'use strict';

/**
 * 回测：定期不定额策略 vs 每月无脑定投。
 *
 * 每月投入固定预算 BASE，按评分成倍率调整：
 *   评分 < 15  → 投 4 倍
 *   评分 < 25  → 投 2 倍
 *   评分 < 40  → 投 1 倍
 *   评分 >= 40 → 投 0.5 倍（保留现金，等更低位）
 *
 * 这样总投入可能与基准不同，因此同时给出「总投入」「最终市值」「收益率」
 * 「年化」「最大回撤」以及「每投入 1 美元的产出」，保证可比。
 */

const BASE = 100; // 每月基准预算（美元），仅用于比例计算

const TIERS = [
  { max: 15, mult: 4, label: '评分<15' },
  { max: 25, mult: 2, label: '评分<25' },
  { max: 40, mult: 1, label: '评分<40' },
  { max: Infinity, mult: 0.5, label: '评分≥40' },
];

function tierOf(score) {
  return TIERS.find((t) => score < t.max);
}

/**
 * @param {Array} monthly 月度序列（含 key/close）
 * @param {Array} points  周线评分序列（含 date/score）
 * @returns {Object} 回测结果
 */
function backtest(monthly, points) {
  // 建立「月份 -> 该月平均评分」的映射（用当月周线评分均值，避免单周噪声）
  const scoreByMonth = new Map();
  for (const p of points) {
    const k = p.date.slice(0, 7);
    if (!scoreByMonth.has(k)) scoreByMonth.set(k, []);
    scoreByMonth.get(k).push(p.score);
  }
  const monthScore = new Map();
  for (const [k, arr] of scoreByMonth) {
    monthScore.set(k, arr.reduce((a, b) => a + b, 0) / arr.length);
  }

  const rows = monthly.filter((m) => monthScore.has(m.key) && !m.isPartial);
  if (rows.length < 12) return null;

  const strat = { invested: 0, btc: 0, tiers: {}, trades: [] };
  const base = { invested: 0, btc: 0 };

  for (const m of rows) {
    const score = monthScore.get(m.key);
    const tier = tierOf(score);
    const amount = BASE * tier.mult;

    // 低分多买策略
    strat.invested += amount;
    strat.btc += amount / m.close;
    strat.tiers[tier.label] = (strat.tiers[tier.label] || 0) + 1;
    strat.trades.push({ month: m.key, score: +score.toFixed(1), amount, price: m.close, mult: tier.mult });

    // 基准：每月等额定投
    base.invested += BASE;
    base.btc += BASE / m.close;
  }

  const last = rows[rows.length - 1];
  const years = rows.length / 12;

  const summ = (s) => {
    const value = s.btc * last.close;
    return {
      invested: Math.round(s.invested),
      btc: +s.btc.toFixed(6),
      value: Math.round(value),
      profit: Math.round(value - s.invested),
      roiPct: +(((value - s.invested) / s.invested) * 100).toFixed(1),
      // 每投入 1 美元最终变成多少（消除投入额差异，可比性关键指标）
      perDollar: +(value / s.invested).toFixed(3),
      cagrPct: +((Math.pow(value / s.invested, 1 / years) - 1) * 100).toFixed(1),
      avgCost: +(s.invested / s.btc).toFixed(2),
    };
  };

  // 最大回撤（按策略持仓市值曲线）
  function maxDrawdown() {
    let btc = 0;
    let inv = 0;
    let peak = 0;
    let mdd = 0;
    for (const m of rows) {
      const score = monthScore.get(m.key);
      const amount = BASE * tierOf(score).mult;
      inv += amount;
      btc += amount / m.close;
      const v = btc * m.close;
      if (v > peak) peak = v;
      if (peak > 0) mdd = Math.min(mdd, (v - peak) / peak);
    }
    return +(mdd * 100).toFixed(1);
  }

  return {
    months: rows.length,
    from: rows[0].key,
    to: last.key,
    years: +years.toFixed(1),
    currentPrice: last.close,
    tiers: TIERS.map((t) => ({ label: t.label, mult: t.mult, count: strat.tiers[t.label] || 0 })),
    strategy: summ(strat),
    baseline: summ(base),
    maxDrawdownPct: maxDrawdown(),
    trades: strat.trades,
  };
}

module.exports = { backtest, TIERS };
