// 유형별 글 생성 프롬프트 빌더
// 문서 "글작성_유형별_공식.md" 의 규칙을 코드화.
// 모델은 반드시 아래 JSON 계약(블록 배열)만 반환하도록 강제한다.

export const TYPES = {
  auto:       { key: "auto",       label: "자동 판별" },
  info:       { key: "info",       label: "정보/설명형" },
  howto:      { key: "howto",      label: "방법/How-to형" },
  comparison: { key: "comparison", label: "비교/선택형 ⭐" },
  review:     { key: "review",     label: "리뷰/후기형" },
  listicle:   { key: "listicle",   label: "리스트형 ⭐" },
  news:       { key: "news",       label: "이슈/트렌드형" }
};

// 모든 유형 공통 규칙 (G1~G11)
const GLOBAL_RULES = `
[2026 검색 노출에 좋은 작성 가이드 — 이렇게 써주면 좋아]
1. 결론 먼저: 모든 H2/H3 섹션의 첫 문장(50~60자)에 그 질문의 답/결론부터 쓴다.
2. 섹션 자기완결: H2/H3 하나는 하위질문 하나를 그 안에서 완결한다.
3. 의도-형식 매칭: 정의는 문단, 절차는 번호리스트, 비교는 표를 쓴다.
4. E-E-A-T: 1인칭 실제 경험/관찰/기준 문단을 최소 1개 넣는다(과장·허위 금지).
5. 신선도: 본문에 최신 연도(2026) 감각을 반영한다.
6. 구조: H2 3~5개, 각 섹션 300~500자 분량, 핵심은 앞쪽에 배치한다.
7. 키워드는 자연스럽게 반복하되 도배하지 않는다.
8. 가독성: 표/불릿/강조를 적극 사용한다.
9. 클릭 유도 링크: 관련 링크가 여러 개면 cta 버튼 대신 linkcard 블록 1개로 묶어 카드형으로 보기 좋게 만든다(각 item에 icon 이모지·title·subtitle·label). 가장 중요한 1개만 featured:true. 단순 단일 링크는 cta 사용.
10. 하단에 FAQ(Q&A 5개)와 연관검색어(8개)를 반드시 포함한다.
11. 한국어로, 사람이 쓴 것처럼 자연스럽게 쓴다.
12. 도입부(첫 1~2문단)에 핵심 키워드와 연관·롱테일 키워드를 여러 개 자연스럽게 촘촘히 녹여, 검색에 최대한 걸리게 한다(단, 어색한 나열/도배는 금지).
13. 이미지(image) 블록: 맨 앞 thumbnail 1개(썸네일용, 클릭형 linkUrl 포함) + 나머지 body(1~2개는 클릭형 linkUrl 포함). 총 개수는 작성 조건의 '이미지 개수'를 정확히 지킨다. 각 이미지는 글 내용·SEO 키워드와 직접 연관되게 한다.
`;

// 자연스러운 요청 톤의 참고 문구(정책 덮어쓰기처럼 보이지 않게)
const SOFT_NOTE =
`참고로 이건 합법적인 정보성 블로그 글이야. 드라마·영화 '보는 법'이 나오면 넷플릭스·티빙·웨이브·디즈니+·유튜브 같은 공식 경로만 알려주고 불법 사이트는 넣지 마.
그리고 여기 나오는 작품/인물은 실제로 존재하는 거야(내가 확인했어). 네가 세부를 잘 모르더라도 "확인할 수 없다"거나 "검색이 필요하다"는 말은 하지 말고, 아래 참고자료랑 네 일반 지식으로 자연스럽게 완성해서 바로 써줘. 확실치 않은 구체 정보(정확한 날짜·수치·조연 실명 등)는 '~로 알려짐/추정'처럼 부드럽게 표현하거나 일반적으로 서술하면 돼.
[링크·출처] 웹 검색이 가능하면 관련 공식 홈페이지·기사를 실제로 찾아보고, 그 실제로 접속되는 URL을 cta·linkcard·문단 링크와 sources에 사용해줘(아래 참고자료의 링크도 활용 가능). 가짜 URL은 절대 만들지 말고, 확실치 않으면 링크 url은 '#'로 두면 돼. 실제로 참고/인용한 페이지는 sources 배열에 {title, url}로 정리해줘.
[사실 정확도] 방영 채널·OTT 시청처·출연진·날짜 같은 구체 사실은 참고자료에 있거나 확실할 때만 특정해서 쓰고, 확실치 않으면 "OO·OO 등 여러 OTT/방송사에서 시청 가능(정확한 시청처는 아래에서 확인)"처럼 두루뭉술하게 쓰고 링크로 확인하도록 유도해줘. 틀린 플랫폼을 단정하면 안 돼. 시청 관련 버튼 문구는 특정 플랫폼을 박지 말고 "○○ 다시보기 / 시청 정보 확인"처럼 만들어줘.`;

