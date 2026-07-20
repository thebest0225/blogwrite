// 블로그 오토라이터 — 서버 백엔드 (Express)
// 역할: 브라우저 웹앱(public/)을 제공 + KIE/네이버/구글트렌드/워드프레스 API 프록시 + 기록 저장
// 프론트가 CORS 없이 same-origin(/api/*)으로 호출 → API 키는 서버(.env)에만 존재
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as DB from "./db.js";
import { tgMsg, tgEsc } from "./notify.js";
import { buildDraftPrompt, buildBloggerMain } from "./public/lib/prompts.js";
import { buildHtml } from "./public/lib/html-builder.js";

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

async function runChat(userId, p) {
  const { system, user, maxTokens = 16000, temperature = 0.8, model, prefillJson = true, engine } = p || {};
  const aKey = DB.getSecret(userId, "anthropicKey") || ANTHROPIC_KEY;
  const kKey = DB.getSecret(userId, "kieKey") || KIE;
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
  if (content && content.trim()) return content;
  throw new Error("AI 응답 실패(잠시 후 다시). " + (lastErr ? String(lastErr.message || lastErr).slice(0, 120) : ""));
}
// 동기 버전(짧은 호출용, 하위호환)
app.post("/api/chat", async (req, res) => {
  try { res.json({ content: await runChat(req.userId, req.body || {}) }); }
  catch (e) { res.status(502).json({ error: String(e.message || e) }); }
});
// 백그라운드 버전(긴 생성 — 터널 타임아웃 회피): start + status 폴링
const chatJobs = new Map();
app.post("/api/chat/start", (req, res) => {
  const id = "cj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const userId = req.userId, body = req.body || {};
  chatJobs.set(id, { status: "pending", ts: Date.now(), userId });
  (async () => {
    try { const content = await runChat(userId, body); const j = chatJobs.get(id); if (j) { j.status = "done"; j.content = content; j.ts = Date.now(); } }
    catch (e) { const j = chatJobs.get(id); if (j) { j.status = "error"; j.error = String(e.message || e).slice(0, 200); j.ts = Date.now(); } }
  })();
  res.json({ jobId: id });
});
app.get("/api/chat/status", (req, res) => {
  const j = chatJobs.get(req.query.id);
  if (!j || j.userId !== req.userId) return res.status(404).json({ error: "작업 없음" });
  const out = { status: j.status, content: j.content || "", error: j.error || "" };
  if (j.status !== "pending" && Date.now() - j.ts > 300000) chatJobs.delete(req.query.id);
  res.json(out);
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
// 서버(자동·예약 발행)용 이미지 생성 — 썸네일(ai_full: 한글 헤드라인 포함) + 본문 1장까지
const SERVER_THUMB = "Premium eye-catching Korean thumbnail, cinematic high-contrast dramatic lighting, one clear focal subject that POPS (glow/rim light, shallow DOF). If a real person is central, photorealistic dramatic portrait with emotion; product → hero shot; concept → striking symbolic scene. Clean, punchy, NOT busy. NO clip-art graphs/arrows/flags, NO random extra people.";
async function genArticleImagesServer(article, kKey, thumbStyleOv, opts = {}) {
  if (!kKey) return;
  const thumbAspect = opts.thumbAspect || "16:9";
  const bodyAspect = opts.bodyAspect || "4:3";
  let resolution = opts.resolution || "1K";
  const imgs = (article.blocks || []).filter((b) => b.type === "image" && !b.resolvedUrl).slice(0, 2);
  for (const b of imgs) {
    const isThumb = b.slot === "thumbnail";
    const headline = (b.overlayText || article.title || article.keyword || "").slice(0, 40);
    let prompt = b.prompt || b.alt || article.keyword || "";
    let aspect = isThumb ? thumbAspect : bodyAspect;
    const [aw, ah] = aspect.split(":").map(Number);
    const res = (resolution === "4K" && aw === ah) ? "2K" : resolution;   // 정사각 4K는 미지원 → 2K
    if (isThumb) { prompt = `${thumbStyleOv || SERVER_THUMB}\n\nScene: ${b.prompt || article.keyword || ""}\n\n상단 영역에 큰 한글 헤드라인을 정확한 맞춤법으로 크게: "${headline}". 하단 1/3은 비워둔다. 작은 모바일 썸네일에서도 읽히게. 클립아트·깨진 글자 금지.`; }
    try { b.resolvedUrl = await runImageJob(IMAGE_MODEL, { prompt, aspect_ratio: aspect, resolution: res }, kKey); } catch (e) { /* 실패한 이미지는 건너뜀 */ }
  }
  // 여전히 URL 없는 이미지 블록은 제거(빈 자리표시 방지)
  article.blocks = (article.blocks || []).filter((b) => b.type !== "image" || b.resolvedUrl);
}
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

// ---- Pexels 스톡 사진 검색(글 보강용) ----
const PEXELS = process.env.PEXELS_API_KEY;
app.get("/api/stock-photos", async (req, res) => {
  const key = DB.getSecret(req.userId, "pexelsKey") || PEXELS;
  if (!key) return res.json({ photos: [] });
  const q = (req.query.q || "").toString().trim(); const n = Math.min(10, parseInt(req.query.n, 10) || 3);
  if (!q) return res.json({ photos: [] });
  try {
    const r = await fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&per_page=${n}&orientation=landscape`, { headers: { Authorization: key } });
    if (!r.ok) return res.json({ photos: [] });
    const j = await r.json();
    const photos = (j.photos || []).map((p) => ({ url: p.src?.large || p.src?.medium || p.src?.original, page: p.url, photographer: p.photographer, alt: p.alt || q }));
    res.json({ photos });
  } catch { res.json({ photos: [] }); }
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
// 사이트 주소 정규화: 스킴 없으면 https:// 붙이고 끝 슬래시 제거
const normSite = (u) => { let s = String(u || "").trim().replace(/\/+$/, ""); if (s && !/^https?:\/\//i.test(s)) s = "https://" + s; return s; };
function resolveWp(userId, destId) {
  const dests = DB.listDestinations(userId);
  let pick = destId ? dests.find((d) => d.id === destId) : (dests.find((d) => d.platform === "wordpress" && d.is_default) || dests.find((d) => d.platform === "wordpress"));
  if (pick) { const full = DB.getDestination(userId, pick.id); if (full && full.platform === "wordpress") return { site: normSite(full.site_url), user: full.creds?.user, pass: full.creds?.appPassword }; }
  if (WP_SITE) return { site: normSite(WP_SITE), user: WP_USER, pass: WP_PASS };
  return null;
}
// 카테고리 이름 → term id (없으면 생성). WP 발행 시 자동 분류.
async function wpResolveCategory(site, auth, name) {
  if (!name || !String(name).trim()) return null; name = String(name).trim();
  try {
    const r = await fetch(`${site}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=30`, { headers: { Authorization: auth } });
    if (r.ok) { const arr = await r.json(); const hit = (arr || []).find((c) => c.name === name); if (hit) return hit.id; }
    const cr = await fetch(`${site}/wp-json/wp/v2/categories`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const cj = await cr.json().catch(() => ({}));
    if (cr.ok && cj.id) return cj.id;
    if (cj?.data?.term_id) return cj.data.term_id;
  } catch {}
  return null;
}
// 오구 서브사이트는 앱비번 계정(오구온지기/oguadmin)이 아니라 니치 필자 계정으로 저자 표기
const OGU_AUTHORS = { benefit: 10, ott: 11, money: 12, pet: 13, apptip: 14, soft: 15, trend: 16, mango: 2 };
function oguAuthorFor(site) {
  const m = String(site || "").match(/^https?:\/\/([a-z0-9]+)\.oguonline\.com/i);
  return m && OGU_AUTHORS[m[1]] ? OGU_AUTHORS[m[1]] : null;
}

app.post("/api/wp", async (req, res) => {
  const wp = resolveWp(req.userId, req.body?.destinationId);
  if (!wp || !wp.site) return res.status(400).json({ error: "워드프레스 목적지가 설정되지 않았습니다(계정 관리에서 등록)." });
  if (!wp.user || !wp.pass) return res.status(400).json({ error: "이 워드프레스 계정에 사용자명/응용프로그램 비밀번호가 없습니다(계정 관리에서 입력)." });
  try {
    const { title, content, status = "draft", category, postUrl } = req.body;   // postId/postUrl 있으면 수정발행
    let { postId } = req.body;
    const auth = "Basic " + Buffer.from(`${wp.user}:${String(wp.pass).replace(/\s+/g, "")}`).toString("base64");
    // postId 없고 URL만 있으면 slug로 원격 글 ID 역추적(옛 발행글 편집)
    if (!postId && postUrl) {
      try {
        const slug = decodeURIComponent(String(postUrl).replace(/\/+$/, "").split("/").pop() || "");
        const sr = await fetch(`${wp.site}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=any`, { headers: { Authorization: auth } });
        const arr = await sr.json(); if (Array.isArray(arr) && arr[0]) postId = arr[0].id;
      } catch {}
      if (!postId) return res.status(400).json({ error: "원격 글을 찾지 못했습니다(URL로 매칭 실패). 새 글로 발행하거나 URL을 확인하세요." });
    }
    const postBody = { title, content };
    if (String(wp.site).includes("oguonline.com")) postBody.meta = { _ogu_src: "blogwrite" };   // 오구 알림 출처 태그
    const _oguAuthor = oguAuthorFor(wp.site); if (_oguAuthor) postBody.author = _oguAuthor;      // 니치 필자로 저자 표기
    if (!postId) postBody.status = status;   // 신규만 status 지정(업데이트 시 기존 상태 유지)
    const catId = await wpResolveCategory(wp.site, auth, category);
    if (catId) postBody.categories = [catId];
    const endpoint = postId ? `${wp.site}/wp-json/wp/v2/posts/${postId}` : `${wp.site}/wp-json/wp/v2/posts`;
    const r = await fetch(endpoint, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(postBody) });
    const text = await r.text();
    let j = {}; try { j = JSON.parse(text); } catch {}
    if (!r.ok) {
      if (r.status === 401 || r.status === 403 || j.code === "rest_cannot_create") {
        return res.status(400).json({ error: `WP 인증 실패(${r.status}): 로그인 비밀번호가 아니라 '응용프로그램 비밀번호'가 필요합니다. WP 관리자→사용자→프로필→응용프로그램 비밀번호에서 발급 후 계정 관리에 입력하세요.` });
      }
      throw new Error(j.message || `HTTP ${r.status}: ${text.slice(0, 120)}`);
    }
    res.json({ id: j.id, link: j.link });
  } catch (e) { res.status(500).json({ error: "WP 발행 오류: " + String(e.message || e) }); }
});

// ---- 발행된 글의 '현재(라이브)' 내용 가져오기 (블로그에서 직접 수정분 반영용) ----
app.post("/api/remote-post", async (req, res) => {
  const { destinationId, postId, postUrl } = req.body || {};
  const dest = destinationId ? DB.getDestination(req.userId, destinationId) : null;
  if (!dest) return res.status(400).json({ error: "목적지를 찾을 수 없습니다." });
  try {
    if (dest.platform === "wordpress") {
      const wp = resolveWp(req.userId, dest.id); if (!wp || !wp.site || !wp.user || !wp.pass) throw new Error("WP 자격 없음");
      const auth = "Basic " + Buffer.from(`${wp.user}:${String(wp.pass).replace(/\s+/g, "")}`).toString("base64");
      let id = postId;
      if (!id && postUrl) { const slug = decodeURIComponent(String(postUrl).replace(/\/+$/, "").split("/").pop() || ""); const sr = await fetch(`${wp.site}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&status=any`, { headers: { Authorization: auth } }); const arr = await sr.json(); if (Array.isArray(arr) && arr[0]) id = arr[0].id; }
      if (!id) throw new Error("원격 글 ID를 찾지 못했습니다.");
      const r = await fetch(`${wp.site}/wp-json/wp/v2/posts/${id}?context=edit`, { headers: { Authorization: auth } });
      const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status);
      return res.json({ id, title: (j.title?.raw ?? j.title?.rendered ?? "").toString(), html: (j.content?.rendered ?? j.content?.raw ?? "").toString() });
    }
    if (dest.platform === "blogger") {
      const rt = dest.creds?.refreshToken, blogId = dest.creds?.blogId; if (!rt || !blogId) throw new Error("블로거 미연결");
      const access = await bloggerAccessToken(rt);
      let id = postId;
      if (!id && postUrl) { const p = new URL(postUrl).pathname; const br = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/bypath?path=${encodeURIComponent(p)}`, { headers: { Authorization: "Bearer " + access } }); const bj = await br.json(); if (bj && bj.id) id = bj.id; }
      if (!id) throw new Error("원격 글 ID를 찾지 못했습니다.");
      const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${id}`, { headers: { Authorization: "Bearer " + access } });
      const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status);
      return res.json({ id, title: j.title || "", html: j.content || "" });
    }
    res.status(400).json({ error: "네이버 등은 라이브 불러오기를 지원하지 않습니다." });
  } catch (e) { res.status(500).json({ error: "라이브 불러오기 오류: " + String(e.message || e) }); }
});

// ---- 이미지 → WP 미디어 업로드 (드래그/붙여넣기/웹URL) ----
app.post("/api/wp-media", async (req, res) => {
  const wp = resolveWp(req.userId, req.body?.destinationId);
  if (!wp || !wp.site || !wp.user || !wp.pass) return res.status(400).json({ error: "이미지 업로드는 워드프레스 목적지에서만 가능합니다(자격 확인)." });
  try {
    const { dataUrl, imageUrl } = req.body || {};
    let buf, mime = "image/jpeg", fname = "image.jpg";
    if (dataUrl) {
      const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
      if (!m) throw new Error("잘못된 이미지 데이터");
      mime = m[1]; buf = Buffer.from(m[2], "base64"); fname = "upload-" + Date.now() + "." + ((mime.split("/")[1] || "jpg").split("+")[0]);
    } else if (imageUrl) {
      const r = await fetch(imageUrl, { headers: { "User-Agent": "Mozilla/5.0", Referer: "" } });
      if (!r.ok) throw new Error("원본 이미지 다운로드 실패 (" + r.status + ")");
      mime = (r.headers.get("content-type") || "image/jpeg").split(";")[0]; buf = Buffer.from(await r.arrayBuffer());
      fname = "web-" + Date.now() + "." + ((mime.split("/")[1] || "jpg").split("+")[0]);
    } else return res.status(400).json({ error: "이미지가 없습니다." });
    if (!/^image\//.test(mime)) throw new Error("이미지 형식이 아닙니다.");
    if (buf.length > 12 * 1024 * 1024) throw new Error("이미지가 너무 큽니다(12MB 초과).");
    const auth = "Basic " + Buffer.from(`${wp.user}:${String(wp.pass).replace(/\s+/g, "")}`).toString("base64");
    const r = await fetch(`${wp.site}/wp-json/wp/v2/media`, { method: "POST", headers: { Authorization: auth, "Content-Type": mime, "Content-Disposition": `attachment; filename="${fname}"` }, body: buf });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || ("업로드 실패 " + r.status));
    res.json({ url: j.source_url, id: j.id });
  } catch (e) { res.status(500).json({ error: "이미지 업로드 오류: " + String(e.message || e) }); }
});

// ---- 초안(웹서치) 백그라운드 생성: 긴 요청이 Cloudflare 터널 타임아웃 나지 않게 job+폴링 ----
const draftJobs = new Map();
app.post("/api/draft/start", (req, res) => {
  const aKey = DB.getSecret(req.userId, "anthropicKey") || ANTHROPIC_KEY;
  if (!aKey) return res.status(400).json({ error: "Anthropic 키가 필요합니다(설정에서 입력)." });
  const { keyword, reference } = req.body || {};
  if (!keyword || !String(keyword).trim()) return res.status(400).json({ error: "키워드가 필요합니다." });
  const id = "dj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  draftJobs.set(id, { status: "pending", ts: Date.now(), userId: req.userId });
  (async () => {
    try {
      const st = DB.getSettingsRaw(req.userId);
      const built = buildDraftPrompt({ keyword: String(keyword).trim(), reference: reference || "", today: new Date().toISOString().slice(0, 10), audience: st.defaultAudience, tone: st.defaultTone });
      const text = await anthropicChat({ system: built.system, user: built.user, maxTokens: 16000, apiKey: aKey });
      const job = draftJobs.get(id); if (job) { job.status = "done"; job.text = text; job.ts = Date.now(); }
    } catch (e) {
      const job = draftJobs.get(id); if (job) { job.status = "error"; job.error = String(e.message || e).slice(0, 200); job.ts = Date.now(); }
    }
  })();
  res.json({ jobId: id });
});
app.get("/api/draft/status", (req, res) => {
  const job = draftJobs.get(req.query.id);
  if (!job || job.userId !== req.userId) return res.status(404).json({ error: "작업을 찾을 수 없음" });
  const out = { status: job.status, text: job.text || "", error: job.error || "" };
  if (job.status !== "pending" && Date.now() - job.ts > 300000) draftJobs.delete(req.query.id);
  res.json(out);
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
  const { destinationId, title, content, isDraft, postUrl } = req.body || {};   // postId/postUrl 있으면 수정발행
  let { postId } = req.body;
  const dest = destinationId ? DB.getDestination(req.userId, destinationId) : null;
  if (!dest || dest.platform !== "blogger") return res.status(400).json({ error: "블로거 계정이 아닙니다." });
  const rt = dest.creds?.refreshToken, blogId = dest.creds?.blogId;
  if (!rt || !blogId) return res.status(400).json({ error: "이 블로거 계정은 아직 '구글 연결'이 안 됐습니다." });
  try {
    const access = await bloggerAccessToken(rt);
    // postId 없고 URL만 있으면 path로 원격 글 ID 역추적(옛 발행글 편집)
    if (!postId && postUrl) {
      try {
        const p = new URL(postUrl).pathname;
        const br = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/bypath?path=${encodeURIComponent(p)}`, { headers: { Authorization: "Bearer " + access } });
        const bj = await br.json(); if (bj && bj.id) postId = bj.id;
      } catch {}
      if (!postId) return res.status(400).json({ error: "원격 글을 찾지 못했습니다(URL 매칭 실패)." });
    }
    const url = postId
      ? `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`
      : `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${isDraft ? "?isDraft=true" : ""}`;
    const r = await fetch(url, { method: postId ? "PUT" : "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" }, body: JSON.stringify(postId ? { id: postId, title, content } : { title, content }) });
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
// 키워드 대기열(예약형 클라우드 에이전트가 next_topic으로 소진)
app.get("/api/topics", (req, res) => res.json({ topics: DB.listTopics(req.userId) }));
app.post("/api/topics", (req, res) => { const k = (req.body?.keyword || "").trim(); if (!k) return res.status(400).json({ error: "키워드를 입력하세요." }); res.json({ ok: true, topic: DB.addTopic(req.userId, k, req.body?.note || "") }); });
app.post("/api/topics/delete", (req, res) => { if (req.body?.id) DB.deleteTopic(req.userId, req.body.id); res.json({ ok: true }); });

