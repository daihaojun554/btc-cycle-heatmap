'use strict';

/**
 * 周期与阶段划分。
 *
 * 「四年周期」按自然四年切分（2013-2016 / 2017-2020 / 2021-2024 / 2025-2028），
 * 边界整齐、和月度热力图「一年一行」对齐，一眼能框出四年。
 *
 * 每个周期内部再分四个阶段（用周期估值评分定位，而非机械按月数切）：
 *   1. 上涨期   —— 从周期起点到周期顶部（评分最高点）
 *   2. 顶部区   —— 顶部前后各若干月
 *   3. 下跌期   —— 顶部到周期底部（评分最低点）
 *   4. 盘整期   —— 底部之后到周期结束
 */

// 自然四年周期定义
const CYCLE_YEARS = [
  { start: 2013, end: 2016 },
  { start: 2017, end: 2020 },
  { start: 2021, end: 2024 },
  { start: 2025, end: 2028 },
];

const TOP_WINDOW_MONTHS = 3; // 顶部区前后各 3 个月

/** 生成 'YYYY-MM' */
const ym = (y, m) => `${y}-${String(m).padStart(2, '0')}`;

/**
 * @param {Array} monthly  月度序列（含 key/close/high/low/changePct）
 * @param {Array} points   周线评分序列（含 date/score/high/low）
 * @returns {{cycles: Array, current: Object}}
 */
function buildCycles(monthly, points) {
  const lastKey = monthly.length ? monthly[monthly.length - 1].key : null;
  const cycles = [];

  for (const def of CYCLE_YEARS) {
    const months = monthly.filter((m) => m.year >= def.start && m.year <= def.end);
    if (!months.length) continue;

    const from = months[0].key;
    const to = months[months.length - 1].key;
    const isCurrent = lastKey >= from && lastKey <= to;

    // 用周线评分定位周期内的顶与底
    const pts = points.filter((p) => {
      const y = Number(p.date.slice(0, 4));
      return y >= def.start && y <= def.end;
    });

    // 顶/底定位用「评分优先 + 价格确认」的混合策略：
    //   1. 先用周期估值评分找到最贵/最便宜的时刻（评分反映的是估值，能穿越价格噪声）
    //   2. 再在该时刻 ±3 个月内取价格极值，作为顶/底的实际点位
    // 纯用价格极值会被「自然四年」的切分边界带偏（例如 2017-2020 段里价格最高点在
    // 2020 年末，但真正的周期顶是 2017-12），因此必须以评分为锚。
    let top = null;
    let bottom = null;
    if (pts.length) {
      const anchorTop = pts.reduce((a, b) => (b.score > a.score ? b : a));
      const anchorBot = pts.reduce((a, b) => (b.score < a.score ? b : a));
      top = pickExtreme(pts, anchorTop, 'top');
      bottom = pickExtreme(pts, anchorBot, 'bottom');
    }

    const phases = buildPhases(months, top, bottom, isCurrent, lastKey);

    // 找到当前所处阶段
    const currentPhase = isCurrent ? phases.find((ph) => lastKey >= ph.from && lastKey <= ph.to) : null;

    cycles.push({
      index: cycles.length + 1,
      label: `${def.start}-${def.end}`,
      startYear: def.start,
      endYear: def.end,
      from,
      to,
      isCurrent,
      months: months.length,
      years: [...new Set(months.map((m) => m.year))],
      low: +Math.min(...months.map((m) => m.low)).toFixed(2),
      high: +Math.max(...months.map((m) => m.high)).toFixed(2),
      top,
      bottom,
      phases,
      currentPhaseId: currentPhase ? currentPhase.id : null,
    });
  }

  const current = cycles.find((c) => c.isCurrent) || null;

  return { cycles, current };
}

/**
 * 以某个「评分锚点」为中心，在 ±WINDOW 周内取价格极值。
 * @param {Array} pts     周线序列
 * @param {Object} anchor 评分锚点
 * @param {'top'|'bottom'} kind
 */
