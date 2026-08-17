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
  "identity", "research", "voice", "experience", "editorial", "titles", "keywords",
  "hook", "flow", "tables", "structure", "contract", "topics", "covered",
  "links", "checklist", "cadence",
];
const SEC_LABEL = {
  identity: "정체성·바이라인", voice: "말투", experience: "실제 경험 자산",
  editorial: "편집 원칙", keywords: "검색 키워드 규칙", tables: "표 규칙",
  research: "쓰기 전 조사", titles: "제목 만드는 법", hook: "도입부 설계",
  flow: "본문 전개와 체류 장치", structure: "구조 규칙",
  contract: "출력 형식 계약", topics: "주제 풀", covered: "이미 다룬 주제",
  links: "내부 링크 목록", checklist: "자기 점검", cadence: "발행 속도",
};

// 로그·오류 메시지에 주소 전체를 박으면 읽기 어렵다. 네이버 글번호만 보여준다.
function shortLink(u) { return String(u).split("/").filter(Boolean).pop(); }

export function sectionOrder() { return SEC_ORDER.slice(); }
export function sectionLabel(k) { return SEC_LABEL[k] || k; }

// 정적 링크 목록에 '발행 완료된 글' 을 합친다.
//
// 왜 필요한가 — 정적 목록만 쓰면 새로 발행한 글이 '함께 보면 좋은 글' 후보에 영원히
// 안 들어간다. 예약발행이 많아 주소가 나중에 붙는데(확장이 3시간마다 블로그를 훑어
// 제목으로 매칭한다), 그 결과가 반영되지 않으면 항상 옛 글만 서로 링크하게 된다.
export function linksWithPublished(linkBody, published = [], missingUrl = 0) {
  const base = String(linkBody || "").trim();
  const have = new Set(base.match(/https?:\/\/\S+/g) || []);
  const fresh = (published || []).filter((r) => r.url && !have.has(r.url));
  const out = [base];
  if (fresh.length) {
    out.push("", "[최근 발행글 — 여기서도 골라도 된다]",
      ...fresh.map((r) => `${r.url} ${String(r.title || "").replace(/\s*\(20\d\d[^)]*\)\s*$/, "").trim()}`));
  }
  if (missingUrl > 0) {
    out.push("", `※ 발행했지만 주소가 아직 안 붙은 글 ${missingUrl}건이 있다. 주소를 모르니 링크로 쓰지 마라.`);
  }
  return out.join("\n");
}

// 플레이북에서 링크로 써도 되는 주소만 뽑는다. submit_draft 검증이 이걸 쓴다.
export function allowedLinksFrom(linkBody) {
  return String(linkBody || "").match(/https?:\/\/\S+/g) || [];
}

