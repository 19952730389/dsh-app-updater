/**
 * 持久化状态：设置、上次扫描结果、日志。
 * 位置：$DSH_HOME/dsh-app-updater/  （默认 ~/.dsh/dsh-app-updater）
 *
 * 只写插件自己的目录，绝不碰 profile 或宿主配置。
 */

import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_LOG = 400;

export function dshHome() {
  const explicit = process.env.DSH_HOME;
  if (explicit && explicit.trim()) return explicit.trim();
  return join(homedir(), ".dsh");
}

export function dataDir() {
  return join(dshHome(), "dsh-app-updater");
}

export function defaultSettings() {
  return {
    includeStoreApps: true,
    includeRegistryOnly: true,
    downloadDir: "",
    keepInstallers: true,
    useWingetDownload: true,
    hashFallbackUpgrade: true,
    dryRun: false,
  };
}

export function defaultState() {
  return {
    version: 1,
    settings: defaultSettings(),
    scan: { startedAt: 0, finishedAt: 0, error: null, running: false, warnings: [] },
    update: { startedAt: 0, finishedAt: 0, running: false, total: 0, done: 0, current: null, results: [], error: null },
    apps: { scannedAt: 0, stats: { total: 0, upgradable: 0, unsupported: 0 }, items: [] },
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

  async load() {
    if (this.loaded) return this.state;
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
