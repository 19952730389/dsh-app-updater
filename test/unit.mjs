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
import { parseInstallerManifest, splitSwitchArgs, defaultSilentArgs, resolveInstallArgs } from "../lib/engine.js";
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

/* ---------------- 结果 ---------------- */
console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);