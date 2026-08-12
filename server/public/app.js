// 블로그 오토라이터 — 웹앱 프론트 (파이프라인: 원본 1개 → 블로거·네이버·워드프레스 3종)
import { buildBloggerMain, buildCushionPrompt, buildDraftPrompt } from "./lib/prompts.js?v=20260721c";
import { buildHtml, buildPreviewDoc } from "./lib/html-builder.js?v=20260722b";
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
`Ultra eye-catching Korean thumbnail engineered for MAXIMUM click-through, following current top-creator trends (2026). Bold high-saturation color-blocked or duotone background; the main subject POPS off the background with a subtle glow / rim light and shallow depth of field. ONE clear focal subject, uncluttered. ADAPT to the subject: (a) real person central → photorealistic dramatic close-up portrait with strong natural emotion (surprise / serious / curious), moody cinematic rim lighting; (b) product/object → bold hero shot with dramatic lighting; (c) concept/issue/how-to → one striking symbolic cinematic scene. Include the Korean headline text large and PERFECTLY spelled, FREELY placed and styled (font, color, layout, effects, highlight) so it best fits the mood/scene — not confined to any fixed area. Keep strong contrast against the background, do NOT crop/cut off any letters, and make it clearly readable as a tiny mobile thumbnail. Premium, punchy, high-contrast — but clean, NOT busy. NO cartoon mascots, NO cheap clip-art graphs/arrows/flags/finance icons, NO random extra people, NO messy collage.`;

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
const accountSetEnabled = (id, enabled) => apiJson("/api/destinations/enabled", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
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

  document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view, b.classList.contains("active"))));
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
  $("publishBtn").addEventListener("click", publishCur);
  $("markPublishedBtn").addEventListener("click", onMarkPublished);
  $("cushGenBtn").addEventListener("click", generateCushions);
  $("cushRefresh").addEventListener("click", renderCushion);
  $("cushSrcSelect").addEventListener("change", onCushSrcChange);
  const brandEl = document.querySelector(".brand"); if (brandEl) { brandEl.style.cursor = "pointer"; brandEl.title = "홈(작업보드)으로"; brandEl.addEventListener("click", () => showView("board")); }
  $("anRefresh").addEventListener("click", renderAnalytics);
  ["anWindow", "anSort", "anDir", "anBlog"].forEach((id) => $(id).addEventListener("change", renderAnList));
  $("schedPubSet").addEventListener("click", onSchedulePublishSet);
  $("schedPubClear").addEventListener("click", onSchedulePublishClear);
  $("workBack").addEventListener("click", () => { cur = null; $("workDetail").style.display = "none"; });
  $("deleteWorkBtn").addEventListener("click", deleteCur);
  $("myPostAdd").addEventListener("click", onAddMyPost);
  $("myPostSearch").addEventListener("input", () => renderMyPosts());
  $("myPostDateFilter")?.addEventListener("change", () => renderMyPosts());
  $("trendRefresh").addEventListener("click", () => renderTrends(true));
  $("draftsRefresh").addEventListener("click", () => renderDrafts(true));
  $("draftSearch").addEventListener("input", () => { clearTimeout(_dq); _dq = setTimeout(() => renderDrafts(true), 300); });
  $("draftFilter").addEventListener("change", () => renderDrafts(true));
  $("draftsMore").addEventListener("click", () => renderDrafts(false));
  $("accPlatform").addEventListener("change", updateAccForm);
  $("accSave").addEventListener("click", onAccountSave);
  $("accCancel").addEventListener("click", resetAccForm);
  $("accGoogleConnect").addEventListener("click", onGoogleConnect);
  // (발행 버튼은 publishBtn 하나로 통합 — 플랫폼은 계정에 따라 자동)
  $("updatePublishBtn").addEventListener("click", updatePublish);
  $("pullLiveBtn").addEventListener("click", pullLive);
  $("aiEditBtn").addEventListener("click", aiEditArticle);
  $("aiEditInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); aiEditArticle(); } });
  $("schSource").addEventListener("change", updateSchForm);
  $("schScope").addEventListener("change", updateSchForm);
  $("schSave").addEventListener("click", onScheduleSave);
  $("schCancel").addEventListener("click", resetSchForm);
  $("topicAdd").addEventListener("click", addTopic);
  $("topicKw").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTopic(); } });
  $("draftGuideSave").addEventListener("click", async () => {
    try { await saveSettings({ draftGuide: $("draftGuide").value }); settings = await getSettings(); setStatus("✅ 초안 작성 지침 저장됨 (다음 실행부터 반영)"); }
    catch (e) { setStatus("지침 저장 실패: " + e.message, true); }
  });
  $("optSave").addEventListener("click", onSaveOptions);
  $("tgTestBtn").addEventListener("click", onTgTest);
  $("pmClose").addEventListener("click", closeProgress);
  $("pmCancel").addEventListener("click", cancelProgress);
  $("historyRefresh").addEventListener("click", renderHistory);
  $("byDraftRefresh").addEventListener("click", renderByDraft);
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
function showView(name, refresh) {
  if (!progressOpen) clearStatus();
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  if (name === "board") renderWorkList();
  else if (name === "inbox") renderDrafts(true);
  else if (name === "accounts") renderAccounts();
  else if (name === "bydraft") renderByDraft();
  else if (name === "history") renderHistory();
  else if (name === "assets") renderMyPosts();
  else if (name === "schedule") { renderSchedules(); renderTopics(); $("draftGuide").value = settings.draftGuide || ""; }
  else if (name === "new") { setGenMode(genMode === "cushion" ? "draft" : genMode); }
  else if (name === "trends") { if (refresh || !_trendsLoaded) renderTrends(!!refresh); }
  else if (name === "cushion") renderCushion();
  else if (name === "analytics") renderAnalytics();
  else if (name === "settings") populateSettings();
  window.scrollTo({ top: 0 });
  // 이미 활성화된 같은 메뉴를 다시 누르면 = 명시적 새로고침 (위 render 들이 최신 데이터로 다시 그려짐) + 피드백
  if (refresh) { setStatus("🔄 새로고침했습니다"); setTimeout(clearStatus, 1400); }
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
    const off = a.enabled === false;   // 휴재 계정: 자동체크 안 됨 + 선택 불가
    const checked = off ? false : (hadAny ? (prev[a.id] === true) : false);   // 기본 미체크 — 니치 맞는 것만 자동 체크(autoSelectAccountsByTopic)
    const lab = document.createElement("label"); lab.className = "acc-pick" + (off ? " acc-pick-off" : "");
    lab.innerHTML = `<input type="checkbox" value="${a.id}" ${checked ? "checked" : ""} ${off ? "disabled" : ""}>`
      + `<span class="acc-badge ${genMode === "destination" ? "dest" : "cush"}">${PLAT_LABEL[a.platform] || a.platform}</span>`
      + `<span class="nm">${escapeHtml(a.name || "(이름없음)")}</span>`
      + (off ? `<span class="acc-pause">휴재중</span>` : "");
    box.appendChild(lab);
  }
}
function selectedAccountsForMode() {
  const checked = new Set([...document.querySelectorAll("#genAccPick input:checked")].map((i) => i.value));
  return accountsForMode().filter((a) => checked.has(String(a.id)) && a.enabled !== false);   // 휴재 계정 제외
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
  // 휴재(off) 계정은 니치가 맞아도 점수 0 → 자동 체크 안 됨
  const scored = inputs.map((i) => ({ i, s: (amap[i.value] && amap[i.value].enabled !== false) ? accountTopicMatch(amap[i.value], text) : 0 }));
  if (!scored.some((x) => x.s > 0)) return;                 // 매칭 없으면 기존 유지
  scored.forEach((x) => { if (!x.i.disabled) x.i.checked = x.s > 0; });
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
    const off = a.enabled === false;
    const row = document.createElement("div"); row.className = "acc-row" + (off ? " acc-off" : "");
    const rc = a.role === "destination" ? "dest" : (a.role === "both" ? "both" : "cush");
    row.innerHTML = `<span class="acc-badge ${rc}">${ROLE_LABEL[a.role] || a.role}</span>`
      + `<span class="nm">${a.name || "(이름없음)"}</span>`
      + `<span class="acc-plat">${PLAT_LABEL[a.platform] || a.platform}</span>`
      + (a.platform === "wordpress" ? `<span class="cred-chip ${a.has_creds ? "on" : "off"}"><iconify-icon icon="${a.has_creds ? "solar:lock-keyhole-bold" : "solar:lock-keyhole-unlocked-linear"}"></iconify-icon>${a.has_creds ? "인증 저장됨" : "인증 없음"}</span>`
        : a.platform === "blogger" ? `<span class="cred-chip ${a.has_creds ? "on" : "off"}"><iconify-icon icon="${a.has_creds ? "solar:link-bold" : "solar:link-broken-linear"}"></iconify-icon>${a.has_creds ? "구글 연결됨" : "연결 필요"}</span>` : "")
      + (off ? '<span class="acc-pause">휴재중</span>' : "")
      + (a.is_default ? '<span class="df">기본</span>' : "");
    // on/off(휴재) 토글 — off면 니치가 맞아도 목적지글 자동체크/자동생성에서 제외
    const tog = document.createElement("button");
    tog.className = "acc-toggle" + (off ? " off" : " on");
    tog.innerHTML = `<iconify-icon icon="${off ? "solar:pause-circle-bold" : "solar:play-circle-bold"}"></iconify-icon>${off ? "휴재" : "사용중"}`;
    tog.title = off ? "휴재 해제(사용) — 다시 목적지 대상에 포함" : "휴재(off) — 목적지 자동체크/자동생성에서 제외";
    tog.addEventListener("click", async () => {
      tog.disabled = true;
      try { await accountSetEnabled(a.id, off); renderAccounts(); setStatus(off ? `▶️ '${a.name}' 사용 재개` : `⏸️ '${a.name}' 휴재로 전환 — 목적지 대상에서 제외됩니다`); }
      catch (e) { setStatus("상태 변경 실패: " + e.message, true); tog.disabled = false; }
    });
    const edit = document.createElement("button"); edit.className = "hist-del"; edit.textContent = "✎"; edit.title = "수정";
    edit.addEventListener("click", () => loadAccForEdit(a));
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { if (confirm("계정을 삭제할까요?")) { await accountDelete(a.id); renderAccounts(); } });
    row.appendChild(tog); row.appendChild(edit); row.appendChild(del); box.appendChild(row);
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
async function renderTopics() {
  const box = $("topicList"); if (!box) return;
  let topics = [];
  try { topics = await apiJson("/api/topics").then((j) => j.topics || []); } catch {}
  const pending = topics.filter((t) => t.status === "pending");
  box.innerHTML = "";
  if (!topics.length) { box.innerHTML = '<div class="hist-empty">대기 중인 키워드가 없습니다. 비워두면 에이전트가 니치에서 트렌드 주제를 스스로 고릅니다.</div>'; return; }
  for (const t of topics) {
    const used = t.status !== "pending";
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `<span class="acc-badge ${used ? "cush" : "dest"}">${used ? "사용됨" : "대기"}</span>`
      + `<span class="nm">${escapeHtml(t.keyword)}</span>`
      + (t.note ? `<span class="muted" style="flex:1;">${escapeHtml(t.note)}</span>` : "");
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async () => { await apiJson("/api/topics/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: t.id }) }).catch(() => {}); renderTopics(); });
    row.appendChild(del); box.appendChild(row);
  }
}
async function addTopic() {
  const kw = $("topicKw").value.trim(); if (!kw) { setStatus("키워드를 입력하세요.", true); return; }
  try { await apiJson("/api/topics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keyword: kw, note: $("topicNote").value.trim() }) }); $("topicKw").value = ""; $("topicNote").value = ""; renderTopics(); setStatus("✅ 키워드 대기열에 추가됨"); }
  catch (e) { setStatus("추가 실패: " + e.message, true); }
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
    const tag = d.status === "used" ? "✅ " : (d.status === "failed" ? "⚠️ " : (d.status === "new" ? "🆕 " : ""));
    const failNote = d.status === "failed" ? `<span style="color:#e11d48;font-weight:600;"> · 자동생성 실패(보관됨)</span>` : "";
    b.innerHTML = `<b>${tag}${(d.title || "(제목없음)")}</b>${d.keyword ? ` · ${d.keyword}` : ""}${failNote}<div class="muted" style="font-weight:400;white-space:normal;">${(d.preview || "").replace(/</g, "&lt;")}…</div>`;
    b.addEventListener("click", () => loadDraft(d.id, d.title));
    row.appendChild(b);
    if (d.status === "failed") {
      const rt = document.createElement("button"); rt.className = "hist-del"; rt.textContent = "↻"; rt.title = "재시도 — 자동생성 대기열에 다시 넣기";
      rt.addEventListener("click", async (e) => { e.preventDefault(); await draftStatus(d.id, "new"); setStatus("↻ 재시도 대기열에 넣었어요. 다음 자동 처리 주기에 다시 생성합니다."); renderDrafts(true); updateInboxBadge(); });
      row.appendChild(rt);
    }
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => { e.preventDefault(); if (confirm("이 초안을 삭제할까요?")) { await draftDelete(d.id); renderDrafts(true); updateInboxBadge(); } });
    row.appendChild(del); box.appendChild(row);
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

let _statusT = null;
function setStatus(msg, isError = false) {
  const el = $("status"); el.textContent = msg; el.classList.remove("hidden"); el.classList.toggle("error", isError);
  if (progressOpen && !isError) progressStep(msg);
  clearTimeout(_statusT);
  // 진행중 모달이 열려있지 않으면 잠깐 보였다가 자동으로 사라짐(토스트)
  if (!progressOpen) _statusT = setTimeout(() => el.classList.add("hidden"), isError ? 6000 : 3200);
}

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
function clearStatus() { clearTimeout(_statusT); $("status").classList.add("hidden"); }
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
  $("optThumbAspect").value = settings.thumbAspect || "16:9";
  $("optBodyAspect").value = settings.bodyAspect || "4:3";
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
  $("optAutoMultiMatch").checked = settings.autoMultiMatch !== false;
  $("optAutoMultiMax").value = settings.autoMultiMax != null ? settings.autoMultiMax : 0;
  $("optTgEnabled").checked = !!settings.tgEnabled;
  $("optTgChatId").value = settings.tgChatId || "";
  $("optTgBotToken").placeholder = settings.hasTgBotToken ? "저장됨 (변경 시에만 입력)" : "예: 8215466645:AA...";
  $("optTgOnDraft").checked = settings.tgOnDraft !== false;
  $("optTgOnGenerate").checked = settings.tgOnGenerate !== false;
  $("optTgOnPublish").checked = settings.tgOnPublish !== false;
  $("optTgOnSchedule").checked = settings.tgOnSchedule !== false;
  $("optTgOnError").checked = settings.tgOnError !== false;
}
async function onSaveOptions() {
  const patch = {
    genEngine: $("optEngine").value,
    kieChatModel: $("optChatModel").value, thumbnailMode: $("optThumbMode").value, imageResolution: $("optImgRes").value,
    thumbAspect: $("optThumbAspect").value, bodyAspect: $("optBodyAspect").value,
    // 키는 입력했을 때만(비우면 유지)
    ...($("optAnthropicKey").value.trim() ? { anthropicKey: $("optAnthropicKey").value.trim() } : {}),
    ...($("optKieKey").value.trim() ? { kieKey: $("optKieKey").value.trim() } : {}),
    ...($("optNaverId").value.trim() ? { naverClientId: $("optNaverId").value.trim() } : {}),
    ...($("optNaverSecret").value.trim() ? { naverClientSecret: $("optNaverSecret").value.trim() } : {}),
    ...($("optPexelsKey").value.trim() ? { pexelsKey: $("optPexelsKey").value.trim() } : {}),
    linkMode: $("optLinkMode").value, overlayAccent: $("optAccent").value, myBlogUrl: $("optMyBlog").value.trim(),
    defaultTone: $("optTone").value.trim(), defaultAudience: $("optAudience").value.trim(), authorBio: $("optAuthorBio").value.trim(),
    thumbnailStylePrompt: $("optThumbStyle").value.trim(), adEnabled: $("optAdEnabled").checked, adCode: $("optAdCode").value.trim(),
    autoPublish: $("optAutoPublish").checked, stockPhotos: $("optStockPhotos").checked, autoProcessDrafts: $("optAutoProcessDrafts").checked,
    autoMultiMatch: $("optAutoMultiMatch").checked, autoMultiMax: parseInt($("optAutoMultiMax").value, 10) || 0,
    tgEnabled: $("optTgEnabled").checked, tgChatId: $("optTgChatId").value.trim(),
    ...($("optTgBotToken").value.trim() ? { tgBotToken: $("optTgBotToken").value.trim() } : {}),
    tgOnDraft: $("optTgOnDraft").checked, tgOnGenerate: $("optTgOnGenerate").checked, tgOnPublish: $("optTgOnPublish").checked, tgOnSchedule: $("optTgOnSchedule").checked, tgOnError: $("optTgOnError").checked
  };
  try { await saveSettings(patch); settings = await getSettings(); try { config = await apiJson("/api/config"); } catch {} $("apiWarn").classList.toggle("hidden", !!config.kieEnabled || !!config.claudeEnabled); populateSettings(); setStatus("✅ 설정 저장됨"); }
  catch (e) { setStatus("설정 저장 실패: " + e.message, true); }
}
async function onTgTest() {
  // 테스트 전에 현재 입력값 저장(토큰/챗ID 반영)
  const patch = { tgEnabled: $("optTgEnabled").checked, tgChatId: $("optTgChatId").value.trim(), ...($("optTgBotToken").value.trim() ? { tgBotToken: $("optTgBotToken").value.trim() } : {}) };
  try {
    await saveSettings(patch); settings = await getSettings(); populateSettings();
    setStatus("테스트 발송 중…");
    await apiJson("/api/telegram/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    setStatus("✅ 텔레그램 테스트 발송됨. 봇 대화방을 확인하세요.");
  } catch (e) { setStatus("테스트 발송 실패: " + e.message, true); }
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
      selectedTrend = { title: it.title, traffic: it.traffic || "", newsTitle: it.newsTitle || "", newsSource: it.newsSource || "", source: it.source || "" };
      showView("new");            // 트렌드 → 새 글 생성(초안)으로 이동
      setGenMode("draft");
      $("draftKeyword").value = it.title;
      $("draftKeyword").focus();
      setStatus(`✨ "${it.title}" 트렌드를 초안 키워드에 넣었어요. 'AI 초안 생성'을 누르세요.`);
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
    for (const r of recs) if (r.type === "post" && r.url && /^https?:\/\//.test(r.url) && !seen.has(r.url)) { seen.add(r.url); out.push({ title: r.title || r.url, url: r.url, keyword: r.keyword || "", date: r.date || "" }); }
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
  const dfv = ($("myPostDateFilter")?.value || "");
  const kstDay = (d) => { try { return new Date(d).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); } catch { return ""; } };
  let filtered = q ? all.filter((p) => ((p.title || "") + " " + (p.keyword || "") + " " + (p.url || "")).toLowerCase().includes(q)) : all;
  if (dfv) {
    if (dfv === "3d") { const days = new Set([0, 1, 2].map((n) => kstDay(Date.now() - n * 86400000))); filtered = filtered.filter((p) => p.date && days.has(kstDay(p.date))); }
    else { const target = kstDay(Date.now() - parseInt(dfv, 10) * 86400000); filtered = filtered.filter((p) => p.date && kstDay(p.date) === target); }
  }
  const shown = filtered.slice(0, 60);
  const dlabel = { "0": "오늘", "1": "어제", "2": "그제", "3d": "최근 3일" }[dfv] || "";
  $("myPostsCount").textContent = (dlabel ? dlabel + " · " : "") + (q ? `"${q}" ` : "") + `${filtered.length}개` + (filtered.length > shown.length ? ` · 최근 ${shown.length}개 표시` : "");
  box.innerHTML = "";
  if (!shown.length) { box.innerHTML = '<div class="hist-empty">' + (q || dfv ? "해당 조건의 글이 없습니다." : "발행 글이 없습니다.") + '</div>'; return; }
  for (const p of shown) {
    const row = document.createElement("div"); row.className = "hist-item";
    const a = document.createElement("a"); a.className = "hist-load"; a.href = p.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = p.title || p.url; a.title = p.url; a.style.cssText = "text-decoration:none;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const when = document.createElement("span"); when.className = "muted"; when.style.cssText = "font-size:.72rem;margin:0 8px;white-space:nowrap;flex:none;";
    when.textContent = p.date ? new Date(p.date).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
    const edit = document.createElement("button"); edit.className = "hist-del"; edit.textContent = "✎"; edit.title = "편집(수정발행)"; edit.style.marginRight = "4px";
    edit.addEventListener("click", (e) => { e.preventDefault(); editPublishedPost(p); });
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => { e.preventDefault(); await storeDelete(p.url); await renderMyPosts(); });
    row.appendChild(a); row.appendChild(when); row.appendChild(edit); row.appendChild(del); box.appendChild(row);
  }
}
// 발행 자산(자동발행 포함)을 블로그라이터에서 직접 편집 → WP 수정발행
async function editPublishedPost(p) {
  const host = (u) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return ""; } };
  const ph = host(p.url);
  if (!ph) { setStatus("이 글의 주소가 올바르지 않습니다.", true); return; }
  let dests = [];
  try { dests = await accountsApi(); } catch {}
  const dest = dests.find((d) => d.platform === "wordpress" && host(d.site_url) === ph);
  if (!dest) { setStatus("이 사이트(" + ph + ")가 목적지로 등록돼 있지 않아 편집할 수 없습니다(계정 관리에서 등록).", true); return; }
  setStatus("불러오는 중…");
  let data;
  try {
    data = await apiJson("/api/remote-post", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: dest.id, postUrl: p.url, raw: true }) });
  } catch (e) { setStatus("불러오기 실패: " + e.message, true); return; }
  setStatus("");
  openEditModal({ destId: dest.id, url: p.url, title: (data.title || p.title || ""), content: (data.raw || data.html || "") });
}
function openEditModal({ destId, url, title, content }) {
  document.getElementById("oguEditModal")?.remove();
  const ov = document.createElement("div"); ov.id = "oguEditModal";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;";
  const box = document.createElement("div");
  box.style.cssText = "background:#fff;border-radius:14px;max-width:840px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);";
  box.innerHTML =
    '<div style="padding:14px 18px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:10px">' +
    '<strong style="font-size:1rem">발행글 편집</strong>' +
    '<span id="oguEditUrl" style="color:#999;font-size:.78rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
    '<button id="oguEditClose" class="mini">닫기</button></div>' +
    '<div style="padding:16px 18px;overflow:auto;flex:1">' +
    '<label style="font-size:.78rem;color:#666">제목</label>' +
    '<input id="oguEditTitle" type="text" style="width:100%;margin:4px 0 12px" />' +
    '<label style="font-size:.78rem;color:#666">본문 HTML (숏코드·태그 그대로 편집)</label>' +
    '<textarea id="oguEditBody" spellcheck="false" style="width:100%;height:46vh;font-family:monospace;font-size:.82rem;line-height:1.5"></textarea></div>' +
    '<div style="padding:12px 18px;border-top:1px solid #eee;display:flex;gap:8px;align-items:center;justify-content:flex-end">' +
    '<a id="oguEditView" target="_blank" rel="noopener" class="mini" style="margin-right:auto">글 보기 ↗</a>' +
    '<button id="oguEditSave" class="primary">저장 (수정발행)</button></div>';
  ov.appendChild(box); document.body.appendChild(ov);
  document.getElementById("oguEditUrl").textContent = url;
  document.getElementById("oguEditView").href = url;
  document.getElementById("oguEditTitle").value = title;
  document.getElementById("oguEditBody").value = content;
  const close = () => ov.remove();
  document.getElementById("oguEditClose").onclick = close;
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
  document.getElementById("oguEditSave").onclick = async () => {
    const btn = document.getElementById("oguEditSave"); btn.disabled = true; btn.textContent = "저장 중…";
    try {
      await apiJson("/api/wp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: destId, postUrl: url, title: document.getElementById("oguEditTitle").value, content: document.getElementById("oguEditBody").value, status: "publish" }) });
      setStatus("✅ 수정 발행 완료");
      close();
    } catch (e) { setStatus("저장 실패: " + e.message, true); btn.disabled = false; btn.textContent = "저장 (수정발행)"; }
  };
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
// 검수 중인 작업 삭제(발행 안 함) — 작업보드에서 제거
async function deleteCur() {
  if (!cur) return;
  const t = (cur.article && cur.article.title) || cur.title || "이 글";
  if (!confirm(`'${t}'\n이 작업을 삭제할까요? (발행하지 않고 작업보드에서 제거합니다)`)) return;
  await apiJson("/api/work/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id }) }).catch(() => {});
  setStatus("작업을 삭제했습니다.");
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

// ===== 조회수 분석 =====
let _anData = null;
function fmtDateTime(iso) { if (!iso) return "-"; const d = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T")); if (isNaN(d)) return "-"; const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
// 발행기록 일자별 그룹 키(로컬 날짜 + 요일). 시간은 뺀다.
function dayKey(iso) { if (!iso) return "날짜 없음"; const d = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T")); if (isNaN(d)) return "날짜 없음"; const p = (n) => String(n).padStart(2, "0"); const wk = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()]; return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} (${wk})`; }
async function renderAnalytics() {
  const box = $("anList");
  box.innerHTML = '<div class="hist-empty">불러오는 중…</div>';
  try { _anData = await apiJson("/api/analytics"); } catch { box.innerHTML = '<div class="hist-empty">불러오기 실패</div>'; return; }
  // 블로그 필터 옵션 채우기
  const blogs = [...new Set((_anData.posts || []).map((p) => p.blog).filter(Boolean))];
  const bsel = $("anBlog"), cur0 = bsel.value;
  bsel.innerHTML = '<option value="">전체 블로그</option>' + blogs.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join("");
  bsel.value = cur0;
  renderAnList();
}
function renderAnList() {
  const box = $("anList"), note = $("anNote");
  if (!_anData) return;
  const posts = _anData.posts || [];
  if (!posts.length) { box.innerHTML = '<div class="hist-empty">집계할 발행글(워드프레스)이 아직 없습니다. 목적지글을 발행하면 1시간마다 조회수를 모읍니다.</div>'; note.classList.add("hidden"); return; }
  const win = parseInt($("anWindow").value, 10) || 24;
  const sort = $("anSort").value, dir = $("anDir").value === "asc" ? 1 : -1, blog = $("anBlog").value;
  if (!posts.some((p) => p.samples >= 2)) { note.classList.remove("hidden"); note.innerHTML = `<iconify-icon icon="solar:clock-circle-bold-duotone"></iconify-icon> 조회수 수집 시작됨. <b>누적은 바로</b>, <b>Δ·급등은 스냅샷이 쌓인 뒤(24~48h)</b>부터 정확해집니다.`; }
  else note.classList.add("hidden");
  let list = blog ? posts.filter((p) => p.blog === blog) : posts.slice();
  const metric = (p) => sort === "cumulative" ? p.cumulative : sort === "published" ? Date.parse(p.published_at || 0) || 0 : sort === "surge" ? p.surge24 : (p.deltas ? (p.deltas[win] || 0) : 0);
  list.sort((a, b) => (metric(a) - metric(b)) * dir);
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = '<div class="hist-empty">해당 블로그의 발행글이 없습니다.</div>'; return; }
  for (const p of list) {
    const dWin = p.deltas ? (p.deltas[win] || 0) : 0;
    const deltaBadge = dWin > 0 ? `<span class="pubm" style="background:#e7f7ec;color:#137a3e;">▲ ${dWin}</span>` : `<span class="df">Δ0</span>`;
    const surgeBadge = p.surge24 >= 2 ? `<span class="pubm" style="background:#fee2e2;color:#b91c1c;">🔥x${p.surge24}</span>` : "";
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `<span class="acc-plat" style="min-width:84px;">${escapeHtml(p.blog || "")}</span>`
      + `<span class="nm">${escapeHtml(p.title || "(제목없음)")}</span>`
      + `<span class="an-date">${fmtDateTime(p.published_at)}</span>`
      + `<span class="df" title="누적 조회수">👁 ${p.cumulative}</span>` + deltaBadge + surgeBadge;
    if (p.url) { const a = document.createElement("a"); a.className = "mini"; a.href = p.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "글 보기"; row.appendChild(a); }
    const cush = document.createElement("button"); cush.className = "mini primary-mini"; cush.innerHTML = `<iconify-icon icon="solar:link-linear"></iconify-icon> 쿠션글`; cush.addEventListener("click", () => openCushionFor(p.work_id)); row.appendChild(cush);
    box.appendChild(row);
  }
}
async function openCushionFor(workId) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === "cushion"));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== "cushion"));
  window.scrollTo({ top: 0 });
  await renderCushion();
  const sel = $("cushSrcSelect");
  if ([...sel.options].some((o) => o.value === workId)) { sel.value = workId; onCushSrcChange(); }
  else setStatus("이 글은 쿠션 목록에 없습니다(목적지 역할·발행 상태 확인).", true);
}

