'use strict';

/**
 * 前端：拉取 /api/snapshot 渲染热力图、信号表、走势图，并定时轮询保持实时。
 */

const POLL_MS = 5 * 60 * 1000; // 历史快照：每 5 分钟问一次后端有没有新数据
const PRICE_POLL_MS = 60 * 1000; // 实时价格：每分钟刷新
const HALVINGS = ['2012-11-28', '2016-07-09', '2020-05-11', '2024-04-19', '2028-04-16'];

// 评分色带：0(极度低估/买) -> 50(中性) -> 100(极度高估/卖)
// 单调渐变，保证「越绿越便宜、越红越贵」一眼可读
const SCALE = [
  [0, '#0b3d1f'],
  [12, '#0e5c2b'],
  [25, '#12833c'],
  [38, '#2ea043'],
  [50, '#c9a227'], // 中性：金黄
  [62, '#e3813a'],
  [75, '#f0603a'],
  [88, '#f85149'],
  [100, '#ff7b72'],
];

/** 月度涨跌幅 -> 颜色。
 *  用对称对数映射：±5% 和 ±50% 在视觉上保持对称，避免极端月份压平其余格子。
 *  红 = 跌，绿 = 涨（符合中文用户习惯）。
 *  数组按「强度从弱到强」排列，索引 0 = 几乎没变，末尾 = 剧烈变化。 */
const DOWN = ['#fddbc7', '#f4a582', '#d6604d', '#a50f15', '#67001f'];
const UP = ['#d9f0d3', '#a6dba0', '#5aae61', '#1b7837', '#00441b'];

function monthColor(pct) {
  if (pct === null || !Number.isFinite(pct)) return '#21262d';
  // 对称对数刻度：把 ±100% 压缩到 ±1
  const norm = Math.sign(pct) * Math.log10(1 + Math.abs(pct) / 4) / Math.log10(1 + 100 / 4);
  const t = Math.min(1, Math.abs(norm)); // 0-1 强度
  const stops = pct >= 0 ? UP : DOWN;
  const idx = t * (stops.length - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(stops.length - 1, i0 + 1);
  return mixHex(stops[i0], stops[i1], idx - i0);
}

/** 格子文字颜色：底色深(变化剧烈)时用白字，底色浅(变化小)时用深字 */
function monthTextColor(pct) {
  if (pct === null || !Number.isFinite(pct)) return '#8b949e';
  const a = Math.abs(pct);
  // 与 monthColor 同一套对数刻度：强度超过约 40% 时底色已经很深
  return a >= 12 ? '#ffffff' : '#0d1117';
}

let snapshot = null;
let signalMap = new Map();
let currentView = 'month';
let livePrice = null; // 分钟级实时价，由 /api/price 驱动

/** 评分 0-100 -> 颜色（在色带上线性插值） */
function scoreColor(score) {
  const s = Math.max(0, Math.min(100, score));
  for (let i = 0; i < SCALE.length - 1; i++) {
    const [p0, c0] = SCALE[i];
    const [p1, c1] = SCALE[i + 1];
    if (s >= p0 && s <= p1) {
      const t = (s - p0) / (p1 - p0 || 1);
      return mixHex(c0, c1, t);
    }
  }
  return SCALE[SCALE.length - 1][1];
}

function hex2rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mixHex(a, b, t) {
  const A = hex2rgb(a);
  const B = hex2rgb(b);
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** 评分 -> 文字结论 */
function verdictOf(score) {
  if (score < 12) return { label: '极度低估 · 历史级买点', color: '#39d353', desc: '历史上这个区间买入,后续 1-2 年回报极高' };
  if (score < 25) return { label: '明显低估 · 适合买入', color: '#3fb950', desc: '接近周期底部区域,分批建仓的窗口' };
  if (score < 40) return { label: '偏低估 · 可以定投', color: '#7ee787', desc: '低于长期趋势,风险收益比尚可' };
  if (score < 55) return { label: '中性 · 持有观望', color: '#d29922', desc: '处于周期中段,不宜追高也不急于卖出' };
  if (score < 70) return { label: '偏高 · 考虑减仓', color: '#e3813a', desc: '已高于长期趋势,建议分批止盈' };
  if (score < 85) return { label: '高估 · 卖出区域', color: '#f85149', desc: '接近历史周期顶部特征' };
  return { label: '极度高估 · 历史级卖点', color: '#ff7b72', desc: '历史上这个区间之后往往出现深度回撤' };
}

function fmtPrice(v) {
  if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}

function fmtPct(v) {
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!snapshot) return;
  const { stats, signals, points, halving } = snapshot;

  // 信号索引：日期 -> 信号
  signalMap = new Map();
  for (const s of signals) signalMap.set(s.date, s);

  renderHero(stats, points, halving);
  renderCycleBanner();
  renderRadar();
  renderMetrics(stats, points, halving);
  renderBuyAnalysis();
  renderBacktest();
  renderMonthlyHeatmap(snapshot.monthly || []);
  renderCompare();
  bindCompareHover();
  renderLegendMonth();
  renderHeatmap(points);
  renderSignalsTable(signals);
  renderLegend();
  renderChart(points);
  bindChartHover();
  drawGauge(stats.current.score);

  document.getElementById('generated').textContent = new Date(snapshot.generatedAt).toLocaleString('zh-CN');
}

/** 顶部横幅：当前四年周期 + 所处阶段 + 进度条 */
function renderCycleBanner() {
  const cyc = snapshot.currentCycle;
  const box = document.getElementById('cycle-banner');
  if (!cyc) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';

  const years = cyc.years;
  const span = `${cyc.startYear}–${cyc.endYear}`;
  document.getElementById('cb-title').textContent = `${span}  ·  第 ${cyc.progress ? cyc.progress.elapsed : '?'} / 48 个月`;

  const ph = cyc.phases.find((p) => p.id === cyc.currentPhaseId);
  const stageEl = document.getElementById('cb-stage');
  if (ph) {
    const color = PHASE_COLOR[ph.id] || '#8b949e';
    stageEl.innerHTML =
      `<span style="color:${color}">当前阶段：${ph.name}</span>` +
      `<span class="cb-desc">${phaseAdvice(ph.id)}</span>`;
  }

  // 进度条：按阶段占月数比例分段
  const bar = document.getElementById('cb-bar') || document.querySelector('.cb-bar');
  bar.querySelectorAll('.cb-seg').forEach((n) => n.remove());
  const totalM = cyc.months || 1;
  const mk = document.getElementById('cb-marks');
  for (const p of cyc.phases) {
    const n = Math.max(1, monthsBetween(p.from, p.to));
    const seg = document.createElement('div');
    seg.className = 'cb-seg ' + (PHASE_CLASS[p.id] || 'ph-unknown') + (p.id === cyc.currentPhaseId ? '' : ' past');
    seg.style.flex = `${n} 0 0`;
    seg.textContent = n >= 4 ? p.name : '';
    seg.title = `${p.name} ${p.from} ~ ${p.to}`;
    bar.insertBefore(seg, mk);
  }

  // 进度填充
  const pct = cyc.progress ? cyc.progress.pct : 0;
  document.getElementById('cb-fill').style.width = `${pct}%`;

  // 图例
  const legend = document.getElementById('cb-legend');
  legend.innerHTML =
    `<span><i style="background:#2ea043"></i>上涨期</span>` +
    `<span><i style="background:#d6604d"></i>顶部区</span>` +
    `<span><i style="background:#a50f15"></i>下跌期</span>` +
    `<span><i style="background:#2d8fb0"></i>盘整期</span>` +
    `<span class="now">已走过 ${pct}%，剩余约 ${cyc.progress ? cyc.progress.remain : '?'} 个月 · 至 ${cyc.to}</span>`;
}

const PHASE_COLOR = {
  rise: '#2ea043',
  top: '#d6604d',
  fall: '#a50f15',
  accum: '#2d8fb0',
  tail: '#8b949e',
  unknown: '#8b949e',
};

/** 各阶段的操作提示 */
function phaseAdvice(id) {
  switch (id) {
    case 'rise':
      return '周期启动上行，可持有但不宜追高';
    case 'top':
      return '历史见顶区间，估值最贵，建议分批止盈';
    case 'fall':
      return '见顶回落，估值压缩，观望等待';
    case 'accum':
      return '底部横盘区，通常是布局下一轮的窗口';
    default:
      return '';
  }
}

function monthsBetween(a, b) {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}
function renderMonthlyHeatmap(monthly) {
  const host = document.getElementById('heatmap-month');
  host.innerHTML = '';
  if (!monthly.length) {
    host.innerHTML = '<p style="color:var(--text-dim)">月度数据不可用</p>';
    return;
  }

  const cycles = snapshot.cycles || [];
  // 没被任何周期覆盖的月份（理论上不会有，兜底）
  const covered = new Set();
  for (const c of cycles) for (const m of monthly) if (m.key >= c.from && m.key <= c.to) covered.add(m.key);

  for (const cyc of cycles) {
    host.appendChild(buildCycleGroup(cyc, monthly));
  }

  const orphans = monthly.filter((m) => !covered.has(m.key));
  if (orphans.length) host.appendChild(buildYearBlocks(orphans));

  const st = snapshot.monthlyStats;
  if (st) {
    document.getElementById('axis-month').textContent =
      `共 ${st.months} 个月（${st.from} → ${st.to}）· 上涨 ${st.upMonths} 次 / 下跌 ${st.downMonths} 次 · ` +
      `胜率 ${st.winRate}% · 月度中位数 ${st.medianChange >= 0 ? '+' : ''}${st.medianChange}% · ` +
      `最强 ${st.best.key} ${st.best.changePct >= 0 ? '+' : ''}${st.best.changePct}% · ` +
      `最弱 ${st.worst.key} ${st.worst.changePct}%`;
  }
}

const PHASE_CLASS = {
  rise: 'ph-rise',
  top: 'ph-top',
  fall: 'ph-fall',
  accum: 'ph-accum',
  tail: 'ph-unknown',
  unknown: 'ph-unknown',
};

/** 一个四年周期 = 一个带框的区块 */
function buildCycleGroup(cyc, monthly) {
  const months = monthly.filter((m) => m.key >= cyc.from && m.key <= cyc.to);
  const wrap = document.createElement('div');
  wrap.className = 'cycle-group' + (cyc.isCurrent ? ' current' : '');

  // --- 头部 ---
  const head = document.createElement('div');
  head.className = 'cycle-group-head';
  // 标题用周期定义的自然年份（2025–2028），而非仅有数据的年份
  const span = `${cyc.startYear}–${cyc.endYear}`;
  const dataNote = cyc.isCurrent ? `已走 ${cyc.months} 个月` : `${cyc.months} 个月`;
  head.innerHTML = `
    <span class="cg-year">${span} 四年周期</span>
    <span class="cg-range">${cyc.from} → ${cyc.to} · ${dataNote} · 区间 $${fmtNum(cyc.low)} ~ $${fmtNum(cyc.high)}</span>
    ${cyc.isCurrent ? '<span class="cg-badge now">当前周期</span>' : '<span class="cg-badge">已走完</span>'}
  `;
  wrap.appendChild(head);

  // --- 阶段色带（宽度按月数占比）---
  const strip = document.createElement('div');
  strip.className = 'phase-strip';
  const totalM = months.length || 1;
  for (const ph of cyc.phases) {
    const n = months.filter((m) => m.key >= ph.from && m.key <= ph.to).length;
    if (!n) continue;
    const cell = document.createElement('div');
    cell.className = `phase-cell ${PHASE_CLASS[ph.id] || 'ph-unknown'}`;
    if (ph.id === cyc.currentPhaseId) cell.classList.add('now');
    cell.style.flex = `${n} 0 0`;
    cell.style.width = `${(n / totalM) * 100}%`;
    const marker = ph.markerMonth ? `<span class="ph-marker">${ph.id === 'top' ? '顶' : '底'}</span>` : '';
    // 窄格子只显示标记，宽格子显示完整名称
    cell.innerHTML = n >= 5 ? `${ph.name}${marker}` : n >= 2 ? ph.name.slice(0, 2) + marker : marker;
    cell.title = `${ph.name} ${ph.from} ~ ${ph.to}（${n} 个月）${ph.desc ? ' · ' + ph.desc : ''}`;
    strip.appendChild(cell);
  }
  wrap.appendChild(strip);

  // --- 年份格子（每年一行）---
  const byYear = new Map();
  for (const m of months) {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year).push(m);
  }
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    wrap.appendChild(buildYearRow(y, byYear.get(y)));
  }

  return wrap;
}

