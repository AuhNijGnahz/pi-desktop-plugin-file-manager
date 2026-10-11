const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const scratch = process.env.PI_SCRATCH_DIR;
const root = process.cwd();
const qa = createRequire(path.join(scratch, 'pdf-search-review/tests/electron/package.json'));
const { _electron } = qa('playwright');


(async () => {
  const source = process.env.PDF_ALIGNMENT_FIXTURE || path.join(root, 'tests/electron/fixtures/alignment.pdf');
  const temporary = await fs.mkdtemp(path.join(scratch, 'pdf6-alignment-check-'));
  const fixtures = path.join(temporary, 'project');
  await fs.mkdir(fixtures);
  const bytes = await fs.readFile(source);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(fixtures, 'alignment.pdf'), bytes);
  await fs.writeFile(path.join(fixtures, 'notes.txt'), 'Alignment fixture closed.');
  const app = await _electron.launch({ executablePath: qa('electron'), args: [path.join(root, 'tests/electron/main.cjs')], env: { ...process.env, PDF_PLUGIN_DIR: process.env.PDF_PLUGIN_DIR || root, PDF_FIXTURE_DIR: fixtures, PDF_PROFILE_DIR: path.join(temporary, 'profile') } });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(String(error)));
    await page.getByRole('tree').waitFor();
    await page.evaluate(() => {
      const NativeWorker = window.Worker;
      window.pdfTestResources = { created: 0, terminated: 0, workers: new Set(), urls: new Set() };
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); window.pdfTestResources.created++; window.pdfTestResources.workers.add(this); }
        terminate() { if (window.pdfTestResources.workers.delete(this)) window.pdfTestResources.terminated++; return super.terminate(); }
      };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); window.pdfTestResources.urls.add(url); return url; };
      URL.revokeObjectURL = url => { window.pdfTestResources.urls.delete(url); return revoke(url); };
    });
    await page.getByRole('treeitem').filter({ hasText: 'alignment.pdf' }).click();
    await page.locator('.textLayer span[role="presentation"]').first().waitFor();
    await page.getByRole('button', { name: '100%', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.pdf-scroll').getAttribute('aria-busy') === 'false');
    await page.evaluate(() => document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const measurement = await page.locator('.pdf-document .page[data-page-number="1"]').evaluate((element) => {
      const canvas = element.querySelector('canvas');
      const canvasRect = canvas.getBoundingClientRect();
      const words = [...element.querySelectorAll('.textLayer span[role="presentation"]')].filter(span => ['finite', 'union', 'selected'].includes(span.textContent));
      return { canvas: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height, pixels: [canvas.width, canvas.height] }, words: words.map(span => { const r = span.getBoundingClientRect(); return { text: span.textContent, rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom } }; }) };
    });
    assert(measurement.words.length >= 3, 'embedded-font fixture must expose exact word spans');
    const withInk = await page.locator('.pdf-document .page[data-page-number="1"]').evaluate((element, data) => {
      const canvas = element.querySelector('canvas');
      const canvasRect = canvas.getBoundingClientRect();
      const ratio = canvas.width / canvasRect.width;
      const locate = (rangeRect) => {
        const y0 = Math.max(0, Math.floor((rangeRect.top - canvasRect.top - 3) * ratio));
        const y1 = Math.min(canvas.height, Math.ceil((rangeRect.bottom - canvasRect.top + 3) * ratio));
        const columns = [];
        const pixels = canvas.getContext('2d').getImageData(0, y0, canvas.width, y1 - y0).data;
        for (let x = 0; x < canvas.width; x++) {
          for (let y = 0; y < y1 - y0; y++) {
            const pixel = (y * canvas.width + x) * 4;
            if (pixels[pixel + 3] > 0 && pixels[pixel] < 150 && pixels[pixel + 1] < 150 && pixels[pixel + 2] < 150) { columns.push(x); break; }
          }
        }
        const groups = [];
        for (const x of columns) {
          const previous = groups.at(-1);
          if (!previous || x - previous.at(-1) > Math.ceil(ratio * 3)) groups.push([x]);
          else previous.push(x);
        }
        const domCenter = (rangeRect.left + rangeRect.right) / 2;
        const candidates = groups.map(group => ({ left: canvasRect.left + group[0] / ratio, right: canvasRect.left + (group.at(-1) + 1) / ratio }));
        return candidates.reduce((best, candidate) => Math.abs((candidate.left + candidate.right) / 2 - domCenter) < Math.abs((best.left + best.right) / 2 - domCenter) ? candidate : best, candidates[0] || null);
      };
      return data.words.map(word => ({ ...word, ink: locate(word.rect) }));
    }, measurement);
    for (const word of withInk) {
      assert(word.ink, `canvas ink must be found for ${word.text}`);
      assert(Math.abs(word.ink.left - word.rect.left) < 8, `${word.text} left edge drifted: ${word.ink.left - word.rect.left}px`);
      assert(Math.abs(word.ink.right - word.rect.right) < 8, `${word.text} right edge drifted: ${word.ink.right - word.rect.right}px`);
    }
    const points = await page.locator('.pdf-document .page[data-page-number="1"]').evaluate(element => {
      const spans = [...element.querySelectorAll('.textLayer span[role="presentation"]')];
      const finite = spans.find(span => span.textContent === 'finite');
      const union = spans.find(span => span.textContent === 'union');
      if (!finite || !union) return null;
      const a = finite.getBoundingClientRect();
      const b = union.getBoundingClientRect();
      return { finite: { left: a.left, y: a.top + a.height / 2 }, union: { right: b.right, y: b.top + b.height / 2 } };
    });
    assert(points);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.move(points.finite.left + 1, points.finite.y);
    await page.mouse.down();
    await page.mouse.move(points.union.right - 1, points.union.y, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.getSelection().toString()), 'finite union');
    await page.getByRole('treeitem').filter({ hasText: 'notes.txt' }).click();
    await page.waitForFunction(() => document.querySelector('.pdf-scroll') === null);
    await page.waitForFunction(() => {
      const resources = window.pdfTestResources;
      return resources && resources.workers.size === 0 && resources.urls.size === 0 && resources.created === resources.terminated;
    });
    const resources = await page.evaluate(() => ({ created: window.pdfTestResources.created, terminated: window.pdfTestResources.terminated, active: window.pdfTestResources.workers.size, urls: window.pdfTestResources.urls.size }));
    const requests = await app.evaluate(() => global.blockedPdfRequests);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
    assert.deepEqual(resources, { created: resources.created, terminated: resources.created, active: 0, urls: 0 });
    const report = { ok: true, measurement: withInk, selected: 'finite union', resources, requests, errors, hash };
    await fs.writeFile(path.join(scratch, 'pdf6-alignment-fixture-result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await app.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
