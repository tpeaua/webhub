'use strict';

const {
  app, BrowserWindow, ipcMain, session, Tray, Menu,
  nativeImage, dialog, shell,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const APP_NAME = 'WebHub';
const SMOKE = process.argv.includes('--smoke');

// Force a consistent identity & data directory regardless of how the app is
// launched (dev `electron .` vs the packaged .app).
app.setName('WebHub');
app.setPath('userData', path.join(app.getPath('appData'), 'WebHub'));

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const configFile = () => path.join(app.getPath('userData'), 'apps.json');
const iconsDir = () => path.join(app.getPath('userData'), 'icons');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let config = { apps: [] };
const windows = new Map();        // appId -> BrowserWindow
const badges = new Map();         // appId -> unread count
const closingForced = new Set();  // appIds allowed to actually close
let tray = null;
let launcher = null;
let isQuitting = false;

// ---------------------------------------------------------------------------
// Seed apps (first run)
// ---------------------------------------------------------------------------
const SEED_APPS = [
  { id: 'chatgpt',         name: 'ChatGPT',            url: 'https://chatgpt.com',           profile: 'personal', color: '#10a37f' },
  { id: 'whatsapp',        name: 'WhatsApp',           url: 'https://web.whatsapp.com',      profile: 'personal', color: '#25D366' },
  { id: 'teams-work',      name: 'Teams (Work)',       url: 'https://teams.microsoft.com',   profile: 'work',     color: '#6264A7' },
  { id: 'outlook-hotmail', name: 'Outlook (Hotmail)',  url: 'https://outlook.live.com/mail/', profile: 'work',    color: '#0078D4' },
  { id: 'gmail-personal',  name: 'Gmail (Personal)',   url: 'https://mail.google.com',       profile: 'personal', color: '#EA4335' },
  { id: 'yahoo-mail',      name: 'Yahoo Mail',         url: 'https://mail.yahoo.com',        profile: 'personal', color: '#6001D2' },
  { id: 'speedtest',       name: 'SpeedTest',          url: 'https://www.speedtest.net',     profile: 'personal', color: '#E91E63' },
  { id: 'messenger',       name: 'Messenger',          url: 'https://www.messenger.com',     profile: 'personal', color: '#2C3E50' },
];

const PALETTE = [
  '#10a37f', '#25D366', '#6264A7', '#EA4335', '#4285F4', '#F25022',
  '#7B83EB', '#0F9D58', '#DB4437', '#F4B400', '#00A4EF', '#FF5C5C',
  '#8E44AD', '#16A085', '#2C3E50', '#E91E63',
];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function slug(s) {
  return String(s || 'default').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}
function randomColor() {
  return PALETTE[Math.floor(Math.random() * PALETTE.length)];
}
function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

function findPython() {
  for (const c of ['/opt/local/bin/python3', '/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3']) {
    if (fs.existsSync(c)) return c;
  }
  return 'python3';
}

function runRebuild() {
  return new Promise((resolve) => {
    const script = path.join(app.getPath('userData'), 'make-apps.py');
    if (!fs.existsSync(script)) {
      resolve({ ok: false, error: 'make-apps.py not found: ' + script });
      return;
    }
    execFile(findPython(), [script], { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(stderr || err.message).slice(0, 1500) });
      else resolve({ ok: true, output: String(stdout).trim().slice(-1500) });
    });
  });
}

let rebuildTimer = null;
function scheduleRebuild(delay = 2500) {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    runRebuild().catch(() => {});
  }, delay);
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
function loadConfig() {
  let raw = null;
  try { raw = fs.readFileSync(configFile(), 'utf8'); } catch { /* first run */ }

  if (raw) {
    try { config = JSON.parse(raw); } catch { config = { apps: [] }; }
  } else {
    config = { apps: SEED_APPS.map((a) => ({ ...a })), seeded: true };
  }
  if (!Array.isArray(config.apps)) config.apps = [];
  // This iMac's Intel iGPU has no Metal/GL driver on Monterey, so software
  // rendering is the reliable default. Users can flip it in the tray menu.
  if (config.gpuDisabled === undefined) config.gpuDisabled = true;
  saveConfig();
}

