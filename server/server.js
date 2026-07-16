// 블로그 오토라이터 — 서버 백엔드 (Express)
// 역할: 브라우저 웹앱(public/)을 제공 + KIE/네이버/구글트렌드/워드프레스 API 프록시 + 기록 저장
// 프론트가 CORS 없이 same-origin(/api/*)으로 호출 → API 키는 서버(.env)에만 존재
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

// ---- MangoHub SSO 인증 (세션 쿠키는 .mangois.love 공유) ----
const MANGOHUB_VERIFY = process.env.MANGOHUB_VERIFY || "http://localhost:8000/api/auth/verify";
const LOGIN_URL = process.env.LOGIN_URL || "https://mangois.love/";
const PUBLIC_PATHS = new Set(["/styles.css", "/app.js", "/favicon.ico", "/health"]);
async function isAuthed(req) {
  const cookie = req.headers.cookie || "";
  if (!/session_token=/.test(cookie)) return false;
  try {
    const r = await fetch(MANGOHUB_VERIFY, { headers: { Cookie: cookie, "X-Page-Key": "blogwrite" } });
    return r.ok;
  } catch { return false; }
}
app.get("/health", (req, res) => res.json({ ok: true }));
app.use(async (req, res, next) => {
  if (PUBLIC_PATHS.has(req.path) || req.path.startsWith("/lib/")) return next();
  if (await isAuthed(req)) return next();
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
const STORE = path.join(__dirname, "records.json");
const DRAFTS = path.join(__dirname, "drafts.json");   // MCP로 받은 초안함 (MCP 서버와 공유)

const loadStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return []; } };
const saveStore = (a) => fs.writeFileSync(STORE, JSON.stringify(a));
const loadDrafts = () => { try { return JSON.parse(fs.readFileSync(DRAFTS, "utf8")); } catch { return []; } };
const saveDrafts = (a) => fs.writeFileSync(DRAFTS, JSON.stringify(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kieHeaders = () => ({ Authorization: `Bearer ${KIE}`, "Content-Type": "application/json" });

// ---- 글 생성 (KIE Claude) ----
async function kieChat({ system, user, maxTokens, temperature, model, prefillJson }) {
  const messages = [{ role: "user", content: user }];
  // JSON 강제: 어시스턴트 응답을 "{" 로 시작하게 프리필 → 서두(거부성 멘트) 원천 차단
  if (prefillJson) messages.push({ role: "assistant", content: "{" });
  const r = await fetch(`${KIE_BASE}/claude/v1/messages`, {
    method: "POST", headers: kieHeaders(),
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
app.post("/api/chat", async (req, res) => {
  const { system, user, maxTokens = 16000, temperature = 0.8, model, prefillJson = true } = req.body;
  let content = "", lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1200);
    try {
      content = await kieChat({ system, user, maxTokens, temperature, model, prefillJson });
      if (content && content.trim()) break;
      lastErr = new Error("빈 응답");
    } catch (e) { lastErr = e; }
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
async function runImageJob(model, input) {
  const g = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, { method: "POST", headers: kieHeaders(), body: JSON.stringify({ model, input }) });
  const gj = await kieSafeJson(g);
  if (gj.code !== 200) throw new Error(gj.msg || "createTask 실패");
  const id = gj.data.taskId;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const inf = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`, { headers: kieHeaders() });
    let d; try { d = (await kieSafeJson(inf)).data; } catch { continue; }
    if (!d) continue;
    if (d.state === "success") { let u = []; try { u = JSON.parse(d.resultJson || "{}").resultUrls || []; } catch {} if (u[0]) return u[0]; throw new Error("결과 URL 없음"); }
    if (d.state === "fail") throw new Error(d.failMsg || "이미지 실패");
  }
  throw new Error("이미지 시간초과");
}
app.post("/api/image", async (req, res) => {
  try { const { prompt, aspect = "4:3", resolution = "1K" } = req.body; res.json({ url: await runImageJob(IMAGE_MODEL, { prompt, aspect_ratio: aspect, resolution }) }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post("/api/image-edit", async (req, res) => {
  try { const { imageUrl, prompt, aspect = "4:3", resolution = "1K" } = req.body; res.json({ url: await runImageJob("gpt-image-2-image-to-image", { prompt, input_urls: [imageUrl], aspect_ratio: aspect, resolution }) }); }
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

// ---- 트렌드 (구글 급상승, 6h 캐시) ----
let trendCache = null;
app.get("/api/trends", async (req, res) => {
  try {
    if (!req.query.force && trendCache && Date.now() - trendCache.ts < 6 * 3600 * 1000) return res.json(trendCache);
    let items = [];
    for (const url of ["https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR", "https://trends.google.co.kr/trends/trendingsearches/daily/rss?geo=KR"]) {
      try {
        const r = await fetch(url); if (!r.ok) continue;
        const xml = await r.text();
        items = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>/g)].map((m) => ({ title: m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() })).filter((x) => x.title);
        if (items.length) break;
      } catch {}
    }
    trendCache = { ts: Date.now(), items: items.slice(0, 20) };
    res.json(trendCache);
  } catch (e) { res.json({ ts: Date.now(), items: [] }); }
});

// ---- 네이버 검색 (선택, 링크 그라운딩) ----
app.get("/api/naver-search", async (req, res) => {
  if (!NAVER_ID) return res.json({ items: [] });
  try {
    const q = req.query.q || ""; const out = [];
    for (const kind of ["webkr", "news", "blog"]) {
      const r = await fetch(`https://openapi.naver.com/v1/search/${kind}.json?query=${encodeURIComponent(q)}&display=4`, { headers: { "X-Naver-Client-Id": NAVER_ID, "X-Naver-Client-Secret": NAVER_SECRET } });
      if (!r.ok) continue; const j = await r.json();
      for (const it of j.items || []) out.push({ kind, title: (it.title || "").replace(/<[^>]+>/g, ""), link: it.link });
    }
    res.json({ items: out });
  } catch { res.json({ items: [] }); }
});

// ---- 워드프레스 발행 ----
app.post("/api/wp", async (req, res) => {
  if (!WP_SITE) return res.status(400).json({ error: "WP 미설정" });
  try {
    const { title, content, status = "draft" } = req.body;
    const auth = "Basic " + Buffer.from(`${WP_USER}:${WP_PASS}`).toString("base64");
    const r = await fetch(`${WP_SITE.replace(/\/+$/, "")}/wp-json/wp/v2/posts`, { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify({ title, content, status }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.message || r.status);
    res.json({ id: j.id, link: j.link });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 기록/보관함 저장소 ----
app.get("/api/store", (req, res) => res.json({ records: loadStore().reverse() }));
app.post("/api/store", (req, res) => { const a = loadStore(); a.push({ date: new Date().toISOString(), ...req.body }); saveStore(a); res.json({ ok: true }); });
// 보관함 항목 삭제 (url 기준)
app.post("/api/store/delete", (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.json({ ok: false });
  saveStore(loadStore().filter((r) => r.url !== url));
  res.json({ ok: true });
});

// ---- 초안함 (MCP로 받은 초안 리스트) ----
app.get("/api/drafts", (req, res) => res.json({ drafts: loadDrafts().slice().reverse() }));
app.post("/api/drafts", (req, res) => {
  const d = req.body || {};
  const rec = { id: "d" + Date.now().toString(36), date: new Date().toISOString(), status: "new", title: d.title || "(제목없음)", content: d.content || "", keyword: d.keyword || "", source: d.source || "web" };
  const a = loadDrafts(); a.push(rec); saveDrafts(a);
  res.json({ ok: true, draft: rec });
});
app.post("/api/drafts/delete", (req, res) => {
  const { id } = req.body || {};
  saveDrafts(loadDrafts().filter((r) => r.id !== id));
  res.json({ ok: true });
});
app.post("/api/drafts/status", (req, res) => {
  const { id, status } = req.body || {};
  const a = loadDrafts(); const r = a.find((x) => x.id === id); if (r) { r.status = status; saveDrafts(a); }
  res.json({ ok: true });
});

// ---- 비민감 설정 저장 (settings.json) ----
const SETTINGS = path.join(__dirname, "settings.json");
const SETTINGS_DEFAULTS = {
  kieChatModel: "claude-sonnet-5",
  imageResolution: "1K",
  thumbnailMode: "ai_full",     // ai_full | overlay | off
  thumbnailStylePrompt: "",     // 비우면 프론트 기본값 사용
  overlayAccent: "#ff2d55",
  linkMode: "search",           // search | model
  myBlogUrl: "",
  defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자",
  authorBio: "",
  adEnabled: false,
  adCode: "",
  internalLinks: false,
  generateImages: true,
  imageCount: 1
};
const loadSettings = () => { try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS, "utf8")) }; } catch { return { ...SETTINGS_DEFAULTS }; } };
app.get("/api/settings", (req, res) => res.json(loadSettings()));
app.post("/api/settings", (req, res) => {
  const merged = { ...loadSettings(), ...(req.body || {}) };
  fs.writeFileSync(SETTINGS, JSON.stringify(merged, null, 2));
  res.json({ ok: true, settings: merged });
});

// (선택) 비밀 설정이 아닌 프론트용 기본값 제공
app.get("/api/config", (req, res) => res.json({ kieEnabled: !!KIE, wpEnabled: !!WP_SITE, naverEnabled: !!NAVER_ID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`블로그 오토라이터 서버: http://localhost:${PORT}`));
