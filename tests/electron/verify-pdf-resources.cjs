const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const from = (directory) => directory ? createRequire(path.join(path.resolve(directory), 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electronBinary = from(process.env.PDF_ELECTRON_DIR)('electron');
const PDF_WORKER = 'file-manager-pdf';
const REGEX_WORKER = 'file-manager-pdf-regex';
const TIMEOUT_ALERT = 'Regular expression search took too long and was stopped. Simplify the pattern and try again.';
const LIMIT_ALERT = 'Regular expression search produced too many matches. Narrow the pattern and try again.';
const INVALID_ALERT = 'Invalid or unsupported regular expression. Check the pattern and character classes.';
const NORMAL_CYCLES = 15;
const LIMIT_CHARACTERS = 100128;

// ASCII-only synthetic PDFs need no generator dependency or user document.
function pdfBytes(objects) {
  let document = '%PDF-1.7\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(document + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}
const stream = (content) => `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
const literal = (text) => text.replace(/[\\()]/g, '\\$&');
const text = (value, size = 14, y = 700) => `BT /F1 ${size} Tf 40 ${y} Td (${literal(value)}) Tj ET`;
function onePagePdf(content) {
  return pdfBytes([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    stream(content),
  ]);
}
function bookmarksPdf() {
  return pdfBytes([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /Names << /Dests 11 0 R >> >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    stream(text('Bookmarked page one - recovery phrase')),
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    stream(text('Bookmarked page two - named destination')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>',
    '<< /Title (Same page XYZ) /Parent 8 0 R /Next 10 0 R /Dest [3 0 R /XYZ 40 700 null] >>',
    '<< /Title (Named page two) /Parent 8 0 R /Prev 9 0 R /Dest (chapter-two) >>',
    '<< /Names [(chapter-two) [5 0 R /XYZ 40 700 null]] >>',
  ]);
}
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A host timer also bounds commands if an old bundle blocks the renderer.
async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

// Install before opening any PDF. Preserve native Worker/observer behavior;
// inject faults only into the explicitly named worker/action under test.
function instrumentResources() {
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const state = window.pdfResourceTest = {
    workers: new Set(), createdWorkers: new Set(), terminatedWorkers: new Set(),
    workerInfo: new WeakMap(), workerRecords: [], attempts: [],
    urls: new Set(), createdUrls: new Set(), revokedUrls: new Set(), urlInfo: new Map(),
    suppressActions: new Set(), suppressed: [], workerErrors: [], regexJobs: [], regexReplies: [],
    failRegexConstruction: false, creationFailures: [], probeRegexExec: false, marks: {},
    fontIds: new WeakMap(), removedFontIds: new Set(), fontEvents: [], nextFontId: 0,
    buses: new WeakMap(), busIds: new WeakMap(), nextBusId: 0, lastBus: null, bookmarkBus: null,
    listeners: new Map([[window, new Set()], [document, new Set()]]), observerPools: {}, heartbeat: null,
  };
  const fontId = (face) => {
    if (!state.fontIds.has(face)) state.fontIds.set(face, ++state.nextFontId);
    return state.fontIds.get(face);
  };
  const fontSetPrototype = Object.getPrototypeOf(document.fonts);
  for (const method of ['add', 'delete', 'clear']) {
    const original = fontSetPrototype[method];
    fontSetPrototype[method] = function (...args) {
      const faces = this === document.fonts ? (method === 'clear' ? [...this] : [args[0]]) : [];
      const present = faces.filter((face) => this.has(face));
      const result = original.apply(this, args);
      for (const face of method === 'add' ? faces : present) {
        const id = fontId(face);
        if (method !== 'add') state.removedFontIds.add(id);
        state.fontEvents.push({ method, id, family: face.family, at: performance.now() });
      }
      return result;
    };
  }
  // Enable only for the compact limit case. Count calls in the real worker,
  // without supplying matches or changing its iteration/exception behavior.
  const execProbe = `"use strict"; (() => {
    if (self.name !== "file-manager-pdf-regex") return;
    let source, calls = 0;
    const exec = RegExp.prototype.exec, send = self.postMessage.bind(self);
    self.addEventListener("message", event => { source = event.data.source; calls = 0; });
    RegExp.prototype.exec = function (...args) {
      if (this.source === source) calls++;
      return exec.apply(this, args);
    };
    self.postMessage = (message, ...rest) => send({ ...message, __pdfResourceExecCalls: calls }, ...rest);
  })();\n`;
  const createUrl = URL.createObjectURL.bind(URL), revokeUrl = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    const instrumented = state.probeRegexExec && /javascript/i.test(blob.type);
    const workerBlob = instrumented ? new Blob([execProbe, blob], { type: blob.type }) : blob;
    const url = createUrl(workerBlob);
    state.createdUrls.add(url); state.urls.add(url);
    state.urlInfo.set(url, { url, name: null, bytes: blob.size, instrumented, createdAt: performance.now(), revokedAt: null });
    return url;
  };
  URL.revokeObjectURL = (url) => {
    if (state.urls.delete(url)) {
      state.revokedUrls.add(url);
      state.urlInfo.get(url).revokedAt = performance.now();
    }
    return revokeUrl(url);
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      const name = options?.name || '';
      const attempt = { name, url: String(url), at: performance.now() };
      state.attempts.push(attempt);
      const info = state.urlInfo.get(String(url));
      if (info) info.name = name;
      if (state.failRegexConstruction && name === 'file-manager-pdf-regex') {
        state.creationFailures.push(attempt);
        throw new Error('Synthetic regex Worker construction failure');
      }
      super(url, options);
      const record = { id: state.workerRecords.length + 1, name, url: String(url), createdAt: performance.now(), terminatedAt: null };
      state.workerInfo.set(this, record); state.workerRecords.push(record);
      state.createdWorkers.add(this); state.workers.add(this);
      nativeAdd.call(this, 'error', (event) => state.workerErrors.push({ id: record.id, name, message: event.message, at: performance.now() }));
      if (name === 'file-manager-pdf-regex') nativeAdd.call(this, 'message', (event) => {
        state.regexReplies.push({ workerId: record.id, id: event.data.id, error: event.data.error || null,
          matches: event.data.matches?.length, execCalls: event.data.__pdfResourceExecCalls, at: performance.now() });
      });
    }
    postMessage(message, ...rest) {
      const record = state.workerInfo.get(this);
      if (record.name === 'file-manager-pdf' && state.suppressActions.has(message?.action)) {
        state.suppressed.push({ workerId: record.id, name: record.name, action: message.action, at: performance.now() });
        return;
      }
      if (record.name === 'file-manager-pdf-regex') {
        const job = { workerId: record.id, id: message.id, source: message.source, contentLength: message.content?.length, at: performance.now() };
        state.regexJobs.push(job);
        const heartbeat = state.heartbeat;
        if (heartbeat && heartbeat.source === message.source && heartbeat.busyAt === null) {
          heartbeat.busyAt = job.at; heartbeat.workerId = record.id;
          heartbeat.timeout = setTimeout(() => { heartbeat.timerAt = performance.now(); }, 50);
        }
      }
      return super.postMessage(message, ...rest);
    }
    terminate() {
      if (state.workers.delete(this)) {
        state.terminatedWorkers.add(this);
        state.workerInfo.get(this).terminatedAt = performance.now();
      }
      return super.terminate();
    }
  };

  // PDF.js buses are sealed: all ownership/counting belongs in these WeakMaps.
  const busPrototype = window.pdfjsViewer?.EventBus?.prototype;
  if (!busPrototype) throw new Error('Production PDF.js EventBus is unavailable');
  const busOn = busPrototype.on, busOff = busPrototype.off;
  busPrototype.on = function (eventName, listener, options) {
    const result = busOn.call(this, eventName, listener, options);
    if (options?.signal?.aborted) return result;
    if (!state.buses.has(this)) {
      state.buses.set(this, new Map()); state.busIds.set(this, ++state.nextBusId);
    }
    const events = state.buses.get(this);
    if (!events.has(eventName)) events.set(eventName, []);
    events.get(eventName).push(listener);
    state.lastBus = this; // Capture the adapter's bus through on(), not LinkService.
    return result;
  };
  busPrototype.off = function (eventName, listener, options) {
    const result = busOff.call(this, eventName, listener, options);
    const callbacks = state.buses.get(this)?.get(eventName);
    const index = callbacks?.indexOf(listener) ?? -1;
    if (index >= 0) callbacks.splice(index, 1);
    return result;
  };
  state.textListeners = (bus = state.bookmarkBus) => state.buses.get(bus)?.get('textlayerrendered')?.length || 0;

  // Track window/document only, with native once/signal and listener identity.
  // Element listeners and CodeMirror's MutationObservers are intentionally out
  // of this comparison; their lifetime differs from a PDF document's lifetime.
  const dropListener = (pool, record) => {
    pool.delete(record);
    if (record.signal && record.abort) nativeRemove.call(record.signal, 'abort', record.abort);
  };
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const pool = state.listeners.get(this);
    if (!pool || !listener || options?.signal?.aborted) return nativeAdd.call(this, type, listener, options);
    type = String(type);
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const existing = [...pool].find((record) => record.type === type && record.listener === listener && record.capture === capture);
    if (existing) return nativeAdd.call(this, type, existing.wrapped, options);
    const record = { type, listener, capture, signal: options?.signal, wrapped: null, abort: null };
    record.wrapped = function (event) {
      if (options?.once) dropListener(pool, record);
      if (typeof listener === 'function') return listener.call(this, event);
      return listener.handleEvent.call(listener, event);
    };
    nativeAdd.call(this, type, record.wrapped, options);
    pool.add(record);
    if (record.signal) {
      record.abort = () => dropListener(pool, record);
      nativeAdd.call(record.signal, 'abort', record.abort, { once: true });
    }
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const pool = state.listeners.get(this);
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const record = pool && [...pool].find((item) => item.type === String(type) && item.listener === listener && item.capture === capture);
    if (!record) return nativeRemove.call(this, type, listener, options);
    nativeRemove.call(this, type, record.wrapped, options);
    dropListener(pool, record);
  };
  for (const name of ['ResizeObserver', 'IntersectionObserver']) {
    const NativeObserver = window[name];
    if (!NativeObserver) continue;
    const pool = state.observerPools[name] = new Map();
    window[name] = class extends NativeObserver {
      observe(target, ...options) {
        const result = super.observe(target, ...options);
        if (!pool.has(this)) pool.set(this, new Set());
        pool.get(this).add(target);
        return result;
      }
      unobserve(target) {
        const result = super.unobserve(target);
        const targets = pool.get(this);
        targets?.delete(target);
        if (targets?.size === 0) pool.delete(this);
        return result;
      }
      disconnect() { const result = super.disconnect(); pool.delete(this); return result; }
    };
  }
  state.pools = () => {
    const listeners = {};
    for (const [target, pool] of state.listeners) {
      const types = {};
      for (const record of pool) {
        const key = `${record.type}:${record.capture ? 'capture' : 'bubble'}`;
        types[key] = (types[key] || 0) + 1;
      }
      listeners[target === window ? 'window' : 'document'] = Object.fromEntries(Object.entries(types).sort());
    }
    const observers = Object.fromEntries(Object.entries(state.observerPools).map(([name, pool]) => [name, {
      active: pool.size, targets: [...pool.values()].reduce((sum, targets) => sum + targets.size, 0),
    }]));
    return { listeners, observers };
  };
  state.snapshot = () => {
    const names = [...new Set(state.workerRecords.map((record) => record.name))].sort();
    return {
      at: performance.now(), fonts: document.fonts.size, fontIds: [...document.fonts].map(fontId),
      fontFamilies: [...document.fonts].map((face) => face.family), workers: state.workers.size, urls: state.urls.size,
      created: state.createdWorkers.size, terminated: state.terminatedWorkers.size,
      createdUrls: state.createdUrls.size, revokedUrls: state.revokedUrls.size,
      byName: Object.fromEntries(names.map((name) => [name, {
        created: state.workerRecords.filter((record) => record.name === name).length,
        terminated: state.workerRecords.filter((record) => record.name === name && record.terminatedAt !== null).length,
        active: [...state.workers].filter((worker) => state.workerInfo.get(worker).name === name).length,
        urls: [...state.urls].filter((url) => state.urlInfo.get(url)?.name === name).length,
      }])),
      activeWorkers: [...state.workers].map((worker) => ({ ...state.workerInfo.get(worker) })),
      pools: state.pools(), textListeners: state.textListeners(),
    };
  };
  state.startHeartbeat = (source) => {
    const heartbeat = state.heartbeat = { source, startedAt: performance.now(), busyAt: null, workerId: null, timerAt: null, ticks: [], interval: null, timeout: null };
    heartbeat.interval = setInterval(() => heartbeat.ticks.push(performance.now()), 20);
  };
  state.stopHeartbeat = () => {
    const heartbeat = state.heartbeat;
    clearInterval(heartbeat.interval); clearTimeout(heartbeat.timeout);
    state.heartbeat = null;
    const worker = state.workerRecords.find((record) => record.id === heartbeat.workerId);
    const end = worker?.terminatedAt ?? performance.now();
    const ticks = heartbeat.ticks.filter((at) => at >= heartbeat.busyAt && at <= end);
    const points = [heartbeat.busyAt, ...ticks, end];
    return {
      busyAt: heartbeat.busyAt, workerId: heartbeat.workerId, ticksWhileBusy: ticks.length,
      timerDelayMs: heartbeat.timerAt === null ? null : heartbeat.timerAt - heartbeat.busyAt,
      maxGapMs: Math.max(...points.slice(1).map((at, index) => at - points[index])),
      busyMs: end - heartbeat.busyAt,
    };
  };
}

(async () => {
  const pluginDir = path.resolve(process.env.PDF_PLUGIN_DIR || path.join(__dirname, '../..'));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-pdf-resources-'));
  const project = path.join(temporary, 'project');
  const evidence = path.resolve(process.env.PDF_EVIDENCE_DIR || path.join(temporary, 'evidence'));
  const report = { ok: false, pluginDir, faultFonts: [], overlap: null, stalledTermination: null, stalledStartup: null,
    regexTimeouts: [], regexCancellation: [], regexCreationFailure: null, regexLimit: null,
    bookmarks: null, normalCycles: [], pageErrors: [], consoleErrors: [], rendererRemoteRequests: [] };
  let application, page, failure, stage = 'setup';
  try {
    await fs.mkdir(project);
    await fs.mkdir(evidence, { recursive: true });
    const alignmentSource = path.join(__dirname, 'fixtures/alignment.pdf');
    const alignment = await fs.readFile(alignmentSource);
    const fixtureBytes = new Map([
      ['alignment.pdf', alignment],
      ['regex.pdf', onePagePdf(`${text(`${'a'.repeat(80)}!`, 10)}\n${text('Regex recovery phrase', 16, 650)}`)],
      // A single invisible text item exercises the per-page match bound with
      // a small canvas and text layer. Extra characters prove early termination.
      ['limit.pdf', onePagePdf(`${text('Match limit recovery', 16)}\nBT /F1 0.002 Tf 3 Tr 40 640 Td (${'x'.repeat(LIMIT_CHARACTERS)}) Tj ET`)],
      ['bookmarks.pdf', bookmarksPdf()],
      ['notes.txt', Buffer.from('PDF resource test idle text.\n')],
    ]);
    for (const [name, bytes] of fixtureBytes) await fs.writeFile(path.join(project, name), bytes);
    report.fixtureHashes = Object.fromEntries([...fixtureBytes].map(([name, bytes]) => [name, sha256(bytes)]));
    application = await _electron.launch({ executablePath: electronBinary, args: [path.join(__dirname, 'main.cjs')], env: {
      ...process.env, PDF_PLUGIN_DIR: pluginDir, PDF_FIXTURE_DIR: project, PDF_PROFILE_DIR: path.join(temporary, 'profile'),
    } });
    page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => report.pageErrors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('request', (request) => { if (/^https?:/i.test(request.url())) report.rendererRemoteRequests.push(request.url()); });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
    await page.bringToFront();
    await page.getByRole('tree').waitFor();
    assert.equal(new URL(page.url()).protocol, 'file:', 'Regression must use the production file:// IIFE');
    await page.evaluate(instrumentResources);

    const open = (name) => page.getByRole('treeitem').filter({ hasText: name }).click();
    const snapshot = () => page.evaluate(() => window.pdfResourceTest.snapshot());
    const mark = (key) => page.evaluate((name) => { window.pdfResourceTest.marks[name] = performance.now(); }, key);
    const loaded = async (expected) => {
      const layer = expected ? page.locator('.pdf-document .textLayer').filter({ hasText: expected }).first() : page.locator('.pdf-document .textLayer').first();
      await layer.locator('.endOfContent').waitFor({ state: 'attached', timeout: 20000 });
      await page.waitForFunction(() => document.querySelector('.pdf-scroll')?.getAttribute('aria-busy') === 'false');
      await page.evaluate(() => document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(resolve))));
    };
    const idle = async (key, maxMs = 2000) => {
      await bounded(page.waitForFunction(() => {
        const state = window.pdfResourceTest;
        return state.workers.size === 0 && state.urls.size === 0 && document.fonts.size === 0;
      }, null, { polling: 25, timeout: maxMs }), maxMs + 500, `${stage}: resources idle`);
      const resources = await snapshot();
      assert.equal(resources.fonts, 0); assert.equal(resources.workers, 0); assert.equal(resources.urls, 0);
      assert.equal(resources.created, resources.terminated, 'Every native Worker identity must be terminated');
      assert.equal(resources.createdUrls, resources.revokedUrls, 'Every Blob URL identity must be revoked');
      if (key) {
        resources.elapsedMs = await page.evaluate((name) => performance.now() - window.pdfResourceTest.marks[name], key);
        assert(resources.elapsedMs <= maxMs, `${stage}: cleanup took ${resources.elapsedMs}ms (limit ${maxMs}ms)`);
      }
      return resources;
    };
    const closePdf = async (key) => {
      if (key) await mark(key);
      await open('notes.txt');
      await page.locator('.cm-content').getByText('PDF resource test idle text.', { exact: true }).waitFor();
      return idle(key);
    };
    const pdfWorker = async () => {
      const resources = await snapshot();
      const workers = resources.activeWorkers.filter((worker) => worker.name === PDF_WORKER);
      assert.equal(workers.length, 1, 'Expected one named native PDF Worker');
      return workers[0];
    };
    const assertPdfAlive = async (id) => {
      const worker = await pdfWorker();
      assert.equal(worker.id, id, 'Regex failure/cancellation must preserve the native PDF Worker');
      const resources = await snapshot();
      assert.equal(resources.byName[REGEX_WORKER]?.active || 0, 0);
      assert.equal(resources.byName[REGEX_WORKER]?.urls || 0, 0);
    };
    const regexIdle = () => page.waitForFunction(() => {
      const state = window.pdfResourceTest;
      return ![...state.workers].some((worker) => state.workerInfo.get(worker).name === 'file-manager-pdf-regex') &&
        ![...state.urls].some((url) => state.urlInfo.get(url)?.name === 'file-manager-pdf-regex');
    }, null, { polling: 20, timeout: 2000 });
    const input = page.getByRole('searchbox', { name: 'Search in PDF', exact: true });
    const regexButton = page.getByRole('button', { name: 'Use regular expression', exact: true });
    const matches = async (total) => {
      await page.waitForFunction((expected) => {
        const status = document.querySelector('.pdf-search-status')?.textContent || '';
        const count = /^(\d+) \/ (\d+)$/.exec(status);
        return count && Number(count[1]) > 0 && (expected === null ? Number(count[2]) > 0 : Number(count[2]) === expected);
      }, total ?? null);
      await page.locator('.textLayer .highlight.selected').first().waitFor();
      assert.equal(await input.getAttribute('aria-invalid'), 'false');
      assert.equal(await page.getByRole('button', { name: 'Next match', exact: true }).isDisabled(), false);
    };
    const recovery = async () => {
      await input.fill('recovery'); await matches(1);
      assert.equal(await page.locator('.pdf-search-error').count(), 0);
      await regexIdle();
    };
    const searchError = async (message) => {
      const alert = page.getByRole('alert').filter({ hasText: message });
      await alert.waitFor();
      assert.equal(await alert.innerText(), message);
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.equal(await input.getAttribute('aria-describedby'), await alert.getAttribute('id'));
      assert.equal(await page.getByRole('button', { name: 'Previous match', exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Next match', exact: true }).isDisabled(), true);
      assert.equal(await page.locator('.pdf-search-status').innerText(), '');
      await page.waitForFunction(() => document.querySelectorAll('.textLayer .highlight').length === 0);
    };
    const beginBusyRegex = async (pattern, key, heartbeat = false) => {
      await page.evaluate(({ source, name, pulse }) => {
        const state = window.pdfResourceTest;
        state.marks[name] = performance.now();
        if (pulse) state.startHeartbeat(source);
      }, { source: pattern, name: key, pulse: heartbeat });
      await bounded(input.fill(pattern), 1500, 'Enter catastrophic regex');
      await bounded(page.waitForFunction(({ source, name }) => window.pdfResourceTest.regexJobs.some((job) => job.source === source && job.at >= window.pdfResourceTest.marks[name]),
        { source: pattern, name: key }, { polling: 20, timeout: 1500 }), 1700, 'Start independent regex Worker');
      const job = await page.evaluate(({ source, name }) => {
        const state = window.pdfResourceTest;
        const job = state.regexJobs.find((item) => item.source === source && item.at >= state.marks[name]);
        const worker = state.workerRecords.find((record) => record.id === job.workerId);
        return { ...job, name: worker.name, alive: worker.terminatedAt === null, url: worker.url };
      }, { source: pattern, name: key });
      assert.equal(job.name, REGEX_WORKER);
      assert.equal(job.alive, true, 'Cancellation/timeout test must catch the regex Worker while it is busy');
      return job;
    };
    // Observe past the 1000ms deadline: any obsolete error/highlight, even if
    // transient, is a failure. This intentional wait verifies timer cancellation.
    const noStaleResult = () => bounded(page.evaluate(() => new Promise((resolve) => {
      const started = performance.now();
      const result = { alerts: 0, highlights: 0, checks: 0, elapsedMs: 0 };
      const check = () => {
        result.alerts = Math.max(result.alerts, document.querySelectorAll('.pdf-search-error').length);
        result.highlights = Math.max(result.highlights, document.querySelectorAll('.textLayer .highlight').length);
        result.checks++;
        if (performance.now() - started >= 1250) {
          clearInterval(timer); result.elapsedMs = performance.now() - started; resolve(result);
        }
      };
      const timer = setInterval(check, 20); check();
    })), 2000, 'Observe cancelled regex deadline');

    stage = 'idle baseline';
    await open('notes.txt');
    await page.locator('.cm-content').waitFor();
    report.initialIdle = await idle();
    assert.equal(report.initialIdle.fonts, 0, 'Synthetic text-only idle font baseline must be zero');

    stage = 'repeated runtime Worker errors';
    for (let iteration = 1; iteration <= 3; iteration++) {
      await open('alignment.pdf'); await loaded();
      const before = await snapshot();
      assert(before.fonts > 0, 'Embedded-font fixture must register native FontFaces');
      const fault = { iteration, before: before.fonts };
      report.faultFonts.push(fault);
      await page.evaluate((key) => {
        const state = window.pdfResourceTest;
        const worker = [...state.workers].find((item) => state.workerInfo.get(item).name === 'file-manager-pdf');
        if (!worker) throw new Error('No PDF Worker available for the fault');
        state.marks[key] = performance.now();
        worker.dispatchEvent(new ErrorEvent('error', { message: 'Synthetic runtime PDF Worker failure', cancelable: true }));
      }, `fault-${iteration}`);
      await page.getByRole('alert').filter({ hasText: 'Could not display this PDF' }).waitFor();
      const after = await idle(`fault-${iteration}`);
      Object.assign(fault, { after: after.fonts, elapsedMs: after.elapsedMs, workers: after.workers, urls: after.urls });
      await closePdf();
    }

    stage = 'failed document overlaps new fonts';
    await open('alignment.pdf'); await loaded();
    const old = await snapshot();
    assert(old.fonts > 0, 'Overlap case must start with embedded FontFaces');
    const oldWorker = await pdfWorker();
    await page.getByRole('button', { name: 'Reload from disk', exact: true }).evaluate((element) => {
      const state = window.pdfResourceTest;
      state.marks.overlap = performance.now();
      const worker = [...state.workers].find((item) => state.workerInfo.get(item).name === 'file-manager-pdf');
      worker.dispatchEvent(new ErrorEvent('error', { message: 'Synthetic overlapping PDF Worker failure', cancelable: true }));
      element.click(); // Reload the same PDF in this task, before old cleanup.
    });
    await page.waitForFunction((id) => [...window.pdfResourceTest.workers].some((worker) => {
      const info = window.pdfResourceTest.workerInfo.get(worker);
      return info.name === 'file-manager-pdf' && info.id !== id;
    }), oldWorker.id);
    await loaded();
    const reopened = await snapshot();
    const newFaces = reopened.fontIds.filter((id) => !old.fontIds.includes(id));
    assert(newFaces.length > 0, 'Reopened document must own new FontFace identities');
    await page.waitForFunction((ids) => ids.every((id) => window.pdfResourceTest.removedFontIds.has(id)), old.fontIds, { polling: 25, timeout: 2000 });
    const overlap = await page.evaluate(({ oldIds, newIds }) => {
      const state = window.pdfResourceTest;
      const firstNewAdd = Math.min(...state.fontEvents.filter((event) => event.method === 'add' && newIds.includes(event.id)).map((event) => event.at));
      const lastOldRemoval = Math.max(...state.fontEvents.filter((event) => event.method !== 'add' && oldIds.includes(event.id)).map((event) => event.at));
      const active = state.snapshot();
      return { oldFonts: oldIds.length, newFonts: newIds.length, firstNewAdd, lastOldRemoval,
        actualOverlap: firstNewAdd < lastOldRemoval, newFontsRemain: newIds.every((id) => active.fontIds.includes(id)),
        elapsedMs: performance.now() - state.marks.overlap, active };
    }, { oldIds: old.fontIds, newIds: newFaces });
    report.overlap = overlap;
    assert.equal(overlap.actualOverlap, true, 'New fonts must load before the old failed document finishes cleanup');
    assert.equal(overlap.newFontsRemain, true, 'Old document cleanup removed fonts owned by the reopened document');
    assert.equal(overlap.active.fonts, newFaces.length);
    assert.equal(overlap.active.byName[PDF_WORKER].active, 1);
    assert.equal(await page.getByRole('alert').count(), 0, 'Old failure must not replace the reopened PDF');
    report.overlap.closed = await closePdf('overlap-close');

    stage = 'unacknowledged Terminate';
    await open('alignment.pdf'); await loaded();
    const terminationBefore = await snapshot();
    const terminateFault = await page.evaluate(() => {
      const state = window.pdfResourceTest;
      state.suppressActions.add('Terminate');
      return { errors: state.workerErrors.length, suppressed: state.suppressed.length };
    });
    try {
      const after = await closePdf('stalled-terminate');
      const injected = await page.evaluate((offset) => ({ suppressed: window.pdfResourceTest.suppressed.slice(offset), errors: window.pdfResourceTest.workerErrors.length }), terminateFault.suppressed);
      report.stalledTermination = { fontsBefore: terminationBefore.fonts, elapsedMs: after.elapsedMs, after, ...injected };
      assert(terminationBefore.fonts > 0);
      assert(injected.suppressed.some((entry) => entry.name === PDF_WORKER && entry.action === 'Terminate'), 'Fault must suppress the native PDF Terminate action');
      assert.equal(injected.errors, terminateFault.errors, 'Terminate timeout must recover without any ErrorEvent rescue');
    } finally {
      await page.evaluate(() => window.pdfResourceTest.suppressActions.delete('Terminate'));
    }

    stage = 'unacknowledged startup GetDocRequest';
    const startupFault = await page.evaluate(() => {
      const state = window.pdfResourceTest;
      state.suppressActions.add('GetDocRequest');
      return { errors: state.workerErrors.length, suppressed: state.suppressed.length };
    });
    try {
      await open('alignment.pdf');
      await page.waitForFunction((offset) => window.pdfResourceTest.suppressed.slice(offset).some((entry) => entry.action === 'GetDocRequest'), startupFault.suppressed, { polling: 20, timeout: 5000 });
      const before = await snapshot();
      assert.equal(before.byName[PDF_WORKER].active, 1);
      const after = await closePdf('stalled-setup');
      const injected = await page.evaluate((offset) => ({ suppressed: window.pdfResourceTest.suppressed.slice(offset), errors: window.pdfResourceTest.workerErrors.length }), startupFault.suppressed);
      assert.equal(injected.errors, startupFault.errors, 'Startup cleanup must not use an ErrorEvent rescue');
      report.stalledStartup = { elapsedMs: after.elapsedMs, before, after, ...injected };
    } finally {
      await page.evaluate(() => window.pdfResourceTest.suppressActions.delete('GetDocRequest'));
    }

    stage = 'regex timeout and renderer responsiveness';
    await open('regex.pdf'); await loaded('Regex recovery phrase');
    assert((await page.locator('.textLayer').innerText()).includes(`${'a'.repeat(80)}!`), 'PDF must expose one continuous catastrophic-regex input');
    const regexPdfWorker = await pdfWorker();
    await page.getByRole('button', { name: 'Search in PDF', exact: true }).click();
    await recovery();
    await regexButton.click(); await matches(1); await regexIdle();
    for (const [index, pattern] of ['(a+)+b', '(a|aa)+b'].entries()) {
      const key = `regex-timeout-${index}`;
      const job = await beginBusyRegex(pattern, key, true);
      await bounded(page.waitForFunction((message) => document.querySelector('.pdf-search-error')?.textContent === message, TIMEOUT_ALERT,
        { polling: 20, timeout: 2500 }), 2750, 'Regex timeout alert');
      const elapsedMs = await page.evaluate((name) => performance.now() - window.pdfResourceTest.marks[name], key);
      const heartbeat = await page.evaluate(() => window.pdfResourceTest.stopHeartbeat());
      report.regexTimeouts.push({ pattern, elapsedMs, job, heartbeat });
      assert(elapsedMs <= 2500, `Regex timeout alert took ${elapsedMs}ms`);
      assert(heartbeat.ticksWhileBusy >= 5, `Renderer heartbeat stalled during regex: ${JSON.stringify(heartbeat)}`);
      assert(heartbeat.timerDelayMs !== null && heartbeat.timerDelayMs < 300, 'Renderer setTimeout must execute promptly while regex is busy');
      assert(heartbeat.maxGapMs < 500, 'Renderer must remain responsive throughout regex matching');
      await searchError(TIMEOUT_ALERT); await regexIdle(); await assertPdfAlive(regexPdfWorker.id);
      const revoked = await page.evaluate((url) => window.pdfResourceTest.revokedUrls.has(url), job.url);
      assert.equal(revoked, true, 'Timed-out regex Worker URL must be revoked');
      await recovery();
    }

    stage = 'Escape cancels busy regex';
    const escapeJob = await beginBusyRegex('(a+)+b', 'escape-busy');
    await mark('escape-cancel');
    await input.press('Escape'); await input.waitFor({ state: 'hidden' }); await regexIdle();
    const escapeElapsed = await page.evaluate(() => performance.now() - window.pdfResourceTest.marks['escape-cancel']);
    assert(escapeElapsed < 500, `Escape took ${escapeElapsed}ms to release the busy regex Worker`);
    await assertPdfAlive(regexPdfWorker.id);
    const escapeObservation = await noStaleResult();
    assert.equal(escapeObservation.alerts, 0); assert.equal(escapeObservation.highlights, 0);
    report.regexCancellation.push({ action: 'Escape', elapsedMs: escapeElapsed, job: escapeJob, observation: escapeObservation });
    await page.getByRole('button', { name: 'Search in PDF', exact: true }).click(); await recovery();

    stage = 'regex Worker construction failure';
    const attemptsBefore = await page.evaluate(() => {
      window.pdfResourceTest.failRegexConstruction = true;
      return window.pdfResourceTest.creationFailures.length;
    });
    try {
      await input.fill('recovery\\b'); await searchError(INVALID_ALERT); await regexIdle();
      const faults = await page.evaluate((offset) => window.pdfResourceTest.creationFailures.slice(offset).map((attempt) => ({ ...attempt,
        urlRevoked: window.pdfResourceTest.revokedUrls.has(attempt.url), urlActive: window.pdfResourceTest.urls.has(attempt.url),
      })), attemptsBefore);
      assert.equal(faults.length, 1, 'Expected exactly one injected regex construction failure');
      assert.equal(faults[0].name, REGEX_WORKER); assert.equal(faults[0].urlRevoked, true); assert.equal(faults[0].urlActive, false);
      await assertPdfAlive(regexPdfWorker.id);
      report.regexCreationFailure = { faults };
    } finally {
      await page.evaluate(() => { window.pdfResourceTest.failRegexConstruction = false; });
    }
    await recovery(); report.regexCreationFailure.recovered = true;

    stage = 'document switch cancels busy regex';
    const switchJob = await beginBusyRegex('(a|aa)+b', 'switch-busy');
    const switchIdle = await closePdf('regex-switch');
    const switchRelease = await page.evaluate((id) => {
      const state = window.pdfResourceTest;
      return state.workerRecords.find((record) => record.id === id).terminatedAt - state.marks['regex-switch'];
    }, switchJob.workerId);
    assert(switchRelease >= 0 && switchRelease < 500, `Switch took ${switchRelease}ms to release the busy regex Worker`);
    const switchObservation = await noStaleResult();
    assert.equal(switchObservation.alerts, 0); assert.equal(switchObservation.highlights, 0);
    report.regexCancellation.push({ action: 'document switch', elapsedMs: switchRelease, job: switchJob, idle: switchIdle, observation: switchObservation });
    await open('regex.pdf'); await loaded('Regex recovery phrase');
    await page.getByRole('button', { name: 'Search in PDF', exact: true }).click();
    await recovery(); await closePdf('regex-recovered-close');

    stage = 'regex per-page match limit';
    await open('limit.pdf'); await loaded('Match limit recovery');
    const limitPdfWorker = await pdfWorker();
    const extractedHits = await page.locator('.textLayer').evaluate((layer) => [...layer.textContent].filter((character) => character === 'x').length);
    assert.equal(extractedHits, LIMIT_CHARACTERS, 'Compact limit fixture must expose more than 100000 hits on one page');
    await page.getByRole('button', { name: 'Search in PDF', exact: true }).click();
    await recovery(); await regexButton.click(); await matches(1); await regexIdle();
    await page.evaluate(() => { window.pdfResourceTest.probeRegexExec = true; });
    await mark('match-limit'); await input.fill('x');
    await bounded(page.waitForFunction((message) => document.querySelector('.pdf-search-error')?.textContent === message, LIMIT_ALERT,
      { polling: 20, timeout: 2500 }), 2750, 'Regex match-limit alert');
    await searchError(LIMIT_ALERT); await regexIdle(); await assertPdfAlive(limitPdfWorker.id);
    const limit = await page.evaluate(() => {
      const state = window.pdfResourceTest;
      const job = state.regexJobs.find((item) => item.source === 'x' && item.at >= state.marks['match-limit']);
      const reply = state.regexReplies.find((item) => item.workerId === job?.workerId && item.id === job?.id);
      return { elapsedMs: performance.now() - state.marks['match-limit'], job, reply };
    });
    report.regexLimit = { fixtureBytes: fixtureBytes.get('limit.pdf').length, extractedHits, ...limit };
    assert(limit.elapsedMs <= 2500); assert.equal(limit.reply?.error, 'LIMIT');
    assert(limit.job.contentLength > 100000);
    assert.equal(limit.reply.execCalls, 100001, 'Matcher must stop on the first hit beyond the 100000-match bound');
    await page.evaluate(() => { window.pdfResourceTest.probeRegexExec = false; });
    await recovery(); await closePdf('limit-close');

    stage = 'same-page XYZ bookmark listener ownership';
    await open('bookmarks.pdf'); await loaded('Bookmarked page one');
    await page.evaluate(() => { window.pdfResourceTest.bookmarkBus = window.pdfResourceTest.lastBus; });
    const bookmarkBaseline = await page.evaluate(() => ({ busId: window.pdfResourceTest.busIds.get(window.pdfResourceTest.bookmarkBus), count: window.pdfResourceTest.textListeners() }));
    assert(bookmarkBaseline.busId, 'Capture the document EventBus through on()');
    await page.getByRole('button', { name: 'Navigation', exact: true }).click();
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    const sameBookmark = page.getByRole('button', { name: 'Same page XYZ', exact: true });
    await sameBookmark.waitFor();
    await loaded('Bookmarked page one'); // Sidebar resize must finish first.
    const listenerCounts = [];
    for (let click = 0; click < 30; click++) {
      await sameBookmark.click();
      await page.waitForFunction(() => document.querySelector('input[aria-label="Page number"]')?.value === '1');
      listenerCounts.push(await page.evaluate(() => window.pdfResourceTest.textListeners()));
    }
    report.bookmarks = { ...bookmarkBaseline, samePageClicks: 30, listenerCounts };
    assert(bookmarkBaseline.count <= 1, `Unexpected bookmark listener baseline ${bookmarkBaseline.count}`);
    assert(listenerCounts.every((count) => count === bookmarkBaseline.count && count <= 1), `Bookmark listeners grew: ${listenerCounts.join(', ')}`);
    await page.getByRole('button', { name: 'Named page two', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Page number"]')?.value === '2');
    await loaded('Bookmarked page two');
    await page.waitForFunction(() => document.activeElement?.classList.contains('textLayer') && document.activeElement.closest('.page')?.dataset.pageNumber === '2');
    report.bookmarks.namedDestinationPage = Number(await page.getByRole('spinbutton', { name: 'Page number', exact: true }).inputValue());
    await sameBookmark.click();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Page number"]')?.value === '1');
    assert.equal(await page.evaluate(() => window.pdfResourceTest.textListeners()), bookmarkBaseline.count);
    await closePdf('bookmarks-close');
    report.bookmarks.afterClose = await page.evaluate(() => window.pdfResourceTest.textListeners());
    assert.equal(report.bookmarks.afterClose, 0, 'Closing the document must remove its bookmark text-layer listener');

    // Warm every transition once before comparing idle editor pools. Absolute
    // zero would falsely flag CodeMirror's own active ResizeObserver/listeners.
    const normalCycle = async (index) => {
      await open('alignment.pdf'); await loaded();
      assert((await snapshot()).fonts > 0);
      await page.getByRole('button', { name: 'Navigation', exact: true }).click();
      await page.locator('.pdf-thumbnail[aria-busy="false"] canvas').first().waitFor();
      await page.getByRole('tab', { name: 'Document info', exact: true }).click();
      await page.locator('.pdf-document-info').getByText('alignment.pdf', { exact: true }).waitFor();
      await page.getByRole('tab', { name: 'Outline', exact: true }).click();
      await page.getByText('This PDF has no embedded outline or bookmarks.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Close PDF navigation', exact: true }).click();
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await page.getByRole('button', { name: '100%', exact: true }).click();
      await page.getByRole('button', { name: 'Fit width', exact: true }).click(); await loaded();
      await page.getByRole('button', { name: 'Search in PDF', exact: true }).click();
      await input.fill('finite'); await matches();
      if (index % 3 === 0) { await regexButton.click(); await input.fill('finite|union'); await matches(); }
      await input.press('Escape'); await input.waitFor({ state: 'hidden' });
      return closePdf(`normal-${index}`);
    };
    stage = 'warm idle text resource pools';
    await normalCycle(0);
    // CodeMirror may schedule its idle measurement; compare stable text state.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1200)));
    report.idleTextBaseline = (await snapshot()).pools;
    for (let iteration = 1; iteration <= NORMAL_CYCLES; iteration++) {
      stage = `normal open/close cycle ${iteration}`;
      const resources = await normalCycle(iteration);
      await page.waitForFunction((expected) => JSON.stringify(window.pdfResourceTest.pools()) === expected,
        JSON.stringify(report.idleTextBaseline), { polling: 50, timeout: 2000 });
      resources.pools = (await snapshot()).pools;
      report.normalCycles.push({ iteration, elapsedMs: resources.elapsedMs, fonts: resources.fonts, workers: resources.workers, urls: resources.urls, pools: resources.pools });
      assert.deepEqual(resources.pools, report.idleTextBaseline, `Idle window/document listener or observer pool grew after cycle ${iteration}`);
    }

    stage = 'final resource and byte invariants';
    report.finalResources = await idle();
    const identities = await page.evaluate(() => {
      const state = window.pdfResourceTest;
      return {
        everyWorkerTerminated: [...state.createdWorkers].every((worker) => state.terminatedWorkers.has(worker)),
        everyUrlRevoked: [...state.createdUrls].every((url) => state.revokedUrls.has(url)),
        workerRecords: state.workerRecords, urlRecords: [...state.urlInfo.values()], workerErrors: state.workerErrors,
      };
    });
    assert.equal(identities.everyWorkerTerminated, true); assert.equal(identities.everyUrlRevoked, true);
    report.workerRecords = identities.workerRecords;
    report.urlRecords = identities.urlRecords;
    report.workerErrors = identities.workerErrors;
    assert.equal(report.workerErrors.length, 4, 'Only the three runtime faults and overlap fault should dispatch ErrorEvents');
    report.remoteRequests = await application.evaluate(() => global.blockedPdfRequests);
    assert.deepEqual(report.remoteRequests, []); assert.deepEqual(report.rendererRemoteRequests, []); assert.deepEqual(report.pageErrors, []);
    for (const [name, bytes] of fixtureBytes) assert.deepEqual(await fs.readFile(path.join(project, name)), bytes, `Synthetic fixture changed: ${name}`);
    assert.deepEqual(await fs.readFile(alignmentSource), alignment, 'Checked-in embedded-font fixture bytes changed');
    report.fixturesUnchanged = true;
  } catch (error) {
    failure = error;
    report.failedStage = stage;
    report.error = { message: String(error), stack: error.stack };
    if (page) {
      report.failureResources = await bounded(page.evaluate(() => window.pdfResourceTest?.snapshot()), 1500, 'Failure resource snapshot').catch(() => null);
      const dom = await bounded(page.locator('body').innerText(), 1500, 'Failure DOM').catch(() => null);
      if (dom !== null) await fs.writeFile(path.join(evidence, 'pdf-resources-failure.txt'), dom).catch(() => {});
      await bounded(page.screenshot({ path: path.join(evidence, 'pdf-resources-failure.png'), timeout: 1500 }), 1800, 'Failure screenshot').catch(() => {});
    }
    if (application) report.remoteRequests = await bounded(application.evaluate(() => global.blockedPdfRequests), 1500, 'Failure remote requests').catch(() => null);
  } finally {
    if (application) {
      try {
        await bounded(application.close(), 8000, 'Close isolated Electron');
        report.electronClosed = true;
      } catch (error) {
        failure ||= error;
        report.closeError = String(error);
        const child = application.process();
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise((resolve) => child.once('exit', resolve));
          child.kill('SIGKILL');
          await bounded(exited, 3000, 'Stop isolated Electron process').catch(() => {});
        }
        report.electronClosed = child.exitCode !== null || child.signalCode !== null;
      }
    }
    try {
      await fs.rm(temporary, { recursive: true, force: true });
      report.temporaryDeleted = true;
    } catch (error) {
      failure ||= error; report.cleanupError = String(error);
    }
  }
  report.ok = !failure;
  if (process.env.PDF_EVIDENCE_DIR) {
    await fs.mkdir(evidence, { recursive: true });
    await fs.writeFile(path.join(evidence, 'pdf-resources-result.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report, null, 2));
  if (failure) throw failure;
})().catch((error) => { console.error(error); process.exitCode = 1; });
