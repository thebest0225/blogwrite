// KIE.ai API 클라이언트
// - 글 생성: Claude Messages 호환  POST https://api.kie.ai/claude/v1/messages
//   모델: claude-sonnet-5 (기본) / claude-opus-4-8
// - 이미지: 마켓 jobs API  POST /api/v1/jobs/createTask (gpt-image-2-text-to-image)
//   → data.taskId → GET /api/v1/jobs/recordInfo?taskId= 폴링 → resultJson.resultUrls
// 참고: https://docs.kie.ai/

const BASE = "https://api.kie.ai";

function authHeaders(apiKey) {
  return {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

// ---- 글 생성 (Claude Messages, 동기) ----
export async function chatComplete({ apiKey, model, system, user, maxTokens = 6000, temperature = 0.8 }) {
  if (!apiKey) throw new Error("KIE API 키가 없습니다. 설정에서 입력하세요.");
  const res = await fetch(`${BASE}/claude/v1/messages`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({
      model,
      system,
      messages: [{ role: "user", content: user }],
      max_tokens: maxTokens,
      temperature,
      stream: false,
      thinkingFlag: false
    })
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`KIE 응답 파싱 실패: ${text.slice(0, 300)}`); }
  if (!res.ok || (json.code && json.code !== 200)) {
    throw new Error(`KIE 오류(${res.status}): ${json?.msg || json?.error?.message || text.slice(0, 300)}`);
  }
  const data = json?.data && (json.data.content || json.data.choices) ? json.data : json;
  // Anthropic 형식: content = [{type:'text', text:'...'}]
  let content = "";
  if (Array.isArray(data?.content)) {
    content = data.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  if (!content) {
    content = data?.choices?.[0]?.message?.content ?? data?.content ?? "";
  }
  if (!content) throw new Error(`KIE 응답에 본문이 없습니다: ${text.slice(0, 300)}`);
  return content;
}

// ---- 이미지 작업 공통 (마켓 jobs API, 비동기) ----
async function runImageJob({ apiKey, model, input }) {
  const genRes = await fetch(`${BASE}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ model, input })
  });
  const genJson = await genRes.json();
  if (!genRes.ok || genJson.code !== 200) {
    throw new Error(`이미지 요청 실패: ${genJson?.msg || genRes.status}`);
  }
  const taskId = genJson?.data?.taskId;
  if (!taskId) throw new Error("이미지 taskId를 받지 못했습니다.");

  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const infoRes = await fetch(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: authHeaders(apiKey)
    });
    const infoJson = await infoRes.json();
    const data = infoJson?.data;
    if (!data) continue;
    if (data.state === "success") {
      let urls = [];
      try { urls = JSON.parse(data.resultJson || "{}").resultUrls || []; } catch {}
      if (urls[0]) return urls[0];
      throw new Error("이미지 완료지만 URL이 없습니다.");
    }
    if (data.state === "fail") {
      throw new Error("이미지 생성 실패: " + (data.failMsg || data.failCode || "서버 오류"));
    }
  }
  throw new Error("이미지 생성 시간 초과.");
}

// 텍스트 → 이미지 생성
export async function generateImage({ apiKey, prompt, model = "gpt-image-2-text-to-image", aspectRatio = "16:9", resolution = "1K" }) {
  if (!apiKey) throw new Error("KIE API 키가 없습니다.");
  return runImageJob({ apiKey, model, input: { prompt, aspect_ratio: aspectRatio, resolution } });
}

// 이미지 → 이미지 편집(부분 수정)
export async function editImage({ apiKey, imageUrl, prompt, aspectRatio = "16:9", resolution = "1K" }) {
  if (!apiKey) throw new Error("KIE API 키가 없습니다.");
  if (!imageUrl || imageUrl.startsWith("data:")) {
    throw new Error("부분 수정은 생성된 이미지(URL)에만 가능합니다. '다시 생성'을 사용하세요.");
  }
  return runImageJob({
    apiKey,
    model: "gpt-image-2-image-to-image",
    input: { prompt, input_urls: [imageUrl], aspect_ratio: aspectRatio, resolution }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
