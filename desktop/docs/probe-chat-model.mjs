// 临时探针：单测 chat-model.mjs 对协议桩的流式调用。不属于交付面。
import { chatCompletion } from "../chat-model.mjs";

let deltas = 0;
try {
  const result = await chatCompletion({
    baseURL: "http://127.0.0.1:8798/v1",
    model: "stub-echo-1",
    messages: [
      { role: "system", content: "[记忆资料 begin]\n- recordId: demo-movie | 内容: 看了电影\n[记忆资料 end]" },
      { role: "user", content: "我以前看过什么电影？" }
    ],
    timeoutMs: 15000,
    onDelta: () => { deltas += 1; }
  });
  console.log(JSON.stringify({ ok: true, deltas, text: result.text }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error.code, message: error.message }));
}
