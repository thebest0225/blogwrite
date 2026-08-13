// ============================================================
// 롱폼 V2 MCP 도구 — blogwrite MCP 서버(mcp.mangois.love)에 얹는 모듈
//
// 왜 별도 서버가 아니라 여기에 붙였나 —
//   blogwrite MCP 는 이미 claude.ai / PC 클로드에 등록·인증돼 있다(Blog_MangoHub).
//   같은 서버에 도구를 추가하면 사용자가 커넥터를 새로 등록할 필요가 전혀 없다.
//   서버를 하나 더 띄우면 관리 지점이 둘로 늘 뿐이다.
//
// 목적: 클로드에서 대본만 주면
//   프로젝트 생성 → 세그먼트 분할 → 분석 레지스트리 → 프롬프트 업로드
// 까지 끝내서, 망고허브 배경미디어 단계에 들어가면 다 준비돼 있게 한다.
//
// 설계 원칙 —
//  1) 새 비즈니스 로직 없음. 기존 롱폼 V2 REST API 를 그대로 호출한다.
//  2) 분할은 UI 와 글자 하나까지 같아야 한다 → longform/splitter.js
//     (phase_split.js 이식). API 의 POST /split-script 는 Gemini 기반 + 하한 80자라
//     사용자의 60자 설정을 80자로 바꿔버린다 → 절대 쓰지 않는다.
//  3) 같은 머신이라 API 를 127.0.0.1 로 직통 호출한다.
//  4) 인증: 망고허브 장기 세션 쿠키(LF_SESSION_TOKEN). API 코드 변경 0.
//  5) Cloudflare 프록시 한계 100초 — 장시간 작업은 70초 폴링형으로 자른다.
// ============================================================
import { z } from "zod";
import { autoSplit } from "./splitter.js";
import { CHANNELS, resolveChannel, channelList } from "./channels.js";

const API = (process.env.LF_API_BASE || "http://127.0.0.1:8000/api/longform-v2").replace(/\/$/, "");
const API_V1 = (process.env.LF_API_V1 || "http://127.0.0.1:8000/api/longform").replace(/\/$/, "");
const SESSION = process.env.LF_SESSION_TOKEN || "";
const DEFAULT_MAX_CHARS = Number(process.env.LF_MAX_CHARS || 60);
// 영상 프롬프트는 전 세그먼트에 만들지 않는다 — 영상 생성이 비싸서
// 임팩트 있는 구간만 골라 만든다(사용자 정책 2026-08-06).
const DEFAULT_VIDEO_TARGET = Number(process.env.LF_VIDEO_TARGET || 30);