/** 单年一行 */
function buildYearRow(y, months) {
  const row = document.createElement('div');
  row.className = 'year-row';

  const ups = months.filter((m) => m.changePct > 0).length;
  const downs = months.filter((m) => m.changePct < 0).length;
  const yearChg = months[0].prevClose
    ? ((months[months.length - 1].close - months[0].prevClose) / months[0].prevClose) * 100
    : null;

  const label = document.createElement('div');
  label.className = 'year-row-label';
  label.innerHTML = `
    <span class="yr-year">${y}</span>
    <span class="yr-chg" style="color:${yearChg === null ? 'var(--text-dimmer)' : yearChg >= 0 ? '#39d353' : '#ff7b72'}">
      ${yearChg === null ? '' : (yearChg >= 0 ? '+' : '') + yearChg.toFixed(1) + '%'}
    </span>
    <span class="yr-meta">${ups}涨/${downs}跌</span>
  `;
  row.appendChild(label);

  const grid = document.createElement('div');
  grid.className = 'month-grid';
  for (const m of months) grid.appendChild(makeMonthCell(m));
  row.appendChild(grid);

  return row;
}

function buildYearBlocks(months) {
  const frag = document.createDocumentFragment();
  const byYear = new Map();
  for (const m of months) {
    if (!byYear.has(m.year)) byYear.set(m.year, []);
    byYear.get(m.year).push(m);
  }
  for (const y of [...byYear.keys()].sort((a, b) => a - b)) {
    frag.appendChild(buildYearRow(y, byYear.get(y)));
  }
  return frag;
}

function fmtNum(v) {
  return Math.round(v).toLocaleString('en-US');
}

function makeMonthCell(m) {
  const cell = document.createElement('div');
  const pct = m.changePct;
  cell.className = 'mcell';
  if (m.isPartial) cell.classList.add('partial');
  const cur = snapshot.monthlyStats && snapshot.monthlyStats.current;
  if (cur && m.key === cur.key) cell.classList.add('current');
  cell.style.background = monthColor(pct);
  cell.style.color = monthTextColor(pct);
  cell.dataset.key = m.key;

  const sign = pct === null ? '' : pct >= 0 ? '+' : '';
  cell.innerHTML = `
    <div class="mc-pct">${pct === null ? '—' : sign + pct.toFixed(1) + '%'}</div>
    <div class="mc-m">${m.month}月</div>
  `;

  cell.addEventListener('mouseenter', (e) => showMonthTooltip(e, m));
  cell.addEventListener('mousemove', moveTooltip);
  cell.addEventListener('mouseleave', hideTooltip);
  return cell;
}

function renderLegendMonth() {
  const el = document.getElementById('legend-month');
  const stops = [-60, -30, -15, -5, 0, 5, 15, 30, 60];
  el.innerHTML = stops.map((s) => `<i style="background:${monthColor(s)}"></i>`).join('');
}

function showMonthTooltip(e, m) {
  const tt = document.getElementById('tooltip');
  const pct = m.changePct;
  const sign = pct === null ? '' : pct >= 0 ? '+' : '';
  const color = pct === null ? '#8b949e' : pct >= 0 ? '#39d353' : '#ff7b72';
  tt.innerHTML = `
    <div class="tt-date">${m.key}${m.isPartial ? ' · 进行中' : ''}</div>
    <div class="tt-row"><span>本月收盘</span><b>${fmtPrice(m.close)}</b></div>
    <div class="tt-row"><span>上月收盘</span><b>${m.prevClose ? fmtPrice(m.prevClose) : '—'}</b></div>
    <div class="tt-row"><span>月度涨跌</span><b style="color:${color}">${pct === null ? '—' : sign + pct.toFixed(2) + '%'}</b></div>
    <div class="tt-row"><span>月内最高</span><b>${fmtPrice(m.high)}</b></div>
    <div class="tt-row"><span>月内最低</span><b>${fmtPrice(m.low)}</b></div>
    ${m.isPartial ? `<div class="tt-row" style="margin-top:4px"><span style="color:var(--accent)">本月未结束，用实时价估算</span></div>` : ''}
  `;
  tt.classList.add('show');
  moveTooltip(e);
}

function renderHero(stats, points, halving) {
  const cur = stats.current;

  // 有实时价时以实时价为准（分钟级），否则退回快照收盘价
  if (livePrice && Number.isFinite(livePrice.price)) {
    updatePriceDisplay(livePrice, null);
  } else {
    document.getElementById('price').textContent = fmtPrice(cur.close);

    // 主指标为「本月相对上月」的涨跌幅
    const ms = snapshot.monthlyStats;
    const m = ms && ms.current;
    if (m && m.changePct !== null) {
      const cls = m.changePct >= 0 ? 'up' : 'down';
      const partial = m.isPartial ? '<span style="color:var(--text-dimmer)">（本月进行中）</span>' : '';
      document.getElementById('price-sub').innerHTML =
        `<span class="${cls}">${fmtPct(m.changePct)}</span> 本月 vs 上月 ${fmtPrice(m.prevClose)} ${partial}` +
        ` · 距历史最高 ${cur.drawdownPct}%`;
    } else {
      const prev = points[points.length - 2];
      const chg = prev ? ((cur.close - prev.close) / prev.close) * 100 : 0;
      document.getElementById('price-sub').innerHTML =
        `<span class="${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span> 较上周 · 当前回撤 <b>${cur.drawdownPct}%</b>`;
    }
  }

  const v = verdictOf(cur.score);
  document.getElementById('verdict-value').textContent = v.label;
  document.getElementById('verdict-value').style.color = v.color;
  document.getElementById('verdict-desc').textContent = v.desc;
  document.querySelector('.verdict').style.borderLeftColor = v.color;
}