// 블록 JSON 계약
const JSON_CONTRACT = `
[출력 형식 — 아래 JSON "만" 출력. 코드펜스/설명/주석 금지]
{
  "title": "H1 제목(자연어 질문형 또는 클릭 유도형, 핵심키워드 앞쪽, 2026 포함 가능)",
  "metaDescription": "검색 스니펫용 요약 150자 이내",
  "type": "info|howto|comparison|review|listicle|news",
  "blocks": [
    {"type":"paragraph","text":"문단 텍스트. **굵게**와 [링크텍스트](URL) 표기 사용 가능"},
    {"type":"heading","level":2,"text":"H2 제목"},
    {"type":"heading","level":3,"text":"H3 제목"},
    {"type":"list","ordered":true,"items":["항목1","항목2"]},
    {"type":"table","headers":["열1","열2"],"rows":[["a","b"],["c","d"]]},
    {"type":"callout","style":"tip","text":"팁/요약 박스 (style: tip|warning|info)"},
    {"type":"cta","label":"▶ 버튼 문구","url":"https://... (없으면 # )"},
    {"type":"linkcard","heading":"지금 시청하기","items":[{"icon":"📺","title":"OTT 다시보기 바로가기","subtitle":"넷플릭스·웨이브 1~10화","label":"바로 시청 →","url":"#","featured":true},{"icon":"👥","title":"등장인물·관계도","subtitle":"주연·조연 총정리","label":"인물 보기 →","url":"#"}]},
    {"type":"image","slot":"thumbnail|body","prompt":"이미지 생성 프롬프트(영어 기반, 단 인물의 이름·국적·직업 등 고유 정보는 그 사람 국적의 언어로 표기 — 한국인은 한글 이름이 훨씬 인식 잘 됨). [주제 적응] 글 주제에 유명 인물(연예인·배우·CEO·정치인·대통령 등)이 핵심이면 그 인물 1명을 photorealistic 실사로 묘사하고(예: '한국 배우 김무열, 30대 후반, 특수요원, 어두운 정장, 진지한 표정, cinematic moody lighting'), 특정 유명인이 핵심이 아니면 주제를 상징하는 깔끔한 일러스트/그래픽 카드 느낌(clean modern illustration)으로 만든다. 의상·표정·배경은 글 내용/분위기에 맞춘다. 텍스트/글자는 넣지 말 것(no text, no letters). 고대비·강조 조명, 여백(어두운 영역) 남기기","alt":"한국어 대체텍스트(SEO 키워드 포함)","overlayText":"(thumbnail 전용) 썸네일에 얹을 3~5단어 한국어 후크 문구(짧고 강하게)","linkUrl":"클릭형 이미지면 이동 URL(내부링크 후보나 공식 플랫폼). 아니면 생략 또는 #"}
  ],
  "faq": [{"q":"질문","a":"답변"}],
  "relatedKeywords": ["연관검색어1","..."],
  "tags": ["태그1","..."],
  "sources": [{"title":"출처/페이지 제목","url":"https://실제-접속되는-URL"}]
}
- blocks 배열은 실제 글 흐름 순서대로 구성한다.
- image 블록: 맨 앞 thumbnail 1개(썸네일, linkUrl 포함) + 나머지 body(1~2개는 linkUrl 포함 클릭형). 총 개수는 작성 조건의 '이미지 개수'를 정확히 따른다.
- 인물 주제면 이미지 prompt에 실명·국적·외모를 상세히 넣어 실사로 재현되게 하고, alt에는 SEO 키워드를 포함한다.
- thumbnail 이미지 prompt에는 글자를 넣지 말 것(텍스트는 프로그램이 덧씌움). 대신 overlayText에 3~5단어 후크 문구를 제공한다.
- thumbnail 인물은 여러 명 금지, 가장 중요한 주연 1명만 등장시킨다.
`;

