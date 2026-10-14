import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EventBus, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";

/** PDFLinkService adds a new text-layer listener per destination. Own one
 * document-scoped listener instead, including for already-rendered pages. */
export function createPdfNavigation(pdf: PDFDocumentProxy, viewer: PDFViewer, eventBus: EventBus, signal: AbortSignal) {
  let generation = 0;
  let pendingPage: number | null = null;
  const focus = (number: number) => {
    const layer = viewer.getPageView(number - 1)?.textLayer?.div;
    // PDF.js appends endOfContent only when its complete text layer is ready.
    if (!layer?.isConnected || layer.hidden || !layer.querySelector(".endOfContent")) return false;
    layer.focus({ preventScroll: true });
    return true;
  };
  eventBus.on("textlayerrendered", ({ pageNumber, error }: { pageNumber: number; error?: unknown }) => {
    if (signal.aborted || pageNumber !== pendingPage) return;
    if (error || focus(pageNumber)) pendingPage = null;
  }, { signal });
  const cancel = () => { generation++; pendingPage = null; };
  return {
    cancel,
    async goToDestination(destination: string | unknown[]) {
      cancel();
      const request = generation;
      if (signal.aborted) return;
      const explicit = typeof destination === "string" ? await pdf.getDestination(destination) : destination;
      if (signal.aborted || request !== generation) return;
      if (!Array.isArray(explicit) || explicit.length < 2) throw new Error("Invalid PDF bookmark destination");
      const reference = explicit[0];
      let number: number;
      if (Number.isInteger(reference)) number = Number(reference) + 1;
      else if (reference && typeof reference === "object") number = pdf.cachedPageNumber(reference) ?? (await pdf.getPageIndex(reference)) + 1;
      else throw new Error("Invalid PDF bookmark page");
      if (signal.aborted || request !== generation) return;
      if (!Number.isInteger(number) || number < 1 || number > pdf.numPages) throw new Error("Invalid PDF bookmark page");
      pendingPage = number;
      viewer.scrollPageIntoView({ pageNumber: number, destArray: explicit, ignoreDestinationZoom: true });
      if (focus(number)) pendingPage = null;
    },
  };
}
