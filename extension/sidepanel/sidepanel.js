import { getSettings } from "../lib/storage.js";
import { chatComplete, generateImage, editImage } from "../lib/kie.js";
import { buildBloggerMain, buildCushionPrompt } from "../lib/prompts.js";
import { buildHtml, buildPreviewDoc } from "../lib/html-builder.js";
import { composeThumbnail } from "../lib/thumbnail.js";
import { expandKeywords } from "../lib/keywords.js";
import { getMyPosts, addMyPost, deleteMyPost, matchMyPosts } from "../lib/history.js";
import { cloudConfigured, cloudAdd, cloudList } from "../lib/cloud.js";
import { getTrends } from "../lib/trends.js";
import { wpConfigured, wpCreatePost, wpListForLinks, wpListPosts } from "../lib/wordpress-api.js";

const $ = (id) => document.getElementById(id);
let settings = null;
let mode = "blogger";       // blogger | naver | wp
let lastArticle = null;
let lastHtml = null;
let lastKeyword = "";
let lastResolvedType = "";
let lastRelatedItems = [];
let cloudCache = null;

const ASPECT_BY_MODE = { blogger: "4:3", wp: "4:3", naver: "1:1" };

init();

async function init() {
  settings = await getSettings();
  $("genImages").checked = settings.generateImages;
  $("imgCount").value = String(settings.imageCount || 1);
  applyModeUI();

  if (!settings.kieApiKey) $("apiWarn").classList.remove("hidden");

  $("modeBar").addEventListener("click", (e) => {
    const btn = e.target.closest(".mode");
    if (!btn) return;
    mode = btn.dataset.mode;
    applyModeUI();
  });
  $("openOptions").addEventListener("click", openOptions);
  $("goOptions")?.addEventListener("click", (e) => { e.preventDefault(); openOptions(); });
  $("generateBtn").addEventListener("click", onGenerate);
  $("copyBtn").addEventListener("click", onCopy);
  $("wpDraftBtn").addEventListener("click", () => wpPublish("draft"));
  $("wpPublishBtn").addEventListener("click", () => wpPublish("publish"));
  $("myPostAdd").addEventListener("click", onAddMyPost);
  $("myPostSearch").addEventListener("input", () => renderMyPosts());
  $("tabSaveBtn").addEventListener("click", onSaveCurrentTab);
  $("sheetOpenBtn").addEventListener("click", () => {
    if (settings.sheetViewUrl) window.open(settings.sheetViewUrl, "_blank");
    else setStatus("설정에 '구글 시트 보기 URL'을 넣으면 전체 목록을 열 수 있어요.", true);
  });
  $("trendRefresh").addEventListener("click", () => renderTrends(true));
  $("trendBox").addEventListener("toggle", (e) => { if (e.target.open) renderTrends(false); });

  renderMyPosts();
}

function applyModeUI() {
  document.querySelectorAll(".mode").forEach((m) => m.classList.toggle("active", m.dataset.mode === mode));
  const cushion = (mode === "naver" || mode === "wp");
  $("bloggerUrlRow").classList.toggle("hidden", !cushion);
  $("imgAspect").value = ASPECT_BY_MODE[mode] || "4:3";
  $("generateBtn").textContent = mode === "blogger" ? "✨ 블로거 메인 완성" : (mode === "naver" ? "🟢 네이버 글 만들기" : "🔵 워드프레스 글 만들기");
}

function openOptions() { chrome.runtime.openOptionsPage(); }
function setStatus(msg, isError = false) {
  const el = $("status");
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
}
function clearStatus() { $("status").classList.add("hidden"); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseJson(raw) {
  let t = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s > 0 || e < t.length - 1) t = t.slice(s, e + 1);
  return JSON.parse(t);
}
function tryParse(raw) { try { return parseJson(raw); } catch { return null; } }

function creds() { return { site: settings.wpSite, user: settings.wpUser, pass: settings.wpAppPassword }; }

