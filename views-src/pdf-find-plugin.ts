import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import type { Plugin } from "vite";

const ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const MODULE = "virtual:pdf-regex-worker";
const RESOLVED = `\0${MODULE}`;

/** Keep PDF.js's own text extraction, index projection and highlight lifecycle.
 * Await only its public matcher, discarding canceled-document/pattern results. */
export function patchPdfAsyncFind(source: string): string {
  const replaceOnce = (anchor: string, replacement: string) => {
    if (source.split(anchor).length !== 2) throw new Error("PDF.js async find anchor changed");
    source = source.replace(anchor, replacement);
  };
  replaceOnce("  #calculateMatch(pageIndex) {", "  async #calculateMatch(pageIndex) {");
  replaceOnce("  #reset() {\n    this._highlightMatches = false;", "  #reset() {\n    this._pdfMatchRevision = (this._pdfMatchRevision ?? 0) + 1;\n    this._highlightMatches = false;");
  replaceOnce("    if (this._dirtyMatch) {\n      this._dirtyMatch = false;", "    if (this._dirtyMatch) {\n      this._pdfMatchRevision++;\n      this.cancelPendingMatches?.();\n      this._dirtyMatch = false;");
  replaceOnce("    if (this._resumePageIdx) {\n      return;\n    }\n    const offset = this._offset;", "    if (this._resumePageIdx !== null) {\n      return;\n    }\n    const offset = this._offset;");
  replaceOnce("      if (this._resumePageIdx) {\n        this._resumePageIdx = null;", "      if (this._resumePageIdx !== null) {\n        this._resumePageIdx = null;");
  replaceOnce(
    "    const matcherResult = this.match(query, pageContent, pageIndex);",
    `    const document = this._pdfDocument;
    const generation = this.matchGeneration;
    const revision = this._pdfMatchRevision;
    const matcherResult = await this.match(query, pageContent, pageIndex);
    if (!this.#state || this._pdfDocument !== document || this.matchGeneration !== generation || this._pdfMatchRevision !== revision) return;`,
  );
  return source;
}

export async function buildPdfRegexWorker(): Promise<string> {
  const result = await build({
    entryPoints: [join(import.meta.dirname, "src/lib/pdfRegexWorker.ts")],
    bundle: true, write: false, format: "iife", target: "es2022", minify: true,
    legalComments: "inline", supported: { "template-literal": false },
  });
  return result.outputFiles[0].text;
}

export function pdfFindPlugin(): Plugin {
  let worker: Promise<string> | undefined;
  return {
    name: "pdf-async-find",
    enforce: "pre",
    resolveId(id) { if (id === MODULE) return RESOLVED; },
    async load(id) {
      if (id === RESOLVED) return `export const regexWorkerSource = ${JSON.stringify(await (worker ??= buildPdfRegexWorker()))};`;
    },
    async transform(source, id) {
      if (!id.replaceAll("\\", "/").endsWith("/pdfjs-dist/legacy/web/pdf_viewer.mjs")) return;
      const metadata = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
      if (metadata.version !== "6.4.299") throw new Error("Review PDF async find before upgrading PDF.js");
      return { code: patchPdfAsyncFind(source), map: null };
    },
  };
}
