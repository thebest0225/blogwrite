# blogwrite — 블로그 오토라이터

클로드로 쓴 원본 글을 **블로거 메인 / 네이버 / 워드프레스** 3종으로 재가공(디자인·정보 보강·썸네일·링크)하는 도구.

## 구성
- `extension/` — 크롬 확장 (현재 동작 버전, v0.2). 모든 로직의 원본.
- `server/` — **서버 웹앱 전환용 백엔드 + 핸드오프 문서**. 서버에서 실행/수정하려면 여기부터.
- `블로그자동화_크롬확장_기획서.md`, `글작성_유형별_공식.md` — 기획/작성 공식.

## 서버 웹앱으로 쓰려면 (권장)
1. `server/README_핸드오프.md` 를 읽고 그대로 진행 (서버의 Claude Code가 이어서 완성 가능).
2. 요약:
   ```
   cd server && npm install
   cp .env.example .env   # KIE 키 등 입력
   npm start              # http://localhost:3000
   ```
3. 프론트(`server/public/`)는 `extension/` 로직을 포팅해 완성 (핸드오프 문서에 지시 있음).

## 크롬 확장으로 바로 쓰려면
- `chrome://extensions` → 개발자 모드 → 압축해제 로드 → `extension/` 선택
- 자세히: `extension/설치_및_테스트.md`

## 주의
- API 키/`.env`/기록 파일은 `.gitignore`로 제외됨. 절대 커밋하지 말 것.
