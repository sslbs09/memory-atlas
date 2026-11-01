/**
 * atlas-service.mjs — 以独立 Node 24 子进程运行 Memory Atlas 服务。
 *
 * 为什么是子进程：GLM 检索索引用 node:sqlite（Node 24 稳定行为），Electron 内嵌
 * 的 Node 是 22.x，行为不满足。所以桌面应用只做壳，Atlas 用系统 Node 24 跑：
 *
 *   node <repoRoot>/bin/atlas-server.mjs --data-dir <dir> --port <p>
 *        --retrieval-module <repoRoot>/adapters/glm-retrieval.mjs
 *   env: ATLAS_GLM_MODULE=<desktop>/glm-retrieval/src/adapter.mjs
 *        ATLAS_READ_TOKEN / ATLAS_WRITE_TOKEN（本进程生成，只传给子进程与适配器）
 *
 * 纪律：
 *   - 绝不用 Electron 的 process.execPath 当 Node（那会再启动一个完整 Electron）；
 *   - 只结束自己启动的那个子进程（stdin close → 优雅停机，兜底 kill），
 *     不碰用户已有的任何 node / atlas 服务；
 *   - 启动失败必须携带真实原因（node 缺失、版本不够、模块缺失、端口被占、
 *     单写者锁被持有），不吞错、不降级成"没有记忆"。
 */

import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const READY_TIMEOUT_MS = 30000;

function firstLine(text) {
  return String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
}

/** 在 PATH 里找 node.exe 并验证主版本 >= 24（GLM 索引的 node:sqlite 依赖）。 */
export async function resolveNode24() {
  const override = process.env.MEMORY_ATLAS_NODE;
  const candidates = [];
  if (override) candidates.push(override);
  if (process.platform === "win32") {
    candidates.push("node.exe");
  } else {
    candidates.push("node");
  }
  const whereResult = await new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFile(cmd, ["node"], { timeout: 5000 }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    });
  });
  candidates.push(...whereResult);

  const tried = [];
  for (const candidate of candidates) {
    const version = await new Promise((resolve) => {
      execFile(candidate, ["--version"], { timeout: 5000 }, (error, stdout) => {
        if (error) return resolve(null);
        resolve(String(stdout).trim());
      });
    });
    if (!version) { tried.push(`${candidate}: 无法执行`); continue; }
    const major = Number(/^v(\d+)/.exec(version)?.[1] ?? 0);
    if (major >= 24) return { nodePath: candidate, nodeVersion: version };
    tried.push(`${candidate}: ${version}（需要 >= 24，GLM 检索索引的 node:sqlite 依赖 Node 24 行为）`);
  }
  throw new Error(
    "没有找到可用的 Node.js >= 24。 tried: " + (tried.join("; ") || "（列表为空）") +
    ". 可用环境变量 MEMORY_ATLAS_NODE 指定 node.exe 的完整路径。"
  );
}

export class AtlasService {
  constructor({ repoRoot, desktopRoot, dataDir, port }) {
    this.repoRoot = repoRoot;
    this.desktopRoot = desktopRoot;
    this.dataDir = dataDir;
    // port: 数字（固定）或 0（Atlas 在环回上挑一个空闲端口并在就绪行里报告）
    this.requestedPort = Number.isInteger(port) && port >= 0 ? port : 0;
    this.state = "stopped"; // stopped | starting | running | failed
    this.child = null;
    this.port = null;
    this.pid = null;
    this.index = null;
    this.nodePath = null;
    this.nodeVersion = null;
    this.readToken = null;
    this.writeToken = null;
    this.error = null;
    this.exitCode = null;
    this.stderrTail = [];
    this.waiters = [];
  }

  pushStderr(line) {
    this.stderrTail.push(line);
    if (this.stderrTail.length > 120) this.stderrTail.shift();
  }

