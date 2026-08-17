# 네이버 초안 재작성 인수 — 남은 29건

## 무엇을 하는 작업인가

네이버 블로그(망고아빠) 미발행 초안 35건을 새 기준으로 다시 쓴다. 6건은 끝났고 29건 남았다.

원래 문제 — 35건이 전부 `안녕하세요! 망고아빠입니다.` 로 시작하고 대다수가
`댓글 남겨주세요` 로 끝났다. 규칙이 인사말을 강제해서 생긴 획일성이다.
목표는 정보 전달이 아니라 **CTR · 체류시간 · 완독 · 자연스러운 댓글 유도**다.

## 절대 하지 말 것 (이걸 어기면 작업 전체가 무효다)

1. **독자 반응을 지어내지 마라.** `댓글이 많았어요` `질문이 자주 와요` `문의가 많아서`
   전부 금지다. 실제로 후쿠오카 초안에 없던 댓글을 지어낸 사고가 있었고 사용자가 잡아냈다.
   검증기가 오류로 막지만 애초에 쓰지 마라.
2. **없는 일화를 만들지 마라.** 플레이북 `[실제 경험 자산]` 섹션에 있는 것만 1인칭 일화로
   쓸 수 있다. 목록에 없는 주제(사료 성분·용품 비교·야간 산책 등)는 일화 대신
   `찾아보다 제일 헷갈렸던 게 이 부분이었어요` 같은 '찾아보면서 느낀 점' 으로 쓴다.
3. **본문 중간의 확인된 사실·수치·표를 바꾸지 마라.** 이 작업은 도입부·마무리·소제목을
   고치는 것이다. 사실 관계를 새로 조사해 바꾸는 게 아니다.
4. **제목을 바꾸지 마라.** 색인이 걸려 있을 수 있다.

## 지침은 DB 에 있다 — 반드시 먼저 읽어라

```bash
cd /var/www/mangoabba/blogwrite/server
node -e "import('./db.js').then(d=>{
  const pb=d.getPlaybook(1,'naver');
  import('./playbook.js').then(m=>console.log(m.renderPlaybook(pb)));
})"
```

특히 이 섹션들을 그대로 따른다 —
`[도입부 설계]` `[본문 전개와 체류 장치]` `[제목 만드는 법]` `[구조 규칙]` `[실제 경험 자산]`

## 각 초안에 해야 할 일

### ① 도입부 4단으로 다시 쓴다
```
[① 실제 상황 2줄 이상]   구체적인 장면. '~에 대해 알아보겠습니다' 예고 금지
[② 문제 제기]            그런데 왜 다를까 / 왜 안 될까
[③ 작성자 반응]          저도 처음엔 이렇게 알고 있었습니다
[④ 궁금증 연결]          결론을 도입부에서 다 말하지 않는다
[사진1 · 태그]
캡션: …
망고아빠입니다.          ← 인사는 여기. 첫 줄에 두지 마라
———
```

### ② 마무리를 독자 질문으로 바꾼다
`요약 → 핵심 다시 강조 → 독자 경험을 묻는 질문` 순서.
`댓글 남겨주세요` `다음 글에선 ~ 정리해볼게요` 로 끝내지 마라.
질문은 독자가 자기 경험을 말하고 싶어지는 것으로. 예 —
`우리 아이는 어느 쪽이었나요?` `이 방법 말고 다른 걸로 해결하신 분 있나요?`

### ③ 소제목
- 경험형은 3~4개로 통합, 정보형은 5~7개 유지
- **문장형으로 쓴다.** 명사로 끝나는 게 절반 넘으면 검증기가 경고한다
  - ✕ 렌터카 규정 / 주의사항 / 신청 방법
  - ○ 숙소보다 렌터카가 먼저입니다 / 여기서 대부분 순서를 틀립니다

