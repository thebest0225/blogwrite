// 블로거(blogger.com) 편집기 콘텐츠 스크립트
// 편집기 구조가 다양해서 여러 전략을 순차 시도한다.
// - 같은 출처(iframe) 내부까지 탐색
// - contenteditable엔 execCommand('insertHTML')로 삽입(에디터가 반영하게)
// - HTML 보기 textarea엔 value 설정
// 실패 시 사이드패널의 'HTML 복사'로 폴백.
(function () {
  if (window.__awBloggerLoaded) return;
  window.__awBloggerLoaded = true;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.action !== "insertPost" && msg?.action !== "extractPost") return;
    try {
      sendResponse(msg.action === "extractPost" ? extract() : insert(msg.title, msg.html));
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  });

  // 접근 가능한 모든 문서(메인 + 같은 출처 iframe)
  function docs() {
    const list = [document];
    for (const f of document.querySelectorAll("iframe")) {
      try { if (f.contentDocument) list.push(f.contentDocument); } catch (_) { /* 교차출처 */ }
    }
    return list;
  }

  function findTitle() {
    const sels = [
      'input[aria-label*="제목"]', 'input[placeholder*="제목"]',
      'input[aria-label*="Title"]', 'input[placeholder*="Title"]',
      'input[aria-label*="title"]'
    ];
    for (const doc of docs()) {
      for (const s of sels) { const el = doc.querySelector(s); if (el) return el; }
    }
    return null;
  }

  // 본문 후보: HTML 모드 textarea 또는 가장 큰 contenteditable
  function findBody() {
    // 1) HTML 보기 textarea
    for (const doc of docs()) {
      const ta = doc.querySelector('textarea[aria-label*="HTML"], textarea[id*="postingHtmlBox"], textarea.gpn-textarea, textarea');
      if (ta) return { el: ta, doc, kind: "textarea" };
    }
    // 2) contenteditable 중 가장 큰 영역(본문)
    let best = null, bestArea = 0, bestDoc = null;
    for (const doc of docs()) {
      const ces = doc.querySelectorAll('[contenteditable="true"], [contenteditable=""], [role="textbox"][contenteditable]');
      for (const el of ces) {
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 0, height: 0 };
        const area = (r.width || el.offsetWidth || 0) * (r.height || el.offsetHeight || 0);
        if (area >= bestArea) { bestArea = area; best = el; bestDoc = doc; }
      }
    }
    if (best) return { el: best, doc: bestDoc, kind: "ce" };
    return null;
  }

  function fireInput(el, doc) {
    el.dispatchEvent(new (doc.defaultView || window).Event("input", { bubbles: true }));
    el.dispatchEvent(new (doc.defaultView || window).Event("change", { bubbles: true }));
    el.dispatchEvent(new (doc.defaultView || window).KeyboardEvent("keyup", { bubbles: true }));
  }

  function setTextarea(el, doc, value) {
    el.focus();
    el.value = value;
    fireInput(el, doc);
  }

  function setContentEditable(el, doc, html, replace) {
    el.focus();
    const sel = (doc.defaultView || window).getSelection();
    const range = doc.createRange();
    range.selectNodeContents(el);
    if (!replace) range.collapse(false); // 끝에 추가
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = doc.execCommand("insertHTML", false, html); } catch (_) { ok = false; }
    if (!ok) {
      // 폴백: 직접 삽입
      if (replace) el.innerHTML = html;
      else el.innerHTML += html;
    }
    fireInput(el, doc);
  }

  function extract() {
    const t = findTitle();
    const body = findBody();
    if (!body) return { ok: false, error: "블로거 본문을 읽지 못했습니다. 'HTML 보기'로 전환 후 다시 시도하세요." };
    const content = body.kind === "textarea" ? body.el.value : body.el.innerHTML;
    return { ok: true, title: t ? t.value : "", content, note: "블로거에서 읽음" };
  }

  function insert(title, html) {
    const notes = [];
    const t = findTitle();
    if (t) { t.focus(); t.value = title; fireInput(t, t.ownerDocument || document); notes.push("제목"); }

    const body = findBody();
    if (!body) {
      return { ok: false, error: "블로거 본문 편집영역을 못 찾음. 'HTML 보기' 모드로 전환하거나 'HTML 복사'를 쓰세요." };
    }
    if (body.kind === "textarea") setTextarea(body.el, body.doc, html);
    else setContentEditable(body.el, body.doc, html, true);
    notes.push(body.kind === "textarea" ? "본문(HTML모드)" : "본문(작성모드)");
    return { ok: true, note: notes.join("+") + " — 반영 안 되면 'HTML 보기'에서 붙여넣기 권장" };
  }
})();
