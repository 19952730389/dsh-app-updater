/**
 * dsh-app-updater 宿主半身。
 *
 * 职责：暴露 HTTP 路由给设置页 UI，串行调度「扫描」与「更新」两条后台任务，
 * 把进度写进持久化状态。所有写操作都要求 loopback 来源 + confirm:true。
 *
 * 设计上不依赖宿主内部服务（不用 llm / tools / agent），只依赖 webServer，
 * 因此在没有 Web 的 composition 里它会安静地不挂载任何路由。
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { Store } from "./state.js";
import { scanApps, runUpdates, resolveDownloadDir, findBrew, currentEnvironment } from "./engine.js";
import { findWinget } from "./winget.js";
import { describeEnvironment, engineFor, capabilitiesFor, ENGINE_WINGET, ENGINE_BREW } from "./platform.js";

const PREFIX = "/dsh-app-updater";
const MAX_BODY_BYTES = 256 * 1024;

/** 版本号只有 package.json 一个来源，避免两处写死对不上。 */
const PLUGIN_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("../package.json").version || "";
  } catch {
    return "";
  }
})();

const store = new Store();

/** 当前任务的控制面。同一时刻只允许一个扫描 + 一个更新。 */
const control = {
  scanAbort: null,
  updateAbort: null,
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function isLoopback(req) {
  const a = req && req.socket && req.socket.remoteAddress;
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let chunks = "";
    let tooLarge = false;
    req.on("data", (c) => {
      if (tooLarge) return;
      if (chunks.length + c.length > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks += c;
    });
    req.on("end", () => {
      if (tooLarge) return resolve({ tooLarge: true });
      if (!chunks.trim()) return resolve({});
      try {
        resolve(JSON.parse(chunks));
      } catch {
        resolve({ parseError: true });
      }
    });
    req.on("error", () => resolve({ parseError: true }));
  });
}

/** 请求是否携带了 DSH 连接凭据（浏览器会话 Cookie 或 API Cookie）。 */
export function hasConnectionCredentials(req) {
  const h = (req && req.headers) || {};
  return Boolean(h.cookie || h.authorization);
}

/**
 * connection 准入（宿主信任边界）。
 *
 * DSH 的 `connection` 服务负责插件 HTTP 路由的信任校验：`admit(request)` 先做
 * Host/Origin 校验，再做浏览器会话 / API 认证，返回本次调用对应的 Peer，或用
 * `401`（未认证）/`403`（不可信来源）拒绝 —— 宿主自己的 `/api` 路由用的就是它。
 *
 * 退回策略（只有一条，且完全不涉及凭据）：宿主没有 `connection` 服务，
 * 或者请求**没有携带任何连接凭据**、来自回环地址时，按旧的「回环」规则放行，
 * 并在响应头标注 `X-DSH-Admission: loopback-legacy`。
 * 带凭据的请求一律以 admission 的结果为准；非回环请求一律拒绝。
 *
 * @returns {boolean} 已放行 true；已写出拒绝响应 false
 */