// ===== 쿠션글 전용 메뉴 (발행된 목적지글 → 쿠션 계정별 각기 다른 유입글) =====
let _cushDests = [];
async function renderCushion() {
  try { accounts = await apiJson("/api/accounts").then((j) => j.accounts || []); } catch { accounts = []; }
  let items = [];
  try { items = await apiJson("/api/work?status=published").then((j) => j.items || []); } catch {}
  const amap = accById();
  _cushDests = items.filter((w) => isDestRole(amap[w.destination_id] || {}) && (w.published_url || w.published_id));
  const sel = $("cushSrcSelect");
  if (!_cushDests.length) { sel.innerHTML = '<option value="">발행된 목적지글이 없습니다 (먼저 목적지글을 발행하세요)</option>'; }
  else { sel.innerHTML = '<option value="">— 발행된 목적지글 선택 —</option>' + _cushDests.map((w) => { const acc = amap[w.destination_id] || {}; return `<option value="${w.id}">${escapeHtml((w.title || "(제목없음)").slice(0, 50))} · ${escapeHtml(acc.name || PLAT_LABEL[w.target] || w.target)}</option>`; }).join(""); }
  $("cushSrcInfo").classList.add("hidden");
  renderCushAccPicker();
}
function renderCushAccPicker() {
  const box = $("cushAccPicker"); if (!box) return;
  const prev = {}; box.querySelectorAll("input").forEach((i) => { prev[i.value] = i.checked; });
  const had = Object.keys(prev).length > 0;
  const list = accounts.filter(isCushForMode);
  box.innerHTML = "";
  if (!list.length) { box.innerHTML = `<span class="muted">쿠션 계정(블로거/네이버)이 없습니다. '계정 관리'에서 추가하세요.</span>`; return; }
  for (const a of list) {
    const checked = had ? (prev[a.id] !== false) : true;
    const lab = document.createElement("label"); lab.className = "acc-pick";
    lab.innerHTML = `<input type="checkbox" value="${a.id}" ${checked ? "checked" : ""}><span class="acc-badge cush">${PLAT_LABEL[a.platform] || a.platform}</span><span class="nm">${escapeHtml(a.name || "(이름없음)")}</span>`;
    box.appendChild(lab);
  }
}
function onCushSrcChange() {
  const w = _cushDests.find((x) => x.id === $("cushSrcSelect").value);
  const info = $("cushSrcInfo");
  if (!w) { info.classList.add("hidden"); return; }
  const acc = accById()[w.destination_id] || {};
  info.classList.remove("hidden");
  info.innerHTML = `<b>${escapeHtml(w.title || "")}</b> <span class="di-plat">${escapeHtml(acc.name || "")}</span>` + (w.published_url ? ` <a href="${w.published_url}" target="_blank" rel="noopener" class="di-link">글 보기</a>` : "");
}
function buildCushionForAccount(acc, sourceText, keyword, destUrl, variant) {
  const v = { ...(variant || {}), style: accountStyle(acc).vibe, persona: acc.persona || "" };
  const ov = acc.overrides || {};
  const common = { keyword, audience: ov.audience || settings.defaultAudience, tone: ov.tone || settings.defaultTone, authorBio: ov.authorBio || settings.authorBio, today: todayStr(), imageCount: parseInt($("imgCount").value, 10) || 1, variant: v, reference: `[유입 목적지 글 요약]\n${(sourceText || "").slice(0, 1500)}` };
  return buildCushionPrompt(acc.platform === "naver" ? "naver" : "blogger", { ...common, sourceText, bloggerUrl: destUrl });
}
async function generateCushions() {
  if (!$("cushSrcSelect").value) { setStatus("유입시킬 목적지글을 선택하세요.", true); return; }
  const ids = new Set([...document.querySelectorAll("#cushAccPicker input:checked")].map((i) => i.value));
  const chosen = accounts.filter((a) => ids.has(String(a.id)) && isCushForMode(a));
  if (!chosen.length) { setStatus("쿠션 계정을 하나 이상 체크하세요.", true); return; }
  let dest; try { dest = await apiJson("/api/work/" + encodeURIComponent($("cushSrcSelect").value)); } catch { setStatus("목적지글을 불러오지 못했습니다.", true); return; }
  const destUrl = dest.published_url || "";
  const sourceText = ((dest.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || (dest.article?.blocks || []).map((b) => b.text || "").join(" ")).slice(0, 6000);
  const keyword = dest.article?.keyword || dest.title || "";
  const prevMode = genMode; genMode = "cushion";
  $("cushGenBtn").disabled = true; genAborted = false;
  openProgress("쿠션글 생성");
  progressLog(`목적지: ${dest.title || ""} → 쿠션 ${chosen.length}개`, "done");
  try {
    await gatherRelatedLinks(keyword);
    const groups = {}; chosen.forEach((a) => { (groups[a.platform] = groups[a.platform] || []).push(a); });
    const idxIn = {}; let done = 0, ok = 0; const total = chosen.length;
    for (const acc of chosen) {
      if (genAborted) break;
      idxIn[acc.platform] = (idxIn[acc.platform] || 0) + 1;
      const variant = { index: idxIn[acc.platform], total: groups[acc.platform].length };
      progressStep(`[${acc.name}] 쿠션 작성 중… (${done + 1}/${total})`, 8 + Math.round(done / total * 88));
      let article;
      try { article = await chatArticle(buildCushionForAccount(acc, sourceText, keyword, destUrl, variant)); }
      catch (e) { if (genAborted) break; progressLog(`✗ ${acc.name} 실패: ${e.message}`, "error"); done++; continue; }
      const html = await finalizeForAccount(acc, article, keyword, destUrl);
      await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ draft_id: dest.draft_id || null, target: acc.platform, destination_id: acc.id, title: article.title || "", article, html, status: "generated", role: "cushion" }) }).catch(() => {});
      ok++; done++; progressLog(`✓ ${acc.name} 쿠션 생성됨`, "done");
    }
    progressDone(true, `쿠션 ${ok}개 생성 완료 — 작업보드에서 검토·발행하세요.`);
    setStatus(`✅ 쿠션 ${ok}개 생성됨.`);
  } catch (e) { progressDone(false, "쿠션 생성 실패: " + e.message); }
  finally { genMode = prevMode; $("cushGenBtn").disabled = false; }
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
    genPrompt = `${thumbStyle}\n\nScene: ${b.prompt || keyword}\n\nIntegrate this EXACT Korean headline into the image, HUGE and perfectly spelled: "${headline}". You are FREE to choose its position, font, color, style and layout so it best matches the mood/scene — not confined to any fixed area. Keep strong contrast against the background, do NOT crop/cut off any letters, and make it clearly legible even as a tiny mobile thumbnail. No broken/garbled letters.\n\nComposition: strong subject-vs-background pop (glow/rim light, shallow DOF), high-contrast punchy but CLEAN. If a real person is central show ONLY ONE person with clear emotion; otherwise a bold symbolic scene with NO random people. NO cartoon mascot, NO clip-art graphs/arrows/flags/finance icons, NO messy collage.`;
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
// AI 자연어 수정 — 현재 글 JSON을 통째로 넘겨 요청대로 고친 뒤 되받아 반영(이미지 등 기존 필드 보존)
async function aiEditArticle() {
  if (!cur || !cur.article) { setStatus("먼저 작업(글)을 선택하세요.", true); return; }
  const instr = $("aiEditInput").value.trim();
  if (!instr) { setStatus("수정 요청을 입력하세요.", true); return; }
  const btn = $("aiEditBtn"); btn.disabled = true;
  setStatus("AI가 글을 수정하는 중… (최대 1~2분)");
  const system = "너는 한국어 블로그 글 편집기다. 주어진 기사 JSON을 사용자의 수정 요청대로 고쳐서 '완전한 JSON 하나'만 반환한다. 규칙: (1) 스키마/필드 구조를 그대로 유지한다. (2) 수정 요청과 무관한 부분은 절대 바꾸지 않는다. (3) 이미지 블록의 resolvedUrl·_genPrompt 등 기존 값은 그대로 보존한다. (4) 'FAQ 완성' 같은 요청이면 비어있는 q/a를 실제 내용으로 채운다. (5) 코드펜스/설명/주석 없이 JSON 객체 하나만 출력한다.";
  const user = `[수정 요청]\n${instr}\n\n[현재 기사 JSON]\n${JSON.stringify(cur.article)}`;
  try {
    let content = await chatComplete({ engine: settings.genEngine, model: settings.kieChatModel, system, user, maxTokens: 16000 });
    let edited = tryParse(content);
    if (!edited) { content = await chatComplete({ engine: settings.genEngine, model: settings.kieChatModel, system, user: user + "\n\n(위 형식의 JSON 객체 하나로만, 끊기지 않게 완결해서 출력해줘.)", maxTokens: 16000 }); edited = tryParse(content); }
    if (!edited || !Array.isArray(edited.blocks)) throw new Error("AI 응답을 해석하지 못했어요. 다시 시도해 주세요.");
    // 이미지 resolvedUrl 등 기존 필드 순서 매칭으로 보존(모델이 빠뜨려도 유지)
    const oldImgs = (cur.article.blocks || []).filter((b) => b.type === "image");
    const newImgs = (edited.blocks || []).filter((b) => b.type === "image");
    newImgs.forEach((nb, i) => { const ob = oldImgs[i]; if (ob) ["resolvedUrl", "_genPrompt", "_aspect", "_isThumb", "_headline", "credit", "creditUrl"].forEach((k) => { if (nb[k] == null && ob[k] != null) nb[k] = ob[k]; }); });
    edited.today = cur.article.today || edited.today;
    edited.keyword = cur.article.keyword || edited.keyword;
    if (cur.article.authorBio && !edited.authorBio) edited.authorBio = cur.article.authorBio;
    cur.article = edited;
    rebuildCur(); await saveCur(); renderCur(); if (editMode) renderEditor();
    $("aiEditInput").value = "";
    setStatus("✅ AI 수정 완료. 미리보기를 확인하고, 발행된 글이면 '수정 발행'을 누르세요.");
  } catch (e) { setStatus("AI 수정 실패: " + e.message, true); }
  finally { btn.disabled = false; }
}
// 이미 발행된 글을 편집 후 원격에 '수정 발행'(업데이트)
async function updatePublish() {
  if (!cur || (!cur.published_id && !cur.published_url)) return;
  // 수정 발행 = 최종 업데이트 날짜를 오늘(수정일)로 갱신. 최초 발행일(datePublished)은 유지.
  if (cur.article) { cur.article.today = todayStr(); if (!cur.article.datePublished) cur.article.datePublished = cur.article.today; }
  if (editMode) toggleEdit(); else rebuildCur();
  try {
    setStatus("수정 발행(업데이트) 중…");
    const body = { destinationId: cur.acc.id, postId: cur.published_id || undefined, postUrl: cur.published_url || undefined, title: cur.article.title, content: cur.html };
    const res = cur.target === "wordpress"
      ? await wpCreatePost({ ...body, category: cur.article.category })
      : await apiJson("/api/blogger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, labels: articleLabels(cur.article) }) });
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

// 실패한 목적지 글 재생성(그 초안×목적지만 다시 생성)
async function doRegenerate(id, rerender) {
  setStatus("↻ 재생성 중… (Sonnet5 → 실패 시 Gemini 폴백). 잠시만요.");
  try {
    const r = await apiJson("/api/work/regenerate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setStatus(r && r.ok ? "✅ 재생성 완료. 작업보드에서 확인 후 발행하세요." : ("재생성 실패: " + (r?.error || "")), !(r && r.ok));
  } catch (e) { setStatus("재생성 실패: " + String(e?.message || e), true); }
  if (typeof rerender === "function") rerender();
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
      + (w.publish_at ? `<span class="pubm" style="background:var(--accent-soft);color:var(--accent-dark);"><iconify-icon icon="solar:clock-circle-linear"></iconify-icon> ${fmtRunAt(w.publish_at)} 예약</span>` : (w.status === "failed" ? `<span class="df" style="background:#fee2e2;color:#b91c1c;" title="${escapeHtml(w.note || "생성 실패")}">⚠ 생성 실패</span>` : `<span class="df">${w.status === "generated" ? "생성됨" : w.status}</span>`));
    if (w.status === "failed") {
      const rg = document.createElement("button"); rg.className = "mini"; rg.textContent = "↻ 재생성"; rg.addEventListener("click", () => doRegenerate(w.id, renderWorkList));
      row.appendChild(rg);
    } else {
      const open = document.createElement("button"); open.className = "mini"; open.textContent = "열기"; open.addEventListener("click", () => openWork(w.id));
      row.appendChild(open);
    }
    const del = document.createElement("button"); del.className = "hist-del"; del.textContent = "✕";
    del.title = "이 작업 삭제(발행 안 함)";
    del.addEventListener("click", async () => { if (!confirm(`'${w.title || "이 글"}'\n이 작업을 삭제할까요? (발행하지 않고 제거)`)) return; await apiJson("/api/work/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: w.id }) }).catch(() => {}); if (cur && cur.id === w.id) { cur = null; $("workDetail").style.display = "none"; } renderWorkList(); });
    row.appendChild(del); box.appendChild(row);
  }
}
// ---------- 초안별 결과물(묶음 보기) ----------
async function renderByDraft() {
  const box = $("byDraftList");
  box.innerHTML = '<div class="hist-empty">불러오는 중…</div>';
  let data;
  try { data = await apiJson("/api/by-draft"); } catch { box.innerHTML = '<div class="hist-empty">불러오기 실패</div>'; return; }
  const items = data.items || [], drafts = data.drafts || {};
  const amap = accById();
  const groups = new Map();
  for (const w of items) { const key = w.draft_id || "__none__"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(w); }
  if (!groups.size) { box.innerHTML = '<div class="hist-empty">아직 생성된 글이 없습니다. 초안이 자동 처리되면 여기 묶여서 보입니다.</div>'; return; }
  const kstDay = (d) => { try { return new Date(d).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); } catch { return ""; } };
  const kstDT = (d) => { try { return new Date(d).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }); } catch { return ""; } };
  const groupMs = (key, ws) => { if (key !== "__none__" && drafts[key] && drafts[key].date) { const t = Date.parse(drafts[key].date); if (!isNaN(t)) return t; } return Math.max(0, ...ws.map((x) => Date.parse(x.updated_at || 0) || 0)); };
  const order = [...groups.entries()].sort((a, b) => groupMs(b[0], b[1]) - groupMs(a[0], a[1]));
  const today = kstDay(Date.now());
  const statusLabel = { generated: "생성됨", published: "발행됨" };
  function buildCard(key, ws) {
    const d = drafts[key];
    const title = key === "__none__" ? "직접 생성(초안 없음)" : (d ? (d.title || d.keyword || key) : "삭제된 초안");
    const pubCount = ws.filter((w) => w.status === "published").length;
    const failCount = ws.filter((w) => w.status === "failed").length;
    const gm = groupMs(key, ws);
    const dLabel = gm ? (key === "__none__" ? "최근 " : "초안 ") + kstDT(gm) : "";
    const card = document.createElement("div"); card.className = "card bydraft-group";
    card.innerHTML = `<div class="bydraft-head"><iconify-icon icon="solar:inbox-line-linear"></iconify-icon> <b>${escapeHtml(title)}</b> <span class="muted">${dLabel ? "· " + dLabel + " " : ""}· 글 ${ws.length}개${pubCount ? ` · 발행 ${pubCount}` : ""}${failCount ? ` · <span style="color:#b91c1c;font-weight:600;">실패 ${failCount}</span>` : ""}</span></div>`;
    const list = document.createElement("div"); list.className = "acc-list";
    for (const w of ws) {
      const acc = amap[w.destination_id] || { platform: w.target };
      const dest = isDestRole(acc);
      const isFail = w.status === "failed";
      const badge = w.status === "published" ? `<span class="pubm" style="background:#e7f7ec;color:#137a3e;">발행됨</span>` : (w.publish_at ? `<span class="pubm" style="background:var(--accent-soft);color:var(--accent-dark);"><iconify-icon icon="solar:clock-circle-linear"></iconify-icon> ${fmtRunAt(w.publish_at)}</span>` : (isFail ? `<span class="df" style="background:#fee2e2;color:#b91c1c;" title="${escapeHtml(w.note || "생성 실패")}">⚠ 생성 실패</span>` : `<span class="df">${statusLabel[w.status] || w.status}</span>`));
      const row = document.createElement("div"); row.className = "acc-row";
      row.innerHTML = `<span class="acc-badge ${dest ? "dest" : "cush"}">${dest ? "목적지" : "쿠션"}</span>`
        + `<span class="acc-plat">${PLAT_LABEL[w.target] || w.target}${acc.name ? " · " + escapeHtml(acc.name) : ""}</span>`
        + `<span class="nm">${escapeHtml(w.title || "(제목없음)")}</span>` + badge;
      if (isFail) {
        const rg = document.createElement("button"); rg.className = "mini"; rg.textContent = "↻ 재생성"; rg.addEventListener("click", () => doRegenerate(w.id, renderByDraft));
        row.appendChild(rg);
      } else {
        const open = document.createElement("button"); open.className = "mini"; open.textContent = "열기·편집"; open.addEventListener("click", () => { showView("board"); openWork(w.id); });
        row.appendChild(open);
      }
      if (w.published_url) { const a = document.createElement("a"); a.className = "mini"; a.href = w.published_url; a.target = "_blank"; a.rel = "noopener"; a.textContent = "블로그 보기"; row.appendChild(a); }
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }
  box.innerHTML = "";
  const todayGroups = order.filter(([key]) => key !== "__none__" && drafts[key] && kstDay(drafts[key].date) === today);
  const th = document.createElement("div"); th.className = "view-head"; th.style.marginTop = "2px";
  th.innerHTML = `<h3 style="margin:0;font-size:1rem;">📅 오늘 생성된 초안 <span class="muted" style="font-weight:400;">· ${todayGroups.length}건</span></h3>`;
  box.appendChild(th);
  if (!todayGroups.length) { const e = document.createElement("div"); e.className = "hist-empty"; e.textContent = "오늘 생성된 초안이 없습니다."; box.appendChild(e); }
  else for (const [key, ws] of todayGroups) box.appendChild(buildCard(key, ws));
  const ah = document.createElement("div"); ah.className = "view-head"; ah.style.marginTop = "20px";
  ah.innerHTML = `<h3 style="margin:0;font-size:1rem;">🗂 전체 초안별 결과물 <span class="muted" style="font-weight:400;">· ${order.length}건</span></h3>`;
  box.appendChild(ah);
  for (const [key, ws] of order) box.appendChild(buildCard(key, ws));
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
  const cnt = { manual: 0, auto: 0, scheduled: 0, other: 0 };
  for (const w of _history) { const m = w.publish_mode; if (m === "manual") cnt.manual++; else if (m === "auto") cnt.auto++; else if (m === "scheduled") cnt.scheduled++; else cnt.other++; }
  $("historyCount").textContent = `— 총 ${_history.length}건 (수동 ${cnt.manual} · 자동 ${cnt.auto} · 예약 ${cnt.scheduled}${cnt.other ? ` · 기타 ${cnt.other}` : ""})${items.length !== _history.length ? ` · 표시 ${items.length}건` : ""}`;
  box.innerHTML = "";
  if (!items.length) { box.innerHTML = '<div class="hist-empty">해당 조건의 발행 글이 없습니다.</div>'; return; }
  // 일자별 갯수(표시 대상 기준). items 는 updated_at DESC 정렬이라 최신 날짜부터 그룹핑된다.
  const dayCnt = {}; for (const w of items) { const k = dayKey(w.updated_at); dayCnt[k] = (dayCnt[k] || 0) + 1; }
  let _lastDay = null;
  for (const w of items) {
    const acc = amap[w.destination_id] || { platform: w.target };
    const dstr = fmtDateTime(w.updated_at);
    const _day = dayKey(w.updated_at);
    if (_day !== _lastDay) {
      _lastDay = _day;
      const h = document.createElement("div"); h.className = "hist-date";
      h.innerHTML = `<span class="hist-date-label"><iconify-icon icon="solar:calendar-linear"></iconify-icon> ${_day}</span><span class="hist-date-cnt">${dayCnt[_day]}건</span>`;
      box.appendChild(h);
    }
    const mode = w.publish_mode === "scheduled" ? `<span class="pubm auto">예약발행</span>` : w.publish_mode === "auto" ? `<span class="pubm auto">자동발행</span>` : (w.publish_mode === "manual" ? `<span class="pubm manual">수동발행</span>` : `<span class="pubm">발행됨</span>`);
    const row = document.createElement("div"); row.className = "acc-row";
    row.innerHTML = `${mode}`
      + `<span class="acc-plat">${PLAT_LABEL[w.target] || w.target}${acc.name ? " · " + acc.name : ""}</span>`
      + `<span class="nm">${escapeHtml(w.title || "(제목없음)")}</span>`
      + `<span class="df an-date" style="color:var(--muted)">${dstr}</span>`;
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
// 발행 대상(목적지) 변경 — 자동 매칭이 니치와 안 맞을 때 직접 다른 블로그로 바꿔 발행
async function changeDest(destId) {
  if (!cur || !destId) return;
  const acc = accById()[destId];
  if (!acc) { setStatus("선택한 목적지를 찾을 수 없습니다.", true); return; }
  cur.acc = acc; cur.target = acc.platform;
  try {
    await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: acc.platform, destination_id: destId, title: cur.article.title || "", status: cur.status || "generated" }) });
  } catch (e) { setStatus("목적지 변경 저장 실패: " + String(e?.message || e), true); }
  renderCur();
  setStatus(`🎯 발행 대상을 '${acc.name || PLAT_LABEL[acc.platform] || acc.platform}'(으)로 변경했습니다. 이제 발행하세요.`);
}
function renderCur() {
  if (!cur) return;
  $("metaLine").textContent = `[${cur.acc.name || PLAT_LABEL[cur.target] || cur.target}] ${cur.article.title || ""}` + (cur.resolvedType ? ` · 유형:${cur.resolvedType}` : "") + (cur.article.category ? ` · 카테고리:${cur.article.category}` : "") + `\n메타: ${cur.article.metaDescription || "-"}`;
  $("preview").srcdoc = buildPreviewDoc(cur.article.title || "", cur.html);
  const published = cur.status === "published";
  const autoPlat = cur.target === "wordpress" || cur.target === "blogger";
  const canUpdate = published && (cur.published_id || cur.published_url) && autoPlat;
  // 목적지 안내 배지: 어느 블로그/플랫폼으로 나가는지 + 상태
  const platLabel = PLAT_LABEL[cur.target] || cur.target;
  const roleLabel = isDestRole(cur.acc) ? "목적지" : "쿠션";
  let dest = `<b>${escapeHtml(cur.acc.name || platLabel)}</b> <span class="di-plat">${roleLabel} · ${platLabel}</span>`;
  if (published) dest += cur.published_url ? ` <a href="${cur.published_url}" target="_blank" rel="noopener" class="di-link">발행됨 → 글 보기</a>` : ` <span class="di-ok">발행됨</span>`;
  else if (cur.publish_at) dest += ` <span class="di-sched">${fmtRunAt(cur.publish_at)} 예약</span>`;
  else dest += autoPlat ? ` <span class="di-wait">발행 대기</span>` : ` <span class="di-wait">수동 발행 대상</span>`;
  // 발행 대상 / 카테고리 — 정렬된 컨트롤 블록
  let controls = "";
  if (!published) {
    const dList = (accounts || []).filter((a) => isDestRole(a));
    const inList = dList.some((a) => a.id === cur.acc.id);
    if (dList.length) {
      const optsH = (inList ? "" : `<option value="${escapeHtml(cur.acc.id || "")}" selected>${escapeHtml(cur.acc.name || platLabel)} (현재)</option>`)
        + dList.map((a) => `<option value="${a.id}" ${a.id === cur.acc.id ? "selected" : ""}>${escapeHtml(a.name || PLAT_LABEL[a.platform] || a.platform)} · ${PLAT_LABEL[a.platform] || a.platform}</option>`).join("");
      controls += `<div class="wd-ctl-row"><span class="wd-ctl-label">🎯 발행 대상</span><select id="destPick" class="wd-ctl-select">${optsH}</select><span class="wd-ctl-hint">니치가 안 맞으면 바꿔 발행</span></div>`;
    }
  }
  if (cur.target === "wordpress") {
    const catHint = published ? "바꾼 뒤 <b>‘수정 발행’</b> 클릭 시 반영" : "자동 선택됨 — 아닌 것만 변경";
    controls += `<div class="wd-ctl-row"><span class="wd-ctl-label">🗂 카테고리</span><select id="catPick" class="wd-ctl-select"><option selected>${escapeHtml(cur.article.category || "(자동)")}</option></select><span class="wd-ctl-hint">${catHint}</span></div>`;
  }
  if (controls) dest += `<div class="wd-controls">${controls}</div>`;
  $("destInfo").innerHTML = dest;
  const _pick = $("destPick");
  if (_pick) _pick.addEventListener("change", () => changeDest(_pick.value));
  const _cat = $("catPick");
  if (_cat) {
    apiJson("/api/wp-categories?destinationId=" + encodeURIComponent(cur.acc.id || "")).then((r) => {
      const tree = (r && r.tree) || [];
      const names = (r && r.categories) || [];
      const curVal = cur.article.category || "";
      // 계층(부모→자식 들여쓰기)로 표시. option value는 순수 카테고리명(발행 시 그대로 매칭)
      let items = tree.length
        ? tree.map((t) => ({ name: t.name, label: (t.depth ? " ".repeat(t.depth) + "└ " : "") + t.name }))
        : names.map((n) => ({ name: n, label: n }));
      if (curVal && !items.some((i) => i.name === curVal)) items = [{ name: curVal, label: curVal }, ...items];
      if (!items.length) items = [{ name: curVal || "(자동)", label: curVal || "(자동)" }];
      _cat.innerHTML = items.map((i) => `<option value="${escapeHtml(i.name)}" ${i.name === curVal ? "selected" : ""}>${escapeHtml(i.label)}</option>`).join("");
    }).catch(() => {});
    _cat.addEventListener("change", () => {
      cur.article.category = _cat.value;
      $("metaLine").textContent = `[${cur.acc.name || PLAT_LABEL[cur.target] || cur.target}] ${cur.article.title || ""}` + (cur.resolvedType ? ` · 유형:${cur.resolvedType}` : "") + (cur.article.category ? ` · 카테고리:${cur.article.category}` : "") + `\n메타: ${cur.article.metaDescription || "-"}`;
      saveCur();
      setStatus("🗂 카테고리를 '" + _cat.value + "'(으)로 지정했습니다.");
    });
  }
  // 미발행: '발행'(WP·블로거 자동) / '저장(수동발행)'. 발행됨: '수정 발행' + '현재본 불러오기'
  $("publishBtn").classList.toggle("hidden", published || !autoPlat);
  $("markPublishedBtn").classList.toggle("hidden", published);
  $("updatePublishBtn").classList.toggle("hidden", !canUpdate);
  $("pullLiveBtn").classList.toggle("hidden", !canUpdate);
  // 예약 발행: 미발행 + WP·블로거만
  const canAuto = !published && autoPlat;
  $("schedPubRow").classList.toggle("hidden", !canAuto);
  if (canAuto) {
    $("schedPubAt").value = cur.publish_at ? toLocalInput(cur.publish_at) : "";
    const set = !!cur.publish_at;
    $("schedPubState").textContent = set ? `예약됨: ${fmtRunAt(cur.publish_at)}` : "";
    $("schedPubClear").classList.toggle("hidden", !set);
  }
  $("preview").classList.toggle("hidden", editMode);
  $("editor").classList.toggle("hidden", !editMode);
  renderImageEditors();
  if (editMode) renderEditor();
}
function rebuildCur() { if (cur) cur.html = buildHtmlForAccount(cur.acc, cur.article, cur.keyword, destUrlForGen()); }
// 블로거 라벨 = 글 내용 기반. 태그(콘텐츠 키워드)를 우선하고, 태그가 없을 때만 카테고리로 폴백.
// (카테고리는 워드프레스 분류용이라 부정확할 수 있어 라벨로는 태그가 더 정확하다.)
function articleLabels(article) {
  if (!article) return [];
  let out = Array.isArray(article.tags) ? article.tags.map((t) => String(t || "").trim()).filter(Boolean) : [];
  if (!out.length && article.category) out = [String(article.category).trim()].filter(Boolean);
  return [...new Set(out)].slice(0, 8);
}
// 발행/수정 시점에 "최종 업데이트" 날짜를 실제 발행일로 스탬프하고 HTML 재조립.
// datePublished(최초 발행일)는 한 번만 세팅되고, today(=최종 업데이트/수정일)는 매 발행·수정마다 갱신된다.
function stampPublishDate() {
  if (!cur || !cur.article) return;
  cur.article.today = todayStr();
  if (!cur.article.datePublished) cur.article.datePublished = cur.article.today;
  rebuildCur();
}
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
const ED_TYPE = { paragraph: "문단", heading: "제목", list: "리스트", table: "표", callout: "박스", cta: "버튼", linkcard: "링크카드", image: "이미지", youtube: "영상", spacer: "빈줄" };
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
  const blocks = cur.article.blocks || [];
  const thumbBlock = blocks.find((b) => b.type === "image" && b.slot === "thumbnail");
  // 최상단 썸네일 존 — 없으면 추가, 있으면 미리보기+교체 (클릭/붙여넣기/드래그)
  article.appendChild(thumbZone(thumbBlock));
  // 제목
  const h1 = document.createElement("h1"); h1.className = "ied-h1"; h1.contentEditable = "true"; h1.spellcheck = false; h1.textContent = cur.article.title || "";
  h1.addEventListener("blur", () => { cur.article.title = h1.innerText.trim(); refreshAfterEditLive(); });
  article.appendChild(h1);
  article.appendChild(insertBar(0));
  blocks.forEach((b, i) => { if (b === thumbBlock) return; article.appendChild(blockRow(b, i)); article.appendChild(insertBar(i + 1)); });

  // FAQ 편집 — 하단에 자동 렌더되는 faq 배열을 여기서 직접 수정(편집 중에도 보이게)
  if (!Array.isArray(cur.article.faq)) cur.article.faq = [];
  const faqSec = document.createElement("div"); faqSec.style.cssText = "margin-top:1.6em;border-top:1px dashed #d4d4d8;padding-top:1em;";
  const faqTitle = document.createElement("div"); faqTitle.textContent = "자주 묻는 질문 (FAQ)"; faqTitle.style.cssText = "font-weight:800;font-size:1.15em;margin-bottom:.6em;color:#18181b;";
  faqSec.appendChild(faqTitle);
  const faqList = document.createElement("div");
  const renderFaqRows = () => {
    faqList.innerHTML = "";
    cur.article.faq.forEach((f, i) => {
      const row = document.createElement("div"); row.style.cssText = "border:1px solid #e4e4e7;border-radius:10px;padding:10px 12px;margin-bottom:8px;background:#fafafa;";
      const q = document.createElement("div"); q.contentEditable = "true"; q.spellcheck = false; q.textContent = f.q || ""; q.style.cssText = "font-weight:700;outline:none;margin-bottom:4px;min-height:1.2em;";
      q.addEventListener("blur", () => { cur.article.faq[i].q = q.innerText.trim(); refreshAfterEditLive(); });
      const a = document.createElement("div"); a.contentEditable = "true"; a.spellcheck = false; a.textContent = f.a || ""; a.style.cssText = "outline:none;color:#333;min-height:1.2em;";
      a.addEventListener("blur", () => { cur.article.faq[i].a = a.innerText.trim(); refreshAfterEditLive(); });
      const del = document.createElement("button"); del.type = "button"; del.textContent = "삭제"; del.className = "mini"; del.style.cssText = "margin-top:6px;font-size:12px;";
      del.addEventListener("click", () => { cur.article.faq.splice(i, 1); renderFaqRows(); refreshAfterEditLive(); });
      row.appendChild(q); row.appendChild(a); row.appendChild(del); faqList.appendChild(row);
    });
    if (!cur.article.faq.length) { const e = document.createElement("div"); e.textContent = "FAQ 항목이 없습니다. 아래 버튼으로 추가하세요."; e.style.cssText = "color:#a1a1aa;font-size:13px;margin-bottom:8px;"; faqList.appendChild(e); }
  };
  renderFaqRows();
  const addBtn = document.createElement("button"); addBtn.type = "button"; addBtn.className = "mini"; addBtn.textContent = "＋ FAQ 항목 추가";
  addBtn.addEventListener("click", () => { cur.article.faq.push({ q: "", a: "" }); renderFaqRows(); refreshAfterEditLive(); });
  faqSec.appendChild(faqList); faqSec.appendChild(addBtn);
  article.appendChild(faqSec);
}
// 편집기용 이미지 업로드(WP=미디어 업로드 / 그 외=데이터URL). insertDroppedImage와 동일 경로.
async function uploadEditorImage({ file, url }) {
  if (cur.acc.platform === "wordpress") {
    const body = file ? { destinationId: cur.acc.id, dataUrl: await fileToDataUrl(file) } : { destinationId: cur.acc.id, imageUrl: url };
    const r = await apiJson("/api/wp-media", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return r.url;
  }
  if (file) return await fileToDataUrl(file);
  return url || "";
}
// 썸네일 설정/교체 — 파일/URL을 업로드해 thumbnail 슬롯 블록에 반영(없으면 맨 앞에 생성)
async function setThumbImage({ file, url }) {
  if (!cur) return;
  setStatus("썸네일 설정 중…");
  try {
    const finalUrl = await uploadEditorImage({ file, url });
    if (!finalUrl) { setStatus("이미지 URL을 가져오지 못했어요.", true); return; }
    const blocks = cur.article.blocks || (cur.article.blocks = []);
    let tb = blocks.find((b) => b.type === "image" && b.slot === "thumbnail");
    if (tb) { tb.resolvedUrl = finalUrl; delete tb._genPrompt; delete tb.prompt; }
    else { blocks.unshift({ type: "image", slot: "thumbnail", resolvedUrl: finalUrl, alt: cur.article.title || "" }); }
    refreshAfterEdit();   // 편집기·미리보기 재렌더 + 저장
    setStatus("✅ 썸네일을 설정했어요.");
  } catch (e) { setStatus("썸네일 설정 실패: " + e.message, true); }
}
// 썸네일 AI 생성 — 원래 생성됐어야 할 프롬프트(_genPrompt/prompt)로 재생성. 블록이 없으면 제목·키워드로 합성.
async function aiGenThumb(tb) {
  if (!config.kieEnabled) { setStatus("KIE 키가 필요합니다(설정에서 입력).", true); return; }
  let block = tb;
  if (!block) {
    block = { type: "image", slot: "thumbnail", prompt: cur.keyword || cur.article.title || "", overlayText: cur.article.title || cur.keyword || "", _isThumb: true, _headline: cur.article.title || cur.keyword || "", _aspect: aspectFor(cur.acc) };
    cur.article.blocks = cur.article.blocks || [];
    cur.article.blocks.unshift(block);
  } else {
    block._isThumb = true;
    if (!block._headline) block._headline = block.overlayText || cur.article.title || cur.keyword || "";
    if (!block._aspect) block._aspect = aspectFor(cur.acc);
  }
  await regenImage(block, "");
}
// 최상단 썸네일 존 (클릭·붙여넣기·드래그)
function thumbZone(tb) {
  const wrap = document.createElement("div"); wrap.className = "ied-thumbzone"; wrap.style.cssText = "margin:0 0 14px;";
  const lbl = document.createElement("div"); lbl.textContent = "🖼️ 썸네일 이미지"; lbl.style.cssText = "font-size:12px;font-weight:700;color:#52525b;margin-bottom:6px;"; wrap.appendChild(lbl);
  const hasUrl = !!(tb && tb.resolvedUrl);
  const zone = document.createElement("div"); zone.tabIndex = 0;
  zone.style.cssText = "border:2px dashed #cbd5e1;border-radius:12px;padding:" + (hasUrl ? "6px" : "22px 14px") + ";text-align:center;cursor:pointer;background:#fafafa;outline:none;transition:border-color .2s,background .2s;";
  const hint = hasUrl ? "여기 클릭 후 <b>Ctrl+V</b> · <b>드래그</b> · <b>파일 선택</b>으로 교체" : "썸네일 추가 — 여기 클릭 후 <b>Ctrl+V 붙여넣기</b> · <b>드래그</b> · <b>파일 선택</b>";
  zone.innerHTML = (hasUrl
      ? `<img src="${escapeHtml(tb.resolvedUrl)}" style="max-width:100%;max-height:220px;border-radius:8px;display:block;margin:0 auto;">`
      : `<iconify-icon icon="solar:gallery-add-bold" style="font-size:30px;color:#94a3b8;"></iconify-icon>`)
    + `<div style="font-size:12.5px;color:#64748b;margin-top:6px;">${hint} <button type="button" class="mini tz-file" style="margin-left:6px;">📁 파일 선택</button></div>`;
  const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
  fileInput.addEventListener("change", () => { const f = fileInput.files && fileInput.files[0]; if (f) setThumbImage({ file: f }); });
  // 존 클릭 → 포커스(붙여넣기 활성). '파일 선택' 버튼만 파일창.
  zone.addEventListener("click", (e) => { if (e.target.closest(".tz-file")) { e.stopPropagation(); fileInput.click(); return; } zone.focus(); });
  const on = () => { zone.style.borderColor = "#6366f1"; zone.style.background = "#eef2ff"; };
  const off = () => { zone.style.borderColor = "#cbd5e1"; zone.style.background = "#fafafa"; };
  zone.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); on(); });
  zone.addEventListener("dragleave", (e) => { e.stopPropagation(); off(); });
  zone.addEventListener("drop", (e) => {
    e.preventDefault(); e.stopPropagation(); off();
    const dt = e.dataTransfer; const f = [...(dt.files || [])].find((x) => x.type.startsWith("image/")); const u = f ? null : extractDragUrl(dt);
    if (f || (u && /^https?:\/\//i.test(u))) setThumbImage({ file: f, url: u });
    else setStatus("이미지를 인식하지 못했어요. 이미지 파일이나 웹 이미지를 놓아 주세요.", true);
  });
  zone.addEventListener("paste", (e) => {
    const it = [...(e.clipboardData?.items || [])].find((x) => x.type.startsWith("image/"));
    if (it) { const f = it.getAsFile(); if (f) { e.preventDefault(); e.stopPropagation(); setThumbImage({ file: f }); } }
  });
  wrap.appendChild(zone); wrap.appendChild(fileInput);
  if (hasUrl) {
    const bar = document.createElement("div"); bar.style.cssText = "margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;";
    if (tb._genPrompt || tb.prompt) { const rg = document.createElement("button"); rg.className = "mini"; rg.textContent = "AI 다시생성"; rg.addEventListener("click", () => regenImage(tb, "")); bar.appendChild(rg); }
    const rm = document.createElement("button"); rm.className = "mini"; rm.textContent = "썸네일 제거"; rm.addEventListener("click", () => { if (confirm("썸네일을 제거할까요?")) { const bs = cur.article.blocks; const ix = bs.indexOf(tb); if (ix >= 0) bs.splice(ix, 1); refreshAfterEdit(); } }); bar.appendChild(rm);
    wrap.appendChild(bar);
  }
  // 썸네일 alt(검색 노출용, 비우면 AI 자동값)·출처·출처링크 — 인물 이미지 등 출처 필요할 때 검수에서 바로 입력
  if (hasUrl) {
    const meta = document.createElement("div"); meta.className = "ied-imgmeta"; meta.style.marginTop = "6px";
    const mk = (ph, val, set) => { const el = document.createElement("input"); el.placeholder = ph; el.value = val || ""; el.addEventListener("input", () => set(el.value)); el.addEventListener("blur", refreshAfterEditLive); return el; };
    meta.appendChild(mk("이미지 설명(alt) — 검색 노출용 (비우면 AI 자동)", tb.alt, (v) => (tb.alt = v)));
    meta.appendChild(mk("출처(선택) — 예: 사진: 연합뉴스", tb.credit, (v) => (tb.credit = v)));
    meta.appendChild(mk("출처 링크(선택) — https://...", tb.creditUrl, (v) => (tb.creditUrl = v)));
    wrap.appendChild(meta);
  }
  // 썸네일 없음 → AI로 생성(원래 프롬프트) 버튼
  if (!hasUrl) {
    const abar = document.createElement("div"); abar.style.cssText = "margin-top:8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const ai = document.createElement("button"); ai.className = "mini primary-mini";
    ai.innerHTML = `<iconify-icon icon="solar:magic-stick-3-linear"></iconify-icon> AI로 생성`;
    ai.title = (tb && (tb._genPrompt || tb.prompt)) ? "원래 썸네일 프롬프트로 생성" : "제목·키워드로 썸네일 생성";
    ai.addEventListener("click", async () => { ai.disabled = true; const t = ai.innerHTML; ai.innerHTML = "생성 중…"; try { await aiGenThumb(tb); } finally { ai.disabled = false; ai.innerHTML = t; } });
    abar.appendChild(ai);
    const hint = document.createElement("span"); hint.className = "muted"; hint.style.fontSize = "12px"; hint.textContent = "생성 실패한 썸네일을 원래 프롬프트로 다시 생성";
    abar.appendChild(hint);
    wrap.appendChild(abar);
  }
  return wrap;
}
function insertBar(index) {
  const bar = document.createElement("div"); bar.className = "ed-insert";
  const mk = (label, fn) => { const btn = document.createElement("button"); btn.textContent = label; btn.addEventListener("click", () => fn(index, bar)); return btn; };
  bar.appendChild(mk("+ 글", addTextAt)); bar.appendChild(mk("+ 버튼", addButtonAt)); bar.appendChild(mk("+ 이미지", addImageAt)); bar.appendChild(mk("+ 영상", addVideoAt)); bar.appendChild(mk("+ 빈줄", addSpacerAt));
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
  if (structural && b.type !== "image" && b.type !== "spacer") ctrl.appendChild(mkIconBtn("solar:pen-linear", "수정", () => openBlockEdit(b, i, row)));
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
  } else if (b.type === "spacer") {
    const el = document.createElement("div"); el.className = "ied-view";
    el.style.cssText = "border:1px dashed #d4d4d8;border-radius:8px;color:#a1a1aa;font-size:12px;text-align:center;padding:8px;background:repeating-linear-gradient(45deg,#fafafa,#fafafa 6px,#f4f4f5 6px,#f4f4f5 12px);";
    el.textContent = "— 빈 줄 (여백) —";
    row.appendChild(el);
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
function addSpacerAt(index) { cur.article.blocks.splice(index, 0, { type: "spacer", size: 28 }); refreshAfterEdit(); }
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
// KIE/외부 이미지(또는 data URL)를 워드프레스 미디어에 올려 영구 URL로 변환.
// 비-WP 목적지는 원본 그대로. (KIE 임시 URL은 미리보기에서 안 뜨거나 만료되므로 필수)
async function persistImageUrl(url) {
  if (!url || !cur || cur.acc.platform !== "wordpress") return url;
  try {
    const body = url.startsWith("data:") ? { destinationId: cur.acc.id, dataUrl: url } : { destinationId: cur.acc.id, imageUrl: url };
    const r = await apiJson("/api/wp-media", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (r && r.url) || url;
  } catch { return url; }
}
async function regenImage(b, instr) {
  if (!config.kieEnabled) { setStatus("KIE 키 필요", true); return; }
  // 썸네일 블록 감지: 런타임 메타(_isThumb)가 없어도 slot으로 판단(발행본 불러와 재편집 시 메타가 없음)
  const isThumbBlock = b._isThumb || b.slot === "thumbnail";
  let prompt;
  if (isThumbBlock && settings.thumbnailMode === "ai_full") {
    // 썸네일: 헤드라인 문구가 반드시 이미지에 들어가도록 풀 프롬프트를 재구성(발행본 재편집 포함)
    const hl = b._headline || b.overlayText || cur?.article?.title || cur?.keyword || "";
    const baseThumb = settings.thumbnailStylePrompt || DEFAULT_THUMB_STYLE;
    const accThumb = cur.acc.overrides && cur.acc.overrides.thumbStyle;
    const thumbStyle = baseThumb + (accThumb ? `\n[이 블로그 전용 스타일] ${accThumb}` : "");
    const scene = b.prompt || cur?.keyword || (cur?.article?.title || "").slice(0, 30);
    prompt = `${thumbStyle}\n\nScene: ${scene}\n\n이 한글 헤드라인 문구를 이미지에 크게 넣어라(정확한 맞춤법): "${hl}". 문구의 위치·폰트·색·스타일·레이아웃은 이미지 분위기에 가장 잘 어울리게 자유롭게 디자인하되, 글자가 잘리지 않고 배경과 또렷이 대비되어 작은 썸네일에서도 잘 읽히게. 깨진 글자 금지. 안전 규칙: 폭력·무기·유혈·시신·범죄 행위를 절대 묘사하지 말고 어둡고 진중한 상징적 분위기로만 표현. NO clip-art/arrows/flags, NO random extra people.`;
    if (instr) prompt += `\n\n추가 수정 요청: ${instr}`;
    b._isThumb = true; b._headline = hl;   // 메타 보강(다음 재생성 대비)
  } else {
    const base = b._genPrompt || b.prompt || (cur?.keyword || "");
    prompt = instr ? `${base}\n\n추가 수정 요청: ${instr}` : base;
  }
  const aspect = b._aspect || (isThumbBlock ? aspectFor(cur.acc) : "4:3");
  setStatus("이미지 다시 생성 중…");
  try {
    let url = await generateImage({ prompt, aspectRatio: aspect, resolution: safeResolution(aspect) });
    if (isThumbBlock && settings.thumbnailMode === "overlay") url = await composeThumbnail({ imageUrl: url, text: b._headline || cur.article.title, accent: settings.overlayAccent || "#ff2d55", aspect });
    setStatus("이미지 저장 중…");
    url = await persistImageUrl(url);   // WP 미디어에 올려 영구 URL로 (미리보기·발행에 안정 반영)
    b.resolvedUrl = url; b._genPrompt = prompt; b._aspect = aspect; refreshAfterEdit(); renderImageEditors(); setStatus("✅ 이미지 갱신됨");
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
    setStatus("이미지 저장 중…");
    url = await persistImageUrl(url);   // WP 미디어에 올려 영구 URL로
    b.resolvedUrl = url; refreshAfterEdit(); renderImageEditors(); setStatus("✅ 이미지 수정됨");
  } catch (e) { setStatus("수정 실패: " + e.message, true); }
}

// ---------- 출력 / 발행 ----------
async function onCopy() {
  if (!cur?.html) return;
  try { await navigator.clipboard.writeText(cur.html); setStatus(`📋 [${cur.acc.name || cur.target}] HTML 복사됨. 편집기 'HTML' 모드에 붙여넣으세요.`); }
  catch (e) { setStatus("복사 실패: " + e.message, true); }
}
// 통합 발행 — 계정 플랫폼에 따라 WP/블로거 자동 라우팅
async function publishCur() {
  if (!cur) return;
  if (cur.target === "wordpress") return wpPublish("publish");
  if (cur.target === "blogger") return bloggerPublish();
  setStatus("이 계정은 자동발행 대상이 아닙니다(네이버 등). 'HTML 복사'로 직접 올린 뒤 '저장(수동발행)'을 누르세요.", true);
}
async function wpPublish(status) {
  if (!cur?.html) return;
  if (cur.target !== "wordpress") { setStatus("이 계정은 워드프레스 자동발행이 아닙니다. HTML 복사로 발행하세요.", true); return; }
  if (status === "publish") stampPublishDate();   // 최종 업데이트 = 발행일로 자동 세팅
  const label = status === "publish" ? "발행" : "초안 저장";
  try {
    setStatus(`[${cur.acc.name || "WP"}] ${label} 중…`);
    const res = await wpCreatePost({ title: cur.article.title, content: cur.html, status, destinationId: cur.acc.id, category: cur.article.category });
    if (res.link) {
      try { await saveMyPost({ title: cur.article.title, url: res.link, keyword: cur.keyword }, (cur.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {}
      if (status === "publish") {
        if (isDestRole(cur.acc)) $("bloggerUrl").value = res.link;   // 목적지 → 쿠션 유입 URL
        // 발행 완료 → 작업 목록에서 제거(status published)
        await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", article: cur.article, html: cur.html, status: "published", published_url: res.link, published_id: res.id != null ? String(res.id) : null, publish_mode: "manual" }) }).catch(() => {});
        cur = null; $("workDetail").style.display = "none"; renderWorkList();
      }
    }
    setStatus(`✅ ${label} 완료: ${res.link || ("글 #" + res.id)}${status === "publish" && isDestRole(cur?.acc || {}) ? " · 목적지로 설정됨" : ""}`);
  } catch (e) { setStatus(`${label} 실패: ` + e.message, true); }
}
async function bloggerPublish() {
  if (!cur?.html) return;
  if (cur.target !== "blogger") return;
  stampPublishDate();   // 최종 업데이트 = 발행일로 자동 세팅
  try {
    setStatus(`[${cur.acc.name || "블로거"}] 블로거 발행 중…`);
    const res = await apiJson("/api/blogger", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ destinationId: cur.acc.id, title: cur.article.title, content: cur.html, labels: articleLabels(cur.article) }) });
    if (res.link) {
      try { await saveMyPost({ title: cur.article.title, url: res.link, keyword: cur.keyword }, (cur.html || "").replace(/<[^>]+>/g, " ").slice(0, 4000)); } catch {}
      await apiJson("/api/work", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: cur.id, target: cur.target, destination_id: cur.acc.id, title: cur.article.title || "", article: cur.article, html: cur.html, status: "published", published_url: res.link, published_id: res.id != null ? String(res.id) : null, publish_mode: "manual" }) }).catch(() => {});
      setStatus(`✅ 블로거 발행 완료: ${res.link}`);
      cur = null; $("workDetail").style.display = "none"; renderWorkList();
    }
  } catch (e) { setStatus("블로거 발행 실패: " + e.message + " · 계정 관리에서 '구글 연결'을 확인하세요.", true); }
}

