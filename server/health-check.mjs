/**
 * 블로그라이터 발행 경로 건강검진 (2026-08-20 신설)
 *
 * 왜 만들었나 — sesangjs(블로거) 가 2026-08-04 에 OAuth refresh_token 만료(invalid_grant)로
 *   발행이 죽었는데, 실패가 work_items.note 에도 안 남고 알림도 없어 **16일간 조용히 멈춰** 있었다.
 *   이 스크립트가 매일 자격증명을 실제로 찔러보고, 문제 있을 때만 텔레그램으로 알린다.
 *
 * 검사 항목
 *   1) blogger  — refresh_token 으로 액세스 토큰 갱신되는지 (죽으면 invalid_grant)
 *   2) wordpress— appPassword 로 /wp-json/wp/v2/users/me 200 나오는지
 *   3) naver    — 자동 확인 불가(확장 경유) → 건너뜀
 *   4) 정체된 work_items — published 아닌 채 24시간 넘은 건
 *
 * 종료코드 0=정상, 1=문제 있음.  --quiet 주면 정상일 때 출력 없음(cron 용).
 */
import { dec } from './db.js';
import Database from 'better-sqlite3';

const QUIET = process.argv.includes('--quiet');
const DB_PATH = new URL('./blogwrite.db', import.meta.url).pathname;
const db = new Database(DB_PATH, { readonly: true });

const TG_TOKEN = process.env.TG_TOKEN || '8215466645:AAE0BQA3BK62IoztZfPZHeBDYxPZi27YQko';
const TG_CHAT  = process.env.TG_CHAT  || '7076008136';
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const problems = [];
const lines = [];
const log = (s) => { lines.push(s); if (!QUIET) console.log(s); };

async function checkBlogger(d, creds) {
  if (!GOOGLE_ID || !GOOGLE_SECRET) return `⚠️ ${d.name}: GOOGLE_CLIENT_ID/SECRET 없어 검사 불가`;
  if (!creds.refreshToken) return `❌ ${d.name}: refreshToken 없음 — 구글 연결 필요`;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: creds.refreshToken, client_id: GOOGLE_ID,
                                client_secret: GOOGLE_SECRET, grant_type: 'refresh_token' }),
  }).catch((e) => ({ ok: false, json: async () => ({ error: String(e.message) }) }));
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) {
    return `❌ ${d.name}: 토큰 갱신 실패 (${j.error || '?'}) — 재인증 필요\n`
         + `   → https://write.mangois.love/api/oauth/blogger/start 접속해 구글 재연결`;
  }
  return null;
}

async function checkWordpress(d, creds) {
  if (!creds.user || !creds.appPassword) return `❌ ${d.name}: user/appPassword 없음`;
  const url = `${d.site_url.replace(/\/$/, '')}/wp-json/wp/v2/users/me?context=edit`;
  const auth = Buffer.from(`${creds.user}:${creds.appPassword}`).toString('base64');
  let r;
  try {
    r = await fetch(url, { headers: { Authorization: 'Basic ' + auth }, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return `❌ ${d.name}: 접속 불가 (${String(e.message).slice(0, 60)})`;
  }
  if (r.status === 401 || r.status === 403) return `❌ ${d.name}: 인증 거부 (HTTP ${r.status}) — 앱 비밀번호 재발급 필요`;
  if (!r.ok) return `❌ ${d.name}: HTTP ${r.status}`;
  return null;
}

log(`■ 블로그라이터 발행 경로 점검 — ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`);

for (const d of db.prepare('SELECT id,name,platform,site_url,creds,enabled FROM destinations').all()) {
  if (!d.enabled) { log(`  ⏸ ${d.name} — 비활성(enabled=0), 건너뜀`); continue; }
  let creds = {};
  try { creds = JSON.parse(dec(d.creds)); } catch { creds = {}; }

  let err = null;
  if (d.platform === 'blogger')        err = await checkBlogger(d, creds);
  else if (d.platform === 'wordpress') err = await checkWordpress(d, creds);
  else { log(`  – ${d.name} (${d.platform}) — 자동검사 대상 아님`); continue; }

  if (err) { problems.push(err); log('  ' + err.replace(/\n/g, '\n  ')); }
  else log(`  ✅ ${d.name} (${d.platform})`);
}

// 정체된 발행 건 — 3일 넘게 published 가 아닌 것
// 네이버는 MangoAuto 확장(브라우저 열려 있어야 함)이 처리하므로 대기가 정상일 수 있다
// → 문제로 세지 않고 정보로만 알린다. 자동발행 대상(wordpress/blogger)만 문제로 집계.
const platformOf = Object.fromEntries(
  db.prepare('SELECT id, platform FROM destinations').all().map((d) => [d.id, d.platform]));
const stuck = db.prepare(`
  SELECT w.destination_id, w.status, count(*) n, min(w.created_at) oldest
  FROM work_items w
  WHERE w.status <> 'published' AND w.created_at < datetime('now','-3 days')
  GROUP BY w.destination_id, w.status`).all();
if (stuck.length) {
  log('  ── 정체된 발행 건 (3일+ 미발행)');
  for (const s of stuck) {
    const auto = ['wordpress', 'blogger'].includes(platformOf[s.destination_id]);
    const msg = `${auto ? '⚠️' : 'ℹ️'} ${s.destination_id}: '${s.status}' ${s.n}건 정체 (최초 ${String(s.oldest).slice(0, 16)})`
              + (auto ? '' : ' — 확장 대기중일 수 있음');
    if (auto) problems.push(msg);
    log('     ' + msg);
  }
}

// 최근 3일간 발행 0건인 활성 대상 — 루틴이 그 사이트를 빼먹고 있다는 신호
const silent = db.prepare(`
  SELECT d.id, d.name FROM destinations d
  WHERE d.enabled=1 AND d.platform IN ('wordpress','blogger')
    AND NOT EXISTS (SELECT 1 FROM work_items w
                    WHERE w.destination_id=d.id AND w.status='published'
                      AND w.created_at >= datetime('now','-3 days'))`).all();
for (const s of silent) {
  const msg = `⚠️ ${s.name}: 최근 3일간 발행 0건 — 루틴에서 빠졌는지 확인`;
  problems.push(msg); log('     ' + msg);
}

if (problems.length) {
  log(`\n❌ 문제 ${problems.length}건`);
  // --quiet 이어도 문제가 있으면 전체 리포트를 출력한다 (cron 이 로그·메일로 남길 수 있게).
  if (QUIET) console.log(lines.join('\n'));
  if (TG_TOKEN && TG_CHAT) {
    const text = '🩺 블로그라이터 점검 실패\n\n' + problems.join('\n');
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ chat_id: TG_CHAT, text }),
    }).catch(() => {});
  }
  process.exit(1);
}
log('\n✅ 전부 정상');
process.exit(0);
