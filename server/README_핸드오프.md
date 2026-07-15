# 블로그 오토라이터 — 서버 웹앱 전환 핸드오프

> 이 문서는 **서버에 설치된 Claude Code가 읽고 이어서 완성**하도록 쓴 지시서입니다.
> 지금까지 크롬 확장으로 만들었고, 이제 **브라우저 웹앱 + Node 백엔드**로 옮깁니다.

---

## 0. 한 줄 요약
크롬 확장(`../extension/`)의 로직을 재사용해, **Node/Express 백엔드(제공됨: `server.js`) + 프론트 웹앱(`public/`, 이제 만들어야 함)** 으로 전환한다. 백엔드가 KIE·네이버·구글트렌드·워드프레스 API를 프록시하고 기록을 저장하며, 프론트는 same-origin `/api/*` 만 호출한다(CORS·API키 노출 없음).

## 1. 이 프로그램이 하는 일 (제품 개요)
사용자가 **claude.ai(웹서치 O)로 정확한 원본 글**을 써서 붙여넣으면, 이 툴이 **3종으로 재가공**한다:
- **블로거 메인**: 원형 + 정보 보강 + 디자인(표/카드/썸네일). 광고 붙는 최종 목적지 글.
- **네이버 / 워드프레스**: 유입용 "쿠션 글". 링크 절반은 블로거 메인으로(유입), 절반은 공식 출처. 상단에 클릭 유도 버튼카드 다수. 플랫폼별 톤 다름(네이버=친근 구어체, WP=정돈된 정보성).
정확도는 claude.ai 원본이 책임지고, 이 툴은 **디자인·보강·변형·썸네일·링크·저장**을 담당.

## 2. 현재 상태 (크롬 확장 v0.2, `../extension/`)
- 동작함: 원본 붙여넣기 → 모드(블로거/네이버/WP) → 생성(KIE Claude) → 블록 JSON → HTML 조립 → 썸네일(GPT Image-2 + 캔버스 텍스트 오버레이) → 링크 스마트 연결 → **HTML 복사** / WP REST 발행.
- 부가: 🔥 트렌드(구글 급상승, 6h 캐시), 🔗 내 글 보관함(발행/입력 시 저장, 링크 걸 때 우선 사용), 이미지 다시생성/부분수정.
- 저장: 로컬(chrome.storage) + 선택적 외부(구글시트/서버). → **웹앱에선 서버 저장으로 일원화.**

## 3. 재사용 맵 (extension/lib → 웹앱)
| 파일 | 처리 |
|------|------|
| `extension/lib/prompts.js` | **프론트로 복사**(순수 JS). buildBloggerMain / buildCushionPrompt 사용 → system/user 만들어 `/api/chat` 로 POST |
| `extension/lib/html-builder.js` | **프론트로 복사**(순수 JS). buildHtml/buildPreviewDoc/smartLink 그대로 |
| `extension/lib/thumbnail.js` | **프론트로 복사**(브라우저 canvas 필요) |
| `extension/lib/kie.js` | 폐기 → 백엔드 `/api/chat`,`/api/image`,`/api/image-edit` 로 대체(이미 server.js에 있음) |
| `extension/lib/keywords.js` | 폐기 → 백엔드 `/api/keywords` (CORS 때문에 서버가 호출) |
| `extension/lib/naver.js` | 폐기 → 백엔드 `/api/naver-search`, `/api/trends` |
| `extension/lib/trends.js` | 폐기 → 백엔드 `/api/trends` |
| `extension/lib/wordpress-api.js` | 발행은 `/api/wp`. 내블로그 검색(Blogger 피드)은 프론트에서 직접 fetch 가능(같은출처 아님이라 CORS 주의 → 필요시 `/api/myblog-search` 추가) |
| `extension/lib/storage.js`,`history.js`,`cloud.js` | 폐기 → 서버 `/api/store` (records.json) + `/api/config`. 설정값(tone/authorBio/adCode/thumbnailStylePrompt/overlayAccent/linkMode/myBlogUrl 등)은 `/api/settings`(GET/POST, settings.json) 새로 만들어 관리 |
| `extension/sidepanel/*` | **`public/index.html` + `public/app.js` + `public/styles.css` 로 포팅**. chrome.* 제거, KIE 직접호출 → `/api/*` fetch 로 교체, chrome.tabs("📍 현재") 기능은 제거 |

## 4. 백엔드 (제공됨 · server.js) — 엔드포인트
- `POST /api/chat` `{system,user,maxTokens,model}` → `{content}`
- `POST /api/image` `{prompt,aspect,resolution}` → `{url}`
- `POST /api/image-edit` `{imageUrl,prompt,aspect,resolution}` → `{url}`
- `GET  /api/keywords?seed=` → `{keywords:[]}`
- `GET  /api/trends[?force=1]` → `{ts,items:[{title}]}`
- `GET  /api/naver-search?q=` → `{items:[{kind,title,link}]}`
- `POST /api/wp` `{title,content,status}` → `{id,link}`
- `GET/POST /api/store` → 기록/보관함(records.json)
- `GET  /api/config` → `{wpEnabled,naverEnabled}`
- 정적: `public/` 서빙 (프론트)
- **추가로 만들 것**: `GET/POST /api/settings`(settings.json) — 비민감 설정 저장.