/* ═══════════════════════════════════════════════════════════════
 *  사이트 플레이북
 *  지침을 DB 에 두고 여기서 고친다. 루틴은 next_topic 으로 읽어가므로
 *  저장하면 다음 실행부터 반영된다. 루틴 프롬프트를 다시 붙일 일이 없다.
 * ═══════════════════════════════════════════════════════════════ */
let pbState = { site: null, order: [], labels: {} };

async function pbFetch(path, opts) {
  const r = await fetch(path, { credentials: "same-origin", ...opts });
  if (!r.ok) throw new Error(`서버 응답 ${r.status}`);
  return r.json();
}

async function loadPlaybookSites() {
  const j = await pbFetch("/api/playbook");
  pbState.order = j.order || []; pbState.labels = j.labels || {};
  const box = document.getElementById("pbSiteList");
  if (!box) return;
  const sites = j.sites || [];
  if (!sites.length) { box.innerHTML = '<div class="pb-site muted">아직 없습니다</div>'; return; }
  box.innerHTML = "";
  for (const s of sites) {
    const b = document.createElement("button");
    b.className = "pb-site" + (pbState.site === s.site ? " on" : "");
    const on = s.enabled === null || s.enabled === undefined ? true : !!s.enabled;
    b.innerHTML = `<span class="dot ${on ? "" : "off"}"></span><span>${s.site}</span><span class="cnt">${s.sections}</span>`;
    b.addEventListener("click", () => openPlaybook(s.site));
    box.appendChild(b);
  }
}