### ④ 정보형은 경험을 확인한다
정보형은 절차가 뼈대고 경험이 그 안에 박혀야 한다. 1인칭 표지가 2회 이하인 글은
`[실제 경험 자산]` 범위에서 보강한다. 자산에 없으면 '찾아보면서 느낀 점' 으로.

### ⑤ 검증기가 잡는 나머지
표 2열 → 3열(실제 정보로 열 추가) / 표에 수치 없으면 금액·크기·개수·기한 넣기 /
사진 2~3개 / 분량 밴드(경험형 1,300~2,000 · 정보형 1,700~2,600)

## 도구

### 패치 적용
```bash
python3 /tmp/claude-1000/-home-mangoabba/97804b1a-046a-4347-b89d-611a25f9fe0d/scratchpad/patch.py <패치.json>
```
패치 JSON 형식 —
```json
[{"id":"초안id",
  "intro":"메타줄 뒤부터 첫 소제목 전까지 교체할 도입부 전체",
  "outro":"마무리 표식부터 함께보면좋은글 전까지 교체할 마무리",
  "renames":{"옛 소제목":"새 소제목"},
  "drop_heads":["없앨 소제목"]}]
```
`drop_heads` 는 소제목 줄만 지운다 = 아래 문단이 위 섹션에 흡수된다(통합).
표·사진 추가 같은 건 patch.py 로 안 되니 별도 node 스크립트로 `drafts.content` 를 직접 고친다.

### 검증 (한 건)
```bash
cd /var/www/mangoabba/blogwrite/server
node -e "
const D=require('better-sqlite3'),db=new D('blogwrite.db',{readonly:true});
Promise.all([import('./playbook.js'),import('./db.js')]).then(([m,DB])=>{
  const allowed=m.allowedLinksFrom(DB.getPlaybook(1,'naver').sections.find(s=>s.section==='links').body)
    .concat(DB.naverPublishedLinks(1).map(r=>r.url));
  const r=db.prepare('select title,content from drafts where id=?').get('초안id');
  const v=m.validateNaverDraft({title:r.title,content:r.content,allowedLinks:allowed});
  console.log(v.ok?'통과':'실패', JSON.stringify(v.stats));
  v.errors.forEach(e=>console.log(' ✗',e)); v.warns.forEach(w=>console.log(' △',w));
});"
```

### 전체 진행률
```bash
cd /var/www/mangoabba/blogwrite/server
node -e "
const D=require('better-sqlite3'),db=new D('blogwrite.db',{readonly:true});
Promise.all([import('./playbook.js'),import('./db.js')]).then(([m,DB])=>{
  const allowed=m.allowedLinksFrom(DB.getPlaybook(1,'naver').sections.find(s=>s.section==='links').body)
    .concat(DB.naverPublishedLinks(1).map(r=>r.url));
  const rows=db.prepare(\"select id,title,content from drafts where content like '%## 썸네일%'\").all();
  let ok=0,clean=0; const rest=[];
  for(const r of rows){
    const v=m.validateNaverDraft({title:r.title,content:r.content,allowedLinks:allowed});
    if(v.ok)ok++; if(v.ok&&!v.warns.length)clean++; else rest.push(r.id+' '+r.title.slice(0,30));
  }
  console.log('오류없음',ok,'/ 완전통과',clean,'/ 35');
  rest.forEach(x=>console.log('  남음',x));
});"
```

## 끝났다고 판단하는 기준

35건 전부 **오류 0 · 경고 0**. 경고까지 없어야 한다.
`△ 표에 수치가 없습니다` 같은 경고도 실제로 수치를 넣어 해소한다.
해소할 수 없는 경고가 있으면 그 초안 id 와 이유를 보고에 남긴다.

## 완료 후