function renderMetrics(stats, points, halving) {
  const cur = stats.current;
  const el = document.getElementById('metrics');
  const ms = snapshot.monthlyStats;

  const halfTxt = halving ? `${halving.progressPct}%` : '—';
  const halfDesc = halving ? `第 ${halving.epoch + 1} 周期 · 下次减半 ${halving.nextHalvingEta}` : '数据不可用';

  const cards = [
    {
      k: '本月涨跌',
      v: ms && ms.current.changePct !== null ? fmtPct(ms.current.changePct) : '—',
      d: ms ? `vs 上月 ${fmtPrice(ms.current.prevClose)}${ms.current.isPartial ? ' · 进行中' : ''}` : '',
    },
    {
      k: '月度胜率',
      v: ms ? `${ms.winRate}%` : '—',
      d: ms ? `${ms.upMonths} 涨 / ${ms.downMonths} 跌（共 ${ms.months} 月）` : '',
    },
    {
      k: '月度中位数',
      v: ms ? fmtPct(ms.medianChange) : '—',
      d: ms ? `平均 ${fmtPct(ms.avgChange)} · 最强 ${ms.best.key} +${ms.best.changePct}%` : '',
    },
    { k: '周期评分', v: cur.score, d: `历史分位 ${stats.currentScorePercentile}%（越低越便宜）` },
    { k: '距历史最高点', v: `${cur.drawdownPct}%`, d: `ATH ${fmtPrice(stats.ath)}` },
    { k: '减半周期进度', v: halfTxt, d: halfDesc },
  ];

  el.innerHTML = cards
    .map(
      (c) => `<div class="metric">
        <div class="k">${c.k}</div>
        <div class="v">${c.v}</div>
        <div class="d">${c.d}</div>
      </div>`,
    )
    .join('');
}

/** 热力图：按减半周期分段，每段一行，格子按周排列 */
function renderHeatmap(points) {
  const host = document.getElementById('heatmap');
  host.innerHTML = '';

  // 按减半周期切分（减半日为分界）
  const bounds = HALVINGS.map((d) => Date.parse(`${d}T00:00:00Z`));
  const cycles = [];
  for (let ci = 0; ci < HALVINGS.length; ci++) {
    const start = bounds[ci];
    const end = bounds[ci + 1] ?? Infinity;
    const pts = points.filter((p) => p.t >= start && p.t < end);
    if (pts.length) cycles.push({ index: ci, start: HALVINGS[ci], end: HALVINGS[ci + 1] ?? '进行中', pts });
  }

  const lastT = points[points.length - 1].t;

  cycles.forEach((cyc, ci) => {
    const block = document.createElement('div');
    block.className = 'cycle-block';

    const isNow = lastT >= Date.parse(`${cyc.start}T00:00:00Z`) && (ci === cycles.length - 1);
    const meta = document.createElement('div');
    meta.className = 'cycle-head';
    const wins = cyc.pts.reduce((a, b, i, arr) => {
      if (i === 0) return a;
      const d = (b.t - arr[i - 1].t) / 86400000;
      return d > 10 ? a + 1 : a;
    }, 0);
    meta.innerHTML = `
      <span class="cycle-title">周期 ${ci + 1}</span>
      <span class="cycle-meta">${cyc.start} → ${cyc.end} · ${cyc.pts.length} 周</span>
      ${isNow ? '<span class="cycle-tag now">当前所在周期</span>' : '<span class="cycle-tag">已完结</span>'}
    `;
    block.appendChild(meta);

    // 分行：每行最多 52 周（一年），保持格子可读
    const PER_ROW = 52;
    const rows = document.createElement('div');
    rows.style.display = 'flex';
    rows.style.flexDirection = 'column';
    rows.style.gap = '3px';

    for (let r = 0; r < Math.ceil(cyc.pts.length / PER_ROW); r++) {
      const rowPts = cyc.pts.slice(r * PER_ROW, (r + 1) * PER_ROW);
      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const p of rowPts) {
        grid.appendChild(makeCell(p));
      }
      rows.appendChild(grid);
    }
    block.appendChild(rows);
    host.appendChild(block);
  });
}

function makeCell(p) {
  const cell = document.createElement('div');
  const sig = signalMap.get(p.date);
  const score = p.score;

  cell.className = 'cell';
  if (sig) {
    cell.classList.add(sig.type === 'bottom' ? 'signal-buy' : 'signal-sell');
    if (!sig.confirmed) cell.classList.add('pending');
  }
  const cur = snapshot.stats.current;
  if (p.date === cur.date) cell.classList.add('current');

  // 评分越低越绿；用背景色深度表达
  cell.style.background = scoreColor(score);
  cell.dataset.date = p.date;

  cell.addEventListener('mouseenter', (e) => showTooltip(e, p, sig));
  cell.addEventListener('mousemove', moveTooltip);
  cell.addEventListener('mouseleave', hideTooltip);

  return cell;
}

function renderLegend() {
  const el = document.getElementById('legend-scale');
  const stops = [5, 20, 35, 50, 65, 80, 95];
  el.innerHTML = stops.map((s) => `<i style="background:${scoreColor(s)}"></i>`).join('');
}

function renderSignalsTable(signals) {
  const tb = document.querySelector('#signals-table tbody');
  const cur = snapshot.stats.current;
  const rows = signals
    .slice()
    .reverse()
    .map((s) => {
      const isBuy = s.type === 'bottom';
      // 计算该信号之后的实际表现：优先到下一个反向信号，否则算到当前价
      const idx = signals.indexOf(s);
      const next = signals.slice(idx + 1).find((x) => x.type !== s.type);
      const targetPrice = next ? next.price : cur.close;
      const chg = ((targetPrice - s.price) / s.price) * 100;
      const isSinceNow = !next;
      const perfTxt = fmtPct(chg) + (isSinceNow ? ' <span style="color:var(--text-dimmer)">至今</span>' : '');
      const perfColor = chg >= 0 ? 'var(--buy)' : 'var(--sell)';
      return `<tr>
        <td><span class="badge ${isBuy ? 'buy' : 'sell'}">${isBuy ? '▲ 买点' : '▼ 卖点'}</span></td>
        <td class="num">${s.date}</td>
        <td class="num">${fmtPrice(s.price)}</td>
        <td class="num">${s.score}</td>
        <td class="num" style="color:${perfColor}">${perfTxt}</td>
        <td><span class="badge ${s.confirmed ? 'confirmed' : 'pending'}">${s.confirmed ? '已确认' : '待确认'}</span></td>
      </tr>`;
    })
    .join('');
  tb.innerHTML = rows || '<tr><td colspan="6" style="color:var(--text-dim)">暂无信号</td></tr>';
}

// ---------------------------------------------------------------- 走势图

/** 走势图的几何信息，供悬停命中测试复用 */
let chartGeom = null;

function renderChart(points) {
  const canvas = document.getElementById('chart');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = 360;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + 'px';

  const pad = { l: 62, r: 58, t: 26, b: 44 }; // 底部留出年份 + 周期标签条
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const prices = points.map((p) => p.close);
  const logMin = Math.log10(Math.min(...prices) * 0.85);
  const logMax = Math.log10(Math.max(...prices) * 1.15);
  const x = (i) => pad.l + (i / (points.length - 1)) * iw;
  const y = (v) => pad.t + ih - ((Math.log10(v) - logMin) / (logMax - logMin)) * ih;

  // 保存几何信息 + 绘制函数，供悬停时重绘
  chartGeom = { canvas, dpr, W, H, pad, iw, ih, logMin, logMax, x, y, points, draw: null };
  chartGeom.draw = (hoverIdx) => drawChart(chartGeom, hoverIdx);

  // 首次绘制已在别处触发，这里直接画
  chartGeom.draw(null);
}