async function openPlaybook(site) {
  pbState.site = site;
  const j = await pbFetch("/api/playbook?site=" + encodeURIComponent(site));
  pbState.order = j.order || pbState.order; pbState.labels = j.labels || pbState.labels;
  document.getElementById("pbHead")?.classList.remove("hidden");
  document.getElementById("pbSiteName").textContent = site;
  const total = (j.sections || []).reduce((a, s) => a + (s.body || "").length, 0);
  document.getElementById("pbMeta").textContent =
    `섹션 ${(j.sections || []).length}개 · ${total.toLocaleString()}자 · 루틴이 읽어가는 지침`;
  const sw = document.getElementById("pbEnabled");
  if (sw) sw.checked = j.enabled !== false;

  // 순서대로 렌더. 비어 있는 섹션도 자리를 만들어 채울 수 있게 한다.
  const have = new Map((j.sections || []).map((s) => [s.section, s]));
  const keys = [...pbState.order, ...(j.sections || []).map((s) => s.section).filter((k) => !pbState.order.includes(k))];
  const box = document.getElementById("pbSections");
  box.innerHTML = "";
  keys.forEach((k, i) => {
    const cur = have.get(k);
    const body = cur ? cur.body : "";
    const el = document.createElement("div");
    el.className = "pb-sec";
    el.innerHTML = `
      <div class="pb-sec-head">
        <b>${pbState.labels[k] || k}</b><span class="k">${k}</span>
        <span class="len">${body.length.toLocaleString()}자</span>
      </div>
      <div class="pb-sec-body ${body ? "hidden" : ""}">
        <textarea data-sec="${k}" placeholder="비어 있습니다. 지침을 적으면 루틴이 다음 실행부터 따릅니다."></textarea>
        <div class="pb-sec-actions">
          <button class="mini pb-save">저장</button>
          <span class="saved hidden">저장됨</span>
        </div>
      </div>`;
    el.querySelector("textarea").value = body;
    el.querySelector(".pb-sec-head").addEventListener("click", () =>
      el.querySelector(".pb-sec-body").classList.toggle("hidden"));
    el.querySelector(".pb-save").addEventListener("click", async (e) => {
      e.stopPropagation();
      const ta = el.querySelector("textarea");
      try {
        await pbFetch("/api/playbook", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site, section: k, body: ta.value, sort: (i + 1) * 10 }) });
        el.querySelector(".len").textContent = ta.value.length.toLocaleString() + "자";
        const s = el.querySelector(".saved"); s.classList.remove("hidden");
        setTimeout(() => s.classList.add("hidden"), 1600);
      } catch (err) { setStatus("저장 실패: " + err.message, true); }
    });
    box.appendChild(el);
  });
  loadPlaybookSites();
}

