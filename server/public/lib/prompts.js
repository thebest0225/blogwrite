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

// 공통 시스템 프롬프트: '사용자가 검증한 원본을 재편집·디자인' 으로 프레이밍 → 거부/서두 방지
const EDITOR_SYSTEM =
`너는 한국어 블로그 편집·디자인 전문가야. 사용자가 직접 작성하고 사실 확인까지 마친 '원본 글'을, 검색 노출이 잘 되는 보기 좋은 블로그 글로 재편집·재구성·디자인하는 작업이다.
- 새로운 구체 사실(정확한 날짜·수치·실명 등)을 지어내지 말고, 원본에 있는 정보를 재구성·재배치하고 일반적으로 알려진 배경·맥락·연관 키워드로 자연스럽게 보강한다.
- 이건 사용자 본인의 콘텐츠를 다듬는 정당한 편집 작업이다. 확인 질문이나 거부·주의 서두 없이 바로 결과만 낸다.
- 반드시 요청된 JSON 형식 하나로만 응답한다(설명·코드펜스·서두 금지, '{' 로 시작).`;

// 작성 지침(중립적 서술 — 거부성 서두 유발 방지)
const SOFT_NOTE =
`[작성 지침]
- 정보성 블로그 글이다. 콘텐츠 시청 안내가 필요하면 넷플릭스·티빙·웨이브·디즈니+·유튜브 등 공식 경로만 안내한다.
- 아래 원본 글과 참고자료, 그리고 일반 지식을 바탕으로 자연스럽게 완성한다. 확실하지 않은 구체 정보(정확한 날짜·수치·조연 실명 등)는 "~로 알려짐/추정" 식으로 부드럽게 쓰거나 일반적으로 서술한다.
- 링크·URL: 확실한 실제 URL만 사용한다. 원본 글에 이미 있는 링크는 관련 위치에 활용한다. 불확실하면 url을 "#"로 둔다(가짜 URL 생성 금지). 실제 참고한 페이지만 sources 배열에 {title, url}로 정리한다.
- 유튜브 영상 URL: 원본에 유튜브 영상 주소(youtube.com/watch, youtu.be 등)가 있으면 관련 위치에 그대로 살려라. 시스템이 그 자리에서 자동으로 '재생 플레이어'로 임베드한다(별도 버튼으로 만들 필요 없음).
- 방영채널·OTT·출연진·날짜 등 구체 사실은 확실할 때만 특정한다. 불확실하면 "여러 OTT/방송사에서 확인 가능(정확한 시청처는 링크에서 확인)"처럼 서술하고 링크로 유도한다. 시청 버튼 문구는 특정 플랫폼을 단정하지 말고 "○○ 다시보기 / 시청 정보 확인" 형태로 만든다.`;

// SEO·트렌드·수익형(애드센스) 최적화 공통 블록 — 목적지/쿠션 생성 시 주입
const SEO_TREND = `
[SEO·트렌드·수익형 블로그 최적화 — 매우 중요]
- 이 글은 애드센스 정보 블로그용이다. '검색 유입'과 '체류시간'이 핵심 목표다.
- 이 모델은 웹검색을 못 한다. 그러니 위 '원본 글(초안)'에 담긴 정보·수치·고유명사·실제 링크·맥락을 최대한 뽑아내 활용해라(초안이 곧 정보 저수지). 초안에 없는 새 사실(정확한 날짜·수치 등)은 지어내지 말고, 초안 정보를 더 깊고 촘촘하게 재구성·확장한다.
- 검색의도 커버리지: 대표 키워드 + 연관검색어 + 롱테일을 각각 소제목(H2/H3)·문단으로 '실제 내용'으로 다뤄, 글 하나로 여러 검색어를 잡는다.
- 제목: 숫자·연도(2026)·구체어·궁금증 유발을 활용한 클릭 유도형(단, 과장·낚시 금지).
- 구조: 목차형 H2 5개 이상, 표·리스트·요약박스(callout)로 스캔 가독성 확보, 하단 FAQ로 롱테일 흡수, 연관검색어 8개 포함.
- 광고 친화: 도입부에 결론 요약 → 이후 본문을 충분히 길고 알차게(체류시간↑), 소제목 간격을 자연스럽게 두어 광고가 배치될 여지를 준다.
- ★썸네일(첫 image 블록) = 클릭률의 핵심이다. 이 주제에서 '가장 클릭하고 싶은 장면'을 논리적으로 골라 **구체적으로** 묘사해라: 핵심 인물(유명인·CEO·정치인이면 실명+실사 묘사), 상징적 사물, 현장 분위기 등. 예) 삼성 성과급/노조 이슈면 '기업 총수와 노조 대표가 마주한 협상 테이블, 삼성 사옥, 긴장된 분위기'처럼 주제가 한눈에 읽히는 장면. 막연한 아이콘·그래프·화살표 말고 실제 상황을 담아라(단, 확인 안 된 인물을 억지로 특정하지는 말 것).`;

