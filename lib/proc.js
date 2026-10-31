/**
 * 子进程执行：统一 UTF-8 解码、超时、取消。
 *
 * 只接受绝对路径可执行文件 + 参数数组，绝不经过 shell —— 应用名和安装路径
 * 里带空格、引号、中文都不会被二次解释。
 */

import { spawn } from "node:child_process";

/**
 * @param {string} exe 绝对路径
 * @param {string[]} args 参数数组
 * @param {{ timeoutMs?: number, signal?: AbortSignal, env?: Record<string,string>, onData?: (chunk: string) => void }} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:string|null}>}
 */
export function runProcess(exe, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  return new Promise((resolve) => {
    const out = [];
    const err = [];
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
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        ...result,
      });
    };

    const kill = () => {
      try {
        child && child.kill();
      } catch {
        /* 进程已退出 */
      }
    };

    const onAbort = () => kill();

    try {
      child = spawn(exe, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
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
      out.push(d);
      if (opts.onData) {
        try {
          opts.onData(d.toString("utf8"));
        } catch {
          /* 进度回调不允许影响主流程 */
        }
      }
    });
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => finish({ ok: false, code: null, spawnError: String((e && e.message) || e) }));
    child.on("close", (code) => finish({ ok: code === 0, code, spawnError: null }));
  });
}

/** 合并输出，便于匹配错误文案。 */
export function outputText(result) {
  if (!result) return "";
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}