// ---- 트렌드 ----
async function renderTrends(force) {
  const box = $("trendList");
  box.innerHTML = '<div class="hist-empty">불러오는 중…</div>';
  const { items, ts, stale } = await getTrends(force);
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = '<div class="hist-empty">트렌드를 불러오지 못했어요. 잠시 후 새로고침 하세요.</div>'; return; }
  const d = new Date(ts);
  $("trendMeta").textContent = `구글 급상승 · ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 기준${stale ? " (이전 캐시)" : ""}`;
  items.forEach((it, i) => {
    const row = document.createElement("div");
    row.className = "hist-item";
    const b = document.createElement("button");
    b.className = "hist-load";
    b.textContent = `${i + 1}. ${it.title}` + (it.traffic ? `  (${it.traffic})` : "");
    b.title = (it.news || []).join(" / ");
    b.addEventListener("click", () => { $("keyword").value = it.title; setStatus(`주제로 "${it.title}" 선택됨`); });
    row.appendChild(b);
    box.appendChild(row);
  });
}

// ---- 내 글 보관함 ----
async function getAllMyPosts() {
  const local = await getMyPosts();
  if (cloudConfigured(settings)) {
    if (!cloudCache) {
      const recs = await cloudList(settings);
      cloudCache = recs.filter((r) => r.url && /^https?:\/\//.test(r.url))
        .map((r) => ({ title: r.title || r.url, url: r.url, keyword: r.keyword || "" }));
    }
    const seen = new Set(local.map((p) => p.url));
    return [...local, ...cloudCache.filter((p) => !seen.has(p.url))];
  }
  return local;
}
async function renderMyPosts() {
  const box = $("myPostsList");
  const all = await getAllMyPosts();
  const q = ($("myPostSearch")?.value || "").toLowerCase().trim();
  const filtered = q
    ? all.filter((p) => ((p.title || "") + " " + (p.keyword || "") + " " + (p.url || "")).toLowerCase().includes(q))
    : all;
  const shown = filtered.slice(0, 30);
  const where = cloudConfigured(settings) ? "☁️ 구글 시트" : "💾 로컬만(시트 미연동)";
  $("myPostsCount").textContent = (q
    ? `전체 ${all.length}개 중 "${q}" ${filtered.length}개`
    : `전체 ${all.length}개${all.length > 30 ? " · 최근 30개 표시" : ""}`) + ` · 저장: ${where}`;
  box.innerHTML = "";
  if (!shown.length) { box.innerHTML = '<div class="hist-empty">' + (q ? "검색 결과 없음" : "보관된 글이 없습니다.") + '</div>'; return; }
  for (const p of shown) {
    const row = document.createElement("div");
    row.className = "hist-item";
    const a = document.createElement("a");
    a.className = "hist-load"; a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = p.title || p.url; a.title = p.url; a.style.textDecoration = "none";
    const del = document.createElement("button");
    del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => { e.preventDefault(); await deleteMyPost(p.url); await renderMyPosts(); });
    row.appendChild(a); row.appendChild(del);
    box.appendChild(row);
  }
}

// 지금 보고 있는 탭(발행된 내 글)을 보관함에 저장 — 블로거 발행 후 게시물 보기 상태에서 사용
async function onSaveCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:\/\//.test(tab.url)) { setStatus("현재 페이지 URL을 읽을 수 없어요.", true); return; }
    if (/chrome:\/\/|chrome-extension:\/\//.test(tab.url)) { setStatus("확장/설정 페이지는 저장할 수 없어요. 발행된 글 페이지에서 눌러주세요.", true); return; }
    const title = $("myPostTitle").value.trim() || tab.title || lastArticle?.title || tab.url;
    await saveMyPost({ title, url: tab.url, keyword: lastKeyword || $("keyword").value.trim(), createdAt: Date.now() });
    $("myPostTitle").value = ""; $("myPostUrl").value = "";
    setStatus("📍 현재 페이지를 보관함에 저장했어요.");
  } catch (e) { setStatus("저장 실패: " + e.message, true); }
}
async function onAddMyPost() {
  const url = $("myPostUrl").value.trim();
  const title = $("myPostTitle").value.trim();
  if (!/^https?:\/\//.test(url)) { setStatus("올바른 URL을 입력하세요.", true); return; }
  await saveMyPost({ title: title || url, url, keyword: title, createdAt: Date.now() });
  $("myPostUrl").value = ""; $("myPostTitle").value = "";
  setStatus("✅ 보관함에 추가됨" + (cloudConfigured(settings) ? " (시트 동기화)" : ""));
}
async function saveMyPost(entry) {
  await addMyPost(entry);
  cloudCache = null;
  await cloudAdd(settings, { type: "post", title: entry.title, url: entry.url, keyword: entry.keyword || "", createdAt: entry.createdAt });
  await renderMyPosts();
}

// ---- 링크 소스: 원본 내장 링크 + 내 보관함 ----
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
      const out = (j?.feed?.entry || []).map((e) => ({
        title: e.title?.$t || "내 글",
        link: (e.link || []).find((l) => l.rel === "alternate")?.href
      })).filter((x) => x.link);
      if (out.length) return out;
    }
  } catch {}
  if (wpConfigured(settings)) {
    try { const posts = await wpListPosts({ ...creds(), search: keyword, perPage: 3 }); return posts.map((p) => ({ title: p.title, link: p.link })); } catch {}
  }
  return [];
}

