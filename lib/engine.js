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
import { existsSync, lstatSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { homedir } from "node:os";

import { runProcess, outputText } from "./proc.js";
import { elevationAvailable, isElevated, runElevated } from "./elevate.js";
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
import { detectEnvironment, describeEnvironment, engineFor, ENGINE_BREW, ENGINE_WINGET } from "./platform.js";

const INSTALLER_EXT = /\.(exe|msi|msix|appx|msixbundle|pkg|dmg)$/i;

/** 当前环境（进程级缓存：同一次运行里平台/架构不会变）。 */
let cachedEnv = null;
export function currentEnvironment() {
  if (!cachedEnv) cachedEnv = detectEnvironment();
  return cachedEnv;
}

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
  const env = currentEnvironment();

  log("info", `运行环境：${describeEnvironment(env)}（引擎：${engineFor(env.family)}）`);

  if (env.family === "macos") {
    return scanMacos({ settings, log, signal, env, startedAt, warnings });
  }
  if (env.family !== "windows") {
    log("warn", `当前系统 ${env.platform} 没有可用的更新引擎，本插件支持 Windows 与 macOS`);
    return {
      env,
      engine: { id: engineFor(env.family), available: false, version: "", path: "" },
      scannedAt: Date.now(),
      startedAt,
      stats: { total: 0, upgradable: 0, unsupported: 0 },
      items: [],
      warnings: [`当前系统 ${env.platform} 暂不支持（本插件面向 Windows 与 macOS）`],
    };
  }

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
    env,
    engine: {
      id: ENGINE_WINGET,
      available: Boolean(wingetInfo.available),
      version: wingetInfo.version || "",
      path: wingetInfo.path || "",
    },
    winget: wingetInfo,
    scannedAt: Date.now(),
    startedAt,
    stats,
    items,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 提权、复核与「自带更新服务」
 * ------------------------------------------------------------------ */

/**
 * winget 报「清单里没有可用安装包」一类错误（本机架构没有对应安装包）。
 * 中文输出是「找不到适用的安装程序」，英文是 “No applicable installer found”。
 *
 * 这类失败必须退回「不限架构」再来一次：虎牙直播（Huya.Huya）的清单里只有
 * 一个不标架构的通用 exe，带上 `--architecture x64` 就永远找不到。
 */
export function isArchNotFoundError(text) {
  const raw = String(text || "");
  if (!raw) return false;
  return /architecture|架构|applicable installer|not applicable|找不到适用|没有适用/i.test(raw);
}

/** 安装器退出码 → 人话。输出为空时兜底；MSI 的真实原因在它自己的日志里。 */
export function explainInstallerExitCode(code, text) {
  const first = firstLine(text);
  if (first) return first;
  const map = {
    1603: "安装程序返回 1603（安装失败：常见原因是权限不足、文件被占用或已装其它版本；MSI 详情见日志）",
    1619: "安装程序返回 1619（安装包无法打开）",
    1620: "安装程序返回 1620（安装包损坏或不可读）",
    1625: "安装程序返回 1625（被系统策略禁止）",
    1638: "安装程序返回 1638（已安装其它版本）",
    1730: "安装程序返回 1730（卸载/安装需要管理员权限）",
  };
  return map[code] || `安装程序退出码 ${code}`;
}

/**
 * 判断一次更新是否真的生效。
 *
 * 只看安装器退出码是不够的：机器级安装包在没有管理员令牌时会**静默退出 0**
 * 却什么都没装（实测 Logitech G HUB 2026.6.981214 → 目标 2026.7.992920，
 * 退出码 0，Program Files 里的文件与 winget 报的版本都没有变化）。
 * 所以拿「安装前版本 / 安装后版本 / 目标版本」三个值判断，判不出来才算失败。
 *
 * @returns {{changed: boolean, reason: string}}
 */
export function evaluateUpdateResult({ before, after, target }) {
  const a = String(after == null ? "" : after).trim();
  const b = String(before == null ? "" : before).trim();
  const t = String(target == null ? "" : target).trim();
  // winget 读不到已装版本（虎牙直播的卸载信息里就没有版本号）→ 无法复核：
  // 既不能判生效也不能判失败，交给调用方按「已安装、未复核」处理。
  if (!looksLikeVersion(a)) {
    return {
      changed: false,
      unverifiable: true,
      reason: a ? `winget 读不到已装版本（显示为 ${a}）` : "安装后读不到版本",
    };
  }
  // 达到或超过目标版本 → 生效
  if (t && !isNewer(t, a)) {
    return { changed: true, reason: `版本已是 ${a}（目标 ${t}）` };
  }
  // 目标版本未知时，只能看它是否真的变新了
  if (b && looksLikeVersion(b) && isNewer(a, b)) {
    return { changed: true, reason: `版本从 ${b} 升到 ${a}` };
  }
  if (t) return { changed: false, reason: `版本没有变化（仍为 ${a}，目标 ${t}）` };
  return { changed: false, reason: `版本没有变化（仍为 ${a}）` };
}

/** 可取消的等待。 */
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal) signal.addEventListener("abort", finish, { once: true });
  });
}

