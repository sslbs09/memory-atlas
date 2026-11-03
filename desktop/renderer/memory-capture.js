/**
 * memory-capture.js — Alpha-01 注入记忆工作台的轻量工具条与面板。
 *
 * 职责（不重排工作台版式、不替代任何既有控件）：
 *   1. 顶栏加一组 Alpha 控件：服务状态、＋记住这段内容、记忆对话实验、载入演示记忆；
 *   2. 「记住这段内容」面板：写当前空间的正式记录（来源 manual / alpha-capture），
 *      写入确认后自动刷新列表并选中新记录（经 alpha:memory-written 事件，不再手动刷新）；
 *   3. 「新建空间」面板：常驻入口（顶栏 ＋ 与写入面板内链接），不再只在零空间时出现；
 *   4. 「确认重提」面板：经 Event Bridge 的 user_remention 准入（唯一强化类事件）；
 *   5. 服务启动失败时，把真实原因显示出来（不是"没有记忆"）。
 *
 * 面板行为：Esc 关闭、点击面板外关闭、工具条按钮开关切换（不再重置已填内容）、
 * 关闭时归还焦点。文案不走 i18n 词典（新增键不在 zh.json 里），静态中文。
 * 所有数据都经 petAPI IPC。
 */
(function () {
  "use strict";

  const api = window.petAPI;
  if (!api) return;

  let panel = null;
  let panelMode = null; // 'capture' | 'space' | 'revisit' | 'service'
  let panelOpener = null;

  const SPACE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
    captureBtn.title = "写入一条正式记忆（快捷键 n）";
    captureBtn.addEventListener("click", () => togglePanel("capture"));

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
      const previous = select.value;
      select.innerHTML = "";
      for (const spaceId of listed.spaceIds || []) {
        const option = document.createElement("option");
        option.value = spaceId;
        option.textContent = spaceId;
        select.append(option);
      }
      if (listed.current) select.value = listed.current;
      // 只有当前空间真的变了才派发 change：否则会触发一次多余的全量重载
      // （工作台自己的 spaces-changed 订阅已经把选项刷好了）。
      if (select.value !== previous) select.dispatchEvent(new Event("change"));
    } catch { /* 空间刷新失败不打断主流程 */ }
  }

  /* ---------------- 面板（写入 / 新建空间 / 重提 / 服务状态） ---------------- */

  function closePanel({ restoreFocus = true } = {}) {
    if (!panel) return;
    panel.remove();
    panel = null;
    panelMode = null;
    const opener = panelOpener;
    panelOpener = null;
    if (restoreFocus && opener && opener.isConnected && typeof opener.focus === "function") {
      opener.focus({ preventScroll: true });
    }
  }

  function togglePanel(mode) {
    if (panel && panelMode === mode) closePanel();
    else openPanel(mode);
  }

  function openPanel(mode, context) {
    const wasOpen = Boolean(panel);
    const previousOpener = panelOpener;
    closePanel({ restoreFocus: false });
    panelMode = mode;
    // 面板之间跳转（写入→新建空间）时，焦点仍归还给最初打开面板的控件。
    panelOpener = wasOpen ? previousOpener : document.activeElement;
    panel = el("div", "alpha-panel");
    panel.id = "alpha-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label",
      mode === "capture" ? "记住这段内容" : mode === "space" ? "新建记忆空间"
        : mode === "revisit" ? "确认重新提到了它" : "Atlas 服务状态");

    const head = el("div", "alpha-panel-head");
    const title = el("h3", "alpha-panel-title",
      mode === "capture" ? "记住这段内容" : mode === "space" ? "新建记忆空间"
        : mode === "revisit" ? "确认这次重新提到了它" : "Atlas 服务状态");
    const close = el("button", "alpha-panel-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "关闭面板");
    close.addEventListener("click", () => closePanel());
    head.append(title, close);
    panel.append(head);

    if (mode === "capture") buildCaptureForm(panel);
    else if (mode === "space") buildSpaceForm(panel);
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
    const newSpaceLink = el("button", "alpha-linkbtn", "新建空间…");
    newSpaceLink.type = "button";
    newSpaceLink.addEventListener("click", () => openPanel("space"));
    spaceLine.append(spaceName, newSpaceLink);
    root.append(spaceLine);

    const textarea = el("textarea", "alpha-textarea");
    textarea.rows = 5;
    textarea.maxLength = 4000;
    textarea.placeholder = "一段经历、一件小事、一个约定……（最多 4000 字，Ctrl+Enter 写入）";
    textarea.setAttribute("aria-label", "记忆内容");
    root.append(textarea);

    const counter = el("div", "alpha-counter", "0 / 4000");
    root.append(counter);
    textarea.addEventListener("input", () => {
      counter.textContent = textarea.value.length + " / 4000";
    });

    const kindLine = el("div", "alpha-row");
    kindLine.append(el("span", "alpha-label", "类型"));
    const kind = document.createElement("select");
    kind.className = "alpha-select";
    kind.setAttribute("aria-label", "记录类型");
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
    occurredAt.setAttribute("aria-label", "发生时间");
    timeLine.append(occurredAt);
    root.append(timeLine);

    const submit = el("button", "alpha-btn alpha-btn-primary", "写入记忆");
    submit.type = "button";
    const feedback = el("div", "alpha-feedback");
    feedback.setAttribute("role", "status");

    async function doWrite() {
      const text = textarea.value.trim();
      if (!text) { feedback.textContent = "内容为空。"; textarea.focus(); return; }
      if (!currentSpaceId()) {
        feedback.textContent = "还没有记忆空间：先创建一个。";
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
          feedback.textContent = `已写入（${result.outcome === "IDEMPOTENT_REPLAY" ? "幂等重放" : "RECORDED"}）recordId=${result.recordId} · 已在列表中选中`;
          // 工作台收到事件后自动回档案、清筛选、刷新并选中这条记录。
          document.dispatchEvent(new CustomEvent("alpha:memory-written", {
            detail: { recordId: result.recordId }
          }));
          const again = el("button", "alpha-btn", "再写一条");
          again.type = "button";
          again.addEventListener("click", () => {
            textarea.value = "";
            counter.textContent = "0 / 4000";
            feedback.textContent = "";
            submit.disabled = false;
            textarea.focus();
          });
          const done = el("button", "alpha-btn", "完成");
          done.type = "button";
          done.addEventListener("click", () => closePanel());
          feedback.append(document.createElement("br"), again, done);
        } else {
          feedback.textContent = "写入失败：" + (result.error || result.status || "未知原因");
          submit.disabled = false;
        }
      } catch (error) {
        feedback.textContent = "写入失败：" + error;
        submit.disabled = false;
      }
    }

    submit.addEventListener("click", () => { void doWrite(); });
    textarea.addEventListener("keydown", (event) => {
      // 中文输入法组字期间的回车只用于上屏；Ctrl+Enter 才是提交。
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        if (!submit.disabled) void doWrite();
      }
    });
    root.append(submit, feedback);
  }

  function buildSpaceForm(root) {
    root.append(el("p", "alpha-note",
      "空间是相互隔离的记忆环境：各有自己的记录与索引。创建后会立即切换到新空间。"));

    const idInput = document.createElement("input");
    idInput.className = "alpha-input";
    idInput.placeholder = "空间 ID（字母数字开头，如 my-life）";
    idInput.maxLength = 64;
    idInput.setAttribute("aria-label", "空间 ID");
    const labelInput = document.createElement("input");
    labelInput.className = "alpha-input";
    labelInput.placeholder = "显示名（可选）";
    labelInput.maxLength = 80;
    labelInput.setAttribute("aria-label", "显示名");
    const createBtn = el("button", "alpha-btn alpha-btn-primary", "创建空间");
    createBtn.type = "button";
    const feedback = el("div", "alpha-feedback");
    feedback.setAttribute("role", "status");

    async function doCreate() {
      const spaceId = idInput.value.trim();
      if (!SPACE_ID_RE.test(spaceId)) {
        feedback.textContent = "空间 ID 只能用字母、数字、点、下划线、连字符，且以字母或数字开头。";
        idInput.focus();
        return;
      }
      createBtn.disabled = true;
      feedback.textContent = "创建中…";
      try {
        const result = await api.createSpace({ spaceId, label: labelInput.value.trim() });
        if (result.ok) {
          feedback.textContent = `空间 ${result.spaceId} 已创建并选中。`;
          await refreshSpaces();
          const write = el("button", "alpha-btn", "写入第一条记忆");
          write.type = "button";
          write.addEventListener("click", () => openPanel("capture"));
          const done = el("button", "alpha-btn", "完成");
          done.type = "button";
          done.addEventListener("click", () => closePanel());
          feedback.append(document.createElement("br"), write, done);
        } else {
          feedback.textContent = "创建失败：" + (result.error || result.status || "未知原因");
          createBtn.disabled = false;
        }
      } catch (error) {
        feedback.textContent = "创建失败：" + error;
        createBtn.disabled = false;
      }
    }

    createBtn.addEventListener("click", () => { void doCreate(); });
    for (const input of [idInput, labelInput]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing && !createBtn.disabled) {
          event.preventDefault();
          void doCreate();
        }
      });
    }
    root.append(idInput, labelInput, createBtn, feedback);
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
    feedback.setAttribute("role", "status");
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

  /* ---------------- 面板全局行为 ---------------- */

  function bindPanelBehavior() {
    // Esc 优先关面板（捕获阶段），不让它同时触发工作台的编辑器关闭。
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel) {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
      }
    }, true);
    // 点击面板与工具条之外：关闭。不归还焦点——焦点应留在用户点的地方。
    document.addEventListener("mousedown", (event) => {
      if (!panel) return;
      const target = event.target;
      if (panel.contains(target)) return;
      if (target.closest && target.closest("#alpha-toolbar")) return;
      closePanel({ restoreFocus: false });
    });
    // 工作台快捷键与常驻入口的意图事件。
    document.addEventListener("alpha:open-capture-panel", () => togglePanel("capture"));
    document.addEventListener("alpha:open-space-panel", () => openPanel("space"));
  }

  function start() {
    buildToolbar();
    watch();
    bindPanelBehavior();
    if (api.onSpacesChanged) api.onSpacesChanged(() => void refreshServiceStatus());
    if (api.onServiceFailed) {
      api.onServiceFailed((payload) => {
        openPanel("service", { message: "Atlas 服务启动失败：" + (payload && payload.message ? payload.message : "未知原因") });
        void refreshServiceStatus();
      });
    }
    // 服务芯片是 Atlas 模式下唯一的连接指示：定期复核，服务死了不能一直绿着。
    setInterval(() => { void refreshServiceStatus(); }, 30000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) void refreshServiceStatus();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
