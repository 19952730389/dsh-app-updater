/**
 * macOS 应用清单：把「本机装了哪些应用」真正列出来。
 *
 * 为什么需要这个模块：1.3.x 的 macOS 扫描只读了 `brew list --cask`，也就是
 * **只有通过 Homebrew 装过的应用才会出现在列表里**。一台正常使用的 Mac 上，
 * 绝大多数应用是拖 DMG 装的，于是 `brew list --cask` 返回空 → 界面显示
 * 「未检测到任何已安装应用」。这不是「没有应用」，而是**没有枚举应用**。
 *
 * 现在的做法：
 *  1. 枚举标准应用目录里的 `.app`（/Applications、/System/Applications 及其
 *     Utilities 子目录、~/Applications），从每个 bundle 的 Info.plist 读版本；
 *  2. 用 Homebrew 的 cask 目录（formulae.brew.sh，缓存一天）把 `.app` 反向匹配到
 *     cask token，从而知道**官网最新版本**；
 *  3. 只有「确实由 Homebrew 管理」的应用才标记为可一键更新 —— 其余应用如实列出，
 *     但标注为不可由本插件更新，绝不假装能更新。
 *
 * 这里只做「读」，不改动任何东西；所有命令都是绝对路径 + 参数数组，不经 shell。
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { runProcess } from "./proc.js";
import { dataDir } from "./state.js";
import { isNewer, looksLikeVersion } from "./version.js";

/** macOS 放应用的标准目录（约定：这些目录第一层就是 `.app`）。 */
export function applicationDirs(home = homedir()) {
  // 这些是 macOS 的 POSIX 路径，用字符串拼接而不是 path.join：
  // join 在 Windows 上会产出反斜杠，跨平台跑单测时就对不上了。
  const h = String(home || "").replace(/\/+$/, "");
  return [
    "/Applications",
    "/Applications/Utilities",
    "/System/Applications",
    "/System/Applications/Utilities",
    `${h}/Applications`,
  ];
}

/** cask 目录的缓存文件（放插件自己的数据目录，不碰宿主配置）。 */
export function catalogCachePath(dir) {
  return join(dir || dataDir(), "cask-catalog.json");
}

const CATALOG_URL = "https://formulae.brew.sh/api/cask.json";

/**
 * cask 目录的下载地址，参与并发竞速。
 *
 * 为什么不止一个：`formulae.brew.sh` 在国内网络下常常只有 20~30 KB/s（实测 19 MB 的
 * cask.json 跑 120 秒只下到 0.5 MB），而旧实现只给它一次 120 秒的机会 —— 于是每次扫描
 * 都白等两分钟、最后拿不到目录，所有应用都算不出「可更新」。镜像站同样内容几秒就能下完，
 * 所以官方地址仍然排第一，谁先下完用谁。
 *
 * 为什么**不**放阿里云：`mirrors.aliyun.com/homebrew/homebrew-bottles/api/cask.json` 是一份
 * 冻结在 2025-05-22 的旧快照（13.7 MB，其余三源 19.3 MB；用 `isNewer` 全量比对有 2908 个
 * cask 版本落后官方、1257 个缺失）。它结构同构、不会报错，只会让「已是最新」的结论悄悄变错 ——
 * 而阿里云是国内最快的源，竞速里几乎总是它先返回，等于稳定拿到最旧的数据。
 * 宁可少一个源，也不要一个又快又错的源。
 */
const CATALOG_URLS = [
  CATALOG_URL,
  "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api/cask.json",
  "https://mirrors.ustc.edu.cn/homebrew-bottles/api/cask.json",
];

/** 单个地址的超时：一个慢线路不该把整次扫描卡住好几分钟。 */
const CATALOG_FETCH_TIMEOUT_S = 60;
const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
/** 抓不到新目录时，已经过期的缓存最多还能用这么久（旧数据也比没有强）。 */
const CATALOG_STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 从 cask 目录 JSON 建索引：
 *  - byApp：`.app` 文件名（小写）→ 条目**数组**，用来「从已装应用反查 cask」；
 *  - byToken：cask token → 条目，用来「从已装 cask 正查最新版本」。
 *
 * 一个 .app 可能被多个 cask 声明（例如 `iterm2` 与 `iterm2@nightly` 都装
 * `iTerm.app`），只留最后一个会让匹配随目录顺序漂移 —— 所以这里保留全部候选，
 * 由 pickCask 按「已装 > 非 nightly/非弃用 > token 精确匹配」挑选。
 *
 * @param {any} list formulae.brew.sh/api/cask.json 的内容
 */
