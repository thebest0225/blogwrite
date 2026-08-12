// playbook.js — 사이트별 지침(플레이북)과 초안 기계 검증
//
// 왜 만들었나 (2026-08-13)
//   페르소나·편집원칙·경험자산이 claude.ai 루틴 프롬프트 안에 박혀 있었다. 한 줄 고치려면
//   1만 자를 다시 붙여야 했고, 사이트가 늘면 관리가 안 됐다.
//   더 큰 문제는 프롬프트에 '본문 1,700~2,500자', '사진 2장', '자기 점검' 을 다 써놨는데도
//   20건 중 11건이 어겼다는 것이다. 부탁으로는 안 지켜진다. 그래서 —
//     · 지침은 DB(site_playbook)에 두고 next_topic 이 읽어간다(수정이 웹에서 즉시 반영).
//     · 초안이 들어올 때 submit_draft 가 '기계로' 검사해서 어긋난 항목을 돌려준다.
//   새 MCP 도구를 만들지 않고 기존 도구(next_topic / submit_draft)를 확장하는 방식이다.

const SEC_ORDER = [
  "identity", "voice", "experience", "editorial", "keywords",
  "structure", "contract", "topics", "covered", "links", "checklist", "cadence",
];
const SEC_LABEL = {
  identity: "정체성·바이라인", voice: "말투", experience: "실제 경험 자산",
  editorial: "편집 원칙", keywords: "검색 키워드 규칙", structure: "구조 규칙",
  contract: "출력 형식 계약", topics: "주제 풀", covered: "이미 다룬 주제",
  links: "내부 링크 목록", checklist: "자기 점검", cadence: "발행 속도",
};

export function sectionOrder() { return SEC_ORDER.slice(); }
export function sectionLabel(k) { return SEC_LABEL[k] || k; }

// 플레이북을 루틴이 그대로 따를 수 있는 한 덩어리 글로 만든다.
export function renderPlaybook(pb) {
  if (!pb || !pb.sections?.length) return "";
  const bySec = new Map(pb.sections.map((s) => [s.section, s.body]));
  const out = [];
  for (const k of SEC_ORDER) {
    const body = bySec.get(k);
    if (body && body.trim()) out.push(`━━━ [${SEC_LABEL[k]}] ━━━\n${body.trim()}`);
  }
  // 순서에 없는 사용자 정의 섹션도 뒤에 붙인다
  for (const s of pb.sections) {
    if (!SEC_ORDER.includes(s.section) && s.section !== "__meta__" && s.body?.trim()) {
      out.push(`━━━ [${s.section}] ━━━\n${s.body.trim()}`);
    }
  }
  return out.join("\n\n");
}

// ─────────────────────────────────────────────────────────────
//  초안 기계 검증
// ─────────────────────────────────────────────────────────────
const HAN_JP = /[぀-ヿ一-鿿]/;          // 일본어(가나·한자)
const GEO_FOREIGN = {
  오키나와: "일본", 후쿠오카: "일본", 도쿄: "일본", 오사카: "일본", 삿포로: "일본", 교토: "일본",
  세부: "필리핀", 보홀: "필리핀", 마닐라: "필리핀",
  푸켓: "태국", 방콕: "태국", 치앙마이: "태국",
  하노이: "베트남", 다낭: "베트남", 호치민: "베트남",
};
const BAN_TITLE = /총정리|완벽 가이드|완벽정리|알아보기|모든 것|A to Z/;
const PHOTO_TAGS = ["walk","water","travel","treat","home","health","gear","face","sleep","car","cafe","friend"];
const SEASONS = ["spring","summer","fall","winter"];

