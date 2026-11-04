/**
 * 运行环境识别：操作系统（Windows / macOS / Linux）、具体版本、CPU 架构
 * （ARM64 还是 x64/Intel），以及本机可用的「更新引擎」。
 *
 * 为什么要单独一个模块：安装包是按「系统 + 架构」分发的 —— 同一个应用，
 * Windows x64、Windows ARM64、macOS Apple Silicon、macOS Intel 可能是四个
 * 不同的下载地址。更新前必须先知道自己是谁，才能挑对那一份。
 *
 * 本模块只做识别与决策，不复制任何平台相关的命令；命令留给 engine。
 */

import { arch as nodeArch, platform as nodePlatform, release as nodeRelease, version as nodeVersion, cpus } from "node:os";

/** Windows 版本名：用 build 号区分 Win10 / Win11。 */
export function windowsName(release, build) {
  const b = Number(build);
  if (!Number.isFinite(b) || b <= 0) return "Windows";
  if (b >= 22000) return "Windows 11";
  if (b >= 10240) return "Windows 10";
  return "Windows";
}

/** macOS 代号：Darwin 主版本 → macOS 版本与代号。 */
export const DARWIN_TO_MACOS = {
  25: { version: "26", name: "macOS 26（Tahoe）" },
  24: { version: "15", name: "macOS 15（Sequoia）" },
  23: { version: "14", name: "macOS 14（Sonoma）" },
  22: { version: "13", name: "macOS 13（Ventura）" },
  21: { version: "12", name: "macOS 12（Monterey）" },
  20: { version: "11", name: "macOS 11（Big Sur）" },
  19: { version: "10.15", name: "macOS 10.15（Catalina）" },
};

export function macOSName(darwinMajor) {
  const m = Number(darwinMajor);
  const hit = DARWIN_TO_MACOS[m];
  if (hit) return { version: hit.version, name: hit.name };
  if (Number.isFinite(m) && m > 25) return { version: String(m - 9), name: `macOS（Darwin ${m}）` };
  return { version: "", name: "macOS" };
}

/**
 * 真实 CPU 架构。
 *
 * Windows on ARM 上跑 x64 的 Node 时 `os.arch()` 会报 x64（进程是模拟的），
 * 但 `PROCESSOR_ARCHITEW6432` 会露出真正的 ARM64；苹果平台上 `os.arch()`
 * 本身就可靠（arm64 表示 Apple Silicon，x64 表示 Intel）。
 */
export function normalizeArch(platform, rawArch, env = {}) {
  const a = String(rawArch || "").toLowerCase();
  if (platform === "win32") {
    const wow = String(env.PROCESSOR_ARCHITEW6432 || "").toLowerCase();
    const pa = String(env.PROCESSOR_ARCHITECTURE || "").toLowerCase();
    const real = wow || pa;
    if (real.includes("arm64")) return "arm64";
    if (real.includes("x86") && a === "ia32") return "x86";
    if (a === "arm64") return "arm64";
    if (a === "ia32") return "x86";
    return "x64";
  }
  if (a === "arm64") return "arm64";
  if (a === "ia32") return "x86";
  if (a === "x64") return "x64";
  return a || "unknown";
}

/** 架构的人类可读标签。 */
export function archLabel(platform, arch) {
  if (arch === "arm64") {
    return platform === "darwin" ? "Apple Silicon（ARM64）" : "ARM64";
  }
  if (arch === "x64") {
    return platform === "darwin" ? "Intel 64 位（x64）" : "x64（AMD64）";
  }
  if (arch === "x86") return "32 位（x86）";
  return arch || "未知架构";
}

/** winget 的 `--architecture` 取值（与 winget 自身的三档一致）。 */
export function wingetArch(arch) {
  if (arch === "arm64") return "arm64";
  if (arch === "x86") return "x86";
  if (arch === "x64") return "x64";
  return "";
}

/** 平台族：把 linux 之类的归到「其它」，engine 只对 windows / macos 有实现。 */
export function platformFamily(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "other";
}

/**
 * 识别本机环境。
 *
 * @param {{ platform?: string, arch?: string, release?: string, env?: object, cpus?: any[] }} [opts]
 *        全部可注入，便于在测试里模拟 Windows on ARM / macOS Intel 等组合。
 * @returns {object} 环境描述（可直接放进 state.json）
 */
