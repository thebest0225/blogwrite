// 생성된 JSON(article) → 플랫폼 독립 HTML(인라인 스타일) + JSON-LD 스키마
// 모든 스타일은 인라인으로 넣어 워드프레스/블로거 어디에 붙여도 깨지지 않게 함.

function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// **굵게** 와 [텍스트](url) 만 허용하는 간단 인라인 변환
function inline(s = "") {
  let t = esc(s);
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener" style="color:#2563eb;text-decoration:underline;">$1</a>');
  return t;
}

// 유튜브 영상 ID 추출 (watch?v= / youtu.be / embed / shorts / live)
function ytId(u) {
  if (!u) return "";
  const m = String(u).match(/(?:youtube\.com\/(?:watch\?[^#\s"']*\bv=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : "";
}
// 반응형 유튜브 임베드(재생 플레이어)
function ytEmbed(id, title) {
  return `<div style="position:relative;width:100%;aspect-ratio:16/9;margin:1.5em 0;border-radius:12px;overflow:hidden;box-shadow:0 6px 18px rgba(0,0,0,.15);background:#000;">`
    + `<iframe src="https://www.youtube.com/embed/${id}" title="${esc(title || "YouTube 영상")}" `
    + `style="position:absolute;inset:0;width:100%;height:100%;border:0;" loading="lazy" `
    + `allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe></div>`
    + (title ? `<p style="text-align:center;color:#888;font-size:.85em;margin:-6px 0 1em;">${esc(title)}</p>` : "");
}

const S = {
  h2: "font-size:1.5em;font-weight:700;margin:1.6em 0 0.6em;padding-bottom:0.2em;border-bottom:2px solid #eee;",
  h3: "font-size:1.2em;font-weight:700;margin:1.2em 0 0.5em;",
  p: "line-height:1.8;margin:0.8em 0;color:#222;",
  table: "border-collapse:collapse;width:100%;margin:1em 0;font-size:0.95em;",
  th: "border:1px solid #ddd;background:#f5f7fa;padding:10px;text-align:left;font-weight:700;",
  td: "border:1px solid #ddd;padding:10px;vertical-align:top;",
  li: "line-height:1.8;margin:0.3em 0;",
  img: "max-width:100%;height:auto;border-radius:10px;margin:1em 0;display:block;",
  ctaWrap: "text-align:center;margin:1.5em 0;",
  cta: "display:inline-block;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;padding:14px 28px;border-radius:8px;font-weight:700;text-decoration:none;box-shadow:0 3px 8px rgba(37,99,235,.3);",
  callout: {
    tip: "background:#eef7ee;border-left:4px solid #34a853;",
    warning: "background:#fff4e5;border-left:4px solid #f59e0b;",
    info: "background:#eef2ff;border-left:4px solid #6366f1;"
  },
  calloutBase: "padding:14px 16px;border-radius:6px;margin:1.2em 0;line-height:1.7;",
  faqWrap: "margin:1.2em 0;",
  faqQ: "font-weight:700;margin:1em 0 0.3em;color:#111;",
  faqA: "line-height:1.8;margin:0 0 0.8em;color:#333;",
  related: "margin-top:2em;padding-top:1em;border-top:1px dashed #ccc;color:#666;font-size:0.9em;",
  updated: "color:#888;font-size:0.85em;margin:0.3em 0 1em;"
};

// 링크 URL 해석:
// 1) 모델(claude 리서치) URL 모드 && 모델이 실제 URL을 준 경우 → 그대로
// 2) 그 외 → 버튼 문구의 '의도'에 맞는 실제 목적지로 라우팅(smartLink)
function resolveHref(url, label, cfg) {
  // 1) 원본/모델(클로드 웹서치)이 준 '실제 URL'은 항상 그대로 사용 — 공식 홈·뉴스 등 신뢰 링크 보존
  if (url && url !== "#" && /^https?:\/\//i.test(url)) return url;
  // 2) '자세히 보기'류 문구는 목적지(내 메인/원본)로 연결
  if (cfg.selfUrl) {
    const l = String(label || "");
    const selfish = /자세히|전체|더보기|더 알아|원문|본문|계속|모두\s*보|보러\s*가|확인하러|여기서\s*확인|원글|전체\s*순위/.test(l);
    const official = /넷플릭스|netflix|티빙|웨이브|디즈니|유튜브|youtube|나무위키|위키|공식|예고편|뉴스|기사|쿠팡/i.test(l);
    if (selfish && !official) return cfg.selfUrl;
  }
  // 3) 불명확한(URL 없는) 링크 처리
  //  - "search" 모드: 문구 의도에 맞는 검색/실목적지로 보완(절대 404 없음)
  //  - 기본(preserve): 검색결과 링크는 만들지 않음. 내 실제 연관글이 있으면 그걸로, 없으면 링크 제거(텍스트로)
  if (cfg.linkMode === "search") return smartLink(label, cfg);
  if (cfg.relatedUrls && cfg.relatedUrls.length) { const u = cfg.relatedUrls[cfg._i % cfg.relatedUrls.length]; cfg._i++; if (u) return u; }
  return "";
}

// 버튼 문구 뜻에 맞는 실제 목적지 URL 생성.
// 특정 OTT/방송사는 억측하지 않는다(자주 틀림). 시청류는 네이버 '다시보기' 검색으로 → 네이버가 실제 시청처를 보여줌.
function smartLink(label, cfg) {
  const raw = String(label || "");
  const L = raw.toLowerCase();
  // 안전 인코딩: 짝 없는 서로게이트(깨진 이모지 등)로 인한 "URI malformed" 방지
  const enc = (s) => { try { return encodeURIComponent(s); } catch { return encodeURIComponent(String(s).replace(/[\uD800-\uDFFF]/g, "").trim() || "검색"); } };
  // 제목 추출: 플랫폼명 + 동작어(시청하기·정주행·보러가기 등)를 최대한 제거
  let t = raw
    .replace(/넷플릭스에서|넷플릭스|netflix|티빙에서|티빙|tving|웨이브에서|웨이브|wavve|디즈니플러스|디즈니\s*\+|디즈니|disney|왓챠|쿠팡플레이|유플러스|u\+|jtbc|tvn|sbs|kbs|mbc|유튜브에서|유튜브|youtube|나무위키|위키백과|위키|wiki|공식|홈페이지|사이트/gi, "")
    .replace(/에서|정주행하기|정주행|몰아보기|다시보기|시청하기|시청|보러가기|보러|바로가기|바로|둘러보기|알아보기|확인하기|확인하러|확인|더보기|해보기|보기|찾기|계속|하기|하러/gi, "")
    .replace(/[▶👉→\-–—:·|/]|📺|🎬|🔥|📖|🎯|👥|📱|💬|📰/g, " ")
    .replace(/\s+/g, " ").trim();
  if (t.length < 2) t = cfg.searchContext || raw;
  const q = t;

  if (/유튜브|youtube|예고편|트레일러|trailer|영상/i.test(L)) return "https://www.youtube.com/results?search_query=" + enc(q);
  if (/나무위키|namu/i.test(L)) return "https://namu.wiki/Search?q=" + enc(q);
  if (/위키|wiki/i.test(L)) return "https://ko.wikipedia.org/w/index.php?search=" + enc(q);
  if (/뉴스|기사|속보|캐스팅|인터뷰/i.test(L)) return "https://search.naver.com/search.naver?where=news&query=" + enc(q);
  if (/쿠팡|구매|최저가|가격|주문|사기/i.test(L)) return "https://www.coupang.com/np/search?q=" + enc(q);
  if (/시청|다시보기|스트리밍|ott|방송|어디서|정주행|몰아보기|보기/i.test(L)) return cfg.searchBase + enc(q + " 다시보기");
  // 특정 의도 없는 일반 링크 → 내 연관글(보관함)이 있으면 크로스링크로 순환 배정, 없으면 통합검색
  if (cfg.relatedUrls && cfg.relatedUrls.length) {
    const u = cfg.relatedUrls[cfg._i % cfg.relatedUrls.length];
    cfg._i++;
    if (u) return u;
  }
  return cfg.searchBase + enc(q); // 기본: 네이버 통합검색(제목)
}

function renderBlock(b, cfg) {
  const accent = cfg.accent;
  switch (b.type) {
    case "heading":
      return b.level === 3
        ? `<h3 style="${S.h3}">${esc(b.text)}</h3>`
        : `<h2 style="${S.h2}">${esc(b.text)}</h2>`;
    case "paragraph":
      return `<p style="${S.p}">${inline(b.text)}</p>`;
    case "list": {
      const tag = b.ordered ? "ol" : "ul";
      const items = (b.items || []).map((it) => `<li style="${S.li}">${inline(it)}</li>`).join("");
      return `<${tag} style="padding-left:1.4em;margin:0.8em 0;">${items}</${tag}>`;
    }
    case "table": {
      const head = (b.headers || []).map((h) => `<th style="${S.th}">${esc(h)}</th>`).join("");
      const body = (b.rows || [])
        .map((r) => `<tr>${r.map((c) => `<td style="${S.td}">${inline(c)}</td>`).join("")}</tr>`)
        .join("");
      return `<table style="${S.table}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
    case "callout": {
      const style = S.callout[b.style] || S.callout.info;
      return `<div style="${S.calloutBase}${style}">${inline(b.text)}</div>`;
    }
    case "youtube": {
      const id = ytId(b.url || b.videoUrl || b.id);
      return id ? ytEmbed(id, b.title || b.label || "") : "";
    }
    case "cta": {
      const url = resolveHref(b.url, b.label, cfg);
      // 유튜브 영상 URL이면 버튼 대신 재생 플레이어로 임베드
      const yid = ytId(url) || ytId(b.url);
      if (yid) return ytEmbed(yid, b.label || "");
      if (!url) return "";   // 목적지 없는 버튼은 렌더 안 함(죽은 링크·검색결과 링크 방지)
      const cta = `display:inline-block;background:${accent};color:#fff;padding:13px 28px;border-radius:10px;font-weight:700;text-decoration:none;box-shadow:0 3px 10px rgba(0,0,0,.18);`;
      return `<div style="text-align:center;margin:1.4em 0;"><a class="awb-cta" href="${esc(url)}" target="_blank" rel="noopener" style="${cta}">${esc(b.label || "자세히 보기")}</a></div>`;
    }
    case "linkcard": {
      const rows = (b.items || []).map((it) => {
        const feat = !!it.featured;
        const href = resolveHref(it.url, it.title || it.label, cfg);
        if (!href) return "";   // 실목적지 없는 항목은 링크카드에서 제외(검색결과 링크 방지)
        const rowBg = feat ? `${accent}14` : "#fff";       // 라이트 테마: 검정 대신 연한 액센트 톤
        const rowBorder = feat ? accent : "#eee";
        const tColor = "#111";                              // 본문 글씨는 항상 어둡게(밝은 배경)
        const sColor = feat ? "#555" : "#888";
        const icoBg = feat ? accent : "#ffe4e6";
        return `<a href="${esc(href)}" target="_blank" rel="noopener" style="text-decoration:none;display:block;">`
          + `<div class="awb-row" style="display:flex;align-items:center;gap:12px;border:${feat ? "2px" : "1px"} solid ${rowBorder};border-radius:12px;padding:12px 14px;margin:8px 0;background:${rowBg};">`
          + `<div style="width:40px;height:40px;border-radius:10px;background:${icoBg};display:flex;align-items:center;justify-content:center;font-size:18px;flex:none;">${esc(it.icon || "▶")}</div>`
          + `<div style="flex:1;min-width:0;"><div style="font-weight:700;color:${tColor};">${esc(it.title || "")}</div>`
          + `${it.subtitle ? `<div style="font-size:.82em;color:${sColor};margin-top:2px;">${esc(it.subtitle)}</div>` : ""}</div>`
          + `<div class="awb-btn" style="background:${accent};color:#fff;border-radius:999px;padding:8px 16px;font-weight:700;font-size:.85em;white-space:nowrap;">${esc(it.label || "보기 →")}</div>`
          + `</div></a>`;
      }).join("");
      if (!rows.trim()) return "";   // 유효 링크가 하나도 없으면 카드 자체를 렌더 안 함
      return `<div style="border:1px solid #f0dede;border-radius:18px;padding:16px;margin:1.5em 0;background:linear-gradient(180deg,#ffffff,#fff8f8);box-shadow:0 8px 24px rgba(0,0,0,.06);">`
        + `${b.heading ? `<h4 style="margin:0 0 10px;font-size:1em;font-weight:700;color:${accent};">${esc(b.heading)}</h4>` : ""}${rows}</div>`;
    }
    case "image": {
      // 모델이 클릭형으로 지정한 이미지만 링크로. URL은 검색결과로 안전하게 해석.
      const link = (b.linkUrl && b.linkUrl !== "#") ? resolveHref(b.linkUrl, b.alt || cfg.searchContext, cfg) : "";
      if (b.resolvedUrl) {
        const img = `<img src="${esc(b.resolvedUrl)}" alt="${esc(b.alt || "")}" loading="lazy" style="${S.img}"/>`;
        // 출처(Pexels 등) 캡션
        const credit = b.credit ? `<span style="display:block;text-align:center;color:#aaa;font-size:0.78em;margin-top:2px;">${b.creditUrl ? `<a href="${esc(b.creditUrl)}" target="_blank" rel="noopener nofollow" style="color:#aaa;text-decoration:none;">${esc(b.credit)}</a>` : esc(b.credit)}</span>` : "";
        // 클릭형 링크 이미지
        if (link) {
          return `<a href="${esc(link)}" target="_blank" rel="noopener" style="text-decoration:none;">${img}${b.alt ? `<span style="display:block;text-align:center;color:#888;font-size:0.85em;margin-top:-4px;">${esc(b.alt)}</span>` : ""}</a>${credit}`;
        }
        return img + credit;
      }
      // 이미지 미생성 시 자리표시(클릭형이면 링크 표시)
      const badge = link ? " · 🔗클릭형" : "";
      const ph = `<div style="background:#f0f0f0;border:1px dashed #bbb;border-radius:10px;padding:24px;text-align:center;color:#999;margin:1em 0;">🖼️ 이미지 자리 (${esc(b.slot || "body")}${badge}) — ${esc(b.alt || b.prompt || "")}</div>`;
      return link ? `<a href="${esc(link)}" target="_blank" rel="noopener" style="text-decoration:none;">${ph}</a>` : ph;
    }
    default:
      return "";
  }
}

function renderFaq(faq = []) {
  const valid = (faq || []).filter((f) => f && String(f.q || "").trim() && String(f.a || "").trim());  // 빈 질문·답변 항목 제외
  if (!valid.length) return "";
  const items = valid
    .map((f) => `<div><p style="${S.faqQ}">Q. ${esc(f.q)}</p><p style="${S.faqA}">A. ${inline(f.a)}</p></div>`)
    .join("");
  return `<h2 style="${S.h2}">자주 묻는 질문 (FAQ)</h2><div style="${S.faqWrap}">${items}</div>`;
}

function buildSchema(article) {
  const graph = [];
  graph.push({
    "@type": "Article",
    "headline": article.title,
    "description": article.metaDescription,
    "dateModified": article.today || undefined
  });
  if (article.faq?.length) {
    graph.push({
      "@type": "FAQPage",
      "mainEntity": article.faq.map((f) => ({
        "@type": "Question",
        "name": f.q,
        "acceptedAnswer": { "@type": "Answer", "text": f.a }
      }))
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

// article: buildPrompt로 생성돼 파싱된 객체 (+ today, +authorBio 주입 가능)
// opts: { adEnabled, adCode } 광고 자동 삽입
// 반환: { html, htmlWithSchema, schema }
export function buildHtml(article, opts = {}) {
  const parts = [];
  const accent = opts.accent || "#e11d48";
  const cfg = {
    accent,
    linkMode: opts.linkMode || "preserve",      // preserve=원본·공식 링크 그대로(기본) / search=불명확 링크 검색보완
    searchBase: opts.searchBase || "https://search.naver.com/search.naver?query=",
    searchContext: opts.searchContext || "",
    relatedUrls: Array.isArray(opts.relatedUrls) ? opts.relatedUrls : [],
    selfUrl: opts.selfUrl || "",
    _i: 0
  };
  // 주의: <style> 블록은 워드프레스(특히 멀티사이트)가 보안필터(kses)로 제거하면서
  // 내부 CSS 텍스트가 본문에 노출되는 버그가 있음 → 발행 HTML엔 넣지 않는다.
  // hover는 장식용일 뿐이고, 카드/버튼 기본 모양은 모두 인라인 스타일로 유지된다.
  // 미리보기에서만 hover가 필요하면 buildPreviewDoc 쪽에서 스타일을 주입한다(발행 HTML에는 미포함).
  const adUnit = opts.adEnabled && opts.adCode
    ? `<div class="autowriter-ad" style="margin:1.6em 0;text-align:center;">${opts.adCode}</div>`
    : "";

  if (article.today) {
    parts.push(`<p style="${S.updated}">최종 업데이트: ${esc(article.today)}</p>`);
  }

  const blocks = article.blocks || [];
  // 첫 H2 위치(도입부 뒤)와 중간 지점에 광고 삽입
  let firstH2 = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].type === "heading" && (blocks[i].level || 2) === 2) { firstH2 = i; break; }
  }
  const mid = Math.floor(blocks.length / 2);

  for (let i = 0; i < blocks.length; i++) {
    if (adUnit && i === firstH2) parts.push(adUnit);
    parts.push(renderBlock(blocks[i], cfg));
    if (adUnit && i === mid && mid !== firstH2 && mid > firstH2) parts.push(adUnit);
  }

  if (adUnit) parts.push(adUnit); // FAQ 앞 광고
  parts.push(renderFaq(article.faq));

  if (article.authorBio) {
    parts.push(`<div style="${S.calloutBase}${S.callout.info}"><strong>작성자</strong><br/>${inline(article.authorBio)}</div>`);
  }

  // 함께 보면 좋은 글 (내 보관함 연관글 → 내부 유입/상호링크)
  if (opts.relatedPosts && opts.relatedPosts.length) {
    const items = opts.relatedPosts
      .filter((p) => p && p.link)
      .slice(0, 5)
      .map((p) => `<a href="${esc(p.link)}" target="_blank" rel="noopener" style="text-decoration:none;display:block;">`
        + `<div class="awb-row" style="display:flex;align-items:center;gap:10px;border:1px solid #eee;border-radius:12px;padding:11px 14px;margin:7px 0;background:#fff;">`
        + `<div style="width:34px;height:34px;border-radius:9px;background:${accent}1a;display:flex;align-items:center;justify-content:center;font-size:16px;flex:none;">📄</div>`
        + `<div style="flex:1;min-width:0;font-weight:600;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.title || p.link)}</div>`
        + `<div class="awb-btn" style="background:${accent};color:#fff;border-radius:999px;padding:6px 13px;font-weight:700;font-size:.82em;white-space:nowrap;">보러가기 →</div>`
        + `</div></a>`).join("");
    if (items) parts.push(`<div style="margin-top:1.6em;"><h2 style="${S.h2}">함께 보면 좋은 글</h2>${items}</div>`);
  }

  if (opts.sources && opts.sources.length) {
    const lis = opts.sources
      .filter((s) => s && s.link)
      .map((s) => `<li style="margin:4px 0;"><a href="${esc(s.link)}" target="_blank" rel="noopener" style="color:#2563eb;">${esc(s.title || s.link)}</a></li>`)
      .join("");
    if (lis) parts.push(`<div style="margin-top:1.4em;padding-top:0.8em;border-top:1px solid #eee;"><strong style="font-size:.9em;color:#555;">참고 자료</strong><ul style="padding-left:1.2em;font-size:.85em;color:#666;margin:.4em 0;">${lis}</ul></div>`);
  }

  if (article.relatedKeywords?.length) {
    parts.push(`<p style="${S.related}">연관 검색어: ${article.relatedKeywords.map(esc).join(", ")}</p>`);
  }

  const schema = buildSchema(article);
  const schemaScript = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;

  return {
    html: parts.join("\n"),
    htmlWithSchema: parts.join("\n") + "\n" + schemaScript,
    schema
  };
}

// 미리보기용 전체 문서 (iframe srcdoc)
export function buildPreviewDoc(title, bodyHtml) {
  // hover 효과는 발행 HTML엔 넣지 않고(워드프레스가 <style> 제거) 미리보기에서만 보여준다
  return `<!doctype html><html><head><meta charset="utf-8"/>
<style>body{font-family:-apple-system,'Malgun Gothic',sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#222;}
h1{font-size:1.8em;line-height:1.3;margin:0 0 0.6em;}
.awb-row{transition:all .15s ease;}.awb-row:hover{box-shadow:0 6px 16px rgba(0,0,0,.13)!important;transform:translateY(-1px);}
.awb-cta{transition:all .15s ease;}.awb-cta:hover{filter:brightness(.92);transform:translateY(-1px);}</style></head>
<body><h1>${esc(title)}</h1>${bodyHtml}</body></html>`;
}
