// preload.cjs — Alpha 主窗口（记忆工作台）的渲染层桥。
//
// 与 ds-ui harness/preload.cjs 同一契约（memory* 七个调用 + 空间 + i18n/theme），
// 另加 Alpha 专有通道：写入记忆、创建空间、演示种子、服务状态、对话实验入口、
// 激活解释与重提确认。渲染层没有 Node、没有文件系统、没有任意 channel；
// apiKey 不经过这个桥（chat:config 返回值永远没有 key 本体）。
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => async (payload) => {
  try {
    return await ipcRenderer.invoke(channel, payload);
  } catch (error) {
    return { ok: false, status: "MEMORY_RESULT_UNKNOWN", error: String((error && error.message) || error) };
  }
};

const search = invoke("alpha:memory-search");
const detail = invoke("alpha:memory-detail");
const operation = invoke("alpha:memory-operation");
const health = invoke("alpha:memory-health");
const capacity = invoke("alpha:memory-capacity");
const contextSearch = invoke("alpha:memory-context-search");
const control = invoke("alpha:control-formal-memory");

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("petAPI", {
  memorySearch: (params) => search(params && typeof params === "object" ? params : {}),
  memoryDetail: (recordId) => detail(String(recordId || "")),
  memoryOperation: (operationId) => operation(String(operationId || "")),
  memoryHealth: () => health(),
  memoryCapacity: () => capacity(),
  memoryContextSearch: (params) => contextSearch(params && typeof params === "object" ? params : {}),
  controlFormalMemory: (payload) => {
    if (!payload || typeof payload !== "object") return Promise.resolve({ ok: false, status: "MEMORY_CONTROL_INVALID" });
    const action = payload.action === "correct" || payload.action === "retract" ? payload.action : null;
    if (!action) return Promise.resolve({ ok: false, status: "MEMORY_CONTROL_INVALID" });
    return control({
      instanceId: typeof payload.instanceId === "string" ? payload.instanceId : undefined,
      operationId: typeof payload.operationId === "string" ? payload.operationId : undefined,
      targetExperienceId: typeof payload.targetExperienceId === "string" ? payload.targetExperienceId : "",
      action,
      ...(action === "correct" ? { text: String(payload.text || "").slice(0, 4000) } : {})
    });
  },
  // 空间选择与图能力探测（Atlas 模式有真实实现）
  listSpaces: () => ipcRenderer.invoke("alpha:spaces"),
  selectSpace: (spaceId) => ipcRenderer.invoke("alpha:space-select", String(spaceId || "")),
  probeGraph: () => ipcRenderer.invoke("alpha:graph-probe"),
  getI18n: () => ipcRenderer.invoke("alpha:get-i18n"),
  getState: () => ipcRenderer.invoke("alpha:get-state"),
  onUiLangChanged: subscribe("alpha:ui-lang"),
  onThemeChanged: subscribe("alpha:theme"),
  // Alpha 专有
  createSpace: (payload) => ipcRenderer.invoke("alpha:create-space", payload && typeof payload === "object" ? payload : {}),
  addMemory: (payload) => ipcRenderer.invoke("alpha:add-memory", payload && typeof payload === "object" ? payload : {}),
  seedDemo: () => ipcRenderer.invoke("alpha:seed-demo"),
  serviceStatus: () => ipcRenderer.invoke("alpha:service-status"),
  openChat: () => ipcRenderer.invoke("alpha:open-chat"),
  activationExplain: (payload) => ipcRenderer.invoke("alpha:activation-explain", payload && typeof payload === "object" ? payload : {}),
  activationEvents: () => ipcRenderer.invoke("alpha:activation-events"),
  revisitConfirm: (payload) => ipcRenderer.invoke("alpha:revisit-confirm", payload && typeof payload === "object" ? payload : {}),
  onSpacesChanged: subscribe("alpha:spaces-changed"),
  onServiceFailed: subscribe("alpha:service-failed")
});
