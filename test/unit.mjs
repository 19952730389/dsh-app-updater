/**
 * 单元自测：解析器 / 版本比较 / 清单解析 / 静默参数。
 * 全部基于仓库内的 fixture 与真实安装包清单样本，不联网、不改动系统。
 *
 * 运行：node test/unit.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  parseInstalledList,
  parseUpgradeList,
  parseWingetTable,
  parseHeaderColumns,
  displayWidth,
  sliceByWidth,
} from "../lib/winget.js";
import { compareVersions, isNewer, looksLikeVersion, splitVersion } from "../lib/version.js";
import { parseInstallerManifest, splitSwitchArgs, defaultSilentArgs, resolveInstallArgs, parseBrewCaskVersions, parseBrewOutdated, findBrew, isArchNotFoundError, explainInstallerExitCode, evaluateUpdateResult, findEdgeUpdate, updateHintFor } from "../lib/engine.js";
import { psQuote, ELEVATION_CANCELLED } from "../lib/elevate.js";
import {
  applicationDirs,
  parseCaskCatalog,
  pickCask,
  normalizeAppKey,
  buildMacosItems,
} from "../lib/macos.js";
import { admissionGate, hasConnectionCredentials, resolveLegacyLoopbackOptIn, LEGACY_LOOPBACK_ENV } from "../lib/index.js";
import {
  detectEnvironment,
  describeEnvironment,
  windowsName,
  macOSName,
  normalizeArch,
  archLabel,
  wingetArch,
  platformFamily,
  engineFor,
  capabilitiesFor,
  ENGINE_WINGET,
  ENGINE_BREW,
  ENGINE_NONE,
} from "../lib/platform.js";
import { normalizeName } from "../lib/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

/* ---------------- 显示宽度 ---------------- */
group("显示宽度 / 定宽表格切列");
ok(displayWidth("abc") === 3, "ASCII 宽度");
ok(displayWidth("哔哩哔哩") === 8, "CJK 按 2 列计宽");
ok(displayWidth("微信 a") === 6, "CJK + ASCII 混合");
const headerStarts = parseHeaderColumns("Name    Id      Version   Available Source");
ok(headerStarts.length === 5 && headerStarts[0] === 0, "表头列起点解析", headerStarts);

/* ---------------- winget list 解析 ---------------- */
group("winget list 解析（真实 fixture）");
const installedRaw = readFileSync(join(here, "fixture-winget-list.txt"), "utf8");
const installed = parseInstalledList(installedRaw);
ok(installed.length === 131, "解析出 131 条已安装应用", installed.length);
ok(installed.every((r) => r.id && r.name), "每行都有 id 与 name");
const git = installed.find((r) => r.id === "Git.Git");
ok(git && git.version === "2.55.0.5", "Git 已装版本解析正确", git);
const zh = installed.find((r) => r.name === "企业微信");
ok(zh && zh.id === "Tencent.WeCom", "中文名行未被错位切列", zh);
const msix = installed.find((r) => r.id.startsWith("MSIX\\"));
ok(Boolean(msix), "MSIX 包带反斜杠 Id 也能解析", msix && msix.id);
const arp = installed.find((r) => r.id.startsWith("ARP\\"));
ok(Boolean(arp), "ARP 包也能解析", arp && arp.id);

/* ---------------- winget upgrade 解析 ---------------- */
group("winget upgrade 解析（真实 fixture，另一套更窄的列宽）");
const upgradable = parseUpgradeList(readFileSync(join(here, "fixture-winget-upgrade.txt"), "utf8"));
ok(upgradable.length === 15, "解析出 15 条可更新", upgradable.length);
ok(
  upgradable.every((r) => r.id && r.available),
  "每条可更新记录都有 id 与 available"
);
const chrome = upgradable.find((r) => r.id === "Google.Chrome");
ok(chrome && chrome.available === "156.0.8078.48", "Chrome 目标版本解析正确", chrome);