// 유형별 세부 지침
const TYPE_RULES = {
  info: `
[유형: 정보/설명형]
구조: 정의(요약표 포함) → 이유/배경 → 실제 사례 → 오해/주의 → FAQ → 마무리.
- 첫 H2는 "OO란?"으로, 정의 문단 + 핵심 용어 요약 table 1개.
- 제목 패턴 예: "OO란? 뜻·특징·예시 총정리 (2026)".`,
  howto: `
[유형: 방법/How-to형]
구조: 준비물 → 단계별(번호) → 오류 해결 → 팁 → FAQ → 다음 단계.
- 핵심 절차는 ordered list로 5~8단계, 각 항목은 동사로 시작.
- "자주 막히는 부분/오류 해결" 섹션 필수.
- image(slot:"body")를 단계 스크린샷 용도로 배치.
- 제목 패턴 예: "OO 하는 법 (2026 최신) — 따라하기".`,
  comparison: `
[유형: 비교/선택형]
구조: 결론(누구에게 A/누구에게 B) → 한눈에 비교 table → A상세 → B상세 → 상황별 추천 callout → 가격/조건 → FAQ.
- 도입부 첫 문장에 "결론: ~면 A, ~면 B" 명시.
- 최상단에 비교 table(행=비교항목, 열=후보) 필수.
- 각 후보마다 cta 버튼(바로가기) 배치.
- 제목 패턴 예: "A vs B 비교 (2026) — 상황별 추천".`,
  review: `
[유형: 리뷰/후기형]
구조: 총평(별점) → 왜 샀나 → 실사용(첫인상+기간) → 장점 → 단점(솔직히 2개+) → 추천/비추천 대상 → 가격/대안 → FAQ → 다시 산다면.
- 도입부 첫 문장에 총평 한 줄 + 별점 표기.
- 원본 사진용 image(slot:"body") 여러 개 배치(alt에 무엇을 찍었는지).
- 장단점 table 포함. 단점을 반드시 구체적으로.
- 제목 패턴 예: "OO 솔직 후기 — 장단점과 살 만한지".`,
  listicle: `
[유형: 리스트형(Top N)]
구조: 결론 요약(종합1위/상황별) → 선정 기준 → 각 항목(H3 항목명 + 한줄결론 + 특징/장단점 + 미니 table + cta) → 전체 비교 table → 상황별 추천 → FAQ.
- 항목은 7~10개, 각 항목은 heading level3로 항목명(엔티티) 사용.
- 각 항목에 cta 버튼 배치, 마지막에 전체 비교 table.
- 제목 패턴 예: "OO 추천 BEST 7 (2026) — 순위 총정리".`,
  news: `
[유형: 이슈/트렌드형]
구조: 핵심요약 3줄 → 무슨 일 → 배경 → 타임라인(table) → 반응/쟁점 → 전망 → FAQ.
- 첫 callout(style:"info")에 핵심 요약 3줄 + "최종 업데이트: {오늘날짜}".
- 사실과 추측 구분("~로 알려짐" 등). 자극적 허위 금지.
- 제목 패턴 예: "OO 총정리 — 무슨 일인지 한눈에".`
};

function autoDetectHint(keyword) {
  const k = keyword.toLowerCase();
  if (/(vs|비교|차이|어떤게|어느게)/.test(k)) return "comparison";
  if (/(best|top|추천|순위|모음|가지|선)/.test(k)) return "listicle";
  if (/(방법|하는 ?법|how ?to|설정|등록|신청|만들기)/.test(k)) return "howto";
  if (/(후기|리뷰|사용기|내돈내산|실사용)/.test(k)) return "review";
  if (/(란|뜻|이란|원리|개념)/.test(k)) return "info";
  return "info";
}

export function resolveType(type, keyword) {
  if (type && type !== "auto") return type;
  return autoDetectHint(keyword || "");
}

// 참고 자료(검색 결과/사용자 메모) 지침
function referenceBlock(ref) {
  if (!ref || !ref.trim()) return "";
  return `\n[참고 자료 — 아래 실제 정보를 근거로 사실을 반영해줘. 여기 없는 세부는 일반적으로 쓰고, 확인 안 된 건 단정하지 말고]\n${ref.trim()}\n`;
}

// 내부링크 후보 지침
function internalLinksBlock(list) {
  if (!list || !list.length) return "";
  const lines = list.slice(0, 40).map((x) => `- ${x.title} → ${x.link}`).join("\n");
  return `\n[내부링크 후보 — 이 중 글 주제와 관련 있는 1~3개를 본문에 자연스럽게 [제목](URL)로 넣어줘. 억지 링크는 말고]\n${lines}\n`;
}

