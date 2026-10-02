/* Headless smoke test: runs index.html's script against a lightweight DOM stub,
   exercising dashboard render / input / edit / delete / subject-swap / import / export / clear,
   catching any runtime exceptions.

   Run: node test/smoke-test.js */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const src = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const demoJson = fs.readFileSync(path.join(ROOT, 'data', 'sample-data.json'), 'utf8');

let failures = 0;
function step(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); }
  catch (e) {
    failures++;
    console.log('  \u2717 ' + name + '  \u2192  ' + e.message);
    console.log(String(e.stack || '').split('\n').slice(1, 4).map(s => '      ' + s.trim()).join('\n'));
  }
}
function ok(name, cond, extra) {
  if (cond) console.log('  \u2713 ' + name);
  else { failures++; console.log('  \u2717 ' + name + (extra ? '  \u2192 ' + extra : '')); }
}

/* ============================ DOM stub ============================ */
let rafId = 0, fakeNow = 0;
const created = [];

function ctxStub() {
  const t = {
    canvas: {},
    createRadialGradient: () => ({ addColorStop() {} }),
    createLinearGradient: () => ({ addColorStop() {} }),
    measureText: () => ({ width: 12 })
  };
  return new Proxy(t, { get(o, k) { return (k in o) ? o[k] : function () {}; }, set() { return true; } });
}

function El(tag) {
  const el = {
    tagName: tag || 'div', id: '', className: '', innerHTML: '', textContent: '',
    checked: false, hidden: false, disabled: false, title: '', type: '',
    style: {}, dataset: {}, children: [], _attrs: {}, _ls: {},
    clientWidth: 640, clientHeight: 320, offsetWidth: 640, offsetHeight: 180, scrollHeight: 180, scrollLeft: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, f) { const on = (f === undefined) ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; }
    },
    addEventListener(t, f) { this._ls[t] = f; }, removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parentNode = this; c.parentElement = this; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getAttribute(k) { return this._attrs[k] == null ? null : this._attrs[k]; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 120, height: 32 }; },
    scrollIntoView() {}, focus() {}, select() {}, click() {}, blur() {},
    getContext() { return ctxStub(); },
    trigger(t, ev) { if (this._ls[t]) this._ls[t](ev || { target: this }); }
  };
  /* mimic browser: assignment to input.value coerces to string */
  let _v = '';
  Object.defineProperty(el, 'value', {
    get() { return _v; },
    set(x) { _v = (x == null) ? '' : String(x); },
    enumerable: true
  });
  created.push(el);
  return el;
}

const byId = new Map();
const VIEWS = ['dashboard', 'input', 'records', 'charts', 'stats', 'settings'];
const viewsStub = VIEWS.map(v => {
  const e = El('section');
  e.setAttribute('data-view', v);
  e.querySelector = s => (s === '.stagger' ? El('div') : null);
  return e;
});
const tabsStub = VIEWS.map((v, i) => {
  const e = El('button');
  e.setAttribute('data-view', v);
  e.setAttribute('aria-selected', i === 0 ? 'true' : 'false');
  return e;
});

const documentStub = {
  readyState: 'complete', visibilityState: 'visible',
  documentElement: El('html'), body: El('body'),
  getElementById(id) { if (!byId.has(id)) { const e = El('div'); e.id = id; byId.set(id, e); } return byId.get(id); },
  createElement(t) { return El(t); },
  addEventListener() {}, removeEventListener() {},
  querySelector(sel) {
    if (sel.indexOf('.tab[') === 0) return tabsStub[0];
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.view') return viewsStub;
    if (sel === '.tab') return tabsStub;
    return [];
  }
};
const localStorageStub = {
  _d: {},
  getItem(k) { return (k in this._d) ? this._d[k] : null; },
  setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }
};
const windowStub = {
  localStorage: localStorageStub,
  devicePixelRatio: 2,
  matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
  addEventListener() {}, removeEventListener() {}, scrollTo() {}
};
const computed = {
  '--accent': '#0A84FF', '--font': 'sans-serif', '--text': '#111', '--text-2': '#555', '--text-3': '#999',
  '--grid': '#dddddd', '--grid-soft': '#eeeeee', '--card-strong': '#ffffff'
};
const getComputedStyleStub = () => ({ getPropertyValue: n => computed[n] || '' });

