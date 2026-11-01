// B1 中文词法分析。设计目标来自任务书：
//   - 1～2 字中文短词可检索 → CJK 逐字一元 + 相邻二元索引
//   - 稳定 ID、代号（MK-II / HS-7）、日期（2026年3月14日）可检索 → ASCII 词元原样保留
//   - 绝不做“相似度去重”，更不会把「喜欢」与「不喜欢」归并——这里只产生词元集合，
//     不产生任何“重复判定”。极性字（不/无/没/非）永远是一元词元，天然可查。

const CJK_RANGES = [
  [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2a6df]
];

function isCjk(ch) {
  const code = ch.codePointAt(0);
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi);
}

export function normalizeText(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// 文本 → 词元集合（去重）。ASCII 连续段保留整体词元（含 - _ . 连接），
// CJK 段落输出一元与相邻二元。数字与日期随 ASCII 段进入。
export function tokenizeForIndex(text) {
  const normalized = normalizeText(text);
  const terms = new Set();
  let asciiRun = '';
  let cjkRun = '';
  const flushAscii = () => {
    if (asciiRun) { terms.add(asciiRun); asciiRun = ''; }
  };
  const flushCjk = () => {
    for (let i = 0; i < cjkRun.length; i += 1) {
      terms.add(cjkRun[i]);
      if (i + 1 < cjkRun.length) terms.add(cjkRun.slice(i, i + 2));
    }
    cjkRun = '';
  };
  for (const ch of normalized) {
    if (isCjk(ch)) { flushAscii(); cjkRun += ch; continue; }
    flushCjk();
    if (/[a-z0-9]/.test(ch) || (asciiRun && /[-._]/.test(ch))) { asciiRun += ch; continue; }
    flushAscii();
  }
  flushAscii();
  flushCjk();
  return terms;
}

// 查询词 → 查询词元列表。多词按空格拆分（与 Backend A 的 q 语义一致：AND）。
// 2 字 CJK 查询优先用二元词元（精确相邻），1 字用一元。
export function termsForQuery(query) {
  const normalized = normalizeText(query);
  if (!normalized) return [];
  const out = [];
  for (const word of normalized.split(' ').filter(Boolean)) {
    const parts = [...word];
    const allCjk = parts.every(isCjk);
    if (allCjk && parts.length === 1) { out.push({ term: word, kind: 'cjk-1' }); continue; }
    if (allCjk && parts.length === 2) { out.push({ term: word, kind: 'cjk-2' }); continue; }
    for (const term of tokenizeForIndex(word)) {
      out.push({ term, kind: term.length === 1 ? 'cjk-1' : term.length === 2 && isCjk(term[0]) && isCjk(term[1]) ? 'cjk-2' : 'ascii' });
    }
  }
  return out;
}
