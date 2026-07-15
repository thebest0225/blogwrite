// 구글 시트(Apps Script 웹앱) 연동 — 작업 기록/내 글 보관함을 클라우드에 저장
// 설정: sheetApiUrl(Apps Script 배포 URL), sheetToken(선택 비밀키)
// Apps Script는 doPost(추가)/doGet(목록)를 처리. (설정_구글시트연동.md 참고)

export function cloudConfigured(s) {
  return !!(s && s.sheetApiUrl && /^https?:\/\//.test(s.sheetApiUrl));
}

// 레코드 추가 (type: 'post' | 'article')
export async function cloudAdd(s, record) {
  if (!cloudConfigured(s)) return;
  try {
    await fetch(s.sheetApiUrl, {
      method: "POST",
      // text/plain → CORS 프리플라이트 회피(Apps Script는 postData.contents로 읽음)
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ token: s.sheetToken || "", ...record })
    });
  } catch (e) {
    console.warn("클라우드 저장 실패:", e);
  }
}

// 전체 레코드 목록
export async function cloudList(s) {
  if (!cloudConfigured(s)) return [];
  try {
    const url = s.sheetApiUrl + (s.sheetApiUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(s.sheetToken || "");
    const res = await fetch(url);
    if (!res.ok) return [];
    const j = await res.json();
    return Array.isArray(j.records) ? j.records : [];
  } catch (e) {
    console.warn("클라우드 조회 실패:", e);
    return [];
  }
}