/* requestAnimationFrame: "jumping" fake clock completes a frame synchronously so paint code runs without infinite recursion */
const requestAnimationFrameStub = cb => { fakeNow += 900; const id = ++rafId; cb(fakeNow); return id; };

class FileReaderStub {
  readAsText() { this.result = FileReaderStub.text; if (this.onload) this.onload(); }
}
FileReaderStub.text = '';
class BlobStub { constructor(parts) { this.parts = parts; this.size = String(parts[0] || '').length; } }
const URLStub = { createObjectURL: () => 'blob:stub', revokeObjectURL() {} };

/* ============================ Load the app ============================ */
console.log('\n[1] Boot');
let H = null;
step('execute whole script (incl. boot())', () => {
  /* peel off the IIFE wrapper to expose internals (avoid ASI pitfalls on `return`) */
  const open = src.indexOf('{');
  const close = src.lastIndexOf('})();');
  if (open < 0 || close < 0) throw new Error('cannot locate IIFE structure');
  const inner = src.slice(open + 1, close);
  const factory = new Function(
    'document', 'window', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle',
    'Blob', 'URL', 'FileReader', 'ResizeObserver',
    inner + `
    return {
      Store: Store, uiState: uiState,
      switchView: switchView, renderView: renderView, refresh: refresh,
      saveExam: saveExam, editExam: editExam, deleteExam: deleteExam, resetForm: resetForm,
      updateFormStatus: updateFormStatus, renderScoreGrid: renderScoreGrid,
      onSubjectSelectChange: onSubjectSelectChange, saveTierEditor: saveTierEditor, addTierRow: addTierRow,
      loadDemo: loadDemo, resetAll: resetAll, exportJSON: exportJSON, handleImportFile: handleImportFile,
      cycleTheme: cycleTheme, flushState: flushState, loadState: loadState,
      examTotal: examTotal, subjectStats: subjectStats, totalStats: totalStats,
      isComplete: isComplete, subjectKeys: subjectKeys, matchTier: matchTier, nextTier: nextTier,
      sortedExams: sortedExams, buildLineData: buildLineData, buildRadarData: buildRadarData,
      examCardHtml: examCardHtml, tierPanelHtml: tierPanelHtml
    };`
  );
  H = factory(
    documentStub, windowStub, { now: () => fakeNow }, requestAnimationFrameStub, () => {}, getComputedStyleStub,
    BlobStub, URLStub, FileReaderStub, undefined
  );
});
ok('boot() rendered dashboard metric cards', byId.get('dashStats') && byId.get('dashStats').innerHTML.indexOf('总分平均') >= 0);
ok('boot() rendered tier card (empty state)', byId.get('dashTier').innerHTML.indexOf('还没有可用于参考的总分') >= 0);
ok('brand bar shows six subjects', byId.get('brandSub').textContent.indexOf('语文') >= 0);
ok('radar and trend canvases registered data', byId.get('dashRadarCanvas').width > 0 && byId.get('dashTrendCanvas').width > 0);

console.log('\n[2] Load sample data');
step('loadDemo() (empty data -> apply directly)', () => H.loadDemo());
ok('7 sample exams', H.Store.state.exams.length === 7);
ok('avg total based on 6 complete exams', H.totalStats().count === 6);
ok('chinese sample 7 (includes the incomplete exam)', H.subjectStats().chinese.count === 7);
ok('physics sample 6', H.subjectStats().physics.count === 6);
ok('tier card shows 中上 211 / 强一本', byId.get('dashTier').innerHTML.indexOf('中上 211 / 强一本') >= 0);
H.flushState();   // saveState is debounced; flush here before asserting
ok('persisted to localStorage', JSON.parse(localStorageStub.getItem('hs-grade-report-v1')).exams.length === 7);

