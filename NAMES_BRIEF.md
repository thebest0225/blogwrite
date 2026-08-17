# 실제 이름 채우기 — 장소를 약속한 글 3건

## 문제

사용자 지적 —
> 제목은 '일본 도쿄 반려견 동반 숙소 ｜ 중형견도 되는 곳 찾는 법' 인데 동반 가능한 숙소를
> 찾아서 대여섯 개 제공해주면 신뢰도가 올라가고 사람들이 좋아할 정보가 될 텐데
> 그냥 숙소 찾는 법만 써놨다. 이러면 다른 도시·다른 국가 글이랑 무슨 차별성이 있나.

실측 — 장소를 약속한 글 10건 중 **8건이 실제 이름 0개**였다.
표 머리글이 전부 `숙소 유형` `방식` 이다. **유형은 독자가 이미 안다. 모르는 건 '그래서 어디' 다.**

원인은 내가 쓴 규칙의 구멍이었다 —
`'안 된다' 를 쓸 때마다 대안·가능 목록·판별법을 붙인다` 에서 **판별법을 목록의 대체물로 허용**했다.
그래서 "이렇게 걸러요" 로 끝내고 통과했다. 지금은 규칙을 고쳤다.

## 대상 (`NAMES_IDS.txt`)

| 글 | 지금 표 |
|---|---|
| 일본 도쿄 반려견 동반 숙소 | `숙소 유형 / 중형견 가능성 / 예약 전 확인할 것` |
| 필리핀 보홀 반려견 동반 | `숙소 유형 / 반려동물 조건 / 추가 요금 / 확인 방법` |
| 여름 휴가철 강아지 맡기기 | `방식 / 환경 / 이런 아이에게 / 대략 비용(1일)` |

## 할 일

**유형 표를 이름 표로 바꾼다.** 5~6곳을 실제 이름으로.

```
✕ 펫 전용 객실 호텔 | 되지만 10kg 안팎 제한 많음 | 전화로 체중 먼저
○ 시나가와 프린스 호텔 | 10kg 이하 · 1박 3,300엔 추가 | 전화 예약만
```

각 행에 **이름 · 조건(체중·크기 제한) · 비용 · 예약 방법**을 붙인다.
`찾는 법` 은 목록 **다음에** 온다 — 내가 못 찾은 곳을 독자가 스스로 찾을 때 쓰는 도구다.

`강아지 맡기기` 는 업체 이름을 대기 어려우면(전국 체인이 아니라 동네 업소)
**펫호텔 체인·플랫폼 이름**(등록 확인 가능한 것)과 비용·확인 방법으로 채운다.
동물보호법상 동물위탁관리업 등록 여부를 국가동물보호정보시스템에서 확인할 수 있다는 게 실용 정보다.

## 반드시 지킬 것

1. **WebSearch 로 실제로 확인한 곳만 쓴다.** 있는지 없는지 모르는 숙소 이름을 만들면
   독자가 예약하러 갔다가 없는 걸 발견한다. 그건 지어낸 댓글보다 나쁘다.
2. **확인한 값만 쓴다.** 체중 제한·추가 요금을 못 찾았으면 그 칸은 '확인 필요' 로 두고
   추측값을 넣지 마라. 표에 빈 칸은 오류이니 '문의 필요' 처럼 사실을 적는다.
3. **외부 링크 금지.** 출처는 이름으로만 (`○○ 공식 안내 기준`).
4. 제목·도입부·마무리·망고 경험은 건드리지 마라.
5. 분량이 늘면 맨 위 `깊이:` 줄을 올려라.
6. 못 찾은 곳이 많아 5곳을 못 채우면, **채운 만큼만 쓰고 몇 곳인지 밝혀라.**
   억지로 숫자를 맞추려고 만들지 마라.

## 검증

```bash
cd /var/www/mangoabba/blogwrite/server
node -e "
const D=require('better-sqlite3'),db=new D('blogwrite.db',{readonly:true});
Promise.all([import('./playbook.js'),import('./db.js')]).then(([m,DB])=>{
  const allowed=m.allowedLinksFrom(DB.getPlaybook(1,'naver').sections.find(s=>s.section==='links').body)
    .concat(DB.naverPublishedLinks(1).map(r=>r.url));
  const ids=require('fs').readFileSync('/var/www/mangoabba/blogwrite/NAMES_IDS.txt','utf8').trim().split('\n');
  const q=db.prepare('select id,title,content from drafts where id=?');
  for(const id of ids){ const r=q.get(id);
    const v=m.validateNaverDraft({title:r.title,content:r.content,allowedLinks:allowed});
    console.log((v.ok&&!v.warns.length?'○':'✗')+' '+r.title.slice(0,30)+' '+[...v.errors,...v.warns].join('|').slice(0,90));
  }
});"
```
3건 전부 오류 0 · 경고 0. `유형별 분류` 경고가 사라져야 한다.
도구는 `REWRITE_BRIEF.md` 참고.