/* ---------------- 非表格噪声 ---------------- */
group("非数据行过滤");
// 按 winget 的真实列宽构造（列间距足够宽），这样切列结果与真机一致
const padded = parseWingetTable(
  [
    "Name                Id                 Version       Available     Source",
    "--------------------------------------------------------------------------",
    "Git                 Git.Git            2.55.0.5      2.56.0.3      winget",
    "15 upgrades available.",
    "No installed package found matching input criteria.",
  ].join("\n")
);
const paddedIdx = padded.columns.map((c) => c.toLowerCase());
const paddedRows = padded.rows
  .map((cells) => ({
    name: cells[0] || "",
    id: cells[paddedIdx.indexOf("id")] || "",
    version: cells[paddedIdx.indexOf("version")] || "",
  }))
  .filter((r) => r.name && String(r.version).trim() && r.id && (!/\s/.test(r.id) || /^ARP\\/i.test(r.id)));
ok(padded.rows.length === 3, "通用表格解析保留 3 行（1 条数据 + 2 条提示）", padded.rows.length);
ok(paddedRows.length === 1 && paddedRows[0].id === "Git.Git", "数据行判定剔除 2 条提示行", paddedRows);
const single = parseInstalledList("Name Id      Version  Source\n-----------------------------\nGit  Git.Git 2.56.0.3 winget\n");
ok(single.length === 1 && single[0].source === "winget", "单包查询（无 Available 列）也能解析", single);

/* ---------------- 版本比较 ---------------- */
group("版本比较");
ok(isNewer("2.56.0.3", "2.55.0.5"), "2.56.0.3 > 2.55.0.5");
ok(compareVersions("1.2.3", "1.2.3") === 0, "相同版本相等");
ok(compareVersions("1.2", "1.2.0") === 0, "缺段按 0 补齐");
ok(compareVersions("1.2.3-beta", "1.2.3") === -1, "预发布小于正式版");
ok(compareVersions("1.20.0", "1.19.0") > 0, "1.20.0 > 1.19.0");
ok(compareVersions("2026.7.992920", "2026.6.981214") > 0, "日期风格版本可比");
ok(!looksLikeVersion("Unknown"), "Unknown 不算版本");
ok(looksLikeVersion("4.1.15.56"), "4.1.15.56 是版本");
ok(splitVersion("v1.2.3") && splitVersion("v1.2.3").nums.join(".") === "1.2.3", "去掉 v 前缀");

/* ---------------- 安装包清单 ---------------- */
group("winget 下载清单解析");
const gitYaml = readFileSync(
  join(here, "fixture-installer-git.yaml"),
  "utf8"
);
const gitInfo = parseInstallerManifest(gitYaml);
ok(gitInfo.installerType === "inno", "识别 inno 安装器", gitInfo.installerType);
ok(gitInfo.silent === "/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART", "取出发布方静默参数", gitInfo.silent);
ok(gitInfo.installerUrl.startsWith("https://github.com/git-for-windows/"), "取出官网下载地址", gitInfo.installerUrl);
ok(gitInfo.elevation === "elevatesSelf", "取出提权要求", gitInfo.elevation);

group("静默参数决策");
ok(
  JSON.stringify(resolveInstallArgs({ silent: "/SP- /VERYSILENT", installerType: "inno" }, "a.exe")) ===
    JSON.stringify(["/SP-", "/VERYSILENT"]),
  "清单参数优先"
);
ok(
  JSON.stringify(resolveInstallArgs({ silent: '/qn /norestart /LOG="<LOGPATH>"', installerType: "msi" }, "a.msi")) ===
    JSON.stringify(["/qn", "/norestart"]),
  "剔除占位符模板参数"
);
ok(
  JSON.stringify(resolveInstallArgs({}, "a.msi")) === JSON.stringify(["/qn", "/norestart"]),
  "无清单时按 msi 兜底"
);
ok(
  JSON.stringify(defaultSilentArgs("nullsoft", "a.exe")) === JSON.stringify(["/S"]),
  "无清单时按 NSIS 兜底"
);
ok(
  JSON.stringify(splitSwitchArgs('/S /D="C:\\Program Files\\App"')) === JSON.stringify(["/S", "/D=C:\\Program Files\\App"]),
  "带引号的路径参数保持整体"
);

/* ---------------- 名称归一化 ---------------- */
group("跨源名称匹配");
ok(normalizeName("CPUID CPU-Z 3.01") === normalizeName("CPUID CPU-Z"), "去掉尾部版本号后同名");
ok(normalizeName("Microsoft Edge") !== normalizeName("Google Chrome"), "不同软件不误配");