function drawChart(g, hoverIdx) {
  const { canvas, dpr, W, H, pad, iw, ih, logMin, logMax, x, y, points } = g;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // ---- 四年周期分区（底层背景）----
  const cycleBands = [];
  const cycles = snapshot.cycles || [];
  for (const c of cycles) {
    let a = points.findIndex((p) => p.date.slice(0, 7) >= c.from);
    let b = -1;
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].date.slice(0, 7) <= c.to) {
        b = i;
        break;
      }
    }
    if (a >= 0 && b >= a) cycleBands.push({ cycle: c, a, b });
  }

  // 交替极淡底色，形成周期"区块"感
  cycleBands.forEach((band, bi) => {
    const x0 = x(band.a);
    const x1 = x(band.b);
    if (bi % 2 === 1) {
      ctx.fillStyle = 'rgba(255,255,255,.03)';
      ctx.fillRect(x0, pad.t, x1 - x0, ih);
    }
    // 周期分界竖线
    if (bi > 0) {
      ctx.strokeStyle = 'rgba(230,237,243,.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x0, pad.t);
      ctx.lineTo(x0, pad.t + ih);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  // 背景色带：按评分连续着色（叠在周期底色上，透明度压低避免打架）
  for (let i = 0; i < points.length - 1; i++) {
    ctx.fillStyle = scoreColor(points[i].score);
    ctx.globalAlpha = 0.11;
    const x0 = x(i);
    const x1 = x(i + 1) + 1;
    ctx.fillRect(x0, pad.t, x1 - x0, ih);
  }
  ctx.globalAlpha = 1;

  // y 轴刻度（对数）
  ctx.fillStyle = '#6e7681';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  const ticks = [100, 300, 1000, 3000, 10000, 30000, 100000];
  for (const t of ticks) {
    if (Math.log10(t) < logMin || Math.log10(t) > logMax) continue;
    const yy = y(t);
    ctx.strokeStyle = 'rgba(48,54,61,.7)';
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(pad.l + iw, yy);
    ctx.stroke();
    ctx.fillText(t >= 1000 ? t / 1000 + 'k' : t, pad.l - 8, yy + 4);
  }

  // 价格曲线
  ctx.strokeStyle = '#e6edf3';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.close)) : ctx.moveTo(x(i), y(p.close))));
  ctx.stroke();

  // 信号标记
  for (const s of snapshot.signals) {
    const i = points.findIndex((p) => p.date === s.date);
    if (i < 0) continue;
    const isBuy = s.type === 'bottom';
    const cx = x(i);
    const cy = y(s.close);
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fillStyle = isBuy ? '#39d353' : '#ff7b72';
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = isBuy ? '#39d353' : '#ff7b72';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isBuy ? '买' : '卖', cx, cy + (isBuy ? 20 : -12));
  }

  // ---- x 轴：年份刻度 ----
  ctx.fillStyle = '#6e7681';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  let lastYear = null;
  points.forEach((p, i) => {
    const yr = p.date.slice(0, 4);
    if (yr !== lastYear && Number(yr) % 2 === 0) {
      lastYear = yr;
      ctx.fillText(yr, x(i), H - 24);
    }
  });

  // ---- 底部四年周期标签条 ----
  const bandY = H - 18;
  const bandH = 14;
  cycleBands.forEach((band, bi) => {
    const x0 = x(band.a);
    const x1 = x(band.b);
    const bw = x1 - x0;
    if (bw < 8) return;
    const isCur = band.cycle.isCurrent;

    // 色条
    ctx.fillStyle = isCur ? 'rgba(247,147,26,.9)' : 'rgba(88,166,255,.42)';
    ctx.fillRect(x0, bandY, bw - 1, bandH);

    // 文字
    if (bw >= 62) {
      ctx.fillStyle = isCur ? '#1a1005' : '#e6edf3';
      ctx.font = isCur ? '700 10px -apple-system, sans-serif' : '10px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      const label = `${band.cycle.startYear}–${band.cycle.endYear}`;
      ctx.fillText(label, x0 + bw / 2, bandY + bandH / 2 + 3.5);
    }
  });

  // 周期标签条说明（放在左侧标签列，避开色条）
  ctx.fillStyle = '#484f58';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText('四年周期', pad.l - 8, bandY + bandH / 2 + 3.5);

  // 当前价格标注
  const cur = points[points.length - 1];
  const cy = y(cur.close);
  ctx.strokeStyle = 'rgba(88,166,255,.6)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, cy);
  ctx.lineTo(pad.l + iw, cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#58a6ff';
  ctx.textAlign = 'left';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText(fmtPrice(cur.close), pad.l + iw + 6, cy + 4);

  // ---- 悬停十字准线 ----
  if (hoverIdx !== null && hoverIdx >= 0 && hoverIdx < points.length) {
    const hp = points[hoverIdx];
    const hx = x(hoverIdx);
    const hy = y(hp.close);

    // 垂直参考线
    ctx.strokeStyle = 'rgba(230,237,243,.42)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, pad.t);
    ctx.lineTo(hx, pad.t + ih);
    ctx.stroke();

    // 水平参考线
    ctx.beginPath();
    ctx.moveTo(pad.l, hy);
    ctx.lineTo(pad.l + iw, hy);
    ctx.stroke();
    ctx.setLineDash([]);

    // 高亮点
    ctx.beginPath();
    ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 右侧价格气泡
    const label = fmtPrice(hp.close);
    ctx.font = '600 11px -apple-system, sans-serif';
    const tw = ctx.measureText(label).width;
    const bw = tw + 12;
    const bh = 18;
    let bx = pad.l + iw + 4;
    const by = Math.max(pad.t, Math.min(pad.t + ih - bh, hy - bh / 2));
    ctx.fillStyle = '#e6edf3';
    fillRoundRect(ctx, bx, by, bw, bh, 4);
    ctx.fillStyle = '#0d1117';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 6, by + bh / 2 + 0.5);
    ctx.textBaseline = 'alphabetic';

    // 底部日期气泡
    const dLabel = hp.date;
    ctx.font = '600 10.5px -apple-system, sans-serif';
    const dw = ctx.measureText(dLabel).width;
    let dx = hx - dw / 2 - 6;
    dx = Math.max(pad.l, Math.min(pad.l + iw - (dw + 12), dx));
    const dy = pad.t + ih + 3;
    ctx.fillStyle = '#e6edf3';
    fillRoundRect(ctx, dx, dy, dw + 12, 17, 4);
    ctx.fillStyle = '#0d1117';
    ctx.textAlign = 'left';
    ctx.fillText(dLabel, dx + 6, dy + 12.5);
  }
}

// ---------------------------------------------------------------- 走势图悬停

/** roundRect 在旧浏览器上不存在，降级为普通矩形，避免整图报错 */
function fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fill();
}

/** 把鼠标的 x 坐标换算成最近的数据点下标 */
function chartHitIndex(g, clientX) {
  const rect = g.canvas.getBoundingClientRect();
  const mx = clientX - rect.left;
  // 反解 x(i) = pad.l + (i/(n-1))*iw
  const ratio = (mx - g.pad.l) / g.iw;
  let i = Math.round(ratio * (g.points.length - 1));
  return Math.max(0, Math.min(g.points.length - 1, i));
}

function bindChartHover() {
  const canvas = document.getElementById('chart');
  if (canvas.dataset.hoverBound) return;
  canvas.dataset.hoverBound = '1';

  let raf = 0;
  let lastIdx = null;

  const onMove = (e) => {
    if (!chartGeom) return;
    const i = chartHitIndex(chartGeom, e.clientX);
    if (i === lastIdx) return;
    lastIdx = i;
    // 用 rAF 节流，避免高频 mousemove 反复重绘
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      chartGeom.draw(lastIdx);
    });
    showChartTooltip(e, chartGeom.points[i]);
  };

  const onLeave = () => {
    lastIdx = null;
    hideTooltip();
    if (chartGeom) chartGeom.draw(null);
  };

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  // 触屏：点按也能查看
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches[0]) onMove(e.touches[0]);
  }, { passive: true });
  canvas.addEventListener('touchend', onLeave);
}

function showChartTooltip(e, p) {
  const tt = document.getElementById('tooltip');
  const v = verdictOf(p.score);
  const sig = signalMap.get(p.date);

  // 当前周属于哪个四年周期、哪个阶段
  let cycLine = '';
  const cyc = (snapshot.cycles || []).find((c) => p.date.slice(0, 7) >= c.from && p.date.slice(0, 7) <= c.to);
  if (cyc) {
    const ph = cyc.phases.find((x) => p.date.slice(0, 7) >= x.from && p.date.slice(0, 7) <= x.to);
    const phColor = PHASE_COLOR[ph ? ph.id : 'unknown'] || '#8b949e';
    cycLine =
      `<div class="tt-row"><span>四年周期</span><b>${cyc.startYear}–${cyc.endYear}${cyc.isCurrent ? ' · 当前' : ''}</b></div>` +
      (ph ? `<div class="tt-row"><span>阶段</span><b style="color:${phColor}">${ph.name}</b></div>` : '');
  }

  let extra = '';
  if (sig) {
    extra = `<div class="tt-row"><span>周期信号</span><b style="color:${sig.type === 'bottom' ? '#39d353' : '#ff7b72'}">${sig.type === 'bottom' ? '▲ 底部' : '▼ 顶部'}</b></div>`;
  }

  tt.innerHTML = `
    <div class="tt-date">${p.date}</div>
    <div class="tt-row"><span>价格</span><b style="font-size:14px">${fmtPrice(p.close)}</b></div>
    <div class="tt-row"><span>周期评分</span><b style="color:${scoreColor(p.score)}">${p.score}</b></div>
    <div class="tt-row"><span>距 ATH</span><b>${p.drawdownPct}%</b></div>
    <div class="tt-row"><span>Mayer</span><b>${p.mayer ?? '—'}</b></div>
    ${cycLine}
    ${extra}
    <div class="tt-row" style="margin-top:4px"><span style="color:${v.color}">${v.label}</span></div>
  `;
  tt.classList.add('show');
  moveTooltip(e);
}

// ---------------------------------------------------------------- 仪表盘

function drawGauge(score) {
  const canvas = document.getElementById('gauge');
  const dpr = window.devicePixelRatio || 1;
  const W = 260;
  const H = 150;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H - 22;
  const R = 92;
  const start = Math.PI;
  const end = 2 * Math.PI;

  // 分段弧
  const segs = 60;
  for (let i = 0; i < segs; i++) {
    const a0 = start + (i / segs) * Math.PI;
    const a1 = start + ((i + 0.82) / segs) * Math.PI;
    const s = (i / segs) * 100;
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a1);
    ctx.lineWidth = 14;
    ctx.lineCap = 'butt';
    ctx.strokeStyle = scoreColor(s);
    ctx.stroke();
  }

  // 指针
  const ang = start + (score / 100) * Math.PI;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(ang) * (R - 20), cy + Math.sin(ang) * (R - 20));
  ctx.strokeStyle = '#e6edf3';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#e6edf3';
  ctx.fill();

  // 数值
  ctx.fillStyle = '#e6edf3';
  ctx.font = '700 26px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(score.toFixed(0), cx, cy - 26);
  ctx.fillStyle = '#6e7681';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.fillText('周期评分', cx, cy - 8);

  ctx.fillStyle = '#39d353';
  ctx.textAlign = 'left';
  ctx.fillText('买', cx - R - 4, cy + 16);
  ctx.fillStyle = '#ff7b72';
  ctx.textAlign = 'right';
  ctx.fillText('卖', cx + R + 4, cy + 16);
}

// ---------------------------------------------------------------- Tooltip