1. 진행률 스크립트로 최종 확인
2. `cd /var/www/mangoabba/blogwrite && git add -A && git commit` (커밋 메시지는 무엇을 왜
   바꿨는지, 겪은 문제를 적는다. 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`)
3. 보고 — 몇 건 처리했는지, 지어내기 없이 경험을 채운 방법, 해소 못 한 경고

## 작업 완료 기록 (2026-08-14)

35건 전부 오류 0 · 경고 0. 이후 루틴이 새로 만든 5건까지 합쳐 **40건 전부 통과**.

무엇을 했나
- 29건 도입부를 4단(상황→문제제기→작성자 반응→궁금증 연결)으로 다시 씀.
  고정 인사말은 대표 사진 뒤 한 줄로 내림.
- 마무리를 전부 '요약 → 핵심 강조 → 독자 경험을 묻는 질문' 으로 교체.
  `댓글 남겨주세요` · `다음엔 ~ 정리해볼게요` 전량 제거.
- 경험형 소제목을 3~4개로 통합(`drop_heads` 로 소제목 줄만 삭제해 문단을 위 섹션에 흡수),
  명사로 끝나는 소제목을 문장형으로 바꿈.
- 2열 표 6개를 3열로 재구성(열은 본문에 이미 있는 정보로만 만듦),
  수치 없는 표에 본문에 나온 숫자를 넣음(1~2일 · 48시간 · 3초 · 10kg 등).
- 사진 2개 미달·중복 번호 정리, 하단 '함께 보면 좋은 글' 표식 누락 3건 복구.
- 도쿄·재입국·눈물자국은 마무리가 하단 링크 **뒤**에 있어 검증기가 마무리를 못 읽었다.
  마무리를 링크 앞으로 옮겼다.

경험을 어떻게 채웠나 (지어내지 않고)
- 1인칭 일화는 플레이북 `[실제 경험 자산]`(타임 렌터카 전화·셀프세차·취소 수수료·
  셀프검역 3개국)과 확정 사실(12~13.5kg·2017.10생·목표 12.2kg·1일 3산책·물 좋아함·
  이중모·시흥 정왕동)에서만 가져왔다.
- 자산에 없는 주제(사료·용품·야간 산책 등)는 일화 대신
  `찾아보다 제일 헷갈렸던 게 이 부분이었어요` 식으로 썼다.
- 초안 본문에 이미 있던 경험(망고 새벽 공복토·젤 매트 물어뜯음 등)은 도입부에서
  같은 사건으로만 다시 썼다. 새 사건을 만들지 않았다.
- 독자 반응 문구는 전량 삭제했다 — 푸켓 `유독 많이 물어보세요`,
  후쿠오카 `오키나와 다녀온 글에…`, 보홀 `묻는 분이 많더라고요`,
  재입국 `지금도 들어오는 댓글 대부분이…`, 세부·식욕부진 `많으시죠`.
- 실종 글에 있던 '배곧 산책 중 시야에서 사라진 날' 은 자산에 없는 지어낸 장면이라
  `이름표는 걸리거나 풀리면 그걸로 끝이더라고요` 로 바꿨다.

## 이미 끝난 6건 (참고용 — 톤을 여기에 맞춰라)

`dmspizyre31ae4a` 발 씻기 · `dmspwekx6837fd5` 귀 청소 · `dmsq1zx2a4e0a40` 물그릇
`dmsq20vah925cb5` 털빠짐 · `dmsq611i4ab4fa1` 물놀이 · `dmsq620sz5cdaf1` 역재채기

이 중 하나를 읽어 도입부·마무리·소제목 톤을 먼저 파악하고 시작하라.

## 검증에서 추가로 잡은 것 (2026-08-14)

재작성 결과를 검증하다 **한 사건이 도시별로 이식된 것**을 찾았다.

경험 자산의 '숙소를 먼저 잡아 취소 수수료를 문 일' 은 일본에서 렌터카 체중 제한에
걸려 생긴 **한 번의 사건**인데, 7개 글에 퍼져 있었다.

| 글 | 상태 |
|---|---|
| 오키나와 | 원 사건 — 그대로 |
| 후쿠오카 | `처음 일본 여행 준비할 때` — 이미 정직 |
| 오사카 · 보홀 · 짐싸기 | `예전에 문 적이 있다` 과거 참조 — 그대로 |
| **푸켓 · 도쿄** | **그 도시에서 일어난 일처럼 읽힘 → 수정** |

수정 —
· 푸켓 `이건 푸켓이 아니라 일본에서 겪은 일이에요`
· 도쿄 `도쿄 얘기는 아니고, 앞서 일본 다른 지역에서`
  마무리의 `도쿄에서 제일 잘한 선택이었어요` 도 근거 없는 단정이라 완화

**교훈** — 한 사건을 여러 곳에서 겪은 것처럼 쓰는 건 지어낸 댓글과 같은 종류의 문제다.
경험 자산이 적을수록 이 압력이 커진다. 자산에 없는 도시의 글에서는 기존 사건을
**출처를 밝히고 인용**해야지, 그 도시의 경험으로 승격시키면 안 된다.
검증기 정규식으로는 못 잡는다 — 같은 일화가 몇 건에 쓰였는지 세어보는 게 유일한 방법이다.

```bash
# 일화 재사용 점검
cd /var/www/mangoabba/blogwrite/server
node -e "
const D=require('better-sqlite3'),db=new D('blogwrite.db',{readonly:true});
for(const r of db.prepare(\"select title,content from drafts where content like '%## 썸네일%'\").all()){
  const m=r.content.match(/[^\n]{0,50}(취소 수수료|셀프세차|배상하겠|전화로만)[^\n]{0,60}/g);
  if(m){ console.log('── '+r.title.slice(0,40)); m.forEach(x=>console.log('   '+x.trim())); }
}"
```

## 2차 수정 (2026-08-17) — 발행 안 한 28건만

사용자 지적 — "아직 자연스럽지 못하다. 애로사항을 자꾸 애로로 줄이고, 도입부가 본문과
연결이 안 되고, 결국 AI 느낌이 나고, 제목이 클릭하고 싶어지지 않는다."

측정해보니 전부 **내 규칙이 만든 틀**이었다.

| 틀 | 빈도 | 원인 |
|---|---|---|
| `정리하면` 으로 마무리 시작 | **35/40** | 예시를 그대로 베낌 |
| `아직 남은 애로사항은` | **10/40** | [편집 원칙] 이 그 단어를 요구 |
| 제목에 클릭 장치 없음 | **33/40** | 강제하지 않아서 |
| `그 뒤로 순서를 바꿨어요` | 4/40 | 경험 자산 인용 틀 |

인사말 35건 획일화와 **같은 실수를 반복**했다. 규칙이 요소를 강제하면 그 요소가
똑같은 문장으로 굳는다. 한 건만 검사해서는 절대 안 보인다.

### 새로 생긴 안전장치
`crossDraftRepeats(drafts, limit)` — 초안 전체를 가로질러 같은 상투구가 몇 건에
나오는지 센다. 첫 문장·마지막 문장 중복도 잡는다(목록에 없는 새 틀도 걸린다).
```bash
cd /var/www/mangoabba/blogwrite/server
node -e "
const D=require('better-sqlite3'),db=new D('blogwrite.db',{readonly:true});
import('./playbook.js').then(m=>{
  const rows=db.prepare(\"select id,title,content from drafts where content like '%## 썸네일%'\").all();
  m.crossDraftRepeats(rows).forEach(r=>console.log(r.n+'/'+r.total+'  '+r.name));
});"
```

### 검증기에 추가된 것
- 틀 5종 경고 (아직 애로 / 정리하면 / 세 줄 요약 예고 / 예고형 도입부 닫기 / 그 뒤로 순서를)
- **제목 장치 없으면 오류** — 말줄임표·직접인용·질문형·반전·금지·비교 중 하나 필수

### 대상
`UNPUBLISHED_IDS.txt` 의 28건만. **이미 발행한 12건은 건드리지 마라** —
초안을 고쳐도 네이버에 올라간 글은 안 바뀌므로 헛수고이고, 발행본과 초안이 어긋난다.