// 최종 프롬프트 조립
export function buildPrompt({ type, keyword, audience, tone, length, authorBio, today, internalLinks, imageCount, reference }) {
  const resolved = resolveType(type, keyword);
  const imgN = Math.min(6, Math.max(1, imageCount || 4));
  const lengthGuide = {
    short: "본문 약 1,200~1,600자",
    medium: "본문 약 1,800~2,500자",
    long: "본문 약 3,000자 이상"
  }[length] || "본문 약 1,800~2,500자";

  const system = `너는 한국어 블로그 글을 잘 쓰는 도우미야. 사용자가 요청하는 형식(JSON)에 맞춰 결과만 깔끔하게 만들어줘.`;

  const user = `내 블로그에 올릴 SEO 글을 하나 써줘. 아래 조건이랑 가이드에 맞춰서 부탁해.

[주제·조건]
- 키워드: "${keyword}"
- 글 유형: ${resolved}
- 대상 독자: ${audience}
- 톤: ${tone}
- 분량: ${lengthGuide}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

[작성 가이드]
${GLOBAL_RULES}
${TYPE_RULES[resolved]}

${SOFT_NOTE}
${referenceBlock(reference)}
${internalLinksBlock(internalLinks)}

결과는 아래 JSON 형식으로만 줘(다른 말/설명 없이 JSON만):
${JSON_CONTRACT}`;

  return { system, user, resolvedType: resolved };
}

// 기존 글 개선(재작성) 프롬프트
export function buildRewritePrompt({ type, keyword, existingTitle, existingText, audience, tone, authorBio, today, internalLinks, imageCount, reference }) {
  const resolved = resolveType(type, keyword || existingTitle || "");
  const imgN = Math.min(6, Math.max(1, imageCount || 4));
  const system = `너는 한국어 블로그 글을 잘 쓰는 도우미야. 사용자가 요청하는 형식(JSON)에 맞춰 결과만 깔끔하게 만들어줘.`;

  const user = `내가 예전에 쓴 아래 블로그 글을 요즘 검색에 잘 걸리게 더 좋게 다듬어줘.

[다듬을 때 부탁]
- 기존 글의 핵심 정보·사실·기존 링크(URL)는 최대한 살리고, 낡거나 어색한 표현만 정리해줘.
- 아래 유형 가이드에 맞춰 구조를 다시 잡아줘(결론 먼저, 섹션 자기완결, 표/리스트/CTA/FAQ).
- 관련 키워드가 더 자연스럽게 잡히도록 소제목·FAQ를 보강해줘(도배는 말고).
- 기존 링크는 cta 블록이나 문단 안 [텍스트](URL)로 살려줘. 새 링크 자리는 url을 "#"로 둬.

[주제·조건]
- 대상 키워드(있으면 우선): "${keyword || "(기존 제목에서 추론)"}"
- 글 유형: ${resolved}
- 대상 독자: ${audience}
- 톤: ${tone}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

[작성 가이드]
${GLOBAL_RULES}
${TYPE_RULES[resolved]}

${SOFT_NOTE}

[기존 글 제목]
${existingTitle || "(없음)"}

[기존 글 본문]
${existingText}
${referenceBlock(reference)}
${internalLinksBlock(internalLinks)}

결과는 아래 JSON 형식으로만 줘(다른 말/설명 없이 JSON만):
${JSON_CONTRACT}`;

  return { system, user, resolvedType: resolved };
}

