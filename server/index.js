'use strict';

/**
 * 零依赖 HTTP 服务：
 *   GET /                 静态站点
 *   GET /api/snapshot     当前完整快照（周线 + 评分 + 信号 + 减半周期）
 *   GET /api/status       服务与数据健康状态
 *   POST /api/refresh     手动触发一次更新
 *
 * 更新策略：启动时立即更新一次，之后每小时定时更新。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { update, readCache } = require('./update');
const { fetchSpotPriceDetailed } = require('./fetch');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const UPDATE_INTERVAL_MS = Number(process.env.UPDATE_INTERVAL_MS || 60 * 60 * 1000); // 每小时
const PRICE_INTERVAL_MS = Number(process.env.PRICE_INTERVAL_MS || 60 * 1000); // 实时价默认 1 分钟
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const state = {
  startedAt: new Date().toISOString(),
  lastUpdateAt: null,
  lastError: null,
  updating: false,
  updateCount: 0,
};

// 实时价格状态：独立于全量重算，按分钟级更新
const priceState = {
  price: null,
  source: null,
  at: null,
  prevPrice: null,
  prevDayPrice: null,
  dayOpenAt: null,
  error: null,
  fetchCount: 0,
  lastFetchMs: null,
};

async function refreshPrice(trigger = 'schedule') {
  const t0 = Date.now();
  try {
    const r = await fetchSpotPriceDetailed();
    priceState.prevPrice = priceState.price;
    priceState.price = r.price;
    priceState.source = r.source;
    priceState.at = r.at;
    priceState.error = null;
    priceState.fetchCount++;
    priceState.lastFetchMs = Date.now() - t0;

    // 记录 24 小时前的价格，用于计算日涨跌
    const now = Date.now();
    if (!priceState.dayOpenAt || now - priceState.dayOpenAt >= 24 * 3600 * 1000) {
      priceState.dayOpenAt = now;
      priceState.prevDayPrice = r.price;
    }
    if (trigger !== 'schedule') {
      console.log(`[price] $${r.price} (${r.source}) ${priceState.lastFetchMs}ms`);
    }
    return r;
  } catch (err) {
    priceState.error = err.message;
    console.error(`[price] 获取失败 (${trigger}):`, err.message);
    return null;
  }
}

async function runUpdate(trigger) {
  if (state.updating) return { skipped: true };
  state.updating = true;
  try {
    const snap = await update({ quiet: true });
    state.lastUpdateAt = new Date().toISOString();
    state.lastError = null;
    state.updateCount++;
    console.log(
      `[${new Date().toISOString()}] 更新完成 (${trigger}) 价格 $${snap.stats.current.close} 评分 ${snap.stats.current.score}${snap.stale ? ' [STALE]' : ''}`,
    );
    return { ok: true };
  } catch (err) {
    state.lastError = err.message;
    console.error(`[${new Date().toISOString()}] 更新失败 (${trigger}):`, err.message);
    return { ok: false, error: err.message };
  } finally {
    state.updating = false;
  }
}

/** 用实时价重算当月环比，避免前端等整点快照 */
function buildLiveMonthly(snap, price) {
  const ms = snap.monthlyStats;
  if (!ms || !ms.current || ms.current.prevClose === null) return null;
  const prevClose = ms.current.prevClose;
  const changePct = +(((price - prevClose) / prevClose) * 100).toFixed(2);
  return {
    key: ms.current.key,
    price,
    prevClose,
    changePct,
    isPartial: ms.current.isPartial,
    // 当月最高/最低随实时价扩展
    high: Math.max(ms.current.high ?? price, price),
    low: Math.min(ms.current.low ?? price, price),
  };
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(file);
  const stat = fs.statSync(file);
  // ETag 基于文件大小 + 修改时间，文件一变 ETag 就变
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;

  // 协商缓存：每次都向服务器确认，未变更则返回 304（省流量且永远拿到最新代码）
  res.setHeader('etag', etag);
  res.setHeader('cache-control', 'no-cache');

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    res.end();
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
    etag,
    'last-modified': stat.mtime.toUTCString(),
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const { pathname } = url;

  if (pathname === '/api/snapshot') {
    const snap = readCache();
    if (!snap) return sendJSON(res, 503, { error: '数据尚未就绪，请稍后重试' });
    return sendJSON(res, 200, snap);
  }

  // 实时价格：轻量接口，前端按分钟轮询
  if (pathname === '/api/price') {
    // 缓存超过一个周期就顺手刷新一次，保证数据足够新
    const ageMs = priceState.at ? Date.now() - Date.parse(priceState.at) : Infinity;
    if (ageMs > PRICE_INTERVAL_MS) await refreshPrice('on-demand');

    if (priceState.price === null) {
      return sendJSON(res, 503, { error: priceState.error || '价格尚未就绪' });
    }
    const snap = readCache();
    return sendJSON(res, 200, {
      price: priceState.price,
      prevPrice: priceState.prevPrice,
      source: priceState.source,
      at: priceState.at,
      ageMs,
      intervalMs: PRICE_INTERVAL_MS,
      fetchMs: priceState.lastFetchMs,
      fetchCount: priceState.fetchCount,
      prevDayPrice: priceState.prevDayPrice,
      dayChangePct:
        priceState.prevDayPrice && priceState.price
          ? +(((priceState.price - priceState.prevDayPrice) / priceState.prevDayPrice) * 100).toFixed(2)
          : null,
      // 当月环比：用实时价对比上月收盘
      monthly: snap ? buildLiveMonthly(snap, priceState.price) : null,
      error: priceState.error,
    });
  }

  if (pathname === '/api/status') {
    const snap = readCache();
    const ageMs = snap ? Date.now() - Date.parse(snap.generatedAt) : null;
    return sendJSON(res, 200, {
      ...state,
      dataAgeMs: ageMs,
      dataAgeMinutes: ageMs === null ? null : +(ageMs / 60000).toFixed(1),
      nextUpdateInMs: state.lastUpdateAt
        ? Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - Date.parse(state.lastUpdateAt)))
        : 0,
      updateIntervalMs: UPDATE_INTERVAL_MS,
      dataGeneratedAt: snap ? snap.generatedAt : null,
    });
  }

  if (pathname === '/api/refresh' && req.method === 'POST') {
    const r = await runUpdate('manual');
    return sendJSON(res, r.ok ? 200 : 500, r);
  }

  return serveStatic(req, res, pathname);
});

// 启动流程：先读缓存让服务立刻可用，再异步刷新
const cached = readCache();
if (cached) {
  console.log(`已加载缓存快照: ${cached.generatedAt} (价格 $${cached.stats.current.close})`);
} else {
  console.log('无本地缓存，正在首次抓取数据…');
}

server.listen(PORT, HOST, async () => {
  console.log(`\n  BTC 周期热力图  →  http://${HOST}:${PORT}\n`);
  console.log(`  历史数据每 ${UPDATE_INTERVAL_MS / 60000} 分钟重算`);
  console.log(`  实时价格每 ${PRICE_INTERVAL_MS / 1000} 秒刷新（前端按同频率轮询）`);

  // 先拉价格（快），再跑全量重算（慢）
  await refreshPrice('startup');
  setInterval(() => refreshPrice('schedule'), PRICE_INTERVAL_MS);

  await runUpdate('startup');
  setInterval(() => runUpdate('schedule'), UPDATE_INTERVAL_MS);
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务…');
  server.close(() => process.exit(0));
});
