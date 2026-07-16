// 블로그 오토라이터 — 웹앱 프론트 (크롬 확장 sidepanel.js 포팅)
// chrome.* / KIE 직접호출 제거 → same-origin /api/* 사용. 로직(프롬프트·링크·썸네일·톤·상단버튼)은 확장 그대로.
import { buildBloggerMain, buildCushionPrompt } from "./lib/prompts.js";
import { buildHtml, buildPreviewDoc } from "./lib/html-builder.js";
import { composeThumbnail } from "./lib/thumbnail.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let config = { kieEnabled: false, wpEnabled: false, naverEnabled: false };
let mode = "blogger";
let lastArticle = null, lastHtml = null, lastKeyword = "", lastResolvedType = "", lastRelatedItems = [];

const ASPECT_BY_MODE = { blogger: "4:3", wp: "4:3", naver: "1:1" };

const DEFAULT_THUMB_STYLE =
`Korean YouTube-style clickbait thumbnail, 16:9 aspect ratio. Cinematic, high-contrast dramatic lighting with a moody atmospheric background that fits the article's actual topic. Big HEAVY bold Korean sans-serif headline with a thick black-and-white outline, placed in the TOP area (top-left or top-right) with the bottom third kept clear/empty (blog thumbnails crop the bottom); the Korean text must be large and PERFECTLY, CORRECTLY spelled. Clean, premium, instantly readable even at small mobile size. Do NOT add cartoon mascots, stock-market graphs, arrows, national flags, or finance/economics elements. The imagery should visually match the real subject of the article.`;

const DEFAULTS = {
  kieChatModel: "claude-sonnet-5", imageResolution: "1K",
  thumbnailMode: "ai_full", thumbnailStylePrompt: "", overlayAccent: "#ff2d55",
  linkMode: "search", myBlogUrl: "", defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자", authorBio: "",
  adEnabled: false, adCode: "", internalLinks: false, generateImages: true, imageCount: 1
};

