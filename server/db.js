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
CREATE INDEX IF NOT EXISTS idx_dest_user ON destinations(user_id);
CREATE INDEX IF NOT EXISTS idx_sched_user ON schedules(user_id);
`);
// 계정 역할(목적지/쿠션/겸용) 컬럼 (기존 테이블에도 추가)
try { db.exec("ALTER TABLE destinations ADD COLUMN role TEXT DEFAULT 'destination'"); } catch {}
// 발행 방식(auto=자동발행 / manual=HTML 수동) 컬럼
try { db.exec("ALTER TABLE work_items ADD COLUMN publish_mode TEXT"); } catch {}
// 예약 확장 컬럼 (초안/키워드 소스, 실행일시, 범위, 발행수준, 상태)
for (const col of [
  "source TEXT DEFAULT 'keyword'", "draft_id TEXT", "run_at TEXT",
  "scope TEXT DEFAULT 'destination'", "publish TEXT DEFAULT 'none'",
  "status TEXT DEFAULT 'pending'", "last_run TEXT", "result TEXT"
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
const SECRET_FIELDS = ["anthropicKey", "kieKey", "naverClientId", "naverClientSecret"];
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
export function listDestinations(userId) {
  const rows = db.prepare("SELECT id,name,platform,role,site_url,is_default,creds FROM destinations WHERE user_id=? ORDER BY role, is_default DESC, created_at").all(uid(userId));
  return rows.map((d) => { const has = !!(d.creds && d.creds.length); delete d.creds; return { ...d, has_creds: has }; });
}
export function getDestination(userId, id) {
  const d = db.prepare("SELECT * FROM destinations WHERE user_id=? AND id=?").get(uid(userId), id);
  if (d && d.creds) { try { d.creds = JSON.parse(dec(d.creds)); } catch { d.creds = {}; } }
  return d;
}
export function upsertDestination(userId, dst) {
  const id = dst.id || rid("acc");
  const creds = dst.creds ? enc(JSON.stringify(dst.creds)) : (dst.id ? undefined : "");
  const role = dst.role || "destination";
  // 같은 역할 내 기본 1개
  if (dst.is_default) db.prepare("UPDATE destinations SET is_default=0 WHERE user_id=? AND role=?").run(uid(userId), role);
  const ex = db.prepare("SELECT id FROM destinations WHERE user_id=? AND id=?").get(uid(userId), id);
  if (ex) {
    db.prepare("UPDATE destinations SET name=?,platform=?,role=?,site_url=?,is_default=?" + (creds !== undefined ? ",creds=?" : "") + " WHERE user_id=? AND id=?")
      .run(...[dst.name, dst.platform, role, dst.site_url, dst.is_default ? 1 : 0, ...(creds !== undefined ? [creds] : []), uid(userId), id]);
  } else {
    db.prepare("INSERT INTO destinations(id,user_id,name,platform,role,site_url,creds,is_default,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(id, uid(userId), dst.name, dst.platform, role, dst.site_url, creds || "", dst.is_default ? 1 : 0, now());
  }
  return listDestinations(userId);
}
export function deleteDestination(userId, id) { db.prepare("DELETE FROM destinations WHERE user_id=? AND id=?").run(uid(userId), id); return listDestinations(userId); }
// 생성 대상 계정 목록 (목적지 우선, 그다음 쿠션) — 계정별로 각각 다른 글 생성
export function accountsForGeneration(userId) {
  const rows = db.prepare("SELECT id,name,platform,role,site_url,creds FROM destinations WHERE user_id=? ORDER BY CASE role WHEN 'destination' THEN 0 WHEN 'both' THEN 1 ELSE 2 END, created_at").all(uid(userId));
  return rows.map((d) => { const has = !!(d.creds && d.creds.length); delete d.creds; return { ...d, has_creds: has }; });
}

// ---- 초안함 ----
export function listDrafts(userId) { return db.prepare("SELECT id,date,status,title,content,keyword,source FROM drafts WHERE user_id=? ORDER BY date DESC").all(uid(userId)); }
// 수천건 대비 검색·페이지네이션
export function listDraftsPage(userId, { q = "", status = "", offset = 0, limit = 50 } = {}) {
  let where = "user_id=?"; const args = [uid(userId)];
  if (status) { where += " AND status=?"; args.push(status); }
  if (q) { where += " AND (title LIKE ? OR keyword LIKE ?)"; args.push("%" + q + "%", "%" + q + "%"); }
  const total = db.prepare(`SELECT COUNT(*) c FROM drafts WHERE ${where}`).get(...args).c;
  const drafts = db.prepare(`SELECT id,date,status,title,keyword,source,substr(content,1,160) AS preview FROM drafts WHERE ${where} ORDER BY date DESC LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 200), Math.max(0, offset));
  return { drafts, total };
}
export function getDraft(userId, id) { return db.prepare("SELECT * FROM drafts WHERE user_id=? AND id=?").get(uid(userId), id); }
export function countNewDrafts(userId) { return db.prepare("SELECT COUNT(*) c FROM drafts WHERE user_id=? AND status='new'").get(uid(userId)).c; }
export function addDraft(userId, d) {
  const rec = { id: rid("d"), user_id: uid(userId), date: now(), status: "new", title: d.title || "(제목없음)", content: d.content || "", keyword: d.keyword || "", source: d.source || "web" };
  db.prepare("INSERT INTO drafts(id,user_id,date,status,title,content,keyword,source) VALUES(@id,@user_id,@date,@status,@title,@content,@keyword,@source)").run(rec);
  return rec;
}
export function deleteDraft(userId, id) { db.prepare("DELETE FROM drafts WHERE user_id=? AND id=?").run(uid(userId), id); }
export function setDraftStatus(userId, id, status) { db.prepare("UPDATE drafts SET status=? WHERE user_id=? AND id=?").run(status, uid(userId), id); }