function showTooltip(e, p, sig) {
  const tt = document.getElementById('tooltip');
  const v = verdictOf(p.score);
  let extra = '';
  if (sig) {
    extra = `<div class="tt-row"><span>信号</span><b style="color:${sig.type === 'bottom' ? '#39d353' : '#ff7b72'}">${sig.type === 'bottom' ? '▲ 周期底部' : '▼ 周期顶部'}</b></div>`;
  }
  tt.innerHTML = `
    <div class="tt-date">${p.date}</div>
    <div class="tt-row"><span>收盘价</span><b>${fmtPrice(p.close)}</b></div>
    <div class="tt-row"><span>周期评分</span><b style="color:${scoreColor(p.score)}">${p.score}</b></div>
    <div class="tt-row"><span>距 ATH</span><b>${p.drawdownPct}%</b></div>
    <div class="tt-row"><span>Mayer</span><b>${p.mayer ?? '—'}</b></div>
    <div class="tt-row"><span>趋势偏离</span><b>${p.trendDeviation}×</b></div>
    ${extra}
    <div class="tt-row" style="margin-top:4px"><span style="color:${v.color}">${v.label}</span></div>
  `;
  tt.classList.add('show');
  moveTooltip(e);
}

function moveTooltip(e) {
  const tt = document.getElementById('tooltip');
  const pad = 14;
  let left = e.clientX + pad;
  let top = e.clientY + pad;
  const r = tt.getBoundingClientRect();
  if (left + r.width > window.innerWidth - 8) left = e.clientX - r.width - pad;
  if (top + r.height > window.innerHeight - 8) top = e.clientY - r.height - pad;
  tt.style.left = left + 'px';
  tt.style.top = top + 'px';
}

function hideTooltip() {
  document.getElementById('tooltip').classList.remove('show');
}

// ---------------------------------------------------------------- 买点雷达

const RADAR_ADVICE = {
  watch: { text: '进入观察区', desc: '评分已低于 35，开始留意，但还不到买入时机。', cls: 'level-watch' },
  alert: { text: '接近买点', desc: '评分低于 25，已进入历史买点评分范围，可以开始分批建仓。', cls: 'level-alert' },
  buy: { text: '历史级买点', desc: '评分低于 15，历史上三次大底都在这个区间，适合重仓。', cls: 'level-buy' },
  deep: { text: '极度低估', desc: '评分低于 8，2015 年级别的历史大底，极其罕见。', cls: 'level-deep' },
};

function renderRadar() {
  const r = snapshot.radar;
  const box = document.getElementById('radar');
  if (!r || !r.distance) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';

  const d = r.distance;
  const reached = d.reachedLevel ? RADAR_ADVICE[d.reachedLevel] : null;

  box.className = 'radar' + (reached ? ' ' + reached.cls : '');

  document.getElementById('radar-status').textContent = reached ? reached.text : '等待中 · 尚未进入观察区';
  document.getElementById('radar-status').style.color = reached
    ? d.reachedLevel === 'buy' || d.reachedLevel === 'deep'
      ? '#39d353'
      : '#e3813a'
    : 'var(--text)';

  let desc;
  if (reached) {
    desc = reached.desc;
  } else {
    desc = `当前评分 ${d.current}，距「进入观察区(35)」还差 ${d.toNext} 分 · 距买点(15)还差 ${d.toBuy} 分`;
  }
  document.getElementById('radar-desc').textContent = desc;

  // 档位阶梯
  const ladder = document.getElementById('radar-ladder');
  ladder.innerHTML = '';
  const maxScore = 100;
  for (const lv of r.levels) {
    const isReached = d.current < lv.threshold;
    const isNext = d.nextLevel === lv.id;
    const armed = r.armed[lv.id] !== false;
    const pct = Math.max(0, Math.min(100, ((maxScore - lv.threshold) / maxScore) * 100));

    const el = document.createElement('div');
    el.className = 'rung' + (isReached ? ' reached' : '') + (isNext ? ' active' : '');
    const color = lv.id === 'deep' || lv.id === 'buy' ? '#39d353' : lv.id === 'alert' ? '#e3813a' : '#d29922';
    el.innerHTML = `
      <span class="rung-dot" style="background:${isReached ? color : 'var(--text-dimmer)'};color:${color}"></span>
      <span class="rung-name">${lv.emoji} ${lv.label}</span>
      <span class="rung-thr">评分 &lt; ${lv.threshold}</span>
      <span class="rung-bar"><span class="rung-fill" style="width:${isReached ? 100 : Math.max(2, 100 - Math.abs(d.current - lv.threshold) * 2)}%;background:${color}"></span></span>
      <span class="rung-armed">${isReached ? '已触发' : armed ? '待触发' : '冷却中'}</span>
    `;
    el.title = `${lv.label}：评分跌破 ${lv.threshold} 时提醒 · ${lv.desc}`;
    ladder.appendChild(el);
  }
}

// ---------------------------------------------------------------- 定投回测