// 네이버 초안(마크다운) 구조를 뜯는다. popup.js 의 naverizeDraft 와 같은 규칙이지만
// 여기선 DOM 없이 순수 정규식만 쓴다(서버·MCP 양쪽에서 돌아야 하므로).
export function parseNaverDraft(content) {
  let src = String(content || "").replace(/\r\n/g, "\n");
  let thumb = "";
  const ti = src.search(/^[ \t]*##\s*썸네일 프롬프트/m);
  if (ti >= 0) { thumb = src.slice(ti); src = src.slice(0, ti); }

  const meta = {};
  src = src.replace(/^\s*카테고리\s*[:：]\s*(.+)$/m, (_, v) => { meta.category = v.trim(); return ""; });
  src = src.replace(/^\s*원본참고\s*[:：]\s*(.+)$/m, (_, v) => { meta.source = v.trim(); return ""; });

  let tagLine = "";
  src = src.replace(/^\s*(#[^\s#]+(?:\s+#[^\s#]+){2,})\s*$/m, (_, v) => { tagLine = v.trim(); return ""; });

  const groups = src.split(/\n{2,}/).map((g) => g.trim()).filter(Boolean);
  const heads = [], photos = [], tables = [], links = [], text = [];
  for (const g of groups) {
    const lines = g.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines.every((l) => /^[—–\-─]{3,}$/.test(l))) { text.push("———"); continue; }
    const pm = lines[0].match(/^\[\s*사진\s*(\d+)\s*[·:]?\s*([^\]]*)\]$/);
    if (pm) {
      const cap = (lines[1] || "").replace(/^캡션\s*[:：]\s*/, "").trim();
      photos.push({ n: +pm[1], tags: pm[2].trim(), caption: cap });
      text.push(cap || `[사진${pm[1]}]`);
      continue;
    }
    if (lines.length >= 2 && lines.every((l) => l.startsWith("|"))) {
      const rows = lines.filter((l) => !/^\|[\s:|-]+\|$/.test(l))
        .map((l) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      if (rows.length) { tables.push(rows); text.push(rows.map((r) => r.join(" | ")).join("\n")); continue; }
    }
    if (lines.length === 1 && /^\*\*.+\*\*$/.test(lines[0])) {
      const h = lines[0].replace(/^\*\*|\*\*$/g, "").trim();
      heads.push(h); text.push(h); continue;
    }
    if (lines.every((l) => /^https?:\/\/\S+$/.test(l))) { links.push(...lines); text.push(...lines); continue; }
    text.push(lines.join("\n"));
  }
  const body = text.join("\n\n");
  return {
    meta, heads, photos, tables, links, thumb, tagLine,
    text: body,
    charCount: body.replace(/\s/g, "").length,
    tags: tagLine ? tagLine.split(/\s+/).filter(Boolean) : [],
  };
}

// 네이버 초안 검증. { ok, errors[], warns[], stats } 를 돌려준다.
export function validateNaverDraft({ title = "", content = "", allowedLinks = [] } = {}) {
  const p = parseNaverDraft(content);
  const E = [], W = [];
  const t = String(title).trim();

  // ── 제목
  if (t.length < 30 || t.length > 48) E.push(`제목이 ${t.length}자입니다 (30~48자)`);
  if (!/20\d\d/.test(t)) E.push("제목에 시점이 없습니다 (예: 2026년 8월 기준)");
  if (BAN_TITLE.test(t)) E.push(`제목에 금지 표현이 있습니다 (${t.match(BAN_TITLE)[0]})`);
  for (const [city, country] of Object.entries(GEO_FOREIGN)) {
    if (t.includes(city) && !t.includes(country)) {
      E.push(`제목에 '${city}' 만 있고 국가('${country}')가 없습니다 — 한국 사람은 '${country} ${city}' 로 검색합니다`);
      break;
    }
  }
  // 체중+견종 표기는 검색어가 아니다 → 중형견/소형견/대형견 으로
  if (/\d+\s*kg\s*(넘는|이상|이하)?\s*(코기|웰시코기|시바|말티즈|푸들)/.test(t) ||
      /(코기|웰시코기)\s*\d+\s*kg/.test(t)) {
    if (!/소형견|중형견|대형견/.test(t)) W.push("제목이 '체중+견종' 입니다 — '중형견' 같은 검색어를 쓰는 게 낫습니다");
  }

  // ── 본문
  if (p.charCount < 1700 || p.charCount > 2500) E.push(`본문이 ${p.charCount}자입니다 (1,700~2,500자)`);
  const contentHeads = p.heads.filter((h) => h !== "함께 보면 좋은 글");
  if (contentHeads.length < 5 || contentHeads.length > 7) E.push(`소제목이 ${contentHeads.length}개입니다 (5~7개, 하단 '함께 보면 좋은 글' 제외)`);
  if (/\*\*/.test(p.text)) E.push("본문에 ** 가 남아 있습니다 (소제목은 그 줄 하나만으로 문단을 이뤄야 합니다)");

  // ── 사진
  if (p.photos.length < 2 || p.photos.length > 3) E.push(`사진 자리가 ${p.photos.length}개입니다 (2개 기본, 길면 3개)`);
  for (const ph of p.photos) {
    const parts = ph.tags.split(/[+,\s]+/).filter(Boolean);
    const bad = parts.filter((x) => !PHOTO_TAGS.includes(x) && !SEASONS.includes(x));
    if (bad.length) E.push(`사진${ph.n} 태그에 허용 안 된 값: ${bad.join(", ")}`);
    if (!parts.some((x) => PHOTO_TAGS.includes(x))) E.push(`사진${ph.n} 에 주제 태그가 없습니다`);
    if (!ph.caption) E.push(`사진${ph.n} 캡션이 비어 있습니다`);
  }

  // ── 해시태그
  if (p.tags.length < 10 || p.tags.length > 20) E.push(`해시태그가 ${p.tags.length}개입니다 (10~20개)`);
  if (p.tags.some((x) => /\s/.test(x))) E.push("해시태그 안에 공백이 있습니다");
  const lines = p.text.split("\n");
  if (p.tagLine && lines[lines.length - 1] !== p.tagLine) W.push("해시태그가 마지막 본문 줄이 아닙니다");

  // ── 메타·썸네일
  if (!p.meta.category) E.push("맨 위에 '카테고리:' 줄이 없습니다");
  if (!p.meta.source) W.push("맨 위에 '원본참고:' 줄이 없습니다");
  if (!p.thumb) E.push("맨 끝에 '## 썸네일 프롬프트' 가 없습니다");

  // ── 외국어 발음 표기 (읽을 수 없으면 독자가 못 씁니다)
  if (HAN_JP.test(p.text)) {
    const jpLines = p.text.split("\n").filter((l) => HAN_JP.test(l));
    const noRead = jpLines.filter((l) => !/[(/]\s*[가-힣]/.test(l));
    if (noRead.length) E.push(`일본어에 발음 표기가 없는 줄 ${noRead.length}개 — 읽을 수 없으면 독자가 못 씁니다`);
  }

  // ── 내부 링크는 허용 목록 안에서만
  if (allowedLinks.length) {
    const bad = p.links.filter((u) => !allowedLinks.includes(u));
    if (bad.length) E.push(`허용 목록에 없는 주소 ${bad.length}개: ${bad.slice(0, 2).join(", ")}`);
  }
  if (!p.links.length) W.push("내부 링크가 없습니다");

  // ── 실용 밀도: '안 된다' 를 쓰고 대안이 없으면
  const negatives = (p.text.match(/안 되|안 됩니다|어렵습니다|제한이 있|불가/g) || []).length;
  const remedies = (p.text.match(/대신|되는 곳|되는 조건|찾는 방법|이렇게 물어|가능한 곳|대안/g) || []).length;
  if (negatives >= 3 && remedies === 0) E.push(`'안 된다' 류가 ${negatives}번 나오는데 대안·되는 곳이 없습니다`);

  // ── 표
  for (const rows of p.tables) {
    const w = rows[0].length;
    if (rows.some((r) => r.length !== w)) W.push("표의 열 수가 행마다 다릅니다");
  }

  return {
    ok: E.length === 0,
    errors: E, warns: W,
    stats: {
      titleChars: t.length, bodyChars: p.charCount,
      heads: contentHeads.length, photos: p.photos.length,
      tables: p.tables.length, links: p.links.length, tags: p.tags.length,
      category: p.meta.category || null, hasThumb: !!p.thumb,
    },
  };
}

// 워드프레스 3사이트 공통 검증(투데이모바 거절 원인 반영).
// 핵심: '판단' 이 있는가. 66건 중 1건에만 있어서 '가치 없는 콘텐츠' 로 반려됐다.
export function validateWpArticle({ title = "", body = "", calcLinks = [] } = {}) {
  const E = [], W = [];
  const t = String(title).trim();
  const h = String(body || "");
  const text = h.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;|&#\d+;/g, "");
  const chars = text.replace(/\s/g, "").length;

  if (t.length < 22 || t.length > 44) W.push(`제목이 ${t.length}자입니다 (22~44자)`);
  if (BAN_TITLE.test(t)) W.push(`제목에 상투 표현이 있습니다 (${t.match(BAN_TITLE)[0]})`);
  if (chars < 2500) E.push(`본문이 ${chars}자입니다 (2,500자 이상)`);

  const h2 = (h.match(/<h2[^>]*>/g) || []).length;
  if (h2 < 4) E.push(`h2 가 ${h2}개입니다 (4개 이상)`);

  // ★판단 — 이게 없으면 공식 자료 재기술이다
  const JUDGE = /실익이 없|해당(이)? (안|되지) |안 해도 되|오히려 (손해|불리|역효과)|추천하지 않|굳이 .{0,6}필요 없|이 경우(엔|는) .{0,10}(안|불리)/;
  if (!JUDGE.test(text)) E.push("판단이 없습니다 — '이 경우엔 실익이 없다 / 안 해도 된다 / 오히려 손해다' 를 근거와 함께 하나 넣으세요");

  // 기준 시점
  if (!/20\d\d년\s*\d+월|기준일|기준\)/.test(text)) W.push("본문에 기준 시점이 없습니다");

  // 계산기 연결 (todaymoba 의 원본 자산)
  if (calcLinks.length && !calcLinks.some((u) => h.includes(u))) {
    W.push("계산기 연결이 없습니다 — 남이 못 베끼는 자산입니다");
  }

  // 지어낸 개인 경력 주장 (편집팀 명의와 어긋난다)
  const CRED = /(저는|제가)[^.!?]{0,40}(콜센터|창구|증권사|소비자상담센터|공공근로|요양보호사|주민센터|복지관|무인발급기|상담원|공무원)/;
  if (CRED.test(text)) E.push("지어낸 개인 경력 주장이 있습니다 — 편집팀 명의와 어긋나고 YMYL 주제에서 위험합니다");

  return { ok: E.length === 0, errors: E, warns: W, stats: { titleChars: t.length, bodyChars: chars, h2 } };
}