// ---- 발행 자산(연관 링크 소스) ----
export function listAssets(userId) { return db.prepare("SELECT date,url,title,keyword,excerpt FROM assets WHERE user_id=? ORDER BY date DESC").all(uid(userId)); }
export function addAsset(userId, a) {
  if (!a.url) return;
  const ex = db.prepare("SELECT id FROM assets WHERE user_id=? AND url=?").get(uid(userId), a.url);
  if (ex) { db.prepare("UPDATE assets SET title=?,keyword=?,excerpt=?,date=? WHERE id=?").run(a.title || "", a.keyword || "", (a.excerpt || "").slice(0, 4000), now(), ex.id); return; }
  db.prepare("INSERT INTO assets(user_id,date,url,title,keyword,excerpt) VALUES(?,?,?,?,?,?)").run(uid(userId), now(), a.url, a.title || "", a.keyword || "", (a.excerpt || "").slice(0, 4000));
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

// ---- 작업 항목(칸반) ----
export function listWorkItems(userId, status) {
  return status
    ? db.prepare("SELECT id,draft_id,target,destination_id,title,status,published_url,publish_mode,updated_at FROM work_items WHERE user_id=? AND status=? ORDER BY updated_at DESC").all(uid(userId), status)
    : db.prepare("SELECT id,draft_id,target,destination_id,title,status,published_url,publish_mode,updated_at FROM work_items WHERE user_id=? AND status!='published' ORDER BY updated_at DESC").all(uid(userId));
}
export function getWorkItem(userId, id) {
  const w = db.prepare("SELECT * FROM work_items WHERE user_id=? AND id=?").get(uid(userId), id);
  if (w && w.article_json) { try { w.article = JSON.parse(w.article_json); } catch {} }
  return w;
}
export function upsertWorkItem(userId, w) {
  const id = w.id || rid("w");
  const ex = db.prepare("SELECT id FROM work_items WHERE user_id=? AND id=?").get(uid(userId), id);
  const aj = w.article ? JSON.stringify(w.article) : (w.article_json || null);
  if (ex) {
    db.prepare("UPDATE work_items SET target=?,destination_id=?,title=?,article_json=COALESCE(?,article_json),html=COALESCE(?,html),status=?,published_url=COALESCE(?,published_url),publish_mode=COALESCE(?,publish_mode),updated_at=? WHERE user_id=? AND id=?")
      .run(w.target, w.destination_id || null, w.title || "", aj, w.html ?? null, w.status || "generated", w.published_url || null, w.publish_mode || null, now(), uid(userId), id);
  } else {
    db.prepare("INSERT INTO work_items(id,user_id,draft_id,target,destination_id,title,article_json,html,status,published_url,publish_mode,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, uid(userId), w.draft_id || null, w.target, w.destination_id || null, w.title || "", aj, w.html || "", w.status || "generated", w.published_url || null, w.publish_mode || null, now(), now());
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
    enabled: s.enabled ? 1 : 0,
    // 편집 저장 시 재실행 가능하도록 상태 초기화(완료/오류였어도 pending 으로)
    status: s.status || "pending"
  };
  if (ex) db.prepare("UPDATE schedules SET name=@name,source=@source,draft_id=@draft_id,keywords=@keywords,run_at=@run_at,scope=@scope,publish=@publish,enabled=@enabled,status=@status WHERE id=@id AND user_id=@uid").run({ ...row, id, uid: uid(userId) });
  else db.prepare("INSERT INTO schedules(id,user_id,name,source,draft_id,keywords,run_at,scope,publish,enabled,status,created_at) VALUES(@id,@uid,@name,@source,@draft_id,@keywords,@run_at,@scope,@publish,@enabled,@status,@created)").run({ ...row, id, uid: uid(userId), created: now() });
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

export default db;
