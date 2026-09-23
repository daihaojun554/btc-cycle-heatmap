'use strict';

/**
 * 链上估值指标：MVRV 比率（Coin Metrics 社区版，免费无 Key）。
 *
 * MVRV = 市值 ÷ 已实现市值 = 当前价 ÷ 全体持币者的平均成本
 *   MVRV = 1.0 → 全体持币者不赚不亏
 *   MVRV = 0.7 → 平均浮亏 30%（多数人在割肉）
 *   MVRV = 4.0 → 平均浮盈 300%（人人都想止盈）
 *
 * 历史验证（2013 至今）：
 *   所有周期底 MVRV < 0.8（2015-01 最低 0.56）
 *   所有周期顶 MVRV > 2.7（2013-11 最高 5.88）
 *
 * 数据有约 2 天延迟（链上指标需要等区块确认聚合）。
 */

const API =
  'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics' +
  '?assets=btc&metrics=CapMVRVCur,PriceUSD&frequency=1d&start_time=2013-01-01&page_size=10000';

// 分档：依据历史顶底分布划定
const ZONES = [
  { max: 1.0, id: 'deep-value', label: '深度低估', color: '#39d353', advice: '全体持币者平均亏损，历史上这是周期大底' },
  { max: 1.5, id: 'value', label: '低估', color: '#7ee787', advice: '接近全网平均成本，风险较低' },
  { max: 2.2, id: 'neutral', label: '中性', color: '#d29922', advice: '有浮盈但不极端，属于周期中段' },
  { max: 3.0, id: 'expensive', label: '高估', color: '#e3813a', advice: '平均浮盈超 100%，注意风险' },
  { max: Infinity, id: 'bubble', label: '泡沫区', color: '#f85149', advice: '历史上这是周期顶部区域，建议分批止盈' },
];

function zoneOf(v) {
  return ZONES.find((z) => v < z.max) || ZONES[ZONES.length - 1];
}

async function fetchMVRV() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let raw;
  try {
    const res = await fetch(API, { signal: ctrl.signal, headers: { 'user-agent': 'btc-cycle-heatmap/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } finally {
    clearTimeout(timer);
  }

  if (!raw || !Array.isArray(raw.data) || raw.data.length === 0) throw new Error('数据为空');

  const series = raw.data
    .filter((d) => d.CapMVRVCur != null && Number.isFinite(parseFloat(d.CapMVRVCur)))
    .map((d) => ({
      date: String(d.time).slice(0, 10),
      t: Date.parse(`${String(d.time).slice(0, 10)}T00:00:00Z`),
      mvrv: +parseFloat(d.CapMVRVCur).toFixed(3),
      price: d.PriceUSD != null ? Math.round(parseFloat(d.PriceUSD)) : null,
    }))
    .sort((a, b) => a.t - b.t);

  if (series.length < 100) throw new Error(`样本过少: ${series.length}`);

  const cur = series[series.length - 1];
  const values = series.map((d) => d.mvrv);
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) => +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);

  const percentile = +((values.filter((v) => v <= cur.mvrv).length / values.length) * 100).toFixed(0);
  const zone = zoneOf(cur.mvrv);

  // 全体持币者的平均成本（= 价格 ÷ MVRV），以及当前平均盈亏
  const avgCost = Math.round(cur.price / cur.mvrv);
  const unrealizedPnlPct = +((cur.mvrv - 1) * 100).toFixed(1);

  // 连续处于同一档的天数
  let streak = 1;
  for (let i = series.length - 2; i >= 0; i--) {
    if (zoneOf(series[i].mvrv).id === zone.id) streak++;
    else break;
  }

  // 历史极值点（用于"上次这么便宜是什么时候"）
  const cheapest = series.reduce((a, b) => (b.mvrv < a.mvrv ? b : a));
  const priciest = series.reduce((a, b) => (b.mvrv > a.mvrv ? b : a));
  const lastBelow = [...series].reverse().find((d) => d.mvrv < 1.0 && d.date !== cur.date) || null;

  // 近 90 天走势
  const recent = series.slice(-90).map((d) => ({ date: d.date, mvrv: d.mvrv }));

  return {
    current: {
      ...cur,
      zone: zone.id,
      zoneLabel: zone.label,
      color: zone.color,
      advice: zone.advice,
      avgCost,
      unrealizedPnlPct,
    },
    percentile,
    streak,
    stats: {
      min: +Math.min(...values).toFixed(2),
      max: +Math.max(...values).toFixed(2),
      median: pct(0.5),
      p10: pct(0.1),
      p25: pct(0.25),
      p75: pct(0.75),
      p90: pct(0.9),
      days: series.length,
      from: series[0].date,
      to: cur.date,
      lagDays: Math.round((Date.now() - cur.t) / 86400000),
    },
    zones: ZONES.map((z, i) => ({
      ...z,
      count: values.filter((v) => v < z.max && v >= (ZONES[i - 1]?.max ?? -Infinity)).length,
    })),
    cheapest: { date: cheapest.date, mvrv: cheapest.mvrv, price: cheapest.price },
    priciest: { date: priciest.date, mvrv: priciest.mvrv, price: priciest.price },
    lastBelowCost: lastBelow ? { date: lastBelow.date, mvrv: lastBelow.mvrv } : null,
    recent,
    series,
  };
}

module.exports = { fetchMVRV, zoneOf, ZONES };
