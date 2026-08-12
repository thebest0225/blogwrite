// 블로그라이터 v2 — 공유 데이터 계층 (SQLite, 사용자별 스코프)
// blogwrite 서버 + MCP 서버가 같은 blogwrite.db 를 공유(WAL 다중프로세스).
import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(__dirname, "blogwrite.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  user_id INTEGER PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS destinations (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  name TEXT, platform TEXT, site_url TEXT, creds TEXT, is_default INTEGER DEFAULT 0,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  date TEXT, status TEXT DEFAULT 'new', title TEXT, content TEXT, keyword TEXT, source TEXT DEFAULT 'web'
);
CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  date TEXT, url TEXT, title TEXT, keyword TEXT, excerpt TEXT
);
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  draft_id TEXT, target TEXT, destination_id TEXT,
  title TEXT, article_json TEXT, html TEXT,
  status TEXT DEFAULT 'generated', published_url TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_user ON drafts(user_id);
CREATE INDEX IF NOT EXISTS idx_assets_user ON assets(user_id);
CREATE INDEX IF NOT EXISTS idx_work_user ON work_items(user_id);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  name TEXT, mode TEXT, keywords TEXT, times_per_day INTEGER DEFAULT 1,
  auto TEXT DEFAULT 'draft', enabled INTEGER DEFAULT 1, created_at TEXT
);
CREATE TABLE IF NOT EXISTS topic_queue (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
  keyword TEXT NOT NULL, note TEXT, status TEXT DEFAULT 'pending',
  created_at TEXT, used_at TEXT
);
CREATE TABLE IF NOT EXISTS post_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL, work_id TEXT NOT NULL,
  ts TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pstats ON post_stats(user_id, work_id, ts);
