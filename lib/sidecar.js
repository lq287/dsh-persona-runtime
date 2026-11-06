/**
 * persona sidecar 的 Node 侧管理：spawn 一个常驻的 `python -m persona.sidecar`，
 * 用 JSON-lines 跟它对话。
 *
 * 为什么不把人格逻辑用 JS 重写一遍：
 *   四层人格 + 关系层 + 两道偏好闸门 + 守卫 + 漂移基线有 88 项自检盯着。
 *   重写一遍必然出现两套语义（同一个项目已经因为"两处各自实现"出过事故）。
 *   插件只做两件事：注册工具、转发请求 —— 与 dsh-memory-pg 保持同一个架构取向。
 *
 * 生命周期：懒启动、死了自动重启（带退避）、dispose 时优雅关闭；任何失败都变成
 * 工具结果里的错误文本，绝不让会话挂掉。
 */

import { spawn } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_STDERR_LINES = 40;

export class PersonaSidecar {
  /**
   * @param {object} options
   * @param {string} options.projectRoot persona 包所在目录（含 persona/ 子包）
   * @param {string} [options.pythonExe]
   * @param {string} [options.backend] auto | postgres | memory
   * @param {string} [options.dsn]
   * @param {string} [options.ownersFile]
   * @param {string} [options.relFile]
   * @param {number} [options.timeoutMs]
   * @param {(line: string) => void} [options.log]
   */
  constructor(options) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.pythonExe = options.pythonExe || (process.platform === "win32" ? "python" : "python3");
    this.backend = options.backend || "auto";
    this.dsn = options.dsn;
    this.ownersFile = options.ownersFile;
    this.relFile = options.relFile;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.log = options.log || ((line) => console.error(`[persona] ${line}`));

    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
    this.stderrTail = [];
    this.restartCount = 0;
    this._lastExitAt = 0;
    this.disposed = false;
  }

  _env() {
    const sep = process.platform === "win32" ? ";" : ":";
    // 依赖既可能在项目内 pylibs（本机做法），也可能是系统装的；两个都放进去。
    const extra = [path.join(this.projectRoot, "channels", "pylibs"), path.join(this.projectRoot, "pylibs")];
    const env = {
      ...process.env,
      PYTHONPATH: [...extra, this.projectRoot].join(sep),
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
      PERSONA_BACKEND: this.backend,
    };
    if (this.dsn) env.PERSONA_PG_DSN = this.dsn;
    if (this.ownersFile) env.PERSONA_OWNERS_FILE = this.ownersFile;
    if (this.relFile) env.PERSONA_REL_FILE = this.relFile;
    return env;
  }

  _ensureChild() {
    if (this.child && this.child.exitCode === null) return this.child;
    if (this.disposed) throw new Error("persona sidecar 已关闭");
    if (this.restartCount >= 3 && Date.now() - this._lastExitAt < 5000) {
      throw new Error(
        `persona sidecar 连续启动失败 ${this.restartCount} 次：${this.stderrTail.slice(-5).join(" | ")}`,
      );
    }

    this.buffer = "";
    const child = spawn(this.pythonExe, ["-X", "utf8", "-m", "persona.sidecar"], {
      cwd: this.projectRoot,
      env: this._env(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > MAX_STDERR_LINES) this.stderrTail.shift();
        this.log(line);
      }
    });

    child.on("error", (err) => {
      this._failAll(new Error(`persona sidecar 启动失败：${err.message}`));
      this._lastExitAt = Date.now();
      this.restartCount += 1;
      this.child = null;
    });

    child.on("exit", (code, signal) => {
      const detail = this.stderrTail.slice(-3).join(" | ");
      this._failAll(
        new Error(`persona sidecar 退出（code=${code}, signal=${signal}）${detail ? "：" + detail : ""}`),
      );
      this._lastExitAt = Date.now();
      if (code !== 0) this.restartCount += 1;
      this.child = null;
    });

    return child;
  }

  _onStdout(chunk) {
    this.buffer += chunk;
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log(`无法解析的响应行: ${line.slice(0, 200)}`);
        continue;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(sidecarError(msg.error));
    }
  }

  _failAll(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  /**
   * @param {string} op
   * @param {object} [args]
   * @param {number} [timeoutMs]
   * @returns {Promise<object>}
   */
  request(op, args = {}, timeoutMs) {
    const child = this._ensureChild();
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, op, args }) + "\n", "utf8");

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`persona sidecar 超时（${op} > ${timeoutMs || this.timeoutMs}ms）`));
      }, timeoutMs || this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(payload, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`写入 sidecar 失败：${err.message}`));
      });
    });
  }

  async dispose() {
    this.disposed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      await this.request("shutdown", {}, 2000);
    } catch {
      /* 已经在退出路径上 */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }
}

function sidecarError(error) {
  if (!error) return new Error("persona sidecar 返回了未知错误");
  const err = new Error(error.message || String(error));
  err.name = error.type || "SidecarError";
  if (error.hint) err.hint = error.hint;
  return err;
}