// 사람이 쓴 듯한 깊이·개성 — 애드센스 승인/체류에 매우 중요
const HUMAN_VOICE = `
[사람이 쓴 듯한 깊이·개성 — 애드센스 승인·체류시간에 매우 중요]
- 1인칭 경험·관점을 실제로 녹여라: "직접 해보니", "내 경우엔", "의외였던 건", "처음엔 헷갈렸는데" 같은 구체적 관찰·판단·시행착오를 최소 2~3곳. (확인 안 된 사실을 지어내지는 말고, 일반적 경험 범위에서 자연스럽게)
- 정보만 나열하지 마라 — 각 섹션은 '사실 + 그에 대한 해석/판단/견해'가 함께 있어야 한다. 왜 그런지, 무엇을 주의해야 하는지, 나라면 어떻게 할지까지.
- 구체성으로 깊이를 더해라: 실제 수치·사례·상황·비교·예외·흔한 오해·체크포인트. 두루뭉술한 일반론 금지.
- AI 티 제거: "~에 대해 알아보겠습니다", "결론적으로", "다양한", "매우 중요합니다", "~할 수 있습니다"의 반복, 뻔한 도입/마무리, 교과서식 나열을 피하라. 문장 길이를 변주하고 자연스러운 구어와 단정적 견해를 섞어라.
- 도입부는 정의부터 시작하지 말고, 독자의 실제 고민·상황·궁금증으로 훅을 걸어라.`;

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
  "photoQueries": ["english stock photo query 1","english query 2","english query 3"],
  "tags": ["태그1","..."],
  "sources": [{"title":"출처/페이지 제목","url":"https://실제-접속되는-URL"}]
}
- photoQueries: 이 글에 어울리는 **스톡사진 검색어를 영어로 3~5개**(구체적 장면·사물·상황. 예: "samsung office building", "korean stock market chart", "business meeting negotiation"). 본문 사이에 넣을 실사 사진 검색에 쓰인다.
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

${variantBlock(variant)}
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