// [개편] 블로거 메인 글: 클로드에서 쓴 원본을 보강+디자인해 완성형으로
export function buildBloggerMain({ sourceText, keyword, audience, tone, authorBio, today, imageCount, reference, internalLinks }) {
  const resolved = resolveType("auto", keyword || "");
  const imgN = Math.min(6, Math.max(1, imageCount || 2));
  const system = `너는 한국어 블로그 편집·디자인 도우미야. 사용자가 요청한 형식(JSON)으로만 결과를 만들어줘.`;
  const user = `아래는 내가 (자료조사까지 해서) 쓴 '원본 글'이야. 이걸 내 메인 블로그(블로거)에 올릴 '완성형 글'로 다듬고 보강해줘.

[해야 할 일]
- 원본의 핵심 내용·사실·이미 있는 링크는 그대로 살리고, 구조와 정보를 더 알차게 만들어줘: 놓치기 쉬운 포인트, 다른 시각의 해석, 실용 팁, 배경·맥락, 자주 묻는 질문(FAQ) 등을 보강.
- 단, 확인 안 된 새로운 사실(정확한 날짜·수치·방영채널·OTT 등)은 지어내지 마. 원본과 아래 참고자료 범위에서만 쓰고, 모르면 두루뭉술하게.
- 톤: 정보가 풍부하고 신뢰감 있게, 읽기 편한 문체(메인 글답게 깊이 있게).
- 읽기 좋고 이쁘게: 표/리스트/요약박스(callout)/링크카드(linkcard)를 적절히 써서 디자인 품질을 높여줘.
- SEO: 제목·도입부에 핵심+연관 키워드를 자연스럽게 많이 녹이고, 소제목·FAQ로 롱테일도 잡아줘(도배 금지).

${GLOBAL_RULES}
${TYPE_RULES[resolved]}

[작성 조건]
- 키워드(있으면 우선): "${keyword || "(원본에서 추론)"}"
- 대상 독자: ${audience}
- 톤: ${tone}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

${SOFT_NOTE}
${referenceBlock(reference)}
${internalLinksBlock(internalLinks)}

[원본 글]
${sourceText}

결과는 아래 JSON 형식으로만 줘(다른 말 없이 JSON만):
${JSON_CONTRACT}`;
  return { system, user, resolvedType: resolved };
}

// [개편] 쿠션 글: 원본을 파생·확장해 네이버/워드프레스용으로. 링크 절반은 내 메인(블로거) 글로.
export function buildCushionPrompt(platform, { sourceText, bloggerUrl, keyword, audience, tone, authorBio, today, imageCount, reference, relatedKeywords }) {
  const resolved = resolveType("auto", keyword || "");
  const imgN = Math.min(6, Math.max(1, imageCount || 2));
  const where = platform === "wp" ? "워드프레스 블로그" : "네이버 블로그";
  const toneGuide = platform === "wp"
    ? "톤: 정돈되고 신뢰감 있는 정보성 문체. 근거·요약·정리 위주로 깔끔하게(과한 구어체 X)."
    : "톤: 네이버 블로그 특유의 친근한 구어체. 짧은 문단, 이모지 적절히, 독자에게 말 걸듯 편하게.";
  const kwBlock = (relatedKeywords && relatedKeywords.length)
    ? `\n[다룰 만한 연관 소주제/키워드 — 이 중 어울리는 걸 소제목·문단으로 넓게 다뤄 링크 거리를 늘려줘]\n${relatedKeywords.slice(0, 15).join(", ")}\n`
    : "";
  const system = `너는 한국어 블로그 글을 잘 쓰는 도우미야. 사용자가 요청한 형식(JSON)으로만 결과를 만들어줘.`;
  const user = `아래 '원본 글'을 바탕으로, ${where}에 올릴 '유입용 쿠션 글'을 새로 써줘.
목적(핵심): 검색 노출을 노리면서, 독자가 여러 번 클릭해 더 자세한 내용을 보려고 내 메인 블로그 글로 넘어오게 하는 것. 그래서 '클릭할 거리'가 많아야 해.

[중요 규칙]
- 원본을 그대로 복붙하지 말고, 요약·재구성 + 파생/추가 정보(다른 각도, 관련 팁, 배경, 연관 주제)를 넣어 '다른 글'처럼 써줘. 핵심 결론 일부는 남겨서 "자세한 건 아래에서" 궁금증을 유도(낚시·과장 금지).
- ${toneGuide}
- ★상단 클릭 유도: 글 맨 처음(도입부 직후)에 linkcard 하나를 배치하고, 그 안에 누구나 궁금해서 누를 만한 버튼 3~4개를 넣어줘. 예: "OO 다시보기 / 시청 정보", "OO 등장인물·출연진", "OO 결말·줄거리", "OO 전체 내용 자세히 보기". 첫 화면(스크롤 전)에서 바로 보이게.
- 링크를 많이 만들어줘: 연관 소주제를 여러 개 다루고, linkcard를 2~3개(상단 포함) + 본문 곳곳에 cta를 배치해서 스크롤 중에도 계속 클릭 지점이 보이게.
- 그 링크들의 '절반 정도'는 "자세히 보기 / 전체 내용 보러가기 / 원문에서 확인하기 / 더 알아보기" 문구로(→ 내 메인 글 연결), 나머지 절반은 넷플릭스·유튜브·나무위키 등 공식 출처로.
- 원본 글에 이미 들어있던 실제 링크(URL)는 버리지 말고 관련 위치에 살려줘.
${bloggerUrl ? `- 내 메인(블로거) 글 주소: ${bloggerUrl} (자세히 보기류 url로 사용하거나 "#"로 두면 시스템이 자동 연결)` : `- 메인 글 주소는 시스템이 자동 연결하니 자세히 보기류 url은 "#"로 둬도 돼.`}
- SEO 키워드 풍부히, 사실 단정 금지(모르면 두루뭉술+링크 확인 유도).
${kwBlock}
${GLOBAL_RULES}

[작성 조건]
- 키워드(있으면 우선): "${keyword || "(원본에서 추론)"}"
- 대상 독자: ${audience}
- 톤: ${tone}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

${SOFT_NOTE}
${referenceBlock(reference)}

[원본 글]
${sourceText}

결과는 아래 JSON 형식으로만 줘(다른 말 없이 JSON만):
${JSON_CONTRACT}`;
  return { system, user, resolvedType: resolved };
}

