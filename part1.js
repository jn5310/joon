// Math Finder part1.js — 이 줄부터 끝까지 전부 복사
var M = window.M || (window.M = {});
M.db = (() => {
const DB_NAME = 'mathbook';
const DB_VERSION = 1;
let dbPromise = null;
function open() {
if (dbPromise) return dbPromise;
dbPromise = new Promise((resolve, reject) => {
const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onupgradeneeded = () => {
const db = req.result;
if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
if (!db.objectStoreNames.contains('pages')) {
const s = db.createObjectStore('pages', { keyPath: 'id' });
s.createIndex('bookId', 'bookId');
}
if (!db.objectStoreNames.contains('items')) {
const s = db.createObjectStore('items', { keyPath: 'id' });
s.createIndex('bookId', 'bookId');
}
};
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
return dbPromise;
}
function wrap(req) {
return new Promise((resolve, reject) => {
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
}
async function store(name, mode = 'readonly') {
const db = await open();
return db.transaction(name, mode).objectStore(name);
}
async function put(name, value) {
return wrap((await store(name, 'readwrite')).put(value));
}
async function putMany(name, values) {
const db = await open();
const tx = db.transaction(name, 'readwrite');
const s = tx.objectStore(name);
for (const v of values) s.put(v);
return new Promise((resolve, reject) => {
tx.oncomplete = () => resolve();
tx.onerror = () => reject(tx.error);
});
}
async function get(name, id) {
return wrap((await store(name)).get(id));
}
async function del(name, id) {
return wrap((await store(name, 'readwrite')).delete(id));
}
async function all(name) {
return wrap((await store(name)).getAll());
}
async function byBook(name, bookId) {
return wrap((await store(name)).index('bookId').getAll(bookId));
}
async function deleteBook(bookId) {
for (const name of ['pages', 'items']) {
const rows = await byBook(name, bookId);
const db = await open();
const tx = db.transaction(name, 'readwrite');
for (const r of rows) tx.objectStore(name).delete(r.id);
await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
await del('books', bookId);
}
function uid(prefix = '') {
return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
return { put, putMany, get, del, all, byBook, deleteBook, uid };
})();
M.layout = (() => {
const DARK = 170; // 이 밝기보다 어두우면 '잉크'
function isDark(d, i) {
return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < DARK;
}
/** x별 잉크 개수 (y0~y1 구간, step 간격 샘플링) */
function columnProfile(img, y0, y1, step = 2) {
const { data, width } = img;
const counts = new Uint32Array(width);
for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1); y += step) {
const row = y * width * 4;
for (let x = 0; x < width; x++) if (isDark(data, row + x * 4)) counts[x]++;
}
return counts;
}
/** y별 잉크 개수 (x0~x1 구간) */
function rowProfile(img, x0, x1, y0 = 0, y1 = img.height, step = 1) {
const { data, width } = img;
const counts = new Uint32Array(img.height);
x0 = Math.max(0, x0 | 0); x1 = Math.min(width, x1 | 0);
for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1); y++) {
const row = y * width * 4;
let c = 0;
for (let x = x0; x < x1; x += step) if (isDark(data, row + x * 4)) c++;
counts[y] = c;
}
return counts;
}
/**
* 단(column) 검출. 가운데 여백(또는 얇은 세로 구분선)을 찾아 1~3단으로 나눈다.
* opts.top / opts.bottom: 머리말·꼬리말로 무시할 비율
*/
function detectColumns(img, opts = {}) {
const { width: W, height: H } = img;
const yTop = Math.floor(H * (opts.top ?? 0.07));
const yBot = Math.floor(H * (1 - (opts.bottom ?? 0.06)));
const step = 2;
const counts = columnProfile(img, yTop, yBot, step);
const rows = Math.max(1, Math.floor((yBot - yTop) / step));
const lowTh = Math.max(1, rows * 0.004);
let inkL = 0, inkR = W - 1;
while (inkL < W && counts[inkL] <= lowTh) inkL++;
while (inkR > 0 && counts[inkR] <= lowTh) inkR--;
if (inkL >= inkR) return [{ x0: 0, x1: W }];
const blank = new Uint8Array(W);
for (let x = 0; x < W; x++) blank[x] = counts[x] <= lowTh ? 1 : 0;
const maxLine = Math.max(2, Math.round(W * 0.006));
for (let x = 1; x < W; x++) {
if (!blank[x] && blank[x - 1]) {
let e = x;
while (e < W && !blank[e]) e++;
if (e - x <= maxLine && e < W && blank[e]) {
let peak = 0;
for (let k = x; k < e; k++) peak = Math.max(peak, counts[k]);
if (peak > rows * 0.5) for (let k = x; k < e; k++) blank[k] = 1;
}
x = e;
}
}
const minGap = W * 0.012;
const gaps = [];
for (let x = inkL; x <= inkR; x++) {
if (blank[x]) {
let e = x;
while (e <= inkR && blank[e]) e++;
const mid = (x + e) / 2;
if (e - x >= minGap && mid > W * 0.2 && mid < W * 0.8) gaps.push({ s: x, e });
x = e;
}
}
const cols = [];
let start = inkL;
for (const g of gaps) {
if (g.s - start >= W * 0.2) { cols.push({ x0: start, x1: g.s }); start = g.e; }
}
if (inkR + 1 - start >= W * 0.2 || cols.length === 0) cols.push({ x0: start, x1: inkR + 1 });
else cols[cols.length - 1].x1 = inkR + 1;
return cols;
}
/** 박스의 배경 밝기를 추정해 연한 그래프 축·격자까지 포함한다. 실제 픽셀은 바꾸지 않는다. */
function trimThreshold(img, x0, y0, x1, y1) {
const { data, width } = img;
const samples = [];
const sx = Math.max(1, Math.floor((x1 - x0) / 100));
const sy = Math.max(1, Math.floor((y1 - y0) / 100));
const add = (x, y) => {
const i = (y * width + x) * 4;
samples.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
};
for (let x = x0; x < x1; x += sx) { add(x, y0); add(x, y1 - 1); }
for (let y = y0; y < y1; y += sy) { add(x0, y); add(x1 - 1, y); }
samples.sort((a, b) => a - b);
const background = samples[Math.floor(samples.length / 2)] ?? 255;
return Math.max(DARK, Math.min(230, background - 15));
}
/** 박스 안의 잉크 영역에 맞게 자르되 밝은 도형선과 안전 여백을 보존한다. */
function trimBox(img, box, pad = null) {
const { data, width } = img;
const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(width, Math.ceil(box.x1));
const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(img.height, Math.ceil(box.y1));
if (x1 <= x0 || y1 <= y0) return null;
const threshold = trimThreshold(img, x0, y0, x1, y1);
const safePad = pad ?? Math.max(10, Math.round(Math.min(img.width, img.height) * 0.006));
let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
for (let y = y0; y < y1; y++) {
const row = y * width * 4;
for (let x = x0; x < x1; x++) {
const i = row + x * 4;
const luminance = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
if (luminance < threshold) {
if (x < minX) minX = x; if (x > maxX) maxX = x;
if (y < minY) minY = y; if (y > maxY) maxY = y;
}
}
}
if (maxX < 0) return null;
return {
x0: Math.max(x0, minX - safePad), y0: Math.max(y0, minY - safePad),
x1: Math.min(x1, maxX + 1 + safePad), y1: Math.min(y1, maxY + 1 + safePad),
};
}
/** 박스 안 잉크 비율 */
function inkRatio(img, box) {
const prof = rowProfile(img, box.x0, box.x1, box.y0, box.y1, 2);
let s = 0;
for (let y = Math.max(0, box.y0 | 0); y < Math.min(img.height, box.y1); y++) s += prof[y];
const area = Math.max(1, ((box.x1 - box.x0) / 2) * (box.y1 - box.y0));
return s / area;
}
return { columnProfile, rowProfile, detectColumns, trimBox, inkRatio };
})();
M.segment = (() => {
const NUM_WORD = /^[\[(【<]?(?:No\.?|#)?0*(\d{1,4})[\])】>.]?$/i;
const NUM_LINE = /^[\[(【<]?(?:No\.?|#)?0*(\d{1,4})[\])】>.]?(?:\s|$)/i;
function parseAnchorNumber(line) {
const fw = line.firstWord?.text?.trim() ?? '';
let m = fw.match(NUM_WORD);
if (!m) m = line.text.trim().match(NUM_LINE);
if (!m) return null;
const n = parseInt(m[1], 10);
return n >= 1 && n <= 9999 ? n : null;
}
/** 페이지 한 장에서 번호 후보 수집 */
function findCandidates(page, opts = {}) {
const leftTol = opts.leftTol ?? 0.1;
const out = [];
const yTop = page.height * (opts.top ?? 0.07);
const yBot = page.height * (1 - (opts.bottom ?? 0.06));
page.columns.forEach((col, ci) => {
const cw = col.x1 - col.x0;
for (const ln of page.lines) {
const fw = ln.firstWord || ln;
if (ln.y1 < yTop || ln.y0 > yBot) continue;
if (fw.x0 < col.x0 - cw * 0.03 || fw.x0 >= col.x1) continue;
if (fw.x0 - col.x0 > cw * leftTol + 4) continue;
const num = parseAnchorNumber(ln);
if (num == null) continue;
out.push({ page: page.index, col: ci, num, x0: fw.x0, y0: Math.min(fw.y0, ln.y0), y1: ln.y1, h: ln.y1 - ln.y0 });
}
});
return out;
}
/**
* 읽는 순서대로 정렬된 후보에서 '번호가 1씩(가끔 건너뛰며) 증가하는' 가장 긴 사슬을 찾는다.
* 번호가 1~3으로 되돌아가면 새 단원(section) 시작으로 본다.
*/
function chainAnchors(cands, opts = {}) {
const maxSkip = opts.maxSkip ?? 3;
const n = cands.length;
if (!n) return [];
const score = new Float64Array(n);
const prev = new Int32Array(n).fill(-1);
const isReset = new Uint8Array(n);
for (let i = 0; i < n; i++) {
score[i] = 1 - Math.min(cands[i].num - 1, 50) * 0.02;
for (let j = Math.max(0, i - 400); j < i; j++) {
const d = cands[i].num - cands[j].num;
let s = -Infinity, reset = 0;
if (d >= 1 && d <= maxSkip) s = score[j] + 1 - (d - 1) * 0.3;
else if (cands[i].num <= 3 && cands[j].num >= 5) { s = score[j] + 1 - (cands[i].num - 1) * 0.3 - 0.5; reset = 1; }
if (s > score[i]) { score[i] = s; prev[i] = j; isReset[i] = reset; }
}
}
let best = 0;
for (let i = 1; i < n; i++) if (score[i] > score[best]) best = i;
const path = [];
for (let i = best; i >= 0; i = prev[i]) path.push(i);
path.reverse();
let section = 1;
return path.map((i, k) => {
if (k > 0 && isReset[i]) section++;
return { ...cands[i], section };
});
}
/**
* 전체 분리. pages: [{index, width, height, columns:[{x0,x1}], lines:[...]}]
* 반환: [{section, number, fragments:[{page,x0,y0,x1,y1}]}]  (자르기 전 원시 영역 — 호출측에서 trim)
*/
function segmentPages(pages, opts = {}) {
const continuation = opts.continuation ?? false;
const cands = [];
for (const p of pages) {
const c = findCandidates(p, opts);
c.sort((a, b) => (a.col - b.col) || (a.y0 - b.y0));
cands.push(...c);
}
cands.sort((a, b) => (a.page - b.page) || (a.col - b.col) || (a.y0 - b.y0));
const anchors = chainAnchors(cands, opts);
const items = [];
const byPageCol = new Map();
for (const a of anchors) {
const k = a.page + ':' + a.col;
if (!byPageCol.has(k)) byPageCol.set(k, []);
byPageCol.get(k).push(a);
}
let current = null;
for (const p of pages) {
const yTop = p.height * (opts.top ?? 0.07);
const yBot = p.height * (1 - (opts.bottom ?? 0.06));
const guardX = Math.max(8, p.width * 0.008);
const captureBounds = (ci) => {
const col = p.columns[ci];
const leftLimit = ci ? (p.columns[ci - 1].x1 + col.x0) / 2 : 0;
const rightLimit = ci + 1 < p.columns.length ? (col.x1 + p.columns[ci + 1].x0) / 2 : p.width;
return { x0: Math.max(leftLimit, col.x0 - guardX), x1: Math.min(rightLimit, col.x1 + guardX) };
};
p.columns.forEach((col, ci) => {
const capture = captureBounds(ci);
const list = byPageCol.get(p.index + ':' + ci) || [];
const firstY = list.length ? list[0].y0 : yBot;
if (continuation && current && firstY - yTop > p.height * 0.02) {
current.fragments.push({ page: p.index, x0: capture.x0, y0: yTop, x1: capture.x1, y1: firstY - 2, cont: true });
}
list.forEach((a, k) => {
const pad = Math.max(4, a.h * 0.35);
const next = list[k + 1];
current = {
section: a.section, number: a.num,
fragments: [{ page: p.index, x0: capture.x0, y0: Math.max(yTop, a.y0 - pad), x1: capture.x1, y1: next ? next.y0 - pad * 0.5 : yBot }],
};
items.push(current);
});
});
}
return items;
}
/** 조각 안의 텍스트 */
function textInFragments(pagesByIndex, fragments) {
const out = [];
for (const f of fragments) {
const p = pagesByIndex.get(f.page);
if (!p) continue;
for (const ln of p.lines) {
const cx = (ln.x0 + ln.x1) / 2, cy = (ln.y0 + ln.y1) / 2;
if (cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1) out.push(ln.text);
}
}
return out.join('\n');
}
function itemKey(it) {
return `${it.section}-${it.number}`;
}
/** 문제 ↔ 해설 매칭. section-number가 같으면 연결, 없으면 번호만으로(유일할 때) 연결 */
function matchSolutions(problems, solutions) {
const byKey = new Map(solutions.map((s) => [itemKey(s), s]));
const byNum = new Map();
for (const s of solutions) byNum.set(s.number, byNum.has(s.number) ? null : s);
let matched = 0;
for (const p of problems) {
const s = byKey.get(itemKey(p)) || byNum.get(p.number) || null;
p.solutionId = s ? s.id : null;
if (s) matched++;
}
return matched;
}
/** 해설 텍스트에서 정답 추출 (예: "정답 ③", "답: 12") */
function extractAnswer(text) {
if (!text) return null;
const m = text.match(/(?:정답|답)\s*[:：]?\s*([①②③④⑤]|\d{1,4}(?:\.\d+)?)/);
return m ? m[1] : null;
}
/** 문제 텍스트에서 배점 추출 */
function extractPoints(text) {
if (!text) return null;
// "[4점]" "(4점)" 형태를 우선, 없으면 줄 끝에 단독으로 있는 "4점" ("14점", "2.4점", "두 점" 등은 제외)
const m = text.match(/[\[(【]\s*([2-4])\s*점\s*[\])】]/) || text.match(/(?:^|[^\d.])([2-4])\s*점\s*$/m);
return m ? parseInt(m[1], 10) : null;
}
return { parseAnchorNumber, findCandidates, chainAnchors, segmentPages, textInFragments, itemKey, matchSolutions, extractAnswer, extractPoints };
})();
M.grade = (() => {
const BOOK_LEVELS = {
auto:     { label: '모름/혼합 (1~9)', range: [1, 9] },
concept:  { label: '개념서 (4~9)', range: [4, 9] },
basic:    { label: '기본 유형서 (3~8)', range: [3, 8] },
advanced: { label: '실력·심화서 (2~6)', range: [2, 6] },
exam:     { label: '기출·모의고사 (1~7)', range: [1, 7] },
killer:   { label: '최상위·킬러 (1~3)', range: [1, 3] },
};
const HARD_KEYWORDS = [
'(가)', '(나)', '(다)', '조건을 만족', '모든 실수', '서로 다른', '최댓값', '최솟값', '개수', '합의 최댓값',
'미분가능', '연속', '실수 전체의 집합', '만족시키는', '<보기>', '보기', 'ㄱ', 'ㄴ', 'ㄷ', '역함수', '합성함수',
'절댓값', '극값', '변곡점', '넓이', '정적분', '수열', '귀납', '확률', '경우의 수', '벡터', '이차곡선',
];
function keywordCount(text) {
if (!text) return 0;
let c = 0;
for (const k of HARD_KEYWORDS) if (text.includes(k)) c++;
return c;
}
function nonSpaceLen(t) { return t ? t.replace(/\s/g, '').length : 0; }
/** 문제 하나의 원시 특징값 */
function features(problem, solution, sectionMax) {
const ph = problem.pageHeight || 1;
return {
pos: sectionMax > 1 ? (problem.number - 1) / (sectionMax - 1) : 0.5,
height: Math.log(1 + (problem.h || 0) / ph * 10),
len: Math.log(1 + nonSpaceLen(problem.text)),
kw: keywordCount(problem.text),
pts: problem.points ?? null,
sol: solution ? Math.log(1 + (solution.h || 0) / (solution.pageHeight || 1) * 10) + 0.3 * Math.log(1 + nonSpaceLen(solution.text)) : null,
};
}
const WEIGHTS = { sol: 0.35, pts: 0.3, pos: 0.2, height: 0.15, len: 0.1, kw: 0.1 };
function zscores(values) {
const v = values.filter((x) => x != null && Number.isFinite(x));
if (v.length < 2) return values.map((x) => (x == null ? null : 0));
const m = v.reduce((a, b) => a + b, 0) / v.length;
const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
return values.map((x) => (x == null || !Number.isFinite(x) ? null : (x - m) / sd));
}
/**
* 한 권의 문제 전체에 규칙 기반 난이도 부여.
* problems: 문제 목록, solutionsById: Map, level: BOOK_LEVELS 키
* 반환: [{id, score, grade, features}]
*/
function heuristicGrades(problems, solutionsById, level = 'auto') {
if (!problems.length) return [];
const secMax = new Map();
for (const p of problems) secMax.set(p.section, Math.max(secMax.get(p.section) || 0, p.number));
const feats = problems.map((p) => features(p, solutionsById.get(p.solutionId), secMax.get(p.section)));
const keys = Object.keys(WEIGHTS);
const z = {};
for (const k of keys) z[k] = zscores(feats.map((f) => f[k]));
const scores = feats.map((_, i) => {
let s = 0, w = 0;
for (const k of keys) if (z[k][i] != null) { s += WEIGHTS[k] * z[k][i]; w += WEIGHTS[k]; }
return w ? s / w : 0;
});
const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
const pct = new Array(scores.length);
order.forEach(([, i], r) => { pct[i] = scores.length > 1 ? r / (scores.length - 1) : 0.5; });
const [hard, easy] = (BOOK_LEVELS[level] || BOOK_LEVELS.auto).range;
return problems.map((p, i) => ({
id: p.id,
score: scores[i],
grade: Math.round(easy - pct[i] * (easy - hard)),
features: feats[i],
}));
}
/** 실제로 사용할 등급: 수동 > AI > 규칙 */
function effectiveGrade(p) {
return p.gradeManual ?? p.gradeLLM ?? p.gradeHeur ?? null;
}
function gradeSource(p) {
if (p.gradeManual != null) return '수동';
if (p.gradeLLM != null) return 'AI';
if (p.gradeHeur != null) return '규칙';
return '-';
}
return { BOOK_LEVELS, keywordCount, features, heuristicGrades, effectiveGrade, gradeSource };
})();
M.select = (() => {
const { effectiveGrade } = M.grade;
function rng(seed) {
let a = seed >>> 0 || 1;
return () => {
a |= 0; a = (a + 0x6d2b79f5) | 0;
let t = Math.imul(a ^ (a >>> 15), 1 | a);
t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}
function shuffle(arr, rand) {
const a = arr.slice();
for (let i = a.length - 1; i > 0; i--) {
const j = Math.floor(rand() * (i + 1));
[a[i], a[j]] = [a[j], a[i]];
}
return a;
}
const MIX_PRESETS = {
balanced: { label: '균형 (쉬움 20 / 목표 60 / 도전 20)', easier: 0.2, target: 0.6, harder: 0.2 },
focus:    { label: '목표 집중 (10 / 80 / 10)', easier: 0.1, target: 0.8, harder: 0.1 },
push:     { label: '도전형 (10 / 50 / 40)', easier: 0.1, target: 0.5, harder: 0.4 },
review:   { label: '복습형 (40 / 50 / 10)', easier: 0.4, target: 0.5, harder: 0.1 },
};
function filterPool(pool, opts = {}) {
return pool.filter((p) => {
if (effectiveGrade(p) == null || !p.image) return false;
if (opts.requireSolution && !p.solutionId) return false;
if (opts.bookIds?.length && !opts.bookIds.includes(p.bookId)) return false;
if (opts.subjects?.length && !opts.subjects.includes(p.subject)) return false;
return true;
});
}
/**
* pool: 문제 목록, opts: {target(1~9), count, mix, seed, requireSolution, bookIds, subjects}
* 쉬운 문제 → 어려운 문제 순으로 정렬해서 반환
*/
function selectProblems(pool, opts) {
const target = opts.target;
const count = opts.count;
const mix = opts.mix || MIX_PRESETS.balanced;
const rand = rng(opts.seed ?? Date.now());
const cand = shuffle(filterPool(pool, opts), rand);
const g = (p) => effectiveGrade(p);
const buckets = {
harder: cand.filter((p) => g(p) < target && g(p) >= target - 2),
target: cand.filter((p) => g(p) === target),
easier: cand.filter((p) => g(p) > target && g(p) <= target + 2),
};
const quota = {
harder: target === 1 ? 0 : Math.round(count * mix.harder),
easier: target === 9 ? 0 : Math.round(count * mix.easier),
};
quota.target = Math.max(0, count - quota.harder - quota.easier);
const chosen = new Set();
const take = (list, n) => {
for (const p of list) {
if (n <= 0) break;
if (!chosen.has(p)) { chosen.add(p); n--; }
}
return n;
};
let short = 0;
for (const k of ['target', 'harder', 'easier']) short += take(buckets[k], quota[k]);
if (short > 0) {
const rest = cand.filter((p) => !chosen.has(p)).sort((a, b) => Math.abs(g(a) - target) - Math.abs(g(b) - target));
short = take(rest, short);
}
const result = [...chosen];
result.sort((a, b) => (g(b) - g(a)) || ((a.bookId > b.bookId) - (a.bookId < b.bookId)) || (a.section - b.section) || (a.number - b.number));
return { problems: result, shortage: short, available: cand.length };
}
/** 선택된 목록 중 하나를 같은(가까운) 등급의 다른 문제로 교체 */
function replaceOne(selected, index, pool, opts, seed = Date.now()) {
const cur = selected[index];
const used = new Set(selected.map((p) => p.id));
const target = effectiveGrade(cur);
const cand = shuffle(filterPool(pool, opts).filter((p) => !used.has(p.id)), rng(seed));
cand.sort((a, b) => Math.abs(effectiveGrade(a) - target) - Math.abs(effectiveGrade(b) - target));
if (!cand.length) return selected;
const out = selected.slice();
out[index] = cand[0];
return out;
}
return { rng, MIX_PRESETS, filterPool, selectProblems, replaceOne };
})();
M.imaging = (() => {
const db = M.db;
const { trimBox } = M.layout;
function loadImage(src) {
return new Promise((resolve, reject) => {
const im = new Image();
im.onload = () => resolve(im);
im.onerror = reject;
im.src = src;
});
}
/** 페이지 캐시 (최근 몇 장만 메모리에 유지) */
class PageCache {
constructor(limit = 6) { this.limit = limit; this.map = new Map(); }
async get(pageId) {
if (this.map.has(pageId)) {
const v = this.map.get(pageId);
this.map.delete(pageId); this.map.set(pageId, v);
return v;
}
const rec = await db.get('pages', pageId);
if (!rec) return null;
const im = await loadImage(rec.image);
const canvas = document.createElement('canvas');
canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.drawImage(im, 0, 0);
const v = { rec, canvas, imageData: ctx.getImageData(0, 0, canvas.width, canvas.height) };
this.map.set(pageId, v);
while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
return v;
}
}
function pageId(bookId, kind, index) {
return `${bookId}:${kind}:${index}`;
}
/** 조각들을 잉크 영역에 맞게 다듬는다. 너무 작은 조각은 버림 */
async function trimFragments(cache, bookId, kind, fragments) {
const out = [];
for (const f of fragments) {
const pg = await cache.get(pageId(bookId, kind, f.page));
if (!pg) continue;
const t = trimBox(pg.imageData, f);
if (!t) continue;
if (f.cont && t.y1 - t.y0 < pg.canvas.height * 0.015) continue;
out.push({ page: f.page, ...t, cont: !!f.cont });
}
return out;
}
/** 조각을 원래 픽셀 비율 그대로 세로로 이어붙인 무손실 PNG */
async function cropFragments(cache, bookId, kind, fragments) {
const parts = [];
for (const f of fragments) {
const pg = await cache.get(pageId(bookId, kind, f.page));
if (pg) parts.push({ pg, f });
}
if (!parts.length) return null;
const gap = 8;
const w = Math.max(...parts.map((p) => p.f.x1 - p.f.x0));
const h = parts.reduce((s, p) => s + (p.f.y1 - p.f.y0), 0) + gap * (parts.length - 1);
const c = document.createElement('canvas');
c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
const ctx = c.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
let y = 0;
for (const { pg, f } of parts) {
const fw = f.x1 - f.x0, fh = f.y1 - f.y0;
ctx.drawImage(pg.canvas, f.x0, f.y0, fw, fh, 0, y, fw, fh);
y += fh + gap;
}
return { image: c.toDataURL('image/png'), imageFormat: 'PNG', w: c.width, h: c.height };
}
/** 한글 텍스트를 이미지로 (jsPDF 한글 폰트 문제 회피) */
function textImage(text, { size = 28, bold = false, color = '#111', maxWidth = 2000 } = {}) {
const c = document.createElement('canvas');
const ctx = c.getContext('2d');
const font = `${bold ? '700 ' : ''}${size}px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif`;
ctx.font = font;
const w = Math.min(maxWidth, Math.ceil(ctx.measureText(text).width) + 4);
c.width = Math.max(1, w); c.height = Math.ceil(size * 1.4);
ctx.font = font; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
ctx.fillStyle = color; ctx.textBaseline = 'middle';
ctx.fillText(text, 2, c.height / 2);
return { image: c.toDataURL('image/png'), w: c.width, h: c.height };
}
return { loadImage, PageCache, pageId, trimFragments, cropFragments, textImage };
})();
// ===== part1.js 끝 =====
