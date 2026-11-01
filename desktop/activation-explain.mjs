/**
 * activation-explain.mjs — Alpha 的 Activation Shadow 解释器。
 *
 * 复用 experiments/activation-01..04 的策略实现（import，不复制公式）：
 *   A0  = activation-04 attribution-strategies 的 rankA0V4（= activation-03 rankA0）
 *   L   = 词面证据 tier 重排（computeTierFromReal）
 *   R   = 动态激活乘数（g2Multiplier，只来自合法 user_revisited）
 *   LR  = G1G2（base × G2 + tier 闸门）
 *   D   = RecentDelivery 抑制（只用于 ambient；显式追问恒绕过）
 *
 * 红线（与 activation-03/04 相同，这里是调用侧的责任）：
 *   - 正式返回/正式上下文顺序永远是 A0（Atlas 检索返回序）；影子结果只用于展示；
 *   - 查询本身不写任何强化事件；影子运行零激活副作用；
 *   - R 在无原生分数（权威扫描回退）时按实现拒绝（R_NO_BASE_SCORE）。
 *
 * 与 dogfood CLI 的差异（唯一一处口径差异，必须明示）：
 *   dogfood 用 authority.inspect() 建词面 df 表；Alpha 通过 Atlas HTTP 取
 *   status=active、limit=200 的记录来建同一张表。空间 ≤200 条有效记录时与
 *   inspect 完全一致；超出时 scopeWindowed=true 并向上层明示。
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function importExperimentModule(repoRoot, ...segments) {
  const file = path.join(repoRoot, "experiments", ...segments);
  if (!fs.existsSync(file)) throw new Error(`activation 实验模块缺失：${file}`);
  return import(pathToFileURL(file).href);
}

export async function createActivationExplain({ repoRoot, ledger, rawSearch }) {
  const [strategiesV4, evidenceMod, eventsMod, tokenizerMod] = await Promise.all([
    importExperimentModule(repoRoot, "activation-04", "src", "attribution-strategies.mjs"),
    importExperimentModule(repoRoot, "activation-03", "src", "evidence.mjs"),
    importExperimentModule(repoRoot, "activation-01", "src", "events.mjs"),
    importExperimentModule(repoRoot, "activation-01", "src", "tokenizer.mjs")
  ]);
  const { rankA0V4, rankL, rankR, rankLR, rankD } = strategiesV4;
  const { classifyEvidencePath } = evidenceMod;
  const { replayEvents } = eventsMod;
  const { termsForQuery, tokenizeForIndex } = tokenizerMod;

  const DAY_MS = 86_400_000;

  function ageText(ms, now) {
    if (ms == null) return null;
    const h = (now - ms) / 3_600_000;
    if (h < 1) return `${Math.max(0, Math.round(h * 60))} 分钟前`;
    if (h < 48) return `${h.toFixed(1)} 小时前`;
    return `${(h / 24).toFixed(1)} 天前`;
  }

  /**
   * scope df 表：与 dogfood 相同的过滤器（experience/correction 且 active）。
   * rawSearch({ space, status, limit, offset, content }) → Atlas 原生响应。
   */
  async function buildScope(spaceId) {
    const df = new Map();
    let scopeDocCount = 0;
    let windowed = false;
    let offset = 0;
    for (let page = 0; page < 2; page += 1) {
      const response = await rawSearch({ space: spaceId, status: "active", limit: 200, offset, content: 1 });
      // rawSearch 返回 { status, payload, ... }：记录在 payload 里。
      const payload = response?.payload;
      if (!payload || payload.ok === false) break;
      const records = Array.isArray(payload.records) ? payload.records : [];
      for (const rec of records) {
        if (rec.kind !== "experience" && rec.kind !== "correction") continue;
        scopeDocCount += 1;
        for (const t of tokenizeForIndex(rec.content ?? "")) df.set(t, (df.get(t) ?? 0) + 1);
      }
      if (payload.hasMore === true && records.length > 0) {
        windowed = true;
        offset += records.length;
        if (offset >= 400) break; // 预览最多 2 页；再大就明示窗口化
      } else {
        break;
      }
    }
    return { df, scopeDocCount, windowed };
  }

  function rankChangeNotes({ results, state, now, mode, candidates }) {
    const notes = [];
    const a0Order = results.A0.ranked.map((r) => r.recordId);
    for (const s of ["L", "R", "LR", "D"]) {
      const r = results[s];
      if (r.refused) { notes.push({ strategy: s, refused: r.fallbackReason }); continue; }
      const order = r.ranked.map((x) => x.recordId);
      if (JSON.stringify(order) === JSON.stringify(a0Order)) {
        notes.push({ strategy: s, sameAsA0: true });
        continue;
      }
      for (const item of r.ranked) {
        const from = a0Order.indexOf(item.recordId) + 1;
        const to = order.indexOf(item.recordId) + 1;
        if (from === to) continue;
        let why = "";
        if (s === "R" || s === "LR") {
          const g2 = item.g2 ?? { multiplier: 1, count: 0 };
          why = g2.multiplier > 1
            ? `合法重提 ×${g2.count} 次 → 激活乘数 ×${g2.multiplier.toFixed(3)}`
            : "乘数 ×1（无合法重提）";
          if (s === "LR" && (r.gateMoves ?? []).some((m) => m.recordId === item.recordId)) {
            why += `；tier 闸门：${(r.gateMoves.find((m) => m.recordId === item.recordId)).reason}`;
          }
          if (s === "LR" && item.tier !== undefined) why += `（tier=T${item.tier}）`;
        }
        if (s === "D") {
          const cand = candidates.find((x) => x.recordId === item.recordId);
          const act = cand ? state.get(`${cand.spaceId}::${item.recordId}`) : null;
          why = act?.lastDeliveryMs
            ? `最近投递 ${ageText(act.lastDeliveryMs, now)} → ${item.suppressed ? "RecentDelivery 抑制生效" : "抑制窗外，未抑制"}`
            : "未抑制";
        }
        if (s === "L") {
          why = `tier=T${item.tier}（${item.tierName}）`;
        }
        notes.push({ strategy: s, recordId: item.recordId, from, to, why });
      }
    }
    return notes;
  }

  /**
   * 对一次 Atlas 检索做 A0/L/R/LR/D 影子解释。
   * raw 响应必须携带每条记录的 score/coverage/matchReason（索引路径才会给）。
   */
  async function explainSearch({ spaceId, query, raw }) {
    const now = Date.now();
    const records = Array.isArray(raw?.records) ? raw.records : [];
    const candidates = records.map((record, position) => ({
      recordId: record.recordId,
      spaceId,
      position,
      a0Score: record.score ?? null,
      coverage: record.coverage ?? null,
      matchReason: Array.isArray(record.matchReason) ? record.matchReason : null,
      content: record.content ?? "",
      occurredAt: record.occurredAt ?? null,
      status: record.status,
      kind: record.kind
    }));
    const mode = query ? "explicit" : "ambient";
    const queryTerms = query ? termsForQuery(query) : [];
    const collapsedQuery = query ? String(query).normalize("NFC").toLowerCase().replace(/\s+/g, "") : "";

    for (const c of candidates) {
      c.evidenceClass = classifyEvidencePath({ matchReason: c.matchReason, coverage: c.coverage });
    }

    const scope = await buildScope(spaceId);
    const state = replayEvents(ledger.events());
    const common = {
      candidates, mode, state, now, queryTerms, collapsedQuery,
      scopeDf: scope.df, scopeDocCount: scope.scopeDocCount
    };
    const results = {
      A0: rankA0V4({ candidates }),
      L: rankL(common),
      R: rankR(common),
      LR: rankLR(common),
      D: rankD(common)
    };

    const rankOf = (strategy) => {
      const r = results[strategy];
      if (r.refused) return null;
      return new Map(r.ranked.map((x, i) => [x.recordId, i + 1]));
    };
    const ranks = Object.fromEntries(["A0", "L", "R", "LR", "D"].map((s) => [s, rankOf(s)]));

    const rows = candidates.map((c) => {
      const act = state.get(`${c.spaceId}::${c.recordId}`);
      const lRow = results.L.ranked.find((x) => x.recordId === c.recordId) ?? null;
      const rRow = results.R.ranked.find((x) => x.recordId === c.recordId) ?? null;
      return {
        recordId: c.recordId,
        content: c.content,
        occurredAt: c.occurredAt,
        evidenceClass: c.evidenceClass,
        a0Score: c.a0Score,
        coverage: c.coverage,
        matchReason: c.matchReason,
        tier: lRow ? lRow.tier : null,
        tierName: lRow ? lRow.tierName : null,
        matchedBigrams: lRow?.matchedBigrams ?? null,
        g2: rRow?.g2 ?? null,
        revisitCount: act?.reinforceTimesMs?.length ?? 0,
        lastDeliveryMs: act?.lastDeliveryMs ?? null,
        lastDeliveryText: ageText(act?.lastDeliveryMs, now),
        rankBy: Object.fromEntries(["A0", "L", "R", "LR", "D"].map((s) => [s, ranks[s] ? ranks[s].get(c.recordId) : "refused"]))
      };
    });

    return {
      generatedAt: new Date(now).toISOString(),
      spaceId,
      query: query ?? null,
      mode,
      searchPath: raw?.searchPath ?? null,
      indexState: raw?.index?.state ?? null,
      candidateCount: candidates.length,
      scopeDocCount: scope.scopeDocCount,
      scopeWindowed: scope.windowed,
      scopeNote: scope.windowed
        ? "有效记录超过 200 条：词面 df 表只统计了前 400 条 active 记录，tier 证据是窗口内近似。"
        : null,
      officialOrderNote: "正式顺序 = A0（Atlas 检索返回序）；L/R/LR/D 仅为影子解释，未替换正式结果。",
      rows,
      order: Object.fromEntries(["A0", "L", "R", "LR", "D"].map((s) => [
        s,
        results[s].refused ? "refused" : results[s].ranked.map((x) => x.recordId)
      ])),
      refused: Object.fromEntries(["L", "R", "LR", "D"].map((s) => [
        s,
        results[s].refused ? results[s].fallbackReason : null
      ])),
      notes: rankChangeNotes({ results, state, now, mode, candidates })
    };
  }

  /**
   * 从用户消息里派生检索关键词。GLM 引擎与扫描都是空格分隔的 AND 语义，
   * 整句自然语言常会零命中；这里按空间词频表挑「存在且最稀有」的词元：
   * 二元词优先（更可辨别），ASCII 词次之，一元词兜底；df 升序，最多 6 个。
   * 只做检索词建议——评分与顺序仍完全由 Atlas 决定。
   */
  async function suggestKeywords(spaceId, message) {
    const text = String(message || "").trim();
    if (!text) return [];
    const { df, scopeDocCount, windowed } = await buildScope(spaceId);
    const terms = termsForQuery(text);
    const seen = new Set();
    const ranked = [];
    for (const { term, kind } of terms) {
      if (seen.has(term)) continue;
      seen.add(term);
      const count = df.get(term) ?? 0;
      if (count === 0) continue; // 空间里不存在的词元只会把 AND 查询拖成零命中
      const preference = kind === "cjk-2" ? 0 : kind === "ascii" ? 1 : 2;
      ranked.push({ term, kind, df: count, preference });
    }
    ranked.sort((a, b) => (a.preference - b.preference) || (a.df - b.df) || a.term.localeCompare(b.term));
    return { terms: ranked.slice(0, 6), scopeDocCount, windowed };
  }

  return { explainSearch, suggestKeywords };
}
