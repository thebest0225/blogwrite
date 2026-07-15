// 네이버 데이터랩 검색어 트렌드 API
// POST https://openapi.naver.com/v1/datalab/search
// 주어진 키워드들의 상대 검색량 추이를 받아, 최근 상승세(모멘텀)로 랭킹한다.
// (데이터랩은 "지금 뜨는 키워드"를 직접 주지 않으므로, LLM이 뽑은 후보들의 추세를 비교하는 용도)

const ENDPOINT = "https://openapi.naver.com/v1/datalab/search";
const SEARCH = "https://openapi.naver.com/v1/search";

export function naverConfigured(s) {
  return !!(s?.naverClientId && s?.naverClientSecret);
}

// 네이버 검색(그라운딩용): 키워드로 실제 뉴스/블로그 결과를 긁어온다.
// kinds: news | blog | webkr | encyc
export async function naverSearch({ clientId, clientSecret, query, kinds = ["news", "blog"], perKind = 5 }) {
  const out = [];
  for (const kind of kinds) {
    try {
      const res = await fetch(`${SEARCH}/${kind}.json?query=${encodeURIComponent(query)}&display=${perKind}&sort=sim`, {
        headers: { "X-Naver-Client-Id": clientId, "X-Naver-Client-Secret": clientSecret }
      });
      if (!res.ok) continue;
      const j = await res.json();
      for (const it of j.items || []) {
        out.push({ kind, title: strip(it.title), desc: strip(it.description), link: it.link, date: it.pubDate || it.postdate || "" });
      }
    } catch { /* 개별 실패는 무시 */ }
  }
  return out;
}

function strip(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
    .replace(/\s+/g, " ").trim();
}

// keywords: string[] (최대 20개 권장). 5개씩 묶어 요청.
export async function datalabTrend({ clientId, clientSecret, keywords, startDate, endDate, timeUnit = "week" }) {
  const results = [];
  for (let i = 0; i < keywords.length; i += 5) {
    const chunk = keywords.slice(i, i + 5);
    const body = {
      startDate,
      endDate,
      timeUnit,
      keywordGroups: chunk.map((k) => ({ groupName: k, keywords: [k] }))
    };
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`데이터랩 오류(${res.status}): ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    for (const r of j.results || []) results.push(r);
  }
  return results; // [{title, keywords, data:[{period, ratio}]}]
}

// 최근 절반 평균 vs 앞 절반 평균의 변화율(%) = 모멘텀
export function momentum(series) {
  const d = series?.data || [];
  if (d.length < 2) return 0;
  const half = Math.floor(d.length / 2);
  const early = avg(d.slice(0, half).map((x) => x.ratio));
  const late = avg(d.slice(half).map((x) => x.ratio));
  if (!early) return late > 0 ? 100 : 0;
  return Math.round(((late - early) / early) * 100);
}

export function lastRatio(series) {
  const d = series?.data || [];
  return d.length ? d[d.length - 1].ratio : 0;
}

function avg(a) {
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
}