// ---------- 망고허브 API 호출 ----------
async function api(method, path, body, { base = API, timeout = 600000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        // API 는 쿠키 인증만 받는다(app/dependencies.py). 장기 세션 토큰을 쿠키로 보낸다.
        Cookie: `session_token=${SESSION}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch { data = { _raw: txt.slice(0, 500) }; }
    if (!r.ok) {
      const detail = (data && (data.detail || data._raw)) || r.statusText;
      throw new Error(`${method} ${path} → ${r.status}: ${String(detail).slice(0, 300)}`);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

const ok = (o) => ({ content: [{ type: "text", text: JSON.stringify(o, null, 1) }] });
const err = (m) => ({ content: [{ type: "text", text: `⛔ ${m}` }], isError: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET /projects/{id} 는 ui_prefs / story_analysis 를 JSON 문자열로 줄 수도, 객체로 줄 수도 있다.
// 문자열인 채로 .key 를 읽어서 null 이 나오던 버그가 있었다(2026-08-06).
// 영상 프롬프트를 붙일 세그먼트를 앞에서부터 순서대로 고른다.
// 인포그래픽·타이포·도표 컷은 제외 — 망고허브 _decide_video_mode 와 같은 기준:
//   ① 분석의 infographic_type 이 none 이 아님
//   ② 이미지 프롬프트에 no human / no people / no character 계열 문구가 있음
const _NO_CHAR_KW = ["no human character", "no human", "no people", "no person",
  "no character", "no mascot", "no figure", "empty scene", "no silhouette"];

function pickVideoTargets(segs, scenesByIdx, target) {
  const out = [];
  for (let i = 0; i < segs.length && out.length < target; i++) {
    const sd = scenesByIdx.get(i) || {};
    const itype = String(sd.infographic_type || "none").trim().toLowerCase();
    const ichar = String(sd.infographic_character || "absent").trim().toLowerCase();
    // 순수 정보 시각화(인물 없음)만 제외한다. 인물이 도표를 제시하는 하이브리드는
    // 미세한 제스처 영상이 가능해서 망고허브도 허용한다(_decide_video_mode 와 동일 기준).
    if (itype && itype !== "none" && ichar !== "present") continue;
    const low = String(segs[i].prompt || "").toLowerCase();
    if (_NO_CHAR_KW.some((k) => low.includes(k))) continue;  // 사람 없는 컷 제외
    out.push(i);
  }
  return out;
}

function asObj(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
}

// blogwrite mcp.js 의 buildServer() 안에서 호출한다.
export function registerLongformTools(server) {
  if (!SESSION) {
    console.warn("[longform] LF_SESSION_TOKEN 이 없어 롱폼 도구를 등록하지 않습니다.");
    return 0;
  }

  // ── 1. 채널 브리핑 ────────────────────────────────────────
  // ⚠️ 망고허브가 자기 LLM 에 넣는 것과 '똑같은 재료' 를 원문 그대로 준다.
  //    요약하면 인물 규칙이 빠져 얼굴 없는 마네킹이 나온다(2026-08-06 실측 사고).
  server.tool(
    "lf_channel",
    "채널의 그림체 프리셋 원문 · 호스트 캐릭터 외형 원문 · 시각화 지침을 반환한다. "
    + "대본 작업을 시작할 때 가장 먼저 호출하라.\n"
    + "★여기 나오는 preset.prompt_prefix 와 host_character.appearance_prompt 는 "
    + "망고허브가 이미지 프롬프트를 만들 때 쓰는 것과 동일한 원문이다. 요약하거나 바꾸지 말고 "
    + "그 규칙을 그대로 따라라 — 특히 PEOPLE-DEPICTION RULES(개별 인물은 풀컬러 표정 있는 "
    + "얼굴·피부색·머리 / 배경 군중만 단순 얼굴)를 어기면 인물이 마네킹처럼 나온다.",
    {
      channel: z.string().optional()
        .describe("채널 id 또는 이름. economics / senior-psychology, 또는 '경제와상식사이' / '심리학 돋보기'. 생략하면 목록만."),
    },
    async ({ channel }) => {
      if (!channel) return ok({ channels: channelList(), default_max_chars: DEFAULT_MAX_CHARS });
      const c = resolveChannel(channel);
      if (!c) return err(`모르는 채널: ${channel}. 가능한 값: ${channelList().map((x) => x.id).join(", ")}`);
      try {
        // 프리셋 원문 — 망고허브가 art_prefix / art_suffix 로 넣는 그 값
        let preset = null;
        try {
          const all = await api("GET", "/presets", undefined, { base: API_V1 });
          const list = Array.isArray(all) ? all : (all?.presets || []);
          const p = list.find((x) => String(x.id) === String(c.preset_id));
          if (p) preset = {
            id: p.id, name: p.name,
            prompt_prefix: p.prompt_prefix || "",
            prompt_suffix: p.prompt_suffix || "",
            fixed_style: p.fixed_style || "",
            video_style: p.video_style || "",
          };
        } catch (e) { /* 아래에서 경고로 알린다 */ }

        // 호스트 캐릭터 원문 — 망고허브가 character_profile 로 넣는 그 값
        let host = null;
        if (c.host_character_id) {
          try {
            const cs = await api("GET", "/character-profiles", undefined, { base: API_V1 });
            const arr = Array.isArray(cs) ? cs : (cs?.profiles || cs?.characters || []);
            const h = arr.find((x) => String(x.id) === String(c.host_character_id));
            if (h) host = {
              id: h.id, name: h.name,
              appearance_prompt: h.appearance_prompt || h.description || "",
            };
          } catch (e) { /* 위와 동일 */ }
        }

        return ok({
          channel: c.id, label: c.label,
          preset_id: c.preset_id, viz_guide_id: c.viz_guide_id,
          default_max_chars: DEFAULT_MAX_CHARS,
          tone_note: c.tone_note,

          // ★ 원문 재료 — 요약하지 말고 이 규칙을 따르라
          preset,
          host_character: host,
          host_usage: host
            ? [
                `${host.name} 는 이 채널의 진행자다. appearance_prompt 를 그대로 프롬프트에 전사하라.`,
                "★등장 대상 — '진행자·나레이터·앵커 톤' 컷:",
                "  · 도입부 후크 (첫 2~4컷)",
                "  · 화제가 바뀌는 전환 지점",
                "  · 개념·수치를 설명하거나 정리하는 해설 컷",
                "  · 마무리·결론 (마지막 2~3컷)",
                "  전체의 15~25% 정도. 매 컷 넣으면 지루하고, 없으면 채널 색이 사라진다.",
                "★등장하지 않는 컷 — 대본 속 사건 현장, 일반 인물의 일상, 인포그래픽 단독 컷.",
                "⛔ 대본 속 일반 인물에게 이 외형(둥근 흰 얼굴 등)을 적용하지 마라.",
                "   일반 인물은 프리셋의 PEOPLE-DEPICTION RULES 를 따른다 —",
                "   풀컬러 표정 있는 얼굴 · 피부색 · 스타일링된 머리 · 일상복.",
                "⛔ 스틱맨·코기·실사 사람으로 바꾸지 마라. 다른 마스코트를 등장시키지 마라.",
              ].join("\n")
            : "이 채널에는 등록된 호스트 캐릭터가 없다. 모든 인물은 프리셋의 인물 규칙을 따른다.",
          warning: (!preset || (c.host_character_id && !host))
            ? "재료 일부를 못 읽었다. lf_guide 로 지침 전문을 확인하고, 문제가 계속되면 사용자에게 알려라."
            : undefined,
          next: "lf_create_project 로 프로젝트를 만들어라.",
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 2. 프로젝트 생성 ──────────────────────────────────────
  server.tool(
    "lf_create_project",
    "롱폼 V2 프로젝트를 만든다. channel 만 주면 그림체 프리셋과 시각화 지침이 자동으로 확정된다. "
    + "대본 전문을 함께 저장한다. 반환된 project_id 를 이후 모든 도구에 쓴다.",
    {
      title: z.string().describe("프로젝트 제목 (영상 제목 초안이면 충분)"),
      script: z.string().describe("대본 전문. 원문을 그대로 넣어라 — 요약·수정·줄바꿈 정리 금지."),
      channel: z.string().describe("채널. economics / senior-psychology 또는 '경제와상식사이' / '심리학 돋보기'"),
      topic_description: z.string().optional().describe("주제 한두 문장 설명 (선택)"),
      preset_id: z.string().optional().describe("채널 기본값을 덮어쓸 때만"),
      viz_guide_id: z.number().optional().describe("채널 기본값을 덮어쓸 때만"),
      video_target: z.number().optional()
        .describe("영상 프롬프트를 만들 세그먼트 개수. 기본 30. 영상 생성은 비싸서 전 세그먼트에 만들지 않는다."),
    },
    async ({ title, script, channel, topic_description, preset_id, viz_guide_id, video_target }) => {
      try {
        const c = resolveChannel(channel);
        if (!c) return err(`모르는 채널: ${channel}. 가능한 값: ${channelList().map((x) => x.id).join(", ")}`);
        const presetId = preset_id || c.preset_id;
        const guideId = viz_guide_id || c.viz_guide_id;

        const created = await api("POST", "/projects", {
          title: String(title).slice(0, 250), category: c.id, script: String(script || ""),
        });
        const pid = created?.id ?? created?.project?.id;
        if (!pid) return err(`프로젝트 생성 응답에 id 가 없다: ${JSON.stringify(created).slice(0, 300)}`);

        // 프리셋 전문을 art_style_snapshot 에 박아둔다.
        // 그동안 이 필드가 모든 프로젝트에서 비어 있어서 썸네일 생성기가 그림체를 못 찾고
        // 실사로 뭉개지는 사고가 있었다(2026-08-05). MCP 로 만드는 프로젝트는 처음부터 채운다.
        let snap = null;
        try {
          const all = await api("GET", "/presets", undefined, { base: API_V1 });
          const list = Array.isArray(all) ? all : (all?.presets || []);
          const p = list.find((x) => String(x.id) === String(presetId));
          if (p) snap = {
            id: p.id, name: p.name,
            prompt_prefix: p.prompt_prefix || "", prompt_suffix: p.prompt_suffix || "",
            fixed_style: p.fixed_style || "", fixed_character: p.fixed_character || "",
            fixed_background: p.fixed_background || "", video_style: p.video_style || "",
          };
        } catch (e) { /* 스냅샷은 부가정보 — 실패해도 진행 */ }

        const patch = { viz_guide_id: Number(guideId), art_style_id: presetId };
        if (topic_description) patch.topic_description = topic_description;
        if (snap) patch.art_style_snapshot = snap;
        await api("PATCH", `/projects/${pid}`, patch);

        // 프리셋은 ui_prefs.phase4_preset_id 가 단일 권위다(프런트·썸네일 모두 여기를 본다).
        // 영상 목표 개수도 같이 저장한다 — lf_status / lf_resume 가 완료 판정에 쓴다.
        const vt = Math.max(0, Number(video_target ?? DEFAULT_VIDEO_TARGET));
        const prefsPayload = { phase4_preset_id: presetId, lf_video_target: vt };
        await api("PATCH", `/projects/${pid}/ui-prefs`, { prefs: prefsPayload })
          .catch(async () => { await api("PATCH", `/projects/${pid}/ui-prefs`, prefsPayload); });

        return ok({
          project_id: pid, title, channel: c.id, label: c.label,
          preset_id: presetId, viz_guide_id: guideId,
          art_style_snapshot: snap ? "저장됨" : "프리셋 조회 실패(진행 가능)",
          video_target: Math.max(0, Number(video_target ?? DEFAULT_VIDEO_TARGET)),
          script_chars: String(script || "").length,
          next: `lf_split_and_save({project_id:${pid}}) 로 세그먼트를 나눠라.`,
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 3. 분할 + 저장 ────────────────────────────────────────
  server.tool(
    "lf_split_and_save",
    "대본을 세그먼트로 나눠 저장한다. 망고허브 UI 의 자동분할과 동일한 규칙(문장 경계 유지, "
    + "글자수는 '대략' 목표)을 쓴다. max_chars 기본 60. 분할 결과 요약을 반환한다.",
    {
      project_id: z.number().describe("lf_create_project 가 준 id"),
      max_chars: z.number().optional().describe("세그먼트 목표 글자수. 기본 60. 문장 경계에서 끊으므로 실제 길이는 이 값 근처에서 흔들린다."),
      force: z.boolean().optional()
        .describe("⚠️ 이미 이미지·프롬프트가 있는 프로젝트를 강제로 재분할. 기존 작업물이 전부 삭제된다. 사용자 동의 없이 쓰지 마라."),
    },
    async ({ project_id, max_chars, force }) => {
      try {
        const proj = await api("GET", `/projects/${project_id}`);
        const script = String(proj?.script || "").trim();
        if (!script) return err("프로젝트에 대본이 없다. lf_create_project 에 script 를 넣었는지 확인하라.");
        // ⚠️ 안전장치 (2026-08-06): 재분할은 전 세그먼트를 새로 만든다 —
        //   이미 만든 이미지·영상·오디오·프롬프트가 전부 날아간다.
        //   작업이 들어간 프로젝트에는 force 없이는 실행하지 않는다.
        const cur = Array.isArray(proj?.segments) ? proj.segments : [];
        const hasImg = cur.filter((x) => (x.image_url || "").trim()).length;
        const hasVid = cur.filter((x) => (x.video_url || "").trim()).length;
        const hasAud = cur.filter((x) => (x.audio_url || "").trim()).length;
        const hasPr = cur.filter((x) => (x.prompt || "").trim()).length;
        if (!force && (hasImg || hasVid || hasAud || hasPr)) {
          return err(
            `이 프로젝트에는 이미 작업물이 있다 — 세그먼트 ${cur.length}개 / 이미지 ${hasImg} / `
            + `영상 ${hasVid} / 오디오 ${hasAud} / 프롬프트 ${hasPr}.\n`
            + "재분할하면 전부 사라진다. 그래서 실행하지 않았다.\n"
            + "· 이어서 작업하려면 → lf_resume({project_id:" + project_id + "})\n"
            + "· 정말 처음부터 다시 나누려면 → 사용자에게 '기존 이미지가 전부 삭제된다' 는 점을 "
            + "명확히 알리고 동의를 받은 뒤 force:true 로 다시 호출하라. 임의로 force 를 쓰지 마라."
          );
        }
        const maxC = Number(max_chars || DEFAULT_MAX_CHARS);
        const parts = autoSplit(script, maxC);
        if (!parts.length) return err("분할 결과가 비었다.");
        await api("PUT", `/projects/${project_id}/segments`, {
          segments: parts.map((t) => ({ text: t, prompt: "", status: "pending" })),
        });
        const lens = parts.map((t) => t.length);
        return ok({
          project_id, max_chars: maxC, segments: parts.length,
          length_stats: {
            avg: +(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1),
            min: Math.min(...lens), max: Math.max(...lens),
          },
          first_3: parts.slice(0, 3),
          next: "대본을 직접 읽고 lf_set_analysis 로 장소·인물 레지스트리를 올린 뒤, lf_segments → lf_set_prompts 로 진행하라.",
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 4. 지침·프리셋 원문 (클로드가 읽을 재료) ───────────────
  server.tool(
    "lf_guide",
    "이 프로젝트에 적용된 그림체 프리셋 원문과 시각화 지침 전문을 반환한다. "
    + "이미지·영상 프롬프트를 쓰기 전에 반드시 한 번 읽어라 — 여기 적힌 캐릭터 표준 스펙·"
    + "인물 계층·팔레트·금지 규칙을 따라야 한다.",
    {
      project_id: z.number(),
      part: z.enum(["image", "scene", "both"]).optional()
        .describe("시각화 지침 중 어느 섹션을 볼지. image=이미지/영상 프롬프트 단계용(기본), scene=장면 연출 단계용"),
    },
    async ({ project_id, part }) => {
      try {
        const proj = await api("GET", `/projects/${project_id}`);
        const prefs = asObj(proj?.ui_prefs);
        const presetId = prefs.phase4_preset_id || proj?.art_style_id || null;
        let preset = null;
        if (presetId) {
          const all = await api("GET", "/presets", undefined, { base: API_V1 }).catch(() => []);
          const list = Array.isArray(all) ? all : (all?.presets || []);
          preset = list.find((p) => String(p.id) === String(presetId)) || null;
        }
        let guide = null;
        if (proj?.viz_guide_id) {
          const gs = await api("GET", "/viz-guides").catch(() => []);
          const list = Array.isArray(gs) ? gs : (gs?.guides || gs?.items || []);
          guide = list.find((g) => Number(g.id) === Number(proj.viz_guide_id)) || null;
        }
        const want = part || "image";
        return ok({
          project_id, category: proj?.category || null,
          preset: preset ? {
            id: preset.id, name: preset.name,
            prompt_prefix: preset.prompt_prefix || "",
            prompt_suffix: preset.prompt_suffix || "",
            fixed_style: preset.fixed_style || "",
            video_style: preset.video_style || "",
          } : null,
          viz_guide: guide ? {
            id: guide.id, name: guide.name, description: guide.description || "",
            content_image: (want === "image" || want === "both") ? (guide.content_image || "") : undefined,
            content_scene: (want === "scene" || want === "both") ? (guide.content_scene || "") : undefined,
          } : null,
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 5. 분석 레지스트리 저장 (클로드가 직접 분석) ──────────
  server.tool(
    "lf_set_analysis",
    "네가 대본을 읽고 만든 분석 결과를 프로젝트에 저장한다. 망고허브의 자체 분석(수 분 소요, "
    + "KIE 비용)을 대체한다. 세그먼트 저장 직후 한 번만 호출하라.\n"
    + "여기 올린 장소·인물 레지스트리는 (1) 네가 프롬프트를 쓸 때 일관성 기준이 되고 "
    + "(2) 망고허브의 썸네일 생성기가 그대로 재사용한다. 그래서 반드시 올려야 한다.\n"
    + "★장소·인물 묘사는 영문으로 써라 — 그대로 이미지 프롬프트에 재사용된다.",
    {
      project_id: z.number(),
      plot_summary: z.string().describe("영상 전체를 3~5문장 한국어로. 무엇을 주장하고 어떤 결론으로 가는지."),
      locations: z.array(z.object({
        name: z.string().describe("장소 이름 (한국어). 예: 무너지는 지방 백화점"),
        description: z.string().describe("ENGLISH, 25-45 words. 이 장소의 확정 배경 묘사. 건축·소품·조명·분위기를 구체적으로. 모든 씬에서 이 문구를 재사용한다."),
      })).describe("대본에 등장하는 주요 장소 6~20개. 같은 장소가 여러 씬에 나오면 하나로 통일하라 — 이게 영상의 시각적 일관성을 만든다."),
      characters: z.array(z.object({
        label: z.string().describe("인물 이름/역할 (한국어). 예: 2030 세대 소비자"),
        appearance: z.string().describe("ENGLISH, 20-40 words. 연령대·성별·헤어·의상. 채널의 캐릭터 표준 스펙(4.5등신, 흰 원+검은 점 눈동자)을 전제로 그 위에 얹는 개별 특징만."),
      })).optional().describe("반복 등장 인물 0~6명. 씬마다 외형이 달라지지 않게 여기서 고정한다."),
      scenes: z.array(z.object({
        idx: z.number().describe("세그먼트 인덱스"),
        what: z.string().describe("이 씬에서 무슨 일이 벌어지는지 한국어 한 문장"),
        emotion: z.string().describe("감정 한 단어. 예: 경악, 분노, 뿌듯, 담담"),
        location: z.string().optional().describe("위 locations 의 name 중 하나"),
        infographic_type: z.enum(["none", "comparison", "diagram", "stats", "numbered_list"]).optional()
          .describe("이 세그먼트를 정보 시각화 컷으로 만들 때만 지정. none(기본) / comparison(A vs B 대비) / diagram(단계·원리·구조·플로우) / stats(수치·비중·추세 차트) / numbered_list(N가지·첫째·둘째). ★전체 세그먼트의 약 13% 만 부여하라 — 남발하면 영상이 슬라이드쇼가 된다. 지정한 컷은 영상 프롬프트 대상에서 자동 제외된다."),
        infographic_character: z.enum(["absent", "present"]).optional()
          .describe("인포 컷에 인물이 등장하는지. absent=순수 정보 시각화(사람 없음) / present=호스트나 인물이 도표를 제시하는 하이브리드. 기본 absent."),
      })).optional().describe("세그먼트별 요지. 전부 채우지 않아도 되지만 채우면 프롬프트 품질이 오른다."),
    },
    async ({ project_id, plot_summary, locations, characters, scenes }) => {
      try {
        // 망고허브가 자체 분석에서 쓰는 것과 같은 스키마로 맞춘다 —
        // 썸네일 생성기(_story_digest)가 location_registry / scene_breakdown /
        // anonymous_character_registry / plot_summary 를 읽는다.
        const location_registry = {};
        for (const l of locations || []) {
          const k = String(l.name || "").trim();
          if (k) location_registry[k] = String(l.description || "").trim();
        }
        const story = {
          plot_summary: String(plot_summary || "").trim(),
          location_registry,
          anonymous_character_registry: (characters || []).map((c, i) => ({
            id: `anon_${i}`, label: String(c.label || "").trim(),
            face_description: String(c.appearance || "").trim(),
            default_outfit: "",
          })),
          scene_breakdown: (scenes || []).map((sc) => ({
            index: Number(sc.idx),
            what: String(sc.what || "").trim(),
            emotion: String(sc.emotion || "").trim(),
            location_visual: location_registry[String(sc.location || "")] || "",
            scene_purpose: "",
            // 망고허브 _decide_video_mode 와 같은 키 이름·값 — 인포 씬은 영상 프롬프트 제외.
            // comparison / diagram / stats / numbered_list 4종은 시각화 지침의 분류 그대로다.
            infographic_type: String(sc.infographic_type || "none"),
            infographic_character: String(sc.infographic_character || "absent"),
          })),
          _meta: { source: "claude-mcp", written_at: new Date().toISOString() },
        };
        await api("PATCH", `/projects/${project_id}`, { story_analysis: story });

        // 인포그래픽 비율 검증 — 시각화 지침 기준 약 13%. 넘으면 슬라이드쇼가 된다.
        const proj0 = await api("GET", `/projects/${project_id}`).catch(() => null);
        const segCount = Array.isArray(proj0?.segments) ? proj0.segments.length : 0;
        const infoRows = story.scene_breakdown.filter(
          (x) => String(x.infographic_type || "none") !== "none");
        const byType = {};
        for (const r of infoRows) byType[r.infographic_type] = (byType[r.infographic_type] || 0) + 1;
        const pct = segCount ? Math.round((infoRows.length / segCount) * 100) : 0;

        return ok({
          project_id,
          locations: Object.keys(location_registry).length,
          characters: story.anonymous_character_registry.length,
          scenes: story.scene_breakdown.length,
          infographic: {
            count: infoRows.length, of_segments: segCount, percent: pct,
            by_type: byType,
            idx: infoRows.map((x) => x.index).slice(0, 40),
            note: pct > 20
              ? `⚠️ 인포 컷이 ${pct}% 다. 시각화 지침 기준은 약 13% — 남발하면 영상이 슬라이드쇼가 된다. 꼭 필요한 것만 남기고 다시 올려라.`
              : (pct === 0
                  ? "인포 컷이 하나도 없다. 비교·수치·N가지·단계가 분명한 구간이 있으면 지정하는 게 좋다(약 13%)."
                  : "적정 범위."),
          },
          next: "lf_segments 로 15~20개씩 읽고 프롬프트를 써서 lf_set_prompts 로 올려라.",
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 5b. 망고허브 자체 분석 (선택) ─────────────────────────
  server.tool(
    "lf_run_mangohub_analysis",
    "망고허브의 자체 스토리 분석을 실행한다(수 분 소요, KIE 비용 발생). "
    + "기본 흐름에서는 쓰지 마라 — lf_set_analysis 로 네가 직접 분석한 걸 올리는 게 빠르고 정확하다. "
    + "사용자가 명시적으로 '망고허브 분석 돌려라' 라고 할 때만 호출하라.\n"
    + "⚠️ 한 번 호출에 최대 70초만 기다린다(Cloudflare 프록시 한계). status 가 completed 가 "
    + "아니면 job_id 를 그대로 넣어 다시 호출해 이어서 기다려라.",
    {
      project_id: z.number(),
      job_id: z.string().optional().describe("이어서 기다릴 때만. 처음 호출은 생략."),
    },
    async ({ project_id, job_id }) => {
      try {
        let jobId = job_id;
        if (!jobId) {
          const started = await api("POST", `/projects/${project_id}/analyze-script-async`, {});
          jobId = started?.job_id || started?.jobId;
          if (!jobId) return ok({ note: "동기 완료로 보임", raw: started });
        }
        const limit = 70 * 1000;   // Cloudflare 100초 한계 안쪽
        const t0 = Date.now();
        let last = null;
        while (Date.now() - t0 < limit) {
          await sleep(5000);
          last = await api("GET", `/projects/${project_id}/analyze-script-status/${jobId}`).catch(() => null);
          const st = last?.status;
          if (st === "completed" || st === "done") break;
          if (st === "failed" || st === "error") return err(`분석 실패: ${last?.error || "원인 미상"}`);
        }
        const st = last?.status || "unknown";
        return ok({
          project_id, job_id: jobId, status: st,
          elapsed_sec: Math.round((Date.now() - t0) / 1000),
          next: (st === "completed" || st === "done")
            ? "완료. lf_segments 로 진행하라."
            : `아직 진행 중 — lf_run_mangohub_analysis({project_id:${project_id},job_id:"${jobId}"}) 로 다시 호출해 이어서 기다려라.`,
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 6. 세그먼트 읽기 (배치) ───────────────────────────────
  server.tool(
    "lf_segments",
    "세그먼트를 범위로 읽는다. 프롬프트를 쓸 때 10~20개씩 나눠 읽고 처리하라. "
    + "with_analysis=true 면 해당 구간의 스토리 분석(장소·감정·목적)도 함께 준다.",
    {
      project_id: z.number(),
      from: z.number().optional().describe("시작 idx (0부터). 기본 0"),
      count: z.number().optional().describe("몇 개 읽을지. 기본 30, 최대 80. ★25~30개를 권장한다 — 배치가 커지면 뒤로 갈수록 프롬프트가 짧아지고 한글 라벨·캐릭터 외형이 뭉개진다(실측)."),
      with_analysis: z.boolean().optional().describe("스토리 분석의 해당 씬 정보 포함 여부"),
      only_missing: z.boolean().optional()
        .describe("true 면 프롬프트가 아직 비어 있는 세그먼트만 골라 준다. 이어서 작업할 때 쓰면 이미 채운 걸 다시 읽지 않아 토큰을 아낀다."),
    },
    async ({ project_id, from, count, with_analysis, only_missing }) => {
      try {
        const proj = await api("GET", `/projects/${project_id}`);
        const segs = Array.isArray(proj?.segments) ? proj.segments : [];
        const a = Math.max(0, Number(from || 0));
        const n = Math.min(80, Math.max(1, Number(count || 30)));
        const sa = asObj(proj?.story_analysis);
        const sb = Array.isArray(sa?.scene_breakdown) ? sa.scene_breakdown : [];
        // only_missing: 프롬프트가 비어 있는 것만 앞에서부터 n개
        let picked;
        if (only_missing) {
          picked = segs
            .map((s, i) => ({ s, i }))
            .filter(({ s, i }) => i >= a && !(s.prompt || "").trim())
            .slice(0, n);
        } else {
          picked = segs.slice(a, a + n).map((s, k) => ({ s, i: a + k }));
        }
        const items = picked.map(({ s, i: idx }) => {
          const row = {
            idx, text: s.text || "",
            has_image_prompt: !!(s.prompt || "").trim(),
            has_video_prompt: !!(s.video_prompt || "").trim(),
          };
          if (with_analysis) {
            const sc = sb.find((x) => Number(x?.index) === idx);
            if (sc) row.analysis = {
              what: sc.what || "", emotion: sc.emotion || "",
              scene_purpose: sc.scene_purpose || "", who: sc.who || "",
              location: sc.location_visual || sc.location || "",
            };
          }
          return row;
        });
        return ok({
          project_id, total_segments: segs.length, returned: items.length,
          quality_warning: n > 35
            ? `${n}개를 한 번에 받았다. 세그먼트당 주의가 얕아지기 쉽다 — 개별 인물의 풀컬러 얼굴, `
              + "호스트 appearance_prompt 전사, 한글 라벨을 빠뜨리지 않았는지 마지막에 다시 확인하라. "
              + "다음 배치는 35개로 줄이는 것을 권한다."
            : undefined,
          idx_range: items.length ? [items[0].idx, items[items.length - 1].idx] : [],
          items,
          locations_available: sa?.location_registry ? Object.keys(sa.location_registry) : [],
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 7. 프롬프트 업로드 ────────────────────────────────────
  server.tool(
    "lf_set_prompts",
    "세그먼트별 이미지 프롬프트(image_prompt)와 영상 프롬프트(video_prompt)를 저장한다. "
    + "10~20개씩 배치로 올려라. 보낸 idx 만 갱신하고 나머지는 건드리지 않는다. "
    + "이미지 프롬프트는 영문, 시각화 지침과 프리셋을 따라 작성하라.",
    {
      project_id: z.number(),
      items: z.array(z.object({
        idx: z.number().describe("세그먼트 인덱스 (0부터)"),
        image_prompt: z.string().optional().describe("영문 이미지 생성 프롬프트"),
        video_prompt: z.string().optional().describe("영문 영상(모션) 프롬프트"),
        negative: z.string().optional().describe("네거티브 프롬프트 (선택)"),
      })).describe("갱신할 세그먼트 배열"),
    },
    async ({ project_id, items }) => {
      try {
        if (!items?.length) return err("items 가 비었다.");
        const proj = await api("GET", `/projects/${project_id}`);
        const segs = Array.isArray(proj?.segments) ? proj.segments : [];
        if (!segs.length) return err("세그먼트가 없다. lf_split_and_save 를 먼저 실행하라.");
        const bad = items.map((x) => Number(x.idx)).filter((i) => i < 0 || i >= segs.length);
        if (bad.length) return err(`범위를 벗어난 idx: ${bad.join(",")} (전체 ${segs.length}개)`);

        // ⚠️ 2026-08-06: 예전에는 PUT /segments 로 전체 배열을 교체했다.
        //   그 엔드포인트는 내부에서 전 row 를 DELETE 후 재삽입한다 — 페이로드에 빠진 필드가
        //   있으면 이미지·영상·오디오가 날아갈 수 있는 구조다(실제 과거 사고 이력 있음).
        //   지금은 보낸 세그먼트만 PATCH 한다. 다른 세그먼트와 다른 필드는 손도 대지 않는다.
        // 세그먼트 50~80개를 순차로 PATCH 하면 왕복만 수 초 쌓인다 → 8개씩 병렬.
        // 각 PATCH 는 독립 커밋이라 중간에 끊겨도 그때까지 저장된 것은 남는다.
        let done = 0;
        const fails = [];
        const jobs = items.map((it) => {
          const seg = segs[Number(it.idx)];
          if (!seg?.id) { fails.push(`idx ${it.idx}: DB id 없음`); return null; }
          const body = {};
          if (it.image_prompt !== undefined) body.prompt = it.image_prompt;
          if (it.video_prompt !== undefined) body.video_prompt = it.video_prompt;
          if (it.negative !== undefined) body.negative = it.negative;
          if (!Object.keys(body).length) return null;
          return { idx: it.idx, id: seg.id, body };
        }).filter(Boolean);

        for (let k = 0; k < jobs.length; k += 8) {
          await Promise.all(jobs.slice(k, k + 8).map(async (j) => {
            try {
              await api("PATCH", `/projects/${project_id}/segments/${j.id}`, j.body);
              done++;
            } catch (e) { fails.push(`idx ${j.idx}: ${String(e.message || e).slice(0, 80)}`); }
          }));
        }
        // ── 품질 검사 ──
        // 지시만으로는 규칙이 빠진다(실측: 8장 중 4장에 영어 라벨). 서버가 확인해 되돌려준다.
        const checked = items.filter((it) => (it.image_prompt || "").trim());
        const noEngGuard = /no english text|no latin lettering|hangul only/i;
        const missGuard = checked.filter((it) => !noEngGuard.test(it.image_prompt)).map((it) => it.idx);
        const risky = checked.filter((it) =>
          /\b(map|chart|graph|signboard|sign|document|screen|billboard|scoreboard|label)\b/i
            .test(it.image_prompt) && !/hangul|한글|korean text|korean label/i.test(it.image_prompt)
        ).map((it) => it.idx);
        const words = checked.map((it) => String(it.image_prompt).trim().split(/\s+/).length);
        const shortOnes = checked.filter((_, i) => words[i] < 45).map((it) => it.idx);
        // 배치 뒷부분이 앞부분보다 뚜렷하게 짧아졌는지 (품질 저하 신호)
        let decay;
        if (words.length >= 10) {
          const h = Math.floor(words.length / 2);
          const a = words.slice(0, h).reduce((x, y) => x + y, 0) / h;
          const b = words.slice(h).reduce((x, y) => x + y, 0) / (words.length - h);
          if (b < a * 0.75) decay = `앞 절반 평균 ${a.toFixed(0)}단어 → 뒤 절반 ${b.toFixed(0)}단어. `
            + "뒤로 갈수록 짧아졌다 — 뒤쪽 세그먼트를 다시 써라.";
        }

        const after = await api("GET", `/projects/${project_id}`);
        const aSegs = Array.isArray(after?.segments) ? after.segments : [];
        return ok({
          project_id, updated: done,
          failed: fails.length ? fails : undefined,
          quality: {
            avg_words: words.length ? Math.round(words.reduce((x, y) => x + y, 0) / words.length) : 0,
            missing_english_guard: missGuard.length ? missGuard : undefined,
            english_guard_note: missGuard.length
              ? "이 idx 들에 영어 억제 네거티브가 없다. 이미지 모델이 지도·차트 라벨을 영어로 그린다. "
                + "'no English text, no Latin lettering, no romanized words; any text in frame is Korean hangul only' "
                + "를 붙여 다시 올려라."
              : undefined,
            text_surface_without_hangul: risky.length ? risky : undefined,
            text_surface_note: risky.length
              ? "지도·차트·표지판·서류 같은 글자 표면이 있는데 한글 지정이 없다. 한글 라벨을 명시하거나 라벨을 빼라."
              : undefined,
            too_short: shortOnes.length ? shortOnes : undefined,
            decay,
          },
          filled_image: aSegs.filter((x) => (x.prompt || "").trim()).length,
          filled_video: aSegs.filter((x) => (x.video_prompt || "").trim()).length,
          images_intact: aSegs.filter((x) => (x.image_url || "").trim()).length,
          total: aSegs.length,
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 7b. 이어하기 (새 대화에서 첫 호출) ────────────────────
  server.tool(
    "lf_resume",
    "중단된 프로젝트를 새 대화에서 이어받는다. 프로젝트를 새로 만들지 말고 이걸 먼저 불러라.\n"
    + "★인수 없이 그냥 호출해도 된다 — MCP 로 시작했고 아직 안 끝난 프로젝트를 알아서 찾는다. "
    + "사용자가 망고허브에서 직접 만든 프로젝트는 자동 대상에서 제외한다(건드리면 안 되므로). "
    + "사용자가 '이어서 해줘' 라고만 하면 lf_resume({}) 를 부르면 된다. "
    + "번호를 물어보지 마라.\n"
    + "★대본을 다시 붙여넣을 필요가 없다 — 대본·세그먼트·분석은 이미 망고허브에 저장돼 있다.\n"
    + "이 도구 하나로 (1) 채널 스타일 브리핑 (2) 확정된 장소·인물 레지스트리 "
    + "(3) 어디부터 이어야 하는지 를 전부 받는다. 받은 뒤 바로 "
    + "lf_segments({only_missing:true}) → lf_set_prompts 반복으로 들어가라.",
    {
      project_id: z.number().optional().describe("아는 경우에만. 모르면 비워라 — 자동으로 찾는다."),
      title: z.string().optional().describe("제목 일부로 찾을 때. 예: 'tsmc', '대만'"),
      recent: z.boolean().optional().describe("true 면 이어받지 않고 최근 프로젝트 목록만 본다"),
      include_manual: z.boolean().optional()
        .describe("기본은 MCP 로 시작한 프로젝트만 자동 대상이다. 사용자가 '망고허브에서 직접 만든 것도 이어달라' 고 명시할 때만 true."),
    },
    async ({ project_id, title, recent, include_manual }) => {
      try {
        // project_id 를 모를 때 — 사용자에게 번호를 묻지 않고 직접 찾는다.
        if (recent || !project_id) {
          const list = await api("GET", "/projects");
          let arr = Array.isArray(list) ? list : (list?.projects || list?.items || []);
          // 목록은 segments 를 주지 않는다(segment_count 만). 상세는 따로 받아야 한다.
          if (title) {
            const q = String(title).toLowerCase().trim();
            const hit = arr.filter((p) => String(p.title || "").toLowerCase().includes(q));
            if (!hit.length) {
              return err(`제목에 '${title}' 이 들어간 프로젝트가 없다. 최근 목록: `
                + arr.slice(0, 8).map((p) => `${p.id} ${p.title}`).join(" / "));
            }
            arr = hit;
          }
          const cands = arr.filter((p) => Number(p.segment_count || 0) > 0).slice(0, 8);
          if (!cands.length) {
            return ok({
              note: "세그먼트가 있는 프로젝트가 없다. 새 대본이면 lf_create_project 로 시작하라.",
              projects: arr.slice(0, 8).map((p) => ({ project_id: p.id, title: p.title })),
            });
          }
          // 후보별 진행률을 병렬로 확인 (최대 8건)
          const detail = await Promise.all(cands.map(async (p) => {
            try {
              const d = await api("GET", `/projects/${p.id}`);
              const sg = Array.isArray(d?.segments) ? d.segments : [];
              const sa2 = asObj(d?.story_analysis);
              // MCP 로 시작한 프로젝트만 자동으로 이어받는다.
              // lf_set_analysis 가 _meta.source='claude-mcp' 를 남긴다.
              // 사용자가 망고허브에서 직접 만든 프로젝트를 건드리지 않기 위한 표식이다.
              const byMcp = String(asObj(sa2._meta).source || "") === "claude-mcp";
              const vt2 = Number(asObj(d?.ui_prefs).lf_video_target ?? DEFAULT_VIDEO_TARGET);
              const map2 = new Map((Array.isArray(sa2.scene_breakdown) ? sa2.scene_breakdown : [])
                .map((x) => [Number(x?.index), x]));
              const mi = sg.filter((x) => !(x.prompt || "").trim()).length;
              const vp = pickVideoTargets(sg, map2, vt2)
                .filter((i) => !(sg[i].video_prompt || "").trim()).length;
              return { p, segments: sg.length, missing_image: mi, video_todo: vp,
                       by_mcp: byMcp,
                       images: sg.filter((x) => (x.image_url || "").trim()).length,
                       done: mi === 0 && vp === 0 };
            } catch { return { p, error: true }; }
          }));
          // 자동 대상 = MCP 로 시작했고 아직 안 끝난 것만.
          const todo = detail.filter((x) => !x.error && !x.done && (x.by_mcp || include_manual));
          const manualSkipped = detail.filter((x) => !x.error && !x.done && !x.by_mcp && !include_manual);

          if (recent) {
            return ok({
              projects: detail.map((x) => ({
                project_id: x.p.id, title: x.p.title, category: x.p.category,
                segments: x.segments, missing_image: x.missing_image,
                video_todo: x.video_todo, done: x.done, updated_at: x.p.updated_at,
              })),
            });
          }
          if (!todo.length) {
            return ok({
              note: manualSkipped.length
                ? "MCP 로 시작한 미완료 프로젝트가 없다. 아래는 사용자가 망고허브에서 직접 작업 중인 "
                  + "프로젝트라 자동으로 건드리지 않았다. 사용자가 명시적으로 지정하면 project_id 로 호출하라."
                : "안 끝난 프로젝트가 없다. 전부 채워져 있다.",
              manual_in_progress: manualSkipped.map((x) => ({
                project_id: x.p.id, title: x.p.title, segments: x.segments,
                images: x.images, missing_image: x.missing_image,
              })),
              projects: detail.map((x) => ({ project_id: x.p.id, title: x.p.title, done: x.done })),
            });
          }
          if (todo.length > 1) {
            return ok({
              note: "MCP 로 시작한 미완료 프로젝트가 여러 개다. 사용자에게 어느 것인지 물어보고 project_id 로 다시 호출하라.",
              manual_skipped: manualSkipped.map((x) => `${x.p.id} ${x.p.title}`),
              candidates: todo.map((x) => ({
                project_id: x.p.id, title: x.p.title, category: x.p.category,
                segments: x.segments, missing_image: x.missing_image, video_todo: x.video_todo,
                updated_at: x.p.updated_at,
              })),
            });
          }
          project_id = todo[0].p.id;   // 하나뿐이면 그대로 이어받는다
        }
        const proj = await api("GET", `/projects/${project_id}`);
        const segs = Array.isArray(proj?.segments) ? proj.segments : [];
        const sa = asObj(proj?.story_analysis);
        const prefs = asObj(proj?.ui_prefs);
        const ch = resolveChannel(proj?.category);
        const missImg = segs.map((x, i) => ((x.prompt || "").trim() ? null : i)).filter((x) => x !== null);
        const vidIdx = segs.map((x, i) => ((x.video_prompt || "").trim() ? i : null)).filter((x) => x !== null);
        const vt = Number(prefs.lf_video_target ?? DEFAULT_VIDEO_TARGET);
        const sbMap = new Map((Array.isArray(sa.scene_breakdown) ? sa.scene_breakdown : [])
          .map((x) => [Number(x?.index), x]));
        const pickTodo = pickVideoTargets(segs, sbMap, vt)
          .filter((i) => !(segs[i].video_prompt || "").trim());

        return ok({
          project_id, title: proj?.title,
          note: `프로젝트 ${project_id} — ${proj?.title}. 다음부터는 "${project_id} 이어서" 라고 해도 된다.`,
          channel: proj?.category, label: ch?.label || null,
          preset_id: prefs.phase4_preset_id || proj?.art_style_id || null,
          viz_guide_id: proj?.viz_guide_id || null,

          // 프롬프트를 쓰는 데 필요한 전부 — 대본 재전달 불필요
          tone_note: ch?.tone_note || "",
          reload_materials: "프리셋·호스트 캐릭터 원문이 필요하면 lf_channel({channel:'"
            + String(proj?.category || "") + "'}) 를 한 번 더 불러라.",
          plot_summary: sa.plot_summary || "",
          location_registry: sa.location_registry || {},
          characters: sa.anonymous_character_registry || [],

          progress: {
            segments: segs.length,
            image_done: segs.length - missImg.length,
            missing_image_count: missImg.length,
            next_batch_from: missImg.length ? missImg[0] : null,
            // 영상은 목표 개수만 채운다(전 세그먼트 아님).
            video_target: vt,
            video_done: vidIdx.length,
            video_pick_idx: pickTodo,        // 여기 있는 idx 에만 영상 프롬프트를 쓴다
            video_remaining: pickTodo.length,
          },
          next: missImg.length
            ? `lf_segments({project_id:${project_id}, from:${missImg[0]}, count:20, with_analysis:true, only_missing:true}) 로 이미지 프롬프트를 이어서 채워라.`
            : (pickTodo.length
                ? `이미지는 끝났다. video_pick_idx 의 세그먼트 ${pickTodo.length}개에 영상 프롬프트를 써라: ${pickTodo.slice(0, 30).join(",")}`
                : "이미 전부 채워져 있다. 사용자에게 완료를 알려라."),
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  // ── 8. 진행 현황 ──────────────────────────────────────────
  server.tool(
    "lf_status",
    "프로젝트 진행 현황을 반환한다. 프롬프트가 몇 개 채워졌는지, 빠진 idx 가 어디인지 알려준다. "
    + "작업을 끝내기 전에 호출해서 빠진 게 없는지 확인하라.",
    { project_id: z.number() },
    async ({ project_id }) => {
      try {
        const proj = await api("GET", `/projects/${project_id}`);
        const segs = Array.isArray(proj?.segments) ? proj.segments : [];
        const missImg = segs.map((s, i) => ((s.prompt || "").trim() ? null : i)).filter((x) => x !== null);
        const vidIdx = segs.map((s, i) => ((s.video_prompt || "").trim() ? i : null)).filter((x) => x !== null);
        const sa = asObj(proj?.story_analysis);
        const vt = Number(asObj(proj?.ui_prefs).lf_video_target ?? DEFAULT_VIDEO_TARGET);
        const sbMap = new Map((Array.isArray(sa.scene_breakdown) ? sa.scene_breakdown : [])
          .map((x) => [Number(x?.index), x]));
        const picks = pickVideoTargets(segs, sbMap, vt);
        const pickTodo = picks.filter((i) => !(segs[i].video_prompt || "").trim());
        return ok({
          project_id, title: proj?.title, category: proj?.category,
          viz_guide_id: proj?.viz_guide_id || null,
          preset_id: asObj(proj?.ui_prefs).phase4_preset_id || proj?.art_style_id || null,
          segments: segs.length,
          story_analysis: sa ? "있음" : "없음",
          // ── 이미지: 전 세그먼트 필수 ──
          image_prompts: segs.length - missImg.length,
          // 200개 프로젝트에서 전체 목록을 뿌리면 응답이 터진다 → 앞 20개 + 개수만.
          missing_image_idx: missImg.slice(0, 20),
          missing_image_count: missImg.length,
          next_batch_from: missImg.length ? missImg[0] : null,

          // ── 영상: 목표 개수만 (전 세그먼트 아님) ──
          video_target: vt,
          video_prompts: vidIdx.length,
          video_idx: vidIdx,                 // 이미 붙인 위치
          // 앞에서부터 순서대로 고른 대상. 인포·타이포·도표 컷은 자동 제외됐다.
          // 여기 있는 idx 에만 영상 프롬프트를 쓰면 된다 — 직접 고르려 하지 마라.
          video_pick_idx: pickTodo,
          video_remaining: pickTodo.length,
          done: missImg.length === 0 && pickTodo.length === 0,
        });
      } catch (e) { return err(String(e.message || e)); }
    }
  );

  return 10;
}