function renderBacktest() {
  const b = snapshot.backtest;
  const host = document.getElementById('backtest');
  if (!b) {
    host.innerHTML = '<p style="color:var(--text-dim)">回测数据不可用</p>';
    return;
  }

  const s = b.strategy;
  const base = b.baseline;
  const better = s.perDollar > base.perDollar;

  host.innerHTML = `
    <div class="bt-card ${better ? 'win' : ''}">
      <h3>${better ? '🏆 ' : ''}策略：低分多买</h3>
      <div class="bt-sub">按周期评分调整每月投入倍率</div>
      <div class="bt-big">$${s.perDollar}</div>
      <div class="bt-sub" style="margin:0 0 10px">每投入 1 美元的最终产出</div>
      <div class="bt-row"><span>总投入</span><b>$${s.invested.toLocaleString()}</b></div>
      <div class="bt-row"><span>最终市值</span><b>$${s.value.toLocaleString()}</b></div>
      <div class="bt-row"><span>总收益</span><b style="color:var(--buy)">+${s.roiPct}%</b></div>
      <div class="bt-row"><span>年化</span><b>${s.cagrPct}%</b></div>
      <div class="bt-row"><span>平均成本</span><b>$${s.avgCost.toLocaleString()}</b></div>
      <div class="bt-row"><span>持有 BTC</span><b>${s.btc}</b></div>
    </div>

    <div class="bt-card">
      <h3>基准：每月等额定投</h3>
      <div class="bt-sub">不看估值，每月固定投入</div>
      <div class="bt-big">$${base.perDollar}</div>
      <div class="bt-sub" style="margin:0 0 10px">每投入 1 美元的最终产出</div>
      <div class="bt-row"><span>总投入</span><b>$${base.invested.toLocaleString()}</b></div>
      <div class="bt-row"><span>最终市值</span><b>$${base.value.toLocaleString()}</b></div>
      <div class="bt-row"><span>总收益</span><b style="color:var(--buy)">+${base.roiPct}%</b></div>
      <div class="bt-row"><span>年化</span><b>${base.cagrPct}%</b></div>
      <div class="bt-row"><span>平均成本</span><b>$${base.avgCost.toLocaleString()}</b></div>
      <div class="bt-row"><span>持有 BTC</span><b>${base.btc}</b></div>
    </div>

    <div class="bt-card">
      <h3>投入倍率分布</h3>
      <div class="bt-sub">${b.from} → ${b.to} · ${b.months} 个月 · ${b.years} 年</div>
      ${b.tiers.map((t) => `<div class="bt-tier"><span>${t.label} → 投 ${t.mult} 倍</span><b>${t.count} 个月</b></div>`).join('')}
      <div class="bt-note">
        策略在低估月份投入更多，因此平均成本更低。<br>
        期间最大回撤：<b style="color:var(--sell)">${b.maxDrawdownPct}%</b>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------- 浏览器通知

const NOTIFY_KEY = 'btc-radar-notified';

async function requestNotify() {
  const btn = document.getElementById('btn-notify');
  if (!('Notification' in window)) {
    btn.textContent = '浏览器不支持通知';
    btn.disabled = true;
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm === 'granted') {
    btn.textContent = '✓ 桌面通知已开启';
    btn.classList.add('on');
    // 立刻发一条确认
    new Notification('BTC 买点雷达已开启', {
      body: '当周期评分跌破 35 / 25 / 15 / 8 时，我会在这里提醒你。',
      tag: 'btc-radar-on',
    });
  } else {
    btn.textContent = '通知被拒绝';
  }
}

/** 检查是否需要弹出浏览器通知（同一档位只弹一次） */
function maybeNotify() {
  const r = snapshot.radar;
  if (!r || !r.distance || !r.distance.reachedLevel) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const lv = r.distance.reachedLevel;
  const seen = JSON.parse(localStorage.getItem(NOTIFY_KEY) || '{}');
  // 同一档位在同一快照周期内只提醒一次
  const key = `${lv}:${snapshot.generatedAt.slice(0, 13)}`;
  if (seen[key]) return;
  seen[key] = 1;

  // 清理旧记录，避免无限增长
  const keys = Object.keys(seen);
  if (keys.length > 20) delete seen[keys[0]];
  localStorage.setItem(NOTIFY_KEY, JSON.stringify(seen));

  const adv = RADAR_ADVICE[lv];
  new Notification(`BTC ${adv.text} · 评分 ${r.distance.current}`, {
    body: `${adv.desc}\n价格 $${Math.round(r.distance.price).toLocaleString('en-US')}`,
    tag: 'btc-radar-' + lv,
  });
}

function testNotify() {
  if (!('Notification' in window) || Notification.permission !== 'granted') {
    requestNotify();
    return;
  }
  new Notification('测试通知 · BTC 买点雷达', {
    body: '如果你看到这条消息，说明桌面通知工作正常。',
    tag: 'btc-radar-test',
  });
}

function initNotifyUI() {
  const btn = document.getElementById('btn-notify');
  if (!('Notification' in window)) {
    btn.textContent = '浏览器不支持';
    btn.disabled = true;
  } else if (Notification.permission === 'granted') {
    btn.textContent = '✓ 桌面通知已开启';
    btn.classList.add('on');
  } else if (Notification.permission === 'denied') {
    btn.textContent = '通知已被拒绝';
  }
  btn.addEventListener('click', requestNotify);
  document.getElementById('btn-test').addEventListener('click', testNotify);
}

// ---------------------------------------------------------------- 周期对比

const CYCLE_COLORS = ['#58a6ff', '#39d353', '#d29922', '#f7931a'];
const hiddenCycles = new Set();
let compareGeom = null;

function renderCompare() {
  const comps = snapshot.comparisons || [];
  if (!comps.length) return;

  // 图例
  const legend = document.getElementById('compare-legend');
  legend.innerHTML = '';
  comps.forEach((c, i) => {
    const el = document.createElement('span');
    el.className = 'cleg' + (c.isCurrent ? ' now' : '') + (hiddenCycles.has(c.index) ? ' off' : '');
    const color = CYCLE_COLORS[i % CYCLE_COLORS.length];
    el.innerHTML = `<i style="background:${color}"></i>周期 ${c.index} · ${c.label}${c.isCurrent ? ' ← 当前' : ''}`;
    el.title = '点击显示/隐藏';
    el.addEventListener('click', () => {
      if (hiddenCycles.has(c.index)) hiddenCycles.delete(c.index);
      else hiddenCycles.add(c.index);
      renderCompare();
    });
    legend.appendChild(el);
  });

  drawCompare();

  // 卡片
  const cards = document.getElementById('compare-cards');
  cards.innerHTML = comps
    .map((c, i) => {
      const color = CYCLE_COLORS[i % CYCLE_COLORS.length];
      const last = c.series[c.series.length - 1];
      const top = c.top;
      const bot = c.bottom;
      const keyAt = (m) => (c.series.find((s) => s.month === m) || {}).key || '';
      const vsTop = top ? ((last.norm - top.norm) / top.norm) * 100 : 0;
      // 同时给出「归一化倍数」和「真实美元价」，避免只看到一个没有单位的数字
      const fmt = (v) => Math.round(v).toLocaleString('en-US');
      return `
      <div class="ccard ${c.isCurrent ? 'current' : ''}">
        <h4><span class="cc-bar" style="background:${color}"></span>周期 ${c.index} · ${c.label}
          ${c.isCurrent ? '<span class="cc-tag now">当前</span>' : ''}
          ${c.partialFromStart ? '<span class="cc-tag warn">起点缺数据</span>' : ''}
        </h4>
        <div class="cc-sub">起点 ${c.series[0].key} · $${fmt(c.basePrice)} · 已走 ${c.months} 个月</div>
        ${
          top
            ? `<div class="cc-row"><span>见顶于</span><b>第 ${top.month} 月 · ${keyAt(top.month)}</b></div>
               <div class="cc-row"><span>顶部</span><b>$${fmt(top.price)} <span style="color:var(--text-dimmer)">(${top.norm}% 起点)</span></b></div>`
            : ''
        }
        ${
          bot
            ? `<div class="cc-row"><span>触底于</span><b>第 ${bot.month} 月 · ${keyAt(bot.month)}</b></div>
               <div class="cc-row"><span>底部</span><b>$${fmt(bot.price)} <span style="color:var(--text-dimmer)">(${bot.norm}% 起点)</span></b></div>`
            : ''
        }
        <div class="cc-row"><span>最新（第 ${last.month} 月）</span><b>${last.key} · $${fmt(last.price)}</b></div>
        <div class="cc-row"><span>较起点</span><b style="color:${last.norm >= 100 ? 'var(--buy)' : 'var(--sell)'}">${last.norm >= 100 ? '+' : ''}${(last.norm - 100).toFixed(1)}% <span style="color:var(--text-dimmer)">(${last.norm}%)</span></b></div>
        <div class="cc-row"><span>距顶部</span><b style="color:${vsTop >= 0 ? 'var(--buy)' : 'var(--sell)'}">${vsTop.toFixed(1)}%</b></div>
      </div>`;
    })
    .join('');
}

function drawCompare(hoverMonth = null) {
  const comps = (snapshot.comparisons || []).filter((c) => !hiddenCycles.has(c.index));
  const canvas = document.getElementById('compareChart');
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth;
  const H = 490;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pad = { l: 58, r: 20, t: 46, b: 62 }; // 顶部留出年份带，底部留出月份轴
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;

  const MAX_M = 48;
  // 纵轴用对数，因为周期 2 峰值到 2925，而周期 3 只有 327
  const all = comps.flatMap((c) => c.series.map((s) => s.norm));
  const vMin = Math.max(10, Math.min(...all) * 0.75);
  const vMax = Math.max(...all) * 1.25;
  const logMin = Math.log10(vMin);
  const logMax = Math.log10(vMax);

  const x = (m) => pad.l + ((m - 1) / (MAX_M - 1)) * iw;
  const y = (v) => pad.t + ih - ((Math.log10(v) - logMin) / (logMax - logMin)) * ih;

  compareGeom = { canvas, pad, iw, ih, x, y, MAX_M, comps, W, H, dpr };

  // 网格
  ctx.font = '11px -apple-system, sans-serif';
  ctx.strokeStyle = 'rgba(48,54,61,.65)';
  ctx.fillStyle = '#6e7681';
  ctx.textAlign = 'right';
  for (const v of [25, 50, 100, 200, 400, 800, 1600, 3200]) {
    if (v < vMin || v > vMax) continue;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(pad.l + iw, yy);
    ctx.stroke();
    ctx.fillText(String(v), pad.l - 8, yy + 4);
  }

  // 100 基准线（起点）
  const y100 = y(100);
  ctx.strokeStyle = 'rgba(230,237,243,.35)';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(pad.l, y100);
  ctx.lineTo(pad.l + iw, y100);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8b949e';
  ctx.textAlign = 'left';
  ctx.fillText('起点 = 100%', pad.l + 6, y100 - 5);

  // ---- x 轴：每个周期各自的年份带 ----
  // 四条曲线叠在一起，年份各不相同，所以给每个周期画一条独立的年份带
  const allComps = snapshot.comparisons || [];
  const visibleComps = allComps.filter((c) => !hiddenCycles.has(c.index));
  const bandH = 13;
  const bandGap = 3;

  visibleComps.forEach((c, vi) => {
    const ci = allComps.indexOf(c);
    const color = CYCLE_COLORS[ci % CYCLE_COLORS.length];
    const by = pad.t - 4 - (vi + 1) * (bandH + bandGap);

    // 年份分隔竖线（贯穿绘图区）
    ctx.strokeStyle = 'rgba(110,118,129,.22)';
    ctx.lineWidth = 1;
    for (const ys of c.yearSpans) {
      if (ys.fromMonth <= 1) continue;
      const gx = x(ys.fromMonth);
      ctx.beginPath();
      ctx.moveTo(gx, pad.t);
      ctx.lineTo(gx, pad.t + ih);
      ctx.stroke();
    }

    // 年份色带
    ctx.font = '600 10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const ys of c.yearSpans) {
      const x0 = x(ys.fromMonth) - (ys.fromMonth > 1 ? (x(2) - x(1)) / 2 : 0);
      const x1 = x(ys.toMonth) + (x(2) - x(1)) / 2;
      const bw = x1 - x0;
      if (bw < 12) continue;

      ctx.globalAlpha = c.isCurrent ? 0.3 : 0.16;
      ctx.fillStyle = color;
      ctx.fillRect(x0, by, bw - 1.5, bandH);
      ctx.globalAlpha = 1;

      // 年份文字（带周期标识，避免四条带分不清）
      ctx.fillStyle = color;
      const label = bw >= 52 ? `周期${c.index} · ${ys.year}` : bw >= 30 ? String(ys.year) : '';
      if (label) ctx.fillText(label, x0 + bw / 2, by + bandH / 2 + 0.5);
    }
  });
  ctx.textBaseline = 'alphabetic';

  // ---- x 轴月份刻度 ----
  ctx.fillStyle = '#6e7681';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  for (let m = 1; m <= MAX_M; m += 3) {
    const gx = x(m);
    // 刻度短线
    ctx.strokeStyle = 'rgba(110,118,129,.5)';
    ctx.beginPath();
    ctx.moveTo(gx, pad.t + ih);
    ctx.lineTo(gx, pad.t + ih + 4);
    ctx.stroke();
    // 每 6 个月标一次文字，避免拥挤
    if (m % 6 === 1 || m === 1) ctx.fillText('第' + m + '月', gx, pad.t + ih + 19);
  }

  // 月份轴标题
  ctx.fillStyle = '#484f58';
  ctx.font = '10.5px -apple-system, sans-serif';
  ctx.fillText('← 周期内第几个月 →', pad.l + iw / 2, H - 10);

  // 当前周期已走过的月份，画一条竖线
  const cur = (snapshot.comparisons || []).find((c) => c.isCurrent);
  if (cur) {
    const cx = x(cur.months);
    ctx.strokeStyle = 'rgba(247,147,26,.55)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, pad.t);
    ctx.lineTo(cx, pad.t + ih);
    ctx.stroke();
    ctx.setLineDash([]);

    // 标签贴在竖线右侧，避免与年份带重叠
    ctx.fillStyle = '#f7931a';
    ctx.textAlign = 'left';
    ctx.font = '600 10.5px -apple-system, sans-serif';
    const lastKey = cur.series[cur.series.length - 1].key;
    ctx.fillText(`当前 ${lastKey}`, cx + 5, pad.t + 12);
    ctx.font = '11px -apple-system, sans-serif';
  }

  // 各周期曲线
  comps.forEach((c) => {
    const i = snapshot.comparisons.indexOf(c);
    const color = CYCLE_COLORS[i % CYCLE_COLORS.length];
    const isCur = c.isCurrent;

    ctx.strokeStyle = color;
    ctx.lineWidth = isCur ? 2.6 : 1.6;
    ctx.globalAlpha = isCur ? 1 : 0.72;
    ctx.beginPath();
    c.series.forEach((s, k) => (k ? ctx.lineTo(x(s.month), y(s.norm)) : ctx.moveTo(x(s.month), y(s.norm))));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // 顶/底标记：位置取「评分定位的周期拐点」（那才是真正的周期顶底，
    // 月收盘极值会被自然四年的切分带偏，例如周期 2 的月收盘最高点落在第 48 月，
    // 但真实的周期顶是第 12 月）；纵坐标取该月的最高/最低价对应的归一化值。
    const markTop = c.top;
    const markBot = c.bottom;
    if (!markTop || !markBot) return;

    const px = x(markTop.month);
    const py = y(markTop.norm);
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#0d1117';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = '600 10px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('顶', px, py - 10);

    // 谷值标记（空心）
    const tx = x(markBot.month);
    const ty = y(markBot.norm);
    ctx.beginPath();
    ctx.arc(tx, ty, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0d1117';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText('底', tx, ty + 17);

    // 当前周期末端显示数值
    if (isCur) {
      const last = c.series[c.series.length - 1];
      ctx.beginPath();
      ctx.arc(x(last.month), y(last.norm), 5.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });

  // 悬停：显示该月各周期的数值
  if (hoverMonth !== null) {
    const hx = x(hoverMonth);
    ctx.strokeStyle = 'rgba(230,237,243,.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, pad.t);
    ctx.lineTo(hx, pad.t + ih);
    ctx.stroke();
    ctx.setLineDash([]);

    comps.forEach((c) => {
      const i = snapshot.comparisons.indexOf(c);
      const color = CYCLE_COLORS[i % CYCLE_COLORS.length];
      const s = c.series.find((v) => v.month === hoverMonth);
      if (!s) return;
      ctx.beginPath();
      ctx.arc(x(s.month), y(s.norm), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.8;
      ctx.stroke();
    });
  }
}

function showCompareTooltip(e, month) {
  const comps = (snapshot.comparisons || []).filter((c) => !hiddenCycles.has(c.index));
  const rows = comps
    .map((c) => {
      const i = snapshot.comparisons.indexOf(c);
      const color = CYCLE_COLORS[i % CYCLE_COLORS.length];
      const s = c.series.find((v) => v.month === month);
      if (!s) {
        return `<div class="tt-row"><span style="color:${color}">周期${c.index}</span><b style="color:var(--text-dimmer)">未走到</b></div>`;
      }
      return `<div class="tt-row"><span style="color:${color}">周期${c.index} · ${s.key}</span><b>${fmtPrice(s.price)} <span style="color:var(--text-dimmer)">(${s.norm}%)</span></b></div>`;
    })
    .join('');
  // 从任一有数据的周期取该月的年月，作为标题参考
  const anyS = comps.map((c) => c.series.find((v) => v.month === month)).find(Boolean);
  const title = anyS ? `周期内第 ${month} 个月（如 ${anyS.key}）` : `周期内第 ${month} 个月`;
  const tt = document.getElementById('tooltip');
  tt.innerHTML = `<div class="tt-date">${title}</div>${rows}`;
  tt.classList.add('show');
  moveTooltip(e);
}

function bindCompareHover() {
  const canvas = document.getElementById('compareChart');
  if (canvas.dataset.hoverBound) return;
  canvas.dataset.hoverBound = '1';
  let raf = 0;
  let last = null;

  const onMove = (e) => {
    if (!compareGeom) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const ratio = (mx - compareGeom.pad.l) / compareGeom.iw;
    const m = Math.max(1, Math.min(compareGeom.MAX_M, Math.round(ratio * (compareGeom.MAX_M - 1)) + 1));
    if (m === last) return;
    last = m;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      drawCompare(last);
    });
    showCompareTooltip(e, m);
  };
  const onLeave = () => {
    last = null;
    hideTooltip();
    drawCompare(null);
  };
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
  canvas.addEventListener('touchstart', (e) => { if (e.touches[0]) onMove(e.touches[0]); }, { passive: true });
  canvas.addEventListener('touchend', onLeave);
}

// ---------------------------------------------------------------- 历史买点规律

function renderBuyAnalysis() {
  const b = snapshot.buyAnalysis;
  const panel = document.getElementById('buy-panel');
  if (!b) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';

  const passed = b.currentChecks.filter((c) => c.pass).length;
  const total = b.currentChecks.length;

  document.getElementById('buy-summary').innerHTML =
    `${b.count} 个历史买点 · 当前满足 <b style="color:${passed === total ? 'var(--buy)' : 'var(--sell)'}">${passed}/${total}</b> 条标准 · ` +
    `买点评分区间 <b>${b.scoreRange.min} ~ ${b.scoreRange.max}</b>`;

  // ---- 四条标准检查 ----
  const check = document.getElementById('buy-check');
  check.innerHTML = b.currentChecks
    .map((c) => {
      const gapText =
        c.gap !== undefined && !c.pass
          ? `还差 ${Math.abs(c.gap)}${c.id === 'drawdown' ? ' 个百分点' : ' 分'}`
          : c.pass
            ? '已满足'
            : '';
      const colorId = c.id === 'drawdown' ? '' : '';
      return `
      <div class="bchk ${c.pass ? 'pass' : 'fail'}">
        <div class="bk-top">
          <span class="bk-name">${c.name}</span>
          <span class="bk-icon">${c.pass ? '✅' : '❌'}</span>
        </div>
        <div class="bk-val">${typeof c.value === 'number' ? (c.id === 'drawdown' ? c.value + '%' : c.value) : c.value}</div>
        <div class="bk-req">要求 ${c.req}${gapText ? ' · ' + gapText : ''}</div>
      </div>`;
    })
    .join('');

  // ---- 阶段分布 ----
  const maxCount = Math.max(...b.phaseDist.map((p) => p.count), 1);
  const totalR = b.count || 1;
  document.getElementById('buy-phases').innerHTML = `
    <div class="ph-dist">
      ${b.phaseDist
        .map(
          (p) => `
        <div class="phd-row ${p.count === 0 ? 'zero' : ''}">
          <span class="phd-name">${p.name}</span>
          <span class="phd-bar">
            ${
              p.count > 0
                ? `<span class="phd-seg" style="width:${(p.count / totalR) * 100}%;background:${PHASE_COLOR[p.id] || '#8b949e'}"></span>`
                : ''
            }
          </span>
          <span class="phd-count">${p.count} 个</span>
        </div>`,
        )
        .join('')}
    </div>`;

  document.getElementById('buy-phase-note').innerHTML =
    b.forbiddenPhaseCount === 0
      ? '历史上 <b>上涨期与顶部区从未出现买点</b>，6 个买点全部落在下跌期或盘整期 —— 这是最可靠的规律。'
      : `有 ${b.forbiddenPhaseCount} 个买点出现在上涨期/顶部区。`;

  // ---- 周期内月份刻度 ----
  const monthRows = b.rows.filter((r) => r.monthInCycle !== null);
  const dots = monthRows
    .map((r) => {
      const left = ((r.monthInCycle - 1) / 47) * 100;
      const color = r.confirmed ? '#58a6ff' : '#d29922';
      return `<span class="mo-dot${r.confirmed ? '' : ' now'}" style="left:${left}%;background:${color}"
        title="${r.date} · 周期第 ${r.monthInCycle} 月 · 评分 ${r.score}"></span>`;
    })
    .join('');
  const nowMonth = snapshot.currentCycle && snapshot.currentCycle.progress ? snapshot.currentCycle.progress.elapsed : null;
  const nowMark =
    nowMonth !== null
      ? `<span class="mo-now-line" style="left:${((nowMonth - 1) / 47) * 100}%"></span>`
      : '';

  document.getElementById('buy-months').innerHTML = `
    <div class="mo-scale">
      <span class="mo-track"></span>
      <span class="mo-zone" style="left:${((16 - 1) / 47) * 100}%;width:${((24 - 16) / 47) * 100}%"></span>
      ${dots}${nowMark}
      <span class="mo-labels"><span>第1月</span><span>第12月</span><span>第24月</span><span>第36月</span><span>第48月</span></span>
    </div>`;

  // ---- 买点明细表 ----
  const tb = document.querySelector('#buy-table tbody');
  tb.innerHTML = b.rows
    .map((r) => {
      const g = (v) => (v ? `<span class="gain">+${v.pct}%</span>` : '<span class="na">数据不足</span>');
      const dd = r.dd1y ? `<span class="dd">${r.dd1y.pct.toFixed(1)}%</span>` : '<span class="na">—</span>';
      return `
      <tr class="${r.confirmed ? '' : 'unconfirmed'}">
        <td class="num">${r.date}${r.confirmed ? '' : ' <span style="color:#d29922">待确认</span>'}</td>
        <td class="num">${fmtPrice(r.price)}</td>
        <td class="num" style="color:${scoreColor(r.score)};font-weight:600">${r.score}</td>
        <td class="num">${r.drawdownPct ?? '—'}%</td>
        <td>${r.cycleLabel ?? '—'}</td>
        <td>${r.phaseName ?? '—'}</td>
        <td class="num">${g(r.gain1y)}</td>
        <td class="num">${g(r.gain2y)}</td>
        <td class="num">${dd}</td>
      </tr>`;
    })
    .join('');
}

// ---------------------------------------------------------------- 实时价格

/**
 * 价格来源策略（按顺序尝试）：
 *   1. 本地后端 /api/price（自建服务运行时，最稳）
 *   2. 交易所公开接口直连（GitHub Pages 等纯静态托管时使用，支持 CORS）
 * 任一成功即可，全失败则保留上次价格并提示。
 */
const SPOT_SOURCES = [
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    pick: (d) => Number(d.price),
  },
  {
    name: 'OKX',
    url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
    pick: (d) => Number(d.data && d.data[0] && d.data[0].last),
  },
  {
    name: 'Coinbase',
    url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    pick: (d) => Number(d.data && d.data.amount),
  },
];

/** 静态模式标记：后端不可用时置为 true，之后不再反复请求 /api */
let staticMode = false;

async function fetchFromLocalApi() {
  if (staticMode) return null;
  try {
    const res = await fetch('/api/price', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const p = await res.json();
    if (!p || !Number.isFinite(p.price)) throw new Error('bad payload');
    return { price: p.price, source: p.source || 'local', at: p.at || new Date().toISOString(), monthly: p.monthly };
  } catch {
    // 后端不存在（静态托管）或临时故障，转向直连交易所
    staticMode = true;
    return null;
  }
}

async function fetchFromExchange() {
  for (const src of SPOT_SOURCES) {
    try {
      const res = await fetch(src.url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const price = src.pick(d);
      if (Number.isFinite(price) && price > 0) {
        return { price, source: src.name, at: new Date().toISOString(), monthly: null };
      }
    } catch {
      /* 试下一个源 */
    }
  }
  return null;
}

/** 拉取实时价格并局部更新页面（不重绘整图，避免闪烁） */
async function loadPrice() {
  try {
    let p = await fetchFromLocalApi();
    if (!p) p = await fetchFromExchange();
    if (!p) throw new Error('所有价格源均不可用');

    // 直连模式下没有后端算好的月度数据，用快照里的上月收盘自行计算
    if (!p.monthly && snapshot && snapshot.monthlyStats && snapshot.monthlyStats.current) {
      const prevClose = snapshot.monthlyStats.current.prevClose;
      if (prevClose) {
        p.monthly = {
          key: snapshot.monthlyStats.current.key,
          price: p.price,
          prevClose,
          changePct: +(((p.price - prevClose) / prevClose) * 100).toFixed(2),
          isPartial: true,
        };
      }
    }

    const prev = livePrice ? livePrice.price : null;
    livePrice = p;
    updatePriceDisplay(p, prev);
    return p;
  } catch (err) {
    const el = document.getElementById('live-status');
    if (el) el.textContent = '价格获取失败';
    return null;
  }
}

/** 局部更新价格相关 DOM */
function updatePriceDisplay(p, prev) {
  // 顶部大价格
  const priceEl = document.getElementById('price');
  if (priceEl) {
    priceEl.textContent = fmtPrice(p.price);
    // 价格变动时闪一下颜色
    if (prev !== null && prev !== p.price) {
      const up = p.price > prev;
      priceEl.classList.remove('flash-up', 'flash-down');
      void priceEl.offsetWidth; // 强制重排以重启动画
      priceEl.classList.add(up ? 'flash-up' : 'flash-down');
    }
  }

  // 本月环比（用实时价 vs 上月收盘）
  const subEl = document.getElementById('price-sub');
  if (subEl && p.monthly) {
    const m = p.monthly;
    const cls = m.changePct >= 0 ? 'up' : 'down';
    subEl.innerHTML =
      `<span class="${cls}">${fmtPct(m.changePct)}</span> 本月 vs 上月 ${fmtPrice(m.prevClose)}` +
      `<span style="color:var(--text-dimmer)">（本月进行中）</span>`;
  }

  // 价格行情条
  const statusEl = document.getElementById('live-status');
  if (statusEl) {
    const age = Math.round((Date.now() - Date.parse(p.at)) / 1000);
    const src = { binance: 'Binance', okx: 'OKX', coinbase: 'Coinbase', kraken: 'Kraken' }[p.source] || p.source;
    statusEl.textContent = `${src} · ${age < 60 ? age + ' 秒前' : Math.round(age / 60) + ' 分钟前'}`;
  }

  // 指标卡里的「本月涨跌」
  const cards = document.querySelectorAll('.metric');
  if (cards.length && p.monthly) {
    const v = cards[0].querySelector('.v');
    const d = cards[0].querySelector('.d');
    if (v) {
      v.textContent = fmtPct(p.monthly.changePct);
      v.style.color = p.monthly.changePct >= 0 ? 'var(--buy)' : 'var(--sell)';
    }
    if (d) d.textContent = `vs 上月 ${fmtPrice(p.monthly.prevClose)} · 实时`;
  }

  // 页脚时间
  const gen = document.getElementById('generated');
  if (gen && !gen.dataset.fixed) {
    gen.dataset.fixed = '1';
  }
}

// ---------------------------------------------------------------- 实时状态

/**
 * 获取快照：
 *   1. 自建后端 /api/snapshot
 *   2. 静态文件 ./data.json（GitHub Pages / 静态托管）
 */
async function fetchSnapshot() {
  if (!staticMode) {
    try {
      const res = await fetch('/api/snapshot', { cache: 'no-store' });
      if (res.ok) return await res.json();
      // 4xx/5xx 通常说明没有后端，切静态模式
      if (res.status === 404) staticMode = true;
    } catch {
      staticMode = true;
    }
  }
  const res = await fetch('./data.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('静态数据缺失 (HTTP ' + res.status + ')');
  return await res.json();
}

async function load() {
  try {
    const data = await fetchSnapshot();
    const isNew = !snapshot || data.generatedAt !== snapshot.generatedAt;
    snapshot = data;
    if (isNew) {
      render();
      maybeNotify();
    }
    setStatus(true, data);
  } catch (err) {
    setStatus(false, null, err.message);
  }
}

function setStatus(ok, data, errMsg) {
  const dot = document.getElementById('dot');
  const txt = document.getElementById('status-text');
  if (!ok) {
    dot.className = 'dot error';
    txt.textContent = '数据获取失败：' + errMsg;
    return;
  }
  dot.className = 'dot live';
  const ageMin = Math.round((Date.now() - Date.parse(data.generatedAt)) / 60000);
  const ageText = ageMin < 1 ? '刚刚' : ageMin < 60 ? ageMin + ' 分钟前' : Math.round(ageMin / 60) + ' 小时前';

  if (data.stale) {
    txt.textContent = '数据源暂时不可用（显示缓存）';
  } else if (staticMode) {
    // 静态托管：数据由 CI 定时烘焙，用"数据时间"而非"刚刚"更诚实
    txt.textContent = `历史数据更新于 ${ageText} · 价格实时`;
  } else {
    txt.textContent = `实时 · 更新于 ${ageText}`;
  }
}

// 视图切换
const SECTIONS = ['overview', 'analysis', 'signal', 'backtest'];

function switchView(view) {
  if (!SECTIONS.includes(view)) view = 'overview';
  currentView = view;

  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  // 每次只显示一个板块；顶部行情条（hero / cycleBanner / radar）常驻，不参与切换
  for (const id of SECTIONS) {
    const el = document.getElementById('view-' + id);
    if (el) el.classList.toggle('hidden', id !== view);
  }

  // 切换后重画 canvas：隐藏期间尺寸为 0，直接显示会得到空白图
  if (snapshot) {
    if (view === 'analysis') {
      renderChart(snapshot.points);
      drawCompare();
    }
    drawGauge(snapshot.stats.current.score);
  }

  try {
    localStorage.setItem('btc-heatmap-view', view);
  } catch {
    /* 忽略隐私模式报错 */
  }
}

document.querySelectorAll('.tab').forEach((t) => {
  t.addEventListener('click', () => switchView(t.dataset.view));
});

// 启动
try {
  const saved = localStorage.getItem('btc-heatmap-view');
  if (SECTIONS.includes(saved)) currentView = saved;
} catch {
  /* 忽略 */
}
// 无论初始板块是什么都跑一次，确保隐藏的 canvas 在首次显示时能被正确绘制
switchView(currentView);

initNotifyUI();
load();
setInterval(load, POLL_MS);
// 实时价格独立轮询（分钟级），与历史快照解耦
loadPrice();
setInterval(loadPrice, PRICE_POLL_MS);
// 页面重新可见时立刻补一次，避免后台标签页暂停定时器导致数据陈旧
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadPrice();
});
window.addEventListener('resize', () => {
  if (snapshot) {
    renderChart(snapshot.points);
    drawGauge(snapshot.stats.current.score);
    if (currentView === 'analysis') drawCompare();
  }
});
