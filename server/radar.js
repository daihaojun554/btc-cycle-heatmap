'use strict';

/**
 * 买点雷达：监控周期评分，跌破档位时触发提醒。
 *
 * 档位设计依据：
 *   - 历史所有真买点的评分在 3.2 ~ 26.5 之间（最贵的一次是 2026-06 的 26.5）
 *   - 因此 30 分是「首次值得动手」的位置，35 分以上仍属追高
 *
 * 每档附带仓位建议，比例对应「把计划资金分成 10 份」的投入节奏：
 *   entry  30  首次动手（高于历史最贵买点，只投小仓）
 *   add    25  进入历史买点区间，加仓
 *   buy    15  历史级买点（2018/2020/2022 三次大底都在此附近）
 *   deep    8  极度低估（2015 双底级别），投入最大
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'radar-state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'radar-events.jsonl');

const LEVELS = [
  {
    id: 'deep',
    threshold: 8,
    label: '极度低估',
    emoji: '🟢',
    desc: '2015 年级别的历史大底，十年级别机会',
    action: '投入剩余全部（计划的最后 3 成）',
  },
  {
    id: 'buy',
    threshold: 15,
    label: '历史级买点',
    emoji: '🟢',
    desc: '2018 / 2020 / 2022 三次真买点都在此区间',
    action: '重仓，投入计划的 3 成',
  },
  {
    id: 'add',
    threshold: 25,
    label: '进入买点区间',
    emoji: '🟡',
    desc: '已覆盖历史所有买点的评分上限（最贵的一次是 26.5）',
    action: '加仓，投入计划的 3 成',
  },
  {
    id: 'entry',
    threshold: 30,
    label: '可以开始动手',
    emoji: '🟠',
    desc: '低于此值才值得买入，之前都算追高',
    action: '小仓试水，投入计划的 2 成',
  },
];

// 各档位回升多少分后重新武装（避免在阈值附近反复横跳时刷屏）
const REARM_MARGIN = 5;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { armed: {}, lastScore: null, lastCheck: null, history: [] };
  }
}

function writeState(st) {
  ensureDir();
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * 检查评分是否需要触发提醒。
 * @param {Object} snap 当前快照
 * @returns {{fired: Array, state: Object, distance: Object}}
 */
function checkRadar(snap) {
  const score = snap.stats.current.score;
  const price = snap.spot ?? snap.stats.current.close;
  const st = readState();

  // 首次运行：初始化各档位状态，不触发历史提醒
  const firstRun = st.lastScore === null;
  if (!st.armed) st.armed = {};

  // 清理已废弃的档位 ID（例如早期版本的 watch / alert），避免状态文件里堆积无效键
  const validIds = new Set(LEVELS.map((l) => l.id));
  for (const key of Object.keys(st.armed)) {
    if (!validIds.has(key)) delete st.armed[key];
  }

  const fired = [];
  for (const lv of LEVELS) {
    const wasArmed = st.armed[lv.id] !== false; // 默认处于武装状态
    const nowBelow = score < lv.threshold;

    if (nowBelow && wasArmed) {
      fired.push({ ...lv, score, price, at: new Date().toISOString() });
      st.armed[lv.id] = false; // 触发后解除武装，避免重复提醒
    } else if (!nowBelow && score > lv.threshold + REARM_MARGIN) {
      // 评分回升足够多，重新武装，等待下一次跌破
      st.armed[lv.id] = true;
    }
  }

  st.lastScore = score;
  st.lastCheck = new Date().toISOString();
  writeState(st);

  // 一次只提醒「跌破的最深档位」，避免评分暴跌时连发多条通知
  // LEVELS 按阈值升序排列（deep 8 → watch 35），最深 = 阈值最小
  const deepest = fired.length ? fired[0] : null;

  // 距下一个档位还差多少
  const nextLevel = [...LEVELS].reverse().find((lv) => score >= lv.threshold) || null;
  const reached = LEVELS.find((lv) => score < lv.threshold) || null;

  return {
    fired: firstRun || !deepest ? [] : [deepest],
    allFired: fired,
    firstRun,
    state: st,
    distance: {
      current: score,
      price,
      reachedLevel: reached ? reached.id : null,
      nextLevel: nextLevel ? nextLevel.id : null,
      toNext: nextLevel ? +(score - nextLevel.threshold).toFixed(1) : null,
      toBuy: +(score - 15).toFixed(1),
      toAlert: +(score - 25).toFixed(1),
    },
  };
}

/** 记录提醒事件（用于页面展示历史提醒） */
function recordEvents(events) {
  if (!events.length) return;
  ensureDir();
  for (const e of events) {
    fs.appendFileSync(EVENTS_FILE, `${JSON.stringify(e)}\n`);
  }
}

function readEvents(limit = 50) {
  try {
    const lines = fs.readFileSync(EVENTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}

module.exports = { checkRadar, recordEvents, readEvents, LEVELS };
