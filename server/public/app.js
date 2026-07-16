// 블로그 오토라이터 — 웹앱 프론트 (파이프라인: 원본 1개 → 블로거·네이버·워드프레스 3종)
import { buildBloggerMain, buildCushionPrompt } from "./lib/prompts.js";
import { buildHtml, buildPreviewDoc } from "./lib/html-builder.js";
import { composeThumbnail } from "./lib/thumbnail.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let config = { kieEnabled: false, wpEnabled: false, naverEnabled: false };
let results = { blogger: null, naver: null, wp: null };   // 각 {article, html, resolvedType, keyword}
let activeTarget = null;
let lastMyPosts = [], lastSources = [], lastMainUrl = "";

const ASPECT_BY_TARGET = { blogger: "4:3", wp: "4:3", naver: "1:1" };
const LABEL = { blogger: "블로거 메인", naver: "네이버", wp: "워드프레스" };

const DEFAULT_THUMB_STYLE =
`Korean YouTube-style clickbait thumbnail, 16:9 aspect ratio. Cinematic, high-contrast dramatic lighting with a moody atmospheric background that fits the article's actual topic. Big HEAVY bold Korean sans-serif headline with a thick black-and-white outline, placed in the TOP area with the bottom third kept clear; the Korean text must be large and PERFECTLY spelled. Clean, premium, readable at small size. NO cartoon mascots, stock graphs, arrows, flags, finance elements. Imagery matches the real subject.`;

const DEFAULTS = {
  kieChatModel: "claude-sonnet-5", imageResolution: "1K",
  thumbnailMode: "ai_full", thumbnailStylePrompt: "", overlayAccent: "#ff2d55",
  linkMode: "search", myBlogUrl: "", defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자", authorBio: "",
  adEnabled: false, adCode: "", internalLinks: false, generateImages: true, imageCount: 1
};

