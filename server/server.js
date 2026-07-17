// 블로그 오토라이터 — 서버 백엔드 (Express)
// 역할: 브라우저 웹앱(public/)을 제공 + KIE/네이버/구글트렌드/워드프레스 API 프록시 + 기록 저장
// 프론트가 CORS 없이 same-origin(/api/*)으로 호출 → API 키는 서버(.env)에만 존재
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as DB from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "8mb" }));

// oguonline.com 등 별도 도메인: MangoHub 세션 쿠키(.mangois.love) 공유 불가 →
// 기본은 인증되는 write.mangois.love 로 연결(리다이렉트). (환경변수로 끌 수 있음)
const ALIAS_REDIRECT = process.env.ALIAS_REDIRECT !== "0";
const ALIAS_HOSTS = new Set(["oguonline.com", "www.oguonline.com"]);
const CANONICAL = process.env.CANONICAL_URL || "https://write.mangois.love";
app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0].toLowerCase();
  if (ALIAS_REDIRECT && ALIAS_HOSTS.has(host)) return res.redirect(302, CANONICAL + req.originalUrl);
  next();
});

// ---- MangoHub SSO 인증 (세션 쿠키는 .mangois.love 공유) + user_id 확보(멀티테넌시) ----
const MANGOHUB_ME = process.env.MANGOHUB_ME || "http://localhost:8000/api/auth/me";
const LOGIN_URL = process.env.LOGIN_URL || "https://mangois.love/";
const PUBLIC_PATHS = new Set(["/styles.css", "/app.js", "/favicon.ico", "/health"]);
const _userCache = new Map(); // session_token → {id, ts}
async function resolveUser(req) {
  const cookie = req.headers.cookie || "";
  const m = cookie.match(/session_token=([^;]+)/);
  if (!m) return null;
  const tok = m[1];
  const c = _userCache.get(tok);
  if (c && Date.now() - c.ts < 60000) return c.id;
  try {
    const r = await fetch(MANGOHUB_ME, { headers: { Cookie: cookie } });
    if (!r.ok) return null;
    const u = await r.json();
    if (u && u.id && u.status === "active") { _userCache.set(tok, { id: u.id, ts: Date.now() }); return u.id; }
  } catch {}
  return null;
}
app.get("/health", (req, res) => res.json({ ok: true }));
app.use(async (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith("/lib/")) return next();
  const userId = await resolveUser(req);
  if (userId) { req.userId = userId; return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "MangoHub 로그인이 필요합니다.", login: LOGIN_URL });
  return res.redirect(302, LOGIN_URL);
});

app.use(express.static(path.join(__dirname, "public")));

const KIE = process.env.KIE_API_KEY;
const CHAT_MODEL = process.env.KIE_CHAT_MODEL || "claude-sonnet-5";
const IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-text-to-image";
const NAVER_ID = process.env.NAVER_CLIENT_ID, NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const WP_SITE = process.env.WP_SITE, WP_USER = process.env.WP_USER, WP_PASS = process.env.WP_APP_PASSWORD;
const KIE_BASE = "https://api.kie.ai";
// Claude 공식 API (웹서치 지원) — 글 생성용
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const DEFAULT_ENGINE = process.env.GEN_ENGINE || (ANTHROPIC_KEY ? "claude" : "kie");
const STORE = path.join(__dirname, "records.json");
const DRAFTS = path.join(__dirname, "drafts.json");   // MCP로 받은 초안함 (MCP 서버와 공유)

const loadStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return []; } };
const saveStore = (a) => fs.writeFileSync(STORE, JSON.stringify(a));
const loadDrafts = () => { try { return JSON.parse(fs.readFileSync(DRAFTS, "utf8")); } catch { return []; } };
const saveDrafts = (a) => fs.writeFileSync(DRAFTS, JSON.stringify(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kieHeaders = (key) => ({ Authorization: `Bearer ${key || KIE}`, "Content-Type": "application/json" });

// ---- 글 생성 (KIE Claude) ----
async function kieChat({ system, user, maxTokens, temperature, model, prefillJson, apiKey }) {
  const messages = [{ role: "user", content: user }];
  // JSON 강제: 어시스턴트 응답을 "{" 로 시작하게 프리필 → 서두(거부성 멘트) 원천 차단
  if (prefillJson) messages.push({ role: "assistant", content: "{" });
  const r = await fetch(`${KIE_BASE}/claude/v1/messages`, {
    method: "POST", headers: kieHeaders(apiKey),
    body: JSON.stringify({ model: model || CHAT_MODEL, system, messages, max_tokens: maxTokens, temperature, stream: false })
  });
  const t = await r.text();
  // KIE 게이트웨이(Cloudflare) 에러 페이지/비정상 응답 감지 → 재시도 대상
  if (!r.ok || /^\s*<(?:!doctype|html)/i.test(t)) {
    throw new Error(`KIE 게이트웨이 오류(${r.status})`);
  }
  let j; try { j = JSON.parse(t); } catch { throw new Error("KIE 응답 형식 오류"); }
  const data = j.data && (j.data.content || j.data.choices) ? j.data : j;
  let content = Array.isArray(data.content) ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
  if (!content) content = data?.choices?.[0]?.message?.content || "";
  // 게이트웨이 에러 HTML이 정상 JSON의 content 안에 담겨오는 경우도 실패로 처리 → 재시도
  if (/^\s*<(?:!doctype|html)|no-js ie6 oldie/i.test(content)) throw new Error("KIE 게이트웨이 오류(본문 HTML)");
  if (prefillJson && content) { content = content.replace(/^\s*/, ""); if (!content.startsWith("{")) content = "{" + content; }
  return content;
}
// ---- 글 생성 (Claude 공식 API, 웹서치 O) ----
async function anthropicChat({ system, user, maxTokens = 16000, model, webSearch = true, apiKey }) {
  const body = { model: model || ANTHROPIC_MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] };
  if (webSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey || ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${t.slice(0, 180)}`);
  let j; try { j = JSON.parse(t); } catch { throw new Error("Anthropic 응답 형식 오류"); }
  const content = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  if (!content.trim()) throw new Error("Anthropic 빈 응답");
  return content;
}

app.post("/api/chat", async (req, res) => {
  const { system, user, maxTokens = 16000, temperature = 0.8, model, prefillJson = true, engine } = req.body;
  const aKey = DB.getSecret(req.userId, "anthropicKey") || ANTHROPIC_KEY;
  const kKey = DB.getSecret(req.userId, "kieKey") || KIE;
  const useClaude = (engine === "claude" || (!engine && DEFAULT_ENGINE === "claude")) && !!aKey;
  let content = "", lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1200);
    try {
      content = useClaude
        ? await anthropicChat({ system, user, maxTokens, webSearch: true, apiKey: aKey })
        : await kieChat({ system, user, maxTokens, temperature, model, prefillJson, apiKey: kKey });
      if (content && content.trim()) break;
      lastErr = new Error("빈 응답");
    } catch (e) {
      lastErr = e;
      if (useClaude && attempt === 1) { try { content = await kieChat({ system, user, maxTokens, temperature, model, prefillJson, apiKey: kKey }); if (content && content.trim()) break; } catch (e2) { lastErr = e2; } }
    }
  }
  if (content && content.trim()) return res.json({ content });
  res.status(502).json({ error: "AI 응답 실패(잠시 후 다시 시도해 주세요). " + (lastErr ? String(lastErr.message || lastErr).slice(0, 120) : "") });
});

// ---- 이미지 (KIE jobs) ----
// 게이트웨이 HTML/비정상 응답 방어 후 JSON 파싱
async function kieSafeJson(r) {
  const t = await r.text();
  if (!r.ok || /^\s*<(?:!doctype|html)|no-js ie6 oldie/i.test(t)) throw new Error(`KIE 게이트웨이 오류(${r.status})`);
  try { return JSON.parse(t); } catch { throw new Error("KIE 응답 형식 오류"); }
}
async function runImageJob(model, input, apiKey) {
  const g = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, { method: "POST", headers: kieHeaders(apiKey), body: JSON.stringify({ model, input }) });
  const gj = await kieSafeJson(g);
  if (gj.code !== 200) throw new Error(gj.msg || "createTask 실패");
  const id = gj.data.taskId;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const inf = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`, { headers: kieHeaders(apiKey) });
    let d; try { d = (await kieSafeJson(inf)).data; } catch { continue; }
    if (!d) continue;
    if (d.state === "success") { let u = []; try { u = JSON.parse(d.resultJson || "{}").resultUrls || []; } catch {} if (u[0]) return u[0]; throw new Error("결과 URL 없음"); }
    if (d.state === "fail") throw new Error(d.failMsg || "이미지 실패");
  }
  throw new Error("이미지 시간초과");
}
app.post("/api/image", async (req, res) => {
  try { const kKey = DB.getSecret(req.userId, "kieKey") || KIE; const { prompt, aspect = "4:3", resolution = "1K" } = req.body; res.json({ url: await runImageJob(IMAGE_MODEL, { prompt, aspect_ratio: aspect, resolution }, kKey) }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post("/api/image-edit", async (req, res) => {
  try { const kKey = DB.getSecret(req.userId, "kieKey") || KIE; const { imageUrl, prompt, aspect = "4:3", resolution = "1K" } = req.body; res.json({ url: await runImageJob("gpt-image-2-image-to-image", { prompt, input_urls: [imageUrl], aspect_ratio: aspect, resolution }, kKey) }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 키워드 확장 (구글+네이버 자동완성) ----
app.get("/api/keywords", async (req, res) => {
  const seed = (req.query.seed || "").trim();
  if (!seed) return res.json({ keywords: [] });
  const mods = ["", "추천", "방법", "후기", "비교", "순위", "뜻", "이유", "단점", "실시간", "정리", "총정리", "2026"];
  const qs = [...new Set(mods.map((m) => (m ? `${seed} ${m}` : seed)))];
  const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "application/json,*/*" };
  // 깨진(모지바케) 결과 필터: 대체문자/고립 자모 포함 시 제외
  const isClean = (s) => typeof s === "string" && s.length > 1 && !/[�ᄀ-ᇿ㄰-㆏]/.test(s);
  const found = new Set();
  await Promise.all(qs.map(async (q) => {
    try { const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr&q=${encodeURIComponent(q)}`, { headers: UA }); (JSON.parse(await r.text())[1] || []).forEach((k) => { if (isClean(k)) found.add(k); }); } catch {}
    try {
      const r = await fetch(`https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(q)}&st=100&r_format=json&r_enc=UTF-8&r_unicode=0&ans=2`, { headers: UA });
      const buf = new Uint8Array(await r.arrayBuffer());
      const txt = new TextDecoder("utf-8").decode(buf);
      ((JSON.parse(txt).items?.[0]) || []).forEach((row) => { const k = Array.isArray(row) ? row[0] : row; if (isClean(k)) found.add(k); });
    } catch {}
  }));
  res.json({ keywords: [...found].filter(Boolean).slice(0, 60) });
});

// ---- 트렌드 (구글 급상승 신 엔드포인트 + signal.bz 실검, 1h 캐시) ----
let trendCache = null;
const unescapeXml = (s) => (s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").trim();
const pick = (block, tag) => { const m = block.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">")); return m ? unescapeXml(m[1]) : ""; };

async function fetchGoogleTrends() {
  for (const url of ["https://trends.google.com/trending/rss?geo=KR", "https://trends.google.co.kr/trending/rss?geo=KR"]) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } }); if (!r.ok) continue;
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
        const b = m[1];
        const title = pick(b, "title");
        const news = b.match(/<ht:news_item>([\s\S]*?)<\/ht:news_item>/);
        return {
          title,
          traffic: pick(b, "ht:approx_traffic"),
          picture: pick(b, "ht:picture"),
          newsTitle: news ? pick(news[1], "ht:news_item_title") : "",
          newsUrl: news ? pick(news[1], "ht:news_item_url") : "",
          newsSource: news ? pick(news[1], "ht:news_item_source") : "",
          source: "google",
        };
      }).filter((x) => x.title);
      if (items.length) return items;
    } catch {}
  }
  return [];
}
async function fetchSignalTrends() {
  try {
    const r = await fetch("https://api.signal.bz/news/realtime", { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://signal.bz/" } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.top10 || []).map((t) => ({ title: t.keyword, traffic: "", state: t.state, source: "signal" })).filter((x) => x.title);
  } catch { return []; }
}
app.get("/api/trends", async (req, res) => {
  try {
    if (!req.query.force && trendCache && Date.now() - trendCache.ts < 3600 * 1000) return res.json(trendCache);
    const [google, signal] = await Promise.all([fetchGoogleTrends(), fetchSignalTrends()]);
    // 병합 + 중복제거(제목 기준). 구글(뉴스맥락 있음) 우선, 그 다음 실검 키워드.
    const seen = new Set(); const merged = [];
    for (const it of [...google, ...signal]) {
      const key = it.title.replace(/\s+/g, "").toLowerCase();
      if (seen.has(key)) continue; seen.add(key); merged.push(it);
    }
    const src = google.length && signal.length ? "google+signal" : (google.length ? "google" : (signal.length ? "signal" : "none"));
    trendCache = { ts: Date.now(), source: src, items: merged.slice(0, 24) };
    res.json(trendCache);
  } catch (e) { res.json({ ts: Date.now(), source: "none", items: [] }); }
});

// ---- 네이버 검색 (선택, 링크 그라운딩) — 사용자별 키 ----
app.get("/api/naver-search", async (req, res) => {
  const nid = DB.getSecret(req.userId, "naverClientId") || NAVER_ID;
  const nsec = DB.getSecret(req.userId, "naverClientSecret") || NAVER_SECRET;
  if (!nid) return res.json({ items: [] });
  try {
    const q = req.query.q || ""; const out = [];
    for (const kind of ["webkr", "news", "blog"]) {
      const r = await fetch(`https://openapi.naver.com/v1/search/${kind}.json?query=${encodeURIComponent(q)}&display=4`, { headers: { "X-Naver-Client-Id": nid, "X-Naver-Client-Secret": nsec } });
      if (!r.ok) continue; const j = await r.json();
      for (const it of j.items || []) out.push({ kind, title: (it.title || "").replace(/<[^>]+>/g, ""), link: it.link });
    }
    res.json({ items: out });
  } catch { res.json({ items: [] }); }
});

// ---- 워드프레스 발행 (사용자별 목적지 자격 / .env 폴백) ----
function resolveWp(userId, destId) {
  const dests = DB.listDestinations(userId);
  let pick = destId ? dests.find((d) => d.id === destId) : (dests.find((d) => d.platform === "wordpress" && d.is_default) || dests.find((d) => d.platform === "wordpress"));
  if (pick) { const full = DB.getDestination(userId, pick.id); if (full && full.platform === "wordpress") return { site: full.site_url, user: full.creds?.user, pass: full.creds?.appPassword }; }
  if (WP_SITE) return { site: WP_SITE, user: WP_USER, pass: WP_PASS };
  return null;
}
app.post("/api/wp", async (req, res) => {
  const wp = resolveWp(req.userId, req.body?.destinationId);
  if (!wp || !wp.site) return res.status(400).json({ error: "워드프레스 목적지가 설정되지 않았습니다(목적지 관리에서 등록)." });
  try {
    const { title, content, status = "draft" } = req.body;
    const auth = "Basic " + Buffer.from(`${wp.user}:${wp.pass}`).toString("base64");
    const r = await fetch(`${wp.site.replace(/\/+$/, "")}/wp-json/wp/v2/posts`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ title, content, status }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status);
    res.json({ id: j.id, link: j.link });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 블로거 OAuth (Google) + 자동발행 ----
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID, GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT = process.env.GOOGLE_REDIRECT || (CANONICAL + "/api/oauth/blogger/callback");
const normUrl = (u) => (u || "").replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();

app.get("/api/oauth/blogger/start", (req, res) => {
  if (!GOOGLE_ID) return res.status(400).send("Google OAuth 미설정(.env 확인)");
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: GOOGLE_ID, redirect_uri: GOOGLE_REDIRECT, response_type: "code",
    scope: "https://www.googleapis.com/auth/blogger", access_type: "offline", prompt: "consent",
    state: String(req.query.dest || "")
  });
  res.redirect(url);
});

app.get("/api/oauth/blogger/callback", async (req, res) => {
  const code = req.query.code, destId = req.query.state;
  if (!code) return res.redirect(CANONICAL + "/?blogger=error#accounts");
  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, redirect_uri: GOOGLE_REDIRECT, grant_type: "authorization_code" }) });
    const tj = await tr.json();
    if (!tr.ok || !tj.refresh_token) throw new Error(tj.error_description || "토큰 교환 실패(재동의 필요할 수 있음)");
    const access = tj.access_token;
    const dest = destId ? DB.getDestination(req.userId, destId) : null;
    let blogId = "", blogUrl = "";
    try {
      const br = await fetch("https://www.googleapis.com/blogger/v3/users/self/blogs", { headers: { Authorization: "Bearer " + access } });
      const bj = await br.json(); const blogs = bj.items || [];
      if (dest && dest.site_url) { const m = blogs.find((b) => normUrl(b.url) === normUrl(dest.site_url)); if (m) { blogId = m.id; blogUrl = m.url; } }
      if (!blogId && blogs[0]) { blogId = blogs[0].id; blogUrl = blogs[0].url; }
    } catch {}
    if (dest) {
      DB.upsertDestination(req.userId, { id: dest.id, name: dest.name, platform: dest.platform, role: dest.role, site_url: dest.site_url || blogUrl, is_default: dest.is_default, creds: { refreshToken: tj.refresh_token, blogId, blogUrl } });
    }
    res.redirect(CANONICAL + "/?blogger=ok#accounts");
  } catch (e) {
    res.redirect(CANONICAL + "/?blogger=error&msg=" + encodeURIComponent(String(e.message || e).slice(0, 120)) + "#accounts");
  }
});

async function bloggerAccessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ refresh_token: refreshToken, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, grant_type: "refresh_token" }) });
  const j = await r.json(); if (!r.ok || !j.access_token) throw new Error(j.error_description || "액세스 토큰 갱신 실패");
  return j.access_token;
}
app.post("/api/blogger", async (req, res) => {
  const { destinationId, title, content, isDraft } = req.body || {};
  const dest = destinationId ? DB.getDestination(req.userId, destinationId) : null;
  if (!dest || dest.platform !== "blogger") return res.status(400).json({ error: "블로거 계정이 아닙니다." });
  const rt = dest.creds?.refreshToken, blogId = dest.creds?.blogId;
  if (!rt || !blogId) return res.status(400).json({ error: "이 블로거 계정은 아직 '구글 연결'이 안 됐습니다." });
  try {
    const access = await bloggerAccessToken(rt);
    const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${isDraft ? "?isDraft=true" : ""}`, { method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" }, body: JSON.stringify({ title, content }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status);
    res.json({ id: j.id, link: j.url });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

// ---- 발행 자산(보관함) — /api/store 호환 shim (assets) ----
app.get("/api/store", (req, res) => res.json({ records: DB.listAssets(req.userId).map((a) => ({ type: "post", url: a.url, title: a.title, keyword: a.keyword, date: a.date })) }));
app.post("/api/store", (req, res) => { const b = req.body || {}; if (b.type === "post" && b.url) DB.addAsset(req.userId, { url: b.url, title: b.title, keyword: b.keyword, excerpt: b.body }); res.json({ ok: true }); });
app.post("/api/store/delete", (req, res) => { if (req.body?.url) DB.deleteAsset(req.userId, req.body.url); res.json({ ok: true }); });

// ---- 초안함 (검색·페이지네이션) ----
app.get("/api/drafts", (req, res) => res.json(DB.listDraftsPage(req.userId, { q: req.query.q || "", status: req.query.status || "", offset: parseInt(req.query.offset, 10) || 0, limit: parseInt(req.query.limit, 10) || 50 })));
app.get("/api/drafts/:id", (req, res) => { const d = DB.getDraft(req.userId, req.params.id); d ? res.json(d) : res.status(404).json({ error: "not found" }); });
app.post("/api/drafts", (req, res) => res.json({ ok: true, draft: DB.addDraft(req.userId, req.body || {}) }));
app.post("/api/drafts/delete", (req, res) => { if (req.body?.id) DB.deleteDraft(req.userId, req.body.id); res.json({ ok: true }); });
app.post("/api/drafts/status", (req, res) => { if (req.body?.id) DB.setDraftStatus(req.userId, req.body.id, req.body.status); res.json({ ok: true }); });

// ---- 자동화 예약 ----
app.get("/api/schedules", (req, res) => res.json({ schedules: DB.listSchedules(req.userId) }));
app.post("/api/schedules", (req, res) => res.json({ ok: true, schedules: DB.upsertSchedule(req.userId, req.body || {}) }));
app.post("/api/schedules/delete", (req, res) => res.json({ ok: true, schedules: DB.deleteSchedule(req.userId, req.body?.id) }));

// ---- 목적지 관리 ----
app.get("/api/destinations", (req, res) => res.json({ destinations: DB.listDestinations(req.userId) }));
app.post("/api/destinations", (req, res) => res.json({ ok: true, destinations: DB.upsertDestination(req.userId, req.body || {}) }));
app.post("/api/destinations/delete", (req, res) => res.json({ ok: true, destinations: DB.deleteDestination(req.userId, req.body?.id) }));

// ---- 작업 항목(칸반) ----
app.get("/api/work", (req, res) => res.json({ items: DB.listWorkItems(req.userId, req.query.status) }));
app.get("/api/work/:id", (req, res) => { const w = DB.getWorkItem(req.userId, req.params.id); w ? res.json(w) : res.status(404).json({ error: "not found" }); });
app.post("/api/work", (req, res) => res.json({ ok: true, id: DB.upsertWorkItem(req.userId, req.body || {}) }));
app.post("/api/work/delete", (req, res) => { if (req.body?.id) DB.deleteWorkItem(req.userId, req.body.id); res.json({ ok: true }); });

// ---- 설정 (사용자별, 민감키 암호화) ----
const SETTINGS_DEFAULTS = {
  genEngine: "claude", kieChatModel: "claude-sonnet-5", imageResolution: "1K",
  thumbnailMode: "ai_full", thumbnailStylePrompt: "", overlayAccent: "#ff2d55",
  linkMode: "search", myBlogUrl: "", defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자", authorBio: "",
  adEnabled: false, adCode: "", internalLinks: false, generateImages: true, imageCount: 1
};
app.get("/api/settings", (req, res) => res.json({ ...SETTINGS_DEFAULTS, ...DB.getSettings(req.userId) }));
app.post("/api/settings", (req, res) => res.json({ ok: true, settings: { ...SETTINGS_DEFAULTS, ...DB.saveSettings(req.userId, req.body || {}) } }));

// ---- 프론트용 상태(사용자별) ----
app.get("/api/config", (req, res) => {
  const s = DB.getSettingsRaw(req.userId);
  res.json({
    kieEnabled: !!s.kieKey || !!KIE,
    claudeEnabled: !!s.anthropicKey || !!ANTHROPIC_KEY,
    wpEnabled: DB.listDestinations(req.userId).some((d) => d.platform === "wordpress") || !!WP_SITE,
    naverEnabled: !!s.naverClientId || !!NAVER_ID,
    googleOAuth: !!GOOGLE_ID,
    defaultEngine: s.genEngine || DEFAULT_ENGINE,
    newDrafts: DB.countNewDrafts(req.userId)
  });
});
// 생성 대상 계정 목록(계정마다 각각 다른 글 생성)
app.get("/api/accounts", (req, res) => res.json({ accounts: DB.accountsForGeneration(req.userId) }));
// 발행 자산(목적지 선택용: url+title+excerpt)
app.get("/api/assets", (req, res) => res.json({ assets: DB.listAssets(req.userId) }));

// ---- 기존 JSON → SQLite 1회 이관 (user 1) + .env WP를 기본 목적지로 ----
function migrateOnce() {
  const flag = path.join(__dirname, ".migrated_v2");
  if (fs.existsSync(flag)) return;
  try {
    const U = 1;
    // settings.json → user 1 설정
    try { const s = JSON.parse(fs.readFileSync(path.join(__dirname, "settings.json"), "utf8")); DB.saveSettings(U, s); } catch {}
    // drafts.json → drafts
    try { for (const d of JSON.parse(fs.readFileSync(DRAFTS, "utf8"))) DB.addDraft(U, d); } catch {}
    // records.json (type post) → assets
    try { for (const r of JSON.parse(fs.readFileSync(STORE, "utf8"))) if (r.type === "post" && r.url) DB.addAsset(U, { url: r.url, title: r.title, keyword: r.keyword, excerpt: r.body }); } catch {}
    // .env WP → 기본 목적지
    if (WP_SITE && !DB.listDestinations(U).length) DB.upsertDestination(U, { name: "기본 워드프레스", platform: "wordpress", site_url: WP_SITE, creds: { user: WP_USER, appPassword: WP_PASS }, is_default: true });
    fs.writeFileSync(flag, new Date().toISOString());
    console.log("[migrate] JSON→SQLite 이관 완료(user 1)");
  } catch (e) { console.warn("[migrate] 실패:", e.message); }
}
migrateOnce();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`블로그 오토라이터 서버: http://localhost:${PORT}`));
