# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.1] — 2026-11-01

### 安全

- **「仅凭回环地址放行」改为默认拒绝**（插件市场 dshopen.org 对 1.3.0 的复核意见）：
  1.3.0 接入 `connection` 准入后仍留了一条退回路径 —— 宿主没有 `connection` 服务，或请求
  不带任何连接凭据且来自回环地址时，直接按「本机信任」放行。在没有准入服务的旧宿主上，
  任何本机进程（以及能向回环发起请求的页面）都能借此调用 `/update`、`/settings` 等安装接口，
  等于绕过认证。1.3.1 起这条路径**默认关闭**：
  - 宿主有 `connection`：一律以 `admit()` 的结果为准，`401` / `403` / `409` 原样返回
    （响应头 `X-DSH-Admission: denied`）。只有「401 + 回环 + 无凭据 + 用户显式开启兼容模式」
    这一种例外，且必须在下面第 2 条的前提下才成立。
  - 宿主没有 `connection`：**默认 403**，不再自动相信回环地址。
- **兼容模式必须由用户显式开启**（保留给确实跑在旧宿主上的用户）：插件配置
  `allowLegacyLoopback: true`（`cordis.patch.yml` 覆盖同名条目）或环境变量
  `DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK=1`，两者默认都没有。开启后：
  - 放行的请求带 `X-DSH-Admission: loopback-legacy-optin` 与 `X-DSH-Admission-Warning`；
  - `state.json` / `health.json` 新增 `admission` 字段（`mode` / `service` /
    `allowLegacyLoopback` / `warning`），复核时不必读代码就能确认当前路径；
  - 设置页顶部显示红色警示条，日志写一条 `warn`。
- **准入拒绝统一返回 JSON**：`401`/`403`/`409` 带 `{ ok:false, error, admission:"denied" }`，
  不再用纯文本，排障时能直接看出是被准入挡掉的。

### 测试

- `test/unit.mjs`：准入用例从 6 项扩到 25 项，覆盖兼容模式开关（配置 / 环境变量 / 缺省关闭）、
  无 `connection` 服务默认拒绝、显式开启后放行、非回环仍拒绝、`409`、带凭据未认证不放行等。
- 新增 `test/deny.mjs`：起真实 HTTP 服务，验证无 `connection` 且未开兼容模式时**每一条路由**
  都是 `403 + X-DSH-Admission: denied`；再验证显式开启后放行并标注 opt-in 响应头。
- `test/render.mjs`：新增兼容模式警示条 4 项（开启显示、样式、文案、默认不显示）。
- 自测命令更新为 `node test/unit.mjs && node test/render.mjs && node test/deny.mjs`。

## [1.3.0] — 2026-10-31

### 修复

- **机器级安装全部失败的问题**：进程没有管理员令牌时，MSI 直接失败（msiexec 1603，
  MSI 日志里是 `Error 1925: You do not have sufficient privileges…`），而部分安装器是
  **静默退出 0 却什么都没装**（实测 Logitech G HUB）。两个现象同源，都是权限。
- **安装后复核**：退出码 0 不再等于成功。安装完成后用「安装前版本 / 安装后版本 / 目标版本」
  判断是否真的生效，没生效就如实报失败 —— 原来只看退出码，会把 G HUB 那种
  「退出码 0、版本没变」的情况误报成「更新完成」。
- **架构过滤回退**：`winget download/upgrade --architecture x64` 在清单里没有该架构时现在能
  正确识别（中文报错是「找不到适用的安装程序」，旧正则只匹配了「没有适用」）并退回不限架构
  重试；`winget upgrade` 兜底同时补上 `--include-unknown`（虎牙直播的已装版本被读成 Unknown，
  不带它直接「目录里没有适用的更新」）。
- **Edge**：winget 目录里的 `Microsoft.Edge` 是企业版 MSI，与本机消费版 Edge 的安装技术不匹配，
  winget 直接拒绝（`0x8A15008E`「安装技术与当前安装的版本不同，请卸载包并安装较新版本」），
  现在先走 Edge 自带的更新服务 `MicrosoftEdgeUpdate.exe /ua`；若它没生效（实测该机的
  EdgeUpdate 引擎目录是 `1.3.311.5` 而服务主程序还是 `1.3.275.13`，服务起不来，`/ua` 直接
  `0x80070002`），自动退回安装 winget 目录里的官网全量包（企业版 MSI，提权执行）——
  实测这一步能把 Edge 正常装到目标版本，winget 拒绝执行只是因为它的策略。
- **读不到版本的应用**：虎牙直播的卸载信息里没有版本号，winget 永远显示 `Unknown`。
  复核阶段不再把它误判为失败，改为「已安装、未复核」写进结果与日志。
- **「安装包不生效」的软件给出可操作提示**：实测 Logitech G HUB 的更新包早已下载到
  `%ProgramData%\LGHUB\next.json` 指向的 depots（build 880806 / 2026.7.992920），但安装器
  `--silent` 与 `winget upgrade` 都会在 3 秒内退出 0 且什么都不装，只有**启动 G HUB 本体**
  之后 `current.json` 才跳到新版本。插件承诺不启动用户的软件，所以这类情况现在会在失败
  原因里直接给出「手动打开一次该应用即可完成升级」的提示（`updateHintFor`）。
- **MSI 日志**：MSI 安装现在带 `/l*v <下载目录>\<包名>.msi.log`，失败时把日志路径写进错误信息
  （「Error 1925」就是这么被找到的）。
- **残留清单**：关闭「保留安装包」时，现在连 winget 落盘的 `.yaml` 清单一并删除。

### 新增