export function detectEnvironment(opts = {}) {
  const platform = opts.platform || nodePlatform();
  const rawArch = opts.arch || nodeArch();
  const release = opts.release || nodeRelease();
  const env = opts.env || process.env;
  const cpuList = opts.cpus !== undefined ? opts.cpus : safeCpus();

  const arch = normalizeArch(platform, rawArch, env);
  const family = platformFamily(platform);
  /* 记录架构判定依据，供 /health.json 排障：Windows-on-ARM 靠
     PROCESSOR_ARCHITEW6432 修正被模拟的 os.arch()。若宿主清洗了这些环境变量，
     这里如实标注「来源不足」，避免用户拿到错架构安装包却无从查起。 */
  const archSource =
    platform === "win32"
      ? String(env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || "")
        ? "PROCESSOR_ARCHITEW6432/PROCESSOR_ARCHITECTURE"
        : `os.arch()=${rawArch}（未提供 PROCESSOR_ARCHITEW6432，ARM 模拟可能无法识别）`
      : `os.arch()=${rawArch}`;

  let osName = "未知系统";
  let osVersion = release || "";
  let osBuild = "";

  if (family === "windows") {
    const parts = String(release).split(".");
    osBuild = parts[2] || "";
    osName = windowsName(release, osBuild);
  } else if (family === "macos") {
    const major = String(release).split(".")[0];
    const named = macOSName(major);
    osName = named.name;
    osVersion = named.version || release;
  } else {
    osName = platform || "未知系统";
  }

  const cpuModel = cpuList && cpuList[0] && cpuList[0].model ? String(cpuList[0].model).trim() : "";

  return {
    platform,
    family,
    osName,
    osVersion,
    osBuild,
    arch,
    archSource,
    archLabel: archLabel(platform, arch),
    wingetArch: wingetArch(arch),
    cpuModel,
    cpuCount: cpuList ? cpuList.length : 0,
    nodeVersion: process.versions && process.versions.node ? process.versions.node : "",
    osNodeVersion: nodeVersion(),
    detectedAt: Date.now(),
  };
}

function safeCpus() {
  try {
    return cpus() || [];
  } catch {
    return [];
  }
}

/** 一行摘要，用于日志与界面状态行。 */
export function describeEnvironment(env) {
  if (!env) return "未知环境";
  let os = env.osName || env.platform || "未知系统";
  // Windows 的名字里没有 build，补上；macOS 的名字自带版本号，不重复
  if (env.family === "windows" && env.osBuild) os += "（build " + env.osBuild + "）";
  return [os, env.archLabel].filter(Boolean).join(" · ");
}

/**
 * 更新引擎：Windows 用 winget，macOS 用 Homebrew（装 cask 型应用），
 * 两者都没有时明确返回 none，而不是假装能更新。
 */
export const ENGINE_WINGET = "winget";
export const ENGINE_BREW = "homebrew";
export const ENGINE_NONE = "none";

export function engineFor(family) {
  if (family === "windows") return ENGINE_WINGET;
  if (family === "macos") return ENGINE_BREW;
  return ENGINE_NONE;
}

/** 该 环境+引擎 组合下能做什么。 */
export function capabilitiesFor(env, engineAvailable) {
  const family = env ? env.family : "other";
  // macOS 即使没有 Homebrew 也能枚举 .app（列出已装应用），只是无法判断/驱动更新
  const scan = family === "windows" || family === "macos";
  const canUpdate = family === "windows" ? Boolean(engineAvailable) : Boolean(engineAvailable);
  return {
    scan: Boolean(scan),
    update: Boolean(canUpdate),
    checkVersions: Boolean(canUpdate),
    storeAppsIncluded: family === "windows" || family === "macos",
    note:
      family === "windows"
        ? engineAvailable
          ? ""
          : "未找到 winget，只能列出注册表里的应用，无法判断是否有新版本"
        : family === "macos"
          ? engineAvailable
            ? ""
            : "未找到 Homebrew：可以列出已安装应用，但无法判断/驱动更新；安装 Homebrew 后可一键升级 cask 应用"
          : "当前系统没有可用的更新引擎（本插件支持 Windows 与 macOS）",
  };
}