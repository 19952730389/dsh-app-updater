window.__ModuleLoader__.load({
  id: "dsh-app-updater",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require("react");
    const h = react.createElement;

    /* ------------------------------------------------------------------ *
     * 常量
     * ------------------------------------------------------------------ */

    const STATE_URL = "/dsh-app-updater/state.json";
    const SCAN_URL = "/dsh-app-updater/scan";
    const UPDATE_URL = "/dsh-app-updater/update";
    const CANCEL_URL = "/dsh-app-updater/cancel";
    const OPEN_DOWNLOADS_URL = "/dsh-app-updater/open-downloads";
    const SETTINGS_URL = "/dsh-app-updater/settings";

    const POLL_BUSY_MS = 900; // 扫描 / 更新进行中
    const POLL_IDLE_MS = 5000; // 空闲
    const LOG_LIMIT = 100;

    /* 本地记住的界面偏好（localStorage 不可用时静默降级为内存默认值） */
    const STORE_COLS_KEY = "dsh-appupd-cols-v1";
    const STORE_SETTINGS_OPEN_KEY = "dsh-appupd-settings-open";

    /* 列宽：默认给足，应用名不再被压到看不全；每列可手动拖拽调整 */
    const DEFAULT_COLS = { name: 260, version: 96, available: 96, state: 108 };
    const RESIZABLE_COLS = ["name", "version", "available", "state"];
    const COL_LABELS = { name: "应用", version: "已装版本", available: "可升级到", state: "状态" };
    const CHECK_COL_PX = 28;
    const OP_COL_PX = 62;
    const MIN_COL_PX = 48;
    const MAX_COL_PX = 640;

    /* 设置项 → 中文标签与说明 */
    const TOGGLES = [
      {
        key: "keepInstallers",
        label: "保留安装包",
        hint: "关闭后，安装完成即删除该应用刚下载的安装包",
      },
      {
        key: "dryRun",
        label: "演练模式",
        hint: "只从官网下载完整安装包，不执行安装",
        warn: true,
      },
      {
        key: "matchSystemArch",
        label: "按本机架构安装包",
        hint: "按当前系统与芯片（Windows ARM64 / x64、Apple Silicon / Intel）挑选对应安装包",
      },
      {
        key: "autoElevate",
        label: "自动提权安装",
        hint: "需要管理员的安装包（MSI、写入 Program Files）改由管理员上下文执行；UAC 开启时每次安装会弹一次确认",
      },
      {
        key: "hashFallbackUpgrade",
        label: "下载失败时回退 winget",
        hint: "官网包哈希与目录记录不一致时，改用 winget 安装同源全量包",
      },
      {
        key: "includeStoreApps",
        label: "包含应用商店应用",
        hint: "商店 / MSIX 应用只列出，更新仍由 Microsoft Store 负责",
      },
      {
        key: "includeRegistryOnly",
        label: "包含目录未收录应用",
        hint: "用注册表补齐 winget 目录未收录的软件（只列出，无法自动更新）",
      },
    ];

    const REASON_TEXT = {
      "not-in-catalog": "软件目录未收录",
      "unknown-version": "版本未知",
      "system-component": "系统组件",
      pinned: "版本被固定",
      "store-managed": "由应用商店管理",
    };

    const SOURCE_TEXT = {
      winget: "winget",
      msstore: "msstore",
      registry: "registry",
      homebrew: "homebrew",
    };

    /** 引擎显示名 */
    const ENGINE_TEXT = {
      winget: "winget",
      homebrew: "Homebrew",
      none: "无可用更新引擎",
    };

    /* ------------------------------------------------------------------ *
     * 样式（宿主 CSS 变量 + fallback，全部 appupd- 前缀）
     * ------------------------------------------------------------------ */

    const CSS = [
      ".appupd-root{display:flex;flex-direction:column;gap:10px;font-size:13px;color:inherit;min-width:0;}",

      /* 工具条 */
      ".appupd-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".appupd-title{font-size:14px;font-weight:600;margin-right:auto;color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".appupd-btn{font-family:inherit;font-size:12px;line-height:1.5;padding:4px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#4b5563);background:var(--dsw-alias-bg-layer-2,#374151);color:var(--dsw-alias-label-primary,#f3f4f6);cursor:pointer;white-space:nowrap;transition:border-color .15s ease,background .15s ease;}",
      ".appupd-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f8cff);}",
      ".appupd-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:1px;}",
      ".appupd-btn:disabled{opacity:.45;cursor:default;}",
      ".appupd-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f8cff));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f8cff));color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600;}",
      ".appupd-btn-quiet{background:transparent;}",

      /* 状态行 */
      ".appupd-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);min-height:18px;}",
      ".appupd-status-strong{color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-err{color:#f87171;}",
      ".appupd-sep{opacity:.45;}",

      /* 进度 */
      ".appupd-progress{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2,rgba(55,65,81,.35));}",
      ".appupd-progress-head{display:flex;align-items:center;gap:8px;font-size:12px;min-width:0;color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-progress-count{font-variant-numeric:tabular-nums;font-weight:600;flex:none;}",
      ".appupd-progress-name{color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
      ".appupd-progress-track{height:6px;border-radius:3px;background:rgba(128,128,128,.28);overflow:hidden;}",
      ".appupd-progress-fill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary,#4f8cff);transition:width .25s ease;}",

      /* 筛选行 */
      ".appupd-filter{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".appupd-search{font-family:inherit;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#4b5563);background:transparent;color:inherit;flex:1 1 200px;max-width:320px;min-width:140px;}",
      ".appupd-search::placeholder{color:var(--dsw-alias-label-secondary,#9ca3af);}",
      ".appupd-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:1px;}",
      ".appupd-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:6px;overflow:hidden;}",
      ".appupd-seg-btn{font-family:inherit;font-size:12px;padding:4px 10px;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);border:0;border-right:1px solid var(--dsw-alias-border-l1,#4b5563);cursor:pointer;white-space:nowrap;}",
      ".appupd-seg-btn:last-child{border-right:0;}",
      ".appupd-seg-btn:hover{color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-seg-btn-on{background:var(--dsw-alias-bg-layer-2,#374151);color:var(--dsw-alias-label-primary,#f3f4f6);font-weight:600;}",
      ".appupd-count{font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);margin-left:auto;white-space:nowrap;}",

      /* 表格 */
      ".appupd-tablewrap{max-height:min(52vh,520px);overflow-y:auto;overflow-x:auto;border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:8px;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.45) transparent;}",
      ".appupd-tablewrap::-webkit-scrollbar{width:8px;height:8px;}",
      ".appupd-tablewrap::-webkit-scrollbar-thumb{background:rgba(148,163,184,.4);border-radius:4px;}",
      ".appupd-tablewrap::-webkit-scrollbar-track{background:transparent;}",
      ".appupd-table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;table-layout:fixed;}",
      ".appupd-table thead th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2,#374151);color:var(--dsw-alias-label-secondary,#9ca3af);font-weight:600;font-size:11px;text-align:left;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#4b5563);white-space:nowrap;}",
      ".appupd-table tbody td{padding:3px 8px;height:30px;border-bottom:1px solid rgba(128,128,128,.16);vertical-align:middle;overflow:hidden;}",
      ".appupd-table tbody tr:last-child td{border-bottom:0;}",
      ".appupd-table tbody tr:hover td{background:rgba(128,128,128,.08);}",
      ".appupd-th{position:relative;}",
      ".appupd-col-check{padding-left:10px !important;padding-right:0 !important;}",
      ".appupd-col-ver,.appupd-col-op{white-space:nowrap;}",
      ".appupd-col-op{text-align:right;padding-right:10px !important;}",
      ".appupd-grip{position:absolute;top:0;right:-3px;width:7px;height:100%;cursor:col-resize;z-index:2;background:transparent;}",
      ".appupd-grip::after{content:'';position:absolute;top:22%;right:3px;width:1px;height:56%;background:var(--dsw-alias-border-l1,#4b5563);}",
      ".appupd-grip:hover::after,.appupd-grip-on::after{background:var(--dsw-alias-brand-primary,#4f8cff);width:2px;}",
      ".appupd-cb{margin:0;accent-color:var(--dsw-alias-brand-primary,#4f8cff);cursor:pointer;vertical-align:middle;}",
      ".appupd-cb:disabled{cursor:default;opacity:.45;}",
      ".appupd-nameline{display:flex;align-items:center;gap:6px;min-width:0;}",
      ".appupd-name{font-size:12px;color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
      ".appupd-pub{font-size:11px;line-height:1.25;color:var(--dsw-alias-label-secondary,#9ca3af);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".appupd-ver{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#9ca3af);}",
      ".appupd-ver-new{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-brand-primary,#4f8cff);}",
      ".appupd-muted{color:var(--dsw-alias-label-secondary,#9ca3af);}",
      ".appupd-badge{display:inline-block;font-size:10px;line-height:15px;padding:0 5px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,#4b5563);color:var(--dsw-alias-label-secondary,#9ca3af);white-space:nowrap;flex:none;}",
      ".appupd-badge-winget{border-color:rgba(79,140,255,.55);color:var(--dsw-alias-brand-primary,#4f8cff);}",
      ".appupd-badge-msstore{border-color:rgba(52,211,153,.55);color:#34d399;}",
      ".appupd-badge-registry{border-color:rgba(148,163,184,.5);}",
      ".appupd-badge-homebrew{border-color:rgba(251,191,36,.55);color:#fbbf24;}",
      ".appupd-envline{font-size:12px;color:var(--dsw-alias-label-primary,#f3f4f6);word-break:break-word;}",
      ".appupd-state-new{font-weight:600;color:var(--dsw-alias-brand-primary,#4f8cff);white-space:nowrap;}",
      ".appupd-state-ok{color:#34d399;white-space:nowrap;}",
      ".appupd-state-none{color:var(--dsw-alias-label-secondary,#9ca3af);white-space:nowrap;}",
      ".appupd-reason{font-size:10px;line-height:1.2;color:var(--dsw-alias-label-secondary,#9ca3af);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".appupd-rowbtn{font-family:inherit;font-size:11px;padding:2px 10px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1,#4b5563);background:transparent;color:var(--dsw-alias-label-primary,#f3f4f6);cursor:pointer;white-space:nowrap;}",
      ".appupd-rowbtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f8cff);color:var(--dsw-alias-brand-primary,#4f8cff);}",
      ".appupd-rowbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:1px;}",
      ".appupd-rowbtn:disabled{opacity:.4;cursor:default;}",
      ".appupd-empty-cell{padding:24px 12px !important;text-align:center;color:var(--dsw-alias-label-secondary,#9ca3af);}",

      /* 空态 */
      ".appupd-empty{padding:26px 12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);border:1px dashed var(--dsw-alias-border-l1,#4b5563);border-radius:8px;}",

      /* 日志 */
      ".appupd-log{border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:8px;overflow:hidden;}",
      ".appupd-log-head{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;background:transparent;border:0;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;text-align:left;}",
      ".appupd-log-head:hover{color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-log-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:-2px;}",
      ".appupd-log-caret{display:inline-block;width:10px;flex:none;opacity:.8;}",
      ".appupd-log-body{max-height:200px;overflow-y:auto;padding:2px 10px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.65;scrollbar-width:thin;scrollbar-color:rgba(148,163,184,.45) transparent;}",
      ".appupd-log-line{display:flex;gap:8px;white-space:pre-wrap;word-break:break-word;}",
      ".appupd-log-time{flex:none;color:var(--dsw-alias-label-secondary,#9ca3af);opacity:.75;}",
      ".appupd-lv-error{color:#f87171;}",
      ".appupd-lv-warn{color:#fbbf24;}",
      ".appupd-lv-success{color:#34d399;}",
      ".appupd-lv-info{color:var(--dsw-alias-label-secondary,#9ca3af);}",

      /* 演练模式警示条 */
      ".appupd-banner{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;border:1px solid rgba(251,191,36,.5);background:rgba(251,191,36,.12);color:#fbbf24;font-size:12px;}",
      /* 兼容模式（仅回环放行）警示条：默认关闭，开启时用红色提醒 */
      ".appupd-banner-warn{border-color:rgba(239,68,68,.55);background:rgba(239,68,68,.12);color:#f87171;}",

      /* 插件设置面板 */
      ".appupd-panel{border:1px solid var(--dsw-alias-border-l1,#4b5563);border-radius:8px;overflow:hidden;}",
      ".appupd-panel-head{display:flex;align-items:center;gap:6px;width:100%;padding:6px 10px;background:transparent;border:0;font-family:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#9ca3af);cursor:pointer;text-align:left;}",
      ".appupd-panel-head:hover{color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-panel-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:-2px;}",
      ".appupd-panel-body{display:flex;flex-direction:column;gap:9px;padding:2px 10px 10px;border-top:1px solid rgba(128,128,128,.16);}",
      ".appupd-field{display:flex;align-items:flex-start;gap:10px;}",
      ".appupd-field-label{flex:0 0 152px;padding-top:3px;font-size:12px;color:var(--dsw-alias-label-primary,#f3f4f6);}",
      ".appupd-field-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:3px;}",
      ".appupd-field-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
      ".appupd-hint{font-size:11px;line-height:1.35;color:var(--dsw-alias-label-secondary,#9ca3af);}",
      ".appupd-input{font-family:inherit;font-size:12px;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#4b5563);background:transparent;color:inherit;flex:1 1 200px;min-width:140px;}",
      ".appupd-input::placeholder{color:var(--dsw-alias-label-secondary,#9ca3af);}",
      ".appupd-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:1px;}",
      ".appupd-switch{position:relative;flex:none;width:36px;height:20px;margin-top:2px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1,#4b5563);background:rgba(128,128,128,.35);cursor:pointer;padding:0;transition:background .16s ease,border-color .16s ease;}",
      ".appupd-switch::after{content:'';position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .16s ease;}",
      ".appupd-switch-on{background:var(--dsw-alias-brand-primary,#4f8cff);border-color:var(--dsw-alias-brand-primary,#4f8cff);}",
      ".appupd-switch-on::after{left:18px;}",
      ".appupd-switch:disabled{opacity:.45;cursor:default;}",
      ".appupd-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4f8cff);outline-offset:2px;}",

      /* 降低动效 */
      "@media (prefers-reduced-motion: reduce){.appupd-btn,.appupd-progress-fill,.appupd-rowbtn,.appupd-seg-btn,.appupd-switch,.appupd-switch::after{transition:none !important;}}",
    ].join("");

    /* ------------------------------------------------------------------ *
     * 工具函数
     * ------------------------------------------------------------------ */

    function errText(e) {
      if (!e) return "未知错误";
      if (typeof e === "string") return e;
      const m = e.message || e.error || "";
      return String(m || e);
    }

    async function getJson(url) {
      const r = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }

    async function postJson(url, body) {
      const r = await fetch(url, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      let j = null;
      try {
        j = await r.json();
      } catch (e) {
        j = null;
      }
      if (!r.ok) throw new Error((j && (j.error || j.message)) || "HTTP " + r.status);
      if (j && j.ok === false) throw new Error(j.error || "请求被拒绝");
      return j;
    }

    function pad2(n) {
      return n < 10 ? "0" + n : String(n);
    }

    function fmtClock(ts) {
      const d = new Date(typeof ts === "number" && ts > 0 ? ts : Date.now());
      return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
    }

    function fmtRel(ts, now) {
      if (typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "从未";
      const diff = Math.max(0, (now || Date.now()) - ts);
      if (diff < 5000) return "刚刚";
      if (diff < 60000) return Math.floor(diff / 1000) + " 秒前";
      if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
      if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
      return Math.floor(diff / 86400000) + " 天前";
    }

    function reasonText(app) {
      const r = app && app.reason;
      if (!r) return "";
      return REASON_TEXT[r] || String(r);
    }

    /** 引擎状态文案：winget 1.29.380 / Homebrew 4.5.0 / 无可用更新引擎 */
    function engineTextOf(engine) {
      if (!engine || !engine.id) return "引擎状态未知";
      const name = ENGINE_TEXT[engine.id] || engine.id;
      if (engine.available === false) return name + " 不可用";
      return engine.version ? name + " " + engine.version : name + " 可用";
    }

    /* ---------------- 本地偏好（列宽 / 面板展开） ---------------- */

    /** localStorage 包装：不可用（隐私模式、无 window）时静默降级为默认值。 */
    function readStore(key, fallback) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return fallback;
        const v = window.localStorage.getItem(key);
        return v === null ? fallback : v;
      } catch (e) {
        return fallback;
      }
    }

    function writeStore(key, value) {
      try {
        if (typeof window === "undefined" || !window.localStorage) return;
        window.localStorage.setItem(key, String(value));
      } catch (e) {
        /* 存不下就只当记不住偏好，不影响功能 */
      }
    }

    function clampWidth(px) {
      const n = Math.round(Number(px) || 0);
      if (!isFinite(n)) return MIN_COL_PX;
      return Math.max(MIN_COL_PX, Math.min(MAX_COL_PX, n));
    }

    function loadCols() {
      const out = Object.assign({}, DEFAULT_COLS);
      const raw = readStore(STORE_COLS_KEY, "");
      if (!raw) return out;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          for (const key of RESIZABLE_COLS) {
            if (typeof parsed[key] === "number") out[key] = clampWidth(parsed[key]);
          }
        }
      } catch (e) {
        /* 存的内容坏了就用默认值 */
      }
      return out;
    }

    function saveCols(cols) {
      try {
        const slim = {};
        for (const key of RESIZABLE_COLS) slim[key] = clampWidth(cols[key]);
        writeStore(STORE_COLS_KEY, JSON.stringify(slim));
      } catch (e) {
        /* 忽略 */
      }
    }

    /** 下载目录校验：留空 = 使用默认目录；否则必须是绝对路径（盘符或 UNC）。 */
    const DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/;
    const UNC_ABS_RE = /^\\\\[^\\]/;

    function isAbsoluteDir(p) {
      const v = String(p == null ? "" : p).trim();
      if (!v) return true;
      return DRIVE_ABS_RE.test(v) || UNC_ABS_RE.test(v);
    }

    function toggleLabel(key) {
      for (const t of TOGGLES) {
        if (t.key === key) return t.label;
      }
      return key;
    }

    /* ------------------------------------------------------------------ *
     * 设置页
     * ------------------------------------------------------------------ */

    function AppUpdaterSection() {
      const [state, setState] = react.useState(null);
      const [loadError, setLoadError] = react.useState(null);
      const [localLog, setLocalLog] = react.useState([]);
      const [query, setQuery] = react.useState("");
      const [mode, setMode] = react.useState("all");
      const [selected, setSelected] = react.useState({});
      const [busy, setBusy] = react.useState({ scan: false, update: false, cancel: false, open: false });
      const [logOpen, setLogOpen] = react.useState(false);
      const [now, setNow] = react.useState(Date.now());

      const phaseRef = react.useRef("idle");
      const inFlightRef = react.useRef(false);
      const pollFailRef = react.useRef(false);

      /* 列宽（可拖拽调整、本地记住） */
      const [cols, setCols] = react.useState(loadCols);
      const [resizingCol, setResizingCol] = react.useState(null);
      const colsRef = react.useRef(cols);
      const dragRef = react.useRef(null);
      const dragCleanupRef = react.useRef(null);

      /* 设置面板 */
      const [settingsOpen, setSettingsOpen] = react.useState(
        () => readStore(STORE_SETTINGS_OPEN_KEY, "1") === "1"
      );
      const [dirDraft, setDirDraft] = react.useState("");
      const [dirTouched, setDirTouched] = react.useState(false);
      const [settingsBusy, setSettingsBusy] = react.useState(false);
      const [settingsError, setSettingsError] = react.useState(null);

      const pushLog = react.useCallback((level, text) => {
        setLocalLog((prev) => {
          const next = prev.concat([{ at: Date.now(), level: level, text: String(text) }]);
          return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next;
        });
      }, []);

      const refresh = react.useCallback(async () => {
        if (inFlightRef.current) return;
        inFlightRef.current = true;
        try {
          const j = await getJson(STATE_URL);
          if (j && typeof j === "object") {
            setState(j);
            setLoadError(null);
            pollFailRef.current = false;
          }
        } catch (e) {
          setLoadError(errText(e));
          if (!pollFailRef.current) {
            pollFailRef.current = true;
            pushLog("error", "读取状态失败：" + errText(e));
          }
        } finally {
          inFlightRef.current = false;
        }
      }, [pushLog]);

      /* 让轮询循环读到最新的 phase，而不必重建定时器 */
      react.useEffect(() => {
        phaseRef.current = (state && state.phase) || "idle";
      }, [state]);

      /* 相对时间每 10s 刷新一次 */
      react.useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 10000);
        return () => clearInterval(id);
      }, []);

      /* 轮询：忙 900ms / 空闲 5000ms；页面不可见时暂停 */
      react.useEffect(() => {
        let timer = null;
        let disposed = false;

        const clearTimer = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };
        const isVisible = () =>
          typeof document === "undefined" || document.visibilityState === "visible";
        const schedule = () => {
          clearTimer();
          if (disposed) return;
          timer = setTimeout(tick, phaseRef.current !== "idle" ? POLL_BUSY_MS : POLL_IDLE_MS);
        };
        const tick = async () => {
          if (disposed) return;
          if (!isVisible()) {
            clearTimer();
            return;
          }
          await refresh();
          schedule();
        };
        const onVisibility = () => {
          if (disposed) return;
          if (isVisible()) {
            clearTimer();
            tick();
          } else {
            clearTimer();
          }
        };

        tick();
        if (typeof document !== "undefined") {
          document.addEventListener("visibilitychange", onVisibility);
        }
        return () => {
          disposed = true;
          clearTimer();
          if (typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", onVisibility);
          }
        };
      }, [refresh]);

      /* ---------------- 列宽：拖拽调整 + 本地记忆 ---------------- */

      react.useEffect(() => {
        colsRef.current = cols;
      }, [cols]);

      /* 组件卸载时，若还在拖拽则摘掉 document 上的监听 */
      react.useEffect(() => {
        return () => {
          if (dragCleanupRef.current) dragCleanupRef.current();
          dragCleanupRef.current = null;
          dragRef.current = null;
        };
      }, []);

      const applyDrag = (clientX) => {
        const drag = dragRef.current;
        if (!drag) return;
        const width = clampWidth(drag.startWidth + (clientX - drag.startX));
        setCols((prev) => (prev[drag.key] === width ? prev : Object.assign({}, prev, { [drag.key]: width })));
      };

      const onColResizeStart = (key, e) => {
        if (!e || (e.button !== undefined && e.button !== 0)) return;
        if (typeof document === "undefined") return;
        e.preventDefault();
        e.stopPropagation();
        if (dragCleanupRef.current) dragCleanupRef.current();

        dragRef.current = { key: key, startX: e.clientX, startWidth: colsRef.current[key] || DEFAULT_COLS[key] };
        setResizingCol(key);

        const onMove = (ev) => applyDrag(ev.clientX);
        const finish = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", finish);
          dragRef.current = null;
          dragCleanupRef.current = null;
          setResizingCol(null);
          saveCols(colsRef.current);
        };
        const cleanup = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", finish);
        };
        dragCleanupRef.current = cleanup;
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", finish);
      };

      const onColReset = (key, e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        setCols((prev) => {
          const next = Object.assign({}, prev, { [key]: DEFAULT_COLS[key] });
          saveCols(next);
          return next;
        });
      };

      /* ---------------- 设置面板 ---------------- */

      /* 宿主返回的生效目录：只在用户没动过输入框时同步到草稿 */
      react.useEffect(() => {
        if (dirTouched) return;
        const s = (state && state.settings) || null;
        setDirDraft(s && typeof s.downloadDir === "string" ? s.downloadDir : "");
      }, [state, dirTouched]);

      const toggleSettingsPanel = () => {
        setSettingsOpen((v) => {
          const next = !v;
          writeStore(STORE_SETTINGS_OPEN_KEY, next ? "1" : "0");
          return next;
        });
      };

      const saveSettings = react.useCallback(
        async (patch, okText) => {
          setSettingsBusy(true);
          setSettingsError(null);
          try {
            const r = await postJson(SETTINGS_URL, { confirm: true, settings: patch });
            if (okText) pushLog("success", okText);
            await refresh();
            return true;
          } catch (e) {
            const msg = errText(e);
            setSettingsError(msg);
            pushLog("error", "保存设置失败：" + msg);
            return false;
          } finally {
            setSettingsBusy(false);
          }
        },
        [pushLog, refresh]
      );

      const toggleSetting = (key) => {
        const s = (state && state.settings) || {};
        const next = !s[key];
        saveSettings({ [key]: next }, (toggleLabel(key) || key) + (next ? " 已开启" : " 已关闭"));
      };

      const saveDir = async () => {
        const value = String(dirDraft || "").trim();
        if (!isAbsoluteDir(value)) {
          setSettingsError("下载目录必须是绝对路径（如 D:\\Apps）或 UNC 路径（\\\\server\\share）");
          return;
        }
        const ok = await saveSettings({ downloadDir: value }, value ? "下载目录已保存" : "已恢复默认下载目录");
        if (ok) setDirTouched(false);
      };

      const resetDir = () => {
        setDirDraft("");
        setDirTouched(false);
        saveSettings({ downloadDir: "" }, "已恢复默认下载目录");
      };

      /* ---------------- 派生数据 ---------------- */

      const phase = (state && state.phase) || "idle";
      const scanning = phase === "scanning";
      const updating = phase === "updating";
      const apps = state && state.apps ? state.apps : null;
      const items = apps && Array.isArray(apps.items) ? apps.items : null;
      const updateInfo = (state && state.update) || {};
      const winget = (state && state.winget) || null;
      const platform = state && state.platform;

      /* 运行环境（系统 / 架构）与更新引擎 */
      const env = (state && state.env) || null;
      const engine = (state && state.engine) || null;
      const caps = (state && state.capabilities) || null;
      const envSummary =
        (state && state.envSummary) ||
        (env ? [env.osName || env.platform, env.archLabel].filter(Boolean).join(" · ") : "环境未知");
      const engineText = !state ? "" : engineTextOf(engine);

      const filtered = react.useMemo(() => {
        if (!items) return [];
        const q = query.trim().toLowerCase();
        const out = [];
        for (let i = 0; i < items.length; i++) {
          const a = items[i];
          if (!a) continue;
          const canUpdate = !!(a.hasUpdate && a.updateSupported);
          if (mode === "updatable" && !canUpdate) continue;
          if (mode === "unsupported" && a.updateSupported) continue;
          if (q) {
            const hay =
              String(a.name || "") +
              " " +
              String(a.publisher || "") +
              " " +
              String(a.id || "");
            if (hay.toLowerCase().indexOf(q) < 0) continue;
          }
          out.push(a);
        }
        return out;
      }, [items, query, mode]);

      const selectableIds = react.useMemo(() => {
        const out = [];
        for (let i = 0; i < filtered.length; i++) {
          const a = filtered[i];
          if (a && a.hasUpdate && a.updateSupported && a.id) out.push(a.id);
        }
        return out;
      }, [filtered]);

      const selectedCount = react.useMemo(() => {
        let n = 0;
        for (let i = 0; i < selectableIds.length; i++) {
          if (selected[selectableIds[i]]) n++;
        }
        return n;
      }, [selectableIds, selected]);

      const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;

      const total = apps && apps.stats && typeof apps.stats.total === "number" ? apps.stats.total : items ? items.length : 0;
      const upgradable =
        apps && apps.stats && typeof apps.stats.upgradable === "number"
          ? apps.stats.upgradable
          : selectableIds.length;

      const mergedLog = react.useMemo(() => {
        const server = state && Array.isArray(state.log) ? state.log : [];
        const all = server.concat(localLog);
        all.sort((a, b) => (Number(a && a.at) || 0) - (Number(b && b.at) || 0));
        return all.slice(all.length > LOG_LIMIT ? all.length - LOG_LIMIT : 0);
      }, [state, localLog]);

      /* ---------------- 动作 ---------------- */

      const doScan = async () => {
        if (busy.scan || phase !== "idle") return;
        setBusy((b) => ({ ...b, scan: true }));
        try {
          await postJson(SCAN_URL, { confirm: true, force: true });
          pushLog("info", "已开始扫描本机应用…");
          await refresh();
        } catch (e) {
          pushLog("error", "启动扫描失败：" + errText(e));
        } finally {
          setBusy((b) => ({ ...b, scan: false }));
        }
      };

      const runUpdate = async (ids, label) => {
        const list = (ids || []).filter(Boolean);
        if (!list.length) return;
        setBusy((b) => ({ ...b, update: true }));
        try {
          const r = await postJson(UPDATE_URL, { confirm: true, ids: list, mode: "silent" });
          pushLog(
            "info",
            "已提交 " + ((r && r.queued) || list.length) + " 个更新任务" + (label ? "（" + label + "）" : "")
          );
          setSelected({});
          await refresh();
        } catch (e) {
          pushLog("error", "启动更新失败：" + errText(e));
        } finally {
          setBusy((b) => ({ ...b, update: false }));
        }
      };

      const doCancel = async () => {
        if (busy.cancel) return;
        setBusy((b) => ({ ...b, cancel: true }));
        try {
          await postJson(CANCEL_URL, { confirm: true });
          pushLog("warn", "已请求取消更新");
          await refresh();
        } catch (e) {
          pushLog("error", "取消失败：" + errText(e));
        } finally {
          setBusy((b) => ({ ...b, cancel: false }));
        }
      };

      const doOpenDownloads = async () => {
        if (busy.open) return;
        setBusy((b) => ({ ...b, open: true }));
        try {
          const r = await postJson(OPEN_DOWNLOADS_URL, { confirm: true });
          pushLog("success", "已打开下载目录" + (r && r.path ? "：" + r.path : ""));
        } catch (e) {
          pushLog("error", "打开下载目录失败：" + errText(e));
        } finally {
          setBusy((b) => ({ ...b, open: false }));
        }
      };

      const toggleOne = (id, enabled) => {
        if (!enabled) return;
        setSelected((prev) => {
          const next = { ...prev };
          if (next[id]) delete next[id];
          else next[id] = true;
          return next;
        });
      };

      const toggleAll = () => {
        if (!selectableIds.length) return;
        setSelected((prev) => {
          if (allSelected) {
            const next = { ...prev };
            for (let i = 0; i < selectableIds.length; i++) delete next[selectableIds[i]];
            return next;
          }
          const next = { ...prev };
          for (let i = 0; i < selectableIds.length; i++) next[selectableIds[i]] = true;
          return next;
        });
      };

      const updateAll = () => runUpdate(selectableIds, "当前筛选");
      const updateSelected = () => {
        const ids = selectableIds.filter((id) => selected[id]);
        return runUpdate(ids, "已选 " + ids.length + " 项");
      };

      /* ---------------- 渲染片段 ---------------- */

      const btn = (label, onClick, opts) => {
        const o = opts || {};
        return h(
          "button",
          {
            type: "button",
            className:
              "appupd-btn" +
              (o.primary ? " appupd-btn-primary" : "") +
              (o.quiet ? " appupd-btn-quiet" : ""),
            onClick: onClick,
            disabled: !!o.disabled,
            title: o.title || undefined,
          },
          label
        );
      };

      const statusCell = (a) => {
        if (a.hasUpdate && a.updateSupported) {
          return h("span", { className: "appupd-state-new" }, "有新版本");
        }
        if (a.hasUpdate && !a.updateSupported) {
          const r = reasonText(a);
          return h(
            "span",
            { className: "appupd-state-none", title: r ? "无法更新：" + r : "无法更新" },
            "未收录"
          );
        }
        return h("span", { className: "appupd-state-ok" }, "已是最新");
      };

      const rows = filtered.map((a) => {
        const key = a.id || a.name;
        const canUpdate = !!(a.hasUpdate && a.updateSupported);
        const checked = canUpdate && !!selected[key];
        const reason = canUpdate ? "" : reasonText(a);
        const rowBusy = phase !== "idle" || busy.update;
        return h(
          "tr",
          { key: key, className: "appupd-row" },
          h(
            "td",
            { className: "appupd-col-check" },
            h("input", {
              type: "checkbox",
              className: "appupd-cb",
              checked: checked,
              disabled: !canUpdate,
              onChange: () => toggleOne(key, canUpdate),
              "aria-label": "选择 " + String(a.name || key),
              title: reason || "选择以批量更新",
            })
          ),
          h(
            "td",
            null,
            h(
              "div",
              { className: "appupd-nameline" },
              h(
                "span",
                {
                  className: "appupd-name",
                  title: String(a.name || key) + (a.id ? "\n" + a.id : ""),
                },
                a.name || key
              ),
              h(
                "span",
                { className: "appupd-badge appupd-badge-" + String(a.source || "registry") },
                SOURCE_TEXT[a.source] || a.source || "未知"
              )
            ),
            a.publisher && a.publisher !== a.name
              ? h("div", { className: "appupd-pub", title: a.publisher }, a.publisher)
              : null
          ),
          h("td", { className: "appupd-col-ver" }, h("span", { className: "appupd-ver" }, a.version || "—")),
          h(
            "td",
            { className: "appupd-col-ver" },
            a.hasUpdate && a.available
              ? h("span", { className: "appupd-ver-new" }, a.available)
              : h("span", { className: "appupd-muted" }, "—")
          ),
          h(
            "td",
            { className: "appupd-col-state" },
            statusCell(a),
            reason ? h("div", { className: "appupd-reason", title: reason }, reason) : null
          ),
          h(
            "td",
            { className: "appupd-col-op" },
            h(
              "button",
              {
                type: "button",
                className: "appupd-rowbtn",
                disabled: !canUpdate || rowBusy,
                onClick: () => runUpdate([key], a.name),
                title: !canUpdate
                  ? reason
                  : rowBusy
                    ? "更新进行中，请稍候"
                    : "更新到 " + (a.available || "最新版"),
              },
              "更新"
            )
          )
        );
      });

      const emptyBody = () => {
        if (!state) return h("div", { className: "appupd-empty" }, "正在读取状态…");
        if (!items) {
          return h(
            "div",
            { className: "appupd-empty" },
            "还没有检测过，点右上角『刷新检测』开始"
          );
        }
        if (!items.length) return h("div", { className: "appupd-empty" }, "未检测到任何已安装应用");
        return h("div", { className: "appupd-empty" }, "没有匹配的应用");
      };

      const body = !items || !filtered.length ? emptyBody() : null;

      /* ---------------- 设置面板 / 演练提示 ---------------- */

      const settings = (state && state.settings) || {};
      const dryRunOn = Boolean(settings.dryRun);
      const effectiveDir = (state && state.downloadDir) || "%USERPROFILE%\\Downloads\\DSH App Updater";

      const dryRunBanner = dryRunOn
        ? h(
            "div",
            { className: "appupd-banner", role: "status" },
            h("span", null, "演练模式已开启：只从官网下载全量安装包，不会真正安装。")
          )
        : null;

      /* 兼容模式：只有用户显式开启（插件配置 / 环境变量）才会出现，默认不显示 */
      const admission = (state && state.admission) || null;
      const legacyOn = Boolean(admission && admission.allowLegacyLoopback);
      const legacyBanner = legacyOn
        ? h(
            "div",
            { className: "appupd-banner appupd-banner-warn", role: "alert" },
            h(
              "span",
              null,
              "兼容模式已开启：没有连接凭据的本机回环请求会被放行（旧宿主没有 connection 准入时才会用到）。非必要请关闭，见 README 的「安全」一节。"
            )
          )
        : null;

      const switchEl = (key) => {
        const on = Boolean(settings[key]);
        return h("button", {
          type: "button",
          className: "appupd-switch" + (on ? " appupd-switch-on" : ""),
          role: "switch",
          "aria-checked": on,
          "aria-label": toggleLabel(key),
          disabled: settingsBusy || !state,
          onClick: () => toggleSetting(key),
          title: on ? "点击关闭" : "点击开启",
        });
      };

      const settingsPanel = h(
        "div",
        { className: "appupd-panel" },
        h(
          "button",
          {
            type: "button",
            className: "appupd-panel-head",
            onClick: toggleSettingsPanel,
            "aria-expanded": settingsOpen,
          },
          h("span", { className: "appupd-log-caret" }, settingsOpen ? "▾" : "▸"),
          "插件设置"
        ),
        settingsOpen
          ? h(
              "div",
              { className: "appupd-panel-body" },
              h(
                "div",
                { className: "appupd-field" },
                h("div", { className: "appupd-field-label" }, "运行环境"),
                h(
                  "div",
                  { className: "appupd-field-main" },
                  h(
                    "div",
                    { className: "appupd-field-row" },
                    h("span", { className: "appupd-envline" }, envSummary + (engineText ? " · " + engineText : ""))
                  ),
                  env && env.cpuModel
                    ? h(
                        "div",
                        { className: "appupd-hint" },
                        env.cpuModel + (env.cpuCount ? " · " + env.cpuCount + " 线程" : "")
                      )
                    : null
                )
              ),
              caps && !caps.scan && caps.note
                ? h("div", { className: "appupd-err", style: { fontSize: 12 } }, caps.note)
                : null,
              h(
                "div",
                { className: "appupd-field" },
                h("div", { className: "appupd-field-label" }, "安装包下载目录"),
                h(
                  "div",
                  { className: "appupd-field-main" },
                  h(
                    "div",
                    { className: "appupd-field-row" },
                    h("input", {
                      className: "appupd-input",
                      type: "text",
                      value: dirDraft,
                      placeholder: effectiveDir,
                      onChange: (e) => {
                        setDirTouched(true);
                        setSettingsError(null);
                        setDirDraft(e.target.value);
                      },
                      onKeyDown: (e) => {
                        if (e.key === "Enter") saveDir();
                      },
                      "aria-label": "安装包下载目录",
                    }),
                    h(
                      "button",
                      { type: "button", className: "appupd-rowbtn", disabled: settingsBusy, onClick: saveDir },
                      settingsBusy ? "保存中…" : "保存"
                    ),
                    h(
                      "button",
                      { type: "button", className: "appupd-rowbtn", disabled: settingsBusy, onClick: resetDir },
                      "恢复默认"
                    )
                  ),
                  h(
                    "div",
                    { className: "appupd-hint" },
                    "留空 = 默认目录（" + effectiveDir + "）；从官网下载的完整安装包与对应清单一并保存在该目录"
                  )
                )
              ),
              ...TOGGLES.map((t) =>
                h(
                  "div",
                  { className: "appupd-field", key: t.key },
                  h("div", { className: "appupd-field-label" }, t.label),
                  h(
                    "div",
                    { className: "appupd-field-main" },
                    h(
                      "div",
                      { className: "appupd-field-row" },
                      switchEl(t.key),
                      h("span", { className: "appupd-hint" }, t.hint)
                    )
                  )
                )
              ),
              settingsError ? h("div", { className: "appupd-err", style: { fontSize: 12 } }, settingsError) : null
            )
          : null
      );

      /* 表格：总宽 = 各列固定宽度之和，超出容器就横向滚动（列宽即所见） */
      const colsWidth = CHECK_COL_PX + cols.name + cols.version + cols.available + cols.state + OP_COL_PX;

      const grip = (key) =>
        h("span", {
          className: "appupd-grip" + (resizingCol === key ? " appupd-grip-on" : ""),
          onMouseDown: (e) => onColResizeStart(key, e),
          onDoubleClick: (e) => onColReset(key, e),
          title:
            "拖动调整「" + COL_LABELS[key] + "」列宽（当前 " + cols[key] + "px）；双击恢复默认",
          "aria-hidden": "true",
        });

      const progress =
        updating || updateInfo.running
          ? (() => {
              const t = Number(updateInfo.total) || 0;
              const d = Number(updateInfo.done) || 0;
              const pct = t > 0 ? Math.max(0, Math.min(100, Math.round((d / t) * 100))) : 0;
              return h(
                "div",
                { className: "appupd-progress" },
                h(
                  "div",
                  { className: "appupd-progress-head" },
                  h("span", { className: "appupd-progress-count" }, d + "/" + t),
                  h(
                    "span",
                    { className: "appupd-progress-name", title: updateInfo.current || "" },
                    updateInfo.current ? "正在处理 " + updateInfo.current : "正在准备…"
                  ),
                  h("span", { className: "appupd-progress-count" }, pct + "%")
                ),
                h(
                  "div",
                  { className: "appupd-progress-track" },
                  h("div", { className: "appupd-progress-fill", style: { width: pct + "%" } })
                ),
                updateInfo.error
                  ? h("div", { className: "appupd-err", style: { fontSize: 12 } }, "更新出错：" + updateInfo.error)
                  : null
              );
            })()
          : null;

      const statusRow = h(
        "div",
        { className: "appupd-status" },
        !state
          ? h("span", null, loadError ? h("span", { className: "appupd-err" }, "无法连接宿主：" + loadError) : "正在读取状态…")
          : h(
              "span",
              engine && engine.available === false ? { className: "appupd-err" } : null,
              engineText
            ),
        state ? h("span", { className: "appupd-sep" }, "·") : null,
        state
          ? h(
              "span",
              { className: "appupd-status-strong", title: "操作系统与 CPU 架构" },
              envSummary
            )
          : null,
        state ? h("span", { className: "appupd-sep" }, "·") : null,
        state
          ? h("span", null, "上次扫描：" + fmtRel(apps && apps.scannedAt, now))
          : null,
        state ? h("span", { className: "appupd-sep" }, "·") : null,
        state
          ? h(
              "span",
              { className: "appupd-status-strong" },
              "共 " + total + " 个应用 · " + upgradable + " 个可更新"
            )
          : null,
        scanning ? h("span", null, "扫描中…") : null,
        caps && caps.note ? h("span", { className: "appupd-err" }, caps.note) : null,
        loadError && state ? h("span", { className: "appupd-err" }, "（状态刷新失败：" + loadError + "）") : null
      );

      const logLines = mergedLog.map((l, i) => {
        const level = l && l.level ? String(l.level) : "info";
        const cls =
          level === "error"
            ? "appupd-lv-error"
            : level === "warn"
              ? "appupd-lv-warn"
              : level === "success"
                ? "appupd-lv-success"
                : "appupd-lv-info";
        return h(
          "div",
          { key: i, className: "appupd-log-line" },
          h("span", { className: "appupd-log-time" }, fmtClock(l && l.at)),
          h("span", { className: cls }, (l && l.text) || "")
        );
      });

      return h(
        "div",
        { className: "appupd-root" },
        /* 1. 工具条 */
        h(
          "div",
          { className: "appupd-bar" },
          h("div", { className: "appupd-title" }, "应用更新"),
          h(
            "div",
            { className: "appupd-actions" },
            btn(busy.scan || scanning ? "检测中…" : "刷新检测", doScan, {
              primary: true,
              disabled: busy.scan || phase !== "idle",
              title: phase !== "idle" ? "当前有任务在执行" : "扫描本机已安装应用并检查更新",
            }),
            selectedCount > 0
              ? btn("更新所选 (" + selectedCount + ")", updateSelected, {
                  disabled: phase !== "idle" || busy.update,
                  title: "仅更新勾选的应用",
                })
              : null,
            btn("全部更新", updateAll, {
              disabled: phase !== "idle" || busy.update || selectableIds.length === 0,
              title:
                selectableIds.length === 0
                  ? "当前筛选下没有可更新的应用"
                  : "更新当前筛选下 " + selectableIds.length + " 个应用",
            }),
            btn(busy.cancel ? "取消中…" : "取消", doCancel, {
              quiet: true,
              disabled: !updating || busy.cancel,
              title: updating ? "取消尚未开始的更新" : "当前没有进行中的更新",
            }),
            btn("打开下载目录", doOpenDownloads, {
              quiet: true,
              disabled: busy.open,
              title:
                (state && state.settings && state.settings.downloadDir) || "在资源管理器中打开安装包下载目录",
            })
          )
        ),

        /* 2. 状态行 */
        statusRow,

        /* 3. 演练模式提示 */
        dryRunBanner,

        /* 3b. 兼容模式（仅回环放行）提示：默认不出现 */
        legacyBanner,

        /* 4. 进度 */
        progress,

        /* 5. 插件设置 */
        settingsPanel,

        /* 6. 筛选行 */
        items && items.length
          ? h(
              "div",
              { className: "appupd-filter" },
              h("input", {
                type: "search",
                className: "appupd-search",
                placeholder: "搜索应用名 / 发布者 / ID",
                value: query,
                onChange: (e) => setQuery(e.target.value),
                "aria-label": "搜索应用",
              }),
              h(
                "div",
                { className: "appupd-seg", role: "group", "aria-label": "筛选" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "appupd-seg-btn" + (mode === "all" ? " appupd-seg-btn-on" : ""),
                    onClick: () => setMode("all"),
                    "aria-pressed": mode === "all",
                  },
                  "全部"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "appupd-seg-btn" + (mode === "updatable" ? " appupd-seg-btn-on" : ""),
                    onClick: () => setMode("updatable"),
                    "aria-pressed": mode === "updatable",
                  },
                  "仅可更新"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "appupd-seg-btn" + (mode === "unsupported" ? " appupd-seg-btn-on" : ""),
                    onClick: () => setMode("unsupported"),
                    "aria-pressed": mode === "unsupported",
                  },
                  "未收录"
                )
              ),
              h(
                "span",
                { className: "appupd-count" },
                "筛选结果 " + filtered.length + " / " + items.length
              )
            )
          : null,

        /* 7. 表格 */
        body
          ? body
          : h(
              "div",
              { className: "appupd-tablewrap" },
              h(
                "table",
                {
                  className: "appupd-table",
                  style: {
                    width: colsWidth + "px",
                    minWidth: "100%",
                  },
                },
                h(
                  "colgroup",
                  null,
                  h("col", { style: { width: CHECK_COL_PX + "px" } }),
                  h("col", { style: { width: cols.name + "px" } }),
                  h("col", { style: { width: cols.version + "px" } }),
                  h("col", { style: { width: cols.available + "px" } }),
                  h("col", { style: { width: cols.state + "px" } }),
                  h("col", { style: { width: OP_COL_PX + "px" } })
                ),
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    h(
                      "th",
                      { className: "appupd-col-check" },
                      h("input", {
                        type: "checkbox",
                        className: "appupd-cb",
                        checked: allSelected,
                        disabled: selectableIds.length === 0,
                        onChange: toggleAll,
                        "aria-label": "全选可更新的应用",
                        title:
                          selectableIds.length === 0
                            ? "当前筛选下没有可更新的应用"
                            : allSelected
                              ? "全不选"
                              : "全选",
                        ref: (el) => {
                          if (el) el.indeterminate = !allSelected && selectedCount > 0;
                        },
                      })
                    ),
                    h("th", { className: "appupd-th" }, "应用", grip("name")),
                    h("th", { className: "appupd-th appupd-col-ver" }, "已装版本", grip("version")),
                    h("th", { className: "appupd-th appupd-col-ver" }, "可升级到", grip("available")),
                    h("th", { className: "appupd-th appupd-col-state" }, "状态", grip("state")),
                    h("th", { className: "appupd-col-op" }, "操作")
                  )
                ),
                h(
                  "tbody",
                  null,
                  rows.length
                    ? rows
                    : h(
                        "tr",
                        null,
                        h("td", { colSpan: 6, className: "appupd-empty-cell" }, "没有匹配的应用")
                      )
                )
              )
            ),

        /* 6. 日志 */
        h(
          "div",
          { className: "appupd-log" },
          h(
            "button",
            {
              type: "button",
              className: "appupd-log-head",
              onClick: () => setLogOpen((v) => !v),
              "aria-expanded": logOpen,
            },
            h("span", { className: "appupd-log-caret" }, logOpen ? "▾" : "▸"),
            h("span", null, "运行日志（最近 " + mergedLog.length + " 条）")
          ),
          logOpen
            ? h(
                "div",
                { className: "appupd-log-body" },
                logLines.length ? logLines : h("div", { className: "appupd-lv-info" }, "暂无日志")
              )
            : null
        )
      );
    }

    /* ------------------------------------------------------------------ *
     * 插件入口
     * ------------------------------------------------------------------ */

    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return;
        const prev = document.querySelector('style[data-plugin-css="dsh-app-updater"]');
        if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
        const tag = document.createElement("style");
        tag.dataset.plugin = "dsh-app-updater";
        tag.dataset.pluginCss = "dsh-app-updater";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          if (tag.parentNode) tag.parentNode.removeChild(tag);
        };
      }, "dsh-app-updater: styles");

      ctx.inject(["slots", "locale"], (scope) => {
        scope.slots.inject("settings.section", () =>
          scope.slots.register(
            {
              name: "settings.section",
              id: "dsh-app-updater",
              order: 42,
              label: () => "应用更新",
            },
            AppUpdaterSection
          )
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "locale"];
    return module.exports;
  },
});