/* ---------------- 本地化输出（健康检查） ---------------- */
group("本地化 winget 输出解析（中文界面）");
const zhListRaw = readFileSync(join(here, "fixture-winget-list-zh.txt"), "utf8");
const zhUpRaw = readFileSync(join(here, "fixture-winget-upgrade-zh.txt"), "utf8");
const zhInstalled = parseInstalledList(zhListRaw);
const zhUpgradable = parseUpgradeList(zhUpRaw);
ok(zhInstalled.length > 50, "中文表头（名称/ID/版本/可用/源）仍能解析出应用", zhInstalled.length);
ok(zhUpgradable.length >= 1, "中文表头下仍能解析出可更新项", zhUpgradable.length);
ok(
  zhInstalled.length >= installed.length - 5 && zhInstalled.some((r) => r.id === "Git.Git") && installed.some((r) => r.id === "Git.Git"),
  "中英文两次输出规模相当且都能认出同一批关键应用",
  [installed.length, zhInstalled.length]
);
const zhGit = zhInstalled.find((r) => r.id === "Git.Git");
ok(zhGit && zhGit.version && !zhGit.name.includes("名称"), "中文行未把表头当数据", zhGit);
ok(
  zhInstalled.some((r) => r.id.startsWith("ARP\\") && /\s/.test(r.id)),
  "ARP 且显示名带空格的行仍保留"
);
ok(
  zhInstalled.every((r) => looksLikeVersion(r.version) || /^(unknown|未知)$/i.test(r.version)),
  "所有数据行的版本列都像版本号（提示行被剔除）"
);

/* ---------------- 运行环境识别 ---------------- */
group("系统与架构识别");
ok(windowsName("10.0.26300", "26300") === "Windows 11", "build 26300 → Windows 11", windowsName("10.0.26300", "26300"));
ok(windowsName("10.0.19045", "19045") === "Windows 10", "build 19045 → Windows 10", windowsName("10.0.19045", "19045"));
ok(macOSName(24).version === "15" && macOSName(24).name.includes("Sequoia"), "Darwin 24 → macOS 15 Sequoia", macOSName(24));
ok(macOSName(23).version === "14", "Darwin 23 → macOS 14", macOSName(23));
ok(macOSName(99).name.includes("Darwin 99"), "未来版本不崩且如实标注", macOSName(99).name);

ok(
  normalizeArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64", PROCESSOR_ARCHITEW6432: "ARM64" }) === "arm64",
  "Windows on ARM 上跑 x64 Node 也能识别出 ARM64"
);
ok(normalizeArch("win32", "x64", { PROCESSOR_ARCHITECTURE: "AMD64" }) === "x64", "普通 x64 机器识别为 x64");
ok(normalizeArch("darwin", "arm64", {}) === "arm64", "Apple Silicon 识别为 arm64");
ok(normalizeArch("darwin", "x64", {}) === "x64", "Intel Mac 识别为 x64");
ok(archLabel("darwin", "arm64") === "Apple Silicon（ARM64）", "Apple Silicon 标签", archLabel("darwin", "arm64"));
ok(archLabel("win32", "x64").includes("x64"), "x64 标签", archLabel("win32", "x64"));
ok(wingetArch("arm64") === "arm64" && wingetArch("x64") === "x64" && wingetArch("unknown") === "", "winget 架构取值映射");

ok(platformFamily("win32") === "windows" && platformFamily("darwin") === "macos" && platformFamily("linux") === "other", "平台族归类");
ok(engineFor("windows") === ENGINE_WINGET, "Windows → winget", engineFor("windows"));
ok(engineFor("macos") === ENGINE_BREW, "macOS → Homebrew", engineFor("macos"));
ok(engineFor("other") === ENGINE_NONE, "其它系统 → 无引擎", engineFor("other"));

