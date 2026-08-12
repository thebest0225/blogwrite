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
import * as PB from "./playbook.js";
// 롱폼 V2 도구 — 별도 MCP 서버를 띄우지 않고 이 커넥터에 얹는다(2026-08-06).
//   이미 등록·인증된 커넥터라 사용자가 새로 등록할 필요가 없다.
import { registerLongformTools } from "./longform/tools.js";

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

// 오늘의머니바다 / 더케이타임스 일괄 발행 (각 사이트 autopilot.publish 재사용)
const TODAYMOBA_DIR = process.env.TODAYMOBA_DIR || "/var/www/todaymoba-news";
const THEKTIMES_DIR = process.env.THEKTIMES_DIR || "/var/www/thektimes-news";
function publishBatch(dir, articles) {
  return new Promise((resolve) => {
    const py = spawn(dir + "/venv/bin/python", [dir + "/publish_batch.py"], { cwd: dir });
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
    "블로그 초안을 블로그라이터 서버의 '초안함'으로 전송한다. ★네이버 목적지는 저장 전에 플레이북 기준으로 기계 검증한다(제목 길이·시점·국가 표기·본문 자수·소제목 수·사진 슬롯과 태그·캡션·해시태그·외국어 발음 표기·허용 링크·판단 유무). 어긋나면 저장하지 않고 어긋난 항목을 돌려주니, 그 항목만 고쳐 다시 호출하라. 매우 상세하게(사실·링크·출처 포함) 작성해 보낼 것. ★자동 예약 루틴이 보낼 때는 auto=true 로 보내라 — 그때만 기존 작성물과 중복이면 자동 반려한다. 사용자가 대화로 직접 요청한(수동) 초안은 auto 를 생략 → 중복이어도 그대로 저장한다. 여기 담긴 초안은 사용자가 웹앱에서 목적지(워드프레스)/쿠션(블로거·네이버) 글로 가공·발행한다.",
    { title: z.string().describe("초안 제목/주제"), content: z.string().describe("초안 본문 전체 (상세할수록 좋음. 마크다운/링크 포함 가능)"), keyword: z.string().optional().describe("핵심 키워드/사건명(중복 판정 기준)"), auto: z.boolean().optional().describe("자동 예약 루틴이 보낼 때만 true. 이때만 중복 자동 차단. 수동 요청은 생략/false."), allow_similar: z.boolean().optional().describe("auto 여도 제도·사실이 실제로 바뀌어 새로 쓸 이유가 분명할 때 true (중복 가드 우회)"), site: z.string().optional().describe("목적지 지정 — 사이트별 자동 루틴은 반드시 넣어라. destination id 또는 도메인/이름 일부(oguonline / thektimes / todaymoba). 생략하면 키워드로 추측 배분한다(부정확).") },
    async ({ title, content, keyword, auto, allow_similar, site }) => {
      if (auto && !allow_similar) {   // 자동일 때만, '정확히 같은 주제(same_keyword)'만 하드 차단. 같은 대상 다른 각도는 통과(루틴이 check_coverage로 판단).
        const cov = DB.findCoverage(userId, { keyword: keyword || "", title: title || "" });
        const hardDup = (cov.top || []).some((m) => m.reason === "same_keyword");
        if (hardDup) {
          const list = (cov.top || []).map((m) => `- [${m.kind}] ${m.title}${m.keyword ? ` (kw:${m.keyword})` : ""}`).join("\n");
          return { content: [{ type: "text", text: `⛔ 정확히 같은 주제가 이미 있습니다(자동 차단).\n\n${list}\n\n※ 같은 대상이라도 다른 각도·새 정보·다른 하위주제면 keyword를 그에 맞게 바꿔 다시 시도. 새로 쓸 이유가 분명하면 allow_similar=true.` }] };
        }
      }
      // site 로 목적지를 먼저 확정한다(있으면 추측 배분을 건너뛴다)
      let destId = null;
      if (site) {
        const want = String(site).toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
        const all = DB.listDestinations ? DB.listDestinations(userId) : [];
        const host = (d) => String(d.site_url || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        // ⚠️ 도메인 매칭을 id 매칭보다 먼저 본다.
        //    더케이타임스 목적지의 id 가 하필 'todaymoba'(과거 네이밍 잔재)여서,
        //    id 를 먼저 보면 site="todaymoba" 가 오늘의머니바다가 아니라 더케이타임스로 간다.
        const hit = all.find((d) => host(d) === want)                    // 도메인 완전일치
                 || all.find((d) => host(d).split(".")[0] === want)      // 도메인 앞부분 (todaymoba, thektimes, oguonline)
                 || all.find((d) => String(d.id).toLowerCase() === want) // 목적지 id
                 || all.find((d) => `${host(d)} ${d.name || ""}`.toLowerCase().includes(want));
        if (hit) destId = hit.id;
      }
      // ★기계 검증 (2026-08-13)
      //   프롬프트에 '본문 1,700~2,500자', '사진 2장', '자기 점검' 을 다 써놨는데도
      //   20건 중 11건이 어겼다. 부탁으로는 안 지켜진다. 그래서 여기서 기계로 잰다.
      //   어긋나면 저장하지 않고 어긋난 항목을 돌려준다 → 고쳐서 다시 보내면 된다.
      const pbSite = destId === "naver_mango" ? "naver" : (destId || "");
      const pbForCheck = pbSite ? DB.getPlaybook(userId, pbSite) : null;
      const isNaver = destId === "naver_mango" || String(site || "").toLowerCase().includes("naver");
      if (isNaver && pbForCheck && pbForCheck.sections.length) {
        const linkSec = pbForCheck.sections.find((x) => x.section === "links");
        const allowed = linkSec ? (linkSec.body.match(/https?:\/\/\S+/g) || []) : [];
        const v = PB.validateNaverDraft({ title, content, allowedLinks: allowed });
        if (!v.ok) {
          const lines = [
            "⛔ 저장하지 않았습니다 — 플레이북 기준에 어긋난 항목이 있습니다.",
            "",
            ...v.errors.map((e) => `✗ ${e}`),
            ...(v.warns.length ? ["", ...v.warns.map((w) => `△ ${w}`)] : []),
            "",
            `현재 상태: 제목 ${v.stats.titleChars}자 · 본문 ${v.stats.bodyChars}자 · 소제목 ${v.stats.heads}개 · 사진 ${v.stats.photos}개 · 표 ${v.stats.tables}개 · 링크 ${v.stats.links}개 · 해시태그 ${v.stats.tags}개`,
            "",
            "위 항목만 고쳐서 submit_draft 를 다시 호출하라. 글 전체를 새로 쓰지 말고 어긋난 부분만 손봐라.",
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
      }

      const rec = DB.addDraft(userId, { title, content, keyword, source: "mcp", dest_id: destId });
      let routed = "";
      if (rec.dest_id) { const d = DB.getDestination(userId, rec.dest_id); if (d) routed = ` → 목적지: ${d.name}${destId ? " (지정)" : " (자동 배분)"}`; }
      else if (site) routed = ` ⚠️ site="${site}" 에 맞는 목적지를 못 찾아 미배정`;
      try { tgMsg(userId, "draft", [`📥 새 초안 도착`, `📝 ${tgEsc(title || keyword || rec.id)}`, `초안함에서 확인하세요.`]); } catch {}
      return { content: [{ type: "text", text: `✅ 초안함에 저장됨 (id: ${rec.id})${routed}. 블로그라이터 웹앱(write.mangois.love)에서 가공·발행하세요.` }] };
    }
  );
  server.tool(
    "check_coverage",
    "새 글을 쓰기 전에 비슷한 기존 글이 있는지 확인한다(초안함+발행글+기존글 전체). ★matches(후보)가 있어도 무조건 중복은 아니다 — 같은 대상(프로그램·지원금·사건·인물·작품)이라도 다른 각도/새 정보/업데이트/다른 하위주제(예: 신청방법 vs 지급일 vs 자격)면 새로 써도 된다. matches의 제목을 보고 '실질적으로 같은 내용인지' 직접 판단하라. 거의 같은 정보를 반복하는 것이면 다른 주제/각도로.",
    { keyword: z.string().describe("주제 핵심 키워드 (예: 프로그램명·지원금명·사건명)"), title: z.string().optional().describe("작성 예정 제목(선택)") },
    async ({ keyword, title }) => {
      const cov = DB.findCoverage(userId, { keyword, title: title || keyword });
      return { content: [{ type: "text", text: JSON.stringify({ has_similar: cov.duplicate, note: cov.duplicate ? "비슷한 후보 있음 — 아래 제목을 보고 '같은 내용 반복'이면 다른 각도로, '다른 각도/새 정보'면 그대로 진행" : "겹치는 글 없음 — 작성 가능", matches: cov.top }, null, 2) }] };
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
    "다음에 쓸 초안 주제를 하나 가져온다. 예약형 자동 초안 작성 시 맨 먼저 호출할 것(=자동 루틴 진입점). ★site 를 넣으면 그 사이트의 '플레이북'(정체성·말투·실제 경험 자산·편집 원칙·검색 키워드 규칙·구조·출력 형식 계약·주제 풀·이미 다룬 주제·내부 링크 목록·자기 점검·발행 속도)을 전부 실어서 돌려준다. 그게 그 사이트의 지침이니 그대로 따라라. playbook_enabled 가 false 면 아무것도 쓰지 말고 즉시 종료하라(운영자가 잠시 멈춰둔 것이다). 키워드 대기열이 있으면 그 키워드를, 없으면 니치/주제 풀에서 고른다. already_covered 와 겹치지 않게 하고, 고른 주제는 check_coverage로 최종 확인한 뒤 초안을 작성해 submit_draft 로 보내라.",
    { site: z.string().optional().describe("사이트 키 — naver / todaymoba / oguonline / thektimes 또는 destination id. 넣으면 그 사이트 플레이북을 함께 반환한다.") },
    async ({ site }) => {
      const guide = (DB.getSettingsRaw(userId).draftGuide || "").trim();
      // ★플레이북 — 지침을 DB 에서 읽어온다. 루틴 프롬프트를 다시 붙일 필요가 없다.
      let pbBlock = null;
      if (site) {
        const pb = DB.getPlaybook(userId, site);
        if (pb.sections.length) {
          if (!pb.enabled) {
            return { content: [{ type: "text", text: JSON.stringify({
              site, playbook_enabled: false,
              instruction: `'${site}' 는 지금 멈춰둔 상태다(운영자가 관리 페이지에서 끔). 아무것도 쓰지 말고 '${site} 플레이북이 꺼져 있어 건너뜀' 한 줄만 보고하고 종료하라.`,
            }, null, 2) }] };
          }
          // 이 사이트에 이미 쓴 제목을 자동으로 실어 보낸다.
          // [이미 다룬 주제] 섹션을 손으로 관리하면 반드시 뒤처진다.
          let recent = [];
          try {
            const destId = site === "naver" ? "naver_mango" : site;
            recent = (DB.listDrafts(userId) || [])
              .filter((d) => d.dest_id === destId)
              .slice(0, 60)
              .map((d) => d.title);
          } catch {}
          pbBlock = {
            site, playbook_enabled: true, meta: pb.meta,
            playbook: PB.renderPlaybook(pb),
            already_written: recent,
            already_written_note: "이 사이트에 이미 쓴 제목이다. 여기 있는 주제는 다시 쓰지 마라(플레이북의 [이미 다룬 주제] 보다 이게 최신이다).",
            draft_count: recent.length,
          };
        }
      }
      const covered = DB.recentCoverage(userId, 40);   // 최근 다룬 주제(중복 회피용)
      const t = DB.nextTopic(userId);
      if (t) {
        const remain = DB.pendingTopicCount(userId);
        return { content: [{ type: "text", text: JSON.stringify({ mode: "queued", keyword: t.keyword, note: t.note || "", remaining_in_queue: remain, ...(pbBlock || {}), writing_guidelines: pbBlock ? "(위 playbook 을 따르라)" : (guide || "(지정된 지침 없음 — 기본 원칙대로)"), already_covered: covered, instruction: "이건 자동 예약 루틴이다. 작성 전 check_coverage로 이 주제를 이미 다뤘는지 확인 — 이미 다뤘고 새 전개/업데이트가 없으면 건너뛰어라(중복 금지). 새 주제면 writing_guidelines를 지켜 상세 초안 작성 후 submit_draft에 auto=true 로 보내라." }, null, 2) }] };
      }
      const niches = DB.nicheList(userId);
      return { content: [{ type: "text", text: JSON.stringify({ mode: "trend", niches, ...(pbBlock || {}), writing_guidelines: pbBlock ? "(위 playbook 을 따르라)" : (guide || "(지정된 지침 없음 — 기본 원칙대로)"), already_covered: covered, instruction: "예약된 키워드가 없다. 이건 자동 예약 루틴이다. 위 niches 중 지금 시의성 있는 주제를 고르되 already_covered 목록과 겹치지 않게 하라. 고른 주제는 check_coverage로 최종 확인(중복이면 다른 주제). writing_guidelines를 지켜 상세 초안 작성 후 submit_draft에 auto=true 로 보내라." }, null, 2) }] };
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
    "오구온라인(oguonline.com) IT·생활 실용 꿀팁 글을 '여러 건 한 번에' 발행한다. 웹서치로 사실을 확인해 작성한 완성 글들을 배열로 넘기면, 분야별 담당자 자동 배정 + 대표이미지 + 발행기록 저장까지 처리해 즉시 게시한다. 한 번에 권장 2~4건(최대 30). 각 글 body는 완성된 HTML(<p>,<h2>,<table>,<ul> 등), 본문 2,000~3,000자 권장. category는 다음 중 하나: download(무료 프로그램 다운로드·설치), phone-tips(스마트폰·앱 활용법), life-money(알뜰 짠테크·생활경제), benefit-tips(정부지원금·환급 등 숨은 혜택), mango-note(생활 정보: 계절·안전·보험 등 생활 속 실용 정보). 오구온라인 스타일: 어려운 내용을 '쉽게 풀어보면' 식으로, 3줄요약(summary)과 필요시 비교표를 포함하고, '읽고 바로 따라 할 수 있는' 실용 정보로.",
    {
      articles: z.array(z.object({
        title: z.string().describe("기사 제목(28~45자 검색친화)"),
        body: z.string().describe("완성된 본문 HTML (<p>,<h2>,<table> 등. 실제 수치·출처 포함 권장)"),
        category: z.string().optional().describe("download|phone-tips|life-money|benefit-tips|mango-note"),
        tags: z.array(z.string()).optional().describe("한국어 태그 5~7개"),
        summary: z.array(z.string()).optional().describe("3줄 요약 (핵심 불릿 3개)"),
        image_query: z.string().optional().describe("대표 이미지용 영문 스톡 검색어"),
        meta_description: z.string().optional().describe("검색 노출용 요약 1문장"),
        thumb_hook: z.string().optional().describe("썸네일 이미지에 크게 얹을 한국어 후크 8~14자. 제목을 그대로 줄이지 말고 가장 궁금하게 만드는 핵심 한 조각만(예: '피 대신 케첩?', '월 34만원 더'). 낚시·과장 금지, 문장부호는 물음표만. 생략하면 제목에서 자동 추출되는데 품질이 떨어진다 — 반드시 넣어라."),
      })).describe("발행할 IT·생활 팁 글 배열(여러 건 동시)")
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

  server.tool(
    "publish_todaymoba",
    "오늘의머니바다(todaymoba.com) '돈·정부혜택' 정보 글을 여러 건 한 번에 발행한다. 웹서치로 최신 사실(금액·자격·신청기간·공식링크)을 확인해 작성한 완성 글들을 배열로 넘기면, 니치별 담당자 자동 배정 + 대표이미지 + 발행기록까지 처리해 즉시 게시한다. 한 번에 1~3건 권장. 각 글 body는 완성 HTML(<p>,<h2>,<table>,<ul> 등 + 콜아웃 숏코드 [ogu_warn]/[ogu_tip]/[ogu_check]). category는 니치 slug 중 하나: missed(몰라서 놓친 돈: 미청구 환급·숨은 지원금), gov(정부지원금·수당), invest(생활 재테크·예적금·절세), life(생활경제 실용정보), howto(신청·발급 절차 안내), senior(시니어 복지·연금·건강).",
    {
      articles: z.array(z.object({
        title: z.string().describe("제목(22~40자 검색친화)"),
        body: z.string().describe("완성 본문 HTML(실제 수치·공식 출처 링크 포함 권장)"),
        category: z.string().describe("니치 slug: missed|gov|invest|life|howto|senior"),
        tags: z.array(z.string()).optional().describe("한국어 태그 2~3개(재사용 넓은 주제어)"),
        summary: z.array(z.string()).optional().describe("핵심 요약 불릿 3~4개(결론·금액 먼저)"),
        image_query: z.string().optional().describe("대표 이미지용 영문 검색어"),
        image_query2: z.string().optional().describe("본문 보조 이미지용 영문 검색어"),
        image_query3: z.string().optional().describe("본문 보조 이미지용 영문 검색어"),
        meta_description: z.string().optional().describe("검색 노출용 요약 1문장(70~110자)"),
        thumb_hook: z.string().optional().describe("썸네일 이미지에 크게 얹을 한국어 후크 8~14자. 제목을 그대로 줄이지 말고 가장 궁금하게 만드는 핵심 한 조각만(예: '피 대신 케첩?', '월 34만원 더'). 낚시·과장 금지, 문장부호는 물음표만. 생략하면 제목에서 자동 추출되는데 품질이 떨어진다 — 반드시 넣어라."),
      })).describe("발행할 돈·혜택 정보 글 배열")
    },
    async ({ articles }) => {
      if (!Array.isArray(articles) || !articles.length)
        return { content: [{ type: "text", text: "발행할 글이 없습니다." }] };
      const r = await publishBatch(TODAYMOBA_DIR, articles);
      if (!r.ok)
        return { content: [{ type: "text", text: `발행 처리 실패: ${r.error}\n${r.out || ""}\n${r.err || ""}` }] };
      const arr = r.results || [];
      const ok = arr.filter((x) => x.ok);
      const lines = arr.map((x) => x.ok ? `✅ [${x.category}] ${x.title}\n   ${x.url}` : `❌ ${x.title || "(제목없음)"}: ${x.error}`);
      return { content: [{ type: "text", text: `오늘의머니바다 발행 ${ok.length}/${arr.length}건 완료\n\n${lines.join("\n")}` }] };
    }
  );

  server.tool(
    "publish_thektimes",
    "THE KILLING TIMES(thektimes.com) 사건·미제·실화 매거진 글을 여러 건 한 번에 발행한다. 웹서치로 사실을 확인해 작성한 완성 글들을 배열로 넘기면, 니치별 담당자 자동 배정 + 대표이미지 + 발행기록까지 처리해 즉시 게시한다. 한 번에 1~3건 권장. 각 글 body는 완성 HTML(<p>,<h2>,<table>,<ul> 등 + 콜아웃 숏코드 [ogu_warn]/[ogu_tip]). 분석 텍스트에 무게중심 — 사실 나열은 절반 이하로 두고 법의학·범죄심리·제도 관점의 분석을 3개 이상 넣는다. 마무리 직전에 필자 1인칭 판단 섹션(<h2>내가 보는 이 사건</h2> 등)을 반드시 두고, 맨 끝은 <h2>자주 묻는 질문</h2> 3~4개로 닫는다(<ul><li><strong>Q. 질문?</strong> — 답변.</li></ul> 형식 정확히). 본문 3,500~5,000자, <h2> 하나당 550자 이상. ★category 는 아래 네 개 중 하나여야 한다(2026-08 개편으로 연예·스포츠·온라인 화제 코너는 폐지됨. 없는 slug 를 보내면 cases 로 잘못 들어간다): cases(공분을 산 강력범죄 심층), mystery(미제·실종·기이한 실화), docu(그것이 알고싶다·PD수첩 등 탐사보도 프로그램, 실화 다큐), crime-screen(범죄·수사·스릴러 드라마·영화). 자극 절제·피해자 보호·사실 기반.",
    {
      articles: z.array(z.object({
        title: z.string().describe("제목(26~42자, 사실 근거 후크형)"),
        body: z.string().describe("완성 본문 HTML(사실·전개·맥락·관점 촘촘히)"),
        category: z.enum(["cases", "mystery", "docu", "crime-screen"]).describe("니치 slug — cases(강력범죄 심층)|mystery(미제·실종)|docu(탐사보도·실화 다큐)|crime-screen(범죄 드라마·영화)"),
        tags: z.array(z.string()).optional().describe("한국어 태그 2~3개(재사용 넓은 주제어)"),
        summary: z.array(z.string()).optional().describe("핵심 요약 불릿 3~4개"),
        image_query: z.string().optional().describe("대표 이미지용 영문 검색어"),
        image_query2: z.string().optional().describe("본문 보조 이미지용 영문 검색어"),
        image_query3: z.string().optional().describe("본문 보조 이미지용 영문 검색어"),
        meta_description: z.string().optional().describe("검색 노출용 요약 1문장(70~110자)"),
        thumb_hook: z.string().optional().describe("썸네일 이미지에 크게 얹을 한국어 후크 8~14자. 제목을 그대로 줄이지 말고 가장 궁금하게 만드는 핵심 한 조각만(예: '피 대신 케첩?', '월 34만원 더'). 낚시·과장 금지, 문장부호는 물음표만. 생략하면 제목에서 자동 추출되는데 품질이 떨어진다 — 반드시 넣어라."),
      })).describe("발행할 탐사·이슈·방송 글 배열")
    },
    async ({ articles }) => {
      if (!Array.isArray(articles) || !articles.length)
        return { content: [{ type: "text", text: "발행할 글이 없습니다." }] };
      const r = await publishBatch(THEKTIMES_DIR, articles);
      if (!r.ok)
        return { content: [{ type: "text", text: `발행 처리 실패: ${r.error}\n${r.out || ""}\n${r.err || ""}` }] };
      const arr = r.results || [];
      const ok = arr.filter((x) => x.ok);
      const lines = arr.map((x) => x.ok ? `✅ [${x.category}] ${x.title}\n   ${x.url}` : `❌ ${x.title || "(제목없음)"}: ${x.error}`);
      return { content: [{ type: "text", text: `더케이타임스 발행 ${ok.length}/${arr.length}건 완료\n\n${lines.join("\n")}` }] };
    }
  );

  // 롱폼 V2 도구 9개 등록 (lf_*)

  registerLongformTools(server);

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
