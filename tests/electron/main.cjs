const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
app.setPath('userData', process.env.PDF_PROFILE_DIR);
let settings = { fmPrefs: { watchFiles: true } };
global.pi = {
  workspace: { get: async () => ({ path: process.env.PDF_FIXTURE_DIR, name: 'Synthetic PDF project' }) },
  plugin: { getDataPath: async () => process.env.PDF_PROFILE_DIR, getSettings: async () => settings, setSettings: async (value) => { settings = value; } },
};
const plugin = require(path.join(process.env.PDF_PLUGIN_DIR, 'main.js'));
global.testAppearance = { base: 'dark', locale: 'en' };
global.blockedPdfRequests = [];
app.whenReady().then(async () => {
  await plugin.onLoad();
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const remote = /^https?:/i.test(details.url);
    if (remote) global.blockedPdfRequests.push(details.url);
    callback({ cancel: remote });
  });
  ipcMain.handle('bridge', async (_event, channel, payload) => {
    if (channel === 'app.getAppearance') return global.testAppearance;
    if (channel === 'workspace.get') return global.pi.workspace.get();
    return plugin.onPanelInvoke(channel, payload);
  });
  const window = new BrowserWindow({ width: 1250, height: 880, show: true, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await window.loadFile(path.join(process.env.PDF_PLUGIN_DIR, 'views/index.html'));
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { void plugin.onUnload(); });