// ---------- API ----------
async function apiJson(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { let j = {}; try { j = await r.json(); } catch {} location.href = j.login || "https://mangois.love/"; throw new Error("로그인 필요"); }
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { throw new Error(t.slice(0, 200)); }
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const chatComplete = ({ system, user, maxTokens, model }) =>
  apiJson("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system, user, maxTokens, model }) }).then((j) => j.content);
const generateImage = ({ prompt, aspectRatio, resolution }) =>
  apiJson("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspect: aspectRatio, resolution }) }).then((j) => j.url);
const editImage = ({ imageUrl, prompt, aspectRatio, resolution }) =>
  apiJson("/api/image-edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl, prompt, aspect: aspectRatio, resolution }) }).then((j) => j.url);
const apiTrends = (force) => apiJson(`/api/trends${force ? "?force=1" : ""}`);
const storeList = () => apiJson("/api/store").then((j) => j.records || []);
const storeAdd = (rec) => apiJson("/api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) }).catch(() => {});
const storeDelete = (url) => apiJson("/api/store/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {});
const wpCreatePost = ({ title, content, status }) => apiJson("/api/wp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, status }) });

async function getSettings() { try { return { ...DEFAULTS, ...(await apiJson("/api/settings")) }; } catch { return { ...DEFAULTS }; } }
async function saveSettings(patch) { await apiJson("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); }

init();

async function init() {
  try { config = await apiJson("/api/config"); } catch {}
  settings = await getSettings();
  $("genImages").checked = settings.generateImages;
  $("imgCount").value = String(settings.imageCount || 1);
  if (settings.myBlogUrl && !$("bloggerUrl").value) $("bloggerUrl").value = settings.myBlogUrl;
  if (!config.kieEnabled) $("apiWarn").classList.remove("hidden");

  $("openOptions").addEventListener("click", openOptions);
  $("genBlogger").addEventListener("click", () => generate("blogger"));
  $("genNaver").addEventListener("click", () => generate("naver"));
  $("genWp").addEventListener("click", () => generate("wp"));
  document.querySelectorAll(".restab").forEach((b) => b.addEventListener("click", () => showResult(b.dataset.t)));
  $("editToggle").addEventListener("click", toggleEdit);
  $("copyBtn").addEventListener("click", onCopy);
  $("wpDraftBtn").addEventListener("click", () => wpPublish("draft"));
  $("wpPublishBtn").addEventListener("click", () => wpPublish("publish"));
  $("mainUrlSave").addEventListener("click", onSaveMainUrl);
  $("myPostAdd").addEventListener("click", onAddMyPost);
  $("myPostSearch").addEventListener("input", () => renderMyPosts());
  $("trendRefresh").addEventListener("click", () => renderTrends(true));
  $("trendBox").addEventListener("toggle", (e) => { if (e.target.open) renderTrends(false); });
  $("optClose").addEventListener("click", () => $("optionsDialog").close());
  $("optSave").addEventListener("click", onSaveOptions);

  renderMyPosts();
}

function setStatus(msg, isError = false) { const el = $("status"); el.textContent = msg; el.classList.remove("hidden"); el.classList.toggle("error", isError); }
function clearStatus() { $("status").classList.add("hidden"); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function deriveTopic() {
  const src = $("originalText").value || "";
  const first = src.split(/\n/).map((s) => s.replace(/^#+\s*/, "").replace(/[*_`>#]/g, "").trim()).find((s) => s.length > 1) || "";
  return first.slice(0, 40);
}
function getDestUrl() { return ($("bloggerUrl")?.value?.trim()) || settings.myBlogUrl || lastMainUrl || ""; }
function parseJson(raw) {
  let t = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s > 0 || e < t.length - 1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function tryParse(raw) { try { return parseJson(raw); } catch { return null; } }

// ---------- 설정 모달 ----------
function openOptions() {
  $("optChatModel").value = settings.kieChatModel || "claude-sonnet-5";
  $("optThumbMode").value = settings.thumbnailMode || "ai_full";
  $("optImgRes").value = settings.imageResolution || "1K";
  $("optLinkMode").value = settings.linkMode || "search";
  $("optAccent").value = settings.overlayAccent || "#ff2d55";
  $("optMyBlog").value = settings.myBlogUrl || "";
  $("optTone").value = settings.defaultTone || "";
  $("optAudience").value = settings.defaultAudience || "";
  $("optAuthorBio").value = settings.authorBio || "";
  $("optThumbStyle").value = settings.thumbnailStylePrompt || "";
  $("optAdEnabled").checked = !!settings.adEnabled;
  $("optAdCode").value = settings.adCode || "";
  $("optionsDialog").showModal();
}
async function onSaveOptions() {
  const patch = {
    kieChatModel: $("optChatModel").value, thumbnailMode: $("optThumbMode").value, imageResolution: $("optImgRes").value,
    linkMode: $("optLinkMode").value, overlayAccent: $("optAccent").value, myBlogUrl: $("optMyBlog").value.trim(),
    defaultTone: $("optTone").value.trim(), defaultAudience: $("optAudience").value.trim(), authorBio: $("optAuthorBio").value.trim(),
    thumbnailStylePrompt: $("optThumbStyle").value.trim(), adEnabled: $("optAdEnabled").checked, adCode: $("optAdCode").value.trim()
  };
  try { await saveSettings(patch); settings = await getSettings(); $("optionsDialog").close(); setStatus("✅ 설정 저장됨"); }
  catch (e) { setStatus("설정 저장 실패: " + e.message, true); }
}

// ---------- 트렌드 ----------
async function renderTrends(force) {
  const box = $("trendList"); box.innerHTML = '<div class="hist-empty">불러오는 중…</div>';
  let data; try { data = await apiTrends(force); } catch { data = { items: [], ts: Date.now() }; }
  const items = data.items || []; box.innerHTML = "";
  if (!items.length) { box.innerHTML = '<div class="hist-empty">트렌드를 불러오지 못했어요.</div>'; return; }
  const d = new Date(data.ts || Date.now());
  $("trendMeta").textContent = `구글 급상승 · ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 기준`;
  items.forEach((it, i) => {
    const row = document.createElement("div"); row.className = "hist-item";
    const b = document.createElement("button"); b.className = "hist-load"; b.textContent = `${i + 1}. ${it.title}`;
    b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(it.title); } catch {} setStatus(`"${it.title}" 복사됨 — 이 주제로 원본 글을 작성해 붙여넣으세요.`); });
    row.appendChild(b); box.appendChild(row);
  });
}

// ---------- 발행 글 보관함 (DB 누적) ----------
async function getAllMyPosts() {
  try {
    const recs = await storeList(); const seen = new Set(), out = [];
    for (const r of recs) if (r.type === "post" && r.url && /^https?:\/\//.test(r.url) && !seen.has(r.url)) { seen.add(r.url); out.push({ title: r.title || r.url, url: r.url, keyword: r.keyword || "" }); }
    return out;
  } catch { return []; }
}
function matchMyPosts(posts, keyword) {
  const kw = (keyword || "").toLowerCase().trim(); if (!kw) return posts.slice(0, 8);
  const tokens = kw.split(/\s+/).filter((t) => t.length >= 2);
  return posts.map((p) => {
    const hay = ((p.title || "") + " " + (p.keyword || "")).toLowerCase();
    let s = 0; for (const t of tokens) if (hay.includes(t)) s++; if (hay.includes(kw)) s += 2;
    return { p, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => ({ title: x.p.title, link: x.p.url }));
}
async function renderMyPosts() {
  const box = $("myPostsList"); const all = await getAllMyPosts();
  const q = ($("myPostSearch")?.value || "").toLowerCase().trim();
  const filtered = q ? all.filter((p) => ((p.title || "") + " " + (p.keyword || "") + " " + (p.url || "")).toLowerCase().includes(q)) : all;
  const shown = filtered.slice(0, 30);
  $("myPostsCount").textContent = q ? `전체 ${all.length}개 중 "${q}" ${filtered.length}개` : `전체 ${all.length}개${all.length > 30 ? " · 최근 30개" : ""}`;
  box.innerHTML = "";
  if (!shown.length) { box.innerHTML = '<div class="hist-empty">' + (q ? "검색 결과 없음" : "발행 글이 없습니다. 블로거 발행 후 주소를 저장하세요.") + '</div>'; return; }
  for (const p of shown) {
    const row = document.createElement("div"); row.className = "hist-item";
    const a = document.createElement("a"); a.className = "hist-load"; a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = p.title || p.url; a.title = p.url; a.style.textDecoration = "none";
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => { e.preventDefault(); await storeDelete(p.url); await renderMyPosts(); });
    row.appendChild(a); row.appendChild(del); box.appendChild(row);
  }
}
async function onAddMyPost() {
  const url = $("myPostUrl").value.trim(), title = $("myPostTitle").value.trim();
  if (!/^https?:\/\//.test(url)) { setStatus("올바른 URL을 입력하세요.", true); return; }
  await saveMyPost({ title: title || url, url, keyword: title }); $("myPostUrl").value = ""; $("myPostTitle").value = "";
  setStatus("✅ 보관함에 추가됨");
}
async function saveMyPost(entry, content) {
  await storeAdd({ type: "post", title: entry.title, url: entry.url, keyword: entry.keyword || "", body: content || "" });
  lastMainUrl = entry.url; await renderMyPosts();
}
// 블로거 발행 주소 저장 → 목적지로 세팅
async function onSaveMainUrl() {
  const url = $("mainUrlInput").value.trim();
  if (!/^https?:\/\//.test(url)) { setStatus("발행된 주소(https://...)를 입력하세요.", true); return; }
  const art = results.blogger?.article;
  const plain = (results.blogger?.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  await saveMyPost({ title: art?.title || deriveTopic() || "메인 글", url, keyword: results.blogger?.keyword || deriveTopic() }, plain);
  $("bloggerUrl").value = url;   // 쿠션 목적지로 자동 세팅
  $("mainUrlInput").value = "";
  setStatus("✅ 발행 주소 저장 완료. 이제 네이버·워드프레스가 이 글로 유입됩니다.");
}

// ---------- 링크 소스 ----------
async function gatherRelatedLinks(keyword) {
  const myPosts = matchMyPosts(await getAllMyPosts(), keyword);
  const seenM = new Set(), mp = [];
  for (const it of myPosts) if (it?.link && !seenM.has(it.link)) { seenM.add(it.link); mp.push(it); }
  lastMyPosts = mp.slice(0, 8);
  const embedded = extractLinksFromText($("originalText").value || "");
  const seenS = new Set(), src = [];
  for (const it of embedded) if (it?.link && !seenS.has(it.link)) { seenS.add(it.link); src.push(it); }
  lastSources = src.slice(0, 8);
}
function extractLinksFromText(text) {
  const out = [];
  const push = (title, link) => { if (!/^https?:\/\//.test(link)) return; if (out.some((x) => x.link === link)) return; out.push({ title: (title || link).trim() || link, link }); };
  let m;
  const html = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = html.exec(text))) push(m[2].replace(/<[^>]+>/g, ""), m[1]);
  const md = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  while ((m = md.exec(text))) push(m[1], m[2]);
  const bare = /\bhttps?:\/\/[^\s)<>"']+/g;
  while ((m = bare.exec(text))) { if (!/\.(png|jpe?g|gif|webp|svg|css|js)(\?|$)/i.test(m[0])) push(m[0], m[0]); }
  return out.slice(0, 10);
}
async function searchMyBlog(blogUrl, keyword) {
  const base = blogUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/feeds/posts/default?q=${encodeURIComponent(keyword)}&alt=json&max-results=3`);
    if (res.ok) { const j = await res.json(); return (j?.feed?.entry || []).map((e) => ({ title: e.title?.$t || "내 글", link: (e.link || []).find((l) => l.rel === "alternate")?.href })).filter((x) => x.link); }
  } catch {}
  return [];
}

// ---------- 프롬프트 ----------
function buildPromptFor(target, keyword) {
  const sourceText = $("originalText").value.trim();
  const common = { keyword, audience: settings.defaultAudience, tone: settings.defaultTone, authorBio: settings.authorBio, today: todayStr(), imageCount: parseInt($("imgCount").value, 10) || 1 };
  if (target === "blogger") return buildBloggerMain({ ...common, sourceText, internalLinks: [] });
  return buildCushionPrompt(target === "wp" ? "wp" : "naver", { ...common, sourceText, bloggerUrl: getDestUrl() });
}

// ---------- 생성 ----------
async function generate(target) {
  if (!config.kieEnabled) { setStatus("서버에 KIE API 키가 없습니다. (.env 확인)", true); return; }
  if (!$("originalText").value.trim()) { setStatus("원본 글을 먼저 붙여넣으세요.", true); return; }
  const keyword = deriveTopic();
  const btns = [$("genBlogger"), $("genNaver"), $("genWp")]; btns.forEach((b) => (b.disabled = true));
  try {
    await gatherRelatedLinks(keyword);
    const built = buildPromptFor(target, keyword);
    setStatus(`[${LABEL[target]}] 글 작성 중… (15~60초)`);
    let content = await chatComplete({ model: settings.kieChatModel, system: built.system, user: built.user, maxTokens: 16000 });
    let article = tryParse(content);
    if (!article) {
      setStatus(`[${LABEL[target]}] 형식 재요청 중…`);
      content = await chatComplete({ model: settings.kieChatModel, system: built.system, user: built.user + "\n\n(JSON이 끊기지 않게 위 형식의 JSON 객체 하나로만 완결해줘.)", maxTokens: 16000 });
      article = tryParse(content);
    }
    if (!article) throw new Error("생성 결과 JSON 파싱 실패. 원본을 조금 줄이거나 다시 시도하세요.\n" + content.slice(0, 140));
    await finalizeArticle(target, article, keyword, built.resolvedType);
  } catch (e) { setStatus(`[${LABEL[target]}] 오류: ` + e.message, true); }
  finally { btns.forEach((b) => (b.disabled = false)); }
}

function enforceImageCount(article, n) {
  const blocks = article.blocks || []; const imgs = blocks.filter((b) => b.type === "image");
  if (imgs.length <= n) return; const keep = new Set(); const thumb = imgs.find((b) => b.slot === "thumbnail");
  if (thumb) keep.add(thumb); for (const b of imgs) { if (keep.size >= n) break; keep.add(b); }
  article.blocks = blocks.filter((b) => b.type !== "image" || keep.has(b));
}
async function genBlockImage(target, b, article, keyword) {
  const isThumb = b.slot === "thumbnail";
  const headline = (b.overlayText || article.title || keyword || "").slice(0, 40);
  let genPrompt = b.prompt || b.alt || keyword;
  const thumbStyle = settings.thumbnailStylePrompt || DEFAULT_THUMB_STYLE;
  if (isThumb && settings.thumbnailMode === "ai_full") {
    genPrompt = `${thumbStyle}\n\nScene: ${b.prompt || keyword}\n\nRender this EXACT Korean headline, large, bold, correctly spelled: "${headline}"\n\nHARD RULES: Korean headline in the TOP area, bottom clear. If a public figure is central show ONLY ONE person; else clean illustration/graphic-card with NO random people. NO cartoon mascot, graphs, arrows, flags, finance symbols.`;
  }
  const aspect = isThumb ? (ASPECT_BY_TARGET[target] || "4:3") : "4:3";
  b._genPrompt = genPrompt; b._headline = headline; b._isThumb = isThumb; b._aspect = aspect;
  let url = await generateImage({ prompt: genPrompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
  if (isThumb && settings.thumbnailMode === "overlay") { try { url = await composeThumbnail({ imageUrl: url, text: headline, accent: settings.overlayAccent || "#ff2d55", aspect }); } catch (e) { console.warn(e); } }
  b.resolvedUrl = url;
}
function safeResolution(aspect) { const res = settings.imageResolution || "1K"; const [aw, ah] = (aspect || "16:9").split(":").map(Number); if (aw === ah && res === "4K") return "2K"; return res; }

// 상단 클릭 유도 링크카드: (쿠션) 목적지 자세히보기 + (공통) 내 블로그 연관글 바로가기
// target: blogger|wp|naver, relatedPosts: [{title,link}], destUrl: 목적지
function ensureTopLinkcard(target, article, keyword, relatedPosts, destUrl) {
  const blocks = article.blocks || [];
  if (blocks.slice(0, 4).some((b) => b.type === "linkcard")) return;   // 모델이 이미 상단 카드 만들었으면 존중
  const kw = (keyword || article.title || "").trim();
  const items = [];
  // 쿠션(wp): 목적지(원본)로 유입하는 featured 버튼
  if (target !== "blogger" && destUrl) {
    items.push({ icon: "▶️", title: `${kw} 전체 내용 자세히 보기`, subtitle: "핵심만 빠르게 확인", label: "자세히 보기 →", url: destUrl, featured: true });
  }
  // 공통: 내 블로그 연관글을 '누르고 싶은' 바로가기로 (블로거 메인도 포함)
  const enticers = ["지금 바로 확인 →", "안 보면 손해 →", "여기서 확인 →", "바로가기 →"];
  (relatedPosts || []).slice(0, 3).forEach((p, i) => {
    items.push({ icon: "🔗", title: p.title, subtitle: "함께 보면 좋은 글", label: enticers[i] || "바로가기 →", url: p.link, featured: (target === "blogger" && i === 0 && !items.length) });
  });
  if (!items.length) return;   // 넣을 게 없으면(연관글 없고 목적지도 없음) 생략
  const heading = target === "blogger" ? "👉 이 글과 함께 보면 좋아요" : "👉 먼저 확인하세요";
  const card = { type: "linkcard", heading, items };
  let idx = blocks.findIndex((b) => b.type === "image" && b.slot === "thumbnail"); idx = idx >= 0 ? idx + 1 : 0;
  blocks.splice(idx, 0, card); article.blocks = blocks;
}
// 유튜브 영상 ID 추출
function ytId(u) { const m = String(u || "").match(/(?:youtube\.com\/(?:watch\?[^#\s"'()]*\bv=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : ""; }
// 유튜브 URL을 재생 플레이어(youtube 블록)로 변환/삽입 (블로거·WP용, 네이버 제외)
function embedYouTube(article) {
  const blocks = article.blocks || []; const out = []; const seen = new Set();
  for (const b of blocks) {
    if (b.type === "cta" && ytId(b.url)) { const id = ytId(b.url); if (!seen.has(id)) { seen.add(id); out.push({ type: "youtube", url: b.url, title: b.label || "" }); } continue; }
    out.push(b);
    let hay = "";
    if (b.type === "paragraph") hay = b.text || "";
    else if (b.type === "linkcard") hay = (b.items || []).map((it) => it.url || "").join(" ");
    if (hay) {
      const re = /(?:youtube\.com\/(?:watch\?[^#\s"'()]*\bv=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g;
      let mm; while ((mm = re.exec(hay))) { if (!seen.has(mm[1])) { seen.add(mm[1]); out.push({ type: "youtube", url: mm[0], title: "관련 영상" }); } }
    }
  }
  article.blocks = out;
}
// 네이버: 외부 링크 딱 1개(자세히 보기 → 목적지)
function enforceNaverSingleLink(article, keyword) {
  const blocks = (article.blocks || []).filter((b) => b.type !== "linkcard" && b.type !== "cta");
  blocks.push({ type: "cta", label: `${(keyword || article.title || "").trim()} 전체 내용 자세히 보기 →`, url: "#" });
  article.blocks = blocks;
}

async function finalizeArticle(target, article, keyword, resolvedType) {
  article.today = todayStr(); article.authorBio = settings.authorBio;
  if (target === "wp") ensureTopLinkcard("wp", article, keyword, lastMyPosts, getDestUrl());
  else if (target === "naver") enforceNaverSingleLink(article, keyword);
  else if (target === "blogger" && lastMyPosts.length) ensureTopLinkcard("blogger", article, keyword, lastMyPosts, "");
  if (target !== "naver") embedYouTube(article);   // 유튜브 URL → 재생 플레이어 임베드(네이버는 iframe 불가 → 제외)
  enforceImageCount(article, parseInt($("imgCount").value, 10) || 1);

  if ($("genImages").checked && config.kieEnabled) {
    const imgBlocks = (article.blocks || []).filter((b) => b.type === "image");
    let i = 0;
    for (const b of imgBlocks) { i++; setStatus(`[${LABEL[target]}] 이미지 생성 중… (${i}/${imgBlocks.length})`); try { await genBlockImage(target, b, article, keyword); } catch (e) { console.warn(e); } }
  }

  results[target] = { article, keyword, resolvedType, html: "" };
  rebuildPreview(target);
  $("resultCard").style.display = "";
  $(`rt-${target}`).classList.add("has");
  showResult(target);

  // 생성 기록 DB 저장(누적)
  try {
    const plain = (results[target].html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
    const thumb = (article.blocks || []).find((b) => b.type === "image" && b.slot === "thumbnail")?.resolvedUrl || "";
    await storeAdd({ type: "article", title: article.title || "", keyword, summary: article.metaDescription || "", platform: target, images: thumb ? [thumb] : [], body: plain });
  } catch {}

  setStatus(target === "blogger"
    ? "✅ 블로거 메인 완성. HTML 복사→블로거에 붙여넣고 수정 후 발행하세요. 발행 주소를 위에 저장하면 쿠션이 이 글로 유입됩니다."
    : `✅ ${LABEL[target]} 완성.`);
}

function rebuildPreview(target) {
  const r = results[target]; if (!r) return;
  const isNaver = target === "naver";
  const myPosts = isNaver ? [] : lastMyPosts;
  try {
    const out = buildHtml(r.article, {
      adEnabled: settings.adEnabled, adCode: settings.adCode, accent: settings.overlayAccent || "#e11d48",
      searchLinks: settings.linkMode !== "model", searchContext: r.keyword || r.article?.title || "",
      relatedUrls: myPosts.map((x) => x.link), relatedPosts: myPosts, sources: isNaver ? [] : lastSources,
      selfUrl: (target === "naver" || target === "wp") ? getDestUrl() : ""
    });
    r.html = out.html;
  } catch (e) {
    console.error("preview build error:", e);
    // 링크 라우팅 없이 최소 미리보기로 폴백(결과 유실 방지)
    try {
      const out = buildHtml(r.article, { accent: settings.overlayAccent || "#e11d48", searchLinks: false });
      r.html = out.html;
    } catch (e2) {
      r.html = `<h1>${(r.article?.title || "").replace(/</g, "&lt;")}</h1><p>미리보기 조립 중 오류가 발생했습니다. HTML 복사는 가능합니다.</p>`;
    }
  }
}

// ---------- 결과 표시 ----------
function showResult(target) {
  const r = results[target]; if (!r) return;
  activeTarget = target;
  document.querySelectorAll(".restab").forEach((b) => b.classList.toggle("active", b.dataset.t === target));
  $("metaLine").textContent = `제목: ${r.article.title}` + (r.resolvedType ? ` · 유형: ${r.resolvedType}` : "") + `\n메타: ${r.article.metaDescription || "-"}`;
  $("preview").srcdoc = buildPreviewDoc(r.article.title, r.html);
  $("wpActions").classList.toggle("hidden", !(target === "wp" && config.wpEnabled));
  $("mainUrlRow").classList.toggle("hidden", target !== "blogger");
  renderImageEditors();
  if (editMode) renderEditor();
}

// ---------- 편집 모드 (블록 추가/삭제/수정) ----------
let editMode = false;
function toggleEdit() {
  editMode = !editMode;
  $("editToggle").classList.toggle("primary-mini", editMode);
  $("editToggle").textContent = editMode ? "✅ 편집 완료" : "✏️ 편집";
  $("editor").classList.toggle("hidden", !editMode);
  if (editMode) renderEditor();
}
function refreshAfterEdit() {
  rebuildPreview(activeTarget);
  const r = results[activeTarget];
  $("preview").srcdoc = buildPreviewDoc(r.article.title, r.html);
  renderEditor();
}
const ED_TYPE = { paragraph: "문단", heading: "제목", list: "리스트", table: "표", callout: "박스", cta: "버튼", linkcard: "링크카드", image: "이미지", youtube: "영상" };
function edSummary(b) {
  if (b.type === "youtube") return `[영상] ${b.title || ""} (${ytId(b.url) || "?"})`;
  if (b.type === "cta") return `[버튼] ${b.label || ""} → ${b.url || "#"}`;
  if (b.type === "image") return `[이미지] ${b.alt || b.prompt || ""}${b.resolvedUrl ? " (생성됨)" : ""}`;
  if (b.type === "linkcard") return `[링크카드] ${(b.items || []).map((x) => x.title).join(", ")}`;
  if (b.type === "list") return (b.items || []).join(" · ");
  if (b.type === "table") return `표 ${(b.rows || []).length}행`;
  if (b.type === "callout") return `[박스] ${b.text || ""}`;
  return "";
}
function renderEditor() {
  const box = $("editor"); box.innerHTML = "";
  const r = results[activeTarget];
  if (!r) { box.innerHTML = '<div class="ed-hint">생성된 글이 없습니다.</div>'; return; }
  box.appendChild(edHint());
  const blocks = r.article.blocks || [];
  box.appendChild(insertBar(0));
  blocks.forEach((b, i) => { box.appendChild(blockRow(b, i)); box.appendChild(insertBar(i + 1)); });
}
function edHint() { const d = document.createElement("div"); d.className = "ed-hint"; d.textContent = "블록 사이에 마우스를 올리면 글·버튼·이미지를 추가할 수 있어요. 제목/문단은 바로 수정, ✕로 삭제됩니다. (수정 후 미리보기·복사에 반영)"; return d; }
function insertBar(index) {
  const bar = document.createElement("div"); bar.className = "ed-insert";
  const mk = (label, fn) => { const btn = document.createElement("button"); btn.textContent = label; btn.addEventListener("click", () => fn(index, bar)); return btn; };
  bar.appendChild(mk("+ 글", addTextAt));
  bar.appendChild(mk("+ 버튼", addButtonAt));
  bar.appendChild(mk("+ 이미지", addImageAt));
  bar.appendChild(mk("+ 영상", addVideoAt));
  return bar;
}
function blockRow(b, i) {
  const row = document.createElement("div"); row.className = "ed-block";
  const del = document.createElement("button"); del.className = "ed-del"; del.textContent = "✕";
  del.addEventListener("click", () => { results[activeTarget].article.blocks.splice(i, 1); refreshAfterEdit(); });
  row.appendChild(del);
  const type = document.createElement("div"); type.className = "ed-type"; type.textContent = ED_TYPE[b.type] || b.type; row.appendChild(type);
  if (b.type === "paragraph" || b.type === "heading") {
    const ta = document.createElement("textarea"); ta.rows = b.type === "heading" ? 1 : 3; ta.value = b.text || "";
    ta.addEventListener("input", () => { b.text = ta.value; });
    ta.addEventListener("blur", refreshAfterEdit);
    row.appendChild(ta);
  } else {
    const body = document.createElement("div"); body.className = "ed-body"; body.textContent = edSummary(b); row.appendChild(body);
  }
  return row;
}
function addTextAt(index) { results[activeTarget].article.blocks.splice(index, 0, { type: "paragraph", text: "새 문단 내용을 입력하세요." }); refreshAfterEdit(); }
function addButtonAt(index, bar) {
  const form = document.createElement("div"); form.className = "ed-form";
  const label = document.createElement("input"); label.placeholder = "버튼 문구 (예: 자세히 보기 →)";
  const url = document.createElement("input"); url.placeholder = "링크 URL (비우면 목적지로)";
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "추가";
  ok.addEventListener("click", () => {
    const u = url.value.trim() || getDestUrl() || "#";
    results[activeTarget].article.blocks.splice(index, 0, { type: "cta", label: label.value.trim() || "자세히 보기 →", url: u });
    refreshAfterEdit();
  });
  form.appendChild(label); form.appendChild(url); form.appendChild(ok);
  bar.replaceWith(form); label.focus();
}
function addVideoAt(index, bar) {
  const form = document.createElement("div"); form.className = "ed-form";
  const url = document.createElement("input"); url.placeholder = "유튜브 영상 주소 (youtube.com/watch?v=... 또는 youtu.be/...)";
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "삽입";
  ok.addEventListener("click", () => {
    const id = ytId(url.value.trim());
    if (!id) { setStatus("유효한 유튜브 영상 주소가 아닙니다.", true); return; }
    results[activeTarget].article.blocks.splice(index, 0, { type: "youtube", url: url.value.trim(), title: "" });
    refreshAfterEdit();
  });
  form.appendChild(url); form.appendChild(ok); bar.replaceWith(form); url.focus();
}
async function addImageAt(index, bar) {
  const form = document.createElement("div"); form.className = "ed-form";
  const desc = document.createElement("input"); desc.placeholder = "이미지 설명 (예: 성산일출봉 일출 풍경)";
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "생성";
  ok.addEventListener("click", async () => {
    if (!config.kieEnabled) { setStatus("KIE 키가 필요합니다.", true); return; }
    ok.disabled = true; ok.textContent = "생성중…";
    try {
      const p = desc.value.trim() || results[activeTarget]?.keyword || "";
      const u = await generateImage({ prompt: p, aspectRatio: "4:3", resolution: safeResolution("4:3") });
      results[activeTarget].article.blocks.splice(index, 0, { type: "image", slot: "body", alt: desc.value.trim(), resolvedUrl: u, _genPrompt: p, _aspect: "4:3" });
      refreshAfterEdit();
    } catch (e) { setStatus("이미지 생성 실패: " + e.message, true); ok.disabled = false; ok.textContent = "생성"; }
  });
  form.appendChild(desc); form.appendChild(ok);
  bar.replaceWith(form); desc.focus();
}

// ---------- 이미지 수정 ----------
function renderImageEditors() {
  const box = $("imgEditList"); box.innerHTML = "";
  const r = results[activeTarget]; const imgs = (r?.article?.blocks || []).filter((b) => b.type === "image");
  if (!imgs.length) { $("imgEditBox").classList.add("hidden"); return; }
  $("imgEditBox").classList.remove("hidden");
  imgs.forEach((b) => {
    const row = document.createElement("div"); row.className = "imgedit-row";
    const thumb = b.resolvedUrl ? `<img src="${b.resolvedUrl}" class="imgedit-thumb"/>` : `<div class="imgedit-thumb ph">미생성</div>`;
    const head = document.createElement("div"); head.className = "imgedit-head"; head.innerHTML = `${thumb}<span>${b.slot === "thumbnail" ? "🖼️ 썸네일" : "본문 이미지"}</span>`;
    const input = document.createElement("input"); input.type = "text"; input.placeholder = "수정 요청 (예: 배경 더 어둡게)";
    const btns = document.createElement("div"); btns.className = "imgedit-btns";
    const regen = document.createElement("button"); regen.className = "mini"; regen.textContent = "다시 생성"; regen.addEventListener("click", () => regenImage(b, input.value.trim()));
    const edit = document.createElement("button"); edit.className = "mini"; edit.textContent = "부분 수정"; edit.addEventListener("click", () => editImg(b, input.value.trim()));
    btns.appendChild(regen); btns.appendChild(edit); row.appendChild(head); row.appendChild(input); row.appendChild(btns); box.appendChild(row);
  });
}
async function regenImage(b, instr) {
  if (!config.kieEnabled) { setStatus("KIE 키 필요", true); return; }
  const base = b._genPrompt || b.prompt || (results[activeTarget]?.keyword || "");
  const prompt = instr ? `${base}\n\n추가 수정 요청: ${instr}` : base;
  const aspect = b._aspect || (b._isThumb ? (ASPECT_BY_TARGET[activeTarget] || "4:3") : "4:3");
  setStatus("이미지 다시 생성 중…");
  try {
    let url = await generateImage({ prompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || results[activeTarget].article.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url; b._genPrompt = prompt; rebuildPreview(activeTarget); showResult(activeTarget); setStatus("✅ 이미지 갱신됨");
  } catch (e) { setStatus("이미지 실패: " + e.message, true); }
}
async function editImg(b, instr) {
  if (!instr) { setStatus("수정 요청 문구를 입력하세요.", true); return; }
  if (!b.resolvedUrl || b.resolvedUrl.startsWith("data:")) { setStatus("부분 수정은 생성된 이미지(URL)만 가능. '다시 생성'을 쓰세요.", true); return; }
  const aspect = b._aspect || (b._isThumb ? (ASPECT_BY_TARGET[activeTarget] || "4:3") : "4:3");
  setStatus("이미지 부분 수정 중…");
  try {
    let url = await editImage({ imageUrl: b.resolvedUrl, prompt: instr, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || results[activeTarget].article.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url; rebuildPreview(activeTarget); showResult(activeTarget); setStatus("✅ 이미지 수정됨");
  } catch (e) { setStatus("수정 실패: " + e.message, true); }
}

// ---------- 출력 ----------
async function onCopy() {
  const r = results[activeTarget]; if (!r?.html) return;
  try { await navigator.clipboard.writeText(r.html); setStatus(`📋 [${LABEL[activeTarget]}] HTML 복사됨. 편집기 'HTML' 모드에 붙여넣으세요.`); }
  catch (e) { setStatus("복사 실패: " + e.message, true); }
}
async function wpPublish(status) {
  const r = results[activeTarget]; if (!r?.html) return;
  if (!config.wpEnabled) { setStatus("서버 .env에 워드프레스 정보를 입력하세요.", true); return; }
  const label = status === "publish" ? "발행" : "초안 저장";
  try {
    setStatus(`워드프레스에 ${label} 중…`);
    const res = await wpCreatePost({ title: r.article.title, content: r.html, status });
    if (res.link) { try { await saveMyPost({ title: r.article.title, url: res.link, keyword: r.keyword }, (r.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {} }
    setStatus(`✅ ${label} 완료: ${res.link || ("글 #" + res.id)}`);
  } catch (e) { setStatus(`${label} 실패: ` + e.message, true); }
}
