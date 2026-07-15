// 페이지 컨텍스트에서 실행 (워드프레스 window.wp 접근 가능)
// kind: "insert"(추가) | "replace"(교체) | "extract"(기존 글 읽기)
(function () {
  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || d.__autowriter !== true || d.dir !== "toPage") return;
    const reply = (payload) =>
      window.postMessage({ __autowriter: true, dir: "fromPage", reqId: d.reqId, ...payload }, "*");

    try {
      if (d.kind === "extract") return reply(extract());
      return reply(await put(d));
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  });

  // ---- 기존 글 읽기 ----
  function extract() {
    if (window.wp?.data) {
      const sel = wp.data.select("core/editor");
      if (sel?.getEditedPostAttribute) {
        const title = sel.getEditedPostAttribute("title") || "";
        const content = sel.getEditedPostAttribute("content") || "";
        if (content) return { ok: true, title, content, note: "Gutenberg에서 읽음" };
      }
    }
    if (window.tinymce && tinymce.get("content")) {
      return { ok: true, title: valOf("title"), content: tinymce.get("content").getContent(), note: "클래식에서 읽음" };
    }
    const ta = document.getElementById("content");
    if (ta) return { ok: true, title: valOf("title"), content: ta.value, note: "textarea에서 읽음" };
    return { ok: false, error: "기존 글을 읽을 편집기를 찾지 못했습니다." };
  }

  // ---- 글 넣기 (추가/교체) ----
  async function put(d) {
    const { title, html, kind } = d;

    if (window.wp?.data && window.wp?.blocks) {
      const editor = wp.data.dispatch("core/editor");
      const blockEditor = wp.data.dispatch("core/block-editor");
      const blockSelect = wp.data.select("core/block-editor");
      if (editor?.editPost) editor.editPost({ title });

      let blocks = null;
      try { blocks = wp.blocks.rawHandler({ HTML: html }); } catch (_) { blocks = null; }
      if (!blocks || !blocks.length) {
        // 폴백: HTML 통짜 블록 (style/특수태그로 파싱 실패해도 안전)
        blocks = [wp.blocks.createBlock("core/html", { content: html })];
      }

      // 교체 모드거나 본문이 비어있으면 전체 리셋(가장 안정적)
      const count = blockSelect?.getBlockCount ? blockSelect.getBlockCount() : 0;
      const isEmpty = count <= 1;
      if ((kind === "replace" || isEmpty) && blockEditor?.resetBlocks) {
        blockEditor.resetBlocks(blocks);
        return { ok: true, note: kind === "replace" ? "전체 교체" : "본문 삽입" };
      }
      if (blockEditor?.insertBlocks) {
        blockEditor.insertBlocks(blocks, count); // 끝에 추가
        return { ok: true, note: "블록 추가" };
      }
    }

    if (window.tinymce && tinymce.get("content")) {
      tinymce.get("content").setContent(html);
      setVal("title", title);
      return { ok: true, note: "클래식(TinyMCE)" };
    }

    const ta = document.getElementById("content");
    if (ta) {
      ta.value = html;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      setVal("title", title);
      return { ok: true, note: "textarea" };
    }
    return { ok: false, error: "지원되는 편집기를 찾지 못했습니다." };
  }

  function valOf(id) { const el = document.getElementById(id); return el ? el.value : ""; }
  function setVal(id, v) {
    const el = document.getElementById(id);
    if (el) { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }
  }
})();
