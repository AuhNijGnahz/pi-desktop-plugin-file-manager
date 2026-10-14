export type PdfSpread = "single" | "double" | "cover";

/** Document geometry, independent of scroll position and the current scale. */
export function createPdfFitWidths() {
  const pages = new Map<number, number>();
  const widest: Record<PdfSpread, number> = { single: 0, double: 0, cover: 0 };
  const rowWidth = (first: number) => (pages.get(first) ?? 0) + (pages.get(first + 1) ?? 0);

  return {
    add(pageNumber: number, naturalWidth: number) {
      if (pages.has(pageNumber) || !Number.isFinite(naturalWidth) || naturalWidth <= 0) return;
      pages.set(pageNumber, naturalWidth);
      widest.single = Math.max(widest.single, naturalWidth);
      widest.double = Math.max(widest.double, rowWidth(pageNumber % 2 ? pageNumber : pageNumber - 1));
      widest.cover = Math.max(widest.cover, pageNumber === 1 ? naturalWidth : rowWidth(pageNumber % 2 ? pageNumber - 1 : pageNumber));
    },
    width(mode: PdfSpread) { return widest[mode]; },
  };
}
