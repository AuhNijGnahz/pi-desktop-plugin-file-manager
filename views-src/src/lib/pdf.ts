import { getDocument, PDFWorker, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";
import { workerSource } from "virtual:pdf-assets";

const RESOURCE_ROOT = "https://pi-file-manager.invalid/pdfjs/";

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** One document owns one real worker; disposal is safe to call more than once. */
export function createPdfSession(src: string, onFailure?: () => void) {
  const prefix = "data:application/pdf;base64,";
  if (!src.startsWith(prefix)) throw new Error("Invalid PDF data URI");
  const data = decodeBase64(src.slice(prefix.length));
  const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
  let port: Worker;
  try {
    port = new Worker(url, { name: "file-manager-pdf" });
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
  let worker: PDFWorker | undefined;
  let released = false;
  let disposed = false;
  let destroyTask: (() => Promise<void>) | undefined;
  const release = () => {
    if (released) return;
    released = true;
    port.onerror = null;
    // Cleanup failures must not prevent releasing the native port or its URL.
    try { worker?.destroy(); } catch {}
    try { port.terminate(); } catch {}
    try { URL.revokeObjectURL(url); } catch {}
  };
  const workerFailure = new Promise<never>((_resolve, reject) => {
    port.onerror = (event) => {
      event.preventDefault();
      if (released) return;
      const notify = !disposed;
      release();
      reject(new Error(event.message || "PDF worker failed"));
      // The lifecycle transform also cleans frontend resources after a dead
      // worker: disposal must await that cleanup, not race this error signal.
      void destroyTask?.();
      if (notify) {
        try { onFailure?.(); } catch {}
      }
    };
  });
  workerFailure.catch(() => {});
  try {
    worker = PDFWorker.create({ port, verbosity: VerbosityLevel.ERRORS });
    const task = getDocument({
      data,
      worker,
      cMapUrl: `${RESOURCE_ROOT}cmaps/`,
      standardFontDataUrl: `${RESOURCE_ROOT}standard_fonts/`,
      wasmUrl: `${RESOURCE_ROOT}wasm/`,
      iccUrl: `${RESOURCE_ROOT}iccs/`,
      cMapPacked: true,
      // The bundled worker redirects resource fetches to embedded data URLs.
      // Worker fetching also enables PDF.js's synchronous ICC conversion.
      useWorkerFetch: true,
      useSystemFonts: false,
      canvasMaxAreaInBytes: 64 * 1024 * 1024,
      verbosity: VerbosityLevel.ERRORS,
    });
    let disposal: Promise<void> | undefined;
    const destroy = (): Promise<void> => {
      disposed = true;
      return (disposal ??= Promise.resolve().then(() => task.destroy()).catch(() => {}).finally(release));
    };
    destroyTask = destroy;
    return { promise: Promise.race([task.promise, workerFailure]), destroy };
  } catch (error) {
    release();
    throw error;
  }
}
