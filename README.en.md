# dsh-app-updater — App Updater for DeepSeek Harness

**English** | [简体中文](README.md)
![version](https://img.shields.io/badge/version-1.0.0-4b6fff?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-2f6f4f?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-7da1de?style=flat-square)
![dsh-plugin](https://img.shields.io/badge/DSH-plugin-263146?style=flat-square)


Detect every installed Windows application that has a newer version, then update them
with one click — downloading the **full installer from each vendor's own website** and
installing it silently. **The detected applications are never launched.**

Where to find it: DeepSeek Harness → Settings → **应用更新 (App Updater)**

## Install

```bash
# straight from the source repository
dsh plugin --profile web add github:19952730389/dsh-app-updater
```

Prebuilt `.tgz` (see [Releases](https://github.com/19952730389/dsh-app-updater/releases)):

```bash
dsh plugin --profile web add https://github.com/19952730389/dsh-app-updater/releases/latest/download/dsh-app-updater.tgz
```

Restart DSH afterwards; the plugin lives at **Settings → 应用更新**. The Electron-managed
`desktop` profile does not accept `dsh plugin` writes, so link the package into that
profile's `node_modules` and add it to `dsh.profile.bundles` manually.

---

## What it actually does

| Step | How |
|---|---|
| 1. List installed apps | `winget list` (apps known to the winget catalog plus Store/MSIX packages) **and** the three Windows registry `Uninstall` keys (apps the catalog does not know). Read-only: no application is ever started. |
| 2. Decide whether an update exists | `winget upgrade --include-unknown` gives "installed version → available version" from the official winget catalog, merged into the inventory by package id. |
| 3. One-click update | `winget download` fetches the **vendor's full installer** from the URL recorded in the winget manifest (SHA-256 verified), the downloaded manifest supplies the publisher's own `InstallerSwitches.Silent`, the installer runs silently, and the resulting version is re-read with `winget list --id`. |
| 4. Fallback | If the vendor re-signed the installer (hash no longer matches the catalog) or the manifest forbids direct download, it falls back to `winget upgrade --id … --exact --silent` — still the full installer from the vendor, with winget doing the fetching and installing. |

Those download URLs really are the vendors' own: `github.com/git-for-windows/…`,
`dl.google.com/dl/chrome/install/…`, `download.cpuid.com/cpu-z/…`, `dl.hdslb.com/…`.
Both the installer and its `.yaml` manifest are kept in the download folder, so the
`InstallerUrl`, `InstallerSha256` and silent switches can be audited afterwards.

---

## Usage

1. Open **Settings → 应用更新**.
2. Click **刷新检测** (nothing runs in the background; scanning only happens when you ask).
3. The table sorts updateable apps first. Use the search box and the
   **全部 / 仅可更新 / 未收录** segments to narrow it down.
4. Tick the apps to update (or press **全部更新**), or update a single app from its row.
5. While updating you get a progress bar, the current app name and a per-item log;
   **取消** stops the items that have not started yet.
6. **打开下载目录** reveals the downloaded vendor installers in Explorer.

### Status values

| Status | Meaning |
|---|---|
| **有新版本** | The catalog reports a higher version; one-click update is available. |
| **已是最新** | No newer version in the catalog. |
| **未收录** | An update exists in the catalog but this plugin cannot drive it (see reasons below). |

| Reason | Meaning |
|---|---|
| 软件目录未收录 | The app is not in the winget catalog (registry-only software), so its official update cannot be discovered or downloaded. |
| 由应用商店管理 | MSIX / Store app — update it through Microsoft Store. |
| 版本未知 | The installed version cannot be read (winget reports `Unknown`); updating is still allowed. |
| 系统组件 | System component / runtime; not driven by this plugin by default. |

---

## Settings

State file: `%USERPROFILE%\.dsh\dsh-app-updater\state.json`

| Key | Default | Meaning |
|---|---|---|
| `includeStoreApps` | `true` | List Store (MSIX) apps too (display only). |
| `includeRegistryOnly` | `true` | Fill in apps missing from the winget catalog using the registry (display only). |
| `downloadDir` | empty | Custom download folder; empty = `%USERPROFILE%\Downloads\DSH App Updater`. Must be absolute. |
| `keepInstallers` | `true` | Keep the installer after a successful update. |
| `hashFallbackUpgrade` | `true` | Fall back to `winget upgrade` when the download fails. |
| `dryRun` | `false` | **Rehearsal mode**: download the vendor's full installer but never install it. |

Everything above is editable from the plugin's own settings panel inside the settings page.
The panel also accepts API calls:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"confirm":true,"settings":{"dryRun":true}}' \
  http://127.0.0.1:<port>/dsh-app-updater/settings
```

---

## Safety boundaries

- **Every write requires loopback + explicit confirmation**: `scan` / `update` / `cancel` /
  `settings` / `open-downloads` accept only requests from loopback with `confirm:true`.
- **No guessed silent switches**: the publisher's declared `Silent` switches are preferred;
  generic defaults are used only when a manifest is unavailable.
- **No silent elevation**: installers that need administrator rights show the normal UAC prompt.
- **Version is verified after installing** and recorded in the log.
- **System components** (`.NET`, VC++ runtimes, …) are listed but not updated by default.
- **Only its own directory is written**: state and logs live in `~/.dsh/dsh-app-updater/`.

## Requirements

- **Windows** with `winget.exe` (Microsoft App Installer). Without winget the plugin can still
  list registry apps, but cannot tell whether they are up to date.
- No third-party npm dependencies: the host half uses Node built-ins only, the browser half
  only the host-provided `react`.

## HTTP API (host half)

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-app-updater/state.json` | Status, inventory, log, settings |
| GET | `/dsh-app-updater/apps.json` | Inventory and statistics only |
| GET | `/dsh-app-updater/health.json` | Self-check (route count, data directory) |
| POST | `/dsh-app-updater/scan` | `{confirm:true, force:true}` start scanning |
| POST | `/dsh-app-updater/update` | `{confirm:true, ids:[...]}` start the update queue |
| POST | `/dsh-app-updater/cancel` | `{confirm:true}` cancel items not yet started |
| POST | `/dsh-app-updater/settings` | `{confirm:true, settings:{...}}` |
| POST | `/dsh-app-updater/open-downloads` | `{confirm:true}` open the download folder |

## Install (from a checkout)

```bash
# from a local checkout
dsh plugin --profile <profile> add file:/path/to/dsh-app-updater

# or as a local link
dsh plugin --profile <profile> add link:/path/to/dsh-app-updater
```

Then add `dsh-app-updater` to `dsh.profile.bundles` in the profile's `package.json`
(the bundled `cordis.patch.yml` mounts the host half) and reload DSH.

## Uninstall

1. Remove `dsh-app-updater` from `dsh.profile.bundles` and from `dependencies` in the profile's `package.json`.
2. Delete `<profile>/node_modules/dsh-app-updater`.
3. Restart DSH; the data directory `%USERPROFILE%\.dsh\dsh-app-updater` can be removed as well.

## Tests

```bash
node test/unit.mjs     # 36 checks: table parsing, version compare, manifest & switch parsing
node test/render.mjs   # 32 checks: settings panel, rehearsal banner, column drag, request bodies
node test/harness.mjs --scan   # boots the host half against a fake cordis ctx + real HTTP
```

## Layout

| File | Purpose |
|---|---|
| `lib/index.js` | Host half: HTTP routes, write gate, scan/update scheduling |
| `lib/engine.js` | Inventory merge, vendor installer download, silent install, winget fallback, version re-check |
| `lib/winget.js` | winget discovery/invocation, fixed-width table parsing (CJK-aware) |
| `lib/registry.js` | Registry `Uninstall` enumeration (PowerShell, UTF-8) |
| `lib/version.js` | Windows-style version comparison |
| `lib/state.js` | Settings and state persistence (atomic writes) |
| `lib/proc.js` | Child process runner (timeouts, cancellation, UTF-8) |
| `lib/client.js` | Browser half: the settings page UI |
| `CONTRACT.md` | Host ↔ client interface contract |

## License

MIT