// ---- 자동화 예약 ----
app.get("/api/schedules", (req, res) => res.json({ schedules: DB.listSchedules(req.userId) }));
app.post("/api/schedules", (req, res) => res.json({ ok: true, schedules: DB.upsertSchedule(req.userId, req.body || {}) }));
app.post("/api/schedules/delete", (req, res) => res.json({ ok: true, schedules: DB.deleteSchedule(req.userId, req.body?.id) }));
// 지금 즉시 실행(테스트/수동 트리거) — 백그라운드로 돌리고 즉시 응답
app.post("/api/schedules/run", (req, res) => {
  const s = DB.getSchedule(req.userId, req.body?.id);
  if (!s) return res.status(404).json({ error: "예약을 찾을 수 없음" });
  DB.setScheduleStatus(s.id, "pending", "수동 실행 대기");
  runSchedule({ ...s, status: "pending" }).catch(() => {});
  res.json({ ok: true });
});

// ---- 목적지 관리 ----
app.get("/api/destinations", (req, res) => res.json({ destinations: DB.listDestinations(req.userId) }));
app.post("/api/destinations", (req, res) => res.json({ ok: true, destinations: DB.upsertDestination(req.userId, req.body || {}) }));
app.post("/api/destinations/delete", (req, res) => res.json({ ok: true, destinations: DB.deleteDestination(req.userId, req.body?.id) }));

