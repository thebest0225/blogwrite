// 블로그 오토라이터 — MCP 서버 (원격, Streamable HTTP)
// Claude(Desktop/웹)에서 초안을 서버 '초안함'으로 보내고, 발행 자산(연관글)을 검색한다.
// blogwrite 웹앱과 같은 디렉토리의 drafts.json / records.json 을 공유한다.
import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAFTS = path.join(__dirname, "drafts.json");
const STORE = path.join(__dirname, "records.json");
const TOKEN = process.env.MCP_TOKEN || "";
const PORT = process.env.MCP_PORT || 3100;

const loadJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return []; } };
const saveJson = (f, a) => fs.writeFileSync(f, JSON.stringify(a));

// ---- MCP 서버(도구) 팩토리 (요청마다 생성: 무상태) ----
function buildServer() {
  const server = new McpServer({ name: "blogwrite", version: "1.0.0" });

  // 1) 초안 전송 → 초안함(drafts.json)에 저장
  server.tool(
    "submit_draft",
    "블로그 초안을 블로그라이터 서버의 '초안함'으로 전송한다. 매우 상세하게(사실·링크·출처 포함) 작성해 보낼 것. 여기 담긴 초안은 사용자가 웹앱에서 목적지(워드프레스)/쿠션(블로거·네이버) 글로 가공·발행한다.",
    {
      title: z.string().describe("초안 제목/주제"),
      content: z.string().describe("초안 본문 전체 (상세할수록 좋음. 마크다운/링크 포함 가능)"),
      keyword: z.string().optional().describe("핵심 키워드(선택)")
    },
    async ({ title, content, keyword }) => {
      const a = loadJson(DRAFTS);
      const rec = { id: "d" + Date.now().toString(36) + randomUUID().slice(0, 4), date: new Date().toISOString(), status: "new", title: title || "(제목없음)", content: content || "", keyword: keyword || "", source: "mcp" };
      a.push(rec); saveJson(DRAFTS, a);
      return { content: [{ type: "text", text: `✅ 초안함에 저장됨 (id: ${rec.id}). 블로그라이터 웹앱(write.mangois.love)에서 가공·발행하세요.` }] };
    }
  );

  // 2) 초안함 목록
  server.tool(
    "list_drafts",
    "블로그라이터 초안함에 쌓인 최근 초안 목록을 반환한다.",
    { limit: z.number().optional().describe("개수(기본 20)") },
    async ({ limit }) => {
      const a = loadJson(DRAFTS).slice().reverse().slice(0, limit || 20)
        .map((d) => ({ id: d.id, title: d.title, keyword: d.keyword, status: d.status, date: d.date }));
      return { content: [{ type: "text", text: JSON.stringify(a, null, 2) }] };
    }
  );

  // 3) 발행 자산(연관글) 검색 → 초안 작성 시 자연스럽게 링크로 녹이도록
  server.tool(
    "search_my_posts",
    "이미 발행한 내 글들(제목·URL·키워드)을 키워드로 검색한다. 초안을 쓸 때 관련 있는 내 글의 URL을 본문에 자연스럽게 링크로 녹이면 내부 유입에 좋다.",
    { query: z.string().describe("검색 키워드/주제") },
    async ({ query }) => {
      const kw = (query || "").toLowerCase().trim();
      const tokens = kw.split(/\s+/).filter((t) => t.length >= 2);
      const posts = loadJson(STORE).filter((r) => r.type === "post" && r.url && /^https?:\/\//.test(r.url));
      const scored = posts.map((p) => {
        const hay = ((p.title || "") + " " + (p.keyword || "")).toLowerCase();
        let s = 0; for (const t of tokens) if (hay.includes(t)) s++; if (hay.includes(kw)) s += 2;
        return { p, s };
      }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8)
        .map((x) => ({ title: x.p.title, url: x.p.url, keyword: x.p.keyword || "" }));
      return { content: [{ type: "text", text: scored.length ? JSON.stringify(scored, null, 2) : "관련 발행글 없음(아직 축적 전)." }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "8mb" }));
app.get("/health", (req, res) => res.json({ ok: true, service: "blogwrite-mcp" }));

// 토큰 인증 (Desktop: mcp-remote --header 'Authorization: Bearer ...')
app.use("/mcp", (req, res, next) => {
  if (!TOKEN) return next(); // 토큰 미설정 시 통과(로컬)
  const h = req.headers.authorization || "";
  if (h === `Bearer ${TOKEN}`) return next();
  res.set("WWW-Authenticate", 'Bearer realm="blogwrite-mcp"').status(401).json({ error: "unauthorized" });
});

// Streamable HTTP (무상태: 요청마다 서버/트랜스포트 생성)
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
  }
});
app.get("/mcp", (req, res) => res.status(405).json({ error: "Method Not Allowed (use POST)" }));

app.listen(PORT, () => console.log(`블로그라이터 MCP 서버: http://localhost:${PORT}/mcp`));