CREATE INDEX IF NOT EXISTS idx_dest_user ON destinations(user_id);
CREATE INDEX IF NOT EXISTS idx_sched_user ON schedules(user_id);
CREATE INDEX IF NOT EXISTS idx_topicq_user ON topic_queue(user_id, status);
`);
// 계정 역할(목적지/쿠션/겸용) 컬럼 (기존 테이블에도 추가)
try { db.exec("ALTER TABLE destinations ADD COLUMN role TEXT DEFAULT 'destination'"); } catch {}
try { db.exec("ALTER TABLE destinations ADD COLUMN persona TEXT"); } catch {}
try { db.exec("ALTER TABLE destinations ADD COLUMN topics TEXT"); } catch {}
// 블로그별 오버라이드(톤/대상독자/저자소개/썸네일스타일) JSON. 비우면 전역 설정 사용
try { db.exec("ALTER TABLE destinations ADD COLUMN overrides TEXT"); } catch {}
// 계정 사용 여부(휴재 토글). 1=on(기본), 0=off → 자동 생성/자동 체크 제외
try { db.exec("ALTER TABLE destinations ADD COLUMN enabled INTEGER DEFAULT 1"); } catch {}
// 초안 → 목적지 자동 배분(니치)용 컬럼
try { db.exec("ALTER TABLE drafts ADD COLUMN dest_id TEXT"); } catch {}
// 중복 방지 인덱스(커버리지): 지금까지 다룬 주제(초안+발행+기존글 백필). 동일 키워드/유사 제목 재작성 차단용.
try { db.exec(`CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  norm_key TEXT, norm_title TEXT, keyword TEXT, title TEXT, site TEXT, kind TEXT, url TEXT, date TEXT
)`); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_cov_user ON coverage(user_id, norm_key)"); } catch {}

// ---- 사이트 플레이북 (2026-08-12) ------------------------------------------
// 왜 만들었나: 페르소나·편집원칙·경험자산이 claude.ai 루틴 프롬프트 안에 박혀 있어서
//   한 줄 고치려면 1만 자를 다시 붙여야 했다. 사이트가 늘면 관리가 안 된다.
//   → 지침을 여기 두고 루틴은 얇게 만든다. 루틴이 MCP get_site_playbook 으로 읽어간다.
//   웹 관리 페이지에서 고치면 다음 실행부터 바로 반영된다.
//
// section: 한 사이트의 지침을 여러 조각으로 나눠 저장한다.
//   identity(정체성·바이라인) / voice(말투) / editorial(편집 원칙) / structure(구조 규칙)
//   contract(출력 형식 계약) / topics(주제 풀) / covered(이미 다룬 주제) / links(내부 링크)
//   experience(경험 자산 — 계속 누적) / checklist(자기 점검) / cadence(발행 속도)
// enabled: 0 이면 루틴이 첫 단계에서 읽고 아무것도 안 하고 종료한다(실질적 중지 스위치).
try { db.exec(`CREATE TABLE IF NOT EXISTS site_playbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  site TEXT NOT NULL,            -- destinations.id 또는 짧은 키(naver / todaymoba / oguonline / thektimes)
  section TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
)`); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_uniq ON site_playbook(user_id, site, section)"); } catch {}

// 사이트 단위 메타(중지 스위치·발행 속도·메모). section='__meta__' 한 행에 JSON 으로.
export function getPlaybook(userId, site) {
  const rows = db.prepare("SELECT section, body, sort, enabled, updated_at FROM site_playbook WHERE user_id=? AND site=? ORDER BY sort, section").all(uid(userId), site);
  const meta = rows.find((r) => r.section === "__meta__");
  let m = {};
  try { m = meta ? JSON.parse(meta.body || "{}") : {}; } catch {}
  return {
    site,
    enabled: meta ? !!meta.enabled : true,
    meta: m,
    sections: rows.filter((r) => r.section !== "__meta__" && r.enabled),
  };
}
export function listPlaybookSites(userId) {
  return db.prepare(`SELECT site,
      MAX(CASE WHEN section='__meta__' THEN enabled ELSE NULL END) AS enabled,
      MAX(CASE WHEN section='__meta__' THEN body ELSE NULL END)    AS meta,
      COUNT(*) AS sections, MAX(updated_at) AS updated_at
    FROM site_playbook WHERE user_id=? GROUP BY site ORDER BY site`).all(uid(userId));
}
export function upsertPlaybookSection(userId, site, section, body, opts = {}) {
  const ex = db.prepare("SELECT id FROM site_playbook WHERE user_id=? AND site=? AND section=?").get(uid(userId), site, section);
  if (ex) {
    db.prepare("UPDATE site_playbook SET body=?, sort=COALESCE(?,sort), enabled=COALESCE(?,enabled), updated_at=? WHERE id=?")
      .run(String(body ?? ""), opts.sort ?? null, opts.enabled === undefined ? null : (opts.enabled ? 1 : 0), now(), ex.id);
  } else {
    db.prepare("INSERT INTO site_playbook(user_id,site,section,body,sort,enabled,updated_at) VALUES(?,?,?,?,?,?,?)")
      .run(uid(userId), site, section, String(body ?? ""), opts.sort ?? 0, opts.enabled === false ? 0 : 1, now());
  }
  return getPlaybook(userId, site);
}
export function deletePlaybookSection(userId, site, section) {
  db.prepare("DELETE FROM site_playbook WHERE user_id=? AND site=? AND section=?").run(uid(userId), site, section);
  return getPlaybook(userId, site);
}
export function setPlaybookEnabled(userId, site, enabled) {
  const ex = db.prepare("SELECT id, body FROM site_playbook WHERE user_id=? AND site=? AND section='__meta__'").get(uid(userId), site);
  if (ex) db.prepare("UPDATE site_playbook SET enabled=?, updated_at=? WHERE id=?").run(enabled ? 1 : 0, now(), ex.id);
  else db.prepare("INSERT INTO site_playbook(user_id,site,section,body,sort,enabled,updated_at) VALUES(?,?,'__meta__','{}',-1,?,?)").run(uid(userId), site, enabled ? 1 : 0, now());
  return getPlaybook(userId, site);
}
// 경험 자산은 계속 쌓인다. 한 줄씩 덧붙이는 전용 함수(대화로 알려준 걸 바로 넣기 위함).
export function appendExperience(userId, site, line) {
  const cur = db.prepare("SELECT body FROM site_playbook WHERE user_id=? AND site=? AND section='experience'").get(uid(userId), site);
  const body = ((cur && cur.body) ? cur.body.trimEnd() + "\n" : "") + "· " + String(line).trim();
  return upsertPlaybookSection(userId, site, "experience", body, { sort: 40 });
}
// 발행 방식(auto=자동발행 / manual=HTML 수동) 컬럼
try { db.exec("ALTER TABLE work_items ADD COLUMN publish_mode TEXT"); } catch {}
try { db.exec("ALTER TABLE work_items ADD COLUMN publish_at TEXT"); } catch {}
try { db.exec("ALTER TABLE work_items ADD COLUMN published_id TEXT"); } catch {}   // 원격 글 ID(수정발행용)
try { db.exec("ALTER TABLE work_items ADD COLUMN note TEXT"); } catch {}            // 생성 실패 사유 등 메모
// 예약 확장 컬럼 (초안/키워드 소스, 실행일시, 범위, 발행수준, 상태)
for (const col of [
  "source TEXT DEFAULT 'keyword'", "draft_id TEXT", "run_at TEXT",
  "scope TEXT DEFAULT 'destination'", "publish TEXT DEFAULT 'none'",
  "status TEXT DEFAULT 'pending'", "last_run TEXT", "result TEXT", "dest_id TEXT"
]) { try { db.exec("ALTER TABLE schedules ADD COLUMN " + col); } catch {} }

// ---- 암호화 (API 키·발행 자격) ----
const SECRET = crypto.createHash("sha256").update(process.env.DATA_SECRET || "blogwrite-default-secret").digest();
export function enc(text) {
  if (text == null || text === "") return "";
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", SECRET, iv);
  const e = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return "v1:" + Buffer.concat([iv, c.getAuthTag(), e]).toString("base64");
}
export function dec(blob) {
  if (!blob || !String(blob).startsWith("v1:")) return blob || "";
  try {
    const raw = Buffer.from(String(blob).slice(3), "base64");
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", SECRET, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch { return ""; }
}

const uid = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };
const now = () => new Date().toISOString();
const rid = (p) => p + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");

// ---- 설정 (민감키는 암호화 저장, 반환 시 존재여부만/복호화는 서버 내부용) ----
const SECRET_FIELDS = ["anthropicKey", "kieKey", "naverClientId", "naverClientSecret", "pexelsKey", "tgBotToken"];
export function getSettingsRaw(userId) {
  const row = db.prepare("SELECT json FROM settings WHERE user_id=?").get(uid(userId));
  let s = {}; try { s = row ? JSON.parse(row.json) : {}; } catch {}
  return s;
}
export function getSettings(userId) {
  // 프론트 반환용: 민감키는 값 대신 존재여부(hasXxx)
  const s = getSettingsRaw(userId); const out = { ...s };
  for (const f of SECRET_FIELDS) { out["has" + f[0].toUpperCase() + f.slice(1)] = !!s[f]; delete out[f]; }
  return out;
}
export function getSecret(userId, field) { return dec(getSettingsRaw(userId)[field] || ""); }
export function saveSettings(userId, patch) {
  const cur = getSettingsRaw(userId); const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (SECRET_FIELDS.includes(k)) { if (v) next[k] = enc(v); }  // 빈값이면 기존 유지
    else next[k] = v;
  }
  db.prepare("INSERT INTO settings(user_id,json) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET json=excluded.json")
    .run(uid(userId), JSON.stringify(next));
  return getSettings(userId);
}

// ---- 계정(목적지/쿠션) : 다수, 플랫폼별, 역할별 ----
const _parseOv = (s) => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
export function listDestinations(userId) {
  const rows = db.prepare("SELECT id,name,platform,role,site_url,is_default,persona,topics,overrides,enabled,creds FROM destinations WHERE user_id=? ORDER BY role, is_default DESC, created_at").all(uid(userId));
  return rows.map((d) => { const has = !!(d.creds && d.creds.length); delete d.creds; return { ...d, overrides: _parseOv(d.overrides), enabled: d.enabled !== 0, has_creds: has }; });
}
export function getDestination(userId, id) {
  const d = db.prepare("SELECT * FROM destinations WHERE user_id=? AND id=?").get(uid(userId), id);
  if (d && d.creds) { try { d.creds = JSON.parse(dec(d.creds)); } catch { d.creds = {}; } }
  if (d) d.overrides = _parseOv(d.overrides);
  return d;
}
export function upsertDestination(userId, dst) {
  const id = dst.id || rid("acc");
  const creds = dst.creds ? enc(JSON.stringify(dst.creds)) : (dst.id ? undefined : "");
  const role = dst.role || "destination";
  // 같은 역할 내 기본 1개
  if (dst.is_default) db.prepare("UPDATE destinations SET is_default=0 WHERE user_id=? AND role=?").run(uid(userId), role);
  const ex = db.prepare("SELECT id FROM destinations WHERE user_id=? AND id=?").get(uid(userId), id);
  const persona = dst.persona !== undefined ? dst.persona : null;
  const topics = dst.topics !== undefined ? dst.topics : null;
  const overrides = dst.overrides !== undefined ? JSON.stringify(dst.overrides || {}) : null;
  const enabled = dst.enabled === undefined ? null : (dst.enabled ? 1 : 0);   // 토글만 저장할 땐 다른 필드 안 건드리게 COALESCE
  if (ex) {
    db.prepare("UPDATE destinations SET name=?,platform=?,role=?,site_url=?,is_default=?,persona=COALESCE(?,persona),topics=COALESCE(?,topics),overrides=COALESCE(?,overrides),enabled=COALESCE(?,enabled)" + (creds !== undefined ? ",creds=?" : "") + " WHERE user_id=? AND id=?")
      .run(...[dst.name, dst.platform, role, dst.site_url, dst.is_default ? 1 : 0, persona, topics, overrides, enabled, ...(creds !== undefined ? [creds] : []), uid(userId), id]);
  } else {
    db.prepare("INSERT INTO destinations(id,user_id,name,platform,role,site_url,creds,is_default,persona,topics,overrides,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, uid(userId), dst.name, dst.platform, role, dst.site_url, creds || "", dst.is_default ? 1 : 0, persona || "", topics || "", overrides || "{}", enabled === null ? 1 : enabled, now());
  }
  return listDestinations(userId);
}
export function deleteDestination(userId, id) { db.prepare("DELETE FROM destinations WHERE user_id=? AND id=?").run(uid(userId), id); return listDestinations(userId); }
// 계정 on/off(휴재) 토글 — 다른 필드는 건드리지 않는다.
export function setDestinationEnabled(userId, id, enabled) {
  db.prepare("UPDATE destinations SET enabled=? WHERE user_id=? AND id=?").run(enabled ? 1 : 0, uid(userId), id);
  return listDestinations(userId);
}
// 생성 대상 계정 목록 (목적지 우선, 그다음 쿠션) — 계정별로 각각 다른 글 생성
export function accountsForGeneration(userId) {
  const rows = db.prepare("SELECT id,name,platform,role,site_url,persona,topics,overrides,enabled,creds FROM destinations WHERE user_id=? ORDER BY CASE role WHEN 'destination' THEN 0 WHEN 'both' THEN 1 ELSE 2 END, created_at").all(uid(userId));
  return rows.map((d) => { const has = !!(d.creds && d.creds.length); delete d.creds; return { ...d, overrides: _parseOv(d.overrides), enabled: d.enabled !== 0, has_creds: has }; });
}

// ---- 초안 → 목적지 니치 자동 분류 ----
export function classifyDestination(userId, text) {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  const dests = db.prepare("SELECT id,topics FROM destinations WHERE user_id=? AND (role='destination' OR role='both')").all(uid(userId));
  let best = null, bestScore = 0;
  for (const d of dests) {
    const toks = ((d.topics || "").toLowerCase().split(/[\s,]+/)).filter((x) => x.length >= 2);
    let s = 0; for (const k of toks) if (t.includes(k)) s++;
    if (s > bestScore) { bestScore = s; best = d.id; }
  }
  return bestScore > 0 ? best : null;
}

// ---- 초안함 ----
export function listDrafts(userId) { return db.prepare("SELECT id,date,status,title,content,keyword,source,dest_id FROM drafts WHERE user_id=? ORDER BY date DESC").all(uid(userId)); }
// 수천건 대비 검색·페이지네이션
export function listDraftsPage(userId, { q = "", status = "", offset = 0, limit = 50 } = {}) {
  let where = "user_id=?"; const args = [uid(userId)];
  if (status === "active") { where += " AND status IN ('new','failed')"; }   // 초안함 기본: 대기중 + 실패(재시도 대상)
  else if (status) { where += " AND status=?"; args.push(status); }
  if (q) { where += " AND (title LIKE ? OR keyword LIKE ?)"; args.push("%" + q + "%", "%" + q + "%"); }
  const total = db.prepare(`SELECT COUNT(*) c FROM drafts WHERE ${where}`).get(...args).c;
  const drafts = db.prepare(`SELECT id,date,status,title,keyword,source,dest_id,substr(content,1,160) AS preview FROM drafts WHERE ${where} ORDER BY date DESC LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 200), Math.max(0, offset));
  return { drafts, total };
}
export function getDraft(userId, id) { return db.prepare("SELECT * FROM drafts WHERE user_id=? AND id=?").get(uid(userId), id); }
export function countNewDrafts(userId) { return db.prepare("SELECT COUNT(*) c FROM drafts WHERE user_id=? AND status='new'").get(uid(userId)).c; }
export function addDraft(userId, d) {
  const dest_id = d.dest_id || classifyDestination(userId, (d.title || "") + " " + (d.keyword || "") + " " + (d.content || "").slice(0, 600));
  const rec = { id: rid("d"), user_id: uid(userId), date: now(), status: "new", title: d.title || "(제목없음)", content: d.content || "", keyword: d.keyword || "", source: d.source || "web", dest_id: dest_id || null };
  db.prepare("INSERT INTO drafts(id,user_id,date,status,title,content,keyword,source,dest_id) VALUES(@id,@user_id,@date,@status,@title,@content,@keyword,@source,@dest_id)").run(rec);
  try { addCoverage(userId, { title: rec.title, keyword: rec.keyword, kind: "draft", site: "초안함" }); } catch {}
  return rec;
}
export function deleteDraft(userId, id) { db.prepare("DELETE FROM drafts WHERE user_id=? AND id=?").run(uid(userId), id); }
export function setDraftStatus(userId, id, status) { db.prepare("UPDATE drafts SET status=? WHERE user_id=? AND id=?").run(status, uid(userId), id); }
// 자동 처리 대상: 들어온(mcp/ai) 새 초안 (전 사용자, 소량씩) — 예약(대기/실행/완료)에 물린 초안은 SQL에서 제외
export function newAutoDrafts(limit = 5) {
  return db.prepare("SELECT d.* FROM drafts d WHERE d.status='new' AND d.source IN ('mcp','ai-draft') AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.draft_id=d.id AND s.status IN ('pending','running','done')) ORDER BY d.date LIMIT ?").all(limit);
}
// 이 초안이 예약(대기/실행중)에 이미 물려있나 → 자동처리 중복 방지
export function draftHasSchedule(userId, draftId) { return !!db.prepare("SELECT 1 FROM schedules WHERE user_id=? AND draft_id=? AND status IN ('pending','running') LIMIT 1").get(uid(userId), draftId); }

