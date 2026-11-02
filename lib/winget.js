/**
 * winget 适配层：定位可执行文件、调用子命令、解析它的表格输出。
 *
 * winget 的输出是给人看的定宽表格，没有 JSON 模式，所以这里按「显示宽度」
 * 切列：CJK 字符占两列。行首到下一列起点之间是一个单元格。
 *
 * 两个已知的输出坑：
 *  1) 管道输出时 winget 用 194 列宽（实测 1.29.380），Name 列会被截断；
 *  2) `winget upgrade` 是另一套更窄的表格，列宽与 list 不同。
 * 因此列边界必须从各自表头解析，不能写死。
 */

import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { looksLikeVersion } from "./version.js";

/**
 * winget.exe 在 WindowsApps 下是「应用执行别名」（reparse point），指向
 * C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_*\winget.exe。
 * 那个目标目录受 ACL 保护：`existsSync` / `statSync` 会抛 EACCES 并返回 false，
 * 但 `lstatSync` 读的是别名本身，能正常拿到大小。所以这里一律用 lstat。
 */
function usableAlias(file) {
  try {
    const st = lstatSync(file);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
}

const WINGET_TIMEOUT_MS = 180000;

/** 一个字符在终端里占几列。 */
export function charWidth(ch) {
  const c = ch.codePointAt(0);
  if (c === undefined) return 1;
  if (c === 0x200b) return 0;
  if (c < 0x1100) return 1;
  if (
    c <= 0x115f || // Hangul Jamo
    (c >= 0x2e80 && c <= 0x303e) || // CJK Radicals / Kangxi / CJK Symbols
    (c >= 0x3041 && c <= 0x33ff) || // Hiragana .. CJK Compatibility
    (c >= 0x3400 && c <= 0x4dbf) || // CJK Ext A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK Unified
    (c >= 0xa000 && c <= 0xa4cf) || // Yi
    (c >= 0xac00 && c <= 0xd7a3) || // Hangul Syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK Compatibility Ideographs
    (c >= 0xfe30 && c <= 0xfe6f) || // CJK Compatibility Forms
    (c >= 0xff00 && c <= 0xff60) || // Fullwidth Forms
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1f64f) || // Emoji
    (c >= 0x1f900 && c <= 0x1f9ff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text) {
  let w = 0;
  for (const ch of String(text)) w += charWidth(ch);
  return w;
}

/** 按显示列宽切出 [start, end) 区间的子串。 */
export function sliceByWidth(line, start, end) {
  let out = "";
  let col = 0;
  for (const ch of line) {
    const w = charWidth(ch);
    if (col >= start && col < end) out += ch;
    col += w;
    if (col >= end) break;
  }
  return out.trim();
}

/** 从表头行解析各列的起始显示列。 */
export function parseHeaderColumns(headerLine) {
  const starts = [];
  let col = 0;
  let prevSpace = true;
  for (const ch of headerLine) {
    const isSpace = ch === " " || ch === "\t";
    if (!isSpace && prevSpace) starts.push(col);
    prevSpace = isSpace;
    col += charWidth(ch);
  }
  return starts;
}

const SEPARATOR = /^[-=\s]+$/;

function cleanCell(text) {
  return String(text == null ? "" : text).trim();
}

/** 表头下面的那条虚线；winget 每种语言的表头都靠它收尾。 */
function isSeparatorLine(line) {
  const t = String(line || "").trim();
  return t.length >= 3 && /^[-=]+$/.test(t);
}

/** 一行里有几个「词」（用于判断它像不像表头，与语言无关）。 */
function wordCount(line) {
  let n = 0;
  let prevSpace = true;
  for (const ch of String(line || "")) {
    const isSpace = ch === " " || ch === "\t";
    if (!isSpace && prevSpace) n += 1;
    prevSpace = isSpace;
  }
  return n;
}

/**
 * 解析 winget 的定宽表格。
 *
 * 表头识别必须与语言无关：winget 会跟随系统区域设置输出本地化表头
 * （中文版是 `名称 ID 版本 可用 源`），只认英文 `Name Id ...` 会在中文系统上
 * 直接解析出 0 行。这里的判据是「这一行的下一行是虚线，且本行至少有 3 个词」，
 * 英文正则只作为额外候选。
 *
 * @param {string} raw 命令原始输出
 * @param {{ requireHeader?: RegExp }} [opts]
 * @returns {{ columns: string[], rows: string[][] }}
 */
export function parseWingetTable(raw, opts = {}) {
  const text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const englishRe = opts.requireHeader || /^Name\s+Id\s+Version/;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const english = englishRe.test(line);
    const structural = wordCount(line) >= 3 && isSeparatorLine(lines[i + 1]);
    if (english || structural) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return { columns: [], rows: [] };

  const header = lines[headerIndex];
  const starts = parseHeaderColumns(header);
  const columns = starts.map((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY;
    return sliceByWidth(header, s, end);
  });

  const bounds = starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY]);
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (SEPARATOR.test(line)) continue;
    // 尾部提示行（"15 upgrades available." / "No installed package found..."）不是数据行：
    // 数据行的 Id 列必须有内容。
    const cells = bounds.map(([a, b]) => cleanCell(sliceByWidth(line, a, b)));
    if (!cells[0]) continue;
    if (!cells[1]) continue;
    rows.push(cells);
  }
  return { columns, rows };
}