// ---- 작업 항목(칸반) ----
app.get("/api/work", (req, res) => res.json({ items: DB.listWorkItems(req.userId, req.query.status) }));
app.get("/api/by-draft", (req, res) => res.json(DB.workItemsByDraft(req.userId)));
// 조회수 분석: 발행글 누적/최근증가(Δ)/급등배수
app.get("/api/analytics", (req, res) => {
  const windowH = Math.max(1, Math.min(720, parseInt(req.query.window, 10) || 24));
  const nowMs = Date.now(), winMs = windowH * 3600 * 1000;
  const sinceIso = new Date(nowMs - (windowH * 2 * 3600 * 1000) - 3600 * 1000).toISOString();
  const snaps = DB.statSnapshotsSince(req.userId, sinceIso);
  const series = {}; for (const s of snaps) (series[s.work_id] = series[s.work_id] || []).push(s);
  const amap = {}; DB.accountsForGeneration(req.userId).forEach((a) => { amap[a.id] = a; });
  const viewsAt = (arr, tMs) => { let best = null; for (const s of arr) { const st = Date.parse(s.ts); if (st <= tMs && (!best || st > Date.parse(best.ts))) best = s; } return best ? best.views : (arr.length ? arr[0].views : 0); };
  const posts = DB.publishedForStats(req.userId).map((p) => {
    const arr = series[p.id] || [];
    const cur = arr.length ? arr[arr.length - 1].views : 0;
    const t1 = viewsAt(arr, nowMs - winMs), t2 = viewsAt(arr, nowMs - 2 * winMs);
    const dWin = Math.max(0, cur - t1), dPrev = Math.max(0, t1 - t2);
    const surge = dPrev > 0 ? Math.round(dWin / dPrev * 10) / 10 : (dWin > 0 ? 99 : 0);
    const acc = amap[p.destination_id] || {};
    return { work_id: p.id, title: p.title, url: p.published_url, blog: acc.name || p.target, cumulative: cur, delta: dWin, surge, samples: arr.length };
  });
  posts.sort((a, b) => b.delta - a.delta || b.cumulative - a.cumulative);
  res.json({ window: windowH, posts, collecting: snaps.length > 0, lastAt: DB.lastStatTs(req.userId) });
});
app.get("/api/work/:id", (req, res) => { const w = DB.getWorkItem(req.userId, req.params.id); w ? res.json(w) : res.status(404).json({ error: "not found" }); });
app.post("/api/work", (req, res) => res.json({ ok: true, id: DB.upsertWorkItem(req.userId, req.body || {}) }));
app.post("/api/work/delete", (req, res) => { if (req.body?.id) DB.deleteWorkItem(req.userId, req.body.id); res.json({ ok: true }); });
// 예약 발행 설정/해제 (생성된 글을 지정 시각에 자동 발행)
app.post("/api/work/schedule", (req, res) => {
  const { id, publish_at } = req.body || {};
  if (!id) return res.status(400).json({ error: "id 필요" });
  DB.setWorkPublishAt(req.userId, id, publish_at || null);
  res.json({ ok: true });
});