function saveConfig() {
  try { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); } catch { /* noop */ }
  fs.writeFileSync(configFile(), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// User agent — strip Electron token so Google/Teams don't block sign-in
// ---------------------------------------------------------------------------
function cleanUserAgent() {
  const ua = String(app.userAgentFallback || '');
  const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '150.0.0.0';
  app.userAgentFallback = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + chrome + ' Safari/537.36';
}

// ---------------------------------------------------------------------------
// Sessions & permissions (mic/camera/notifications for Teams & WhatsApp calls)
// ---------------------------------------------------------------------------
const ALLOWED_PERMS = [
  'media', 'notifications', 'fullscreen', 'display-capture',
  'clipboard-sanitized-write', 'clipboard-read', 'pointerLock', 'geolocation',
];

function configureSession(ses) {
  if (!ses || ses.__webhubConfigured) return;
  ses.__webhubConfigured = true;
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(ALLOWED_PERMS.includes(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMS.includes(permission));
}

// ---------------------------------------------------------------------------
// Icon fetching (Google favicon service + site favicon fallbacks)
// ---------------------------------------------------------------------------
async function fetchIconFor(a) {
  const dir = iconsDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }

  let domain = null;
  try { domain = new URL(a.url).hostname; } catch { /* noop */ }

  const candidates = [];
  if (a.customIconUrl) candidates.push(a.customIconUrl);
  if (domain) candidates.push(
    `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/favicon.ico`,
  );

  for (const c of candidates) {
    try {
      const res = await fetch(c, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf || buf.length < 64) continue;

      let ext = null;
      if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) ext = 'ico';
      else if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = 'png';
      else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ext = 'jpg';
      else if (buf[0] === 0x3c) ext = 'svg';
      if (!ext) continue;

      // remove any previously saved icon for this app
      for (const e of ['png', 'ico', 'jpg', 'jpeg', 'svg']) {
        try { fs.unlinkSync(path.join(dir, `${a.id}.${e}`)); } catch { /* noop */ }
      }
      const p = path.join(dir, `${a.id}.${ext}`);
      fs.writeFileSync(p, buf);
      return p;
    } catch { /* try next candidate */ }
  }
  return null;
}

