#!/usr/bin/env python3
"""
Generate standalone .app bundles (one per configured app) by cloning the
known-good WebHub.app engine and renaming "WebHub" -> app name — the exact
transformation @electron/packager performs internally.

Each app gets its own name, icon, and Dock identity.

Usage: python3 make-apps.py [--only APP_ID]
"""
import os, sys, json, re, shutil, subprocess, tempfile, plistlib

HOME = os.path.expanduser('~')
SUPPORT = os.path.join(HOME, 'Library', 'Application Support', 'WebHub')
CONFIG = os.path.join(SUPPORT, 'apps.json')
ICONS_DIR = os.path.join(SUPPORT, 'icons')
ENGINE = os.path.join(SUPPORT, 'engine', 'WebHub.app')
APPS_DIR = '/Applications' if os.access('/Applications', os.W_OK) else os.path.join(HOME, 'Applications')
LSREG = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

HELPER_APPS = (
    'WebHub Helper.app',
    'WebHub Helper (GPU).app',
    'WebHub Helper (Plugin).app',
    'WebHub Helper (Renderer).app',
)

MAIN_TEMPLATE = r"""'use strict';
const { app, BrowserWindow, session, Menu, systemPreferences } = require('electron');

const APP_URL = @@URL@@;
const APP_NAME = @@NAME@@;

// Low-end tuning (mirrors the manager's main.js): cap per-renderer memory and
// trim compositing work. Must run before Chromium spawns any process.
app.commandLine.appendSwitch('enable-low-end-device-mode');
app.commandLine.appendSwitch('disable-smooth-scrolling');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=1024');
// This iMac's Intel iGPU has no Metal driver on Monterey -> software rendering.
app.disableHardwareAcceleration();
// Present a clean, standard Chrome user agent (drop the app-name and Electron
// tokens, which make sites like WhatsApp think the browser is outdated).
const _ua = String(app.userAgentFallback || '');
const _chromeVer = (_ua.match(/Chrome\/([\d.]+)/) || [])[1] || '150.0.0.0';
app.userAgentFallback = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + _chromeVer + ' Safari/537.36';

const ALLOWED = [
  'media', 'notifications', 'fullscreen', 'display-capture',
  'clipboard-sanitized-write', 'clipboard-read', 'pointerLock', 'geolocation',
];

let win = null;

function createWindow() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_w, permission, cb, details) => {
    if (permission === 'media') {
      // Trigger the macOS privacy (TCC) prompt for mic/camera, then allow the
      // web request only if macOS grants the hardware access.
      const types = (details && details.mediaTypes) || ['audio'];
      const asks = [];
      if (types.includes('audio')) asks.push(systemPreferences.askForMediaAccess('microphone'));
      if (types.includes('video')) asks.push(systemPreferences.askForMediaAccess('camera'));
      Promise.all(asks).then((r) => cb(r.every(Boolean))).catch(() => cb(false));
      return;
    }
    cb(ALLOWED.includes(permission));
  });
  ses.setPermissionCheckHandler((_w, p) => ALLOWED.includes(p));

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 380,
    title: APP_NAME,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // Keep sign-in/SSO popups (e.g. Microsoft Teams, Google) INSIDE the app so
    // the session cookie is stored here and the login completes. Sending them
    // to the default browser broke sign-in.
    if (/^https?:\/\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 980,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
        },
      };
    }
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  win.loadURL(APP_URL);
}

const got = app.requestSingleInstanceLock();
if (!got) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' },
    ]));
    createWindow();
    app.on('activate', () => {
      if (!win || win.isDestroyed()) createWindow();
      else { win.show(); win.focus(); }
    });
  });
  app.on('before-quit', () => { app.isQuitting = true; });
  app.on('window-all-closed', () => { /* keep running in the Dock */ });
}
"""


def slug(s):
    return re.sub(r'[^a-z0-9.-]+', '-', str(s).lower()).strip('-') or 'app'


def clean_name(s):
    """Bundled identity (executable + helper prefix) — no spaces/symbols."""
    c = re.sub(r'[^A-Za-z0-9]+', '', str(s))
    return c or 'App'


def safe_filename(s):
    return re.sub(r'[/:\x00]', '-', str(s)).strip() or 'App'


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def make_icns(src, dest):
    iconset = tempfile.mkdtemp(prefix='webhub-icns-', suffix='.iconset')
    try:
        for s in (16, 32, 128, 256, 512):
            run(['/usr/bin/sips', '-s', 'format', 'png', '-z', str(s), str(s), src,
                 '--out', os.path.join(iconset, 'icon_%dx%d.png' % (s, s))])
            run(['/usr/bin/sips', '-s', 'format', 'png', '-z', str(s * 2), str(s * 2), src,
                 '--out', os.path.join(iconset, 'icon_%dx%d@2x.png' % (s, s))])
        run(['/usr/bin/sips', '-s', 'format', 'png', '-z', '1024', '1024', src,
             '--out', os.path.join(iconset, 'icon_512x512@2x.png')])
        run(['/usr/bin/iconutil', '-c', 'icns', iconset, '-o', dest])
        return True
    except Exception:
        return False
    finally:
        shutil.rmtree(iconset, ignore_errors=True)


def find_icon(app):
    for ext in ('png', 'jpg', 'jpeg'):
        p = os.path.join(ICONS_DIR, app['id'] + '.' + ext)
        if os.path.exists(p):
            return p
    return None