/**
 * winget 表格尾部会出现提示行（如 `15 upgrades available.` / `15 个可用的升级。`），
 * 它们落在定宽列里同样是「非空单元格」，不能只看首列。
 *
 * 判据（都满足才算数据行）：
 *  1) Name 非空；2) Version 像版本号或是 `Unknown` / `未知`——提示行会落进别的列，
 *  Version 列必然不是版本；3) Id 不含空白字符，例外是 winget 为传统 ARP 条目合成的
 *  `ARP\Machine\X64\<显示名>`（显示名可带空格）。
 */
function isDataRow(row) {
  if (!row.name) return false;
  const version = String(row.version || "").trim();
  if (!version) return false;
  if (!looksLikeVersion(version) && !/^(unknown|未知)$/i.test(version)) return false;
  if (!row.id) return false;
  if (!/\s/.test(row.id)) return true;
  return /^ARP\\/i.test(row.id);
}

/** 解析 `winget list` 输出 → 已安装清单（与界面语言无关）。 */
export function parseInstalledList(raw) {
  const { columns, rows } = parseWingetTable(raw);
  const idx = indexColumns(columns);
  return rows
    .map((cells) => ({
      name: cells[idx.name] || "",
      id: cells[idx.id] || "",
      version: cells[idx.version] || "",
      available: idx.available >= 0 ? cells[idx.available] || "" : "",
      source: idx.source >= 0 ? cells[idx.source] || "" : "",
    }))
    .filter(isDataRow);
}

/** 解析 `winget upgrade` 输出 → 可升级清单（与界面语言无关）。 */
export function parseUpgradeList(raw) {
  const { columns, rows } = parseWingetTable(raw, { requireHeader: /^Name\s+Id\s+Version\s+Available/ });
  const idx = indexColumns(columns);
  return rows
    .map((cells) => ({
      name: cells[idx.name] || "",
      id: cells[idx.id] || "",
      version: cells[idx.version] || "",
      available: idx.available >= 0 ? cells[idx.available] || "" : "",
      source: idx.source >= 0 ? cells[idx.source] || "" : "",
    }))
    .filter(isDataRow);
}

/**
 * 表头 → 列下标。
 *
 * winget 的表头会跟随界面语言变化（`名称 ID 版本 可用 源`），但**列的先后顺序是固定的**。
 * 因此先按标签找（英文与中文都试），标签都认不出时按位置回退：Name, Id, Version, Available, Source。
 */
function indexColumns(columns) {
  const lower = columns.map((c) => c.toLowerCase());
  const find = (...names) => {
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const n = columns.length;
  let name = find("name", "名称");
  let id = find("id", "id", "标识");
  let version = find("version", "版本");
  let available = find("available", "可用");
  let source = find("source", "源");
  if (id < 0 || version < 0) {
    // 本地化表头没认出来：按 winget 固定的列序回退
    name = n > 0 ? 0 : -1;
    id = n > 1 ? 1 : -1;
    version = n > 2 ? 2 : -1;
    available = n > 3 ? 3 : -1;
    source = n > 4 ? 4 : -1;
  }
  return { name, id, version, available, source };
}

/** 定位 winget.exe（绝对路径，绝不经过 shell 或 PATH 相对项）。 */
export function findWinget(env = process.env) {
  const candidates = [];
  const localAppData = env.LOCALAPPDATA || env.LocalAppData;
  if (localAppData) candidates.push(join(localAppData, "Microsoft", "WindowsApps", "winget.exe"));
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  candidates.push(join(programFiles, "WindowsApps", "winget.exe"));
  const pathValue = env.PATH || env.Path || "";
  for (const entry of pathValue.split(";")) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (!dir) continue;
    if (!/^[a-zA-Z]:[\\/]/.test(dir)) continue; // 只接受绝对路径
    candidates.push(join(dir, "winget.exe"));
  }
  for (const file of candidates) {
    if (usableAlias(file)) return file;
  }
  return null;
}

/**
 * 跑一条 winget 子命令。
 * 始终走 UTF-8 解码：winget 的输出是 UTF-8（实测中文名不乱码）。
 */
export function runWinget(exe, args, options = {}) {
  const timeout = options.timeoutMs || WINGET_TIMEOUT_MS;
  return new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    let settled = false;
    let timer = null;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(options.env || {}) },
      });
    } catch (err) {
      finish({ ok: false, code: null, stdout: "", stderr: String((err && err.message) || err), error: "spawn" });
      return;
    }
    if (options.signal) {
      if (options.signal.aborted) {
        try { child.kill(); } catch { /* 已退出 */ }
      } else {
        options.signal.addEventListener("abort", () => {
          try { child.kill(); } catch { /* 已退出 */ }
        }, { once: true });
      }
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString("utf8"), stderr: Buffer.concat(errChunks).toString("utf8"), error: "timeout" });
    }, timeout);
    child.stdout.on("data", (d) => chunks.push(d));
    // stderr 单独收桶：winget 的横幅/警告写进 stderr 时不污染定宽表解析（解析器
    // 可能把折行的横幅误判成数据行），且 close 后 outputText 能拿到真实 stderr 分类错误。
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (err) => {
      finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString("utf8"), stderr: String(err && err.message), error: "spawn" });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      finish({ ok: code === 0, code, stdout, stderr: Buffer.concat(errChunks).toString("utf8"), error: null });
    });
  });
}

/** 从 `winget --version` 输出提取版本号。 */
export function parseWingetVersion(raw) {
  const m = String(raw || "").match(/v?(\d+\.\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : "";
}

/** winget 是否「不可用」类错误（未安装 / 被策略禁用 / 权限不足）。 */
export function isWingetUnavailable(result) {
  if (!result) return true;
  if (result.error === "spawn") return true;
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return /被拒绝访问|拒绝访问|Access is denied|not recognized|无法识别/i.test(text) && (result.code !== 0);
}