export function admissionGate(req, res, connection) {
  const loopback = isLoopback(req);
  if (connection && typeof connection.admit === "function") {
    let admission;
    try {
      admission = connection.admit(req);
    } catch (err) {
      json(res, 500, { ok: false, error: `连接准入失败：${String((err && err.message) || err)}` });
      return false;
    }
    if (!admission || typeof admission.rejection !== "number") return true;
    if (admission.rejection === 401 && loopback && !hasConnectionCredentials(req)) {
      // 宿主自己的载体（Electron 经 IPC 桥接的 fetch）与本机脚本都不带 Cookie，
      // 没有可核验的凭据，只能按回环信任放行 —— 与接入准入之前的行为一致。
      if (typeof res.setHeader === "function") res.setHeader("X-DSH-Admission", "loopback-legacy");
      return true;
    }
    res.writeHead(admission.rejection, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
    return false;
  }
  if (!loopback) {
    json(res, 403, { ok: false, error: "只接受本机请求（loopback）：当前宿主没有可用的 connection 准入服务" });
    return false;
  }
  if (typeof res.setHeader === "function") res.setHeader("X-DSH-Admission", "loopback-legacy");
  return true;
}

/**
 * 写操作闸门：`confirm:true`。
 *
 * 来源校验已经由 `register()` 里的 connection 准入做过（见 admissionGate），
 * 这里只负责「这次写入是用户显式确认过的」。
 */
async function writeGate(req, res) {
  const body = await readJsonBody(req);
  if (body.tooLarge) {
    json(res, 413, { ok: false, error: "请求体过大" });
    return null;
  }
  if (body.parseError) {
    json(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return null;
  }
  if (body.confirm !== true) {
    json(res, 400, { ok: false, error: "缺少 confirm:true（写操作必须显式确认）" });
    return null;
  }
  return body;
}

function phaseOf(state) {
  if (state.update.running) return "updating";
  if (state.scan.running) return "scanning";
  return "idle";
}

/**
 * 平台闸门：Windows 与 macOS 通过；其它系统明确拒绝，而不是让引擎跑到一半才报错。
 * @returns {object|null} 通过时返回环境对象，否则已写出 400 响应并返回 null
 */
function platformGuard(res) {
  const env = currentEnvironment();
  if (env.family === "windows" || env.family === "macos") return env;
  json(res, 400, {
    ok: false,
    error: `当前系统 ${env.platform} 暂不支持（本插件面向 Windows 与 macOS）`,
  });
  return null;
}

function buildStatePayload() {
  const s = store.state;
  const env = s.env || currentEnvironment();
  const engine = s.engine && s.engine.id ? s.engine : defaultEngine(env);
  return {
    ok: true,
    platform: env.platform,
    env,
    envSummary: describeEnvironment(env),
    engine,
    capabilities: capabilitiesFor(env, Boolean(engine.available)),
    winget: s.winget || detectWingetSync(),
    phase: phaseOf(s),
    scan: s.scan,
    update: s.update,
    apps: s.apps,
    log: s.log.slice(-200),
    settings: s.settings,
    downloadDir: resolveDownloadDir(s.settings),
  };
}

/** 还没扫描过时，也把引擎探测出来，界面不必等到扫描完才显示环境。 */
let cachedDefaultEngine = null;
function defaultEngine(env) {
  const id = engineFor(env.family);
  if (cachedDefaultEngine && cachedDefaultEngine.id === id) return cachedDefaultEngine;
  if (id === ENGINE_WINGET) {
    const file = findWinget();
    cachedDefaultEngine = { id, available: Boolean(file), version: "", path: file || "" };
  } else if (id === ENGINE_BREW) {
    const file = findBrew();
    cachedDefaultEngine = { id, available: Boolean(file), version: "", path: file || "" };
  } else {
    cachedDefaultEngine = { id, available: false, version: "", path: "" };
  }
  return cachedDefaultEngine;
}

let cachedWinget = null;
function detectWingetSync() {
  if (cachedWinget) return cachedWinget;
  const file = findWinget();
  cachedWinget = { available: Boolean(file), version: "", path: file || "" };
  return cachedWinget;
}

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

let scanPromise = null;

async function startScan(force) {
  if (store.state.scan.running && scanPromise) return { started: false, running: true };
  if (!force && store.state.apps.scannedAt && Date.now() - store.state.apps.scannedAt < 30_000) {
    return { started: false, cached: true };
  }

  const abort = new AbortController();
  control.scanAbort = abort;
  store.state.scan = { ...store.state.scan, running: true, startedAt: Date.now(), finishedAt: 0, error: null, warnings: [] };
  store.save();

  scanPromise = (async () => {
    try {
      const result = await scanApps({
        settings: store.state.settings,
        log: (level, text) => store.log(level, text),
        signal: abort.signal,
      });
      store.state.env = result.env || store.state.env;
      store.state.engine = result.engine || store.state.engine;
      if (result.winget) store.state.winget = result.winget;
      store.state.apps = {
        scannedAt: result.scannedAt,
        stats: result.stats,
        items: result.items,
        engine: result.engine ? result.engine.id : "",
      };
      store.state.scan = {
        running: false,
        startedAt: result.startedAt,
        finishedAt: Date.now(),
        error: null,
        warnings: result.warnings,
      };
    } catch (err) {
      const message = String((err && err.message) || err);
      store.state.scan = { ...store.state.scan, running: false, finishedAt: Date.now(), error: message };
      store.log("error", `扫描失败：${message}`);
    } finally {
      control.scanAbort = null;
      scanPromise = null;
      store.save();
    }
  })();

  return { started: true };
}

let updatePromise = null;

async function startUpdate(ids) {
  if (store.state.update.running) return { started: false, running: true };
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === "string" && x.trim());
  if (!list.length) return { started: false, error: "没有要更新的应用" };

  const abort = new AbortController();
  control.updateAbort = abort;
  store.state.update = {
    running: true,
    startedAt: Date.now(),
    finishedAt: 0,
    total: list.length,
    done: 0,
    current: null,
    results: [],
    error: null,
  };
  store.save();

  updatePromise = (async () => {
    try {
      await runUpdates({
        ids: list,
        // 把界面刚扫描出来的「已装版本 / 目标版本」一并带过去：安装后的复核要用它
        // 判断这次更新到底有没有真的生效（只看退出码会把「静默退出 0 却什么都没装」误报成功）
        plan: (store.state.apps.items || []).filter((it) => list.includes(it.id)),
        settings: store.state.settings,
        log: (level, text) => store.log(level, text),
        signal: abort.signal,
        onProgress: (patch) => {
          store.state.update = { ...store.state.update, ...patch };
          store.save();
        },
      });
    } catch (err) {
      const message = String((err && err.message) || err);
      store.state.update = { ...store.state.update, running: false, finishedAt: Date.now(), error: message };
      store.log("error", `更新任务异常：${message}`);
    } finally {
      control.updateAbort = null;
      updatePromise = null;
      store.save();
      // 更新结束后自动重扫，让版本号刷新成新值
      startScan(true).catch(() => {});
    }
  })();

  return { started: true, queued: list.length };
}

/** 在资源管理器中打开下载目录（不需要 shell 解释器，避免注入）。 */
function openFolder(path) {
  try {
    const explorer = join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "explorer.exe");
    const child = spawn(explorer, [path], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 插件
 * ------------------------------------------------------------------ */

export default {
  name: "dsh-app-updater",
  apply(ctx) {
    ctx.effect(() => {
      store.load().catch(() => {});
    }, "dsh-app-updater: load state");

    ctx.inject(["webServer"], (webCtx) => {
      const webServer = webCtx.webServer;

      // connection 准入：宿主提供的信任边界（Host/Origin 校验 + 浏览器/API 认证）。
      // 它在宿主没有 Web 载体时不存在，此时 admissionGate 退回旧的「回环」检查。
      let connection = null;
      ctx.inject(["connection"], (connCtx) => {
        connection = connCtx.connection;
        return () => {
          connection = null;
        };
      });
      const routes = [];

      /**
       * 注册一条路由：请求先过 connection 准入（见 admissionGate），再进业务处理。
       * 写接口另有 `confirm:true` 闸门（writeGate）。
       */
      const register = (path, handler) => {
        routes.push(
          webServer.register({
            kind: "exact",
            path: `${PREFIX}${path}`,
            handler: (req, res) => {
              if (!admissionGate(req, res, connection)) return;
              return handler(req, res);
            },
          })
        );
      };

      register("/state.json", async (req, res) => {
        try {
          await store.load();
          json(res, 200, buildStatePayload());
        } catch (err) {
          json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      });

      register("/apps.json", async (req, res) => {
        await store.load();
        json(res, 200, {
          ok: true,
          scannedAt: store.state.apps.scannedAt,
          stats: store.state.apps.stats,
          items: store.state.apps.items,
          warnings: store.state.scan.warnings || [],
        });
      });

      register("/scan", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        if (!platformGuard(res)) return;
        const r = await startScan(body.force !== false);
        json(res, 200, { ok: true, ...r });
      });

      register("/update", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        if (!platformGuard(res)) return;
        const r = await startUpdate(body.ids);
        if (r.error) return json(res, 400, { ok: false, ...r });
        json(res, 200, { ok: true, ...r });
      });

      register("/cancel", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        let cancelled = false;
        if (control.updateAbort) {
          control.updateAbort.abort();
          cancelled = true;
          store.log("warn", "收到取消请求，正在停止更新队列");
        }
        if (control.scanAbort) {
          control.scanAbort.abort();
          cancelled = true;
          store.log("warn", "收到取消请求，正在停止扫描");
        }
        json(res, 200, { ok: true, cancelled });
      });

      register("/settings", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        const patch = { ...(body.settings || {}) };
        if (Object.prototype.hasOwnProperty.call(patch, "downloadDir")) {
          const value = String(patch.downloadDir == null ? "" : patch.downloadDir).trim();
          // 空 = 用默认目录；否则必须是绝对路径，避免把安装包写到意料之外的位置
          if (value && !/^[A-Za-z]:[\\/]/.test(value) && !/^\\\\[^\\]/.test(value)) {
            return json(res, 400, {
              ok: false,
              error: "downloadDir 必须是绝对路径（如 D:\\Apps）或 UNC 路径（\\\\server\\share）",
            });
          }
          patch.downloadDir = value;
        }
        const next = store.updateSettings(patch);
        store.log("info", "设置已保存");
        json(res, 200, { ok: true, settings: next, downloadDir: resolveDownloadDir(next) });
      });

      register("/open-downloads", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        const dir = resolveDownloadDir(store.state.settings);
        const opened = process.platform === "win32" ? openFolder(dir) : false;
        json(res, 200, { ok: opened, path: dir, exists: existsSync(dir) });
      });

      register("/health.json", async (req, res) => {
        await store.load();
        const env = store.state.env || currentEnvironment();
        const engine = store.state.engine && store.state.engine.id ? store.state.engine : defaultEngine(env);
        json(res, 200, {
          ok: true,
          plugin: "dsh-app-updater",
          version: PLUGIN_VERSION,
          platform: env.platform,
          env,
          envSummary: describeEnvironment(env),
          engine,
          capabilities: capabilitiesFor(env, Boolean(engine.available)),
          routes: routes.length,
          dataDir: join(process.env.DSH_HOME || join(homedir(), ".dsh"), "dsh-app-updater"),
        });
      });

      ctx.effect(
        () => () => {
          for (const dispose of routes) {
            try {
              dispose();
            } catch {
              /* 已释放 */
            }
          }
        },
        "dsh-app-updater: routes"
      );
    });
  },
};