def load_plist(p):
    with open(p, 'rb') as f:
        return plistlib.load(f)


def save_plist(obj, p):
    with open(p, 'wb') as f:
        plistlib.dump(obj, f)


def build_app(app, verbose=False):
    pretty = app.get('name') or 'App'
    ident = clean_name(pretty)
    app_id = app.get('id') or 'app'
    url = app.get('url') or 'https://www.google.com'
    folder = safe_filename(pretty)
    bundle_id = 'local.webhub.' + slug(app_id)
    icon_name = slug(app_id) + '.icns'

    if not os.path.isdir(ENGINE):
        raise SystemExit('Engine not found at: ' + ENGINE)

    tmp = tempfile.mkdtemp(prefix='webhub-app-')
    bundle = os.path.join(tmp, folder + '.app')
    contents = os.path.join(bundle, 'Contents')
    macos = os.path.join(contents, 'MacOS')
    res = os.path.join(contents, 'Resources')
    fw_dir = os.path.join(contents, 'Frameworks')

    # Clone the engine (full copy — frameworks must be real files, not
    # symlinks, or macOS/dyld fails to launch the helper processes).
    shutil.copytree(ENGINE, bundle)

    # Rename main executable: WebHub -> <ident>.
    os.rename(os.path.join(macos, 'WebHub'), os.path.join(macos, ident))

    # Rename helper apps + their executables + Info.plists.
    for h in HELPER_APPS:
        old_exe = h[:-4]                       # "WebHub Helper (GPU)"
        new_exe = old_exe.replace('WebHub Helper', ident + ' Helper')
        old_dir = os.path.join(fw_dir, h)
        new_dir = os.path.join(fw_dir, h.replace('WebHub Helper', ident + ' Helper'))
        os.rename(old_dir, new_dir)
        os.rename(os.path.join(new_dir, 'Contents', 'MacOS', old_exe),
                  os.path.join(new_dir, 'Contents', 'MacOS', new_exe))
        pl = load_plist(os.path.join(new_dir, 'Contents', 'Info.plist'))
        pl['CFBundleExecutable'] = new_exe
        pl['CFBundleName'] = new_exe
        pl['CFBundleDisplayName'] = new_exe
        save_plist(pl, os.path.join(new_dir, 'Contents', 'Info.plist'))

    # Replace the engine's app code with this app's code.
    asar = os.path.join(res, 'app.asar')
    if os.path.exists(asar):
        os.remove(asar)
    appdir = os.path.join(res, 'app')
    os.makedirs(appdir, exist_ok=True)
    with open(os.path.join(appdir, 'main.js'), 'w') as f:
        f.write(MAIN_TEMPLATE.replace('@@URL@@', json.dumps(url))
                             .replace('@@NAME@@', json.dumps(pretty)))
    with open(os.path.join(appdir, 'package.json'), 'w') as f:
        json.dump({'name': slug(app_id), 'version': '1.0.0', 'main': 'main.js'}, f, indent=2)

    # Icon.
    icon_src = find_icon(app)
    icon_dest = os.path.join(res, icon_name)
    engine_icns = os.path.join(res, 'electron.icns')
    if icon_src and make_icns(icon_src, icon_dest):
        if os.path.exists(engine_icns) and engine_icns != icon_dest:
            os.remove(engine_icns)
    elif os.path.exists(engine_icns) and engine_icns != icon_dest:
        os.rename(engine_icns, icon_dest)

    # Rebrand the main Info.plist.
    pl = load_plist(os.path.join(contents, 'Info.plist'))
    pl['CFBundleDisplayName'] = pretty
    pl['CFBundleName'] = ident
    pl['CFBundleExecutable'] = ident
    pl['CFBundleIdentifier'] = bundle_id
    pl['CFBundleIconFile'] = icon_name
    pl.pop('ElectronAsarIntegrity', None)
    save_plist(pl, os.path.join(contents, 'Info.plist'))

    # Install into the Applications folder (feeds Launchpad + Dock).
    os.makedirs(APPS_DIR, exist_ok=True)
    final = os.path.join(APPS_DIR, folder + '.app')
    if os.path.islink(final) or os.path.exists(final):
        if os.path.isdir(final) and not os.path.islink(final):
            shutil.rmtree(final)
        else:
            os.remove(final)
    shutil.move(bundle, final)

    shutil.rmtree(tmp, ignore_errors=True)
    if verbose:
        print('built:', folder + '.app')
    return final


def refresh_launchpad(apps):
    """Register the built apps and restart the Dock so Launchpad shows them."""
    try:
        for a in apps:
            p = os.path.join(APPS_DIR, safe_filename(a.get('name') or 'App') + '.app')
            if os.path.exists(p):
                subprocess.run([LSREG, '-f', p], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['/usr/bin/killall', 'Dock'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def main():
    only = None
    if '--only' in sys.argv:
        only = sys.argv[sys.argv.index('--only') + 1]

    with open(CONFIG) as f:
        config = json.load(f)
    apps = config.get('apps', [])
    if only:
        apps = [a for a in apps if a['id'] == only]

    print('Building %d app(s)…' % len(apps))
    for a in apps:
        build_app(a, verbose=True)
    refresh_launchpad(apps)
    print('Done.')


if __name__ == '__main__':
    main()
