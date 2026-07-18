// 블로그 오토라이터 — 웹앱 프론트 (파이프라인: 원본 1개 → 블로거·네이버·워드프레스 3종)
import { buildBloggerMain, buildCushionPrompt, buildDraftPrompt } from "./lib/prompts.js";
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
`Ultra eye-catching Korean thumbnail engineered for MAXIMUM click-through, following current top-creator trends (2026). Bold high-saturation color-blocked or duotone background; the main subject POPS off the background with a subtle glow / rim light and shallow depth of field. ONE clear focal subject, uncluttered. ADAPT to the subject: (a) real person central → photorealistic dramatic close-up portrait with strong natural emotion (surprise / serious / curious), moody cinematic rim lighting; (b) product/object → bold hero shot with dramatic lighting; (c) concept/issue/how-to → one striking symbolic cinematic scene. Big HEAVY Korean sans-serif headline (3–6 words) in the TOP area, with a thick contrasting outline AND a solid highlight box behind ONE key word for a strong color pop; keep the bottom third clear. Text must be HUGE, PERFECTLY spelled, and readable as a tiny mobile thumbnail. Premium, punchy, high-contrast — but clean, NOT busy. NO cartoon mascots, NO cheap clip-art graphs/arrows/flags/finance icons, NO random extra people, NO messy collage.`;

const DEFAULTS = {
  genEngine: "claude", kieChatModel: "claude-sonnet-5", imageResolution: "1K",
  thumbnailMode: "ai_full", thumbnailStylePrompt: "", overlayAccent: "#ff2d55",
  linkMode: "preserve", myBlogUrl: "", defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자",
  authorBio: "여러 분야의 정보를 직접 찾아보고, 최신 자료와 공식 출처를 확인해 이해하기 쉽게 정리합니다. 검색만으로는 흩어져 있던 내용을 한곳에 모아, 실제로 도움이 되는 알맹이만 담으려 합니다.",
  adEnabled: false, adCode: "", internalLinks: false, generateImages: true, imageCount: 1, autoPublish: false, stockPhotos: true, autoProcessDrafts: false
};

// ---------- API ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function apiJson(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401) { let j = {}; try { j = await r.json(); } catch {} location.href = j.login || "https://mangois.love/"; throw new Error("로그인 필요"); }
  const t = await r.text();
  // Cloudflare/게이트웨이 HTML 방어 — 원시 HTML을 에러로 노출하지 않음
  if (/^\s*<(?:!doctype|html)|no-js ie6 oldie/i.test(t)) {
    throw new Error(r.status === 504 || r.status === 524 ? "서버 응답 시간 초과(잠시 후 다시 시도해 주세요)." : "게이트웨이 오류(잠시 후 다시 시도해 주세요).");
  }
  let j; try { j = JSON.parse(t); } catch { throw new Error(t.slice(0, 150)); }
  if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