  async start() {
    if (this.state === "running" || this.state === "starting") return this.status();
    this.state = "starting";
    this.error = null;
    this.exitCode = null;
    this.stderrTail = [];

    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const node = await resolveNode24();
      this.nodePath = node.nodePath;
      this.nodeVersion = node.nodeVersion;

      const readToken = randomBytes(24).toString("hex");
      const writeToken = randomBytes(24).toString("hex");
      this.readToken = readToken;
      this.writeToken = writeToken;

      const serverPath = path.join(this.repoRoot, "bin", "atlas-server.mjs");
      const retrievalModule = path.join(this.repoRoot, "adapters", "glm-retrieval.mjs");
      const glmModule = path.join(this.desktopRoot, "glm-retrieval", "src", "adapter.mjs");
      if (!fs.existsSync(serverPath)) throw new Error(`Atlas 服务入口不存在：${serverPath}`);
      if (!fs.existsSync(retrievalModule)) throw new Error(`Atlas 检索工厂不存在：${retrievalModule}`);
      if (!fs.existsSync(glmModule)) {
        throw new Error(
          `GLM 检索引擎不存在：${glmModule}。` +
          "Alpha 首次构建需要把 glm-retrieval 源码复制到 desktop/glm-retrieval（见 desktop/PROVENANCE.md）。"
        );
      }

      const child = spawn(this.nodePath, [
        serverPath,
        "--data-dir", this.dataDir,
        "--port", String(this.requestedPort),
        "--retrieval-module", retrievalModule
      ], {
        cwd: this.repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          ATLAS_GLM_MODULE: glmModule,
          ATLAS_READ_TOKEN: readToken,
          ATLAS_WRITE_TOKEN: writeToken
        }
      });
      this.child = child;
      this.pid = child.pid;

      let stdoutBuf = "";
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(
            `Atlas 服务 ${READY_TIMEOUT_MS / 1000} 秒内未就绪。` +
            (this.stderrTail.length ? `最近输出：\n${this.stderrTail.slice(-12).join("\n")}` : "（无输出）")
          ));
        }, READY_TIMEOUT_MS);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`Atlas 进程启动失败：${error.message}`));
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          this.exitCode = code;
          reject(new Error(
            `Atlas 进程提前退出（code=${code ?? "null"}）。` +
            (this.stderrTail.length ? `最近输出：\n${this.stderrTail.slice(-12).join("\n")}` : "（无输出）")
          ));
        });
        this.waiters.push({ resolve: () => {
          clearTimeout(timer);
          resolve();
        }, reject });
      });

      child.stdout.on("data", (chunk) => {
        stdoutBuf += String(chunk);
        let idx;
        while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          let parsed = null;
          try { parsed = JSON.parse(line); } catch { parsed = null; }
          if (parsed && parsed.event === "listening") {
            this.port = parsed.port;
            this.index = parsed.index ?? null;
            this.state = "running";
            for (const w of this.waiters.splice(0)) w.resolve();
          }
        }
      });
      child.stderr.on("data", (chunk) => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) this.pushStderr(line);
        }
      });
      child.on("exit", (code) => {
        this.exitCode = code;
        if (this.state === "running" || this.state === "starting") {
          this.state = this.state === "running" ? "stopped" : "failed";
          if (this.state === "failed") {
            this.error = `Atlas 进程提前退出（code=${code ?? "null"}）。\n${this.stderrTail.slice(-12).join("\n")}`;
          }
        }
        this.child = null;
        this.pid = null;
      });

      await ready;
      this.state = "running";
      return this.status();
    } catch (error) {
      this.state = "failed";
      this.error = error && error.message ? error.message : String(error);
      this.stopChild();
      throw new Error(this.error);
    }
  }

  stopChild() {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      // 优雅停机路径：Atlas 以 stdin 关闭为停机信号（与 WhiteMoon Host 同一约定）。
      child.stdin.end();
    } catch { /* stdin 已关闭也无妨 */ }
    const killer = setTimeout(() => {
      try { child.kill(); } catch { /* 进程已经不在了 */ }
    }, 3500);
    child.once("exit", () => clearTimeout(killer));
  }

  async stop() {
    this.stopChild();
    this.state = "stopped";
  }

  status() {
    return {
      state: this.state,
      port: this.port,
      pid: this.pid,
      dataDir: this.dataDir,
      nodePath: this.nodePath,
      nodeVersion: this.nodeVersion,
      index: this.index,
      exitCode: this.exitCode,
      error: this.error,
      stderrTail: this.stderrTail.slice(-30),
      requestedPort: this.requestedPort
    };
  }
}

/** 把首行非 JSON 的 stderr 提炼成一句人话（常见故障的直名）。 */
export function explainServiceError(status) {
  if (!status || !status.error) return null;
  const text = `${status.error}\n${status.stderrTail.join("\n")}`;
  if (/ATLAS_WRITE_LOCK_HELD|writer\.lock|单写者|already.*lock/i.test(text)) {
    return "Atlas 数据目录已被另一个 Atlas 进程持有（单写者锁）。请关闭占用它的进程，或为 Alpha 换一个数据目录。";
  }
  if (/EADDRINUSE/i.test(text)) {
    return "Atlas 端口被其他程序占用。Alpha 默认自动挑空闲端口；若配置了固定端口，请换一个或改回 auto。";
  }
  if (/retrieval module failed to load/i.test(text)) {
    return `GLM 检索模块加载失败：${firstLine(text)}`;
  }
  return firstLine(text);
}
