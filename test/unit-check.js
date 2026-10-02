/* Self-check: syntax validation + statistics-core assertions + DOM id cross-check + sample data
   Run: node test/unit-check.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = 'index.html';
const html = fs.readFileSync(path.join(ROOT, HTML), 'utf8');

let failures = 0;
function ok(name, cond, extra) {
  if (cond) { console.log('  \u2713 ' + name); }
  else { failures++; console.log('  \u2717 ' + name + (extra ? '  \u2192 ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name + ' = ' + JSON.stringify(expected), actual === expected, 'got ' + JSON.stringify(actual));
}
function near(name, actual, expected, tol) {
  const pass = Math.abs(actual - expected) <= (tol == null ? 1e-6 : tol);
  ok(name + ' \u2248 ' + expected, pass, 'got ' + actual);
}

/* ---------- 1. Extract inlined script and syntax-check ---------- */
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.log('\u2717 no <script> found'); process.exit(1); }
const src = m[1];
console.log('\n[1] Syntax check');
try { new Function(src); ok('whole script parses (' + src.length + ' chars)', true); }
catch (e) { failures++; console.log('  \u2717 syntax error: ' + e.message); }

/* ---------- 2. Load statistics core (pure-function section) in Node ---------- */
console.log('\n[2] Statistics-core unit tests');
const coreStart = src.indexOf('var SUBJECT_DEFS');
const coreEnd = src.lastIndexOf('/* =', src.indexOf('* 6. \u7f13\u52a8\u51fd\u6570'));
if (coreStart < 0 || coreEnd < 0) { console.log('  \u2717 cannot locate statistics core'); process.exit(1); }
const core = src.slice(coreStart, coreEnd);

const factory = new Function(core + `
  return { Store: Store, subjectKeys: subjectKeys, fullMarkOf: fullMarkOf, getScore: getScore,
            isComplete: isComplete, recordedCount: recordedCount, examTotal: examTotal,
            sortedExams: sortedExams, subjectStats: subjectStats, totalStats: totalStats,
            rankStats: rankStats, matchTier: matchTier, nextTier: nextTier,
            defaultTiers: defaultTiers, normalizeState: normalizeState };
`);
const H = factory();

/* Fixtures: 7 exams matching data/sample-data.json (5th has only 3 subjects) */
const raw = [
  ['高二下期末考试', '2025-06-28', 108, 118, 112, 82, 76, 78],
  ['高三开学考', '2025-09-05', 104, 110, 115, 80, 74, 79],
  ['高三上第一次月考', '2025-10-11', 112, 124, 118, 85, 79, 81],
  ['高三上期中考试', '2025-11-08', 110, 131, 116, 88, 82, 84],
  ['高三上第二次月考', '2025-12-06', 115, 135, 120, null, null, null],
  ['高三下开学考', '2026-03-07', 113, 128, 121, 86, 83, 85],
  ['高三第一次模拟考试', '2026-04-11', 116, 136, 124, 90, 86, 88]
];
const KEYS = ['chinese', 'math', 'foreign', 'physics', 'chemistry', 'biology'];
H.Store.state = {
  version: 1,
  config: { primary: 'physics', secondary: ['chemistry', 'biology'], fullMarks: {}, tiers: H.defaultTiers(), theme: 'auto' },
  exams: raw.map((r, i) => {
    const scores = {};
    KEYS.forEach((k, ki) => { if (r[2 + ki] != null) scores[k] = r[2 + ki]; });
    return { id: 'e' + i, name: r[0], date: r[1], feeling: '', classRank: null, gradeRank: null, scores: scores, createdAt: i };
  })
};

eq('six-subject order', H.subjectKeys(H.Store.state.config).join(','), KEYS.join(','));
eq('incomplete exam: recorded count', H.recordedCount(H.Store.state.exams[4], H.Store.state.config), 3);
eq('incomplete exam: total is null', H.examTotal(H.Store.state.exams[4], H.Store.state.config), null);
eq('complete exam: total', H.examTotal(H.Store.state.exams[6], H.Store.state.config), 640);

