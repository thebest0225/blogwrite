// 블로그 오토라이터 — MCP 서버 (원격, Streamable HTTP)
// Claude(Desktop/웹/폰)에서 초안을 서버 '초안함'으로 보내고, 발행 자산(연관글)을 검색한다.
// 인증: (1) 정적 토큰(데스크탑 mcp-remote)  (2) OAuth 2.0 PKCE+DCR (claude.ai 커넥터)
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { spawn } from "child_process";
import { tgMsg, tgEsc } from "./notify.js";
import * as DB from "./db.js";

const OGU_NEWS_DIR = process.env.OGU_NEWS_DIR || "/var/www/oguonline-news";
// 오구온라인 뉴스 일괄 발행 (파이썬 배치 스크립트 호출, 검증된 발행 로직 재사용)
function publishOguNews(articles) {
  return new Promise((resolve) => {
    const py = spawn(OGU_NEWS_DIR + "/venv/bin/python", [OGU_NEWS_DIR + "/publish_news_batch.py"], { cwd: OGU_NEWS_DIR });
    let out = "", err = "";
    py.stdout.on("data", (d) => (out += d));
    py.stderr.on("data", (d) => (err += d));
    py.on("close", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop() || "[]";
        resolve({ ok: true, results: JSON.parse(line) });
      } catch (e) {
        resolve({ ok: false, error: String(e), out: out.slice(-600), err: err.slice(-400) });
      }
    });
    py.on("error", (e) => resolve({ ok: false, error: String(e) }));
    py.stdin.write(JSON.stringify({ articles }));
    py.stdin.end();
  });
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.MCP_TOKEN || "";
const PORT = process.env.MCP_PORT || 3100;
const MCP_USER_ID = parseInt(process.env.MCP_USER_ID || "1", 10);   // 정적 토큰용 기본 사용자
const BASE = process.env.MCP_PUBLIC_URL || "https://mcp.mangois.love";
const MANGOHUB_ME = process.env.MANGOHUB_ME || "http://localhost:8000/api/auth/me";
const LOGIN_URL = process.env.LOGIN_URL || "https://mangois.love/";

// ---- OAuth 저장소 (재시작에도 연결 유지되게 파일 영속) ----
const STORE_PATH = path.join(__dirname, "oauth-store.json");
let store = { clients: {}, codes: {}, tokens: {}, refresh: {} };
try { store = { clients: {}, codes: {}, tokens: {}, refresh: {}, ...JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) }; } catch {}
let _saveT = null;
function saveStore() { clearTimeout(_saveT); _saveT = setTimeout(() => { try { fs.writeFileSync(STORE_PATH, JSON.stringify(store)); } catch {} }, 300); }
const rnd = (n = 32) => crypto.randomBytes(n).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// ---- MangoHub 세션 → 사용자 식별 ----
async function resolveUser(req) {
  const cookie = req.headers.cookie || "";
  if (!/session_token=/.test(cookie)) return null;
  try {
    const r = await fetch(MANGOHUB_ME, { headers: { Cookie: cookie } });
    if (!r.ok) return null;
    const u = await r.json();
    if (u && u.id && u.status === "active") return u.id;
  } catch {}
  return null;
}