- **自动提权安装**（`lib/elevate.js`）：需要管理员的安装类命令交给 `Start-Process -Verb RunAs`
  的提权副本执行，退出码与输出写进临时文件后读回。新增开关「自动提权安装」（默认开启）。
  UAC 为「始终通知」时每次安装会弹一次确认；把 `ConsentPromptBehaviorAdmin` 设为 0
  （管理员静默提权）时完全无感。
- 说明：提权副本是独立进程，取消更新只会停掉启动器，已经开始的那次安装会自己跑完。

### 安全

- **接入宿主 connection 准入**（插件市场 dshopen.org 对 1.2.0 的复核意见）：所有
  `/dsh-app-updater/*` 路由先过 `ctx.connection.admit(request)` —— DSH 用来做 Host/Origin
  信任校验与浏览器会话 / API 认证的那套边界，宿主自己的 `/api` 路由用的就是它。
  未通过准入的请求直接得到 `401`/`403`；带凭据的请求一律以准入结果为准。
  只有在宿主没有 `connection` 服务、或者请求不带任何连接凭据且来自回环地址时，才退回旧的
  「回环」规则，并在响应头标注 `X-DSH-Admission: loopback-legacy`（宿主自己的 Electron
  载体与本机脚本都不带 Cookie，需要一个不误伤它们的路径）。
- 因此 README 里「用 curl 直接改设置」的例子现在需要带上 DSH 的会话 Cookie，或在
  `connection` 不可用的宿主上从回环地址调用。

### 说明

- 读类命令（`winget list` / `upgrade --include-unknown` / `--version`）不提权。
- `update.results[]` 新增 `installOk`（安装器自身是否报成功）与 `manifest`（落盘的清单位置）。

## [1.2.0] — 2026-10-31

### 新增

- **运行环境识别**（`lib/platform.js`）：识别 Windows / macOS / 其它系统、具体版本与名称
  （`Windows 11（build 26300）`、`macOS 15（Sequoia）`）、CPU 架构（ARM64 / x64 / Intel / x86），
  并记录 CPU 型号与线程数。Windows on ARM 上跑 x64 的 Node 时，靠 `PROCESSOR_ARCHITEW6432`
  仍能还原出真实架构，而不是被骗成 x64。
- **按架构挑选安装包**：Windows 侧把识别到的架构传给 winget 的 `--architecture`，让「官网全量包」
  与当前系统/芯片匹配；清单里没有该架构的安装包时自动退回自动匹配，并在日志里说明。
  macOS 侧由 Homebrew 按本机架构取对应 cask。新增开关「按本机架构安装包」（默认开启）。
- **macOS 更新引擎（Homebrew cask）**：用 `brew list --cask --versions` 拿已装版本、
  `brew outdated --json=v2 --cask --greedy` 拿可升级版本，`brew upgrade --cask <token>` 更新；
  演练模式改用 `brew fetch --cask <token>`，只下载安装包不安装。没有 Homebrew 时明确报告
  「不可用」，而不是假装能更新。
- **界面**：状态行与设置面板新增「运行环境」（系统 · 架构 · 引擎）；引擎不可用时红字给出原因；
  应用来源新增 `homebrew` 徽章。
- `/health.json` 增加 `version` / `env` / `envSummary` / `engine` / `capabilities`；
  `state.json` 同步带出这些字段。

### 说明

- macOS 路径无法在开发机（Windows）上真机验证，因此识别与 Homebrew 输出解析均以注入式单测覆盖
  （`test/unit.mjs` 共 66 项），安装/更新命令按 Homebrew 官方 CLI 行为编写。
- 扫描/更新接口按平台放行：Windows 与 macOS 通过，其它系统返回 400 并说明原因。

## [1.0.0] — 2026-10-31

首个可用版本。

### 检测

- 用 `winget list` 列出已安装应用（含 winget 目录收录的软件与商店 / MSIX 包），并用注册表三处
  `Uninstall` 键补齐 winget 目录未收录的软件。全程只读注册表与文件，**不启动任何被检测的应用**。
- 用 `winget upgrade --include-unknown` 取「已装版本 → 可升级版本」，按包 Id 与清单合并。
- 版本比较支持 Windows 风格的 `1.2.3.4`、日期风格 `2026.7.992920`、带后缀 `0.9.2+2026103013`
  以及 `1.2.3-beta` 这类预发布标记。
- 定宽表格解析按**显示宽度**切列（CJK 占 2 列），并剔除 `15 upgrades available.` 之类的尾部提示行。

### 更新

- 一键更新链路：`winget download` 从**发布方官网**拉取**完整安装包**（下载时核对清单里的 SHA-256）→
  解析随包落盘的 winget 清单，取发布方自己声明的 `InstallerSwitches.Silent` →
  静默安装 → 用 `winget list --id` 复核安装后版本。
- 官网包哈希与目录记录不一致（发布方重签了安装包）或清单禁止直接下载时，自动退回
  `winget upgrade --id … --exact --silent`（同源全量包，下载与安装交给 winget）。
- 安装包与清单留档在下载目录，便于核对来源；可关闭「保留安装包」在安装后自动清理。
- 需要管理员权限的安装包会正常弹出 UAC，插件不做静默提权。

### 界面

- 设置 → 应用更新：工具条（刷新检测 / 全部更新 / 更新所选 / 取消 / 打开下载目录）、
  状态行、进度条、筛选行、应用表格、可折叠日志。
- 表格列宽默认给足以完整显示应用名，并且**每列可拖拽调宽、双击恢复默认**，偏好记在浏览器本地。
- 插件设置面板：安装包下载目录（含绝对路径校验）、保留安装包、演练模式、下载失败回退 winget、
  包含商店应用、包含目录未收录应用。演练模式开启时页面顶部有醒目提示。
- 全部写操作要求本机（loopback）来源并显式带 `confirm:true`。