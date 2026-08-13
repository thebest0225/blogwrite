// ============================================================
// 채널(카테고리) 매핑 — 프리셋 · 시각화지침 · 호스트 캐릭터
//
// ⚠️ 2026-08-06 재작성. 이전 버전은 그림체·인물 규칙을 내가 손으로 요약해서 넣었다.
//    그 요약이 사고를 냈다 —
//      · 썸네일용 '밈 캐릭터 스펙'(둥근 흰 얼굴·점 눈동자·코·귀 없음)을 본문 인물 전체에
//        적용해서, 대본 속 일반 인물이 전부 얼굴 없는 마네킹으로 나왔다.
//      · 프리셋 원문의 PEOPLE-DEPICTION RULES(개별 인물 = 풀컬러 표정 있는 얼굴 ·
//        피부색 · 스타일링된 머리 / 배경 군중만 단순 얼굴)를 덮어써 버렸다.
//    → 요약을 만들지 않는다. 망고허브가 자기 LLM 에 주입하는 것과 똑같은 재료
//      (프리셋 prompt_prefix/suffix 원문 + 호스트 캐릭터 appearance_prompt 원문 +
//       시각화 지침 content_image)를 lf_channel 이 그대로 실어 보낸다.
//    여기 남기는 건 '어느 재료를 쓸지' 매핑과 채널 톤 메모뿐이다.
// ============================================================

export const CHANNELS = {
  economics: {
    label: "경제와상식사이",
    preset_id: "poomgyeok-life",
    viz_guide_id: 11,
    // 진행자·해설 톤 컷에 등장하는 채널 호스트. 외형은 등록 프로필이 단일 권위다.
    host_character_id: "mascot_sangsik",
    tone_note: [
      "코믹 과장을 허용한다. 경악·분노·뿌듯 등 표정을 크게 밀어도 된다.",
      "메타포 중심 — 씬의 핵심 메시지를 한 장의 강한 시각 비유로. 거대화 / 좌우대비 /",
      "무너짐·돌파 / 발견 / 규모비교 다섯 패턴. 텅 빈 풍경 단독 금지.",
      "인포그래픽은 비교·수치·N가지·단계가 분명할 때만(전체의 약 13%). 남발 금지.",
      "이미지 내 텍스트는 한글만. 큰 제목 배너·매거진 레이아웃 금지.",
    ].join("\n"),
  },

  "senior-psychology": {
    label: "심리학 돋보기 (품격라이프)",
    preset_id: "poomgyeok-lifestyle",
    viz_guide_id: 10,
    host_character_id: null,
    tone_note: [
      "중후한 절제 톤. 과장 리액션·비명 표정 금지. 화사하고 가볍고 귀여우면 실패.",
      "낮은 키 조명, 방향성 있는 빛, 액센트는 따뜻한 황동/호박색 하나뿐.",
      "teal-and-orange 시네마 그레이딩 금지.",
      "배경 행인·군중을 55~70% 씬에 적극 배치 — 메인과의 퀄리티 격차가 화면을 고급스럽게 만든다.",
      "폭발·파편 스펙터클 금지. 균열은 조용하고 얇게.",
    ].join("\n"),
  },
};

const ALIASES = {
  "경제와상식사이": "economics", "경제": "economics", "경제상식": "economics",
  "심리학 돋보기": "senior-psychology", "심리학돋보기": "senior-psychology",
  "품격라이프": "senior-psychology", "품격": "senior-psychology",
};

export function resolveChannel(input) {
  const k = String(input || "").trim();
  if (CHANNELS[k]) return { id: k, ...CHANNELS[k] };
  const alias = ALIASES[k] || ALIASES[k.replace(/\s+/g, "")];
  if (alias) return { id: alias, ...CHANNELS[alias] };
  return null;
}

export function channelList() {
  return Object.entries(CHANNELS).map(([id, c]) => ({
    id, label: c.label, preset_id: c.preset_id, viz_guide_id: c.viz_guide_id,
  }));
}