export function parseCaskCatalog(list) {
  const byApp = new Map();
  const byToken = new Map();
  const addCandidate = (appName, entry) => {
    const key = String(appName).toLowerCase();
    const bucket = byApp.get(key);
    if (bucket) bucket.push(entry);
    else byApp.set(key, [entry]);
  };
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || typeof c !== "object" || !c.token) continue;
    const appNames = [];
    for (const art of Array.isArray(c.artifacts) ? c.artifacts : []) {
      if (!art || typeof art !== "object") continue;
      for (const raw of Array.isArray(art.app) ? art.app : []) {
        // 形如 "$APPDIR/Foo.app" 或 "Foo.app"，只取最后一段
        const base = String(raw).split("/").pop();
        if (base && /\.app$/i.test(base)) appNames.push(base);
      }
    }
    const entry = {
      token: String(c.token),
      version: String(c.version == null ? "" : c.version).trim(),
      name: Array.isArray(c.name) && c.name.length ? String(c.name[0]) : String(c.token),
      appNames,
      deprecated: Boolean(c.deprecated),
      disabled: Boolean(c.disabled),
      autoUpdates: Boolean(c.auto_updates),
    };
    byToken.set(entry.token, entry);
    for (const appName of appNames) addCandidate(appName, entry);
  }
  return { byApp, byToken };
}

/** token 里的变体后缀（iterm2@nightly → iterm2），用于排序时优先主 cask。 */
function baseToken(token) {
  return String(token || "").split("@")[0];
}

/**
 * 在多个候选 cask 里挑出最可能是「这个 .app 对应的那个 cask」。
 *
 * 优先级（越靠前越优先）：
 *  1. 已安装（token 出现在 brews 里）—— 已装的就是用户实际在用的那个；
 *  2. 非 deprecated / disabled；
 *  3. 主 token（不带 @nightly 这类变体后缀）；
 *  4. token 与应用名/应用文件名归一化后相等。
 */
