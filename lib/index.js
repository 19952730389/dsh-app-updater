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

import { Store } from "./state.js";
import { scanApps, runUpdates, resolveDownloadDir } from "./engine.js";
import { findWinget } from "./winget.js";

const PREFIX = "/dsh-app-updater";
const MAX_BODY_BYTES = 256 * 1024;

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

/** 写操作闸门：loopback + confirm:true。 */
async function writeGate(req, res) {
  if (!isLoopback(req)) {
    json(res, 403, { ok: false, error: "只接受本机请求（loopback）" });
    return null;
  }
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

function buildStatePayload() {
  const s = store.state;
  return {
    ok: true,
    platform: process.platform,
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
      store.state.winget = result.winget;
      store.state.apps = {
        scannedAt: result.scannedAt,
        stats: result.stats,
        items: result.items,
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
      const routes = [];

      const register = (path, handler) => {
        routes.push(webServer.register({ kind: "exact", path: `${PREFIX}${path}`, handler }));
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
        if (process.platform !== "win32") {
          return json(res, 400, { ok: false, error: "只支持 Windows" });
        }
        const r = await startScan(body.force !== false);
        json(res, 200, { ok: true, ...r });
      });

      register("/update", async (req, res) => {
        const body = await writeGate(req, res);
        if (!body) return;
        await store.load();
        if (process.platform !== "win32") {
          return json(res, 400, { ok: false, error: "只支持 Windows" });
        }
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
        json(res, 200, {
          ok: true,
          plugin: "dsh-app-updater",
          platform: process.platform,
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