// ---- 프롬프트 조립 ----
async function buildCurrentPrompt(keyword) {
  const sourceText = $("originalText").value.trim();
  const common = {
    keyword,
    audience: settings.defaultAudience,
    tone: settings.defaultTone,
    authorBio: settings.authorBio, today: todayStr(),
    imageCount: parseInt($("imgCount").value, 10) || 1
  };
  if (mode === "blogger") {
    let internalLinks = [];
    if (settings.internalLinks && wpConfigured(settings)) { try { internalLinks = await wpListForLinks({ ...creds(), perPage: 50 }); } catch {} }
    return buildBloggerMain({ ...common, sourceText, internalLinks });
  }
  let relatedKeywords = [];
  const seed = keyword || (sourceText.split(/\n/)[0] || "").slice(0, 20);
  if (seed) { try { const { flat } = await expandKeywords(seed); relatedKeywords = flat.map((x) => x.keyword).slice(0, 15); } catch {} }
  return buildCushionPrompt(mode === "wp" ? "wp" : "naver", {
    ...common, sourceText, relatedKeywords,
    bloggerUrl: $("bloggerUrl").value.trim() || settings.myBlogUrl || ""
  });
}

// ---- 생성 ----
async function onGenerate() {
  settings = await getSettings();
  if (!settings.kieApiKey) { setStatus("KIE API 키를 먼저 설정에 입력하세요.", true); openOptions(); return; }
  const keyword = $("keyword").value.trim();
  if (!$("originalText").value.trim()) { setStatus("원본 글을 붙여넣으세요. (클로드에서 작성한 글)", true); return; }

  const btn = $("generateBtn");
  btn.disabled = true;
  $("result").classList.add("hidden");
  try {
    await gatherRelatedLinks(keyword);
    const built = await buildCurrentPrompt(keyword);

    setStatus(mode === "blogger" ? "① 블로거 메인 완성 중… (15~60초)" : "① 쿠션 글 작성 중… (15~60초)");
    let content = await chatComplete({ apiKey: settings.kieApiKey, model: settings.kieChatModel, system: built.system, user: built.user, maxTokens: 20000 });
    let article = tryParse(content);
    if (!article) {
      setStatus("① 형식 재요청 중…");
      const retry = built.user + "\n\n(참고: JSON이 끊기지 않게 위 형식의 JSON 객체 하나로만 완결해 주세요.)";
      content = await chatComplete({ apiKey: settings.kieApiKey, model: settings.kieChatModel, system: built.system, user: retry, maxTokens: 20000 });
      article = tryParse(content);
    }
    if (!article) {
      const startsJson = content.trim().startsWith("{") || /^\s*```(json)?\s*\{/.test(content);
      throw new Error((startsJson ? "글이 너무 길어 응답이 잘렸어요. 원본을 줄이거나 다시 시도하세요." : "생성 결과 JSON 파싱 실패. 다시 시도하세요.") + "\n응답 일부: " + content.slice(0, 160));
    }
    await finalizeArticle(article, keyword, built.resolvedType);
  } catch (e) {
    setStatus("오류: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
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
  if (isThumb && settings.thumbnailMode === "ai_full") {
    genPrompt = `${settings.thumbnailStylePrompt}\n\nScene: ${b.prompt || keyword}\n\nRender this EXACT Korean headline text, large, bold, correctly spelled: "${headline}"\n\nHARD RULES: put the Korean headline text in the TOP area, keep the bottom clear. If the topic centers on a public figure, show ONLY ONE main person; otherwise a clean illustration/graphic-card style with NO random people. NO cartoon mascot, NO graphs/charts, NO arrows, NO flags, NO finance symbols. Match ONLY the article's real topic.`;
  }
  const aspect = isThumb ? ($("imgAspect").value || "4:3") : "4:3";
  b._genPrompt = genPrompt; b._headline = headline; b._isThumb = isThumb; b._aspect = aspect;

  let url = await generateImage({ apiKey: settings.kieApiKey, model: settings.kieImageModel, prompt: genPrompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
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

// 쿠션 글: 상단에 클릭 유도 링크카드가 없으면 강제 삽입(썸네일 다음)
function ensureTopLinkcard(article, keyword) {
  const blocks = article.blocks || [];
  if (blocks.slice(0, 4).some((b) => b.type === "linkcard")) return;
  const kw = (keyword || article.title || "").trim();
  const card = {
    type: "linkcard",
    heading: "👉 먼저 확인하세요",
    items: [
      { icon: "▶️", title: `${kw} 전체 내용 자세히 보기`, subtitle: "핵심 정리·자세한 정보", label: "자세히 보기 →", featured: true },
      { icon: "📺", title: `${kw} 다시보기·시청 정보`, subtitle: "어디서 보는지 확인", label: "다시보기 →" },
      { icon: "👥", title: `${kw} 등장인물·출연진`, subtitle: "총정리", label: "총정리 →" }
    ]
  };
  let idx = blocks.findIndex((b) => b.type === "image" && b.slot === "thumbnail");
  idx = idx >= 0 ? idx + 1 : 0;
  blocks.splice(idx, 0, card);
  article.blocks = blocks;
}

async function finalizeArticle(article, keyword, resolvedType) {
  article.today = todayStr();
  article.authorBio = settings.authorBio;
  if (mode === "naver" || mode === "wp") ensureTopLinkcard(article, keyword);
  enforceImageCount(article, parseInt($("imgCount").value, 10) || 1);
  lastArticle = article; lastKeyword = keyword || ""; lastResolvedType = resolvedType || "";

  if ($("genImages").checked && settings.kieApiKey) {
    const imgBlocks = (article.blocks || []).filter((b) => b.type === "image");
    let i = 0;
    for (const b of imgBlocks) {
      i++;
      setStatus(`② 이미지 생성 중… (${i}/${imgBlocks.length})`);
      try { await genBlockImage(b, article, keyword); } catch (e) { console.warn("이미지 실패:", e); }
    }
  }

  rebuildPreview();
  $("result").classList.remove("hidden");
  $("wpActions").classList.toggle("hidden", !(mode === "wp" && wpConfigured(settings)));
  renderImageEditors();
  // 블로거 메인: 발행 후 URL만 넣으면 되게 제목 미리 채움
  if (mode === "blogger") $("myPostTitle").value = article.title || "";
  clearStatus();

  // 클라우드 기록
  try {
    const plainBody = (lastHtml || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
    const thumb = (article.blocks || []).find((b) => b.type === "image" && b.slot === "thumbnail")?.resolvedUrl || "";
    await cloudAdd(settings, { type: "article", title: article.title || "", keyword: lastKeyword, summary: article.metaDescription || "", platform: mode, images: thumb ? [thumb] : [], body: plainBody, createdAt: Date.now() });
  } catch {}

  // 쿠션 글이 링크한 메인 URL을 보관함에 등록
  try {
    const bu = $("bloggerUrl")?.value?.trim();
    if ((mode === "naver" || mode === "wp") && bu) await saveMyPost({ title: lastKeyword || article.title || "내 글", url: bu, keyword: lastKeyword, createdAt: Date.now() });
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

// ---- 이미지 수정 ----
function renderImageEditors() {
  const box = $("imgEditList");
  box.innerHTML = "";
  const imgs = (lastArticle?.blocks || []).filter((b) => b.type === "image");
  if (!imgs.length) { $("imgEditBox").classList.add("hidden"); return; }
  $("imgEditBox").classList.remove("hidden");
  imgs.forEach((b) => {
    const row = document.createElement("div");
    row.className = "imgedit-row";
    const thumb = b.resolvedUrl ? `<img src="${b.resolvedUrl}" class="imgedit-thumb"/>` : `<div class="imgedit-thumb ph">미생성</div>`;
    const head = document.createElement("div");
    head.className = "imgedit-head";
    head.innerHTML = `${thumb}<span>${b.slot === "thumbnail" ? "🖼️ 썸네일" : "본문 이미지"}</span>`;
    const input = document.createElement("input");
    input.type = "text"; input.placeholder = "수정 요청 (예: 배경 더 어둡게, 표정 진지하게)";
    const btns = document.createElement("div");
    btns.className = "imgedit-btns";
    const regen = document.createElement("button");
    regen.className = "mini"; regen.textContent = "다시 생성";
    regen.addEventListener("click", () => regenImage(b, input.value.trim()));
    const edit = document.createElement("button");
    edit.className = "mini"; edit.textContent = "부분 수정";
    edit.addEventListener("click", () => editImg(b, input.value.trim()));
    btns.appendChild(regen); btns.appendChild(edit);
    row.appendChild(head); row.appendChild(input); row.appendChild(btns);
    box.appendChild(row);
  });
}
async function regenImage(b, instr) {
  settings = await getSettings();
  if (!settings.kieApiKey) { setStatus("KIE 키가 필요합니다.", true); return; }
  const base = b._genPrompt || b.prompt || lastKeyword;
  const prompt = instr ? `${base}\n\n추가 수정 요청: ${instr}` : base;
  const aspect = b._aspect || (b._isThumb ? ($("imgAspect").value || "4:3") : "4:3");
  setStatus("이미지 다시 생성 중…");
  try {
    let url = await generateImage({ apiKey: settings.kieApiKey, model: settings.kieImageModel, prompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || lastArticle.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url; b._genPrompt = prompt;
    rebuildPreview(); renderImageEditors(); setStatus("✅ 이미지 갱신됨");
  } catch (e) { setStatus("이미지 실패: " + e.message, true); }
}
async function editImg(b, instr) {
  settings = await getSettings();
  if (!instr) { setStatus("수정 요청 문구를 입력하세요.", true); return; }
  if (!b.resolvedUrl || b.resolvedUrl.startsWith("data:")) { setStatus("부분 수정은 생성된 이미지(URL)만 가능. '다시 생성'을 쓰세요.", true); return; }
  const aspect = b._aspect || (b._isThumb ? ($("imgAspect").value || "4:3") : "4:3");
  setStatus("이미지 부분 수정 중…");
  try {
    let url = await editImage({ apiKey: settings.kieApiKey, imageUrl: b.resolvedUrl, prompt: instr, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || lastArticle.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url;
    rebuildPreview(); renderImageEditors(); setStatus("✅ 이미지 수정됨");
  } catch (e) { setStatus("수정 실패: " + e.message, true); }
}

// ---- 출력 ----
async function onCopy() {
  if (!lastHtml) return;
  try { await navigator.clipboard.writeText(lastHtml); setStatus("📋 HTML 복사됨. 블로거/네이버/워드프레스 'HTML 편집' 모드에 붙여넣으세요."); }
  catch (e) { setStatus("복사 실패: " + e.message, true); }
}
async function wpPublish(status) {
  if (!lastArticle || !lastHtml) return;
  settings = await getSettings();
  if (!wpConfigured(settings)) { setStatus("설정에서 워드프레스 정보를 입력하세요.", true); return; }
  const label = status === "publish" ? "발행" : "초안 저장";
  try {
    setStatus(`워드프레스에 ${label} 중…`);
    const res = await wpCreatePost({ ...creds(), title: lastArticle.title, content: lastHtml, status });
    if (res.link) { try { await saveMyPost({ title: lastArticle.title, url: res.link, keyword: lastKeyword, createdAt: Date.now() }); } catch {} }
    setStatus(`✅ ${label} 완료: ${res.link || ("글 #" + res.id)}`);
  } catch (e) { setStatus(`${label} 실패: ` + e.message, true); }
}
