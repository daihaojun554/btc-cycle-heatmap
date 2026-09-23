'use strict';

/**
 * 数据管线：抓取 -> 分析 -> 落盘缓存。
 * 供两种调用方式：
 *   1. 作为模块被 server 定时调用（每小时）
 *   2. 直接 `node server/update.js` 手动刷新一次
 */

const fs = require('fs');
const path = require('path');
const { fetchKrakenWeekly, fetchDaily, fetchSpotPriceDetailed, fetchTipHeight, halvingInfo, aggregateMonthly, aggregateMonthlyFromWeekly, withMonthlyChange } = require('./fetch');
const { analyze } = require('./analyze');
const { buildCycles, cycleProgress, buildComparisons } = require('./cycles');
const { checkRadar, recordEvents, LEVELS } = require('./radar');
const { backtest } = require('./backtest');
const { analyzeBuys, checkCurrent } = require('./buypoints');
const notify = require('./notify');
const { fetchFearGreed, backtestCombo } = require('./sentiment');
const { fetchMVRV } = require('./mvrv');
const daily = require('./daily');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'snapshot.json');
// 静态托管用副本：GitHub Pages 等环境没有后端，前端直接读这个文件
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_SNAPSHOT = path.join(PUBLIC_DIR, 'data.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 执行一次完整更新。
 * 网络失败时回退到旧缓存（保证站点不会白屏），并标注 stale。
 */
async function update({ quiet = false } = {}) {
  const log = (...a) => !quiet && console.log('[update]', ...a);
  const startedAt = Date.now();
  let weekly = null;
  let source = 'kraken';
  const warnings = [];

  try {
    weekly = await fetchKrakenWeekly();
    log(`Kraken 周线 ${weekly.length} 条`);
  } catch (err) {
    warnings.push(`Kraken 失败: ${err.message}`);
    log('Kraken 失败，尝试其他日线源…');
    try {
      const d = await fetchDaily();
      weekly = d.rows; // 日线也能喂给周期分析（analyze 只依赖 t/o/h/l/c）
      source = `${d.source}-daily`;
      log(`${d.source} 日线 ${d.rows.length} 条`);
    } catch (err2) {
      warnings.push(`日线源失败: ${err2.message}`);
    }
  }

  if (!weekly || weekly.length < 50) {
    const old = readCache();
    if (old) {
      const merged = { ...old, stale: true, staleReason: warnings.join('; '), lastAttempt: new Date().toISOString() };
      writeCache(merged);
      log('全部数据源失败，保留旧缓存');
      return merged;
    }
    throw new Error(`无法获取价格数据: ${warnings.join('; ')}`);
  }

  // 实时价（用于当月尚未收盘的格子）
  let spot = null;
  try {
    spot = (await fetchSpotPriceDetailed()).price;
    log(`实时价 $${spot}`);
  } catch (err) {
    warnings.push(`实时价失败: ${err.message}`);
  }

  // 月度序列：优先用日线聚合自然月；日线全部不可用时退回周线聚合。
  // 这一步必须有兜底 —— 否则月度数据为空会连锁导致周期、对比图、回测全部失效。
  let monthly = [];
  try {
    let daily = null;
    if (source.endsWith('-daily')) {
      daily = weekly; // 周线本身就是日线数据降级来的
    } else {
      try {
        const r = await fetchDaily();
        daily = r.rows;
      } catch (err) {
        warnings.push(`日线源全部失败，月度改用周线聚合: ${err.message}`);
      }
    }

    if (daily && daily.length > 100) {
      monthly = aggregateMonthly(daily, spot);
      const firstKey = monthly.length ? monthly[0].key : null;
      const older = aggregateMonthlyFromWeekly(source === 'kraken' ? weekly : [], firstKey);
      monthly = withMonthlyChange(older.concat(monthly));
    } else if (source === 'kraken' || weekly.length > 100) {
      // 兜底：纯周线聚合。精度略低（月末取当周收盘），但保证图表可用。
      monthly = withMonthlyChange(aggregateMonthlyFromWeekly(weekly));
      warnings.push('月度数据由周线聚合（精度略低）');
    }

    if (monthly.length) {
      log(`月度序列 ${monthly.length} 个月（${monthly[0].key} → ${monthly[monthly.length - 1].key}）`);
    } else {
      warnings.push('月度序列为空');
    }
  } catch (err) {
    warnings.push(`月度聚合失败: ${err.message}`);
  }

  // 减半信息（失败不影响主流程）
  let halving = null;
  try {
    const height = await fetchTipHeight();
    halving = halvingInfo(height);
    log(`区块高度 ${height}，周期进度 ${halving.progressPct}%`);
  } catch (err) {
    warnings.push(`区块高度失败: ${err.message}`);
  }

  const { points, stats, signals } = analyze(weekly);

  // 月度视角的汇总统计（供前端 hero 区显示）
  const monthlyStats = buildMonthlyStats(monthly, spot);

  // 四年周期划分与阶段定位
  const { cycles, current: currentCycle } = buildCycles(monthly, points);
  if (currentCycle) {
    currentCycle.progress = cycleProgress(currentCycle, monthly[monthly.length - 1].key);
    log(
      `当前周期 ${currentCycle.label} · 阶段「${
        (currentCycle.phases.find((p) => p.id === currentCycle.currentPhaseId) || {}).name || '—'
      }」· 进度 ${currentCycle.progress.pct}%`,
    );
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    stale: false,
    source,
    warnings,
    halving,
    spot,
    stats,
    signals,
    points,
    monthly,
    monthlyStats,
    cycles,
    currentCycle,
    comparisons: buildComparisons(cycles, monthly),
    buyAnalysis: null,
    sentiment: null,
    onchain: null,
    radar: null,
    backtest: null,
    meta: {
      symbol: 'BTC/USD',
      interval: '1w',
      metric:
        '综合评分 0-100：由 ATH 回撤(40%)、幂律趋势偏离(35%)、Mayer Multiple(25%) 合成。0=历史级低估，100=历史级高估。',
      monthlyMetric: '月度环比涨跌幅 =（本月收盘 − 上月收盘）/ 上月收盘。当月未收盘时用实时价对比上月收盘。',
      cycleMetric:
        '四年周期按自然四年切分（2013-2016 / 2017-2020 / 2021-2024 / 2025-2028）。周期内阶段由周期估值评分定位：上涨期→顶部区→下跌期→盘整期。',
    },
  };

  // ---- 历史买点规律 ----
  try {
    snapshot.buyAnalysis = analyzeBuys(signals, points, cycles, snapshot.comparisons);
    // 当前状态对四条标准的满足情况
    if (snapshot.buyAnalysis) {
      snapshot.buyAnalysis.currentChecks = checkCurrent(snapshot.buyAnalysis.criteria, snapshot);
      const passed = snapshot.buyAnalysis.currentChecks.filter((c) => c.pass).length;
      log(`历史买点规律：${snapshot.buyAnalysis.count} 个样本，当前满足 ${passed}/4 条标准`);
    }
  } catch (err) {
    warnings.push(`买点分析失败: ${err.message}`);
  }

  // ---- 恐惧贪婪指数（情绪反向指标）----
  try {
    const fg = await fetchFearGreed();
    snapshot.sentiment = {
      fearGreed: {
        current: fg.current,
        percentile: fg.percentile,
        streak: fg.streak,
        stats: fg.stats,
        zones: fg.zones,
        lastExtremeFear: fg.lastExtremeFear,
        lastExtremeGreed: fg.lastExtremeGreed,
        recent: fg.recent,
      },
      // 「极度恐惧」单独用几乎无预测力，配合估值评分才有效 —— 把该结论做成数据
      combo: backtestCombo(fg.series, points, 30),
    };
    log(
      `恐惧贪婪指数：${fg.current.value}（${fg.current.label}）· 历史分位 ${fg.percentile}% · 连续 ${fg.streak} 天`,
    );
  } catch (err) {
    warnings.push(`恐惧贪婪指数失败: ${err.message}`);
  }

  // ---- MVRV 链上估值（全网平均成本视角）----
  try {
    const mv = await fetchMVRV();
    snapshot.onchain = {
      mvrv: {
        current: mv.current,
        percentile: mv.percentile,
        streak: mv.streak,
        stats: mv.stats,
        zones: mv.zones,
        cheapest: mv.cheapest,
        priciest: mv.priciest,
        lastBelowCost: mv.lastBelowCost,
        recent: mv.recent,
      },
    };
    log(
      `MVRV：${mv.current.mvrv}（${mv.current.zoneLabel}）· 全网平均成本 $${mv.current.avgCost.toLocaleString()} · 分位 ${mv.percentile}%`,
    );
  } catch (err) {
    warnings.push(`MVRV 失败: ${err.message}`);
  }

  // ---- 买点雷达：检查是否跌破档位 ----
  try {
    const radar = checkRadar(snapshot);
    snapshot.radar = {
      levels: LEVELS,
      distance: radar.distance,
      armed: radar.state.armed,
      lastCheck: radar.state.lastCheck,
    };

    if (radar.fired.length) {
      recordEvents(radar.fired);
      for (const ev of radar.fired) {
        log(`🔔 雷达触发：${ev.label}（评分 ${ev.score} < ${ev.threshold}）`);
        // Telegram 推送（未配置则静默跳过）
        const r = await notify.send(notify.formatAlert(ev, snapshot));
        if (r.ok) log('   → Telegram 已发送');
        else if (!r.skipped) log(`   → Telegram 失败: ${r.error || r.reason}`);
      }
      snapshot.radar.justFired = radar.fired;
    }
  } catch (err) {
    warnings.push(`雷达检查失败: ${err.message}`);
  }

  // ---- 每日简报（早晚两个时段检查，只在有变化时推送）----
  try {
    const entry = daily.extract(snapshot);
    const history = daily.readDaily();
    const prev = history.length ? history[history.length - 1] : null;
    const d = daily.diff(prev, entry, LEVELS);

    snapshot.dailyBrief = { current: entry, previous: prev, change: { reasons: d.reasons, gap: d.gap } };

    // 只在 UTC 0 点或 13 点所在的运行窗口推送，避免每小时都发
    const utcHour = new Date().getUTCHours();
    const isBriefWindow = utcHour === 0 || utcHour === 13;

    if (isBriefWindow && d.shouldSend) {
      const msg = daily.format(entry, d, LEVELS);
      const r = await notify.send(msg);
      log(`📊 日报已推送：${d.reasons.join(' · ')}${r.ok ? '' : '（失败：' + (r.error || r.reason) + '）'}`);
      snapshot.dailyBrief.sent = true;
      snapshot.dailyBrief.sentAt = new Date().toISOString();
    } else if (isBriefWindow) {
      log('📊 日报无需推送（无显著变化）');
      snapshot.dailyBrief.sent = false;
    }

    daily.appendDaily(entry);
  } catch (err) {
    warnings.push(`日报失败: ${err.message}`);
  }

  // ---- 回测 ----
  try {
    snapshot.backtest = backtest(monthly, points);
  } catch (err) {
    warnings.push(`回测失败: ${err.message}`);
  }

  writeCache(snapshot);
  log(`完成，耗时 ${snapshot.tookMs}ms`);

  // 追加历史快照，用于「实时变化」趋势（保留最近 500 条）
  appendHistory({
    at: snapshot.generatedAt,
    price: stats.current.close,
    score: stats.current.score,
    drawdownPct: stats.current.drawdownPct,
    mayer: stats.current.mayer,
  });

  return snapshot;
}

/** 月度视角汇总：当前月环比、历史涨跌分布、极值月份 */
function buildMonthlyStats(monthly, spot) {
  if (!monthly || monthly.length === 0) return null;

  const withChg = monthly.filter((m) => m.changePct !== null && Number.isFinite(m.changePct));
  const cur = monthly[monthly.length - 1];
  const changes = withChg.map((m) => m.changePct);
  const sorted = changes.slice().sort((a, b) => a - b);

  const percentileOf = (v) => {
    if (!sorted.length) return null;
    return +((sorted.filter((x) => x <= v).length / sorted.length) * 100).toFixed(1);
  };

  const best = withChg.reduce((a, b) => (b.changePct > a.changePct ? b : a), withChg[0]);
  const worst = withChg.reduce((a, b) => (b.changePct < a.changePct ? b : a), withChg[0]);

  // 连续同向月数
  let streak = 1;
  for (let i = monthly.length - 1; i > 0; i--) {
    const a = monthly[i].changePct;
    const b = monthly[i - 1].changePct;
    if (a === null || b === null) break;
    if (Math.sign(a) === Math.sign(b)) streak++;
    else break;
  }

  return {
    months: monthly.length,
    from: monthly[0].key,
    to: cur.key,
    current: {
      key: cur.key,
      close: +cur.close.toFixed(2),
      prevClose: cur.prevClose === null ? null : +cur.prevClose.toFixed(2),
      changePct: cur.changePct,
      isPartial: cur.isPartial,
      high: +cur.high.toFixed(2),
      low: +cur.low.toFixed(2),
      days: cur.days ?? null,
      spot: spot ?? null,
    },
    avgChange: +(changes.reduce((a, b) => a + b, 0) / changes.length).toFixed(2),
    upMonths: changes.filter((c) => c > 0).length,
    downMonths: changes.filter((c) => c < 0).length,
    winRate: +((changes.filter((c) => c > 0).length / changes.length) * 100).toFixed(1),
    medianChange: sorted[Math.floor(sorted.length / 2)],
    currentPercentile: cur.changePct === null ? null : percentileOf(cur.changePct),
    best: { key: best.key, changePct: best.changePct, close: +best.close.toFixed(2) },
    worst: { key: worst.key, changePct: worst.changePct, close: +worst.close.toFixed(2) },
    streak: { count: streak, direction: monthly[monthly.length - 1].changePct >= 0 ? 'up' : 'down' },
    maxAbs: +Math.max(...changes.map(Math.abs)).toFixed(2),
  };
}

function writeCache(snapshot) {
  ensureDir();
  const json = JSON.stringify(snapshot, null, 2);
  const tmp = `${CACHE_FILE}.tmp`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, CACHE_FILE); // 原子替换，避免读到半个文件

  // 同步一份到 public/，供 GitHub Pages 等纯静态托管使用
  try {
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    const tmp2 = `${PUBLIC_SNAPSHOT}.tmp`;
    fs.writeFileSync(tmp2, json);
    fs.renameSync(tmp2, PUBLIC_SNAPSHOT);
  } catch {
    /* 静态副本写失败不影响主流程 */
  }
}

const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

function appendHistory(entry) {
  ensureDir();
  fs.appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
  // 简单截断，避免无限增长
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n');
    if (lines.length > 500) {
      fs.writeFileSync(HISTORY_FILE, `${lines.slice(-500).join('\n')}\n`);
    }
  } catch {
    /* 忽略 */
  }
}

module.exports = { update, readCache, CACHE_FILE, DATA_DIR };

if (require.main === module) {
  update()
    .then((s) => {
      console.log(`\n✓ 快照已更新: ${CACHE_FILE}`);
      console.log(`  当前价 $${s.stats.current.close} | 评分 ${s.stats.current.score} | 回撤 ${s.stats.current.drawdownPct}%`);
      console.log(`  历史分位 ${s.stats.currentScorePercentile}% | 信号 ${s.signals.length} 个`);
    })
    .catch((err) => {
      console.error('✗ 更新失败:', err.message);
      process.exit(1);
    });
}
