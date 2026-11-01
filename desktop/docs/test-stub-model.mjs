/**
 * test-stub-model.mjs — 本地 OpenAI-compatible 协议桩（仅传输联调用）。
 *
 * 这不是模型，也不是 Mock 记忆：它只是把 /v1/chat/completions 说对——
 * 接收 messages，流式吐 SSE，并在回复里按固定规则引用上下文里的记忆编号，
 * 用于验证 Alpha 的检索→上下文→流式→引用解析→事件 全链路接线。
 * 真实模型联调状态以交付报告为准（本环境没有可用的模型供应商）。
 *
 * 行为：回复第一段说明；若 system 里有 [记忆资料 begin] 块，则把前两条
 * recordId 原样放进【记忆:…】标注里——模拟"模型确实用了记忆"。
 * 若上一条用户消息里含"你好"，不引用任何记忆——模拟"无相关记忆也正常回答"。
 *
 *   node desktop/docs/test-stub-model.mjs [port=8798]
 */

import http from "node:http";

const port = Number(process.argv[2]) || 8798;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "stub-echo-1", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    let payload = null;
    try { payload = JSON.parse(raw); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "bad json" } }));
      return;
    }
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const memorySystem = messages
      .filter((m) => m.role === "system" && typeof m.content === "string" && m.content.includes("[记忆资料 begin]"))
      .map((m) => m.content)
      .join("\n");
    const ids = [...memorySystem.matchAll(/recordId:\s*([A-Za-z0-9._-]+)/g)].map((m) => m[1]);
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const question = String(lastUser?.content || "");
    const memoryIds = /你好|你是谁/.test(question) ? [] : ids.slice(0, 2);

    const cited = memoryIds.length
      ? `我查了你的记忆档案：${memoryIds.map((id) => `【记忆:${id}】`).join("、")}。这是按你记录里的内容回答的。`
      : "这个问题不需要翻记忆，我直接回答：你好，我是通过本地协议桩接入的测试服务。";
    const reply = `（协议桩回复）${cited}`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });
    // 按 payload.stream 说话：true → SSE 分片；false → 整包 JSON（测试非流式回落）。
    if (payload.stream === false) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }));
      return;
    }
    const chunks = reply.match(/[\s\S]{1,24}/g) || [];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i] } }] })}\n\n`);
        i += 1;
        return;
      }
      res.write("data: [DONE]\n\n");
      clearInterval(timer);
      res.end();
    }, 30);
    // 注意：不能挂 req 的 "close" 来清定时器——请求体读完它就触发，会把 SSE 掐死。
    res.on("close", () => clearInterval(timer));
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "stub-listening", port }));
});
