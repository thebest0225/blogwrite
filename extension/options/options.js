import { getSettings, saveSettings, DEFAULTS, DEFAULT_THUMB_STYLE } from "../lib/storage.js";
import { wpListPosts } from "../lib/wordpress-api.js";

const $ = (id) => document.getElementById(id);
const TEXT_FIELDS = [
  "kieApiKey", "kieImageModel",
  "naverClientId", "naverClientSecret",
  "wpSite", "wpUser", "wpAppPassword",
  "adCode", "overlayAccent", "thumbnailStylePrompt", "myBlogUrl",
  "sheetApiUrl", "sheetToken", "sheetViewUrl",
  "defaultTone", "defaultAudience", "authorBio"
];

init();

async function init() {
  const s = await getSettings();
  for (const k of TEXT_FIELDS) if ($(k)) $(k).value = s[k] ?? "";
  $("kieChatModel").value = s.kieChatModel || "claude-sonnet-5";
  $("imageResolution").value = s.imageResolution || "1K";
  $("defaultPlatform").value = s.defaultPlatform;
  $("generateImages").value = String(s.generateImages);
  $("imageCount").value = String(s.imageCount || 4);
  $("internalLinks").checked = !!s.internalLinks;
  $("adEnabled").checked = !!s.adEnabled;
  $("thumbnailMode").value = s.thumbnailMode || "ai_full";
  $("linkMode").value = s.linkMode || "search";
  $("saveBtn").addEventListener("click", onSave);
  $("testWpBtn").addEventListener("click", onTestWp);
  $("resetThumbStyle").addEventListener("click", async () => {
    $("thumbnailStylePrompt").value = DEFAULT_THUMB_STYLE;
    await saveSettings({ thumbnailStylePrompt: DEFAULT_THUMB_STYLE });
    flash("saved", "✅ 썸네일 스타일 초기화됨");
  });
}

async function onSave() {
  const patch = {};
  for (const k of TEXT_FIELDS) if ($(k)) patch[k] = $(k).value.trim();
  patch.kieChatModel = $("kieChatModel").value;
  patch.imageResolution = $("imageResolution").value;
  patch.defaultPlatform = $("defaultPlatform").value;
  patch.generateImages = $("generateImages").value === "true";
  patch.imageCount = parseInt($("imageCount").value, 10) || 4;
  patch.internalLinks = $("internalLinks").checked;
  patch.adEnabled = $("adEnabled").checked;
  patch.thumbnailMode = $("thumbnailMode").value;
  patch.linkMode = $("linkMode").value;
  if (!patch.thumbnailStylePrompt) patch.thumbnailStylePrompt = DEFAULTS.thumbnailStylePrompt;
  if (!patch.kieChatModel) patch.kieChatModel = DEFAULTS.kieChatModel;
  if (!patch.kieImageModel) patch.kieImageModel = DEFAULTS.kieImageModel;
  await saveSettings(patch);
  flash("saved", "✅ 저장됨");
}

async function onTestWp() {
  const site = $("wpSite").value.trim();
  const user = $("wpUser").value.trim();
  const pass = $("wpAppPassword").value.trim();
  if (!site || !user || !pass) { flash("testMsg", "사이트/아이디/비밀번호를 입력하세요", true); return; }
  flash("testMsg", "테스트 중…");
  try {
    const posts = await wpListPosts({ site, user, pass, perPage: 1 });
    flash("testMsg", `✅ 연결 성공 (글 읽기 가능)`);
  } catch (e) {
    flash("testMsg", "❌ " + e.message, true);
  }
}

function flash(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.style.color = isError ? "#dc2626" : "#16a34a";
  el.classList.remove("hidden");
  if (!isError) setTimeout(() => el.classList.add("hidden"), 2500);
}