// ---- 발행 자산(연관 링크 소스) ----
export function listAssets(userId) { return db.prepare("SELECT date,url,title,keyword,excerpt FROM assets WHERE user_id=? ORDER BY date DESC").all(uid(userId)); }
export function addAsset(userId, a) {
  if (!a.url) return;
  const ex = db.prepare("SELECT id FROM assets WHERE user_id=? AND url=?").get(uid(userId), a.url);
  if (ex) { db.prepare("UPDATE assets SET title=?,keyword=?,excerpt=?,date=? WHERE id=?").run(a.title || "", a.keyword || "", (a.excerpt || "").slice(0, 4000), now(), ex.id); return; }
  db.prepare("INSERT INTO assets(user_id,date,url,title,keyword,excerpt) VALUES(?,?,?,?,?,?)").run(uid(userId), now(), a.url, a.title || "", a.keyword || "", (a.excerpt || "").slice(0, 4000));
  try { addCoverage(userId, { title: a.title, keyword: a.keyword, kind: "published", site: (a.url || "").replace(/^https?:\/\//, "").split("/")[0], url: a.url }); } catch {}
}
export function deleteAsset(userId, url) { db.prepare("DELETE FROM assets WHERE user_id=? AND url=?").run(uid(userId), url); }
export function searchAssets(userId, query) {
  const kw = (query || "").toLowerCase().trim();
  const all = listAssets(userId);
  if (!kw) return all.slice(0, 8);
  const tokens = kw.split(/\s+/).filter((t) => t.length >= 2);
  return all.map((p) => { const hay = ((p.title || "") + " " + (p.keyword || "")).toLowerCase(); let s = 0; for (const t of tokens) if (hay.includes(t)) s++; if (hay.includes(kw)) s += 2; return { p, s }; })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.p);
}

// ---- 중복 방지(커버리지) ----
function _covNorm(s) { return String(s || "").toLowerCase().replace(/[^가-힣0-9a-z]/g, ""); }
function _covTokens(s) { return [...new Set(String(s || "").toLowerCase().replace(/[^가-힣0-9a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2))]; }
function _jaccard(a, b) { if (!a.length || !b.length) return 0; const B = new Set(b); let inter = 0; for (const t of a) if (B.has(t)) inter++; return inter / (a.length + b.length - inter); }

// 커버리지 1건 기록 (동일 제목 중복 저장 방지)
export function addCoverage(userId, c) {
  const title = c.title || ""; const keyword = c.keyword || "";
  const nk = _covNorm(keyword || title); const nt = _covNorm(title);
  if (!nk && !nt) return;
  if (nt) { const ex = db.prepare("SELECT id FROM coverage WHERE user_id=? AND norm_title=? LIMIT 1").get(uid(userId), nt); if (ex) return; }
  db.prepare("INSERT INTO coverage(user_id,norm_key,norm_title,keyword,title,site,kind,url,date) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(uid(userId), nk, nt, keyword, title, c.site || "", c.kind || "", c.url || "", now());
}

// 흔한 필러 토큰(주제 구분력 없음) — 이것만 겹치는 건 중복 아님
const _COV_STOP = new Set(["총정리","정리","최신","방법","완전정리","완전","특징","관계도","등장인물","줄거리","정보","가이드","신청","자격","지급일","지급액","지급","금액","조회","기준","절차","사건","사고","논란","이슈","화제","순위","best","top","이야기","관련","공개","언제","누구","무엇","이유","리뷰","후기","방송","드라마","예능","영화","배우","주연","출연","추천","뜻","정리했","한번에","완벽","가지","것","그","이"]);
function _covDistinct(s) { return _covTokens(s).filter((t) => !_COV_STOP.has(t)); }

// 중복/유사 판정:
//  - 동일 키워드(norm_key 정확일치) = 확정 중복
//  - 핵심 고유 토큰(근로장려금·사건명·인물명 등 len>=3) 공유 = 같은 주제(중복)
//  - 제목 토큰 Jaccard 높음 = 유사
// 키워드(주제)가 실제로 다르면(공유 고유 토큰 없음) 중복 아님.
export function findCoverage(userId, { keyword = "", title = "" } = {}) {
  const nk = _covNorm(keyword);
  const qDist = _covDistinct(keyword + " " + title);
  const qTitleTok = _covTokens(title || keyword);
  const rows = db.prepare("SELECT keyword,title,site,kind,url,date,norm_key FROM coverage WHERE user_id=? ORDER BY date DESC LIMIT 4000").all(uid(userId));
  const matches = [];
  for (const r of rows) {
    let score = 0, reason = "";
    if (nk && r.norm_key && r.norm_key === nk) { score = 1; reason = "same_keyword"; }
    else {
      const cDist = _covDistinct((r.keyword || "") + " " + (r.title || ""));
      const shared = qDist.filter((t) => cDist.includes(t));
      const strong = shared.filter((t) => t.length >= 3);   // 구분력 있는 공유 토큰
      if (strong.length) {
        const cont = shared.length / Math.min(qDist.length || 1, cDist.length || 1);
        score = Math.min(1, 0.62 + cont * 0.38); reason = "same_subject";
      } else if (qTitleTok.length) {
        const j = _jaccard(qTitleTok, _covTokens(r.title)); if (j >= 0.55) { score = j; reason = "similar_title"; }
      }
    }
    if (score > 0) matches.push({ title: r.title, keyword: r.keyword, site: r.site, kind: r.kind, url: r.url, date: r.date, score: Math.round(score * 100) / 100, reason });
  }
  matches.sort((a, b) => b.score - a.score);
  const dup = matches.some((m) => m.reason === "same_keyword" || (m.reason === "same_subject" && m.score >= 0.62) || m.score >= 0.7);
  return { duplicate: dup, top: matches.slice(0, 8) };
}

// 최근 다룬 주제 목록(제목/키워드) — 자동 루틴이 주제 고를 때 중복 회피용
export function recentCoverage(userId, n = 40) {
  const rows = db.prepare("SELECT title, keyword FROM coverage WHERE user_id=? ORDER BY date DESC LIMIT ?").all(uid(userId), Math.min(n, 200));
  const seen = new Set(), out = [];
  for (const r of rows) { const s = (r.keyword || r.title || "").trim(); if (s && !seen.has(s)) { seen.add(s); out.push(s); } }
  return out;
}

// 기존 발행글/자산 백필용 일괄 등록
export function importCoverage(userId, items, meta = {}) {
  let n = 0;
  for (const it of items || []) { try { addCoverage(userId, { title: it.title, keyword: it.keyword || "", site: meta.site || it.site || "", kind: meta.kind || "imported", url: it.url || "" }); n++; } catch {} }
  return n;
}

// ---- 작업 항목(칸반) ----
export function listWorkItems(userId, status) {
  return status
    ? db.prepare("SELECT id,draft_id,target,destination_id,title,status,note,published_url,published_id,publish_mode,publish_at,updated_at FROM work_items WHERE user_id=? AND status=? ORDER BY updated_at DESC").all(uid(userId), status)
    : db.prepare("SELECT id,draft_id,target,destination_id,title,status,note,published_url,published_id,publish_mode,publish_at,updated_at FROM work_items WHERE user_id=? AND status!='published' ORDER BY updated_at DESC").all(uid(userId));
}
// (초안×목적지) 기존 작업항목 찾기 — 실패분 재생성 시 같은 행 갱신용
export function findWorkItemByDraftDest(userId, draftId, destId) {
  return db.prepare("SELECT * FROM work_items WHERE user_id=? AND draft_id=? AND destination_id=? ORDER BY updated_at DESC LIMIT 1").get(uid(userId), draftId, destId);
}
// 예약 발행 설정 + 실행 큐(전 사용자, 시간 도래분)
export function setWorkPublishAt(userId, id, iso) { db.prepare("UPDATE work_items SET publish_at=?, updated_at=? WHERE user_id=? AND id=?").run(iso || null, now(), uid(userId), id); }
export function dueWorkPublish(nowIso) { return db.prepare("SELECT id,user_id,destination_id,target FROM work_items WHERE status='generated' AND publish_at IS NOT NULL AND publish_at<=? ORDER BY publish_at").all(nowIso); }
export function getWorkItem(userId, id) {
  const w = db.prepare("SELECT * FROM work_items WHERE user_id=? AND id=?").get(uid(userId), id);
  if (w && w.article_json) { try { w.article = JSON.parse(w.article_json); } catch {} }
  return w;
}
// ---- 키워드 대기열 (예약형 클라우드 에이전트가 next_topic으로 소진) ----
export function addTopic(userId, keyword, note) {
  const id = rid("t");
  db.prepare("INSERT INTO topic_queue(id,user_id,keyword,note,status,created_at) VALUES(?,?,?,?,'pending',?)").run(id, uid(userId), String(keyword || "").trim(), note || "", now());
  return { id, keyword, note: note || "", status: "pending" };
}
export function listTopics(userId) {
  return db.prepare("SELECT id,keyword,note,status,created_at,used_at FROM topic_queue WHERE user_id=? ORDER BY (status='pending') DESC, created_at").all(uid(userId));
}
export function nextTopic(userId) {   // 가장 오래된 pending 하나 반환 + used 처리
  const t = db.prepare("SELECT * FROM topic_queue WHERE user_id=? AND status='pending' ORDER BY created_at LIMIT 1").get(uid(userId));
  if (!t) return null;
  db.prepare("UPDATE topic_queue SET status='used', used_at=? WHERE id=?").run(now(), t.id);
  return t;
}
export function deleteTopic(userId, id) { db.prepare("DELETE FROM topic_queue WHERE user_id=? AND id=?").run(uid(userId), id); }
export function pendingTopicCount(userId) { return db.prepare("SELECT COUNT(*) c FROM topic_queue WHERE user_id=? AND status='pending'").get(uid(userId)).c; }
// 목적지 니치 목록(트렌드 자동선정 폴백용)
export function nicheList(userId) {
  return db.prepare("SELECT name, topics, role FROM destinations WHERE user_id=?").all(uid(userId))
    .filter((r) => (r.role || "destination") !== "cushion" && (r.topics || "").trim())
    .map((r) => ({ blog: r.name, niche: r.topics }));
}
// ---- 조회수 스냅샷(발행글 시계열) ----
// 발행된 워드프레스 글(수집 대상): published_id 있는 것
export function publishedForStats(userId) {
  return db.prepare("SELECT id,target,destination_id,title,published_url,published_id,updated_at,created_at FROM work_items WHERE user_id=? AND status='published' AND published_id IS NOT NULL AND published_id<>'' AND target='wordpress'").all(uid(userId));
}
export function addStatSnapshot(userId, workId, views, ts) {
  db.prepare("INSERT INTO post_stats(user_id,work_id,ts,views) VALUES(?,?,?,?)").run(uid(userId), workId, ts, views | 0);
}
export function statSnapshotsSince(userId, sinceIso) {
  return db.prepare("SELECT work_id,ts,views FROM post_stats WHERE user_id=? AND ts>=? ORDER BY ts").all(uid(userId), sinceIso);
}
export function pruneStats(cutoffIso) { db.prepare("DELETE FROM post_stats WHERE ts<?").run(cutoffIso); }
export function usersWithPublishedStats() { return db.prepare("SELECT DISTINCT user_id FROM work_items WHERE status='published' AND target='wordpress' AND published_id IS NOT NULL AND published_id<>''").all().map((r) => r.user_id); }
export function lastStatTs(userId) { const r = db.prepare("SELECT MAX(ts) m FROM post_stats WHERE user_id=?").get(uid(userId)); return r && r.m ? r.m : null; }
// 초안별 결과물 묶음: 모든 work_item(전 상태) + 관련 초안 제목맵
export function workItemsByDraft(userId) {
  const items = db.prepare("SELECT id,draft_id,target,destination_id,title,status,note,published_url,published_id,publish_mode,publish_at,updated_at FROM work_items WHERE user_id=? ORDER BY updated_at DESC").all(uid(userId));
  const ids = [...new Set(items.map((i) => i.draft_id).filter(Boolean))];
  const drafts = {};
  for (const id of ids) { const d = db.prepare("SELECT id,title,keyword,status,date FROM drafts WHERE user_id=? AND id=?").get(uid(userId), id); if (d) drafts[id] = d; }
  return { items, drafts };
}
export function upsertWorkItem(userId, w) {
  const id = w.id || rid("w");
  const ex = db.prepare("SELECT id FROM work_items WHERE user_id=? AND id=?").get(uid(userId), id);
  const aj = w.article ? JSON.stringify(w.article) : (w.article_json || null);
  const note = (w.note === undefined ? null : w.note);   // COALESCE: 미전달 시 기존 유지, ''전달 시 클리어
  if (ex) {
    db.prepare("UPDATE work_items SET target=?,destination_id=?,title=?,article_json=COALESCE(?,article_json),html=COALESCE(?,html),status=?,note=COALESCE(?,note),published_url=COALESCE(?,published_url),published_id=COALESCE(?,published_id),publish_mode=COALESCE(?,publish_mode),updated_at=? WHERE user_id=? AND id=?")
      .run(w.target, w.destination_id || null, w.title || "", aj, w.html ?? null, w.status || "generated", note, w.published_url || null, w.published_id || null, w.publish_mode || null, now(), uid(userId), id);
  } else {
    db.prepare("INSERT INTO work_items(id,user_id,draft_id,target,destination_id,title,article_json,html,status,note,published_url,published_id,publish_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, uid(userId), w.draft_id || null, w.target, w.destination_id || null, w.title || "", aj, w.html || "", w.status || "generated", note, w.published_url || null, w.published_id || null, w.publish_mode || null, now(), now());
  }
  return id;
}
export function deleteWorkItem(userId, id) { db.prepare("DELETE FROM work_items WHERE user_id=? AND id=?").run(uid(userId), id); }

// ---- 자동화 예약 ----
export function listSchedules(userId) { return db.prepare("SELECT * FROM schedules WHERE user_id=? ORDER BY run_at IS NULL, run_at, created_at DESC").all(uid(userId)); }
export function getSchedule(userId, id) { return db.prepare("SELECT * FROM schedules WHERE user_id=? AND id=?").get(uid(userId), id); }
export function upsertSchedule(userId, s) {
  const id = s.id || rid("sch");
  const ex = db.prepare("SELECT id FROM schedules WHERE user_id=? AND id=?").get(uid(userId), id);
  const row = {
    name: s.name || "", source: s.source || "keyword", draft_id: s.draft_id || null,
    keywords: s.keywords || "", run_at: s.run_at || null,
    scope: s.scope || "destination", publish: s.publish || "none",
    dest_id: s.dest_id || null,
    enabled: s.enabled ? 1 : 0,
    // 편집 저장 시 재실행 가능하도록 상태 초기화(완료/오류였어도 pending 으로)
    status: s.status || "pending"
  };
  if (ex) db.prepare("UPDATE schedules SET name=@name,source=@source,draft_id=@draft_id,keywords=@keywords,run_at=@run_at,scope=@scope,publish=@publish,dest_id=@dest_id,enabled=@enabled,status=@status WHERE id=@id AND user_id=@uid").run({ ...row, id, uid: uid(userId) });
  else db.prepare("INSERT INTO schedules(id,user_id,name,source,draft_id,keywords,run_at,scope,publish,dest_id,enabled,status,created_at) VALUES(@id,@uid,@name,@source,@draft_id,@keywords,@run_at,@scope,@publish,@dest_id,@enabled,@status,@created)").run({ ...row, id, uid: uid(userId), created: now() });
  return listSchedules(userId);
}
export function deleteSchedule(userId, id) { db.prepare("DELETE FROM schedules WHERE user_id=? AND id=?").run(uid(userId), id); return listSchedules(userId); }
// 실행 엔진용: 실행할 때가 된 예약(전 사용자)
export function dueSchedules(nowIso) {
  return db.prepare("SELECT * FROM schedules WHERE enabled=1 AND status='pending' AND run_at IS NOT NULL AND run_at<=? ORDER BY run_at").all(nowIso);
}
export function setScheduleStatus(id, status, result) {
  db.prepare("UPDATE schedules SET status=?, result=?, last_run=? WHERE id=?").run(status, (result || "").slice(0, 500), now(), id);
}
// 완료된 예약 자동 정리(몇 시간 뒤 사라지게)
export function pruneDoneSchedules(cutoffIso) { db.prepare("DELETE FROM schedules WHERE status='done' AND last_run IS NOT NULL AND last_run<?").run(cutoffIso); }
// 서버 시작 시 'running' 고착(재시작 여파) → 'pending' 복구
export function recoverRunningSchedules() { const r = db.prepare("UPDATE schedules SET status='pending' WHERE status='running'").run(); return r.changes; }

export default db;