// 플레이북을 루틴이 그대로 따를 수 있는 한 덩어리 글로 만든다.
// extra: { links: "…" } 를 주면 그 섹션 본문을 대신 쓴다(발행글 합친 목록).
export function renderPlaybook(pb, extra = {}) {
  if (!pb || !pb.sections?.length) return "";
  const bySec = new Map(pb.sections.map((s) => [s.section, s.body]));
  for (const [k, v] of Object.entries(extra)) if (v) bySec.set(k, v);
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
  // 글 유형 — 경험형은 짧고 소제목 3개, 정보형은 길고 5~7개.
  // 하나의 규격으로 다 쓰면 훈련 글은 늘어지고 검역 글은 부실해진다.
  src = src.replace(/^\s*유형\s*[:：]\s*(.+)$/m, (_, v) => { meta.kind = v.trim(); return ""; });
  src = src.replace(/^\s*깊이\s*[:：]\s*(.+)$/m, (_, v) => { meta.depth = v.trim(); return ""; });

  let tagLine = "";
  src = src.replace(/^\s*(#[^\s#]+(?:\s+#[^\s#]+){2,})\s*$/m, (_, v) => { tagLine = v.trim(); return ""; });

  const groups = src.split(/\n{2,}/).map((g) => g.trim()).filter(Boolean);
  const heads = [], photos = [], tables = [], links = [], text = [];
  // 본문 링크와 하단 '함께 보면 좋은 글' 링크를 나눠 담는다.
  // 같은 주소가 두 곳에 다 들어가면 네이버가 링크 카드를 두 번 그려서
  // 같은 글이 반복돼 보인다(실제로 겪었다). 그걸 잡으려면 구분이 필요하다.
  const bodyLinks = [], footerLinks = [];
  let inFooter = false;
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
    // 푸터 표식이 두 형식으로 존재한다 — '**함께 보면 좋은 글**' 과 평문 '함께 보면 좋은 글 ▼'.
    // 하나만 보면 하단 링크를 본문 링크로 세어 중복 판정이 어긋난다.
    if (/^함께 (보면|읽으면) 좋은 글/.test(lines[0].replace(/\*/g, "").trim())) inFooter = true;
    if (lines.length === 1 && /^\*\*.+\*\*$/.test(lines[0])) {
      const h = lines[0].replace(/^\*\*|\*\*$/g, "").trim();
      heads.push(h); text.push(h); continue;
    }
    if (lines.every((l) => /^https?:\/\/\S+$/.test(l))) {
      links.push(...lines);
      (inFooter ? footerLinks : bodyLinks).push(...lines);
      text.push(...lines); continue;
    }
    text.push(lines.join("\n"));
  }
  const body = text.join("\n\n");
  return {
    meta, heads, photos, tables, links, bodyLinks, footerLinks, thumb, tagLine,
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
  if (t.length < 30 || t.length > 48) W.push(`제목이 ${t.length}자입니다 (모바일에서 잘리지 않는 건 대략 30~48자입니다)`);
  // ── 시점 표기는 '필요한 주제에만'
  //   모든 제목에 강제했더니 40건이 전부 '(2026년 8월)' 로 끝났다. 훈련법·해부·기본관리는
  //   내년에도 안 바뀌는데 날짜를 달면 오히려 낡은 글로 보인다.
  //   시점이 정보인 건 규정·요금·제도처럼 바뀌는 것, 그리고 계절 타는 것뿐이다.
  // ⚠️ '법' 을 단독으로 넣었더니 '~하는 법' 이 전부 걸렸다(줄당김·발톱 자르는 법 등).
  //    제도를 뜻하는 말만 남긴다.
  const TIME_NEEDED = /검역|서류|규정|정책|법령|법적|과태료|단속|항공|기내|화물|입국|비자|요금|비용|유지비|지원금|보조금|신청|무료|바뀌|개정|시행|숙소|호텔|렌터카|페리|대중교통|지하철|등록제/;
  const SEASONAL = /여름|장마|폭염|겨울|한파|봄|가을|휴가철|성수기|명절/;
  const hasTime = /20\d\d/.test(t);
  if ((TIME_NEEDED.test(t) || SEASONAL.test(t)) && !hasTime) {
    W.push("제목에 시점이 없습니다 — 규정·요금·계절처럼 바뀌는 주제라 기준 시점이 있으면 좋습니다");
  } else if (hasTime && !TIME_NEEDED.test(t) && !SEASONAL.test(t)) {
    W.push("이 주제는 시점이 필요 없어 보입니다 — 훈련·해부·기본관리는 내년에도 같습니다. " +
           "날짜를 빼면 제목에 쓸 글자가 늘어납니다");
  }
  if (BAN_TITLE.test(t)) E.push(`제목에 금지 표현이 있습니다 (${t.match(BAN_TITLE)[0]})`);
  for (const [city, country] of Object.entries(GEO_FOREIGN)) {
    if (t.includes(city) && !t.includes(country)) {
      W.push(`제목에 '${city}' 만 있고 국가('${country}')가 없습니다 — 한국 사람은 '${country} ${city}' 로 검색합니다`);
      break;
    }
  }
  // 체중+견종 표기는 검색어가 아니다 → 중형견/소형견/대형견 으로
  if (/\d+\s*kg\s*(넘는|이상|이하)?\s*(코기|웰시코기|시바|말티즈|푸들)/.test(t) ||
      /(코기|웰시코기)\s*\d+\s*kg/.test(t)) {
    if (!/소형견|중형견|대형견/.test(t)) W.push("제목이 '체중+견종' 입니다 — '중형견' 같은 검색어를 쓰는 게 낫습니다");
  }

  // ── 본문
  // 표는 정보 밀도가 높아 글자수를 크게 밀어올린다. 상한은 '늘어짐'을 막으려는
  // 것이므로 표 셀 글자는 절반만 센다.
  const tableChars = (p.tables || []).reduce(
    (n, tb) => n + tb.reduce((m, r) => m + r.join("").replace(/\s/g, "").length, 0), 0);
  const proseChars = p.charCount - Math.floor(tableChars / 2);
  // ── 깊이 — 주제에 맞게 고른다
  //   경험형/정보형 2분법이 너무 좁았다. 장소 추천은 가볍게 쓰면 되고
  //   검역 절차는 논문처럼 깊게 써야 하는데 같은 밴드에 밀어 넣고 있었다.
  //   밴드는 넓게 둔다 — 글자수로 글을 통제하려 들면 문장이 이상해진다.
  const DEPTH = {
    // ★구간을 넉넉히 겹친다. 밴드 사이에 틈이 있으면 어느 쪽으로도 안 맞는 글이 생긴다
    //   (소제목 6개에 1,8xx자인 글이 '보통'에도 '깊게'에도 안 맞았다).
    가볍게:   [600, 1500],   // 장소 추천 · 시즌 소식 · 짧은 후기
    보통:     [1200, 2400],  // 경험 · 훈련 · 건강 신호
    깊게:     [1700, 3600],  // 절차 · 규정 · 비교 · 지역 가이드
    "아주 깊게": [3000, 9000],  // 제도 전체 해설 · 검역 전 과정
  };
  const kindRaw = String(p.meta.depth || p.meta.kind || "").trim();
  let kindName = Object.keys(DEPTH).find((k) => kindRaw.includes(k));
  // 옛 표기(경험형/정보형) 호환 — 둘 다 실측 중간이 1,7xx 자라 '보통' 이다.
  // '정보형' 을 '깊게'(2,000~) 로 보냈더니 기존 글이 전부 밴드 아래로 떨어졌다.
  if (!kindName) kindName = "보통";
  const [lo, hi] = DEPTH[kindName];
  if (proseChars < lo || proseChars > hi)
    W.push(`본문이 ${proseChars}자입니다 — '${kindName}'은 보통 ${lo.toLocaleString()}~${hi.toLocaleString()}자입니다 (표 글자는 절반만 셈). 깊이를 바꾸거나 분량을 조정하세요`);
  if (!p.meta.depth && !p.meta.kind)
    W.push("맨 위에 '깊이: 가볍게|보통|깊게|아주 깊게' 줄이 없습니다 — '보통'으로 검사했습니다");

  // '정리하면 이래요' 는 마무리 표식이라 내용 소제목이 아니다. 하단 링크 제목도 마찬가지.
  const contentHeads = p.heads.filter(
    (h) => h !== "함께 보면 좋은 글" && !/^(정리하면|정리 —|마무리|한 줄 정리)/.test(h.trim()));
  // 소제목 개수는 깊이에서 따라 나온다. 개수를 못 박으면 내용을 억지로 쪼개거나 붙이게 된다.
  const HEADS = { 가볍게: [2, 4], 보통: [3, 6], 깊게: [4, 8], "아주 깊게": [5, 12] };
  const [hLo, hHi] = HEADS[kindName];
  if (contentHeads.length < hLo || contentHeads.length > hHi)
    W.push(`소제목이 ${contentHeads.length}개입니다 — '${kindName}'은 보통 ${hLo}~${hHi}개입니다`);

  // ── 소제목이 문장형인지
  // 명사로 끝나는 소제목은 목차처럼 읽혀서 다음 문단을 읽을 이유를 못 준다.
  const nounHeads = contentHeads.filter((h) => !/(요|다|까|나|죠|군요|습니다|세요|네요)[.?!]?$/.test(h.trim()));
  if (nounHeads.length > Math.floor(contentHeads.length / 2))
    W.push(`소제목 ${nounHeads.length}/${contentHeads.length}개가 명사로 끝납니다 — 읽고 싶게 만드는 문장형으로 (${nounHeads.slice(0, 2).join(" / ")})`);
  if (/\*\*/.test(p.text)) E.push("본문에 ** 가 남아 있습니다 (소제목은 그 줄 하나만으로 문단을 이뤄야 합니다)");

  // ── 사진
  if (p.photos.length < 2 || p.photos.length > 3) W.push(`사진 자리가 ${p.photos.length}개입니다 (보통 2~3개)`);
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
  // parseNaverDraft 가 태그 줄을 text 에서 떼어내므로 '마지막 줄이냐' 는 항상 거짓이 된다.
  // 실제로 볼 것은 태그 줄 위에 공백 두 줄이 있는지다.
  if (p.tagLine) {
    const before = String(content).split(p.tagLine)[0].match(/\n*$/)?.[0] || "";
    if ((before.match(/\n/g) || []).length < 3) W.push("해시태그 위에 공백 두 줄을 넣어주세요");
  }

  // ── 메타·썸네일
  if (!p.meta.category) E.push("맨 위에 '카테고리:' 줄이 없습니다");
  if (!p.meta.source) W.push("맨 위에 '원본참고:' 줄이 없습니다");
  if (!p.thumb) E.push("맨 끝에 '## 썸네일 프롬프트' 가 없습니다");

  // ── 외국어 발음 표기 (읽을 수 없으면 독자가 못 씁니다)
  if (HAN_JP.test(p.text)) {
    // 발음은 같은 줄에 괄호로 붙이기도 하고 다음 줄에 "읽기:" 로 달기도 한다.
    // 같은 줄만 보면 멀쩡한 글이 반려되므로 바로 다음 두 줄까지 함께 본다.
    const L = p.text.split("\n");
    const hasRead = (s) => /[(/'"]\s*[가-힣]/.test(s) || /읽기|발음/.test(s);
    const noRead = L.filter((l, i) => HAN_JP.test(l) && !hasRead(l)
      && !hasRead(L[i + 1] || "") && !hasRead(L[i + 2] || ""));
    if (noRead.length) E.push(`일본어에 발음 표기가 없는 줄 ${noRead.length}개 — 읽을 수 없으면 독자가 못 씁니다`);
  }

  // ── 내부 링크는 허용 목록 안에서만
  if (allowedLinks.length) {
    const bad = p.links.filter((u) => !allowedLinks.includes(u));
    if (bad.length) E.push(`허용 목록에 없는 주소 ${bad.length}개: ${bad.slice(0, 2).join(", ")}`);
  }
  if (!p.links.length) W.push("내부 링크가 없습니다");

  // ── 링크 중복
  // 네이버는 주소 한 줄을 링크 카드(썸네일+제목)로 바꿔 그린다. 같은 주소가 본문과
  // 하단에 다 있으면 같은 글이 카드로 두 번 뜨고, 독자에겐 글이 반복돼 보인다.
  const dupBoth = p.bodyLinks.filter((u) => p.footerLinks.includes(u));
  if (dupBoth.length) {
    E.push(`본문과 '함께 보면 좋은 글' 에 같은 주소가 ${dupBoth.length}개 있습니다 — ` +
           `네이버가 링크 카드를 두 번 그려서 같은 글이 반복돼 보입니다 (${dupBoth.map(shortLink).join(", ")})`);
  }
  const seen = new Set(), dupSame = new Set();
  for (const u of p.links) { if (seen.has(u)) dupSame.add(u); seen.add(u); }
  const footerDup = p.footerLinks.filter((u, i) => p.footerLinks.indexOf(u) !== i);
  if (footerDup.length) E.push(`'함께 보면 좋은 글' 안에 같은 주소가 중복입니다 (${footerDup.map(shortLink).join(", ")})`);
  if (p.footerLinks.length && p.footerLinks.length !== 3)
    W.push(`'함께 보면 좋은 글' 이 ${p.footerLinks.length}개입니다 (3개 권장)`);
  if (p.bodyLinks.length > 2)
    W.push(`본문 중간 링크가 ${p.bodyLinks.length}개입니다 (1~2개 권장)`);

  // ── 제목이 장소·업체를 약속했으면 실제 이름을 대야 한다
  //   '일본 도쿄 반려견 동반 숙소' 제목에 유형별 분류만 있고 이름이 '프린스' 하나였다.
  //   도쿄 글과 오사카 글이 바꿔 써도 되는 글이 된다 — 차별성이 0이다.
  //   원인은 [편집 원칙] 이 '판별법' 을 목록의 대체물로 허용한 것이었다.
  //
  //   ★판정 방식 — '이름을 센다' 는 두 번 실패했다. 표 첫 칸을 다 세니 '택시·도보' 가
  //     이름이 됐고, '수식어+시설유형' 으로 좁히니 '객실 호텔·프렌들리 호텔' 이 걸렸다.
  //     그래서 반대로 간다: 이름 대신 ★유형 나열★ 을 잡는다. 이건 신호가 깨끗하다 —
  //     유형 표는 머리글에 '유형·종류·구분' 이 박히고 칸이 일반명사로 시작한다.
  const PROMISES_PLACE = /숙소|호텔|펜션|리조트|해변|계곡|식당|카페|공원|산책코스|등산로|수목원|캠핑|휴양림|펫호텔|되는 곳|업체/;
  if (PROMISES_PLACE.test(t)) {
    // ★'펫' 으로 시작한다고 일반명사가 아니다 — 펫봄·펫트너·펫플래닛은 실제 업체명이다.
    //   접두어만 보면 실제 이름이 걸려서, 작업자가 표를 7줄로 늘려 과반을 피하는
    //   우회를 했다. 우회를 유발하는 검사는 잘못된 검사다.
    //   그래서 접두어가 아니라 '뒤에 붙은 말' 로 판정한다 — 유형을 뜻하는 꼬리표가
    //   붙어야 일반명사다 (펫 전용 객실 '호텔' / 애견 '펜션' / 중형견 가능 '숙소').
    const GENERIC = new RegExp(
      "^(?:펫|반려|애견|대형|소형|중형|부티크|일반|전용|고급|저가|체인|기타|유형|구분|종류|현지|해외|국내|근처|주변|일부|각종|여러)"
      + "[가-힣A-Za-z0-9·\\s]*"
      + "(?:호텔|펜션|리조트|숙소|객실|업체|시설|유형|종류|구분|방식|서비스|플랫폼)\\s*$"
      + "|^(?:유형|구분|종류|방식)");
    let typeTable = false, nameRows = 0;
    for (const tb of p.tables) {
      const header = (tb[0] || []).join(" ");
      const firstCol = tb.slice(1).map((r) => (r[0] || "").trim()).filter(Boolean);
      if (!firstCol.length) continue;
      const generic = firstCol.filter((c) => GENERIC.test(c)).length;
      // 머리글이 '유형/종류/구분' 이거나 첫 칸 절반 이상이 일반명사면 유형 표다
      if (/유형|종류|구분/.test(header) || generic * 2 >= firstCol.length) typeTable = true;
      else nameRows += firstCol.length;
    }
    if (typeTable && nameRows < 4)
      W.push("장소·업체를 약속한 제목인데 표가 '유형별 분류' 입니다 — " +
             "유형은 독자가 이미 압니다. 실제 이름 5~6곳을 조건·비용·예약방법과 함께 대세요");
    else if (!p.tables.length)
      W.push("장소·업체를 약속한 제목인데 목록이 없습니다 — 실제 이름 5~6곳을 표로 정리하세요");
  }

  // ── 정보 밀도 — 분량만 재니 물로 채운 글이 통과했다
  //   재입국 검역 글이 2,023자였는데 구체적인 값은 '0.5IU' 하나뿐이었다.
  //   나머지는 '몇 주 걸려요' '나라마다 달라요' 로 넘어갔다. 그 자리가 글의 알맹이다.
  const FIGURES = p.text.match(
    /\d+(?:[.,]\d+)?\s*(?:kg|g|cm|mm|도|℃|원|만원|엔|달러|일|주|개월|년|시간|분|초|%|회|마리|명|IU|㎖|ml|박|인분|층|실)/g) || [];
  const headCount = Math.max(1, contentHeads.length);
  if (FIGURES.length < headCount)
    W.push(`구체적인 수치가 ${FIGURES.length}개뿐입니다 (소제목 ${headCount}개) — ` +
           `금액·기간·크기·기준값을 찾아서 채우면 글의 값이 올라갑니다`);

  // 값을 안 찾고 넘긴 자리를 잡는다
  const VAGUE = [
    /찾아보(면|시면)\s*(나와요|나옵니다|알 수 있)/,
    /(검색|조회)해\s*보(면|시면)\s*(나와요|나옵니다)/,
    /나라마다 (달라요|다릅니다|갈려요)(?![^\n]{0,40}\d)/,
    /몇 주(?! 째)|며칠(?! 전)|넉넉히 (역산|잡)/,
    /확인해\s*(두시면|보시면) (돼요|됩니다)(?![^\n]{0,30}\d)/,
    /경우에 따라 (달라|다릅)/,
  ];
  const vague = VAGUE.filter((re) => re.test(p.text)).length;
  if (vague >= 2)
    W.push(`값을 안 찾고 넘긴 자리가 ${vague}군데 보입니다 ('몇 주' '나라마다 달라요' '찾아보면 나와요') — ` +
           `그 자리가 독자가 찾아온 이유입니다`);

  // ── 출처 표기 (링크가 아니라 이름으로)
  //   외부 링크는 걸지 않는다 — 남의 사이트로 내보낼 이유가 없다. 대신 근거를 밝힌다.
  const SOURCE = /검역본부|공단|협회|항공|국토부|농림축산|지자체|보건소|시청|구청|보험사|제조사|공식 (안내|규정|기준)|규정상|기준으로|안내에 따르면/;
  if (FIGURES.length >= 5 && !SOURCE.test(p.text))
    W.push("수치는 있는데 출처가 안 보입니다 — '검역본부 기준으로' 처럼 어디 근거인지 밝혀주세요 (링크는 걸지 마세요)");

  // ── 지어낸 독자 반응 (확인할 수 없는 사회적 증거)
  // 후쿠오카 글에 없던 댓글을 지어낸 사고가 있었다. 이건 독자를 속이는 것이고
  // 실제 반응이 없는 블로그에서는 금방 들통난다.
  const FAKE_SOCIAL = /댓글이 (많|여러|꽤)|질문이 (많|여러|꽤|자주)|문의가 (많|여러|꽤)|물어보시는 분들이 (많|여러)|요청이 (많|있어서)|다들 궁금해하|반응이 (좋|많)|쪽지가 (많|여러)/;
  const fake = p.text.match(FAKE_SOCIAL);
  if (fake) E.push(`독자 반응을 지어낸 표현이 있습니다 ('${fake[0]}') — 확인할 수 없는 주장은 쓰지 마세요`);

  // ── 도입부·마무리가 고정 문구로 굳었는지
  // 35건이 전부 '안녕하세요! 망고아빠입니다.' 로 시작하고 대다수가 '댓글 남겨주세요' 로
  // 끝난 적이 있다. 규칙이 만든 획일성이라 규칙으로 막는다.
  const lines0 = p.text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (/^안녕하세요[!.]?\s*망고아빠입니다[.!]?$/.test(lines0[0] || ""))
    W.push("첫 줄이 고정 인사말입니다 — 실제 상황으로 시작하고 인사는 뒤로 미루거나 문장을 바꿔주세요");
  // ⚠️ p.text 의 끝은 하단 '함께 보면 좋은 글' 링크다. 마무리 구간을 따로 잡아야 한다.
  const fi = p.text.indexOf("함께 보면 좋은 글");
  const closing = (fi > 0 ? p.text.slice(0, fi) : p.text).split("\n")
    .map((l) => l.trim()).filter(Boolean).slice(-12).join("\n");
  if (/댓글 (남겨|달아)주세요/.test(closing))
    W.push("'댓글 남겨주세요' 로 끝납니다 — 독자가 자기 경험을 말하고 싶어지는 질문으로 끝내주세요");
  // 물음표가 없어도 '궁금합니다' 처럼 묻는 형태면 인정한다
  if (!/\?/.test(closing) && !/궁금(합니다|해요|하네요)|어떠(세요|신가요)|있으(세요|신가요)/.test(closing))
    W.push("마무리에 독자에게 묻는 질문이 없습니다");

  // ── 내가 만든 틀 (규칙이 요소를 강제하면 같은 문장으로 굳는다)
  //   [편집 원칙] 이 '아직 남은 애로사항' 을 요구해서 10건에 같은 틀이 박혔다.
  //   [말투] 가 인사말을 강제해서 35건이 같은 문장으로 시작했다.
  //   이제 그 틀 자체를 막는다. 같은 뜻을 다른 문장으로 쓰면 된다.
  const TEMPLATES = [
    [/아직[^\n]{0,6}(남은 )?애로|남은 애로/, "'아직 남은 애로' 틀 — 40건 중 10건이 같은 문장이었습니다. 남은 불편은 그 글의 말로 쓰세요"],
    [/^정리하면/m, "'정리하면' 으로 마무리를 여는 건 40건 중 35건이 썼습니다. 다른 말로 여세요"],
    [/(세 줄|한 줄)로 (요약|정리)/, "'세 줄로 요약할게요' 예고는 상투구입니다. 바로 요약하세요"],
    [/(짚어볼게요|확인해봤어요|확인해봤습니다|정리했어요|정리해볼게요|풀어볼게요)\s*$/m,
     "도입부를 '~볼게요/~했습니다' 예고로 닫지 마세요 — 궁금증이 아니라 목차 안내가 됩니다"],
    [/그 뒤로[^\n]{0,10}순서를 (바꿨|고정)/, "'그 뒤로 순서를 바꿨어요' 는 4건이 똑같이 썼습니다"],
  ];
  for (const [re, msg] of TEMPLATES) if (re.test(p.text)) W.push(msg);

  // ── 제목에 클릭할 이유가 있나
  //   40건을 재보니 33건이 '주제 ｜ 부제 (2026년 8월)' 정보 나열형이었다.
  //   네이버 상위 노출 제목은 말줄임표 19/20, 직접인용 9/20, 반전 7/20 이었다.
  const T_DEVICE = [
    [/…|\.\.\.$/, "말줄임표로 끊기"],
    [/["“”''][^"“”'']{4,}["“”'']/, "직접 인용"],
    [/\?/, "질문형"],
    [/사실|알고 ?보니|의외|반전|인 줄|아니었|였는데/, "반전·의외"],
    [/하지 마|안 되|주의|실수|함정|피하|못 (타|하|받)/, "금지·주의"],
    [/vs|비교|보다|차이|어느 쪽/, "비교·대결"],
  ];
  if (!T_DEVICE.some(([re]) => re.test(t)))
    W.push(`제목에 클릭할 이유가 안 보입니다 — 말줄임표·직접인용·질문형·반전·금지·비교 중 하나가 있으면 클릭률이 올라갑니다`);

  // ── 실용 밀도: '안 된다' 를 쓰고 대안이 없으면
  const negatives = (p.text.match(/안 되|안 됩니다|어렵습니다|제한이 있|불가/g) || []).length;
  const remedies = (p.text.match(/대신|되는 곳|되는 조건|찾는 방법|이렇게 물어|가능한 곳|대안/g) || []).length;
  if (negatives >= 3 && remedies === 0) W.push(`'안 된다' 류가 ${negatives}번 나오는데 대안·되는 곳이 없습니다 — 되는 쪽을 알려주세요`);

  // ── 표
  // 2행짜리 3열 표는 문장으로 쓰는 게 낫다. 표를 넣었다면 비교할 값이 있어야 한다.
  if (!p.tables.length) W.push("표가 없습니다 — 비교·금액·주기·판단 기준 중 하나는 표로 만드는 게 좋습니다");
  if (p.tables.length > 2) W.push(`표가 ${p.tables.length}개입니다 — 한 글에 1~2개면 충분합니다`);
  p.tables.forEach((rows, i) => {
    const n = i + 1;
    const w = rows[0].length;
    if (rows.some((r) => r.length !== w)) E.push(`표${n} 의 열 수가 행마다 다릅니다 (자동 채우기가 깨집니다)`);
    if (w < 3) W.push(`표${n} 이 ${w}열입니다 — 열을 하나 더 넣거나 불릿으로 바꾸는 게 낫습니다`);
    if (rows.length < 4) W.push(`표${n} 이 헤더 포함 ${rows.length}행입니다 — 비교 대상이 3개는 돼야 표로 쓸 값이 있습니다`);
    // 숫자·금액·규격이 하나도 없으면 표가 아니라 그냥 나열이다
    const digits = rows.slice(1).flat().join(" ");
    if (!/\d/.test(digits)) W.push(`표${n} 에 수치가 없습니다 — 금액·크기·개수·기한 중 하나는 넣어주세요`);
    // 셀이 비면 네이버에서 빈 칸으로 남아 성의없이 보인다
    if (rows.slice(1).some((r) => r.some((c) => !c.trim()))) E.push(`표${n} 에 빈 칸이 있습니다`);
  });

  return {
    ok: E.length === 0,
    errors: E, warns: W,
    stats: {
      kind: kindName, proseChars,
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

// ─────────────────────────────────────────────────────────────
//  니치 관찰 분석 — 상위 노출 제목에서 패턴을 뽑는다
//
//  왜 필요한가 (2026-08-14)
//    "룰 하나 정해놓고 뺑뺑이" 라는 지적을 받았다. 실제로 초안 35건이 같은 첫 문장으로
//    시작했다. 무엇이 상위에 뜨는지 보지 않고 내부 규칙만 돌렸기 때문이다.
//    확장이 모아온 제목을 여기서 숫자로 바꿔 [쓰기 전 조사] 에 실어 보낸다.
//    사람이 눈으로 20개를 세는 대신 기계가 세게 한다.
// ─────────────────────────────────────────────────────────────
const SERP_DEVICES = [
  ["말줄임표로 끊기", /(…|\.\.\.)\s*$|(…|\.\.\.)/],
  ["직접 인용", /["“”''][^"“”'']{4,}["“”'']/],
  ["질문형", /\?/],
  ["구체적 숫자", /\d/],
  ["비교·대결", /vs|VS|비교|보다|차이/],
  ["반전·의외", /사실|알고 ?보니|의외|반전|였는데|인 줄|아니었/],
  ["금지·주의", /하지 마|안 되|주의|실수|함정|망하|피하/],
  ["방법·순서", /방법|순서|하는 법|고르는|기준/],
  ["시점 표기", /20\d\d|올해|이번 ?달|최신/],
  ["말 걸기", /요\?|잖아요|하실까요|해보세요|아세요/],
];

export function analyzeSerp(rows) {
  const titles = (rows || []).map((r) => r.title).filter(Boolean);
  if (!titles.length) return null;

  const devices = SERP_DEVICES.map(([name, re]) => ({
    name, n: titles.filter((t) => re.test(t)).length,
  })).sort((a, b) => b.n - a.n);

  const lens = titles.map((t) => t.length).sort((a, b) => a - b);
  const mid = lens[Math.floor(lens.length / 2)];

  // 자주 나오는 낱말 — 제목에서 실제로 쓰이는 검색어를 본다
  const stop = new Set(["그리고", "하는", "있는", "위한", "대한", "해서", "하고", "이거",
                        "저거", "정말", "너무", "진짜", "제가", "저는", "이런", "그런"]);
  const freq = new Map();
  for (const t of titles) {
    for (const w of t.split(/[^가-힣A-Za-z0-9]+/)) {
      if (w.length < 2 || stop.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  const words = [...freq.entries()].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 18);

  return { count: titles.length, medianLen: mid,
           minLen: lens[0], maxLen: lens[lens.length - 1], devices, words };
}

// 분석 결과를 [쓰기 전 조사] 뒤에 붙일 글로 만든다.
export function renderSerp(byKeyword) {
  const blocks = [];
  for (const { keyword, rows, seen } of byKeyword) {
    const a = analyzeSerp(rows);
    if (!a) continue;
    const dev = a.devices.filter((d) => d.n > 0)
      .map((d) => `${d.name} ${d.n}/${a.count}`).join(" · ");
    blocks.push(
      `· "${keyword}" 상위 ${a.count}개 (수집 ${String(seen).slice(0, 10)})\n` +
      `  제목 길이 ${a.minLen}~${a.maxLen}자, 중간 ${a.medianLen}자\n` +
      `  장치: ${dev}\n` +
      `  자주 쓰인 말: ${a.words.map(([w, n]) => `${w}(${n})`).join(", ")}\n` +
      `  실제 제목 —\n` +
      rows.slice(0, 5).map((r) => `    ${r.rank}. ${r.title}`).join("\n"));
  }
  if (!blocks.length) return "";
  return "[실제 상위 노출 제목 관찰 — 확장이 모아온 것]\n" +
    "추측하지 말고 이 숫자를 근거로 써라. 내 제목이 여기서 어떻게 다른지 의식하고 만든다.\n\n" +
    blocks.join("\n\n");
}

// ─────────────────────────────────────────────────────────────
//  초안 사이 반복 검사
//
//  왜 필요한가 (2026-08-17)
//    지금까지 검증기는 글 하나만 봤다. 그래서 40건에 같은 문장이 11번 나와도 못 잡았다.
//    실제로 두 번 당했다 —
//      · [말투] 가 인사말을 강제 → 35건이 '안녕하세요! 망고아빠입니다.' 로 시작
//      · [편집 원칙] 이 '아직 남은 애로사항' 을 요구 → 11건에 같은 틀이 박힘
//    규칙이 요소를 강제하면 그 요소가 똑같은 문장으로 나온다. 한 건만 봐서는 절대 안 보인다.
//    그래서 전체를 가로질러 센다.
// ─────────────────────────────────────────────────────────────

// 흔한 말투는 세지 않는다 — 해요체 블로그에서 '더라고요' 가 겹치는 건 정상이다.
// 문제는 '구조를 채우려고 넣은 상투구' 다.
const CLICHE = [
  ["아직 애로", /아직[^\n]{0,6}(남은 )?애로|남은 애로/],
  ["정리하면 마무리", /^정리하면/m],
  ["세 줄 요약 예고", /(세 줄|한 줄)로 (요약|정리)/],
  ["예고형 도입부 닫기", /(짚어볼게요|확인해봤어요|확인해봤습니다|정리했어요|정리해볼게요|풀어볼게요)\s*$/m],
  ["반대였어요", /^반대였(어요|습니다)\.?$/m],
  ["결국 ~였습니다", /결국[^\n]{0,24}(였습니다|이었어요|였어요)/],
  ["그 뒤로 순서를 바꿨", /그 뒤로[^\n]{0,10}순서를 (바꿨|고정)/],
  ["~가 핵심이었", /(이|가) 핵심이었/],
];

/**
 * 여러 초안을 한꺼번에 보고, 같은 상투구가 몇 건에 나오는지 센다.
 * limit 건 이상이면 그 표현은 '틀' 이 된 것이다.
 */
export function crossDraftRepeats(drafts, limit = 3) {
  const out = [];
  for (const [name, re] of CLICHE) {
    const hits = drafts.filter((d) => re.test(String(d.content || "")));
    if (hits.length >= limit) {
      out.push({ name, n: hits.length, total: drafts.length,
                 titles: hits.slice(0, 4).map((d) => String(d.title || "").slice(0, 28)) });
    }
  }

  // 첫 문장·마지막 문장이 겹치는지 — 위 목록에 없는 새 틀도 잡힌다
  const firstLine = new Map(), lastLine = new Map();
  for (const d of drafts) {
    const p = parseNaverDraft(d.content);
    const L = p.text.split("\n").map((x) => x.trim()).filter(Boolean);
    const fi = p.text.indexOf("함께 보면 좋은 글");
    const closing = (fi > 0 ? p.text.slice(0, fi) : p.text)
      .split("\n").map((x) => x.trim()).filter(Boolean);
    const add = (map, key) => { if (key && key.length > 5) map.set(key, (map.get(key) || 0) + 1); };
    add(firstLine, L[0]);
    add(lastLine, closing[closing.length - 1]);
  }
  for (const [label, map] of [["첫 문장", firstLine], ["마지막 문장", lastLine]]) {
    for (const [line, n] of map) {
      if (n >= limit) out.push({ name: `${label} 반복: "${line.slice(0, 30)}"`, n, total: drafts.length, titles: [] });
    }
  }
  return out.sort((a, b) => b.n - a.n);
}