const envWinArm = detectEnvironment({
  platform: "win32",
  arch: "x64",
  release: "10.0.26100",
  env: { PROCESSOR_ARCHITECTURE: "AMD64", PROCESSOR_ARCHITEW6432: "ARM64" },
  cpus: [{ model: "Snapdragon X Elite" }],
});
ok(envWinArm.family === "windows" && envWinArm.arch === "arm64" && envWinArm.wingetArch === "arm64", "注入式环境识别（Windows ARM64）", envWinArm.arch);
ok(envWinArm.osName === "Windows 11" && envWinArm.osBuild === "26100", "Windows 版本名与 build", [envWinArm.osName, envWinArm.osBuild]);
ok(describeEnvironment(envWinArm).includes("Windows 11") && describeEnvironment(envWinArm).includes("ARM64"), "环境摘要包含系统与架构", describeEnvironment(envWinArm));

const envMac = detectEnvironment({ platform: "darwin", arch: "arm64", release: "24.1.0", env: {}, cpus: [{ model: "Apple M4" }] });
ok(envMac.family === "macos" && envMac.osName.includes("Sequoia") && envMac.arch === "arm64", "注入式环境识别（macOS Apple Silicon）", envMac.osName);

ok(capabilitiesFor(envWinArm, false).scan === true, "有 winget 时 Windows 可扫描");
ok(capabilitiesFor(envWinArm, false).note.includes("winget"), "缺 winget 时给出提示", capabilitiesFor(envWinArm, false).note);
ok(capabilitiesFor(envMac, false).update === false, "macOS 缺 Homebrew 时不可更新");
ok(capabilitiesFor(envMac, false).note.includes("Homebrew"), "macOS 缺 Homebrew 时提示装 Homebrew", capabilitiesFor(envMac, false).note);
ok(capabilitiesFor(envMac, true).scan === true, "macOS 有 Homebrew 时可扫描");
ok(capabilitiesFor(envMac, false).scan === true, "macOS 没有 Homebrew 也能扫描（只是不能更新）——「0 个应用」的真正原因不是没 Homebrew");
ok(capabilitiesFor(envMac, false).update === false, "macOS 没有 Homebrew 时不可更新");
ok(capabilitiesFor({ family: "other" }, false).scan === false, "其它系统不可扫描");

/* ---------------- Homebrew 解析 ---------------- */
group("Homebrew 输出解析");
const versions = parseBrewCaskVersions("visual-studio-code 1.94.0\ngoogle-chrome 131.0.6778.86\n\nbad\n");
ok(versions.get("visual-studio-code") === "1.94.0" && versions.get("google-chrome") === "131.0.6778.86", "解析已装 cask 版本", [...versions]);
ok(versions.size === 2, "无版本的行被忽略", versions.size);
const outdated = parseBrewOutdated(JSON.stringify({ casks: [{ name: "visual-studio-code", current_version: "1.95.0" }, { name: "iterm2", current_version: "3.5.10" }] }));
ok(outdated.get("visual-studio-code") === "1.95.0" && outdated.get("iterm2") === "3.5.10", "解析可升级 cask", [...outdated]);
ok(parseBrewOutdated("not json").size === 0, "坏 JSON 不抛错");
// 注意：findBrew 在 HOMEBREW_PREFIX 之外还会尝试 /opt/homebrew、/usr/local 等默认位置，
// 所以「本机真的没装 brew」时才能断言 null。装了 brew 的机器上这里必须按存在性断言，
// 否则测试会随运行环境飘（旧写法在任何装有 Homebrew 的 Mac 上都会红）。
const brewWithoutPrefix = findBrew({ HOMEBREW_PREFIX: "/nonexistent-prefix-for-test" });
ok(
  brewWithoutPrefix === null || brewWithoutPrefix === "/opt/homebrew/bin/brew" || brewWithoutPrefix === "/usr/local/bin/brew",
  "找不到 brew 时返回 null（本机装了 Homebrew 时退回默认前缀）",
  brewWithoutPrefix
);

/* ---------------- macOS 应用枚举（本次修复的核心） ---------------- */
group("macOS 应用枚举");
ok(applicationDirs("/Users/x").includes("/Applications"), "枚举 /Applications");
ok(applicationDirs("/Users/x").includes("/Users/x/Applications"), "枚举 ~/Applications");
ok(applicationDirs("/Users/x").includes("/System/Applications/Utilities"), "枚举系统工具目录");

