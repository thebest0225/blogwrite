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
  genEngine: "claude", kieChatModel: "claude-sonnet-5", imageResolution: "1K",
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
const chatComplete = ({ system, user, maxTokens, model, engine }) =>
  apiJson("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system, user, maxTokens, model, engine: engine || settings?.genEngine }) }).then((j) => j.content);
const generateImage = ({ prompt, aspectRatio, resolution }) =>
  apiJson("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspect: aspectRatio, resolution }) }).then((j) => j.url);
const editImage = ({ imageUrl, prompt, aspectRatio, resolution }) =>
  apiJson("/api/image-edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl, prompt, aspect: aspectRatio, resolution }) }).then((j) => j.url);
const apiTrends = (force) => apiJson(`/api/trends${force ? "?force=1" : ""}`);
const storeList = () => apiJson("/api/store").then((j) => j.records || []);
const storeAdd = (rec) => apiJson("/api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) }).catch(() => {});
const storeDelete = (url) => apiJson("/api/store/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {});
const wpCreatePost = ({ title, content, status, destinationId }) => apiJson("/api/wp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, status, destinationId }) });
const accountsApi = () => apiJson("/api/destinations").then((j) => j.destinations || []);
const accountSave = (dst) => apiJson("/api/destinations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(dst) });
const accountDelete = (id) => apiJson("/api/destinations/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
const draftsList = () => apiJson("/api/drafts").then((j) => j.drafts || []);
const draftDelete = (id) => apiJson("/api/drafts/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
const draftStatus = (id, status) => apiJson("/api/drafts/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, status }) }).catch(() => {});

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

  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
  $("goAccounts")?.addEventListener("click", (e) => { e.preventDefault(); showView("accounts"); });
  $("genAll").addEventListener("click", generateAll);
  document.querySelectorAll(".mode-tab").forEach((b) => b.addEventListener("click", () => setGenMode(b.dataset.mode)));
  $("editToggle").addEventListener("click", toggleEdit);
  $("copyBtn").addEventListener("click", onCopy);
  $("wpDraftBtn").addEventListener("click", () => wpPublish("draft"));
  $("wpPublishBtn").addEventListener("click", () => wpPublish("publish"));
  $("mainUrlSave").addEventListener("click", onSaveMainUrl);
  $("workBack").addEventListener("click", () => { cur = null; $("workDetail").style.display = "none"; });
  $("myPostAdd").addEventListener("click", onAddMyPost);
  $("myPostSearch").addEventListener("input", () => renderMyPosts());
  $("trendRefresh").addEventListener("click", () => renderTrends(true));
  $("draftsRefresh").addEventListener("click", () => renderDrafts(true));
  $("draftSearch").addEventListener("input", () => { clearTimeout(_dq); _dq = setTimeout(() => renderDrafts(true), 300); });
  $("draftFilter").addEventListener("change", () => renderDrafts(true));
  $("draftsMore").addEventListener("click", () => renderDrafts(false));
  $("accPlatform").addEventListener("change", updateAccForm);
  $("accSave").addEventListener("click", onAccountSave);
  $("accCancel").addEventListener("click", resetAccForm);
  $("schMode").addEventListener("change", updateSchForm);
  $("schSave").addEventListener("click", onScheduleSave);
  $("schCancel").addEventListener("click", resetSchForm);
  $("optSave").addEventListener("click", onSaveOptions);
  $("pmClose").addEventListener("click", closeProgress);

  await refreshAccounts();
  updateInboxBadge();
  showView("board");
}
let _dq = null;
function showView(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  if (name === "board") renderWorkList();
  else if (name === "inbox") renderDrafts(true);
  else if (name === "accounts") renderAccounts();
  else if (name === "assets") renderMyPosts();
  else if (name === "schedule") renderSchedules();
  else if (name === "new") { setGenMode(genMode); if (!_trendsLoaded) renderTrends(false); }
  else if (name === "settings") populateSettings();
  window.scrollTo({ top: 0 });
}
async function updateInboxBadge() {
  try { const c = (await apiJson("/api/config")).newDrafts || 0; const b = $("inboxBadge"); b.textContent = c; b.classList.toggle("hidden", !c); } catch {}
}
let accounts = [];
let genMode = "destination";   // destination | cushion
const isDestForMode = (a) => { const r = a.role || "destination"; return r === "destination" || r === "both"; };
const isCushForMode = (a) => { const r = a.role || "destination"; return r === "cushion" || r === "both"; };
function accountsForMode() { return accounts.filter((a) => genMode === "destination" ? isDestForMode(a) : isCushForMode(a)); }
async function refreshAccounts() {
  try { accounts = await apiJson("/api/accounts").then((j) => j.accounts || []); } catch { accounts = []; }
  const el = $("genAccCount"); if (el) el.textContent = String(accountsForMode().length);
}
function setGenMode(mode) {
  genMode = mode;
  document.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const cushion = mode === "cushion";
  $("cushDestRow").classList.toggle("hidden", !cushion);
  $("modeAccLabel").textContent = cushion ? "쿠션" : "목적지";
  $("genAll").innerHTML = `<iconify-icon icon="solar:magic-stick-3-bold"></iconify-icon> ${cushion ? "쿠션 생성" : "목적지 생성"}`;
  $("modeHelp").innerHTML = cushion
    ? "발행된 <b>목적지 글</b>을 고르면, 원본+목적지를 함께 참고해 새 정보·연관검색어를 더한 <b>쿠션</b>을 계정별로 생성합니다."
    : "원본으로 <b>목적지 계정</b>에 완성글을 생성합니다. 생성 후 작업보드에서 발행하면 URL이 생겨요.";
  refreshAccounts();
  if (cushion) loadCushDests();
}
let cushAssets = [];
async function loadCushDests() {
  try { cushAssets = await apiJson("/api/assets").then((j) => j.assets || []); } catch { cushAssets = []; }
  const sel = $("cushDest"); sel.innerHTML = "";
  const o0 = document.createElement("option"); o0.value = ""; o0.textContent = cushAssets.length ? "— 발행된 목적지 선택 —" : "(발행된 목적지 없음 · 아래에 URL 직접 입력)"; sel.appendChild(o0);
  for (const a of cushAssets) { const o = document.createElement("option"); o.value = a.url; o.textContent = (a.title || a.url).slice(0, 60); sel.appendChild(o); }
}

// ---------- 계정 관리 ----------
const PLAT_LABEL = { wordpress: "워드프레스", blogger: "블로거", naver: "네이버" };
const ROLE_LABEL = { destination: "목적지", cushion: "쿠션", both: "겸용" };
function updateAccForm() {
  const p = $("accPlatform").value;
  $("accWpCreds").style.display = p === "wordpress" ? "" : "none";
  $("accHint").textContent = p === "wordpress" ? "WP: 사이트 URL + 사용자명 + 응용프로그램 비밀번호(자동발행용)"
    : p === "blogger" ? "블로거: 블로그 주소 입력. 자동발행은 구글 OAuth 연동 필요(추후). 지금은 HTML 복사용."
    : "네이버: 블로그 주소 입력. 자동발행 불가 → HTML 복사용.";
}
function resetAccForm() {
  $("accEditId").value = ""; $("accName").value = ""; $("accSite").value = "";
  $("accWpUser").value = ""; $("accWpPw").value = ""; $("accDefault").checked = false;
  $("accPlatform").value = "wordpress"; $("accRole").value = "destination"; updateAccForm();
  $("accSave").textContent = "계정 저장";
}
async function renderAccounts() {
  const box = $("accountsList"); let accs = []; try { accs = await accountsApi(); } catch {}
  box.innerHTML = "";
  if (!accs.length) { box.innerHTML = '<div class="hist-empty">등록된 계정이 없습니다. 아래에서 목적지/쿠션 계정을 추가하세요.</div>'; return; }
  for (const a of accs) {
    const row = document.createElement("div"); row.className = "acc-row";
    const rc = a.role === "destination" ? "dest" : (a.role === "both" ? "both" : "cush");
    row.innerHTML = `<span class="acc-badge ${rc}">${ROLE_LABEL[a.role] || a.role}</span>`
      + `<span class="nm">${a.name || "(이름없음)"}</span>`
      + `<span class="acc-plat">${PLAT_LABEL[a.platform] || a.platform}</span>`
      + (a.is_default ? '<span class="df">기본</span>' : "");
    const edit = document.createElement("button"); edit.className = "hist-del"; edit.textContent = "✎"; edit.title = "수정";
    edit.addEventListener("click", () => loadAccForEdit(a));
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { if (confirm("계정을 삭제할까요?")) { await accountDelete(a.id); renderAccounts(); } });
    row.appendChild(edit); row.appendChild(del); box.appendChild(row);
  }
  updateAccForm();
  refreshAccounts();
}
function loadAccForEdit(a) {
  $("accEditId").value = a.id; $("accName").value = a.name || ""; $("accPlatform").value = a.platform;
  $("accRole").value = a.role || "destination"; $("accSite").value = a.site_url || "";
  $("accDefault").checked = !!a.is_default; $("accWpUser").value = ""; $("accWpPw").value = "";
  updateAccForm(); $("accSave").textContent = "수정 저장"; $("accHint").textContent += " (자격증명 비워두면 기존 유지)";
  window.scrollTo({ top: 0, behavior: "smooth" });
}
async function onAccountSave() {
  const dst = {
    id: $("accEditId").value || undefined,
    name: $("accName").value.trim(), platform: $("accPlatform").value, role: $("accRole").value,
    site_url: $("accSite").value.trim(), is_default: $("accDefault").checked
  };
  if (!dst.name) { setStatus("계정 이름을 입력하세요.", true); return; }
  if (dst.platform === "wordpress") {
    const u = $("accWpUser").value.trim(), pw = $("accWpPw").value.trim();
    if (u || pw) dst.creds = { user: u, appPassword: pw };
  }
  try { await accountSave(dst); resetAccForm(); renderAccounts(); setStatus("✅ 계정 저장됨"); }
  catch (e) { setStatus("계정 저장 실패: " + e.message, true); }
}

// ---------- 자동화·예약 ----------
function updateSchForm() { $("schKwRow").style.display = $("schMode").value === "preset" ? "" : "none"; }
function resetSchForm() { $("schEditId").value = ""; $("schName").value = ""; $("schKeywords").value = ""; $("schMode").value = "preset"; $("schTimes").value = "1"; $("schAuto").value = "draft"; $("schEnabled").checked = true; updateSchForm(); $("schSave").textContent = "예약 저장"; }
async function renderSchedules() {
  const box = $("scheduleList"); let list = [];
  try { list = await apiJson("/api/schedules").then((j) => j.schedules || []); } catch {}
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="hist-empty">등록된 예약이 없습니다. 아래에서 추가하세요.</div>'; updateSchForm(); return; }
  for (const s of list) {
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `<span class="acc-badge ${s.enabled ? "dest" : "cush"}">${s.enabled ? "ON" : "OFF"}</span>`
      + `<span class="acc-plat">${s.mode === "trend" ? "트렌드탐색" : "지정키워드"} · 하루 ${s.times_per_day}회 · ${s.auto === "publish" ? "자동발행" : "초안만"}</span>`
      + `<span class="nm">${s.name || "(이름없음)"}</span>`;
    const edit = document.createElement("button"); edit.className = "hist-del"; edit.textContent = "✎";
    edit.addEventListener("click", () => { $("schEditId").value = s.id; $("schName").value = s.name || ""; $("schMode").value = s.mode; $("schKeywords").value = s.keywords || ""; $("schTimes").value = String(s.times_per_day || 1); $("schAuto").value = s.auto || "draft"; $("schEnabled").checked = !!s.enabled; updateSchForm(); $("schSave").textContent = "수정 저장"; });
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { if (confirm("예약을 삭제할까요?")) { await apiJson("/api/schedules/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) }).catch(() => {}); renderSchedules(); } });
    row.appendChild(edit); row.appendChild(del); box.appendChild(row);
  }
  updateSchForm();
}
async function onScheduleSave() {
  const s = { id: $("schEditId").value || undefined, name: $("schName").value.trim(), mode: $("schMode").value, keywords: $("schKeywords").value.trim(), times_per_day: parseInt($("schTimes").value, 10) || 1, auto: $("schAuto").value, enabled: $("schEnabled").checked };
  if (!s.name) { setStatus("예약 이름을 입력하세요.", true); return; }
  try { await apiJson("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }); resetSchForm(); renderSchedules(); setStatus("✅ 예약 저장됨 (실행 엔진은 다음 단계 연결)"); }
  catch (e) { setStatus("예약 저장 실패: " + e.message, true); }
}

// ---------- 초안함 (MCP/Claude로 받은 초안) ----------
let _draftOffset = 0; const DRAFT_PAGE = 50;
async function renderDrafts(reset) {
  const box = $("draftsList"); if (!box) return;
  if (reset) { _draftOffset = 0; box.innerHTML = ""; }
  const q = $("draftSearch")?.value?.trim() || "";
  const status = $("draftFilter")?.value || "";
  let data = { drafts: [], total: 0 };
  try { data = await apiJson(`/api/drafts?q=${encodeURIComponent(q)}&status=${status}&offset=${_draftOffset}&limit=${DRAFT_PAGE}`); } catch {}
  $("draftsCount").textContent = data.total ? `총 ${data.total}개` : "초안이 없습니다 (Claude/MCP에서 전송)";
  if (reset && !data.drafts.length) { box.innerHTML = '<div class="hist-empty">초안이 없습니다. Claude에서 작성해 전송하면 여기 쌓입니다.</div>'; }
  for (const d of data.drafts) {
    const row = document.createElement("div"); row.className = "hist-item";
    const b = document.createElement("button"); b.className = "hist-load";
    const tag = d.status === "used" ? "✅ " : (d.status === "new" ? "🆕 " : "");
    b.innerHTML = `<b>${tag}${(d.title || "(제목없음)")}</b>${d.keyword ? ` · ${d.keyword}` : ""}<div class="muted" style="font-weight:400;white-space:normal;">${(d.preview || "").replace(/</g, "&lt;")}…</div>`;
    b.addEventListener("click", () => loadDraft(d.id, d.title));
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => { e.preventDefault(); if (confirm("이 초안을 삭제할까요?")) { await draftDelete(d.id); renderDrafts(true); updateInboxBadge(); } });
    row.appendChild(b); row.appendChild(del); box.appendChild(row);
  }
  _draftOffset += data.drafts.length;
  $("draftsMore").classList.toggle("hidden", _draftOffset >= data.total);
}
async function loadDraft(id, title) {
  let d; try { d = await apiJson("/api/drafts/" + id); } catch { return; }
  $("originalText").value = d.content || "";
  activeDraftId = d.id;
  showView("new");
  setStatus(`📥 초안 "${d.title || title}" 불러옴. '계정별 전체 생성'을 누르세요.`);
}

function setStatus(msg, isError = false) { const el = $("status"); el.textContent = msg; el.classList.remove("hidden"); el.classList.toggle("error", isError); if (progressOpen && !isError) progressStep(msg); }

/* ===== 진행상황 모달 ===== */
let progressOpen = false;
function openProgress(title) {
  progressOpen = true;
  $("pmTitle").textContent = title;
  $("pmStep").textContent = "준비 중…";
  $("pmLog").innerHTML = "";
  $("pmFill").style.width = "2%";
  $("pmPct").textContent = "";
  $("pmSpinner").classList.remove("hidden");
  $("pmClose").classList.add("hidden");
  $("progressModal").classList.remove("hidden");
}
function progressStep(text, pct) {
  if (!progressOpen) return;
  $("pmStep").textContent = text;
  if (typeof pct === "number") progressBar(pct);
}
function progressBar(pct) { const p = Math.max(0, Math.min(100, Math.round(pct))); $("pmFill").style.width = p + "%"; $("pmPct").textContent = p + "%"; }
function progressLog(text, state = "done") {
  if (!progressOpen) return;
  const row = document.createElement("div"); row.className = "pm-logrow " + state;
  const ic = state === "error" ? "solar:close-circle-bold" : (state === "active" ? "solar:refresh-linear" : "solar:check-circle-bold");
  row.innerHTML = `<iconify-icon icon="${ic}"></iconify-icon><span>${escapeHtml(text)}</span>`;
  $("pmLog").appendChild(row); $("pmLog").scrollTop = $("pmLog").scrollHeight;
}
function progressDone(ok, msg) {
  if (!progressOpen) return;
  $("pmSpinner").classList.add("hidden");
  $("pmClose").classList.remove("hidden");
  $("pmStep").textContent = msg;
  $("pmStep").classList.toggle("err", !ok);
  if (ok) progressBar(100);
  $("pmTitle").textContent = ok ? "완료" : "오류";
}
function closeProgress() { progressOpen = false; $("progressModal").classList.add("hidden"); $("pmStep").classList.remove("err"); }
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

// ---------- 설정 (뷰) ----------
function populateSettings() {
  // API 키: 존재여부 표시 + 입력란 비움(비우면 유지)
  $("hasAnthropic").textContent = settings.hasAnthropicKey ? "· 설정됨" : "· 미설정(.env 폴백)";
  $("hasKie").textContent = settings.hasKieKey ? "· 설정됨" : "· 미설정(.env 폴백)";
  $("hasNid").textContent = settings.hasNaverClientId ? "· 설정됨" : "";
  $("hasNsec").textContent = settings.hasNaverClientSecret ? "· 설정됨" : "";
  ["optAnthropicKey", "optKieKey", "optNaverId", "optNaverSecret"].forEach((id) => { $(id).value = ""; });
  $("optEngine").value = settings.genEngine || "claude";
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
}
async function onSaveOptions() {
  const patch = {
    genEngine: $("optEngine").value,
    kieChatModel: $("optChatModel").value, thumbnailMode: $("optThumbMode").value, imageResolution: $("optImgRes").value,
    // 키는 입력했을 때만(비우면 유지)
    ...($("optAnthropicKey").value.trim() ? { anthropicKey: $("optAnthropicKey").value.trim() } : {}),
    ...($("optKieKey").value.trim() ? { kieKey: $("optKieKey").value.trim() } : {}),
    ...($("optNaverId").value.trim() ? { naverClientId: $("optNaverId").value.trim() } : {}),
    ...($("optNaverSecret").value.trim() ? { naverClientSecret: $("optNaverSecret").value.trim() } : {}),
    linkMode: $("optLinkMode").value, overlayAccent: $("optAccent").value, myBlogUrl: $("optMyBlog").value.trim(),
    defaultTone: $("optTone").value.trim(), defaultAudience: $("optAudience").value.trim(), authorBio: $("optAuthorBio").value.trim(),
    thumbnailStylePrompt: $("optThumbStyle").value.trim(), adEnabled: $("optAdEnabled").checked, adCode: $("optAdCode").value.trim()
  };
  try { await saveSettings(patch); settings = await getSettings(); try { config = await apiJson("/api/config"); } catch {} $("apiWarn").classList.toggle("hidden", !!config.kieEnabled || !!config.claudeEnabled); populateSettings(); setStatus("✅ 설정 저장됨"); }
  catch (e) { setStatus("설정 저장 실패: " + e.message, true); }
}

// ---------- 트렌드 ----------
let _trendsLoaded = false;
const STATE_MARK = { "+": "▲", n: "N", s: "" };
function seedFromTrend(it) {
  const lines = [it.title];
  const bits = [];
  if (it.traffic) bits.push(`검색량 ${it.traffic}`);
  if (it.source === "google") bits.push("구글 급상승"); else if (it.source === "signal") bits.push("실시간 검색어");
  if (bits.length) lines.push(`(${bits.join(" · ")})`);
  if (it.newsTitle) lines.push(`\n참고 뉴스: ${it.newsTitle}${it.newsSource ? " — " + it.newsSource : ""}`);
  if (it.newsUrl) lines.push(it.newsUrl);
  lines.push(`\n위 주제로 최신 정보를 반영한 상세한 블로그 글을 작성해줘. 핵심 배경, 왜 화제인지, 독자가 알아야 할 포인트, 관련 팁을 포함해서.`);
  return lines.join("\n");
}
async function renderTrends(force) {
  const box = $("trendList"); box.innerHTML = '<div class="hist-empty">불러오는 중…</div>';
  let data; try { data = await apiTrends(force); } catch { data = { items: [], ts: Date.now() }; }
  const items = data.items || []; box.innerHTML = ""; _trendsLoaded = true;
  if (!items.length) { box.innerHTML = '<div class="hist-empty">트렌드를 불러오지 못했어요. 잠시 후 새로고침 해보세요.</div>'; $("trendMeta").textContent = ""; return; }
  const d = new Date(data.ts || Date.now());
  const srcLabel = data.source === "signal" ? "실시간 검색어" : "구글 급상승";
  $("trendMeta").textContent = `${srcLabel} · ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 기준`;
  items.forEach((it, i) => {
    const card = document.createElement("button"); card.className = "trend-item"; card.type = "button";
    const mark = STATE_MARK[it.state] || "";
    card.innerHTML =
      `<span class="trend-rank">${i + 1}</span>`
      + `<span class="trend-main">`
      + `<span class="trend-kw">${escapeHtml(it.title)}`
      + (it.traffic ? ` <span class="trend-traffic">${escapeHtml(it.traffic)}</span>` : "")
      + (mark ? ` <span class="trend-state ${it.state === "+" ? "up" : "new"}">${mark}</span>` : "")
      + `</span>`
      + (it.newsTitle ? `<span class="trend-news">${escapeHtml(it.newsTitle)}</span>` : "")
      + `</span>`;
    card.addEventListener("click", () => {
      const cur = $("originalText").value.trim();
      if (cur && !confirm("원본 입력 내용을 이 트렌드 주제로 교체할까요?")) return;
      $("originalText").value = seedFromTrend(it);
      setGenMode("destination");
      $("originalText").focus();
      $("originalText").scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus(`✨ "${it.title}" 주제로 원본 입력을 채웠어요. 내용을 다듬거나 바로 '목적지 생성'을 누르세요.`);
    });
    if (it.newsUrl) {
      const a = document.createElement("a"); a.className = "trend-newslink"; a.href = it.newsUrl; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = `<iconify-icon icon="solar:square-top-down-linear"></iconify-icon> 뉴스`;
      a.addEventListener("click", (e) => e.stopPropagation());
      card.appendChild(a);
    }
    box.appendChild(card);
  });
}
function escapeHtml(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

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
// 워드프레스(목적지) 발행 주소 저장 → 쿠션 목적지로 세팅
async function onSaveMainUrl() {
  const url = $("mainUrlInput").value.trim();
  if (!/^https?:\/\//.test(url)) { setStatus("발행된 주소(https://...)를 입력하세요.", true); return; }
  const art = cur?.article;
  const plain = (cur?.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  await saveMyPost({ title: art?.title || deriveTopic() || "목적지 글", url, keyword: cur?.keyword || deriveTopic() }, plain);
  $("bloggerUrl").value = url;   // 쿠션 목적지로 자동 세팅
  $("mainUrlInput").value = "";
  setStatus("✅ 목적지 주소 저장 완료. 이제 블로거·네이버 쿠션이 이 글로 유입됩니다.");
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

// ---------- 계정별 생성 (계정 수만큼 각각 다른 글) ----------
let activeDraftId = null;
let workItems = [];
let cur = null;      // 현재 열람/편집 중 작업항목
let editMode = false;

const aspectFor = (acc) => (acc && acc.platform === "naver" ? "1:1" : "4:3");
const isDestRole = (acc) => { const r = (acc && acc.role) || "destination"; return r === "destination" || r === "both"; };
const accById = () => Object.fromEntries(accounts.map((a) => [a.id, a]));
function destUrlForGen() {
  const d = accounts.find((a) => isDestRole(a));
  return getDestUrl() || (d && d.site_url) || "";
}
function promptForAccount(acc, keyword, variant, destUrl, reference) {
  const sourceText = $("originalText").value.trim();
  const common = { keyword, audience: settings.defaultAudience, tone: settings.defaultTone, authorBio: settings.authorBio, today: todayStr(), imageCount: parseInt($("imgCount").value, 10) || 1, variant, reference };
  // 목적지 모드 = 목적지 글, 쿠션 모드 = 쿠션 글 (계정 역할이 겸용이어도 현재 모드 기준)
  if (genMode === "destination") return buildBloggerMain({ ...common, sourceText, internalLinks: [] });
  return buildCushionPrompt(acc.platform === "naver" ? "naver" : "blogger", { ...common, sourceText, bloggerUrl: destUrl });
}

// ----- 헬퍼(유지) -----
function enforceImageCount(article, n) {
  const blocks = article.blocks || []; const imgs = blocks.filter((b) => b.type === "image");
  if (imgs.length <= n) return; const keep = new Set(); const thumb = imgs.find((b) => b.slot === "thumbnail");
  if (thumb) keep.add(thumb); for (const b of imgs) { if (keep.size >= n) break; keep.add(b); }
  article.blocks = blocks.filter((b) => b.type !== "image" || keep.has(b));
}
function safeResolution(aspect) { const res = settings.imageResolution || "1K"; const [aw, ah] = (aspect || "16:9").split(":").map(Number); if (aw === ah && res === "4K") return "2K"; return res; }
async function genBlockImageAcc(acc, b, article, keyword) {
  const isThumb = b.slot === "thumbnail";
  const headline = (b.overlayText || article.title || keyword || "").slice(0, 40);
  let genPrompt = b.prompt || b.alt || keyword;
  const thumbStyle = settings.thumbnailStylePrompt || DEFAULT_THUMB_STYLE;
  if (isThumb && settings.thumbnailMode === "ai_full") {
    genPrompt = `${thumbStyle}\n\nScene: ${b.prompt || keyword}\n\nRender this EXACT Korean headline, large, bold, correctly spelled: "${headline}"\n\nHARD RULES: Korean headline in the TOP area, bottom clear. If a public figure is central show ONLY ONE person; else clean illustration/graphic-card with NO random people. NO cartoon mascot, graphs, arrows, flags, finance symbols.`;
  }
  const aspect = isThumb ? aspectFor(acc) : "4:3";
  b._genPrompt = genPrompt; b._headline = headline; b._isThumb = isThumb; b._aspect = aspect;
  let url = await generateImage({ prompt: genPrompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
  if (isThumb && settings.thumbnailMode === "overlay") { try { url = await composeThumbnail({ imageUrl: url, text: headline, accent: settings.overlayAccent || "#ff2d55", aspect }); } catch (e) { console.warn(e); } }
  b.resolvedUrl = url;
}
const ENTICERS = ["지금 바로 확인 →", "안 보면 손해 →", "여기서 확인 →", "놓치지 마세요 →"];
function insertTopCard(article, card) {
  const blocks = article.blocks || [];
  let idx = blocks.findIndex((b) => b.type === "image" && b.slot === "thumbnail"); idx = idx >= 0 ? idx + 1 : 0;
  blocks.splice(idx, 0, card); article.blocks = blocks;
}
function ensureTopLinkcard(role, article, keyword, relatedPosts, destUrl) {
  const blocks = article.blocks || [];
  if (blocks.slice(0, 4).some((b) => b.type === "linkcard")) return;
  const kw = (keyword || article.title || "").trim();
  const items = [];
  if (role === "cushion" && destUrl) items.push({ icon: "▶️", title: `${kw} 전체 내용 자세히 보기`, subtitle: "핵심만 빠르게 확인", label: "자세히 보기 →", url: destUrl, featured: true });
  (relatedPosts || []).slice(0, 3).forEach((p, i) => items.push({ icon: "🔗", title: p.title, subtitle: "함께 보면 좋은 글", label: ENTICERS[i] || "바로가기 →", url: p.link, featured: (role === "destination" && !items.length) }));
  if (!items.length) return;
  insertTopCard(article, { type: "linkcard", heading: role === "destination" ? "👉 이 글과 함께 보면 좋아요" : "👉 먼저 확인하세요", items });
}
function ensureNaverFunnel(article, keyword, relatedPosts, destUrl) {
  const blocks = article.blocks || [];
  const selfish = /자세히|전체|더보기|더 알아|원문|본문|계속|모두\s*보|보러\s*가|바로가기|확인하러/;
  article.blocks = blocks.filter((b) => {
    if (b.type === "cta") { const u = b.url || ""; return /^https?:\/\//i.test(u) && !selfish.test(b.label || ""); }
    if (b.type === "linkcard") return false;
    return true;
  });
  const kw = (keyword || article.title || "").trim(); const dest = destUrl || "#";
  const items = [{ icon: "▶️", title: `${kw} 전체 내용 자세히 보기`, subtitle: "핵심만 빠르게 확인", label: "지금 바로 확인 →", url: dest, featured: true }];
  if (relatedPosts && relatedPosts[0]) items.push({ icon: "🔗", title: relatedPosts[0].title, subtitle: "함께 보면 좋은 글", label: "놓치지 마세요 →", url: relatedPosts[0].link });
  else items.push({ icon: "📌", title: `${kw} 더 자세히 알아보기`, subtitle: "관련 정보 총정리", label: "여기서 확인 →", url: dest });
  insertTopCard(article, { type: "linkcard", heading: "👉 먼저 확인하세요", items });
}
function ytId(u) { const m = String(u || "").match(/(?:youtube\.com\/(?:watch\?[^#\s"'()]*\bv=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/); return m ? m[1] : ""; }
function embedYouTube(article) {
  const blocks = article.blocks || []; const out = []; const seen = new Set();
  for (const b of blocks) {
    if (b.type === "cta" && ytId(b.url)) { const id = ytId(b.url); if (!seen.has(id)) { seen.add(id); out.push({ type: "youtube", url: b.url, title: b.label || "" }); } continue; }
    out.push(b);
    let hay = ""; if (b.type === "paragraph") hay = b.text || ""; else if (b.type === "linkcard") hay = (b.items || []).map((it) => it.url || "").join(" ");
    if (hay) { const re = /(?:youtube\.com\/(?:watch\?[^#\s"'()]*\bv=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g; let mm; while ((mm = re.exec(hay))) { if (!seen.has(mm[1])) { seen.add(mm[1]); out.push({ type: "youtube", url: mm[0], title: "관련 영상" }); } } }
  }
  article.blocks = out;
}
function buildHtmlForAccount(acc, article, keyword, destUrl) {
  const isNaver = acc.platform === "naver"; const myPosts = isNaver ? [] : lastMyPosts;
  try {
    return buildHtml(article, {
      adEnabled: settings.adEnabled, adCode: settings.adCode, accent: settings.overlayAccent || "#e11d48",
      searchLinks: settings.linkMode !== "model", searchContext: keyword || article?.title || "",
      relatedUrls: myPosts.map((x) => x.link), relatedPosts: myPosts, sources: isNaver ? [] : lastSources,
      selfUrl: isDestRole(acc) ? "" : destUrl
    }).html;
  } catch (e) {
    console.error("preview build error:", e);
    try { return buildHtml(article, { accent: settings.overlayAccent || "#e11d48", searchLinks: false }).html; }
    catch { return `<h1>${(article?.title || "").replace(/</g, "&lt;")}</h1><p>미리보기 조립 오류. HTML 복사는 가능합니다.</p>`; }
  }
}
async function finalizeForAccount(acc, article, keyword, destUrl) {
  article.today = todayStr(); article.authorBio = settings.authorBio; article.keyword = keyword;
  const isNaver = acc.platform === "naver";
  if (genMode === "destination") ensureTopLinkcard("destination", article, keyword, lastMyPosts, "");
  else if (isNaver) ensureNaverFunnel(article, keyword, lastMyPosts, destUrl);
  else ensureTopLinkcard("cushion", article, keyword, lastMyPosts, destUrl);
  if (!isNaver) embedYouTube(article);
  enforceImageCount(article, parseInt($("imgCount").value, 10) || 1);
  if ($("genImages").checked && config.kieEnabled) {
    const imgs = (article.blocks || []).filter((b) => b.type === "image"); let i = 0;
    for (const b of imgs) { i++; setStatus(`[${acc.name}] 이미지 ${i}/${imgs.length}…`); try { await genBlockImageAcc(acc, b, article, keyword); } catch (e) { console.warn(e); } }
  }
  return buildHtmlForAccount(acc, article, keyword, destUrl);
}
// 목적지(원본 창작)=Claude 공식 API+웹서치 / 쿠션(초안 재가공)=KIE Claude
function engineForMode() {
  if (genMode === "destination") return config.claudeEnabled ? "claude" : "kie";
  return config.kieEnabled ? "kie" : "claude";
}
async function chatArticle(built) {
  const engine = engineForMode();
  let content = await chatComplete({ engine, model: settings.kieChatModel, system: built.system, user: built.user, maxTokens: 16000 });
  let article = tryParse(content);
  if (!article) { content = await chatComplete({ engine, model: settings.kieChatModel, system: built.system, user: built.user + "\n\n(JSON이 끊기지 않게 위 형식의 JSON 객체 하나로만 완결해줘.)", maxTokens: 16000 }); article = tryParse(content); }
  if (!article) throw new Error("JSON 파싱 실패: " + (content || "").slice(0, 120));
  return article;
}
async function generateAll() {
  if (!config.kieEnabled && !config.claudeEnabled) { setStatus("생성 엔진(Claude/KIE) 키가 없습니다. 설정에서 입력하세요.", true); return; }
  if (!$("originalText").value.trim()) { setStatus("원본 글을 붙여넣거나 초안함에서 선택하세요.", true); return; }
  await refreshAccounts();
  const accts = accountsForMode();
  if (!accts.length) {
    setStatus(genMode === "destination" ? "먼저 '계정 관리'에서 목적지 계정을 등록하세요." : "먼저 '계정 관리'에서 쿠션 계정(블로거/네이버)을 등록하세요.", true);
    showView("accounts"); return;
  }
  let destUrl = "", reference = "";
  if (genMode === "cushion") {
    destUrl = ($("cushDest").value || $("bloggerUrl").value.trim() || destUrlForGen());
    if (!destUrl) { setStatus("유입시킬 목적지 글을 선택하거나 URL을 입력하세요.", true); return; }
    const asset = (cushAssets || []).find((a) => a.url === destUrl);
    if (asset) reference = `[유입 목적지 글: ${asset.title || ""}]\n${asset.excerpt || asset.summary || ""}`.trim();
  }
  const keyword = deriveTopic();
  $("genAll").disabled = true;
  const modeLabel = genMode === "destination" ? "목적지" : "쿠션";
  openProgress(`${modeLabel} 글 생성`);
  const eng = engineForMode();
  progressLog(`엔진: ${eng === "claude" ? "Claude 공식 API · 웹서치 ON" : "KIE (Claude 모델)"} · 주제: ${keyword || "(원본 기반)"}`, "done");
  const total = accts.length; let okCount = 0;
  try {
    progressStep("관련 링크 수집 중…", 5);
    await gatherRelatedLinks(keyword);
    const gk = (a) => genMode + ":" + a.platform;
    const groups = {}; accts.forEach((a) => { (groups[gk(a)] = groups[gk(a)] || []).push(a); });
    const idxIn = {}; let done = 0;
    for (const acc of accts) {
      const k = gk(acc); idxIn[k] = (idxIn[k] || 0) + 1;
      const variant = { index: idxIn[k], total: groups[k].length };
      const base = 8 + Math.round((done / total) * 88);
      progressStep(`[${acc.name}] ${eng === "claude" ? "웹서치·작성" : "재가공"} 중… (${done + 1}/${total})`, base);
      let article;
      try { article = await chatArticle(promptForAccount(acc, keyword, variant, destUrl, reference)); }
      catch (e) { progressLog(`✗ ${acc.name} 실패: ${e.message}`, "error"); done++; continue; }
      const html = await finalizeForAccount(acc, article, keyword, destUrl);
      await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_id: activeDraftId, target: acc.platform, destination_id: acc.id, title: article.title || "", article, html, status: "generated", role: genMode }) }).catch(() => {});
      await storeAdd({ type: "article", title: article.title || "", keyword, platform: acc.platform });
      okCount++; done++;
      progressLog(`${acc.name} — ${(article.title || "").slice(0, 40) || "생성됨"}`, "done");
      progressBar(8 + Math.round((done / total) * 88));
    }
    if (activeDraftId) { await draftStatus(activeDraftId, "used"); renderDrafts(); }
    if (okCount) {
      progressDone(true, `${okCount}/${total}개 ${modeLabel} 글 생성 완료`);
      setStatus(`✅ ${okCount}개 ${modeLabel} 글 생성 완료. 작업보드에서 검수·발행하세요.`);
    } else {
      progressDone(false, "모든 계정 생성 실패. 키/네트워크를 확인하세요.");
    }
  } catch (e) { progressDone(false, "오류: " + e.message); setStatus("오류: " + e.message, true); }
  finally {
    $("genAll").disabled = false;
    if (okCount) { showView("board"); await renderWorkList(); if (workItems[0]) openWork(workItems[0].id); }
  }
}

// ---------- 작업 목록 ----------
async function renderWorkList() {
  try { workItems = await apiJson("/api/work").then((j) => j.items || []); } catch { workItems = []; }
  const box = $("workList");
  if (!workItems.length) { box.innerHTML = '<div class="hist-empty">진행 중 작업이 없습니다. 위에서 생성하세요.</div>'; if (!cur) $("resultCard").style.display = "none"; return; }
  $("resultCard").style.display = "";
  const amap = accById(); box.innerHTML = "";
  for (const w of workItems) {
    const acc = amap[w.destination_id] || { platform: w.target };
    const dest = isDestRole(acc);
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `<span class="acc-badge ${dest ? "dest" : "cush"}">${dest ? "목적지" : "쿠션"}</span>`
      + `<span class="acc-plat">${PLAT_LABEL[w.target] || w.target}${acc.name ? " · " + acc.name : ""}</span>`
      + `<span class="nm">${w.title || "(제목없음)"}</span>`
      + `<span class="df">${w.status === "generated" ? "생성됨" : w.status}</span>`;
    const open = document.createElement("button"); open.className = "mini"; open.textContent = "열기"; open.addEventListener("click", () => openWork(w.id));
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { await apiJson("/api/work/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id }) }).catch(() => {}); if (cur && cur.id === w.id) { cur = null; $("workDetail").style.display = "none"; } renderWorkList(); });
    row.appendChild(open); row.appendChild(del); box.appendChild(row);
  }
}
async function openWork(id) {
  let w; try { w = await apiJson("/api/work/" + id); } catch { return; }
  const acc = accById()[w.destination_id] || { platform: w.target, role: "cushion", name: "" };
  cur = { id: w.id, acc, target: w.target, article: w.article || { blocks: [] }, keyword: (w.article && w.article.keyword) || deriveTopic(), html: w.html || "", resolvedType: (w.article && w.article.type) || "", published_url: w.published_url };
  $("workDetail").style.display = "";
  renderCur();
  $("workDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderCur() {
  if (!cur) return;
  $("metaLine").textContent = `[${cur.acc.name || PLAT_LABEL[cur.target] || cur.target}] ${cur.article.title || ""}` + (cur.resolvedType ? ` · 유형:${cur.resolvedType}` : "") + `\n메타: ${cur.article.metaDescription || "-"}`;
  $("preview").srcdoc = buildPreviewDoc(cur.article.title || "", cur.html);
  $("wpActions").classList.toggle("hidden", cur.target !== "wordpress");
  $("mainUrlRow").classList.toggle("hidden", !isDestRole(cur.acc));
  renderImageEditors();
  if (editMode) renderEditor();
}
function rebuildCur() { if (cur) cur.html = buildHtmlForAccount(cur.acc, cur.article, cur.keyword, destUrlForGen()); }
async function saveCur() {
  if (!cur) return;
  await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", article: cur.article, html: cur.html, status: "generated" }) }).catch(() => {});
}

// ---------- 편집 모드 ----------
function toggleEdit() {
  editMode = !editMode;
  $("editToggle").classList.toggle("primary-mini", editMode);
  $("editToggle").innerHTML = editMode ? `<iconify-icon icon="solar:check-circle-bold"></iconify-icon> 편집 완료` : `<iconify-icon icon="solar:pen-2-linear"></iconify-icon> 편집`;
  $("editor").classList.toggle("hidden", !editMode);
  if (editMode) renderEditor();
}
function refreshAfterEdit() { rebuildCur(); $("preview").srcdoc = buildPreviewDoc(cur.article.title || "", cur.html); renderEditor(); saveCur(); }
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
  if (!cur) { box.innerHTML = '<div class="ed-hint">작업을 선택하세요.</div>'; return; }
  const d = document.createElement("div"); d.className = "ed-hint"; d.textContent = "블록 사이에 마우스를 올리면 글·버튼·이미지·영상을 추가할 수 있어요. 제목/문단은 바로 수정, ✕로 삭제.";
  box.appendChild(d);
  const blocks = cur.article.blocks || [];
  box.appendChild(insertBar(0));
  blocks.forEach((b, i) => { box.appendChild(blockRow(b, i)); box.appendChild(insertBar(i + 1)); });
}
function insertBar(index) {
  const bar = document.createElement("div"); bar.className = "ed-insert";
  const mk = (label, fn) => { const btn = document.createElement("button"); btn.textContent = label; btn.addEventListener("click", () => fn(index, bar)); return btn; };
  bar.appendChild(mk("+ 글", addTextAt)); bar.appendChild(mk("+ 버튼", addButtonAt)); bar.appendChild(mk("+ 이미지", addImageAt)); bar.appendChild(mk("+ 영상", addVideoAt));
  return bar;
}
function blockRow(b, i) {
  const row = document.createElement("div"); row.className = "ed-block";
  const del = document.createElement("button"); del.className = "ed-del"; del.textContent = "✕";
  del.addEventListener("click", () => { cur.article.blocks.splice(i, 1); refreshAfterEdit(); });
  row.appendChild(del);
  const type = document.createElement("div"); type.className = "ed-type"; type.textContent = ED_TYPE[b.type] || b.type; row.appendChild(type);
  if (b.type === "paragraph" || b.type === "heading") {
    const ta = document.createElement("textarea"); ta.rows = b.type === "heading" ? 1 : 3; ta.value = b.text || "";
    ta.addEventListener("input", () => { b.text = ta.value; });
    ta.addEventListener("blur", refreshAfterEdit); row.appendChild(ta);
  } else { const body = document.createElement("div"); body.className = "ed-body"; body.textContent = edSummary(b); row.appendChild(body); }
  return row;
}
function addTextAt(index) { cur.article.blocks.splice(index, 0, { type: "paragraph", text: "새 문단 내용을 입력하세요." }); refreshAfterEdit(); }
function addButtonAt(index, bar) {
  const form = document.createElement("div"); form.className = "ed-form";
  const label = document.createElement("input"); label.placeholder = "버튼 문구 (예: 자세히 보기 →)";
  const url = document.createElement("input"); url.placeholder = "링크 URL (비우면 목적지로)";
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "추가";
  ok.addEventListener("click", () => { const u = url.value.trim() || destUrlForGen() || "#"; cur.article.blocks.splice(index, 0, { type: "cta", label: label.value.trim() || "자세히 보기 →", url: u }); refreshAfterEdit(); });
  form.appendChild(label); form.appendChild(url); form.appendChild(ok); bar.replaceWith(form); label.focus();
}
function addVideoAt(index, bar) {
  const form = document.createElement("div"); form.className = "ed-form";
  const url = document.createElement("input"); url.placeholder = "유튜브 영상 주소";
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "삽입";
  ok.addEventListener("click", () => { if (!ytId(url.value.trim())) { setStatus("유효한 유튜브 주소가 아닙니다.", true); return; } cur.article.blocks.splice(index, 0, { type: "youtube", url: url.value.trim(), title: "" }); refreshAfterEdit(); });
  form.appendChild(url); form.appendChild(ok); bar.replaceWith(form); url.focus();
}
async function addImageAt(index, bar) {
  const form = document.createElement("div"); form.className = "ed-form";
  const desc = document.createElement("input"); desc.placeholder = "이미지 설명";
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "생성";
  ok.addEventListener("click", async () => {
    if (!config.kieEnabled) { setStatus("KIE 키가 필요합니다.", true); return; }
    ok.disabled = true; ok.textContent = "생성중…";
    try { const p = desc.value.trim() || cur.keyword || ""; const u = await generateImage({ prompt: p, aspectRatio: "4:3", resolution: safeResolution("4:3") }); cur.article.blocks.splice(index, 0, { type: "image", slot: "body", alt: desc.value.trim(), resolvedUrl: u, _genPrompt: p, _aspect: "4:3" }); refreshAfterEdit(); }
    catch (e) { setStatus("이미지 생성 실패: " + e.message, true); ok.disabled = false; ok.textContent = "생성"; }
  });
  form.appendChild(desc); form.appendChild(ok); bar.replaceWith(form); desc.focus();
}

// ---------- 이미지 수정 ----------
function renderImageEditors() {
  const box = $("imgEditList"); box.innerHTML = "";
  const imgs = (cur?.article?.blocks || []).filter((b) => b.type === "image");
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
  const base = b._genPrompt || b.prompt || (cur?.keyword || "");
  const prompt = instr ? `${base}\n\n추가 수정 요청: ${instr}` : base;
  const aspect = b._aspect || (b._isThumb ? aspectFor(cur.acc) : "4:3");
  setStatus("이미지 다시 생성 중…");
  try {
    let url = await generateImage({ prompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || cur.article.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url; b._genPrompt = prompt; refreshAfterEdit(); renderImageEditors(); setStatus("✅ 이미지 갱신됨");
  } catch (e) { setStatus("이미지 실패: " + e.message, true); }
}
async function editImg(b, instr) {
  if (!instr) { setStatus("수정 요청 문구를 입력하세요.", true); return; }
  if (!b.resolvedUrl || b.resolvedUrl.startsWith("data:")) { setStatus("부분 수정은 생성된 이미지(URL)만 가능.", true); return; }
  const aspect = b._aspect || (b._isThumb ? aspectFor(cur.acc) : "4:3");
  setStatus("이미지 부분 수정 중…");
  try {
    let url = await editImage({ imageUrl: b.resolvedUrl, prompt: instr, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (b._isThumb && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || cur.article.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    b.resolvedUrl = url; refreshAfterEdit(); renderImageEditors(); setStatus("✅ 이미지 수정됨");
  } catch (e) { setStatus("수정 실패: " + e.message, true); }
}

// ---------- 출력 / 발행 ----------
async function onCopy() {
  if (!cur?.html) return;
  try { await navigator.clipboard.writeText(cur.html); setStatus(`📋 [${cur.acc.name || cur.target}] HTML 복사됨. 편집기 'HTML' 모드에 붙여넣으세요.`); }
  catch (e) { setStatus("복사 실패: " + e.message, true); }
}
async function wpPublish(status) {
  if (!cur?.html) return;
  if (cur.target !== "wordpress") { setStatus("이 계정은 워드프레스 자동발행이 아닙니다. HTML 복사로 발행하세요.", true); return; }
  const label = status === "publish" ? "발행" : "초안 저장";
  try {
    setStatus(`[${cur.acc.name || "WP"}] ${label} 중…`);
    const res = await wpCreatePost({ title: cur.article.title, content: cur.html, status, destinationId: cur.acc.id });
    if (res.link) {
      try { await saveMyPost({ title: cur.article.title, url: res.link, keyword: cur.keyword }, (cur.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {}
      if (status === "publish") {
        if (isDestRole(cur.acc)) $("bloggerUrl").value = res.link;   // 목적지 → 쿠션 유입 URL
        // 발행 완료 → 작업 목록에서 제거(status published)
        await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", status: "published", published_url: res.link }) }).catch(() => {});
        cur = null; $("workDetail").style.display = "none"; renderWorkList();
      }
    }
    setStatus(`✅ ${label} 완료: ${res.link || ("글 #" + res.id)}${status === "publish" && isDestRole(cur?.acc || {}) ? " · 목적지로 설정됨" : ""}`);
  } catch (e) { setStatus(`${label} 실패: ` + e.message, true); }
}