// ---- 설정 (사용자별, 민감키 암호화) ----
const SETTINGS_DEFAULTS = {
  genEngine: "claude", kieChatModel: "claude-sonnet-5", imageResolution: "1K",
  thumbnailMode: "ai_full", thumbnailStylePrompt: "", overlayAccent: "#ff2d55",
  linkMode: "preserve", myBlogUrl: "", defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자",
  authorBio: "여러 분야의 정보를 직접 찾아보고, 최신 자료와 공식 출처를 확인해 이해하기 쉽게 정리합니다. 검색만으로는 흩어져 있던 내용을 한곳에 모아, 실제로 도움이 되는 알맹이만 담으려 합니다.",
  adEnabled: false, adCode: "", internalLinks: false, generateImages: true, imageCount: 1,
  // 자동 생성 이미지 비율(썸네일/본문)
  thumbAspect: "16:9", bodyAspect: "4:3",
  // 예약 에이전트가 따를 초안 작성 지침(클로드 프로젝트 지침을 여기 붙여넣기)
  draftGuide: "",
  // 초안 다중 목적지 매칭
  autoMultiMatch: true, autoMultiMax: 0,
  // 텔레그램 알림
  tgEnabled: false, tgChatId: "", tgOnDraft: true, tgOnGenerate: true, tgOnPublish: true, tgOnSchedule: true, tgOnError: true
};
app.get("/api/settings", (req, res) => res.json({ ...SETTINGS_DEFAULTS, ...DB.getSettings(req.userId) }));
app.post("/api/settings", (req, res) => res.json({ ok: true, settings: { ...SETTINGS_DEFAULTS, ...DB.saveSettings(req.userId, req.body || {}) } }));
// 텔레그램 테스트 발송(현재 저장된 봇/챗ID로)
app.post("/api/telegram/test", async (req, res) => {
  const st = DB.getSettingsRaw(req.userId);
  const token = DB.getSecret(req.userId, "tgBotToken"), chatId = st.tgChatId;
  if (!token || !chatId) return res.status(400).json({ error: "봇 토큰과 Chat ID를 먼저 저장하세요." });
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text: "🔔 블로그라이터 알림 테스트 — 정상 연결되었습니다." }) });
    const j = await r.json(); if (!r.ok || !j.ok) throw new Error(j.description || r.status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "발송 실패: " + String(e.message || e) }); }
});