console.log('\n[3] Render all six views (all chart code runs)');
VIEWS.forEach(v => step('renderView(' + v + ')', () => H.switchView(v)));
ok('records view renders by-exam cards', byId.get('recordsBody').innerHTML.indexOf('exam-card') >= 0);
ok('by-subject view renders', (() => { H.uiState.recordsTab = 'subject'; H.renderView('records'); return byId.get('recordsBody').innerHTML.indexOf('历次成绩') >= 0; })());
ok('charts view renders subject chips', byId.get('lineChips').innerHTML.indexOf('data-line-key') >= 0);
ok('stats view renders per-subject table', byId.get('statSubjectTable').innerHTML.indexOf('平均分') >= 0);
ok('settings view renders tier editor', byId.get('tierEditor').innerHTML.indexOf('tier-edit-row') >= 0);
ok('settings view renders full-mark inputs', byId.get('fullMarkGrid').innerHTML.indexOf('data-fullmark') >= 0);
ok('radar: all 3 data sources render', ['latest', 'exam', 'avg'].every(m => {
  H.uiState.radarMode = m; H.renderView('charts'); return true;
}));

console.log('\n[4] Input (full / incomplete / validation)');
/* simulate score input via scoreGrid's input handler (registered by bindEvents) */
function typeScores(scores) {
  H.resetForm();
  const grid = byId.get('scoreGrid');
  Object.keys(scores).forEach(k => {
    const inp = El('input');
    inp.setAttribute('data-score', k);
    inp.value = String(scores[k]);
    grid.trigger('input', { target: inp });
  });
}
step('incomplete exam: only 3 subjects saves', () => {
  H.resetForm();
  typeScores({ chinese: 111, math: 122, foreign: 133 });
  byId.get('f-name').value = '冒烟-未录满';
  byId.get('f-date').value = '2026-05-20';
  byId.get('f-class').value = '';
  byId.get('f-grade').value = '';
  H.saveExam();
});
ok('exam count +1', H.Store.state.exams.length === 8);
ok('incomplete exam total is null', H.examTotal(H.Store.state.exams[7], H.Store.state.config) === null);
ok('avg-total sample count unchanged (still 6)', H.totalStats().count === 6);
ok('chinese sample count becomes 8 (recorded subjects still count)', H.subjectStats().chinese.count === 8);
ok('card shows 已录 3/6 科 badge', H.examCardHtml(H.Store.state.config, H.Store.state.exams[7], false).indexOf('已录 3/6 科') >= 0);

step('complete exam: six subjects auto-compute total', () => {
  H.resetForm();
  typeScores({ chinese: 120, math: 140, foreign: 130, physics: 92, chemistry: 90, biology: 91 });
  byId.get('f-name').value = '冒烟-完整';
  byId.get('f-date').value = '2026-05-21';
  byId.get('f-class').value = '2';
  byId.get('f-grade').value = '20';
  H.saveExam();
});
ok('exam count 9', H.Store.state.exams.length === 9);
ok('total = 663', H.examTotal(H.Store.state.exams[8], H.Store.state.config) === 663);
ok('avg-total sample count becomes 7', H.totalStats().count === 7);
ok('663 matches 顶尖 985', (H.matchTier(663, H.Store.state.config.tiers) || {}).name === '顶尖 985');

step('empty name rejected', () => {
  const before = H.Store.state.exams.length;
  H.resetForm();
  typeScores({ chinese: 100 });
  byId.get('f-name').value = '';
  byId.get('f-date').value = '2026-05-22';
  H.saveExam();
  if (H.Store.state.exams.length !== before) throw new Error('illegal record written');
});
step('over-full-mark score rejected', () => {
  const before = H.Store.state.exams.length;
  H.resetForm();
  typeScores({ chinese: 400 });
  byId.get('f-name').value = '超分测试';
  byId.get('f-date').value = '2026-05-23';
  H.saveExam();
  if (H.Store.state.exams.length !== before) throw new Error('over-full-mark record written');
});

