// MathBook part3.js — 이 줄부터 끝까지 전부 복사
var M = window.M || (window.M = {});
M.app = (() => {
const db = M.db;
const { ingestBook, segmentKind, relink, finalizeItem, DEFAULT_OPTIONS } = M.pipeline;
const { PageCache, pageId, loadImage } = M.imaging;
const { trimBox } = M.layout;
const { itemKey } = M.segment;
const { BOOK_LEVELS, heuristicGrades, effectiveGrade, gradeSource } = M.grade;
const { PROVIDERS, SUBJECTS, gradeWithLLM, loadConfig, saveConfig } = M.llm;
const { MIX_PRESETS, selectProblems, replaceOne } = M.select;
const { buildPdf } = M.build;
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
const e = document.createElement(tag);
for (const [k, v] of Object.entries(attrs)) {
if (k === 'class') e.className = v;
else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
}
for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : String(c));
return e;
};
const opt = (value, label, selected) => el('option', { value, selected: !!selected }, label);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let books = [];
const bookById = (id) => books.find((b) => b.id === id);
async function refreshBooks() {
books = (await db.all('books')).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
for (const sel of ['#rv-book', '#gr-book']) {
const s = $(sel), cur = s.value;
s.replaceChildren(...books.map((b) => opt(b.id, b.name, b.id === cur)));
}
renderLibrary();
renderBuildFilters();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => {
document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
if (b.dataset.tab === 'review') loadReview();
if (b.dataset.tab === 'grade') renderHist();
}));
$('#in-subject').append(opt('', '(미정)'), ...SUBJECTS.map((s) => opt(s, s)));
$('#in-level').append(...Object.entries(BOOK_LEVELS).map(([k, v]) => opt(k, v.label)));
function logTo(pre, bar) {
return (msg, frac) => {
if (msg) {
const last = pre.lastChild?.textContent || '';
const key = (m) => m.replace(/[\d/]+/g, '#');
if (pre.lastChild && key(last) === key(msg + '\n')) pre.lastChild.textContent = msg + '\n';
else pre.append(document.createTextNode(msg + '\n'));
pre.scrollTop = pre.scrollHeight;
}
if (frac != null) bar.style.width = Math.round(frac * 100) + '%';
};
}
$('#btn-ingest').addEventListener('click', async () => {
const problemFile = $('#in-problem').files[0];
const solutionFile = $('#in-solution').files[0];
if (!problemFile) return alert('문제집 PDF를 선택하세요.');
const name = $('#in-name').value.trim() || problemFile.name.replace(/\.pdf$/i, '');
const log = logTo($('#ingest-log'), $('#ingest-bar'));
const btn = $('#btn-ingest');
btn.disabled = true;
try {
const book = await ingestBook({
name, subject: $('#in-subject').value, level: $('#in-level').value, problemFile, solutionFile,
options: {
scale: +$('#opt-scale').value, top: +$('#opt-top').value, bottom: +$('#opt-bottom').value,
leftTol: +$('#opt-left').value, maxSkip: +$('#opt-skip').value, forceOcr: $('#opt-ocr').checked,
},
}, log);
const s = book.stats;
log(`완료: 문제 ${s.problems}개, 해설 ${s.solutions}개, 연결 ${s.matched}개`, 1);
await runHeuristic(book.id);
log('규칙 기반 난이도 판정 완료. ② 검토·수정 탭에서 분리 결과를 확인하세요.');
await refreshBooks();
$('#rv-book').value = book.id;
} catch (e) {
console.error(e);
log('오류: ' + e.message);
} finally {
btn.disabled = false;
}
});
const rv = { book: null, kind: 'problem', page: 1, items: [], rec: null, img: null, imageData: null, sel: null, drag: null, cache: new PageCache() };
async function loadReview() {
const id = $('#rv-book').value;
rv.book = bookById(id);
if (!rv.book) { $('#rv-side').textContent = '먼저 책을 추가하세요.'; return; }
rv.kind = $('#rv-kind').value;
rv.items = (await db.byBook('items', id)).filter((i) => i.kind === rv.kind);
rv.items.sort((a, b) => (a.section - b.section) || (a.number - b.number));
const n = rv.book.pageCounts?.[rv.kind] || 0;
$('#rv-pages').textContent = n;
rv.page = Math.min(Math.max(1, rv.page), Math.max(1, n));
rv.sel = null;
await showPage();
renderReviewList();
}
async function showPage() {
$('#rv-page').value = rv.page;
rv.rec = await db.get('pages', pageId(rv.book.id, rv.kind, rv.page));
const cv = $('#rv-canvas');
if (!rv.rec) { cv.width = cv.height = 1; return; }
rv.img = await loadImage(rv.rec.image);
cv.width = rv.img.naturalWidth; cv.height = rv.img.naturalHeight;
const ctx = cv.getContext('2d', { willReadFrequently: true });
ctx.drawImage(rv.img, 0, 0);
rv.imageData = ctx.getImageData(0, 0, cv.width, cv.height);
drawOverlay();
renderSide();
}
function fragsOnPage() {
const out = [];
for (const it of rv.items) it.fragments.forEach((f, fi) => { if (f.page === rv.page) out.push({ it, f, fi }); });
return out;
}
function drawOverlay() {
const cv = $('#rv-canvas');
const ctx = cv.getContext('2d');
ctx.drawImage(rv.img, 0, 0);
ctx.setLineDash([8, 8]); ctx.strokeStyle = 'rgba(0,150,0,.5)'; ctx.lineWidth = 2;
for (const c of rv.rec.columns || []) ctx.strokeRect(c.x0, 2, c.x1 - c.x0, cv.height - 4);
ctx.setLineDash([]);
for (const { it, f, fi } of fragsOnPage()) {
const selected = rv.sel && rv.sel.id === it.id && rv.sel.fi === fi;
const hue = (it.number * 67) % 360;
ctx.strokeStyle = selected ? '#e00' : `hsl(${hue},70%,45%)`;
ctx.lineWidth = selected ? 5 : 3;
ctx.strokeRect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0);
const label = (rv.items.some((x) => x.section > 1) ? itemKey(it) : String(it.number)) + (f.cont ? ' (이어짐)' : '');
ctx.font = 'bold 26px sans-serif';
const w = ctx.measureText(label).width + 10;
ctx.fillStyle = selected ? '#e00' : `hsl(${hue},70%,45%)`;
ctx.fillRect(f.x1 - w, f.y0, w, 32);
ctx.fillStyle = '#fff'; ctx.fillText(label, f.x1 - w + 5, f.y0 + 25);
}
if (rv.drag) {
const d = rv.drag;
ctx.strokeStyle = '#06f'; ctx.lineWidth = 3; ctx.setLineDash([6, 4]);
ctx.strokeRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
ctx.setLineDash([]);
}
}
function canvasPoint(ev) {
const cv = $('#rv-canvas');
const r = cv.getBoundingClientRect();
return { x: (ev.clientX - r.left) * (cv.width / r.width), y: (ev.clientY - r.top) * (cv.height / r.height) };
}
$('#rv-canvas').addEventListener('mousedown', (ev) => {
if (!rv.rec) return;
const p = canvasPoint(ev);
const hit = fragsOnPage().reverse().find(({ f }) => p.x >= f.x0 && p.x <= f.x1 && p.y >= f.y0 && p.y <= f.y1);
if (hit) { rv.sel = { id: hit.it.id, fi: hit.fi }; drawOverlay(); renderSide(); return; }
rv.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});
window.addEventListener('mousemove', (ev) => {
if (!rv.drag) return;
const p = canvasPoint(ev);
rv.drag.x1 = p.x; rv.drag.y1 = p.y;
drawOverlay();
});
window.addEventListener('mouseup', async () => {
if (!rv.drag) return;
const d = rv.drag; rv.drag = null;
const box = { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) };
drawOverlay();
if (box.x1 - box.x0 < 15 || box.y1 - box.y0 < 15) { rv.sel = null; drawOverlay(); renderSide(); return; }
const input = prompt('이 영역의 번호를 입력하세요.\n이미 있는 번호면 그 항목에 이어붙입니다. (단원이 여러 개면 "2-15" 형식)');
if (!input) return;
const m = input.trim().match(/^(?:(\d+)\s*-\s*)?(\d+)$/);
if (!m) return alert('번호 형식이 올바르지 않습니다.');
const section = m[1] ? +m[1] : 1, number = +m[2];
const t = trimBox(rv.imageData, box, 6) || box;
const frag = { page: rv.page, ...t };
let it = rv.items.find((x) => x.section === section && x.number === number);
if (it) {
it.fragments.push(frag);
it.fragments.sort((a, b) => (a.page - b.page) || (a.x0 - b.x0) || (a.y0 - b.y0));
} else {
it = { id: db.uid(rv.kind[0]), bookId: rv.book.id, kind: rv.kind, section, number, fragments: [frag], manual: true };
rv.items.push(it);
}
await saveItem(it, true);
rv.sel = { id: it.id, fi: it.fragments.indexOf(frag) };
drawOverlay(); renderSide();
});
window.addEventListener('keydown', async (ev) => {
if (ev.key !== 'Delete' || !rv.sel || !$('#tab-review').classList.contains('active')) return;
if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
await deleteFragment();
});
async function saveItem(it, relinkAfter) {
await finalizeItem(it, rv.cache, null, rv.book.options?.scale || DEFAULT_OPTIONS.scale);
await db.put('items', it);
if (relinkAfter) await relink(rv.book.id);
rv.items = (await db.byBook('items', rv.book.id)).filter((i) => i.kind === rv.kind);
rv.items.sort((a, b) => (a.section - b.section) || (a.number - b.number));
renderReviewList();
}
async function deleteFragment() {
const it = rv.items.find((x) => x.id === rv.sel.id);
if (!it) return;
it.fragments.splice(rv.sel.fi, 1);
rv.sel = null;
if (!it.fragments.length) await deleteItem(it);
else await saveItem(it, false);
drawOverlay(); renderSide();
}
async function deleteItem(it) {
await db.del('items', it.id);
rv.items = rv.items.filter((x) => x.id !== it.id);
rv.sel = null;
await relink(rv.book.id);
renderReviewList();
}
async function renderSide() {
const side = $('#rv-side');
const it = rv.sel && rv.items.find((x) => x.id === rv.sel.id);
if (!it) {
side.replaceChildren(el('p', {}, `이 쪽의 영역: ${fragsOnPage().length}개`), el('p', { class: 'hint' }, '상자를 클릭하면 상세 정보가 여기에 표시됩니다.'));
return;
}
const sec = el('input', { type: 'number', value: it.section, min: 1 });
const num = el('input', { type: 'number', value: it.number, min: 1 });
const kids = [
el('h3', {}, `${rv.kind === 'problem' ? '문제' : '해설'} ${itemKey(it)}`),
el('div', { class: 'row' }, '단원 ', sec, ' 번호 ', num,
el('button', { onclick: async () => { it.section = +sec.value; it.number = +num.value; await saveItem(it, true); drawOverlay(); renderSide(); } }, '저장')),
it.image ? el('img', { src: it.image }) : null,
el('div', { class: 'row' },
el('button', { onclick: deleteFragment }, '이 영역 삭제'),
el('button', { onclick: async () => { if (confirm('항목 전체를 삭제할까요?')) { await deleteItem(it); drawOverlay(); renderSide(); } } }, '항목 삭제')),
];
if (rv.kind === 'problem') {
const sol = it.solutionId ? await db.get('items', it.solutionId) : null;
kids.push(el('p', {}, '난이도: ', gradeBadge(it)), gradeEditor(it, () => renderSide()));
kids.push(el('p', {}, '정답: ', it.answer ?? '-'));
kids.push(el('h4', {}, '연결된 해설'), sol?.image ? el('img', { src: sol.image }) : el('p', { class: 'badge warn' }, '연결된 해설 없음'));
}
if (it.text) kids.push(el('details', {}, el('summary', {}, '인식된 텍스트'), el('pre', { style: 'white-space:pre-wrap;font-size:12px' }, it.text)));
side.replaceChildren(...kids);
}
function gradeBadge(p) {
const g = effectiveGrade(p);
return el('span', { class: 'badge' + (g == null ? ' warn' : '') }, g == null ? '미판정' : `${g}등급 (${gradeSource(p)})`);
}
function gradeEditor(p, after) {
const s = el('select', {}, opt('', '수동 지정 안 함'), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => opt(g, `${g}등급`, p.gradeManual === g)));
s.addEventListener('change', async () => {
p.gradeManual = s.value ? +s.value : null;
const fresh = await db.get('items', p.id);
fresh.gradeManual = p.gradeManual;
await db.put('items', fresh);
after && after();
});
return s;
}
function renderReviewList() {
const list = $('#rv-list');
$('#rv-count').textContent = `(${rv.items.length}개)`;
list.replaceChildren(...rv.items.map((it) => el('div', { class: 'card' },
el('div', { class: 'row' },
el('b', {}, itemKey(it)),
el('span', { class: 'hint' }, `p.${it.fragments.map((f) => f.page).join(',')}`),
rv.kind === 'problem' ? gradeBadge(it) : null,
rv.kind === 'problem' && !it.solutionId ? el('span', { class: 'badge warn' }, '해설 없음') : null,
el('button', { onclick: async () => { rv.page = it.fragments[0].page; rv.sel = { id: it.id, fi: 0 }; await showPage(); $('#rv-canvas').scrollIntoView({ behavior: 'smooth' }); } }, '보기')),
it.image ? el('img', { src: it.image, loading: 'lazy' }) : null)));
}
$('#rv-book').addEventListener('change', () => { rv.page = 1; loadReview(); });
$('#rv-kind').addEventListener('change', () => { rv.page = 1; loadReview(); });
$('#rv-prev').addEventListener('click', () => { if (rv.page > 1) { rv.page--; rv.sel = null; showPage(); } });
$('#rv-next').addEventListener('click', () => { if (rv.page < (rv.book?.pageCounts?.[rv.kind] || 1)) { rv.page++; rv.sel = null; showPage(); } });
$('#rv-page').addEventListener('change', () => { rv.page = Math.max(1, Math.min(+$('#rv-page').value, rv.book?.pageCounts?.[rv.kind] || 1)); rv.sel = null; showPage(); });
$('#rv-reseg').addEventListener('click', async () => {
if (!rv.book || !confirm('수동 수정 내용과 (문제의 경우) 난이도 판정 결과가 사라집니다. 다시 분리할까요?\n분리 설정은 책 추가 탭의 "고급 설정" 값을 사용합니다.')) return;
rv.book.options = { ...rv.book.options, top: +$('#opt-top').value, bottom: +$('#opt-bottom').value, leftTol: +$('#opt-left').value, maxSkip: +$('#opt-skip').value };
await db.put('books', rv.book);
$('#rv-side').textContent = '다시 분리하는 중...';
await segmentKind(rv.book, rv.kind, null, (m) => { $('#rv-side').textContent = m; });
await relink(rv.book.id);
if (rv.kind === 'problem') await runHeuristic(rv.book.id);
await loadReview();
});
$('#rv-relink').addEventListener('click', async () => {
if (!rv.book) return;
const s = await relink(rv.book.id);
alert(`문제 ${s.problems}개 중 ${s.matched}개에 해설이 연결되었습니다.`);
loadReview();
});
async function runHeuristic(bookId) {
const book = bookById(bookId) || await db.get('books', bookId);
const items = await db.byBook('items', bookId);
const problems = items.filter((i) => i.kind === 'problem');
const sols = new Map(items.filter((i) => i.kind === 'solution').map((s) => [s.id, s]));
const res = new Map(heuristicGrades(problems, sols, book.level).map((r) => [r.id, r]));
for (const p of problems) {
const r = res.get(p.id);
p.gradeHeur = r.grade; p.heurScore = r.score;
}
await db.putMany('items', problems);
return problems.length;
}
const cfg = { provider: 'gemini', apiKey: '', model: PROVIDERS.gemini.model, baseUrl: '', delay: 1500, ...loadConfig() };
$('#gr-provider').append(...Object.entries(PROVIDERS).map(([k, v]) => opt(k, v.label, k === cfg.provider)));
$('#gr-key').value = cfg.apiKey; $('#gr-model').value = cfg.model; $('#gr-base').value = cfg.baseUrl; $('#gr-delay').value = cfg.delay;
function readCfg() {
Object.assign(cfg, { provider: $('#gr-provider').value, apiKey: $('#gr-key').value.trim(), model: $('#gr-model').value.trim(), baseUrl: $('#gr-base').value.trim(), delay: +$('#gr-delay').value || 0 });
saveConfig(cfg);
return cfg;
}
$('#gr-provider').addEventListener('change', () => { $('#gr-model').value = PROVIDERS[$('#gr-provider').value].model; readCfg(); });
['#gr-key', '#gr-model', '#gr-base', '#gr-delay'].forEach((s) => $(s).addEventListener('change', readCfg));
const grLog = logTo($('#gr-log'), $('#gr-bar'));
$('#gr-heur').addEventListener('click', async () => {
const id = $('#gr-book').value;
if (!id) return;
const n = await runHeuristic(id);
grLog(`규칙 기반 판정 완료: ${n}문제`, 1);
renderHist();
});
let stopFlag = false;
$('#gr-stop').addEventListener('click', () => { stopFlag = true; });
async function runLLM(all, limit) {
const c = readCfg();
if (PROVIDERS[c.provider].needsKey && !c.apiKey) return alert('API 키를 입력하세요.');
const book = bookById($('#gr-book').value);
if (!book) return;
const items = await db.byBook('items', book.id);
const sols = new Map(items.filter((i) => i.kind === 'solution').map((s) => [s.id, s]));
let todo = items.filter((i) => i.kind === 'problem' && i.image && (all || i.gradeLLM == null));
todo.sort((a, b) => (a.section - b.section) || (a.number - b.number));
if (limit) todo = todo.slice(0, limit);
stopFlag = false;
let ok = 0, fail = 0;
for (let i = 0; i < todo.length && !stopFlag; i++) {
const p = todo[i];
try {
const r = await gradeWithLLM(c, p, sols.get(p.solutionId), book.subject);
p.gradeLLM = r.grade; p.unit = r.unit; p.subjectLLM = r.subject; p.llmReason = r.reason;
if (!p.answer && r.answer) { p.answer = r.answer; p.answerLLM = true; }
await db.put('items', p);
ok++;
grLog(`${itemKey(p)}번 → ${r.grade}등급 · ${r.subject ?? ''} ${r.unit ?? ''} · ${r.reason}`, (i + 1) / todo.length);
} catch (e) {
fail++;
grLog(`${itemKey(p)}번 실패: ${e.message}`, (i + 1) / todo.length);
if (e.status === 401 || e.status === 403 || e.message.includes('Failed to fetch')) { grLog('인증/연결 오류로 중단합니다. 키와 주소를 확인하세요.'); break; }
}
if (c.delay) await sleep(c.delay);
}
grLog(`AI 판정 끝: 성공 ${ok}, 실패 ${fail}${stopFlag ? ' (중지됨)' : ''}`);
renderHist();
}
$('#gr-test').addEventListener('click', () => runLLM(true, 1));
$('#gr-llm').addEventListener('click', () => runLLM(false));
$('#gr-llm-all').addEventListener('click', () => runLLM(true));
$('#gr-book').addEventListener('change', renderHist);
async function renderHist() {
const id = $('#gr-book').value;
const hist = $('#gr-hist');
if (!id) return hist.replaceChildren();
const probs = (await db.byBook('items', id)).filter((i) => i.kind === 'problem');
const counts = Array(10).fill(0);
let none = 0;
for (const p of probs) { const g = effectiveGrade(p); if (g == null) none++; else counts[g]++; }
const max = Math.max(1, ...counts);
hist.replaceChildren(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => el('div', { class: 'bar', style: `height:${(counts[g] / max) * 100}%` }, el('b', {}, counts[g]), el('span', {}, `${g}등급`))));
if (none) hist.append(el('div', { class: 'hint' }, `미판정 ${none}`));
}
$('#bd-target').append(...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => opt(g, `${g}등급`, g === 3)));
$('#bd-mix').append(...Object.entries(MIX_PRESETS).map(([k, v]) => opt(k, v.label)));
let pool = [], solById = new Map(), selection = [];
async function loadPool() {
const items = await db.all('items');
solById = new Map(items.filter((i) => i.kind === 'solution').map((s) => [s.id, s]));
pool = items.filter((i) => i.kind === 'problem').map((p) => ({ ...p, subject: p.subjectLLM || bookById(p.bookId)?.subject || '(미정)' }));
}
async function renderBuildFilters() {
await loadPool();
const checked = (box) => new Set([...box.querySelectorAll('input:checked')].map((c) => c.value));
const bb = $('#bd-books'), prevB = checked(bb);
bb.replaceChildren(...books.map((b) => el('label', {}, el('input', { type: 'checkbox', value: b.id, checked: !prevB.size || prevB.has(b.id) }), ' ', b.name)));
const subs = [...new Set(pool.map((p) => p.subject))].sort();
const sb = $('#bd-subjects'), prevS = checked(sb);
sb.replaceChildren(...subs.map((s) => el('label', {}, el('input', { type: 'checkbox', value: s, checked: !prevS.size || prevS.has(s) }), ' ', s)));
}
function buildOpts() {
return {
target: +$('#bd-target').value,
count: +$('#bd-count').value,
mix: MIX_PRESETS[$('#bd-mix').value],
requireSolution: $('#bd-reqsol').checked,
bookIds: [...$('#bd-books').querySelectorAll('input:checked')].map((c) => c.value),
subjects: [...$('#bd-subjects').querySelectorAll('input:checked')].map((c) => c.value),
};
}
$('#bd-select').addEventListener('click', async () => {
await loadPool();
const o = buildOpts();
const r = selectProblems(pool, { ...o, seed: Date.now() });
selection = r.problems;
$('#bd-info').textContent = `조건에 맞는 문제 ${r.available}개 중 ${selection.length}개 선택` + (r.shortage ? ` (문제가 ${r.shortage}개 부족)` : '');
renderSelection();
});
function renderSelection() {
$('#bd-list').replaceChildren(...selection.map((p, i) => {
const sol = solById.get(p.solutionId);
return el('div', { class: 'card' },
el('div', { class: 'row' }, el('b', {}, `${i + 1}번`), gradeBadge(p), el('span', { class: 'hint' }, `${bookById(p.bookId)?.name ?? ''} ${p.number}번 · ${p.subject}`),
el('button', { onclick: () => { selection = replaceOne(selection, i, pool, buildOpts()); renderSelection(); } }, '교체'),
el('button', { onclick: () => { selection.splice(i, 1); renderSelection(); } }, '빼기')),
el('img', { src: p.image, loading: 'lazy' }),
sol?.image ? el('img', { class: 'sol', src: sol.image, loading: 'lazy' }) : el('span', { class: 'badge warn' }, '해설 없음'));
}));
}
$('#bd-pdf').addEventListener('click', async () => {
if (!selection.length) return alert('먼저 "문제 고르기"를 누르세요.');
const btn = $('#bd-pdf');
btn.disabled = true;
try {
const target = +$('#bd-target').value;
const doc = await buildPdf(selection.map((p) => ({ problem: p, solution: solById.get(p.solutionId), book: bookById(p.bookId) })), {
title: $('#bd-title').value,
subtitle: `목표 ${target}등급 · ${selection.length}문항 · ${new Date().toLocaleDateString('ko-KR')}`,
mode: $('#bd-mode').value, columns: +$('#bd-cols').value, zoom: +$('#bd-zoom').value,
answerKey: $('#bd-key').checked, showSource: $('#bd-src').checked,
});
doc.save(`${$('#bd-title').value || '문제집'}_${target}등급.pdf`);
} catch (e) {
console.error(e); alert('PDF 생성 실패: ' + e.message);
} finally {
btn.disabled = false;
}
});
async function renderLibrary() {
const items = await db.all('items');
$('#lib-books').replaceChildren(...(books.length ? books.map((b) => {
const mine = items.filter((i) => i.bookId === b.id);
const probs = mine.filter((i) => i.kind === 'problem');
const graded = probs.filter((p) => effectiveGrade(p) != null).length;
const ai = probs.filter((p) => p.gradeLLM != null).length;
return el('div', { class: 'bookrow' },
el('div', {}, el('b', {}, b.name), ' ', el('span', { class: 'hint' }, `${b.subject || '과목 미정'} · ${BOOK_LEVELS[b.level]?.label ?? ''}`), el('br'),
`문제 ${probs.length} · 해설 ${mine.length - probs.length} · 해설 연결 ${probs.filter((p) => p.solutionId).length} · 난이도 ${graded} (AI ${ai})`),
el('div', {},
el('select', { onchange: async (ev) => { b.level = ev.target.value; await db.put('books', b); await runHeuristic(b.id); renderLibrary(); } },
...Object.entries(BOOK_LEVELS).map(([k, v]) => opt(k, v.label, k === b.level))),
' ',
el('button', { onclick: async () => { if (confirm(`"${b.name}"을(를) 삭제할까요?`)) { await db.deleteBook(b.id); refreshBooks(); } } }, '삭제')));
}) : [el('p', { class: 'hint' }, '아직 추가된 책이 없습니다.')]));
}
$('#lib-export').addEventListener('click', async () => {
const data = { version: 1, books: await db.all('books'), pages: await db.all('pages'), items: await db.all('items') };
const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
const a = el('a', { href: URL.createObjectURL(blob), download: `mathbook-backup-${new Date().toISOString().slice(0, 10)}.json` });
a.click();
setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('#lib-import').addEventListener('change', async (ev) => {
const f = ev.target.files[0];
if (!f) return;
const data = JSON.parse(await f.text());
for (const name of ['books', 'pages', 'items']) if (data[name]) await db.putMany(name, data[name]);
alert('가져오기 완료');
refreshBooks();
});
refreshBooks();
})();
// ===== part3.js 끝 =====