function pickExtreme(pts, anchor, kind) {
  const WINDOW_WEEKS = 13; // ≈3 个月
  const ai = pts.indexOf(anchor);
  const lo = Math.max(0, ai - WINDOW_WEEKS);
  const hi = Math.min(pts.length - 1, ai + WINDOW_WEEKS);
  const win = pts.slice(lo, hi + 1);
  const pick = kind === 'top' ? win.reduce((a, b) => (b.high > a.high ? b : a)) : win.reduce((a, b) => (b.low < a.low ? b : a));
  return {
    date: pick.date,
    month: pick.date.slice(0, 7),
    score: pick.score,
    price: kind === 'top' ? pick.high : pick.low,
    anchorDate: anchor.date,
    anchorScore: anchor.score,
  };
}

/** 把周期内月份切成四个阶段 */
function buildPhases(months, top, bottom, isCurrent, lastKey) {
  const keys = months.map((m) => m.key);
  const first = keys[0];
  const last = keys[keys.length - 1];

  // 没有评分数据时退化为「整段算一个阶段」
  if (!top || !bottom) {
    return [{ id: 'unknown', name: '未知', from: first, to: last }];
  }

  const topKey = top.month;
  const bottomKey = bottom.month;

  // 顶部区：顶部月份前后各 N 个月
  const topIdx = keys.indexOf(topKey) >= 0 ? keys.indexOf(topKey) : nearestIndex(keys, topKey);
  const topFrom = keys[Math.max(0, topIdx - TOP_WINDOW_MONTHS)];
  const topTo = keys[Math.min(keys.length - 1, topIdx + TOP_WINDOW_MONTHS)];

  // 底部必须晚于顶部区，否则阶段会重叠（数据缺失或评分异常时可能出现）
  const rawBottomIdx = keys.indexOf(bottomKey) >= 0 ? keys.indexOf(bottomKey) : nearestIndex(keys, bottomKey);
  const bottomIdx = Math.max(rawBottomIdx, keys.indexOf(topTo) + 1);

  const phases = [];

  // 1) 上涨期：周期起点 -> 顶部区之前（起点即为顶部时不存在）
  const riseTo = prevKey(keys, topFrom);
  if (riseTo && riseTo >= first) {
    phases.push({ id: 'rise', name: '上涨期', from: first, to: riseTo, desc: '周期启动，价格上行' });
  }

  // 2) 顶部区
  phases.push({
    id: 'top',
    name: '顶部区',
    from: topFrom,
    to: topTo,
    desc: '估值最贵，历史见顶区间',
    isTop: true,
    markerMonth: top.month,
  });

  // 3) 下跌期：顶部区之后 -> 底部
  const fallFrom = nextKey(keys, topTo);
  if (fallFrom && fallFrom <= last) {
    const bottomResolved = keys[Math.min(bottomIdx, keys.length - 1)];
    const fallTo = bottomResolved > fallFrom ? bottomResolved : last;
    phases.push({
      id: 'fall',
      name: '下跌期',
      from: fallFrom,
      to: fallTo,
      desc: '见顶回落，估值压缩',
      isBottom: true,
      markerMonth: bottom.month,
    });

    // 4) 盘整期：底部之后 -> 周期结束
    const accumFrom = nextKey(keys, fallTo);
    if (accumFrom && accumFrom <= last) {
      phases.push({ id: 'accum', name: '盘整期', from: accumFrom, to: last, desc: '底部横盘，等待下一轮' });
    }
  }

  // 兜底：阶段没覆盖到的尾部
  const covered = phases.length ? phases[phases.length - 1].to : null;
  if (covered && covered < last) {
    phases.push({ id: 'tail', name: '延伸期', from: nextKey(keys, covered), to: last, desc: '周期尾声' });
  }

  return phases;
}

function nearestIndex(keys, key) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const d = Math.abs(monthDiff(keys[i], key));
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  return best;
}

function monthDiff(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (ay - by) * 12 + (am - bm);
}

function prevKey(keys, key) {
  const i = keys.indexOf(key);
  return i > 0 ? keys[i - 1] : null;
}

function nextKey(keys, key) {
  const i = keys.indexOf(key);
  return i >= 0 && i < keys.length - 1 ? keys[i + 1] : null;
}