// 긴 생성은 백그라운드 잡+폴링(터널 타임아웃 회피). 중단(genAborted) 지원.
async function chatComplete({ system, user, maxTokens, model, engine }) {
  const { jobId } = await apiJson("/api/chat/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ system, user, maxTokens, model, engine: engine || settings?.genEngine }) });
  let fails = 0;
  for (;;) {
    if (genAborted) throw new Error("__abort__");
    await sleep(2500);
    let st;
    try { st = await apiJson("/api/chat/status?id=" + encodeURIComponent(jobId)); fails = 0; }
    catch (e) { if (/작업/.test(e.message)) throw new Error("작업이 유실됐어요(서버 재시작 등). 다시 생성해 주세요."); if (++fails > 8) throw new Error("서버 응답이 없어 중단했어요. 다시 시도해 주세요."); continue; }
    if (st.status === "done") return st.content;
    if (st.status === "error") throw new Error(st.error || "AI 응답 실패");
  }
}
const generateImage = ({ prompt, aspectRatio, resolution }) =>
  apiJson("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, aspect: aspectRatio, resolution }) }).then((j) => j.url);
const editImage = ({ imageUrl, prompt, aspectRatio, resolution }) =>
  apiJson("/api/image-edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ imageUrl, prompt, aspect: aspectRatio, resolution }) }).then((j) => j.url);
const apiTrends = (force) => apiJson(`/api/trends${force ? "?force=1" : ""}`);
const storeList = () => apiJson("/api/store").then((j) => j.records || []);
const storeAdd = (rec) => apiJson("/api/store", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rec) }).catch(() => {});
const storeDelete = (url) => apiJson("/api/store/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) }).catch(() => {});
const wpCreatePost = ({ title, content, status, destinationId, category, postId, postUrl }) => apiJson("/api/wp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, content, status, destinationId, category, postId, postUrl }) });
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
  $("genDraft").addEventListener("click", generateDraft);
  // 편집해도 불러온 초안 연결은 유지(발행 시 '사용됨' 처리되게). 주제 재추출·목적지 자동선택만.
  $("originalText").addEventListener("input", () => { if (genMode !== "draft") { $("genKeyword").value = deriveTopic(); autoSelectAccountsByTopic(true); } });
  $("genKeyword").addEventListener("input", () => autoSelectAccountsByTopic(true));
  $("copyDraftPrompt").addEventListener("click", copyDraftPromptText);
  document.querySelectorAll(".mode-tab").forEach((b) => b.addEventListener("click", () => setGenMode(b.dataset.mode)));
  $("editToggle").addEventListener("click", toggleEdit);
  $("editor").addEventListener("dragover", (e) => { if (editMode) { e.preventDefault(); $("editor").classList.add("ied-dragover"); } });
  $("editor").addEventListener("dragleave", () => $("editor").classList.remove("ied-dragover"));
  $("editor").addEventListener("drop", onEditorDrop);
  $("editor").addEventListener("paste", onEditorPaste);
  $("copyBtn").addEventListener("click", onCopy);
  $("wpDraftBtn").addEventListener("click", () => wpPublish("draft"));
  $("wpPublishBtn").addEventListener("click", () => wpPublish("publish"));
  $("mainUrlSave").addEventListener("click", onSaveMainUrl);
  $("markPublishedBtn").addEventListener("click", onMarkPublished);
  $("schedPubSet").addEventListener("click", onSchedulePublishSet);
  $("schedPubClear").addEventListener("click", onSchedulePublishClear);
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
  $("accGoogleConnect").addEventListener("click", onGoogleConnect);
  $("bloggerPublishBtn").addEventListener("click", bloggerPublish);
  $("updatePublishBtn").addEventListener("click", updatePublish);
  $("pullLiveBtn").addEventListener("click", pullLive);
  $("schSource").addEventListener("change", updateSchForm);
  $("schScope").addEventListener("change", updateSchForm);
  $("schSave").addEventListener("click", onScheduleSave);
  $("schCancel").addEventListener("click", resetSchForm);
  $("optSave").addEventListener("click", onSaveOptions);
  $("pmClose").addEventListener("click", closeProgress);
  $("pmCancel").addEventListener("click", cancelProgress);
  $("historyRefresh").addEventListener("click", renderHistory);
  $("historySearch").addEventListener("input", () => renderHistory());
  $("historyFilter").addEventListener("change", () => renderHistory());
  $("historyMode").addEventListener("change", () => renderHistory());

  await refreshAccounts();
  updateInboxBadge();
  showView("board");
  handleBloggerReturn();
}
function handleBloggerReturn() {
  const p = new URLSearchParams(location.search);
  const b = p.get("blogger");
  if (!b) return;
  if (b === "ok") { setStatus("✅ 블로거 구글 연결 완료! 이제 자동발행이 가능합니다."); showView("accounts"); }
  else { setStatus("블로거 연결 실패: " + (p.get("msg") || "다시 시도해 주세요(구글 재동의 필요할 수 있음)."), true); showView("accounts"); }
  history.replaceState(null, "", location.pathname);
}
let _dq = null;
function showView(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  if (name === "board") renderWorkList();
  else if (name === "inbox") renderDrafts(true);
  else if (name === "accounts") renderAccounts();
  else if (name === "history") renderHistory();
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
let genMode = "draft";   // draft | destination | cushion
const isDestForMode = (a) => { const r = a.role || "destination"; return r === "destination" || r === "both"; };
const isCushForMode = (a) => { const r = a.role || "destination"; return r === "cushion" || r === "both"; };
function accountsForMode() {
  if (genMode === "destination") return accounts.filter(isDestForMode);
  if (genMode === "cushion") return accounts.filter(isCushForMode);
  return [];
}
async function refreshAccounts() {
  try { accounts = await apiJson("/api/accounts").then((j) => j.accounts || []); } catch { accounts = []; }
  const el = $("genAccCount"); if (el) el.textContent = String(accountsForMode().length);
  renderAccPicker();
}
function renderAccPicker() {
  const box = $("genAccPick"); if (!box) return;
  // 기존 체크 상태 보존(재렌더 시 사용자가 해제한 계정이 다시 체크되지 않도록)
  const prev = {}; box.querySelectorAll("input").forEach((i) => { prev[i.value] = i.checked; });
  const hadAny = Object.keys(prev).length > 0;
  const list = accountsForMode(); box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<span class="muted">등록된 ${genMode === "destination" ? "목적지" : "쿠션"} 계정이 없습니다. '계정 관리'에서 추가하세요.</span>`; return; }
  for (const a of list) {
    const checked = hadAny ? (prev[a.id] !== false) : true;   // 기존에 해제했으면 유지, 새 계정/최초엔 체크
    const lab = document.createElement("label"); lab.className = "acc-pick";
    lab.innerHTML = `<input type="checkbox" value="${a.id}" ${checked ? "checked" : ""}>`
      + `<span class="acc-badge ${genMode === "destination" ? "dest" : "cush"}">${PLAT_LABEL[a.platform] || a.platform}</span>`
      + `<span class="nm">${escapeHtml(a.name || "(이름없음)")}</span>`;
    box.appendChild(lab);
  }
}
function selectedAccountsForMode() {
  const checked = new Set([...document.querySelectorAll("#genAccPick input:checked")].map((i) => i.value));
  return accountsForMode().filter((a) => checked.has(String(a.id)));
}
function setGenMode(mode) {
  genMode = mode;
  document.querySelectorAll(".mode-tab").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const isDraft = mode === "draft", isCush = mode === "cushion";
  $("draftGenRow").classList.toggle("hidden", !isDraft);
  $("cushDestRow").classList.toggle("hidden", !isCush);
  $("genKwRow").classList.toggle("hidden", isDraft);
  $("imgRow").classList.toggle("hidden", isDraft);
  $("accPickWrap").classList.toggle("hidden", isDraft);
  $("genAll").classList.toggle("hidden", isDraft);
  $("genDraft").classList.toggle("hidden", !isDraft);
  if (!isDraft && !$("genKeyword").value.trim()) $("genKeyword").value = deriveTopic();
  $("originalLabel").innerHTML = isDraft
    ? `생성된 초안 <span class="muted">— AI 초안 결과가 여기 채워집니다(직접 붙여넣기·수정도 가능)</span>`
    : `원본 글(초안) <span class="muted">— 붙여넣기 / 초안함에서 불러오기 / ① 초안 만들기 결과</span>`;
  $("originalText").placeholder = isDraft ? "위에서 키워드로 AI 초안을 생성하거나, 직접 초안을 붙여넣으세요." : "상세한 원본 글(초안)을 붙여넣으세요.";
  if (!isDraft) { $("modeAccLabel").textContent = isCush ? "쿠션" : "목적지"; $("genAll").innerHTML = `<iconify-icon icon="solar:magic-stick-3-bold"></iconify-icon> ${isCush ? "쿠션 생성" : "목적지 생성"}`; }
  $("modeHelp").innerHTML =
    isDraft ? "키워드를 넣고 <b>AI 초안 생성</b>을 누르면 Claude가 웹서치로 정보·연관검색어·링크가 풍부한 <b>초안</b>을 만듭니다. 완성되면 <b>② 목적지</b> 탭으로 넘어가세요. (직접 쓴 초안을 붙여넣어도 됩니다)"
    : isCush ? "발행된 <b>목적지 글</b>을 고르면, 초안+목적지를 함께 참고해 새 정보·연관검색어를 더한 <b>쿠션</b>을 계정별로 생성합니다."
    : "초안(원본)으로 <b>목적지 계정</b>에 발행용 완성글을 생성합니다. 생성 후 작업보드에서 발행하면 URL이 생겨요.";
  refreshAccounts().then(() => { if (mode !== "draft") autoSelectAccountsByTopic(true); });
  if (isCush) loadCushDests();
}
// 초안 주제 ↔ 계정 topics 매칭 점수
function accountTopicMatch(acc, text) {
  const topics = (acc.topics || "").split(/[,\n]/).map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2);
  if (!topics.length) return 0;
  const hay = (text || "").toLowerCase();
  let s = 0; for (const t of topics) if (hay.includes(t)) s++;
  return s;
}
// 니치 매칭으로 목적지 자동 체크 (매칭되는 게 있을 때만; 없으면 기존 유지)
function autoSelectAccountsByTopic(silent) {
  const box = $("genAccPick"); if (!box) return;
  const inputs = [...box.querySelectorAll("input")]; if (!inputs.length) return;
  const list = accountsForMode(); const amap = {}; list.forEach((a) => (amap[a.id] = a));
  if (!list.some((a) => (a.topics || "").trim())) return;   // 주제 미설정이면 자동선택 안 함
  const text = ($("genKeyword").value || "") + " " + ($("originalText").value || "").slice(0, 800);
  const scored = inputs.map((i) => ({ i, s: amap[i.value] ? accountTopicMatch(amap[i.value], text) : 0 }));
  if (!scored.some((x) => x.s > 0)) return;                 // 매칭 없으면 기존 유지
  scored.forEach((x) => { x.i.checked = x.s > 0; });
  if (!silent) setStatus("니치 매칭으로 목적지를 자동 선택했어요(체크는 수동으로 바꿀 수 있어요).");
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
  $("accBloggerConnect").style.display = p === "blogger" ? "" : "none";
  $("accHint").textContent = p === "wordpress" ? "WP: 사이트 URL + 사용자명 + 응용프로그램 비밀번호(자동발행용)"
    : p === "blogger" ? "블로거: 블로그 주소 입력 → 저장 → '구글 연결'로 자동발행. (연결 전엔 HTML 복사식)"
    : "네이버: 블로그 주소 입력. 자동발행 불가 → HTML 복사식.";
}
function resetAccForm() {
  $("accEditId").value = ""; $("accName").value = ""; $("accSite").value = ""; $("accPersona").value = ""; $("accTopics").value = "";
  ["accTone", "accAudience", "accAuthorBio", "accThumbStyle"].forEach((id) => { $(id).value = ""; });
  const uEl = $("accWpUser"), pEl = $("accWpPw");
  uEl.value = ""; pEl.value = ""; uEl.placeholder = ""; pEl.placeholder = ""; uEl.classList.remove("saved"); pEl.classList.remove("saved");
  $("accDefault").checked = false;
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
      + (a.platform === "wordpress" ? `<span class="cred-chip ${a.has_creds ? "on" : "off"}"><iconify-icon icon="${a.has_creds ? "solar:lock-keyhole-bold" : "solar:lock-keyhole-unlocked-linear"}"></iconify-icon>${a.has_creds ? "인증 저장됨" : "인증 없음"}</span>`
        : a.platform === "blogger" ? `<span class="cred-chip ${a.has_creds ? "on" : "off"}"><iconify-icon icon="${a.has_creds ? "solar:link-bold" : "solar:link-broken-linear"}"></iconify-icon>${a.has_creds ? "구글 연결됨" : "연결 필요"}</span>` : "")
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
  $("accTopics").value = a.topics || "";
  $("accPersona").value = a.persona || "";
  const ov = a.overrides || {};
  $("accTone").value = ov.tone || ""; $("accAudience").value = ov.audience || ""; $("accAuthorBio").value = ov.authorBio || ""; $("accThumbStyle").value = ov.thumbStyle || "";
  $("accDefault").checked = !!a.is_default;
  const saved = !!a.has_creds;
  const uEl = $("accWpUser"), pEl = $("accWpPw");
  uEl.value = ""; pEl.value = "";
  uEl.placeholder = saved ? "•••• 저장됨 (변경할 때만)" : "";
  pEl.placeholder = saved ? "•••••••• 저장됨 (변경할 때만)" : "";
  uEl.classList.toggle("saved", saved); pEl.classList.toggle("saved", saved);
  updateAccForm(); $("accSave").textContent = "수정 저장";
  if (a.platform === "blogger") {
    $("accGoogleStatus").innerHTML = saved
      ? '<span style="color:var(--ok-fg);font-weight:700;">✓ 구글 연결됨 — 자동발행 가능</span> (다시 누르면 재연결)'
      : "아직 구글 연결 안 됨. '구글 연결'을 눌러 인증하세요.";
    $("accGoogleConnect").innerHTML = `<iconify-icon icon="solar:login-3-bold"></iconify-icon> ${saved ? "재연결" : "구글 연결"}`;
  } else {
    $("accHint").textContent += saved ? " · 자격증명이 저장돼 있습니다(비워두면 유지)" : " · 자격증명 비워두면 기존 유지";
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function onGoogleConnect() {
  const id = $("accEditId").value;
  if (!id) { setStatus("먼저 계정을 저장한 뒤 '구글 연결'을 누르세요.", true); return; }
  if (!config.googleOAuth) { setStatus("서버에 구글 OAuth가 설정되지 않았습니다.", true); return; }
  window.location.href = "/api/oauth/blogger/start?dest=" + encodeURIComponent(id);
}
async function onAccountSave() {
  const dst = {
    id: $("accEditId").value || undefined,
    name: $("accName").value.trim(), platform: $("accPlatform").value, role: $("accRole").value,
    site_url: $("accSite").value.trim(), is_default: $("accDefault").checked,
    persona: $("accPersona").value.trim(), topics: $("accTopics").value.trim(),
    overrides: { tone: $("accTone").value.trim(), audience: $("accAudience").value.trim(), authorBio: $("accAuthorBio").value.trim(), thumbStyle: $("accThumbStyle").value.trim() }
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
const SCH_STATUS = { pending: "대기", running: "실행중", done: "완료", error: "오류" };
function toLocalInput(iso) { if (!iso) return ""; const d = new Date(iso); if (isNaN(d)) return ""; const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function fmtRunAt(iso) { if (!iso) return "일시 미지정"; const d = new Date(iso); if (isNaN(d)) return iso; const p = (n) => String(n).padStart(2, "0"); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; }
function updateSchForm() {
  const src = $("schSource").value;
  $("schDraftRow").style.display = src === "draft" ? "" : "none";
  $("schKwRow").classList.toggle("hidden", src !== "keyword");
  const dest = $("schScope").value === "destination";
  $("schPubRow").style.display = dest ? "" : "none";
}
async function loadSchDrafts(selId) {
  const sel = $("schDraft"); if (!sel) return;
  let data = { drafts: [] };
  try { data = await apiJson("/api/drafts?limit=100"); } catch {}
  sel.innerHTML = "";
  const drafts = data.drafts || [];
  if (!drafts.length) { const o = document.createElement("option"); o.value = ""; o.textContent = "(등록된 초안 없음 — 키워드 소스를 쓰세요)"; sel.appendChild(o); }
  for (const d of drafts) { const o = document.createElement("option"); o.value = d.id; o.textContent = (d.title || d.keyword || d.id).slice(0, 60); sel.appendChild(o); }
  if (selId) sel.value = selId;
}
function resetSchForm() {
  $("schEditId").value = ""; $("schName").value = ""; $("schKeywords").value = ""; $("schRunAt").value = "";
  $("schSource").value = "draft"; $("schScope").value = "destination"; $("schPublish").value = "none"; $("schEnabled").checked = true;
  updateSchForm(); $("schSave").textContent = "예약 저장";
}
async function renderSchedules() {
  await loadSchDrafts();
  const box = $("scheduleList"); let list = [];
  try { list = await apiJson("/api/schedules").then((j) => j.schedules || []); } catch {}
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="hist-empty">등록된 예약이 없습니다. 아래에서 추가하세요.</div>'; updateSchForm(); return; }
  for (const s of list) {
    const scopeLabel = s.scope === "draft" ? "초안까지" : (s.publish === "auto" ? "목적지+자동발행" : "목적지(작성완료)");
    const srcLabel = s.source === "draft" ? "초안" : `키워드:${(s.keywords || "").slice(0, 12)}`;
    const stCls = s.status === "done" ? "on" : (s.status === "error" ? "off" : "");
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `<span class="acc-badge ${s.enabled ? "dest" : "cush"}">${s.enabled ? "ON" : "OFF"}</span>`
      + `<span class="nm">${escapeHtml(s.name || "(이름없음)")}</span>`
      + `<span class="acc-plat">${fmtRunAt(s.run_at)} · ${srcLabel} · ${scopeLabel}</span>`
      + `<span class="cred-chip ${stCls}">${SCH_STATUS[s.status] || s.status || "대기"}</span>`
      + (s.result ? `<span class="df" style="color:var(--muted);font-weight:500;">${escapeHtml(s.result).slice(0, 40)}</span>` : "");
    const run = document.createElement("button"); run.className = "mini"; run.innerHTML = `<iconify-icon icon="solar:play-bold"></iconify-icon> 지금`;
    run.title = "지금 즉시 실행"; run.addEventListener("click", async () => { if (!confirm("지금 이 예약을 실행할까요?")) return; run.disabled = true; setStatus(`⏳ '${s.name}' 실행 중… (완료까지 수십 초)`); await apiJson("/api/schedules/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) }).catch(() => {}); setTimeout(renderSchedules, 3000); });
    const edit = document.createElement("button"); edit.className = "hist-del"; edit.textContent = "✎";
    edit.addEventListener("click", async () => { $("schEditId").value = s.id; $("schName").value = s.name || ""; $("schSource").value = s.source || "draft"; $("schKeywords").value = s.keywords || ""; $("schRunAt").value = toLocalInput(s.run_at); $("schScope").value = s.scope || "destination"; $("schPublish").value = s.publish || "none"; $("schEnabled").checked = !!s.enabled; await loadSchDrafts(s.draft_id); updateSchForm(); $("schSave").textContent = "수정 저장"; window.scrollTo({ top: 9999, behavior: "smooth" }); });
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { if (confirm("예약을 삭제할까요?")) { await apiJson("/api/schedules/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: s.id }) }).catch(() => {}); renderSchedules(); } });
    row.appendChild(run); row.appendChild(edit); row.appendChild(del); box.appendChild(row);
  }
  updateSchForm();
}
async function onScheduleSave() {
  const source = $("schSource").value;
  const runAtLocal = $("schRunAt").value;
  const s = {
    id: $("schEditId").value || undefined,
    name: $("schName").value.trim(),
    source,
    draft_id: source === "draft" ? $("schDraft").value : "",
    keywords: source === "keyword" ? $("schKeywords").value.trim() : "",
    run_at: runAtLocal ? new Date(runAtLocal).toISOString() : "",
    scope: $("schScope").value,
    publish: $("schPublish").value,
    enabled: $("schEnabled").checked
  };
  if (!s.name) { setStatus("예약 이름을 입력하세요.", true); return; }
  if (!s.run_at) { setStatus("실행 일시를 지정하세요.", true); return; }
  if (source === "draft" && !s.draft_id) { setStatus("사용할 초안을 선택하세요(없으면 키워드 소스 이용).", true); return; }
  if (source === "keyword" && !s.keywords) { setStatus("키워드를 입력하세요.", true); return; }
  try { await apiJson("/api/schedules", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }); resetSchForm(); renderSchedules(); setStatus("✅ 예약 저장됨. 지정 시간에 서버가 자동 실행합니다."); }
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
  $("genKeyword").value = d.keyword || deriveTopic();
  setGenMode("destination");   // refreshAccounts 후 니치 매칭 자동선택(genKeyword 반영됨)
  setStatus(`📥 초안 "${d.title || title}" 불러옴. 니치에 맞는 목적지가 자동 체크됩니다(수정 가능).`);
}

function setStatus(msg, isError = false) { const el = $("status"); el.textContent = msg; el.classList.remove("hidden"); el.classList.toggle("error", isError); if (progressOpen && !isError) progressStep(msg); }

/* ===== 진행상황 모달 ===== */
let progressOpen = false, genController = null, genAborted = false;
function openProgress(title) {
  progressOpen = true; genAborted = false;
  try { genController = new AbortController(); } catch { genController = null; }
  $("pmTitle").textContent = title;
  $("pmStep").textContent = "준비 중…";
  $("pmLog").innerHTML = "";
  $("pmFill").style.width = "2%";
  $("pmPct").textContent = "";
  $("pmSpinner").classList.remove("hidden");
  $("pmCancel").classList.remove("hidden");
  $("pmClose").classList.add("hidden");
  $("progressModal").classList.remove("hidden");
}
function cancelProgress() {
  if (!progressOpen) return;
  genAborted = true;
  try { genController?.abort(); } catch {}
  $("pmStep").textContent = "중단하는 중… (진행 중인 요청을 정리합니다)";
  $("pmCancel").classList.add("hidden");
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
  $("pmCancel").classList.add("hidden");
  $("pmClose").classList.remove("hidden");
  $("pmStep").textContent = msg;
  $("pmStep").classList.toggle("err", !ok);
  if (ok) progressBar(100);
  $("pmTitle").textContent = ok ? "완료" : "오류";
}
function closeProgress() { progressOpen = false; $("progressModal").classList.add("hidden"); $("pmStep").classList.remove("err"); }
function clearStatus() { $("status").classList.add("hidden"); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
const _cleanTopic = (s) => s.replace(/[*_`>#\[\]]/g, "").replace(/^\s*[-•]\s*/, "").trim().slice(0, 50);
const _BAD_TITLE = /^(요약|3줄|한\s*줄\s*요약|핵심\s*요약|tl;?dr|목차|개요|들어가며|서론|주제\s*[:：]|제목\s*[:：]|키워드\s*[:：]|본문|이\s*글)/i;
function deriveTopic() {
  const src = $("originalText").value || "";
  const lines = src.split(/\n/).map((s) => s.trim()).filter(Boolean);
  // 1) 첫 마크다운 H1 우선
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  if (h1) return _cleanTopic(h1.replace(/^#\s+/, "").replace(/\s*[:：].*$/, ""));
  // 2) 라벨/메타 줄은 건너뛰고 제목다운 첫 줄
  for (const l of lines) {
    const c = l.replace(/^#+\s*/, "").replace(/[*_`>]/g, "").trim();
    if (c.length < 3) continue;
    if (_BAD_TITLE.test(c)) continue;
    return _cleanTopic(c.replace(/\s*[:：].*$/, ""));
  }
  return _cleanTopic((lines[0] || "").replace(/^#+\s*/, ""));
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
  // API 키: 존재여부 표시 + 입력란 비움(비우면 유지). 저장돼 있으면 마스킹 placeholder 로 표시.
  $("hasAnthropic").textContent = settings.hasAnthropicKey ? "· 설정됨" : "· 미설정(.env 폴백)";
  $("hasKie").textContent = settings.hasKieKey ? "· 설정됨" : "· 미설정(.env 폴백)";
  $("hasNid").textContent = settings.hasNaverClientId ? "· 설정됨" : "";
  $("hasNsec").textContent = settings.hasNaverClientSecret ? "· 설정됨" : "";
  const MASK = "••••••••••••  저장됨 (변경할 때만 입력)";
  maskField("optAnthropicKey", settings.hasAnthropicKey, "sk-ant-...");
  maskField("optKieKey", settings.hasKieKey, "");
  maskField("optNaverId", settings.hasNaverClientId, "");
  maskField("optNaverSecret", settings.hasNaverClientSecret, "");
  maskField("optPexelsKey", settings.hasPexelsKey, "pexels.com/api 무료 발급");
  $("hasPexels").textContent = settings.hasPexelsKey ? "· 설정됨" : "· 미설정";
  $("optStockPhotos").checked = settings.stockPhotos !== false;
  function maskField(id, saved, empty) { const el = $(id); el.value = ""; el.placeholder = saved ? MASK : (empty || ""); el.classList.toggle("saved", !!saved); }
  $("optEngine").value = settings.genEngine || "claude";
  $("optChatModel").value = settings.kieChatModel || "claude-sonnet-5";
  $("optThumbMode").value = settings.thumbnailMode || "ai_full";
  $("optImgRes").value = settings.imageResolution || "1K";
  $("optLinkMode").value = settings.linkMode || "preserve";
  $("optAccent").value = settings.overlayAccent || "#ff2d55";
  $("optMyBlog").value = settings.myBlogUrl || "";
  $("optTone").value = settings.defaultTone || "";
  $("optAudience").value = settings.defaultAudience || "";
  $("optAuthorBio").value = settings.authorBio || "";
  $("optThumbStyle").value = settings.thumbnailStylePrompt || "";
  $("optAdEnabled").checked = !!settings.adEnabled;
  $("optAutoPublish").checked = !!settings.autoPublish;
  $("optAutoProcessDrafts").checked = !!settings.autoProcessDrafts;
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
    ...($("optPexelsKey").value.trim() ? { pexelsKey: $("optPexelsKey").value.trim() } : {}),
    linkMode: $("optLinkMode").value, overlayAccent: $("optAccent").value, myBlogUrl: $("optMyBlog").value.trim(),
    defaultTone: $("optTone").value.trim(), defaultAudience: $("optAudience").value.trim(), authorBio: $("optAuthorBio").value.trim(),
    thumbnailStylePrompt: $("optThumbStyle").value.trim(), adEnabled: $("optAdEnabled").checked, adCode: $("optAdCode").value.trim(),
    autoPublish: $("optAutoPublish").checked, stockPhotos: $("optStockPhotos").checked, autoProcessDrafts: $("optAutoProcessDrafts").checked
  };
  try { await saveSettings(patch); settings = await getSettings(); try { config = await apiJson("/api/config"); } catch {} $("apiWarn").classList.toggle("hidden", !!config.kieEnabled || !!config.claudeEnabled); populateSettings(); setStatus("✅ 설정 저장됨"); }
  catch (e) { setStatus("설정 저장 실패: " + e.message, true); }
}

// ---------- 트렌드 ----------
let _trendsLoaded = false, selectedTrend = null;
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
      setGenMode("draft");
      $("draftKeyword").value = it.title;
      selectedTrend = { title: it.title, traffic: it.traffic || "", newsTitle: it.newsTitle || "", newsSource: it.newsSource || "", source: it.source || "" };
      $("draftKeyword").focus();
      $("draftGenRow").scrollIntoView({ behavior: "smooth", block: "center" });
      setStatus(`✨ "${it.title}" 트렌드를 초안 키워드에 넣었어요(뉴스 맥락 반영). 'AI 초안 생성'을 누르세요.`);
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
  const kw = (keyword || "").toLowerCase().trim(); if (!kw) return [];
  const tokens = kw.split(/\s+/).filter((t) => t.length >= 2);
  // 다중 토큰이면 2개 이상 겹쳐야 관련(무관한 단일 단어 매칭 배제)
  const need = tokens.length >= 2 ? 2 : 1;
  return posts.map((p) => {
    const hay = ((p.title || "") + " " + (p.keyword || "")).toLowerCase();
    let s = 0; for (const t of tokens) if (hay.includes(t)) s++; if (hay.includes(kw)) s += 3;
    return { p, s };
  }).filter((x) => x.s >= need).sort((a, b) => b.s - a.s).map((x) => ({ title: x.p.title, link: x.p.url }));
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
// 예약 발행: 검토 후 지정 시각에 자동 발행되게 예약
async function onSchedulePublishSet() {
  if (!cur) return;
  const local = $("schedPubAt").value;
  if (!local) { setStatus("발행할 날짜·시간을 선택하세요.", true); return; }
  const iso = new Date(local).toISOString();
  if (new Date(iso).getTime() < Date.now() - 60000) { setStatus("현재 이후 시각을 선택하세요.", true); return; }
  await saveCur();  // 최신 내용(편집분) 저장 후 예약
  await apiJson("/api/work/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, publish_at: iso }) }).catch(() => {});
  cur.publish_at = iso; renderCur();
  setStatus(`⏰ ${fmtRunAt(iso)}에 자동 발행 예약됨. 그때 서버가 알아서 발행합니다.`);
}
async function onSchedulePublishClear() {
  if (!cur) return;
  await apiJson("/api/work/schedule", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, publish_at: "" }) }).catch(() => {});
  cur.publish_at = ""; renderCur();
  setStatus("예약 발행을 해제했습니다.");
}
// 수동 발행 완료 표시 (네이버·블로거 등 HTML 붙여넣기식) → 작업목록에서 제거·보관
async function onMarkPublished() {
  if (!cur) return;
  const url = prompt("발행된 글 주소(URL)를 입력하세요. 없으면 비워도 됩니다:", cur.published_url || "");
  if (url === null) return;
  const u = (url || "").trim();
  await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", status: "published", published_url: u, publish_mode: "manual" }) }).catch(() => {});
  if (u && /^https?:\/\//.test(u)) { try { await saveMyPost({ title: cur.article.title || deriveTopic(), url: u, keyword: cur.keyword }, (cur.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {} }
  setStatus(`✅ '${cur.acc.name || cur.target}' 발행 완료로 표시했습니다.` + (u ? " 발행 자산에도 보관됩니다." : ""));
  cur = null; $("workDetail").style.display = "none"; renderWorkList();
}

// ---------- 링크 소스 ----------
async function gatherRelatedLinks(keyword) {
  const all = await getAllMyPosts();
  // 관련성 있는 글만 사용(무관한 최근글 끌어오기 금지). 관련 없으면 내부링크 안 넣음.
  const myPosts = matchMyPosts(all, keyword);
  const seenM = new Set(), mp = [];
  for (const it of myPosts) if (it?.link && !seenM.has(it.link)) { seenM.add(it.link); mp.push(it); }
  lastMyPosts = mp.slice(0, 6);
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
// 계정(블로그)별 고유 디자인 아이덴티티 — 색·톤이 블로그마다 다르게
const ACC_PALETTE = [
  { accent: "#e11d48", vibe: "선명하고 강렬한 매거진 톤(굵은 소제목, 임팩트 있는 도입부)" },
  { accent: "#2563eb", vibe: "신뢰감 있는 정보지 톤(정돈된 표·요약박스 적극 사용)" },
  { accent: "#059669", vibe: "산뜻하고 실용적인 가이드 톤(체크리스트·단계 강조)" },
  { accent: "#d97706", vibe: "따뜻하고 친근한 블로그 톤(대화하듯, 짧은 문단)" },
  { accent: "#0891b2", vibe: "차분하고 전문적인 톤(FAQ·핵심요약 강조)" },
  { accent: "#4f46e5", vibe: "깔끔하고 트렌디한 톤(간결한 소제목, 리스트 중심)" }
];
function accountStyle(acc) {
  const s = String((acc && (acc.id || acc.name)) || "");
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return ACC_PALETTE[h % ACC_PALETTE.length];
}
function promptForAccount(acc, keyword, variant, destUrl, reference) {
  const sourceText = $("originalText").value.trim();
  const v = { ...(variant || {}), style: accountStyle(acc).vibe, persona: acc.persona || "" };   // 블로그별 톤·페르소나 주입
  const ov = acc.overrides || {};   // 블로그별 오버라이드(비우면 전역 기본)
  const common = { keyword, audience: ov.audience || settings.defaultAudience, tone: ov.tone || settings.defaultTone, authorBio: ov.authorBio || settings.authorBio, today: todayStr(), imageCount: parseInt($("imgCount").value, 10) || 1, variant: v, reference };
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
  const baseThumb = settings.thumbnailStylePrompt || DEFAULT_THUMB_STYLE;
  const accThumb = acc.overrides && acc.overrides.thumbStyle;
  const thumbStyle = baseThumb + (accThumb ? `\n[이 블로그 전용 스타일] ${accThumb}` : "");
  if (isThumb && settings.thumbnailMode === "ai_full") {
    genPrompt = `${thumbStyle}\n\nScene: ${b.prompt || keyword}\n\nRender this EXACT Korean headline, HUGE and bold in the TOP area, perfectly spelled, with a solid highlight box behind the single most important word: "${headline}"\n\nHARD RULES: strong subject-vs-background pop (glow/rim light, shallow DOF), high-contrast punchy but CLEAN composition. If a real person is central show ONLY ONE person with clear emotion; otherwise a bold symbolic scene with NO random people. Bottom third clear. NO cartoon mascot, NO clip-art graphs/arrows/flags/finance icons, NO messy collage.`;
  }
  const aspect = isThumb ? aspectFor(acc) : "4:3";
  b._genPrompt = genPrompt; b._headline = headline; b._isThumb = isThumb; b._aspect = aspect;
  let url = await generateImage({ prompt: genPrompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
  if (isThumb && settings.thumbnailMode === "overlay") { try { url = await composeThumbnail({ imageUrl: url, text: headline, accent: accountStyle(acc).accent, aspect }); } catch (e) { console.warn(e); } }
  b.resolvedUrl = url;
}
const ENTICERS = ["지금 바로 확인 →", "놓치면 후회해요 →", "여기서 정리 끝 →", "이것도 꼭 보세요 →", "한눈에 보기 →"];
const REL_SUBS = ["안 보면 손해!", "가장 많이 본 글", "함께 보면 좋아요", "이런 것도 찾으셨죠?"];
function insertTopCard(article, card) {
  const blocks = article.blocks || [];
  let idx = blocks.findIndex((b) => b.type === "image" && b.slot === "thumbnail"); idx = idx >= 0 ? idx + 1 : 0;
  blocks.splice(idx, 0, card); article.blocks = blocks;
}
function insertCardAt(article, card, ratio) {
  const blocks = article.blocks || [];
  // 본문 중반(ratio 지점)의 heading 근처에 삽입
  let idx = Math.max(2, Math.round(blocks.length * ratio));
  while (idx < blocks.length && blocks[idx].type === "image") idx++;
  blocks.splice(Math.min(idx, blocks.length), 0, card); article.blocks = blocks;
}
function relItems(posts, start = 0, n = 3) {
  return (posts || []).slice(start, start + n).map((p, i) => ({ icon: "🔗", title: p.title, subtitle: REL_SUBS[i % REL_SUBS.length], label: ENTICERS[i % ENTICERS.length], url: p.link }));
}
function ensureTopLinkcard(role, article, keyword, relatedPosts, destUrl) {
  const blocks = article.blocks || [];
  if (blocks.slice(0, 4).some((b) => b.type === "linkcard")) return;
  const kw = (keyword || article.title || "").trim();
  const posts = relatedPosts || [];
  const items = [];
  if (role === "cushion" && destUrl) items.push({ icon: "▶️", title: `${kw} 전체 내용 자세히 보기`, subtitle: "핵심만 빠르게 확인", label: "자세히 보기 →", url: destUrl, featured: true });
  // 상단 카드: 내부 연관글 최대 2개
  relItems(posts, 0, 2).forEach((it, i) => { if (role === "destination" && i === 0 && !items.length) it.featured = true; items.push(it); });
  if (items.length) insertTopCard(article, { type: "linkcard", heading: role === "destination" ? "👉 이 글과 함께 꼭 보세요" : "👉 먼저 확인하세요", items });
  // 목적지: 연관글이 더 있으면 본문 중반에 두 번째 카드(내부링크 강화 → 체류·SEO)
  if (role === "destination" && posts.length > 2) {
    insertCardAt(article, { type: "linkcard", heading: "👉 이런 정보도 찾고 계셨죠?", items: relItems(posts, 2, 3) }, 0.6);
  }
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
  const accent = accountStyle(acc).accent;   // 블로그별 고유 포인트 색
  try {
    return buildHtml(article, {
      adEnabled: settings.adEnabled, adCode: settings.adCode, accent,
      linkMode: settings.linkMode || "preserve", searchContext: keyword || article?.title || "",
      relatedUrls: myPosts.map((x) => x.link), relatedPosts: myPosts, sources: isNaver ? [] : lastSources,
      selfUrl: isDestRole(acc) ? "" : destUrl
    }).html;
  } catch (e) {
    console.error("preview build error:", e);
    try { return buildHtml(article, { accent, linkMode: settings.linkMode || "preserve" }).html; }
    catch { return `<h1>${(article?.title || "").replace(/</g, "&lt;")}</h1><p>미리보기 조립 오류. HTML 복사는 가능합니다.</p>`; }
  }
}
async function finalizeForAccount(acc, article, keyword, destUrl) {
  article.today = todayStr(); article.authorBio = (acc.overrides && acc.overrides.authorBio) || settings.authorBio; article.keyword = keyword;
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
  // Pexels 실사 사진으로 보강(AI 개수 + 1 비율). 글만 있어 허전하지 않게.
  if (settings.stockPhotos !== false && config.pexelsEnabled) {
    const aiN = $("genImages").checked ? (parseInt($("imgCount").value, 10) || 1) : 0;
    try { await addStockPhotos(acc, article, keyword, Math.min(5, aiN + 1)); } catch (e) { console.warn(e); }
  }
  return buildHtmlForAccount(acc, article, keyword, destUrl);
}
// Pexels 사진을 본문 소제목 사이에 배치
async function addStockPhotos(acc, article, keyword, n) {
  if (n <= 0) return;
  let queries = Array.isArray(article.photoQueries) ? article.photoQueries.filter(Boolean) : [];
  if (!queries.length) queries = [keyword];
  const seen = new Set(), photos = [];
  for (const q of queries) {
    if (photos.length >= n) break;
    try {
      const r = await apiJson(`/api/stock-photos?q=${encodeURIComponent(q)}&n=3`);
      for (const p of (r.photos || [])) { if (photos.length >= n) break; if (p.url && !seen.has(p.url)) { seen.add(p.url); photos.push(p); } }
    } catch {}
  }
  if (!photos.length) return;
  const blocks = article.blocks || [];
  const headingIdx = blocks.map((b, i) => (b.type === "heading" && (b.level || 2) === 2 ? i : -1)).filter((i) => i >= 0);
  // 삽입 위치(뒤에서부터 삽입해 인덱스 밀림 방지)
  const spots = [];
  photos.forEach((p, k) => { const hi = headingIdx[k + 1] !== undefined ? headingIdx[k + 1] : (headingIdx.length ? headingIdx[headingIdx.length - 1] + 1 : blocks.length); spots.push({ at: hi, p }); });
  spots.sort((a, b) => b.at - a.at);
  for (const s of spots) {
    blocks.splice(Math.min(s.at, blocks.length), 0, { type: "image", slot: "body", resolvedUrl: s.p.url, alt: s.p.alt || keyword, credit: s.p.photographer ? `사진: ${s.p.photographer} / Pexels` : "Pexels", creditUrl: s.p.page || "https://www.pexels.com" });
  }
  article.blocks = blocks;
}
// 목적지/쿠션 글 생성 = 서드파티(KIE, 웹서치X). 초안(웹서치로 만든 원천자료)에서 정보 추출.
function engineForMode() { return config.kieEnabled ? "kie" : "claude"; }

// 클로드용 초안 프롬프트를 클립보드에 복사(서버 buildDraftPrompt와 항상 동일)
async function copyDraftPromptText() {
  const built = buildDraftPrompt({ keyword: "①여기에_키워드", reference: "", today: todayStr(), audience: settings.defaultAudience, tone: settings.defaultTone });
  const text = `${built.system}\n\n${built.user}\n\n[MCP 전송] 완성된 초안을 submit_draft 도구로 보내줘. 첫 줄을 title, 나머지를 content 로.`;
  try { await navigator.clipboard.writeText(text); setStatus("✅ 클로드용 초안 프롬프트를 복사했어요. claude.ai에 붙여넣고 '①여기에_키워드'만 바꾸세요."); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); setStatus("✅ 프롬프트 복사됨."); } catch { setStatus("복사 실패 — 브라우저 권한을 확인하세요.", true); } ta.remove(); }
}
// 초안(원천 자료) AI 생성 — Claude 공식 API + 웹서치. 결과를 원본 입력에 채운다.
async function generateDraft() {
  if (!config.claudeEnabled) { setStatus("초안 AI 생성은 Claude 공식 API 키가 필요합니다. 설정에서 Anthropic 키를 입력하세요.", true); showView("settings"); return; }
  const kw = ($("draftKeyword").value || "").trim() || deriveTopic();
  if (!kw) { setStatus("키워드나 주제를 입력하세요 (또는 트렌드를 클릭).", true); $("draftKeyword").focus(); return; }
  const exist = $("originalText").value.trim();
  if (exist && !confirm("원본 입력에 내용이 있습니다. AI 초안으로 교체할까요?")) return;
  $("genDraft").disabled = true; $("genAll").disabled = true;
  openProgress("AI 초안 생성 (웹서치)");
  progressLog(`엔진: Claude 공식 API · 웹서치 ON · 주제: ${kw}`, "done");
  try {
    // 트렌드에서 온 키워드면 뉴스 맥락을 근거로 넘겨 트렌드에 맞는 초안·연관키워드가 나오게
    let trendRef = "";
    if (selectedTrend && selectedTrend.title === kw) {
      trendRef = `[지금 뜨는 트렌드 맥락 — 이 흐름을 반영해 최신 이슈 각도로 써라]\n- 트렌드 키워드: ${selectedTrend.title}${selectedTrend.traffic ? ` (검색량 ${selectedTrend.traffic})` : ""}\n${selectedTrend.newsTitle ? `- 관련 뉴스: ${selectedTrend.newsTitle}${selectedTrend.newsSource ? " / " + selectedTrend.newsSource : ""}\n` : ""}- 지금 이 주제를 검색하는 사람들이 실제로 궁금해할 각도(배경·인물·쟁점·전망)와 연관 검색어를 잘 잡아라.`;
    }
    // 백그라운드 작업으로 시작(웹서치는 오래 걸려 동기 요청은 터널 타임아웃 발생) → 폴링
    progressStep("초안 작업 시작…", 8);
    const { jobId } = await apiJson("/api/draft/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword: kw, reference: trendRef }) });
    let text = "", t0 = Date.now(), pct = 12, dfails = 0;
    for (;;) {
      if (genAborted) throw new Error("__abort__");
      await sleep(3000);
      let st;
      try { st = await apiJson("/api/draft/status?id=" + encodeURIComponent(jobId)); dfails = 0; }
      catch (e) { if (/작업/.test(e.message)) throw new Error("작업이 유실됐어요(서버 재시작 등). 다시 생성해 주세요."); if (++dfails > 8) throw new Error("서버 응답이 없어 중단했어요. 다시 시도해 주세요."); continue; }
      const secs = Math.round((Date.now() - t0) / 1000);
      pct = Math.min(90, pct + 3); progressStep(`웹 검색하며 초안 작성 중… (${secs}초 경과, 최대 2~3분)`, pct);
      if (st.status === "done") { text = st.text || ""; break; }
      if (st.status === "error") throw new Error(st.error || "초안 생성 실패");
    }
    if (!text.trim()) throw new Error("빈 응답");
    progressBar(94);
    $("originalText").value = text.trim();
    // 초안도 초안함에 보관
    try { const j = await apiJson("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: (text.split(/\n/)[0] || kw).slice(0, 80), content: text.trim(), keyword: kw, source: "ai-draft" }) }); activeDraftId = j.draft?.id || activeDraftId; updateInboxBadge(); } catch {}
    progressDone(true, "초안 생성 완료 — 검토 후 ② 목적지 탭으로 이동하세요.");
    setStatus(`✅ "${kw}" 초안 생성 완료(초안함에도 저장). 검토 후 ② 목적지 만들기 탭으로 이동하세요.`);
  } catch (e) {
    if (genAborted || e.name === "AbortError" || e.message === "__abort__") { progressDone(false, "중단되었습니다."); setStatus("초안 생성을 중단했습니다."); }
    else { progressDone(false, "초안 생성 실패: " + e.message); setStatus("초안 생성 실패: " + e.message, true); }
  } finally { $("genDraft").disabled = false; $("genAll").disabled = false; }
}
async function chatArticle(built) {
  const engine = engineForMode();
  let content = await chatComplete({ engine, model: settings.kieChatModel, system: built.system, user: built.user, maxTokens: 16000 });
  let article = tryParse(content);
  if (!article) { content = await chatComplete({ engine, model: settings.kieChatModel, system: built.system, user: built.user + "\n\n(JSON이 끊기지 않게 위 형식의 JSON 객체 하나로만 완결해줘.)", maxTokens: 16000 }); article = tryParse(content); }
  if (!article) throw new Error("JSON 파싱 실패: " + (content || "").slice(0, 120));
  return article;
}
// 생성된 work를 자동발행(WP=앱비번, 블로거=OAuth) → published 표시 + 자산 보관
async function autoPublishWork(acc, wid, article, html, keyword) {
  const isWp = acc.platform === "wordpress";
  const res = isWp
    ? await wpCreatePost({ title: article.title, content: html, status: "publish", destinationId: acc.id, category: article.category })
    : await apiJson("/api/blogger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: acc.id, title: article.title, content: html }) });
  if (res && res.link) {
    await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: wid, target: acc.platform, destination_id: acc.id, title: article.title || "", status: "published", published_url: res.link, published_id: res.id != null ? String(res.id) : null, publish_mode: "auto" }) }).catch(() => {});
    try { await saveMyPost({ title: article.title, url: res.link, keyword }, (html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {}
  }
  return res;
}
// 라이브(블로그) HTML → 편집기 블록으로 변환
function inlineToMd(el) {
  let out = "";
  el.childNodes.forEach((n) => {
    if (n.nodeType === 3) out += n.textContent;
    else if (n.nodeType === 1) {
      const t = n.tagName.toLowerCase();
      if (t === "a") out += `[${n.textContent}](${n.getAttribute("href") || "#"})`;
      else if (t === "strong" || t === "b") out += `**${n.textContent.trim()}**`;
      else if (t === "em" || t === "i") out += `*${n.textContent.trim()}*`;
      else if (t === "br") out += "\n";
      else out += inlineToMd(n);
    }
  });
  return out.replace(/\s+/g, " ").trim();
}
function htmlToBlocks(html) {
  const doc = new DOMParser().parseFromString(html || "", "text/html");
  const blocks = [];
  const walk = (nodes) => {
    nodes.forEach((el) => {
      if (el.nodeType === 3) { const t = el.textContent.trim(); if (t) blocks.push({ type: "paragraph", text: t }); return; }
      if (el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4") { const tx = el.textContent.trim(); if (tx) blocks.push({ type: "heading", level: tag === "h2" ? 2 : 3, text: tx }); }
      else if (tag === "img") blocks.push({ type: "image", slot: "body", resolvedUrl: el.getAttribute("src") || "", alt: el.getAttribute("alt") || "" });
      else if (tag === "p" || tag === "figure") {
        const img = el.querySelector("img");
        if (img && !el.textContent.trim()) blocks.push({ type: "image", slot: "body", resolvedUrl: img.getAttribute("src") || "", alt: img.getAttribute("alt") || "" });
        else { const md = inlineToMd(el); if (md) blocks.push({ type: "paragraph", text: md }); if (img) blocks.push({ type: "image", slot: "body", resolvedUrl: img.getAttribute("src") || "", alt: img.getAttribute("alt") || "" }); }
      }
      else if (tag === "ul" || tag === "ol") { const items = [...el.querySelectorAll(":scope > li")].map((li) => inlineToMd(li)).filter(Boolean); if (items.length) blocks.push({ type: "list", ordered: tag === "ol", items }); }
      else if (tag === "blockquote") { const tx = el.textContent.trim(); if (tx) blocks.push({ type: "callout", style: "info", text: tx }); }
      else if (tag === "table") { const trs = [...el.querySelectorAll("tr")]; const rows = trs.map((tr) => [...tr.querySelectorAll("th,td")].map((c) => c.textContent.trim())); const headers = rows.shift() || []; if (headers.length) blocks.push({ type: "table", headers, rows }); }
      else if (tag === "div" || tag === "section" || tag === "article" || tag === "main") walk([...el.childNodes]);
      else if (tag === "hr" || tag === "script" || tag === "style") { /* skip */ }
      else { const tx = el.textContent.trim(); if (tx) blocks.push({ type: "paragraph", text: tx }); }
    });
  };
  walk([...doc.body.childNodes]);
  return blocks.filter((b) => b.type !== "paragraph" || (b.text && b.text.trim()));
}
// 블로그의 '현재' 내용을 불러와 편집기에 반영(직접 수정분 덮어쓰기 방지)
async function pullLive() {
  if (!cur || (!cur.published_id && !cur.published_url)) return;
  if (!confirm("블로그에 게시된 '현재' 내용을 불러옵니다.\n지금 편집기의 내용은 블로그 최신본으로 대체됩니다. 계속할까요?")) return;
  try {
    setStatus("블로그 현재본 불러오는 중…");
    const res = await apiJson("/api/remote-post", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: cur.acc.id, postId: cur.published_id || undefined, postUrl: cur.published_url || undefined }) });
    if (res.title) cur.article.title = res.title;
    const blocks = htmlToBlocks(res.html);
    if (!blocks.length) { setStatus("불러온 내용이 비어 있습니다.", true); return; }
    cur.article.blocks = blocks;
    if (res.id != null) cur.published_id = String(res.id);
    rebuildCur();
    await saveCur();
    if (!editMode) toggleEdit(); else renderEditor();
    renderCur();
    setStatus("✅ 블로그 현재본을 편집기에 반영했습니다. 수정 후 '수정 발행'을 누르세요.");
  } catch (e) { setStatus("불러오기 실패: " + e.message, true); }
}
// 이미 발행된 글을 편집 후 원격에 '수정 발행'(업데이트)
async function updatePublish() {
  if (!cur || (!cur.published_id && !cur.published_url)) return;
  if (editMode) toggleEdit(); else rebuildCur();
  try {
    setStatus("수정 발행(업데이트) 중…");
    const body = { destinationId: cur.acc.id, postId: cur.published_id || undefined, postUrl: cur.published_url || undefined, title: cur.article.title, content: cur.html };
    const res = cur.target === "wordpress"
      ? await wpCreatePost({ ...body, category: cur.article.category })
      : await apiJson("/api/blogger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    cur.published_id = res.id != null ? String(res.id) : cur.published_id;
    await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", article: cur.article, html: cur.html, status: "published", published_url: res.link || cur.published_url, published_id: cur.published_id || null }) }).catch(() => {});
    setStatus(`✅ 수정 발행 완료: ${res.link || cur.published_url}`);
  } catch (e) { setStatus("수정 발행 실패: " + e.message, true); }
}
async function generateAll() {
  if (!config.kieEnabled && !config.claudeEnabled) { setStatus("생성 엔진(Claude/KIE) 키가 없습니다. 설정에서 입력하세요.", true); return; }
  if (!$("originalText").value.trim()) { setStatus("원본 글을 붙여넣거나 초안함에서 선택하세요.", true); return; }
  await refreshAccounts();
  if (!accountsForMode().length) {
    setStatus(genMode === "destination" ? "먼저 '계정 관리'에서 목적지 계정을 등록하세요." : "먼저 '계정 관리'에서 쿠션 계정(블로거/네이버)을 등록하세요.", true);
    showView("accounts"); return;
  }
  const accts = selectedAccountsForMode();
  if (!accts.length) { setStatus("생성할 계정을 하나 이상 체크하세요.", true); return; }
  let destUrl = "", reference = "";
  if (genMode === "cushion") {
    destUrl = ($("cushDest").value || $("bloggerUrl").value.trim() || destUrlForGen());
    if (!destUrl) { setStatus("유입시킬 목적지 글을 선택하거나 URL을 입력하세요.", true); return; }
    const asset = (cushAssets || []).find((a) => a.url === destUrl);
    if (asset) reference = `[유입 목적지 글: ${asset.title || ""}]\n${asset.excerpt || asset.summary || ""}`.trim();
  }
  const keyword = ($("genKeyword").value || "").trim() || deriveTopic();
  // 붙여넣기/직접작성 원본도 초안함에 축적(로드된 초안이 아니면)
  if (!activeDraftId && $("originalText").value.trim()) {
    try { const j = await apiJson("/api/drafts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: (deriveTopic() || keyword || "붙여넣은 초안").slice(0, 80), content: $("originalText").value.trim(), keyword, source: "pasted" }) }); activeDraftId = j.draft?.id || null; updateInboxBadge(); } catch {}
  }
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
      if (genAborted) break;
      const k = gk(acc); idxIn[k] = (idxIn[k] || 0) + 1;
      const variant = { index: idxIn[k], total: groups[k].length };
      const base = 8 + Math.round((done / total) * 88);
      progressStep(`[${acc.name}] ${eng === "claude" ? "웹서치·작성" : "재가공"} 중… (${done + 1}/${total})`, base);
      let article;
      try { article = await chatArticle(promptForAccount(acc, keyword, variant, destUrl, reference)); }
      catch (e) { if (genAborted || e.name === "AbortError" || e.message === "__abort__") break; progressLog(`✗ ${acc.name} 실패: ${e.message}`, "error"); done++; continue; }
      const html = await finalizeForAccount(acc, article, keyword, destUrl);
      const wid = await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_id: activeDraftId, target: acc.platform, destination_id: acc.id, title: article.title || "", article, html, status: "generated", role: genMode }) }).then((j) => j.id).catch(() => null);
      await storeAdd({ type: "article", title: article.title || "", keyword, platform: acc.platform });
      okCount++; done++;
      // 자동발행: 자격증명/연결된 WP·블로거 (설정 ON 시)
      const canAuto = settings.autoPublish && acc.has_creds && (acc.platform === "wordpress" || acc.platform === "blogger") && wid;
      if (canAuto) {
        progressStep(`[${acc.name}] ${PLAT_LABEL[acc.platform]} 자동발행 중…`, 8 + Math.round((done / total) * 88));
        try {
          const res = await autoPublishWork(acc, wid, article, html, keyword);
          if (res && res.link) progressLog(`${acc.name} — 자동발행 완료: ${res.link}`, "done");
          else progressLog(`${acc.name} — 생성됨(발행 링크 없음, 작업보드 확인)`, "done");
        } catch (e) { progressLog(`${acc.name} — 생성됨(자동발행 실패: ${e.message})`, "error"); }
      } else {
        progressLog(`${acc.name} — ${(article.title || "").slice(0, 40) || "생성됨"}`, "done");
      }
      progressBar(8 + Math.round((done / total) * 88));
    }
    if (okCount && activeDraftId) { await draftStatus(activeDraftId, "used"); renderDrafts(); }   // 성공했을 때만 '사용됨' 처리
    if (genAborted) {
      progressDone(false, `중단됨 — ${okCount}/${total}개까지 생성 완료(작업보드에 저장됨)`);
      setStatus(`생성을 중단했습니다. ${okCount}개는 저장되었습니다.`);
    } else if (okCount) {
      const autoMsg = settings.autoPublish ? " (WP·블로거 자동발행 시도됨)" : "";
      progressDone(true, `${okCount}/${total}개 ${modeLabel} 글 생성 완료${autoMsg}`);
      setStatus(`✅ ${okCount}개 ${modeLabel} 글 생성 완료${autoMsg}. 작업보드/발행 기록에서 확인하세요.`);
    } else {
      progressDone(false, "모든 계정 생성 실패. 키/네트워크를 확인하세요.");
    }
  } catch (e) { if (genAborted || e.name === "AbortError" || e.message === "__abort__") { progressDone(false, "중단되었습니다."); setStatus("생성을 중단했습니다."); } else { progressDone(false, "오류: " + e.message); setStatus("오류: " + e.message, true); } }
  finally {
    $("genAll").disabled = false;
    if (okCount) { showView("board"); await renderWorkList(); if (workItems[0]) openWork(workItems[0].id); }
  }
}

// ---------- 작업 목록 ----------
async function renderWorkList() {
  try { workItems = await apiJson("/api/work").then((j) => j.items || []); } catch { workItems = []; }
  const box = $("workList");
  if (!workItems.length) { box.innerHTML = '<div class="hist-empty">진행 중 작업이 없습니다. 위에서 생성하세요.</div>'; return; }
  const amap = accById(); box.innerHTML = "";
  for (const w of workItems) {
    const acc = amap[w.destination_id] || { platform: w.target };
    const dest = isDestRole(acc);
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `<span class="acc-badge ${dest ? "dest" : "cush"}">${dest ? "목적지" : "쿠션"}</span>`
      + `<span class="acc-plat">${PLAT_LABEL[w.target] || w.target}${acc.name ? " · " + acc.name : ""}</span>`
      + `<span class="nm">${w.title || "(제목없음)"}</span>`
      + (w.publish_at ? `<span class="pubm" style="background:var(--accent-soft);color:var(--accent-dark);"><iconify-icon icon="solar:clock-circle-linear"></iconify-icon> ${fmtRunAt(w.publish_at)} 예약</span>` : `<span class="df">${w.status === "generated" ? "생성됨" : w.status}</span>`);
    const open = document.createElement("button"); open.className = "mini"; open.textContent = "열기"; open.addEventListener("click", () => openWork(w.id));
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { await apiJson("/api/work/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id }) }).catch(() => {}); if (cur && cur.id === w.id) { cur = null; $("workDetail").style.display = "none"; } renderWorkList(); });
    row.appendChild(open); row.appendChild(del); box.appendChild(row);
  }
}
// ---------- 발행 기록(보관함) ----------
let _history = [];
async function renderHistory() {
  const box = $("historyList");
  try { _history = await apiJson("/api/work?status=published").then((j) => j.items || []); } catch { _history = []; }
  const q = ($("historySearch").value || "").trim().toLowerCase();
  const amap = accById();
  // 블로그 필터 옵션 채우기(발행된 계정만)
  const fsel = $("historyFilter"); const cur0 = fsel.value;
  const usedDest = [...new Set(_history.map((w) => w.destination_id).filter(Boolean))];
  fsel.innerHTML = '<option value="">전체 블로그</option>' + usedDest.map((id) => `<option value="${id}">${escapeHtml(amap[id]?.name || id)}</option>`).join("");
  fsel.value = cur0;
  const fDest = fsel.value, fMode = $("historyMode").value;
  let items = _history;
  if (q) items = items.filter((w) => ((w.title || "") + (amap[w.destination_id]?.name || "") + (PLAT_LABEL[w.target] || "")).toLowerCase().includes(q));
  if (fDest) items = items.filter((w) => w.destination_id === fDest);
  if (fMode) items = items.filter((w) => (w.publish_mode || "") === fMode);
  $("historyCount").textContent = `— 총 ${_history.length}건 · 표시 ${items.length}건`;
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = '<div class="hist-empty">해당 조건의 발행 글이 없습니다.</div>'; return; }
  for (const w of items) {
    const acc = amap[w.destination_id] || { platform: w.target };
    const d = new Date(w.updated_at || Date.now());
    const dstr = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    const mode = w.publish_mode === "scheduled" ? `<span class="pubm auto">예약발행</span>` : w.publish_mode === "auto" ? `<span class="pubm auto">자동발행</span>` : (w.publish_mode === "manual" ? `<span class="pubm manual">수동발행</span>` : `<span class="pubm">발행됨</span>`);
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `${mode}`
      + `<span class="acc-plat">${PLAT_LABEL[w.target] || w.target}${acc.name ? " · " + acc.name : ""}</span>`
      + `<span class="nm">${escapeHtml(w.title || "(제목없음)")}</span>`
      + `<span class="df" style="color:var(--muted)">${dstr}</span>`;
    if (w.published_url) {
      const a = document.createElement("a"); a.className = "mini"; a.href = w.published_url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = `<iconify-icon icon="solar:square-top-down-linear"></iconify-icon> 열기`;
      row.appendChild(a);
    }
    // URL 수정(수동발행인데 URL 못 넣은 경우 등)
    const editUrl = document.createElement("button"); editUrl.className = "mini"; editUrl.innerHTML = `<iconify-icon icon="solar:pen-linear"></iconify-icon> URL`;
    editUrl.title = "발행 주소 수정"; editUrl.addEventListener("click", async () => {
      const u = prompt("발행된 글 주소(URL)를 입력/수정하세요:", w.published_url || "");
      if (u === null) return; const url = u.trim();
      await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id, target: w.target, destination_id: w.destination_id, title: w.title || "", status: "published", published_url: url }) }).catch(() => {});
      if (url && /^https?:\/\//.test(url)) { try { await saveMyPost({ title: w.title, url, keyword: "" }, ""); } catch {} }
      setStatus("✅ 발행 주소를 수정했습니다."); renderHistory();
    });
    row.appendChild(editUrl);
    // 우리 편집모드로 열어 수정 → '수정 발행'(업데이트). URL만 있어도 원격 ID 역추적으로 편집 가능
    if ((w.published_id || w.published_url) && (w.target === "wordpress" || w.target === "blogger")) {
      const ed = document.createElement("button"); ed.className = "mini"; ed.innerHTML = `<iconify-icon icon="solar:pen-2-linear"></iconify-icon> 편집`;
      ed.title = "편집모드로 열어 수정 후 재발행"; ed.addEventListener("click", () => { showView("board"); openWork(w.id); });
      row.appendChild(ed);
    }
    // 작업으로 되돌리기(실수로 발행표시한 경우 → 작업보드로 복귀해 재발행)
    const revert = document.createElement("button"); revert.className = "mini"; revert.innerHTML = `<iconify-icon icon="solar:undo-left-linear"></iconify-icon> 작업으로`;
    revert.title = "작업보드로 되돌리기(다시 발행)"; revert.addEventListener("click", async () => {
      if (!confirm("이 글을 작업보드로 되돌릴까요? (발행 기록에서 빠지고 다시 검수·발행할 수 있습니다)")) return;
      await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id, target: w.target, destination_id: w.destination_id, title: w.title || "", status: "generated" }) }).catch(() => {});
      setStatus("↩️ 작업보드로 되돌렸습니다. 작업보드에서 다시 발행하세요."); renderHistory();
    });
    row.appendChild(revert);
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕"; del.title = "기록 삭제";
    del.addEventListener("click", async () => { if (confirm("이 발행 기록을 삭제할까요? (실제 발행글은 그대로 유지됩니다)")) { await apiJson("/api/work/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id }) }).catch(() => {}); renderHistory(); } });
    row.appendChild(del); box.appendChild(row);
  }
}
async function openWork(id) {
  let w; try { w = await apiJson("/api/work/" + id); } catch { return; }
  const acc = accById()[w.destination_id] || { platform: w.target, role: "cushion", name: "" };
  cur = { id: w.id, acc, target: w.target, article: w.article || { blocks: [] }, keyword: (w.article && w.article.keyword) || deriveTopic(), html: w.html || "", resolvedType: (w.article && w.article.type) || "", published_url: w.published_url, published_id: w.published_id || "", status: w.status || "generated", publish_at: w.publish_at || "" };
  $("workDetail").style.display = "";
  renderCur();
  $("workDetail").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderCur() {
  if (!cur) return;
  $("metaLine").textContent = `[${cur.acc.name || PLAT_LABEL[cur.target] || cur.target}] ${cur.article.title || ""}` + (cur.resolvedType ? ` · 유형:${cur.resolvedType}` : "") + (cur.article.category ? ` · 카테고리:${cur.article.category}` : "") + `\n메타: ${cur.article.metaDescription || "-"}`;
  $("preview").srcdoc = buildPreviewDoc(cur.article.title || "", cur.html);
  const published = cur.status === "published";
  const canUpdate = published && (cur.published_id || cur.published_url) && (cur.target === "wordpress" || cur.target === "blogger");
  // 이미 발행된 글: '수정 발행'만, 미발행: 일반 발행 버튼들
  $("wpActions").classList.toggle("hidden", published || cur.target !== "wordpress");
  $("bloggerPublishBtn").classList.toggle("hidden", published || cur.target !== "blogger");
  $("markPublishedBtn").classList.toggle("hidden", published || cur.target === "wordpress");
  $("updatePublishBtn").classList.toggle("hidden", !canUpdate);
  $("pullLiveBtn").classList.toggle("hidden", !canUpdate);
  // 예약 발행: 미발행 + WP·블로거만
  const canAuto = !published && (cur.target === "wordpress" || cur.target === "blogger");
  $("schedPubRow").classList.toggle("hidden", !canAuto);
  if (canAuto) {
    $("schedPubAt").value = cur.publish_at ? toLocalInput(cur.publish_at) : "";
    const set = !!cur.publish_at;
    $("schedPubState").textContent = set ? `예약됨: ${fmtRunAt(cur.publish_at)}` : "";
    $("schedPubClear").classList.toggle("hidden", !set);
  }
  $("mainUrlRow").classList.toggle("hidden", !isDestRole(cur.acc));
  $("preview").classList.toggle("hidden", editMode);
  $("editor").classList.toggle("hidden", !editMode);
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
  $("preview").classList.toggle("hidden", editMode);   // 편집 시 iframe 숨기고 인라인 편집기로
  if (editMode) renderEditor();
  else { rebuildCur(); $("preview").srcdoc = buildPreviewDoc(cur.article.title || "", cur.html); saveCur(); }
}
function refreshAfterEdit() { rebuildCur(); $("preview").srcdoc = buildPreviewDoc(cur.article.title || "", cur.html); renderEditor(); saveCur(); }
// 텍스트 인라인 편집(타이핑 중 재렌더 없이 저장만 — 포커스 유지)
let _liveT = null;
function refreshAfterEditLive() { rebuildCur(); clearTimeout(_liveT); _liveT = setTimeout(saveCur, 600); }
function mkIconBtn(icon, title, fn) { const b = document.createElement("button"); b.className = "ied-btn"; b.title = title; b.innerHTML = `<iconify-icon icon="${icon}"></iconify-icon>`; b.addEventListener("click", (e) => { e.preventDefault(); fn(); }); return b; }

// ----- 편집기 이미지 드래그/붙여넣기 -----
const fileToDataUrl = (file) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
function blockIndexUnder(clientY) {
  const els = [...document.querySelectorAll("#editor .ied-block")];
  for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (clientY >= r.top && clientY <= r.bottom) return i; }
  return -1;
}
async function insertDroppedImage({ file, url, index, replaceIndex }) {
  if (!cur) return;
  setStatus("이미지 추가 중…");
  try {
    let finalUrl = url || "";
    if (cur.acc.platform === "wordpress") {
      const body = file ? { destinationId: cur.acc.id, dataUrl: await fileToDataUrl(file) } : { destinationId: cur.acc.id, imageUrl: url };
      const r = await apiJson("/api/wp-media", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      finalUrl = r.url;
    } else if (file) {
      finalUrl = await fileToDataUrl(file);  // 비-WP: 데이터URL(임시). 발행 전 확인 권장
    }
    if (!finalUrl) { setStatus("이미지 URL을 가져오지 못했어요.", true); return; }
    const blocks = cur.article.blocks || (cur.article.blocks = []);
    if (typeof replaceIndex === "number" && blocks[replaceIndex] && blocks[replaceIndex].type === "image") {
      blocks[replaceIndex].resolvedUrl = finalUrl; delete blocks[replaceIndex]._genPrompt; delete blocks[replaceIndex].prompt;
      refreshAfterEdit(); setStatus("✅ 이미지를 교체했어요.");
    } else {
      const at = (typeof index === "number" && index >= 0 && index <= blocks.length) ? index : blocks.length;
      blocks.splice(at, 0, { type: "image", slot: "body", resolvedUrl: finalUrl, alt: "" });
      refreshAfterEdit(); setStatus("✅ 드롭한 위치에 이미지를 넣었어요. (필요하면 ↑↓로 이동)");
    }
  } catch (e) { setStatus("이미지 추가 실패: " + e.message, true); }
}
// 드롭 Y좌표 → 삽입할 blocks 인덱스
function dropIndexFromY(clientY) {
  const els = [...document.querySelectorAll("#editor .ied-block")];
  for (let i = 0; i < els.length; i++) { const r = els[i].getBoundingClientRect(); if (clientY < r.top + r.height / 2) return i; }
  return els.length;
}
// 붙여넣기 시 커서가 있는 블록 다음 위치
function caretBlockIndex() {
  const els = [...document.querySelectorAll("#editor .ied-block")];
  const sel = document.getSelection(); const node = sel && sel.anchorNode;
  const el = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
  const blk = el && el.closest ? el.closest(".ied-block") : null;
  if (blk) { const i = els.indexOf(blk); if (i >= 0) return i + 1; }
  return els.length;
}
function extractDragUrl(dt) {
  let url = dt.getData("text/uri-list") || "";
  if (!url) { const html = dt.getData("text/html"); const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i); if (m) url = m[1]; }
  if (!url) { const t = (dt.getData("text/plain") || "").trim(); if (/^https?:\/\/\S+/i.test(t)) url = t; }
  return (url || "").split("\n")[0].trim();
}
let _dragBlockIdx = null;   // 블록 순서변경 드래그 중인 소스 인덱스
function moveBlock(src, dst) {
  const a = cur.article.blocks; if (src == null || src < 0 || src >= a.length) return;
  const [b] = a.splice(src, 1);
  let t = dst > src ? dst - 1 : dst;   // 제거로 인한 인덱스 시프트 보정
  a.splice(Math.max(0, Math.min(t, a.length)), 0, b);
  refreshAfterEdit();
}
async function onEditorDrop(e) {
  if (!editMode || !cur) return;
  e.preventDefault(); $("editor").classList.remove("ied-dragover");
  const dt = e.dataTransfer;
  // 1) 내부 블록 순서변경
  if (_dragBlockIdx != null || (dt && [...dt.types].includes("application/x-blockindex"))) {
    const src = _dragBlockIdx != null ? _dragBlockIdx : parseInt(dt.getData("application/x-blockindex"), 10);
    _dragBlockIdx = null;
    const dst = dropIndexFromY(e.clientY);
    if (!Number.isNaN(src)) moveBlock(src, dst);
    return;
  }
  if (!dt) return;
  const idx = dropIndexFromY(e.clientY);
  const file = [...(dt.files || [])].find((f) => f.type.startsWith("image/"));
  const url = file ? null : extractDragUrl(dt);
  if (!file && !(url && /^https?:\/\//i.test(url))) { setStatus("이미지를 인식하지 못했어요. 이미지 파일이나 웹 이미지를 끌어다 놓아 주세요.", true); return; }
  // 기존 이미지 블록 위에 놓으면 교체/추가 선택
  const overIdx = blockIndexUnder(e.clientY);
  if (overIdx >= 0 && cur.article.blocks[overIdx] && cur.article.blocks[overIdx].type === "image") {
    const replace = confirm("이 이미지 위에 놓았어요.\n\n[확인] 기존 이미지 교체\n[취소] 이 아래에 새 이미지 추가");
    return insertDroppedImage(replace ? { file, url, replaceIndex: overIdx } : { file, url, index: overIdx + 1 });
  }
  return insertDroppedImage({ file, url, index: idx });
}
async function onEditorPaste(e) {
  if (!editMode || !cur) return;
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find((it) => it.type.startsWith("image/"));
  if (img) { const file = img.getAsFile(); if (file) { e.preventDefault(); await insertDroppedImage({ file, index: caretBlockIndex() }); } }
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
  if (!cur) { box.innerHTML = '<div class="ed-hint">작업을 선택하세요.</div>'; return; }
  const d = document.createElement("div"); d.className = "ed-hint"; d.innerHTML = '미리보기 위에서 바로 편집 — 제목·문단·소제목은 <b>클릭해서 수정</b>, 블록 사이 마우스 올려 추가, 우측 아이콘으로 순서변경·삭제. <b>이미지</b>는 인터넷/파일에서 <b>드래그</b>하거나 <b>Ctrl+V 붙여넣기</b>로 넣을 수 있어요(워드프레스는 미디어에 자동 업로드).';
  box.appendChild(d);
  const article = document.createElement("div"); article.className = "ied-doc"; box.appendChild(article);
  // 제목
  const h1 = document.createElement("h1"); h1.className = "ied-h1"; h1.contentEditable = "true"; h1.spellcheck = false; h1.textContent = cur.article.title || "";
  h1.addEventListener("blur", () => { cur.article.title = h1.innerText.trim(); refreshAfterEditLive(); });
  article.appendChild(h1);
  const blocks = cur.article.blocks || [];
  article.appendChild(insertBar(0));
  blocks.forEach((b, i) => { article.appendChild(blockRow(b, i)); article.appendChild(insertBar(i + 1)); });
}
function insertBar(index) {
  const bar = document.createElement("div"); bar.className = "ed-insert";
  const mk = (label, fn) => { const btn = document.createElement("button"); btn.textContent = label; btn.addEventListener("click", () => fn(index, bar)); return btn; };
  bar.appendChild(mk("+ 글", addTextAt)); bar.appendChild(mk("+ 버튼", addButtonAt)); bar.appendChild(mk("+ 이미지", addImageAt)); bar.appendChild(mk("+ 영상", addVideoAt));
  return bar;
}
function blockRow(b, i) {
  const row = document.createElement("div"); row.className = "ied-block";
  // 우측 상단 컨트롤(hover 시 노출)
  const ctrl = document.createElement("div"); ctrl.className = "ied-ctrl";
  // 잡아서 끌어 순서변경 핸들
  const handle = document.createElement("span"); handle.className = "ied-btn ied-drag"; handle.title = "잡아서 끌어 이동"; handle.draggable = true; handle.innerHTML = `<iconify-icon icon="solar:menu-dots-bold"></iconify-icon>`;
  handle.addEventListener("dragstart", (e) => { _dragBlockIdx = i; try { e.dataTransfer.setData("application/x-blockindex", String(i)); e.dataTransfer.effectAllowed = "move"; } catch {} row.classList.add("ied-dragging"); });
  handle.addEventListener("dragend", () => { _dragBlockIdx = null; row.classList.remove("ied-dragging"); });
  ctrl.appendChild(handle);
  ctrl.appendChild(mkIconBtn("solar:arrow-up-linear", "위로", () => { const a = cur.article.blocks; if (i > 0) { [a[i - 1], a[i]] = [a[i], a[i - 1]]; refreshAfterEdit(); } }));
  ctrl.appendChild(mkIconBtn("solar:arrow-down-linear", "아래로", () => { const a = cur.article.blocks; if (i < a.length - 1) { [a[i + 1], a[i]] = [a[i], a[i + 1]]; refreshAfterEdit(); } }));
  const structural = !["paragraph", "heading", "list", "callout"].includes(b.type);
  if (structural && b.type !== "image") ctrl.appendChild(mkIconBtn("solar:pen-linear", "수정", () => openBlockEdit(b, i, row)));
  ctrl.appendChild(mkIconBtn("solar:trash-bin-trash-linear", "삭제", () => { if (confirm("이 블록을 삭제할까요?")) { cur.article.blocks.splice(i, 1); refreshAfterEdit(); } }));
  row.appendChild(ctrl);

  if (b.type === "paragraph" || b.type === "heading" || b.type === "callout") {
    const el = document.createElement("div");
    el.className = "ied-edit" + (b.type === "heading" ? " ied-h" + (b.level || 2) : b.type === "callout" ? " ied-callout" : " ied-p");
    el.contentEditable = "true"; el.spellcheck = false; el.textContent = b.text || "";
    el.addEventListener("blur", () => { b.text = el.innerText; refreshAfterEditLive(); });
    row.appendChild(el);
  } else if (b.type === "list") {
    const el = document.createElement("div"); el.className = "ied-edit ied-listedit"; el.contentEditable = "true"; el.spellcheck = false;
    el.innerText = (b.items || []).join("\n");
    el.addEventListener("blur", () => { b.items = el.innerText.split(/\n/).map((s) => s.trim()).filter(Boolean); refreshAfterEditLive(); });
    row.appendChild(el);
  } else if (b.type === "image") {
    // 이미지: 실제 미리보기 + 항상 보이는 설명(alt)·출처 입력
    const view = document.createElement("div"); view.className = "ied-view";
    try { view.innerHTML = buildHtml({ blocks: [b] }, { accent: accountStyle(cur.acc).accent, linkMode: "preserve" }).html; } catch { view.textContent = "[이미지]"; }
    row.appendChild(view);
    const meta = document.createElement("div"); meta.className = "ied-imgmeta";
    const mk = (ph, val, set) => { const el = document.createElement("input"); el.placeholder = ph; el.value = val || ""; el.addEventListener("input", () => set(el.value)); el.addEventListener("blur", refreshAfterEditLive); return el; };
    meta.appendChild(mk("이미지 설명(alt) — 검색 노출용", b.alt, (v) => (b.alt = v)));
    meta.appendChild(mk("출처(선택) — 예: 사진: 국민연금공단", b.credit, (v) => (b.credit = v)));
    meta.appendChild(mk("출처 링크(선택) — https://...", b.creditUrl, (v) => (b.creditUrl = v)));
    row.appendChild(meta);
    // 이미지 재생성 컨트롤(블록 바로 아래) — 하단 섹션까지 안 내려가도 되게
    const gen = document.createElement("div"); gen.className = "ied-imggen";
    const instr = document.createElement("input"); instr.type = "text"; instr.placeholder = "AI 재생성/수정 요청 (예: 배경 더 밝게, 노인 손 클로즈업)";
    const regenBtn = document.createElement("button"); regenBtn.className = "mini primary-mini"; regenBtn.innerHTML = `<iconify-icon icon="solar:magic-stick-3-linear"></iconify-icon> 다시 생성`;
    regenBtn.addEventListener("click", () => regenImage(b, instr.value.trim()));
    const editBtn = document.createElement("button"); editBtn.className = "mini"; editBtn.innerHTML = `<iconify-icon icon="solar:pen-new-square-linear"></iconify-icon> 부분 수정`;
    editBtn.addEventListener("click", () => editImg(b, instr.value.trim()));
    gen.appendChild(instr); gen.appendChild(regenBtn); gen.appendChild(editBtn);
    row.appendChild(gen);
  } else {
    // 구조 블록(버튼/링크카드/영상/표): 실제 렌더된 모습 그대로 표시
    const view = document.createElement("div"); view.className = "ied-view";
    try { view.innerHTML = buildHtml({ blocks: [b] }, { accent: accountStyle(cur.acc).accent, linkMode: "preserve", relatedUrls: (lastMyPosts || []).map((x) => x.link), selfUrl: isDestRole(cur.acc) ? "" : destUrlForGen() }).html; }
    catch { view.textContent = edSummary(b); }
    row.appendChild(view);
  }
  return row;
}
// 구조 블록 인라인 수정 폼
function openBlockEdit(b, i, row) {
  const old = row.querySelector(".ied-form"); if (old) { old.remove(); return; }
  const form = document.createElement("div"); form.className = "ied-form";
  const addInput = (ph, val) => { const el = document.createElement("input"); el.placeholder = ph; el.value = val || ""; form.appendChild(el); return el; };
  let apply;
  if (b.type === "cta") {
    const label = addInput("버튼 문구", b.label); const url = addInput("링크 URL(비우면 목적지)", b.url === "#" ? "" : b.url);
    apply = () => { b.label = label.value.trim() || "자세히 보기 →"; b.url = url.value.trim() || destUrlForGen() || "#"; };
  } else if (b.type === "youtube") {
    const url = addInput("유튜브 주소", b.url);
    apply = () => { if (!ytId(url.value.trim())) { setStatus("유효한 유튜브 주소가 아닙니다.", true); return false; } b.url = url.value.trim(); };
  } else if (b.type === "linkcard") {
    const head = addInput("카드 제목", b.heading);
    apply = () => { b.heading = head.value.trim(); };
  } else if (b.type === "image") {
    const alt = addInput("대체텍스트(alt) — 검색 노출용 이미지 설명", b.alt);
    const credit = addInput("출처 표기(선택) — 예: 사진: 국민연금공단", b.credit);
    const creditUrl = addInput("출처 링크(선택) — https://...", b.creditUrl);
    apply = () => { b.alt = alt.value.trim(); b.credit = credit.value.trim(); b.creditUrl = creditUrl.value.trim(); };
    form.appendChild(Object.assign(document.createElement("span"), { className: "muted", textContent: "이미지 재생성은 아래 '이미지 수정'에서" }));
  } else if (b.type === "table") {
    const ta = document.createElement("textarea"); ta.rows = 4; ta.placeholder = "행마다 줄바꿈, 칸은 | 로 구분"; ta.value = [(b.headers || []).join(" | "), ...(b.rows || []).map((r) => r.join(" | "))].join("\n"); form.appendChild(ta);
    apply = () => { const ls = ta.value.split(/\n/).map((s) => s.trim()).filter(Boolean).map((l) => l.split("|").map((c) => c.trim())); b.headers = ls[0] || []; b.rows = ls.slice(1); };
  } else { apply = () => {}; }
  const ok = document.createElement("button"); ok.className = "mini primary-mini"; ok.textContent = "적용";
  ok.addEventListener("click", () => { if (apply() !== false) refreshAfterEdit(); });
  const cancel = document.createElement("button"); cancel.className = "mini"; cancel.textContent = "취소"; cancel.addEventListener("click", () => form.remove());
  form.appendChild(ok); form.appendChild(cancel);
  row.appendChild(form); const fi = form.querySelector("input,textarea"); if (fi) fi.focus();
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
    const res = await wpCreatePost({ title: cur.article.title, content: cur.html, status, destinationId: cur.acc.id, category: cur.article.category });
    if (res.link) {
      try { await saveMyPost({ title: cur.article.title, url: res.link, keyword: cur.keyword }, (cur.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {}
      if (status === "publish") {
        if (isDestRole(cur.acc)) $("bloggerUrl").value = res.link;   // 목적지 → 쿠션 유입 URL
        // 발행 완료 → 작업 목록에서 제거(status published)
        await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", status: "published", published_url: res.link, published_id: res.id != null ? String(res.id) : null, publish_mode: "manual" }) }).catch(() => {});
        cur = null; $("workDetail").style.display = "none"; renderWorkList();
      }
    }
    setStatus(`✅ ${label} 완료: ${res.link || ("글 #" + res.id)}${status === "publish" && isDestRole(cur?.acc || {}) ? " · 목적지로 설정됨" : ""}`);
  } catch (e) { setStatus(`${label} 실패: ` + e.message, true); }
}
async function bloggerPublish() {
  if (!cur?.html) return;
  if (cur.target !== "blogger") return;
  try {
    setStatus(`[${cur.acc.name || "블로거"}] 블로거 발행 중…`);
    const res = await apiJson("/api/blogger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: cur.acc.id, title: cur.article.title, content: cur.html }) });
    if (res.link) {
      try { await saveMyPost({ title: cur.article.title, url: res.link, keyword: cur.keyword }, (cur.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {}
      await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", status: "published", published_url: res.link, published_id: res.id != null ? String(res.id) : null, publish_mode: "manual" }) }).catch(() => {});
      setStatus(`✅ 블로거 발행 완료: ${res.link}`);
      cur = null; $("workDetail").style.display = "none"; renderWorkList();
    }
  } catch (e) { setStatus("블로거 발행 실패: " + e.message + " · 계정 관리에서 '구글 연결'을 확인하세요.", true); }
}
