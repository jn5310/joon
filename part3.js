// Math Finder part3.js — 이 줄부터 끝까지 전부 복사
var M = window.M || (window.M = {});
M.app = (() => {
const db = M.db;
const { ingestBook, segmentKind, relink, finalizeItem, pagesWithoutImage, PageImageMissingError, sameRegions, DEFAULT_OPTIONS, HEARTBEAT_STALE_MS } = M.pipeline;
const { PageCache, pageId, loadImage } = M.imaging;
const { trimBox } = M.layout;
const { itemKey } = M.segment;
const { BOOK_LEVELS, heuristicGrades, effectiveGrade, gradeSource } = M.grade;
const { PROVIDERS, SUBJECTS, analyzeWithLLM, toSchemaJson, numberOf, levelToGrade, loadConfig, saveConfig } = M.llm;
const { MIX_PRESETS, filterPool, selectProblems, replaceOne } = M.select;
const { UNCLASSIFIED, AREAS, TYPES, classifyBook, effectiveType, isStandardType, compareTypes } = M.classify;
const { buildPdf } = M.build;
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
const e = document.createElement(tag);
for (const [k, v] of Object.entries(attrs)) {
if (k === 'class') e.className = v;
else if (k === 'src' && v != null && typeof v !== 'string') {
// IndexedDB Blob/외부 폴더 참조를 화면용 object URL로 바꾼다
M.assets.getBlob(v).then((blob) => {
const url = URL.createObjectURL(blob);
e.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
e.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
e.src = url;
}).catch(() => { e.alt = '이미지를 열 수 없음'; });
}
else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
}
for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : String(c));
return e;
};
const opt = (value, label, selected) => el('option', { value, selected: !!selected }, label);
/** 문제 순서: 본문 번호 먼저, 그다음 예제·유제 같은 라벨별로 단원·번호 순 */
const byItemOrder = (a, b) => ((a.label ? 1 : 0) - (b.label ? 1 : 0)) || String(a.label || '').localeCompare(String(b.label || '')) || (a.section - b.section) || (a.number - b.number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 숫자 입력칸 읽기: 비었거나 범위를 벗어나면 기본값·경계값으로 바꾼다 */
const numIn = (sel, def, lo, hi) => { const v = parseFloat($(sel).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
/** 오류를 사용자에게 보여줄 문장으로 */
function friendlyError(e) {
const msg = String(e?.message || e || '알 수 없는 오류');
if (db.isQuotaError(e)) return '브라우저 저장 공간이 부족합니다. 라이브러리에서 쓰지 않는 책을 지우거나, 백업한 뒤 정리하세요.';
if (e?.name === 'PasswordException') return '암호가 걸린 PDF는 열 수 없습니다. 암호를 푼 PDF로 다시 시도하세요.';
if (e?.name === 'InvalidPDFException' || /Invalid PDF|PDF 구조/i.test(msg)) return 'PDF 파일을 읽을 수 없습니다. 손상되지 않은 PDF인지 확인하세요.';
if (e?.name === 'NotAllowedError' || /폴더.*권한|폴더 연결이 끊겼/i.test(msg)) return '대용량 저장 폴더 권한이 없습니다. 라이브러리에서 같은 폴더를 다시 연결하세요.';
if (e?.name === 'NotFoundError') return '대용량 저장 폴더에서 이미지 파일을 찾을 수 없습니다. 폴더(MathFinderData)를 옮기거나 지우지 않았는지 확인하고, 라이브러리에서 같은 폴더를 다시 연결하세요.';
if (/Tesseract|jsPDF|로드 실패|Failed to fetch|NetworkError|dynamically imported module|Load failed/i.test(msg)) {
return `필요한 프로그램을 내려받지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요. (${msg})`;
}
return msg;
}
let toastTimer = null;
/** 화면 아래에 잠깐 오류를 띄운다 (예상하지 못한 오류가 조용히 묻히지 않도록) */
function toast(msg) {
const t = $('#toast');
t.textContent = msg; t.hidden = false;
clearTimeout(toastTimer);
toastTimer = setTimeout(() => { t.hidden = true; }, 10000);
}
$('#toast').addEventListener('click', () => { $('#toast').hidden = true; });
window.addEventListener('unhandledrejection', (ev) => { console.error(ev.reason); toast('처리 중 오류가 났습니다: ' + friendlyError(ev.reason)); });
window.addEventListener('error', (ev) => { if (ev.error) toast('처리 중 오류가 났습니다: ' + friendlyError(ev.error)); });
let books = [];
const bookById = (id) => books.find((b) => b.id === id);
/** 책 목록만 저장소에서 다시 읽는다 (다른 창에서 바뀐 처리 상태도 반영) */
async function reloadBooks() {
books = (await db.all('books')).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
for (const sel of ['#rv-book', '#gr-book']) {
const s = $(sel), cur = s.value;
s.replaceChildren(...books.map((b) => opt(b.id, b.name, b.id === cur)));
}
}
async function refreshBooks() {
await reloadBooks();
await Promise.all([renderLibrary(), renderBuildFilters()]);
if ($('#tab-classify').classList.contains('active')) await renderClassify();
}
function activateTab(name) {
const button = $(`#tabs button[data-tab="${name}"]`);
document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x === button));
document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
if (name !== 'classify') releaseClassifyItems();
if (name === 'review') return loadReview();
if (name === 'classify') return renderClassify();
if (name === 'grade') return renderHist();
if (name === 'build' && buildFiltersStale) return renderBuildFilters(); // 유형이 바뀐 뒤에만 필터를 새로 만든다
if (name === 'library') return reloadBooks().then(renderLibrary); // 상태 표시가 오래되지 않도록
return Promise.resolve();
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => activateTab(b.dataset.tab)));
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
let ingestControl = null;
$('#btn-ingest-stop').addEventListener('click', () => {
if (!ingestControl?.acceptingStops || ingestControl.stopRequested) return;
ingestControl.stopRequested = true;
const stopBtn = $('#btn-ingest-stop');
stopBtn.disabled = true;
stopBtn.textContent = '중지 요청됨';
ingestControl.log('중지 요청됨: 현재 처리 중인 페이지를 저장한 뒤, 완료된 페이지까지만 문제를 분리합니다.');
});
$('#btn-ingest').addEventListener('click', async () => {
const problemFile = $('#in-problem').files[0];
const solutionFile = $('#in-solution').files[0];
if (!problemFile) return alert('문제집 PDF를 선택하세요.');
const name = $('#in-name').value.trim() || problemFile.name.replace(/\.pdf$/i, '');
const log = logTo($('#ingest-log'), $('#ingest-bar'));
const btn = $('#btn-ingest');
const stopBtn = $('#btn-ingest-stop');
ingestControl = {
stopRequested: false,
acceptingStops: false,
log,
onStateChange() {
stopBtn.disabled = !this.acceptingStops || this.stopRequested;
stopBtn.textContent = this.stopRequested
? '중지 요청됨'
: this.acceptingStops ? '현재 페이지까지만 처리하고 중지' : '분리·저장 중';
},
};
btn.disabled = true;
ingestControl.onStateChange();
// 저장 공간이 모자랄 때 브라우저가 책 데이터를 지우지 않도록 영구 저장을 요청한다
navigator.storage?.persist?.().catch(() => {});
try {
const book = await ingestBook({
name, subject: $('#in-subject').value, level: $('#in-level').value, problemFile, solutionFile,
options: readSegmentOptions(),
}, log, ingestControl);
const s = book.stats;
if (book.ingest?.status === 'stopped') {
const at = book.ingest.stoppedAt;
const label = at.kind === 'problem' ? '문제집' : '해설지';
log(`부분 처리 완료: ${label} ${at.processedPages}/${at.totalPages}쪽 · 문제 ${s.problems}개, 해설 ${s.solutions}개, 연결 ${s.matched}개`, 1);
} else {
log(`완료: 문제 ${s.problems}개, 해설 ${s.solutions}개, 연결 ${s.matched}개`, 1);
}
cl.bookId = book.id; cl.type = '';
let graded = true;
try {
await runHeuristic(book.id);
} catch (e) {
// 책은 이미 저장됐다. 판정만 실패했으니 경고로 알리고 계속한다
graded = false;
log(`주의: 규칙 기반 난이도 판정을 저장하지 못했습니다 — ${friendlyError(e)} (④ 난이도 탭에서 다시 할 수 있습니다)`);
}
const gradedMsg = graded ? '규칙 기반 난이도 판정 완료.' : '분리 완료 (난이도 판정은 나중에 다시 하세요).';
ingestControl = null;
await refreshBooks();
$('#rv-book').value = book.id;
log(`유형 분류 완료: ${typeSummary(await db.byBook('items', book.id)) || '분류할 문제 없음'}`);
if (book.ingest?.status === 'stopped') {
log(`${gradedMsg} 인식된 문제를 하나씩 확인할 수 있도록 검토 화면을 엽니다.`);
$('#rv-kind').value = 'problem';
rv.page = 1;
activateTab('review');
} else {
log(`${gradedMsg} ② 검토·수정 탭에서 분리 결과를, ③ 문제 분류 탭에서 책별·유형별 분류를 확인하세요.`);
}
} catch (e) {
console.error(e);
log('오류: ' + friendlyError(e));
const startedId = e?.bookId || ingestControl?.bookId;
if (startedId) endedHere.add(startedId);
ingestControl = null;
if (e?.bookId) {
// 이미 분리된 문제는 바로 쓸 수 있게 해설 연결·난이도 판정을 해 둔다 (실패해도 무시)
try { await relink(e.bookId); await runHeuristic(e.bookId); } catch { /* 저장 공간 부족 등 */ }
log('저장된 쪽까지는 남겨 두었습니다. ② 검토·수정에서 확인하고, 분리되지 않은 종류가 있으면 "자동 인식 다시 분석"를 누르세요.');
}
// 어느 단계에서 실패했든 목록은 새로 고친다 (저장은 끝났는데 목록에만 안 보이는 일 방지)
await refreshBooks().catch(() => {});
if (e?.bookId && bookById(e.bookId)) $('#rv-book').value = e.bookId;
} finally {
ingestControl = null;
btn.disabled = false;
stopBtn.disabled = true;
stopBtn.textContent = '현재 페이지까지만 처리하고 중지';
}
});
/** 고급 설정 값. 칸을 비우거나 범위를 벗어나면 기본값·경계값을 쓴다 */
function readSegmentOptions() {
return {
scale: numIn('#opt-scale', 2, 1, 4), top: numIn('#opt-top', 0.07, 0, 0.3), bottom: numIn('#opt-bottom', 0.06, 0, 0.3),
leftTol: numIn('#opt-left', 0.1, 0.02, 0.5), maxSkip: Math.round(numIn('#opt-skip', 3, 1, 10)), forceOcr: $('#opt-ocr').checked,
};
}
// 처리나 AI 판정 중에 창을 닫으려 하면 한 번 묻는다
window.addEventListener('beforeunload', (ev) => {
if (!ingestControl && !llmRunning) return;
ev.preventDefault();
ev.returnValue = '';
});
/**
* 처리 상태: 'complete' | 'stopped'(중지) | 'error'(오류) | 'processing'(이 창 또는 다른 창에서 처리 중)
* | 'interrupted'(창을 닫는 등으로 끊김: 처리 중 표시가 오래 갱신되지 않음)
*/
const endedHere = new Set(); // 이 창에서 시작했다가 끝난(실패한) 책: 기록이 '처리 중'으로 남아도 끊긴 것으로 본다
const busyBooks = new Set(); // 이 창에서 다시 분리하거나 저장 공간을 정리 중인 책 (그동안 삭제·영역 편집·다시 분리를 막는다)
const storageBusy = new Set(); // 그중 저장 공간 최적화로 잠근 책 (표시 문구용)
function ingestState(b) {
if (b && (busyBooks.has(b.id) || llmBookId === b.id)) return 'busy'; // 이 창에서 다시 분리·AI 판정·저장 공간 정리 중
const st = b?.ingest?.status;
if (st === 'processing') {
if (ingestControl?.bookId === b.id) return 'processing';
if (endedHere.has(b.id)) return 'interrupted';
return Date.now() - (b.ingest.updatedAt || 0) < HEARTBEAT_STALE_MS ? 'processing' : 'interrupted';
}
return st || 'complete';
}
const KIND_LABEL = { problem: '문제집', solution: '해설지' };
/** 받침 있으면 첫째, 없으면 둘째 조사 (문제집은 / 해설지는) */
const josa = (word, withFinal, withoutFinal) => {
const c = String(word).charCodeAt(String(word).length - 1) - 0xac00;
return c >= 0 && c <= 11171 && c % 28 !== 0 ? withFinal : withoutFinal;
};
/** 페이지는 저장됐지만 아직 문제·해설로 나누지 않은 종류 (나눴는데 번호를 못 찾은 경우는 제외) */
const pendingKinds = (b, counts) => {
// 이 기록이 생기기 전에 끝까지 처리된 책은 모든 종류를 나눈 것으로 본다
const legacyDone = !b?.segmented && ['complete', 'stopped'].includes(b?.ingest?.status || 'complete');
return ['problem', 'solution'].filter((k) => (b?.pageCounts?.[k] || 0) > 0 && !legacyDone && !b?.segmented?.[k] && !(counts?.[k] > 0));
};
function ingestNotice(b, counts) {
const st = ingestState(b), at = b?.ingest?.stoppedAt;
const pages = at ? `${at.processedPages}${at.totalPages ? '/' + at.totalPages : ''}쪽` : '';
const pending = pendingKinds(b, counts);
const names = pending.map((k) => KIND_LABEL[k]).join('·');
const todo = pending.length
? ` ${names}${josa(names, '은', '는')} 페이지만 저장되고 아직 나뉘지 않았습니다. 위에서 종류를 고른 뒤 "자동 인식 다시 분석"를 누르세요.`
: '';
if (st === 'busy') return '이 책은 지금 다시 분리·AI 판정·저장 공간 정리 중입니다. 끝날 때까지 기다려 주세요.';
if (st === 'processing') return '이 책은 지금 처리 중입니다 (다른 창일 수 있습니다). 처리가 끝난 뒤 새로고침하세요.';
if (st === 'stopped' && at) {
return `부분 처리된 책입니다: ${KIND_LABEL[at.kind] || '문제집'} ${pages}까지 저장했습니다. 목록의 "보기"를 눌러 문제를 하나씩 확인하세요. 마지막 페이지의 항목은 다음 쪽에서 이어질 수 있습니다.${todo}`;
}
if (st === 'error' || st === 'interrupted') {
const pc = b.pageCounts || {};
return `${st === 'error' ? '처리 중 오류로' : '처리 도중'} 멈춘 책입니다 (문제집 ${pc.problem || 0}쪽, 해설지 ${pc.solution || 0}쪽 저장됨).`
+ (todo || ' 분리된 문제가 모자라면 "자동 인식 다시 분석"를 누르세요.')
+ (st === 'error' && b.ingest.error ? ` (오류: ${b.ingest.error})` : '');
}
return todo.trim();
}
const rv = { book: null, kind: 'problem', page: 1, items: [], rec: null, img: null, imageData: null, sel: null, drag: null, cache: new PageCache() };
async function loadReview() {
const id = $('#rv-book').value;
// 저장소의 최신 기록을 쓴다 (다른 창에서 처리했거나 상태가 바뀌었을 수 있음)
const fresh = id ? await db.get('books', id) : null;
if (fresh) { const i = books.findIndex((b) => b.id === id); if (i >= 0) books[i] = fresh; }
rv.book = fresh || bookById(id);
if (!rv.book) { $('#rv-status').textContent = ''; $('#rv-side').textContent = '먼저 책을 추가하세요.'; return; }
rv.kind = $('#rv-kind').value;
$('#rv-status').textContent = ingestNotice(rv.book, await db.kindCounts(id));
rv.items = (await db.byBook('items', id)).filter((i) => i.kind === rv.kind);
rv.items.sort(byItemOrder);
const inferred = rv.items.filter((i) => i.detection?.inferred).length;
const pages = (await db.byBook('pages', id)).filter((p) => p.kind === rv.kind);
const noTextAnchor = pages.filter((p) => !(p.diagnostics?.lexicalCandidates > 0)).length;
const quality = rv.items.length ? ` 자동 분리 ${rv.items.length}개${inferred ? ` · 번호를 시각적으로 추정 ${inferred}개` : ''}` : ' 자동 분리된 항목이 없습니다.';
const pageHint = noTextAnchor ? ` · 번호 OCR이 약한 페이지 ${noTextAnchor}/${pages.length}쪽은 여백·레이아웃으로 보완했습니다.` : '';
$('#rv-status').textContent = [$('#rv-status').textContent, quality + pageHint].filter(Boolean).join(' ');
const n = rv.book.pageCounts?.[rv.kind] || 0;
$('#rv-pages').textContent = n;
rv.page = n ? Math.min(Math.max(1, rv.page), n) : 0;
rv.sel = null;
await showPage();
renderReviewList();
}
async function showPage() {
const n = rv.book?.pageCounts?.[rv.kind] || 0;
$('#rv-page').value = rv.page || '';
$('#rv-page').disabled = !n;
$('#rv-prev').disabled = !n || rv.page <= 1;
$('#rv-next').disabled = !n || rv.page >= n;
rv.rec = rv.page ? await db.get('pages', pageId(rv.book.id, rv.kind, rv.page)) : null;
const cv = $('#rv-canvas');
if (!rv.rec) {
rv.img = null; rv.imageData = null; rv.sel = null;
cv.width = cv.height = 1;
const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1, 1);
$('#rv-side').textContent = n ? '페이지를 불러오지 못했습니다.' : '저장된 페이지가 없습니다.';
return;
}
if (rv.rec.image == null) {
// 백업에서 이미지가 빠진 쪽: 문제 카드와 번호·난이도는 그대로 쓰고 고칠 수 있지만, 원본 위에서 영역을 고칠 수는 없다
rv.img = null; rv.imageData = null;
if (rv.sel && !rv.items.some((x) => x.id === rv.sel.id && x.fragments.some((f) => f.page === rv.page))) rv.sel = null;
cv.width = cv.height = 1;
renderSide(); // 안내 문구 (+ 목록·분류 화면에서 고른 항목의 번호 편집)
return;
}
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
if (!rv.img) return; // 이미지가 없는 쪽
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
const label = (it.label || rv.items.some((x) => x.section > 1) ? itemKey(it) : String(it.number)) + (f.cont ? ' (이어짐)' : '');
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
/** 다시 분리하거나 아직 처리(분리) 중인 책은 영역을 고치지 못하게 한다 (고친 영역이 교체로 사라지지 않도록) */
const segmentingNow = () => !!rv.book && (busyBooks.has(rv.book.id) || ingestControl?.bookId === rv.book.id);
function editLocked() {
if (!segmentingNow()) return false;
alert('이 책은 지금 분리 중이라 영역을 고칠 수 없습니다. 끝난 뒤 다시 시도하세요.');
return true;
}
$('#rv-canvas').addEventListener('mousedown', (ev) => {
if (!rv.rec || !rv.img || segmentingNow()) return;
$('#rv-canvas').focus();
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
// 선택해 둔 항목이 있으면 그 번호를 미리 채운다: 확인만 누르면 그 항목(예제·유제 포함)에 이어붙는다
const selected = rv.sel && rv.items.find((x) => x.id === rv.sel.id);
const input = prompt('이 영역의 번호를 입력하세요.\n이미 있는 번호면 그 항목에 이어붙입니다. (단원이 여러 개면 "2-15", 예제·유제는 "유제 1-2" 형식)', selected ? itemKey(selected) : '');
if (!input) return;
const m = input.trim().match(/^(예제|유제|연습\s*문제)?\s*(?:(\d+)\s*-\s*)?(\d+)$/);
if (!m) return alert('번호 형식이 올바르지 않습니다. (예: 15, 2-15, 유제 1-2)');
const label = m[1] ? m[1].replace(/\s+/g, '') : '';
const section = m[2] ? +m[2] : 1, number = +m[3];
if (section < 1 || number < 1) return alert('단원과 번호는 1 이상이어야 합니다.');
const t = trimBox(rv.imageData, box) || box;
const frag = { page: rv.page, ...t };
let it = rv.items.find((x) => (x.label || '') === label && x.section === section && x.number === number);
if (it) {
const fragments = [...it.fragments, frag].sort((a, b) => (a.page - b.page) || (a.x0 - b.x0) || (a.y0 - b.y0));
if (!await canRecrop(it, fragments)) return; // 원본 이미지가 없는 쪽에 걸친 항목은 다시 자를 수 없다
it.fragments = fragments;
} else {
it = { id: db.uid(rv.kind[0]), bookId: rv.book.id, kind: rv.kind, section, number, ...(label ? { label } : {}), fragments: [frag], manual: true };
rv.items.push(it);
}
if (!await saveItem(it, true)) { await reloadReviewItems(); drawOverlay(); renderSide(); return; }
const saved = rv.items.find((x) => x.id === it.id);
const fi = saved ? saved.fragments.findIndex((f) => f.page === frag.page && f.x0 === frag.x0 && f.y0 === frag.y0) : -1;
rv.sel = fi >= 0 ? { id: it.id, fi } : null;
drawOverlay(); renderSide();
});
window.addEventListener('keydown', async (ev) => {
// Mac 키보드에는 Delete 키가 없어 Backspace도 받는다
if ((ev.key !== 'Delete' && ev.key !== 'Backspace') || !rv.sel || !$('#tab-review').classList.contains('active')) return;
// 캔버스에서 상자를 고른 직후에만 지운다 (버튼·입력칸에 커서가 있을 때 실수로 지우지 않도록)
const ae = document.activeElement;
if (ae && ae !== document.body && ae !== $('#rv-canvas')) return;
ev.preventDefault();
await deleteFragment();
});
const CROP_FIELDS = ['section', 'number', 'detection', 'fragments', 'image', 'imageId', 'imageFormat', 'imageBytes', 'w', 'h', 'text', 'pageHeight', 'scale', 'manual'];
/** 저장소의 기록으로 검토 목록을 다시 읽는다 (저장하지 못한 화면 속 수정은 버려진다) */
async function reloadReviewItems() {
rv.items = (await db.byBook('items', rv.book.id)).filter((i) => i.kind === rv.kind);
rv.items.sort(byItemOrder);
renderReviewList();
}
/**
* 고친 항목을 저장한다. recrop=false면 번호·라벨만 바꾼다 (자르기 이미지는 번호와 무관하므로 그대로 둔다 — 원본 이미지가 없는 쪽의 문제도 번호를 고칠 수 있도록).
* 반환: 저장했으면 true
*/
async function saveItem(it, relinkAfter, { recrop = true } = {}) {
if (editLocked()) return false;
buildFiltersStale = true; // 글자·연결이 바뀌면 자동 유형도 바뀔 수 있다
if (!recrop) {
const saved = await db.update('items', it.id, (fresh) => {
fresh.section = it.section; fresh.number = it.number; fresh.detection = it.detection;
if (it.label) fresh.label = it.label; else delete fresh.label;
});
if (saved && relinkAfter) await relink(rv.book.id);
await reloadReviewItems();
return !!saved;
}
try { await finalizeItem(it, rv.cache, null, rv.book.options?.scale || DEFAULT_OPTIONS.scale); }
catch (e) {
await reloadReviewItems(); // 화면에서 바꾼 영역을 저장된 상태로 되돌린다
if (e?.name === 'PageImageMissingError') { alert(e.message); return false; }
throw e;
}
// 영역·이미지만 고쳐 쓴다 (그사이 AI 판정·유형 지정으로 바뀐 값을 덮어쓰지 않도록)
const fields = [...CROP_FIELDS, it.kind === 'problem' ? 'points' : 'answer'];
let superseded = null;
try {
const saved = await db.update('items', it.id, (fresh) => {
superseded = fresh.image;
// AI가 옮겨 적은 글은 옛 영역의 것이다: 영역이 바뀌면 '다시 판정 필요'로 표시한다 (난이도·유형은 그대로 둔다)
if (fresh.aiExtract && !fresh.aiExtract.stale && !sameRegions(fresh.fragments, it.fragments)) fresh.aiExtract = { ...fresh.aiExtract, stale: true };
for (const k of fields) if (k in it) fresh[k] = it[k];
});
if (!saved) await db.put('items', it); // 새로 그린 항목
} catch (e) {
await M.assets.removeRef(it.image).catch(() => {}); // 저장하지 못한 새 자르기 파일은 남기지 않는다
throw e;
}
// 새 자르기가 저장된 뒤에만, 이 기록이 가리키던 옛 외부 파일을 지운다
if (M.assets.isRef(superseded) && superseded.file !== it.image?.file) await M.assets.removeRef(superseded).catch(() => {});
if (relinkAfter) await relink(rv.book.id);
await reloadReviewItems();
return true;
}
/** 조각을 바꾸기 전에: 바뀐 조각들이 원본 이미지가 없는 쪽에 걸치면 알리고 false */
async function canRecrop(it, fragments) {
if (it.image == null) return true; // 원래 이미지가 없던 항목은 읽을 수 있는 쪽으로라도 다시 자른다
const missing = await pagesWithoutImage(it.bookId, it.kind, fragments);
if (!missing.length) return true;
alert(new PageImageMissingError(missing).message);
return false;
}
async function deleteFragment() {
const it = rv.items.find((x) => x.id === rv.sel?.id);
if (!it || editLocked()) return;
// 마지막 영역이면 항목(난이도·유형 판정 포함)이 통째로 지워지므로 한 번 묻는다
if (it.fragments.length === 1 && !confirm(`${itemKey(it)}번의 마지막 영역입니다. 지우면 이 ${it.kind === 'problem' ? '문제' : '해설'}가 통째로 삭제됩니다. 삭제할까요?`)) return;
const rest = it.fragments.filter((_, i) => i !== rv.sel.fi);
// 남는 영역이 원본 이미지가 없는 쪽에 걸치면 다시 자를 수 없다 (그 쪽 부분이 사라지므로 막는다)
if (rest.length && !await canRecrop(it, rest)) return;
it.fragments = rest;
rv.sel = null;
if (!it.fragments.length) await deleteItem(it);
else await saveItem(it, false);
drawOverlay(); renderSide();
}
async function deleteItem(it) {
if (editLocked()) return;
buildFiltersStale = true;
const removed = await db.take('items', it.id); // 지운 기록의 현재 이미지(외부 파일)를 정리한다
if (M.assets.isRef(removed?.image)) await M.assets.removeRef(removed.image).catch(() => {});
rv.items = rv.items.filter((x) => x.id !== it.id);
rv.sel = null;
await relink(rv.book.id);
renderReviewList();
}
// 백업에서 이미지가 빠진 쪽 안내 (문제 카드와 번호·난이도·유형은 그대로 쓰고 고칠 수 있다)
const IMAGELESS_NOTICE = '이 쪽은 백업할 때 이미지를 읽지 못해 원본을 보여 줄 수 없습니다. 문제 카드는 그대로 쓸 수 있고 번호·난이도·유형도 고칠 수 있지만, 이 쪽에 걸친 영역은 고칠 수 없습니다. 온전한 백업을 가져오면 다시 볼 수 있습니다.';
const LABELS = ['예제', '유제', '연습문제'];
async function renderSide() {
const side = $('#rv-side');
const notice = rv.rec && rv.rec.image == null ? el('p', { class: 'badge warn' }, IMAGELESS_NOTICE) : null;
const it = rv.sel && rv.items.find((x) => x.id === rv.sel.id);
if (!it) {
side.replaceChildren(...[notice, el('p', {}, `이 쪽의 영역: ${fragsOnPage().length}개`), el('p', { class: 'hint' }, '상자를 클릭하면 상세 정보가 여기에 표시됩니다.')].filter(Boolean));
return;
}
const sec = el('input', { type: 'number', value: it.section, min: 1 });
const num = el('input', { type: 'number', value: it.number, min: 1 });
// 번호 체계: 본문 번호와 예제·유제·연습문제는 따로 센다 (잘못 들어간 체계를 옮길 수 있도록)
const lab = el('select', { 'aria-label': '번호 체계' }, opt('', '본문 번호', !it.label), ...LABELS.map((l) => opt(l, l, it.label === l)));
const kids = [
notice,
el('h3', {}, `${rv.kind === 'problem' ? '문제' : '해설'} ${itemKey(it)}`),
el('div', { class: 'row' }, lab, ' 단원 ', sec, ' 번호 ', num,
el('button', { onclick: async () => {
const s = Number(sec.value), n = Number(num.value), L = lab.value;
if (!Number.isInteger(s) || s < 1 || !Number.isInteger(n) || n < 1) return alert('단원과 번호는 1 이상의 정수로 입력하세요.');
const key = itemKey({ label: L, section: s, number: n });
if (rv.items.some((x) => x !== it && (x.label || '') === L && x.section === s && x.number === n)
&& !confirm(`${key}번 항목이 이미 있습니다. 그래도 같은 번호로 저장할까요?\n(영역을 합치려면 빈 곳을 드래그한 뒤 그 번호를 입력하세요.)`)) return;
// 사용자가 확인한 번호: '번호 추정' 표시를 없애고, 다시 분석해도 같은 자리의 문제에 이 번호를 유지한다
if (it.section !== s || it.number !== n || (it.label || '') !== L || it.detection?.inferred) {
const { ocrNumber, ...rest } = it.detection || {};
it.detection = { ...rest, inferred: false, numberManual: true };
}
it.section = s; it.number = n;
if (L) it.label = L; else delete it.label;
// 번호만 바뀌므로 다시 자르지 않는다 (자르기 이미지는 그대로)
await saveItem(it, true, { recrop: false }); drawOverlay(); renderSide();
} }, '번호 저장')),
it.image ? el('img', { src: it.image }) : null,
el('div', { class: 'row' },
el('button', { onclick: deleteFragment }, '이 영역 삭제'),
el('button', { onclick: async () => { if (confirm('항목 전체를 삭제할까요?')) { await deleteItem(it); drawOverlay(); renderSide(); } } }, '항목 삭제')),
];
if (rv.kind === 'problem') {
const sol = it.solutionId ? await db.get('items', it.solutionId) : null;
kids.push(el('p', {}, '난이도: ', gradeBadge(it)), gradeEditor(it, () => renderSide()));
// 정답: 해설에서 읽은 값을 보여 주고, 직접 입력할 수도 있다 (해설이 없거나 추정 연결인 문제의 빠른 정답용)
const ans = el('input', { type: 'text', value: it.answer ?? '', placeholder: '예: ③, 12', 'aria-label': '정답 직접 입력', style: 'width:7em' });
kids.push(el('div', { class: 'row' }, '정답: ', ans, el('button', { onclick: async () => {
const v = ans.value.trim().slice(0, 40);
await db.update('items', it.id, (f) => {
if (v) { f.answer = v; f.answerManual = true; f.answerLLM = false; }
else { f.answer = null; f.answerManual = false; f.answerLLM = false; } // 비우면 해설에서 다시 읽는다
});
if (!v) await relink(rv.book.id);
await reloadReviewItems(); renderSide();
} }, '정답 저장'), it.answerManual ? el('span', { class: 'hint' }, '직접 입력') : null));
kids.push(...aiBadges(it), aiExtractView(it));
kids.push(el('h4', {}, '연결된 해설', it.solutionInferred && sol ? el('span', { class: 'badge warn' }, ' 추정 연결 · 확인 필요') : null),
sol?.image ? el('img', { src: sol.image }) : el('p', { class: 'badge warn' }, '연결된 해설 없음'));
}
if (it.text) kids.push(el('details', {}, el('summary', {}, '인식된 텍스트'), el('pre', { style: 'white-space:pre-wrap;font-size:12px' }, it.text)));
side.replaceChildren(...kids.filter(Boolean)); // 빈 칸(null)이 "null" 글자로 들어가지 않도록
}
function gradeBadge(p) {
const g = effectiveGrade(p);
return el('span', { class: 'badge' + (g == null ? ' warn' : '') }, g == null ? '미판정' : `${g}등급 (${gradeSource(p)})`);
}
function gradeEditor(p, after) {
const s = el('select', { 'aria-label': '난이도 직접 지정' }, opt('', '수동 지정 안 함'), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((g) => opt(g, `${g}등급`, p.gradeManual === g)));
s.addEventListener('change', async () => {
p.gradeManual = s.value ? +s.value : null;
await db.update('items', p.id, (fresh) => { fresh.gradeManual = p.gradeManual; });
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
it.detection?.inferred ? el('span', {
class: 'badge warn',
title: it.detection.ocrNumber != null
? `OCR은 ${it.detection.ocrNumber}번으로 읽었지만 앞뒤 문제 배치와 맞지 않아, 순서대로 번호를 추정했습니다. 틀렸으면 원본에서 번호를 고치세요.`
: '문제 번호를 OCR로 읽지 못해 페이지 여백과 배치로 경계를 찾고 번호를 추정했습니다.',
}, it.detection.ocrNumber != null ? `번호 추정 (OCR ${it.detection.ocrNumber})` : '번호 추정') : null,
rv.kind === 'problem' && !it.solutionId ? el('span', { class: 'badge warn' }, '해설 없음') : null,
rv.kind === 'problem' && it.solutionId && it.solutionInferred ? el('span', { class: 'badge warn', title: '번호를 추정한 문제·해설끼리 이었습니다. 맞는 해설인지 확인하세요. (이 연결의 정답은 자동으로 옮기지 않습니다)' }, '해설 추정 연결') : null,
...aiBadges(it),
el('button', { onclick: async () => {
$('#rv-editor').open = true;
rv.page = it.fragments[0].page; rv.sel = { id: it.id, fi: 0 }; await showPage(); $('#rv-canvas').scrollIntoView({ behavior: 'smooth' });
} }, '원본에서 보기·수정')),
it.image ? el('img', { src: it.image, loading: 'lazy' }) : null,
aiExtractView(it))));
}
/** AI가 잘리거나 흐려 읽지 못한 곳을 [미상]으로 적었는지 (지문·문제·선지) */
const hasUnreadable = (p) => [p?.passage, p?.question, ...(p?.choices || [])].some((s) => String(s ?? '').includes('[미상]'));
/** AI 판정이 알려 주는 자르기·번호 확인 표시 (한 영역에 문제 여러 개, 안 보이는 부분, 번호 다름, 영역을 고친 뒤 다시 판정 필요) */
function aiBadges(it) {
const ex = it.kind === 'problem' ? it.aiExtract : null;
if (!ex?.problems?.length) return [];
const main = ex.problems[ex.primary] || ex.problems[0];
const n = numberOf(main.problem_number);
return [
ex.problems.length > 1 ? el('span', { class: 'badge warn', title: 'AI가 이 영역에서 문제를 여러 개 읽었습니다. 두 문제가 한 영역으로 합쳐졌을 수 있으니 원본에서 확인하세요.' }, `AI: 문제 ${ex.problems.length}개`) : null,
hasUnreadable(main) ? el('span', { class: 'badge warn', title: 'AI가 잘리거나 흐려서 읽지 못한 부분을 [미상]으로 적었습니다. 영역이 잘리지 않았는지 원본에서 확인하세요.' }, 'AI: 안 보이는 부분 있음') : null,
n != null && n !== it.number ? el('span', { class: 'badge warn', title: 'AI가 이미지에서 읽은 번호가 이 항목의 번호와 다릅니다. 번호를 확인하세요.' }, `AI가 읽은 번호 ${main.problem_number}`) : null,
ex.stale ? el('span', { class: 'badge warn', title: '영역을 고친 뒤라 AI가 옮겨 적은 글이 지금 영역과 다를 수 있습니다. ④ 난이도 탭에서 "아직 안 한 문제만"으로 다시 판정하세요.' }, 'AI 다시 판정 필요') : null,
];
}
// 수식 미리보기 (KaTeX). 처음 필요할 때만 불러오고, 못 불러오면(인터넷 없음 등) LaTeX 글자를 그대로 둔다
const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';
let katexLoading = null;
function loadKatex() {
if (window.renderMathInElement) return Promise.resolve();
if (!katexLoading) {
const script = (src) => new Promise((resolve, reject) => {
const s = document.createElement('script');
s.src = src; s.onload = resolve;
s.onerror = () => { s.remove(); reject(new Error('KaTeX 로드 실패')); };
document.head.append(s);
});
// 스타일시트도 다 받은 뒤에 그린다 (스타일 없이 그리면 수식이 두 번 겹쳐 보인다). 실패한 <link>는 지워 다음에 다시 받게 한다
const style = () => {
const old = document.querySelector('link[data-katex]');
if (old?.sheet) return Promise.resolve();
old?.remove();
return new Promise((resolve, reject) => {
const l = el('link', { rel: 'stylesheet', href: KATEX_BASE + 'katex.min.css', 'data-katex': '' });
l.onload = resolve;
l.onerror = () => { l.remove(); reject(new Error('KaTeX 스타일 로드 실패')); };
document.head.append(l);
});
};
const p = (async () => {
await style();
if (!window.katex) await script(KATEX_BASE + 'katex.min.js');
await script(KATEX_BASE + 'contrib/auto-render.min.js');
})();
katexLoading = p;
p.catch(() => { if (katexLoading === p) katexLoading = null; }); // 실패한 로드는 기억하지 않고 다음에 펼칠 때 다시 시도
}
return katexLoading;
}
/** 수식을 그린다. 반환: 그렸으면 true (불러오지 못하면 LaTeX 글자 그대로 두고 false) */
function renderMath(node) {
return loadKatex().then(() => {
for (const m of node.querySelectorAll('.math')) {
window.renderMathInElement(m, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }], throwOnError: false, strict: false });
}
return true;
}).catch(() => false);
}
async function copyText(text, btn) {
const label = btn.textContent;
try { await navigator.clipboard.writeText(text); btn.textContent = '복사했습니다'; }
catch { btn.textContent = '복사하지 못했습니다. 위 글을 직접 선택해 복사하세요'; }
setTimeout(() => { btn.textContent = label; }, 2500);
}
/** AI가 옮겨 적은 문제(지문·문제·선지, LaTeX)를 보여 주는 접힌 칸. 펼칠 때 만들고 수식을 그린다 */
function aiExtractView(it) {
const ex = it.kind === 'problem' ? it.aiExtract : null;
if (!ex?.problems?.length) return null;
const main = ex.problems[ex.primary] || ex.problems[0];
const body = el('div', { class: 'ai-extract' });
const box = el('details', { class: 'ai-box' },
el('summary', {}, 'AI가 옮겨 적은 문제 (LaTeX)', main.difficulty_level != null ? ` · 난이도 ${main.difficulty_level}단계 → ${levelToGrade(main.difficulty_level)}등급` : ''), body);
let drawn = false, rendered = false, rendering = false;
// 수식은 펼칠 때마다 아직 못 그렸으면 다시 그려 본다 (처음 펼쳤을 때 인터넷이 끊겼던 경우)
const draw = () => {
if (rendered || rendering) return;
rendering = true;
renderMath(body).then((ok) => { rendered = ok; rendering = false; });
};
box.addEventListener('toggle', () => {
if (!box.open) return;
if (drawn) { draw(); return; }
drawn = true;
const many = ex.problems.length > 1;
ex.problems.forEach((p, i) => body.append(el('div', { class: 'ai-problem' + (many && i === ex.primary ? ' primary' : '') },
el('div', { class: 'hint' }, [p.problem_number ? `번호 ${p.problem_number}` : '번호 없음', p.topic, p.has_figure_or_diagram ? '그림·도표 있음' : null,
p.difficulty_level != null ? `난이도 ${p.difficulty_level}단계` : '난이도 없음', many && i === ex.primary ? '이 항목' : null].filter(Boolean).join(' · ')),
p.passage ? el('div', { class: 'ai-passage math' }, p.passage) : null,
el('div', { class: 'ai-question math' }, p.question || '(문제 글 없음)'),
p.choices.length ? el('ul', { class: 'ai-choices math' }, ...p.choices.map((c) => el('li', {}, c))) : null,
p.difficulty_reasoning ? el('div', { class: 'hint' }, `난이도 근거: ${p.difficulty_reasoning}`) : null)));
const json = JSON.stringify(toSchemaJson(ex.problems), null, 2);
body.append(...[ // (DOM append는 null을 "null" 글자로 넣으므로 빈 칸은 뺀다)
el('details', {}, el('summary', {}, 'JSON 보기'), el('pre', { class: 'ai-json' }, json)),
el('div', { class: 'row' }, el('button', { onclick: (ev) => copyText(json, ev.currentTarget) }, 'JSON 복사'),
el('span', { class: 'hint' }, [PROVIDERS[ex.provider]?.label.replace(/\s*\(.*\)$/, '') || ex.provider, ex.model, String(ex.at || '').slice(0, 10)].filter(Boolean).join(' · '))),
ex.stale ? el('p', { class: 'badge warn' }, '영역을 고친 뒤라 지금 영역과 다를 수 있습니다. 다시 판정하세요.') : null,
].filter(Boolean));
draw();
});
return box;
}
$('#rv-book').addEventListener('change', () => { rv.page = 1; loadReview(); });
$('#rv-kind').addEventListener('change', () => { rv.page = 1; loadReview(); });
$('#rv-prev').addEventListener('click', () => { if (rv.page > 1) { rv.page--; rv.sel = null; showPage(); } });
$('#rv-next').addEventListener('click', () => { if (rv.page < (rv.book?.pageCounts?.[rv.kind] || 1)) { rv.page++; rv.sel = null; showPage(); } });
$('#rv-page').addEventListener('change', () => {
const n = rv.book?.pageCounts?.[rv.kind] || 0;
if (!n) return;
const v = Math.round(Number($('#rv-page').value));
rv.page = Number.isFinite(v) ? Math.max(1, Math.min(v, n)) : rv.page;
rv.sel = null; showPage();
});
$('#rv-reseg').addEventListener('click', async () => {
// 시작할 때의 책·종류로 끝까지 처리한다 (도중에 다른 책을 골라도 섞이지 않도록 선택 상자도 잠근다)
if (!rv.book) return;
const kind = rv.kind;
if (await isBusyElsewhere(rv.book.id)) return alert('이 책은 지금 처리 중(분리·AI 판정)입니다. 끝난 뒤 다시 분리하세요.');
// 다른 창에서 바뀌었을 수 있으니 저장소의 최신 기록으로 작업한다
const book = (await db.get('books', rv.book.id)) || rv.book;
if (!confirm('이 종류의 문제 영역을 처음부터 다시 나눕니다. 직접 그린 영역은 사라지지만, 페이지의 같은 자리에 있는 문제에 매긴 난이도·유형(직접 지정·AI)과 직접 고친 번호·정답은 유지됩니다. 다시 분리할까요?\n분리 설정은 책 추가 탭의 "고급 설정" 값을 사용합니다.')) return;
const locks = ['#rv-reseg', '#rv-relink', '#rv-book', '#rv-kind'];
for (const s of locks) $(s).disabled = true;
busyBooks.add(book.id);
renderLibrary(); // 라이브러리의 삭제 버튼도 잠근다
try {
const o = readSegmentOptions();
book.options = { ...book.options, top: o.top, bottom: o.bottom, leftTol: o.leftTol, maxSkip: o.maxSkip };
await db.update('books', book.id, (f) => { f.options = book.options; });
$('#rv-side').textContent = '다시 분리하는 중...';
buildFiltersStale = true;
await segmentKind(book, kind, null, (m) => { $('#rv-side').textContent = m; });
await relink(book.id);
await runHeuristic(book.id);
// 오류·중단으로 멈췄던 책은 저장된 모든 종류가 나뉘었을 때 "부분 처리" 책으로 바꾼다
busyBooks.delete(book.id);
if (['error', 'interrupted'].includes(ingestState(book)) && !pendingKinds(book, await db.kindCounts(book.id)).length) {
const last = book.pageCounts?.solution ? 'solution' : 'problem';
book.ingest = { status: 'stopped', stoppedAt: { kind: last, processedPages: book.pageCounts?.[last] || 0, totalPages: null } };
await db.update('books', book.id, (f) => { f.ingest = book.ingest; }); // 그사이 지워진 책을 되살리지 않는다
}
} catch (e) {
console.error(e);
alert('다시 분리하지 못했습니다. 기존 분리 결과는 그대로 남아 있습니다.\n' + friendlyError(e));
} finally {
busyBooks.delete(book.id);
for (const s of locks) $(s).disabled = false;
await reloadBooks(); // 이 창의 책 목록도 최신 기록으로
await loadReview();
renderLibrary();
}
});
/** 이 창(분리·AI 판정)이나 다른 창에서 처리 중인지, 저장소의 최신 기록으로 확인한다 */
async function isBusyElsewhere(bookId) {
if (busyBooks.has(bookId) || ingestControl?.bookId === bookId || llmBookId === bookId) return true;
const fresh = await db.get('books', bookId);
return !!fresh && ['processing', 'busy'].includes(ingestState(fresh));
}
$('#rv-relink').addEventListener('click', async () => {
if (!rv.book) return;
buildFiltersStale = true;
try {
const s = await relink(rv.book.id);
alert(`문제 ${s.problems}개 중 ${s.matched}개에 해설이 연결되었습니다.`);
} catch (e) {
alert('해설을 다시 연결하지 못했습니다.\n' + friendlyError(e));
}
loadReview();
});
/** 책마다 글자 기반 자동 분류를 계산한다 (직접 지정·AI 유형과 무관하므로 항목을 다시 읽기 전까지 재사용 가능) */
function autoClassify(items) {
const sols = new Map(), byBook = new Map();
for (const it of items) {
if (it.kind === 'solution') sols.set(it.id, it);
else if (it.kind === 'problem') {
if (!byBook.has(it.bookId)) byBook.set(it.bookId, []);
byBook.get(it.bookId).push(it);
}
}
const out = new Map();
for (const [bookId, probs] of byBook) for (const [id, r] of classifyBook(probs, sols, bookById(bookId)?.subject || '')) out.set(id, r);
return out;
}
const typeOf = (p, auto) => effectiveType(p, auto.get(p.id), bookById(p.bookId)?.subject || '');
/** 직접 지정 > AI > 자동 순서로 최종 유형을 정한다. 반환: Map(id → {type, source, reasons}) */
function classifyItems(items) {
const auto = autoClassify(items);
const out = new Map();
for (const p of items) if (p.kind === 'problem') out.set(p.id, typeOf(p, auto));
return out;
}
function typeSummary(items) {
const counts = new Map();
for (const { type } of classifyItems(items).values()) counts.set(type, (counts.get(type) || 0) + 1);
return [...counts].sort((a, b) => ((a[0] === UNCLASSIFIED) - (b[0] === UNCLASSIFIED)) || (b[1] - a[1]) || compareTypes(a[0], b[0]))
.map(([t, n]) => `${t} ${n}`).join(' · ');
}
const cl = { bookId: '', type: '' };
const clOpen = new Map(); // 사용자가 펼치거나 접은 묶음 상태
const CARD_PAGE = 60; // 펼친 묶음에서 한 번에 만드는 카드 수
// 탭이 열려 있는 동안만 항목과 자동 분류 결과를 메모리에 둔다
let clToken = 0, clItems = null, clLoading = null, clAuto = null;
function loadClassifyItems() {
const p = db.all('items').then((items) => { if (clLoading === p) { clItems = items; clAuto = null; clLoading = null; } return items; });
clLoading = p;
return p;
}
function releaseClassifyItems() {
clToken++; // 진행 중인 렌더 취소
clItems = null; clLoading = null; clAuto = null;
// 카드와 이벤트 처리기가 문제 이미지를 붙잡고 있지 않도록 화면도 비운다
for (const s of ['#cl-books', '#cl-types', '#cl-groups']) $(s).replaceChildren();
}
function facetButton(label, count, active, onclick) {
return el('button', { class: active ? 'active' : '', onclick }, el('span', {}, label), el('span', { class: 'count' }, count));
}
function typeBadge(e) {
return el('span', { class: 'badge' + (e.type === UNCLASSIFIED ? ' warn' : '') }, e.source ? `${e.type} (${e.source})` : e.type);
}
function typeReason(e, p) {
const bits = [];
if (e.source === '자동' && e.reasons.length) bits.push(`근거: ${e.reasons.join(' · ')}`);
if (e.source === '자동·앞뒤 문제') bits.push('근거: 앞뒤 문제와 같은 유형');
if (p.unit) bits.push(`AI 단원: ${p.unit}`);
return bits.length ? el('div', { class: 'hint' }, bits.join(' / ')) : null;
}
/** 유형 선택 상자 원본. 카드마다 복제해서 쓴다 (옵션을 매번 만드는 것보다 훨씬 빠름) */
function typeSelectTemplate(customTypes) {
return el('select', { 'aria-label': '유형 직접 지정' },
opt('', '유형 직접 지정…'),
...AREAS.map((area) => el('optgroup', { label: area }, ...TYPES.filter((t) => t.area === area).map((t) => opt(t.label, t.label)))),
customTypes.length ? el('optgroup', { label: '직접 만든 유형' }, ...customTypes.map((t) => opt(t, t))) : null,
el('optgroup', { label: '기타' }, opt(UNCLASSIFIED, UNCLASSIFIED), opt('__new__', '새 유형 이름 입력…')));
}
function typeEditor(p, template) {
const s = template.cloneNode(true);
if (p.typeManual) { s.value = p.typeManual; s.options[0].textContent = '자동 분류로 되돌리기'; }
s.addEventListener('change', async () => {
let value = s.value;
if (value === '__new__') {
value = (prompt('새 유형 이름을 입력하세요. (예: 나머지정리 활용)') || '').trim().slice(0, 40);
if (!value) { s.value = p.typeManual || ''; return; }
}
const saved = await db.update('items', p.id, (fresh) => { fresh.typeManual = value || null; });
if (!saved) return;
buildFiltersStale = true;
// 저장이 끝나기 전에 탭을 떠났으면 숨은 탭을 다시 그리지 않는다
if (!$('#tab-classify').classList.contains('active')) return;
// 현재 메모리 목록의 같은 문제를 고친다. 이후에 시작된 읽기는 이미 새 값을 담고 있다.
p.typeManual = saved.typeManual;
const cur = clItems?.find((x) => x.id === p.id);
if (cur) cur.typeManual = saved.typeManual;
await renderClassify(false);
});
return s;
}
async function openInReview(p) {
$('#rv-book').value = p.bookId;
$('#rv-kind').value = 'problem';
rv.page = p.fragments?.[0]?.page || 1;
await activateTab('review');
const it = rv.items.find((x) => x.id === p.id);
if (!it || !rv.rec) return;
rv.sel = { id: it.id, fi: Math.max(0, it.fragments.findIndex((f) => f.page === rv.page)) };
drawOverlay(); renderSide();
$('#rv-canvas').scrollIntoView({ behavior: 'smooth' });
}
/** reload=false: 책·유형 선택만 바뀐 경우 메모리의 항목으로 다시 그린다 */
async function renderClassify(reload = true) {
const token = ++clToken;
if (reload) await loadClassifyItems();
else if (clLoading || !clItems) await (clLoading || loadClassifyItems()); // 읽는 중이면 새 결과를 기다린다
if (token !== clToken || !clItems) return; // 더 최근 렌더가 시작됐거나 탭을 떠났으면 버린다
const items = clItems;
if (!clAuto) clAuto = autoClassify(items);
const auto = clAuto;
const bookOrder = new Map(books.map((b, i) => [b.id, i]));
const entries = items.filter((i) => i.kind === 'problem' && bookById(i.bookId))
.map((p) => ({ p, book: bookById(p.bookId), ...typeOf(p, auto) }))
.sort((a, b) => (bookOrder.get(a.p.bookId) - bookOrder.get(b.p.bookId)) || byItemOrder(a.p, b.p));
if (cl.bookId && !bookById(cl.bookId)) cl.bookId = '';
const inBook = cl.bookId ? entries.filter((e) => e.p.bookId === cl.bookId) : entries;
if (cl.type && !inBook.some((e) => e.type === cl.type)) cl.type = '';
const multiSection = new Set(entries.filter((e) => e.p.section > 1).map((e) => e.p.bookId));
const customTypes = [...new Set(entries.map((e) => e.p.typeManual).filter((t) => t && t !== UNCLASSIFIED && !isStandardType(t)))].sort(compareTypes);
// 책별
const perBook = new Map();
for (const e of entries) perBook.set(e.p.bookId, (perBook.get(e.p.bookId) || 0) + 1);
$('#cl-books').replaceChildren(
facetButton('전체 책', entries.length, !cl.bookId, () => { cl.bookId = ''; renderClassify(false); }),
...books.map((b) => facetButton(b.name, perBook.get(b.id) || 0, cl.bookId === b.id, () => { cl.bookId = b.id; renderClassify(false); })));
// 유형별 (선택한 책 기준 개수)
const counts = new Map();
for (const e of inBook) counts.set(e.type, (counts.get(e.type) || 0) + 1);
const pick = (t) => () => { cl.type = t; renderClassify(false); };
const typeKids = [facetButton('전체 유형', inBook.length, !cl.type, pick(''))];
for (const area of AREAS) {
const list = TYPES.filter((t) => t.area === area && counts.has(t.label));
if (list.length) typeKids.push(el('div', { class: 'facet-area' }, area), ...list.map((t) => facetButton(t.label, counts.get(t.label), cl.type === t.label, pick(t.label))));
}
const customShown = [...counts.keys()].filter((t) => t !== UNCLASSIFIED && !isStandardType(t)).sort(compareTypes);
if (customShown.length) typeKids.push(el('div', { class: 'facet-area' }, '직접 만든 유형'), ...customShown.map((t) => facetButton(t, counts.get(t), cl.type === t, pick(t))));
if (counts.has(UNCLASSIFIED)) typeKids.push(el('div', { class: 'facet-area' }, '확인 필요'), facetButton(UNCLASSIFIED, counts.get(UNCLASSIFIED), cl.type === UNCLASSIFIED, pick(UNCLASSIFIED)));
$('#cl-types').replaceChildren(...typeKids);
// 문제 목록: 유형 하나를 전체 책에서 보면 책별로, 그 밖에는 유형별로 묶는다
const shown = cl.type ? inBook.filter((e) => e.type === cl.type) : inBook;
$('#cl-title').textContent = `${cl.bookId ? bookById(cl.bookId).name : '전체 책'} · ${cl.type || '전체 유형'}`;
$('#cl-count').textContent = `${shown.length}문제`;
if (!shown.length) {
$('#cl-groups').replaceChildren(el('p', { class: 'hint' }, entries.length
? '이 책에는 분리된 문제가 없습니다. ② 검토·수정에서 문제 영역을 추가하세요.'
: '아직 분리된 문제가 없습니다. ① 책 추가에서 PDF를 넣으세요.'));
return;
}
const groupByBook = !!cl.type && !cl.bookId;
const groups = new Map();
for (const e of shown) {
const key = groupByBook ? e.p.bookId : e.type;
if (!groups.has(key)) groups.set(key, []);
groups.get(key).push(e);
}
const keys = [...groups.keys()].sort(groupByBook ? (a, b) => bookOrder.get(a) - bookOrder.get(b) : compareTypes);
const template = typeSelectTemplate(customTypes);
const card = (e) => {
const { p, book } = e;
const num = p.label || multiSection.has(p.bookId) ? itemKey(p) : String(p.number);
return el('div', { class: 'card' },
el('div', { class: 'row' }, el('b', {}, `${book.name} ${num}번`), typeBadge(e), gradeBadge(p)),
p.image ? el('img', { src: p.image, loading: 'lazy' }) : el('span', { class: 'badge warn' }, '이미지 없음'),
typeReason(e, p),
el('div', { class: 'row' }, typeEditor(p, template), el('button', { onclick: () => openInReview(p) }, '검토에서 보기')));
};
// 문제가 많으면 처음에는 접어 두고, 펼칠 때 카드를 만든다. 큰 묶음은 CARD_PAGE개씩 나눠 만든다.
const defaultOpen = shown.length <= 150;
$('#cl-groups').replaceChildren(...keys.map((key) => {
const gk = (groupByBook ? 'b:' : 't:') + key;
const list = groups.get(key);
const body = el('div', { class: 'cards' });
const more = el('button', { class: 'more', hidden: true });
let made = 0;
const addMore = () => {
const next = list.slice(made, made + CARD_PAGE);
made += next.length;
body.append(...next.map(card));
more.hidden = made >= list.length;
more.textContent = `더 보기 (${list.length - made}문제 남음)`;
};
more.addEventListener('click', addMore);
const fill = () => { if (!made) addMore(); };
const open = clOpen.has(gk) ? clOpen.get(gk) : defaultOpen;
if (open) fill();
// 사용자의 클릭만 기억한다 (open 속성으로 생기는 toggle 이벤트는 기록하지 않음)
const details = el('details', { class: 'cl-group', open, ontoggle: () => { if (details.open) fill(); } },
el('summary', { onclick: () => clOpen.set(gk, !details.open) }, groupByBook ? bookById(key).name : key, ' ', el('span', { class: 'hint' }, `${list.length}문제`)),
body, more);
return details;
}));
}
async function runHeuristic(bookId) {
const book = bookById(bookId) || await db.get('books', bookId);
const items = await db.byBook('items', bookId);
const problems = items.filter((i) => i.kind === 'problem');
const sols = new Map(items.filter((i) => i.kind === 'solution').map((s) => [s.id, s]));
const res = new Map(heuristicGrades(problems, sols, book?.level).map((r) => [r.id, r]));
// 규칙 등급만 고쳐 쓴다 (AI 판정이 도는 중이어도 그 결과를 덮어쓰지 않음)
await db.updateMany('items', problems.map((p) => p.id), (fresh) => {
const r = res.get(fresh.id);
if (r) { fresh.gradeHeur = r.grade; fresh.heurScore = r.score; }
});
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
let stopFlag = false, llmRunning = false, llmBookId = null;
$('#gr-stop').addEventListener('click', () => { stopFlag = true; });
const LLM_BUTTONS = ['#gr-test', '#gr-llm', '#gr-llm-all'];
/** AI 판정은 한 번에 하나만 (두 번 눌러 요청이 두 배로 나가는 것 방지) */
async function runLLM(all, limit) {
if (llmRunning) return;
const c = readCfg();
if (PROVIDERS[c.provider].needsKey && !c.apiKey) return alert('API 키를 입력하세요.');
const book = bookById($('#gr-book').value);
if (!book) return alert('먼저 책을 추가하세요.');
if (busyBooks.has(book.id) || ingestControl?.bookId === book.id) return alert('이 책은 지금 분리 중입니다. 끝난 뒤 AI 판정을 하세요.');
llmRunning = true; llmBookId = book.id;
for (const s of LLM_BUTTONS) $(s).disabled = true;
renderLibrary(); // 판정하는 동안 이 책의 삭제를 막는다
try {
await runLLMLoop(c, book, all, limit);
} finally {
llmRunning = false; llmBookId = null;
for (const s of LLM_BUTTONS) $(s).disabled = false;
renderLibrary();
}
}
/** AI 판정 결과 한 줄 (로그용): 난이도·단원·유형·문제 글 앞부분, 자르기·번호 확인이 필요하면 ⚠ */
function analysisLine(p, r) {
const main = r.problems[r.primary];
const q = String(main.question || '').replace(/\s+/g, ' ');
const warn = [];
if (r.problems.length > 1) warn.push(`이 영역에서 문제 ${r.problems.length}개를 읽음 — 자르기를 확인하세요`);
if (hasUnreadable(main)) warn.push('안 보이는 부분 [미상] — 영역이 잘리지 않았는지 확인하세요');
const n = numberOf(main.problem_number);
if (n != null && n !== p.number) warn.push(`AI가 읽은 번호 ${main.problem_number}`);
return `${itemKey(p)}번 → ${r.level != null ? `난이도 ${r.level}단계(${r.grade}등급)` : '난이도를 받지 못함(다음 "아직 안 한 문제만"에서 다시 판정)'} · ${r.topic || '단원 미상'} · 유형 ${r.type ?? UNCLASSIFIED}`
+ ` · ${main.choices.length ? `선지 ${main.choices.length}개` : '선지 없음'} · 문제: ${q.length > 60 ? q.slice(0, 60) + '…' : q || '(없음)'}${warn.length ? ` ⚠ ${warn.join(' · ')}` : ''}`;
}
/** 아직 AI 판정이 끝나지 않은 문제: 글을 옮겨 적지 않았거나(예전 방식으로 등급만 받은 문제 포함), 영역을 고쳐 다시 판정이 필요하거나, 난이도를 받지 못한 문제 */
const needsAnalysis = (i) => !i.aiExtract || !!i.aiExtract.stale || i.difficultyLLM == null;
async function runLLMLoop(c, book, all, limit) {
const items = await db.byBook('items', book.id);
let todo = items.filter((i) => i.kind === 'problem' && i.image && (all || needsAnalysis(i)));
todo.sort(byItemOrder);
if (limit) todo = todo.slice(0, limit);
// 요청 수·사용량이 크게 늘 수 있는 경우는 시작 전에 묻는다
if (!limit && todo.length > 1) {
const legacy = todo.filter((i) => !i.aiExtract && i.gradeLLM != null);
if (all) {
if (!confirm(`이 책의 문제 ${todo.length}개를 모두 다시 AI로 판정합니다. 문제마다 요청을 하나씩 보내므로 시간과 사용량이 듭니다. 계속할까요?`)) { grLog('AI 판정을 시작하지 않았습니다.'); return; }
} else if (legacy.length && !confirm(`예전 방식으로 AI 등급만 받은 문제가 ${legacy.length}개 있습니다. 이 문제들도 다시 판정해 문제 글·수식을 옮겨 적을까요?\n`
+ '다시 판정하면 등급이 새 결과로 바뀌고 요청 수·사용량이 그만큼 늘어납니다.\n(취소를 누르면 그 문제들은 건너뛰고 나머지만 판정합니다)')) {
todo = todo.filter((i) => !legacy.includes(i));
}
}
stopFlag = false;
let ok = 0, fail = 0;
if (!todo.length) grLog('새로 판정할 문제가 없습니다. 모든 문제를 다시 판정하려면 "AI 판정 (전체 다시)"를 누르세요.', 1);
if (todo.length > 1) grLog(`AI 판정할 문제 ${todo.length}개 (문제마다 글·수식을 옮겨 적으므로 1문제에 몇 초~수십 초 걸립니다)`, 0);
for (let i = 0; i < todo.length && !stopFlag; i++) {
// 보내기 직전에 최신 기록을 읽는다: 그사이 영역을 고쳤으면 새 자르기를, 지웠거나 다른 창에서 판정을 마쳤으면 건너뛴다
const p = await db.get('items', todo[i].id);
if (!p || !p.image || (!all && !limit && !needsAnalysis(p))) continue;
try {
const r = await analyzeWithLLM(c, p, book.subject);
// 실행 중에 직접 지정한 유형·등급을 덮어쓰지 않도록 저장 직전의 기록에 AI 결과만 반영한다.
// 그사이 영역을 고쳐 자르기가 바뀌었으면 이 결과(옛 영역의 글)는 저장하지 않는다.
let recut = false;
const saved = await db.update('items', p.id, (fresh) => {
if ((fresh.imageId ?? null) !== (p.imageId ?? null)) { recut = true; return db.SKIP; }
fresh.aiExtract = { problems: r.problems, primary: r.primary, provider: c.provider, model: c.model, at: new Date().toISOString() };
// 난이도·근거·등급은 이 글과 한 묶음: 난이도를 받지 못했으면 옛 값도 지운다 (다음 "아직 안 한 문제만"에서 다시 판정)
fresh.difficultyLLM = r.level ?? null; fresh.gradeLLM = r.grade ?? null; fresh.llmReason = r.level != null ? r.reason : null;
fresh.unit = r.topic; fresh.typeLLM = r.type ?? null;
if (r.subject) fresh.subjectLLM = r.subject; // 단원 글에 과목이 없으면 전에 알던 과목을 둔다
});
if (!saved) {
fail++;
grLog(`${itemKey(p)}번: ${recut ? '판정하는 사이 영역을 고쳐 이 결과는 저장하지 않았습니다. 다시 판정하세요.' : '그사이 문제가 지워지거나 다시 분리되어 결과를 저장하지 못했습니다.'}`, (i + 1) / todo.length);
continue;
}
ok++;
grLog(analysisLine(p, r), (i + 1) / todo.length);
} catch (e) {
fail++;
grLog(`${itemKey(p)}번 실패: ${e.message}`, (i + 1) / todo.length);
if (e.status === 401 || e.status === 403 || e.message.includes('Failed to fetch')) { grLog('인증/연결 오류로 중단합니다. 키와 주소를 확인하세요.'); break; }
}
if (c.delay) await sleep(c.delay);
}
grLog(`AI 판정 끝: 성공 ${ok}, 실패 ${fail}${stopFlag ? ' (중지됨)' : ''}`);
renderHist();
buildFiltersStale = true;
if ($('#tab-classify').classList.contains('active')) renderClassify();
}
$('#gr-test').addEventListener('click', () => runLLM(true, 1));
$('#gr-llm').addEventListener('click', () => runLLM(false));
$('#gr-llm-all').addEventListener('click', () => runLLM(true));
// AI가 옮겨 적은 문제를 지정된 JSON 구조 {"problems": [...]}로 내려받는다 (책 안 순서, 한 영역에서 여러 문제를 읽었으면 모두)
$('#gr-export').addEventListener('click', async () => {
const book = bookById($('#gr-book').value);
if (!book) return alert('먼저 책을 추가하세요.');
const done = (await db.byBook('items', book.id)).filter((i) => i.kind === 'problem' && i.aiExtract?.problems?.length).sort(byItemOrder);
if (!done.length) return alert('이 책에는 아직 AI 판정으로 옮겨 적은 문제가 없습니다. 먼저 AI 판정을 실행하세요.');
// 영역마다 그 항목의 문제를 넣는다. 한 영역에서 더 읽은 문제는 모두 넣되, 그 영역이 다른 영역과 실제로 겹치고(같은 쪽의 같은 자리)
// 그 영역에서 AI가 같은 번호(라벨 포함)로 읽은 문제가 있으면 같은 인쇄 문제를 두 번 읽은 것이므로 한 번만 넣는다.
// (번호·첫머리 글만 같은 다른 단원·다른 라벨의 문제는 지우지 않는다.) 각 문제가 어느 항목·쪽에서 왔는지는 "sources"에 같은 순서로 적는다.
const picked = [], sources = [], extraNames = [], droppedNames = [];
const pagesOf = (it) => [...new Set(it.fragments.map((f) => f.page))];
const boxesOverlap = (a, b) => a.page === b.page && Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 8;
const cropsOverlap = (a, b) => a.fragments.some((f) => b.fragments.some((g) => boxesOverlap(f, g)));
const aiKey = (p) => { const n = numberOf(p.problem_number); return n == null ? null : `${String(p.problem_number).normalize('NFKC').replace(/[^가-힣A-Za-z]/g, '')}|${n}`; };
const flat = (p) => String(p.question || '').replace(/\s+/g, '');
const mainOf = (it) => it.aiExtract.problems[it.aiExtract.primary] || it.aiExtract.problems[0];
const kept = done.map((it) => ({ it, p: mainOf(it) })); // 모든 영역의 주 문제 (중복 확인용)
const source = (it, extra) => ({ book: book.name, item: itemKey(it), pages: pagesOf(it), ...(extra ? { extra: true } : {}), ...(it.aiExtract.stale ? { stale: true } : {}) });
for (const it of done) {
const main = mainOf(it);
picked.push(main); sources.push(source(it, false));
for (const p of it.aiExtract.problems) {
if (p === main) continue;
const k = aiKey(p), name = `${itemKey(it)}의 ${p.problem_number || '번호 없는 문제'}`;
const dup = kept.some((o) => o.it !== it && cropsOverlap(o.it, it) && (k != null ? aiKey(o.p) === k : flat(o.p) === flat(p)));
if (dup) { droppedNames.push(name); continue; }
picked.push(p); sources.push(source(it, true)); kept.push({ it, p }); extraNames.push(name);
}
}
const data = { ...toSchemaJson(picked), sources };
const listed = (names) => `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 외 ${names.length - 5}개` : ''}`;
const a = el('a', {
href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
download: `${book.name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}_AI판정.json`,
});
document.body.append(a); a.click(); a.remove();
setTimeout(() => URL.revokeObjectURL(a.href), 60000);
const stale = done.filter((i) => i.aiExtract.stale).length;
const left = (await db.byBook('items', book.id)).filter((i) => i.kind === 'problem' && !i.aiExtract).length;
grLog(`JSON 내려받기: 문제 ${data.problems.length}개 (${done.length}개 영역${extraNames.length ? `, 한 영역에서 더 읽은 문제 ${extraNames.length}개 포함: ${listed(extraNames)} — 자르기를 확인하세요` : ''})`
+ (droppedNames.length ? ` · 겹친 영역에서 두 번 읽힌 문제 ${droppedNames.length}개는 한 번만 넣음: ${listed(droppedNames)}` : '')
+ (stale ? ` · 영역을 고친 뒤 다시 판정하지 않은 ${stale}개 포함` : '') + (left ? ` · 아직 AI 판정 안 한 문제 ${left}개는 빠짐` : ''));
});
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
let buildFiltersStale = false;
let bookChoice = (() => {
try { const v = JSON.parse(localStorage.getItem('math-finder.builder.books') || 'null'); return v?.mode === 'custom' ? { mode: 'custom', ids: new Set(v.ids || []) } : { mode: 'all', ids: new Set() }; }
catch { return { mode: 'all', ids: new Set() }; }
})();
function saveBookChoice() { localStorage.setItem('math-finder.builder.books', JSON.stringify({ mode: bookChoice.mode, ids: [...bookChoice.ids] })); }
function invalidateSelection(message = '조건이 바뀌었습니다. 문제를 다시 골라 주세요.') {
if (!selection.length) return;
selection = []; renderSelection();
$('#bd-info').textContent = message;
}
function updateBookSummary() {
const boxes = [...$('#bd-books').querySelectorAll('input')];
const n = boxes.filter((x) => x.checked).length;
$('#bd-books-summary').textContent = `선택한 책 ${n}/${boxes.length}권`;
}
async function loadPool() {
const items = await db.all('items');
solById = new Map(items.filter((i) => i.kind === 'solution').map((s) => [s.id, s]));
const types = classifyItems(items);
// 책이 없는(가져오기 도중 실패 등) 항목은 시험지 후보에서 뺀다
pool = items.filter((i) => i.kind === 'problem' && bookById(i.bookId)).map((p) => ({
...p, subject: p.subjectLLM || bookById(p.bookId)?.subject || '(미정)', type: types.get(p.id)?.type ?? UNCLASSIFIED,
}));
}
/**
* 고른 문제를 방금 읽은 최신 기록으로 바꿔 끼운다 (그사이 영역 수정·해설 재연결이 있었으면 새 이미지·새 해설을 쓰도록).
* 지워졌거나 현재 조건(책·과목·유형·해설 필수 등)에 맞지 않게 된 문제가 있으면 false
*/
function rebindSelection() {
if (!selection.length) return true;
const byId = new Map(pool.map((p) => [p.id, p]));
const fresh = selection.map((p) => byId.get(p.id));
if (fresh.some((p) => !p)) return false;
const o = buildOpts();
const allowed = new Set(filterPool(pool, o).map((p) => p.id));
if (fresh.some((p) => !allowed.has(p.id))) return false;
// "해설 있는 문제만"이면 연결된 해설 기록이 지금도 있어야 한다
if (o.requireSolution && fresh.some((p) => !solById.has(p.solutionId))) return false;
selection = fresh;
return true;
}
async function renderBuildFilters() {
buildFiltersStale = false;
await loadPool();
// 책·과목·유형 모두 사용자가 끈 것만 기억한다. 새로 추가된 책이나 새로 생긴 유형은 켜진 상태로 나타난다.
const unchecked = (box) => new Set([...box.querySelectorAll('input:not(:checked)')].map((c) => c.value));
const countBy = (key) => { const m = new Map(); for (const p of pool) m.set(p[key], (m.get(p[key]) || 0) + 1); return m; };
const bookCounts = countBy('bookId'), subjectCounts = countBy('subject'), typeCounts = countBy('type');
const box = (sel, values, label, counts) => {
const b = $(sel), off = unchecked(b);
b.replaceChildren(...values.map((v) => el('label', {},
el('input', { type: 'checkbox', value: v, checked: sel === '#bd-books' ? (bookChoice.mode === 'all' || bookChoice.ids.has(v)) : !off.has(v) }), ` ${label(v)} `, el('span', { class: 'hint' }, `(${counts.get(v) || 0})`))));
};
box('#bd-books', books.map((b) => b.id), (id) => bookById(id)?.name ?? id, bookCounts);
box('#bd-subjects', [...subjectCounts.keys()].sort(), (s) => s, subjectCounts);
box('#bd-types', [...typeCounts.keys()].sort(compareTypes), (t) => t, typeCounts);
updateBookSummary();
// 목록을 새로 읽었으니 고른 문제도 최신 기록으로 바꾼다 (지워졌거나 조건에 안 맞게 됐으면 다시 고르게 한다)
if (!rebindSelection()) invalidateSelection('고른 문제 중 일부가 지워졌거나 수정되어 조건에 맞지 않습니다. 문제를 다시 골라 주세요.');
else if (selection.length) renderSelection();
}
function buildOpts() {
return {
target: Math.round(numIn('#bd-target', 3, 1, 9)),
count: Math.round(numIn('#bd-count', 20, 1, 500)),
mix: MIX_PRESETS[$('#bd-mix').value] || MIX_PRESETS.balanced,
requireSolution: $('#bd-reqsol').checked,
excludeBookIds: [...$('#bd-books').querySelectorAll('input:not(:checked)')].map((c) => c.value),
excludeSubjects: [...$('#bd-subjects').querySelectorAll('input:not(:checked)')].map((c) => c.value),
excludeTypes: [...$('#bd-types').querySelectorAll('input:not(:checked)')].map((c) => c.value),
};
}
$('#bd-books').addEventListener('change', () => {
bookChoice.mode = 'custom';
bookChoice.ids = new Set([...$('#bd-books').querySelectorAll('input:checked')].map((x) => x.value));
saveBookChoice(); updateBookSummary(); invalidateSelection();
});
$('#bd-books-all').addEventListener('click', () => {
bookChoice = { mode: 'all', ids: new Set() }; saveBookChoice();
for (const x of $('#bd-books').querySelectorAll('input')) x.checked = true;
updateBookSummary(); invalidateSelection();
});
$('#bd-books-none').addEventListener('click', () => {
bookChoice = { mode: 'custom', ids: new Set() }; saveBookChoice();
for (const x of $('#bd-books').querySelectorAll('input')) x.checked = false;
updateBookSummary(); invalidateSelection();
});
for (const sel of ['#bd-subjects', '#bd-types']) $(sel).addEventListener('change', () => invalidateSelection());
for (const sel of ['#bd-target', '#bd-count', '#bd-mix', '#bd-reqsol']) $(sel).addEventListener('change', () => invalidateSelection());
$('#bd-select').addEventListener('click', async () => {
await loadPool();
const o = buildOpts();
$('#bd-count').value = o.count; // 비었거나 범위를 벗어난 값은 실제로 쓴 값으로 바꿔 보여 준다
const r = selectProblems(pool, { ...o, seed: Date.now() });
selection = r.problems;
$('#bd-info').textContent = selection.length
? `조건에 맞는 문제 ${r.available}개 중 ${selection.length}개 선택` + (r.shortage ? ` (문제가 ${r.shortage}개 부족)` : '')
: '조건에 맞는 문제가 없습니다. 책·과목·유형 체크, "해설 있는 문제만", 난이도 판정 여부를 확인하세요.';
renderSelection();
});
function renderSelection() {
$('#bd-pdf').disabled = !selection.length;
$('#bd-list').replaceChildren(...selection.map((p, i) => {
const sol = solById.get(p.solutionId);
return el('div', { class: 'card' },
el('div', { class: 'row' }, el('b', {}, `${i + 1}번`), gradeBadge(p), el('span', { class: 'hint' }, `${bookById(p.bookId)?.name ?? ''} ${p.label || p.section > 1 ? itemKey(p) : p.number}번 · ${p.subject} · ${p.type}`),
el('button', { onclick: () => {
const next = replaceOne(selection, i, pool, buildOpts());
if (next === selection) return alert('조건에 맞는 다른 문제가 없어 바꿀 수 없습니다.');
selection = next; renderSelection();
} }, '교체'),
el('button', { onclick: () => { selection.splice(i, 1); renderSelection(); } }, '빼기')),
el('img', { src: p.image, loading: 'lazy' }),
sol?.image && p.solutionInferred ? el('span', { class: 'badge warn', title: '번호를 추정한 문제·해설끼리 이었습니다. ② 검토·수정에서 맞는지 확인하세요.' }, '해설 추정 연결') : null,
sol?.image ? el('img', { class: 'sol', src: sol.image, loading: 'lazy' }) : el('span', { class: 'badge warn' }, '해설 없음'));
}));
}
$('#bd-pdf').addEventListener('click', async () => {
if (!selection.length) return alert('먼저 "문제 고르기"를 누르세요.');
const btn = $('#bd-pdf');
btn.disabled = true;
try {
// PDF를 만드는 순간의 최신 기록으로 다시 읽는다: 고른 뒤 고친 영역·다시 연결한 해설·지운 문제를 반영하고,
// 현재 책·과목·유형 조건도 다시 확인한다.
await loadPool();
if (!rebindSelection()) {
invalidateSelection('고른 문제 중 일부가 지워졌거나 수정되어 조건에 맞지 않습니다. 문제를 다시 골라 주세요.');
return alert('고른 뒤에 문제가 지워졌거나 책·과목·유형 조건이 바뀌었습니다. "문제 고르기"를 다시 눌러 주세요.');
}
renderSelection();
const target = Math.round(numIn('#bd-target', 3, 1, 9));
const title = $('#bd-title').value.trim() || '나만의 수학 문제집';
const doc = await buildPdf(selection.map((p) => ({ problem: p, solution: solById.get(p.solutionId), book: bookById(p.bookId) })), {
title,
subtitle: `목표 ${target}등급 · ${selection.length}문항 · ${new Date().toLocaleDateString('ko-KR')}`,
mode: $('#bd-mode').value, columns: +$('#bd-cols').value, zoom: numIn('#bd-zoom', 1, 0.5, 2),
answerKey: $('#bd-key').checked, showSource: $('#bd-src').checked,
});
// 파일 이름에 쓸 수 없는 글자는 바꾼다
doc.save(`${title.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}_${target}등급.pdf`);
} catch (e) {
console.error(e); alert('PDF 생성 실패: ' + friendlyError(e));
} finally {
btn.disabled = !selection.length;
}
});
const STATUS_BADGE = { stopped: '부분 처리', error: '처리 오류', interrupted: '처리 중단됨', processing: '처리 중', busy: '분리·AI 판정 중' };
let libToken = 0;
async function renderLibrary() {
const token = ++libToken;
const items = await db.all('items');
if (token !== libToken) return;
const types = classifyItems(items);
$('#lib-books').replaceChildren(...(books.length ? books.map((b) => {
const mine = items.filter((i) => i.bookId === b.id);
const probs = mine.filter((i) => i.kind === 'problem');
const graded = probs.filter((p) => effectiveGrade(p) != null).length;
const ai = probs.filter((p) => p.gradeLLM != null).length;
const tc = new Map();
for (const p of probs) { const t = types.get(p.id)?.type ?? UNCLASSIFIED; tc.set(t, (tc.get(t) || 0) + 1); }
const top = [...tc].sort((x, y) => ((x[0] === UNCLASSIFIED) - (y[0] === UNCLASSIFIED)) || (y[1] - x[1])).slice(0, 5);
const st = ingestState(b);
return el('div', { class: 'bookrow' },
el('div', {}, el('b', {}, b.name), ' ',
STATUS_BADGE[st] ? el('span', { class: 'badge' + (['processing', 'busy'].includes(st) ? '' : ' warn'), title: b.ingest?.error || '' }, storageBusy.has(b.id) ? '저장 공간 정리 중' : STATUS_BADGE[st]) : null, ' ',
el('span', { class: 'hint' }, `${b.subject || '과목 미정'} · ${BOOK_LEVELS[b.level]?.label ?? ''}`), el('br'),
`문제 ${probs.length} · 해설 ${mine.length - probs.length} · 해설 연결 ${probs.filter((p) => p.solutionId).length} · 난이도 ${graded} (AI ${ai})`,
top.length ? el('div', { class: 'hint' }, `유형: ${top.map(([t, n]) => `${t} ${n}`).join(' · ')}${tc.size > top.length ? ' · …' : ''}`) : null),
el('div', {},
el('select', { 'aria-label': '책 수준', onchange: async (ev) => {
b.level = ev.target.value;
// 바꾼 값만 저장한다 (다른 창이 처리한 최신 기록을 이 창의 옛 사본으로 덮어쓰지 않도록)
await db.update('books', b.id, (f) => { f.level = b.level; });
await runHeuristic(b.id); renderLibrary();
} },
...Object.entries(BOOK_LEVELS).map(([k, v]) => opt(k, v.label, k === b.level))),
' ',
el('button', {
disabled: ['processing', 'busy'].includes(st),
onclick: async () => {
// 화면이 오래됐을 수 있으니 저장소의 최신 기록으로 한 번 더 확인한다
if (await isBusyElsewhere(b.id)) { alert('이 책은 지금 처리 중입니다 (다른 창일 수 있습니다). 처리가 끝난 뒤 삭제하세요.'); return refreshBooks(); }
if (!confirm(`"${b.name}"을(를) 삭제할까요? 페이지와 문제가 모두 지워집니다.`)) return;
try {
const r = await db.deleteBook(b.id);
buildFiltersStale = true;
// 폴더 연결이 끊겨 있으면 이미지 파일은 정리 대기로 남는다 (다음에 폴더를 연결하면 자동으로 지움)
if (r?.externalPending) alert('책을 삭제했습니다. 대용량 저장 폴더가 지금 연결되어 있지 않아 그 폴더의 이미지 파일은 아직 남아 있습니다. 라이브러리에서 "대용량 저장 폴더 연결"을 누르면 자동으로 정리됩니다.');
} catch (e) { alert('삭제하지 못했습니다.\n' + friendlyError(e)); }
refreshBooks();
},
}, '삭제')));
}) : [el('p', { class: 'hint' }, '아직 추가된 책이 없습니다.')]));
renderStorage();
renderExternalStorage();
}
/** 대용량 외부 폴더 연결 상태 */
function renderExternalStorage() {
const s = M.assets.status();
$('#lib-folder').disabled = !s.supported || s.enabled;
$('#lib-folder-off').disabled = !s.enabled;
$('#lib-folder-status').textContent = (!s.supported
? '이 브라우저에서는 외부 폴더 저장을 지원하지 않습니다. 내부 저장은 Blob 압축으로 기존보다 약 25% 절약됩니다.'
: s.needsPermission ? '전에 연결한 대용량 저장 폴더에 접근 권한이 필요합니다. "대용량 저장 폴더 연결"을 눌러 다시 허용하면 그 폴더에 저장된 이미지가 다시 보입니다. (그전까지 새 책은 브라우저 내부에 저장됩니다)'
: s.enabled ? '대용량 폴더 사용 중: 새로 추가하는 책의 페이지와 문제 이미지를 연결한 폴더에 저장합니다. 이 폴더는 용량 확장용이며, 브라우저 데이터가 지워질 때를 대비한 백업은 별도로 내보내세요.'
: s.connected ? '폴더는 읽을 수 있고, 새 책은 브라우저 내부에 저장합니다.'
: '내부 저장 사용 중: 이미지가 base64 문자열이 아닌 Blob으로 저장되어 기존보다 약 25% 작습니다.')
+ (s.pendingCleanup ? ` · 삭제한 책 ${s.pendingCleanup}권의 이미지 폴더가 정리 대기 중입니다 (폴더를 다시 연결하면 자동으로 지웁니다).` : '');
}
$('#lib-folder').addEventListener('click', async () => {
try {
await M.assets.connect(); renderExternalStorage();
const left = M.assets.status().pendingCleanup;
alert('대용량 저장 폴더를 연결했습니다. 이제 새로 추가하는 책의 큰 이미지는 그 폴더에 저장됩니다.'
+ (left ? `\n(삭제한 책 ${left}권의 이미지 폴더는 아직 정리하지 못했습니다. 잠시 뒤 다시 연결해 보세요.)` : ''));
} catch (e) { if (e?.name !== 'AbortError') alert('폴더를 연결하지 못했습니다.\n' + friendlyError(e)); }
});
$('#lib-folder-off').addEventListener('click', async () => {
await M.assets.disconnect(); renderExternalStorage();
});
$('#lib-optimize').addEventListener('click', async () => {
const btn = $('#lib-optimize');
if (!confirm(M.assets.status().enabled
? '기존 책의 큰 이미지도 연결한 폴더로 옮길까요? 중간에 멈춰도 옮긴 데이터는 안전하게 남습니다.'
: '기존 책의 base64 이미지를 더 작은 Blob 저장 형식으로 바꿀까요? 보통 이미지 저장량이 약 25% 줄어듭니다.')) return;
btn.disabled = true;
// 책 하나씩 잠그고 옮긴다: 그 책은 옮기는 동안 삭제·다시 분리·영역 편집을 막고,
// 이미 분리·처리 중인 책은 건너뛴다 (나중에 다시 실행하면 이어서 처리)
let renderTimer = null;
const renderSoon = () => { clearTimeout(renderTimer); renderTimer = setTimeout(renderLibrary, 250); }; // 책마다 다시 그리지 않고 모아서
const acquire = async (id) => {
if (busyBooks.has(id) || ingestControl?.bookId === id || llmBookId === id) return false;
// 다른 창에서 처리 중인 책(저장된 처리 상태·살아 있다는 표시)도 건너뛴다
const fresh = await db.get('books', id);
if (!fresh || ['processing', 'busy'].includes(ingestState(fresh)) || busyBooks.has(id)) return false;
busyBooks.add(id); storageBusy.add(id); renderSoon();
if (rv.book?.id === id) $('#rv-reseg').disabled = true;
return true;
};
const release = (id) => {
busyBooks.delete(id); storageBusy.delete(id); renderSoon();
if (rv.book?.id === id) $('#rv-reseg').disabled = false;
};
try {
const r = await M.assets.optimizeExisting((n, total, changed) => { btn.textContent = `최적화 중 ${n}/${total} (${changed}개 변경)`; }, { acquire, release });
alert(`저장 공간 최적화 완료: ${r.changed}/${r.total}개 이미지를 정리했습니다.`
+ (r.removedFiles ? ` 쓰이지 않는 외부 파일 ${r.removedFiles}개를 지웠습니다.` : '')
+ (r.skippedBooks ? `\n처리 중이던 책 ${r.skippedBooks}권은 건너뛰었습니다. 처리가 끝난 뒤 다시 실행하세요.` : '')
+ (r.failed ? `\n열 수 없는 이미지 ${r.failed}개는 그대로 두었습니다.` : ''));
renderStorage();
buildFiltersStale = true;
} catch (e) {
alert('최적화를 끝내지 못했습니다. 이미 바꾼 데이터는 안전하게 남아 있으며 다시 실행하면 이어집니다.\n' + friendlyError(e));
} finally { btn.disabled = false; btn.textContent = '기존 책 저장 공간 최적화'; renderExternalStorage(); }
});
/** 저장 공간 사용량 (브라우저가 알려 주는 경우) */
async function renderStorage() {
const out = $('#lib-storage');
try {
const est = await navigator.storage?.estimate?.();
if (!est) return;
const mb = (n) => (n / 1048576 >= 1024 ? `${(n / 1073741824).toFixed(1)}GB` : `${Math.max(0.1, n / 1048576).toFixed(1)}MB`);
const persisted = await navigator.storage.persisted?.();
const quota = est.quota || 0, used = est.usage || 0;
out.textContent = `브라우저 내부 저장: ${mb(used)} 사용 / 총 한도 약 ${mb(quota)} / 남은 공간 약 ${mb(Math.max(0, quota - used))}`
+ (persisted ? ' · 영구 저장 켜짐' : ' · 공간이 부족하면 브라우저가 지울 수 있으니 가끔 백업하세요')
+ (M.assets.status().enabled ? ' · 외부 폴더의 실제 디스크 공간은 이 한도와 별도입니다.' : '');
} catch { /* 지원하지 않는 브라우저 */ }
}
// 백업 형식 2: 첫 줄은 머리글, 그다음 줄마다 기록 하나 {"s": 저장소, "v": 값}.
// 기록을 하나씩 문자열로 만들어 이어 붙이므로, 책이 많아도 브라우저 문자열 길이 한계(약 5억 자)에 걸리지 않는다.
const BACKUP_HEADER = 'math-finder-backup';
$('#lib-export').addEventListener('click', async () => {
const btn = $('#lib-export');
// 폴더 권한이 없으면 폴더에 저장된 이미지를 백업에 넣을 수 없다: 이 클릭 안에서 권한을 다시 요청하고, 그래도 없으면 한 번 더 묻는다
if (M.assets.status().needsPermission) {
const ok = await M.assets.reconnect().catch(() => false);
renderExternalStorage();
if (!ok && !confirm('대용량 저장 폴더에 접근 권한이 없어, 폴더에 저장된 이미지는 백업에 넣을 수 없습니다.\n'
+ '취소를 누른 뒤 "대용량 저장 폴더 연결"로 권한을 허용하고 다시 백업하세요.\n\n'
+ '그래도 이미지 없이 백업 파일을 만들까요? (이런 백업으로는 이미지를 복원할 수 없습니다)')) return;
}
btn.disabled = true;
try {
// 문자열이 약 1,600만 자 쌓일 때마다 중간 Blob으로 넘겨 자바스크립트 메모리를 비운다
const chunks = [];
let parts = [JSON.stringify({ format: BACKUP_HEADER, version: 2, app: 'Math Finder', exportedAt: new Date().toISOString() }) + '\n'];
let size = parts[0].length, skippedImages = 0, absentImages = 0;
const skippedNames = [];
const add = (line) => {
parts.push(line); size += line.length;
if (size > 16e6) { chunks.push(new Blob(parts)); parts = []; size = 0; }
};
const recordName = (s, v) => {
const name = bookById(v.bookId)?.name || '책';
return s === 'pages' ? `${name} ${KIND_LABEL[v.kind] || ''} ${v.index}쪽` : `${name} ${v.kind === 'problem' ? '문제' : '해설'} ${itemKey(v)}번`;
};
// Blob/외부 폴더 이미지는 내보낼 때만 data URL로 바꿔 어느 브라우저에서도 복구 가능한 백업을 만든다.
// 폴더에서 지워졌거나 권한이 없어 못 읽는 이미지는 빼고 나머지를 모두 백업한다 (한 장 때문에 백업 전체가 막히지 않도록).
for (const s of ['books', 'pages', 'items']) {
for (const key of await db.keys(s)) {
let v = await db.get(s, key);
if (s !== 'books' && v && v.image == null) { absentImages++; skippedNames.push(recordName(s, v)); } // 이미 이미지가 없던 기록
else if (v?.image != null && typeof v.image !== 'string') {
try { v = { ...v, image: await M.assets.asDataURL(v.image) }; }
catch (e) {
skippedImages++; console.warn('백업에서 뺀 이미지', s, key, e);
skippedNames.push(recordName(s, v));
v = { ...v, image: null };
}
}
add(JSON.stringify({ s, v }) + '\n');
}
}
const blob = new Blob([...chunks, ...parts], { type: 'application/x-ndjson' });
chunks.length = 0; parts = [];
const a = el('a', { href: URL.createObjectURL(blob), download: `math-finder-backup-${new Date().toISOString().slice(0, 10)}.jsonl` });
document.body.append(a); // 일부 브라우저는 문서에 붙어 있어야 내려받기가 된다
a.click();
a.remove();
setTimeout(() => URL.revokeObjectURL(a.href), 60000);
if (skippedImages || absentImages) {
const what = [skippedImages ? `이미지 ${skippedImages}개는 읽을 수 없어 빼고 저장했습니다` : '', absentImages ? `원래 이미지가 없던 기록 ${absentImages}개도 이미지 없이 저장했습니다` : ''].filter(Boolean).join('. ');
alert(`백업 파일을 만들었습니다. 다만 ${what}: ${skippedNames.slice(0, 5).join(', ')}${skippedNames.length > 5 ? ' 외' : ''}.\n`
+ (skippedImages ? '대용량 저장 폴더를 옮기거나 지우지 않았는지, 라이브러리에서 폴더가 연결되어 있는지 확인하세요. ' : '')
+ '이 백업을 이미지가 있는 라이브러리에 가져오면 빠진 이미지는 라이브러리에 있는 것을 그대로 둡니다. 빈 라이브러리에 복원하면 이미지가 빠진 쪽이 있는 책은 문제는 남지만 그 종류를 다시 분리할 수 없습니다.');
}
} catch (e) {
console.error(e);
alert('백업 파일을 만들지 못했습니다.\n' + friendlyError(e) + (db.isQuotaError(e) || /memory|메모리/i.test(String(e?.message)) ? '\n다른 탭을 닫아 메모리를 확보한 뒤 다시 시도하세요.' : ''));
} finally {
btn.disabled = false;
}
});
/** 파일을 한 줄씩 읽는다 (큰 백업도 한 번에 메모리로 올리지 않음) */
async function* fileLines(file) {
if (!file.stream || typeof TextDecoderStream === 'undefined') { yield* (await file.text()).split('\n'); return; }
const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
let buf = '';
for (;;) {
const { value, done } = await reader.read();
if (done) break;
buf += value;
let i;
while ((i = buf.indexOf('\n')) >= 0) { yield buf.slice(0, i); buf = buf.slice(i + 1); }
}
if (buf) yield buf;
}
const hasId = (r) => r && typeof r === 'object' && typeof r.id === 'string' && r.id;
// 백업 안에서는 data URL, 실행 중에는 더 작은 Blob으로 저장한다.
const isDataImage = (s) => typeof s === 'string' && s.startsWith('data:image/');
const compactImage = (s) => isDataImage(s) ? M.assets.dataUrlToBlob(s) : null;
const cleanRecord = {
books: (b) => (hasId(b) ? { ...b, name: b.name || '이름 없는 책', createdAt: b.createdAt || new Date(0).toISOString(), pageCounts: b.pageCounts || { problem: 0, solution: 0 } } : null),
pages: (p) => {
if (!hasId(p) || !p.bookId) return null;
// 백업할 때 읽지 못해 빠진 쪽 이미지: 쪽 기록(글줄·단 정보)은 남긴다. 이 쪽이 있는 종류는 다시 분리하지 않아 문제가 지워지지 않는다.
if (p.image == null) return { ...p, image: null, imageBytes: 0, imageMissing: true };
const image = compactImage(p.image);
return image ? { ...p, image, imageBytes: image.size, imageId: db.uid('i') } : null;
},
items: (it) => {
if (!hasId(it) || !it.bookId || !Array.isArray(it.fragments)) return null;
if (it.image == null) return it;
const image = compactImage(it.image);
return image ? { ...it, image, imageBytes: image.size, imageId: db.uid('i') } : null;
},
};
const isStoreName = (s) => Object.prototype.hasOwnProperty.call(cleanRecord, s);
// 이미지와 한 묶음인 값: 쪽은 이미지 자체, 문제·해설은 그 이미지가 보여 주는 영역과 글자까지
const IMAGE_FIELDS = ['image', 'imageId', 'imageFormat', 'imageBytes'];
// AI 판정 한 번이 함께 만든 값 (나눠 섞으면 글과 등급이 서로 맞지 않게 된다)
const AI_FIELDS = ['aiExtract', 'gradeLLM', 'difficultyLLM', 'llmReason', 'unit', 'subjectLLM', 'typeLLM'];
const CROP_FIELDS_BY_STORE = { pages: ['width', 'height'], items: ['fragments', 'w', 'h', 'text', 'pageHeight', 'scale'] };
/**
* 백업에 이미지가 없는 기록(내보낼 때 폴더 권한이 없었거나 파일을 못 읽음)이 라이브러리의 같은 기록을 덮어쓸 때는
* 라이브러리에 있는 이미지(와 그 이미지가 보여 주는 영역)를 그대로 둔다. 나머지 값(번호·난이도·유형 등)은 백업 것을 쓴다.
*/
function keepLiveImage(s, v, old) {
if (v.image != null || old?.image == null) return v;
const kept = { ...v };
delete kept.imageMissing;
for (const k of [...IMAGE_FIELDS, ...(CROP_FIELDS_BY_STORE[s] || [])]) { if (k in old) kept[k] = old[k]; else delete kept[k]; }
// AI가 옮겨 적은 글과 그 난이도·유형은 그 자르기의 것이다 (한 묶음으로 옮긴다):
// 라이브러리에 있으면 라이브러리 것을 모두, 없으면 백업 것을 모두 쓰되 영역이 다르면 '다시 판정 필요'로
if (s === 'items') {
if (old.aiExtract) for (const k of AI_FIELDS) { if (k in old) kept[k] = old[k]; else delete kept[k]; }
else if (v.aiExtract && !sameRegions(v.fragments, old.fragments)) kept.aiExtract = { ...v.aiExtract, stale: true };
}
return kept;
}
/**
* 가져온 기록을 저장한다. 같은 id의 기록을 새 이미지로 덮어쓰면 그 기록이 쓰던 외부 폴더 파일은 저장이 끝난 뒤 지운다
* (같은 백업을 여러 번 가져와도 폴더에 옛 파일이 쌓이지 않도록). 저장에 실패하면 이번에 쓴 파일을 지운다.
* 반환: { kept: 라이브러리 이미지를 지킨 수, missing: 이미지 없이 들어온 수 }
*/
async function putReplacing(s, list) {
const before = s === 'books' ? [] : await Promise.all(list.map((v) => db.get(s, v.id).catch(() => null)));
const merged = s === 'books' ? list : list.map((v, i) => keepLiveImage(s, v, before[i]));
try { await db.putMany(s, merged); }
catch (e) { await M.assets.removeRefs(list.map((v) => v.image).filter(M.assets.isRef)).catch(() => {}); throw e; }
// 새 이미지가 들어와 바뀐 기록의 옛 파일만 지운다 (이미지 없이 들어온 기록은 위에서 옛 이미지를 그대로 두었다)
const replaced = before.map((old, i) => (M.assets.isRef(old?.image) && old.image.file !== merged[i].image?.file ? old.image : null)).filter(Boolean);
await M.assets.removeRefs(replaced).catch(() => {});
if (s === 'books') return { kept: 0, missing: 0 };
return {
kept: list.filter((v, i) => v.image == null && merged[i].image != null).length,
missing: merged.filter((v) => v.image == null).length,
};
}
/** 가져온 이미지도 지금 저장 모드로 둔다: 대용량 폴더를 쓰는 중이면 폴더 파일로(브라우저 한도를 넘는 백업도 복원되게), 아니면 Blob */
async function placeImage(s, v) {
if (!(v?.image instanceof Blob)) return v;
const role = s === 'pages' ? `page-${v.kind || 'unknown'}` : `item-${v.kind || 'unknown'}`;
const id = s === 'pages' ? v.index ?? v.id : `${v.section ?? 0}-${v.number ?? v.id}`;
return { ...v, image: await M.assets.storeImage(v.image, { bookId: v.bookId, role, id }) };
}
/** 백업 가져오기. 형식 2(줄 단위)와 예전 형식(JSON 하나) 모두 읽는다. 반환: 저장소별 개수 */
async function importBackup(file) {
// kept: 백업에 이미지가 없어 라이브러리 이미지를 그대로 둔 기록 수, missing: 이미지 없이 들어온 기록 수
const counts = { books: 0, pages: 0, items: 0, kept: 0, missing: 0 };
const tally = (r) => { counts.kept += r.kept; counts.missing += r.missing; };
try {
const head = (await file.slice(0, 200).text()).trimStart();
if (head.startsWith(`{"format":"${BACKUP_HEADER}"`)) {
const batch = { books: [], pages: [], items: [] };
const flush = async (s) => {
if (!batch[s].length) return;
tally(await putReplacing(s, batch[s]));
counts[s] += batch[s].length; batch[s] = [];
};
let first = true;
for await (const line of fileLines(file)) {
if (first) { first = false; continue; }
if (!line.trim()) continue;
let rec;
try { rec = JSON.parse(line); } catch {
// 손상된 줄 앞까지 읽은 것은 모두 저장한 뒤 알린다
for (const s of ['books', 'pages', 'items']) await flush(s);
throw new Error('백업 파일의 일부가 손상되었습니다.');
}
if (!isStoreName(rec?.s)) continue;
const v = cleanRecord[rec.s](rec.v);
if (!v) continue;
// 책 기록을 먼저 저장해 두어야 도중에 실패해도 주인 없는 페이지·문제가 남지 않는다
if (rec.s !== 'books') await flush('books');
batch[rec.s].push(await placeImage(rec.s, v));
if (batch[rec.s].length >= 50) await flush(rec.s);
}
for (const s of ['books', 'pages', 'items']) await flush(s);
return counts;
}
let data;
try { data = JSON.parse(await file.text()); } catch { throw new Error('JSON 파일 형식이 올바르지 않습니다.'); }
if (!data || typeof data !== 'object' || !Array.isArray(data.books) || !['pages', 'items'].every((k) => data[k] == null || Array.isArray(data[k]))) {
throw new Error('Math Finder 백업 파일이 아닙니다.');
}
for (const s of ['books', 'pages', 'items']) {
const list = [];
for (const r of data[s] || []) { const v = cleanRecord[s](r); if (v) list.push(await placeImage(s, v)); }
tally(await putReplacing(s, list));
counts[s] = list.length;
}
return counts;
} catch (e) {
e.partial = counts;
throw e;
}
}
$('#lib-import').addEventListener('change', async (ev) => {
const input = ev.target;
const f = input.files[0];
input.value = ''; // 같은 파일을 다시 골라도 동작하도록
if (!f) return;
try {
const c = await importBackup(f);
alert(`가져오기 완료: 책 ${c.books}권, 페이지 ${c.pages}쪽, 문제·해설 ${c.items}개`
+ (c.kept ? `\n백업에 이미지가 빠져 있던 ${c.kept}개는 라이브러리에 있던 이미지를 그대로 두었습니다.` : '')
+ (c.missing ? `\n이미지 없이 들어온 기록이 ${c.missing}개 있습니다. 그 쪽의 원본은 검토 화면에 보이지 않고, 그 종류는 다시 분리할 수 없습니다. 온전한 백업을 가져오면 채워집니다.` : ''));
} catch (e) {
console.error(e);
const p = e.partial;
const done = p && (p.books || p.pages || p.items)
? `\n(앞부분은 이미 들어왔습니다: 책 ${p.books}권, 페이지 ${p.pages}쪽, 문제·해설 ${p.items}개. 온전한 백업 파일로 다시 가져오면 채워집니다.)`
: '';
alert('가져오기 실패: ' + friendlyError(e) + done);
}
buildFiltersStale = true;
refreshBooks();
});
M.assets.init().finally(() => {
renderExternalStorage(); refreshBooks();
// 브라우저를 다시 켜면 폴더 권한을 다시 허용해야 하는 경우가 많다. 이미지가 안 보이는 이유를 바로 알린다
if (M.assets.status().needsPermission) toast('대용량 저장 폴더의 이미지를 보려면 라이브러리 탭에서 "대용량 저장 폴더 연결"을 눌러 권한을 다시 허용하세요.');
});
})();
// ===== part3.js 끝 =====
