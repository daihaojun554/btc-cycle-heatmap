'use strict';

/**
 * 分析层：把周线价格转成「每格的周期性价比评分 + 买卖信号」。
 *
 * 核心思路（对应需求：按相对周期顶底的位置着色）：
 *   1. 回撤分位数 —— 从历史 ATH 回撤越深越接近「底部」（低估）
 *   2. 幂律趋势带 —— 用 log-log 回归拟合 BTC 长期趋势，衡量相对趋势的高估/低估
 *   3. Mayer Multiple —— 价格 / 200日均线
 *   三项合成 0-100 的「周期位置分」：
 *      0  = 极度低估（历史级买点）
 *      100= 极度高估（历史级卖点）
 */

const DAY = 86400000;
const WEEK = 7 * DAY;
const MA_WINDOW_WEEKS = 29; // ≈200 天

/** 简单移动平均 */
function sma(values, window) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

/**
 * 幂律趋势拟合：log10(price) = a + b * log10(daysSinceGenesis)
 * 返回每条记录相对趋势线的偏离（倍数）
 */
function powerLawFit(points) {
  const GENESIS = Date.UTC(2009, 0, 3);
  const xs = points.map((p) => Math.log10((p.t - GENESIS) / DAY));
  const ys = points.map((p) => Math.log10(p.c));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const b = num / den;
  const a = my - b * mx;
  // 残差标准差，用于构造趋势通道
  const resid = ys.map((y, i) => y - (a + b * xs[i]));
  const sd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / n);
  return { a, b, sd, xs, ys, resid };
}

/** 把数值线性映射到 0-1 并夹紧 */
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * 主分析函数
 * @param {Array<{t:number,o:number,h:number,l:number,c:number}>} weekly 周线（按时间升序）
 * @returns {{ points: Array, stats: Object, signals: Array }}
 */
function analyze(weekly) {
  const pts = weekly.slice().sort((a, b) => a.t - b.t);

  // ---- 1. 滚动 ATH 与回撤 ----
  let ath = 0;
  const athSeries = [];
  const drawdown = [];
  for (const p of pts) {
    ath = Math.max(ath, p.h);
    athSeries.push(ath);
    drawdown.push((p.c - ath) / ath); // 负数，-0.8 = 回撤 80%
  }

  // ---- 2. Mayer Multiple（价格 / 200日均线）----
  const ma = sma(pts.map((p) => p.c), MA_WINDOW_WEEKS);
  const mayer = pts.map((p, i) => (ma[i] ? p.c / ma[i] : null));

  // ---- 3. 幂律趋势偏离 ----
  const fit = powerLawFit(pts);
  const plDeviation = pts.map((p, i) => {
    const trendLog = fit.a + fit.b * fit.xs[i];
    return p.c / 10 ** trendLog; // >1 表示高于趋势线，<1 低于
  });

  // ---- 4. 合成 0-100 周期位置分 ----
  // 各分项归一化到 0-1（0=便宜，1=贵）
  const ddVals = drawdown.filter((d) => Number.isFinite(d));
  const ddMin = Math.min(...ddVals); // 最深回撤（最便宜）
  const ddMax = 0; // ATH 处回撤为 0（最贵）
  const mayerVals = mayer.filter((m) => m !== null);
  const mayerLo = 0.6;
  const mayerHi = 3.0;
  const devVals = plDeviation.filter(Number.isFinite);
  const devLo = Math.min(...devVals);
  const devHi = Math.max(...devVals);

  const scoreOf = {
    drawdown: (d) => clamp01((d - ddMin) / (ddMax - ddMin || 1)), // 回撤越深 -> 越接近 0
    mayer: (m) => (m === null ? null : clamp01((m - mayerLo) / (mayerHi - mayerLo))),
    trend: (x) => clamp01((Math.log10(x) - Math.log10(devLo)) / (Math.log10(devHi) - Math.log10(devLo) || 1)),
  };

  const points = pts.map((p, i) => {
    const sDD = scoreOf.drawdown(drawdown[i]);
    const sMY = scoreOf.mayer(mayer[i]);
    const sTR = scoreOf.trend(plDeviation[i]);
    // 权重：回撤 40%、趋势 35%、Mayer 25%
    const parts = [
      [sDD, 0.4],
      [sTR, 0.35],
      [sMY, 0.25],
    ].filter(([v]) => v !== null);
    const wsum = parts.reduce((s, [, w]) => s + w, 0);
    const score = (parts.reduce((s, [v, w]) => s + v * w, 0) / wsum) * 100;

    // 距 ATH 天数（用于判断「熊市持续多久」）
    let athDayIdx = i;
    for (let j = i; j >= 0; j--) {
      if (athSeries[j] === athSeries[i]) {
        athDayIdx = j;
      } else break;
    }

    return {
      t: p.t,
      date: new Date(p.t).toISOString().slice(0, 10),
      close: +p.c.toFixed(2),
      high: +p.h.toFixed(2),
      low: +p.l.toFixed(2),
      ath: +athSeries[i].toFixed(2),
      drawdownPct: +(drawdown[i] * 100).toFixed(2),
      mayer: mayer[i] === null ? null : +mayer[i].toFixed(2),
      trendDeviation: +plDeviation[i].toFixed(3),
      score: +score.toFixed(1),
      sinceAthWeeks: i - athDayIdx,
    };
  });

  // ---- 5. 识别周期顶底信号 ----
  const signals = detectSignals(points);
  // ---- 6. 统计当前所处的「周期分位」----
  const cur = points[points.length - 1];
  const sortedScores = points.map((p) => p.score).sort((a, b) => a - b);
  const percentile = (sortedScores.filter((s) => s <= cur.score).length / sortedScores.length) * 100;

  const stats = {
    weeks: points.length,
    from: points[0].date,
    to: cur.date,
    ath: +Math.max(...points.map((p) => p.high)).toFixed(2),
    current: cur,
    currentScorePercentile: +percentile.toFixed(1),
    scoreScale: {
      min: +Math.min(...points.map((p) => p.score)).toFixed(1),
      max: +Math.max(...points.map((p) => p.score)).toFixed(1),
    },
    trendFit: { a: fit.a, b: fit.b, sd: fit.sd },
  };

  return { points, stats, signals };
}

