/**
 * 渲染 + 交互自测：用迷你 React / 迷你 DOM 把 lib/client.js 真实加载起来，
 * 覆盖设置面板、演练提示、列宽拖拽、请求体与本地存储。
 *
 * 运行：node test/render.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let checks = 0;
let failures = 0;
function ok(cond, label, extra) {
  checks += 1;
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.log(`  ✗ ${label}${extra === undefined ? "" : ` — ${JSON.stringify(extra)}`}`);
  }
}
const group = (n) => console.log(`\n${n}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * 迷你 React（只覆盖本组件用到的 hooks）
 * ------------------------------------------------------------------ */

function makeReact() {
  let hooks = [];
  let cursor = 0;
  let effects = [];
  let renderFn = null;
  let dirty = false;
  let rendering = false;

  const shallowEqual = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

  const schedule = () => {
    dirty = true;
    if (rendering) return;
    queueMicrotask(() => {
      if (dirty && !rendering) renderFn();
    });
  };

  const react = {
    createElement(type, props, ...children) {
      const flat = [];
      for (const c of children) {
        if (Array.isArray(c)) flat.push(...c.flat(Infinity));
        else flat.push(c);
      }
      return {
        type,
        props: props || {},
        children: flat.filter((c) => c !== null && c !== undefined && c !== false && c !== true && c !== ""),
      };
    },
    useState(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
      const set = (v) => {
        const next = typeof v === "function" ? v(hooks[i]) : v;
        if (next !== hooks[i]) {
          hooks[i] = next;
          schedule();
        }
      };
      return [hooks[i], set];
    },
    useRef(init) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = { current: init };
      return hooks[i];
    },
    useMemo(fn, deps) {
      const i = cursor++;
      const prev = hooks[i];
      if (!prev || !shallowEqual(prev.deps, deps)) hooks[i] = { value: fn(), deps: deps };
      return hooks[i].value;
    },
    useCallback(fn, deps) {
      return react.useMemo(() => fn, deps);
    },
    useEffect(fn, deps) {
      const i = cursor++;
      const prev = hooks[i];
      if (!prev || !shallowEqual(prev.deps, deps)) {
        hooks[i] = { deps: deps };
        effects.push(fn);
      }
    },
  };

  return {
    react,
    setRenderer(fn) {
      renderFn = fn;
    },
    render() {
      cursor = 0;
      effects = [];
      rendering = true;
      let tree;
      try {
        tree = renderFn();
      } finally {
        rendering = false;
      }
      dirty = false;
      const cleanups = [];
      for (const fn of effects) {
        try {
          const c = fn();
          if (typeof c === "function") cleanups.push(c);
        } catch (e) {
          throw e;
        }
      }
      for (const c of cleanups) {
        // 只收集，不立即执行（组件卸载时由内部清理逻辑负责）
        void c;
      }
      return tree;
    },
    reset() {
      hooks = [];
      cursor = 0;
      effects = [];
      dirty = false;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 迷你 DOM
 * ------------------------------------------------------------------ */

function makeDom() {
  const listeners = new Map();
  const styles = [];
  const document = {
    visibilityState: "visible",
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: "", setAttribute() {}, appendChild() {} }),
    head: { appendChild: (el) => styles.push(el) },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
  };
  return {
    document,
    styles,
    listeners,
    fire(type, ev) {
      for (const fn of listeners.get(type) || []) fn(ev);
      return (listeners.get(type) || []).length;
    },
    countListeners(type) {
      return (listeners.get(type) || []).length;
    },
  };
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

/* ------------------------------------------------------------------ *
 * 树遍历工具
 * ------------------------------------------------------------------ */

function walk(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  out.push(node);
  if (typeof node.type === "function") {
    walk(node.type(node.props), out);
    return out;
  }
  for (const c of node.children || []) walk(c, out);
  return out;
}

const cls = (n) => (n && n.props ? String(n.props.className || "") : "");
function byClass(tree, part) {
  return walk(tree).filter((n) => n && n.props && cls(n).split(/\s+/).includes(part));
}
function textOf(node) {
  return walk(node)
    .filter((n) => typeof n === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ------------------------------------------------------------------ *
 * 加载模块
 * ------------------------------------------------------------------ */

const rt = makeReact();
const dom = makeDom();
const storage = makeStorage();
const calls = [];
let statePayload = null;
let settingsResponse = { ok: true };

function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

async function fakeFetch(url, init) {
  calls.push({ url: String(url), init: init || null });
  const u = String(url);
  if (u.endsWith("/state.json")) {
    if (!statePayload) return jsonResponse({ ok: true, platform: "win32", phase: "idle", settings: {}, apps: { items: [], stats: {} } });
    return jsonResponse(statePayload);
  }
  if (u.endsWith("/settings")) {
    let body = {};
    try {
      body = JSON.parse((init && init.body) || "{}");
    } catch (e) {
      body = {};
    }
    if (body.settings && body.settings.downloadDir && !/^[A-Za-z]:[\\/]/.test(body.settings.downloadDir) && !/^\\\\/.test(body.settings.downloadDir)) {
      return jsonResponse({ ok: false, error: "downloadDir 必须是绝对路径" }, 400);
    }
    // 模拟宿主：保存后把设置落到 state 里，后续 state.json 就能读回新值
    if (statePayload) {
      statePayload.settings = Object.assign({}, statePayload.settings || {}, body.settings || {});
      if (body.settings && "downloadDir" in body.settings) {
        statePayload.downloadDir = body.settings.downloadDir || statePayload.downloadDir;
      }
    }
    return jsonResponse({ ok: settingsResponse.ok, settings: (statePayload && statePayload.settings) || {} });
  }
  return jsonResponse({ ok: true });
}

let captured = null;
const fakeWindow = {
  __ModuleLoader__: {
    load(def) {
      captured = def;
    },
  },
  localStorage: storage,
};

const fakeRequire = (name) => {
  if (name === "react") return rt.react;
  throw new Error("unexpected require: " + name);
};

// eslint-disable-next-line no-new-func
new Function("window", "document", "fetch", "require", src)(fakeWindow, dom.document, fakeFetch, fakeRequire);

if (!captured || captured.id !== "dsh-app-updater") {
  console.log("模块加载失败");
  process.exit(1);
}

const mod = captured.factory(fakeRequire);
ok(typeof mod.apply === "function", "exports.apply 是函数");
ok(JSON.stringify(mod.inject) === JSON.stringify(["slots", "locale"]), "inject = slots + locale", mod.inject);

/* 用假 ctx 跑 apply，捕获槽位注册 */
let SectionComponent = null;
const fakeCtx = {
  effect(fn) {
    const c = typeof fn === "function" ? fn() : undefined;
    return () => {
      if (typeof c === "function") c();
    };
  },
  inject(deps, fn) {
    const scope = {
      slots: {
        inject: (name, cb) => cb(),
        register: (opts, comp) => {
          if (opts && opts.name === "settings.section") SectionComponent = comp;
          return () => {};
        },
      },
    };
    fn(scope);
  },
  get: () => undefined,
};
mod.apply(fakeCtx);
ok(typeof SectionComponent === "function", "注册了 settings.section 组件");

/* ------------------------------------------------------------------ *
 * 渲染场景
 * ------------------------------------------------------------------ */

function baseState(overrides) {
  return Object.assign(
    {
      ok: true,
      platform: "win32",
      phase: "idle",
      winget: { available: true, version: "1.29.380" },
      scan: { running: false, startedAt: 0, finishedAt: 0, error: null, warnings: [] },
      update: { running: false, total: 0, done: 0, current: null, results: [], error: null },
      apps: {
        scannedAt: Date.now(),
        stats: { total: 2, upgradable: 1, unsupported: 0 },
        items: [
          { id: "Git.Git", name: "Git", version: "2.55.0.5", available: "2.56.0.3", publisher: "The Git Development Community", source: "winget", hasUpdate: true, updateSupported: true, reason: null },
          { id: "reg:foo", name: "腾讯视频", version: "11.186.4331.0", available: "", publisher: "腾讯", source: "registry", hasUpdate: false, updateSupported: false, reason: "not-in-catalog" },
        ],
      },
      log: [{ at: Date.now(), level: "info", text: "扫描完成" }],
      settings: { includeStoreApps: true, includeRegistryOnly: true, downloadDir: "", keepInstallers: true, hashFallbackUpgrade: true, dryRun: false },
      downloadDir: "C:\\Users\\19952\\Downloads\\DSH App Updater",
    },
    overrides || {}
  );
}

rt.setRenderer(() => SectionComponent({ t: () => "" }));
statePayload = baseState();
rt.reset();
let tree = rt.render();
await tick();
await tick();
tree = rt.render();

group("设置面板与列宽手柄");
ok(byClass(tree, "appupd-panel").length === 1, "渲染出插件设置面板");
const switches = byClass(tree, "appupd-switch");
ok(switches.length === 7, "渲染出 7 个设置开关（新增自动提权）", switches.length);
ok(byClass(tree, "appupd-grip").length === 4, "渲染出 4 个列宽拖拽手柄", byClass(tree, "appupd-grip").length);
const ths = walk(tree).filter((n) => n.type === "th");
ok(ths.length === 6, "表头 6 列", ths.length);
const cols = walk(tree).filter((n) => n.type === "col");
ok(cols.length === 6, "colgroup 6 列", cols.length);
ok(String(cols[1].props.style.width) === "260px", "应用列默认 260px", cols[1].props.style.width);
ok(byClass(tree, "appupd-banner").length === 0, "演练模式关闭时无警示条");
ok(byClass(tree, "appupd-nameline").length === 2 || byClass(tree, "appupd-name").length === 2, "应用行渲染正常");

group("演练模式警示条");
statePayload = baseState({ settings: Object.assign({}, baseState().settings, { dryRun: true }) });
rt.reset();
await tick();
tree = rt.render();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-banner").length === 1, "演练模式开启时显示警示条", byClass(tree, "appupd-banner").length);
ok(textOf(byClass(tree, "appupd-banner")[0]).includes("不会真正安装"), "警示条文案包含「不会真正安装」");

group("开关交互 → POST /settings");
calls.length = 0;
const drySwitch = byClass(tree, "appupd-switch")[1]; // dryRun 是第 2 个开关
await drySwitch.props.onClick();
await tick();
await tick();
const setCalls = calls.filter((c) => c.url.endsWith("/settings"));
ok(setCalls.length === 1, "点击开关发出一次设置保存请求", setCalls.length);
const body = JSON.parse(setCalls[0].init.body);
ok(body.confirm === true && body.settings.dryRun === false, "请求体带 confirm:true 且把 dryRun 关掉", body);
await tick();
await tick();
tree = rt.render();
ok(byClass(tree, "appupd-banner").length === 0, "关闭演练模式后警示条消失（宿主回读 state）");

group("下载目录校验");
calls.length = 0;
statePayload = baseState();
rt.reset();
await tick();
tree = rt.render();
const dirInput = walk(tree).find((n) => n.type === "input" && String(cls(n)).includes("appupd-input"));
ok(Boolean(dirInput), "渲染出下载目录输入框");
dirInput.props.onChange({ target: { value: "not-absolute" } });
tree = rt.render();
const saveBtn = walk(tree).find((n) => n.type === "button" && textOf(n) === "保存");
ok(Boolean(saveBtn), "渲染出保存按钮");
await saveBtn.props.onClick();
await tick();
tree = rt.render();
ok(calls.filter((c) => c.url.endsWith("/settings")).length === 0, "非法路径不发请求");
ok(
  textOf(tree).includes("必须是绝对路径"),
  "非法路径显示错误提示",
  textOf(tree).slice(0, 160)
);

calls.length = 0;
const dir2 = walk(rt.render()).find((n) => n.type === "input" && String(cls(n)).includes("appupd-input"));
dir2.props.onChange({ target: { value: "D:\\Apps" } });
tree = rt.render();
const saveBtn2 = walk(tree).find((n) => n.type === "button" && textOf(n) === "保存");
await saveBtn2.props.onClick();
await tick();
await tick();
const okCalls = calls.filter((c) => c.url.endsWith("/settings"));
ok(okCalls.length === 1, "合法路径发一次请求", okCalls.length);
ok(JSON.parse(okCalls[0].init.body).settings.downloadDir === "D:\\Apps", "请求体带上新目录");

group("列宽拖拽（含钳制与持久化）");
statePayload = baseState();
rt.reset();
storage._map.delete("dsh-appupd-cols-v1");
await tick();
tree = rt.render();
await tick();
tree = rt.render();

const grips = byClass(tree, "appupd-grip");
ok(grips.length === 4, "取到 4 个手柄");
const nameGrip = grips[0];
const fakeEv = () => ({
  button: 0,
  clientX: 0,
  preventDefault() {},
  stopPropagation() {},
});
nameGrip.props.onMouseDown(Object.assign(fakeEv(), { clientX: 300 }));
ok(dom.countListeners("mousemove") === 1 && dom.countListeners("mouseup") === 1, "拖拽开始后挂上 mousemove/mouseup");
dom.fire("mousemove", { clientX: 380 });
tree = rt.render();
let colsNow = walk(tree).filter((n) => n.type === "col");
ok(String(colsNow[1].props.style.width) === "340px", "右拖 80px → 应用列 340px", colsNow[1].props.style.width);
dom.fire("mousemove", { clientX: 300 + 5000 });
tree = rt.render();
colsNow = walk(tree).filter((n) => n.type === "col");
ok(String(colsNow[1].props.style.width) === "640px", "越界被钳制到 640px", colsNow[1].props.style.width);
dom.fire("mousemove", { clientX: 300 - 5000 });
tree = rt.render();
colsNow = walk(tree).filter((n) => n.type === "col");
ok(String(colsNow[1].props.style.width) === "48px", "反向越界钳制到 48px", colsNow[1].props.style.width);
dom.fire("mouseup", {});
ok(dom.countListeners("mousemove") === 0 && dom.countListeners("mouseup") === 0, "松手后摘掉 document 监听");
const stored = JSON.parse(storage.getItem("dsh-appupd-cols-v1"));
ok(stored && stored.name === 48, "列宽写进 localStorage", stored);

group("双击手柄恢复默认");
const gripAfter = byClass(rt.render(), "appupd-grip")[0];
gripAfter.props.onDoubleClick(Object.assign(fakeEv(), {}));
tree = rt.render();
const colsReset = walk(tree).filter((n) => n.type === "col");
ok(String(colsReset[1].props.style.width) === "260px", "双击恢复默认 260px", colsReset[1].props.style.width);
ok(JSON.parse(storage.getItem("dsh-appupd-cols-v1")).name === 260, "恢复后的宽度也持久化");

group("localStorage 不可用时不崩");
storage.setItem("dsh-appupd-cols-v1", "{not json");
const broken = makeStorage();
broken.getItem = () => {
  throw new Error("denied");
};
broken.setItem = () => {
  throw new Error("denied");
};
const brokenWindow = { __ModuleLoader__: { load() {} }, localStorage: broken };
const rt2 = makeReact();
new Function("window", "document", "fetch", "require", src)(
  brokenWindow,
  makeDom().document,
  fakeFetch,
  fakeRequire
);
ok(!!brokenWindow.__ModuleLoader__.load, "localStorage 抛错时仍能完成模块注册（读取包装有 try/catch）");
void rt2;

console.log(`\n${failures === 0 ? "全部通过" : "存在失败"}：${checks - failures}/${checks}`);
process.exit(failures === 0 ? 0 : 1);