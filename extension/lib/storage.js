// 설정 저장/불러오기 (chrome.storage.local)
// API 키 등 민감정보는 여기서만 관리.

// GPT Image-2용 기본 썸네일 스타일 지시(첨부 예시 같은 한국 클릭베이트 스타일)
export const DEFAULT_THUMB_STYLE =
`Korean YouTube-style clickbait thumbnail, 16:9 aspect ratio. Cinematic, high-contrast dramatic lighting with a moody atmospheric background that fits the article's actual topic. Big HEAVY bold Korean sans-serif headline with a thick black-and-white outline, placed in the TOP area (top-left or top-right) with the bottom third kept clear/empty (blog thumbnails crop the bottom); the Korean text must be large and PERFECTLY, CORRECTLY spelled. Clean, premium, instantly readable even at small mobile size. Do NOT add cartoon mascots, stock-market graphs, arrows, national flags, or finance/economics elements. The imagery should visually match the real subject of the article.`;

export const CHAT_MODELS = [
  { id: "claude-sonnet-5", label: "Claude Sonnet 5 (기본·빠름)" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 (고품질·느림)" }
];

export const DEFAULTS = {
  kieApiKey: "",
  kieChatModel: "claude-sonnet-5",         // KIE 마켓 Claude 모델
  kieImageModel: "gpt-image-2-text-to-image",
  imageResolution: "1K",                    // 1K | 2K | 4K
  thumbnailAspect: "16:9",                  // 썸네일 비율: 16:9 | 1:1 | 4:3
  naverClientId: "",
  naverClientSecret: "",
  // 워드프레스 REST (기존 글 대량 개선 / 직접 발행 / 내부링크)
  wpSite: "",                               // 예: https://example.com
  wpUser: "",
  wpAppPassword: "",                        // 워드프레스 응용프로그램 비밀번호
  internalLinks: false,                     // 내부링크 자동 연결
  groundingEnabled: true,                   // 네이버 검색으로 사실 보강(무료)
  linkMode: "search",                       // 링크 처리: search(검색결과로 안전) | model(모델 URL 사용)
  myBlogUrl: "",                            // 내 수익 블로그 주소(우선 링크·유입 대상). 예: https://blog.example.com
  sheetApiUrl: "",                          // 구글 시트 Apps Script 웹앱 URL (작업 기록/보관함 클라우드)
  sheetToken: "",                           // (선택) Apps Script 비밀 토큰
  sheetViewUrl: "",                         // (선택) 구글 시트 보기 URL(전체 목록 관리용)
  // 애드센스 광고 자동 삽입
  adEnabled: false,
  adCode: "",                               // 광고 유닛 HTML 코드
  defaultPlatform: "wordpress",             // wordpress | blogger
  defaultTone: "친근하고 신뢰감 있는",
  defaultAudience: "관련 정보를 처음 찾아보는 일반 독자",
  authorBio: "",                            // E-E-A-T 저자 소개 (글 하단 삽입)
  generateImages: true,                     // 이미지 생성 기본 ON
  imageCount: 1,                            // 이미지 개수 기본 1 (썸네일만)
  // 썸네일 방식: ai_full(GPT Image-2가 한글까지 통짜 생성) | overlay(AI배경+캔버스 텍스트) | off
  thumbnailMode: "ai_full",
  thumbnailStylePrompt: DEFAULT_THUMB_STYLE,
  overlayAccent: "#ff2d55"                  // overlay 모드 액센트 색
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}
