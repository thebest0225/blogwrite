// ============================================================
// 대본 분할기 — v2/assets/js/longform/phase_split.js 에서 그대로 이식 (2026-08-06)
//
// ⚠️ 이 파일은 UI 의 autoSplit() 과 "글자 하나까지 같은 결과" 를 내야 한다.
//    API 의 POST /split-script 는 Gemini 기반이고 target_length 하한이 80자라
//    사용자의 60자 설정을 80자로 바꿔버린다 → 절대 쓰지 않는다.
//
//    규칙 (maxC = 60 기준):
//      softCap      = maxC * 1.35 = 81   여기까진 넘겨도 문장 경계 유지
//      hardOverflow = maxC * 1.50 = 90   한 문장이 이보다 길면 절(,·;·:) 단위로 쪼갬
//      minKeep      = max(20, maxC*0.4) = 24   이보다 짧은 꼬리는 이웃과 병합
//      merge 상한   = maxC * 1.60 = 96
//    실측(프로젝트 157 TSMC, 12,369자): 193세그먼트 · 평균 61.4자 · 범위 31~96자
//
//    원본을 고칠 때는 이 파일도 같이 고쳐야 한다.
// ============================================================

function splitIntoSentences(text) {
  const OPEN = { '"': '"', "'": "'", '“': '”', '‘': '’', '「': '」', '『': '』' };
  const CLOSE_SET = new Set(Object.values(OPEN));
  const TERM = new Set(['.', '!', '?', '。', '！', '？', '…']);
  const out = [];
  let buf = '';
  let quoteStack = [];
  let sentenceStartedWithQuote = false;

  const isDigit = (c) => c >= '0' && c <= '9';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const inQuote = quoteStack.length > 0;

    // Track sentence start flag (first non-space char of current buffer).
    if (buf.length === 0 || /\s/.test(buf[buf.length - 1])) {
      // buffer tail is whitespace/empty — next non-space defines start
    }

    // Straight quotes (" and ') are ambiguous — same char opens and closes.
    // If we're inside a quote and this char matches the current top, treat it as close.
    // Typographic pairs ("" '' 「」 『』) always take the open/close branches distinctly.
    if (inQuote && ch === quoteStack[quoteStack.length - 1]) {
      quoteStack.pop();
      buf += ch;
      const prev = buf.length >= 2 ? buf[buf.length - 2] : '';
      if (sentenceStartedWithQuote && quoteStack.length === 0 && TERM.has(prev)) {
        out.push(buf.trim());
        buf = '';
        sentenceStartedWithQuote = false;
      }
      continue;
    }

    // Opening quote: start a new layer.
    if (OPEN[ch]) {
      if (buf.trim().length === 0) sentenceStartedWithQuote = true;
      quoteStack.push(OPEN[ch]);
      buf += ch;
      continue;
    }

    buf += ch;

    // Terminators only count outside quotes.
    if (!inQuote && TERM.has(ch)) {
      // Decimal guard: digit.digit should stay together.
      if (ch === '.' && i + 1 < text.length && isDigit(text[i + 1]) && i > 0 && isDigit(text[i - 1])) {
        continue;
      }
      // Consume repeated terminators (e.g., "?!", "...", "…").
      while (i + 1 < text.length && TERM.has(text[i + 1])) {
        buf += text[i + 1];
        i++;
      }
      // Peek next non-space: if a closing quote follows a standalone quoted sentence,
      // defer the cut until we consume that close quote (handled above).
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (sentenceStartedWithQuote && j < text.length && CLOSE_SET.has(text[j])) {
        // Don't cut yet — let the close-quote branch finalize.
        continue;
      }
      // Cut here.
      const piece = buf.trim();
      if (piece) out.push(piece);
      buf = '';
      sentenceStartedWithQuote = false;
    }
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

function clauseSplitLong(sentence, maxC) {
  const hardOverflow = Math.floor(maxC * 1.5);
  if (sentence.length <= hardOverflow) return [sentence];
  const chunks = [];
  let s = sentence;
  const CLAUSE = /[,;:、，]/;
  while (s.length > hardOverflow) {
    // 목표: maxC ~ maxC*1.3 사이에서 절 단위 경계 찾기.
    let cut = -1;
    const hi = Math.min(Math.floor(maxC * 1.3), s.length - 1);
    const lo = Math.max(20, Math.floor(maxC * 0.6));
    for (let k = hi; k >= lo; k--) {
      if (CLAUSE.test(s[k])) { cut = k + 1; break; }
    }
    if (cut < 0) {
      // 절 경계가 없으면 공백에서 자름.
      for (let k = Math.min(maxC, s.length - 1); k >= lo; k--) {
        if (/\s/.test(s[k])) { cut = k; break; }
      }
    }
    if (cut < 0) cut = maxC;  // 최후 수단: 글자 단위 절단
    chunks.push(s.slice(0, cut).trim());
    s = s.slice(cut).trim();
  }
  if (s) chunks.push(s);
  return chunks.filter(Boolean);
}

function autoSplit(script, maxC) {
  script = String(script || '').trim();
  if (!script) return [];
  const softCap = Math.floor(maxC * 1.35);
  const minKeep = Math.max(20, Math.floor(maxC * 0.4));
  const sentences = splitIntoSentences(script);
  const out = [];
  let buf = '';

  for (const s of sentences) {
    if (!s) continue;
    // 단일 문장이 너무 길면 절 단위로 쪼개서 차례대로 흘려보냄.
    if (s.length > Math.floor(maxC * 1.5)) {
      if (buf) { out.push(buf); buf = ''; }
      clauseSplitLong(s, maxC).forEach(c => out.push(c));
      continue;
    }
    const joined = buf ? buf + ' ' + s : s;
    if (!buf) {
      buf = s;
    } else if (joined.length <= softCap) {
      // softCap까지는 오버도 허용 — 문장 단위 경계 유지가 우선.
      buf = joined;
    } else {
      out.push(buf);
      buf = s;
    }
  }
  if (buf) out.push(buf);

  // 뒤쪽부터 훑으며 너무 짧은 세그먼트를 앞/뒤와 병합.
  // (흔히 마지막 조각이 짧아지는 문제를 해결)
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].replace(/\s/g, '').length >= minKeep) continue;
    if (i > 0) {
      // 앞쪽과 합쳐도 hardOverflow 이하라면 앞쪽에 붙임.
      const merged = out[i - 1] + ' ' + out[i];
      if (merged.length <= Math.floor(maxC * 1.6)) {
        out[i - 1] = merged;
        out.splice(i, 1);
        continue;
      }
    }
    if (i + 1 < out.length) {
      const merged = out[i] + ' ' + out[i + 1];
      if (merged.length <= Math.floor(maxC * 1.6)) {
        out[i] = merged;
        out.splice(i + 1, 1);
        continue;
      }
    }
    // 합칠 수 없으면 그대로 유지 (첫/마지막 1개뿐이거나 이웃도 긴 경우).
  }

  return out;
}

export { splitIntoSentences, clauseSplitLong, autoSplit };