/** 当前周期进度：走到第几个月 / 周期总长度（按自然四年 = 48 个月算，而非已有数据月数） */
function cycleProgress(cycle, lastKey) {
  if (!cycle || !lastKey) return null;
  const total = (cycle.endYear - cycle.startYear + 1) * 12; // 自然四年共 48 个月
  const elapsed = Math.max(0, monthDiff(lastKey, cycle.from) + 1);
  return {
    elapsed,
    total,
    remain: Math.max(0, total - elapsed),
    pct: +Math.min(100, (elapsed / total) * 100).toFixed(1),
    hasDataMonths: cycle.months,
  };
}

/**
 * 周期对比序列：把每个周期按「周期内第几个月」对齐，价格归一化到起点=100。
 * 这样能直接比较不同周期的涨跌节奏（见顶/触底发生在第几个月）。
 */
function buildComparisons(cycles, monthly) {
  const out = [];
  for (const c of cycles) {
    const ms = monthly.filter((m) => m.key >= c.from && m.key <= c.to);
    if (ms.length < 3) continue;

    const base = ms[0].close;
    if (!base) continue;

    const series = ms.map((m, i) => ({
      month: i + 1,
      key: m.key,
      year: m.year,
      // 周期内的第几年（1-4），用于横轴年份分组
      cycleYear: Math.floor(i / 12) + 1,
      price: m.close,
      // 归一化：起点 = 100
      norm: +((m.close / base) * 100).toFixed(1),
    }));

    // 年份分组：每年占的月份区间（用于横轴年份带）
    const yearSpans = [];
    for (let i = 0; i < ms.length; i += 12) {
      const chunk = ms.slice(i, i + 12);
      yearSpans.push({
        year: chunk[0].year,
        label: String(chunk[0].year),
        fromMonth: i + 1,
        toMonth: i + chunk.length,
        cycleYear: Math.floor(i / 12) + 1,
      });
    }

    // 顶/底一律用「月度收盘」口径，与 series 保持一致。
    // 不能用周期对象里的 c.top.price（那是周线盘中价），否则同一张图混了两种口径：
    // 例如周期 1 的盘中低点 $122 vs 月收盘低点 $227，差 86%，比较会失真。
    const topRef = c.top ? ms.find((m) => m.key === c.top.month) || null : null;
    const botRef = c.bottom ? ms.find((m) => m.key === c.bottom.month) || null : null;

    // 顶/底用「该月的最高/最低价」，才符合"顶部/底部"的真实含义。
    // 若只用月收盘价，会低估真实的顶底幅度：
    // 例如 2025-10 月内冲高到 $126,198 后回落，月收盘只有 $109,608（差 13%）。
    // 价格与归一化都用同一套口径，保证可比。
    const top = topRef
      ? {
          month: ms.indexOf(topRef) + 1,
          key: topRef.key,
          date: c.top.date,
          price: topRef.high,
          norm: +((topRef.high / base) * 100).toFixed(1),
        }
      : null;
    const bottom = botRef
      ? {
          month: ms.indexOf(botRef) + 1,
          key: botRef.key,
          date: c.bottom.date,
          price: botRef.low,
          norm: +((botRef.low / base) * 100).toFixed(1),
        }
      : null;

    out.push({
      index: c.index,
      label: c.label,
      startYear: c.startYear,
      endYear: c.endYear,
      isCurrent: c.isCurrent,
      basePrice: +base.toFixed(2),
      from: c.from,
      to: c.to,
      months: ms.length,
      series,
      yearSpans,
      top,
      bottom,
      // 月收盘价的极值（曲线上可见的最高/最低点，与 series 同源）
      peakOnClose: { month: series.find((s) => s.norm === Math.max(...series.map((x) => x.norm))).month },
      // 数据缺口说明（周期 1 从 2013-10 才开始）
      partialFromStart: ms[0].key !== `${c.startYear}-01`,
    });
  }
  return out;
}

module.exports = { buildCycles, cycleProgress, buildComparisons, CYCLE_YEARS };
