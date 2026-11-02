/**
 * 注册表兜底：枚举 Windows「已安装的应用」，覆盖 winget 目录里没有收录的软件。
 *
 * 数据源是三个 Uninstall 键（64 位 / 32 位 / 当前用户），这是「应用和功能」
 * 面板自己用的同一份数据，因此不需要启动任何软件就能读到。
 *
 * 走 PowerShell 是因为 Node 没有内置注册表读取；脚本写到临时文件再执行，
 * 避免命令行引号转义把中文键名弄坏。输出强制 UTF-8。
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
$out = New-Object System.Collections.ArrayList
foreach ($p in $paths) {
  Get-ChildItem $p | ForEach-Object {
    $k = $_
    $n = $k.GetValue('DisplayName')
    if (-not $n) { return }
    if ($k.GetValue('SystemComponent') -eq 1) { return }
    if ($k.GetValue('ParentKeyName')) { return }
    if ($k.GetValue('ReleaseType') -eq 'Update') { return }
    $entry = [ordered]@{
      name = [string]$n
      version = [string]$k.GetValue('DisplayVersion')
      publisher = [string]$k.GetValue('Publisher')
      location = [string]$k.GetValue('InstallLocation')
      hive = [string]$p
      key = [string]$k.PSChildName
    }
    [void]$out.Add([pscustomobject]$entry)
  }
}
$json = ConvertTo-Json -InputObject @($out) -Depth 3 -Compress
[Console]::Out.Write($json)
`;

/** 找 PowerShell（Windows PowerShell 一定存在，pwsh 更好但非必需）。 */
export function findPowerShell(env = process.env) {
  const systemRoot = env.SystemRoot || env.windir || "C:\\Windows";
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function run(exe, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const chunks = [];
    const errChunks = [];
    let done = false;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish({ ok: false, stdout: "", stderr: String((err && err.message) || err), code: null });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, stdout: "", stderr: "timeout", code: null });
    }, timeoutMs);
    child.stdout.on("data", (d) => chunks.push(d));
    // stderr 必须单独收。原来把它 push 进 stdout 的同一个数组：PowerShell 的一条无关
    // 警告（执行策略提示、.NET 版本横幅）混进 JSON 串 → JSON.parse 抛错 → 整次注册表
    // 读取被报成「失败」，用户以为这台机器读不到已装应用，实际数据是完好的。
    child.stderr.on("data", (d) => errChunks.push(d));
    child.on("error", (err) => finish({ ok: false, stdout: "", stderr: String(err && err.message), code: null }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      finish({ ok: code === 0, stdout, stderr: Buffer.concat(errChunks).toString("utf8"), code });
    });
  });
}

/**
 * 读取注册表里的已安装应用。
 * @returns {Promise<{ok: boolean, apps: Array, error: string|null}>}
 */
export async function readRegistryApps(env = process.env) {
  const exe = findPowerShell(env);
  let dir = null;
  try {
    dir = await mkdtemp(join(tmpdir(), "dsh-appupd-"));
    const scriptPath = join(dir, "enum.ps1");
    // 带 BOM 写出，Windows PowerShell 5.1 才会按 UTF-8 读中文
    await writeFile(scriptPath, `\ufeff${PS_SCRIPT}`, "utf8");
    const r = await run(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]);
    if (!r.ok) return { ok: false, apps: [], error: r.stderr || `powershell exit ${r.code}` };
    const text = r.stdout.trim();
    if (!text) return { ok: true, apps: [], error: null };
    const parsed = JSON.parse(text);
    const apps = (Array.isArray(parsed) ? parsed : [parsed]).filter((a) => a && a.name);
    return { ok: true, apps, error: null };
  } catch (err) {
    return { ok: false, apps: [], error: String((err && err.message) || err) };
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 名称归一化：用于把 winget 条目和注册表条目认成同一款软件。 */
export function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[（(].*?[)）]/g, "")
    .replace(/\bversion\b|\b版本\b|\bv?\d+(\.\d+)+[a-z0-9.+]*\b/g, "")
    .replace(/\b(x64|x86|64-bit|32-bit|amd64|arm64)\b/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}
