'use strict';

/**
 * 情绪指标：恐惧贪婪指数（Alternative.me，免费无 Key）。
 *
 * 这是反向指标 —— 别人恐惧时买入，别人贪婪时卖出。
 * 历史验证（2018-02 至今）：
 *   指数 < 20 时基本对应周期底部区域
 *   指数 > 75 时基本对应周期顶部区域
 *
 * 数据源：https://api.alternative.me/fng/
 */

const API = 'https://api.alternative.me/fng/?limit=0'; // limit=0 取全量（约 3100+ 天）

const CLASS_ZH = {
  'Extreme Fear': '极度恐惧',
  Fear: '恐惧',
  Neutral: '中性',
  Greed: '贪婪',
  'Extreme Greed': '极度贪婪',
};

// 分档阈值（与历史买点/卖点区域对应）
const ZONES = [
  { max: 20, id: 'extreme-fear', label: '极度恐惧', color: '#39d353', advice: '历史上这是买点区域，可以分批建仓' },
  { max: 40, id: 'fear', label: '恐惧', color: '#7ee787', advice: '情绪偏冷，适合定投' },
  { max: 60, id: 'neutral', label: '中性', color: '#d29922', advice: '情绪平稳，没有明显信号' },
  { max: 80, id: 'greed', label: '贪婪', color: '#e3813a', advice: '情绪偏热，注意风险' },
  { max: 101, id: 'extreme-greed', label: '极度贪婪', color: '#f85149', advice: '历史上这是卖点区域，考虑分批止盈' },
];

function zoneOf(v) {
  return ZONES.find((z) => v < z.max) || ZONES[ZONES.length - 1];
}

async function fetchFearGreed() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let raw;
  try {
    const res = await fetch(API, { signal: ctrl.signal, headers: { 'user-agent': 'btc-cycle-heatmap/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } finally {
    clearTimeout(timer);
  }

  if (!raw || !Array.isArray(raw.data) || raw.data.length === 0) throw new Error('数据为空');

  // 按时间升序整理
  const series = raw.data
    .map((d) => ({
      t: Number(d.timestamp) * 1000,
      date: new Date(Number(d.timestamp) * 1000).toISOString().slice(0, 10),
      value: Number(d.value),
      label: CLASS_ZH[d.value_classification] || d.value_classification,
    }))
    .filter((d) => Number.isFinite(d.value) && Number.isFinite(d.t))
    .sort((a, b) => a.t - b.t);

  const cur = series[series.length - 1];
  const values = series.map((d) => d.value);
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

  const percentile = +((values.filter((v) => v <= cur.value).length / values.length) * 100).toFixed(0);
  const zone = zoneOf(cur.value);

  // 连续同档天数
  let streak = 1;
  const curZoneId = zone.id;
  for (let i = series.length - 2; i >= 0; i--) {
    if (zoneOf(series[i].value).id === curZoneId) streak++;
    else break;
  }

  // 极端值出现的日期（用于"上次这么恐惧是什么时候"）
  const lastExtremeFear = [...series].reverse().find((d) => d.value < 20);
  const lastExtremeGreed = [...series].reverse().find((d) => d.value > 80);

  // 近 30 天走势
  const recent = series.slice(-30).map((d) => ({ date: d.date, value: d.value }));

  return {
    current: { ...cur, zone: zone.id, zoneLabel: zone.label, color: zone.color, advice: zone.advice },
    percentile,
    streak,
    stats: {
      min: Math.min(...values),
      max: Math.max(...values),
      median: pct(0.5),
      p10: pct(0.1),
      p25: pct(0.25),
      p75: pct(0.75),
      p90: pct(0.9),
      days: series.length,
      from: series[0].date,
      to: cur.date,
    },
    zones: ZONES.map((z) => ({
      ...z,
      count: values.filter((v) => v < z.max && v >= (ZONES[ZONES.indexOf(z) - 1]?.max ?? 0)).length,
    })),
    lastExtremeFear: lastExtremeFear ? { date: lastExtremeFear.date, value: lastExtremeFear.value } : null,
    lastExtremeGreed: lastExtremeGreed ? { date: lastExtremeGreed.date, value: lastExtremeGreed.value } : null,
    recent,
    series,
  };
}

/**
 * 恐惧贪婪 × 周期评分的组合有效性回测。
 *
 * 单独看「极度恐惧」几乎没用 —— 实测 31 次出现里，后续 1 年收益从 -67% 到 +851% 都有。
 * 但叠加估值评分后区分度极大（见下）。这个函数把该结论做成数据，供页面展示。
 *
 * @param {Array} series 情绪序列 [{t, date, value}]
 * @param {Array} points 周线序列 [{date, close, score, drawdownPct}]
 * @param {number} scoreThreshold 估值评分阈值，默认 30
 */
function backtestCombo(series, points, scoreThreshold = 30) {
  if (!series.length || !points.length) return null;

  const at = (ts) => {
    let found = null;
    for (const p of points) {
      if (Date.parse(`${p.date}T00:00:00Z`) <= ts) found = p;
      else break;
    }
    return found;
  };

  const rows = [];
  let lastT = -Infinity;
  for (const d of series) {
    // 情绪进入「极度恐惧」时取样，间隔 <30 天视为同一轮
    if (d.value < 20 && d.t - lastT > 30 * 86400000) {
      lastT = d.t;
      const p = at(d.t);
      if (!p) continue;
      const p1 = at(d.t + 365 * 86400000);
      rows.push({
        date: p.date,
        fng: d.value,
        score: p.score,
        drawdownPct: p.drawdownPct,
        price: p.close,
        gain1y: p1 ? +(((p1.close - p.close) / p.close) * 100).toFixed(0) : null,
      });
    }
  }

  const withGain = rows.filter((r) => r.gain1y !== null);
  const cheap = withGain.filter((r) => r.score < scoreThreshold);
  const pricey = withGain.filter((r) => r.score >= scoreThreshold);
  const avg = (a) => (a.length ? +(a.reduce((s, x) => s + x.gain1y, 0) / a.length).toFixed(0) : null);

  return {
    scoreThreshold,
    total: rows.length,
    cheapCount: cheap.length,
    priceyCount: pricey.length,
    cheapAvg1y: avg(cheap),
    priceyAvg1y: avg(pricey),
    // 结论是否成立（样本够且差异明显）
    significant: cheap.length >= 5 && pricey.length >= 5,
    rows,
  };
}

module.exports = { fetchFearGreed, zoneOf, ZONES, backtestCombo };