function iconDataURL(a) {
  const dir = iconsDir();
  for (const ext of ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp']) {
    const p = path.join(dir, `${a.id}.${ext}`);
    try {
      const buf = fs.readFileSync(p);
      const mime = ext === 'svg' ? 'image/svg+xml'
        : ext === 'jpg' ? 'image/jpeg'
        : ext === 'jpeg' ? 'image/jpeg'
        : `image/${ext}`;
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch { /* noop */ }
  }
  return null;
}

function serializeApps() {
  return config.apps.map((a) => ({ ...a, icon: iconDataURL(a) }));
}

// ---------------------------------------------------------------------------
// App windows
// ---------------------------------------------------------------------------
function appWindow(a) {
  const existing = windows.get(a.id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }

  const partition = 'persist:' + slug(a.profile || a.id);
  configureSession(session.fromPartition(partition));

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 380,
    title: a.name,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Open target=_blank / popups in the default browser instead of new windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Unread-count → Dock badge (e.g. "(3) WhatsApp", "Gmail (2)").
  win.webContents.on('page-title-updated', (_e, title) => {
    const m = title && (title.match(/^\((\d+)\)/) || title.match(/\((\d+)\)/));
    badges.set(a.id, m ? parseInt(m[1], 10) : 0);
    updateDockBadge();
  });

  win.once('ready-to-show', () => win.show());

  // Closing hides to background (keeps notifications flowing) unless quitting.
  win.on('close', (e) => {
    if (!isQuitting && !closingForced.has(a.id)) {
      e.preventDefault();
      win.hide();
      refreshTray();
    }
  });
  win.on('closed', () => {
    closingForced.delete(a.id);
    windows.delete(a.id);
    badges.delete(a.id);
    updateDockBadge();
    refreshTray();
  });

  win.loadURL(a.url);
  windows.set(a.id, win);
  return win;
}

function forceClose(id) {
  const w = windows.get(id);
  if (w && !w.isDestroyed()) {
    closingForced.add(id);
    w.close();
  }
}

function updateDockBadge() {
  if (!app.dock) return;
  let total = 0;
  for (const n of badges.values()) total += n;
  app.dock.setBadge(total > 0 ? String(total) : '');
}

// ---------------------------------------------------------------------------
// Launcher (home screen)
// ---------------------------------------------------------------------------
function createLauncher() {
  launcher = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 640,
    minHeight: 480,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f5f6f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  launcher.loadFile(path.join(__dirname, 'launcher', 'index.html'));
  launcher.once('ready-to-show', () => launcher.show());
  launcher.on('closed', () => { launcher = null; });
}

function showLauncher() {
  if (!launcher || launcher.isDestroyed()) createLauncher();
  else { launcher.show(); launcher.focus(); }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  if (!icon.isEmpty()) icon.setTemplateImage(true);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showLauncher());
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open ' + APP_NAME, click: () => showLauncher() },
    { type: 'separator' },
    ...config.apps.map((a) => ({
      label: a.name,
      submenu: [
        { label: 'Show', click: () => appWindow(a) },
        { label: 'Reload', click: () => { const w = windows.get(a.id); if (w) w.loadURL(a.url); } },
        { label: 'Quit app', click: () => forceClose(a.id) },
      ],
    })),
    { type: 'separator' },
    {
      label: config.gpuDisabled ? 'Enable graphics acceleration' : 'Disable graphics acceleration',
      click: () => {
        config.gpuDisabled = !config.gpuDisabled;
        saveConfig();
        app.relaunch();
        app.exit(0);
      },
    },
    { label: 'Quit ' + APP_NAME, click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

// ---------------------------------------------------------------------------
// Application menu (minimal: keeps Cmd+Q/C/V/W working, no DevTools)
// ---------------------------------------------------------------------------
function buildAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]));
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------
function registerIpc() {
  ipcMain.handle('apps:list', () => serializeApps());
  ipcMain.handle('apps:profiles', () => [...new Set(config.apps.map((a) => slug(a.profile)))]);

  ipcMain.handle('apps:open', (_e, id) => {
    const a = config.apps.find((x) => x.id === id);
    if (a) appWindow(a);
  });

  ipcMain.handle('apps:add', async (_e, data) => {
    const id = data.id || 'app-' + crypto.randomBytes(4).toString('hex');
    const a = {
      id,
      name: String(data.name || 'Untitled').trim() || 'Untitled',
      url: normalizeUrl(data.url),
      profile: slug(data.profile || 'default'),
      color: data.color || randomColor(),
      customIconUrl: data.iconUrl || null,
    };
    config.apps.push(a);
    saveConfig();
    await fetchIconFor(a).catch(() => {});
    scheduleRebuild();
    refreshTray();
    return serializeApps();
  });

  ipcMain.handle('apps:update', async (_e, id, data) => {
    const a = config.apps.find((x) => x.id === id);
    if (!a) return serializeApps();
    const oldUrl = a.url;
    const oldProfile = slug(a.profile);
    const oldIconUrl = a.customIconUrl || null;
    if (data.name != null) a.name = String(data.name).trim() || a.name;
    if (data.url != null) a.url = normalizeUrl(data.url);
    if (data.profile != null) a.profile = slug(data.profile);
    if (data.color != null) a.color = data.color;
    if (data.iconUrl != null) a.customIconUrl = data.iconUrl;
    saveConfig();

    if (a.url !== oldUrl || (a.customIconUrl || null) !== oldIconUrl || data.refetchIcon) {
      await fetchIconFor(a).catch(() => {});
    }

    // Profile changed → session must change, so close & let it reopen fresh.
    if (slug(a.profile) !== oldProfile) forceClose(id);

    scheduleRebuild();
    refreshTray();
    return serializeApps();
  });

  ipcMain.handle('apps:remove', (_e, id) => {
    config.apps = config.apps.filter((x) => x.id !== id);
    saveConfig();
    forceClose(id);
    // delete saved icon
    for (const ext of ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp']) {
      try { fs.unlinkSync(path.join(iconsDir(), `${id}.${ext}`)); } catch { /* noop */ }
    }
    scheduleRebuild();
    refreshTray();
    return serializeApps();
  });

  ipcMain.handle('apps:refreshIcon', async (_e, id) => {
    const a = config.apps.find((x) => x.id === id);
    if (!a) return null;
    await fetchIconFor(a).catch(() => {});
    return iconDataURL(a);
  });

  ipcMain.handle('apps:rebuild', () => runRebuild());

  ipcMain.handle('icon:pick', async (_e, id) => {
    const a = config.apps.find((x) => x.id === id);
    if (!a) return null;
    const r = await dialog.showOpenDialog({
      title: 'Choose icon',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'ico', 'svg', 'webp'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const ext = path.extname(src).replace('.', '') || 'png';
    try {
      fs.mkdirSync(iconsDir(), { recursive: true });
      for (const e of ['png', 'ico', 'jpg', 'jpeg', 'svg', 'webp']) {
        try { fs.unlinkSync(path.join(iconsDir(), `${id}.${e}`)); } catch { /* noop */ }
      }
      const dest = path.join(iconsDir(), `${id}.${ext}`);
      fs.copyFileSync(src, dest);
      return iconDataURL(a);
    } catch { return null; }
  });
}

// ---------------------------------------------------------------------------
// Smoke test (verifies Electron + renderer run on this Mac)
// ---------------------------------------------------------------------------
function runSmokeTest() {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  win.webContents.on('did-finish-load', () => {
    console.log('SMOKE_OK');
    setTimeout(() => { isQuitting = true; app.quit(); }, 300);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log('SMOKE_FAIL ' + code + ' ' + desc);
    app.quit();
  });
  win.loadURL('data:text/html,<h1>ok</h1>');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Must run before app is ready. Disable GPU by default on this machine
  // (Intel HD 4400 has no Metal/GL driver on Monterey) unless overridden.
  let earlyCfg = null;
  try { earlyCfg = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { /* noop */ }
  if (!earlyCfg || earlyCfg.gpuDisabled !== false) app.disableHardwareAcceleration();

  app.on('second-instance', () => showLauncher());

  app.whenReady().then(() => {
    cleanUserAgent();
    buildAppMenu();
    configureSession(session.defaultSession);
    loadConfig();
    registerIpc();

    if (SMOKE) {
      runSmokeTest();
      return;
    }

    buildTray();
    createLauncher();

    // Fetch icons for seed apps in the background (first run).
    const needsIcons = config.apps.filter((a) => !iconDataURL(a));
    if (needsIcons.length) {
      Promise.all(needsIcons.map((a) => fetchIconFor(a).catch(() => null)))
        .then(() => { if (launcher && !launcher.isDestroyed()) launcher.webContents.send('apps:changed'); });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createLauncher();
      else showLauncher();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });

  // Keep running in the menu bar / tray even when all windows are closed.
  app.on('window-all-closed', () => { /* intentionally empty on macOS */ });
}
