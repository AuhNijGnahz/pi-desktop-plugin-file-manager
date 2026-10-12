import { regexWorkerSource } from "virtual:pdf-regex-worker";
import type { PdfSearchMatch } from "./pdfSearch";

export type PdfRegexFailure = "TIMEOUT" | "LIMIT" | "INVALID";
export const PDF_REGEX_TIMEOUT_MS = 1000;
type Job = { id: number; source: string; flags: string; content: string; entireWord: boolean; resolve: (matches: PdfSearchMatch[]) => void };

/** One lazily-created worker, one page in flight, and no duplicate page-text
 * cache. A new pattern/close cancels all pending work. Idle workers are released. */
export function createPdfRegexMatcher(onFailure: (failure: PdfRegexFailure) => void) {
  let worker: Worker | null = null;
  let url: string | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let current: Job | undefined;
  let queue: Job[] = [];
  let sequence = 0;

  const release = () => {
    clearTimeout(deadline); deadline = undefined;
    clearTimeout(idle); idle = undefined;
    const port = worker, blob = url;
    worker = null; url = null;
    if (port) {
      port.onmessage = null; port.onerror = null; port.onmessageerror = null;
      try { port.terminate(); } catch {}
    }
    if (blob) { try { URL.revokeObjectURL(blob); } catch {} }
  };
  const cancel = () => {
    release();
    current?.resolve([]); current = undefined;
    for (const job of queue) job.resolve([]);
    queue = [];
  };
  const fail = (failure: PdfRegexFailure) => {
    cancel();
    onFailure(failure);
  };
  const pump = () => {
    if (current || !queue.length) return;
    clearTimeout(idle); idle = undefined;
    current = queue.shift()!;
    try {
      if (!worker) {
        url = URL.createObjectURL(new Blob([regexWorkerSource], { type: "text/javascript" }));
        worker = new Worker(url, { name: "file-manager-pdf-regex" });
        worker.onmessage = (event: MessageEvent<{ id: number; matches?: PdfSearchMatch[]; error?: PdfRegexFailure }>) => {
          if (!current || event.data.id !== current.id) return;
          if (event.data.error) { fail(event.data.error); return; }
          clearTimeout(deadline); deadline = undefined;
          const done = current; current = undefined;
          done.resolve(event.data.matches ?? []);
          if (queue.length) pump();
          else idle = setTimeout(release, 100);
        };
        worker.onerror = (event) => { event.preventDefault(); fail("INVALID"); };
        worker.onmessageerror = () => fail("INVALID");
      }
      deadline = setTimeout(() => fail("TIMEOUT"), PDF_REGEX_TIMEOUT_MS);
      const { id, source, flags, content, entireWord } = current;
      worker.postMessage({ id, source, flags, content, entireWord });
    } catch {
      fail("INVALID");
    }
  };
  return {
    match(expression: RegExp, content: string, entireWord: boolean): Promise<PdfSearchMatch[]> {
      return new Promise((resolve) => {
        queue.push({ id: ++sequence, source: expression.source, flags: expression.flags, content, entireWord, resolve });
        pump();
      });
    },
    cancel,
  };
}
