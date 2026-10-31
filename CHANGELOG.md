# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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