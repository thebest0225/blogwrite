// 지금 뜨는 트렌드 (구글 급상승 검색어, 한국) — 6시간 캐시 자동 갱신
// 무료·키 불필요. RSS 파싱.
const CACHE_KEY = "trendsCache";
const TTL = 6 * 3600 * 1000; // 6시간

export async function getTrends(force = false) {
  const r = await chrome.storage.local.get(CACHE_KEY);
  const c = r[CACHE_KEY];
  const now = Date.now();
  if (!force && c && c.items?.length && (now - c.ts) < TTL) {
    return { items: c.items, ts: c.ts, cached: true };
  }
  const items = await fetchGoogleDailyTrends();
  if (items.length) {
    await chrome.storage.local.set({ [CACHE_KEY]: { ts: now, items } });
    return { items, ts: now, cached: false };
  }
  if (c?.items?.length) return { items: c.items, ts: c.ts, cached: true, stale: true };
  return { items: [], ts: now };
}

async function fetchGoogleDailyTrends() {
  const urls = [
    "https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR",
    "https://trends.google.co.kr/trends/trendingsearches/daily/rss?geo=KR"
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const xml = await res.text();
      const doc = new DOMParser().parseFromString(xml, "text/xml");
      const items = [...doc.getElementsByTagName("item")].map((it) => {
        const g = (tag) => it.getElementsByTagName(tag)[0]?.textContent || "";
        const news = [...it.getElementsByTagName("ht:news_item_title")].map((n) => n.textContent).slice(0, 2);
        return {
          title: g("title"),
          traffic: g("ht:approx_traffic"),
          news
        };
      }).filter((x) => x.title);
      if (items.length) return items.slice(0, 20);
    } catch (e) { /* 다음 URL 시도 */ }
  }
  return [];
}
