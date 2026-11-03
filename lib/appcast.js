/**
 * 「应用自带更新源」查询：非 Homebrew 管理（拖 DMG / 手动安装）的应用，
 * 不靠 Homebrew 也能知道**官网最新版本是多少**。
 *
 * 为什么需要这个模块：
 *   1.3.8 的 macOS 侧只用 Homebrew cask 目录来算「可升级到」，而 `available`
 *   只在 `managed === true` 时才会被赋值。本机 `brew list --cask` 是空的（0 个 cask），
 *   于是 110 个应用里没有一个是「Homebrew 管理」，全部落到「不可判断」，
 *   「可升级到」一列恒为 `—`：**明明目录里已经知道 16 个应用有新版本，界面却说不知道**。
 *
 * macOS 应用自己就带着更新源，读到它就能只读地判断「有没有新版」：
 *   1. **Sparkle**：Info.plist 的 `SUFeedURL` 指向 appcast.xml，里面
 *      `<sparkle:shortVersionString>` 就是官网最新版本。原生 Mac 应用的主流方案。
 *   2. **Electron**：`Contents/Resources/app-update.yml` 声明 `url` 与 `channel`，
 *      更新清单是 `<channel>-mac.yml`（无 channel 时是 `latest-mac.yml`），顶层 `version:`。
 *
 * 边界（很重要）：这里**只读**，不下载、不安装、不执行被检测应用。
 * 「查到有新版」与「本插件能一键更新」是两件事 —— 非 Homebrew 应用即使查到新版，
 * 也仍然只能由用户收编进 Homebrew，或去应用内 / 官网升级。绝不因为查到版本就
 * 把它标成可一键更新。
 *
 * 所有命令都是绝对路径 + 参数数组，不经 shell；单个源失败只影响它自己。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runProcess } from "./proc.js";
import { isNewer, looksLikeVersion } from "./version.js";

/** 单次抓取超时：一条慢线路不该把整次扫描拖住。 */
const FETCH_TIMEOUT_S = 15;
const FETCH_TIMEOUT_MS = (FETCH_TIMEOUT_S + 10) * 1000;
/** 并发上限：应用可能装了几十个，别一次开几十个 curl。 */
const CONCURRENCY = 7;

/* ------------------------------------------------------------------ *
 * 纯解析函数（无 IO，便于单测）
 * ------------------------------------------------------------------ */

/**
 * 从 `app-update.yml` 读出 generic provider 的地址与 channel。
 *
 * 只支持本文件里真实存在的极简 YAML（`key: value` 顶格）：这个文件由 electron-builder
 * 生成，形状固定，不值得为它引入 YAML 解析器。
 *
 * @returns {{url:string, channel:string}|null}
 */