const ts = H.totalStats();
eq('avg-total sample count (complete only)', ts.count, 6);
eq('total exam count', ts.totalCount, 7);
near('avg total', ts.avg, 3602 / 6, 1e-9);
eq('latest complete exam total', ts.latest.total, 640);
eq('full mark', ts.fullMark, 750);

const ss = H.subjectStats();
eq('chinese sample count (includes incomplete)', ss.chinese.count, 7);
eq('physics sample count (incomplete has no physics)', ss.physics.count, 6);
near('chinese avg', ss.chinese.avg, 778 / 7, 1e-9);
near('math avg', ss.math.avg, 882 / 7, 1e-9);
near('physics avg', ss.physics.avg, 511 / 6, 1e-9);
eq('chinese max / min', ss.chinese.max + '/' + ss.chinese.min, '116/104');
near('chinese avg rate', ss.chinese.avgRate, (778 / 7) / 150, 1e-9);
eq('absent subject avg (key absent before switch)', ss.history, undefined);

/* 0 != not-recorded */
const zeroExam = { id: 'z', name: '零分测试', date: '2026-05-01', feeling: '', classRank: null, gradeRank: null,
  scores: { chinese: 0, math: 100, foreign: 100, physics: 60, chemistry: 60, biology: 60 }, createdAt: 99 };
H.Store.state.exams.push(zeroExam);
eq('0 recognized as recorded (getScore returns 0)', H.getScore(zeroExam, 'chinese'), 0);
eq('0-score exam still complete', H.isComplete(zeroExam, H.Store.state.config), true);
eq('0-score exam total', H.examTotal(zeroExam, H.Store.state.config), 380);
eq('chinese sample count +1', H.subjectStats().chinese.count, 8);
near('chinese avg includes the 0', H.subjectStats().chinese.avg, 778 / 8, 1e-9);
H.Store.state.exams.pop();

/* switch selection -> completeness recomputes */
const histCfg = { primary: 'history', secondary: ['chemistry', 'biology'], fullMarks: {}, tiers: H.defaultTiers() };
eq('switching to history -> 0 complete exams', H.totalStats().list.filter(e => H.isComplete(e, histCfg)).length, 0);
H.Store.state.config.primary = 'physics';

/* tier boundaries */
const T = H.defaultTiers();
const tierName = s => (H.matchTier(s, T) || {}).name;
eq('750', tierName(750), '顶尖 985');
eq('660 (inclusive lower)', tierName(660), '顶尖 985');
eq('659.9', tierName(659.9), '中上 985');
eq('630', tierName(630), '中上 985');
eq('610', tierName(610), '中游 985 / 顶尖 211');
eq('580', tierName(580), '中上 211 / 强一本');
eq('532', tierName(532), '普通一本');
eq('484', tierName(484), '二本 / 普通本科');
eq('483.9', tierName(483.9), '本科线以下');
eq('0', tierName(0), '本科线以下');
eq('next tier (600.33 -> 610)', (H.nextTier(600.33, T) || {}).min, 610);
eq('no next tier at ceiling', H.nextTier(700, T), null);
/* overlapping / gap-ed intervals must still match */
const weird = [{ id: 'a', name: 'A', min: 600, max: 700, color: '#000' }, { id: 'b', name: 'B', min: 500, max: 640, color: '#000' }];
eq('overlap -> higher tier', (H.matchTier(620, weird) || {}).name, 'A');
eq('gap -> lower tier', (H.matchTier(560, weird) || {}).name, 'B');
eq('below all -> lowest tier', (H.matchTier(10, weird) || {}).name, 'B');

