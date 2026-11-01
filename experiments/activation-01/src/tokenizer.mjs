// B1 中文词法分析 —— 自 glm-retrieval/src/tokenize.mjs @ 4f112f2 原样内联（vendored copy）。
// 来源：glm-retrieval 引擎（上游见 desktop/PROVENANCE.md）src/tokenize.mjs
// 本实验不修改原目录；此处副本仅用于在独立 worktree 中复现与真实 HEAD 完全一致的
// 词元语义（CJK 一元/二元 + ASCII 段），保证 A0 基线是真实基线而非任务书转述。
// 逐行与原文件一致（除本头注释）。

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
