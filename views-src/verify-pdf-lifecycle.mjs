/** Synthetic PDF.js lifecycle regression. Run: node views-src/verify-pdf-lifecycle.mjs.
 * Bundles the real patched legacy API and session into an in-memory IIFE.
 * The Worker protocol, DOM and fonts are synthetic; no PDFs, profiles or files
 * are created. Browser rendering remains the isolated desktop checks' job.
 */
import assert from "node:assert/strict";
import { build, transform } from "esbuild";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = dirname(fileURLToPath(import.meta.url));
const installed = createRequire(import.meta.url);
const pdfPath = installed.resolve("pdfjs-dist/legacy/build/pdf.mjs");
const original = await readFile(pdfPath, "utf8");
const pluginPath = join(root, "pdf-lifecycle-plugin.ts");
const compiled = await transform(await readFile(pluginPath, "utf8"), {
  loader: "ts", format: "esm", target: "es2022",
  define: { "import.meta.url": JSON.stringify(pathToFileURL(pluginPath).href) },
});
const { patchPdfLifecycle, pdfLifecyclePlugin, PDF_DESTROY_TIMEOUT_MS } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`
);
const patched = patchPdfLifecycle(original);
const plugin = pdfLifecyclePlugin();
// 与插件里的 PDF_MODULE 一样先归一成正斜杠：Windows 上 resolve 给的是反斜杠路径，
// 下面那几处 replace("/build/", …) 在反斜杠上不生效，断言就永远不可能成立。
const pdfModulePath = pdfPath.replace(/\\/g, "/");
assert.equal(plugin.enforce, "pre");
assert.equal(await plugin.transform(original, pdfModulePath.replace("/build/", "/web/")), undefined);
assert.equal(await plugin.transform(original, pdfModulePath.replace("pdf.mjs", "pdf.worker.mjs")), undefined);
assert.equal((await plugin.transform(original, `${pdfModulePath}?v=synthetic`)).code, patched);
assert.equal((await plugin.transform(original, pdfModulePath.replaceAll("/", "\\"))).code, patched);
for (const anchor of [
  " * pdfjsVersion = 6.4.299", '    apiVersion: "6.4.299",',
  "class PDFDocumentLoadingTask {", "      await this._setupCapability.promise;",
  "        internalRenderTask.cancel();", '    const terminated = this.messageHandler.sendWithPromise("Terminate", null);',
  "    if (worker.destroyed) {", '      const messageHandler = new MessageHandler(docId, workerId, worker.port);',
  '          this.fontLoader.bind(font).catch(() => messageHandler.sendWithPromise("FontFallback", {',
]) {
  assert.throws(() => patchPdfLifecycle(original.replace(anchor, "/* synthetic upstream change */")), /lifecycle anchor/, anchor);
}
assert.throws(() => patchPdfLifecycle(`${original}\n * pdfjsVersion = 6.4.299`), /occurred 2 times/);
assert.throws(() => patchPdfLifecycle(patched), /lifecycle anchor/);
assert.equal(PDF_DESTROY_TIMEOUT_MS, 1000);

const bundle = await build({
  stdin: {
    contents: 'export { createPdfSession } from "./src/lib/pdf.ts"; export { PDFWorker, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";',
    resolveDir: root, sourcefile: "synthetic-lifecycle-entry.ts", loader: "ts",
  },
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
  globalName: "PdfLifecycle", minify: true, logLevel: "silent",
  plugins: [{ name: "synthetic-pdf-lifecycle", setup(builder) {
    builder.onResolve({ filter: /^virtual:pdf-assets$/ }, () => ({ path: "assets", namespace: "synthetic" }));
    builder.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: 'export const workerSource = "/* synthetic Worker */";', loader: "js" }));
    // esbuild 在 Windows 上给的是反斜杠路径，过滤器必须同时接受两种分隔符，
    // 否则这段合成模块永远不会被命中，PDFPageProxy 也就导不出来。
    builder.onLoad({ filter: /[\\/]legacy[\\/]build[\\/]pdf\.mjs$/ }, () => ({
      contents: `${patched}\nexport { PDFPageProxy };`, loader: "js", resolveDir: dirname(pdfPath),
    }));
  } }],
});
console.log("ok   pinned version/unique anchors, exact Vite module IDs, minified legacy IIFE");

class SyntheticNode {
  constructor(name) { this.name = name; this.children = []; this.style = {}; this.parentNode = null; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  setAttribute(name, value) { this[name] = String(value); }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
}
class SyntheticSheet {
  cssRules = [];
  insertRule(rule) { this.cssRules.push(rule); }
}
const document = {
  URL: "file:///synthetic/index.html", baseURI: "file:///synthetic/index.html",
  body: new SyntheticNode("body"), documentElement: new SyntheticNode("html"),
  fonts: new Set(), adoptedStyleSheets: [],
  createElement: name => new SyntheticNode(name),
  createElementNS: (_namespace, name) => new SyntheticNode(name),
};
const urls = new Set();
const ports = [];
let nextBehavior = {};
let nextUrl = 0;
class SyntheticURL extends URL {
  static createObjectURL() { const url = `blob:synthetic-${nextUrl++}`; urls.add(url); return url; }
  static revokeObjectURL(url) { assert.ok(urls.delete(url), "Blob URL revoked once"); }
}
class SyntheticWorker {
  listeners = new Set();
  actions = [];
  terminateCount = 0;
  onerror = null;
  constructor() {
    this.behavior = nextBehavior;
    nextBehavior = {};
    if (this.behavior.constructorError) throw new Error("Synthetic constructor failure");
    ports.push(this);
  }
  addEventListener(type, callback, { signal } = {}) {
    assert.equal(type, "message");
    this.listeners.add(callback);
    signal?.addEventListener("abort", () => this.listeners.delete(callback), { once: true });
  }
  postMessage(request) {
    this.actions.push(request.action);
    if (this.terminateCount) return;
    if (request.action === this.behavior.throwAction) throw new Error(`Synthetic ${request.action} send failure`);
    switch (request.action) {
      case "GetDocRequest":
        this.setupRequest = request;
        if (!this.behavior.suppressSetup) queueMicrotask(() => this.reply(request, "synthetic-worker"));
        break;
      case "Ready":
        this.documentTarget = request.sourceName;
        queueMicrotask(() => this.emit({
          targetName: request.sourceName, sourceName: request.targetName,
          action: this.behavior.documentError ? "DocException" : "GetDoc",
          data: this.behavior.documentError
            ? { name: "InvalidPDFException", message: "Synthetic invalid document" }
            : { pdfInfo: { numPages: 2, fingerprints: ["synthetic"], htmlForXfa: null } },
        }));
        break;
      case "Terminate":
        this.terminateRequest = request;
        if (!this.behavior.suppressTerminate) queueMicrotask(() => this.reply(request, null, this.behavior.rejectTerminate));
        break;
      case "FontFallback":
        queueMicrotask(() => this.reply(request, null, true));
        break;
    }
  }
  reply(request, data, error = false) {
    this.emit({ targetName: request.sourceName, sourceName: request.targetName, callbackId: request.callbackId,
      callback: error ? 2 : 1, data, reason: { name: "UnknownErrorException", message: "Synthetic rejection", details: "" } });
  }
  emit(data) { for (const callback of [...this.listeners]) callback({ data }); }
  terminate() { this.terminateCount++; }
  fail(message = "Synthetic worker error") {
    let prevented = false;
    this.onerror?.({ message, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
}
const timers = new Set();
const deadlineTimers = new Set();
const sandbox = {
  console, document, navigator: { userAgent: "Synthetic lifecycle check", platform: "", language: "en" },
  Worker: SyntheticWorker, URL: SyntheticURL, Blob, AbortController, ReadableStream, Response, Request, Headers,
  TextEncoder, TextDecoder, DOMException, atob, btoa, queueMicrotask, structuredClone,
  CSSStyleSheet: SyntheticSheet, DOMMatrix: class {}, Path2D: class {}, ImageData: class {},
  setTimeout(callback, delay, ...args) {
    const timer = setTimeout(() => { timers.delete(timer); deadlineTimers.delete(timer); callback(...args); }, delay);
    timers.add(timer);
    if (delay === PDF_DESTROY_TIMEOUT_MS) deadlineTimers.add(timer);
    return timer;
  },
  clearTimeout(timer) { timers.delete(timer); deadlineTimers.delete(timer); clearTimeout(timer); },
  fetch() { throw new Error("Synthetic lifecycle regression must never fetch"); },
};
sandbox.window = sandbox;
const context = vm.createContext(sandbox);
vm.runInContext(bundle.outputFiles[0].text, context, { timeout: 10000 });
const { createPdfSession, PDFWorker, PDFPageProxy } = context.PdfLifecycle;
const source = "data:application/pdf;base64,JVBERi0xLjcK";
const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const unhandled = [];
const onUnhandled = reason => unhandled.push(reason);
process.on("unhandledRejection", onUnhandled);
let fixtureId = 0;
async function fixture(behavior = {}, onFailure = () => {}) {
  nextBehavior = behavior;
  const session = createPdfSession(source, onFailure);
  const port = ports.at(-1);
  const doc = await session.promise;
  const transport = doc._transport; // Test-only inspection of the pinned, unminified API.
  const faces = Array.from({ length: 9 }, (_, index) => ({ family: `synthetic-${fixtureId}-${index}` }));
  fixtureId++;
  for (const face of faces) transport.fontLoader.addNativeFontFace(face);
  transport.fontLoader.insertRule("@font-face { font-family: synthetic; }");
  const sheet = document.adoptedStyleSheets.at(-1);
  transport.filterFactory.addFilter([new Uint8Array([0, 255])]);
  const filterNode = document.body.children.at(-1);
  const counters = { commonClosed: 0, pageClosed: 0, cancelled: 0, streamCancelled: 0 };
  transport.commonObjs.resolve("common-image", { bitmap: { close() { counters.commonClosed++; } } });
  const pages = [];
  const completions = [];
  for (let index = 0; index < 2; index++) {
    const page = new PDFPageProxy(index, { rotate: 0, ref: null, userUnit: 1, view: [0, 0, 10, 10] }, transport, doc.pagesMapper);
    transport.updatePage(page);
    page.objs.resolve("page-image", { bitmap: { close() { counters.pageClosed++; } } });
    const completion = deferred();
    completions.push(completion);
    page._intentStates.set("display", {
      renderTasks: new Set([{ completed: completion.promise, cancel() {
        counters.cancelled++;
        if (behavior.cancelError && index === 0) throw new Error("Synthetic cancellation failure");
        if (!behavior.stallRender) completion.resolve();
      } }]),
      streamReader: { cancel() { counters.streamCancelled++; return Promise.resolve(); } },
      streamReaderCancelTimeout: sandbox.setTimeout(() => assert.fail("Page cancellation timer survived"), 10000),
    });
    pages.push(page);
  }
  return { session, port, doc, transport, faces, sheet, filterNode, counters, pages, completions };
}
async function dispose(item, { slow = false } = {}) {
  const started = performance.now();
  const first = item.session.destroy();
  assert.equal(item.session.destroy(), first, "session destruction is idempotent");
  await first;
  const elapsed = performance.now() - started;
  assert.ok(elapsed <= 1500, `destruction exceeded deadline: ${elapsed.toFixed(1)} ms`);
  if (!slow) assert.ok(elapsed < 300, `graceful/error destruction was delayed: ${elapsed.toFixed(1)} ms`);
  assert.equal(item.session.destroy(), first);
  assert.equal(item.port.terminateCount, 1);
  assert.equal(item.port.onerror, null);
  assert.equal(item.port.listeners.size, 0, "main/document message listeners released");
  assert.equal(item.transport.destroyed, true);
  assert.equal(item.transport.messageHandler, null);
  assert.ok(item.faces.every(face => !document.fonts.has(face)), "owned faces removed");
  assert.ok(!document.adoptedStyleSheets.includes(item.sheet), "owned stylesheet removed");
  assert.ok(!document.body.children.includes(item.filterNode), "owned SVG filter removed");
  assert.equal(item.transport.commonObjs.has("common-image"), false);
  assert.equal(item.counters.commonClosed, 1);
  assert.equal(item.counters.pageClosed, 2);
  assert.equal(item.counters.cancelled, 2);
  assert.equal(item.counters.streamCancelled, 2);
  for (const page of item.pages) {
    assert.equal(page.destroyed, true);
    assert.equal(page._intentStates.size, 0);
    assert.equal(page.objs.has("page-image"), false);
  }
  return elapsed;
}
function assertEmpty() {
  assert.equal(document.fonts.size, 0);
  assert.equal(document.adoptedStyleSheets.length, 0);
  assert.equal(document.body.children.length, 0);
  assert.equal(urls.size, 0);
  assert.equal(timers.size, 0, "all deadline/page cancellation timers cleared");
}
try {
  await dispose(await fixture());
  assertEmpty();
  console.log("ok   graceful handshake stays fast; fonts/filter DOM/objects/pages/listeners/timer/port/URL cleared once");

  const survivor = await fixture();
  for (let count = 0; count < 3; count++) {
    let failures = 0;
    const item = await fixture({}, () => { failures++; });
    const staleHandler = item.port.onerror;
    item.port.fail();
    assert.equal(failures, 1);
    assert.equal(item.port.terminateCount, 1);
    const elapsed = await dispose(item, { slow: true });
    staleHandler({ message: "late", preventDefault() {} });
    assert.equal(failures, 1, "no stale failure callback after disposal");
    assert.equal(document.fonts.size, 9, "live document's fonts preserved through repeated errors");
    assert.ok(survivor.faces.every(face => document.fonts.has(face)));
    assert.ok(document.body.children.includes(survivor.filterNode));
    assert.ok(document.adoptedStyleSheets.includes(survivor.sheet));
    assert.equal(survivor.port.terminateCount, 0);
    console.log(`ok   runtime Worker error ${count + 1}: frontend cleanup ${elapsed.toFixed(1)} ms; other document intact`);
  }
  await dispose(survivor);
  assertEmpty();

  for (const behavior of [{ suppressTerminate: true }, { stallRender: true }]) {
    const item = await fixture(behavior);
    const elapsed = await dispose(item, { slow: true });
    assert.ok(item.port.terminateRequest, "real MessageHandler sent Terminate");
    assertEmpty();
    console.log(`ok   ${behavior.suppressTerminate ? "live Worker ignores Terminate" : "Terminate replies but page completion stalls"}: ${elapsed.toFixed(1)} ms`);
  }

  const silent = await fixture({ suppressTerminate: true, stallRender: true });
  const lateTerminate = deferred();
  const handler = silent.transport.messageHandler;
  const originalSend = handler.sendWithPromise.bind(handler);
  handler.sendWithPromise = (action, ...args) => action === "Terminate" ? lateTerminate.promise : originalSend(action, ...args);
  const elapsed = await dispose(silent, { slow: true });
  lateTerminate.reject(new Error("Late Terminate rejection"));
  for (const completion of silent.completions) completion.reject(new Error("Late render rejection"));
  await flush();
  assertEmpty();
  console.log(`ok   silent Terminate plus stuck page completions: ${elapsed.toFixed(1)} ms; late rejections observed`);

  for (const behavior of [{ rejectTerminate: true }, { throwAction: "Terminate" }, { cancelError: true }]) {
    await dispose(await fixture(behavior));
    assertEmpty();
  }
  const synchronous = await fixture();
  synchronous.transport.messageHandler.sendWithPromise = () => { throw new Error("Synchronous sendWithPromise failure"); };
  await dispose(synchronous);
  assertEmpty();
  console.log("ok   rejected/throwing Terminate and page cancellation still run every frontend cleanup");

  const cleanupError = await fixture();
  const objectsClear = cleanupError.transport.commonObjs.clear.bind(cleanupError.transport.commonObjs);
  cleanupError.transport.commonObjs.clear = () => { objectsClear(); throw new Error("Synthetic object cleanup error"); };
  const filterDestroy = cleanupError.transport.filterFactory.destroy.bind(cleanupError.transport.filterFactory);
  cleanupError.transport.filterFactory.destroy = () => { filterDestroy(); throw new Error("Synthetic filter cleanup error"); };
  const workerDestroy = PDFWorker.prototype.destroy;
  PDFWorker.prototype.destroy = function () { workerDestroy.call(this); throw new Error("Synthetic PDFWorker cleanup error"); };
  try { await dispose(cleanupError); } finally { PDFWorker.prototype.destroy = workerDestroy; }
  assertEmpty();
  console.log("ok   cleanup exceptions do not stop remaining frontend steps, native termination or URL revocation");

  for (const rejectFont of [false, true]) {
    const item = await fixture();
    const pending = deferred();
    item.transport.fontLoader.bind = () => pending.promise;
    let callbacks = 0;
    item.transport.commonObjs.get("late-font", () => { callbacks++; });
    item.port.emit({ targetName: item.port.documentTarget, action: "commonobj", data: ["late-font", "Font", { buffer: new ArrayBuffer(512) }] });
    await dispose(item);
    if (rejectFont) pending.reject(new Error("Synthetic late font failure")); else pending.resolve();
    await flush();
    assert.equal(item.transport.commonObjs.has("late-font"), false);
    assert.equal(callbacks, 0);
    assert.equal(item.port.actions.includes("FontFallback"), false);
    assertEmpty();
  }
  const fallback = await fixture();
  fallback.transport.fontLoader.bind = () => Promise.reject(new Error("Synthetic font failure"));
  fallback.port.emit({ targetName: fallback.port.documentTarget, action: "commonobj", data: ["fallback-font", "Font", { buffer: new ArrayBuffer(512) }] });
  await flush();
  assert.equal(fallback.transport.commonObjs.has("fallback-font"), true);
  assert.equal(fallback.port.actions.includes("FontFallback"), true);
  await dispose(fallback);
  assertEmpty();
  console.log("ok   late font resolve/reject cannot repopulate objects or call stale consumers; fallback rejection handled");

  nextBehavior = { suppressSetup: true };
  const startup = createPdfSession(source);
  const startupFailure = assert.rejects(startup.promise, /Loading aborted/);
  await flush();
  const startupPort = ports.at(-1);
  assert.ok(startupPort.setupRequest);
  const startupStarted = performance.now();
  await startup.destroy();
  await startupFailure;
  assert.ok(performance.now() - startupStarted <= 1500);
  assert.equal(startupPort.listeners.size, 0);
  assert.equal(startupPort.terminateCount, 1);
  assertEmpty();

  nextBehavior = { suppressSetup: true };
  const lateSetup = createPdfSession(source);
  const aborted = assert.rejects(lateSetup.promise, /Loading aborted/);
  await flush();
  const latePort = ports.at(-1);
  const lateDisposal = lateSetup.destroy();
  await flush();
  latePort.reply(latePort.setupRequest, "synthetic-worker");
  await lateDisposal;
  await aborted;
  assert.equal(latePort.actions.includes("Ready"), false, "aborted setup must not install a late transport");
  assert.equal(latePort.listeners.size, 0);
  assertEmpty();

  nextBehavior = { suppressSetup: true };
  let startupCallbacks = 0;
  const failedStartup = createPdfSession(source, () => { startupCallbacks++; throw new Error("Synthetic UI callback error"); });
  const failedPromise = assert.rejects(failedStartup.promise, /Synthetic worker error/);
  await flush();
  ports.at(-1).fail();
  await failedStartup.destroy();
  await failedPromise;
  assert.equal(startupCallbacks, 1);
  assertEmpty();

  nextBehavior = { constructorError: true };
  assert.throws(() => createPdfSession(source), /Synthetic constructor failure/);
  const createWorker = PDFWorker.create;
  PDFWorker.create = () => { throw new Error("Synthetic PDFWorker initialization failure"); };
  try { assert.throws(() => createPdfSession(source), /Synthetic PDFWorker initialization failure/); }
  finally { PDFWorker.create = createWorker; }
  assertEmpty();

  nextBehavior = { documentError: true };
  const invalid = createPdfSession(source);
  await assert.rejects(invalid.promise, /Synthetic invalid document/);
  await invalid.destroy();
  assertEmpty();
  await dispose(await fixture());
  assertEmpty();
  console.log("ok   stalled/failed/late startup is bounded, errors propagate, fresh sessions recover");

  let staleCallbacks = 0;
  const closing = await fixture({ suppressTerminate: true }, () => { staleCallbacks++; });
  const closingPromise = closing.session.destroy();
  closing.port.fail();
  await closingPromise;
  await dispose(closing);
  assert.equal(staleCallbacks, 0);
  assertEmpty();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(deadlineTimers.size, 0);
  console.log("ok   errors during intentional disposal suppress UI callbacks; no unhandled rejections or timers");
} finally {
  process.off("unhandledRejection", onUnhandled);
  for (const timer of timers) clearTimeout(timer);
}
