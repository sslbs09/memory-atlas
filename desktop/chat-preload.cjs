// chat-preload.cjs — 记忆对话实验窗口的渲染层桥。
//
// 通道最小化：配置（无 apiKey 本体）、发送/中断/已展示回执、事件流订阅。
// 流式增量经 chat:event 推送；渲染层零网络（CSP connect-src 'none'）。
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel) {
  return (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld("chatAPI", {
  getConfig: () => ipcRenderer.invoke("chat:config-get"),
  setConfig: (payload) => {
    if (!payload || typeof payload !== "object") return Promise.resolve({ ok: false });
    const out = {};
    if (typeof payload.baseURL === "string") out.baseURL = payload.baseURL.slice(0, 500);
    if (typeof payload.model === "string") out.model = payload.model.slice(0, 200);
    if (typeof payload.apiKey === "string") out.apiKey = payload.apiKey.slice(0, 500);
    if (Number.isFinite(payload.timeoutMs)) out.timeoutMs = payload.timeoutMs;
    if (Number.isInteger(payload.contextLimit)) out.contextLimit = payload.contextLimit;
    return ipcRenderer.invoke("chat:config-set", out);
  },
  send: (payload) => {
    if (!payload || typeof payload.requestId !== "string" || typeof payload.message !== "string") {
      return Promise.resolve({ ok: false, error: "BAD_REQUEST" });
    }
    return ipcRenderer.invoke("chat:send", {
      requestId: payload.requestId.slice(0, 80),
      message: String(payload.message).slice(0, 8000),
      history: Array.isArray(payload.history)
        ? payload.history.slice(-20).map((m) => ({
            role: m && m.role === "assistant" ? "assistant" : "user",
            content: String((m && m.content) || "").slice(0, 16000)
          }))
        : []
    });
  },
  cancel: (requestId) => ipcRenderer.invoke("chat:cancel", { requestId: String(requestId || "") }),
  displayed: (requestId) => ipcRenderer.invoke("chat:displayed", { requestId: String(requestId || "") }),
  memoryDetail: (recordId) => ipcRenderer.invoke("alpha:memory-detail", String(recordId || "")),
  revisitConfirm: (payload) => ipcRenderer.invoke("alpha:revisit-confirm", payload && typeof payload === "object" ? payload : {}),
  serviceStatus: () => ipcRenderer.invoke("alpha:service-status"),
  onEvent: subscribe("chat:event"),
  getState: () => ipcRenderer.invoke("alpha:get-state")
});
