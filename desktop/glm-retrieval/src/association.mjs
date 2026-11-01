// B3 有界关联召回。边界（任务书 B3）：
//   - 只在同一实例内关联，跨实例永不关联。
//   - 只使用结构化字段共现：同 subject、同 source_session、同 subject 且时间邻近。
//   - 共同出现不是因果关系；关联永远作为“推测关联”标注（reason 前缀 association:）。
//   - 有界：每个锚点最多 maxPerAnchor 条，总量最多 total 条。
//   - 关联只影响召回与排名，不改变任何记录的存在性或效力。

const DEFAULTS = { maxPerAnchor: 5, total: 12, windowDays: 7 };

function withinWindow(aIso, bIso, windowDays) {
  if (!aIso || !bIso) return true; // 无时间信息不做时间裁剪（字段共现仍然成立）
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= windowDays * 86_400_000;
}

export function findAssociations(store, anchorDocs, { maxPerAnchor = DEFAULTS.maxPerAnchor, total = DEFAULTS.total, windowDays = DEFAULTS.windowDays, excludeKeys = new Set() } = {}) {
  const out = [];
  const seen = new Set(excludeKeys);
  for (const anchor of anchorDocs) {
    if (out.length >= total) break;
    const candidates = [];
    if (anchor.subject) {
      for (const doc of store.bySubject(anchor.instance_id, anchor.subject, { excludeKey: anchor.doc_key, limit: maxPerAnchor * 3 })) {
        if (!withinWindow(anchor.occurred_at, doc.occurred_at, windowDays)) continue;
        candidates.push({ doc, reason: 'association:same-subject+time-window' });
      }
    }
    if (anchor.source_session && candidates.length < maxPerAnchor) {
      for (const doc of store.bySourceSession(anchor.instance_id, anchor.source_session, { excludeKey: anchor.doc_key, limit: maxPerAnchor * 3 })) {
        if (candidates.some((c) => c.doc.doc_key === doc.doc_key)) continue;
        candidates.push({ doc, reason: 'association:same-source-session' });
      }
    }
    let added = 0;
    for (const candidate of candidates) {
      if (added >= maxPerAnchor || out.length >= total) break;
      if (seen.has(candidate.doc.doc_key)) continue;
      seen.add(candidate.doc.doc_key);
      out.push({ doc: candidate.doc, reason: candidate.reason, anchorRecordId: anchor.record_id });
      added += 1;
    }
  }
  return out;
}
