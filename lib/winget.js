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

/**
 * 解析 winget 的定宽表格。
 * @param {string} raw 命令原始输出
 * @param {{ requireHeader?: RegExp }} [opts]
 * @returns {{ columns: string[], rows: string[][] }}
 */
export function parseWingetTable(raw, opts = {}) {
  const text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n");
  const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
  const headerRe = opts.requireHeader || /^Name\s+Id\s+Version/;
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headerRe.test(lines[i])) {
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
 * winget 表格尾部会出现提示行（如 `15 upgrades available.` / `No installed
 * package found …`），它们落在定宽列里同样是「非空单元格」，不能只看首列。
 *
 * 判据（三条都满足才算数据行）：
 *  1) Name 非空；2) Version 非空——真实清单里每一行的版本要么是版本号、要么是
 *  `Unknown`，而提示行会落进别的列，Version 列必然为空；3) Id 不含空白字符，
 *  例外是 winget 为传统 ARP 条目合成的 `ARP\Machine\X64\<显示名>`（显示名可带空格）。
 */
function isDataRow(row) {
  if (!row.name) return false;
  if (!String(row.version || "").trim()) return false;
  if (!row.id) return false;
  if (!/\s/.test(row.id)) return true;
  return /^ARP\\/i.test(row.id);
}

/** 解析 `winget list` 输出 → 已安装清单。 */
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

/** 解析 `winget upgrade` 输出 → 可升级清单。 */
export function parseUpgradeList(raw) {
  const { columns, rows } = parseWingetTable(raw, { requireHeader: /^Name\s+Id\s+Version\s+Available/ });
  const idx = indexColumns(columns);
  return rows
    .map((cells) => ({
      name: cells[idx.name] || "",
      id: cells[idx.id] || "",
      version: cells[idx.version] || "",
      available: cells[idx.available] || "",
      source: cells[idx.source] || "",
    }))
    .filter(isDataRow);
}

function indexColumns(columns) {
  const lower = columns.map((c) => c.toLowerCase());
  const find = (...names) => {
    for (const n of names) {
      const i = lower.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    name: find("name"),
    id: find("id"),
    version: find("version"),
    available: find("available"),
    source: find("source"),
  };
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
      finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString("utf8"), stderr: "", error: "timeout" });
    }, timeout);
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => chunks.push(d));
    child.on("error", (err) => {
      finish({ ok: false, code: null, stdout: Buffer.concat(chunks).toString("utf8"), stderr: String(err && err.message), error: "spawn" });
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      finish({ ok: code === 0, code, stdout, stderr: "", error: null });
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