export function parseAppUpdateYml(text) {
  const src = String(text || "");
  if (!src.trim()) return null;
  const pick = (key) => {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, "m").exec(src);
    if (!m) return "";
    return m[1].trim().replace(/^['"]|['"]$/g, "");
  };
  const provider = pick("provider").toLowerCase();
  const url = pick("url");
  const channel = pick("channel");
  // 只认 generic（或未声明 provider 但给了 url）：github/s3 之类要另一套路径拼接，
  // 猜错会去请求一个不存在的地址，还不如老实说「不知道」。
  const isGeneric = !provider || provider === "generic";
  if (!isGeneric || !/^https?:\/\//i.test(url)) return null;
  return { url: url.endsWith("/") ? url : `${url}/`, channel };
}

/**
 * Electron 更新清单的文件名：有 channel 用 `<channel>-mac.yml`，否则 `latest-mac.yml`。
 * 这是 electron-updater 在 generic provider 上的既定规则。
 */
export function electronFeedName(channel) {
  const c = String(channel || "").trim();
  return c ? `${c}-mac.yml` : "latest-mac.yml";
}

/**
 * 从 electron 更新清单里读版本号（顶层 `version:`）。
 * @returns {string} 版本串；读不出来返回 ""
 */
export function parseElectronFeed(text) {
  const m = /^version\s*:\s*(.+)$/m.exec(String(text || ""));
  if (!m) return "";
  const v = m[1].trim().replace(/^['"]|['"]$/g, "");
  return looksLikeVersion(v) ? v : "";
}

/**
 * 从 Sparkle appcast.xml 里取出所有「正式通道」的版本串。
 *
 * 为什么不用 XML 解析器：appcast 只有一层 `<item>`，而这里要的是「最大版本」，
 * 用正则在 `<item>` 块内取字段足够可靠，还省掉一个依赖。字段优先级：
 *   `sparkle:shortVersionString`（面向用户的版本，如 1.5.0）
 *   → `<title>`（老版本 Sparkle 只写标题）
 * `<sparkle:version>` 是构建号（如 180），不能当版本比较。
 *
 * 带 `<sparkle:channel>` 的 item 是灰度/测试通道，只有整个 appcast 全是带通道的
 * item 时才退而使用它们，避免把 beta 当成正式版。
 */
export function parseSparkleVersions(xml) {
  const src = String(xml || "");
  const stable = [];
  const channeled = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(src)) !== null) {
    const body = m[1];
    const short = /<sparkle:shortVersionString>\s*([^<]*?)\s*<\/sparkle:shortVersionString>/i.exec(body);
    const title = /<title>\s*([^<]*?)\s*<\/title>/i.exec(body);
    const raw = (short && short[1]) || (title && title[1]) || "";
    if (!looksLikeVersion(raw)) continue;
    const hasChannel = /<sparkle:channel>\s*[^<\s]/.test(body);
    (hasChannel ? channeled : stable).push(String(raw).trim());
  }
  if (stable.length) return stable;
  return channeled;
}

/** 在若干版本串里挑出最大的那个；没有可比版本时返回 ""。 */
export function maxVersion(list) {
  let best = "";
  for (const v of Array.isArray(list) ? list : []) {
    if (!looksLikeVersion(v)) continue;
    if (!best || isNewer(v, best)) best = String(v);
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * 读取应用自带的更新源配置
 * ------------------------------------------------------------------ */

/**
 * 读一个 `.app` 自带的更新源（只读文件，不发请求）。
 *
 * @param {string} appPath 形如 /Applications/IINA.app
 * @param {{ plist?: (p:string) => Promise<string>, readFileImpl?: typeof readFile }} [deps]
 *        plist 注入点：默认用 `plutil -extract SUFeedURL raw`（能读二进制 plist）
 * @returns {Promise<{kind:"sparkle", url:string}|{kind:"electron", url:string, channel:string}|null>}
 */
export async function readUpdateSource(appPath, deps = {}) {
  const read = deps.readFileImpl || readFile;
  const plistValue =
    deps.plist ||
    (async (path) => {
      const res = await runProcess("/usr/bin/plutil", ["-extract", "SUFeedURL", "raw", "-o", "-", path], {
        timeoutMs: 10000,
      });
      return res.ok ? res.stdout.trim() : "";
    });

  // Electron 先看：app-update.yml 是明文的，比 plutil 便宜，而且确定性最高。
  try {
    const yml = await read(join(appPath, "Contents", "Resources", "app-update.yml"), "utf8");
    const parsed = parseAppUpdateYml(yml);
    if (parsed) return { kind: "electron", url: parsed.url, channel: parsed.channel };
  } catch {
    /* 不是 Electron 应用，正常 */
  }

  try {
    const url = String(await plistValue(join(appPath, "Contents", "Info.plist")) || "").trim();
    // 空串是真实存在的（i4Tools 把 SUFeedURL 写成 ""），不能当有源
    if (/^https?:\/\//i.test(url)) return { kind: "sparkle", url };
  } catch {
    /* 读不到 plist 就当作没有更新源 */
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * 抓取 + 解析
 * ------------------------------------------------------------------ */

/**
 * 抓一个 URL 的文本（curl 绝对路径，不经 shell）。
 * @returns {Promise<string|null>} 失败返回 null，不抛
 */
export async function fetchText(url, { fetchImpl, timeoutMs, signal } = {}) {
  if (fetchImpl) {
    try {
      const text = await fetchImpl(url);
      return typeof text === "string" && text ? text : null;
    } catch {
      return null;
    }
  }
  const res = await runProcess(
    "/usr/bin/curl",
    ["-fsSL", "--max-time", String(FETCH_TIMEOUT_S), "-H", "Accept: */*", url],
    { timeoutMs: timeoutMs || FETCH_TIMEOUT_MS, signal }
  );
  if (!res.ok || !res.stdout) return null;
  return res.stdout;
}

/**
 * 查询单个应用的官网最新版本。
 * @returns {Promise<string>} 版本串；查不到返回 ""
 */
export async function fetchLatestFromSource(source, opts = {}) {
  if (!source || !source.url) return "";
  if (source.kind === "sparkle") {
    const xml = await fetchText(source.url, opts);
    return xml ? maxVersion(parseSparkleVersions(xml)) : "";
  }
  if (source.kind === "electron") {
    const url = `${source.url}${electronFeedName(source.channel)}`;
    const text = await fetchText(url, opts);
    return text ? parseElectronFeed(text) : "";
  }
  return "";
}

/**
 * 批量查询「应用自带更新源」的最新版本。
 *
 * @param {Array<{path:string, key:string}>} targets 需要查询的应用（调用方已筛掉
 *        系统组件 / App Store / 已能通过 cask 目录判断的应用）
 * @param {object} [opts]
 * @param {(appPath:string, deps:object)=>Promise<any>} [opts.readSourceImpl]
 * @param {(source:object, o:object)=>Promise<string>} [opts.fetchLatestImpl]
 * @param {(s:string)=>void} [opts.log]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Map<string,{version:string, via:string}>>} key（调用方给的标识）→ 结果
 */
export async function checkAppUpdateSources(targets, opts = {}) {
  const list = Array.isArray(targets) ? targets.filter((t) => t && t.path && t.key) : [];
  const out = new Map();
  if (!list.length) return out;

  const readSource = opts.readSourceImpl || readUpdateSource;
  const fetchLatest = opts.fetchLatestImpl || fetchLatestFromSource;
  const log = typeof opts.log === "function" ? opts.log : null;

  let cursor = 0;
  const worker = async () => {
    while (cursor < list.length) {
      if (opts.signal && opts.signal.aborted) return;
      const target = list[cursor];
      cursor += 1;
      try {
        const source = await readSource(target.path, {});
        if (!source) continue;
        const version = await fetchLatest(source, { signal: opts.signal });
        if (version && looksLikeVersion(version)) {
          out.set(target.key, { version, via: source.kind });
        }
      } catch {
        /* 单个应用的更新源读不到，不影响其它应用，也不该中断扫描 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));
  if (log) log("info", `已查询 ${out.size}/${list.length} 个非 Homebrew 应用的官网更新源`);
  return out;
}

export { FETCH_TIMEOUT_S, CONCURRENCY };