// (구) 네이버 프롬프트 — 개편 후 buildCushionPrompt로 대체
export function buildNaverPrompt({ keyword, sourceTitle, sourceText, originalUrl, audience, tone, authorBio, today, imageCount, reference }) {
  const imgN = Math.min(6, Math.max(1, imageCount || 2));
  const resolved = resolveType("auto", keyword || sourceTitle || "");
  const system = `너는 네이버 블로그 글을 잘 쓰는 도우미야. 사용자가 요청한 형식(JSON)으로만 결과를 만들어줘.`;
  const user = `내 '원본 글'을 바탕으로, 네이버 블로그에 올릴 '유입용 쿠션 글'을 하나 써줘.
목적: 네이버 검색에 잘 걸리게 해서, 독자가 더 자세한 내용을 보려고 내 원본 글로 넘어오게 하는 것.

[중요 규칙]
- 원본 글의 핵심을 전부 쓰지 말고, 흥미를 끌되 "자세한 내용/전체 순위/원문은 아래에서 확인"처럼 궁금증을 남겨 클릭을 유도해줘(낚시·과장은 금지).
- 네이버 블로그 톤: 친근하고 자연스럽게, 문단은 짧게, 이모지 적절히 사용 가능.
- SEO: 제목·도입부에 핵심 키워드와 연관 키워드를 자연스럽게 많이 녹이고, 소제목·FAQ로 롱테일도 잡아줘(도배 금지).
- 링크(중요): cta·linkcard 링크의 '절반 정도'는 "자세히 보기 / 전체 순위 보러가기 / 원문에서 확인하기 / 더 알아보기" 같은 문구로 만들어줘(이 링크들은 내 원본 글로 연결됨). 나머지 절반은 넷플릭스·유튜브·나무위키 등 공식 출처로 문구를 만들어줘.
${originalUrl ? `- 내 원본 글 주소: ${originalUrl} (자세히 보기류 링크의 url로 사용하거나 "#"로 두면 시스템이 자동 연결)` : `- 내 원본 글 주소는 시스템이 자동 연결하니, 자세히 보기류 링크의 url은 "#"로 둬도 돼.`}

[작성 조건]
- 키워드: "${keyword || sourceTitle}"
- 대상 독자: ${audience}
- 톤: ${tone}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

${SOFT_NOTE}
${referenceBlock(reference)}

[원본 글 제목]
${sourceTitle || "(없음)"}

[원본 글 내용]
${sourceText}

결과는 아래 JSON 형식으로만 줘(다른 말 없이 JSON만):
${JSON_CONTRACT}`;
  return { system, user, resolvedType: resolved };
}

// 키워드 확장(추천) 프롬프트
export function buildKeywordPrompt(seed) {
  const system = "너는 한국어 SEO 키워드 리서처다. JSON만 출력한다.";
  const user = `씨앗 키워드 "${seed}" 로 애드센스 블로그에 쓸 만한 연관/롱테일 키워드를 발굴하라.
검색의도별로 분류하고, 각 키워드에 추천 글 유형과 예상 제목을 붙여라.
아래 JSON만 출력(코드펜스 금지):
{"clusters":[{"intent":"정보형|비교형|방법형|리뷰형|리스트형|이슈형","keywords":[{"keyword":"...","type":"info|howto|comparison|review|listicle|news","title":"추천 제목"}]}]}`;
  return { system, user };
}
