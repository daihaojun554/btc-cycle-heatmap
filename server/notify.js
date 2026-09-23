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
function formatAlert(ev, snap) {
  const cur = snap.stats.current;
  const lines = [
    `${ev.emoji} <b>BTC 买点提醒 · ${ev.label}</b>`,
    '',
    `评分跌到 <b>${ev.score}</b>（阈值 ${ev.threshold}）`,
    `价格 <b>$${Math.round(ev.price).toLocaleString('en-US')}</b>`,
    '',
    `距 ATH：${cur.drawdownPct}%`,
    `Mayer：${cur.mayer ?? '—'}`,
    `趋势偏离：${cur.trendDeviation}×`,
  ];
  if (snap.currentCycle) {
    const ph = snap.currentCycle.phases.find((p) => p.id === snap.currentCycle.currentPhaseId);
    lines.push(`周期阶段：${ph ? ph.name : '—'}`);
  }
  lines.push('', `<i>${ev.desc}</i>`);
  return lines.join('\n');
}

module.exports = { send, enabled, formatAlert };
