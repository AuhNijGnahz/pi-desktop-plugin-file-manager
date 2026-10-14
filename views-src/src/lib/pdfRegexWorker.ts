import { findPdfRegexMatches } from "./pdfSearch";

// No PDF parser or document bytes enter this worker: the matching controller
// supplies one normalized page at a time, then maps the returned offsets.
self.onmessage = (event: MessageEvent<{ id: number; source: string; flags: string; content: string; entireWord: boolean }>) => {
  const { id, source, flags, content, entireWord } = event.data;
  try {
    const matches = findPdfRegexMatches(new RegExp(source, flags), content, entireWord, 100_000);
    self.postMessage({ id, matches });
  } catch (error) {
    self.postMessage({ id, error: error instanceof RangeError ? "LIMIT" : "INVALID" });
  }
};