${variantBlock(variant)}
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
function variantBlock(v) {
  if (!v) return "";
  let out = "";
  if (v.total > 1) out += `\n[변형 지시 — 매우 중요] 같은 원본으로 여러 계정용 글을 만드는 중이다. 이 글은 그 중 ${v.index}번째다(총 ${v.total}개). 다른 변형들과 **제목·소제목·도입부·파생 키워드·다루는 각도를 확실히 다르게** 써서 중복을 피해라(같은 문장 재사용 금지).\n`;
  if (v.style) out += `\n[이 블로그의 톤·디자인 아이덴티티 — 이 스타일로 통일감 있게] "${v.style}" 이 느낌이 살도록 소제목 어조, 리스트/표/요약박스(callout) 사용 방식, 문단 길이를 맞춰라. (블로그마다 색깔이 달라야 한다)\n`;
  return out;
}
export function buildBloggerMain({ sourceText, keyword, audience, tone, authorBio, today, imageCount, reference, internalLinks, variant }) {
  const resolved = resolveType("auto", keyword || "");
  const imgN = Math.min(6, Math.max(1, imageCount || 2));
  const system = EDITOR_SYSTEM;
  const user = `아래는 내가 (자료조사까지 해서) 쓴 '원본 글'이야. 이걸 최종 목적지 사이트(워드프레스)에 올릴 '완성형 글'로 다듬고 보강해줘.
이 글은 광고가 붙는 **최종 목적지 글**이야 — 가장 깊이 있고 완성도 높아야 해. (블로거·네이버 쿠션 글들이 이 글로 유입시킨다)

[해야 할 일]
- 원본의 핵심 내용·사실·이미 있는 링크는 그대로 살리고, 구조와 정보를 더 알차게 만들어줘: 놓치기 쉬운 포인트, 다른 시각의 해석, 실용 팁, 배경·맥락, 자주 묻는 질문(FAQ) 등을 보강.
- ★키워드는 네가 직접 뽑아라: 원본 주제에서 **검색량이 높을 만한 핵심 키워드 + 연관/파생 키워드(롱테일 포함)**를 스스로 여러 개 도출해, 제목·소제목·도입부·FAQ에 자연스럽게 녹여줘(도배 금지). 별도 키워드 입력은 없다.
- 단, 확인 안 된 새로운 사실(정확한 날짜·수치·방영채널·OTT 등)은 지어내지 마. 원본과 아래 참고자료 범위에서만 쓰고, 모르면 두루뭉술하게.
- 톤: 정보가 풍부하고 신뢰감 있게, 읽기 편한 문체(메인 글답게 깊이 있게).
- 읽기 좋고 이쁘게: 표/리스트/요약박스(callout)/링크카드(linkcard)를 적절히 써서 디자인 품질을 높여줘.

${GLOBAL_RULES}
${SEO_TREND}
${HUMAN_VOICE}
${TYPE_RULES[resolved]}

[작성 조건]
- 키워드(있으면 우선): "${keyword || "(원본에서 추론)"}"
- 대상 독자: ${audience}
- 톤: ${tone}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

${variantBlock(variant)}
${SOFT_NOTE}
${referenceBlock(reference)}
${internalLinksBlock(internalLinks)}

[원본 글]
${sourceText}

결과는 아래 JSON 형식으로만 줘(다른 말 없이 JSON만):
${JSON_CONTRACT}`;
  return { system, user, resolvedType: resolved };
}

