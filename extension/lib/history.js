// 최근 작업 보관 (최대 5개, chrome.storage.local)
// 각 항목: { id, title, type, createdAt, article, html }
const KEY = "history";
const MAX = 5;

export async function getHistory() {
  const r = await chrome.storage.local.get(KEY);
  return Array.isArray(r[KEY]) ? r[KEY] : [];
}

export async function addHistory(entry) {
  const list = await getHistory();
  list.unshift(entry);
  const trimmed = list.slice(0, MAX);
  await chrome.storage.local.set({ [KEY]: trimmed });
  return trimmed;
}

export async function deleteHistory(id) {
  const list = (await getHistory()).filter((e) => e.id !== id);
  await chrome.storage.local.set({ [KEY]: list });
  return list;
}

export function newId() {
  return "h_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
}

// ---- 내 글 보관함 (이 툴로 작성/발행한 글의 제목·URL·키워드) ----
const PKEY = "myPosts";
const PMAX = 100;

export async function getMyPosts() {
  const r = await chrome.storage.local.get(PKEY);
  return Array.isArray(r[PKEY]) ? r[PKEY] : [];
}

export async function addMyPost(entry) {
  if (!entry?.url) return await getMyPosts();
  const list = (await getMyPosts()).filter((p) => p.url !== entry.url); // URL 중복 제거
  list.unshift(entry);
  const trimmed = list.slice(0, PMAX);
  await chrome.storage.local.set({ [PKEY]: trimmed });
  return trimmed;
}

export async function deleteMyPost(url) {
  const list = (await getMyPosts()).filter((p) => p.url !== url);
  await chrome.storage.local.set({ [PKEY]: list });
  return list;
}

// 키워드와 관련 있는 내 글 찾기
export function matchMyPosts(list, keyword) {
  const k = (keyword || "").toLowerCase().trim();
  if (!k) return [];
  const words = k.split(/\s+/).filter((w) => w.length > 1);
  return list
    .map((p) => {
      const hay = ((p.title || "") + " " + (p.keyword || "")).toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((x) => ({ title: x.p.title, link: x.p.url }));
}
