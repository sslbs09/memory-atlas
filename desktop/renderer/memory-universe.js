/**
 * memory-universe.js — 记忆宇宙的 WebGL 视图（按需启动）
 *
 * 这个文件只在用户第一次进入「宇宙」时加载，也只在那时申请 WebGL 上下文。
 * 离开该模式、或窗口关闭时，渲染循环必须停下来：桌宠平时不应该为一张偶尔
 * 才看的图常驻 GPU 开销。
 *
 * 数据来源只有一个：petAPI.memorySearch（正式 API）。这里没有任何"模拟记忆
 * 活动"的动画——粒子只在**真实召回**发生的那一次点亮，1.8 秒后自行熄灭。
 *
 * 依赖：window.ForceGraph3D（vendor/universe/3d-force-graph.min.js，MIT）
 *       window.MemoryUniverseProjection（universe-projection.js，纯逻辑）
 */
(function () {
  "use strict";

  const VENDOR_SRC = "vendor/universe/3d-force-graph.min.js";
  const MAX_RECORDS = 200;
  const IDLE_PAUSE_MS = 2200;
  const RECALL_PULSE_MS = 1800;

  const state = {
    mounted: false,
    graph: null,
    projection: null,
    records: [],
    recall: null,
    api: null,
    t: null,
    onOpenArchive: null,
    selectedId: null,
    cutoff: 0,
    home: null,
    els: {},
    vendorPromise: null,
    resizeObserver: null,
    idleTimer: null,
    pulseTimer: null,
    historyTimer: null,
    rangeHandler: null,
    fault: null,
    webgl: false,
    highlightKeys: new Set(),
    pulseKeys: new Set(),
    starFrame: null,
    spaceId: null,
    // 'local-derived' = 后端没有图查询；'backend-available' = 后端有，但本视图仍用本地投影
    graphSource: "local-derived"
  };

  const STATUS_COLOR = {
    active: "#d9f4ff",
    superseded: "#e6b87a",
    retracted: "#e08a83",
    recorded: "#9fb0b6",
    unknown: "#9fb0b6"
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function escapeHtml(value) {
    // 3d-force-graph 的 tooltip 走 innerHTML，历史文本必须先转义。
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function t(key, params) {
    return state.t ? state.t(key, params) : key;
  }

  function hasWebgl2() {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl2");
      if (!gl) return false;
      const lose = gl.getExtension("WEBGL_lose_context");
      if (lose) lose.loseContext();
      return true;
    } catch {
      return false;
    }
  }

  function loadVendor() {
    if (window.ForceGraph3D) return Promise.resolve(true);
    if (state.vendorPromise) return state.vendorPromise;
    state.vendorPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = VENDOR_SRC;
      script.async = true;
      script.onload = () => resolve(Boolean(window.ForceGraph3D));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
    return state.vendorPromise;
  }

  // ---------------------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------------------

  function formatDate(ms) {
    if (!Number.isFinite(ms)) return "—";
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function renderPanel() {
    const p = state.projection;
    if (!p) return;
    const els = state.els;

    // 数据来源：口径必须写在界面上，读者才知道这张图是什么
    if (els.scope) {
      const span = p.stats.span;
      const range = {
        count: p.stats.records,
        from: span.from ? formatDate(span.from) : "—",
        to: span.to ? formatDate(span.to) : "—"
      };
      els.scope.textContent = state.spaceId
        ? t("set.wbUniScopeSpace", { ...range, space: state.spaceId })
        : t("set.wbUniScope", range);
    }

    // 统计
    if (els.stats) {
      clear(els.stats);
      const rows = [
        [t("set.wbUniStatRecords"), String(p.stats.records), null],
        [t("set.wbUniStatControls"), String(p.stats.controls), null],
        [t("set.wbUniStatLinks"), String(p.stats.links),
          t("set.wbUniStatLinkSplit", { confirmed: p.stats.confirmedLinks, inferred: p.stats.inferredLinks })],
        [t("set.wbUniStatOrigin"), String(p.stats.withOrigin), null],
        [t("set.wbUniStatSpan"), (p.stats.span.from ? formatDate(p.stats.span.from) : "—"),
          p.stats.span.from ? formatDate(p.stats.span.to) : null]
      ];
      for (const [label, value, note] of rows) {
        const row = el("div");
        row.append(el("dt", "", label));
        const dd = el("dd", "", value);
        if (note) dd.append(el("small", "", note));
        row.append(dd);
        els.stats.append(row);
      }
    }

    // 分区（隐喻）
    if (els.regions) {
      clear(els.regions);
      for (const region of p.regions) {
        const li = el("li");
        li.dataset.region = region.id;
        li.append(el("i"), el("span", "", t(region.labelKey)), el("b", "", String(region.count)));
        els.regions.append(li);
      }
    }

    // 本次召回
    if (els.recall) {
      const matched = p.nodes.filter((n) => n.matched).length;
      const label = state.recall && state.recall.label ? state.recall.label : t("set.wbUniRecallNone");
      clear(els.recall);
      els.recall.append(document.createTextNode(label + " · "));
      els.recall.append(el("b", "", String(matched)));
      els.recall.append(document.createTextNode(" " + t("set.wbUniMatchedUnit")));
    }

    renderSelection();
    renderGraphSource();
  }

  /** 图从哪来，必须写在面板上：本地派生 / 后端可用但未接入。 */
  function renderGraphSource() {
    const node = state.els.graphSource;
    if (!node) return;
    node.textContent = state.graphSource === "backend-available"
      ? t("set.wbUniGraphPending")
      : t("set.wbUniGraphLocal");
  }

  function currentUnderstandingOf(node) {
    if (!node) return { kind: "unknown", text: "" };
    if (node.kind !== "control" && node.status === "active") return { kind: "self", text: node.summary };
    if (node.kind === "control" && node.action === "retract") return { kind: "control-retract", text: "" };
    if (node.kind === "control") return { kind: "control-correct", text: node.summary };

    const path = window.MemoryUniverseProjection.chainPath(state.projection, node.id);
    const controls = path.nodeIds
      .map((id) => state.projection.nodes.find((n) => n.id === id))
      .filter((candidate) => candidate && candidate.kind === "control")
      .sort((a, b) => b.sequence - a.sequence);
    if (controls.length) {
      const newest = controls[0];
      if (newest.action === "retract") return { kind: "retracted", text: "" };
      return { kind: "corrected", text: newest.summary, from: newest.id };
    }
    if (node.status === "retracted") return { kind: "retracted", text: "" };
    return { kind: "unknown", text: "" };
  }

  function renderSelection() {
    const host = state.els.selection;
    if (!host) return;
    clear(host);
    const id = state.selectedId;
    if (!id) {
      host.append(el("p", "wb-uni-empty", t("set.wbUniNoSelection")));
      return;
    }
    const node = state.projection.nodes.find((n) => n.id === id);
    if (!node) {
      host.append(el("p", "wb-uni-empty", t("set.wbUniNoSelection")));
      return;
    }

    const wrap = el("div", "wb-uni-pick");
    const idLine = el("div", "wb-uni-pick-id");
    const st = el("span", "st", t({
      active: "set.memWbStatusActive",
      superseded: "set.memWbStatusSuperseded",
      retracted: "set.memWbStatusRetracted",
      recorded: "set.memWbStatusRecorded"
    }[node.status] || "set.wbStatusUnknown"));
    st.dataset.status = node.status;
    idLine.append(st, el("span", "", node.recordType || "—"), el("span", "", node.id));
    wrap.append(idLine);

    const current = currentUnderstandingOf(node);
    if (current.kind === "retracted") {
      wrap.append(el("p", "wb-uni-pick-text", t("set.wbRetractedNow")));
    } else if (current.text) {
      wrap.append(el("p", "wb-uni-pick-text", current.text));
    } else {
      wrap.append(el("p", "wb-uni-empty", t("set.wbCurrentUnknown")));
    }

    const facts = el("dl", "wb-uni-pick-facts");
    const chain = window.MemoryUniverseProjection.chainPath(state.projection, node.id);
    const rows = [
      [t("set.wbUniPickTime"), formatDate(node.ts)],
      [t("set.wbUniPickSource"), node.declaredSource || (node.originKey ? node.originKey.replace("turn:", "turn ") : t("set.wbUniPickNoSource"))],
      [t("set.wbUniPickChain"), t("set.wbUniChainCount", { n: Math.max(0, chain.nodeIds.length - 1) })],
      [t("set.wbUniPickDegree"), String(node.degree)]
    ];
    for (const [label, value] of rows) {
      const row = el("div");
      row.append(el("dt", "", label), el("dd", "", value));
      facts.append(row);
    }
    wrap.append(facts);

    const open = el("button", "wb-btn wb-uni-pick-open", t("set.wbUniOpenArchive"));
    open.type = "button";
    open.dataset.testid = "universe-open-archive";
    open.addEventListener("click", () => {
      if (typeof state.onOpenArchive === "function") state.onOpenArchive(node.id);
    });
    wrap.append(open);

    host.append(wrap);
  }

  // ---------------------------------------------------------------------------
  // 图
  // ---------------------------------------------------------------------------

  function nodeColor(node) {
    if (state.cutoff && node.ts !== null && node.ts < state.cutoff) return "#2a363b";
    if (node.kind === "control") {
      return node.action === "retract" ? STATUS_COLOR.retracted : "#e4d5ab";
    }
    return STATUS_COLOR[node.status] || STATUS_COLOR.unknown;
  }

  /** 只给星图层用：0 = 时间范围外（几乎隐去），1 = 正常。 */
  function nodeOpacity(node) {
    if (state.cutoff && node.ts !== null && node.ts < state.cutoff) return 0.16;
    // 召回命中的更亮，但色相不变：颜色只说明状态，命中是"亮度 + 光环"的事
    return node.matched ? 1 : 0.55;
  }

  function nodeVal(node) {
    // 半径按 cbrt(val) 走，所以这里的系数直接决定整张图的"星等"
    const base = node.weight * 1.2;
    return node.matched ? base * 1.6 : base;
  }

  function inRange(node) {
    return !state.cutoff || node.ts === null || node.ts >= state.cutoff;
  }

  function linkColor(link) {
    const kind = link.kind;
    const dim = !inRange(link.source) || !inRange(link.target);
    if (dim) return "rgba(40,52,58,0.35)";
    const hot = state.highlightKeys && state.highlightKeys.has(window.MemoryUniverseProjection.linkKey(link));
    if (kind === "supersedes") return hot ? "rgba(238,224,180,1)" : "rgba(214,192,140,0.62)";
    if (kind === "same_source") return hot ? "rgba(200,232,242,0.9)" : "rgba(168,204,214,0.4)";
    return hot ? "rgba(127,214,207,0.75)" : "rgba(118,150,160,0.22)";
  }

  function linkWidth(link) {
    if (!inRange(link.source) || !inRange(link.target)) return 0.2;
    const hot = state.highlightKeys && state.highlightKeys.has(window.MemoryUniverseProjection.linkKey(link));
    if (hot) return 1.1;
    return link.kind === "supersedes" ? 0.7 : link.kind === "same_source" ? 0.45 : 0.22;
  }

  function linkParticles(link) {
    if (!state.pulseKeys || !state.pulseKeys.size) return 0;
    return state.pulseKeys.has(window.MemoryUniverseProjection.linkKey(link)) ? 2 : 0;
  }

  function applyStyles() {
    const graph = state.graph;
    if (!graph) return;
    graph
      .nodeColor(nodeColor)
      .nodeOpacity(0)
      .nodeVal(nodeVal)
      .linkColor(linkColor)
      .linkWidth(linkWidth)
      .linkDirectionalParticles(linkParticles)
      .linkDirectionalParticleWidth(1.4)
      .linkDirectionalParticleSpeed(0.006)
      .linkDirectionalParticleColor(() => "#9ff0e6");
    applyNodeMaterial();
    scheduleStars();
  }

  /**
   * 两条实测结论，决定了这段代码为什么存在：
   *   1. 节点大小是烘进几何半径的（SphereGeometry 半径 = cbrt(val) * nodeRelSize），
   *      网格 scale 必须保持 1，改 scale 会把整颗星放大到把相机包进球里。
   *   2. 材质是 MeshLambertMaterial，而深色场景没有可用光照（emissive 全黑），
   *      于是球体在近黑背景上等同于不可见——只剩几个像素的高光。
   * 这里把材质改成自发光，颜色即状态色，不依赖任何灯光。
   */
  function applyNodeMaterial() {
    const graph = state.graph;
    if (!graph) return;
    const nodes = graph.graphData().nodes;
    for (const node of nodes) {
      const obj = node.__threeObj;
      if (!obj) continue;
      if (obj.scale && obj.scale.x !== 1) obj.scale.setScalar(1);
      const material = obj.material;
      if (!material) continue;
      if (material.emissive && material.color) {
        material.emissive.setHex(material.color.getHex());
        material.emissiveIntensity = 1;
      }
      material.needsUpdate = true;
    }
  }


  /**
   * 星图叠加层。
   *
   * 为什么不用引擎自带的球体：这个版本把节点做成 MeshLambertMaterial，而深色场景
   * 里没有可用光照，emissive 又是黑的——球体在近黑背景上等于不可见，实测整张画布
   * 只有十几个亮像素。链接是线材质（不受光照影响）所以还能看到。
   *
   * 这里的做法：位置、缩放、射线拾取仍由 3D 引擎负责，我只用同一套
   * graph2ScreenCoords 把节点投影到 2D 画布上，画成带光晕的星点。
   * 好处是可控（大小/亮度/发光半径都能按状态表达），而且渲染成本恒定。
   */
  function starRadius(node) {
    const base = Math.max(1.6, Math.min(6.5, 1.2 + Math.cbrt(node.weight || 1) * 1.5));
    if (!inRange(node)) return base * 0.6;
    return node.matched ? base * 1.45 : base;
  }

  function starColor(node) {
    const hex = nodeColor(node);
    if (hex.charAt(0) === "#") {
      return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
      };
    }
    return { r: 190, g: 220, b: 230 };
  }

  function drawStars() {
    const canvas = state.els.stars;
    const graph = state.graph;
    if (!canvas || !graph) return;
    const host = state.els.canvas;
    if (!host) return;
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const nodes = graph.graphData().nodes;
    const highlight = state.highlightKeys || new Set();

    // 先画光晕，再画核心：两层叠加才有"星"的感觉，单层圆点像散点图
    for (const node of nodes) {
      const pos = graph.graph2ScreenCoords(node.x || 0, node.y || 0, node.z || 0);
      if (pos.x < -40 || pos.y < -40 || pos.x > width + 40 || pos.y > height + 40) continue;
      const radius = starRadius(node);
      const color = starColor(node);
      const alpha = nodeOpacity(node);
      const glow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, radius * 3.2);
      glow.addColorStop(0, "rgba(" + color.r + "," + color.g + "," + color.b + "," + (0.5 * alpha) + ")");
      glow.addColorStop(0.45, "rgba(" + color.r + "," + color.g + "," + color.b + "," + (0.16 * alpha) + ")");
      glow.addColorStop(1, "rgba(" + color.r + "," + color.g + "," + color.b + ",0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius * 3.2, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "rgba(" + color.r + "," + color.g + "," + color.b + "," + Math.min(1, alpha + 0.15) + ")";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fill();

      // 核心提亮：让"当前有效"的星看起来是发光的点，而不是一块色斑
      ctx.fillStyle = "rgba(255,255,255," + (0.35 * alpha) + ")";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, Math.max(0.8, radius * 0.34), 0, Math.PI * 2);
      ctx.fill();

      // 三层标记，含义各不同：召回命中（细环）、解释链上（亮环）、当前选中（更外一层）
      const onChain = highlight.size > 0 && state.pulseKeys && state.pulseKeys.size > 0;
      if (node.matched || onChain) {
        ctx.strokeStyle = onChain ? "rgba(159,240,230,0.75)" : "rgba(200,235,240,0.28)";
        ctx.lineWidth = onChain ? 1 : 0.7;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius * 2.6, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (node.id === state.selectedId) {
        ctx.strokeStyle = "rgba(255,255,255,0.75)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius * 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius * 5.4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  function scheduleStars() {
    if (state.starFrame) return;
    state.starFrame = requestAnimationFrame(() => {
      state.starFrame = null;
      drawStars();
    });
  }

  function nodeLabel(node) {
    const status = t({
      active: "set.memWbStatusActive",
      superseded: "set.memWbStatusSuperseded",
      retracted: "set.memWbStatusRetracted",
      recorded: "set.memWbStatusRecorded"
    }[node.status] || "set.wbStatusUnknown");
    const text = String(node.summary || "").replace(/\s+/g, " ").slice(0, 90);
    return "<span style=\"font:11px/1.5 'Segoe UI','Microsoft YaHei',sans-serif\">"
      + "<b>" + escapeHtml(status) + "</b> · " + escapeHtml(node.recordType)
      + "<br>" + escapeHtml(node.id)
      + "<br>" + escapeHtml(text) + "</span>";
  }

  /** 实时包围盒：力布局会持续改写节点坐标，取景必须看渲染中的那一份。 */
  function liveBounds() {
    const nodes = state.graph ? state.graph.graphData().nodes : [];
    if (!nodes.length) return null;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const node of nodes) {
      const x = Number.isFinite(node.x) ? node.x : 0;
      const y = Number.isFinite(node.y) ? node.y : 0;
      const z = Number.isFinite(node.z) ? node.z : 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    return {
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
      radius: Math.max(40, Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2)
    };
  }

  /** 把整片星云放进视野：不对称机位（左/上/后），不做正中俯视。 */
  function frameCamera(duration) {
    if (!state.graph) return false;
    const bounds = liveBounds();
    if (!bounds) return false;
    const dist = bounds.radius * 1.95;
    state.home = {
      position: {
        x: bounds.center.x - dist * 0.58,
        y: bounds.center.y + dist * 0.32,
        z: bounds.center.z + dist * 0.78
      },
      target: bounds.center
    };
    state.graph.cameraPosition(state.home.position, state.home.target, duration || 0);
    return true;
  }

  function computeHome() {
    const nodes = state.projection.nodes;
    if (!nodes.length) {
      return { position: { x: 0, y: 0, z: 260 }, target: { x: 0, y: 0, z: 0 } };
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const node of nodes) {
      const x = Number.isFinite(node.x) ? node.x : 0;
      const y = Number.isFinite(node.y) ? node.y : 0;
      const z = Number.isFinite(node.z) ? node.z : 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
    const radius = Math.max(60, Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2);
    const dist = radius * 3.4;
    // 不对称视角：从左上偏低处看过去，而不是正中俯视
    return {
      position: { x: center.x - dist * 0.62, y: center.y + dist * 0.34, z: center.z + dist * 0.86 },
      target: center
    };
  }

  function wake(ms) {
    const graph = state.graph;
    if (!graph) return;
    graph.resumeAnimation();
    schedulePause(ms);
  }

  function schedulePause(ms) {
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      if (state.graph) state.graph.pauseAnimation();
      scheduleStars();
    }, ms === undefined ? IDLE_PAUSE_MS : ms);
  }

  function buildGraph() {
    const host = state.els.canvas;
    if (!host) return;
    if (state.graph) {
      try { state.graph.pauseAnimation(); state.graph._destructor(); } catch { /* 已销毁 */ }
      state.graph = null;
      clear(host);
    }

    const graph = window.ForceGraph3D({
      controlType: "trackball",
      rendererConfig: { alpha: true, antialias: true, preserveDrawingBuffer: true }
    })(host);

    graph
      .backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .width(host.clientWidth || 800)
      .height(host.clientHeight || 600)
      .nodeRelSize(3.6)
      .nodeResolution(12)
      .linkOpacity(1)
      .linkCurvature(0.06)
      .enableNodeDrag(true)
      .nodeLabel(nodeLabel)
      .onNodeClick((node) => { selectNode(node.id, { focus: true }); })
      .onNodeHover((node) => { if (host) host.style.cursor = node ? "pointer" : "default"; })
      .onBackgroundClick(() => {
        state.selectedId = null;
        state.highlightKeys = new Set();
        state.pulseKeys = new Set();
        applyStyles();
        renderSelection();
        wake();
      })
      .onEngineStop(() => {
        if (!state.framed) {
          state.framed = true;
          frameCamera(0);
        }
        applyNodeMaterial();
        schedulePause(900);
      });

    graph.graphData({
      nodes: state.projection.nodes.map((node) => Object.assign({}, node, {
        val: Math.max(1, node.weight) * (node.matched ? 1.5 : 1)
      })),
      links: state.projection.links.map((link) => Object.assign({}, link))
    });
    applyStyles();

    // 链短、斥力温和：让"纠正链"这一族自然靠拢，而不是炸成一团
    const charge = graph.d3Force("charge");
    if (charge && charge.strength) charge.strength(-52);
    const linkForce = graph.d3Force("link");
    if (linkForce && linkForce.distance) {
      linkForce.distance((link) => (link.kind === "supersedes" ? 22 : link.kind === "same_source" ? 30 : 44));
    }

    state.graph = graph;
    state.home = computeHome();
    graph.cameraPosition(state.home.position, state.home.target, 0);
    // 布局会在一秒内把云团拉开，停下来之后重新框一次，否则一开始框的是种子位置
    state.frameTimer = setTimeout(() => { frameCamera(0); }, 900);

    const canvas = host.querySelector("canvas");
    if (canvas) {
      canvas.addEventListener("pointerdown", () => wake(), { passive: true });
      canvas.addEventListener("wheel", () => wake(), { passive: true });
    }

    graph.onEngineTick(() => scheduleStars());
    const controls = graph.controls && graph.controls();
    if (controls && controls.addEventListener) {
      controls.addEventListener("change", () => scheduleStars());
    }

    if (state.resizeObserver) state.resizeObserver.disconnect();
    state.resizeObserver = new ResizeObserver(() => {
      if (!state.graph || !host) return;
      state.graph.width(host.clientWidth || 800).height(host.clientHeight || 600);
      scheduleStars();
    });
    state.resizeObserver.observe(host);

    schedulePause(4000);
  }

  function selectNode(id, { focus }) {
    if (!state.projection) return;
    const node = state.projection.nodes.find((n) => n.id === id);
    if (!node) return;
    state.selectedId = id;

    const path = window.MemoryUniverseProjection.chainPath(state.projection, id);
    state.highlightKeys = new Set(path.linkKeys);
    applyStyles();
    renderSelection();

    if (focus && state.graph) {
      const graph = state.graph;
      const distance = 96;
      const hypot = Math.max(1, Math.hypot(node.x || 0, node.y || 0, node.z || 0));
      const ratio = 1 + distance / hypot;
      graph.cameraPosition({
        x: (node.x || 0) * ratio,
        y: (node.y || 0) * ratio,
        z: (node.z || 0) * ratio
      }, { x: node.x || 0, y: node.y || 0, z: node.z || 0 }, 900);
      // 沿纠正链跑一次粒子：这是"这一刻的解释路径"，1.8 秒后熄灭，不是常驻特效
      state.pulseKeys = new Set(path.linkKeys);
      applyStyles();
      if (state.pulseTimer) clearTimeout(state.pulseTimer);
      state.pulseTimer = setTimeout(() => {
        state.pulseKeys = new Set();
        applyStyles();
        schedulePause(600);
      }, RECALL_PULSE_MS);
      wake(2400);
    }
  }

  // ---------------------------------------------------------------------------
  // 时间线
  // ---------------------------------------------------------------------------

  function drawHistogram() {
    const canvas = state.els.hist;
    const projection = state.projection;
    if (!canvas || !projection) return;
    const span = projection.stats.span;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 480;
    const cssHeight = 34;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (!span.from || !span.to || span.to <= span.from) {
      ctx.fillStyle = "#263238";
      ctx.fillRect(0, cssHeight - 1, cssWidth, 1);
      return;
    }

    const buckets = Math.max(12, Math.min(48, Math.floor(cssWidth / 12)));
    const counts = new Array(buckets).fill(0);
    const width = span.to - span.from;
    for (const node of projection.nodes) {
      if (node.ts === null) continue;
      const ratio = width === 0 ? 0 : (node.ts - span.from) / width;
      const index = Math.min(buckets - 1, Math.max(0, Math.floor(ratio * buckets)));
      counts[index] += 1;
    }
    const max = Math.max(1, ...counts);
    const gap = 1;
    const barWidth = Math.max(1, cssWidth / buckets - gap);
    for (let i = 0; i < buckets; i += 1) {
      const bucketStart = span.from + (width * i) / buckets;
      const dim = state.cutoff && bucketStart + width / buckets < state.cutoff;
      const height = Math.max(1, Math.round((counts[i] / max) * (cssHeight - 6)));
      ctx.fillStyle = dim ? "#1d272c" : "#4c6b73";
      ctx.fillRect(i * (barWidth + gap), cssHeight - height, barWidth, height);
    }
    if (state.cutoff) {
      const x = ((state.cutoff - span.from) / width) * cssWidth;
      ctx.fillStyle = "#7fd6cf";
      ctx.fillRect(Math.max(0, Math.min(cssWidth - 1, x)), 0, 1, cssHeight);
    }
  }

  function applyTimeline(value) {
    const projection = state.projection;
    if (!projection) return;
    const span = projection.stats.span;
    if (!span.from || !span.to) {
      state.cutoff = 0;
      if (state.els.cutoff) state.els.cutoff.textContent = t("set.wbUniTimelineAll");
      return;
    }
    const ratio = Math.max(0, Math.min(1, value / 100));
    state.cutoff = ratio === 0 ? 0 : span.from + (span.to - span.from) * ratio;
    if (state.els.cutoff) {
      state.els.cutoff.textContent = state.cutoff === 0
        ? t("set.wbUniTimelineAll")
        : t("set.wbUniTimelineFrom", { date: formatDate(state.cutoff) });
    }
    applyStyles();
    drawHistogram();
    scheduleStars();
    wake(1600);
  }

  // ---------------------------------------------------------------------------
  // 数据
  // ---------------------------------------------------------------------------

  function showBlocked(reason) {
    if (state.els.blocked) state.els.blocked.hidden = false;
    if (state.els.blockedReason) state.els.blockedReason.textContent = reason || "";
    if (state.els.loading) state.els.loading.hidden = true;
  }

  function showFault(message) {
    if (state.els.blocked) {
      state.els.blocked.hidden = false;
      const title = state.els.blocked.querySelector("h3");
      if (title) title.textContent = t("set.wbUniFaultTitle");
      const body = state.els.blocked.querySelector("p");
      if (body) body.textContent = message;
      if (state.els.blockedReason) state.els.blockedReason.textContent = "";
    }
    if (state.els.loading) state.els.loading.hidden = true;
  }

  async function loadData() {
    state.fault = null;
    if (state.els.loading) state.els.loading.hidden = false;
    if (state.els.blocked) state.els.blocked.hidden = true;

    let result = null;
    try {
      result = await state.api.memorySearch({ status: "all", limit: MAX_RECORDS, offset: 0, order: "newest" });
    } catch {
      result = null;
    }

    if (!result || !result.ok) {
      state.fault = (result && (result.error || result.status)) || "MEMORY_READ_FAILED";
      showFault(t("set.wbUniFault", { reason: state.fault }));
      return false;
    }

    state.spaceId = result.servedInstanceId || null;
    state.records = Array.isArray(result.records) ? result.records : [];

    // 图查询能力：有就标"可用（待接入）"，没有就标"本地派生"。两种都不冒充后端图。
    if (typeof state.api.probeGraph === "function") {
      let probe = null;
      try { probe = await state.api.probeGraph(); } catch { probe = null; }
      state.graphSource = probe && probe.supported === true ? "backend-available" : "local-derived";
    }
    const matchedIds = state.recall && Array.isArray(state.recall.ids) ? state.recall.ids : [];
    state.projection = window.MemoryUniverseProjection.buildUniverse(state.records, {
      matchedIds: matchedIds,
      now: Date.now()
    });

    if (!state.projection.nodes.length) {
      showFault(t("set.wbUniEmpty"));
      return false;
    }

    if (state.els.loading) state.els.loading.hidden = true;
    if (state.els.blocked) state.els.blocked.hidden = true;
    renderPanel();
    buildGraph();
    drawHistogram();
    applyTimeline(Number(state.els.range ? state.els.range.value : 0));
    // 召回点一次亮，随后熄灭：它表示"这一次查询命中了这些"，不是持续活动
    if (matchedIds.length) pulseRecall();
    return true;
  }

  function pulseRecall() {
    const projection = state.projection;
    if (!projection) return;
    const matched = new Set(projection.nodes.filter((n) => n.matched).map((n) => n.id));
    const keys = new Set();
    for (const link of projection.links) {
      if (link.kind === "supersedes" && (matched.has(link.source) || matched.has(link.target))) {
        keys.add(window.MemoryUniverseProjection.linkKey(link));
      }
    }
    if (!keys.size) return;
    state.pulseKeys = keys;
    applyStyles();
    if (state.pulseTimer) clearTimeout(state.pulseTimer);
    state.pulseTimer = setTimeout(() => {
      state.pulseKeys = new Set();
      applyStyles();
    }, RECALL_PULSE_MS);
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  async function mount(opts) {
    const options = opts || {};
    state.api = options.api;
    state.t = options.t;
    state.onOpenArchive = options.onOpenArchive;
    state.recall = options.recall || null;
    state.els = options.els || {};
    state.mounted = true;
    state.selectedId = null;
    state.highlightKeys = new Set();
    state.pulseKeys = new Set();

    if (state.els.range && !state.rangeHandler) {
      state.rangeHandler = () => applyTimeline(Number(state.els.range.value));
      state.els.range.addEventListener("input", state.rangeHandler);
    }

    if (!state.api) {
      showBlocked(t("set.wbNoBridge"));
      return false;
    }
    if (!hasWebgl2()) {
      state.webgl = false;
      showBlocked(t("set.wbUniNoWebgl"));
      return false;
    }
    state.webgl = true;

    if (state.els.loading) state.els.loading.hidden = false;
    const loaded = await loadVendor();
    if (!loaded) {
      state.webgl = false;
      showBlocked(t("set.wbUniNoEngine"));
      return false;
    }
    return loadData();
  }

  function unmount() {
    state.mounted = false;
    if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
    if (state.pulseTimer) { clearTimeout(state.pulseTimer); state.pulseTimer = null; }
    if (state.historyTimer) { clearTimeout(state.historyTimer); state.historyTimer = null; }
    if (state.resizeObserver) { state.resizeObserver.disconnect(); state.resizeObserver = null; }
    if (state.graph) {
      try {
        state.graph.pauseAnimation();
        state.graph._destructor();
      } catch { /* 已销毁 */ }
      state.graph = null;
    }
    if (state.els.range && state.rangeHandler) {
      state.els.range.removeEventListener("input", state.rangeHandler);
      state.rangeHandler = null;
    }
    if (state.els.canvas) clear(state.els.canvas);
    state.projection = null;
    state.records = [];
    state.selectedId = null;
    state.home = null;
  }

  function isPaused() {
    // 通过内部标志判断：3d-force-graph 的 pauseAnimation 会停掉 requestAnimationFrame
    return !state.graph || state.idleTimer !== null;
  }

  function pause() {
    if (state.graph) {
      if (state.idleTimer) { clearTimeout(state.idleTimer); state.idleTimer = null; }
      state.graph.pauseAnimation();
    }
  }

  function refresh() {
    if (!state.mounted || !state.projection) return;
    renderPanel();
    drawHistogram();
    if (state.els.cutoff) {
      const span = state.projection.stats.span;
      state.els.cutoff.textContent = !state.cutoff
        ? t("set.wbUniTimelineAll")
        : t("set.wbUniTimelineFrom", { date: formatDate(state.cutoff) });
      void span;
    }
    applyStyles();
  }

  window.MemoryUniverse = {
    mount,
    unmount,
    pause,
    resume: () => wake(),
    recenter: () => { state.framed = true; return frameCamera(800); },
    refresh,
    isMounted: () => state.mounted,
    selectNode: (id) => selectNode(id, { focus: false }),
    selectAndFocus: (id) => selectNode(id, { focus: true }),
    reload: () => (state.mounted ? loadData() : Promise.resolve(false)),
    // 只给测试用：把一个节点投影到画布像素坐标，测试才能发出"真的点击"
    __nodeScreen: (id) => {
      if (!state.graph) return null;
      // 必须用图内部的实时坐标：力布局会持续改写渲染用的节点副本，
      // projection 里保留的是初始种子位置，拿它算出来的点会打偏。
      const live = state.graph.graphData().nodes.find((n) => n.id === id);
      if (!live) return null;
      const pos = state.graph.graph2ScreenCoords(live.x || 0, live.y || 0, live.z || 0);
      return { x: Math.round(pos.x), y: Math.round(pos.y), x3: live.x, y3: live.y, z3: live.z };
    },
    // 只给测试用：挑一个最靠近画面中心的节点（边缘节点容易被面板或画面裁掉）
    __centerNode: () => {
      if (!state.graph) return null;
      const host = state.els.canvas;
      if (!host) return null;
      const cx = host.clientWidth / 2;
      const cy = host.clientHeight / 2;
      let best = null;
      for (const node of state.graph.graphData().nodes) {
        const p = state.graph.graph2ScreenCoords(node.x || 0, node.y || 0, node.z || 0);
        if (p.x < 60 || p.y < 60 || p.x > host.clientWidth - 60 || p.y > host.clientHeight - 60) continue;
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (!best || d < best.d) best = { id: node.id, d, x: Math.round(p.x), y: Math.round(p.y) };
      }
      return best;
    },
    // 只给测试用：暴露可断言的事实，不暴露内部对象
    __debug: () => ({
      mounted: state.mounted,
      webgl: state.webgl,
      nodes: state.projection ? state.projection.nodes.length : 0,
      links: state.projection ? state.projection.links.length : 0,
      confirmedLinks: state.projection ? state.projection.stats.confirmedLinks : 0,
      inferredLinks: state.projection ? state.projection.stats.inferredLinks : 0,
      selectedId: state.selectedId,
      cutoff: state.cutoff,
      hasGraph: Boolean(state.graph),
      paused: Boolean(state.idleTimer) || !state.graph
    })
  };
})();
