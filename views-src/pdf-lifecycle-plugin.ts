import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

const PDF_MODULE = createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.mjs").replace(/\\/g, "/");
const PDF_ROOT = dirname(dirname(dirname(PDF_MODULE)));
export const PDF_DESTROY_TIMEOUT_MS = 1000;

const LOADING_DESTROY = String.raw`  async destroy() {
    this.destroyed = true;
    this._capability.promise.catch(() => {});
    try {
      if (this._worker?.port) {
        this._worker._pendingDestroy = true;
      }
      await this._setupCapability.promise;
      await this._transport?.destroy();
    } catch (ex) {
      if (this._worker?.port) {
        delete this._worker._pendingDestroy;
      }
      throw ex;
    }
    this._transport = null;
    this._worker?.destroy();
    this._worker = null;
  }`;

const PAGE_DESTROY = String.raw`  _destroy() {
    this.destroyed = true;
    const waitOn = [];
    for (const intentState of this._intentStates.values()) {
      this._abortOperatorList({
        intentState,
        reason: new Error("Page was destroyed."),
        force: true
      });
      if (intentState.opListReadCapability) {
        continue;
      }
      for (const internalRenderTask of intentState.renderTasks) {
        waitOn.push(internalRenderTask.completed);
        internalRenderTask.cancel();
      }
    }
    this.objs.clear();
    this.#pendingCleanup = false;
    return Promise.all(waitOn);
  }`;

const TRANSPORT_DESTROY = String.raw`  destroy() {
    if (this.destroyCapability) {
      return this.destroyCapability.promise;
    }
    this.destroyed = true;
    this.destroyCapability = Promise.withResolvers();
    this.#passwordCapability?.reject(new Error("Worker was destroyed during onPassword callback"));
    const waitOn = [];
    for (const page of this.#pageCache.values()) {
      waitOn.push(page._destroy());
    }
    this.#pageCache.clear();
    this.#pagePromises.clear();
    this.#pageRefCache.clear();
    if (Object.hasOwn(this, "annotationStorage")) {
      this.annotationStorage.resetModified();
    }
    const terminated = this.messageHandler.sendWithPromise("Terminate", null);
    waitOn.push(terminated);
    Promise.all(waitOn).then(() => {
      this.commonObjs.clear();
      this.fontLoader.clear();
      this.#methodPromises.clear();
      this.filterFactory.destroy();
      TextLayer.cleanup();
      this.#networkStream?.cancelAllRequests(new AbortException("Worker was terminated."));
      this.messageHandler?.destroy();
      this.messageHandler = null;
      this.destroyCapability.resolve();
    }, this.destroyCapability.reject);
    return this.destroyCapability.promise;
  }`;

/** Patch the pinned, unminified legacy main API, never runtime private symbols.
 * One deadline covers setup and all page/Terminate waits. Each frontend cleanup
 * is attempted even after rejection or a synchronous cancellation/send error.
 * FontLoader.clear and filterFactory.destroy retain their document ownership;
 * TextLayer.cleanup retains PDF.js's guard for other pending text layers.
 */
