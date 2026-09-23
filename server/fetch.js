'use strict';

/**
 * 数据抓取层：只依赖 Node 内置模块，无第三方包。
 * 数据源：
 *   - Kraken 公开 OHLC：BTC/USD 全历史周线（2013-10 至今）
 *   - Binance 公开 K线：BTC/USDT 日线（2017-08 至今，分页拉全量）+ 实时价
 *   - blockstream / blockchain.info：当前区块高度，用于计算减半周期进度
 */

const KRAKEN = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=10080';
const BINANCE_DAILY = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d';
const BINANCE_TICKER = 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT';
// 区块高度多源容错（任一可用即可）
const TIP_SOURCES = [
  'https://blockstream.info/api/blocks/tip/height',
  'https://blockchain.info/q/getblockcount',
  'https://mempool.space/api/blocks/tip/height',
];

// 历史减半高度与时间（用于把「周期进度」映射到真实区块高度）
const HALVINGS = [
  { height: 210000, date: '2012-11-28' },
  { height: 420000, date: '2016-07-09' },
  { height: 630000, date: '2020-05-11' },
  { height: 840000, date: '2024-04-19' },
];
const BLOCKS_PER_HALVING = 210000;

async function getJSON(url, { timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'btc-cycle-heatmap/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 拉取 Kraken 全历史周线，返回 [{ t, o, h, l, c }]（t 为毫秒时间戳，UTC 周开盘） */
async function fetchKrakenWeekly() {
  const raw = await getJSON(KRAKEN);
  if (raw.error && raw.error.length) throw new Error(`Kraken: ${raw.error.join(',')}`);
  const key = Object.keys(raw.result).find((k) => k !== 'last');
  const rows = raw.result[key];
  return rows.map((r) => ({
    t: r[0] * 1000,
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
  }));
}

/**
 * 拉取全量日线（用于精确聚合「自然月」），多源容错。
 *
 * 重要：不能只依赖 Binance —— 它会用 HTTP 451 屏蔽 GitHub Actions 的机房 IP
 * （法律合规限制），导致 CI 里月度数据全部为空。这里按顺序尝试多个源，
 * Coinbase / Kraken 对机房 IP 友好，作为主力备选。
 *
 * 返回按时间升序的 [{ t, o, h, l, c }]，以及实际使用的源名。
 */
async function fetchDaily() {
  const sources = [
    { name: 'binance', fn: fetchBinanceDaily },
    { name: 'coinbase', fn: fetchCoinbaseDaily },
    { name: 'kraken', fn: fetchKrakenDaily },
  ];
  const errors = [];

  for (const src of sources) {
    try {
      const rows = await src.fn();
      if (rows && rows.length > 100) {
        return { rows, source: src.name };
      }
      errors.push(`${src.name}: 数据过少(${rows ? rows.length : 0})`);
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  throw new Error(`所有日线源均失败 → ${errors.join('; ')}`);
}

/** Binance 全量日线（分页向前翻） */
async function fetchBinanceDaily() {
  const MAX_PAGES = 8; // 8 * 1000 天 ≈ 21 年，足够
  let end = Date.now();
  let all = [];
  const seen = new Set();

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await getJSON(`${BINANCE_DAILY}&endTime=${end}&limit=1000`);
    if (!Array.isArray(rows) || rows.length === 0) break;

    const fresh = rows.filter((r) => !seen.has(r[0]));
    if (fresh.length === 0) break;
    for (const r of fresh) seen.add(r[0]);

    all = fresh.concat(all);
    if (rows.length < 1000) break; // 已到最早
    end = rows[0][0] - 1;
  }

  if (all.length === 0) throw new Error('无数据');
  all.sort((a, b) => a[0] - b[0]);
  return all.map((r) => ({ t: r[0], o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
}

/** Coinbase 全量日线（每页 300 根，向前翻页） */
async function fetchCoinbaseDaily() {
  const MAX_PAGES = 12; // 12 * 300 = 3600 天 ≈ 9.8 年
  const seen = new Set();
  let all = [];
  let end = Date.now();

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400&end=${new Date(end).toISOString()}`;
    const rows = await getJSON(url);
    if (!Array.isArray(rows) || rows.length === 0) break;

    // Coinbase 返回格式: [time(秒), low, high, open, close, volume]，且为倒序
    const fresh = rows.filter((r) => !seen.has(r[0]));
    if (fresh.length === 0) break;
    for (const r of fresh) seen.add(r[0]);

    all = fresh.concat(all);
    const oldest = Math.min(...rows.map((r) => r[0]));
    end = oldest * 1000 - 86400000;
    if (rows.length < 300) break;
  }

  if (all.length === 0) throw new Error('无数据');
  all.sort((a, b) => a[0] - b[0]);
  return all.map((r) => ({
    t: r[0] * 1000,
    o: Number(r[3]),
    h: Number(r[2]),
    l: Number(r[1]),
    c: Number(r[4]),
  }));
}

/** Kraken 日线（只回最近约 720 天，作为最后兜底） */
async function fetchKrakenDaily() {
  const raw = await getJSON('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440');
  if (raw.error && raw.error.length) throw new Error(raw.error.join(','));
  const key = Object.keys(raw.result).find((k) => k !== 'last');
  const rows = raw.result[key];
  if (!rows || !rows.length) throw new Error('无数据');
  return rows.map((r) => ({ t: r[0] * 1000, o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
}

/** 实时价格多源容错（任一可用即可），返回 { price, source, at } */
const SPOT_SOURCES = [
  { name: 'binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', pick: (d) => Number(d.price) },
  { name: 'okx', url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', pick: (d) => Number(d.data?.[0]?.last) },
  { name: 'coinbase', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', pick: (d) => Number(d.data?.amount) },
  { name: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', pick: (d) => Number(d.result?.XXBTZUSD?.c?.[0]) },
];

async function fetchSpotPriceDetailed() {
  const errors = [];
  for (const src of SPOT_SOURCES) {
    try {
      const d = await getJSON(src.url, { timeout: 6000 });
      const price = src.pick(d);
      if (Number.isFinite(price) && price > 0) {
        return { price, source: src.name, at: new Date().toISOString() };
      }
      errors.push(`${src.name}: 数据异常`);
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  throw new Error(errors.join('; '));
}

/** 兼容旧调用：只取价格数字 */
async function fetchSpotPrice() {
  const r = await fetchSpotPriceDetailed();
  return r.price;
}

/** 当前区块高度（多源容错） */
async function fetchTipHeight() {
  const errors = [];
  for (const url of TIP_SOURCES) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const h = parseInt(text.trim(), 10);
      if (!Number.isFinite(h)) throw new Error(`bad height: ${text.slice(0, 40)}`);
      return h;
    } catch (err) {
      errors.push(`${new URL(url).host}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(errors.join('; '));
}

/** 由区块高度推导减半周期信息 */function halvingInfo(height, now = Date.now()) {
  const idx = Math.floor(height / BLOCKS_PER_HALVING);
  const lastHalvingHeight = idx * BLOCKS_PER_HALVING;
  const nextHalvingHeight = (idx + 1) * BLOCKS_PER_HALVING;

  // 用「上一个已知减半」锚定，按 10 分钟/块推算时间点
  const known = HALVINGS[HALVINGS.length - 1];
  const blocksSinceKnown = height - known.height;
  const anchorMs = Date.parse(`${known.date}T00:00:00Z`);
  const nowMs = anchorMs + blocksSinceKnown * 10 * 60 * 1000;

  const remaining = nextHalvingHeight - height;
  const etaMs = nowMs + remaining * 10 * 60 * 1000;

  return {
    height,
    epoch: idx - 3, // 第几次减半周期（2012 减半为第 1 个完整周期）
    lastHalvingHeight,
    lastHalvingDate: lastHalvingHeight === known.height ? known.date : null,
    nextHalvingHeight,
    nextHalvingEta: new Date(etaMs).toISOString().slice(0, 10),
    progressPct: +(((height - lastHalvingHeight) / BLOCKS_PER_HALVING) * 100).toFixed(2),
    blocksRemaining: remaining,
    estimatedNow: new Date(nowMs).toISOString(),
    fetchedAt: new Date(now).toISOString(),
  };
}

/**
 * 把日线按「自然月」聚合。
 * @param {Array} daily 日线（升序）
 * @param {number|null} livePrice 实时价；传入时会替换「当前未结束月份」的收盘价
 * @returns {Array<{key, year, month, t, open, high, low, close, isPartial, days}>}
 */
function aggregateMonthly(daily, livePrice = null) {
  const map = new Map();
  for (const d of daily) {
    const dt = new Date(d.t);
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }

  const now = new Date();
  const currentKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const months = [];
  for (const [key, rows] of map) {
    rows.sort((a, b) => a.t - b.t);
    const [y, m] = key.split('-').map(Number);
    const isPartial = key === currentKey;

    let close = rows[rows.length - 1].c;
    let high = Math.max(...rows.map((r) => r.h));
    let low = Math.min(...rows.map((r) => r.l));
    // 当月未收盘：用实时价作为「当前收盘」，并同步扩展高低点
    if (isPartial && Number.isFinite(livePrice)) {
      close = livePrice;
      high = Math.max(high, livePrice);
      low = Math.min(low, livePrice);
    }

    months.push({
      key,
      year: y,
      month: m,
      t: Date.UTC(y, m - 1, 1),
      open: rows[0].o,
      high,
      low,
      close,
      isPartial,
      days: rows.length,
    });
  }

  months.sort((a, b) => a.t - b.t);
  return months;
}

/** 用周线聚合月份，用于补全日线覆盖不到的上古时期（2013-2017） */
function aggregateMonthlyFromWeekly(weekly, beforeKey) {
  const map = new Map();
  for (const w of weekly) {
    const dt = new Date(w.t);
    const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    if (beforeKey && key >= beforeKey) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(w);
  }

  const months = [];
  for (const [key, rows] of map) {
    rows.sort((a, b) => a.t - b.t);
    // 周数太少的月份（数据起始那个残缺月）跳过
    if (rows.length < 2) continue;
    const [y, m] = key.split('-').map(Number);
    months.push({
      key,
      year: y,
      month: m,
      t: Date.UTC(y, m - 1, 1),
      open: rows[0].o,
      high: Math.max(...rows.map((r) => r.h)),
      low: Math.min(...rows.map((r) => r.l)),
      close: rows[rows.length - 1].c,
      isPartial: false,
      daysApprox: rows.length * 7,
      source: 'weekly',
    });
  }
  months.sort((a, b) => a.t - b.t);
  return months;
}

/** 计算月度环比涨跌幅（相对上个月收盘） */
function withMonthlyChange(months) {
  return months.map((m, i) => {
    const prev = months[i - 1];
    const changePct = prev && prev.close ? ((m.close - prev.close) / prev.close) * 100 : null;
    return { ...m, prevClose: prev ? prev.close : null, changePct: changePct === null ? null : +changePct.toFixed(2) };
  });
}

module.exports = {
  fetchKrakenWeekly,
  fetchDaily,
  fetchBinanceDaily,
  fetchSpotPrice,
  fetchSpotPriceDetailed,
  fetchTipHeight,
  halvingInfo,
  aggregateMonthly,
  aggregateMonthlyFromWeekly,
  withMonthlyChange,
  HALVINGS,
};
