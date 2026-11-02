/**
 * 持久化状态：设置、上次扫描结果、日志。
 * 位置：$DSH_HOME/dsh-appupdater/  （默认 ~/.dsh/dsh-appupdater）
 *
 * 只写插件自己的目录，绝不碰 profile 或宿主配置。
 */

import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LOG = 400;

export function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".dsh");
}

export function dataDir() {
  return join(dshHome(), "dsh-appupdater");
}

export function defaultSettings() {
  return {
    includeStoreApps: true,
    includeRegistryOnly: true,
    // macOS：把非 Homebrew 管理（拖 DMG / 手动装）的应用也列出来（只列出，不更新）
    includeUnmanagedApps: true,
    downloadDir: "",
    keepInstallers: true,
    useWingetDownload: true,
    hashFallbackUpgrade: true,
    dryRun: false,
    // 按本机架构（Windows ARM64 / x64、Apple Silicon / Intel）挑选安装包
    matchSystemArch: true,
    // 需要管理员的安装包（MSI / 写入 Program Files）改用管理员上下文执行
    autoElevate: true,
  };
}

export function defaultState() {
  return {
    version: 2,
    settings: defaultSettings(),
    scan: { startedAt: 0, finishedAt: 0, error: null, running: false, warnings: [] },
    update: { startedAt: 0, finishedAt: 0, running: false, total: 0, done: 0, current: null, results: [], error: null },
    apps: { scannedAt: 0, stats: { total: 0, upgradable: 0, unsupported: 0 }, items: [], engine: "" },
    env: null,
    engine: null,
    log: [],
  };
}

async function readJson(file) {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 原子写：先写 .tmp 再 rename。 */
export async function writeJsonAtomic(file, value) {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export class Store {
  constructor() {
    this.state = defaultState();
    this.loaded = false;
    this.saving = null;
    this.dirty = false;
  }

  get statePath() {
    return join(dataDir(), "state.json");
  }

  /**
   * 改名迁移（1.3.6：dsh-app-updater → dsh-appupdater）：
   * 新目录还没有 state.json、而旧目录有 → 把旧 state.json 复制过来（只读复制，
   * 不删旧目录，用户确认新包正常后再自行卸载/清理）。迁移失败绝不阻塞启动。
   */
  async migrateFromLegacyName() {
    const legacy = join(dshHome(), "dsh-app-updater", "state.json");
    if (this.statePath === legacy) return false;
    try {
      await stat(this.statePath);
      return false; // 新目录已有状态，不迁
    } catch {
      /* 新目录没有 state.json，继续看旧目录 */
    }
    const raw = await readFile(legacy, "utf8").catch(() => null);
    if (raw == null) return false;
    try {
      await mkdir(join(this.statePath, ".."), { recursive: true });
      await writeFile(this.statePath, raw, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  async load() {
    if (this.loaded) return this.state;
    const migrated = await this.migrateFromLegacyName();
    this.migratedFromLegacy = migrated;
    const stored = await readJson(this.statePath);
    if (stored && typeof stored === "object") {
      const base = defaultState();
      this.state = {
        ...base,
        ...stored,
        settings: { ...base.settings, ...(stored.settings || {}) },
        scan: { ...base.scan, ...(stored.scan || {}), running: false },
        update: { ...base.update, ...(stored.update || {}), running: false, current: null },
        apps: stored.apps && typeof stored.apps === "object" ? stored.apps : base.apps,
        log: Array.isArray(stored.log) ? stored.log.slice(-MAX_LOG) : [],
      };
    }
    this.loaded = true;
    return this.state;
  }

  async save() {
    this.dirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try {
          await writeJsonAtomic(this.statePath, this.state);
        } catch {
          // 磁盘不可写时不要让 UI 崩掉：内存态继续可用
          return;
        }
      }
    })().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  log(level, text) {
    const entry = { at: Date.now(), level, text: String(text == null ? "" : text) };
    this.state.log.push(entry);
    if (this.state.log.length > MAX_LOG) this.state.log = this.state.log.slice(-MAX_LOG);
    this.save();
    return entry;
  }

  updateSettings(patch) {
    const next = { ...this.state.settings };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in defaultSettings())) continue;
      if (typeof defaultSettings()[k] === "boolean") next[k] = Boolean(v);
      else next[k] = String(v == null ? "" : v);
    }
    this.state.settings = next;
    this.save();
    return next;
  }
}