const catalogList = [
  {
    token: "visual-studio-code",
    version: "1.144.0",
    name: ["Microsoft Visual Studio Code"],
    artifacts: [{ app: ["Visual Studio Code.app"], target: "/Applications/Visual Studio Code.app" }],
  },
  {
    token: "iterm2",
    version: "3.5.14",
    name: ["iTerm2"],
    artifacts: [{ app: ["iTerm.app"] }],
  },
  {
    token: "raycast",
    version: "1.99.0",
    name: ["Raycast"],
    artifacts: [{ app: ["Raycast.app"] }],
  },
];
const catalog = parseCaskCatalog(catalogList);
ok(catalog.byToken.get("iterm2").version === "3.5.14", "目录按 token 建索引");
ok(catalog.byApp.get("iterm.app")[0].token === "iterm2", "目录按 .app 文件名建索引（大小写无关）");

const macApps = [
  // 通过 Homebrew 装、且有新版
  { path: "/Applications/Visual Studio Code.app", bundleName: "Visual Studio Code.app", name: "Visual Studio Code", version: "1.140.0", bundleId: "com.microsoft.VSCode", appStore: false, system: false },
  // 通过 Homebrew 装、已是最新
  { path: "/Applications/iTerm.app", bundleName: "iTerm.app", name: "iTerm2", version: "3.5.14", bundleId: "com.googlecode.iterm2", appStore: false, system: false },
  // 拖 DMG 装的，Homebrew 不管
  { path: "/Applications/Raycast.app", bundleName: "Raycast.app", name: "Raycast", version: "1.99.0", bundleId: "com.raycast.macos", appStore: false, system: false },
  // App Store 装的
  { path: "/Applications/Xcode.app", bundleName: "Xcode.app", name: "Xcode", version: "16.0", bundleId: "com.apple.dt.Xcode", appStore: true, system: false },
];
const brews = new Map([["visual-studio-code", "1.140.0"], ["iterm2", "3.5.14"]]);
const macBuilt = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog, settings: { includeStoreApps: true, includeUnmanagedApps: true } });

ok(macBuilt.items.length === 4, "4 个 .app 全部列出（旧实现只会有 2 个）", macBuilt.items.map((i) => i.name));
const vsc = macBuilt.items.find((i) => i.name === "Visual Studio Code");
ok(vsc && vsc.hasUpdate && vsc.available === "1.144.0", "Homebrew 管理 + 有新版本 → 可更新并给出目标版本", vsc);
ok(vsc && vsc.updateSupported === true && vsc.id === "brew:visual-studio-code", "可更新的应用带上 brew: token", vsc && vsc.id);
const iterm = macBuilt.items.find((i) => i.name === "iTerm2");
ok(iterm && iterm.hasUpdate === false && iterm.reason === null, "Homebrew 管理且已最新 → 不可更新但没有「不支持」理由", iterm);
const ray = macBuilt.items.find((i) => i.name === "Raycast");
ok(ray && ray.hasUpdate === false && ray.reason === "not-managed", "非 Homebrew 应用：列出但标注「非 Homebrew 管理」", ray);
ok(ray && ray.updateSupported === false, "非 Homebrew 应用不会被标成可更新");
const xcode = macBuilt.items.find((i) => i.name === "Xcode");
ok(xcode && xcode.reason === "store-managed" && xcode.source === "appstore", "App Store 应用标注由商店管理", xcode);
ok(macBuilt.items.filter((i) => i.hasUpdate).length === 1, "只有 1 个可更新");

// --greedy 能强制升级的 cask（自更新应用）也要露出可用版本
const greedy = buildMacosItems({ apps: macApps, brews, outdated: new Map([["iterm2", "3.5.15"]]), catalog, settings: {} });
ok(greedy.items.find((i) => i.name === "iTerm2").available === "3.5.15", "brew outdated --greedy 报告的版本优先", greedy.items.find((i) => i.name === "iTerm2"));

// 关掉「包含非 Homebrew 应用」后只剩 Homebrew 管理的
const onlyBrew = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog, settings: { includeUnmanagedApps: false } });
ok(onlyBrew.items.length === 2 && onlyBrew.items.every((i) => i.source === "homebrew"), "关闭开关后只显示 Homebrew 应用", onlyBrew.items.map((i) => i.name));