console.log('\n[5] Edit and delete');
const targetId = H.Store.state.exams[8].id;
step('editExam() loads form', () => H.editExam(targetId));
ok('form name refilled', byId.get('f-name').value === '冒烟-完整');
ok('form scores refilled', byId.get('scoreGrid').innerHTML.indexOf('data-score') >= 0);
step('rename and save', () => {
  byId.get('f-name').value = '冒烟-已改名';
  H.saveExam();
});
ok('name updated', H.Store.state.exams.filter(e => e.id === targetId)[0].name === '冒烟-已改名');
step('deleteExam() opens confirm and confirms', () => {
  H.deleteExam(targetId);
  created[created.length - 1].trigger('click');       // confirm button
});
ok('record deleted', H.Store.state.exams.filter(e => e.id === targetId).length === 0);
ok('exam count back to 8', H.Store.state.exams.length === 8);

console.log('\n[6] Subject selection change (with impact modal)');
step('switch to 历史 + 政治 + 地理 and confirm', () => {
  byId.get('cfgPrimary').value = 'history';
  byId.get('cfgSec1').value = 'politics';
  byId.get('cfgSec2').value = 'geography';
  H.onSubjectSelectChange();
  created[created.length - 1].trigger('click');
});
ok('primary is now history', H.Store.state.config.primary === 'history');
ok('secondary is now politics + geography', H.Store.state.config.secondary.join(',') === 'politics,geography');
ok('six-subject order updated', H.subjectKeys(H.Store.state.config).join(',') === 'chinese,math,foreign,history,politics,geography');
ok('no history scores -> 0 complete exams', H.totalStats().count === 0);
ok('old subject data still kept (physics scores not deleted)', H.Store.state.exams.some(e => e.scores.physics != null));
step('switch back to 物理 + 化学 + 生物', () => {
  byId.get('cfgPrimary').value = 'physics';
  byId.get('cfgSec1').value = 'chemistry';
  byId.get('cfgSec2').value = 'biology';
  H.onSubjectSelectChange();
  created[created.length - 1].trigger('click');
});
ok('after switch back, 6 complete exams restored', H.totalStats().count === 6);

console.log('\n[7] Import / export / theme / clear');
step('import sample-data.json (via FileReader)', () => {
  FileReaderStub.text = demoJson;
  H.handleImportFile({ name: 'sample-data.json' });
  created[created.length - 1].trigger('click');       // confirm "替换并导入"
});
ok('7 exams after import', H.Store.state.exams.length === 7);
ok('imported tier match correct', (H.matchTier(H.totalStats().avg, H.Store.state.config.tiers) || {}).name === '中上 211 / 强一本');
step('export JSON (Blob + a.click)', () => H.exportJSON());
step('theme cycles 3x back to auto', () => { H.cycleTheme(); H.cycleTheme(); H.cycleTheme(); });
ok('theme back to auto', H.Store.state.config.theme === 'auto');
step('flushState() to disk', () => H.flushState());
ok('localStorage matches memory', JSON.parse(localStorageStub.getItem('hs-grade-report-v1')).exams.length === 7);
step('reload from localStorage (loadState)', () => H.loadState());
ok('still 7 exams after reload', H.Store.state.exams.length === 7);
step('clear all with confirm', () => {
  H.resetAll();
  created[created.length - 1].trigger('click');
});
ok('cleared', H.Store.state.exams.length === 0);
ok('dashboard shows empty-state text', (() => { H.renderView('dashboard'); return byId.get('dashRecent').innerHTML.indexOf('还没有任何考试记录') >= 0; })());

console.log('\n================ SMOKE TEST: ' + (failures === 0 ? 'all passed \u2705' : failures + ' failed \u274c') + ' ================');
process.exit(failures === 0 ? 0 : 1);
