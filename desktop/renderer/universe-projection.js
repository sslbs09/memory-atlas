/**
 * universe-projection.js — 记忆宇宙的投影层（纯函数，无 DOM、无 WebGL）
 *
 * 它把一次正式 API 查询返回的记录变成 { nodes, links, stats, regions }。
 * 这里不做任何"记忆推断"，只做两类事：
 *
 *   1. 把 API 已经给出的关系**显式化**：控制记录 → 被控制记录（supersedes），
 *      同一会话来源的记录（same_source）。这两类边的每一条都能指出来源字段。
 *   2. 把**字面共现**标成推测：两条记录共享同一个词元时连一条 mentions，
 *      并在数据里写 confirmed:false + 词元。界面必须把它画得比确认关系更暗、
 *      并在图例里写明"推测关联"。
 *
 * 明确不做：因果、时间先后即因果、embedding 相似度。没有证据的关系宁可不画。
 *
 * UMD：浏览器挂 window.MemoryUniverseProjection，Node 里可以 require 做单测。
 */
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.MemoryUniverseProjection = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var DAY = 24 * 3600 * 1000;

  /**
   * 四个"脑区"是**功能分区隐喻**，不是解剖学主张：
   * 它们只回答"这条记录在这个视图里归到哪一簇"，判断依据是时间和类型。
   */
  var REGIONS = [
    { id: "prefrontal", labelKey: "set.wbUniRegionPfc", anchor: { x: 150, y: 62, z: -58 } },
    { id: "hippocampus", labelKey: "set.wbUniRegionHippo", anchor: { x: -158, y: -46, z: 64 } },
    { id: "cortex", labelKey: "set.wbUniRegionCortex", anchor: { x: 34, y: 118, z: -132 } },
    { id: "amygdala", labelKey: "set.wbUniRegionAmyg", anchor: { x: -46, y: -120, z: -26 } }
  ];
  var REGION_BY_ID = {};
  REGIONS.forEach(function (r) { REGION_BY_ID[r.id] = r; });

  var LINK_KINDS = {
    SUPERSEDES: "supersedes",
    SAME_SOURCE: "same_source",
    MENTIONS: "mentions"
  };

  // 只用来抑制"什么/就是/这个"这类无信息共现。列表故意短，靠 IDF 过滤兜底。
  var STOPWORDS = new Set([
    "用户", "就是", "这个", "那个", "一个", "什么", "可以", "因为", "所以", "但是", "没有",
    "已经", "还是", "如果", "现在", "今天", "时候", "自己", "不是", "一条", "说这", "这条",
    "我们", "他们", "这样", "那样", "觉得", "一点", "有点", "然后", "而且", "或者", "不过",
    "the", "and", "for", "that", "this", "with", "was", "are", "not", "but", "you", "his", "her"
  ]);

  function normalizeText(value) {
    return String(value == null ? "" : value).toLowerCase().replace(/\s+/g, " ").trim();
  }

  function hash(value) {
    var h = 2166136261;
    var text = String(value);
    for (var i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    // 归一到 [0,1)，用于稳定的初始位置抖动
    return ((h >>> 0) % 100000) / 100000;
  }

  /** 中文取二元组，拉丁取长度≥3 的词；数字与标点丢弃。 */
  function tokenize(text) {
    var normalized = normalizeText(text);
    var tokens = [];
    var cjkRuns = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
    for (var r = 0; r < cjkRuns.length; r += 1) {
      var run = cjkRuns[r];
      for (var i = 0; i + 2 <= run.length; i += 1) {
        var gram = run.slice(i, i + 2);
        if (!STOPWORDS.has(gram)) tokens.push(gram);
      }
    }
    var latin = normalized.match(/[a-z][a-z0-9-]{2,}/g) || [];
    for (var j = 0; j < latin.length; j += 1) {
      if (!STOPWORDS.has(latin[j])) tokens.push(latin[j]);
    }
    return tokens;
  }

  function ageDays(timestamp, now) {
    var ms = Date.parse(String(timestamp || ""));
    if (!isFinite(ms)) return null;
    return (now - ms) / DAY;
  }

  function regionOf(record, now) {
    if (record.recordType === "memory-control") return "prefrontal";
    // episode（WhiteMoon）与 experience（Atlas）都是"发生过的事"，归同一簇，
    // 否则换一个后端整张图的形状就变了，而数据含义并没有变。
    if (record.recordType === "episode" || record.recordType === "experience") return "amygdala";
    var age = ageDays(record.timestamp, now);
    if (age !== null && age <= 7) return "hippocampus";
    return "cortex";
  }

  function originKey(record) {
    if (!record.originAvailable || !record.origin) return null;
    var turnId = record.origin.turnId;
    if (typeof turnId === "string" && turnId) return "turn:" + turnId;
    var channel = record.origin.channel;
    if (typeof channel === "string" && channel) return "channel:" + channel;
    return null;
  }

  /** 稳定初始位置：同一批数据每次打开都落在同一处，截图与测试才可复现。 */
  function seedPosition(node) {
    var anchor = (REGION_BY_ID[node.region] || REGIONS[0]).anchor;
    var r1 = hash(node.id + ":x") - 0.5;
    var r2 = hash(node.id + ":y") - 0.5;
    var r3 = hash(node.id + ":z") - 0.5;
    return {
      x: anchor.x + r1 * 46,
      y: anchor.y + r2 * 40,
      z: anchor.z + r3 * 46
    };
  }

  function blankStats() {
    return {
      records: 0,
      controls: 0,
      links: 0,
      confirmedLinks: 0,
      inferredLinks: 0,
      byStatus: { active: 0, superseded: 0, retracted: 0, recorded: 0, unknown: 0 },
      byRegion: { prefrontal: 0, hippocampus: 0, cortex: 0, amygdala: 0 },
      byType: {},
      withOrigin: 0,
      span: { from: null, to: null }
    };
  }

  /**
   * @param {Array} records 正式 API 返回的记录（已归一化或原样，只要字段名一致）
   * @param {{now?: number, matchedIds?: Array<string>, maxMentionsPerNode?: number}} options
   */
  function buildUniverse(records, options) {
    var opts = options || {};
    var now = Number.isFinite(opts.now) ? opts.now : Date.now();
    var list = Array.isArray(records) ? records.filter(function (r) { return r && r.recordId; }) : [];
    var matched = new Set(Array.isArray(opts.matchedIds) ? opts.matchedIds : []);
    var maxMentions = Number.isSafeInteger(opts.maxMentionsPerNode) ? opts.maxMentionsPerNode : 3;

    var stats = blankStats();
    var nodes = [];
    var byId = new Map();

    for (var i = 0; i < list.length; i += 1) {
      var record = list[i];
      var region = regionOf(record, now);
      var summary = typeof record.summary === "string" ? record.summary : "";
      var isControl = record.recordType === "memory-control";
      var node = {
        id: record.recordId,
        recordId: record.recordId,
        kind: isControl ? "control" : "record",
        status: record.status || "unknown",
        recordType: record.recordType || "",
        summary: summary,
        timestamp: record.timestamp || "",
        ts: Date.parse(String(record.timestamp || "")) || null,
        sequence: Number.isSafeInteger(record.recordSequence) ? record.recordSequence : i + 1,
        region: region,
        action: isControl ? record.action || null : null,
        targetId: isControl ? record.targetExperienceId || null : null,
        originKey: originKey(record),
        declaredSource: record.declaredSource || null,
        matched: matched.size ? matched.has(record.recordId) : false,
        // 视觉权重：长度用对数压缩，避免一条长文把整张图压扁
        weight: Math.max(1, Math.min(6, Math.log10(1 + summary.length) * 1.7)),
        degree: 0,
        chainDepth: 0
      };
      var seed = seedPosition(node);
      node.x = seed.x;
      node.y = seed.y;
      node.z = seed.z;
      nodes.push(node);
      byId.set(node.id, node);

      stats.records += 1;
      if (isControl) stats.controls += 1;
      if (node.status in stats.byStatus) stats.byStatus[node.status] += 1;
      else stats.byStatus.unknown += 1;
      stats.byRegion[region] = (stats.byRegion[region] || 0) + 1;
      stats.byType[node.recordType] = (stats.byType[node.recordType] || 0) + 1;
      if (node.originKey) stats.withOrigin += 1;
      if (node.ts !== null) {
        if (stats.span.from === null || node.ts < stats.span.from) stats.span.from = node.ts;
        if (stats.span.to === null || node.ts > stats.span.to) stats.span.to = node.ts;
      }
    }

    var links = [];
    var linkKeys = new Set();
    function addLink(sourceId, targetId, kind, confirmed, note, weight) {
      if (!sourceId || !targetId || sourceId === targetId) return;
      if (!byId.has(sourceId) || !byId.has(targetId)) return;
      var key = kind + "|" + sourceId + "|" + targetId;
      if (linkKeys.has(key)) return;
      linkKeys.add(key);
      links.push({
        source: sourceId,
        target: targetId,
        kind: kind,
        confirmed: confirmed === true,
        note: note || "",
        weight: Number.isFinite(weight) ? weight : 1
      });
      byId.get(sourceId).degree += 1;
      byId.get(targetId).degree += 1;
    }

    // --- 1. supersedes：控制记录 → 被控制记录（API 字段直接给出）---
    for (var c = 0; c < nodes.length; c += 1) {
      var control = nodes[c];
      if (control.kind !== "control" || !control.targetId) continue;
      addLink(control.id, control.targetId, LINK_KINDS.SUPERSEDES, true,
        control.action === "retract" ? "撤回" : "更正", 2.4);
    }

    // --- 2. same_source：同一会话（origin.turnId / channel）---
    var byOrigin = new Map();
    for (var o = 0; o < nodes.length; o += 1) {
      var sourceNode = nodes[o];
      if (!sourceNode.originKey) continue;
      if (!byOrigin.has(sourceNode.originKey)) byOrigin.set(sourceNode.originKey, []);
      byOrigin.get(sourceNode.originKey).push(sourceNode);
    }
    byOrigin.forEach(function (group, key) {
      group.sort(function (a, b) { return a.sequence - b.sequence; });
      for (var i2 = 1; i2 < group.length; i2 += 1) {
        // 只连相邻两条：n 条同源记录连成链而不是 n² 条边
        addLink(group[i2 - 1].id, group[i2].id, LINK_KINDS.SAME_SOURCE, true,
          key.replace(/^turn:/, "同一次对话 ").replace(/^channel:/, "同渠道 "), 1.2);
      }
    });

    // --- 3. mentions：字面共现，明确标为推测 ---
    var index = new Map();
    for (var n = 0; n < nodes.length; n += 1) {
      if (!nodes[n].summary) continue;
      var terms = new Set(tokenize(nodes[n].summary));
      terms.forEach(function (term) {
        if (!index.has(term)) index.set(term, []);
        index.get(term).push(nodes[n]);
      });
    }
    var mentionBudget = Math.max(0, Math.min(600, Math.round(nodes.length * 2.2)));
    var perNode = new Map();
    var candidates = [];
    index.forEach(function (group, term) {
      if (group.length < 2 || group.length > Math.max(2, Math.round(nodes.length * 0.5))) return;
      group.sort(function (a, b) { return a.sequence - b.sequence; });
      for (var i3 = 1; i3 < group.length; i3 += 1) {
        candidates.push({ a: group[i3 - 1].id, b: group[i3].id, term: term });
      }
    });
    // 词元越长越具体，优先保留
    candidates.sort(function (a, b) { return b.term.length - a.term.length || a.term.localeCompare(b.term); });
    for (var k = 0; k < candidates.length && links.length < mentionBudget + nodes.length; k += 1) {
      var cand = candidates[k];
      var da = perNode.get(cand.a) || 0;
      var db = perNode.get(cand.b) || 0;
      if (da >= maxMentions || db >= maxMentions) continue;
      var before = links.length;
      addLink(cand.a, cand.b, LINK_KINDS.MENTIONS, false, "字面共现「" + cand.term + "」", 0.6);
      if (links.length > before) {
        perNode.set(cand.a, da + 1);
        perNode.set(cand.b, db + 1);
      }
      if (links.length >= mentionBudget) break;
    }

    // --- 链条深度：从控制记录往目标方向走，用于"当前版本"权重 ---
    for (var m = 0; m < nodes.length; m += 1) {
      var walker = nodes[m];
      var depth = 0;
      var seen = new Set([walker.id]);
      while (walker && walker.targetId && byId.has(walker.targetId) && depth < 8) {
        if (seen.has(walker.targetId)) break;
        seen.add(walker.targetId);
        walker = byId.get(walker.targetId);
        depth += 1;
      }
      nodes[m].chainDepth = depth;
    }

    stats.links = links.length;
    for (var l = 0; l < links.length; l += 1) {
      if (links[l].confirmed) stats.confirmedLinks += 1;
      else stats.inferredLinks += 1;
    }

    var regionRows = REGIONS.map(function (region) {
      return {
        id: region.id,
        labelKey: region.labelKey,
        anchor: region.anchor,
        count: stats.byRegion[region.id] || 0
      };
    });

    return {
      nodes: nodes,
      links: links,
      stats: stats,
      regions: regionRows,
      // 这张投影自身的口径，界面必须原样展示，避免被当成"图数据库"
      meta: {
        derived: true,
        authority: "FORMAL_CORE_EXPERIENCE",
        mentionPolicy: "字面共现（推测关联），非因果、非相似度模型",
        explicitRelation: "数据源未提供，本视图不绘制",
        generatedAt: new Date(now).toISOString()
      }
    };
  }

  /**
   * 选中一条记录时，它在图中的"解释路径"：它自己 + 它的纠正链 + 链上每条边。
   * 只沿 supersedes 走，因为那是唯一有显式证据的方向。
   */
  function chainPath(projection, recordId) {
    var nodes = projection.nodes || [];
    var links = projection.links || [];
    var byId = new Map();
    nodes.forEach(function (n) { byId.set(n.id, n); });
    if (!byId.has(recordId)) return { nodeIds: [], linkKeys: [] };

    var nodeIds = new Set([recordId]);
    var linkKeys = new Set();
    var guard = 0;

    // 向上：谁改过这条（控制记录 -> 目标）
    var cursor = recordId;
    while (guard < 12) {
      guard += 1;
      var incoming = links.filter(function (link) {
        return link.kind === LINK_KINDS.SUPERSEDES && link.target === cursor;
      });
      if (!incoming.length) break;
      var link = incoming[0];
      nodeIds.add(link.source);
      linkKeys.add(link.kind + "|" + link.source + "|" + link.target);
      cursor = link.source;
    }

    // 向下：这条改过谁（当选中项本身是控制记录时）
    guard = 0;
    cursor = recordId;
    while (guard < 12) {
      guard += 1;
      var outgoing = links.filter(function (l2) {
        return l2.kind === LINK_KINDS.SUPERSEDES && l2.source === cursor;
      });
      if (!outgoing.length) break;
      var next = outgoing[0];
      nodeIds.add(next.target);
      linkKeys.add(next.kind + "|" + next.source + "|" + next.target);
      cursor = next.target;
    }

    return { nodeIds: Array.from(nodeIds), linkKeys: Array.from(linkKeys) };
  }

  function linkKey(link) {
    return link.kind + "|" + (typeof link.source === "object" ? link.source.id : link.source) +
      "|" + (typeof link.target === "object" ? link.target.id : link.target);
  }

  return {
    REGIONS: REGIONS,
    LINK_KINDS: LINK_KINDS,
    buildUniverse: buildUniverse,
    chainPath: chainPath,
    linkKey: linkKey,
    tokenize: tokenize,
    regionOf: regionOf,
    seedPosition: seedPosition
  };
});
