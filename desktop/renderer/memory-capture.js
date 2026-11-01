/**
 * memory-capture.js — Alpha-01 注入记忆工作台的轻量工具条与面板。
 *
 * 只做四件事，不重排工作台版式、不替代任何既有控件：
 *   1. 顶栏加一组 Alpha 控件：服务状态、＋记住这段内容、确认重提（在详情页动作行里）、
 *      载入合成演示记忆、记忆对话实验入口；
 *   2. 「记住这段内容」面板：写当前空间的正式记录（来源 manual / alpha-capture）；
 *   3. 「确认重提」面板：经 Event Bridge 的 user_remention 准入（唯一强化类事件）；
 *   4. 服务启动失败时，把真实原因显示出来（不是"没有记忆"）。
 *
 * 文案不走 i18n 词典（新增键不在 zh.json 里），静态中文。所有数据都经 petAPI IPC。
 */
(function () {
  "use strict";

  const api = window.petAPI;
  if (!api) return;

  let panel = null;
  let panelMode = null; // 'capture' | 'revisit' | 'service'
  let currentRecordId = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ---------------- 顶栏工具条 ---------------- */

  function buildToolbar() {
    const telemetry = document.querySelector(".wb-telemetry");
    if (!telemetry || document.getElementById("alpha-toolbar")) return;

    const bar = el("div", "alpha-bar");
    bar.id = "alpha-toolbar";

    const statusDot = el("span", "alpha-dot");
    statusDot.id = "alpha-status-dot";
    const statusText = el("span", "alpha-status-text", "Atlas 检查中…");
    statusText.id = "alpha-status-text";
    const status = el("button", "alpha-chip alpha-chip-status", "");
    status.type = "button";
    status.title = "点击查看 Atlas 服务状态";
    status.append(statusDot, statusText);
    status.addEventListener("click", () => openPanel("service"));

    const captureBtn = el("button", "alpha-chip", "＋ 记住这段内容");
    captureBtn.type = "button";
    captureBtn.addEventListener("click", () => openPanel("capture"));

    const chatBtn = el("button", "alpha-chip", "记忆对话实验");
    chatBtn.type = "button";
    chatBtn.addEventListener("click", () => { void api.openChat(); });

    const demoBtn = el("button", "alpha-chip alpha-chip-dim", "载入演示记忆");
    demoBtn.type = "button";
    demoBtn.title = "写入三条合成演示记忆到独立空间 alpha-demo（与真实使用数据隔离）";
    demoBtn.addEventListener("click", () => { void seedDemo(demoBtn); });

    bar.append(status, captureBtn, chatBtn, demoBtn);
    telemetry.append(bar);
    void refreshServiceStatus();
  }

  async function refreshServiceStatus() {
    const dot = document.getElementById("alpha-status-dot");
    const text = document.getElementById("alpha-status-text");
    if (!dot || !text) return;
    try {
      const status = await api.serviceStatus();
      if (status.state === "running") {
        dot.dataset.tone = "ok";
        text.textContent = status.external
          ? "Atlas（外部）已连接"
          : `Atlas 已连接 ·:${status.port}`;
        // 工作台源芯片是静态 FORMAL_CORE（WhiteMoon 语境）；Atlas 模式下改成真实来源名。
        const chip = document.getElementById("wb-source-chip");
        if (chip) chip.textContent = "ATLAS_NATIVE";
      } else if (status.state === "starting") {
        dot.dataset.tone = "pending";
        text.textContent = "Atlas 启动中…";
      } else {
        dot.dataset.tone = "bad";
        text.textContent = "Atlas 离线";
      }
    } catch (error) {
      dot.dataset.tone = "bad";
      text.textContent = "Atlas 状态未知";
    }
  }

  async function seedDemo(button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "写入中…";
    try {
      const result = await api.seedDemo();
      if (result.ok) {
        button.textContent = "已写入 alpha-demo";
        await refreshSpaces();
      } else {
        button.textContent = "写入失败";
        openPanel("service", { message: "演示记忆写入失败：" + (result.error || JSON.stringify(result.written || result)) });
      }
    } catch (error) {
      button.textContent = "写入失败";
    }
    setTimeout(() => { button.disabled = false; button.textContent = original; }, 2500);
  }

  async function refreshSpaces() {
    try {
      const listed = await api.listSpaces();
      if (!listed || !listed.supported) return;
      const select = document.getElementById("wb-space");
      if (!select) return;
      select.innerHTML = "";
      for (const spaceId of listed.spaceIds || []) {
        const option = document.createElement("option");
        option.value = spaceId;
        option.textContent = spaceId;
        select.append(option);
      }
      if (listed.current) select.value = listed.current;
      select.dispatchEvent(new Event("change"));
    } catch { /* 空间刷新失败不打断主流程 */ }
  }

  /* ---------------- 面板（写入 / 重提 / 服务状态） ---------------- */

  function closePanel() {
    if (panel) { panel.remove(); panel = null; panelMode = null; }
  }

  function openPanel(mode, context) {
    closePanel();
    panelMode = mode;
    panel = el("div", "alpha-panel");
    panel.id = "alpha-panel";

    const head = el("div", "alpha-panel-head");
    const title = el("h3", "alpha-panel-title",
      mode === "capture" ? "记住这段内容" : mode === "revisit" ? "确认这次重新提到了它" : "Atlas 服务状态");
    const close = el("button", "alpha-panel-close", "×");
    close.type = "button";
    close.addEventListener("click", closePanel);
    head.append(title, close);
    panel.append(head);

    if (mode === "capture") buildCaptureForm(panel);
    else if (mode === "revisit") buildRevisitForm(panel, context);
    else buildServiceView(panel, context);

    document.body.append(panel);
    const first = panel.querySelector("textarea, input, button");
    if (first) first.focus();
  }

  function buildCaptureForm(root) {
    const note = el("p", "alpha-note",
      "写入当前记忆空间的正式记录（来源标记 manual/alpha-capture）。模型生成的文字不会自动变成记忆——只有你亲手写的内容走这里。");
    root.append(note);

    const spaceLine = el("div", "alpha-row");
    spaceLine.append(el("span", "alpha-label", "空间"));
    const spaceName = el("b", "", currentSpaceId() || "（未选择）");
    spaceLine.append(spaceName);
    root.append(spaceLine);

    const textarea = el("textarea", "alpha-textarea");
    textarea.rows = 5;
    textarea.maxLength = 4000;
    textarea.placeholder = "一段经历、一件小事、一个约定……（最多 4000 字）";
    root.append(textarea);

    const kindLine = el("div", "alpha-row");
    kindLine.append(el("span", "alpha-label", "类型"));
    const kind = document.createElement("select");
    kind.className = "alpha-select";
    for (const [value, label] of [["experience", "经历"], ["observation", "观察"], ["note", "备注"]]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      kind.append(option);
    }
    kindLine.append(kind);
    root.append(kindLine);

    const timeLine = el("div", "alpha-row");
    timeLine.append(el("span", "alpha-label", "发生时间"));
    const occurredAt = document.createElement("input");
    occurredAt.type = "datetime-local";
    occurredAt.className = "alpha-input";
    timeLine.append(occurredAt);
    root.append(timeLine);

    const submit = el("button", "alpha-btn alpha-btn-primary", "写入记忆");
    submit.type = "button";
    const feedback = el("div", "alpha-feedback");
    submit.addEventListener("click", async () => {
      const text = textarea.value.trim();
      if (!text) { feedback.textContent = "内容为空。"; return; }
      if (!currentSpaceId()) {
        feedback.textContent = "还没有记忆空间：先在下方创建一个。";
        return;
      }
      submit.disabled = true;
      feedback.textContent = "写入中…";
      try {
        const result = await api.addMemory({
          text,
          kind: kind.value,
          occurredAt: occurredAt.value ? new Date(occurredAt.value).toISOString() : undefined
        });
        if (result.ok) {
          feedback.textContent = `已写入（${result.outcome === "IDEMPOTENT_REPLAY" ? "幂等重放" : "RECORDED"}）recordId=${result.recordId}`;
          const refresh = el("button", "alpha-btn", "刷新列表查看");
          refresh.type = "button";
          refresh.addEventListener("click", () => {
            closePanel();
            const go = document.getElementById("wb-go");
            if (go) go.click();
          });
          feedback.append(document.createElement("br"), refresh);
        } else {
          feedback.textContent = "写入失败：" + (result.error || result.status || "未知原因");
          submit.disabled = false;
        }
      } catch (error) {
        feedback.textContent = "写入失败：" + error;
        submit.disabled = false;
      }
    });
    root.append(submit, feedback);

    if (!currentSpaceId()) {
      const createLine = el("div", "alpha-create");
      createLine.append(el("p", "alpha-note", "还没有记忆空间时，可以先创建一个："));
      const idInput = document.createElement("input");
      idInput.className = "alpha-input";
      idInput.placeholder = "空间 ID（字母数字开头，如 my-life）";
      const labelInput = document.createElement("input");
      labelInput.className = "alpha-input";
      labelInput.placeholder = "显示名（可选）";
      const createBtn = el("button", "alpha-btn", "创建空间");
      createBtn.type = "button";
      const createFeedback = el("div", "alpha-feedback");
      createBtn.addEventListener("click", async () => {
        const result = await api.createSpace({ spaceId: idInput.value.trim(), label: labelInput.value.trim() });
        if (result.ok) {
          createFeedback.textContent = `空间 ${result.spaceId} 已创建并选中。`;
          await refreshSpaces();
          spaceName.textContent = result.spaceId;
        } else {
          createFeedback.textContent = "创建失败：" + (result.error || result.status);
        }
      });
      createLine.append(idInput, labelInput, createBtn, createFeedback);
      root.append(createLine);
    }
  }

  function buildRevisitForm(root, context) {
    const note = el("p", "alpha-note",
      "只有你明确确认「这次对话/念头里真的重新提到了它」时才记录 user_revisited。检索命中本身不算——合法重提是唯一会强化激活的事件。");
    root.append(note);

    const recordLine = el("div", "alpha-row");
    recordLine.append(el("span", "alpha-label", "记录"));
    recordLine.append(el("b", "", context && context.recordId ? context.recordId : "（未指定）"));
    root.append(recordLine);

    const textarea = el("textarea", "alpha-textarea");
    textarea.rows = 3;
    textarea.maxLength = 500;
    textarea.placeholder = "你这次是怎么提到它的？（可选，会存进事件凭据）";
    root.append(textarea);

    const submit = el("button", "alpha-btn alpha-btn-primary", "确认重提");
    submit.type = "button";
    const feedback = el("div", "alpha-feedback");
    submit.addEventListener("click", async () => {
      if (!context || !context.recordId) { feedback.textContent = "缺少记录 ID。"; return; }
      submit.disabled = true;
      try {
        const result = await api.revisitConfirm({ recordId: context.recordId, utterance: textarea.value.trim() });
        if (result.ok) {
          feedback.textContent = `已记录 user_revisited（eventId=${result.eventId}）。下一次影子解释里可以看到激活变化。`;
        } else {
          feedback.textContent = "未记录：" + (result.reason || "未知原因") +
            (result.detail ? `（${result.detail}）` : "");
          submit.disabled = false;
        }
      } catch (error) {
        feedback.textContent = "失败：" + error;
        submit.disabled = false;
      }
    });
    root.append(submit, feedback);
  }

  function buildServiceView(root, context) {
    if (context && context.message) {
      root.append(el("p", "alpha-feedback alpha-feedback-bad", context.message));
    }
    const box = el("div", "alpha-service");
    box.textContent = "读取中…";
    root.append(box);
    void api.serviceStatus().then((status) => {
      box.innerHTML = "";
      const rows = [
        ["状态", status.state],
        ["端口", status.external ? "(外部)" : status.port ?? "—"],
        ["进程 PID", status.pid ?? "—"],
        ["Node（子进程）", status.nodeVersion || "—"],
        ["Node 路径", status.nodePath || "—"],
        ["数据目录", status.dataDir || "—"],
        ["Electron 内嵌 Node", status.electronNode || "—"],
        ["GLM 引擎模块", status.glmModulePresent ? "已就位" : "缺失（见 PROVENANCE.md）"]
      ];
      if (status.index) {
        rows.push(["检索索引", JSON.stringify(status.index.state || status.index)]);
      }
      for (const [key, value] of rows) {
        const line = el("div", "alpha-service-row");
        line.append(el("span", "alpha-label", key), el("b", "", String(value)));
        box.append(line);
      }
      if (status.error || status.explainedError) {
        const err = el("pre", "alpha-service-err", (status.explainedError ? status.explainedError + "\n" : "") + (status.error || ""));
        box.append(err);
      }
      if (status.stderrTail && status.stderrTail.length) {
        const tail = el("pre", "alpha-service-tail", status.stderrTail.slice(-15).join("\n"));
        box.append(tail);
      }
    });
  }

  function currentSpaceId() {
    const select = document.getElementById("wb-space");
    return select && select.value ? select.value : null;
  }

  /* ---------------- 详情页动作行注入「确认重提」 ---------------- */

  const observer = new MutationObserver(() => {
    const reading = document.getElementById("wb-reading");
    if (!reading) return;
    const row = reading.querySelector('.wb-actions[data-testid="actions"] .wb-action-row');
    if (!row || row.querySelector(".alpha-revisit-btn")) return;
    const recordIdNode = document.getElementById("wb-recid");
    const recordId = recordIdNode ? recordIdNode.textContent.trim() : null;
    if (!recordId) return;
    const btn = el("button", "alpha-btn alpha-revisit-btn", "我重新提到了它");
    btn.type = "button";
    btn.title = "确认这次真的重新提到了这条记忆（记录 user_revisited，唯一强化类事件）";
    btn.addEventListener("click", () => openPanel("revisit", { recordId }));
    row.append(btn);
  });

  function watch() {
    const app = document.getElementById("wb-app");
    if (!app) {
      setTimeout(watch, 120);
      return;
    }
    observer.observe(app, { childList: true, subtree: true });
  }

  function start() {
    buildToolbar();
    watch();
    if (api.onSpacesChanged) api.onSpacesChanged(() => void refreshServiceStatus());
    if (api.onServiceFailed) {
      api.onServiceFailed((payload) => {
        openPanel("service", { message: "Atlas 服务启动失败：" + (payload && payload.message ? payload.message : "未知原因") });
        void refreshServiceStatus();
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
