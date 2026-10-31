/**
 * Windows 提权执行。
 *
 * 为什么需要它：winget 目录里的「官网全量包」有一大半是**机器级**安装 —— MSI 要
 * 写 HKLM / Program Files，安装器要往 Program Files 落文件。进程没有管理员令牌
 * 时有两种失败方式：
 *  1) MSI 直接失败（msiexec 返回 1603，MSI 日志里是 Error 1925「权限不足」）；
 *  2) 安装器**静默退出 0 却什么都没装**（实测 Logitech G HUB）。
 * 第 2 种最坑：只看退出码就会误报「更新成功」，所以安装之后必须复核版本
 * （见 engine.js 的 verifyInstalled）。
 *
 * Windows 的进程令牌创建后无法原地提升，因此这里把**一条命令**写进临时
 * PowerShell 助手脚本，用 `Start-Process -Verb RunAs` 在提权副本里执行，再把
 * 退出码与输出回传到文件后读回。两个脚本都写成 UTF-8 **带 BOM**：Windows
 * PowerShell 5.1 读 .ps1 时若无 BOM 会按本地代码页解码，中文路径会乱。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runProcess } from "./proc.js";

const PS_PROBE_TIMEOUT_MS = 20000;

/** Windows 取消提权的退出码（ERROR_CANCELLED）。 */
export const ELEVATION_CANCELLED = 1223;

/** PowerShell 单引号字面量：内部的 `'` 要写成 `''`。 */
export function psQuote(value) {
  return `'${String(value == null ? "" : value).replace(/'/g, "''")}'`;
}

/** Windows PowerShell 5.1 的绝对路径。 */
export function powershellPath(env = process.env) {
  const root = env.SystemRoot || env.windir || "C:\\Windows";
  return join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** 本机是否有可用的 PowerShell（没有它就无法提权）。 */
export function elevationAvailable(env = process.env) {
  try {
    return existsSync(powershellPath(env));
  } catch {
    return false;
  }
}

let cachedElevated = null;

/** 清掉「是否已提权」的缓存（单元测试与提权后复核用）。 */
export function resetElevationCache() {
  cachedElevated = null;
}

/**
 * 当前进程是否在管理员上下文里。
 * 非 Windows 平台按 uid==0 判断（macOS 的 brew 永远不需要提权）。
 */
export async function isElevated(opts = {}) {
  if (cachedElevated !== null && !opts.refresh) return cachedElevated;
  if (process.platform !== "win32") {
    cachedElevated = typeof process.getuid === "function" ? process.getuid() === 0 : true;
    return cachedElevated;
  }
  if (!elevationAvailable()) {
    cachedElevated = false;
    return cachedElevated;
  }
  const res = await runProcess(
    powershellPath(),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
    ],
    { timeoutMs: PS_PROBE_TIMEOUT_MS, signal: opts.signal }
  );
  cachedElevated = res.ok && /true/i.test(res.stdout);
  return cachedElevated;
}

function stripBom(text) {
  return String(text || "").replace(/^\ufeff/, "");
}

/**
 * 在提权副本里执行一条命令。
 *
 * 返回结构与 proc.js 的 runProcess 一致（外加 cancelled），因此调用方可以
 * 无差别地把它当成「另一个 runProcess」。
 *
 * @param {string} exe 绝对路径
 * @param {string[]} args 参数数组
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:string|null, cancelled:boolean}>}
 */
export async function runElevated(exe, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60 * 60 * 1000;
  const fail = (spawnError) => ({
    ok: false,
    code: null,
    stdout: "",
    stderr: "",
    timedOut: false,
    spawnError,
    cancelled: false,
  });

  if (process.platform !== "win32") return fail("非 Windows 平台不支持提权执行");
  if (!elevationAvailable()) return fail("未找到 powershell.exe，无法提权执行");

  const ps = powershellPath();
  const dir = await mkdtemp(join(tmpdir(), "dsh-app-updater-elev-"));
  const outFile = join(dir, "out.txt");
  const codeFile = join(dir, "code.txt");
  const helperFile = join(dir, "helper.ps1");
  const launchFile = join(dir, "launch.ps1");

  const helper = [
    "$ErrorActionPreference = 'Continue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$OutputEncoding = [System.Text.Encoding]::UTF8",
    `$exe = ${psQuote(exe)}`,
    `$argv = @(${(args || []).map(psQuote).join(", ")})`,
    `& $exe @argv 2>&1 | Out-File -FilePath ${psQuote(outFile)} -Encoding UTF8`,
    "$code = $LASTEXITCODE",
    "if ($null -eq $code) { $code = 0 }",
    `Set-Content -Path ${psQuote(codeFile)} -Value $code -Encoding ASCII`,
    "exit $code",
    "",
  ].join("\r\n");

  // 启动器只负责「把助手脚本以管理员身份跑起来并把退出码带回来」。
  const launch = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    `  $p = Start-Process -FilePath ${psQuote(ps)} -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File', ${psQuote(helperFile)}) -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    `} catch { exit ${ELEVATION_CANCELLED} }`,
    `if ($null -eq $p) { exit ${ELEVATION_CANCELLED} }`,
    "exit $p.ExitCode",
    "",
  ].join("\r\n");

  try {
    await writeFile(helperFile, `\ufeff${helper}`, "utf8");
    await writeFile(launchFile, `\ufeff${launch}`, "utf8");
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return fail(String((err && err.message) || err));
  }

  const res = await runProcess(
    ps,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launchFile],
    { timeoutMs, signal: opts.signal }
  );

  let stdout = "";
  try {
    stdout = stripBom(await readFile(outFile, "utf8"));
  } catch {
    // 安装器没有产出任何输出：正常（GUI 安装包），失败原因由退出码与 MSI 日志给
  }

  let code = res.code;
  let reported = false;
  try {
    const raw = stripBom(await readFile(codeFile, "utf8")).trim();
    if (/^-?\d+$/.test(raw)) {
      code = Number(raw);
      reported = true;
    }
  } catch {
    // 提权副本没能跑到写退出码那一步
  }

  // 超时时提权副本可能还在跑（安装器），保留临时目录不删，避免动到正在执行的脚本
  if (!res.timedOut) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  const cancelled = res.code === ELEVATION_CANCELLED || code === ELEVATION_CANCELLED;
  const spawnError = res.spawnError
    ? res.spawnError
    : cancelled
      ? "提权被拒绝（UAC 被取消）"
      : !reported && !res.timedOut && code !== 0
        ? "提权副本未能报告退出码（可能被 UAC 拒绝）"
        : null;

  return {
    ok: !res.timedOut && !spawnError && code === 0,
    code,
    stdout,
    stderr: "",
    timedOut: res.timedOut,
    spawnError,
    cancelled,
  };
}