export function pickCask(candidates, { appName, bundleName, brews = new Map() } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const keys = new Set([normalizeAppKey(appName), normalizeAppKey(bundleName)].filter(Boolean));
  const score = (entry) => {
    let s = 0;
    if (brews.has(entry.token)) s += 100;
    if (!entry.deprecated && !entry.disabled) s += 10;
    if (entry.token === baseToken(entry.token)) s += 5;
    if (keys.has(normalizeAppKey(entry.token))) s += 3;
    for (const n of entry.appNames) if (keys.has(normalizeAppKey(n))) s += 1;
    return s;
  };
  let best = candidates[0];
  let bestScore = score(best);
  for (const candidate of candidates.slice(1)) {
    const s = score(candidate);
    if (s > bestScore) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}

/** 名字归一化：去掉 .app、空格与标点，只留字母数字，用于 token ↔ 应用名兜底匹配。 */
export function normalizeAppKey(name) {
  return String(name || "")
    .replace(/\.app$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * 在标准应用目录里找 `.app`（不进入 bundle 内部，避免把框架当应用）。
 * @returns {Promise<string[]>} 绝对路径，已去重
 */
export async function listAppBundles(dirs, depth = 1) {
  const found = [];
  const seen = new Set();
  const walk = async (dir, level) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 无权限：跳过，不影响其它目录
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (/\.app$/i.test(entry.name)) {
        if (!seen.has(full)) {
          seen.add(full);
          found.push(full);
        }
        continue;
      }
      if (level > 0 && (entry.isDirectory() || entry.isSymbolicLink())) {
        await walk(full, level - 1);
      }
    }
  };
  for (const dir of dirs) await walk(dir, depth);
  return found;
}

/** 用 plutil 读 Info.plist（macOS 自带，binary plist 也能转 JSON）。 */
async function readInfoPlist(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  const res = await runProcess("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], { timeoutMs: 15000 });
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/**
 * 读一个 `.app` 的元信息。
 * @returns {Promise<{path:string,bundleName:string,name:string,version:string,bundleId:string,appStore:boolean,system:boolean}>}
 */
export async function readAppBundle(appPath) {
  // macOS 上路径一定用 /，但单测在 Windows 上跑，两种分隔符都要能取到最后一段
  const bundleName = String(appPath).split(/[\\/]/).filter(Boolean).pop() || String(appPath);
  const info = {
    path: appPath,
    bundleName,
    name: bundleName.replace(/\.app$/i, ""),
    version: "",
    bundleId: "",
    appStore: existsSync(join(appPath, "Contents", "_MASReceipt", "receipt")),
    system: appPath.startsWith("/System/"),
  };
  const plist = await readInfoPlist(appPath);
  if (plist) {
    const short = plist.CFBundleShortVersionString;
    const bundle = plist.CFBundleVersion;
    info.version = String(short || bundle || "").trim();
    info.bundleId = String(plist.CFBundleIdentifier || "").trim();
    const display = plist.CFBundleDisplayName || plist.CFBundleName;
    if (display) info.name = String(display).trim();
  }
  if (!info.version) {
    // plutil 失败时的兜底：defaults 直接读单个键
    const res = await runProcess(
      "/usr/bin/defaults",
      ["read", join(appPath, "Contents", "Info"), "CFBundleShortVersionString"],
      { timeoutMs: 15000 }
    );
    if (res.ok) info.version = res.stdout.trim();
  }
  return info;
}

/** 枚举并读取全部已安装应用（并发有限，避免一次开几百个进程）。 */
export async function scanAppBundles({ dirs, log, concurrency = 8 } = {}) {
  const paths = await listAppBundles(dirs || applicationDirs());
  const out = [];
  let index = 0;
  const worker = async () => {
    while (index < paths.length) {
      const current = paths[index];
      index += 1;
      try {
        out.push(await readAppBundle(current));
      } catch {
        /* 单个 bundle 读不出来不影响其它应用 */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length || 1) }, worker));
  if (log) log("info", `在应用目录里找到 ${out.length} 个 .app`);
  return out;
}

/**
 * 读缓存的 cask 目录。
 * @param {string} file 缓存文件
 * @param {number} [now] 当前时间
 * @param {{ allowStale?: boolean }} [opts] allowStale：TTL 过了也接受（用于网络抓取失败时兜底）
 * @returns {Promise<Array|null>} 目录条目；不可用时为 null
 */
export async function readCatalogCache(file, now = Date.now(), opts = {}) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    if (!raw || typeof raw.fetchedAt !== "number") return null;
    const age = now - raw.fetchedAt;
    if (age > (opts.allowStale ? CATALOG_STALE_MAX_MS : CATALOG_TTL_MS)) return null;
    return Array.isArray(raw.list) && raw.list.length ? raw.list : null;
  } catch {
    return null;
  }
}

/**
 * 抓取 cask 目录并写缓存。
 *
 * 顺序：新鲜缓存 → 官方地址 → 镜像 → 过期缓存兜底 → null（调用方降级，不中断扫描）。
 * 每个地址单独限时，绝不因为一条慢线路让整次扫描等上十几分钟。
 */