/**
 * 周期顶底检测：
 *  - 局部极值法（±26 周窗口）识别周期高低点
 *  - 按分数阈值标注「买点/卖点」
 *  - 距今 >= 26 周的极值视为已确认，否则标记为 pending
 */
function detectSignals(points) {
  const W = 26;
  const n = points.length;
  const signals = [];

  // 评分门槛：只有估值确实处于极端区间，才把价格极值认定为周期拐点
  const BOTTOM_MAX_SCORE = 35; // 评分低于此值才提示「可能见底」
  const TOP_MIN_SCORE = 65; // 评分高于此值才提示「可能见顶」

  const pushMerged = (sig) => {
    const last = signals[signals.length - 1];
    if (last && last.type === sig.type && Math.abs(sig.i - last.i) < 12) {
      // 同类型且时间接近 -> 保留更极端的那个
      if (sig.type === 'bottom' ? sig.score < last.score : sig.score > last.score) {
        signals[signals.length - 1] = sig;
      }
      return;
    }
    signals.push(sig);
  };

  for (let i = W; i < n - W; i++) {
    const win = points.slice(i - W, i + W + 1);
    const p = points[i];

    const isLow = p.low === Math.min(...win.map((x) => x.low));
    const isHigh = p.high === Math.max(...win.map((x) => x.high));
    const confirmed = n - 1 - i >= W;

    // 只有「价格极值」和「估值评分」同时成立才算真正的周期拐点。
    // 否则只是局部波动，不标注买卖信号。
    if (isLow && p.score <= BOTTOM_MAX_SCORE) {
      pushMerged({ type: 'bottom', i, date: p.date, price: p.low, close: p.close, score: p.score, confirmed });
    } else if (isHigh && p.score >= TOP_MIN_SCORE) {
      pushMerged({ type: 'top', i, date: p.date, price: p.high, close: p.close, score: p.score, confirmed });
    }
  }

  // 近端未确认的潜在信号（最近 26 周内的极值）
  // 同样要求分数落在极端区间，避免把中性波动误报成买卖点。
  const tail = points.slice(Math.max(0, n - W));
  if (tail.length) {
    const tMin = tail.reduce((a, b) => (b.low < a.low ? b : a));
    const tMax = tail.reduce((a, b) => (b.high > a.high ? b : a));
    const iMin = points.indexOf(tMin);
    const iMax = points.indexOf(tMax);
    if (tMin.score <= BOTTOM_MAX_SCORE && !signals.some((s) => Math.abs(s.i - iMin) < 12)) {
      pushMerged({ type: 'bottom', i: iMin, date: tMin.date, price: tMin.low, close: tMin.close, score: tMin.score, confirmed: false, pending: true });
    }
    if (tMax.score >= TOP_MIN_SCORE && !signals.some((s) => Math.abs(s.i - iMax) < 12)) {
      pushMerged({ type: 'top', i: iMax, date: tMax.date, price: tMax.high, close: tMax.close, score: tMax.score, confirmed: false, pending: true });
    }
  }

  return signals.sort((a, b) => a.i - b.i);
}

module.exports = { analyze };
