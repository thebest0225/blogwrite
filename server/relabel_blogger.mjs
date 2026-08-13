// 기존 블로거 발행글 라벨 소급 적용(백필).
// - 저장된 work_items(article_json)의 태그를 콘텐츠 라벨로 사용(태그 없으면 카테고리 폴백).
// - postId 없으면 published_url 로 bypath 역추적.
// - PATCH 로 labels 만 갱신(제목/본문 건드리지 않음).
// 사용법:
//   node relabel_blogger.mjs          # dry-run (무엇이 바뀔지 미리보기만)
//   node relabel_blogger.mjs --apply  # 실제 적용
import "dotenv/config";
import D from "better-sqlite3";

const APPLY = process.argv.includes("--apply");
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID, GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function labelsFromArticle(a) {
  if (!a) return [];
  let out = Array.isArray(a.tags) ? a.tags.map((t) => String(t || "").trim()).filter(Boolean) : [];
  if (!out.length && a.category) out = [String(a.category).trim()].filter(Boolean);
  return [...new Set(out)].slice(0, 8);
}
async function accessToken(refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET, grant_type: "refresh_token" }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error(j.error_description || "액세스 토큰 갱신 실패");
  return j.access_token;
}

const db = new D("blogwrite.db");
const dest = db.prepare("SELECT id,name,creds FROM destinations WHERE platform='blogger'").get();
if (!dest) { console.error("블로거 목적지가 없습니다."); process.exit(1); }
let creds = {}; try { creds = JSON.parse(dest.creds || "{}"); } catch {}
const rt = creds.refreshToken, blogId = creds.blogId;
if (!rt || !blogId) {
  console.error(`❌ 블로거 계정 '${dest.name}' 이(가) 연결되어 있지 않습니다(refreshToken/blogId 없음).`);
  console.error("   → blogwrite 계정 관리에서 '구글 연결'을 먼저 하고 다시 실행하세요.");
  process.exit(1);
}

const rows = db.prepare("SELECT id,title,published_id,published_url,article_json FROM work_items WHERE target='blogger' AND status='published'").all();
console.log(`대상 발행글: ${rows.length}건 · 모드: ${APPLY ? "APPLY(실제 적용)" : "DRY-RUN(미리보기)"}`);

const token = await accessToken(rt);
const auth = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
let ok = 0, skip = 0, fail = 0;

for (const w of rows) {
  let a = {}; try { a = JSON.parse(w.article_json || "{}"); } catch {}
  const labels = labelsFromArticle(a);
  if (!labels.length) { console.log(`  · 건너뜀(라벨 없음): ${(w.title || "").slice(0, 30)}`); skip++; continue; }

  let postId = w.published_id;
  if (!postId && w.published_url) {
    try {
      const p = new URL(w.published_url).pathname;
      const br = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/bypath?path=${encodeURIComponent(p)}`, { headers: auth });
      const bj = await br.json(); if (bj && bj.id) postId = bj.id;
    } catch {}
  }
  if (!postId) { console.log(`  ✗ postId 못 찾음: ${(w.title || "").slice(0, 30)} (${w.published_url || "url없음"})`); fail++; continue; }

  if (!APPLY) { console.log(`  [미리보기] ${(w.title || "").slice(0, 34)}\n     → ${labels.join(", ")}`); ok++; continue; }

  try {
    const r = await fetch(`https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/${postId}`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ labels }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error?.message || r.status);
    console.log(`  ✓ ${(w.title || "").slice(0, 34)} → ${labels.join(", ")}`);
    ok++;
    await sleep(600); // 레이트리밋 완화
  } catch (e) { console.log(`  ✗ 실패: ${(w.title || "").slice(0, 30)} — ${e.message}`); fail++; }
}

console.log(`\n완료: 성공/미리보기 ${ok} · 건너뜀 ${skip} · 실패 ${fail}`);
if (!APPLY) console.log("실제로 적용하려면: node relabel_blogger.mjs --apply");
db.close();
