/**
 * 宿主半身端到端自测：用一个假的 cordis ctx + 真 http server 把插件路由跑起来，
 * 然后像浏览器一样打真实请求。这样不重启 DSH 也能验证整条链路。
 *
 * 用法：node test/harness.mjs [--scan] [--update <id>]
 */

import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = process.env.DSH_HOME || join(here, "..", ".test-home");
// 这个假 ctx 没有 connection 服务，等价于旧宿主：默认拒绝下路由一律 403。
// 所以自测里显式开启兼容模式（与用户在旧宿主上手动开启走的是同一段代码）。
process.env.DSH_APP_UPDATER_ALLOW_LEGACY_LOOPBACK = "1";

const plugin = (await import("../lib/index.js")).default;

const routes = [];
const webServer = {
  register(spec) {
    routes.push(spec);
    return () => {};
  },
};

const ctx = {
  effect(fn) {
    const dispose = fn();
    return () => {
      if (typeof dispose === "function") dispose();
    };
  },
  inject(deps, fn) {
    fn({ webServer });
  },
};

plugin.apply(ctx);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = routes.find((r) => r.path === url.pathname);
  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "no route" }));
    return;
  }
  Promise.resolve(route.handler(req, res)).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

function head(title) {
  console.log(`\n=== ${title} ===`);
}

head("routes");
console.log(routes.map((r) => r.path));

head("health");
console.log(await get("/dsh-app-updater/health.json"));

head("state (before scan)");
const s0 = await get("/dsh-app-updater/state.json");
console.log({ phase: s0.phase, winget: s0.winget, items: s0.apps.items.length, downloadDir: s0.downloadDir });

head("write gate: missing confirm");
console.log(await post("/dsh-app-updater/scan", {}));

head("write gate: bad json");
console.log(await (await fetch(base + "/dsh-app-updater/scan", { method: "POST", body: "{oops" })).json());

if (process.argv.includes("--scan")) {
  head("scan");
  console.log(await post("/dsh-app-updater/scan", { confirm: true, force: true }));
  for (let i = 0; i < 120; i += 1) {
    const st = await get("/dsh-app-updater/state.json");
    if (st.phase === "idle" && st.apps.scannedAt) {
      console.log({ phase: st.phase, stats: st.apps.stats, winget: st.winget });
      const up = st.apps.items.filter((a) => a.hasUpdate);
      console.log("upgradable:", up.map((a) => `${a.name} ${a.version}->${a.available}`));
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  head("apps.json");
  const apps = await get("/dsh-app-updater/apps.json");
  console.log({ total: apps.items.length, stats: apps.stats, warnings: apps.warnings });
}

if (process.argv.includes("--update")) {
  const id = process.argv[process.argv.indexOf("--update") + 1];
  head(`update ${id}`);
  console.log(await post("/dsh-app-updater/update", { confirm: true, ids: [id], mode: "silent" }));
  for (let i = 0; i < 900; i += 1) {
    const st = await get("/dsh-app-updater/state.json");
    if (st.phase !== "updating") {
      console.log("done:", JSON.stringify(st.update.results, null, 1));
      break;
    }
    if (i % 10 === 0) console.log("progress", st.update.done + "/" + st.update.total, st.update.current || "");
    await new Promise((r) => setTimeout(r, 1000));
  }
  head("log tail");
  const st = await get("/dsh-app-updater/state.json");
  console.log(st.log.slice(-12).map((l) => `[${l.level}] ${l.text}`).join("\n"));
}

head("settings");
console.log(await post("/dsh-app-updater/settings", { confirm: true, settings: { keepInstallers: true, downloadDir: "" } }));

head("open-downloads (dry: just check path)");
console.log(await post("/dsh-app-updater/open-downloads", { confirm: true }));

server.close();
console.log("\nharness done");
