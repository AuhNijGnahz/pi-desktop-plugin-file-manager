import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { transform } from "esbuild";
import type { Plugin } from "vite";

const MODULE_ID = "virtual:pdf-assets";
const RESOLVED_ID = `\0${MODULE_ID}`;
const PDF_ROOT = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

/**
 * file:// pages cannot import module workers or fetch sibling binary files.
 * Embed the worker as a classic script and the supporting binaries as base64.
 * Only requested resources are decoded at runtime; no CDN or local server.
 */
export function pdfAssetsPlugin(): Plugin {
  let modulePromise: Promise<string> | undefined;
  let notices: string;

  async function buildModule() {
    const resources: Record<string, string> = {};
    const licenses: string[] = [await readFile(join(PDF_ROOT, "LICENSE"), "utf8")];
    for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
      const names = (await readdir(join(PDF_ROOT, folder))).sort();
      for (const name of names) {
        if (name.startsWith("LICENSE")) {
          licenses.push(`\n--- ${folder}/${name} ---\n${await readFile(join(PDF_ROOT, folder, name), "utf8")}`);
        } else if (/\.(bcmap|pfb|ttf|wasm|icc)$/.test(name) && name !== "quickjs-eval.wasm") {
          resources[`${folder}/${name}`] = (await readFile(join(PDF_ROOT, folder, name))).toString("base64");
        }
      }
    }
    notices = licenses.join("\n").replace(/[ \t]+$/gm, "");
    const { code } = await transform(await readFile(join(PDF_ROOT, "legacy/build/pdf.worker.mjs"), "utf8"), {
      format: "iife",
      target: "es2022",
      minify: true,
      legalComments: "inline",
    });

    // Worker fetching enables PDF.js ICC conversion. Both async fetch and sync
    // XHR resolve to embedded data URLs, including on offline file:// pages.
    const dataUrls = Object.fromEntries(Object.entries(resources).map(([name, base64]) => [
      name, `data:application/octet-stream;base64,${base64}`,
    ]));
    const resourcePrelude = `(() => {
      const prefix = "https://pi-file-manager.invalid/pdfjs/";
      const resources = ${JSON.stringify(dataUrls)};
      const bundled = url => {
        const value = String(url);
        if (value.startsWith("data:")) return value;
        const resource = value.startsWith(prefix) && resources[value.slice(prefix.length)];
        if (!resource) throw new Error("Missing bundled PDF resource: " + value);
        return resource;
      };
      const nativeFetch = self.fetch.bind(self);
      self.fetch = (input, options) => nativeFetch(bundled(input instanceof Request ? input.url : input), options);
      const NativeXHR = self.XMLHttpRequest;
      self.XMLHttpRequest = class extends NativeXHR {
        open(method, url, ...args) { return super.open(method, bundled(url), ...args); }
      };
    })();\n`;
    return `export const workerSource = ${JSON.stringify(resourcePrelude + code)};\n`;
  }

  return {
    name: "pdf-offline-assets",
    resolveId(id) {
      return id === MODULE_ID ? RESOLVED_ID : undefined;
    },
    load(id) {
      if (id === RESOLVED_ID) return (modulePromise ??= buildModule());
    },
    async generateBundle() {
      if (!modulePromise) return;
      await modulePromise;
      this.emitFile({ type: "asset", fileName: "assets/pdfjs-LICENSES.txt", source: notices });
    },
  };
}
