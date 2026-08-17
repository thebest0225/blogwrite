# 내용 보강 — 부실한 10건

## 문제

사용자 지적 — "내용도 졸라 부실한 게 많던데".
실측: 재입국 검역 글이 2,023자인데 구체적인 값은 `0.5IU` **하나뿐**이었다.
나머지는 전부 이렇게 넘어갔다.

```
항체가 검사는 결과까지 몇 주 걸릴 수 있어요        ← 몇 주?
출국 일정에서 넉넉히 역산해                        ← 며칠?
나라마다 유효기간이 달라요                          ← 어떻게 다른데?
검역본부 누리집에서 검색하면 나와요                 ← 그 값이 이 글에 있어야 한다
```

**그 자리가 독자가 찾아온 이유다.** 지어내기를 막으려고 '확인 못 한 값은 찾는 방법을 준다'
고 지침에 써놨더니, 안 찾고 넘기는 걸 허용해버렸다.

## 대상

`THIN_IDS.txt` 의 10건. **다른 초안은 건드리지 마라.**

## 할 일 — 값을 찾아서 채운다

1. **웹검색으로 실제 값을 확인해 넣어라.** 금액·기간·크기·기준값·온도·횟수.
   ```
   ✕ 항체가 검사는 결과까지 몇 주 걸릴 수 있어요
   ○ 항체가 결과는 보통 2~3주, 기관에 따라 4주까지 걸립니다
   ✕ 나라마다 유효기간이 달라요
   ○ 일본은 채혈 후 180일 대기, 태국·필리핀은 대기 기간이 없습니다
   ```

2. **출처는 글 안에서 이름으로 밝혀라. ★링크는 절대 걸지 마라.**
   남의 사이트로 내보낼 이유가 없다. 검증기도 외부 링크를 오류로 막는다.
   ```
   ○ 농림축산검역본부 기준으로 / 대한항공 규정상 / 공단 안내에 따르면
   ✕ 자세한 건 https://…
   ```
   확인이 필요하면 '검역본부 콜센터에 물어보면' 처럼 **이름만** 알려준다.

3. **못 찾은 값은 지어내지 마라.** 확인 못 했다고 밝히고 넘어간다.
   지어내는 것과 안 찾는 것은 다르다 — 지어내면 거짓, 안 찾으면 빈 글.

4. 값이 늘면 분량이 는다. **깊이 표기(`깊이:` 줄)를 실제에 맞게 올려라.**
   가볍게 600~1,500 / 보통 1,200~2,400 / 깊게 1,700~3,600 / 아주 깊게 3,000~9,000

## 건드리지 말 것

- 제목 (이미 클릭 장치를 넣어 고쳤다)
- 도입부 4단 구조·마무리 질문 (이미 고쳤다)
- 망고 경험 서술 — 경험 자산에 없는 일화를 새로 만들지 마라
- 독자 반응 지어내기

## 검증

```bash
cd /var/www/mangoabba/blogwrite/server
node -e "
const D=require('better-sqlite3'),db=new D('blogwrite.db',{readonly:true});
Promise.all([import('./playbook.js'),import('./db.js')]).then(([m,DB])=>{
  const allowed=m.allowedLinksFrom(DB.getPlaybook(1,'naver').sections.find(s=>s.section==='links').body)
    .concat(DB.naverPublishedLinks(1).map(r=>r.url));
  const ids=require('fs').readFileSync('/var/www/mangoabba/blogwrite/THIN_IDS.txt','utf8').trim().split('\n');
  const q=db.prepare('select id,title,content from drafts where id=?');
  let clean=0;
  for(const id of ids){ const r=q.get(id);
    const v=m.validateNaverDraft({title:r.title,content:r.content,allowedLinks:allowed});
    if(v.ok&&!v.warns.length)clean++; else console.log(r.title.slice(0,30)+' :: '+[...v.errors,...v.warns].join(' | ').slice(0,110));
  }
  console.log('완전통과 '+clean+'/'+ids.length);
});"
```

10건 전부 **오류 0 · 경고 0** 이면 끝. 특히 `구체적인 수치가 N개뿐입니다` 경고가
사라져야 한다 — 소제목 수보다 수치가 많아야 한다.

수정 도구는 `REWRITE_BRIEF.md` 참고(patch.py / node 직접 수정).
끝나면 git commit 하고, 어떤 값을 어디서 확인해 넣었는지 보고하라.
