/**
 * chat-model.mjs — OpenAI-compatible /v1/chat/completions 客户端（主进程内）。
 *
 * 只实现标准协议：POST {baseURL}/chat/completions，可选 Bearer，SSE 流式增量，
 * 服务端不支持流式时回落到整包 JSON。不绑定任何供应商；本地 Ollama
 * （http://127.0.0.1:11434/v1）与任何兼容实现都可用。
 *
 * 纪律：
 *   - apiKey 只在主进程内存与 config.json 里，不进日志、不回传渲染层；
 *   - 超时与外部中断都走 AbortSignal；中断后不产生伪造回复；
 *   - 错误原样携带 HTTP 状态与响应片段，界面展示真实原因。
 */

function trimBase(baseURL) {
  return String(baseURL || "").trim().replace(/\/+$/, "");
}

export function isConfigured({ baseURL, model }) {
  return Boolean(trimBase(baseURL) && String(model || "").trim());
}

/**
 * 流式对话。onDelta(chunk) 在每个增量上被调用；resolve 完整文本。
 * abortSignal 由调用方持有（用户中断）。
 */
export async function chatCompletion({
  baseURL, apiKey, model, messages, temperature = 0.7,
  timeoutMs = 60000, signal = null, onDelta = null
}) {
  const base = trimBase(baseURL);
  if (!base || !model) throw Object.assign(new Error("模型 API 未配置（baseURL / model）"), { code: "MODEL_NOT_CONFIGURED" });

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) throw Object.assign(new Error("已中断"), { code: "CHAT_ABORTED" });
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(3000, Number(timeoutMs) || 60000));

  const url = base + "/chat/completions";
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: "Bearer " + apiKey } : {})
      },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
      signal: controller.signal
    });
  } catch (error) {
    if (signal?.aborted || controller.signal.aborted) {
      throw Object.assign(new Error("已中断"), { code: "CHAT_ABORTED" });
    }
    const code = error && (error.cause?.code || error.code);
    throw Object.assign(new Error(
      code === "ECONNREFUSED"
        ? `无法连接模型服务（${url}）：连接被拒绝。请确认服务已启动、地址正确。`
        : `模型请求失败：${error && error.message ? error.message : error}`
    ), { code: code || "MODEL_TRANSPORT_FAILED" });
  } finally {
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw Object.assign(new Error(
      `模型服务返回 HTTP ${response.status}：${text.slice(0, 300) || response.statusText}`
    ), { code: `MODEL_HTTP_${response.status}` });
  }

  const contentType = String(response.headers.get("content-type") || "");
  let full = "";
  try {
    if (contentType.includes("text/event-stream") && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line || !line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          let parsed = null;
          try { parsed = JSON.parse(data); } catch { continue; }
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) {
            full += delta;
            if (onDelta) onDelta(delta);
          }
        }
      }
    } else {
      const payload = await response.json();
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string") {
        throw new Error("模型服务响应里没有 message.content 字段。");
      }
      full = text;
      if (onDelta) onDelta(text);
    }
  } catch (error) {
    if (signal?.aborted || controller.signal.aborted) {
      throw Object.assign(new Error("已中断"), { code: "CHAT_ABORTED" });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { text: full };
}