// 关掉「包含 App Store 应用」
const noStore = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog, settings: { includeStoreApps: false } });
ok(!noStore.items.some((i) => i.name === "Xcode"), "关闭 App Store 开关后不显示 Xcode");

// 没有 cask 目录时降级：仍然列出应用，只是都不认为可更新
const noCatalog = buildMacosItems({ apps: macApps, brews, outdated: new Map(), catalog: null, settings: {} });
ok(noCatalog.items.length === 4 && noCatalog.items.every((i) => !i.hasUpdate), "没有 cask 目录也照样列出应用", noCatalog.items.length);
ok(noCatalog.warnings.some((w) => w.includes("cask 目录")), "没有 cask 目录时给出警告");

// Homebrew 装了但 .app 不在标准目录（字体 / 命令行 cask）
const brewOnly = buildMacosItems({
  apps: [],
  brews: new Map([["font-jetbrains-mono", "2.304"]]),
  outdated: new Map(),
  catalog: parseCaskCatalog([{ token: "font-jetbrains-mono", version: "2.304", name: ["JetBrains Mono"], artifacts: [] }]),
  settings: {},
});
ok(brewOnly.items.length === 1 && brewOnly.items[0].id === "brew:font-jetbrains-mono", "没有 .app 的 cask 也能列出", brewOnly.items);

/* ---------------- macOS 目录解析 ---------------- */
group("cask 目录解析");
const parsedCatalog = parseCaskCatalog([
  { token: "raycast", version: "1.99.0", name: ["Raycast"], artifacts: [{ app: ["Raycast.app"] }] },
  { token: "bad-no-artifacts", version: "1.0" },
  null,
  { version: "9.9" },
]);
ok(parsedCatalog.byToken.size === 2, "跳过没有 token 的条目", parsedCatalog.byToken.size);
ok(!parsedCatalog.byApp.has("bad-no-artifacts"), "artifacts 里没有 app 的不建 byApp 索引");
ok(normalizeAppKey("Visual Studio Code.app") === "visualstudiocode", "应用名归一化去掉 .app 与空格");
ok(normalizeAppKey("VS Code") === "vscode", "应用名归一化保留字母数字");

group("同名 .app 的多个 cask：挑对那一个");
// 真实目录里 iterm2 与 iterm2@nightly 都声明 iTerm.app
const dupCatalog = parseCaskCatalog([
  { token: "iterm2@nightly", version: "3.6.0", name: ["iTerm2 Nightly"], artifacts: [{ app: ["iTerm.app"] }] },
  { token: "iterm2", version: "3.7.6", name: ["iTerm2"], artifacts: [{ app: ["iTerm.app"] }] },
]);
ok(dupCatalog.byApp.get("iterm.app").length === 2, "两个 cask 都留在候选里", dupCatalog.byApp.get("iterm.app").length);
ok(
  pickCask(dupCatalog.byApp.get("iterm.app"), { appName: "iTerm2", bundleName: "iTerm.app", brews: new Map() }).token === "iterm2",
  "没有安装记录时优先主 token（不是 @nightly）"
);
ok(
  pickCask(dupCatalog.byApp.get("iterm.app"), { appName: "iTerm2", bundleName: "iTerm.app", brews: new Map([["iterm2@nightly", "3.6.0"]]) }).token === "iterm2@nightly",
  "已装的是 nightly 时优先已装的那个"
);
// 弃用 / 停用的 cask 排在后面
const depCatalog = parseCaskCatalog([
  { token: "foo-old", version: "1.0", deprecated: true, artifacts: [{ app: ["Foo.app"] }] },
  { token: "foo", version: "2.0", artifacts: [{ app: ["Foo.app"] }] },
]);
ok(pickCask(depCatalog.byApp.get("foo.app"), { appName: "Foo", bundleName: "Foo.app", brews: new Map() }).token === "foo", "弃用的 cask 不会被选中");

/* ---------------- 提权与安装复核 ---------------- */
group("提权执行（PowerShell 助手）");
ok(psQuote("C:\\Program Files\\a.exe") === "'C:\\Program Files\\a.exe'", "psQuote 保留 Windows 路径");
ok(psQuote("it's") === "'it''s'", "psQuote 转义单引号");
ok(psQuote(null) === "''", "psQuote 处理 null");
ok(ELEVATION_CANCELLED === 1223, "UAC 被取消的退出码是 1223");

