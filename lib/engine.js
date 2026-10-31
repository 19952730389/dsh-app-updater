/**
 * 更新引擎：扫描 → 排队 → 逐个「下载官网全量安装包 → 校验 → 静默安装 → 复核版本」。
 *
 * 设计取舍：
 *  - 检测只用 winget 的公开子命令（list / upgrade），不需要启动任何被检测的软件；
 *  - 更新优先走 winget download：它把**官网原始安装包**完整下载到本地（不是增量补丁），
 *    我们再自己用清单里的静默参数执行，做到「全量包 + 可留档 + 可回退」；
 *  - download 失败时退回 winget upgrade（同样是官网全量包，只是安装过程交给 winget）；
 *  - 每步都写日志，失败原因原样透出，不吞错误。
 */

import { mkdir, readdir, stat, readFile, rm } from "node:fs/promises";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";

import { runProcess, outputText } from "./proc.js";
import {
  findWinget,
  runWinget,
  parseInstalledList,
  parseUpgradeList,
  parseWingetVersion,
  isWingetUnavailable,
} from "./winget.js";
import { readRegistryApps, normalizeName } from "./registry.js";
import { compareVersions, isNewer, looksLikeVersion } from "./version.js";

const INSTALLER_EXT = /\.(exe|msi|msix|appx|msixbundle)$/i;

/* ------------------------------------------------------------------ *
 * 清单解析（只取我们需要的字段，不引第三方 YAML 库）
 * ------------------------------------------------------------------ */

/**
 * 从 winget download 落盘的 merged manifest 里提取安装信息。
 * 只做「按缩进扫描」的定向提取：InstallerType / Silent 参数 / Scope / InstallerUrl。
 */
export function parseInstallerManifest(yamlText) {
  const text = String(yamlText || "").replace(/\r\n?/g, "\n");
  const info = {
    installerType: "",
    installerUrl: "",
    silent: "",
    silentWithProgress: "",
    scope: "",
    elevation: "",
    productCode: "",
  };
  const lines = text.split("\n");
  let inInstallers = false;
  let inSwitches = false;
  let switchIndent = -1;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (/^Installers:\s*$/.test(trimmed)) {
      inInstallers = true;
      inSwitches = false;
      continue;
    }
    if (inInstallers && indent === 0 && /^[A-Za-z]/.test(trimmed)) {
      // 回到顶层键：Installers 段结束
      inInstallers = false;
      inSwitches = false;
    }
    if (!inInstallers) continue;

    if (/^InstallerSwitches:\s*$/.test(trimmed)) {
      inSwitches = true;
      switchIndent = indent;
      continue;
    }
    if (inSwitches && indent <= switchIndent && !/^InstallerSwitches:/.test(trimmed)) {
      inSwitches = false;
    }

    if (inSwitches) {
      const m = trimmed.match(/^(SilentWithProgress|Silent|Log|InstallLocation):\s*(.+)$/);
      if (m) {
        const value = stripQuotes(m[2]);
        if (m[1] === "Silent") info.silent = value;
        else if (m[1] === "SilentWithProgress") info.silentWithProgress = value;
      }
      continue;
    }

    const kv = trimmed.match(/^(InstallerType|InstallerUrl|Scope|ElevationRequirement|ProductCode|Architecture):\s*(.+)$/);
    if (kv) {
      const value = stripQuotes(kv[2]);
      switch (kv[1]) {
        case "InstallerType":
          if (!info.installerType) info.installerType = value;
          break;
        case "InstallerUrl":
          if (!info.installerUrl) info.installerUrl = value;
          break;
        case "Scope":
          if (!info.scope) info.scope = value;
          break;
        case "ElevationRequirement":
          if (!info.elevation) info.elevation = value;
          break;
        case "ProductCode":
          if (!info.productCode) info.productCode = value;
          break;
        default:
          break;
      }
    }
  }
  return info;
}

