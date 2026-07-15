// 워드프레스 REST API 클라이언트 (Application Password 인증)
// 기능: 글 목록 / 글 읽기 / 초안·발행 생성 / 수정 / 내부링크 후보 목록

function basicAuth(user, pass) {
  const raw = `${user}:${pass}`;
  return "Basic " + btoa(unescape(encodeURIComponent(raw)));
}

function base(site) {
  return site.replace(/\/+$/, "") + "/wp-json/wp/v2";
}

export function wpConfigured(s) {
  return !!(s?.wpSite && s?.wpUser && s?.wpAppPassword);
}

export async function wpListPosts({ site, user, pass, search = "", page = 1, perPage = 30 }) {
  const url = `${base(site)}/posts?per_page=${perPage}&page=${page}&search=${encodeURIComponent(search)}&status=publish,draft,pending,private&orderby=modified&_fields=id,title,link,status`;
  const res = await fetch(url, { headers: { Authorization: basicAuth(user, pass) } });
  if (!res.ok) throw new Error(`WP 목록 실패(${res.status}): ${(await res.text()).slice(0, 150)}`);
  const arr = await res.json();
  return arr.map((p) => ({
    id: p.id,
    title: stripTags(p.title?.rendered || "(제목없음)"),
    link: p.link,
    status: p.status
  }));
}

export async function wpGetPost({ site, user, pass, id }) {
  const url = `${base(site)}/posts/${id}?context=edit&_fields=id,title,content`;
  const res = await fetch(url, { headers: { Authorization: basicAuth(user, pass) } });
  if (!res.ok) throw new Error(`WP 글 읽기 실패(${res.status})`);
  const j = await res.json();
  return {
    id: j.id,
    title: j.title?.raw ?? stripTags(j.title?.rendered || ""),
    content: j.content?.raw ?? j.content?.rendered ?? ""
  };
}

export async function wpCreatePost({ site, user, pass, title, content, status = "draft" }) {
  const res = await fetch(`${base(site)}/posts`, {
    method: "POST",
    headers: { Authorization: basicAuth(user, pass), "Content-Type": "application/json" },
    body: JSON.stringify({ title, content, status })
  });
  if (!res.ok) throw new Error(`WP 생성 실패(${res.status}): ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

export async function wpUpdatePost({ site, user, pass, id, title, content, status }) {
  const body = {};
  if (title != null) body.title = title;
  if (content != null) body.content = content;
  if (status) body.status = status;
  const res = await fetch(`${base(site)}/posts/${id}`, {
    method: "POST",
    headers: { Authorization: basicAuth(user, pass), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`WP 수정 실패(${res.status}): ${(await res.text()).slice(0, 200)}`);
  return await res.json();
}

// 내부링크 후보 (발행글 제목+URL)
export async function wpListForLinks({ site, user, pass, perPage = 50 }) {
  try {
    const url = `${base(site)}/posts?per_page=${perPage}&status=publish&orderby=modified&_fields=title,link`;
    const res = await fetch(url, { headers: { Authorization: basicAuth(user, pass) } });
    if (!res.ok) return [];
    const arr = await res.json();
    return arr.map((p) => ({ title: stripTags(p.title?.rendered || ""), link: p.link })).filter((x) => x.title && x.link);
  } catch {
    return [];
  }
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#8217;/g, "'").trim();
}
