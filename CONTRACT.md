# dsh-app-updater 契约（宿主 ↔ 客户端）

插件 id：`dsh-app-updater`　显示名：应用更新（App Updater）

## 文件布局

```
dsh-app-updater/
├─ package.json          # main: ./lib/index.js, exports ./client, dsh.bundle.patch, dsh.client
├─ cordis.patch.yml      # insert 行：id=dsh-app-updater, name=dsh-app-updater
├─ lib/
│  ├─ index.js           # 宿主半身：cordis 插件，注册 /dsh-app-updater/* 路由
│  ├─ engine.js          # 扫描 / 下载 / 安装编排
│  ├─ winget.js          # winget 定位、调用、表格解析
│  ├─ registry.js        # 注册表 Uninstall 键枚举（覆盖 winget 未收录的应用）
│  ├─ version.js         # 版本比较（Windows 风格 1.2.3.4 + 字母后缀）
│  ├─ state.js           # 持久化状态（~/.dsh/dsh-app-updater/state.json）
│  └─ client.js          # 浏览器半身：设置页 UI
└─ README.md
```

## 宿主 HTTP 路由

全部 `kind: "exact"`，前缀 `/dsh-app-updater/`。写操作要求 loopback + `confirm: true`。

### GET /dsh-app-updater/state.json

```jsonc
{
  "ok": true,
  "platform": "win32",
  "winget": { "available": true, "version": "v1.29.380", "path": "C:\\...\\winget.exe" },
  "phase": "idle",                 // idle | scanning | updating
  "scan": { "running": false, "startedAt": 0, "finishedAt": 0, "error": null },
  "update": { "running": false, "total": 0, "done": 0, "current": null, "error": null },
  "apps": { "scannedAt": 0, "stats": { "total": 0, "upgradable": 0, "unsupported": 0 }, "items": [] },
  "log": [ { "at": 0, "level": "info|warn|error|success", "text": "..." } ],
  "settings": { "includeStoreApps": true, "includeRegistryOnly": true, "downloadDir": "", "keepInstallers": true, "hashFallbackUpgrade": true, "dryRun": false }
}
```

`apps.items[]`（单条应用）：

```jsonc
{
  "id": "Google.Chrome",            // winget id；纯注册表项为 "reg:<GUID 或 key 尾段>"
  "name": "Google Chrome",
  "version": "155.0.8059.85",       // 已安装版本，未知时 ""
  "available": "156.0.8078.48",     // 可升级到的版本，无更新时 ""
  "publisher": "Google LLC",
  "source": "winget",               // winget | msstore | registry
  "installLocation": "C:\\Program Files\\Google\\Chrome\\Application",
  "hasUpdate": true,
  "updateSupported": true,          // 本插件能否驱动更新
  "reason": null,                   // null | "not-in-catalog" | "unknown-version" | "pinned" | "store-managed" | "system-component"
  "kind": "exe"                     // exe | msi | msix | inno | null（未知）
}
```

### POST /dsh-app-updater/scan

body `{ "confirm": true, "force": true }` → `{ "ok": true, "started": true }`（异步；结果看 state.json / apps.json）

### GET /dsh-app-updater/apps.json

`{ "ok": true, "scannedAt": 0, "stats": {...}, "items": [App...], "warnings": ["..."] }`

### POST /dsh-app-updater/update

body `{ "confirm": true, "ids": ["Google.Chrome", "..."], "mode": "silent" }`
→ `{ "ok": true, "started": true, "queued": 3 }`（串行执行，逐条下载官网全量包 → 校验 → 静默安装）

### POST /dsh-app-updater/cancel

→ `{ "ok": true }`（取消尚未开始的项目；正在安装的进程会收到终止请求）

### POST /dsh-app-updater/settings

body `{ "confirm": true, "settings": { ... } }` → `{ "ok": true, "settings": {...} }`

### POST /dsh-app-updater/open-downloads

→ `{ "ok": true, "path": "..." }`（在资源管理器中打开下载目录）

## 客户端要求

- `window.__ModuleLoader__.load({ id: "dsh-app-updater", factory: (require) => { ... } })`
- `exports.inject = ["slots", "locale"]`
- 注册 `settings.section`：`{ name: "settings.section", id: "dsh-app-updater", order: 42, label: () => "应用更新" }`
- 只用 `require("react")`；不引入其它运行时依赖
- 页面：顶部工具条（刷新检测 / 全部更新 / 取消 / 打开下载目录）+ 统计条 + 可筛选可多选的表格 + 底部日志
- 表格列：勾选 / 应用名 / 已装版本 / 可升级到 / 来源 / 状态 / 操作
- 所有请求带 `cache: "no-store"`；轮询 state.json（扫描/更新中 800ms，空闲 4s）
