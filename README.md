# dsh-app-updater — 应用更新（DSH 插件）

检测本机**所有已安装的 Windows 应用**是否有新版本，并从各自**官网下载完整安装包**一键静默更新。
检测过程**不需要打开被检测的软件**。

入口：DeepSeek Harness → 设置 → **应用更新**

![version](https://img.shields.io/badge/version-1.0.0-4b6fff?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-2f6f4f?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-7da1de?style=flat-square)
![dsh-plugin](https://img.shields.io/badge/DSH-plugin-263146?style=flat-square)

**简体中文** · [English](README.en.md) · [更新日志](CHANGELOG.md) · MIT

---

## 它到底做了什么

| 步骤 | 实现 |
|---|---|
| ① 列出已装应用 | `winget list`（覆盖 winget 目录收录的软件 + 商店/MSIX 包）+ Windows 注册表三处 `Uninstall` 键（覆盖 winget 未收录的软件）。全程只读文件与注册表，不启动任何应用。 |
| ② 判断有没有新版本 | `winget upgrade --include-unknown`：由 winget 官方软件目录给出「已装版本 → 可升级版本」，并与 ①的清单按 Id 合并。 |
| ③ 一键更新 | `winget download` 把**发布方官网的完整安装包**下载到你指定的目录（下载时按清单核对 SHA-256），解析随包落盘的 winget 清单得到发布方自己的静默参数，再执行静默安装；安装完成后用 `winget list --id` 复核版本号。 |
| ④ 失败兜底 | 若官网安装包被发布方重新签发导致哈希与目录记录不一致、或清单禁止直接下载，自动退回 `winget upgrade --id <id> --exact --silent`（同样是从官网拉取完整安装包，只是下载与安装过程交给 winget）。 |

**「从对应官网下载」是真的官网**：安装包地址来自 winget 清单里的 `InstallerUrl`，例如
- Git → `https://github.com/git-for-windows/git/releases/download/...`
- CPU-Z → `https://download.cpuid.com/cpu-z/...`
- 哔哩哔哩 → `https://dl.hdslb.com/...`
- Chrome → `https://dl.google.com/dl/chrome/install/...`

下载目录（默认 `%USERPROFILE%\Downloads\DSH App Updater`）里会同时留一份 `.yaml` 清单，
里面有发布方声明的 `InstallerUrl` / `InstallerSha256` / `InstallerSwitches.Silent`，可以自行核对来源。

---

## 使用

1. 打开 **设置 → 应用更新**。
2. 点 **刷新检测**（不会自动跑后台任务；只有你点了才扫）。
3. 列表默认按「有新版本优先」排序，可用搜索框和 **全部 / 仅可更新 / 未收录** 分段筛选。
4. 勾选要更新的应用（或点 **全部更新** 一次处理当前筛选下所有可更新项），点行尾 **更新** 也可单个更新。
5. 更新期间有进度条、当前应用名与逐条日志；**取消** 会停止尚未开始的项目。
6. **打开下载目录** 可以在资源管理器中查看已下载的官网安装包。
7. 同一页的 **插件设置** 面板里可以改下载目录、保留安装包、演练模式等开关（见「设置项」）。
8. 表格列宽默认给足以完整显示应用名；**拖动表头右侧的分隔条** 可以调整该列宽度（双击恢复默认），
   偏好记在浏览器本地，下次打开仍是你的宽度。

### 状态含义

| 状态 | 含义 |
|---|---|
| **有新版本** | 软件目录给出更高的版本号，可一键更新。 |
| **已是最新** | 目录里没有更高版本。 |
| **未收录** | 目录里找到了更新，但本插件无法驱动它更新（见下）。 |

| 原因 | 含义 |
|---|---|
| 软件目录未收录 | 该软件不在 winget 目录里（例如只在注册表登记的国产软件），无法判断/下载官网更新。 |
| 由应用商店管理 | MSIX / 商店应用，请用 Microsoft Store 更新。 |
| 版本未知 | 应用当前版本读不出来（winget 显示 `Unknown`），仍然允许尝试更新。 |
| 系统组件 | 系统组件/运行时，默认不建议由第三方驱动更新。 |

---

## 设置项

状态文件：`%USERPROFILE%\.dsh\dsh-app-updater\state.json`

| 键 | 默认 | 说明 |
|---|---|---|
| `includeStoreApps` | `true` | 是否把商店（MSIX）应用列进来（只展示，不会被更新）。 |
| `includeRegistryOnly` | `true` | 是否用注册表补齐 winget 未收录的应用（只展示，不能更新）。 |
| `downloadDir` | 空 | 自定义安装包下载目录；空 = `%USERPROFILE%\Downloads\DSH App Updater`。 |
| `keepInstallers` | `true` | 更新后保留安装包；`false` 则在安装完成后删掉该应用刚下载的包。 |
| `hashFallbackUpgrade` | `true` | 下载失败时退回 `winget upgrade` 兜底。 |
| `dryRun` | `false` | **演练模式**：只下载官网全量安装包、不执行安装。用来先看会装什么。 |

用 API 改设置（等价于设置面板，适合脚本化）：

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"confirm":true,"settings":{"dryRun":true}}' \
  http://127.0.0.1:<port>/dsh-app-updater/settings
```

`downloadDir` 会被校验：必须留空（用默认目录）或是绝对路径（`D:\Apps`）／UNC 路径（`\\server\share`），
否则返回 `400` 并在面板里显示红字提示，不会把安装包写到意料之外的位置。

---

## 安全边界

- **写操作全部要求本机来源 + 显式确认**：`scan` / `update` / `cancel` / `settings` / `open-downloads` 只接受 loopback 请求且必须带 `confirm:true`。
- **不猜测静默参数**：优先用发布方在清单里声明的 `Silent` 参数；清单缺失时才按安装包类型用保守的默认开关。
- **不静默提权**：需要管理员权限的安装包会正常弹出 UAC，由你决定是否放行。
- **安装后复核版本**：更新完会重新查询一次版本并记录，日志里能看到「更新完成，当前版本 X」。
- **不做系统组件更新**：`.NET` 运行时、VC++ 运行库等仍会列出来，但默认不作为一键更新的目标。
- **只写自己的目录**：状态与日志写在 `~/.dsh/dsh-app-updater/`，不碰 profile 与宿主配置。

---

## 依赖

- **Windows**（`winget.exe`，即 Microsoft「应用安装程序 / App Installer」）。没装 winget 时插件仍能列出注册表里的应用，但无法判断是否有新版本。
- 不需要任何第三方 npm 依赖；宿主半身只用 Node 内置模块，浏览器半身只用宿主提供的 `react`。

## 接口（宿主半身）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-app-updater/state.json` | 当前状态、应用清单、日志、设置 |
| GET | `/dsh-app-updater/apps.json` | 只取应用清单与统计 |
| GET | `/dsh-app-updater/health.json` | 自检（路由数、数据目录） |
| POST | `/dsh-app-updater/scan` | `{confirm:true, force:true}` 开始扫描 |
| POST | `/dsh-app-updater/update` | `{confirm:true, ids:[...]}` 开始更新队列 |
| POST | `/dsh-app-updater/cancel` | `{confirm:true}` 取消未开始项 |
| POST | `/dsh-app-updater/settings` | `{confirm:true, settings:{...}}` |
| POST | `/dsh-app-updater/open-downloads` | `{confirm:true}` 打开下载目录 |

## 安装

```bash
# 本地目录安装
dsh plugin --profile <profile> add file:/path/to/dsh-app-updater

# 或者用链接（开发时改代码即时生效）
dsh plugin --profile <profile> add link:/path/to/dsh-app-updater
```

装好后把 `dsh-app-updater` 加进 profile `package.json` 的 `dsh.profile.bundles` 清单
（包内自带的 `cordis.patch.yml` 会挂载宿主半身），然后重启 DSH 即可在设置页看到入口。

> 桌面端（Electron 托管）的 `desktop` profile 不允许用 `dsh plugin` 直接改写，
> 需要在 profile 的 `node_modules` 下建立指向本包的 junction 并手动补 `bundles` 与依赖。

## 测试

```bash
node test/unit.mjs              # 36 项：定宽表格解析、版本比较、安装包清单与静默参数
node test/render.mjs            # 32 项：设置面板、演练提示、列宽拖拽、请求体
node test/harness.mjs --scan    # 用假 cordis ctx + 真 HTTP 把宿主半身跑起来
```

## 卸载

1. 从 profile 的 `package.json` 里删掉 `dsh.profile.bundles` 中的 `dsh-app-updater` 与 `dependencies` 中的对应条目。
2. 删除 `%USERPROFILE%\.dsh\profiles\<profile>\node_modules\dsh-app-updater`。
3. 重启 DSH；数据目录 `%USERPROFILE%\.dsh\dsh-app-updater` 可自行删除。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半身：HTTP 路由、写操作闸门、扫描/更新任务调度 |
| `lib/engine.js` | 扫描合并、官网包下载、静默安装、winget 兜底、版本复核 |
| `lib/winget.js` | winget 定位与调用、定宽表格解析（CJK 宽度感知） |
| `lib/registry.js` | 注册表 `Uninstall` 键枚举（PowerShell，UTF-8） |
| `lib/version.js` | Windows 风格版本比较 |
| `lib/state.js` | 状态与设置持久化（原子写） |
| `lib/proc.js` | 子进程执行（超时/取消/UTF-8） |
| `lib/client.js` | 浏览器半身：设置页 UI（设置面板、可拖拽列宽、进度与日志） |
| `CONTRACT.md` | 宿主 ↔ 客户端接口契约 |
| `test/unit.mjs` | 解析器 / 版本 / 清单单测（36 项） |
| `test/render.mjs` | 前端渲染与交互自测（32 项） |
| `test/harness.mjs` | 宿主路由端到端 harness（假 ctx + 真 HTTP） |
| `icon.svg` | 插件图标 |
| `LICENSE` `CHANGELOG.md` `README.en.md` | MIT 许可证、更新日志、英文说明 |