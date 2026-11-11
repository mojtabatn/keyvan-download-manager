'use strict';

// More libuv threads: positional file writes from many connections run in parallel.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  clipboard,
  Menu,
  Tray,
  nativeImage,
  nativeTheme,
  Notification,
  powerSaveBlocker,
  session,
} = require('electron');

const { Settings } = require('./settings');
const { Manager } = require('./engine/manager');
const { testConnection } = require('./engine/http');
const { Windows, resolveTheme, nativeThemeSource } = require('./windows');
const { startIntegrationServer } = require('./integration/server');
const { watchClipboard } = require('./integration/clipboard');
const { PowerActions } = require('./power');

const APP_ID = 'com.mojtaba.downloadmanager';
const ASSETS = path.join(__dirname, '..', 'renderer', 'assets');

// A background app must never freeze behind Electron's modal "JavaScript
// error" dialog: log unexpected errors to <userData>/main.log and keep going.
function logError(kind, err) {
  const line = `[${new Date().toISOString()}] ${kind}: ${(err && err.stack) || err}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'main.log'), line);
  } catch {
    /* ignore */
  }
  console.error(line);
}
process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

// Test/dev overrides (used by the UI check script; harmless otherwise).
if (process.env.DM_USER_DATA) app.setPath('userData', process.env.DM_USER_DATA);
if (process.env.DM_DOWNLOADS) app.setPath('downloads', process.env.DM_DOWNLOADS);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);
Menu.setApplicationMenu(null);

let settings;
let manager;
let windows;
let tray;
let clip;
let power;
let blockerId = null;
let quitting = false;
let shutdownDone = false;
let trayHintShown = false;
let lastActivity = { active: 0, speed: 0, progress: null };
const dialogPayloads = new Map();

const extensionDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'extension') : path.join(__dirname, '..', '..', 'extension'));
const theme = () => resolveTheme(settings.get().theme);
const proxy = () => {
  const p = settings.get().proxy;
  return { type: p.type, host: p.host, port: Number(p.port), username: p.username, password: p.password };
};

// ---------------------------------------------------------------- startup
app.whenReady().then(() => {
  const userData = app.getPath('userData');
  settings = new Settings(path.join(userData, 'settings.json'), app.getPath('downloads'));
  nativeTheme.themeSource = nativeThemeSource(settings.get().theme);
  windows = new Windows(theme);

  manager = new Manager({
    file: path.join(userData, 'downloads.json'),
    getSettings: () => settings.get(),
    getProxy: proxy,
  });
  manager.load();
  wireManagerEvents();
  manager.startTimers();

  power = new PowerActions({
    onState: (s) => {
      windows.broadcast('power:pending', s);
      refreshTrayMenu();
    },
    quitApp: () => quit(),
  });

  registerIpc();
  createTray();
  applyLoginItem();

  const hidden = process.argv.includes('--hidden');
  showMain({ show: !hidden });

  startIntegrationServer({
    version: app.getVersion(),
    isEnabled: () => settings.get().browserIntegration,
    onDownload: (p) => openFromBrowser(p),
  });

  clip = watchClipboard({
    clipboard,
    isEnabled: () => settings.get().clipboardWatch,
    onLink: (url) => openAddDialog({ url, source: 'clipboard' }),
  });

  settings.onChange(onSettingsChanged);
  nativeTheme.on('updated', () => {
    windows.applyTheme();
    windows.broadcast('theme:changed', theme());
  });

  handleArgv(process.argv);
});

app.on('second-instance', (_e, argv) => {
  if (!handleArgv(argv)) windows.openMain();
});

app.on('window-all-closed', () => {
  /* keep running in the tray */
});

app.on('before-quit', (e) => {
  quitting = true;
  if (shutdownDone || !manager) return;
  e.preventDefault();
  manager
    .shutdown()
    .catch(() => {})
    .finally(() => {
      shutdownDone = true;
      app.quit();
    });
});

function quit() {
  quitting = true;
  app.quit();
}

function handleArgv(argv) {
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (url) {
    openAddDialog({ url, source: 'cli' });
    return true;
  }
  return false;
}

function hookMainClose() {
  const main = windows.main;
  if (!main) return;
  main.on('close', (e) => {
    if (quitting || !settings.get().closeToTray) return;
    e.preventDefault();
    main.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: 'Download Manager is still running',
        body: 'Downloads continue in the background. Right-click the tray icon to quit.',
        icon: path.join(ASSETS, 'app-256.png'),
        silent: true,
      }).show();
    }
  });
}

function showMain({ show = true } = {}) {
  const w = windows.openMain({ show });
  if (!w.__closeHooked) {
    w.__closeHooked = true;
    hookMainClose();
  }
}

// ---------------------------------------------------------------- manager -> UI
function wireManagerEvents() {
  manager.on('added', (s) => windows.broadcast('downloads:added', s));
  manager.on('changed', (s) => windows.broadcast('downloads:changed', s));
  manager.on('removed', (id) => {
    windows.broadcast('downloads:removed', id);
    windows.closeProgress(id);
  });
  manager.on('progress', (list) => windows.broadcast('downloads:progress', list));
  manager.on('queue', (q) => {
    windows.broadcast('queue:state', q);
    refreshTrayMenu();
  });
  manager.on('queue-done', () => {
    const action = settings.get().schedule.afterDone;
    if (action && action !== 'none') power.schedule(action);
  });
  manager.on('completed', (s) => {
    const s0 = settings.get();
    const progressOpen = windows.progress.has(s.id);
    if (progressOpen && !s0.showCompleteWindow) windows.closeProgress(s.id);
    if (s0.notifications && Notification.isSupported() && !(progressOpen && s0.showCompleteWindow)) {
      const n = new Notification({ title: 'Download complete', body: s.filename, icon: path.join(ASSETS, 'app-256.png') });
      n.on('click', () => shell.showItemInFolder(s.savePath));
      n.show();
    }
  });
  manager.on('failed', (s) => {
    if (settings.get().notifications && Notification.isSupported() && !windows.progress.has(s.id)) {
      new Notification({ title: 'Download failed', body: `${s.filename}\n${s.error || ''}`, icon: path.join(ASSETS, 'app-256.png') }).show();
    }
  });
  manager.on('activity', (a) => {
    lastActivity = a;
    updateTaskbar(a);
    updateSleepBlocker(a.active > 0);
    if (tray) tray.setToolTip(a.active ? `Download Manager — ${a.active} active · ${fmtSpeed(a.speed)}` : 'Download Manager');
  });
}

function updateTaskbar(a) {
  const main = windows.main;
  if (!main || main.isDestroyed()) return;
  if (!a.active) main.setProgressBar(-1);
  else if (a.progress === -1) main.setProgressBar(2, { mode: 'indeterminate' });
  else main.setProgressBar(Math.max(0.01, a.progress || 0));
}

function updateSleepBlocker(active) {
  const want = active && settings.get().preventSleep;
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension');
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

function fmtSpeed(bps) {
  if (bps >= 1024 * 1024) return `${(bps / 1048576).toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

// ---------------------------------------------------------------- dialogs
function openAddDialog({ url = '', source = 'manual' } = {}) {
  for (const w of windows.dialogs) if (w.__url && w.__url === url && url) return windows.reveal(w);
  const win = windows.openDialog({ mode: 'add', url, source });
  win.__url = url;
  return win;
}

function openFromBrowser(p) {
  if (p.urls && p.urls.length > 1) {
    const win = windows.openDialog({ mode: 'add', url: p.urls.join('\n'), source: 'browser' });
    win.__url = p.urls[0];
    return;
  }
  const token = crypto.randomUUID();
  dialogPayloads.set(token, { ...p, url: p.url || p.urls[0], source: 'browser' });
  setTimeout(() => dialogPayloads.delete(token), 10 * 60 * 1000);
  const win = windows.openDialog({ mode: 'info', token });
  win.__url = p.url;
}

// ---------------------------------------------------------------- tray
function createTray() {
  const img = nativeImage.createEmpty();
  img.addRepresentation({ scaleFactor: 1, buffer: fs.readFileSync(path.join(ASSETS, 'tray-16.png')) });
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(ASSETS, 'tray-32.png')) });
  tray = new Tray(img);
  tray.setToolTip('Download Manager');
  tray.on('click', () => showMain());
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const s = settings.get();
  const items = [
    { label: 'Open Download Manager', click: () => showMain() },
    { label: 'Add Link…', click: () => openAddDialog() },
    { type: 'separator' },
    { label: 'Pause all', click: () => manager.pauseAll() },
    { label: 'Resume all', click: () => manager.resumeAll() },
    manager.queueRunning ? { label: 'Stop queue', click: () => manager.stopQueue() } : { label: 'Start queue', click: () => manager.startQueue() },
    { type: 'separator' },
    { label: 'Normal connection', type: 'radio', checked: s.connectionMode === 'normal', click: () => settings.set({ connectionMode: 'normal' }) },
    { label: 'Secure connection', type: 'radio', checked: s.connectionMode === 'secure', click: () => settings.set({ connectionMode: 'secure' }) },
  ];
  if (power && power.pending) items.push({ type: 'separator' }, { label: `Cancel ${power.pending.action}`, click: () => power.cancel() });
  items.push({ type: 'separator' }, { label: 'Quit', click: () => quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  app.setLoginItemSettings({ openAtLogin: !!settings.get().launchAtStartup, args: ['--hidden'] });
}

function onSettingsChanged(s, prev) {
  if (s.theme !== prev.theme) {
    nativeTheme.themeSource = nativeThemeSource(s.theme);
    windows.applyTheme();
    windows.broadcast('theme:changed', theme());
  }
  if (s.speedLimit !== prev.speedLimit) manager.setSpeedLimit(s.speedLimit);
  if (s.launchAtStartup !== prev.launchAtStartup) applyLoginItem();
  if (s.connectionMode !== prev.connectionMode) refreshTrayMenu();
  if (s.maxConcurrent !== prev.maxConcurrent) manager.pump();
  if (s.preventSleep !== prev.preventSleep) updateSleepBlocker(lastActivity.active > 0);
  windows.broadcast('settings:changed', s);
}

// ---------------------------------------------------------------- external players
function findPlayer() {
  if (process.platform !== 'win32') return null;
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const candidates = [];
  for (const base of pf) {
    candidates.push(path.join(base, 'VideoLAN', 'VLC', 'vlc.exe'));
    candidates.push(path.join(base, 'DAUM', 'PotPlayer', 'PotPlayerMini64.exe'));
    candidates.push(path.join(base, 'DAUM', 'PotPlayer', 'PotPlayerMini.exe'));
    candidates.push(path.join(base, 'MPC-HC', 'mpc-hc64.exe'));
    candidates.push(path.join(base, 'mpv', 'mpv.exe'));
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

// ---------------------------------------------------------------- IPC
function senderWindow(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

/** Asks before taking a download off the list. */
async function confirmRemove(win, snap) {
  const done = snap.status === 'completed';
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Remove', 'Keep'],
    defaultId: 1,
    cancelId: 1,
    title: 'Download Manager',
    message: `Remove “${snap.filename}” from the list?`,
    detail: done ? 'The downloaded file stays on your disk.' : 'The partially downloaded data will be deleted.',
    noLink: true,
  });
  return response === 0;
}

async function runAction(win, { id, action, value }) {
  const dl = manager.get(id);
  if (!dl) return null;
  const s = dl.snapshot();
  switch (action) {
    case 'start':
    case 'resume':
      manager.start(id);
      break;
    case 'pause':
      await manager.pause(id);
      break;
    case 'toggle':
      if (dl.running) await manager.pause(id);
      else manager.start(id);
      break;
    case 'cancel':
      // A running / paused / queued download is canceled but stays in the list;
      // canceling something that is already canceled takes it off the list.
      if (s.status === 'canceled') {
        if (await confirmRemove(win, s)) await manager.remove(id);
      } else {
        windows.closeProgress(id);
        await manager.cancel(id);
      }
      break;
    case 'remove':
      if (s.status === 'completed' || (await confirmRemove(win, s))) await manager.remove(id);
      break;
    case 'delete': {
      // Toolbar "Delete": take the item off the list (optionally the file too).
      const done = s.status === 'completed';
      const opts = {
        type: 'question',
        buttons: ['Delete', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Download Manager',
        message: `Delete “${s.filename}”?`,
        detail: done ? 'It will be removed from the list.' : 'The download stops and is removed from the list; the partially downloaded data is deleted.',
      };
      if (done && fs.existsSync(s.savePath)) {
        opts.checkboxLabel = 'Also delete the file from disk';
        opts.checkboxChecked = false;
      }
      const { response, checkboxChecked } = await dialog.showMessageBox(win, opts);
      if (response === 0) await manager.remove(id, { deleteFile: done && !!checkboxChecked });
      break;
    }
    case 'deleteFile': {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Delete', 'Keep'],
        defaultId: 1,
        cancelId: 1,
        message: `Delete “${s.filename}” from disk?`,
        detail: s.savePath,
        noLink: true,
      });
      if (response === 0) await manager.remove(id, { deleteFile: true });
      break;
    }
    case 'open':
      if (s.status === 'completed') {
        const err = await shell.openPath(s.savePath);
        if (err) windows.broadcast('toast', { text: err });
      } else windows.openProgress(id);
      break;
    case 'openFolder':
      if (fs.existsSync(s.savePath)) shell.showItemInFolder(s.savePath);
      else if (fs.existsSync(dl.tempPath)) shell.showItemInFolder(dl.tempPath);
      else shell.openPath(s.dir);
      break;
    case 'copyUrl':
      clipboard.writeText(s.url);
      clip?.ignore(s.url);
      windows.broadcast('toast', { text: 'Address copied' });
      break;
    case 'redownload':
      await manager.redownload(id);
      break;
    case 'refresh':
      windows.openDialog({ mode: 'refresh', id, url: s.url });
      break;
    case 'refreshUrl':
      await manager.refreshUrl(id, String(value || ''));
      break;
    case 'secure':
      await manager.setSecure(id, !!value);
      break;
    case 'queue':
      manager.setQueued(id, !!value);
      break;
    case 'moveUp':
      manager.moveInQueue(id, 'up');
      break;
    case 'moveDown':
      manager.moveInQueue(id, 'down');
      break;
    case 'progress':
      windows.openProgress(id);
      break;
    case 'connections':
    case 'speedLimit':
      manager.update(id, { [action]: Number(value) || 0 });
      break;
    case 'hash': {
      windows.broadcast('toast', { text: 'Calculating SHA-256…' });
      try {
        const h = await sha256(s.savePath);
        clipboard.writeText(h);
        clip?.ignore(h);
        windows.broadcast('toast', { text: `SHA-256 copied: ${h.slice(0, 16)}…` });
      } catch (e) {
        windows.broadcast('toast', { text: `Couldn't read file: ${e.message}` });
      }
      break;
    }
    default:
      return null;
  }
  return manager.get(id)?.snapshot() || null;
}

function contextMenuFor(win, id) {
  const dl = manager.get(id);
  if (!dl) return;
  const s = dl.snapshot();
  const done = s.status === 'completed';
  const act = (action, value) => () => runAction(win, { id, action, value });
  const tpl = [];
  if (done) tpl.push({ label: 'Open', click: act('open') });
  tpl.push({ label: 'Open folder', click: act('openFolder') });
  tpl.push({ type: 'separator' });
  if (!done) {
    if (dl.running) tpl.push({ label: 'Pause', click: act('pause') });
    else tpl.push({ label: s.status === 'error' ? 'Retry' : 'Resume', click: act('start') });
    if (s.status === 'canceled') tpl.push({ label: 'Restart from beginning', click: act('redownload') });
    tpl.push({ label: 'Show progress window', click: act('progress') });
    tpl.push({ label: s.queued ? 'Remove from queue' : 'Add to queue', click: act('queue', !s.queued) });
    if (s.queued) tpl.push({ label: 'Move up in queue', click: act('moveUp') }, { label: 'Move down in queue', click: act('moveDown') });
    tpl.push({ label: 'Secure connection', type: 'checkbox', checked: s.secure, click: act('secure', !s.secure) });
    tpl.push({ type: 'separator' });
  }
  tpl.push({ label: 'Copy address', click: act('copyUrl') });
  if (!done) tpl.push({ label: 'Refresh link…', click: act('refresh') });
  if (done) tpl.push({ label: 'Download again', click: act('redownload') }, { label: 'Copy SHA-256 checksum', click: act('hash') });
  tpl.push({ type: 'separator' });
  if (done) tpl.push({ label: 'Remove from list', click: act('remove') }, { label: 'Delete file…', click: act('deleteFile') });
  else if (s.status === 'canceled') tpl.push({ label: 'Remove from list…', click: act('remove') });
  else tpl.push({ label: 'Cancel download', click: act('cancel') }, { label: 'Remove from list…', click: act('remove') });
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, (e, ...a) => fn(e, ...a));

  h('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    theme: theme(),
    downloads: app.getPath('downloads'),
    extensionDir: extensionDir(),
  }));
  h('settings:get', () => settings.get());
  h('settings:set', (_e, patch) => settings.set(patch || {}));

  h('downloads:list', () => manager.list());
  h('downloads:detail', (_e, id) => manager.get(id)?.detail() || null);
  h('downloads:probe', async (_e, opts) => {
    try {
      return await manager.probe(String(opts.url || '').trim(), opts);
    } catch (err) {
      const { friendlyError } = require('./engine/download');
      const secure = opts.secure ?? settings.get().connectionMode === 'secure';
      return { error: friendlyError(err, { secure, proxy: proxy() }) };
    }
  });
  h('downloads:add', (e, opts) => {
    const dl = manager.add({ ...opts, secure: opts.secure ?? settings.get().connectionMode === 'secure' });
    if (opts.mode === 'now' && settings.get().showProgressWindow) windows.openProgress(dl.id);
    return dl.snapshot();
  });
  h('downloads:action', (e, payload) => runAction(senderWindow(e), payload || {}));
  h('downloads:contextMenu', (e, id) => contextMenuFor(senderWindow(e), id));
  h('downloads:pauseAll', () => manager.pauseAll());
  h('downloads:resumeAll', () => manager.resumeAll());

  h('queue:start', () => manager.startQueue());
  h('queue:stop', () => manager.stopQueue());
  h('queue:state', () => ({ running: manager.queueRunning }));

  h('dialog:open', (_e, q) => (q && q.mode === 'add' ? openAddDialog(q) : windows.openDialog(q || { mode: 'add' })) && true);
  h('dialog:payload', (_e, token) => {
    const p = dialogPayloads.get(token) || null;
    dialogPayloads.delete(token);
    return p;
  });
  h('dialog:pickFolder', async (e, current) => {
    const r = await dialog.showOpenDialog(senderWindow(e), {
      title: 'Choose a folder',
      defaultPath: current || settings.get().downloadDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  h('disk:free', async (_e, dir) => {
    let p = dir || settings.get().downloadDir;
    while (p && !fs.existsSync(p)) {
      const up = path.dirname(p);
      if (up === p) break;
      p = up;
    }
    try {
      const st = await fs.promises.statfs(p);
      return st.bavail * st.bsize;
    } catch {
      return -1;
    }
  });

  h('connection:set', (_e, mode) => settings.set({ connectionMode: mode === 'secure' ? 'secure' : 'normal' }).connectionMode);
  h('connection:test', async () => {
    try {
      const r = await testConnection(proxy());
      return r;
    } catch (err) {
      const { friendlyError } = require('./engine/download');
      return { ok: false, error: friendlyError(err, { secure: true, proxy: proxy() }) };
    }
  });

  h('player:open', async (_e, q) => {
    const part = 'persist:player';
    const ses = session.fromPartition(part);
    const secure = q.secure ?? settings.get().connectionMode === 'secure';
    const p = proxy();
    await ses.setProxy(secure ? { proxyRules: `${p.type === 'http' ? 'http' : 'socks5'}://${p.host}:${p.port}` } : { mode: 'direct' });
    ses.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
      const headers = { ...d.requestHeaders };
      if (q.referrer) headers.Referer = q.referrer;
      if (q.cookies && sameHost(d.url, q.url)) headers.Cookie = q.cookies;
      cb({ requestHeaders: headers });
    });
    windows.openPlayer({ src: q.url, title: q.title || '', partition: part });
    return true;
  });
  h('player:external', (_e, q) => {
    const exe = findPlayer();
    if (exe) {
      spawn(exe, [q.url], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, player: path.basename(exe) };
    }
    return { ok: false };
  });

  h('window:close', (e) => senderWindow(e)?.close());
  h('window:minimize', (e) => senderWindow(e)?.minimize());
  h('window:resize', (e, height) => windows.resizeContent(senderWindow(e), height));

  h('extension:openFolder', () => shell.openPath(extensionDir()));
  h('power:cancel', () => power.cancel());
  h('power:state', () => (power.pending ? { action: power.pending.action } : null));
  h('shell:openPath', (_e, p) => shell.openPath(String(p || '')));
  h('shell:openProject', () => {
    const url = projectUrl();
    if (!url) return false;
    shell.openExternal(url);
    return true;
  });
}

/** The project's GitHub page (package.json "homepage"); only https GitHub links are opened. */
function projectUrl() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const url = String(pkg.homepage || '');
    return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(url) ? url : '';
  } catch {
    return '';
  }
}

function sameHost(a, b) {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}
