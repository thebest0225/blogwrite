// 텔레그램 알림 (망고허브 봇 재사용). 설정은 blogwrite settings에 저장.
// 이벤트: draft(초안도착) / generate(목적지생성) / publish(발행) / schedule(예약실행) / error(실패)
import * as DB from "./db.js";
import net from "node:net";
import dns from "node:dns";
// api.telegram.org 등에서 IPv6 happy-eyeballs로 멈추는 문제 방지(IPv4 우선)
try { net.setDefaultAutoSelectFamily(false); dns.setDefaultResultOrder("ipv4first"); } catch {}

const EVENT_FLAG = {
  draft: "tgOnDraft",
  generate: "tgOnGenerate",
  publish: "tgOnPublish",
  schedule: "tgOnSchedule",
  error: "tgOnError",
};

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// userId 별로 텔레그램 메시지 발송. 설정/이벤트토글 꺼져있으면 무시.
export async function tgSend(userId, eventKey, text) {
  try {
    const st = DB.getSettingsRaw(userId);
    if (!st || !st.tgEnabled) return false;
    const flag = EVENT_FLAG[eventKey];
    if (flag && st[flag] === false) return false;   // 미지정(undefined)은 ON 취급
    const token = DB.getSecret(userId, "tgBotToken");
    const chatId = st.tgChatId;
    if (!token || !chatId) return false;
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    if (!r.ok) { const j = await r.json().catch(() => ({})); console.error("[tg]", j.description || r.status); return false; }
    return true;
  } catch (e) { console.error("[tg]", e.message); return false; }
}

// 편의: 태그 붙인 메시지
export function tgMsg(userId, eventKey, lines) {
  const body = Array.isArray(lines) ? lines.join("\n") : String(lines);
  return tgSend(userId, eventKey, `🔔 <b>블로그라이터</b>\n${body}`);
}

export { esc as tgEsc };