## 5. 서버 Claude Code가 할 작업 (체크리스트)
1. `server/` 에서 `npm install` → `.env.example` 복사해 `.env` 채우기(KIE 키 등).
2. `node server.js` 로 백엔드 뜨는지 확인 (http://localhost:3000, `/api/trends` 응답 확인).
3. `server/public/` 생성 후 **프론트 포팅**:
   - `extension/lib/{prompts,html-builder,thumbnail}.js` → `public/lib/` 로 복사(그대로 사용).
   - `extension/sidepanel/sidepanel.html/css/js` → `public/index.html / styles.css / app.js` 로 이식.
   - app.js에서 교체:
     - `getSettings()`(chrome.storage) → `/api/settings` fetch (or 기본값).
     - `chatComplete()` → `fetch('/api/chat',{POST})`.
     - `generateImage()/editImage()` → `/api/image`,`/api/image-edit`.
     - `expandKeywords()` → `/api/keywords?seed=`.
     - `getTrends()` → `/api/trends`.
     - 내 글 보관함(getMyPosts/addMyPost) → `/api/store` (type:"post" 필터).
     - 발행 기록(cloudAdd article) → `/api/store` (type:"article").
     - `wpCreatePost()` → `/api/wp`.
     - **삭제**: chrome.tabs("📍 현재 탭 저장") — 웹앱 불가. 대신 "URL 직접 입력/붙여넣기" 유지.
     - `navigator.clipboard.writeText`(HTML 복사) — 웹앱에서 그대로 동작(https 또는 localhost).
   - 썸네일 캔버스(thumbnail.js)는 브라우저에서 그대로 동작.
4. `/api/settings`(settings.json) 구현 + 설정 화면(옵션) 이식(API 키 항목은 서버 .env로 갔으니 프론트 설정엔 비민감 값만).
5. 링크 로직(smartLink)·상단 링크카드 강제삽입(ensureTopLinkcard)·이미지 개수/비율/모드별 톤 — 확장 app 로직 그대로 유지.
6. (선택) 내 블로그 검색: Blogger 피드는 CORS 가능성 있어 `/api/myblog-search?url=&q=` 백엔드 추가 권장.
7. 접속 보안: 내부서버면 방화벽/사내망. 외부 노출 시 간단 로그인(basic auth) 추가 검토.

## 6. 참고: 로직 세부는 확장 코드가 정답
- 프롬프트 규칙/유형/썸네일 스타일/링크 라우팅/톤 차별화/쿠션 상단버튼 등 **모든 로직은 `../extension/` 에 이미 구현**돼 있음. 그대로 옮기면 됨.
- KIE API 형식: `docs.kie.ai`. Claude=`/claude/v1/messages`(stream:false), 이미지=`/api/v1/jobs/createTask`+`/api/v1/jobs/recordInfo`.

---

## 7. 사용자(업로드/실행) 안내
아래는 **사람이** 서버에서 하는 절차입니다.

### A. 파일 업로드
1. 이 `server/` 폴더와 `extension/` 폴더를 **서버로 업로드** (git, scp, rsync 등 편한 방법).
   - `extension/` 은 로직 참고·복사용으로 함께 올리는 게 좋음.
2. 서버에서 해당 위치로 이동.

### B. 서버의 Claude Code에게 이렇게 요청 (복붙용)
```
이 저장소의 server/README_핸드오프.md 를 읽고, 크롬 확장(extension/)을 Node 웹앱으로 전환해줘.
server.js 백엔드는 이미 있으니 npm install 후 .env 채워 실행되게 하고,
extension/sidepanel + extension/lib(prompts/html-builder/thumbnail)를 server/public 으로 포팅해서
브라우저에서 http://서버:3000 으로 쓸 수 있는 웹앱으로 완성해줘.
chrome.* 의존은 /api/* 호출로 바꾸고, 로직(프롬프트·링크·썸네일·톤·상단버튼)은 확장 그대로 유지해.
```

### C. 실행/접속
1. `cd server && npm install`
2. `cp .env.example .env` → `.env` 에 KIE 키 등 입력
3. `npm start` → 콘솔에 `http://localhost:3000`
4. 브라우저에서 `http://서버주소:3000` 접속 → 사용
   (외부 접속하려면 방화벽/포트 개방 또는 리버스 프록시(nginx) 설정)

### D. 이후 수정
- 서버의 Claude Code로 코드 수정 → `npm start` 재기동(또는 `npm run dev` 로 자동 재시작).
