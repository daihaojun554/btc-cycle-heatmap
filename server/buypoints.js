'use strict';

/**
 * 历史买点分析：为每个买点信号算出「所处阶段、周期内月份、买入后表现」，
 * 并汇总成可展示的规律统计。
 */

const DAY = 86400000;

/**
 * @param {Array} signals 信号列表（来自 analyze）
 * @param {Array} points  周线序列
 * @param {Array} cycles  周期列表（来自 buildCycles）
 * @param {Array} comparisons 周期对比序列（用于定位周期内第几个月）
 */
function analyzeBuys(signals, points, cycles, comparisons) {
  const buys = signals.filter((s) => s.type === 'bottom');
  if (!buys.length) return null;

  const dataEnd = Date.parse(`${points[points.length - 1].date}T00:00:00Z`);

  const rows = buys.map((b) => {
    const base = b.price;
    const t0 = Date.parse(`${b.date}T00:00:00Z`);
    const ym = b.date.slice(0, 7);

    // 所属周期与阶段
    let cycle = null;
    let phase = null;
    for (const c of cycles) {
      if (ym >= c.from && ym <= c.to) {
        cycle = c;
        phase = c.phases.find((p) => ym >= p.from && ym <= p.to) || null;
        break;
      }
    }

    // 周期内第几个月 + 归一化价位
    let monthInCycle = null;
    let normPrice = null;
    const comp = comparisons.find((c) => c.index === (cycle ? cycle.index : -1));
    if (comp) {
      const row = comp.series.find((s) => s.key === ym);
      if (row) {
        monthInCycle = row.month;
        normPrice = row.norm;
      }
    }

    // 买入后表现（窗口超出数据范围则标为 null，避免用残缺窗口编造数字）
    const horizon = (days) => (t0 + days * DAY <= dataEnd ? days : null);

    const gain = (days) => {
      if (!horizon(days)) return null;
      const t1 = t0 + days * DAY;
      const w = points.filter((p) => {
        const t = Date.parse(`${p.date}T00:00:00Z`);
        return t >= t0 && t <= t1;
      });
      if (!w.length) return null;
      const hi = w.reduce((a, x) => (x.high > a.high ? x : a));
      return { pct: +(((hi.high - base) / base) * 100).toFixed(0), date: hi.date };
    };

    // 最大浮亏：从信号次周开始算，否则信号当周的低点会让回撤恒为 0
    const drawdown = (days) => {
      if (!horizon(days)) return null;
      const t1 = t0 + days * DAY;
      const w = points.filter((p) => {
        const t = Date.parse(`${p.date}T00:00:00Z`);
        return t > t0 && t <= t1;
      });
      if (!w.length) return null;
      const lo = w.reduce((a, x) => (x.low < a.low ? x : a));
      return { pct: +(((lo.low - base) / base) * 100).toFixed(1), date: lo.date };
    };

    return {
      date: b.date,
      price: b.price,
      score: b.score,
      drawdownPct: (points.find((p) => p.date === b.date) || {}).drawdownPct ?? null,
      confirmed: !!b.confirmed,
      cycleLabel: cycle ? cycle.label : null,
      cycleIndex: cycle ? cycle.index : null,
      phaseId: phase ? phase.id : null,
      phaseName: phase ? phase.name : null,
      monthInCycle,
      normPrice,
      gain3m: gain(90),
      gain6m: gain(180),
      gain1y: gain(365),
      gain2y: gain(730),
      dd1y: drawdown(365),
      dataSufficient: horizon(365) !== null,
      daysSince: Math.round((dataEnd - t0) / DAY),
    };
  });

  // ---- 阶段分布 ----
  const PHASE_ORDER = ['rise', 'top', 'fall', 'accum'];
  const PHASE_NAMES = { rise: '上涨期', top: '顶部区', fall: '下跌期', accum: '盘整期' };
  const phaseDist = PHASE_ORDER.map((id) => ({
    id,
    name: PHASE_NAMES[id],
    count: rows.filter((r) => r.phaseId === id).length,
  }));

  // ---- 评分区间 ----
  const scores = rows.map((r) => r.score).sort((a, b) => a - b);

  // ---- 周期内月份分布 ----
  const months = rows.filter((r) => r.monthInCycle !== null).map((r) => r.monthInCycle);

  // ---- 买入后 1/2 年收益区间（只统计数据充足的） ----
  const g1 = rows.filter((r) => r.gain1y).map((r) => r.gain1y.pct);
  const g2 = rows.filter((r) => r.gain2y).map((r) => r.gain2y.pct);

  return {
    rows,
    count: rows.length,
    phaseDist,
    // 「上涨期/顶部区从不出买点」是最硬的规律
    forbiddenPhaseCount: rows.filter((r) => r.phaseId === 'rise' || r.phaseId === 'top').length,
    scoreRange: { min: scores[0], max: scores[scores.length - 1], median: scores[Math.floor(scores.length / 2)] },
    monthRange: months.length ? { min: Math.min(...months), max: Math.max(...months) } : null,
    gain1yRange: g1.length ? { min: Math.min(...g1), max: Math.max(...g1) } : null,
    gain2yRange: g2.length ? { min: Math.min(...g2), max: Math.max(...g2) } : null,
    // 判定买点的四条标准
    criteria: buildCriteria(rows, scores),
  };
}

/** 汇总「当前是否满足买点条件」的四项检查 */
function buildCriteria(rows, scores) {
  return [
    // 25 取自历史买点评分上限 26.5 的整数化阈值
    { id: 'score', name: '周期评分', req: '低于 25', op: 'lt', threshold: 25 },
    { id: 'phase', name: '周期阶段', req: '下跌期 / 盘整期', op: 'phase' },
    { id: 'month', name: '周期内位置', req: '第 16–40 个月', op: 'range', min: 16, max: 40 },
    { id: 'drawdown', name: '距 ATH', req: '低于 -70%', op: 'lt', threshold: -70 },
  ];
}

/** 判断当前状态是否满足各条标准（供前端显示） */
function checkCurrent(criteria, snapshot) {
  const cur = snapshot.stats.current;
  const cycle = snapshot.currentCycle;
  const phase = cycle ? cycle.phases.find((p) => p.id === cycle.currentPhaseId) : null;
  const month = cycle && cycle.progress ? cycle.progress.elapsed : null;

  return criteria.map((c) => {
    switch (c.op) {
      case 'lt': {
        const val = c.id === 'score' ? cur.score : cur.drawdownPct;
        return { ...c, value: val, pass: val < c.threshold, gap: +(val - c.threshold).toFixed(1) };
      }
      case 'phase': {
        const pass = phase && (phase.id === 'fall' || phase.id === 'accum');
        return { ...c, value: phase ? phase.name : '—', pass: !!pass };
      }
      case 'range': {
        const pass = month !== null && month >= c.min && month <= c.max;
        return { ...c, value: month === null ? '—' : `第 ${month} 个月`, pass: !!pass };
      }
      default:
        return { ...c, value: '—', pass: false };
    }
  });
}

module.exports = { analyzeBuys, checkCurrent };
