// 临时探针：裸 fetch 直击协议桩。不属于交付面。
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 8000);
const started = Date.now();
try {
  const response = await fetch("http://127.0.0.1:8798/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "stub-echo-1",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    }),
    signal: controller.signal
  });
  console.log("status:", response.status, "ct:", response.headers.get("content-type"), `${Date.now() - started}ms`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  console.log("bytes:", text.length, `${Date.now() - started}ms`);
  console.log(text.slice(0, 200));
} catch (error) {
  console.log("FAILED", error.name, error.message, `${Date.now() - started}ms`);
} finally {
  clearTimeout(timer);
}
