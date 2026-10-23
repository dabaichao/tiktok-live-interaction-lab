const { app, BrowserWindow, session } = require('electron');
const { randomUUID } = require('node:crypto');
const { isOfficialPage, loginCookieHeader, loginCookieExpiry } = require('./policy.cjs');

// No HTTP listener, no remote-debugging port, no preload, no access to the user's
// Chrome/Edge profile. Only this child process and its parent share the IPC pipe.
let attemptId, win, loginSession, poll, closing = false, sent = false, lastHeader = '', stableAt = 0;
function send(type, extra = {}) {
  if (process.connected) { try { process.send({ type, attemptId, ...extra }, () => {}); } catch {} }
}
async function quit() {
  if (closing) return;
  closing = true;
  clearInterval(poll);
  if (win && !win.isDestroyed()) win.destroy();
  const fallback = setTimeout(() => app.exit(0), 2500);
  try { await loginSession?.clearStorageData(); await loginSession?.clearCache(); } catch {}
  lastHeader = '';
  clearTimeout(fallback);
  app.exit(0);
}

async function collect() {
  if (closing || sent || !loginSession) return;
  try {
    const cookies = await loginSession.cookies.get({ url: 'https://live.douyin.com/' });
    const header = loginCookieHeader(cookies);
    if (closing || sent) return;
    if (!header) { lastHeader = ''; stableAt = 0; return; }
    if (header !== lastHeader) { lastHeader = header; stableAt = Date.now(); return; }
    // Allow related cookies to settle after QR confirmation, not just the first
    // session cookie. This indicates presence, NOT a platform gift entitlement.
    if (Date.now() - stableAt < 2000) return;
    sent = true;
    const expiresAt = loginCookieExpiry(cookies);
    send('credentials', { cookie: header, ...(expiresAt ? { expiresAt } : {}) });
    lastHeader = '';
    if (win && !win.isDestroyed()) win.setTitle('登录态已获取 · 正在同步到本机后台');
  } catch { send('error'); await quit(); }
}

async function open() {
  await app.whenReady();
  if (closing) return;
  loginSession = session.fromPartition(`douyin-login-${randomUUID()}`, { cache: false });
  loginSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  loginSession.setPermissionCheckHandler(() => false);
  loginSession.on('will-download', event => event.preventDefault());
  win = new BrowserWindow({
    width: 1080, height: 820, minWidth: 720, minHeight: 620,
    title: '抖音官方网页登录 · 请点击登录并扫码，完成后自动同步',
    autoHideMenuBar: true, show: false,
    webPreferences: { session: loginSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, webviewTag: false, devTools: false, safeDialogs: true,
      disableDialogs: true, spellcheck: false, backgroundThrottling: false },
  });
  win.removeMenu();
  win.show();
  win.focus();
  win.webContents.on('page-title-updated', event => event.preventDefault());
  win.webContents.on('will-navigate', (event, url) => { if (!isOfficialPage(url)) event.preventDefault(); });
  win.webContents.on('will-redirect', (event, url) => { if (event.isMainFrame && !isOfficialPage(url)) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOfficialPage(url)) void win.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.webContents.on('render-process-gone', () => { if (!closing) { send('error'); void quit(); } });
  win.on('closed', () => { if (!closing) { send('cancelled'); void quit(); } });
  poll = setInterval(() => void collect(), 1000);
  try {
    await win.loadURL('https://live.douyin.com/');
    if (!closing && !sent) send('waiting');
  }
  catch { if (!closing) { send('error'); void quit(); } }
}

process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'init' && !attemptId && typeof message.attemptId === 'string') {
    attemptId = message.attemptId;
    void open().catch(() => { send('error'); void quit(); });
  } else if (message.type === 'focus' && win && !win.isDestroyed()) { win.show(); win.focus(); }
  else if (message.type === 'accepted' || message.type === 'cancel') void quit();
});
process.on('disconnect', () => void quit());
app.on('window-all-closed', () => { if (!closing) void quit(); });
process.on('uncaughtException', () => { send('error'); void quit(); });
process.on('unhandledRejection', () => { send('error'); void quit(); });
if (!process.send) app.exit(1);
else send('boot');
