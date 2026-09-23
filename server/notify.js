'use strict';

/**
 * Telegram 通知。
 * 通过环境变量配置：
 *   TELEGRAM_BOT_TOKEN  从 @BotFather 获取
 *   TELEGRAM_CHAT_ID    你的 chat id（可发给 @userinfobot 获取）
 *
 * 未配置时静默跳过，不影响其他功能。
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function enabled() {
  return Boolean(TOKEN && CHAT_ID);
}

async function send(text) {
  if (!enabled()) return { ok: false, skipped: true, reason: '未配置 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID' };
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    const d = await res.json();
    if (!d.ok) throw new Error(d.description || `HTTP ${res.status}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** 把雷达事件格式化成 TG 消息 */
/**
 * 把雷达事件格式化成 TG 消息。
 * 重点是「该做什么」，而不只是「发生了什么」—— 收到消息时人往往不在电脑前。
 */
function formatAlert(ev, snap) {
  const cur = snap.stats.current;
  const price = ev.price;
  const L = [];

  L.push(`${ev.emoji} <b>BTC 买点提醒 · ${ev.label}</b>`);
  L.push('');
  L.push(`评分 <b>${ev.score}</b>（跌破 ${ev.threshold}）`);
  L.push(`价格 <b>$${Math.round(price).toLocaleString('en-US')}</b>`);
  L.push('');

  // 三个维度的当前状态
  const fg = snap.sentiment && snap.sentiment.fearGreed;
  const mv = snap.onchain && snap.onchain.mvrv;
  L.push(`距 ATH　　${cur.drawdownPct}%`);
  if (mv) {
    L.push(`MVRV　　　${mv.current.mvrv}（${mv.current.zoneLabel}）`);
    L.push(`全网成本　$${mv.current.avgCost.toLocaleString('en-US')}`);
  }
  if (fg) L.push(`情绪　　　${fg.current.value}（${fg.current.label}）`);

  if (snap.currentCycle) {
    const ph = snap.currentCycle.phases.find((p) => p.id === snap.currentCycle.currentPhaseId);
    if (ph) L.push(`周期阶段　${ph.name}`);
  }

  L.push('');
  L.push(`<b>建议动作：${ev.action || '留意后续机会'}</b>`);

  // 下一档在哪（让人知道还能等）
  const next = (snap.radar && snap.radar.levels ? snap.radar.levels : [])
    .filter((l) => l.threshold < ev.threshold)
    .sort((a, b) => b.threshold - a.threshold)[0];
  if (next) {
    // 用当前评分-价格关系粗估下一档价位（评分 ≈ 64.2 + 0.71 × 回撤%）
    const dd = (next.threshold - 64.2) / 0.71;
    const est = snap.stats.ath * (1 + dd / 100);
    L.push(`下一档：评分低于 ${next.threshold}（${next.label}），约 $${Math.round(est).toLocaleString('en-US')}`);
  }

  L.push('');
  L.push(`<i>${ev.desc}</i>`);
  L.push('<i>非投资建议，请按自己的计划执行</i>');
  return L.join('\n');
}

module.exports = { send, enabled, formatAlert };