group("架构缺失错误识别（中英文都要认）");
ok(isArchNotFoundError("找不到适用的安装程序;有关详细信息，请参阅日志。"), "中文「找不到适用」");
ok(isArchNotFoundError("No applicable installer found"), "英文 No applicable installer");
ok(!isArchNotFoundError("No package found matching input criteria"), "「找不到该包」不算架构问题");
ok(!isArchNotFoundError(""), "空输出不算");
ok(!isArchNotFoundError(null), "null 不算");

group("安装后复核：退出码 0 不等于成功");
ok(evaluateUpdateResult({ before: "2026.6.981214", after: "2026.6.981214", target: "2026.7.992920" }).changed === false, "G HUB：退出码 0、版本没变 → 判为失败");
ok(evaluateUpdateResult({ before: "2026.6.981214", after: "2026.7.992920", target: "2026.7.992920" }).changed === true, "达到目标版本 → 成功");
ok(evaluateUpdateResult({ before: "2026.6.981214", after: "2026.8.0", target: "2026.7.992920" }).changed === true, "超过目标版本 → 成功");
ok(evaluateUpdateResult({ before: "Unknown", after: "Unknown", target: "7.5.0.0" }).unverifiable === true, "虎牙：读不到版本 → 无法复核（不能算失败）");
ok(evaluateUpdateResult({ before: "1.0", after: "", target: "2.0" }).unverifiable === true, "空版本 → 无法复核");
ok(evaluateUpdateResult({ before: "1.0.0", after: "1.2.0", target: "" }).changed === true, "目标未知但版本变新 → 成功");
ok(evaluateUpdateResult({ before: "1.2.0", after: "1.2.0", target: "" }).changed === false, "目标未知且没变 → 失败");

group("安装器退出码 → 人话");
ok(explainInstallerExitCode(1603, "").includes("1603"), "1603 给出可读解释");
ok(explainInstallerExitCode(1603, "first line\nsecond line") === "first line", "有输出时优先用输出的首行");
ok(explainInstallerExitCode(9999, "") === "安装程序退出码 9999", "未知退出码原样透出");

group("Edge 自带更新服务定位");
const edgeUpdate = findEdgeUpdate();
ok(edgeUpdate === null || /MicrosoftEdgeUpdate\.exe$/i.test(edgeUpdate), "返回绝对路径或 null");
ok(updateHintFor("Logitech.GHUB").includes("启动 G HUB"), "G HUB 给出「启动应用才会应用更新」的提示");
ok(updateHintFor("microsoft.edge").length > 0, "Edge 有提示");
ok(updateHintFor("Some.Other") === "" && updateHintFor(null) === "", "未知应用没有提示");

/* ---------------- connection 准入 ---------------- */
function fakeRes() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.setHeader = (k, v) => {
    res.headers[k] = v;
  };
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    Object.assign(res.headers, headers || {});
  };
  res.end = (body) => {
    res.body = String(body == null ? "" : body);
  };
  return res;
}
function fakeReq({ loopback = true, headers = {} } = {}) {
  return { socket: { remoteAddress: loopback ? "127.0.0.1" : "10.0.0.5" }, headers };
}

group("connection 准入（市场审核要求：默认拒绝）");
ok(hasConnectionCredentials({ headers: { cookie: "dsh=x" } }) === true, "识别浏览器会话 Cookie");
ok(hasConnectionCredentials({ headers: { authorization: "Bearer x" } }) === true, "识别 API Cookie/Authorization");
ok(hasConnectionCredentials({ headers: {} }) === false, "没有凭据时返回 false");

