/**
 * 子进程执行：统一 UTF-8 解码、超时、取消。
 *
 * 只接受绝对路径可执行文件 + 参数数组，绝不经过 shell —— 应用名和安装路径
 * 里带空格、引号、中文都不会被二次解释。
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * @param {string} exe 绝对路径
 * @param {string[]} args 参数数组
 * @param {{ timeoutMs?: number, signal?: AbortSignal, env?: Record<string,string>, onData?: (chunk: string) => void }} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:string|null}>}
 */
export function runProcess(exe, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise((resolve) => {
    // 用 StringDecoder 逐块解码：一次性 Buffer.concat().toString("utf8") 在中文
    // 恰好跨 chunk 边界时会产生 U+FFFD 替换字符，污染表格 / 路径解析。
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let outText = "";
    let errText = "";
    let settled = false;
    let timedOut = false;
    let timer = null;
    let child = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (opts.signal && onAbort) opts.signal.removeEventListener("abort", onAbort);
      resolve({
        timedOut,
        stdout: outText + outDecoder.end(),
        stderr: errText + errDecoder.end(),
        ...result,
      });
    };

    const kill = () => {
      try {
        if (process.platform !== "win32" && child && child.pid) {
          /* POSIX：杀整个进程组。brew / 安装器派生的孙进程也要一起停，
             只 kill 直接子进程会留下孤儿进程（Windows 侧由 elevate.js 的
             taskkill /T /F 负责，普通路径由 engine 兜底）。 */
          process.kill(-child.pid, "SIGTERM");
        } else {
          child && child.kill();
        }
      } catch {
        try { child && child.kill(); } catch { /* 进程已退出 */ }
      }
    };

    const onAbort = () => kill();

    try {
      child = spawn(exe, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        // POSIX 上开独立进程组，配合上面的 -pid 进程组 kill
        detached: process.platform !== "win32",
        env: { ...process.env, ...(opts.env || {}) },
      });
    } catch (e) {
      finish({ ok: false, code: null, spawnError: String((e && e.message) || e) });
      return;
    }

    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      const text = outDecoder.write(d);
      outText += text;
      if (opts.onData) {
        try {
          opts.onData(text);
        } catch {
          /* 进度回调不允许影响主流程（此处刻意静默，避免回调异常打断子进程收尾） */
        }
      }
    });
    child.stderr.on("data", (d) => { errText += errDecoder.write(d); });
    child.on("error", (e) => finish({ ok: false, code: null, spawnError: String((e && e.message) || e) }));
    child.on("close", (code) => finish({ ok: code === 0, code, spawnError: null }));
  });
}

/** 合并输出，便于匹配错误文案。 */
export function outputText(result) {
  if (!result) return "";
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}
