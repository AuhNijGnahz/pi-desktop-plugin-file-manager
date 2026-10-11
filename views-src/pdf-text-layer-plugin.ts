import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { transform } from "esbuild";
import type { Plugin } from "vite";

const PDF_ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const WORKER_OPTIONS = { format: "iife", target: "es2022", minify: true, legalComments: "inline" } as const;

/** Apply only to the pinned PDF.js source; a changed anchor must fail the build.
 * Embedded fonts are already installed by PDF.js's document-scoped FontLoader.
 * Advertise that family to TextLayer so internal character advances agree with
 * the canvas, and retain geometric word gaps as independently sized whitespace
 * items rather than distributing them across a whole run. Text and PDF.js's
 * original-index mapping stay intact; missing/Type3 fonts keep their fallback.
 */
export function patchPdfTextGeometry(source: string): string {
  const replaceOnce = (value: string, anchor: string, replacement: string, name: string) => {
    const count = value.split(anchor).length - 1;
    if (count !== 1) throw new Error(`PDF.js text geometry anchor ${name} occurred ${count} times`);
    return value.replace(anchor, replacement);
  };
  source = replaceOnce(
    source,
    "fontFamily: font.fallbackName,",
    "fontFamily: !font.missingFile && !font.isType3Font && !font.disableFontFace ? `${loadedName},${font.fallbackName}` : font.fallbackName,",
    "embedded-font-family",
  );
  return replaceOnce(
    source,
    "if (textOrientation * textContentItem.spaceInFlowMin <= width && width <= textOrientation * textContentItem.spaceInFlowMax) {",
    "if (false && textOrientation * textContentItem.spaceInFlowMin <= width && width <= textOrientation * textContentItem.spaceInFlowMax) {",
    "geometric-word-gap",
  );
}

/** Transform the virtual offline assets before Rollup bundles them. Rebuild
 * only the Worker suffix, leaving the resource prelude and notices untouched.
 * Verify the original suffix instead of editing minified third-party symbols.
 */
export function pdfTextLayerPlugin(): Plugin {
  let workerCodes: Promise<{ original: string; patched: string }> | undefined;
  const buildWorkerCodes = async () => {
    const metadata = JSON.parse(await readFile(join(PDF_ROOT, "package.json"), "utf8"));
    if (metadata.version !== "6.4.299") throw new Error("Review PDF text geometry patches before upgrading PDF.js");
    const source = await readFile(join(PDF_ROOT, "legacy/build/pdf.worker.mjs"), "utf8");
    const original = (await transform(source, WORKER_OPTIONS)).code;
    const patched = (await transform(patchPdfTextGeometry(source), WORKER_OPTIONS)).code;
    return { original, patched };
  };
  return {
    name: "pdf-text-layer-geometry",
    enforce: "pre",
    async transform(module, id) {
      if (id !== "\0virtual:pdf-assets") return;
      const prefix = "export const workerSource = ";
      if (!module.startsWith(prefix) || !module.endsWith(";\n")) throw new Error("Unexpected offline PDF asset module");
      const worker: string = JSON.parse(module.slice(prefix.length, -2));
      const { original, patched } = await (workerCodes ??= buildWorkerCodes());
      if (!worker.endsWith(original)) throw new Error("Offline PDF Worker changed before geometry patching");
      return { code: `${prefix}${JSON.stringify(worker.slice(0, -original.length) + patched)};\n`, map: null };
    },
  };
}