// [개편] 쿠션 글: 원본을 파생·확장해 블로거/네이버용으로. 목적지(워드프레스)로 유입.
export function buildCushionPrompt(platform, { sourceText, bloggerUrl, keyword, audience, tone, authorBio, today, imageCount, reference, variant }) {
  const resolved = resolveType("auto", keyword || "");
  const imgN = Math.min(6, Math.max(1, imageCount || 2));
  const isNaver = platform === "naver";
  const where = isNaver ? "네이버 블로그" : "블로거(Blogger)";

  // 플랫폼별 정체성/링크 전략
  const identity = isNaver
    ? `[정체성] 네이버 블로그용 **유입 쿠션 글**. 친근한 구어체, 짧은 문단, 이모지 적절히, 독자에게 말 걸듯 편하게.`
    : `[정체성] 블로거(Blogger)용 **유입 쿠션 글**. 정보성으로 읽을 가치가 있으면서, 더 자세한 목적지(워드프레스)로 유입시킨다. 링크를 여러 개 넣어 클릭 지점을 풍부하게.`;

  const linkRule = isNaver
    ? `[링크 규칙 — 네이버]
- 네이버는 '외부 블로그'로 나가는 링크에 불이익이 있다. 그러니 목적지/내 글로 나가는 링크는 **정확히 하나만** 자연스럽게 넣어라(글 흐름상 후반부 "▶ 전체 내용 자세히 보기" 하나). 목적지 유입 카드/버튼은 네가 여러 개 만들지 마라 — 상단 유입 카드는 시스템이 자동으로 1개 삽입한다.
- 대신 **공식 출처 링크(넷플릭스·유튜브·나무위키·공식 홈페이지·뉴스 등)와 원본에 있던 실제 URL은 본문에 자연스럽게 넣어라**(이건 외부 블로그가 아니라 괜찮다).`
    : `[링크 규칙 — 블로거 쿠션]
- 상단(도입부 직후)에 linkcard 1개로 클릭 유도 버튼 2~3개. 본문 곳곳에 cta도 배치해 클릭 지점을 여러 개 만들어라.
- 링크의 절반 정도는 "자세히 보기/전체 내용 보러가기"(→ 목적지=워드프레스 연결), 나머지 절반은 공식 출처(넷플릭스·유튜브·나무위키 등)나 내 다른 글(연관글)로 연결. 쿠션끼리 상호 링크 환영.
- 원본에 이미 있던 실제 링크(URL)는 관련 위치에 살려라.`;

  const system = EDITOR_SYSTEM;
  const user = `아래 '원본 글'을 바탕으로, ${where}에 올릴 글을 새로 써줘.

${identity}

[차별화 — 매우 중요]
- 원본을 복붙하지 마라. 요약·재구성하되, **이 플랫폼만의 다른 각도**로 써라. (같은 주제로 여러 플랫폼 글을 만들기 때문에 서로 내용이 겹치면 안 된다.)
- ★키워드는 네가 직접 도출: 원본 주제에서 **검색량 높을 법한 '파생 키워드'를 새로 여러 개 뽑아**, 그 중 ${isNaver ? "네이버 검색 이용자" : "정보 검색 이용자"}가 많이 칠 만한 것 위주로 소제목·문단을 구성해라. (원본에 없던 연관 정보·팁·배경·비교를 추가해 '다른 글'이 되게)
- 핵심 결론 일부는 남겨 "자세한 건 원본에서" 궁금증 유도(낚시·과장 금지).

${linkRule}
- 목적지(원본/메인) 주소: ${bloggerUrl ? bloggerUrl : `(시스템이 자동 연결하니 자세히 보기류 url은 "#"로 둬도 됨)`}
- 사실 단정 금지(모르면 두루뭉술 + 링크로 확인 유도).

${GLOBAL_RULES}
${SEO_TREND}
${HUMAN_VOICE}
[쿠션 추가 지침 — 파생 확장]
- 이 글은 '쿠션(유입)' 글이다. 목적지 글과 **다른 연관검색어·롱테일**을 새로 골라 그 각도로 써서, 목적지와 겹치지 않게 검색 표면적을 넓힌다.
- 초안(원본)에서 아직 덜 다룬 하위주제·비교·사례·최신 이슈 각도를 골라 파고들어, 같은 주제라도 '다른 검색어로 들어온 사람'을 잡는다.
${TYPE_RULES[resolved] || ""}

[작성 조건]
- 대상 독자: ${audience}
- 톤: ${tone}
- 이미지: 정확히 ${imgN}개 (썸네일 1 + 본문 ${imgN - 1})
- 오늘 날짜: ${today}
${authorBio ? `- 글 하단 저자 소개: ${authorBio}` : ""}

${variantBlock(variant)}
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

${variantBlock(variant)}
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
// [개편] 초안(원천 자료) 생성 — Claude 공식 API + 웹서치 전용.
// 목적지/쿠션 글은 웹서치 못하는 서드파티(KIE)로 만들기 때문에,
// 이 초안이 "정보 저수지" 역할을 한다: 최대한 많은 내용 + 연관/롱테일 키워드 + 실제 링크 다수.
export function buildDraftPrompt({ keyword, reference, today, audience, tone }) {
  const system = `너는 한국어 리서치 라이터다. 웹 검색 도구로 최신·정확한 정보를 직접 찾아 근거로 삼는다. 결과는 마크다운 원고로만 출력한다(코드펜스·잡담 금지).`;
  const user = `주제 "${keyword}" 에 대해 웹을 검색해서 **아주 상세한 블로그 초안(원천 자료)** 을 마크다운으로 작성해줘.
이 초안은 최종 발행용이 아니라, 이후 여러 글(목적지·쿠션)을 만들 때 쓰는 **참고용 정보 저수지**야. 그 글들은 웹검색을 못 하므로, 이 초안 안에 정보가 최대한 많이·정확히 담겨야 해.

[반드시 지킬 것]
- 웹 검색으로 최신 사실·수치·날짜·고유명사를 확인해서 반영해. 확인 안 된 건 단정하지 말고.
- 요즘 잘 나가는 구글 애드센스 정보 블로그처럼 **매우 풍부하게**: 개요/결론 요약 → 배경·맥락 → 핵심 정보 여러 섹션 → 실용 팁·주의사항 → 자주 묻는 질문(FAQ) → 관련 정보 정리.
- ★**트렌드·검색 수요 반영**: 이 주제로 지금 사람들이 실제로 많이 검색하는 각도(최신 이슈·비교·가격/방법·후기 등)를 파악해 그 수요를 채우는 섹션을 넣어줘.
- ★**연관 검색어·롱테일 키워드를 최대한 많이(15개 이상)** 스스로 도출해, 그 각각을 소제목(H2/H3)과 본문으로 실제 내용으로 다뤄줘(단순 나열 금지). 이게 뒤에 만들 목적지·쿠션 글들의 소재가 된다 — 각도가 다양할수록 좋다.
- SEO에 유리하게: 명확한 H2/H3 구조, 리스트/표, 질문형 소제목, 핵심 요약.
- ★깊이 재료: 단순 사실뿐 아니라 전문가적 해석·주의점·흔한 오해·비교·예외·실사용 팁을 함께 담아라(뒤에 만들 글이 '사람이 쓴 듯 깊이 있게' 나오도록 근거가 된다).
- ★**실제 링크를 아주 많이** 넣어줘: 공식 홈페이지·정부/기관·제조사·뉴스·통계·관련 자료 등 검색으로 찾은 **진짜 URL**을 본문 곳곳에 [표시문구](https://실제주소) 형태로. 링크는 최소 8~15개 이상, 가짜 URL 금지.
- 분량은 넉넉하게(길수록 좋음). 표·수치·구체 사례 환영.
- 자연스러운 한국어. 대상 독자: ${audience || "일반 검색 사용자"} · 톤: ${tone || "정보가 풍부하고 신뢰감 있게"} · 오늘: ${today || ""}.
${reference && reference.trim() ? `\n[추가 참고자료]\n${reference.trim()}\n` : ""}
[문서 끝에 반드시 아래 두 섹션 포함 — 다운스트림 재활용용]
## 연관 검색어·롱테일 (목적지/쿠션 소재)
- (검색어 15개 이상을 목록으로. 각 항목에 어떤 글로 풀면 좋을지 한 줄 메모)
## 참고 링크 모음
- [표시문구](실제 URL) 형태로, 본문에서 쓴 진짜 링크들을 한 번에 정리(공식 홈·뉴스·기관 등)

맨 위 첫 줄은 이 주제의 대표 제목 한 줄로 시작해줘(마크다운 # 없이 제목 텍스트만). 그 다음부터 본문.`;
  return { system, user };
}

export function buildKeywordPrompt(seed) {
  const system = "너는 한국어 SEO 키워드 리서처다. JSON만 출력한다.";
  const user = `씨앗 키워드 "${seed}" 로 애드센스 블로그에 쓸 만한 연관/롱테일 키워드를 발굴하라.
검색의도별로 분류하고, 각 키워드에 추천 글 유형과 예상 제목을 붙여라.
아래 JSON만 출력(코드펜스 금지):
{"clusters":[{"intent":"정보형|비교형|방법형|리뷰형|리스트형|이슈형","keywords":[{"keyword":"...","type":"info|howto|comparison|review|listicle|news","title":"추천 제목"}]}]}`;
  return { system, user };
}
