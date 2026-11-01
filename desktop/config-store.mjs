/**
 * config-store.mjs — Alpha 桌面应用的本地配置与状态。
 *
 * 两份文件都在应用数据目录（不是仓库、不是 WhiteMoon 的任何目录）：
 *   config.json  模型 API 设置与 Atlas 端口策略。apiKey 只落在这里，
 *                绝不回传给渲染层、绝不进入日志。
 *   state.json   上次使用的记忆空间等界面状态，重启后继续用。
 *
 * 写入一律原子替换，读入一律容错（坏文件回到默认值并保留 .bad 副本）。
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_CONFIG = Object.freeze({
  model: {
    baseURL: "",
    model: "",
    apiKey: "",
    timeoutMs: 60000,
    contextLimit: 5
  },
  atlas: {
    portMode: "auto",   // "auto"（让 Atlas 挑空闲端口）| "fixed"
    fixedPort: 8791
  }
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      try { fs.copyFileSync(file, file + ".bad-" + Date.now()); } catch { /* 保留失败副本失败也无妨 */ }
    }
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function mergeShallow(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function createConfigStore({ configDir }) {
  const configFile = path.join(configDir, "config.json");
  const stateFile = path.join(configDir, "state.json");

  let config = (() => {
    const stored = readJson(configFile) || {};
    return {
      model: mergeShallow(DEFAULT_CONFIG.model, stored.model),
      atlas: mergeShallow(DEFAULT_CONFIG.atlas, stored.atlas)
    };
  })();

  let state = readJson(stateFile) || {};

  return {
    get config() { return config; },
    get state() { return state; },

    /** 模型设置。apiKey 可省略 = 保留旧值；空字符串 = 明确清除。 */
    setModelConfig(patch = {}) {
      const next = { ...config.model };
      if (typeof patch.baseURL === "string") next.baseURL = patch.baseURL.trim();
      if (typeof patch.model === "string") next.model = patch.model.trim();
      if (typeof patch.apiKey === "string") next.apiKey = patch.apiKey.trim();
      if (Number.isFinite(patch.timeoutMs) && patch.timeoutMs >= 3000 && patch.timeoutMs <= 300000) {
        next.timeoutMs = Math.floor(patch.timeoutMs);
      }
      if (Number.isInteger(patch.contextLimit) && patch.contextLimit >= 1 && patch.contextLimit <= 20) {
        next.contextLimit = patch.contextLimit;
      }
      config = { ...config, model: next };
      writeJsonAtomic(configFile, config);
      return this.publicModelConfig();
    },

    /** 给渲染层看的模型配置——永远没有 apiKey 本体，只有"配了没有"。 */
    publicModelConfig() {
      const m = config.model;
      return {
        baseURL: m.baseURL,
        model: m.model,
        timeoutMs: m.timeoutMs,
        contextLimit: m.contextLimit,
        apiKeySet: Boolean(m.apiKey),
        configured: Boolean(m.baseURL && m.model)
      };
    },

    setAtlasConfig(patch = {}) {
      const next = { ...config.atlas };
      if (patch.portMode === "auto" || patch.portMode === "fixed") next.portMode = patch.portMode;
      if (Number.isInteger(patch.fixedPort) && patch.fixedPort > 0 && patch.fixedPort < 65536) next.fixedPort = patch.fixedPort;
      config = { ...config, atlas: next };
      writeJsonAtomic(configFile, config);
      return config.atlas;
    },

    setLastSpace(spaceId) {
      state = { ...state, lastSpaceId: String(spaceId || "") };
      writeJsonAtomic(stateFile, state);
    }
  };
}