// ---- 프론트용 상태(사용자별) ----
app.get("/api/config", (req, res) => {
  const s = DB.getSettingsRaw(req.userId);
  res.json({
    kieEnabled: !!s.kieKey || !!KIE,
    claudeEnabled: !!s.anthropicKey || !!ANTHROPIC_KEY,
    wpEnabled: DB.listDestinations(req.userId).some((d) => d.platform === "wordpress") || !!WP_SITE,
    naverEnabled: !!s.naverClientId || !!NAVER_ID,
    pexelsEnabled: !!s.pexelsKey || !!PEXELS,
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

// ============ 예약 실행 엔진 (서버 사이드, 브라우저 없이 동작) ============
const isDestRoleRow = (a) => { const r = a.role || "destination"; return r === "destination" || r === "both"; };
const firstLine = (t) => (String(t || "").split(/\n/).map((s) => s.replace(/^#+\s*/, "").trim()).find((s) => s.length > 1) || "").slice(0, 60);
function parseArticle(raw) {
  let t = String(raw || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s > 0 || e < t.length - 1) t = t.slice(s, e + 1);
  try { return JSON.parse(t); } catch { return null; }
}
async function publishServer(userId, acc, { title, content, category }) {
  if (acc.platform === "wordpress") {
    const wp = resolveWp(userId, acc.id); if (!wp || !wp.site || !wp.user || !wp.pass) throw new Error("WP 자격 없음(응용프로그램 비밀번호 확인)");
    const auth = "Basic " + Buffer.from(`${wp.user}:${String(wp.pass).replace(/\s+/g, "")}`).toString("base64");
    const body = { title, content, status: "publish" };
    const _oguAuthor = oguAuthorFor(wp.site); if (_oguAuthor) body.author = _oguAuthor;   // 니치 필자로 저자 표기
    const catId = await wpResolveCategory(wp.site, auth, category);
    if (catId) body.categories = [catId];
    const r = await fetch(`${wp.site}/wp-json/wp/v2/posts`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status); return { link: j.link, id: j.id };
  }
  if (acc.platform === "blogger") {
    const dest = DB.getDestination(userId, acc.id); const rt = dest?.creds?.refreshToken, blogId = dest?.creds?.blogId;
    if (!rt || !blogId) throw new Error("블로거 미연결");
    const access = await bloggerAccessToken(rt);
    const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/`, { method: "POST", headers: { Authorization: "Bearer " + access, "Content-Type": "application/json" }, body: JSON.stringify({ title, content }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.status); return { link: j.url, id: j.id };
  }
  return null;
}
async function runSchedule(s) {
  const userId = s.user_id;
  DB.setScheduleStatus(s.id, "running", "");
  try {
    const aKey = DB.getSecret(userId, "anthropicKey") || ANTHROPIC_KEY;
    const kKey = DB.getSecret(userId, "kieKey") || KIE;
    const st = DB.getSettingsRaw(userId);
    const today = new Date().toISOString().slice(0, 10);
    let draftText = "", keyword = "";
    // 1) 초안 확보
    if (s.source === "draft" && s.draft_id) {
      const d = DB.getDraft(userId, s.draft_id);
      if (!d) throw new Error("선택한 초안을 찾을 수 없음");
      draftText = d.content || ""; keyword = d.keyword || firstLine(draftText);
    } else {
      keyword = (s.keywords || "").split(/[\n,]/)[0].trim();
      if (!keyword) throw new Error("키워드가 비어 있음");
      if (!aKey) throw new Error("Anthropic 키 없음(초안 웹서치 생성 불가)");
      const built = buildDraftPrompt({ keyword, today, audience: st.defaultAudience, tone: st.defaultTone });
      draftText = await anthropicChat({ system: built.system, user: built.user, maxTokens: 16000, apiKey: aKey });
      DB.addDraft(userId, { title: firstLine(draftText) || keyword, content: draftText, keyword, source: "scheduled" });
    }
    // 2) 초안까지만이면 종료
    if (s.scope === "draft") { DB.setScheduleStatus(s.id, "done", `초안 생성 완료: ${keyword}`); return; }
    // 3) 목적지 생성 (계정별)
    if (!kKey) throw new Error("KIE 키 없음(목적지 생성 불가)");
    let dests = DB.accountsForGeneration(userId).filter(isDestRoleRow);
    if (s.dest_id) dests = dests.filter((d) => d.id === s.dest_id);   // 특정 목적지만 지정 시
    if (!dests.length) throw new Error("목적지 계정이 없음(계정 관리에서 등록)");
    const groups = {}; dests.forEach((a) => { (groups[a.platform] = groups[a.platform] || []).push(a); });
    const idxIn = {}; let made = 0, pub = 0, lastLink = "";
    for (const acc of dests) {
      idxIn[acc.platform] = (idxIn[acc.platform] || 0) + 1;
      const variant = { index: idxIn[acc.platform], total: groups[acc.platform].length, persona: acc.persona || "" };
      const ov = acc.overrides || {};
      const built = buildBloggerMain({ sourceText: draftText, keyword, audience: ov.audience || st.defaultAudience, tone: ov.tone || st.defaultTone, authorBio: ov.authorBio || st.authorBio, today, imageCount: 1, reference: "", internalLinks: [], variant });
      let content = "";
      for (let attempt = 0; attempt < 2 && !content; attempt++) {
        try { content = await kieChat({ system: built.system, user: built.user, maxTokens: 16000, temperature: 0.8, model: CHAT_MODEL, prefillJson: true, apiKey: kKey }); }
        catch (e) { if (attempt) throw e; await sleep(1200); }
      }
      const article = parseArticle(content);
      if (!article) continue;
      article.today = today; article.keyword = keyword; const abio = ov.authorBio || st.authorBio; if (abio) article.authorBio = abio;
      try { await genArticleImagesServer(article, kKey, ov.thumbStyle || st.thumbnailStylePrompt, { resolution: st.imageResolution, thumbAspect: st.thumbAspect, bodyAspect: st.bodyAspect }); } catch {}
      const html = buildHtml(article, { accent: st.overlayAccent || "#e11d48", linkMode: st.linkMode || "preserve", adEnabled: st.adEnabled, adCode: st.adCode }).html;
      const wid = DB.upsertWorkItem(userId, { target: acc.platform, destination_id: acc.id, title: article.title || "", article, html, status: "generated" });
      made++;
      // 4) 발행 수준
      if (s.publish === "auto" && acc.has_creds) {
        try {
          const pr = await publishServer(userId, acc, { title: article.title, content: html, category: article.category });
          if (pr && pr.link) { DB.upsertWorkItem(userId, { id: wid, target: acc.platform, destination_id: acc.id, title: article.title || "", status: "published", published_url: pr.link, published_id: pr.id != null ? String(pr.id) : null, publish_mode: "scheduled" }); DB.addAsset(userId, { url: pr.link, title: article.title, keyword, excerpt: (html || "").replace(/<[^>]+>/g, " ").slice(0, 4000) }); pub++; lastLink = pr.link; tgMsg(userId, "publish", [`✅ 예약발행 완료 · <b>${tgEsc(acc.name || acc.platform)}</b>`, `📝 ${tgEsc(article.title)}`, `🔗 ${tgEsc(pr.link)}`]); }
        } catch (e) { tgMsg(userId, "error", [`❌ 예약발행 실패 · <b>${tgEsc(acc.name || acc.platform)}</b>`, `📝 ${tgEsc(article.title)}`, `⚠️ ${tgEsc(e.message || e)}`]); }
      }
    }
    // 초안 소스면 원본 초안 '사용됨' 처리(초안함 정리)
    if (made && s.source === "draft" && s.draft_id) { try { DB.setDraftStatus(userId, s.draft_id, "used"); } catch {} }
    const summary = `목적지 ${made}개 생성${s.publish === "auto" ? ` · ${pub}개 발행${lastLink ? " → " + lastLink : ""}` : " (작성완료, 수동발행 대기)"}`;
    DB.setScheduleStatus(s.id, "done", summary);
    tgMsg(userId, "schedule", [`📅 예약작업 완료 · <b>${tgEsc(keyword || "")}</b>`, tgEsc(summary)]);
  } catch (e) { DB.setScheduleStatus(s.id, "error", String(e.message || e)); tgMsg(userId, "error", [`❌ 예약작업 실패`, `⚠️ ${tgEsc(e.message || e)}`]); }
}
// 예약 발행: 생성 완료된 글을 지정 시각에 발행(WP/블로거). 네이버는 자동발행 불가 → 예약 해제.
async function publishDueWorkItem(row) {
  const userId = row.user_id;
  const full = DB.getWorkItem(userId, row.id);
  if (!full || full.status !== "generated") return;
  const acc = DB.accountsForGeneration(userId).find((a) => a.id === row.destination_id) || { platform: row.target, id: row.destination_id };
  if (acc.platform === "naver") { DB.setWorkPublishAt(userId, row.id, null); return; }
  try {
    const article = full.article || {};
    const pr = await publishServer(userId, acc, { title: full.title, content: full.html, category: article.category });
    if (pr && pr.link) {
      DB.upsertWorkItem(userId, { id: row.id, target: row.target, destination_id: row.destination_id, title: full.title || "", status: "published", published_url: pr.link, published_id: pr.id != null ? String(pr.id) : null, publish_mode: "scheduled" });
      DB.addAsset(userId, { url: pr.link, title: full.title, keyword: article.keyword || "", excerpt: (full.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000) });
      tgMsg(userId, "publish", [`✅ 예약발행 완료 · <b>${tgEsc(acc.name || acc.platform)}</b>`, `📝 ${tgEsc(full.title)}`, `🔗 ${tgEsc(pr.link)}`]);
    }
  } catch (e) { console.error("[work publish]", row.id, e.message); DB.setWorkPublishAt(userId, row.id, null); tgMsg(userId, "error", [`❌ 예약발행 실패 · <b>${tgEsc(acc.name || acc.platform)}</b>`, `📝 ${tgEsc(full.title)}`, `⚠️ ${tgEsc(e.message || e)}`]); }  // 실패 시 예약 해제(무한 재시도 방지) — 작업보드에 남음
}
// 초안 자동 처리: 들어온 초안 → 니치 매칭 목적지 글 생성 → 작업보드(발행 안 함)
// 니치 토큰 분리: 콤마·줄바꿈·공백 모두 지원(목적지마다 저장 형식이 달라도 매칭되게)
const topicScore = (acc, text) => { const ts = (acc.topics || "").split(/[,\n\s]+/).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2); let s = 0; for (const t of ts) if (t && text.includes(t)) s++; return s; };
// 반환: 실제로 목적지 글을 생성했으면 true, 니치 매칭이 없어 건너뛰면 false(초안은 'new' 유지)
async function processAutoDraft(userId, draft) {
  const kKey = DB.getSecret(userId, "kieKey") || KIE;
  if (!kKey) return false;
  const st = DB.getSettingsRaw(userId);
  const dests = DB.accountsForGeneration(userId).filter(isDestRoleRow);
  const text = ((draft.keyword || "") + " " + (draft.title || "") + " " + (draft.content || "").slice(0, 1200)).toLowerCase();
  const scored = dests.map((a) => ({ a, s: topicScore(a, text) })).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
  if (!scored.length) return -1;   // 니치 매칭 없음(소비 안 함, 다음 초안으로)
  // 다중 매칭: ON이면 니치가 '충분히' 맞는 목적지 모두에 글 작성(약한 1점짜리 오탐 제외). OFF면 1곳만.
  const multi = st.autoMultiMatch !== false;
  const cap = parseInt(st.autoMultiMax, 10) || 0;   // 상한(0=무제한)
  let list;
  if (multi) {
    // 최상위는 항상 포함, 추가 목적지는 '절대 점수 3 이상'이면 포함(니치 개수 차이에 안정적 + 경계 오탐 방지)
    const MIN_SECONDARY = 3;
    list = scored.filter((x, i) => i === 0 || x.s >= MIN_SECONDARY).map((x) => x.a);
    if (cap > 0) list = list.slice(0, cap);
  } else {
    list = [scored[0].a];
  }
  const today = new Date().toISOString().slice(0, 10);
  const keyword = draft.keyword || firstLine(draft.content);
  let made = 0;
  for (const acc of list) {
    try {
      const ov = acc.overrides || {};
      const variant = { persona: acc.persona || "", index: made + 1, total: list.length };
      const built = buildBloggerMain({ sourceText: draft.content || "", keyword, audience: ov.audience || st.defaultAudience, tone: ov.tone || st.defaultTone, authorBio: ov.authorBio || st.authorBio, today, imageCount: 1, reference: "", internalLinks: [], variant });
      let content = "";
      for (let attempt = 0; attempt < 3 && !content; attempt++) { try { content = await kieChat({ system: built.system, user: built.user, maxTokens: 16000, temperature: 0.8, model: CHAT_MODEL, prefillJson: true, apiKey: kKey }); } catch (e) { if (attempt === 2) throw e; await sleep(1500 * (attempt + 1)); } }
      const article = parseArticle(content); if (!article) throw new Error("파싱 실패");
      article.today = today; article.keyword = keyword; const abio = ov.authorBio || st.authorBio; if (abio) article.authorBio = abio;
      try { await genArticleImagesServer(article, kKey, ov.thumbStyle || st.thumbnailStylePrompt, { resolution: st.imageResolution, thumbAspect: st.thumbAspect, bodyAspect: st.bodyAspect }); } catch {}
      const html = buildHtml(article, { accent: st.overlayAccent || "#e11d48", linkMode: st.linkMode || "preserve", adEnabled: st.adEnabled, adCode: st.adCode }).html;
      DB.upsertWorkItem(userId, { draft_id: draft.id, target: acc.platform, destination_id: acc.id, title: article.title || "", article, html, status: "generated" });
      made++;
      tgMsg(userId, "generate", [`✍️ 초안 자동생성 완료 · <b>${tgEsc(acc.name || acc.platform)}</b>${list.length > 1 ? ` (${made}/${list.length})` : ""}`, `📝 ${tgEsc(article.title)}`, `작업보드에서 확인 후 발행하세요.`]);
    } catch (e) { console.error("[auto-draft]", draft.id, acc.id, e.message); tgMsg(userId, "error", [`❌ 초안 자동생성 실패 · <b>${tgEsc(acc.name || acc.platform)}</b>`, `📥 ${tgEsc(draft.title || draft.keyword || draft.id)}`, `⚠️ ${tgEsc(e.message || e)}`]); }
  }
  if (made > 0) DB.setDraftStatus(userId, draft.id, "used");   // 하나라도 생성돼야 소비(실패 시 초안 보존 → 다음 주기 재시도)
  return made;
}
const AUTO_INTERVAL = parseInt(process.env.AUTO_PROCESS_INTERVAL_MS, 10) || 10 * 60 * 1000;  // 초안 자동처리 간격(기본 10분)
let _lastAutoAt = Date.now() - AUTO_INTERVAL + 90 * 1000;   // 시작 후 첫 처리는 약 90초 뒤(확인용), 이후 10분 간격
const _autoFails = new Map();   // 초안별 연속 생성 실패 횟수(3회면 건너뜀 → 큐 막힘 방지)
// ---- 조회수 스냅샷 수집 (발행글 누적 조회수를 주기적으로 저장 → 24h/48h/급등 계산용) ----
const STAT_INTERVAL = 60 * 60 * 1000;   // 1시간마다
let _lastStatAt = Date.now() - STAT_INTERVAL + 120 * 1000;   // 시작 후 첫 수집 2분 뒤
async function collectPostStats() {
  const nowIso = new Date().toISOString();
  for (const uid2 of DB.usersWithPublishedStats()) {
    const accs = {}; DB.accountsForGeneration(uid2).forEach((a) => { accs[a.id] = a; });
    const bySite = {};
    for (const p of DB.publishedForStats(uid2)) {
      const acc = accs[p.destination_id];
      let site = acc && acc.site_url ? normSite(acc.site_url) : "";
      if (!site && p.published_url) { try { site = new URL(p.published_url).origin; } catch {} }
      if (!site) continue;
      (bySite[site] = bySite[site] || []).push(p);
    }
    for (const [site, list] of Object.entries(bySite)) {
      const idToWork = {}; list.forEach((p) => { idToWork[String(p.published_id)] = p.id; });
      const ids = Object.keys(idToWork);
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        try {
          const r = await fetch(`${site}/wp-json/mango/v1/views?ids=${chunk.join(",")}`, { signal: AbortSignal.timeout(20000) });
          if (!r.ok) continue;
          const j = await r.json();
          for (const [pid, v] of Object.entries(j || {})) { const wid = idToWork[pid]; if (wid) DB.addStatSnapshot(uid2, wid, parseInt(v, 10) || 0, nowIso); }
        } catch (e) { /* 사이트 접속 실패 시 이번 회차 건너뜀 */ }
      }
    }
  }
  DB.pruneStats(new Date(Date.now() - 21 * 86400 * 1000).toISOString());   // 21일 보관
}
let _schedRunning = false;
async function checkSchedules() {
  if (_schedRunning) return; _schedRunning = true;
  try {
    const nowIso = new Date().toISOString();
    const due = DB.dueSchedules(nowIso); for (const s of due) await runSchedule(s);
    const dueWork = DB.dueWorkPublish(nowIso); for (const w of dueWork) await publishDueWorkItem(w);   // 예약 발행 큐
    // 초안 자동 처리 — 부하 방지: 10분 간격으로 '하나씩' 순차 처리(예약분은 별개).
    // 니치 매칭 안 되는 초안은 건너뛰고, 매칭되는 첫 초안 하나만 처리(큐 막힘 방지). 나머지는 다음 주기에.
    if (Date.now() - _lastAutoAt >= AUTO_INTERVAL) {
      for (const d of DB.newAutoDrafts(200)) {
        if (!DB.getSettingsRaw(d.user_id).autoProcessDrafts || DB.draftHasSchedule(d.user_id, d.id)) continue;
        const made = await processAutoDraft(d.user_id, d);   // -1: 니치 매칭없음(다음) / 0: 생성실패 / >0: 성공
        if (made < 0) continue;                               // 매칭 안 되는 초안은 건너뛰고 다음 초안 시도
        if (made === 0) {                                     // 매칭됐지만 생성 실패(KIE 등) → 초안 보존, 실패 카운트
          const n = (_autoFails.get(d.id) || 0) + 1; _autoFails.set(d.id, n);
          if (n >= 3) { DB.setDraftStatus(d.user_id, d.id, "used"); _autoFails.delete(d.id); tgMsg(d.user_id, "error", [`⏭️ 초안 3회 연속 생성 실패로 건너뜀`, `📥 ${tgEsc(d.title || d.id)}`, `초안함에서 직접 확인해 주세요.`]); }
        } else { _autoFails.delete(d.id); }                   // 성공(이미 'used' 처리됨)
        _lastAutoAt = Date.now();                             // 매칭된 초안 하나 시도했으면 이번 주기 종료(성공·실패 무관, 과부하 방지)
        break;
      }
    }
    // 조회수 스냅샷 수집(1시간마다)
    if (Date.now() - _lastStatAt >= STAT_INTERVAL) { _lastStatAt = Date.now(); try { await collectPostStats(); } catch (e) { console.error("[stats]", e.message); } }
    // 완료된 예약 정리(2시간 지난 done 삭제)
    DB.pruneDoneSchedules(new Date(Date.now() - 2 * 3600 * 1000).toISOString());
  }
  catch (e) { console.error("[schedule] loop error", e); }
  finally { _schedRunning = false; }
}
try { const n = DB.recoverRunningSchedules(); if (n) console.log(`[schedule] 재시작 복구: 'running' ${n}건 → pending`); } catch {}   // 재시작 여파 복구
setInterval(checkSchedules, 60000);
setTimeout(checkSchedules, 8000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`블로그 오토라이터 서버: http://localhost:${PORT}`));