function bindPlaybook() {
  document.getElementById("pbRefresh")?.addEventListener("click", () => {
    if (pbState.site) openPlaybook(pbState.site); else loadPlaybookSites();
  });
  document.getElementById("pbAddSite")?.addEventListener("click", async () => {
    const inp = document.getElementById("pbNewSite");
    const site = (inp.value || "").trim();
    if (!site) return;
    // 빈 정체성 섹션 하나로 사이트를 만든다
    await pbFetch("/api/playbook", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site, section: "identity", body: "", sort: 10 }) });
    inp.value = "";
    openPlaybook(site);
  });
  document.getElementById("pbEnabled")?.addEventListener("change", async (e) => {
    if (!pbState.site) return;
    await pbFetch("/api/playbook/enabled", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: pbState.site, enabled: e.target.checked }) });
    setStatus(e.target.checked ? `${pbState.site} 루틴 작동` : `${pbState.site} 루틴 멈춤 — 다음 실행에서 아무것도 쓰지 않습니다`);
    loadPlaybookSites();
  });
  document.getElementById("pbExpAdd")?.addEventListener("click", async () => {
    if (!pbState.site) return;
    const line = prompt("실제 경험 한 줄 (검색해도 안 나오는 것)\n예: 규정에 조금 못 미쳐도 '비용을 배상하겠다' 고 하면 통과되는 곳이 많다");
    if (!line || !line.trim()) return;
    await pbFetch("/api/playbook/experience", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site: pbState.site, line: line.trim() }) });
    setStatus("경험 자산에 추가했습니다 — 다음 글부터 반영됩니다");
    openPlaybook(pbState.site);
  });
  document.getElementById("pbAudit")?.addEventListener("click", async () => {
    if (!pbState.site) return;
    const destId = pbState.site === "naver" ? "naver_mango" : pbState.site;
    const drafts = await pbFetch("/api/drafts?limit=100");
    const list = (drafts.items || drafts || []).filter((d) => d.dest_id === destId);
    if (!list.length) { setStatus("점검할 초안이 없습니다", true); return; }
    const box = document.getElementById("pbSections");
    const rep = document.createElement("div");
    rep.className = "pb-audit";
    rep.innerHTML = `<b>초안 점검</b> <span class="muted">${list.length}건</span><div class="rows"></div>`;
    box.prepend(rep);
    const rows = rep.querySelector(".rows");
    let pass = 0;
    for (const d of list) {
      const full = await pbFetch("/api/drafts/" + encodeURIComponent(d.id));
      const v = await pbFetch("/api/playbook/validate", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site: pbState.site, title: full.title, content: full.content }) });
      if (v.ok) pass++;
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<span class="${v.ok ? "ok" : "ng"}">${v.ok ? "✓" : "✗"}</span>
        <span style="flex:1">${(full.title || "").slice(0, 44)}</span>
        <span class="muted">${v.stats?.bodyChars ?? "?"}자</span>`;
      if (!v.ok) row.title = v.errors.join("\n");
      rows.appendChild(row);
    }
    rep.querySelector(".muted").textContent = `${pass}/${list.length} 통과 — ✗ 에 마우스를 올리면 이유가 보입니다`;
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindPlaybook();
  // 플레이북 메뉴를 처음 누를 때 목록을 불러온다
  document.querySelectorAll('.nav-item[data-view="playbook"]').forEach((b) =>
    b.addEventListener("click", () => loadPlaybookSites()));
});
