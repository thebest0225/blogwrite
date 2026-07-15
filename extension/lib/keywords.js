// 실제 검색 자동완성 기반 키워드 발굴 엔진 (무료, 키 불필요)
// - 구글 자동완성: https://suggestqueries.google.com/complete/search?client=firefox
// - 네이버 자동완성: https://ac.search.naver.com/nx/ac
// 씨앗 키워드 + 의도 수식어를 조합해 롱테일을 대량 수집 → 중복 제거 → 의도별 분류.

// 의도가 드러나는 수식어 (롱테일 확장용)
const MODIFIERS = [
  "", "추천", "방법", "후기", "가격", "비교", "순위", "뜻",
  "이유", "단점", "효과", "종류", "실시간", "정리", "총정리", "2026"
];

export async function expandKeywords(seed) {
  const s = (seed || "").trim();
  if (!s) return { total: 0, groups: {}, flat: [] };

  const queries = Array.from(new Set(MODIFIERS.map((m) => (m ? `${s} ${m}` : s))));
  const found = new Map(); // keyword -> Set(sources)

  await Promise.all(queries.map(async (q) => {
    const [g, n] = await Promise.all([googleSuggest(q), naverSuggest(q)]);
    for (const k of g) addKw(found, k, "G");
    for (const k of n) addKw(found, k, "N");
  }));

  // 정리: 씨앗과 동일/무의미 제거, 씨앗 토큰 관련성 우선
  const seedLc = s.toLowerCase().replace(/\s+/g, "");
  let list = [...found.entries()]
    .map(([k, src]) => ({ keyword: k, sources: [...src] }))
    .filter((x) => x.keyword && x.keyword.length >= 2 && x.keyword.toLowerCase() !== s.toLowerCase());

  // 관련성: 씨앗 단어(공백 제거)를 포함하면 가점
  list.sort((a, b) => rel(b, seedLc) - rel(a, seedLc));
  list = list.slice(0, 120);

  // 의도별 그룹
  const groups = {};
  for (const item of list) {
    const t = classify(item.keyword);
    (groups[t] ||= []).push(item);
  }
  // 그룹별 상한
  for (const k of Object.keys(groups)) groups[k] = groups[k].slice(0, 25);

  return { total: list.length, groups, flat: list };
}

function rel(item, seedLc) {
  const k = item.keyword.toLowerCase().replace(/\s+/g, "");
  let score = item.sources.length; // 두 엔진 모두면 +
  if (k.includes(seedLc)) score += 3;
  return score;
}

function addKw(map, kw, src) {
  const k = (kw || "").trim();
  if (!k) return;
  if (!map.has(k)) map.set(k, new Set());
  map.get(k).add(src);
}

// 의도 분류 (prompts.js의 유형 키와 동일)
export function classify(k) {
  if (/vs|비교|차이|어떤|대신|다른점/.test(k)) return "comparison";
  if (/추천|best|top|순위|모음|[0-9]+가지|[0-9]+선|리스트/.test(k)) return "listicle";
  if (/방법|하는\s?법|하는법|설정|등록|신청|만들기|설치|사용법/.test(k)) return "howto";
  if (/후기|리뷰|사용기|내돈내산|실사용|평가/.test(k)) return "review";
  if (/논란|근황|실시간|사건|이슈|사망|출연|디시|공개|확정/.test(k)) return "news";
  if (/뜻|이란|란$|의미|원리|개념|정의/.test(k)) return "info";
  return "info";
}

// ---- 구글 자동완성 ----
async function googleSuggest(q) {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    return Array.isArray(data?.[1]) ? data[1] : [];
  } catch { return []; }
}

// ---- 네이버 자동완성 ----
async function naverSuggest(q) {
  try {
    const url = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(q)}&st=100&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&frm=nv&ans=2`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    const items = data?.items?.[0] || [];
    return items.map((row) => (Array.isArray(row) ? row[0] : row)).filter(Boolean);
  } catch { return []; }
}