export async function fetchCaskCatalog({ file, log, warnings, fetchImpl } = {}) {
  const cacheFile = file || catalogCachePath();
  const cached = await readCatalogCache(cacheFile);
  if (cached) return cached;

  /**
   * 并发竞速取目录：官方地址与镜像同时开跑，谁先下完用谁，其余立刻取消。
   *
   * 为什么不用「依次重试」：官方线路实测 25 KB/s，串行等待等于每次扫描先干等
   * 60 秒才知道该换镜像；并发竞速时镜像通常一两秒就返回，用户几乎不感知。
   * 官方地址仍然参与竞速（网络正常时用官方数据，最权威）。
   */
  const run = fetchImpl || (async () => {
    const controllers = [];
    const failures = [];

    const attempt = (url) => new Promise((resolve, reject) => {
      const host = url.replace(/^https?:\/\//, "").split("/")[0];
      const controller = new AbortController();
      controllers.push(controller);
      runProcess(
        "/usr/bin/curl",
        ["-fsSL", "--max-time", String(CATALOG_FETCH_TIMEOUT_S), url],
        { timeoutMs: (CATALOG_FETCH_TIMEOUT_S + 15) * 1000, signal: controller.signal }
      ).then((res) => {
        if (!res.ok) {
          const why = String(res.stderr || "").trim().split("\n")[0] || `curl 退出码 ${res.code}`;
          throw new Error(`${host}: ${why}`);
        }
        const list = JSON.parse(res.stdout);
        if (!Array.isArray(list) || !list.length) throw new Error(`${host}: 内容不是 cask 目录数组`);
        resolve(list);
      }).catch((err) => reject(new Error(String((err && err.message) || err))));
    });

    try {
      // 全部并发起跑；Promise.any 拿到第一个成功的结果。
      const list = await Promise.any(
        CATALOG_URLS.map((url) => attempt(url).catch((err) => {
          failures.push(String((err && err.message) || err));
          throw err;
        }))
      );
      return list;
    } catch {
      throw new Error(failures.join("；") || "所有 cask 目录地址都失败");
    } finally {
      // 无论成败，取消还在跑的下载，避免白白占用带宽。
      for (const controller of controllers) {
        try { controller.abort(); } catch { /* 已结束 */ }
      }
    }
  });

  try {
    const list = await run();
    if (!Array.isArray(list)) throw new Error("cask 目录格式不符合预期");
    try {
      await mkdir(dataDir(), { recursive: true });
      await writeFile(cacheFile, JSON.stringify({ fetchedAt: Date.now(), list }), "utf8");
    } catch {
      /* 缓存写不进去不影响本次扫描 */
    }
    if (log) log("info", `已读取 Homebrew cask 目录（${list.length} 个 cask）`);
    return list;
  } catch (err) {
    const message = String((err && err.message) || err);
    // 所有地址都失败时，用过期缓存兜底：版本判断宁可略旧，也好过整屏「无法判断」。
    const stale = await readCatalogCache(cacheFile, Date.now(), { allowStale: true });
    if (stale) {
      const text = `读取 Homebrew cask 目录失败，改用本地过期缓存（版本可能不是最新）：${message}`;
      if (warnings) warnings.push(text);
      if (log) log("warn", text);
      return stale;
    }
    if (warnings) warnings.push(`读取 Homebrew cask 目录失败（不影响列出应用，但无法判断是否有新版本）：${message}`);
    if (log) log("warn", `读取 Homebrew cask 目录失败：${message}`);
    return null;
  }
}

/**
 * 组装 macOS 应用列表（纯函数，便于单测）。
 *
 * @param {object} input
 * @param {Array} input.apps        已安装的 .app（scanAppBundles 的结果）
 * @param {Map<string,string>} input.brews   已装 cask：token → 已装版本
 * @param {Map<string,string>} input.outdated 可升级 cask：token → 可用版本
 * @param {{byApp:Map,byToken:Map}|null} input.catalog cask 目录索引
 * @param {object} input.settings
 * @returns {{items:Array, warnings:string[]}}
 */
export function buildMacosItems({ apps = [], brews = new Map(), outdated = new Map(), catalog = null, settings = {} }) {
  const warnings = [];
  const items = [];
  const byApp = catalog ? catalog.byApp : new Map();
  const byToken = catalog ? catalog.byToken : new Map();
  /** 已被某个 .app 认领的 cask token，避免重复列出 */
  const claimed = new Set();

  // 没有 cask 目录时也能把「已装 cask」和 .app 对上：用 token 名归一化匹配，
  // 否则同一个应用会既作为 .app 出现、又作为 brew 条目再出现一次。
  const brewByName = new Map();
  for (const token of brews.keys()) brewByName.set(normalizeAppKey(token), token);

  const matchCask = (app) => {
    const direct = byApp.get(String(app.bundleName || "").toLowerCase());
    if (direct && direct.length) {
      return pickCask(direct, { appName: app.name, bundleName: app.bundleName, brews });
    }
    const key = normalizeAppKey(app.name || app.bundleName);
    for (const entry of byToken.values()) {
      if (normalizeAppKey(entry.token) === key) return entry;
      for (const appName of entry.appNames) {
        if (normalizeAppKey(appName) === key) return entry;
      }
    }
    const token = brewByName.get(key);
    if (token) return { token, version: "", name: token, appNames: [] };
    return null;
  };

  for (const app of apps) {
    // 注意：只有**显式**设为 false 才过滤。settings 缺字段时按默认「包含」处理，
    // 否则单测/老状态文件里缺字段会把应用整批吞掉。
    if (settings.includeStoreApps === false && app.appStore) continue;
    const cask = matchCask(app);
    const managed = Boolean(cask && brews.has(cask.token));
    // 非 Homebrew 管理的应用：默认列出（includeUnmanagedApps），关掉后只看 Homebrew 应用
    if (!managed && settings.includeUnmanagedApps === false) continue;
    if (cask && managed) claimed.add(cask.token);

    const latest = cask && looksLikeVersion(cask.version) ? cask.version : "";
    const forced = managed && outdated.get(cask.token) ? String(outdated.get(cask.token)) : "";

    let available = "";
    if (managed) {
      if (forced) available = forced;
      else if (latest && looksLikeVersion(app.version) && isNewer(latest, app.version)) available = latest;
    }

    let reason = null;
    if (app.system && !managed) reason = "system-component";
    else if (app.appStore && !managed) reason = "store-managed";
    else if (!managed) reason = "not-managed";

    /* 「非 Homebrew 管理」是 Mac 上最常见的状态（绝大多数应用是拖 DMG 装的）。
       只回一句「不支持」等于把用户留在原地 —— 所以把下一步**具体命令**写进提示：
       `brew install --cask --adopt <token>` 接管现有 .app，不重装、不丢配置。
       能对上 cask 时给真 token；对不上时给占位写法，别让用户自己猜。 */
    const adoptHint =
      reason === "not-managed"
        ? cask && cask.token
          ? `brew install --cask --adopt ${cask.token}`
          : "用 brew install --cask --adopt <token> 收编后可一键更新"
        : "";

    const hasUpdate = Boolean(managed && available);
    items.push({
      id: managed ? `brew:${cask.token}` : `macapp:${app.bundleId || app.bundleName}`,
      name: app.name || app.bundleName,
      version: app.version || "",
      available,
      publisher: cask ? `Homebrew cask · ${cask.token}` : app.bundleId || "",
      source: managed ? "homebrew" : app.appStore ? "appstore" : "app",
      installLocation: app.path,
      hasUpdate,
      updateSupported: hasUpdate,
      reason: hasUpdate ? null : reason,
      adoptHint,
      kind: managed ? "cask" : "app",
    });
  }

  // 通过 Homebrew 装的、但标准目录里没找到 .app 的（字体、命令行 cask 等）也要列出来。
  // 它们本来就由 Homebrew 管理，不受「包含非 Homebrew 应用」开关影响。
  for (const [token, version] of brews) {
    if (claimed.has(token)) continue;
    const entry = byToken.get(token);
    const forced = outdated.get(token) ? String(outdated.get(token)) : "";
    const latest = entry && looksLikeVersion(entry.version) ? entry.version : "";
    let available = "";
    if (forced) available = forced;
    else if (latest && looksLikeVersion(version) && isNewer(latest, version)) available = latest;
    const hasUpdate = Boolean(available);
    items.push({
      id: `brew:${token}`,
      name: entry ? entry.name : token,
      version: version || "",
      available,
      publisher: `Homebrew cask · ${token}`,
      source: "homebrew",
      installLocation: "",
      hasUpdate,
      updateSupported: hasUpdate,
      reason: hasUpdate ? null : null,
      kind: "cask",
    });
  }

  if (!catalog) {
    warnings.push("没有可用的 Homebrew cask 目录：只显示 Homebrew 报告的更新，非 Homebrew 应用无法判断是否有新版本");
  }
  /* 「包含非 Homebrew 应用」被关掉只是用户自己选的过滤条件，不是故障 ——
     不放进 warnings，否则界面会一直挂一条红色告警横幅。 */

  items.sort((a, b) => {
    if (a.hasUpdate !== b.hasUpdate) return a.hasUpdate ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  return { items, warnings };
}