// ---- MCP 서버(도구) 팩토리 — 인증된 userId 로 동작 ----
function buildServer(userId) {
  const server = new McpServer({ name: "blogwrite", version: "1.0.0" });
  server.tool(
    "submit_draft",
    "블로그 초안을 블로그라이터 서버의 '초안함'으로 전송한다. 매우 상세하게(사실·링크·출처 포함) 작성해 보낼 것. 여기 담긴 초안은 사용자가 웹앱에서 목적지(워드프레스)/쿠션(블로거·네이버) 글로 가공·발행한다.",
    { title: z.string().describe("초안 제목/주제"), content: z.string().describe("초안 본문 전체 (상세할수록 좋음. 마크다운/링크 포함 가능)"), keyword: z.string().optional().describe("핵심 키워드(선택)") },
    async ({ title, content, keyword }) => {
      const rec = DB.addDraft(userId, { title, content, keyword, source: "mcp" });
      let routed = "";
      if (rec.dest_id) { const d = DB.getDestination(userId, rec.dest_id); if (d) routed = ` → 니치 자동 배분: ${d.name}`; }
      try { tgMsg(userId, "draft", [`📥 새 초안 도착`, `📝 ${tgEsc(title || keyword || rec.id)}`, `초안함에서 확인하세요.`]); } catch {}
      return { content: [{ type: "text", text: `✅ 초안함에 저장됨 (id: ${rec.id})${routed}. 블로그라이터 웹앱(write.mangois.love)에서 가공·발행하세요.` }] };
    }
  );
  server.tool(
    "list_drafts",
    "블로그라이터 초안함에 쌓인 최근 초안 목록을 반환한다.",
    { limit: z.number().optional().describe("개수(기본 20)") },
    async ({ limit }) => {
      const a = DB.listDrafts(userId).slice(0, limit || 20).map((d) => ({ id: d.id, title: d.title, keyword: d.keyword, status: d.status, date: d.date }));
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    }
  );
  server.tool(
    "next_topic",
    "다음에 쓸 초안 주제를 하나 가져온다. 예약형 자동 초안 작성 시 맨 먼저 호출할 것. 사용자가 미리 넣어둔 '키워드 대기열'에 항목이 있으면 그 키워드를 반환하고(자동 소진), 없으면 사용자의 블로그 니치 목록을 반환한다 — 그 경우 니치 중에서 '지금 시의성 있는(트렌드) 주제'를 스스로 골라라. 어느 경우든 그 주제로 상세 초안을 작성한 뒤 submit_draft로 보내라. 작성 전 list_drafts로 최근 초안과 주제가 겹치지 않는지 확인할 것.",
    {},
    async () => {
      const guide = (DB.getSettingsRaw(userId).draftGuide || "").trim();
      const t = DB.nextTopic(userId);
      if (t) {
        const remain = DB.pendingTopicCount(userId);
        return { content: [{ type: "text", text: JSON.stringify({ mode: "queued", keyword: t.keyword, note: t.note || "", remaining_in_queue: remain, writing_guidelines: guide || "(지정된 지침 없음 — 기본 원칙대로)", instruction: "writing_guidelines를 반드시 지켜 이 키워드로 상세 초안을 작성하고 submit_draft로 보내라." }, null, 2) }] };
      }
      const niches = DB.nicheList(userId);
      return { content: [{ type: "text", text: JSON.stringify({ mode: "trend", niches, writing_guidelines: guide || "(지정된 지침 없음 — 기본 원칙대로)", instruction: "예약된 키워드가 없다. 위 niches 중 하나에서 지금 시의성 있는(최근 트렌드) 주제를 스스로 골라라. writing_guidelines를 반드시 지켜 상세 초안을 작성하고 submit_draft로 보내라. list_drafts로 최근 초안과 중복되지 않게 확인할 것." }, null, 2) }] };
    }
  );
  server.tool(
    "search_my_posts",
    "이미 발행한 내 글들(제목·URL·키워드)을 키워드로 검색한다. 초안을 쓸 때 관련 있는 내 글의 URL을 본문에 자연스럽게 링크로 녹이면 내부 유입에 좋다.",
    { query: z.string().describe("검색 키워드/주제") },
    async ({ query }) => {
      const hits = DB.searchAssets(userId, query).map((p) => ({ title: p.title, url: p.url, keyword: p.keyword || "" }));
      return { content: [{ type: "text", text: hits.length ? JSON.stringify(hits, null, 2) : "관련 발행글 없음(아직 축적 전)." }] };
    }
  );
  server.tool(
    "publish_ogu_news",
    "오구온라인(oguonline.com) 뉴스 기사를 '여러 건 한 번에' 발행한다. 웹서치로 사실을 확인해 작성한 완성 기사들을 배열로 넘기면, 분야별 기자 자동 배정 + 대표이미지 + 발행기록 저장까지 처리해 즉시 게시한다. 한 번에 권장 5~7건(최대 30). 각 기사 body는 완성된 HTML(<p>,<h2>,<table> 등), 본문 1,500~2,300자 권장. category는 다음 중 하나: breaking(속보/사회), politics-economy(정치/경제), it-science(IT/과학), entertainment-sports(연예/스포츠), life(생활). 오구온라인 스타일: 어려운 내용을 '쉽게 풀어보면' 식으로, 3줄요약(summary)과 필요시 비교표를 포함.",
    {
      articles: z.array(z.object({
        title: z.string().describe("기사 제목(28~45자 검색친화)"),
        body: z.string().describe("완성된 본문 HTML (<p>,<h2>,<table> 등. 실제 수치·출처 포함 권장)"),
        category: z.string().optional().describe("breaking|politics-economy|it-science|entertainment-sports|life"),
        tags: z.array(z.string()).optional().describe("한국어 태그 5~7개"),
        summary: z.array(z.string()).optional().describe("3줄 요약 (핵심 불릿 3개)"),
        image_query: z.string().optional().describe("대표 이미지용 영문 스톡 검색어"),
        meta_description: z.string().optional().describe("검색 노출용 요약 1문장")
      })).describe("발행할 뉴스 기사 배열(여러 건 동시)")
    },
    async ({ articles }) => {
      if (!Array.isArray(articles) || !articles.length)
        return { content: [{ type: "text", text: "발행할 기사가 없습니다." }] };
      const r = await publishOguNews(articles);
      if (!r.ok)
        return { content: [{ type: "text", text: `발행 처리 실패: ${r.error}\n${r.out || ""}\n${r.err || ""}` }] };
      const arr = r.results || [];
      const ok = arr.filter((x) => x.ok);
      const lines = arr.map((x) => x.ok ? `✅ [${x.category}] ${x.title}\n   ${x.url}` : `❌ ${x.title || "(제목없음)"}: ${x.error}`);
      return { content: [{ type: "text", text: `오구온라인 발행 ${ok.length}/${arr.length}건 완료\n\n${lines.join("\n")}` }] };
    }
  );
  return server;
}

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));
// 메타데이터/토큰/등록 엔드포인트 CORS 허용(클라이언트 디스커버리용)
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, mcp-protocol-version");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.get("/health", (req, res) => res.json({ ok: true, service: "blogwrite-mcp" }));

