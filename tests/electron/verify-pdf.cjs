const { createRequire } = require('node:module');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const from = (directory) => directory ? createRequire(path.join(directory, 'package.json')) : require;
const { _electron } = from(process.env.PDF_PLAYWRIGHT_DIR)('playwright');
const electronBinary = from(process.env.PDF_ELECTRON_DIR)('electron');

// A valid first page followed by an unresolved page-tree reference.
function missingPagePdf() {
  const stream = 'BT /F1 20 Tf 60 700 Td (First page remains readable) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 99 0 R] /Count 2 /MediaBox [0 0 612 792] >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let document = '%PDF-1.7\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(document));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const start = Buffer.byteLength(document);
  document += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.from(document + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

(async () => {
  const pluginDir = process.env.PDF_PLUGIN_DIR || path.resolve(__dirname, '../..');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pifm-pdf-browser-'));
  const fixtures = path.join(temporary, 'project');
  await fs.cp(path.join(__dirname, 'fixtures'), fixtures, { recursive: true });
  await fs.writeFile(path.join(fixtures, 'later-page-error.pdf'), missingPagePdf());
  await fs.writeFile(path.join(fixtures, 'notes.txt'), 'Text editing remains available.\n');
  const original = await fs.readFile(path.join(fixtures, 'sample.pdf'));
  const evidence = process.env.PDF_EVIDENCE_DIR || path.join(temporary, 'evidence');
  await fs.mkdir(evidence, { recursive: true });
  // Commits belong only to this disposable fixture repository.
  const git = (...args) => execFileSync('git', args, { cwd: fixtures, stdio: 'pipe' });
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=PDF fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic fixtures');
  await fs.copyFile(path.join(fixtures, 'second.pdf'), path.join(fixtures, 'git-changed.pdf'));
  git('add', 'git-changed.pdf');
  git('-c', 'user.name=PDF fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Binary diff baseline');
  await fs.writeFile(path.join(fixtures, 'git-changed.pdf'), original);
  const application = await _electron.launch({ executablePath: electronBinary, args: [path.join(__dirname, 'main.cjs')], env: {
    ...process.env, PDF_PLUGIN_DIR: pluginDir, PDF_FIXTURE_DIR: fixtures, PDF_PROFILE_DIR: path.join(temporary, 'profile'),
  } });
  const results = [];
  const errors = [];
  const messages = [];
  try {
    const page = await application.firstWindow();
    page.setDefaultTimeout(15000);
    await page.bringToFront();
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => { if (message.type() === 'error') messages.push(message.text()); });
    await page.getByRole('tree').waitFor();
    await page.evaluate(() => {
      const NativeWorker = window.Worker;
      window.pdfTestResources = { created: 0, terminated: 0, workers: new Set(), urls: new Set() };
      window.Worker = class extends NativeWorker {
        constructor(...args) { super(...args); window.pdfTestResources.created++; window.pdfTestResources.workers.add(this); }
        terminate() { if (window.pdfTestResources.workers.delete(this)) window.pdfTestResources.terminated++; return super.terminate(); }
      };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { const url = create(blob); window.pdfTestResources.urls.add(url); return url; };
      URL.revokeObjectURL = (url) => { window.pdfTestResources.urls.delete(url); return revoke(url); };
    });
    const open = async (name) => page.getByRole('treeitem').filter({ hasText: name }).click();
    const loaded = async (text) => page.locator('.textLayer').getByText(text, { exact: true }).first().waitFor({ timeout: 20000 });
    await open('sample.pdf');
    await loaded('PDF preview verification - page 1');
    await loaded('中文 PDF 阅读验证：学习与工作');
    const ink = await page.locator('.pdf-document .page[data-page-number="1"] canvas').evaluate((canvas) => {
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 200 || pixels[index + 1] < 200 || pixels[index + 2] < 200) count++;
      return count;
    });
    assert(ink > 1000, `PDF canvas must contain visible ink: ${ink}`);
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
    results.push('production file:// PDF canvas and Chinese/English text; Save unavailable');
    await page.getByRole('button', { name: 'Next page', exact: true }).click();
    await page.getByRole('spinbutton', { name: 'Page number', exact: true }).fill('3');
    await page.getByRole('spinbutton', { name: 'Page number', exact: true }).press('Enter');
    await loaded('PDF preview verification - page 3');
    await page.getByRole('combobox', { name: 'Page layout' }).selectOption('double');
    await page.locator('.pdf-document .spread').first().waitFor();
    await page.getByRole('combobox', { name: 'Page layout' }).selectOption('cover');
    await page.getByRole('combobox', { name: 'Page layout' }).selectOption('single');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await page.getByRole('button', { name: 'Fit width', exact: true }).click();
    await page.getByRole('button', { name: 'Navigation', exact: true }).click();
    await page.locator('.pdf-sidebar canvas').first().waitFor();
    await page.getByRole('tab', { name: 'Outline', exact: true }).click();
    await page.getByText('This PDF has no embedded outline or bookmarks.', { exact: true }).waitFor();
    await page.getByRole('tab', { name: 'Document info', exact: true }).click();
    await page.locator('.pdf-document-info').getByText('sample.pdf', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close PDF navigation' }).click();
    results.push('navigation, zoom/fit, three layouts, thumbnails, empty outline and document info');

    {
      const input = page.getByRole('searchbox', { name: 'Search in PDF', exact: true });
      await page.getByRole('button', { name: 'Search in PDF', exact: true }).click();
      await input.fill('study coach');
      await page.locator('.pdf-search-status').getByText(/\/ 3/).waitFor();
      await page.locator('.textLayer .highlight').first().waitFor();
      const first = await page.locator('.pdf-search-status').innerText();
      await input.press('Enter');
      await page.waitForFunction((previous) => document.querySelector('.pdf-search-status').textContent !== previous, first);
      await input.press('Shift+Enter');
      await page.waitForFunction((expected) => document.querySelector('.pdf-search-status').textContent === expected, first);
      await page.getByRole('button', { name: 'Next match', exact: true }).click();
      await page.waitForFunction((previous) => document.querySelector('.pdf-search-status').textContent !== previous, first);
      await page.getByRole('button', { name: 'Previous match', exact: true }).click();
      await page.waitForFunction((expected) => document.querySelector('.pdf-search-status').textContent === expected, first);
      await input.fill('中文');
      await page.locator('.pdf-search-status').getByText(/\/ 3/).waitFor();
      await page.locator('.textLayer .highlight').first().waitFor();
      await input.fill('a-word-that-does-not-exist');
      await page.getByText('No matches', { exact: true }).waitFor();
      await input.fill('');
      await page.waitForFunction(() => document.querySelectorAll('.textLayer .highlight').length === 0);
      await input.fill('study coach');
      await page.locator('.textLayer .highlight').first().waitFor();
      await input.press('Escape');
      await input.waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelectorAll('.textLayer .highlight').length === 0);
      results.push('English/Chinese cross-page search, count, Enter/Shift+Enter, no match, empty query and Escape clear highlights');
      await page.locator('.pdf-scroll').focus();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
      await input.waitFor();
      await input.fill('study coach');
      await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
      await input.waitFor({ state: 'hidden' });
      await loaded('PDF preview verification - page 1');
      await page.getByRole('button', { name: 'Search in PDF', exact: true }).click();
      await input.fill('study coach');
      await open('second.pdf'); await loaded('Second document: one page only');
      assert.equal(await input.count(), 0);
      results.push('PDF-scoped keyboard shortcut and document switch reset');
    }
    await open('git-changed.pdf'); await loaded('PDF preview verification - page 1');
    await page.getByRole('treeitem').filter({ hasText: 'git-changed.pdf' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'View changes', exact: true }).click();
    await page.getByRole('button', { name: 'Back to the file', exact: true }).click();
    await loaded('PDF preview verification - page 1');
    results.push('PDF binary Git diff and return to preview');
    {
      await open('sample.pdf'); await loaded('PDF preview verification - page 1');
      await fs.copyFile(path.join(fixtures, 'second.pdf'), path.join(fixtures, 'sample.pdf'));
      await loaded('Second document: one page only');
      await fs.writeFile(path.join(fixtures, 'sample.pdf'), original);
      await loaded('PDF preview verification - page 1');
      results.push('filesystem watch reloads changed PDF and restored original');
      await open('notes.txt');
      await page.locator('.cm-content').getByText('Text editing remains available.', { exact: true }).waitFor();
      await fs.writeFile(path.join(fixtures, 'notes.txt'), 'External text update.\n');
      await page.locator('.cm-content').getByText('External text update.', { exact: true }).waitFor();
      await page.locator('.cm-content').click();
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
      await page.keyboard.type(' Unsaved local text.');
      await fs.writeFile(path.join(fixtures, 'notes.txt'), 'External conflicting text.\n');
      await page.getByText('This file changed on disk. Reload to see it — your unsaved changes are still here.', { exact: true }).waitFor();
      assert((await page.locator('.cm-content').innerText()).includes('Unsaved local text.'));
      assert(!(await page.locator('.cm-content').innerText()).includes('External conflicting text.'));
      await open('second.pdf');
      await page.getByRole('dialog').getByRole('button', { name: 'Discard', exact: true }).click();
      await loaded('Second document: one page only');
      await fs.writeFile(path.join(fixtures, 'notes.txt'), 'Text editing remains available.\n');
      results.push('clean text watch reloads; dirty text warns and preserves unsaved buffer');
    }
    await open('broken.pdf'); await page.getByRole('alert').filter({ hasText: 'Could not display this PDF' }).waitFor();
    await open('encrypted.pdf'); await page.getByRole('alert').filter({ hasText: 'requires a password' }).waitFor();
    await open('second.pdf'); await loaded('Second document: one page only');
    results.push('damaged/encrypted errors recover to readable PDF');

    await open('later-page-error.pdf');
    await page.getByRole('alert').filter({ hasText: 'Could not display this PDF' }).waitFor();
    await open('second.pdf'); await loaded('Second document: one page only');
    results.push('valid first page plus damaged later page reports an error and recovers');
    await page.evaluate(() => {
      const worker = Array.from(window.pdfTestResources.workers)[0];
      worker.dispatchEvent(new ErrorEvent('error', { message: 'Synthetic worker failure', cancelable: true }));
    });
    await page.getByRole('alert').filter({ hasText: 'Could not display this PDF' }).waitFor();
    await open('sample.pdf'); await open('second.pdf');
    await loaded('Second document: one page only');
    results.push('worker failure reports an error; rapid switching recovers to current PDF');
    await application.evaluate(({ BrowserWindow }) => {
      global.testAppearance = { base: 'dark', locale: 'zh-CN' };
      BrowserWindow.getAllWindows()[0].webContents.send('test:appearance:changed', global.testAppearance);
      BrowserWindow.getAllWindows()[0].setSize(640, 820);
    });
    await page.getByRole('button', { name: '下一页', exact: true }).waitFor();
    {
      await page.getByRole('button', { name: '在 PDF 中搜索', exact: true }).click();
      await page.getByRole('searchbox', { name: '在 PDF 中搜索', exact: true }).fill('Second');
      await page.locator('.textLayer .highlight').first().waitFor();
      await page.screenshot({ path: path.join(evidence, 'search-narrow.png') });
    }
    await open('notes.txt');
    await page.locator('.cm-content').getByText('Text editing remains available.', { exact: true }).waitFor();
    await page.waitForFunction(() => window.pdfTestResources.workers.size === 0 && window.pdfTestResources.urls.size === 0);
    const resources = await page.evaluate(() => ({ created: window.pdfTestResources.created, terminated: window.pdfTestResources.terminated, active: window.pdfTestResources.workers.size, urls: window.pdfTestResources.urls.size }));
    assert.equal(resources.created, resources.terminated);
    assert.deepEqual(await application.evaluate(() => global.blockedPdfRequests), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(await fs.readFile(path.join(fixtures, 'sample.pdf')), original);
    results.push('Chinese/narrow layout, text viewer, unchanged PDF bytes, no remote requests/page errors, all workers and Blob URLs released');
    console.log(JSON.stringify({ results, resources, pageErrors: errors, consoleErrors: messages }, null, 2));
  } catch (error) {
    const page = await application.firstWindow();
    await page.screenshot({ path: path.join(evidence, 'failure.png') });
    console.error('DOM:', await page.locator('body').innerText(), 'errors:', errors, 'console:', messages,
      'watch:', await page.evaluate(async () => ({ hidden: document.hidden, watch: await window.pluginBridge.invoke('fm.watch', { since: 0 }) })).catch(() => null));
    throw error;
  } finally {
    await application.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
