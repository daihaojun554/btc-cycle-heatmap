'use strict';

/**
 * 每日简报：早晚各检查一次，只在「有变化」时推送，避免变成噪音。
 *
 * 「有变化」的判定（任一满足即推送）：
 *   1. 评分变动 ≥ 1.5 分
 *   2. 价格变动 ≥ 2%
 *   3. MVRV 变动 ≥ 0.05
 *   4. 情绪指数变动 ≥ 8 点
 *   5. 跨过整数关口（评分每跨 5 分、价格每跨 $5,000）
 *   6. 距下一档雷达阈值缩小到 3 分以内（临近提醒）
 *
 * 每日快照存在 data/daily.jsonl，用于与上一次简报对比。
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DAILY_FILE = path.join(DATA_DIR, 'daily.jsonl');
const KEEP_DAYS = 400;

// 触发推送的阈值
const TH = {
  score: 1.5,
  pricePct: 2.0,
  mvrv: 0.05,
  fng: 8,
  scoreStep: 5, // 评分跨过 5 的整数倍
  priceStep: 5000, // 价格跨过 $5,000 的整数倍
  nearLevel: 3, // 距雷达下一档 3 分以内
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readDaily() {
  try {
    return fs
      .readFileSync(DAILY_FILE, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function appendDaily(entry) {
  ensureDir();
  const rows = readDaily();
  // 同一天只保留最后一条（覆盖当天的早晚两次）
  const idx = rows.findIndex((r) => r.date === entry.date);
  if (idx >= 0) rows[idx] = entry;
  else rows.push(entry);

  const trimmed = rows.slice(-KEEP_DAYS);
  fs.writeFileSync(DAILY_FILE, `${trimmed.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

/** 从快照提取简报所需的指标 */
function extract(snap) {
  const fg = snap.sentiment && snap.sentiment.fearGreed;
  const mv = snap.onchain && snap.onchain.mvrv;
  const cycle = snap.currentCycle;
  const phase = cycle ? cycle.phases.find((p) => p.id === cycle.currentPhaseId) : null;

  return {
    date: new Date().toISOString().slice(0, 10),
    at: new Date().toISOString(),
    price: Math.round(snap.spot ?? snap.stats.current.close),
    score: +snap.stats.current.score.toFixed(1),
    drawdownPct: snap.stats.current.drawdownPct,
    mvrv: mv ? mv.current.mvrv : null,
    avgCost: mv ? mv.current.avgCost : null,
    fng: fg ? fg.current.value : null,
    fngLabel: fg ? fg.current.label : null,
    phase: phase ? phase.name : null,
    cycleLabel: cycle ? cycle.label : null,
    cycleMonth: cycle && cycle.progress ? cycle.progress.elapsed : null,
  };
}

/** 判断是否需要推送，并给出变化摘要 */
function diff(prev, cur, radarLevels) {
  const reasons = [];

  if (prev) {
    const dScore = cur.score - prev.score;
    const dPricePct = ((cur.price - prev.price) / prev.price) * 100;
    const dMvrv = cur.mvrv != null && prev.mvrv != null ? cur.mvrv - prev.mvrv : 0;
    const dFng = cur.fng != null && prev.fng != null ? cur.fng - prev.fng : 0;

    if (Math.abs(dScore) >= TH.score) reasons.push(`评分 ${dScore > 0 ? '+' : ''}${dScore.toFixed(1)}`);
    if (Math.abs(dPricePct) >= TH.pricePct) reasons.push(`价格 ${dPricePct > 0 ? '+' : ''}${dPricePct.toFixed(1)}%`);
    if (Math.abs(dMvrv) >= TH.mvrv) reasons.push(`MVRV ${dMvrv > 0 ? '+' : ''}${dMvrv.toFixed(2)}`);
    if (Math.abs(dFng) >= TH.fng) reasons.push(`情绪 ${dFng > 0 ? '+' : ''}${dFng}`);

    // 跨越整数关口：两个值落在不同的「关口格子」里才算跨过。
    // 例：评分 41.5 和 39.5 都在 [40,45) 之外、但 41.5 属于 [40,45)，39.5 属于 [35,40)，
    // 所以确实跨过了 40 这条线。
    const scoreFloor = (v) => Math.floor(v / TH.scoreStep) * TH.scoreStep;
    const priceFloor = (v) => Math.floor(v / TH.priceStep) * TH.priceStep;
    if (scoreFloor(prev.score) !== scoreFloor(cur.score)) {
      // 报出实际跨过的那条线（取两者之间较大的那个）
      const crossed = Math.max(scoreFloor(prev.score), scoreFloor(cur.score));
      reasons.push(`评分跨过 ${crossed} 分线`);
    }
    if (priceFloor(prev.price) !== priceFloor(cur.price)) {
      const crossed = Math.max(priceFloor(prev.price), priceFloor(cur.price));
      reasons.push(`价格跨过 $${crossed.toLocaleString('en-US')} 线`);
    }
  } else {
    reasons.push('首次简报');
  }

  // 临近雷达档位
  const nextLv = (radarLevels || [])
    .filter((l) => l.threshold < cur.score)
    .sort((a, b) => b.threshold - a.threshold)[0];
  const gap = nextLv ? cur.score - nextLv.threshold : null;
  if (nextLv && prev) {
    const prevGap = prev.score - nextLv.threshold;
    if (gap <= TH.nearLevel && prevGap > TH.nearLevel) {
      reasons.push(`距「${nextLv.label}」仅剩 ${gap.toFixed(1)} 分`);
    }
  }

  return { shouldSend: reasons.length > 0, reasons, gap, nextLevel: nextLv || null };
}

/** 生成简报文本（Telegram HTML） */
function format(entry, d, radarLevels) {
  const L = [];
  const arrow = (delta, invert = false) => {
    if (delta == null || Math.abs(delta) < 0.001) return '→';
    const up = delta > 0;
    const good = invert ? !up : up;
    return good ? '↑' : '↓';
  };

  L.push(`📊 <b>BTC 日报 · ${entry.date}</b>`);
  L.push('');
  L.push(`价格　　<b>$${entry.price.toLocaleString('en-US')}</b>`);
  L.push(
    `评分　　<b>${entry.score}</b>　<i>${
      d.nextLevel ? `距「${d.nextLevel.label}」还差 ${(entry.score - d.nextLevel.threshold).toFixed(1)} 分` : '已进入最低档'
    }</i>`,
  );

  if (entry.mvrv != null) {
    L.push(`MVRV　　${entry.mvrv}　（全网成本 $${entry.avgCost.toLocaleString('en-US')}）`);
  }
  if (entry.fng != null) {
    L.push(`情绪　　${entry.fng}（${entry.fngLabel}）`);
  }
  L.push(`回撤　　${entry.drawdownPct}%`);
  if (entry.phase) {
    L.push(`周期　　${entry.cycleLabel} 第 ${entry.cycleMonth} 月 · ${entry.phase}`);
  }

  L.push('');
  L.push(`<b>变化：${d.reasons.join(' · ')}</b>`);
  L.push('');

  // 状态一句话
  const reached = (radarLevels || []).find((l) => entry.score < l.threshold);
  if (reached) {
    L.push(`${reached.emoji} <b>已进入「${reached.label}」区间</b>`);
    L.push(`建议动作：${reached.action || ''}`);
  } else {
    L.push('⏸ 尚未进入买入区间，继续等待');
  }

  L.push('');
  L.push('<i>非投资建议 · 回复 /stop 可退订</i>');
  return L.join('\n');
}

module.exports = { extract, diff, format, readDaily, appendDaily, TH };
