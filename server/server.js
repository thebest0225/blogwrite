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
app.use(express.static(path.join(__dirname, "public")));

const KIE = process.env.KIE_API_KEY;
const CHAT_MODEL = process.env.KIE_CHAT_MODEL || "claude-sonnet-5";
const IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-text-to-image";
const NAVER_ID = process.env.NAVER_CLIENT_ID, NAVER_SECRET = process.env.NAVER_CLIENT_SECRET;
const WP_SITE = process.env.WP_SITE, WP_USER = process.env.WP_USER, WP_PASS = process.env.WP_APP_PASSWORD;
const KIE_BASE = "https://api.kie.ai";
const STORE = path.join(__dirname, "records.json");

const loadStore = () => { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return []; } };
const saveStore = (a) => fs.writeFileSync(STORE, JSON.stringify(a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kieHeaders = () => ({ Authorization: `Bearer ${KIE}`, "Content-Type": "application/json" });

// ---- 글 생성 (KIE Claude) ----
app.post("/api/chat", async (req, res) => {
  try {
    const { system, user, maxTokens = 20000, temperature = 0.8, model } = req.body;
    const r = await fetch(`${KIE_BASE}/claude/v1/messages`, {
      method: "POST", headers: kieHeaders(),
      body: JSON.stringify({ model: model || CHAT_MODEL, system, messages: [{ role: "user", content: user }], max_tokens: maxTokens, temperature, stream: false })
    });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch { return res.status(500).json({ error: t.slice(0, 300) }); }
    const data = j.data && (j.data.content || j.data.choices) ? j.data : j;
    let content = Array.isArray(data.content) ? data.content.filter((b) => b.type === "text").map((b) => b.text).join("") : "";
    if (!content) content = data?.choices?.[0]?.message?.content || "";
    res.json({ content });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- 이미지 (KIE jobs) ----
async function runImageJob(model, input) {
  const g = await fetch(`${KIE_BASE}/api/v1/jobs/createTask`, { method: "POST", headers: kieHeaders(), body: JSON.stringify({ model, input }) });
  const gj = await g.json();
  if (gj.code !== 200) throw new Error(gj.msg || "createTask 실패");
  const id = gj.data.taskId;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const inf = await fetch(`${KIE_BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(id)}`, { headers: kieHeaders() });
    const d = (await inf.json()).data;
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
  const found = new Set();
  await Promise.all(qs.map(async (q) => {
    try { const r = await fetch(`https://suggestqueries.google.com/complete/search?client=firefox&hl=ko&gl=kr&q=${encodeURIComponent(q)}`); (JSON.parse(await r.text())[1] || []).forEach((k) => found.add(k)); } catch {}
    try { const r = await fetch(`https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(q)}&st=100&r_format=json&r_enc=UTF-8&ans=2`); ((JSON.parse(await r.text()).items?.[0]) || []).forEach((row) => found.add(Array.isArray(row) ? row[0] : row)); } catch {}
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

// (선택) 비밀 설정이 아닌 프론트용 기본값 제공
app.get("/api/config", (req, res) => res.json({ wpEnabled: !!WP_SITE, naverEnabled: !!NAVER_ID }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`블로그 오토라이터 서버: http://localhost:${PORT}`));