/* --- 兼容模式开关：默认关闭，必须是显式动作 --- */
ok(resolveLegacyLoopbackOptIn(undefined, {}) === false, "没有任何显式开关 → 兼容模式关闭");
ok(resolveLegacyLoopbackOptIn(null, {}) === false, "配置为 null → 兼容模式关闭");
ok(resolveLegacyLoopbackOptIn({}, {}) === false, "配置里没有该字段 → 兼容模式关闭");
ok(resolveLegacyLoopbackOptIn({ allowLegacyLoopback: false }, {}) === false, "配置显式 false → 关闭");
ok(resolveLegacyLoopbackOptIn({ allowLegacyLoopback: true }, {}) === true, "插件配置 allowLegacyLoopback:true → 开启");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "1" }) === true, "环境变量 =1 → 开启");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "true" }) === true, "环境变量 =true → 开启");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "0" }) === false, "环境变量 =0 → 关闭");
ok(resolveLegacyLoopbackOptIn(undefined, { [LEGACY_LOOPBACK_ENV]: "off" }) === false, "环境变量 =off → 关闭");

/* --- 宿主没有 connection 服务：默认拒绝，只有显式开启兼容模式才放行 --- */
{
  const res = fakeRes();
  ok(
    admissionGate(fakeReq(), res, null) === false && res.statusCode === 403 && res.headers["X-DSH-Admission"] === "denied",
    "没有 connection 服务 + 回环 + 未开兼容模式 → 403（默认拒绝）"
  );
}
{
  const res = fakeRes();
  ok(admissionGate(fakeReq({ loopback: false }), res, null) === false && res.statusCode === 403, "没有 connection 服务时，非回环请求 403");
}
{
  const res = fakeRes();
  ok(
    admissionGate(fakeReq(), res, null, { allowLegacyLoopback: true }) === true &&
      res.headers["X-DSH-Admission"] === "loopback-legacy-optin" &&
      res.headers["X-DSH-Admission-Warning"] === "legacy-loopback-compatibility-enabled",
    "显式开启兼容模式 + 回环 → 放行并标注 opt-in 响应头"
  );
}
{
  const res = fakeRes();
  ok(
    admissionGate(fakeReq({ loopback: false }), res, null, { allowLegacyLoopback: true }) === false && res.statusCode === 403,
    "即使开启兼容模式，非回环请求仍然 403"
  );
}

/* --- 宿主有 connection 服务：一律以 admit() 为准 --- */
{
  const res = fakeRes();
  const connection = { admit: () => ({ peer: { id: "peer-1" } }) };
  ok(admissionGate(fakeReq(), res, connection) === true && res.statusCode === 0, "准入通过 → 放行且不写响应");
}
{
  const res = fakeRes();
  const connection = { admit: () => undefined };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 500, "准入返回空值 → 500（不把看不懂的结果放行）");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: "401" }) };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 403, "准入返回非数字拒绝码 → 403（fail-closed）");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 403 }) };
  ok(admissionGate(fakeReq({ loopback: false }), res, connection) === false && res.statusCode === 403, "准入拒绝 403（不可信来源）→ 403");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 409 }) };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 409, "准入拒绝 409（连接被占用）→ 409");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(admissionGate(fakeReq({ headers: { cookie: "dsh=x" } }), res, connection) === false && res.statusCode === 401, "带凭据但未认证 → 401");
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq({ headers: { cookie: "dsh=x" } }), res, connection, { allowLegacyLoopback: true }) === false &&
      res.statusCode === 401,
    "带凭据未认证时，兼容模式也不放行"
  );
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq(), res, connection) === false && res.statusCode === 401 && res.headers["X-DSH-Admission"] === "denied",
    "无凭据的回环请求默认拒绝（不再退回回环信任）"
  );
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq(), res, connection, { allowLegacyLoopback: true }) === true &&
      res.headers["X-DSH-Admission"] === "loopback-legacy-optin",
    "显式开启兼容模式后，无凭据的回环请求才按旧规则放行"
  );
}
{
  const res = fakeRes();
  const connection = { admit: () => ({ rejection: 401 }) };
  ok(
    admissionGate(fakeReq({ loopback: false }), res, connection, { allowLegacyLoopback: true }) === false && res.statusCode === 401,
    "兼容模式的例外只覆盖回环地址，非回环仍然 401"
  );
}
{
  const res = fakeRes();
  const connection = {
    admit: () => {
      throw new Error("carrier unavailable");
    },
  };
  ok(admissionGate(fakeReq(), res, connection) === false && res.statusCode === 500, "准入抛错 → 500 而不是静默放行");
}

/* ---------------- 结果 ---------------- */
console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);