export function patchPdfLifecycle(source: string): string {
  const replaceOnce = (anchor: string, replacement: string, name: string) => {
    const count = source.split(anchor).length - 1;
    if (count !== 1) throw new Error(`PDF.js lifecycle anchor ${name} occurred ${count} times`);
    source = source.replace(anchor, () => replacement);
  };
  replaceOnce(" * pdfjsVersion = 6.4.299", " * pdfjsVersion = 6.4.299", "version");
  replaceOnce('    apiVersion: "6.4.299",', '    apiVersion: "6.4.299",', "api-version");
  replaceOnce("class PDFDocumentLoadingTask {", `function createPdfDestroyDeadline() {
  let timer;
  const expired = new Promise(resolve => {
    timer = setTimeout(resolve, ${PDF_DESTROY_TIMEOUT_MS});
  });
  return {
    wait: promise => Promise.race([promise, expired]),
    clear: () => clearTimeout(timer)
  };
}
class PDFDocumentLoadingTask {`, "deadline-helper");
  replaceOnce(LOADING_DESTROY, String.raw`  async destroy() {
    this.destroyed = true;
    this._capability.promise.catch(() => {});
    this._capability.reject(new Error("Loading aborted"));
    const deadline = createPdfDestroyDeadline();
    try {
      if (this._worker?.port) {
        this._worker._pendingDestroy = true;
      }
      await deadline.wait(this._setupCapability.promise);
      await this._transport?.destroy(deadline);
    } finally {
      deadline.clear();
      this._transport = null;
      try {
        this._worker?.destroy();
      } finally {
        this._worker = null;
      }
    }
  }`, "loading-task-destroy");
  replaceOnce(String.raw`  Promise.all([worker.promise, gpuPromise]).then(function ([, hasGPU]) {
    if (worker.destroyed) {`, String.raw`  Promise.all([worker.promise, gpuPromise]).then(function ([, hasGPU]) {
    if (worker.destroyed || task.destroyed) {`, "startup-destroyed-gate");
  replaceOnce(String.raw`      const messageHandler = new MessageHandler(docId, workerId, worker.port);
      const transport = new WorkerTransport(messageHandler, task, networkStream, transportParams, transportFactory, pagesMapper);
      task._transport = transport;
      if (task.destroyed) {
        throw new Error("Loading aborted");
      }`, String.raw`      if (task.destroyed) {
        throw new Error("Loading aborted");
      }
      const messageHandler = new MessageHandler(docId, workerId, worker.port);
      const transport = new WorkerTransport(messageHandler, task, networkStream, transportParams, transportFactory, pagesMapper);
      task._transport = transport;`, "late-transport-gate");
  replaceOnce(PAGE_DESTROY, String.raw`  _destroy() {
    this.destroyed = true;
    const waitOn = [];
    const attempt = action => {
      try {
        action();
      } catch (reason) {
        waitOn.push(Promise.reject(reason));
      }
    };
    for (const intentState of this._intentStates.values()) {
      attempt(() => this._abortOperatorList({
        intentState,
        reason: new Error("Page was destroyed."),
        force: true
      }));
      if (intentState.opListReadCapability) {
        continue;
      }
      for (const internalRenderTask of intentState.renderTasks) {
        waitOn.push(internalRenderTask.completed);
        attempt(() => internalRenderTask.cancel());
      }
    }
    attempt(() => this.objs.clear());
    this._intentStates.clear();
    this.#pendingCleanup = false;
    return Promise.all(waitOn);
  }`, "page-destroy");
  replaceOnce(TRANSPORT_DESTROY, String.raw`  destroy(deadline = null) {
    if (this.destroyCapability) {
      return this.destroyCapability.promise;
    }
    this.destroyed = true;
    this.destroyCapability = Promise.withResolvers();
    const ownsDeadline = !deadline;
    deadline ||= createPdfDestroyDeadline();
    const errors = [];
    const attempt = action => {
      try {
        return action();
      } catch (reason) {
        errors.push(reason);
      }
    };
    attempt(() => this.#passwordCapability?.reject(new Error("Worker was destroyed during onPassword callback")));
    const waitOn = [];
    for (const page of this.#pageCache.values()) {
      waitOn.push(Promise.resolve(attempt(() => page._destroy())));
    }
    this.#pageCache.clear();
    this.#pagePromises.clear();
    this.#pageRefCache.clear();
    if (Object.hasOwn(this, "annotationStorage")) {
      attempt(() => this.annotationStorage.resetModified());
    }
    waitOn.push(Promise.resolve(attempt(() => this.messageHandler?.sendWithPromise("Terminate", null))));
    const finish = async () => {
      try {
        await deadline.wait(Promise.all(waitOn));
      } catch (reason) {
        errors.push(reason);
      } finally {
        attempt(() => this.commonObjs.clear());
        attempt(() => this.fontLoader.clear());
        this.#methodPromises.clear();
        attempt(() => this.filterFactory.destroy());
        attempt(() => TextLayer.cleanup());
        attempt(() => this.#networkStream?.cancelAllRequests(new AbortException("Worker was terminated.")));
        attempt(() => this.messageHandler?.destroy());
        this.messageHandler = null;
        if (ownsDeadline) {
          deadline.clear();
        }
      }
      if (errors.length) {
        throw errors[0];
      }
    };
    finish().then(this.destroyCapability.resolve, this.destroyCapability.reject);
    return this.destroyCapability.promise;
  }`, "transport-destroy");
  // Font loading can finish after forced cleanup. Do not repopulate commonObjs
  // or ask a destroyed worker for fallback; observe fallback/cleanup rejections.
  replaceOnce(String.raw`          this.fontLoader.bind(font).catch(() => messageHandler.sendWithPromise("FontFallback", {
            id
          })).finally(() => {
            if (!font.fontExtraProperties) {
              font.clearData();
            }
            this.commonObjs.resolve(id, font);
          });`, String.raw`          this.fontLoader.bind(font).catch(() => {
            if (!this.destroyed) {
              return messageHandler.sendWithPromise("FontFallback", { id });
            }
          }).catch(() => {}).finally(() => {
            if (!font.fontExtraProperties) {
              font.clearData();
            }
            if (!this.destroyed) {
              this.commonObjs.resolve(id, font);
            }
          }).catch(reason => {
            if (!this.destroyed) {
              warn("Font cleanup failed: " + reason);
            }
          });`, "late-font-completion");
  return source;
}

/** Add to Vite's plugins beside the offline PDF asset/text geometry plugins. */
export function pdfLifecyclePlugin(): Plugin {
  let versionChecked: Promise<void> | undefined;
  return {
    name: "pdf-bounded-lifecycle",
    enforce: "pre",
    async transform(source, id) {
      if (id.split("?")[0].replace(/\\/g, "/") !== PDF_MODULE) return;
      await (versionChecked ??= readFile(join(PDF_ROOT, "package.json"), "utf8").then(metadata => {
        if (JSON.parse(metadata).version !== "6.4.299") {
          throw new Error("Review PDF lifecycle patches before upgrading PDF.js");
        }
      }));
      return { code: patchPdfLifecycle(source), map: null };
    },
  };
}
