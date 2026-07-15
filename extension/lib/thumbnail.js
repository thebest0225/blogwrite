// 썸네일 텍스트 오버레이 생성기 (캔버스)
// AI가 뽑은 배경 이미지 위에, 애드센스/유튜브식 고대비 볼드 텍스트를 덧씌운다.
// - AI 이미지 모델은 한글을 못 쓰므로 텍스트는 여기서 그림.
// - KIE 이미지 URL은 CORS가 없을 수 있어 fetch→blob→ImageBitmap 으로 로드(호스트 권한으로 우회).

export async function composeThumbnail({ imageUrl, text, accent = "#ff2d55", aspect = "16:9" }) {
  const [aw, ah] = (aspect || "16:9").split(":").map(Number);
  let W = 1280, H = 720;
  if (aw && ah) {
    if (aw >= ah) { W = 1280; H = Math.round(1280 * ah / aw); }
    else { H = 1280; W = Math.round(1280 * aw / ah); }
  }
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");

  // 배경 이미지 (cover)
  const bmp = await loadBitmap(imageUrl);
  drawCover(ctx, bmp, W, H);

  // 상단 어둠 그라데이션(텍스트 가독성) — 하단은 블로그에서 잘리므로 텍스트를 위로
  const g = ctx.createLinearGradient(0, 0, 0, H * 0.6);
  g.addColorStop(0, "rgba(0,0,0,0.88)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  // 텍스트 준비 (3~5단어 권장, 최대 2줄)
  const clean = (text || "").trim().replace(/\s+/g, " ");
  const padX = 70;
  const padTop = 64;
  const maxWidth = W - padX * 2;
  const { size, lines } = fitText(ctx, clean, maxWidth, 2);

  const lineH = size * 1.15;
  const totalH = lineH * lines.length;
  let y = padTop + size; // 상단 정렬(첫 줄 baseline)

  // 액센트 바(텍스트 좌측, 상단)
  ctx.fillStyle = accent;
  ctx.fillRect(padX, padTop, 16, totalH - (lineH - size));

  const textX = padX + 34;
  ctx.textBaseline = "alphabetic";
  ctx.font = `900 ${size}px 'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif`;
  ctx.lineJoin = "round";
  for (const line of lines) {
    // 외곽선
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = Math.max(6, size * 0.11);
    ctx.strokeText(line, textX, y);
    // 본문
    ctx.fillStyle = "#ffffff";
    ctx.fillText(line, textX, y);
    y += lineH;
  }

  return canvas.toDataURL("image/jpeg", 0.9);
}

async function loadBitmap(url) {
  // 이미 dataURL이면 그대로 사용
  if (url.startsWith("data:")) {
    const res = await fetch(url);
    return await createImageBitmap(await res.blob());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error("이미지 로드 실패");
  return await createImageBitmap(await res.blob());
}

function drawCover(ctx, bmp, W, H) {
  const r = Math.max(W / bmp.width, H / bmp.height);
  const w = bmp.width * r, h = bmp.height * r;
  ctx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
}

function fitText(ctx, text, maxWidth, maxLines) {
  for (let size = 104; size >= 44; size -= 4) {
    ctx.font = `900 ${size}px 'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif`;
    const lines = wrap(ctx, text, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
  }
  ctx.font = `900 44px 'Malgun Gothic',sans-serif`;
  return { size: 44, lines: wrap(ctx, text, maxWidth).slice(0, maxLines) };
}

function wrap(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (ctx.measureText(t).width <= maxWidth) {
      cur = t;
    } else {
      if (cur) lines.push(cur);
      if (ctx.measureText(w).width > maxWidth) {
        // 한 단어가 너무 길면 글자 단위로 끊기
        let c = "";
        for (const ch of w) {
          if (ctx.measureText(c + ch).width <= maxWidth) c += ch;
          else { if (c) lines.push(c); c = ch; }
        }
        cur = c;
      } else {
        cur = w;
      }
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