function stripQuotes(value) {
  let v = String(value || "").trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    v = v.slice(1, -1);
  }
  return v;
}

/** 根据安装包类型给出静默安装参数（清单没写时的兜底）。 */
export function defaultSilentArgs(installerType, filePath) {
  const type = String(installerType || "").toLowerCase();
  const ext = String(filePath || "").toLowerCase();
  if (type === "msi" || ext.endsWith(".msi")) return ["/qn", "/norestart"];
  if (type === "inno" || type === "innosetup") return ["/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];
  if (type === "nullsoft" || type === "nsis") return ["/S"];
  if (type === "burn" || type === "wix") return ["/quiet", "/norestart"];
  if (type === "msix" || type === "appx") return [];
  // 未知 exe：优先 Inno 参数（国内/开源软件最常见），失败时由上层改用 winget upgrade
  return ["/S"];
}

/** 把清单里的 Silent 字符串切成参数数组（保留引号内的整体）。 */
export function splitSwitchArgs(silent) {
  const text = String(silent || "").trim();
  if (!text) return [];
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === " ") {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * 决定用什么参数跑安装包。
 *
 * 顺序很重要：清单里声明的 Silent 参数优先（那是发布方自己给的、与安装包
 * 完全匹配的一组开关）；没有清单时才按安装包类型猜。
 *
 * 注意：清单里的 `/LOG="<LOGPATH>"` 是占位符模板，不能原样传，所以这里只
 * 取 Silent / SilentWithProgress 两项，占位符再单独剔除。
 */
export function resolveInstallArgs(info, installerPath) {
  const declared = (info && (info.silent || info.silentWithProgress)) || "";
  // 占位符模板（<LOGPATH> / <INSTALLPATH>）不能原样传给安装包：删掉占位符，
  // 再把因此变空值的开关（形如 /LOG=）整条剔除。
  const cleaned = String(declared).replace(/<[A-Za-z_]+>/g, "").replace(/\s+/g, " ").trim();
  const declaredArgs = splitSwitchArgs(cleaned).filter((a) => {
    if (!a) return false;
    if (/^\/?[A-Za-z]+=$/.test(a)) return false; // /LOG= 这类空值开关
    return true;
  });
  if (declaredArgs.length) return declaredArgs;
  return defaultSilentArgs(info && info.installerType, installerPath);
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

export function resolveDownloadDir(settings) {
  const custom = String((settings && settings.downloadDir) || "").trim();
  if (custom && isAbsolute(custom)) return custom;
  return join(homedir(), "Downloads", "DSH App Updater");
}

function isStoreId(id) {
  return /^(MSIX|MSSTORE)\\/i.test(String(id || ""));
}

/**
 * 执行一次完整扫描。
 * @param {{ settings: object, log: (level: string, text: string) => void, signal?: AbortSignal }} ctx
 */
export async function scanApps({ settings, log, signal }) {
  const startedAt = Date.now();
  const warnings = [];
  const wingetPath = findWinget();

  /** @type {Map<string, any>} */
  const byId = new Map();
  /** @type {Map<string, string>} id → available */
  const availableById = new Map();

  let wingetInfo = { available: false, version: "", path: wingetPath || "" };
  if (wingetPath) {
    const ver = await runWinget(wingetPath, ["--version"], { timeoutMs: 20000 });
    const version = parseWingetVersion(ver.stdout);
    wingetInfo = { available: ver.ok && !!version, version, path: wingetPath };
    if (!wingetInfo.available) warnings.push("winget 无法执行，仅使用注册表检测（无法判断是否有新版本）");
  } else {
    warnings.push("未找到 winget.exe，仅使用注册表检测（无法判断是否有新版本）");
  }

  if (wingetInfo.available) {
    log("info", "正在读取 winget 已安装清单…");
    const listRes = await runWinget(
      wingetPath,
      ["list", "--accept-source-agreements", "--disable-interactivity"],
      { timeoutMs: 240000, signal }
    );
    if (!listRes.ok && isWingetUnavailable(listRes)) {
      warnings.push(`winget list 失败：${firstLine(outputText(listRes)) || "未知错误"}`);
      wingetInfo.available = false;
    } else {
      const installed = parseInstalledList(listRes.stdout);
      log("info", `winget 报告 ${installed.length} 个已安装条目`);
      for (const item of installed) {
        if (!item.id) continue;
        byId.set(item.id, {
          id: item.id,
          name: item.name || item.id,
          version: item.version || "",
          available: "",
          publisher: "",
          source: /^(MSIX|MSSTORE)\\/i.test(item.id) ? "msstore" : "winget",
          installLocation: "",
          hasUpdate: false,
          updateSupported: false,
          reason: null,
          kind: null,
        });
      }

      log("info", "正在向软件目录查询可用更新…");
      const upRes = await runWinget(
        wingetPath,
        ["upgrade", "--include-unknown", "--accept-source-agreements", "--disable-interactivity"],
        { timeoutMs: 240000, signal }
      );
      if (upRes.ok || upRes.stdout) {
        const upgradable = parseUpgradeList(upRes.stdout);
        log("info", `软件目录报告 ${upgradable.length} 个可更新条目`);
        for (const item of upgradable) {
          if (!item.id) continue;
          if (item.available) availableById.set(item.id, item.available);
          const existing = byId.get(item.id);
          if (existing) {
            existing.available = item.available || "";
            if (!existing.version && item.version) existing.version = item.version;
          } else {
            byId.set(item.id, {
              id: item.id,
              name: item.name || item.id,
              version: item.version || "",
              available: item.available || "",
              publisher: "",
              source: "winget",
              installLocation: "",
              hasUpdate: false,
              updateSupported: false,
              reason: null,
              kind: null,
            });
          }
        }
      } else {
        warnings.push("查询可用更新失败，本次只能显示已安装清单");
      }
    }
  }

  // 注册表兜底：补齐 winget 目录未收录的应用，并给 winget 条目补上发布者/安装位置
  if (settings.includeRegistryOnly) {
    log("info", "正在读取注册表已安装应用…");
    const reg = await readRegistryApps();
    if (!reg.ok) {
      warnings.push(`注册表读取失败：${reg.error || "未知错误"}`);
    } else {
      log("info", `注册表报告 ${reg.apps.length} 个应用`);
      const nameIndex = new Map();
      for (const app of byId.values()) nameIndex.set(normalizeName(app.name), app);
      for (const r of reg.apps) {
        const key = normalizeName(r.name);
        const matched = key ? nameIndex.get(key) : null;
        if (matched) {
          if (!matched.publisher && r.publisher) matched.publisher = r.publisher;
          if (!matched.installLocation && r.location) matched.installLocation = r.location;
          if (!matched.version && r.version) matched.version = r.version;
          continue;
        }
        const id = `reg:${r.key || key || r.name}`;
        if (byId.has(id)) continue;
        byId.set(id, {
          id,
          name: r.name,
          version: r.version || "",
          available: "",
          publisher: r.publisher || "",
          source: "registry",
          installLocation: r.location || "",
          hasUpdate: false,
          updateSupported: false,
          reason: null,
          kind: null,
        });
      }
    }
  }

  // 汇总判定
  const items = [];
  for (const app of byId.values()) {
    if (!settings.includeStoreApps && app.source === "msstore") continue;
    if (!settings.includeRegistryOnly && app.source === "registry") continue;
    const available = app.available || availableById.get(app.id) || "";
    let hasUpdate = false;
    let reason = null;
    let updateSupported = false;

    if (isStoreId(app.id) || app.source === "msstore") {
      reason = "store-managed";
    } else if (!available) {
      reason = app.source === "registry" ? "not-in-catalog" : null;
    } else if (!looksLikeVersion(app.version)) {
      // winget 显示 Unknown：无法确认是否真的更新，按可更新处理但不静默判定
      hasUpdate = true;
      updateSupported = true;
    } else if (isNewer(available, app.version)) {
      hasUpdate = true;
      updateSupported = true;
    } else {
      hasUpdate = false;
    }

    if (hasUpdate && !updateSupported && !reason) reason = "unknown-version";
    items.push({
      ...app,
      available: hasUpdate ? available : "",
      hasUpdate,
      updateSupported,
      reason: hasUpdate && updateSupported ? null : reason,
    });
  }

  items.sort((a, b) => {
    if (a.hasUpdate !== b.hasUpdate) return a.hasUpdate ? -1 : 1;
    if (a.updateSupported !== b.updateSupported) return a.updateSupported ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
  });

  const stats = {
    total: items.length,
    upgradable: items.filter((i) => i.hasUpdate && i.updateSupported).length,
    unsupported: items.filter((i) => i.hasUpdate && !i.updateSupported).length,
  };

  log("success", `扫描完成：${stats.total} 个应用，${stats.upgradable} 个可更新`);

  return {
    winget: wingetInfo,
    scannedAt: Date.now(),
    startedAt,
    stats,
    items,
    warnings,
  };
}

function firstLine(text) {
  const line = String(text || "").trim().split("\n")[0] || "";
  return line.slice(0, 200);
}

/* ------------------------------------------------------------------ *
 * 更新
 * ------------------------------------------------------------------ */

/** 目录快照，用于在 winget download 后找出新增文件。 */
async function snapshotDir(dir) {
  const map = new Map();
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      try {
        const st = await stat(join(dir, e.name));
        map.set(e.name, st.mtimeMs);
      } catch {
        /* 文件在扫描间隙被删掉 */
      }
    }
  } catch {
    /* 目录不存在 */
  }
  return map;
}

/**
 * 下载官网全量安装包。
 * @returns {Promise<{ok:boolean, installer?:string, manifest?:string, info?:object, error?:string}>}
 */
async function downloadInstaller(wingetPath, id, dir, log, signal) {
  await mkdir(dir, { recursive: true });
  const before = await snapshotDir(dir);
  log("info", `下载官网全量安装包：${id}`);
  const res = await runWinget(
    wingetPath,
    [
      "download",
      "--id",
      id,
      "--download-directory",
      dir,
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    { timeoutMs: 30 * 60 * 1000, signal }
  );
  const text = outputText(res);
  if (!res.ok) {
    return { ok: false, error: classifyWingetError(text) || `winget download 退出码 ${res.code}` };
  }

  // 从输出里取落盘路径；取不到就按目录差异找
  let installer = null;
  const m = text.match(/Installer downloaded:\s*(.+?)\s*$/m);
  if (m) {
    const candidate = m[1].trim().replace(/^["']|["']$/g, "");
    installer = isAbsolute(candidate) ? candidate : join(dir, basename(candidate));
  }
  if (!installer) {
    const after = await snapshotDir(dir);
    const fresh = [];
    for (const [name, mtime] of after) {
      if (!before.has(name) || before.get(name) !== mtime) fresh.push(name);
    }
    const pick = fresh.find((n) => INSTALLER_EXT.test(n)) || fresh.find((n) => /\.ya?ml$/i.test(n));
    if (pick) installer = join(dir, pick);
  }
  if (!installer) return { ok: false, error: "下载完成但没找到安装包文件" };

  let manifest = null;
  const manifestGuess = installer.replace(INSTALLER_EXT, ".yaml");
  try {
    const st = await stat(manifestGuess);
    if (st.isFile()) manifest = manifestGuess;
  } catch {
    const after = await snapshotDir(dir);
    const yaml = [...after.keys()].find((n) => /\.ya?ml$/i.test(n) && n.includes(basename(installer).split("_")[0]));
    if (yaml) manifest = join(dir, yaml);
  }

  let info = {};
  if (manifest) {
    try {
      info = parseInstallerManifest(await readFile(manifest, "utf8"));
    } catch {
      info = {};
    }
  }
  return { ok: true, installer, manifest, info };
}

/** 执行安装包（静默）。 */
async function runInstaller(installer, info, log, signal) {
  const ext = String(installer).toLowerCase();
  const isMsi = ext.endsWith(".msi");
  const args = resolveInstallArgs(info, installer);
  const exe = isMsi ? join(process.env.SystemRoot || "C:\\Windows", "System32", "msiexec.exe") : installer;
  const finalArgs = isMsi ? ["/i", installer, ...args] : args;
  log("info", `静默安装：${basename(installer)} ${finalArgs.join(" ")}`.trim());
  const res = await runProcess(exe, finalArgs, { timeoutMs: 60 * 60 * 1000, signal });
  const text = outputText(res);
  if (res.spawnError) return { ok: false, error: res.spawnError, code: null };
  if (res.timedOut) return { ok: false, error: "安装超时（60 分钟）", code: null };
  if (res.code !== 0) {
    // 3010 = 需要重启，属成功
    if (res.code === 3010) return { ok: true, code: res.code, note: "安装完成，需重启生效" };
    return { ok: false, error: firstLine(text) || `安装程序退出码 ${res.code}`, code: res.code };
  }
  return { ok: true, code: 0 };
}

/** 用 winget upgrade 兜底（同样是官网全量包，安装由 winget 执行）。 */
async function wingetUpgradeFallback(wingetPath, id, log, signal) {
  log("warn", `改用 winget upgrade 兜底：${id}`);
  const res = await runWinget(
    wingetPath,
    [
      "upgrade",
      "--id",
      id,
      "--exact",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ],
    { timeoutMs: 60 * 60 * 1000, signal }
  );
  const text = outputText(res);
  if (res.ok) return { ok: true };
  const code = res.code;
  if (code === 3010 || (code >>> 0) === 0x8a15002b) {
    return code === 3010 ? { ok: true, note: "安装完成，需重启生效" } : { ok: false, error: "目录里没有适用的更新" };
  }
  return { ok: false, error: classifyWingetError(text) || `winget upgrade 退出码 ${code}` };
}

/** 安装后复核版本。 */
async function readInstalledVersion(wingetPath, id, signal) {
  if (!wingetPath || id.startsWith("reg:")) return "";
  const res = await runWinget(
    wingetPath,
    ["list", "--id", id, "--exact", "--accept-source-agreements", "--disable-interactivity"],
    { timeoutMs: 60000, signal }
  );
  const rows = parseInstalledList(res.stdout);
  const row = rows.find((r) => r.id.toLowerCase() === id.toLowerCase()) || rows[0];
  return row ? row.version : "";
}

function classifyWingetError(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  if (/hash does not match|哈希不匹配|Installer hash/i.test(raw)) {
    return "官网安装包的哈希与软件目录记录不一致（发布方更新了安装包），可改用 winget upgrade 兜底，或以管理员身份执行 winget settings --enable InstallerHashOverride 后重试";
  }
  if (/DownloadCommandProhibited/i.test(raw)) return "该软件的清单禁止直接下载，只能通过 winget upgrade 安装";
  if (/requires administrator|需要管理员|elevat/i.test(raw)) return "需要管理员权限（会弹出 UAC 确认）";
  if (/No available upgrade found|No newer package/i.test(raw)) return "目录里没有适用的更新";
  if (/not found|找不到|No package found/i.test(raw)) return "软件目录里找不到该包";
  if (/被拒绝访问|Access is denied/i.test(raw)) return "访问被拒绝（可能需要以管理员身份运行）";
  const line = raw.split("\n").map((l) => l.trim()).filter((l) => l && !/^[-=]+$/.test(l)).pop() || "";
  return line.slice(0, 300);
}

/**
 * 串行执行一批更新。
 * @param {object} p
 * @param {string[]} p.ids
 * @param {object} p.settings
 * @param {(level: string, text: string) => void} p.log
 * @param {(patch: object) => void} p.onProgress 进度回调（写进 state.update）
 * @param {AbortSignal} p.signal
 */
export async function runUpdates({ ids, settings, log, onProgress, signal }) {
  const wingetPath = findWinget();
  const dir = resolveDownloadDir(settings);
  const results = [];
  const queue = [...new Set(ids.filter(Boolean))];

  onProgress({ running: true, total: queue.length, done: 0, current: null, results: [], error: null, startedAt: Date.now() });
  log("info", `开始更新 ${queue.length} 个应用`);

  let index = 0;
  for (const id of queue) {
    if (signal.aborted) {
      results.push({ id, ok: false, error: "已取消" });
      log("warn", `已取消：${id}`);
      break;
    }
    index += 1;
    onProgress({ running: true, total: queue.length, done: index - 1, current: id });
    log("info", `（${index}/${queue.length}）开始处理 ${id}`);

    const startedAt = Date.now();
    let entry = { id, ok: false, error: null, installer: null, fromCache: false, note: null, verified: null, durationMs: 0 };

    try {
      if (!wingetPath) {
        entry.error = "未找到 winget，无法下载官网安装包";
      } else {
        const dl = await downloadInstaller(wingetPath, id, dir, log, signal);
        if (!dl.ok) {
          entry.error = dl.error;
        } else if (settings.dryRun) {
          // 演练模式：照常从官网下载全量安装包并落盘，但不执行安装。
          entry.installer = dl.installer;
          entry.ok = true;
          entry.dryRun = true;
          entry.note = "演练模式：已下载官网全量安装包，未执行安装";
          log("warn", `${id}：演练模式，已下载 ${basename(dl.installer)}，跳过安装`);
        } else {
          entry.installer = dl.installer;
          const inst = await runInstaller(dl.installer, dl.info, log, signal);
          if (inst.ok) {
            entry.ok = true;
            entry.note = inst.note || null;
          } else {
            entry.error = inst.error;
          }
        }

        // 下载失败或安装失败 → winget upgrade 兜底（同样是官网全量包）
        if (!entry.ok && !entry.dryRun && settings.hashFallbackUpgrade !== false && !signal.aborted) {
          log("warn", `${id}：${entry.error}，尝试 winget upgrade 兜底`);
          const fb = await wingetUpgradeFallback(wingetPath, id, log, signal);
          if (fb.ok) {
            entry.ok = true;
            entry.error = null;
            entry.note = fb.note || "已通过 winget 安装官网全量包";
          } else {
            entry.error = `${entry.error}；兜底失败：${fb.error}`;
          }
        }
      }

      if (entry.ok) {
        const version = await readInstalledVersion(wingetPath, id, signal);
        if (version) {
          entry.verified = version;
          log("success", `${id} 更新完成，当前版本 ${version}`);
        } else {
          log("success", `${id} 更新完成`);
        }
      } else {
        log("error", `${id} 更新失败：${entry.error}`);
      }
    } catch (err) {
      entry.ok = false;
      entry.error = String((err && err.message) || err);
      log("error", `${id} 更新异常：${entry.error}`);
    }

    entry.durationMs = Date.now() - startedAt;
    if (!settings.keepInstallers && entry.installer) {
      rm(entry.installer, { force: true }).catch(() => {});
    }
    results.push(entry);
    onProgress({ running: true, total: queue.length, done: index, current: null, results });
  }

  const okCount = results.filter((r) => r.ok).length;
  onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
  log(okCount === results.length ? "success" : "warn", `更新结束：成功 ${okCount} / ${results.length}`);
  return results;
}
