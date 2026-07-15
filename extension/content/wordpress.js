// 워드프레스 편집기 콘텐츠 스크립트 (isolated world)
// 사이드패널 → 이 스크립트 → (postMessage) → wp-inject.js(페이지 컨텍스트) → 응답
(function () {
  if (window.__awWpLoaded) return; // 중복 주입 방지
  window.__awWpLoaded = true;

  const PENDING = new Map();
  let injected = false;

  function injectPageScript() {
    if (injected) return;
    injected = true;
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("content/wp-inject.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  injectPageScript(); // 로드 시 미리 주입해 응답 지연 방지

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || d.__autowriter !== true || d.dir !== "fromPage") return;
    const cb = PENDING.get(d.reqId);
    if (cb) { PENDING.delete(d.reqId); cb(d); }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action !== "insertPost" && msg?.action !== "extractPost") return;
    injectPageScript();
    const reqId = "req_" + Date.now() + "_" + Math.floor(performance.now());
    const kind = msg.action === "extractPost" ? "extract" : (msg.replace ? "replace" : "insert");

    const timer = setTimeout(() => {
      if (PENDING.has(reqId)) {
        PENDING.delete(reqId);
        sendResponse({ ok: false, error: "편집기 응답 시간 초과(Gutenberg 미로딩?)" });
      }
    }, 7000);

    PENDING.set(reqId, (resp) => {
      clearTimeout(timer);
      sendResponse(resp);
    });

    setTimeout(() => {
      window.postMessage({
        __autowriter: true, dir: "toPage", reqId, kind,
        title: msg.title, html: msg.html
      }, "*");
    }, 300);

    return true; // async
  });
})();