/** 提权跑 winget：winget 自己的安装动作同样需要管理员令牌才能装机器级包。 */
async function runWingetElevated(wingetPath, args, opts = {}) {
  const res = await runElevated(wingetPath, args, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  return {
    ok: res.ok,
    code: res.code,
    stdout: res.stdout || "",
    stderr: "",
    error: res.spawnError ? "spawn" : res.timedOut ? "timeout" : null,
  };
}

/**
 * 本轮的「目标版本」表：复核「到底升没升上去」的依据。
 * 用一次 `winget upgrade --include-unknown` 拿全量（含已装版本为 Unknown 的应用）。
 */
async function fetchUpgradeTargets(wingetPath, ctx, signal) {
  const map = new Map();
  if (!wingetPath) return map;
  try {
    const res = await ctx.runWinget(
      wingetPath,
      ["upgrade", "--include-unknown", "--accept-source-agreements", "--disable-interactivity"],
      { timeoutMs: 240000, signal }
    );
    if (res.ok) {
      for (const row of parseUpgradeList(res.stdout)) {
        const key = String(row.id || "").toLowerCase();
        if (key && row.available) map.set(key, row.available);
      }
    }
  } catch {
    // 拿不到目标版本时退化为「只看版本有没有变化」
  }
  return map;
}

/**
 * 自带更新服务的软件：winget 目录里给的是**企业版**安装包，与本机的消费版
 * 安装技术不匹配，winget 会直接拒绝（0x8A15008E「安装技术与当前安装的版本
 * 不同，请卸载包并安装较新版本」）。这类软件交给它自己的更新服务。
 */
const SELF_UPDATERS = new Map([
  ["microsoft.edge", "edgeupdate"],
  ["microsoft.edgewebview2runtime", "edgeupdate"],
  ["microsoft.edgewebview", "edgeupdate"],
]);

/**
 * 少数软件的更新不由安装包完成，而是由它自己的常驻更新器在**应用启动时**应用
 * （实测 Logitech G HUB：更新包早就下载好躺在 %ProgramData%\LGHUB\next.json 指向的
 * depots 里，安装器 `--silent` 和 winget upgrade 都退出 0 什么都不做，只有启动
 * G HUB 本体后 current.json 才跳到新版本）。
 *
 * 插件承诺「不需要打开被检测的软件」，所以这里只给提示，不替用户启动 app。
 */
const UPDATE_HINTS = new Map([
  [
    "logitech.ghub",
    "G HUB 的更新由它自己的更新器在「启动 G HUB」时应用：安装包与 winget 都可能退出 0 而不生效，手动打开一次 G HUB 即可完成升级（插件不会替你启动软件）",
  ],
  [
    "microsoft.edge",
    "Edge 由 EdgeUpdate 服务维护；该服务不可用时插件会退回安装官网全量包（企业版 MSI，提权执行）",
  ],
]);

/** 这条应用有没有「安装之外的更新方式」提示。 */
export function updateHintFor(id) {
  return UPDATE_HINTS.get(String(id || "").toLowerCase()) || "";
}

/** 定位 Microsoft Edge 自带的更新服务。 */
export function findEdgeUpdate(env = process.env) {
  const roots = [
    env["ProgramFiles(x86)"],
    env.ProgramFiles,
    "C:\\Program Files (x86)",
    "C:\\Program Files",
  ].filter(Boolean);
  for (const root of roots) {
    const file = join(root, "Microsoft", "EdgeUpdate", "MicrosoftEdgeUpdate.exe");
    try {
      if (existsSync(file)) return file;
    } catch {
      // 受保护目录读不到时继续找下一个
    }
  }
  return null;
}

/**
 * 触发自带更新服务（目前只有 Edge）。
 * 它的退出码不代表版本已经就位（只是把任务交给服务），所以交给 verifyInstalled 轮询确认。
 */
async function runSelfUpdater(kind, log, signal, ctx) {
  if (kind !== "edgeupdate") return { ok: false, error: "未知的自带更新方式" };
  const exe = findEdgeUpdate();
  if (!exe) return { ok: false, error: "未找到 MicrosoftEdgeUpdate.exe（Edge 自带更新服务）" };
  log("info", "改用 Edge 自带更新服务（winget 目录里是企业版 MSI，与本机消费版 Edge 的安装技术不匹配）");
  const res = await ctx.run(exe, ["/ua"], { timeoutMs: 30 * 60 * 1000, signal });
  if (res.spawnError) return { ok: false, error: res.spawnError };
  if (res.timedOut) return { ok: false, error: "Edge 自带更新服务超时" };
  return { ok: true, note: "已交给 Microsoft Edge 更新服务，等待版本就位" };
}

/**
 * 安装后复核：读已装版本，与目标/安装前版本比对，必要时轮询等待
 * （Edge 这类自带更新服务不是同步生效的）。
 */
async function verifyInstalled({ wingetPath, id, before, target, signal, log, attempts = 1, delayMs = 15000 }) {
  let version = "";
  let verdict = { changed: false, reason: "尚未复核" };
  const rounds = Math.max(1, attempts);
  for (let i = 0; i < rounds; i += 1) {
    if (signal && signal.aborted) break;
    version = await readInstalledVersion(wingetPath, id, signal);
    verdict = evaluateUpdateResult({ before, after: version, target });
    if (verdict.changed || verdict.unverifiable) return { ...verdict, version };
    if (i + 1 < rounds) {
      if (log && i === 0) {
        log("info", `${id}：暂未读到新版本（${version || "未知"}），继续等待…`);
      }
      await delay(delayMs, signal);
    }
  }
  return { ...verdict, version };
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
async function downloadInstaller(wingetPath, id, dir, log, signal, opts = {}) {
  await mkdir(dir, { recursive: true });
  const before = await snapshotDir(dir);
  const env = opts.env || currentEnvironment();
  const archFlag = opts.matchArch === false ? "" : env.wingetArch || "";
  if (archFlag) log("info", `按本机架构选择安装包：${env.archLabel}（--architecture ${archFlag}）`);
  else log("info", `未指定架构，交给 winget 自动匹配（${env.archLabel}）`);
  log("info", `下载官网全量安装包：${id}`);
  const args = [
    "download",
    "--id",
    id,
    "--download-directory",
    dir,
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--disable-interactivity",
  ];
  if (archFlag) args.push("--architecture", archFlag);
  const res = await runWinget(wingetPath, args, { timeoutMs: 30 * 60 * 1000, signal });
  const text = outputText(res);
  if (!res.ok) {
    const err = classifyWingetError(text) || `winget download 退出码 ${res.code}`;
    // 指定架构失败（清单里没有这一架构的安装包）时，退回让 winget 自己挑，并如实记录
    if (archFlag && isArchNotFoundError(text)) {
      log("warn", `${id}：清单里没有 ${archFlag} 架构的安装包，改为自动匹配`);
      return downloadInstaller(wingetPath, id, dir, log, signal, { ...opts, matchArch: false });
    }
    return { ok: false, error: err };
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
async function runInstaller(installer, info, log, signal, ctx = {}) {
  const ext = String(installer).toLowerCase();
  const isMsi = ext.endsWith(".msi");
  const run = ctx.run || runProcess;
  const args = resolveInstallArgs(info, installer);
  const exe = isMsi ? join(process.env.SystemRoot || "C:\\Windows", "System32", "msiexec.exe") : installer;
  // 安装失败时唯一能说明原因的现场就是 MSI 自己的日志（Error 1925 / 1603 …），
  // 所以顺手开一份；日志路径由调用方提供一个可写目录（临时目录里没有空格）。
  const msiLog = isMsi && ctx.scratchDir
    ? join(ctx.scratchDir, `${basename(installer).replace(/[^\w.-]+/g, "_")}.msi.log`)
    : "";
  const finalArgs = isMsi ? ["/i", installer, ...args, ...(msiLog ? ["/l*v", msiLog] : [])] : args;
  log("info", `静默安装：${basename(installer)} ${finalArgs.join(" ")}`.trim());
  if (ctx.elevated) log("info", "安装步骤在管理员上下文中执行（自动提权）");
  const res = await run(exe, finalArgs, { timeoutMs: 60 * 60 * 1000, signal });
  const text = outputText(res);
  if (res.spawnError) return { ok: false, error: res.spawnError, code: null };
  if (res.timedOut) return { ok: false, error: "安装超时（60 分钟）", code: null };
  if (res.code !== 0) {
    // 3010 = 需要重启，属成功
    if (res.code === 3010) return { ok: true, code: res.code, note: "安装完成，需重启生效" };
    const detail = msiLog && existsSync(msiLog) ? `；MSI 日志：${msiLog}` : "";
    return { ok: false, error: explainInstallerExitCode(res.code, text) + detail, code: res.code };
  }
  return { ok: true, code: 0 };
}

/**
 * 用 winget upgrade 兜底（同样是官网全量包，安装由 winget 执行）。
 *
 * 两道修正：
 *  1) 带上 `--include-unknown`：已装版本被 winget 读成 Unknown 的应用（虎牙直播）
 *     不带它就直接「目录里没有适用的更新」；
 *  2) 带架构过滤而失败时退回不限架构再试一次（清单里只有通用 exe 的应用）。
 */
async function wingetUpgradeFallback(wingetPath, id, log, signal, opts = {}) {
  const env = opts.env || currentEnvironment();
  const run = opts.run || runWinget;
  const archFlag = opts.matchArch === false ? "" : env.wingetArch || "";

  const attempt = async (flag) => {
    log("warn", `改用 winget upgrade 兜底：${id}（${flag ? "--architecture " + flag : "不限架构"}）`);
    const args = [
      "upgrade",
      "--id",
      id,
      "--exact",
      "--silent",
      "--include-unknown",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    if (flag) args.push("--architecture", flag);
    const res = await run(wingetPath, args, { timeoutMs: 60 * 60 * 1000, signal });
    return { res, text: outputText(res) };
  };

  let { res, text } = await attempt(archFlag);
  if (!res.ok && archFlag && isArchNotFoundError(text)) {
    // 清单里没有本机架构的安装包 → 交回 winget 自己挑
    ({ res, text } = await attempt(""));
  }
  if (res.ok) return { ok: true };
  const code = res.code;
  if (code === 3010) return { ok: true, note: "安装完成，需重启生效" };
  if ((code >>> 0) === 0x8a15002b) return { ok: false, error: "目录里没有适用的更新" };
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
export async function runUpdates({ ids, settings, log, onProgress, signal, plan = [] }) {
  const env = currentEnvironment();
  const matchArch = settings.matchSystemArch !== false;

  if (env.family === "macos") {
    return runMacosUpdates({ ids, settings, log, onProgress, signal, env });
  }

  const wingetPath = findWinget();
  const dir = resolveDownloadDir(settings);
  const results = [];
  const queue = [...new Set(ids.filter(Boolean))];
  const planById = new Map(
    (Array.isArray(plan) ? plan : [])
      .map((item) => [String((item && item.id) || "").toLowerCase(), item])
      .filter(([key]) => key)
  );

  // 提权：机器级安装（MSI / 写 Program Files）需要管理员令牌，而进程令牌创建后无法
  // 原地提升，所以安装类命令交给提权副本执行（lib/elevate.js）。读版本、下载都不需要。
  const autoElevate = settings.autoElevate !== false;
  const elevatedNow = env.family === "windows" ? await isElevated({ signal }) : true;
  const useElevation = env.family === "windows" && autoElevate && !elevatedNow && elevationAvailable();
  const ctx = {
    run: (exe, args, o) => (useElevation ? runElevated(exe, args, o) : runProcess(exe, args, o)),
    runWinget: (exe, args, o) => (useElevation ? runWingetElevated(exe, args, o) : runWinget(exe, args, o)),
    elevated: useElevation,
    scratchDir: dir,
  };

  onProgress({ running: true, total: queue.length, done: 0, current: null, results: [], error: null, startedAt: Date.now() });
  log("info", `开始更新 ${queue.length} 个应用（${describeEnvironment(env)}，按架构匹配：${matchArch ? "是" : "否"}）`);
  if (env.family === "windows") {
    if (elevatedNow) log("info", "当前进程已具备管理员权限");
    else if (useElevation) log("info", "当前进程没有管理员权限：需要管理员的安装步骤会自动提权执行");
    else if (autoElevate) log("warn", "当前进程没有管理员权限，且找不到 powershell.exe：无法自动提权，机器级安装会失败");
    else log("warn", "当前进程没有管理员权限，且已关闭「自动提权安装」：机器级安装会失败（MSI 报 1925、安装器静默退出 0）");
  }

  // 「目标版本」表：安装后复核「到底升没升上去」的依据
  const targets = await fetchUpgradeTargets(wingetPath, ctx, signal);

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
    const target = targets.get(id.toLowerCase()) || "";
    const before = (planById.get(id.toLowerCase()) || {}).version || "";
    let entry = { id, ok: false, error: null, installer: null, fromCache: false, note: null, verified: null, durationMs: 0 };

    try {
      const selfUpdater = SELF_UPDATERS.get(id.toLowerCase());
      let settled = false;

      if (!wingetPath) {
        entry.error = "未找到 winget，无法下载官网安装包";
      } else if (selfUpdater && settings.useSelfUpdater !== false && !settings.dryRun) {
        // 先让软件自带的更新服务试一次；没生效就退回官网全量安装包。
        // Edge 的实测：EdgeUpdate 服务坏掉时 /ua 直接 0x80070002，而 winget 目录里的
        // 官方安装包（企业版 MSI）在提权下能正常把 Edge 装到目标版本 —— winget 自己
        // 拒绝执行只是因为「安装技术不同」这条策略。
        entry.selfUpdater = selfUpdater;
        const r = await runSelfUpdater(selfUpdater, log, signal, ctx);
        entry.note = r.note || null;
        if (r.ok) {
          const check = await verifyInstalled({
            wingetPath,
            id,
            before,
            target,
            signal,
            log,
            attempts: 12,
            delayMs: 15000,
          });
          entry.verified = check.version || null;
          if (check.changed || check.unverifiable) {
            settled = true;
            entry.ok = true;
            entry.note = `${entry.note ? entry.note + "；" : ""}${check.changed ? "复核通过：" : "未复核："}${check.reason}`;
            log(check.changed ? "success" : "warn", `${id} ${check.changed ? "更新完成" : "已安装（未复核）"}，${check.reason}`);
          } else {
            log("warn", `${id}：自带更新服务没有生效（${check.reason}），改用官网全量安装包`);
          }
        } else {
          log("warn", `${id}：${r.error}，改用官网全量安装包`);
        }
      }

      if (settled) {
        // 自带更新服务已经完成并复核过
      } else if (entry.error || !wingetPath || signal.aborted) {
        log("error", `${id} 更新失败：${entry.error}`);
      } else {
        const dl = await downloadInstaller(wingetPath, id, dir, log, signal, { env, matchArch });
        if (!dl.ok) {
          entry.error = dl.error;
        } else if (settings.dryRun) {
          // 演练模式：照常从官网下载全量安装包并落盘，但不执行安装。
          entry.installer = dl.installer;
          entry.manifest = dl.manifest || null;
          entry.ok = true;
          entry.dryRun = true;
          entry.note = "演练模式：已下载官网全量安装包，未执行安装";
          log("warn", `${id}：演练模式，已下载 ${basename(dl.installer)}，跳过安装`);
        } else {
          entry.installer = dl.installer;
          entry.manifest = dl.manifest || null;
          const inst = await runInstaller(dl.installer, dl.info, log, signal, ctx);
          if (inst.ok) {
            entry.ok = true;
            entry.installOk = true;
            entry.note = inst.note || null;
          } else {
            entry.error = inst.error;
          }
        }

        // 下载失败或安装失败 → winget upgrade 兜底（同样是官网全量包）
        if (!entry.ok && !entry.dryRun && settings.hashFallbackUpgrade !== false && !signal.aborted) {
          log("warn", `${id}：${entry.error}，尝试 winget upgrade 兜底`);
          const fb = await wingetUpgradeFallback(wingetPath, id, log, signal, { env, matchArch, run: ctx.runWinget });
          if (fb.ok) {
            entry.ok = true;
            entry.installOk = true;
            entry.error = null;
            entry.note = fb.note || "已通过 winget 安装官网全量包";
          } else {
            entry.error = `${entry.error}；兜底失败：${fb.error}`;
          }
        }

        // 复核：退出码 0 ≠ 装上了。机器级安装包在没有管理员令牌时会静默退出 0 却什么都没装。
        if (entry.ok && !entry.dryRun && !signal.aborted) {
          const check = await verifyInstalled({
            wingetPath,
            id,
            before,
            target,
            signal,
            log,
            attempts: 4,
            delayMs: 15000,
          });
          entry.verified = check.version || null;
          if (check.changed) {
            entry.note = `${entry.note ? entry.note + "；" : ""}复核通过：${check.reason}`;
            log("success", `${id} 更新完成，${check.reason}`);
          } else if (check.unverifiable) {
            // 读不到已装版本（卸载信息里没有版本号）：按「已安装、未复核」处理，不能算失败
            entry.note = `${entry.note ? entry.note + "；" : ""}未复核：${check.reason}`;
            log("warn", `${id} 已安装，但无法复核版本：${check.reason}`);
          } else {
            entry.ok = false;
            const hint = updateHintFor(id);
            entry.error = `安装报告成功，但没有生效：${check.reason}${hint ? `。${hint}` : ""}`;
            log("error", `${id} 更新失败：${entry.error}`);
          }
        } else if (entry.ok && entry.dryRun) {
          // 演练模式没有真正安装，不做版本复核
        } else if (entry.ok) {
          log("success", `${id} 更新完成`);
        } else {
          log("error", `${id} 更新失败：${entry.error}`);
        }
      }
    } catch (err) {
      entry.ok = false;
      entry.error = String((err && err.message) || err);
      log("error", `${id} 更新异常：${entry.error}`);
    }

    entry.durationMs = Date.now() - startedAt;
    if (!settings.keepInstallers && entry.installer) {
      rm(entry.installer, { force: true }).catch(() => {});
      // winget download 会同时落一份 .yaml 清单，别让它留在下载目录里
      if (entry.manifest) rm(entry.manifest, { force: true }).catch(() => {});
    }
    results.push(entry);
    onProgress({ running: true, total: queue.length, done: index, current: null, results });
  }

  const okCount = results.filter((r) => r.ok).length;
  onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
  log(okCount === results.length ? "success" : "warn", `更新结束：成功 ${okCount} / ${results.length}`);
  return results;
}

/* ------------------------------------------------------------------ *
 * macOS：Homebrew cask 引擎
 *
 * Homebrew 自己会按当前 Mac 的架构取对应的 cask（Apple Silicon 走 arm64，
 * Intel 走 x86_64），所以这里不需要再拼下载地址；我们只负责把「已装版本 →
 * 可升级版本」读出来，并在用户确认后执行 upgrade / fetch。
 * ------------------------------------------------------------------ */

export function findBrew(env = process.env) {
  const candidates = [];
  if (env.HOMEBREW_PREFIX) candidates.push(join(env.HOMEBREW_PREFIX, "bin", "brew"));
  candidates.push("/opt/homebrew/bin/brew", "/usr/local/bin/brew", "/home/linuxbrew/.linuxbrew/bin/brew");
  const pathValue = env.PATH || env.Path || "";
  for (const entry of String(pathValue).split(":")) {
    const dir = entry.trim();
    if (dir.startsWith("/")) candidates.push(join(dir, "brew"));
  }
  for (const file of candidates) {
    try {
      if (lstatSync(file).isFile()) return file;
    } catch {
      /* 不可访问的候选路径 */
    }
  }
  return null;
}

async function runBrew(brewPath, args, opts = {}) {
  return runProcess(brewPath, args, {
    timeoutMs: opts.timeoutMs || 20 * 60 * 1000,
    signal: opts.signal,
  });
}

/** `brew list --cask --versions` → Map(token → version)。 */
export function parseBrewCaskVersions(text) {
  const out = new Map();
  for (const line of String(text || "").split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    out.set(parts[0], parts.slice(1).join(" "));
  }
  return out;
}

/** `brew outdated --json=v2 --cask --greedy` → Map(token → 可用版本)。 */
export function parseBrewOutdated(text) {
  const out = new Map();
  let json = null;
  try {
    json = JSON.parse(String(text || "").trim() || "{}");
  } catch {
    return out;
  }
  const casks = Array.isArray(json && json.casks) ? json.casks : [];
  for (const c of casks) {
    if (!c || !c.name) continue;
    const current = c.current_version || (Array.isArray(c.current_versions) ? c.current_versions[0] : "") || "";
    out.set(String(c.name), String(current));
  }
  return out;
}

async function scanMacos({ settings, log, signal, env, startedAt, warnings }) {
  const brewPath = findBrew();
  const items = [];

  if (!brewPath) {
    warnings.push("未找到 Homebrew，macOS 上无法检测/更新应用（安装 Homebrew 后重新检测即可）");
    log("warn", warnings[warnings.length - 1]);
    return {
      env,
      engine: { id: ENGINE_BREW, available: false, version: "", path: "" },
      scannedAt: Date.now(),
      startedAt,
      stats: { total: 0, upgradable: 0, unsupported: 0 },
      items,
      warnings,
    };
  }

  const verRes = await runBrew(brewPath, ["--version"], { timeoutMs: 30000 });
  const brewVersion = firstLine(outputText(verRes)).replace(/^Homebrew\s+/i, "");
  log("info", `Homebrew ${brewVersion}（${brewPath}）· ${env.archLabel}`);

  const listRes = await runBrew(brewPath, ["list", "--cask", "--versions"], { signal });
  const installed = parseBrewCaskVersions(listRes.stdout);
  log("info", `Homebrew 报告 ${installed.size} 个已安装 cask 应用`);

  const outRes = await runBrew(brewPath, ["outdated", "--json=v2", "--cask", "--greedy"], { signal });
  const outdated = parseBrewOutdated(outRes.stdout);
  log("info", `其中 ${outdated.size} 个有新版本`);

  for (const [token, version] of installed) {
    const available = outdated.get(token) || "";
    const hasUpdate = Boolean(available) && (!version || isNewer(available, version));
    items.push({
      id: `brew:${token}`,
      name: token,
      version: version || "",
      available: hasUpdate ? available : "",
      publisher: "Homebrew cask",
      source: "homebrew",
      installLocation: "",
      hasUpdate,
      updateSupported: hasUpdate,
      reason: hasUpdate ? null : null,
      kind: "cask",
    });
  }

  // 有更新但没在「已安装」列表里露出的（例如 --greedy 强制升级项）也补进来
  for (const [token, available] of outdated) {
    if (installed.has(token)) continue;
    items.push({
      id: `brew:${token}`,
      name: token,
      version: "",
      available,
      publisher: "Homebrew cask",
      source: "homebrew",
      installLocation: "",
      hasUpdate: true,
      updateSupported: true,
      reason: null,
      kind: "cask",
    });
  }

  items.sort((a, b) => {
    if (a.hasUpdate !== b.hasUpdate) return a.hasUpdate ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });

  const stats = {
    total: items.length,
    upgradable: items.filter((i) => i.hasUpdate).length,
    unsupported: 0,
  };
  log("success", `扫描完成：${stats.total} 个应用，${stats.upgradable} 个可更新`);
  if (settings.includeStoreApps) {
    warnings.push("macOS 的应用商店（App Store）应用不在 Homebrew 覆盖范围内，本插件不会更新它们");
  }

  return {
    env,
    engine: { id: ENGINE_BREW, available: true, version: brewVersion, path: brewPath },
    scannedAt: Date.now(),
    startedAt,
    stats,
    items,
    warnings,
  };
}

async function runMacosUpdates({ ids, settings, log, onProgress, signal, env }) {
  const brewPath = findBrew();
  const results = [];
  const queue = [...new Set((ids || []).filter(Boolean))];

  onProgress({ running: true, total: queue.length, done: 0, current: null, results: [], error: null, startedAt: Date.now() });
  log("info", `开始更新 ${queue.length} 个应用（${describeEnvironment(env)}，引擎：Homebrew）`);

  if (!brewPath) {
    for (const id of queue) {
      results.push({ id, ok: false, error: "未找到 Homebrew，无法更新；请先安装 Homebrew" });
      log("error", `${id} 更新失败：未找到 Homebrew`);
    }
    onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
    return results;
  }

  let index = 0;
  for (const rawId of queue) {
    if (signal.aborted) {
      results.push({ id: rawId, ok: false, error: "已取消" });
      log("warn", `已取消：${rawId}`);
      break;
    }
    index += 1;
    const token = String(rawId).replace(/^brew:/, "");
    onProgress({ running: true, total: queue.length, done: index - 1, current: token });
    log("info", `（${index}/${queue.length}）开始处理 ${token}`);

    const startedAt = Date.now();
    const entry = { id: rawId, ok: false, error: null, installer: null, note: null, verified: null, durationMs: 0 };
    try {
      if (settings.dryRun) {
        // 演练模式：只下载该 cask 对应的安装包（Homebrew 按本机架构取），不安装
        log("warn", `${token}：演练模式，只下载安装包不安装`);
        const fetchRes = await runBrew(brewPath, ["fetch", "--cask", token], { signal, timeoutMs: 60 * 60 * 1000 });
        if (fetchRes.ok) {
          entry.ok = true;
          entry.dryRun = true;
          entry.note = "演练模式：已下载该应用对应的安装包，未安装";
        } else {
          entry.error = firstLine(outputText(fetchRes)) || `brew fetch 退出码 ${fetchRes.code}`;
        }
      } else {
        log("info", `brew upgrade --cask ${token}`);
        const upRes = await runBrew(brewPath, ["upgrade", "--cask", token], { signal, timeoutMs: 2 * 60 * 60 * 1000 });
        if (upRes.ok) {
          entry.ok = true;
        } else {
          entry.error = firstLine(outputText(upRes)) || `brew upgrade 退出码 ${upRes.code}`;
        }
      }

      if (entry.ok) {
        const listRes = await runBrew(brewPath, ["list", "--cask", "--versions", token], { signal, timeoutMs: 60000 });
        const now = parseBrewCaskVersions(listRes.stdout).get(token) || "";
        if (now) {
          entry.verified = now;
          log("success", `${token} 更新完成，当前版本 ${now}`);
        } else {
          log("success", `${token} 更新完成`);
        }
      } else {
        log("error", `${token} 更新失败：${entry.error}`);
      }
    } catch (err) {
      entry.ok = false;
      entry.error = String((err && err.message) || err);
      log("error", `${token} 更新异常：${entry.error}`);
    }

    entry.durationMs = Date.now() - startedAt;
    results.push(entry);
    onProgress({ running: true, total: queue.length, done: index, current: null, results });
  }

  const okCount = results.filter((r) => r.ok).length;
  onProgress({ running: false, total: queue.length, done: results.length, current: null, results, finishedAt: Date.now(), error: null });
  log(okCount === results.length ? "success" : "warn", `更新结束：成功 ${okCount} / ${results.length}`);
  return results;
}