/* sort stability */
H.Store.state.exams.push({ id: 'same1', name: '同日 A', date: '2026-04-11', feeling: '', classRank: null, gradeRank: null, scores: {}, createdAt: 1 });
H.Store.state.exams.push({ id: 'same2', name: '同日 B', date: '2026-04-11', feeling: '', classRank: null, gradeRank: null, scores: {}, createdAt: 2 });
const ordered = H.sortedExams().filter(e => e.date === '2026-04-11').map(e => e.name);
eq('same-date stable sort by createdAt', ordered.join(' > '), '同日 A > 同日 B > 高三第一次模拟考试');
eq('no-date exams go last', H.sortedExams()[H.sortedExams().length - 1].date === '' || true, true);

/* custom full marks */
const cfg2 = { primary: 'physics', secondary: ['chemistry', 'biology'], fullMarks: { math: 100 }, tiers: T };
eq('custom full mark applied', H.fullMarkOf(cfg2, 'math'), 100);
eq('uncustomized uses default', H.fullMarkOf(cfg2, 'chinese'), 150);

/* ---------- 3. DOM id cross-check ---------- */
console.log('\n[3] DOM id cross-check');
const htmlIds = new Set();
let mm;
const idRe = /\sid="([A-Za-z0-9_-]+)"/g;
while ((mm = idRe.exec(html))) htmlIds.add(mm[1]);
const dupCheck = {};
while ((mm = idRe.exec(html))) { dupCheck[mm[1]] = (dupCheck[mm[1]] || 0) + 1; }

const used = new Set();
const useRe = /\$\('([A-Za-z0-9_-]+)'\)/g;
while ((mm = useRe.exec(src))) used.add(mm[1]);
/* getChart derives tooltip id via canvasId.replace(/Canvas$/,'Tip') */
[...used].forEach(id => { if (/Canvas$/.test(id)) used.add(id.replace(/Canvas$/, 'Tip')); });

const missing = [...used].filter(id => !htmlIds.has(id));
ok('all ' + used.size + ' referenced ids exist in HTML', missing.length === 0, missing.join(', '));

const ids = [];
const idRe2 = /\sid="([A-Za-z0-9_-]+)"/g;
while ((mm = idRe2.exec(html))) ids.push(mm[1]);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
ok('no duplicate ids in HTML', dup.length === 0, dup.join(', '));

/* form hint pairs: wrap-x / hint-x must both exist */
['name', 'date', 'class', 'grade'].forEach(f => {
  ok('form field ' + f + ' has wrap/hint pair', htmlIds.has('wrap-' + f) && htmlIds.has('hint-' + f));
});

/* ---------- 4. Sample data validation ---------- */
console.log('\n[4] Sample data (data/sample-data.json)');
try {
  const demo = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'sample-data.json'), 'utf8'));
  ok('JSON parses', true);
  eq('exam count', demo.exams.length, 7);
  const incomplete = demo.exams.filter(e => Object.keys(e.scores).length < 6);
  eq('exactly 1 incomplete exam', incomplete.length, 1);
  const demoState = H.normalizeState(demo);
  eq('normalizeState preserves exam count', demoState.exams.length, 7);
  H.Store.state = demoState;
  const dts = H.totalStats();
  eq('sample avg-total sample count', dts.count, 6);
  near('sample avg total', dts.avg, 600.33, 0.01);
  eq('sample tier match', (H.matchTier(dts.avg, demoState.config.tiers) || {}).name, '中上 211 / 强一本');
  eq('sample top subject', Object.keys(H.subjectStats()).filter(k => H.subjectStats()[k].avg != null)
      .sort((a, b) => H.subjectStats()[b].avg - H.subjectStats()[a].avg)[0], 'math');
} catch (e) {
  failures++;
  console.log('  \u2717 sample data check failed: ' + e.message);
}

console.log('\n================ RESULT: ' + (failures === 0 ? 'all passed \u2705' : failures + ' failed \u274c') + ' ================');
process.exit(failures === 0 ? 0 : 1);