// ---- OAuth 디스커버리 ----
const asMeta = {
  issuer: BASE,
  authorization_endpoint: BASE + "/authorize",
  token_endpoint: BASE + "/token",
  registration_endpoint: BASE + "/register",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  scopes_supported: ["mcp"]
};
const prMeta = { resource: BASE + "/mcp", authorization_servers: [BASE] };
app.get("/.well-known/oauth-authorization-server", (req, res) => res.json(asMeta));
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => res.json(prMeta));
// 일부 클라이언트는 OIDC 디스커버리를 시도 → 동일 메타로 응답
app.get("/.well-known/openid-configuration", (req, res) => res.json(asMeta));

// ---- 동적 클라이언트 등록 (RFC 7591) ----
app.post("/register", (req, res) => {
  const b = req.body || {};
  const redirectUris = Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
  const clientId = "c_" + rnd(12);
  const client = { client_id: clientId, redirect_uris: redirectUris, client_name: b.client_name || "mcp-client", token_endpoint_auth_method: "none", created: nowS() };
  store.clients[clientId] = client; saveStore();
  res.status(201).json({ ...client, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
});

// ---- 인가 엔드포인트 ----
app.get("/authorize", async (req, res) => {
  const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } = req.query;
  const client = store.clients[client_id];
  if (!client || response_type !== "code" || !redirect_uri) return res.status(400).send("invalid_request");
  if (client.redirect_uris.length && !client.redirect_uris.includes(redirect_uri)) return res.status(400).send("invalid redirect_uri");
  if (code_challenge_method && code_challenge_method !== "S256") return res.status(400).send("code_challenge_method must be S256");
  // MangoHub 로그인 확인(같은 브라우저의 .mangois.love 세션 쿠키)
  const userId = await resolveUser(req);
  if (!userId) {
    return res.status(200).send(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;max-width:420px;margin:60px auto;text-align:center;line-height:1.6">
      <h3>MangoHub 로그인이 필요해요</h3>
      <p>먼저 mangois.love에 로그인한 뒤, 이 창에서 <b>다시 시도</b>를 눌러주세요.</p>
      <p><a href="${LOGIN_URL}" target="_blank" style="display:inline-block;padding:10px 18px;background:#4f46e5;color:#fff;border-radius:8px;text-decoration:none">mangois.love 로그인 열기</a></p>
      <p><a href="" onclick="location.reload();return false" style="color:#4f46e5">다시 시도</a></p></body>`);
  }
  const code = rnd(24);
  store.codes[code] = { userId, clientId: client_id, redirectUri: redirect_uri, codeChallenge: code_challenge || "", exp: nowS() + 300 };
  saveStore();
  const u = new URL(redirect_uri);
  u.searchParams.set("code", code);
  if (state) u.searchParams.set("state", state);
  res.redirect(302, u.toString());
});

// ---- 토큰 엔드포인트 ----
function issueTokens(userId, clientId) {
  const access = "at_" + rnd(32), refresh = "rt_" + rnd(32);
  store.tokens[access] = { userId, clientId, exp: nowS() + 3600 };
  store.refresh[refresh] = { userId, clientId };
  saveStore();
  return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "mcp" };
}
app.post("/token", (req, res) => {
  const b = req.body || {};
  if (b.grant_type === "authorization_code") {
    const c = store.codes[b.code];
    if (!c || c.exp < nowS()) return res.status(400).json({ error: "invalid_grant" });
    if (c.clientId !== b.client_id || c.redirectUri !== b.redirect_uri) return res.status(400).json({ error: "invalid_grant" });
    if (c.codeChallenge) {
      const ok = b.code_verifier && b64url(crypto.createHash("sha256").update(b.code_verifier).digest()) === c.codeChallenge;
      if (!ok) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE 검증 실패" });
    }
    delete store.codes[b.code]; saveStore();
    return res.json(issueTokens(c.userId, c.clientId));
  }
  if (b.grant_type === "refresh_token") {
    const r = store.refresh[b.refresh_token];
    if (!r) return res.status(400).json({ error: "invalid_grant" });
    return res.json(issueTokens(r.userId, r.clientId));
  }
  res.status(400).json({ error: "unsupported_grant_type" });
});

// ---- /mcp 인증: 정적 토큰 또는 OAuth 액세스 토큰 ----
function authMcp(req, res, next) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  const tok = m ? m[1] : "";
  if (TOKEN && tok === TOKEN) { req.mcpUserId = MCP_USER_ID; return next(); }
  const at = tok && store.tokens[tok];
  if (at && at.exp >= nowS()) { req.mcpUserId = at.userId; return next(); }
  if (at && at.exp < nowS()) { delete store.tokens[tok]; saveStore(); }
  res.set("WWW-Authenticate", `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`).status(401).json({ error: "unauthorized" });
}

// Streamable HTTP (무상태)
app.post("/mcp", authMcp, async (req, res) => {
  try {
    const server = buildServer(req.mcpUserId || MCP_USER_ID);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
  }
});
app.get("/mcp", authMcp, (req, res) => res.status(405).json({ error: "Method Not Allowed (use POST)" }));

app.listen(PORT, () => console.log(`블로그라이터 MCP 서버(OAuth): http://localhost:${PORT}/mcp`));
