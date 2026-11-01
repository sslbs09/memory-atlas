/**
 * chat.js — 记忆对话实验窗口（渲染层）。
 *
 * 数据路径：输入 → chatAPI.send（IPC）→ 主进程（Atlas 检索 + 影子解释 + 上下文
 * 构造 + OpenAI-compatible 调用）→ chat:event 流式回传。渲染层零网络。
 *
 * 三个集合（检索候选 / 进入上下文 / 回复实际引用）在调试视图里分开呈现，
 * 不混为一谈；记忆文本永远是数据，任何地方都不按 HTML 渲染。
 */
(function () {
  "use strict";

  const api = window.chatAPI;
  if (!api) return;

  const log = document.getElementById("chat-log");
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("chat-send");
  const stopBtn = document.getElementById("chat-stop");
  const empty = document.getElementById("chat-empty");
  const spaceChip = document.getElementById("chat-space-chip");
  const modelChip = document.getElementById("chat-model-chip");
  const configSection = document.getElementById("chat-config");
  const configToggle = document.getElementById("chat-config-toggle");
  const pop = document.getElementById("chat-detail-pop");

  let history = [];        // [{role:'user'|'assistant', content}]（不含本轮）
  let streaming = null;    // { requestId, bubble, textEl }
  let lastConfig = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function applyTheme(theme) {
    const root = document.documentElement;
    root.classList.toggle("theme-dark", theme === "dark");
    document.body.classList.toggle("theme-dark", theme === "dark");
  }

  /* ---------------- 头部 chips 与配置 ---------------- */

  async function refreshChips() {
    try {
      const cfg = await api.getConfig();
      lastConfig = cfg;
      spaceChip.textContent = "空间 " + (cfg.spaceId || "—");
      modelChip.textContent = cfg.configured
        ? `模型 ${cfg.model}${cfg.apiKeySet ? " ·key已配" : " ·无key"}`
        : "模型未配置（点击设置）";
    } catch { /* 主进程不可达时保持原样 */ }
  }

  function fillConfigForm(cfg) {
    document.getElementById("cfg-baseurl").value = cfg.baseURL || "";
    document.getElementById("cfg-model").value = cfg.model || "";
    document.getElementById("cfg-apikey").value = "";
    document.getElementById("cfg-timeout").value = cfg.timeoutMs || 60000;
    document.getElementById("cfg-context").value = cfg.contextLimit || 5;
  }

  configToggle.addEventListener("click", () => {
    configSection.hidden = !configSection.hidden;
    if (!configSection.hidden && lastConfig) fillConfigForm(lastConfig);
  });

  document.getElementById("cfg-save").addEventListener("click", async () => {
    const feedback = document.getElementById("cfg-feedback");
    const payload = {
      baseURL: document.getElementById("cfg-baseurl").value.trim(),
      model: document.getElementById("cfg-model").value.trim(),
      timeoutMs: Number(document.getElementById("cfg-timeout").value) || 60000,
      contextLimit: Number(document.getElementById("cfg-context").value) || 5
    };
    const apiKey = document.getElementById("cfg-apikey").value.trim();
    if (apiKey) payload.apiKey = apiKey;
    try {
      const saved = await api.setConfig(payload);
      lastConfig = saved;
      feedback.textContent = saved.configured ? "已保存。" : "已保存，但 baseURL/model 还不完整，还不能对话。";
      void refreshChips();
    } catch (error) {
      feedback.textContent = "保存失败：" + error;
    }
  });

  /* ---------------- 消息渲染 ---------------- */

  function renderCitations(textEl, text) {
    // 【记忆:xxx】变成可点击的引用芯片；其余内容一律 textContent，不渲染 HTML。
    const parts = String(text || "").split(/(【记忆[:：]\s*[A-Za-z0-9][A-Za-z0-9._-]*】)/g);
    for (const part of parts) {
      const match = /^【记忆[:：]\s*([A-Za-z0-9][A-Za-z0-9._-]*)】$/.exec(part);
      if (match) {
        const chip = el("span", "chat-cite", "记忆:" + match[1]);
        chip.title = "点击查看档案详情";
        chip.addEventListener("click", () => void showRecordDetail(match[1]));
        textEl.append(chip);
      } else if (part) {
        textEl.append(document.createTextNode(part));
      }
    }
  }

  function userTurn(text) {
    empty.hidden = true;
    const turn = el("div", "chat-turn");
    const msg = el("div", "chat-msg chat-msg-user");
    const bubble = el("div", "chat-bubble", text);
    msg.append(bubble);
    turn.append(msg);
    log.append(turn);
    scrollToEnd();
    return turn;
  }

  function assistantTurn() {
    const turn = el("div", "chat-turn");
    const msg = el("div", "chat-msg chat-msg-assistant");
    const bubble = el("div", "chat-bubble");
    msg.append(bubble);
    turn.append(msg);
    log.append(turn);
    scrollToEnd();
    return { turn, msg, bubble };
  }

  function errorTurn(message) {
    const turn = el("div", "chat-turn");
    turn.append(el("div", "chat-err", message));
    log.append(turn);
    scrollToEnd();
  }

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  /* ---------------- 调试视图 ---------------- */

  function debugTable(headers, rows, citeClickable) {
    const table = el("table");
    const thead = el("thead");
    const headRow = el("tr");
    for (const h of headers) headRow.append(el("th", null, h));
    thead.append(headRow);
    table.append(thead);
    const tbody = el("tbody");
    for (const row of rows) {
      const tr = el("tr");
      for (const cell of row) {
        const td = el("td");
        if (cell && typeof cell === "object" && cell.__cite) {
          const link = el("span", "cite-link", cell.text);
          link.addEventListener("click", () => void showRecordDetail(cell.recordId));
          td.append(link);
        } else if (cell && typeof cell === "object" && cell.__node) {
          td.append(cell.__node);
        } else {
          td.append(document.createTextNode(String(cell ?? "")));
          if (cell === null || cell === undefined || cell === "") td.classList.add("dim");
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    return table;
  }

  function citeCell(recordId) {
    return { __cite: true, text: recordId, recordId };
  }

  function buildDebugView(debug) {
    const details = el("details", "chat-debug");
    const summary = el("summary", null,
      `检索与上下文 · 候选 ${debug.candidateCount} · 上下文 ${debug.context.length} · 引用 ${debug.citedRecordIds.length}` +
      ` · ${debug.durationMs} ms`);
    const body = el("div", "chat-debug-body");

    body.append(el("h4", null, "本轮"));
    body.append(el("div", "mono", `空间：${debug.spaceId}\n用户消息：${debug.query}\n检索关键词：${debug.queryUsed || "（原句）"}${debug.queryAttempts && debug.queryAttempts.length > 1 ? `（尝试：${debug.queryAttempts.join(" → ")}）` : ""}\n模型：${debug.model}\nBaseURL：${debug.baseURL}\n检索路径：${debug.searchPath || "—"} · 索引：${debug.indexState || "—"} · 全库命中：${debug.totalCount ?? "—"}`));

    const shadow = debug.shadow;
    if (shadow && !shadow.error && Array.isArray(shadow.rows) && shadow.rows.length) {
      body.append(el("h4", null, `检索候选与影子排序（正式顺序 = A0${shadow.scopeWindowed ? "；df 表窗口化" : ""}）`));
      const rows = shadow.rows.map((r) => [
        citeCell(r.recordId),
        r.rankBy?.A0 ?? "",
        r.a0Score != null ? Number(r.a0Score).toFixed(3) : "—",
        `${r.evidenceClass || "—"}${r.tier != null ? `/T${r.tier}` : ""}`,
        `${r.rankBy?.L ?? "—"} / ${r.rankBy?.R ?? "—"} / ${r.rankBy?.LR ?? "—"} / ${r.rankBy?.D ?? "—"}${r.rankBy?.LR !== r.rankBy?.A0 ? " *" : ""}`,
        r.g2 && r.g2.multiplier !== 1 ? `×${Number(r.g2.multiplier).toFixed(2)}(${r.g2.count})` : "×1",
        String(r.revisitCount ?? 0),
        r.lastDeliveryText || "—"
      ]);
      body.append(debugTable(
        ["recordId", "A0分", "证据", "L/R/LR/D", "g2乘数", "合法重提", "最近投递"],
        rows
      ));
      body.append(el("div", "dim", `* = LR（或 R/L/D）与 A0 顺序不同，仅影子展示。正式上下文与 Atlas 返回都按 A0。`));
      if (shadow.refused) {
        const refused = Object.entries(shadow.refused).filter(([, v]) => v);
        if (refused.length) {
          body.append(el("div", "bad", "策略拒用：" + refused.map(([k, v]) => `${k}（${v}）`).join("；")));
        }
      }
      const notes = (shadow.notes || []).filter((n) => n.why);
      if (notes.length) {
        body.append(el("h4", null, "排名变动原因"));
        for (const n of notes) {
          body.append(el("div", "mono", `${n.strategy}: ${n.recordId} #${n.from}→#${n.to} — ${n.why}`));
        }
      }
      if (shadow.scopeNote) body.append(el("div", "dim", shadow.scopeNote));
      body.append(el("div", "dim", shadow.officialOrderNote || ""));
    } else if (shadow && shadow.error) {
      body.append(el("div", "bad", shadow.error));
    }

    body.append(el("h4", null, "真正传入模型上下文的记录"));
    const ctxRows = debug.context.map((r, i) => [
      String(i + 1),
      citeCell(r.recordId),
      String(r.recordRevision ?? "—"),
      String(r.source || "—"),
      String(r.content || "")
    ]);
    body.append(debugTable(["#", "recordId", "revision", "来源", "内容"], ctxRows));
    for (const r of debug.context) {
      const line = el("div");
      line.append(el("span", "dim", `${r.recordId} · `));
      const btn = el("button", "mini-btn", "确认这次真的重提了它");
      btn.type = "button";
      btn.title = "记录 user_revisited（唯一强化类事件；检索/上下文本身不算）";
      btn.addEventListener("click", async () => {
        const result = await api.revisitConfirm({ recordId: r.recordId, utterance: debug.query });
        btn.textContent = result.ok ? "已记录 ✓" : "未记录";
        btn.disabled = true;
      });
      line.append(btn);
      body.append(line);
    }

    body.append(el("h4", null, "模型回复中实际引用"));
    if (debug.citedRecordIds.length) {
      body.append(el("div", "good mono", debug.citedRecordIds.join(", ")));
    } else {
      body.append(el("div", "dim", "（模型没有标注引用任何一条——它可能只是读过）"));
    }
    if (debug.citedUnknown.length) {
      body.append(el("div", "bad", `标注了不在上下文里的编号：${debug.citedUnknown.join(", ")}（模型标注错误，不记事件）`));
    }
    body.append(el("div", "dim",
      `${debug.setsNote.candidates}\n${debug.setsNote.context}\n${debug.setsNote.cited}\n${debug.setsNote.disclaimer}`));

    details.append(summary, body);
    return details;
  }

  /* ---------------- 引用详情浮层 ---------------- */

  async function showRecordDetail(recordId) {
    pop.hidden = false;
    document.getElementById("chat-detail-id").textContent = recordId;
    const body = document.getElementById("chat-detail-body");
    body.textContent = "读取中…";
    try {
      const detail = await api.memoryDetail(recordId);
      body.innerHTML = "";
      if (!detail.ok || detail.outcome !== "MATCHED" || !detail.record) {
        body.append(el("div", "bad", "读不到这条记录：" + (detail.status || detail.outcome || "未知原因")));
        return;
      }
      const r = detail.record;
      const kvs = [
        ["状态", r.status],
        ["类型", r.recordType],
        ["发生时间", r.occurredAt || r.timestamp || "—"],
        ["记录时间", r.acceptedAt || "—"],
        ["序列", r.recordSequence ?? "—"],
        ["来源", r.declaredSource || "—"],
        ["空间", detail.servedInstanceId || "—"]
      ];
      for (const [k, v] of kvs) {
        const line = el("div", "kv");
        line.append(el("span", null, k), el("b", null, String(v)));
        body.append(line);
      }
      body.append(el("div", "content", r.summary || "（无内容）"));
      if (Array.isArray(detail.related) && detail.related.length) {
        body.append(el("h4", null, "关联记录"));
        for (const rel of detail.related.slice(0, 8)) {
          const line = el("div", "kv");
          line.append(el("span", null, rel.action || "related"), el("b", null, `${rel.recordId}（${rel.status}）`));
          body.append(line);
        }
      }
    } catch (error) {
      body.textContent = "读取失败：" + error;
    }
  }

  document.getElementById("chat-detail-close").addEventListener("click", () => { pop.hidden = true; });

  /* ---------------- 发送 / 事件流 ---------------- */

  function setStreamingUI(on) {
    sendBtn.disabled = on;
    stopBtn.hidden = !on;
    input.disabled = false;
  }

  async function send() {
    const text = input.value.trim();
    if (!text || streaming) return;
    await refreshChips(); // 空间/模型可能在别处被切换，发送前对齐一次
    input.value = "";
    userTurn(text);
    history.push({ role: "user", content: text });

    const raw = new Uint8Array(8);
    crypto.getRandomValues(raw);
    const requestId = "t" + Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
    const { bubble } = assistantTurn();
    const textEl = el("span");
    bubble.append(textEl);
    streaming = { requestId, bubble, textEl, full: "" };
    setStreamingUI(true);

    const result = await api.send({ requestId, message: text, history: history.slice(0, -1) });
    if (!result || result.ok !== true) {
      finishTurn();
      errorTurn("发送失败：" + (result && result.error ? result.error : "未知原因"));
    }
  }

  function finishTurn() {
    streaming = null;
    setStreamingUI(false);
  }

  api.onEvent((event) => {
    if (!event || !event.requestId || !streaming || event.requestId !== streaming.requestId) return;
    if (event.type === "delta") {
      streaming.full += event.text || "";
      streaming.textEl.textContent = "";
      renderCitations(streaming.textEl, streaming.full);
      scrollToEnd();
      return;
    }
    const turn = streaming.bubble.closest(".chat-turn");
    if (event.type === "done") {
      streaming.textEl.textContent = "";
      renderCitations(streaming.textEl, event.reply);
      history.push({ role: "assistant", content: event.reply });
      if (turn && event.debug) turn.append(buildDebugView(event.debug));
      finishTurn();
      scrollToEnd();
      // 回复已真实展示 → 投递确认（delivered_reference，只更新最近投递）。
      void api.displayed(event.requestId);
      return;
    }
    if (event.type === "aborted") {
      if (streaming.full) {
        streaming.textEl.textContent = "";
        renderCitations(streaming.textEl, streaming.full + "\n（已中断）");
        history.push({ role: "assistant", content: streaming.full });
      } else {
        streaming.bubble.textContent = "（已中断，本轮没有生成内容）";
      }
      finishTurn();
      return;
    }
    if (event.type === "error") {
      streaming.bubble.remove();
      if (!streaming.full) history.pop();
      errorTurn(`[${event.code || "MODEL_FAILED"}] ${event.message || "未知错误"}`);
      finishTurn();
    }
  });

  sendBtn.addEventListener("click", () => void send());
  stopBtn.addEventListener("click", () => {
    if (streaming) void api.cancel(streaming.requestId);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  });

  /* ---------------- 启动 ---------------- */

  void (async () => {
    try {
      const state = await api.getState();
      applyTheme(state && state.theme ? state.theme : "light");
    } catch { applyTheme("light"); }
    await refreshChips();
    if (lastConfig && !lastConfig.configured) {
      configSection.hidden = false;
      fillConfigForm(lastConfig);
    }
    input.focus();
  })();
})();
