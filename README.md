# WebHub

**Turn any website into a desktop app — and keep older Macs working.**

WebHub is a free, open-source alternative to subscription web-app wrappers
like WebCatalog. It wraps the *web* versions of the apps you rely on —
Microsoft Teams, WhatsApp, ChatGPT, Gmail, Outlook/Hotmail, Yahoo Mail, and
anything else — into proper desktop apps, each with its own icon, Dock
presence, isolated login, and notifications.

It exists for a real problem: **modern apps keep dropping support for macOS
Monterey and older Intel Macs**, even when the hardware still works fine.
WebHub lets you keep using those services as desktop apps without upgrading
your machine.

## Why this exists

Software companies end support for older macOS versions (Monterey and
earlier) for a mix of reasons — newer SDKs, dropped Intel builds, and changed
security assumptions. For someone on an older iMac or MacBook, the result is:

- "This app requires macOS 14 or later."
- "Your browser is no longer supported."
- The native app stops updating, then stops working.

But almost every service still ships a **fully-featured web app**. WebHub turns
those web apps into native-feeling desktop apps.

## Features

- **Unlimited apps** — no 2-app limit, no subscription.
- **Individual `.app` bundles** — each service gets its own icon in
  `/Applications` and Launchpad, plus its own Dock presence.
- **Vendor-agnostic** — any website works: Google, Microsoft, Yahoo, or any
  other provider. It's just a URL.
- **Isolated sessions** — every app keeps its own login, so multiple accounts
  (e.g. work and personal) stay separate.
- **Microphone & camera** — voice/video calls work (ChatGPT voice,
  WhatsApp/Teams calls); macOS prompts for permission on first use.
- **Clean browser identity** — presents a current Chrome user-agent so sites
  don't show "update your browser" warnings.
- **Old-Intel-Mac friendly** — software rendering by default, so it works even
  when the iGPU has no Metal driver (e.g. OpenCore Legacy Patcher).
- **Auto-rebuild** — add an app in the manager and its icon is generated and
  pushed to Launchpad automatically.

## How it works

WebHub has two parts:

1. **`WebHub.app`** — a small Electron "manager" where you add/remove apps.
   It stores a simple JSON config
   (`~/Library/Application Support/WebHub/apps.json`).
2. **`make-apps.py`** — a Python generator that reads that config and produces
   a standalone `.app` for each entry. It clones a known-good Electron build
   and rebrands it (name, icon, bundle ID, helper apps), so each app is fully
   self-contained.

Each generated app is a full Electron (Chromium) window pointed at one URL,
with its own isolated user-data directory so logins never collide.

## Requirements

- **macOS 12 (Monterey) or later** — Intel (x64) and Apple Silicon.
- **Node.js 22+** and **Python 3** (the generator uses `sips` / `iconutil`,
  which ship with macOS).

Built and tested with **Electron 43**.

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Run the manager in development mode
npm start

# 3. Package the manager into a .app (needs internet on first build)
npm run pack        # → dist/WebHub-darwin-x64/WebHub.app

# 4. Generate individual apps from your config
python3 make-apps.py
```

`make-apps.py` reads `~/Library/Application Support/WebHub/apps.json` and
installs the generated apps into `/Applications` (falling back to
`~/Applications` if `/Applications` isn't writable). It also re-registers them
with Launchpad and refreshes the Dock.

### Adding apps

Open **WebHub** → **＋ Add app** → enter a name and URL. The app rebuilds
automatically and the icon appears in Launchpad within a few seconds.

You can also edit `apps.json` directly and re-run `make-apps.py`.

## Implementation notes

A few non-obvious things that took real debugging, documented for future
maintainers:

- **Helper apps must match the app name.** Electron looks for
  `"<CFBundleName> Helper.app"` in `Contents/Frameworks/` (falling back from
  the compile-time product name). `make-apps.py` renames the engine's helper
  apps and their inner executables + `Info.plist` to match each app's
  `CFBundleName`, or the app fails with *"Unable to find helper app"*.
- **Frameworks must be real copies, not symlinks.** Sharing the heavy
  `Electron Framework.framework` via symlink breaks helper launch on macOS
  (`GPU process exited unexpectedly`). Each bundle ships its own copy.
- **Clean user-agent.** The default UA includes an app-name token
  (`whatsapp/1.0.0`) that makes sites like WhatsApp think the browser is old.
  We rebuild the UA to a standard `Chrome/<version>` string.
- **Explicit media permission.** On macOS the privacy (TCC) prompt is *not*
  triggered automatically by Chromium. We call
  `systemPreferences.askForMediaAccess('microphone' | 'camera')` from the
  permission-request handler so the OS prompt appears on first use.
- **Software rendering.** Chromium auto-falls back to software when an Intel
  iGPU has no Metal driver; we set `app.disableHardwareAcceleration()`
  explicitly to avoid GPU-process churn.
- **Launchpad freshness.** Newly generated apps don't reliably appear in
  Launchpad on their own. `make-apps.py` runs `lsregister` and restarts the
  Dock after each build; stale registrations (e.g. after moving/removing
  copies) must be unregistered with `lsregister -u`.

## Notes & limitations

- **Each running app is a full Chromium process** (~150–400 MB), the same as
  WebCatalog/Nativefier. On an 8 GB Mac, don't run *all* apps at once — quit
  (⌘Q) what you're not using.
- **Apps are unsigned.** They run locally without Gatekeeper issues, but macOS
  identifies them by path for privacy permissions. Grant mic/camera when
  prompted per app.
- **On unsupported Intel iGPUs** (no Metal driver), rendering is
  software-based — reliable, but video calls are CPU-heavy.
- Closing a window **hides** it (so notifications keep flowing); use **⌘Q** to
  actually quit and free RAM.

## Project layout

```
webhub/
├── main.js          # Manager app (Electron main process)
├── preload.js       # Manager preload (IPC bridge)
├── launcher/        # Manager UI (home screen)
├── make-apps.py     # Generates standalone .app bundles per site
├── gen-icons.py     # Regenerates the default icons (icon.png / trayTemplate.png)
├── assets/          # Default app icon + tray icon
└── package.json
```

## License

MIT — do what you like with it.
