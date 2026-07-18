// 오구온라인 니치 블로그들을 블로그라이터 '목적지'로 등록/동기화 (user_id=1)
// 실행: OGU_APP_PW="xxxx xxxx ..." node register_ogu_dest.js
import * as DB from "./db.js";

const USER = parseInt(process.env.OGU_USER_ID || "1", 10);
const APP_PW = process.env.OGU_APP_PW || "";
const WP_USER = process.env.OGU_WP_USER || "oguadmin";

const NICHES = [
  { slug: "benefit", name: "오구:혜택노트",       topics: "정부지원금 환급 복지 바우처 보조금 지원금 신청 혜택 연말정산 국민연금 건강보험", persona: "정부지원·환급 혜택을 발굴해 쉽게 안내하는 혜택헌터" },
  { slug: "ott",     name: "오구:오늘 뭐 볼까",   topics: "드라마 영화 넷플릭스 OTT 티빙 디즈니 예능 방영 정주행 배우 시청 왓챠 쿠팡플레이 개봉 극장 시리즈 출연 시즌 캐스팅 감독 관람", persona: "OTT·드라마를 큐레이션하는 콘텐츠 덕후" },
  { slug: "money",   name: "오구:알뜰살뜰",       topics: "절약 재테크 통신비 카드 적금 예금 요금 공과금 구독료 생활경제 짠테크 할인 금리 대출 주식 부동산 물가 세금 월급 보험 청약 연말정산", persona: "생활 속 절약·재테크를 실전으로 알려주는 짠테크마스터" },
  { slug: "pet",     name: "오구:초보 집사",      topics: "강아지 고양이 반려동물 반려견 반려묘 사료 산책 배변 훈련 집사 펫 예방접종 건강", persona: "강아지·고양이를 함께 키우는 다년차 집사" },
  { slug: "apptip",  name: "오구:폰꿀팁",         topics: "스마트폰 아이폰 안드로이드 앱 카카오톡 유튜브 엑셀 크롬 설정 꿀팁 기능 오류", persona: "스마트폰·앱 숨은 기능을 쉽게 알려주는 IT 도우미" },
  { slug: "soft",    name: "오구:다운로드 가이드", topics: "다운로드 프로그램 설치 무료 압축 반디집 곰플레이어 뷰어 브라우저 소프트웨어 캡처", persona: "필수 프로그램을 안전하게 설치하도록 돕는 소프트웨어 안내자" },
  { slug: "trend",   name: "오구:지금 이슈",       topics: "이슈 화제 실시간 트렌드 뉴스 논란 밈 신제품 검색어 사건", persona: "지금 화제인 이슈를 빠르게 정리하는 트렌드 캐처" },
];

if (!APP_PW) { console.error("OGU_APP_PW 환경변수 필요"); process.exit(1); }

let n = 0;
for (const it of NICHES) {
  DB.upsertDestination(USER, {
    id: "ogu_" + it.slug,
    name: it.name,
    platform: "wordpress",
    role: "destination",
    site_url: "https://" + it.slug + ".oguonline.com",
    topics: it.topics,
    persona: it.persona,
    creds: { user: WP_USER, appPassword: APP_PW },
    is_default: false,
  });
  n++;
  console.log("등록:", it.name, "→ https://" + it.slug + ".oguonline.com");
}
console.log("완료:", n, "개 목적지 동기화 (user", USER + ")");
