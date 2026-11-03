/**
 * memory-workbench.js — 记忆档案工作台的界面逻辑（Universal Memory v0.1）
 *
 * 与既有接线的关系：本文件重写交互层，不新增任何读写通道。
 *   - 读取：petAPI.memorySearch / memoryDetail / memoryOperation /
 *           memoryHealth / memoryCapacity（全部是 Host→Core 只读视图的转发）
 *   - 写入：petAPI.controlFormalMemory（唯一既有路径，含 consent gate）
 *   - 本地转写：petAPI.memoryContextSearch（永远标为非正式）
 *
 * 界面不持有权威。四条可见纪律：
 *   1. 读不到 ≠ 没有记忆。故障在列表与报头同时成句，绝不渲染成「没有匹配」。
 *   2. 写入只认服务端确认。未确认就是未确认，并给出按操作标识查询的入口。
 *   3. 任何数字缺就显示缺失，不补零、不算比例、不画假进度。
 *   4. 历史文本一律走 textContent 渲染，绝不拼接 HTML。
 */
(function () {
  "use strict";

  const api = window.petAPI;
  const app = document.getElementById("wb-app");
  if (!app) return;

  const t = (key, params) => (window.I18N ? window.I18N.t(key, params) : key);
  const PAGE_SIZE = 25;
  /** 服务端未提供时间过滤时的窗口上限：Core 的 limit 上限就是 200。 */
  const WINDOW_LIMIT = 200;
  const MAX_CHAIN = 8;

  const STATUS_LABEL = {
    active: "set.memWbStatusActive",
    superseded: "set.memWbStatusSuperseded",
    retracted: "set.memWbStatusRetracted",
    recorded: "set.memWbStatusRecorded"
  };
  /** 只有"例外"才盖章：有效记录不需要印章，需要被一眼看见的是被改动过的。 */
  const STAMP_LABEL = {
    superseded: "set.memWbStatusSuperseded",
    retracted: "set.memWbStatusRetracted",
    recorded: "set.memWbStatusRecorded"
  };
  /** Host / Body 的失败码 → 一句人能读的话。绝不并成「没有匹配」。 */
  const FAULT_TEXT = {
    MEMORY_ACCESS_DENIED: "set.memWbConsent",
    MEMORY_UNAVAILABLE: "set.memWbHostDown",
    FORMAL_DISABLED: "set.memWbHostDown",
    HOST_NOT_READY: "set.memWbHostDown",
    MEMORY_RESULT_UNKNOWN: "set.memWbResultUnknown",
    MEMORY_READ_TIMEOUT: "set.wbReadTimeout",
    SOURCE_UNAVAILABLE: "set.memWbUnavailable",
    INSTANCE_UNAVAILABLE: "set.memWbUnavailable",
    INSTANCE_MISMATCH: "set.memWbUnavailable",
    PACKAGE_MISMATCH: "set.memWbUnavailable",
    MEMORY_QUERY_INVALID: "set.memWbUnavailable",
    MEMORY_READ_FAILED: "set.memWbUnavailable",
    UNINDEXED: "set.memWbUnindexed"
  };

  const els = {
    list: document.getElementById("wb-list"),
    count: document.getElementById("wb-count"),
    windowNote: document.getElementById("wb-window-note"),
    page: document.getElementById("wb-page"),
    prev: document.getElementById("wb-prev"),
    next: document.getElementById("wb-next"),
    q: document.getElementById("wb-q"),
    go: document.getElementById("wb-go"),
    status: document.getElementById("wb-status"),
    type: document.getElementById("wb-type"),
    time: document.getElementById("wb-time"),
    order: document.getElementById("wb-order"),
    instance: document.getElementById("wb-instance"),
    revisionLabel: document.getElementById("wb-revision-label"),
    revision: document.getElementById("wb-revision"),
    conn: document.getElementById("wb-conn"),
    connText: document.getElementById("wb-conn-text"),
    reader: document.getElementById("wb-reader"),
    readerEmpty: document.getElementById("wb-reader-empty"),
    sheet: document.getElementById("wb-sheet"),
    seq: document.getElementById("wb-seq"),
    recid: document.getElementById("wb-recid"),
    typechip: document.getElementById("wb-typechip"),
    stamp: document.getElementById("wb-stamp"),
    reading: document.getElementById("wb-reading"),
    margin: document.getElementById("wb-margin"),
    back: document.getElementById("wb-back"),
    ledger: document.getElementById("wb-ledger"),
    ledgerClear: document.getElementById("wb-ledger-clear"),
    feedback: document.getElementById("wb-feedback"),
    feedbackRefresh: document.getElementById("wb-feedback-refresh"),
    chainList: document.getElementById("wb-chain-list"),
    chainTarget: document.getElementById("wb-chain-target"),
    figures: document.getElementById("wb-figures"),
    budget: document.getElementById("wb-budget"),
    index: document.getElementById("wb-index"),
    faults: document.getElementById("wb-faults"),
    actions: document.getElementById("wb-actions"),
    maintRefresh: document.getElementById("wb-maint-refresh"),
    size: document.getElementById("wb-size"),
    refresh: document.getElementById("wb-refresh"),
    uniCanvas: document.getElementById("wb-uni-canvas"),
    uniStars: document.getElementById("wb-uni-stars"),
    uniScope: document.getElementById("wb-uni-scope"),
    uniLoading: document.getElementById("wb-uni-loading"),
    uniBlocked: document.getElementById("wb-uni-blocked"),
    uniBlockedReason: document.getElementById("wb-uni-blocked-reason"),
    uniBack: document.getElementById("wb-uni-back"),
    uniStats: document.getElementById("wb-uni-stats"),
    uniRegions: document.getElementById("wb-uni-regions"),
    uniRecall: document.getElementById("wb-uni-recall"),
    uniSelection: document.getElementById("wb-uni-selection"),
    uniHist: document.getElementById("wb-uni-hist"),
    uniRange: document.getElementById("wb-uni-range"),
    uniCutoff: document.getElementById("wb-uni-tl-read"),
    uniRefresh: document.getElementById("wb-uni-refresh"),
    uniRecenter: document.getElementById("wb-uni-recenter"),
    uniGraphSource: document.getElementById("wb-uni-graph-source"),
    spaceWrap: document.getElementById("wb-space-wrap"),
    space: document.getElementById("wb-space"),
    spaceNew: document.getElementById("wb-space-new")
  };

  const state = {
    mode: "search",
    pane: "list",
    query: "",
    status: "active",
    type: "",
    time: "all",
    order: "newest",
    limit: PAGE_SIZE,
    offset: 0,
    records: [],
    total: 0,
    // 时间窗口模式：服务端没有时间参数，客户端只能在返回的窗口内筛选，
    // 这两个数字用来诚实地说明"筛了多少"。
    windowed: false,
    scanned: 0,
    totalMatch: 0,
    // null=未知；true=服务端按 since 过滤；false=退回窗口内筛选
    serverTime: null,
    // Atlas 模式才有：可选记忆空间与图查询能力
    spaces: [],
    spaceSupported: false,
    service: null,
    selectedId: null,
    detail: null,
    chain: [],
    chainBroken: null,
    revision: null,
    instanceId: null,
    busy: false,
    listFault: null,
    conn: "unknown",
    connDetail: "",
    notice: null,
    editorOpen: false,
    editorText: "",
    // 撤回两步确认：第一次点击只是"举枪"，4 秒内再点一次才真正撤回。
    retractArmed: null,
    pending: null,
    capacity: null,
    capacityFault: null,
    capacityBusy: false,
    ledger: [],
    feedback: [],
    feedbackFault: null,
    types: [],
    readSize: "m"
  };

  // ---------------------------------------------------------------------------
  // 纯工具
  // ---------------------------------------------------------------------------

  const SIZE_STEPS = ["s", "m", "l"];
  const SIZE_PX = { s: "14px", m: "16px", l: "18px" };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    // 只有 textContent：历史文本永远不参与 HTML 解析。
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function timeText(value) {
    const ms = Date.parse(String(value || ""));
    if (!Number.isFinite(ms)) return "—";
    const lang = window.I18N ? window.I18N.lang() : "zh";
    try {
      return new Date(ms).toLocaleString(lang === "zh" ? "zh-CN" : lang, {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
      });
    } catch {
      return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
    }
  }

  /**
   * 容量按十进制单位显示：Host 的容量目标是 20,000,000,000 字节，产品口径就是
   * 「20 GB」。用 1024 换算会显示成 18.6 GB，看起来像没达到目标，反而误导。
   */
  function bytesText(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
    if (bytes < 1000) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1000;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
    return value.toFixed(value < 10 ? 2 : 1) + " " + units[unit];
  }

  function percentText(ratio) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
    const pct = ratio * 100;
    if (pct === 0) return "0 %";
    if (pct < 0.0001) return "<0.0001 %";
    if (pct < 1) return pct.toFixed(4) + " %";
    return pct.toFixed(2) + " %";
  }

  function faultText(result) {
    const status = (result && (result.status || result.code)) || "";
    const detail = result && result.error ? String(result.error) : "";
    const key = FAULT_TEXT[status];
    if (status === "MEMORY_QUERY_INVALID" && detail) return { text: detail, detail: status };
    const text = t(key || "set.memWbUnavailable");
    return { text, detail: detail && detail !== text ? detail : status };
  }

  function newOperationId() {
    const stamp = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
    return "wb-" + stamp + "-" + rand;
  }

  function store(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 配额/隐私模式：忽略 */ }
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch {
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // 操作台账（本机旁注，不是权威）
  // ---------------------------------------------------------------------------

  const LEDGER_KEY = "wb.ledger.v1";
  const LEDGER_MAX = 40;

  function loadLedger() {
    const rows = load(LEDGER_KEY, []);
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => row && typeof row.operationId === "string").slice(0, LEDGER_MAX);
  }

  function saveLedger() {
    store(LEDGER_KEY, state.ledger.slice(0, LEDGER_MAX));
  }

  function recordLedger(entry) {
    state.ledger = [entry, ...state.ledger.filter((row) => row.operationId !== entry.operationId)].slice(0, LEDGER_MAX);
    saveLedger();
    renderLedger();
  }

  function markLedger(operationId, patch) {
    let found = false;
    state.ledger = state.ledger.map((row) => {
      if (row.operationId !== operationId) return row;
      found = true;
      return Object.assign({}, row, patch);
    });
    if (found) saveLedger();
    renderLedger();
  }

  function ledgerStateText(value) {
    if (value === "confirmed") return t("set.wbLedgerConfirmed");
    if (value === "unconfirmed") return t("set.wbLedgerUnconfirmed");
    if (value === "notlanded") return t("set.wbLedgerNotLanded");
    return t("set.wbLedgerFailed");
  }

  function renderLedger() {
    const box = els.ledger;
    if (!box) return;
    clear(box);
    if (!state.ledger.length) {
      box.append(el("p", "wb-note", t("set.wbLedgerEmpty")));
      return;
    }
    for (const row of state.ledger) {
      const item = el("div", "wb-ledger-item");
      const main = el("div", "wb-ledger-main");

      const action = el("div", "wb-ledger-action");
      const act = el("span", "act", row.action === "correct" ? "CORRECT" : "RETRACT");
      act.dataset.action = row.action === "correct" ? "correct" : "retract";
      action.append(act, el("span", "", row.targetExperienceId || "—"));
      main.append(action);

      main.append(el("div", "wb-ledger-sub", row.operationId + " · " + timeText(row.at)));
      item.append(main);

      const stateNode = el("span", "wb-ledger-state", ledgerStateText(row.state));
      stateNode.dataset.state = row.state;
      item.append(stateNode);

      if (row.state === "unconfirmed") {
        const verify = el("button", "wb-linkbtn wb-ledger-verify", t("set.wbVerify"));
        verify.type = "button";
        verify.dataset.operationId = row.operationId;
        verify.addEventListener("click", () => { void verifyOperation(row.operationId); });
        item.append(verify);
      }
      box.append(item);
    }
  }

  // ---------------------------------------------------------------------------
  // 报头与状态
  // ---------------------------------------------------------------------------

  function connOkLabel() {
    return state.service && /atlas/i.test(state.service) ? t("set.wbConnOkAtlas") : t("set.wbConnOk");
  }

  function setConn(tone, text, detail) {
    state.conn = tone;
    state.connDetail = detail || "";
    if (!els.conn) return;
    els.conn.dataset.tone = tone;
    if (els.connText) els.connText.textContent = text;
    els.conn.title = state.connDetail;
  }

  function applyConnFromResult(result) {
    if (result && result.ok) {
      setConn("ok", connOkLabel(), "");
      return;
    }
    const status = (result && (result.status || result.code)) || "";
    if (status === "MEMORY_ACCESS_DENIED") setConn("bad", t("set.wbConnDenied"), status);
    else if (status === "MEMORY_RESULT_UNKNOWN") setConn("pending", t("set.wbConnUnknownState"), status);
    else setConn("bad", t("set.wbConnFault"), status);
  }

  function renderTelemetry() {
    if (els.instance) els.instance.textContent = state.instanceId || "—";
    // 空间选择器已经把"当前是哪个空间"说清楚了，再显示一个同名实例字段是重复信息
    const instanceField = els.instance && els.instance.parentElement;
    if (instanceField) instanceField.hidden = state.spaceSupported && state.spaces.length > 0;
    if (els.revisionLabel) {
      els.revisionLabel.textContent = state.spaceSupported ? t("set.wbRevisionControl") : t("set.memWbRevisionLabel");
      els.revisionLabel.title = state.spaceSupported ? t("set.wbRevisionControlHint") : "";
    }
    if (els.revision) els.revision.textContent = state.revision === null || state.revision === undefined ? "—" : String(state.revision);
  }

  // ---------------------------------------------------------------------------
  // 列表
  // ---------------------------------------------------------------------------

  function renderList() {
    const box = els.list;
    if (!box) return;
    clear(box);
    box.dataset.busy = state.busy ? "true" : "false";

    if (state.listFault) {
      const wrap = el("div", "wb-empty");
      wrap.append(el("p", "wb-empty-fault", state.listFault.text));
      if (state.listFault.detail) wrap.append(el("p", "wb-note", state.listFault.detail));
      const retry = el("button", "wb-btn", t("set.wbRetry"));
      retry.type = "button";
      retry.style.marginTop = "10px";
      retry.addEventListener("click", () => { void search({ reset: false }); });
      wrap.append(retry);
      box.append(wrap);
      return;
    }

    if (!state.records.length) {
      const wrap = el("div", "wb-empty");
      wrap.append(el("p", "wb-empty-title", t("set.memWbNotFound")));
      // 默认筛选下一条都没有：这是"空间还空着"，不是"搜不到"——引导写第一条。
      const pristine = !state.query && state.status === "active" && !state.type &&
        state.time === "all" && state.totalMatch === 0;
      wrap.append(el("p", "wb-note", state.query ? t("set.wbEmptyQueryHint")
        : pristine ? t("set.wbEmptySpace") : t("set.wbEmptyHint")));
      box.append(wrap);
      return;
    }

    for (const record of state.records) {
      const row = el("button", "wb-row");
      row.type = "button";
      row.setAttribute("role", "option");
      row.dataset.id = record.recordId;
      row.dataset.status = record.status;
      row.dataset.testid = "row";
      row.setAttribute("aria-selected", String(record.recordId === state.selectedId));

      row.append(el("span", "wb-row-seq", record.recordSequence === null || record.recordSequence === undefined
        ? "—"
        : String(record.recordSequence).padStart(3, "0")));
      row.append(el("span", "wb-row-flag"));

      const body = el("div", "wb-row-body");
      body.append(el("div", "wb-row-sum", record.summary || t("set.wbNoText")));
      const meta = el("div", "wb-row-meta");
      const st = el("span", "st", t(STATUS_LABEL[record.status] || "set.wbStatusUnknown"));
      st.dataset.status = record.status;
      meta.append(st, el("span", "", record.recordType || "—"), el("span", "", timeText(record.timestamp)));
      body.append(meta);
      row.append(body);

      row.addEventListener("click", () => { void openRecord(record.recordId); });
      box.append(row);
    }
    // 键盘导航（j/k/方向键）选中的行必须看得见；nearest 只在行已出屏时才滚动。
    const selected = box.querySelector('.wb-row[aria-selected="true"]');
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  function renderPager() {
    if (!els.page) return;
    const page = Math.floor(state.offset / state.limit) + 1;
    const pages = Math.max(1, Math.ceil(state.total / state.limit));
    els.page.textContent = t("set.wbPageOf", { page, pages, total: state.total });
    if (els.prev) els.prev.disabled = state.busy || state.offset <= 0;
    if (els.next) els.next.disabled = state.busy || state.offset + state.limit >= state.total;
  }

  function renderListMeta() {
    if (els.count) {
      els.count.textContent = state.busy ? t("set.memWbBusy") : t("set.wbCount", { n: state.total });
    }
    if (els.windowNote) {
      if (!state.windowed) {
        els.windowNote.hidden = true;
        els.windowNote.textContent = "";
      } else {
        els.windowNote.hidden = false;
        const truncated = state.totalMatch > state.scanned;
        els.windowNote.textContent = t(truncated ? "set.wbWindowTruncated" : "set.wbWindowNote", {
          shown: state.total,
          scanned: state.scanned,
          total: state.totalMatch
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 读取：搜索
  // ---------------------------------------------------------------------------

  function windowStart(time) {
    const now = Date.now();
    if (time === "1d") return now - 24 * 3600 * 1000;
    if (time === "7d") return now - 7 * 24 * 3600 * 1000;
    if (time === "30d") return now - 30 * 24 * 3600 * 1000;
    return null;
  }

  function timeSinceIso(time) {
    const ms = windowStart(time);
    return ms === null ? null : new Date(ms).toISOString();
  }

  function searchParams({ offset }) {
    const params = { status: state.status, limit: state.limit, offset, order: state.order };
    if (state.query) params.query = state.query;
    if (state.type) params.types = [state.type];

    const since = timeSinceIso(state.time);
    if (since && state.serverTime !== false) {
      // Host 的 /memory-search 支持 since/until：时间过滤在服务端对整个文档生效，
      // 这才是"近 7 天"该有的意思。
      params.since = since;
      params.timeField = "timestamp";
      return params;
    }
    if (since) {
      // 后端不支持时，只能取回一页再本地筛；界面上必须说明覆盖范围。
      params.limit = WINDOW_LIMIT;
      params.offset = 0;
    }
    return params;
  }

  function withinWindow(record, fromMs) {
    if (fromMs === null) return true;
    const ms = Date.parse(record.timestamp || record.acceptedAt || "");
    if (!Number.isFinite(ms)) return false;
    return ms >= fromMs;
  }

  async function rawSearch(params) {
    try {
      return await api.memorySearch(params);
    } catch {
      return { ok: false, status: "MEMORY_RESULT_UNKNOWN" };
    }
  }

  async function search({ reset = true } = {}) {
    if (state.busy) return;
    if (reset) state.offset = 0;
    state.busy = true;
    state.notice = null;
    state.listFault = null;
    renderListMeta();
    renderList();
    renderPager();

    let result = await rawSearch(searchParams({ offset: state.windowed ? 0 : state.offset }));
    state.busy = false;

    if (!result || !result.ok) {
      const status = (result && (result.status || result.code)) || "";
      if (status === "MEMORY_QUERY_INVALID" && state.time !== "all" && state.serverTime !== false &&
          /since|until|timeField/.test(String(result.error || ""))) {
        // 旧版 Host 会把未认识的参数按名字拒绝——这正是我们需要的信号。
        state.serverTime = false;
        await search({ reset: true });
        return;
      }
      state.records = [];
      state.total = 0;
      state.windowed = state.time !== "all";
      state.listFault = faultText(result || { status: "MEMORY_RESULT_UNKNOWN" });
      applyConnFromResult(result || null);
      renderListMeta(); renderList(); renderPager(); renderReaderEmptyFault();
      return;
    }

    const all = Array.isArray(result.records) ? result.records : [];
    state.revision = Number.isSafeInteger(result.revision) ? result.revision : state.revision;
    state.instanceId = result.servedInstanceId || state.instanceId;
    state.totalMatch = Number.isSafeInteger(result.totalCount) ? result.totalCount : all.length;
    state.scanned = Number.isSafeInteger(result.returned) ? result.returned : all.length;
    applyConnFromResult(result);
    seedTypes(all);

    const from = windowStart(state.time);
    if (from !== null && state.serverTime !== false) {
      // 信任但验证。两种"上游没把 since 传下去"的迹象：
      //   1. 这一页里出现了窗口外的记录；
      //   2. 总数与"不带时间条件"时一模一样，而档案里确实存在更早的记录。
      // 第二种只能靠一次额外的最小查询来判定（limit=1, 取最早一条）。
      const violations = all.filter((record) => !withinWindow(record, from));
      let ignored = violations.length > 0;
      if (!ignored) {
        const probe = await rawSearch({
          status: state.status,
          limit: 1,
          offset: 0,
          order: "oldest",
          ...(state.query ? { query: state.query } : {}),
          ...(state.type ? { types: [state.type] } : {})
        });
        if (probe && probe.ok && typeof probe.totalCount === "number" &&
            probe.totalCount === state.totalMatch &&
            Array.isArray(probe.records) && probe.records.length &&
            !withinWindow(probe.records[0], from)) {
          ignored = true;
        }
      }
      if (ignored) {
        state.serverTime = false;
        await search({ reset: true });
        return;
      }
      state.serverTime = true;
      state.windowed = false;
      state.total = state.totalMatch;
      state.scanned = state.totalMatch;
      state.records = all;
    } else if (from !== null) {
      const filtered = all.filter((record) => withinWindow(record, from));
      state.windowed = true;
      state.total = filtered.length;
      state.records = filtered.slice(state.offset, state.offset + state.limit);
    } else {
      state.windowed = false;
      state.total = state.totalMatch;
      state.records = all;
    }

    renderTelemetry();
    renderListMeta(); renderList(); renderPager();
  }

  function seedTypes(records) {
    const known = new Set(state.types);
    let added = false;
    for (const record of records) {
      if (record.recordType && !known.has(record.recordType)) {
        known.add(record.recordType);
        state.types.push(record.recordType);
        added = true;
      }
    }
    if (added) {
      state.types.sort();
      store("wb.types.v1", state.types);
      renderTypeOptions();
    }
  }

  function renderTypeOptions() {
    if (!els.type) return;
    const current = els.type.value;
    clear(els.type);
    const all = el("option", "", t("set.memWbTypeAll"));
    all.value = "";
    els.type.append(all);
    for (const type of state.types) {
      const option = el("option", "", type);
      option.value = type;
      els.type.append(option);
    }
    els.type.value = state.types.includes(current) ? current : "";
    state.type = els.type.value;
  }

  // ---------------------------------------------------------------------------
  // 记忆空间（Atlas 模式）：Archive 与 Universe 必须看同一个 space
  // ---------------------------------------------------------------------------

  function renderSpaceOptions() {
    if (!els.spaceWrap || !els.space) return;
    if (!state.spaceSupported) {
      els.spaceWrap.hidden = true;
      return;
    }
    // 一个空间都没有时也要露出「＋新建」：创建入口不再依赖"先打开写入面板"。
    els.spaceWrap.hidden = false;
    els.space.disabled = state.spaces.length === 0;
    const current = els.space.value;
    clear(els.space);
    for (const spaceId of state.spaces) {
      const option = el("option", "", spaceId);
      option.value = spaceId;
      els.space.append(option);
    }
    const wanted = state.instanceId || current;
    els.space.value = state.spaces.includes(wanted) ? wanted : (state.spaces[0] || "");
  }

  async function loadSpaces() {
    if (!api.listSpaces) return;
    let listed = null;
    try { listed = await api.listSpaces(); } catch { listed = null; }
    if (!listed || listed.supported !== true) {
      state.spaceSupported = false;
      delete app.dataset.atlas;
      renderSpaceOptions();
      return;
    }
    state.spaceSupported = true;
    // Atlas 模式下顶栏只留 Alpha 服务芯片一个连接指示（CSS 隐藏 wb-conn），
    // 避免两个"已连接"各说各话；读路径故障仍会在列表与阅读区成句。
    app.dataset.atlas = "true";
    state.spaces = Array.isArray(listed.spaceIds) ? listed.spaceIds : [];
    // 主进程的 currentSpace 是空间权威：即使本地已有 instanceId 也要跟住，
    // 否则演示种子/新建空间后选择器会与实际空间脱节（QA-01）。
    const previousSpace = state.instanceId;
    if (listed.current) state.instanceId = listed.current;
    if (!state.instanceId && state.spaces.length) {
      // 没有显式指定空间时选第一个：选择器同时显示出来，用户看得到自己在哪个空间
      const picked = await api.selectSpace(state.spaces[0]);
      if (picked && picked.ok) state.instanceId = picked.spaceId;
    }
    renderSpaceOptions();
    renderTelemetry();
    // 空间在别处被切换（新建空间/演示种子）时，视图必须自己跟上：
    // 不能指望注入层派发 change——它可能看到选择器已被更新而跳过派发。
    if (listed.current && previousSpace && listed.current !== previousSpace) {
      disarmRetract();
      state.offset = 0;
      state.selectedId = null;
      state.detail = null;
      state.chain = [];
      els.sheet.hidden = true;
      renderReaderEmptyFault();
      renderChainPanel();
      await search({ reset: true });
      await loadCapacity({ silent: true });
      if (universeMounted && window.MemoryUniverse) void window.MemoryUniverse.reload();
    }
  }

  async function switchSpace(spaceId) {
    if (!api.selectSpace) return;
    disarmRetract();
    state.notice = null;
    const result = await api.selectSpace(spaceId);
    if (!result || !result.ok) {
      state.listFault = { text: t("set.wbSpaceFailed"), detail: (result && result.status) || "" };
      renderList();
      return;
    }
    state.instanceId = result.spaceId;
    state.offset = 0;
    state.selectedId = null;
    state.detail = null;
    state.chain = [];
    els.sheet.hidden = true;
    renderTelemetry();
    // 重拉空间列表：别的入口（演示种子/新建空间）可能刚加了空间，
    // 用启动时的陈旧列表重绘会把新空间选项抹掉（QA-01）。
    await loadSpaces();
    await search({ reset: true });
    await loadCapacity({ silent: true });
    // 宇宙视图如果开着，跟着切到同一个空间（重新拉取并重建投影）
    if (universeMounted && window.MemoryUniverse) {
      void window.MemoryUniverse.reload();
    }
  }

  // ---------------------------------------------------------------------------
  // 读取：详情 + 纠正链
  // ---------------------------------------------------------------------------

  /**
   * 沿 changedBy 指针把纠正链走完。每一步都是一次 /memory-detail 读取，
   * 有上限、有环检测；走不通时明确记录断点，而不是把链补齐。
   */
  async function loadChain(recordId) {
    const nodes = [];
    const seen = new Set();
    let currentId = recordId;
    let broken = null;
    for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
      if (!currentId || seen.has(currentId)) break;
      seen.add(currentId);
      let detail = null;
      try {
        detail = await api.memoryDetail(currentId);
      } catch {
        broken = { id: currentId, reason: "MEMORY_RESULT_UNKNOWN" };
        break;
      }
      if (!detail || !detail.ok) {
        broken = { id: currentId, reason: (detail && (detail.status || detail.code)) || "MEMORY_READ_FAILED" };
        break;
      }
      if (detail.outcome !== "MATCHED" || !detail.record) {
        broken = { id: currentId, reason: "NO_MATCH" };
        break;
      }
      nodes.push(detail.record);
      currentId = detail.record.changedBy || null;
    }
    return { nodes, broken };
  }

  async function openRecord(recordId, { keepMode = false } = {}) {
    if (!recordId) return;
    if (state.retractArmed && state.retractArmed !== recordId) disarmRetract();
    state.selectedId = recordId;
    state.notice = null;
    state.editorOpen = false;
    state.pane = "reader";
    app.dataset.pane = "reader";
    renderList();
    // 窄窗下左列被隐藏，焦点必须跟着走，否则键盘用户会留在不可见的行上。
    if (window.matchMedia("(max-width: 900px)").matches && els.back) {
      requestAnimationFrame(() => els.back.focus({ preventScroll: true }));
    }

    // 先用列表里已有的摘要画骨架，避免右栏空白等待
    const stub = state.records.find((record) => record.recordId === recordId) || null;
    state.detail = stub ? { record: stub, related: [] } : null;
    renderSheet(state.detail, { loading: true });

    let detail = null;
    try {
      detail = await api.memoryDetail(recordId);
    } catch {
      detail = { ok: false, status: "MEMORY_RESULT_UNKNOWN" };
    }
    if (!detail || !detail.ok) {
      state.detail = null;
      state.chain = [];
      state.chainBroken = null;
      renderSheetFault(faultText(detail || { status: "MEMORY_RESULT_UNKNOWN" }));
      renderChainPanel();
      applyConnFromResult(detail || null);
      return;
    }
    if (detail.outcome !== "MATCHED" || !detail.record) {
      state.detail = null;
      state.chain = [];
      state.chainBroken = null;
      renderSheetFault({ text: t("set.memWbNotFound"), detail: recordId });
      renderChainPanel();
      return;
    }
    state.detail = detail;
    state.revision = Number.isSafeInteger(detail.revision) ? detail.revision : state.revision;
    renderTelemetry();
    renderSheet(detail, { loading: false });

    const chain = await loadChain(recordId);
    state.chain = chain.nodes;
    state.chainBroken = chain.broken;
    renderChainPanel();
    renderSheet(detail, { loading: false });
    void keepMode;
  }

  // ---------------------------------------------------------------------------
  // 渲染：阅读区
  // ---------------------------------------------------------------------------

  function renderSheetFault(fault) {
    els.sheet.hidden = true;
    els.readerEmpty.hidden = false;
    clear(els.readerEmpty);
    els.readerEmpty.append(el("p", "wb-empty-fault", fault.text));
    if (fault.detail) els.readerEmpty.append(el("p", "wb-note", fault.detail));
  }

  function renderReaderEmptyFault() {
    if (state.detail) return;
    els.sheet.hidden = true;
    els.readerEmpty.hidden = false;
    clear(els.readerEmpty);

    if (state.listFault) {
      // 读不到就把原因写在这里，绝不留一句"没有匹配"。
      els.readerEmpty.append(el("p", "wb-empty-fault", state.listFault.text));
      if (state.listFault.detail) els.readerEmpty.append(el("p", "wb-note", state.listFault.detail));
      return;
    }

    els.readerEmpty.append(el("p", "wb-empty-title", t("set.memWbDetailEmpty")));
    els.readerEmpty.append(el("p", "wb-note", t("set.wbReaderHint")));

    // 用目录代替空白：说明右栏会呈现哪四件事，用的是已有文案键。
    const index = el("div", "wb-empty-index");
    for (const key of ["set.memWbCurrent", "set.memWbOriginal", "set.wbChainTitle", "set.wbFields"]) {
      index.append(el("span", "", t(key)));
    }
    els.readerEmpty.append(index);
  }

  /**
   * 当前理解：只用 API 已返回的记录与纠正链推导。
   *
   * 关键在"多级纠正"：一条记录被纠正两次时，她现在的理解是**最新**那条更正，
   * 不是紧邻的那条。所以这里看链尾，而不是看 changedBy 指向的第一个控制记录。
   */
  function deriveCurrent(detail) {
    const record = detail && detail.record;
    if (!record) return { kind: "unknown", text: "" };

    const chain = state.chain.length ? state.chain : [record];
    const last = chain[chain.length - 1];
    if (last && last.recordId !== record.recordId && last.recordType === "memory-control") {
      if (last.action === "retract") return { kind: "retracted", text: "", from: last.recordId };
      if (last.action === "correct") return { kind: "corrected", text: last.summary, from: last.recordId };
    }

    if (record.status === "active") return { kind: "self", text: record.summary, from: record.recordId };
    if (record.status === "retracted") return { kind: "retracted", text: "", from: record.changedBy };
    if (record.status === "recorded") return { kind: "control-only", text: record.summary, from: record.recordId };
    if (record.status === "superseded") {
      const control = chain.find((node) => node.recordId === record.changedBy);
      if (control && control.action === "correct") return { kind: "corrected", text: control.summary, from: control.recordId };
      return { kind: "superseded-unknown", text: "", from: record.changedBy || null };
    }
    return { kind: "unknown", text: "" };
  }

  function renderSheet(detail, { loading }) {
    if (!detail || !detail.record) {
      if (loading) {
        // 骨架：右栏绝不留白，也不假装已有记录
        els.sheet.hidden = true;
        els.readerEmpty.hidden = false;
        clear(els.readerEmpty);
        const sk = el("div", "wb-skeleton");
        sk.append(el("span"), el("span"), el("span"));
        els.readerEmpty.append(sk);
      }
      return;
    }

    const record = detail.record;
    els.readerEmpty.hidden = true;
    els.sheet.hidden = false;

    els.seq.textContent = record.recordSequence === null || record.recordSequence === undefined
      ? "—"
      : "#" + String(record.recordSequence).padStart(3, "0");
    els.recid.textContent = record.recordId;
    els.typechip.textContent = record.recordType || "—";

    const stampKey = STAMP_LABEL[record.status];
    els.stamp.textContent = stampKey ? t(stampKey) : "";
    els.stamp.dataset.status = record.status;

    const reading = els.reading;
    clear(reading);

    if (loading) {
      const sk = el("div", "wb-skeleton");
      sk.append(el("span"), el("span"), el("span"));
      reading.append(sk);
      clear(els.margin);
      return;
    }

    const current = deriveCurrent(detail);

    // —— 当前理解 ——
    const currentSection = el("section", "wb-section");
    currentSection.dataset.testid = "current-section";
    currentSection.append(el("h2", "wb-block-label", t("set.memWbCurrent")));
    if (current.kind === "retracted") {
      currentSection.append(el("p", "wb-retract-note", t("set.wbRetractedNow")));
      currentSection.append(el("p", "wb-inline-note", t("set.wbRetractedHint")));
    } else if (current.kind === "superseded-unknown") {
      currentSection.append(el("p", "wb-inline-note", t("set.wbCurrentUnknown")));
    } else if (current.kind === "control-only") {
      currentSection.append(el("p", "wb-retract-note", t("set.wbControlOnly")));
    } else if (current.text) {
      const p = el("p", "wb-current-text", current.text);
      p.dataset.testid = "current-text";
      currentSection.append(p);
      if (current.kind === "corrected") {
        currentSection.append(el("p", "wb-inline-note", t("set.wbCurrentFrom", { id: current.from })));
      } else if (current.kind === "self") {
        currentSection.append(el("p", "wb-inline-note", t("set.wbCurrentSelf")));
      }
    } else {
      currentSection.append(el("p", "wb-inline-note", t("set.wbCurrentUnknown")));
    }
    reading.append(currentSection);

    // —— 原始记录（当前有效时不重复正文，只说明它就是原文）——
    if (record.status !== "active") {
      const originalSection = el("section", "wb-section");
      originalSection.dataset.testid = "original-section";
      originalSection.append(el("h2", "wb-block-label", t("set.memWbOriginal")));
      const original = el("p", "wb-original-text", record.summary || t("set.wbNoText"));
      if (record.status === "superseded") original.dataset.underline = "faded";
      original.dataset.testid = "original-text";
      originalSection.append(original);
      reading.append(originalSection);
    }

    // —— 纠正链 ——
    const chainSection = el("section", "wb-section");
    chainSection.dataset.testid = "chain-section";
    chainSection.append(el("h2", "wb-block-label", t("set.wbChainTitle")));
    chainSection.append(renderTimeline(record));
    if (state.chainBroken) {
      chainSection.append(el("p", "wb-inline-note", t("set.wbChainBroken", {
        id: state.chainBroken.id,
        reason: state.chainBroken.reason
      })));
    }
    reading.append(chainSection);

    // —— 本地转写（非正式，按需读取）——
    reading.append(renderContext(record));

    // —— 写入操作 ——
    reading.append(renderActions(record));

    renderMargin(detail);
  }

  function renderTimeline(record) {
    const wrap = el("div", "wb-chain-timeline");
    const nodes = state.chain.length ? state.chain : [record];
    if (nodes.length === 1 && nodes[0].recordId === record.recordId) {
      // 没有被改动过就不必把正文再抄一遍：链的语义是"变化"，不是"内容"。
      return el("p", "wb-inline-note", t("set.memWbRelatedNone"));
    }
    // 链按 changedBy 指针从旧到新走；这里反过来排，最新在上。
    const ordered = [...nodes].reverse();
    for (const node of ordered) {
      const item = el("div", "wb-tl-item");
      item.dataset.status = node.status;
      item.dataset.current = String(node.recordId === ordered[0].recordId);

      const head = el("div", "wb-tl-head");
      if (node.recordType === "memory-control") {
        const verb = el("span", "verb", node.action === "retract" ? t("set.memWbRetract") : t("set.memWbCorrect"));
        verb.dataset.action = node.action || "";
        head.append(verb);
      } else {
        head.append(el("span", "verb", t(STATUS_LABEL[node.status] || "set.wbStatusUnknown")));
      }
      head.append(el("span", "", timeText(node.timestamp)), el("span", "", node.recordId));
      item.append(head);

      if (node.recordType === "memory-control" && node.action === "retract") {
        item.append(el("p", "wb-tl-text", t("set.wbRetractedNow")));
      } else {
        item.append(el("p", "wb-tl-text", node.summary || t("set.wbNoText")));
      }
      wrap.append(item);
    }
    return wrap;
  }

  function renderContext(record) {
    const section = el("section", "wb-section");
    section.dataset.testid = "context-section";
    section.append(el("h2", "wb-block-label", t("set.memWbContext")));

    const body = el("div");
    const hint = el("p", "wb-inline-note", t("set.memWbContextHint"));
    const button = el("button", "wb-btn", t("set.memWbContextOpen"));
    button.type = "button";
    button.dataset.testid = "context-open";
    button.addEventListener("click", () => { void openContext(record, body, button); });

    section.append(hint, button, body);
    return section;
  }

  async function openContext(record, body, button) {
    const query = String(record.summary || "").replace(/\s+/g, " ").trim().slice(0, 40);
    clear(body);
    button.disabled = true;
    if (!query) { body.append(el("p", "wb-note", t("set.wbContextNoNeedle"))); button.disabled = false; return; }
    let result = null;
    try { result = await api.memoryContextSearch({ query, limit: 12 }); } catch { result = null; }
    button.disabled = false;
    if (!result) { body.append(el("p", "wb-note", t("set.memWbUnavailable"))); return; }
    if (result.outcome === "SOURCE_UNAVAILABLE") {
      body.append(el("p", "wb-note", t("set.memWbUnavailable") + "（" + (result.reason || "UNKNOWN") + "）"));
      return;
    }
    if (result.outcome === "UNINDEXED") body.append(el("p", "wb-note", t("set.memWbUnindexed")));
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (!rows.length) {
      body.append(el("p", "wb-note", t("set.wbContextNoMatch")));
      return;
    }
    const list = el("div", "wb-chain-timeline");
    for (const row of rows) {
      const item = el("div", "wb-tl-item");
      item.dataset.status = "recorded";
      const head = el("div", "wb-tl-head");
      head.append(el("span", "verb", row.role || "?"), el("span", "", timeText(row.at)));
      item.append(head, el("p", "wb-tl-text", row.content || ""));
      list.append(item);
    }
    body.append(list);
  }

  // ---------------------------------------------------------------------------
  // 写入：纠正 / 撤回 / 查询操作
  // ---------------------------------------------------------------------------

  let retractTimer = null;

  function disarmRetract() {
    if (retractTimer) { clearTimeout(retractTimer); retractTimer = null; }
    state.retractArmed = null;
  }

  function renderActions(record) {
    const section = el("section", "wb-actions");
    section.dataset.testid = "actions";

    if (state.notice) {
      const ok = el("div", "wb-confirm");
      const box = el("div", "grow");
      box.append(el("div", "t", state.notice.text));
      box.append(el("div", "d", state.notice.operationId || ""));
      ok.append(box);
      if (state.notice.tone === "unconfirmed" && state.notice.operationId) {
        // 未确认时，"下一步"不是再写一次，而是先把上一次的真实结果问清楚。
        const verify = el("button", "wb-btn", t("set.wbVerify"));
        verify.type = "button";
        verify.dataset.testid = "notice-verify";
        verify.addEventListener("click", () => { void verifyOperation(state.notice.operationId); });
        ok.append(verify);
      }
      section.append(ok);
    }

    if (state.notice && state.notice.tone === "unconfirmed") {
      section.append(el("p", "wb-action-note", t("set.wbUnconfirmedLock")));
      return section;
    }

    if (state.pending) {
      section.append(el("p", "wb-action-note", t("set.wbWritePending")));
      return section;
    }

    // 当前有效的纠正记录（memory-control / correct）本身也是"当前事实"，
    // 必须能继续纠正或撤回，否则同一件事只能纠正一次（QA-02：二级纠正无入口）。
    const correctableControl = record.recordType === "memory-control" && record.action === "correct";
    const editable = record.status === "active" &&
      (record.recordType !== "memory-control" || correctableControl);
    if (!editable) {
      section.append(el("p", "wb-action-note", t("set.wbNotEditable")));
      return section;
    }
    if (!state.instanceId) {
      section.append(el("p", "wb-action-note", t("set.wbNoInstance")));
      return section;
    }

    if (state.editorOpen) {
      section.append(renderEditor(record));
      return section;
    }

    const row = el("div", "wb-action-row");
    const correct = el("button", "wb-btn", t("set.memWbCorrect"));
    correct.type = "button";
    correct.dataset.testid = "correct-open";
    correct.addEventListener("click", () => {
      state.editorOpen = true;
      state.editorText = record.summary || "";
      renderSheet(state.detail, { loading: false });
      const editor = document.getElementById("wb-editor");
      if (editor) {
        editor.focus();
        editor.setSelectionRange(editor.value.length, editor.value.length);
      }
    });

    // 撤回是不可忽视的状态变更：单击只是预备，4 秒内再点一次才执行。
    // 历史永远可查，但误点不该让一条记录当场作废。
    const armed = state.retractArmed === record.recordId;
    const retract = el("button", "wb-btn wb-btn-danger" + (armed ? " wb-btn-armed" : ""),
      armed ? t("set.wbRetractConfirm") : t("set.memWbRetract"));
    retract.type = "button";
    retract.dataset.testid = "retract-submit";
    if (armed) retract.dataset.armed = "true";
    retract.addEventListener("click", () => {
      if (state.retractArmed === record.recordId) {
        disarmRetract();
        void submitControl({ action: "retract", record });
        return;
      }
      disarmRetract();
      state.retractArmed = record.recordId;
      renderSheet(state.detail, { loading: false });
      retractTimer = setTimeout(() => {
        retractTimer = null;
        if (state.retractArmed !== record.recordId) return;
        state.retractArmed = null;
        if (state.detail && state.detail.record && state.detail.record.recordId === record.recordId) {
          renderSheet(state.detail, { loading: false });
        }
      }, 4000);
    });

    row.append(correct, retract);
    section.append(row);
    section.append(el("p", "wb-action-note", armed ? t("set.wbRetractConfirmHint") : t("set.wbWriteNote")));
    return section;
  }

  function renderEditor(record) {
    const wrap = el("div", "wb-editor-wrap");
    wrap.append(el("label", "wb-block-label", t("set.memWbReplacement")));

    const editor = el("textarea", "wb-editor");
    editor.id = "wb-editor";
    editor.dataset.testid = "editor";
    editor.maxLength = 4000;
    editor.value = state.editorText || record.summary || "";
    editor.setAttribute("aria-label", t("set.memWbReplacement"));
    editor.addEventListener("input", () => {
      state.editorText = editor.value;
      const count = document.getElementById("wb-count-chars");
      if (count) count.textContent = editor.value.length + " / 4000";
    });
    editor.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        void submitControl({ action: "correct", record, text: editor.value });
      } else if (event.key === "Escape") {
        event.preventDefault();
        state.editorOpen = false;
        state.editorText = "";
        renderSheet(state.detail, { loading: false });
      }
    });

    const foot = el("div", "wb-editor-foot");
    const count = el("span", "count", editor.value.length + " / 4000");
    count.id = "wb-count-chars";
    const grow = el("span", "grow");
    const save = el("button", "wb-btn wb-btn-primary", t("set.formalMemSave"));
    save.type = "button";
    save.dataset.testid = "correct-submit";
    save.addEventListener("click", () => { void submitControl({ action: "correct", record, text: editor.value }); });
    const cancel = el("button", "wb-btn", t("set.cancelShort"));
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.editorOpen = false;
      state.editorText = "";
      renderSheet(state.detail, { loading: false });
    });
    foot.append(count, grow, save, cancel);

    wrap.append(editor, foot);
    wrap.append(el("p", "wb-action-note", t("set.wbEditorHint")));
    return wrap;
  }

  async function submitControl({ action, record, text }) {
    if (state.pending) return;
    const value = typeof text === "string" ? text.trim() : "";
    if (action === "correct" && !value) {
      state.editorOpen = true;
      state.editorText = text || "";
      renderSheet(state.detail, { loading: false });
      const wrap = document.querySelector(".wb-editor-wrap");
      if (wrap) wrap.append(el("p", "wb-empty-fault", t("set.formalMemNeedText")));
      return;
    }

    const operationId = newOperationId();
    state.pending = { operationId, action, target: record.recordId };
    renderSheet(state.detail, { loading: false });

    const payload = { instanceId: state.instanceId, operationId, targetExperienceId: record.recordId, action };
    if (action === "correct") payload.text = value;

    let result = null;
    try {
      result = await api.controlFormalMemory(payload);
    } catch {
      // 通道层没有任何回答：这是"未确认"，不是失败，更不是成功。
      result = { ok: false, status: "MEMORY_RESULT_UNKNOWN" };
    }
    state.pending = null;

    if (!result || !result.ok) {
      const status = (result && (result.status || result.code)) || "MEMORY_RESULT_UNKNOWN";
      if (status === "MEMORY_RESULT_UNKNOWN") {
        recordLedger({
          operationId, action, targetExperienceId: record.recordId,
          at: new Date().toISOString(), state: "unconfirmed"
        });
        state.notice = { text: t("set.memWbResultUnknown"), operationId, tone: "unconfirmed" };
        state.editorOpen = false;
        renderSheet(state.detail, { loading: false });
        return;
      }
      recordLedger({
        operationId, action, targetExperienceId: record.recordId,
        at: new Date().toISOString(), state: "failed", message: faultText(result || {}).text
      });
      state.notice = { text: faultText(result || {}).text, operationId, tone: "failed" };
      state.editorOpen = false;
      renderSheet(state.detail, { loading: false });
      return;
    }

    recordLedger({
      operationId, action, targetExperienceId: record.recordId,
      at: new Date().toISOString(), state: "confirmed"
    });
    state.editorOpen = false;
    state.editorText = "";

    // 只显示服务端确认后的状态：重新读列表与详情，而不是本地改状态。
    // 确认提示必须在刷新之后才写进去——刷新会清掉旧提示，这是刻意的。
    await search({ reset: false });
    await openRecord(record.recordId, { keepMode: true });
    state.notice = {
      text: result.outcome === "IDEMPOTENT_REPLAY" ? t("set.wbReplay") : t("set.memWbSaved"),
      operationId
    };
    renderSheet(state.detail, { loading: false });
    await loadCapacity({ silent: true });
  }

  async function verifyOperation(operationId) {
    if (!operationId) return;
    let result = null;
    try {
      result = await api.memoryOperation(operationId);
    } catch {
      result = { ok: false, status: "MEMORY_RESULT_UNKNOWN" };
    }
    if (!result || !result.ok) {
      state.notice = { text: faultText(result || {}).text, operationId };
      renderSheet(state.detail, { loading: false });
      return;
    }
    if (!result.recorded) {
      markLedger(operationId, { state: "notlanded" });
      state.notice = { text: t("set.wbNotLanded"), operationId };
      renderSheet(state.detail, { loading: false });
      return;
    }
    markLedger(operationId, { state: "confirmed" });
    const target = result.record && result.record.targetExperienceId
      ? result.record.targetExperienceId
      : state.selectedId;
    await search({ reset: false });
    if (target) await openRecord(target, { keepMode: true });
    state.notice = { text: t("set.wbVerified"), operationId };
    renderSheet(state.detail, { loading: false });
  }

  // ---------------------------------------------------------------------------
  // 渲染：边注
  // ---------------------------------------------------------------------------

  function renderMargin(detail) {
    const box = els.margin;
    clear(box);
    const record = detail.record;
    if (!record) return;

    const factsBlock = el("div", "wb-margin-block");
    factsBlock.append(el("h3", "wb-margin-title", t("set.wbFields")));
    const dl = el("dl", "wb-facts");
    const pairs = [
      [t("set.memWbStatus"), t(STATUS_LABEL[record.status] || "set.wbStatusUnknown")],
      [t("set.wbFieldSequence"), record.recordSequence === null || record.recordSequence === undefined ? "—" : String(record.recordSequence)],
      [t("set.memWbTime"), timeText(record.timestamp)],
      [t("set.wbFieldAccepted"), timeText(record.acceptedAt)],
      [t("set.wbFieldSource"), record.source || "—"],
      [t("set.wbFieldOrigin"), record.originAvailable ? t("set.wbOriginYes") : t("set.memWbOriginNone")],
      [t("set.wbFieldDeclared"), record.declaredSource || "—"],
      [t("set.wbFieldInstance"), detail.servedInstanceId || state.instanceId || "—"],
      [t("set.wbFieldRevision"), detail.revision === undefined || detail.revision === null ? "—" : String(detail.revision)]
    ];
    for (const [label, value] of pairs) {
      const cell = el("div");
      cell.append(el("dt", "", label));
      const dd = el("dd", String(value).length > 0 ? "" : "plain", value);
      cell.append(dd);
      dl.append(cell);
    }
    factsBlock.append(dl);
    box.append(factsBlock);

    if (record.originAvailable && record.origin) {
      const originBlock = el("div", "wb-margin-block");
      originBlock.append(el("h3", "wb-margin-title", t("set.memWbOrigin")));
      const originDl = el("dl", "wb-facts");
      for (const [key, value] of Object.entries(record.origin)) {
        if (value === null || value === undefined) continue;
        const cell = el("div");
        cell.append(el("dt", "", key));
        cell.append(el("dd", "", typeof value === "object" ? JSON.stringify(value) : String(value)));
        originDl.append(cell);
      }
      originBlock.append(originDl);
      box.append(originBlock);
    }

    const related = Array.isArray(detail.related) ? detail.related : [];
    const relatedBlock = el("div", "wb-margin-block");
    relatedBlock.append(el("h3", "wb-margin-title", t("set.memWbRelated")));
    if (!related.length) {
      relatedBlock.append(el("p", "wb-note", t("set.memWbRelatedNone")));
    } else {
      const list = el("div", "wb-rel-list");
      for (const item of related.slice(0, 8)) {
        const button = el("button", "wb-rel-item");
        button.type = "button";
        const idline = el("div", "wb-rel-id");
        if (item.recordType === "memory-control") {
          idline.append(el("span", "", item.action === "retract" ? "RETRACT" : "CORRECT"));
        }
        idline.append(el("span", "", item.recordId));
        button.append(idline);
        button.append(el("p", "wb-rel-sum", item.summary || t("set.wbNoText")));
        button.addEventListener("click", () => { void openRecord(item.recordId, { keepMode: true }); });
        list.append(button);
      }
      relatedBlock.append(list);
    }
    box.append(relatedBlock);
  }

  // ---------------------------------------------------------------------------
  // 管理视图：审查信号（Agent 举报，人裁决）
  // ---------------------------------------------------------------------------

  async function loadFeedback() {
    if (!api.feedbackList) return;
    let result = null;
    try { result = await api.feedbackList("pending"); } catch { result = null; }
    if (!result || !result.ok) {
      state.feedback = [];
      state.feedbackFault = result ? faultText(result) : { text: t("set.wbFeedbackFault"), detail: "MEMORY_RESULT_UNKNOWN" };
      renderFeedback();
      return;
    }
    state.feedbackFault = null;
    state.feedback = Array.isArray(result.feedback) ? result.feedback : [];
    renderFeedback();
  }

  function renderFeedback() {
    const box = els.feedback;
    if (!box) return;
    clear(box);
    if (state.feedbackFault) {
      box.append(el("p", "wb-empty-fault", state.feedbackFault.text));
      return;
    }
    if (!state.feedback.length) {
      box.append(el("p", "wb-note", t("set.wbFeedbackEmpty")));
      return;
    }
    for (const item of state.feedback) {
      const row = el("div", "wb-feedback-item");
      row.dataset.signal = item.signal;

      const head = el("div", "wb-feedback-head");
      const badge = el("span", "wb-feedback-badge",
        item.signal === "incorrect" ? t("set.wbFeedbackIncorrect") : t("set.wbFeedbackUseful"));
      badge.dataset.signal = item.signal;
      const source = el("span", "wb-feedback-source", (item.source && item.source.kind) || "unknown");
      head.append(badge, source, el("span", "wb-feedback-time", timeText(item.createdAt)));
      row.append(head);

      const target = el("button", "wb-feedback-target", item.recordId);
      target.type = "button";
      target.title = t("set.wbFeedbackOpen");
      target.addEventListener("click", () => { setMode("search"); void openRecord(item.recordId, { keepMode: true }); });
      row.append(target);

      if (item.note) row.append(el("p", "wb-feedback-note", item.note));

      const actions = el("div", "wb-feedback-actions");
      const open = el("button", "wb-btn", t("set.wbFeedbackOpen"));
      open.type = "button";
      open.addEventListener("click", () => { setMode("search"); void openRecord(item.recordId, { keepMode: true }); });
      const dismiss = el("button", "wb-btn", t("set.wbFeedbackDismiss"));
      dismiss.type = "button";
      dismiss.addEventListener("click", () => { void dismissFeedback(item.feedbackId, dismiss); });
      actions.append(open, dismiss);
      row.append(actions);
      box.append(row);
    }
  }

  async function dismissFeedback(feedbackId, button) {
    if (!api.feedbackResolve || !feedbackId) return;
    if (button) button.disabled = true;
    let result = null;
    try { result = await api.feedbackResolve({ feedbackId, resolution: "dismissed", by: "user" }); } catch { result = null; }
    if (!result || !result.ok) {
      if (button) button.disabled = false;
      state.feedbackFault = { text: t("set.wbFeedbackFault"), detail: (result && result.status) || "" };
      renderFeedback();
      return;
    }
    await loadFeedback();
  }

  // ---------------------------------------------------------------------------
  // 管理视图：纠正链面板
  // ---------------------------------------------------------------------------

  function renderChainPanel() {
    const box = els.chainList;
    if (!box) return;
    clear(box);
    if (els.chainTarget) els.chainTarget.textContent = state.selectedId || "—";
    if (!state.selectedId || !state.chain.length) {
      box.append(el("p", "wb-note", t("set.wbChainEmpty")));
      return;
    }
    const nodes = [...state.chain].reverse();
    for (const node of nodes) {
      const item = el("div", "wb-chain-node");
      item.dataset.status = node.status;
      item.dataset.current = String(node.recordId === nodes[0].recordId);

      const when = el("div", "wb-chain-when");
      if (node.recordType === "memory-control") {
        when.append(el("span", "", node.action === "retract" ? "RETRACT" : "CORRECT"));
      } else {
        when.append(el("span", "", t(STATUS_LABEL[node.status] || "set.wbStatusUnknown")));
      }
      when.append(el("span", "", timeText(node.timestamp)));
      item.append(when);
      item.append(el("p", "wb-chain-text", node.summary || t("set.wbNoText")));
      // 整个节点就是入口：档案条目里不需要再放一个重复的按钮。
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      item.title = t("set.wbOpenInReader");
      item.addEventListener("click", () => { void openRecord(node.recordId, { keepMode: true }); });
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void openRecord(node.recordId, { keepMode: true });
        }
      });
      box.append(item);
    }
    if (state.chainBroken) {
      box.append(el("p", "wb-inline-note", t("set.wbChainBroken", {
        id: state.chainBroken.id, reason: state.chainBroken.reason
      })));
    }
  }

  // ---------------------------------------------------------------------------
  // 维护与容量
  // ---------------------------------------------------------------------------

  function figure(label, bytes, sub) {
    const node = el("div", "wb-figure");
    node.append(el("span", "wb-figure-label", label));
    const text = bytesText(bytes);
    const value = el("b", "wb-figure-value", text === null ? t("set.wbMissing") : text);
    if (text === null) value.dataset.missing = "true";
    node.append(value);
    if (sub) node.append(el("div", "wb-figure-sub", sub));
    return node;
  }

  function renderMaintenance() {
    const figures = els.figures;
    const budget = els.budget;
    const index = els.index;
    const faultsBox = els.faults;
    const actions = els.actions;
    if (!figures || !budget || !index || !faultsBox || !actions) return;
    clear(figures); clear(budget); clear(index); clear(faultsBox); clear(actions);
    figures.style.gridTemplateColumns = "";

    if (state.capacityBusy && !state.capacity) {
      figures.append(figure(t("set.wbFigureFormal"), null), figure(t("set.wbFigureIndex"), null),
        figure(t("set.wbFigureLocal"), null), figure(t("set.wbFigureTotal"), null));
      budget.append(el("p", "wb-note", t("set.memWbBusy")));
      return;
    }

    if (state.capacityFault) {
      const banner = el("div", "wb-faultbanner");
      const box = el("div", "grow");
      box.append(el("div", "t", state.capacityFault.text));
      if (state.capacityFault.detail) box.append(el("div", "d", state.capacityFault.detail));
      banner.append(box);
      figures.style.gridTemplateColumns = "1fr";
      figures.append(banner);
      budget.append(el("p", "wb-note", t("set.wbCapacityMissing")));
      index.append(el("p", "wb-note", t("set.wbIndexUnknown")));
      faultsBox.append(el("p", "wb-note", t("set.wbNoFaultsRead")));
      actions.append(el("p", "wb-note", t("set.wbNoActions")));
      return;
    }

    const cap = state.capacity;
    if (!cap || !cap.capacity) {
      figures.append(figure(t("set.wbFigureFormal"), null, t("set.wbCapacityNotReported")));
      figures.append(figure(t("set.wbFigureIndex"), null, t("set.wbCapacityNotReported")));
      figures.append(figure(t("set.wbFigureLocal"), null, t("set.wbCapacityNotReported")));
      figures.append(figure(t("set.wbFigureTotal"), null, t("set.wbCapacityNotReported")));
      budget.append(el("p", "wb-note", t("set.wbCapacityMissing")));
      actions.append(el("p", "wb-note", t("set.wbNoActions")));
      return;
    }

    const c = cap.capacity;
    const measureKey = cap.formal && cap.formal.measureLabelKey ? cap.formal.measureLabelKey : "set.wbFigureFormalSub";
    figures.append(figure(t("set.wbFigureFormal"), c.authoritativeBytes, t(measureKey)));
    figures.append(figure(t("set.wbFigureIndex"), c.derivedCacheBytes, t("set.wbFigureIndexSub")));
    figures.append(figure(t("set.wbFigureLocal"), c.localTranscriptBytes, t("set.wbFigureLocalSub")));
    const totalKnown = [c.authoritativeBytes, c.derivedCacheBytes, c.localTranscriptBytes, c.localDerivedIndexBytes]
      .every((value) => Number.isSafeInteger(value));
    figures.append(figure(
      t("set.wbFigureTotal"),
      totalKnown ? c.authoritativeBytes + c.derivedCacheBytes + c.localTranscriptBytes + c.localDerivedIndexBytes : null,
      totalKnown ? t("set.wbFigureTotalSub") : t("set.wbFigureTotalPartial")
    ));

    // —— 容量目标：只画实测位置，不画"进度成就感" ——
    const head = el("div", "wb-budget-head");
    head.append(el("h3", "", t("set.wbBudgetTitle")));
    head.append(el("span", "pct", percentText(c.percentOfTarget) || t("set.wbMissing")));
    budget.append(head);

    const target = c.capacityTargetBytes;
    // 没有正式原文占用量就没有比例可画：这里说明缺的是什么，而不是画一条 0% 的假进度。
    if (!Number.isSafeInteger(c.authoritativeBytes)) {
      budget.append(el("p", "wb-note", t("set.wbCapacityMissing")));
    } else if (Number.isSafeInteger(target) && target > 0) {
      const scale = el("div", "wb-scale");
      for (const at of [0, 25, 50, 75, 100]) {
        const tick = el("div", "tick" + (at % 50 === 0 ? " major" : ""));
        tick.style.left = at + "%";
        scale.append(tick);
        const label = el("div", "tick-label", at === 0 ? "0" : at + " %");
        label.style.left = at + "%";
        scale.append(label);
      }
      if (typeof c.percentOfTarget === "number" && Number.isFinite(c.percentOfTarget)) {
        const marker = el("div", "marker");
        marker.style.left = Math.max(0, Math.min(100, c.percentOfTarget)) + "%";
        marker.title = t("set.wbBudgetMarker", {
          used: bytesText(c.authoritativeBytes) || t("set.wbMissing"),
          pct: percentText(c.percentOfTarget)
        });
        scale.append(marker);
      }
      budget.append(scale);

      budget.append(el("p", "wb-note wb-budget-note", t("set.wbBudgetUsed", {
        used: bytesText(c.authoritativeBytes) || t("set.wbMissing"),
        target: bytesText(target) || t("set.wbMissing"),
        pct: percentText(c.percentOfTarget) || t("set.wbMissing")
      })));
      budget.append(el("p", "wb-note wb-budget-note", t("set.memWbNoAutoDiscard")));
    } else {
      budget.append(el("p", "wb-note", t("set.wbBudgetNoTarget")));
    }

    // —— 索引状态 ——
    const sources = (cap.formal && Array.isArray(cap.formal.sources)) ? cap.formal.sources : [];
    if (!sources.length) {
      index.append(el("p", "wb-note", t("set.wbIndexUnknown")));
    } else {
      const table = el("table", "wb-ledger-table");
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const name of [t("set.wbColSource"), t("set.wbColAvailability"), t("set.wbColIndexing")]) {
        const th = document.createElement("th");
        th.textContent = name;
        hr.append(th);
      }
      thead.append(hr);
      table.append(thead);
      const tbody = document.createElement("tbody");
      for (const source of sources) {
        const tr = document.createElement("tr");
        for (const value of [source.id || "—", source.availability || "—", source.indexing || "—"]) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        tbody.append(tr);
      }
      table.append(tbody);
      index.append(table);
      const note = sources.find((source) => source.note);
      if (note) index.append(el("p", "wb-inline-note", note.note));
    }

    const local = cap.local;
    if (local && local.available === false) {
      const reason = String(local.reason || "UNKNOWN");
      // "这个后端不提供"和"这个目录读不出来"是两件事，不能共用一句话
      const key = reason.startsWith("NOT_PROVIDED") ? "set.wbLocalNotProvided" : "set.wbLocalUnavailable";
      index.append(el("p", "wb-inline-note", t(key, { reason })));
    } else if (local && Array.isArray(local.unindexedSegments) && local.unindexedSegments.length) {
      index.append(el("p", "wb-inline-note", t("set.wbLocalUnindexed", { n: local.unindexedSegments.length })));
    }

    // —— 最近维护错误：只列真实上报的字段 ——
    const findings = [];
    const unreadable = c.unreadable || {};
    if (unreadable.formal || c.formalAvailable === false) findings.push({ tag: "FORMAL", text: t("set.wbFaultFormal") });
    if (unreadable.localTranscript) findings.push({ tag: "LOCAL", text: t("set.wbFaultLocal") });
    const measurement = c.derived && c.derived.measurement;
    if (measurement && Array.isArray(measurement.unreadable)) {
      for (const item of measurement.unreadable.slice(0, 6)) {
        findings.push({ tag: "CACHE", text: (item.reason || "UNREADABLE") + " · " + (item.path || "") });
      }
    }
    if (measurement && measurement.partial) {
      findings.push({ tag: "CACHE", text: t("set.wbFaultPartial") + (measurement.truncatedAt ? " · " + measurement.truncatedAt : "") });
    }
    if (!findings.length) {
      faultsBox.append(el("p", "wb-note", t("set.wbNoFaults")));
    } else {
      for (const finding of findings) {
        const item = el("div", "wb-fault-item");
        item.append(el("span", "wb-fault-tag", finding.tag));
        item.append(el("span", "wb-fault-text", finding.text));
        faultsBox.append(item);
      }
    }

    // —— 可执行动作：后端提供才出现；未提供的只作为说明存在，不做成死按钮 ——
    const actionList = el("div", "wb-action-list");
    const refreshItem = el("div", "wb-action-item");
    refreshItem.append(el("span", "k", "REFRESH"));
    const refreshVal = el("span", "v");
    refreshVal.append(el("b", "", t("set.wbActionRefresh")));
    refreshVal.append(document.createTextNode(" — " + t("set.wbActionRefreshDesc")));
    refreshItem.append(refreshVal);
    actionList.append(refreshItem);

    const notProvided = el("div", "wb-action-item");
    notProvided.append(el("span", "k", "N/A"));
    const np = el("span", "v");
    np.append(el("b", "", t("set.wbActionUnavailable")));
    np.append(document.createTextNode(" — " + t("set.wbActionUnavailableDesc")));
    notProvided.append(np);
    actionList.append(notProvided);

    actions.append(actionList);
    const formalState = cap.formal && cap.formal.status;
    if (formalState && formalState !== "OK") {
      actions.append(el("p", "wb-inline-note", t("set.wbFormalState", { state: formalState })));
    }
  }

  async function loadCapacity({ silent = false } = {}) {
    if (state.capacityBusy) return;
    state.capacityBusy = true;
    if (!silent) renderMaintenance();
    let result = null;
    try {
      result = await api.memoryCapacity();
    } catch {
      result = null;
    }
    state.capacityBusy = false;
    if (!result) {
      state.capacity = null;
      state.capacityFault = { text: t("set.wbCapacityMissing"), detail: "MEMORY_RESULT_UNKNOWN" };
      renderMaintenance();
      return;
    }
    if (result.ok !== true) {
      state.capacity = null;
      state.capacityFault = faultText(result);
      renderMaintenance();
      return;
    }
    state.capacity = result;
    state.capacityFault = null;
    if (result.instanceId) state.instanceId = result.instanceId;
    renderTelemetry();
    renderMaintenance();
  }

  // ---------------------------------------------------------------------------
  // 模式与外壳
  // ---------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // 记忆宇宙：同一个窗口的第二种可视化，WebGL 只在进入时启动
  // -------------------------------------------------------------------------

  let universeMounted = false;

  /** 本次"召回"= 档案区当前的筛选结果；宇宙只高亮这些，不自己另算一套。 */
  function universeRecall() {
    const label = state.query
      ? "「" + state.query + "」"
      : t(STATUS_LABEL[state.status] || "set.memWbStatusAll");
    return { label, ids: state.records.map((record) => record.recordId) };
  }

  async function mountUniverse() {
    if (!window.MemoryUniverse) {
      state.listFault = { text: t("set.wbUniNoEngine"), detail: "memory-universe.js" };
      return;
    }
    universeMounted = true;
    const ok = await window.MemoryUniverse.mount({
      api,
      t,
      recall: universeRecall(),
      onOpenArchive: (recordId) => {
        // 从星图回到档案：同一个选择，同一个阅读区，不另开一个详情实现
        setMode("search");
        void openRecord(recordId, { keepMode: true });
      },
      els: {
        canvas: els.uniCanvas,
        stars: els.uniStars,
        scope: els.uniScope,
        loading: els.uniLoading,
        blocked: els.uniBlocked,
        blockedReason: els.uniBlockedReason,
        stats: els.uniStats,
        regions: els.uniRegions,
        recall: els.uniRecall,
        selection: els.uniSelection,
        hist: els.uniHist,
        range: els.uniRange,
        cutoff: els.uniCutoff,
        graphSource: els.uniGraphSource
      }
    });
    if (!ok && universeMounted) {
      // 失败也保留占位说明，用户能看到"为什么看不到"，而不是一片黑
      return;
    }
  }

  function unmountUniverse() {
    if (window.MemoryUniverse && universeMounted) window.MemoryUniverse.unmount();
    universeMounted = false;
  }

  const VIEW_TITLE_KEY = {
    search: "set.wbNavSearch",
    manage: "set.wbNavManage",
    maint: "set.wbNavMaint",
    universe: "set.wbNavUniverse"
  };

  function renderViewTitle() {
    const node = document.getElementById("wb-view-title");
    const key = VIEW_TITLE_KEY[state.mode];
    if (node && key) node.textContent = t(key);
  }

  function setMode(mode) {
    const leavingUniverse = state.mode === "universe" && mode !== "universe";
    state.mode = mode;
    app.dataset.mode = mode;
    renderViewTitle();
    for (const button of document.querySelectorAll(".wb-rail-item")) {
      button.setAttribute("aria-selected", String(button.dataset.mode === mode));
    }
    if (mode === "universe") {
      if (window.innerWidth <= 900) {
        state.pane = "list";
        app.dataset.pane = "list";
      }
      void mountUniverse();
    } else if (leavingUniverse) {
      // 关掉视图就停掉渲染循环：这个窗口不应该在后台继续烧 GPU
      unmountUniverse();
    }
    if (mode === "maint") {
      if (window.innerWidth <= 900) {
        state.pane = "list";
        app.dataset.pane = "list";
      }
      void loadCapacity();
    } else if (mode === "manage") {
      renderChainPanel();
      renderLedger();
      void loadFeedback();
    }
  }

  function setReadSize(size) {
    state.readSize = SIZE_STEPS.includes(size) ? size : "m";
    app.style.setProperty("--wb-read-size", SIZE_PX[state.readSize]);
    store("wb.readSize", state.readSize);
  }

  function cycleReadSize() {
    const index = SIZE_STEPS.indexOf(state.readSize);
    setReadSize(SIZE_STEPS[(index + 1) % SIZE_STEPS.length]);
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  let composing = false;

  function focusSearch() {
    if (!els.q) return;
    els.q.focus();
    els.q.select();
  }

  function runSearch() {
    state.query = els.q ? els.q.value.trim() : "";
    state.offset = 0;
    state.notice = null;
    void search({ reset: true });
  }

  function bindEvents() {
    if (els.go) els.go.addEventListener("click", runSearch);

    if (els.q) {
      els.q.addEventListener("compositionstart", () => { composing = true; });
      els.q.addEventListener("compositionend", () => { composing = false; });
      els.q.addEventListener("keydown", (event) => {
        // 中文输入法组字期间的回车只用于上屏，不触发搜索。
        if (event.key === "Enter" && !composing && !event.isComposing) runSearch();
        if (event.key === "Escape") { els.q.value = state.query; els.q.blur(); }
      });
    }

    if (els.status) {
      els.status.addEventListener("click", (event) => {
        const pressed = event.target.closest("button[data-status]");
        if (!pressed) return;
        state.status = pressed.dataset.status;
        state.offset = 0;
        state.notice = null;
        for (const node of els.status.querySelectorAll("button")) {
          node.setAttribute("aria-pressed", String(node === pressed));
        }
        void search({ reset: true });
      });
    }

    if (els.type) els.type.addEventListener("change", () => {
      state.type = els.type.value;
      state.offset = 0;
      state.notice = null;
      void search({ reset: true });
    });
    if (els.time) els.time.addEventListener("change", () => {
      state.time = els.time.value;
      state.offset = 0;
      state.notice = null;
      void search({ reset: true });
    });
    if (els.order) els.order.addEventListener("change", () => {
      state.order = els.order.value;
      state.offset = 0;
      void search({ reset: true });
    });

    if (els.prev) els.prev.addEventListener("click", () => {
      state.offset = Math.max(0, state.offset - state.limit);
      state.notice = null;
      void search({ reset: false });
    });
    if (els.next) els.next.addEventListener("click", () => {
      state.offset += state.limit;
      state.notice = null;
      void search({ reset: false });
    });

    for (const button of document.querySelectorAll(".wb-rail-item")) {
      button.addEventListener("click", () => setMode(button.dataset.mode));
    }

    if (els.back) els.back.addEventListener("click", () => {
      state.pane = "list";
      app.dataset.pane = "list";
    });

    if (els.refresh) els.refresh.addEventListener("click", () => {
      state.notice = null;
      void search({ reset: false });
      if (state.selectedId) void openRecord(state.selectedId, { keepMode: true });
      if (state.mode === "maint") void loadCapacity();
    });

    if (els.maintRefresh) els.maintRefresh.addEventListener("click", () => { void loadCapacity(); });
    if (els.size) els.size.addEventListener("click", cycleReadSize);

    if (els.space) {
      // 切换空间：适配器记住它，Archive 与 Universe 之后都读同一个 space
      els.space.addEventListener("change", () => { void switchSpace(els.space.value); });
    }
    if (els.spaceNew) {
      // 常驻创建入口（Issue #1）：具体表单由 Alpha 注入层提供，这里只发意图。
      els.spaceNew.addEventListener("click", () => {
        document.dispatchEvent(new CustomEvent("alpha:open-space-panel"));
      });
    }

    // 写入面板确认写入后：回到档案、清空筛选、刷新并选中新记录。
    // 写入是"现在就要看见它"的动作，不该再要求一次手动刷新。
    document.addEventListener("alpha:memory-written", (event) => {
      const recordId = event.detail && event.detail.recordId;
      void (async () => {
        setMode("search");
        disarmRetract();
        if (els.q) els.q.value = "";
        state.query = "";
        state.status = "active";
        if (els.status) {
          for (const node of els.status.querySelectorAll("button")) {
            node.setAttribute("aria-pressed", String(node.dataset.status === "active"));
          }
        }
        state.offset = 0;
        await search({ reset: true });
        if (recordId) await openRecord(recordId, { keepMode: true });
      })();
    });

    if (els.uniRefresh) {
      els.uniRefresh.addEventListener("click", () => {
        if (universeMounted && window.MemoryUniverse) void window.MemoryUniverse.reload();
      });
    }
    if (els.uniRecenter) {
      els.uniRecenter.addEventListener("click", () => {
        if (universeMounted && window.MemoryUniverse) window.MemoryUniverse.recenter();
      });
    }
    if (els.uniBack) {
      els.uniBack.addEventListener("click", () => setMode("search"));
    }

    // 窗口不可见时不渲染；重新可见时恢复，由用户下一次交互唤醒
    document.addEventListener("visibilitychange", () => {
      if (!universeMounted || !window.MemoryUniverse) return;
      if (document.hidden) window.MemoryUniverse.pause();
      else window.MemoryUniverse.resume();
    });
    window.addEventListener("beforeunload", unmountUniverse);

    if (els.ledgerClear) els.ledgerClear.addEventListener("click", () => {
      state.ledger = [];
      saveLedger();
      renderLedger();
    });

    if (els.feedbackRefresh) els.feedbackRefresh.addEventListener("click", () => { void loadFeedback(); });

    document.addEventListener("keydown", (event) => {
      const target = event.target;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" || target.isContentEditable);
      if (event.key === "/" && !typing) {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (typing) return;
      if (event.key === "n" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        document.dispatchEvent(new CustomEvent("alpha:open-capture-panel"));
        return;
      }
      const down = event.key === "j" || event.key === "ArrowDown";
      const up = event.key === "k" || event.key === "ArrowUp";
      if (down || up) {
        if (state.mode !== "search" || !state.records.length) return;
        event.preventDefault();
        const index = state.records.findIndex((record) => record.recordId === state.selectedId);
        const next = down ? index + 1 : index - 1;
        const record = state.records[Math.max(0, Math.min(state.records.length - 1, next))];
        if (record) void openRecord(record.recordId);
      }
      if (event.key === "Escape" && state.editorOpen) {
        state.editorOpen = false;
        state.editorText = "";
        renderSheet(state.detail, { loading: false });
      }
    });
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  function boot() {
    if (!api) {
      state.listFault = { text: t("set.wbNoBridge"), detail: "window.petAPI" };
      renderList();
      renderSheetFault(state.listFault);
      return;
    }

    state.ledger = loadLedger();
    state.types = load("wb.types.v1", []);
    if (!Array.isArray(state.types)) state.types = [];
    setReadSize(load("wb.readSize", "m"));
    renderTypeOptions();
    renderLedger();
    setConn("idle", t("set.wbConnUnknown"), "");

    // i18n 词典可能晚于首次绘制到达：到达后整窗重绘一次动态文案。
    if (window.I18N && typeof window.I18N.onChange === "function") {
      window.I18N.onChange(() => {
        renderTypeOptions();
        renderViewTitle();
        renderTelemetry();
        renderList();
        renderListMeta();
        renderPager();
        renderLedger();
        renderFeedback();
        if (state.detail) renderSheet(state.detail, { loading: false });
        else renderReaderEmptyFault();
        renderChainPanel();
        if (state.capacity || state.capacityFault) renderMaintenance();
        if (universeMounted && window.MemoryUniverse) window.MemoryUniverse.refresh();
        if (state.conn === "ok") setConn("ok", connOkLabel(), state.connDetail);
        else if (state.conn === "bad") setConn("bad", t("set.wbConnFault"), state.connDetail);
        else if (state.conn === "pending") setConn("pending", t("set.wbConnUnknownState"), state.connDetail);
        else setConn("idle", t("set.wbConnUnknown"), state.connDetail);
      });
    }

    bindEvents();
    // 空间在别处被创建/切换（演示种子、新建空间面板）时重拉列表，保持选择器与实际一致。
    if (api.onSpacesChanged) api.onSpacesChanged(() => { void loadSpaces(); });
    void (async () => {
      await loadSpaces();
      await initialLoad();
    })();
  }

  async function initialLoad() {
    // 搜索与健康度各自独立失败：容量目录读不到时，检索仍然必须可用。
    const searchTask = search({ reset: true });
    const healthTask = (async () => {
      let health = null;
      try { health = await api.memoryHealth(); } catch { health = null; }
      if (health && health.ok) {
        if (health.service) state.service = health.service;
        if (health.instanceId) state.instanceId = health.instanceId;
        if (Number.isSafeInteger(health.formalRevision)) state.revision = health.formalRevision;
        if (Number.isSafeInteger(health.revision)) state.revision = health.revision;
        renderTelemetry();
        // Alpha 接线修复：search 先到时芯片按"未知 service"先渲染一次；
        // health 带来真正的 service 名后，把已连接标签纠正成 Atlas/Host 各自的说法。
        if (state.conn === "ok") setConn("ok", connOkLabel());
      } else if (health) {
        // 报头只反映"能不能读"；具体故障已经在列表里成句，不在这里重复刷屏。
        applyConnFromResult(health);
      }
    })();
    await Promise.all([searchTask, healthTask]);
  }

  boot();
})();