// ---------- API 헬퍼 ----------
async function apiJson(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) {
    let j = {}; try { j = await r.json(); } catch {}
    location.href = j.login || "https://mangois.love/";
    throw new Error("MangoHub 로그인이 필요합니다.");
  }
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
const apiKeywords = (seed) => apiJson(`/api/keywords?seed=${encodeURIComponent(seed)}`).then((j) => j.keywords || []);
const apiTrends = (force) => apiJson(`/api/trends${force ? "?force=1" : ""}`);
const storeList = () => apiJson("/api/store").then((j) => j.records || []);
const storeAdd = (rec) => apiJson("/api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) }).catch(() => {});
const storeDelete = (url) => apiJson("/api/store/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {});
const wpCreatePost = ({ title, content, status }) => apiJson("/api/wp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, status }) });

async function getSettings() {
  try { const s = await apiJson("/api/settings"); return { ...DEFAULTS, ...s }; } catch { return { ...DEFAULTS }; }
}
async function saveSettings(patch) {
  await apiJson("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
}

init();

async function init() {
  try { config = await apiJson("/api/config"); } catch {}
  settings = await getSettings();
  $("genImages").checked = settings.generateImages;
  $("imgCount").value = String(settings.imageCount || 1);
  applyModeUI();
  if (!config.kieEnabled) $("apiWarn").classList.remove("hidden");

  $("modeBar").addEventListener("click", (e) => {
    const btn = e.target.closest(".mode"); if (!btn) return;
    mode = btn.dataset.mode; applyModeUI();
  });
  $("openOptions").addEventListener("click", openOptions);
  $("generateBtn").addEventListener("click", onGenerate);
  $("copyBtn").addEventListener("click", onCopy);
  $("wpDraftBtn").addEventListener("click", () => wpPublish("draft"));
  $("wpPublishBtn").addEventListener("click", () => wpPublish("publish"));
  $("myPostAdd").addEventListener("click", onAddMyPost);
  $("myPostSearch").addEventListener("input", () => renderMyPosts());
  $("trendRefresh").addEventListener("click", () => renderTrends(true));
  $("trendBox").addEventListener("toggle", (e) => { if (e.target.open) renderTrends(false); });

  // 설정 모달 버튼
  $("optClose").addEventListener("click", () => $("optionsDialog").close());
  $("optSave").addEventListener("click", onSaveOptions);

  renderMyPosts();
}

function applyModeUI() {
  document.querySelectorAll(".mode").forEach((m) => m.classList.toggle("active", m.dataset.mode === mode));
  const cushion = (mode === "naver" || mode === "wp");
  $("bloggerUrlRow").classList.toggle("hidden", !cushion);
  $("imgAspect").value = ASPECT_BY_MODE[mode] || "4:3";
  $("generateBtn").textContent = mode === "blogger" ? "✨ 블로거 메인 완성" : (mode === "naver" ? "🟢 네이버 글 만들기" : "🔵 워드프레스 글 만들기");
}

function setStatus(msg, isError = false) {
  const el = $("status"); el.textContent = msg; el.classList.remove("hidden"); el.classList.toggle("error", isError);
}
function clearStatus() { $("status").classList.add("hidden"); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
// 원본 글에서 주제(첫 제목/문장) 자동 추출 — 별도 키워드 입력 대체
function deriveTopic() {
  const src = $("originalText").value || "";
  const first = src.split(/\n/).map((s) => s.replace(/^#+\s*/, "").replace(/[*_`>#]/g, "").trim()).find((s) => s.length > 1) || "";
  return first.slice(0, 40);
}
// 쿠션이 유입시킬 목적지(메인) URL: 입력칸 > 설정 내블로그 > 최근 저장한 내 글
function getDestUrl() {
  return ($("bloggerUrl")?.value?.trim()) || settings.myBlogUrl || (lastMainUrl || "");
}
let lastMainUrl = "";

function parseJson(raw) {
  let t = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s > 0 || e < t.length - 1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function tryParse(raw) { try { return parseJson(raw); } catch { return null; } }

// ---------- 설정 모달 ----------
function openOptions() {
  const d = $("optionsDialog");
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
  d.showModal();
}
async function onSaveOptions() {
  const patch = {
    kieChatModel: $("optChatModel").value, thumbnailMode: $("optThumbMode").value,
    imageResolution: $("optImgRes").value, linkMode: $("optLinkMode").value,
    overlayAccent: $("optAccent").value, myBlogUrl: $("optMyBlog").value.trim(),
    defaultTone: $("optTone").value.trim(), defaultAudience: $("optAudience").value.trim(),
    authorBio: $("optAuthorBio").value.trim(), thumbnailStylePrompt: $("optThumbStyle").value.trim(),
    adEnabled: $("optAdEnabled").checked, adCode: $("optAdCode").value.trim()
  };
  try { await saveSettings(patch); settings = await getSettings(); $("optionsDialog").close(); setStatus("✅ 설정 저장됨"); }
  catch (e) { setStatus("설정 저장 실패: " + e.message, true); }
}

// ---------- 트렌드 ----------
async function renderTrends(force) {
  const box = $("trendList");
  box.innerHTML = '<div class="hist-empty">불러오는 중…</div>';
  let data; try { data = await apiTrends(force); } catch { data = { items: [], ts: Date.now() }; }
  const items = data.items || [];
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = '<div class="hist-empty">트렌드를 불러오지 못했어요. 잠시 후 새로고침 하세요.</div>'; return; }
  const d = new Date(data.ts || Date.now());
  $("trendMeta").textContent = `구글 급상승 · ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 기준`;
  items.forEach((it, i) => {
    const row = document.createElement("div"); row.className = "hist-item";
    const b = document.createElement("button"); b.className = "hist-load";
    b.textContent = `${i + 1}. ${it.title}`;
    b.addEventListener("click", async () => { try { await navigator.clipboard.writeText(it.title); } catch {} setStatus(`"${it.title}" 복사됨 — 이 주제로 원본 글을 작성해 붙여넣으세요.`); });
    row.appendChild(b); box.appendChild(row);
  });
}

// ---------- 내 글 보관함 ----------
async function getAllMyPosts() {
  try {
    const recs = await storeList();
    const seen = new Set(), out = [];
    for (const r of recs) {
      if (r.type === "post" && r.url && /^https?:\/\//.test(r.url) && !seen.has(r.url)) {
        seen.add(r.url); out.push({ title: r.title || r.url, url: r.url, keyword: r.keyword || "" });
      }
    }
    return out;
  } catch { return []; }
}
function matchMyPosts(posts, keyword) {
  const kw = (keyword || "").toLowerCase().trim();
  if (!kw) return [];
  const tokens = kw.split(/\s+/).filter((t) => t.length >= 2);
  const scored = posts.map((p) => {
    const hay = ((p.title || "") + " " + (p.keyword || "")).toLowerCase();
    let score = 0; for (const t of tokens) if (hay.includes(t)) score++;
    if (hay.includes(kw)) score += 2;
    return { p, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.map((x) => ({ title: x.p.title, link: x.p.url }));
}
async function renderMyPosts() {
  const box = $("myPostsList");
  const all = await getAllMyPosts();
  const q = ($("myPostSearch")?.value || "").toLowerCase().trim();
  const filtered = q ? all.filter((p) => ((p.title || "") + " " + (p.keyword || "") + " " + (p.url || "")).toLowerCase().includes(q)) : all;
  const shown = filtered.slice(0, 30);
  $("myPostsCount").textContent = q ? `전체 ${all.length}개 중 "${q}" ${filtered.length}개` : `전체 ${all.length}개${all.length > 30 ? " · 최근 30개 표시" : ""}`;
  box.innerHTML = "";
  if (!shown.length) { box.innerHTML = '<div class="hist-empty">' + (q ? "검색 결과 없음" : "보관된 글이 없습니다.") + '</div>'; return; }
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
  await saveMyPost({ title: title || url, url, keyword: title });
  $("myPostUrl").value = ""; $("myPostTitle").value = "";
  setStatus("✅ 보관함에 추가됨");
}
async function saveMyPost(entry) {
  await storeAdd({ type: "post", title: entry.title, url: entry.url, keyword: entry.keyword || "" });
  lastMainUrl = entry.url;   // 최근 저장한 내 글 → 쿠션 기본 목적지
  await renderMyPosts();
}

// ---------- 링크 소스 ----------
async function gatherRelatedLinks(keyword) {
  const embedded = extractLinksFromText($("originalText").value || "");
  const storeMatches = matchMyPosts(await getAllMyPosts(), keyword);
  let mine = [];
  if (settings.myBlogUrl && keyword) { try { mine = await searchMyBlog(settings.myBlogUrl, keyword); } catch {} }
  const merged = [], seen = new Set();
  for (const it of [...storeMatches, ...mine, ...embedded]) {
    if (it?.link && !seen.has(it.link)) { seen.add(it.link); merged.push(it); }
  }
  lastRelatedItems = merged.slice(0, 10);
}
function extractLinksFromText(text) {
  const out = [];
  const push = (title, link) => {
    if (!/^https?:\/\//.test(link)) return;
    if (out.some((x) => x.link === link)) return;
    out.push({ title: (title || link).trim() || link, link });
  };
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
    if (res.ok) {
      const j = await res.json();
      const out = (j?.feed?.entry || []).map((e) => ({ title: e.title?.$t || "내 글", link: (e.link || []).find((l) => l.rel === "alternate")?.href })).filter((x) => x.link);
      if (out.length) return out;
    }
  } catch {}
  return [];
}

// ---------- 프롬프트 조립 ----------
async function buildCurrentPrompt(keyword) {
  const sourceText = $("originalText").value.trim();
  const common = {
    keyword, audience: settings.defaultAudience, tone: settings.defaultTone,
    authorBio: settings.authorBio, today: todayStr(), imageCount: parseInt($("imgCount").value, 10) || 1
  };
  if (mode === "blogger") {
    return buildBloggerMain({ ...common, sourceText, internalLinks: [] });
  }
  // 파생 키워드는 모델이 스스로 도출(프롬프트에 지시). 외부 키워드 API 의존 제거.
  return buildCushionPrompt(mode === "wp" ? "wp" : "naver", {
    ...common, sourceText,
    bloggerUrl: getDestUrl()
  });
}

// ---------- 생성 ----------
async function onGenerate() {
  settings = await getSettings();
  if (!config.kieEnabled) { setStatus("서버에 KIE API 키가 설정되지 않았습니다. (.env 확인)", true); return; }
  if (!$("originalText").value.trim()) { setStatus("원본 글을 붙여넣으세요. (claude.ai 등에서 작성한 글)", true); return; }
  const keyword = deriveTopic();   // 원본에서 주제 자동 추출 (별도 키워드 입력 없음)

  const btn = $("generateBtn"); btn.disabled = true; $("result").classList.add("hidden");
  try {
    await gatherRelatedLinks(keyword);
    const built = await buildCurrentPrompt(keyword);
    setStatus(mode === "blogger" ? "① 블로거 메인 완성 중… (15~60초)" : "① 쿠션 글 작성 중… (15~60초)");
    let content = await chatComplete({ model: settings.kieChatModel, system: built.system, user: built.user, maxTokens: 20000 });
    let article = tryParse(content);
    if (!article) {
      setStatus("① 형식 재요청 중…");
      const retry = built.user + "\n\n(참고: JSON이 끊기지 않게 위 형식의 JSON 객체 하나로만 완결해 주세요.)";
      content = await chatComplete({ model: settings.kieChatModel, system: built.system, user: retry, maxTokens: 20000 });
      article = tryParse(content);
    }
    if (!article) {
      const startsJson = content.trim().startsWith("{") || /^\s*```(json)?\s*\{/.test(content);
      throw new Error((startsJson ? "글이 너무 길어 응답이 잘렸어요. 원본을 줄이거나 다시 시도하세요." : "생성 결과 JSON 파싱 실패. 다시 시도하세요.") + "\n응답 일부: " + content.slice(0, 160));
    }
    await finalizeArticle(article, keyword, built.resolvedType);
  } catch (e) { setStatus("오류: " + e.message, true); }
  finally { btn.disabled = false; }
}

function enforceImageCount(article, n) {
  const blocks = article.blocks || [];
  const imgs = blocks.filter((b) => b.type === "image");
  if (imgs.length <= n) return;
  const keep = new Set();
  const thumb = imgs.find((b) => b.slot === "thumbnail");
  if (thumb) keep.add(thumb);
  for (const b of imgs) { if (keep.size >= n) break; keep.add(b); }
  article.blocks = blocks.filter((b) => b.type !== "image" || keep.has(b));
}

async function genBlockImage(b, article, keyword) {
  const isThumb = b.slot === "thumbnail";
  const headline = (b.overlayText || article.title || keyword || "").slice(0, 40);
  let genPrompt = b.prompt || b.alt || keyword;
  const thumbStyle = settings.thumbnailStylePrompt || DEFAULT_THUMB_STYLE;
  if (isThumb && settings.thumbnailMode === "ai_full") {
    genPrompt = `${thumbStyle}\n\nScene: ${b.prompt || keyword}\n\nRender this EXACT Korean headline text, large, bold, correctly spelled: "${headline}"\n\nHARD RULES: put the Korean headline text in the TOP area, keep the bottom clear. If the topic centers on a public figure, show ONLY ONE main person; otherwise a clean illustration/graphic-card style with NO random people. NO cartoon mascot, NO graphs/charts, NO arrows, NO flags, NO finance symbols. Match ONLY the article's real topic.`;
  }
  const aspect = isThumb ? ($("imgAspect").value || "4:3") : "4:3";
  b._genPrompt = genPrompt; b._headline = headline; b._isThumb = isThumb; b._aspect = aspect;

  let url = await generateImage({ prompt: genPrompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
  if (isThumb && settings.thumbnailMode === "overlay") {
    try { url = await composeThumbnail({ imageUrl: url, text: headline, accent: settings.overlayAccent || "#ff2d55", aspect }); } catch (e) { console.warn(e); }
  }
  b.resolvedUrl = url;
}
function safeResolution(aspect) {
  const res = settings.imageResolution || "1K";
  const [aw, ah] = (aspect || "16:9").split(":").map(Number);
  if (aw === ah && res === "4K") return "2K";
  return res;
}

// 워드프레스 하이브리드: 상단 클릭 유도 링크카드(2~3개) 보장
function ensureTopLinkcard(article, keyword) {
  const blocks = article.blocks || [];
  if (blocks.slice(0, 4).some((b) => b.type === "linkcard")) return;
  const kw = (keyword || article.title || "").trim();
  const card = {
    type: "linkcard", heading: "👉 먼저 확인하세요",
    items: [
      { icon: "▶️", title: `${kw} 전체 내용 자세히 보기`, subtitle: "핵심 정리·자세한 정보", label: "자세히 보기 →", featured: true },
      { icon: "📌", title: `${kw} 관련 정보 총정리`, subtitle: "한눈에 보기", label: "총정리 →" }
    ]
  };
  let idx = blocks.findIndex((b) => b.type === "image" && b.slot === "thumbnail");
  idx = idx >= 0 ? idx + 1 : 0;
  blocks.splice(idx, 0, card);
  article.blocks = blocks;
}

// 네이버: 외부 링크는 딱 1개(자세히 보기 → 목적지)만 남김
function enforceNaverSingleLink(article, keyword) {
  const blocks = article.blocks || [];
  // 기존 linkcard/cta 전부 제거 (네이버는 외부링크 불이익)
  const stripped = blocks.filter((b) => b.type !== "linkcard" && b.type !== "cta");
  // 마지막에 단일 유입 CTA 하나만 추가
  stripped.push({ type: "cta", label: `${(keyword || article.title || "").trim()} 전체 내용 자세히 보기 →`, url: "#" });
  article.blocks = stripped;
}

async function finalizeArticle(article, keyword, resolvedType) {
  article.today = todayStr();
  article.authorBio = settings.authorBio;
  if (mode === "wp") ensureTopLinkcard(article, keyword);
  else if (mode === "naver") enforceNaverSingleLink(article, keyword);
  enforceImageCount(article, parseInt($("imgCount").value, 10) || 1);
  lastArticle = article; lastKeyword = keyword || ""; lastResolvedType = resolvedType || "";

  if ($("genImages").checked && config.kieEnabled) {
    const imgBlocks = (article.blocks || []).filter((b) => b.type === "image");
    let i = 0;
    for (const b of imgBlocks) {
      i++; setStatus(`② 이미지 생성 중… (${i}/${imgBlocks.length})`);
      try { await genBlockImage(b, article, keyword); } catch (e) { console.warn("이미지 실패:", e); }
    }
  }

  rebuildPreview();
  $("resultEmpty").classList.add("hidden");
  $("result").classList.remove("hidden");
  $("wpActions").classList.toggle("hidden", !(mode === "wp" && config.wpEnabled));
  renderImageEditors();
  if (mode === "blogger") {
    $("myPostTitle").value = article.title || "";
    setStatus("✅ 블로거 메인 완성. 발행 후 그 URL을 아래 '내 글 보관함'에 저장하면, 네이버·워드프레스 쿠션이 이 글로 자동 유입됩니다.");
  } else {
    clearStatus();
  }

  try {
    const plainBody = (lastHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
    const thumb = (article.blocks || []).find((b) => b.type === "image" && b.slot === "thumbnail")?.resolvedUrl || "";
    await storeAdd({ type: "article", title: article.title || "", keyword: lastKeyword, summary: article.metaDescription || "", platform: mode, images: thumb ? [thumb] : [], body: plainBody });
  } catch {}
  try {
    const bu = $("bloggerUrl")?.value?.trim();
    if ((mode === "naver" || mode === "wp") && bu) await saveMyPost({ title: lastKeyword || article.title || "내 글", url: bu, keyword: lastKeyword });
  } catch {}
}

function rebuildPreview() {
  let sourceItems = lastRelatedItems.slice(0, 6);
  let relatedUrls = lastRelatedItems.map((x) => x.link);
  const out = buildHtml(lastArticle, {
    adEnabled: settings.adEnabled, adCode: settings.adCode,
    accent: settings.overlayAccent || "#e11d48",
    searchLinks: settings.linkMode !== "model",
    searchContext: lastKeyword || lastArticle?.title || "",
    relatedUrls, sources: sourceItems,
    selfUrl: (mode === "naver" || mode === "wp") ? ($("bloggerUrl").value.trim() || settings.myBlogUrl || "") : ""
  });
  lastHtml = out.html;
  $("metaLine").textContent = `제목: ${lastArticle.title}` + (lastResolvedType ? ` · 유형: ${lastResolvedType}` : "") + `\n메타: ${lastArticle.metaDescription || "-"}`;
  $("preview").srcdoc = buildPreviewDoc(lastArticle.title, out.html);
}

// ---------- 이미지 수정 ----------
function renderImageEditors() {
  const box = $("imgEditList"); box.innerHTML = "";
  const imgs = (lastArticle?.blocks || []).filter((b) => b.type === "image");
  if (!imgs.length) { $("imgEditBox").classList.add("hidden"); return; }
  $("imgEditBox").classList.remove("hidden");
  imgs.forEach((b) => {
    const row = document.createElement("div"); row.className = "imgedit-row";
    const thumb = b.resolvedUrl ? `<img src="${b.resolvedUrl}" class="imgedit-thumb"/>` : `<div class="imgedit-thumb ph">미생성</div>`;
    const head = document.createElement("div"); head.className = "imgedit-head";
    head.innerHTML = `${thumb}<span>${b.slot === "thumbnail" ? "🖼️ 썸네일" : "본문 이미지"}</span>`;
    const input = document.createElement("input"); input.type = "text"; input.placeholder = "수정 요청 (예: 배경 더 어둡게, 표정 진지하게)";
    const btns = document.createElement("div"); btns.className = "imgedit-btns";
    const regen = document.createElement("button"); regen.className = "mini"; regen.textContent = "다시 생성";
    regen.addEventListener("click", () => regenImage(b, input.value.trim()));
    const edit = document.createElement("button"); edit.className = "mini"; edit.textContent = "부분 수정";
    edit.addEventListener("click", () => editImg(b, input.value.trim()));
    btns.appendChild(regen); btns.appendChild(edit);
    row.appendChild(head); row.appendChild(input); row.appendChild(btns); box.appendChild(row);
  });
}
async function regenImage(b, instr) {
  if (!config.kieEnabled) { setStatus("KIE 키가 필요합니다.", true); return; }
  const base = b._genPrompt || b.prompt || lastKeyword;
  const prompt = instr ? `${base}\n\n추가 수정 요청: ${instr}` : base;
  const aspect = b._aspect || (b._isThumb ? ($("imgAspect").value || "4:3") : "4:3");
  setStatus("이미지 다시 생성 중…");
  try {
    let url = await generateImage({ prompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || lastArticle.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url; b._genPrompt = prompt;
    rebuildPreview(); renderImageEditors(); setStatus("✅ 이미지 갱신됨");
  } catch (e) { setStatus("이미지 실패: " + e.message, true); }
}
async function editImg(b, instr) {
  if (!instr) { setStatus("수정 요청 문구를 입력하세요.", true); return; }
  if (!b.resolvedUrl || b.resolvedUrl.startsWith("data:")) { setStatus("부분 수정은 생성된 이미지(URL)만 가능. '다시 생성'을 쓰세요.", true); return; }
  const aspect = b._aspect || (b._isThumb ? ($("imgAspect").value || "4:3") : "4:3");
  setStatus("이미지 부분 수정 중…");
  try {
    let url = await editImage({ imageUrl: b.resolvedUrl, prompt: instr, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || lastArticle.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url;
    rebuildPreview(); renderImageEditors(); setStatus("✅ 이미지 수정됨");
  } catch (e) { setStatus("수정 실패: " + e.message, true); }
}

// ---------- 출력 ----------
async function onCopy() {
  if (!lastHtml) return;
  try { await navigator.clipboard.writeText(lastHtml); setStatus("📋 HTML 복사됨. 블로거/네이버/워드프레스 'HTML 편집' 모드에 붙여넣으세요."); }
  catch (e) { setStatus("복사 실패: " + e.message, true); }
}
async function wpPublish(status) {
  if (!lastArticle || !lastHtml) return;
  if (!config.wpEnabled) { setStatus("서버 .env 에 워드프레스 정보(WP_SITE/USER/PASSWORD)를 입력하세요.", true); return; }
  const label = status === "publish" ? "발행" : "초안 저장";
  try {
    setStatus(`워드프레스에 ${label} 중…`);
    const res = await wpCreatePost({ title: lastArticle.title, content: lastHtml, status });
    if (res.link) { try { await saveMyPost({ title: lastArticle.title, url: res.link, keyword: lastKeyword }); } catch {} }
    setStatus(`✅ ${label} 완료: ${res.link || ("글 #" + res.id)}`);
  } catch (e) { setStatus(`${label} 실패: ` + e.message, true); }
}
