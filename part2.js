// MathBook part2.js — 이 줄부터 끝까지 전부 복사
var M = window.M || (window.M = {});
M.pdfsource = (() => {
const PDFJS_VER = '4.10.38';
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VER}/build`;
let pdfjsLib = null;
async function lib() {
if (!pdfjsLib) {
pdfjsLib = await import(`${PDFJS_BASE}/pdf.min.mjs`);
pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.min.mjs`;
}
return pdfjsLib;
}
async function openPdf(file) {
const pdfjs = await lib();
const data = new Uint8Array(await file.arrayBuffer());
return pdfjs.getDocument({ data }).promise;
}
/**
* 페이지를 canvas로 렌더링하고, 텍스트 레이어가 있으면 줄 단위 텍스트를 함께 돌려준다.
* 반환 lines 좌표는 렌더링된 canvas 픽셀 좌표.
*/
async function renderPage(doc, pageNo, scale) {
const page = await doc.getPage(pageNo);
const viewport = page.getViewport({ scale });
const canvas = document.createElement('canvas');
canvas.width = Math.floor(viewport.width);
canvas.height = Math.floor(viewport.height);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
await page.render({ canvasContext: ctx, viewport }).promise;
let lines = [];
try {
const tc = await page.getTextContent();
lines = textItemsToLines(tc.items, viewport);
} catch (e) { /* 텍스트 없음 */ }
const charCount = lines.reduce((s, l) => s + l.text.replace(/\s/g, '').length, 0);
return { canvas, lines, hasText: charCount >= 40 };
}
function textItemsToLines(items, viewport) {
const boxes = [];
for (const it of items) {
if (!it.str || !it.str.trim()) continue;
const [, , c, d, e, f] = it.transform;
const [x, yBase] = viewport.convertToViewportPoint(e, f);
const h = (it.height || Math.hypot(c, d)) * viewport.scale;
const w = it.width * viewport.scale;
boxes.push({ text: it.str, x0: x, y0: yBase - h, x1: x + w, y1: yBase });
}
boxes.sort((a, b) => (a.y1 - b.y1) || (a.x0 - b.x0));
const lines = [];
for (const b of boxes) {
const h = b.y1 - b.y0;
const last = lines[lines.length - 1];
if (last && Math.abs(last.y1 - b.y1) < h * 0.4 && b.x0 - last.x1 < h * 3) {
last.text += (b.x0 - last.x1 > h * 0.2 ? ' ' : '') + b.text;
last.x1 = Math.max(last.x1, b.x1);
last.y0 = Math.min(last.y0, b.y0);
} else {
const first = b.text.trim().split(/\s+/)[0];
const fw = (b.x1 - b.x0) * (first.length / Math.max(1, b.text.length));
lines.push({ ...b, firstWord: { text: first, x0: b.x0, y0: b.y0, x1: b.x0 + fw, y1: b.y1 } });
}
}
return lines;
}
return { openPdf, renderPage };
})();
M.ocr = (() => {
const TESS_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let workerPromise = null;
function loadScript(src) {
return new Promise((resolve, reject) => {
if (window.Tesseract) return resolve();
const s = document.createElement('script');
s.src = src;
s.onload = resolve;
s.onerror = () => reject(new Error('Tesseract.js 로드 실패: ' + src));
document.head.appendChild(s);
});
}
async function worker(onProgress) {
if (!workerPromise) {
workerPromise = (async () => {
await loadScript(TESS_URL);
return window.Tesseract.createWorker('kor+eng', 1, {
logger: (m) => onProgress && m.status === 'recognizing text' && onProgress(m.progress),
});
})();
}
return workerPromise;
}
/** canvas를 OCR 해서 lines [{text, x0,y0,x1,y1, firstWord}] 반환 */
async function ocrCanvas(canvas, onProgress) {
const w = await worker(onProgress);
const { data } = await w.recognize(canvas);
const lines = [];
for (const ln of data.lines || []) {
const text = (ln.text || '').trim();
if (!text) continue;
const fw = ln.words && ln.words[0];
lines.push({
text,
x0: ln.bbox.x0, y0: ln.bbox.y0, x1: ln.bbox.x1, y1: ln.bbox.y1,
firstWord: fw
? { text: fw.text, x0: fw.bbox.x0, y0: fw.bbox.y0, x1: fw.bbox.x1, y1: fw.bbox.y1 }
: { text: text.split(/\s+/)[0], x0: ln.bbox.x0, y0: ln.bbox.y0, x1: ln.bbox.x1, y1: ln.bbox.y1 },
});
}
return lines;
}
async function terminateOcr() {
if (workerPromise) {
const w = await workerPromise;
await w.terminate();
workerPromise = null;
}
}
return { ocrCanvas, terminateOcr };
})();
M.llm = (() => {
const { loadImage } = M.imaging;
const PROVIDERS = {
gemini:    { label: 'Google Gemini (무료 등급 있음)', model: 'gemini-2.5-flash', needsKey: true },
anthropic: { label: 'Anthropic Claude', model: 'claude-sonnet-4-5', needsKey: true },
openai:    { label: 'OpenAI', model: 'gpt-4o-mini', needsKey: true },
ollama:    { label: 'Ollama (내 PC, 키 불필요)', model: 'qwen2.5vl:7b', needsKey: false },
};
const SUBJECTS = ['수학(상)', '수학(하)', '공통수학1', '공통수학2', '수학I', '수학II', '대수', '미적분I', '미적분', '미적분II', '확률과 통계', '기하'];
function buildPrompt(subjectHint, hasSolution) {
return `당신은 한국 고등학교 수학 문제의 난이도를 평가하는 전문가입니다.
첫 번째 이미지는 문제${hasSolution ? ', 두 번째 이미지는 그 문제의 해설' : ''}입니다.
${subjectHint ? `참고: 이 책의 과목은 "${subjectHint}"입니다.
` : ''}
이 문제가 "수능 몇 등급 학생에게 알맞은 문제인지"를 1~9 정수로 판정하세요.
(그 등급대 학생의 정답률이 대략 50% 정도인 수준)
- 1: 킬러·준킬러 (전체 정답률 20% 미만)
- 2: 고난도 4점
- 3: 일반적인 4점 중상
- 4: 쉬운 4점 / 어려운 3점
- 5: 보통 3점
- 6: 쉬운 3점
- 7: 2점 수준의 계산 문제
- 8~9: 개념 확인, 공식 대입, 기초 계산
반드시 아래 JSON 형식으로만 답하세요:
{"grade": 정수, "subject": "과목(${SUBJECTS.join('/')} 중 하나)", "unit": "단원명", "answer": "정답(알 수 있으면, 없으면 null)", "reason": "한 문장 근거"}`;
}
/** 전송 전 이미지 축소 (토큰/비용 절약) */
async function shrink(dataURL, maxW = 1000) {
const im = await loadImage(dataURL);
const r = Math.min(1, maxW / im.naturalWidth);
const c = document.createElement('canvas');
c.width = Math.round(im.naturalWidth * r); c.height = Math.round(im.naturalHeight * r);
const ctx = c.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
ctx.drawImage(im, 0, 0, c.width, c.height);
return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}
function parseJsonLoose(text) {
const m = text.match(/\{[\s\S]*\}/);
if (!m) throw new Error('JSON 응답 없음: ' + text.slice(0, 200));
const o = JSON.parse(m[0]);
const g = Math.round(Number(o.grade));
if (!(g >= 1 && g <= 9)) throw new Error('grade 범위 오류: ' + o.grade);
return { grade: g, subject: o.subject || null, unit: o.unit || null, answer: o.answer == null || o.answer === 'null' ? null : String(o.answer), reason: o.reason || '' };
}
async function call(cfg, prompt, images) {
const { provider, apiKey, model } = cfg;
let res, text;
if (provider === 'anthropic') {
res = await fetch('https://api.anthropic.com/v1/messages', {
method: 'POST',
headers: {
'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
'anthropic-dangerous-direct-browser-access': 'true',
},
body: JSON.stringify({
model, max_tokens: 400,
messages: [{ role: 'user', content: [
...images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: d } })),
{ type: 'text', text: prompt },
] }],
}),
});
if (!res.ok) throw httpError(res, await res.text());
text = (await res.json()).content.map((c) => c.text || '').join('');
} else if (provider === 'openai') {
res = await fetch('https://api.openai.com/v1/chat/completions', {
method: 'POST',
headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
body: JSON.stringify({
model, response_format: { type: 'json_object' },
messages: [{ role: 'user', content: [
{ type: 'text', text: prompt },
...images.map((d) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${d}` } })),
] }],
}),
});
if (!res.ok) throw httpError(res, await res.text());
text = (await res.json()).choices[0].message.content;
} else if (provider === 'gemini') {
res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
method: 'POST',
headers: { 'content-type': 'application/json' },
body: JSON.stringify({
contents: [{ parts: [{ text: prompt }, ...images.map((d) => ({ inline_data: { mime_type: 'image/jpeg', data: d } }))] }],
generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
}),
});
if (!res.ok) throw httpError(res, await res.text());
const j = await res.json();
text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
} else if (provider === 'ollama') {
const base = (cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
res = await fetch(`${base}/api/chat`, {
method: 'POST',
headers: { 'content-type': 'application/json' },
body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, images }] }),
});
if (!res.ok) throw httpError(res, await res.text());
text = (await res.json()).message.content;
} else {
throw new Error('알 수 없는 제공자: ' + provider);
}
return parseJsonLoose(text);
}
function httpError(res, body) {
const e = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
e.status = res.status;
return e;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 문제 1개 판정 (429/5xx 재시도) */
async function gradeWithLLM(cfg, problem, solution, subjectHint) {
const images = [await shrink(problem.image)];
if (solution?.image) images.push(await shrink(solution.image));
const prompt = buildPrompt(subjectHint, !!solution?.image);
for (let attempt = 0; ; attempt++) {
try {
return await call(cfg, prompt, images);
} catch (e) {
const retryable = e.status === 429 || (e.status >= 500 && e.status < 600);
if (!retryable || attempt >= 3) throw e;
await sleep(2000 * 2 ** attempt);
}
}
}
function loadConfig() {
try { return JSON.parse(localStorage.getItem('mathbook.llm') || '{}'); } catch { return {}; }
}
function saveConfig(cfg) {
localStorage.setItem('mathbook.llm', JSON.stringify(cfg));
}
return { PROVIDERS, SUBJECTS, buildPrompt, parseJsonLoose, gradeWithLLM, loadConfig, saveConfig };
})();
M.build = (() => {
const { textImage } = M.imaging;
const { effectiveGrade } = M.grade;
const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
const PX_TO_MM = 25.4 / 72; // 렌더링 배율 1 = 72dpi
function loadScript(src) {
return new Promise((resolve, reject) => {
if (window.jspdf) return resolve();
const s = document.createElement('script');
s.src = src; s.onload = resolve;
s.onerror = () => reject(new Error('jsPDF 로드 실패'));
document.head.appendChild(s);
});
}
/**
* entries: [{problem, solution, book}]
* opts: {title, subtitle, mode:'pair'|'separate', columns:1|2, zoom, answerKey, showSource}
*/
async function buildPdf(entries, opts) {
await loadScript(JSPDF_URL);
const { jsPDF } = window.jspdf;
const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
const PW = 210, PH = 297, M = 14, GUT = 8;
const cols = opts.columns === 2 ? 2 : 1;
const colW = (PW - 2 * M - (cols - 1) * GUT) / cols;
const bottom = PH - M - 6;
const zoom = opts.zoom || 1;
let pageNo = 1, col = 0, y = M, pageTop = M;
const colX = (c) => M + c * (colW + GUT);
const fullH = () => bottom - M;
const decorate = () => {
doc.setFontSize(9); doc.setTextColor(120);
doc.text(String(pageNo), PW / 2, PH - M / 2, { align: 'center' });
};
const divider = () => {
if (cols === 2) { doc.setDrawColor(200); doc.line(PW / 2, pageTop, PW / 2, bottom); }
};
const newPage = () => { divider(); doc.addPage(); pageNo++; col = 0; pageTop = M; y = M; decorate(); };
const nextCol = () => { if (++col >= cols) newPage(); else y = pageTop; };
const label = (text, size = 26, bold = true, color = '#1f3a93') => {
const t = textImage(text, { size, bold, color });
const h = size * 0.2; // mm
return { image: t.image, fmt: 'PNG', h, w: Math.min(colW, (t.w / t.h) * h) };
};
const pic = (item) => {
if (!item?.image) return null;
const s = item.scale || 2;
let w = (item.w / s) * PX_TO_MM * zoom;
let h = (item.h / s) * PX_TO_MM * zoom;
if (w > colW) { h *= colW / w; w = colW; }
if (h > fullH()) { w *= fullH() / h; h = fullH(); }
return { image: item.image, fmt: 'JPEG', w, h };
};
const heightOf = (blocks) => blocks.reduce((s, b) => s + b.h + 1.5, 0);
const place = (b) => {
if (y + b.h > bottom && y > pageTop) nextCol();
doc.addImage(b.image, b.fmt, colX(col), y, b.w, b.h, undefined, 'FAST');
y += b.h + 1.5;
};
/** 블록 묶음을 가능하면 한 단에 같이 배치 */
const group = (blocks) => {
blocks = blocks.filter(Boolean);
const total = heightOf(blocks);
if (y + total > bottom && total <= bottom - pageTop && y > pageTop) nextCol();
blocks.forEach(place);
};
const rule = () => {
if (y + 4 > bottom) return;
doc.setDrawColor(215); doc.line(colX(col), y + 1, colX(col) + colW, y + 1);
y += 4;
};
decorate();
const t1 = textImage(opts.title || '나만의 문제집', { size: 56, bold: true });
const th = 11;
doc.addImage(t1.image, 'PNG', M, y, Math.min(PW - 2 * M, (t1.w / t1.h) * th), th);
y += th + 1;
if (opts.subtitle) {
const t2 = textImage(opts.subtitle, { size: 30, color: '#555' });
const sh = 6;
doc.addImage(t2.image, 'PNG', M, y, Math.min(PW - 2 * M, (t2.w / t2.h) * sh), sh);
y += sh + 2;
}
doc.setDrawColor(60); doc.setLineWidth(0.6); doc.line(M, y, PW - M, y); doc.setLineWidth(0.2);
y += 4;
pageTop = y; // 2단일 때 첫 페이지 오른쪽 단도 제목 아래부터
const header = (i, e) => {
const g = effectiveGrade(e.problem);
const src = opts.showSource !== false ? `  ·  ${e.book?.name ?? ''} ${e.problem.number}번` : '';
return label(`${i + 1}번  [${g}등급]${src}`);
};
const solBlocks = (title, e) => [
label(title + (e.problem.answer ? `   정답 ${e.problem.answer}` : ''), 24, true, '#b03a2e'),
pic(e.solution) || label('(해설 없음)', 22, false, '#888'),
];
if (opts.mode === 'separate') {
entries.forEach((e, i) => { group([header(i, e), pic(e.problem)]); rule(); });
newPage();
place(label('정답 및 해설', 40));
entries.forEach((e, i) => { group(solBlocks(`${i + 1}번 해설`, e)); rule(); });
} else {
entries.forEach((e, i) => {
const prob = [header(i, e), pic(e.problem)].filter(Boolean);
const sol = solBlocks('해설', e).filter(Boolean);
const total = heightOf([...prob, ...sol]);
if (y + total > bottom && total <= bottom - pageTop && y > pageTop) nextCol();
group(prob);
group(sol);
rule();
});
}
if (opts.answerKey && entries.some((e) => e.problem.answer)) {
newPage();
place(label('빠른 정답', 40));
const perRow = cols === 2 ? 3 : 5;
for (let i = 0; i < entries.length; i += perRow) {
const row = entries.slice(i, i + perRow).map((e, k) => `${i + k + 1}. ${e.problem.answer ?? '-'}`).join('      ');
place(label(row, 26, false, '#111'));
}
}
divider();
return doc;
}
return { buildPdf };
})();
M.pipeline = (() => {
const db = M.db;
const { openPdf, renderPage } = M.pdfsource;
const { ocrCanvas } = M.ocr;
const { detectColumns } = M.layout;
const { segmentPages, textInFragments, matchSolutions, extractAnswer, extractPoints } = M.segment;
const { PageCache, pageId, trimFragments, cropFragments } = M.imaging;
const DEFAULT_OPTIONS = {
scale: 2,          // 렌더링 배율 (1 = 72dpi, 2 ≈ 144dpi)
top: 0.07,         // 머리말로 무시할 위쪽 비율
bottom: 0.06,      // 꼬리말로 무시할 아래쪽 비율
leftTol: 0.1,      // 번호가 단 왼쪽 끝에서 이 비율 안에 있어야 함
maxSkip: 3,        // 번호 건너뛰기 허용 폭
forceOcr: false,   // 텍스트가 있어도 OCR 강제
};
async function ingestPdf(book, kind, file, opts, log) {
const doc = await openPdf(file);
const metas = [];
for (let p = 1; p <= doc.numPages; p++) {
const { canvas, lines: textLines, hasText } = await renderPage(doc, p, opts.scale);
let lines = textLines, ocr = false;
if (!hasText || opts.forceOcr) {
log(`[${kind === 'problem' ? '문제' : '해설'}] ${p}/${doc.numPages} 쪽 OCR 중...`, p / doc.numPages);
lines = await ocrCanvas(canvas);
ocr = true;
} else {
log(`[${kind === 'problem' ? '문제' : '해설'}] ${p}/${doc.numPages} 쪽 (텍스트 PDF)`, p / doc.numPages);
}
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const columns = detectColumns(ctx.getImageData(0, 0, canvas.width, canvas.height), opts);
const meta = { id: pageId(book.id, kind, p), bookId: book.id, kind, index: p, width: canvas.width, height: canvas.height, columns, lines, ocr };
await db.put('pages', { ...meta, image: canvas.toDataURL('image/jpeg', 0.88) });
metas.push(meta);
canvas.width = canvas.height = 0; // 메모리 해제
}
return metas;
}
/** 저장된 페이지 정보로 문제 분리를 다시 수행 (옵션 변경 시에도 사용) */
async function segmentKind(book, kind, metas, log) {
const opts = { ...DEFAULT_OPTIONS, ...book.options, continuation: kind === 'solution' };
if (!metas) {
metas = (await db.byBook('pages', book.id))
.filter((p) => p.kind === kind)
.map(({ image, ...m }) => m)
.sort((a, b) => a.index - b.index);
}
const old = (await db.byBook('items', book.id)).filter((it) => it.kind === kind);
for (const it of old) await db.del('items', it.id);
const raw = segmentPages(metas, opts);
const pagesByIndex = new Map(metas.map((m) => [m.index, m]));
const cache = new PageCache();
const items = [];
for (let i = 0; i < raw.length; i++) {
const r = raw[i];
log && log(`[${kind === 'problem' ? '문제' : '해설'}] ${i + 1}/${raw.length} 자르는 중`, (i + 1) / raw.length);
const fragments = await trimFragments(cache, book.id, kind, r.fragments);
if (!fragments.length) continue;
const item = { id: db.uid(kind[0]), bookId: book.id, kind, section: r.section, number: r.number, fragments };
await finalizeItem(item, cache, pagesByIndex, opts.scale);
items.push(item);
}
await db.putMany('items', items);
return items;
}
/** 자르기 이미지 + 텍스트 + 부가정보 갱신 */
async function finalizeItem(item, cache, pagesByIndex, scale) {
const crop = await cropFragments(cache, item.bookId, item.kind, item.fragments);
Object.assign(item, crop || { image: null, w: 0, h: 0 });
if (!pagesByIndex) {
const idx = [...new Set(item.fragments.map((f) => f.page))];
const metas = (await Promise.all(idx.map((i) => db.get('pages', pageId(item.bookId, item.kind, i))))).filter(Boolean);
pagesByIndex = new Map(metas.map((m) => [m.index, m]));
}
item.text = textInFragments(pagesByIndex, item.fragments);
const pg = pagesByIndex.get(item.fragments[0]?.page);
item.pageHeight = pg ? pg.height : 1;
if (scale) item.scale = scale; // 렌더링 배율 (PDF 출력 시 원래 크기 복원용)
if (item.kind === 'problem') item.points = extractPoints(item.text);
else item.answer = extractAnswer(item.text);
return item;
}
/** 문제 ↔ 해설 연결 후 저장 */
async function relink(bookId) {
const items = await db.byBook('items', bookId);
const problems = items.filter((i) => i.kind === 'problem');
const solutions = items.filter((i) => i.kind === 'solution');
const matched = matchSolutions(problems, solutions);
const solById = new Map(solutions.map((s) => [s.id, s]));
for (const p of problems) {
const s = solById.get(p.solutionId);
if (!p.answerManual && !p.answerLLM) p.answer = s?.answer ?? null;
}
await db.putMany('items', problems);
return { problems: problems.length, solutions: solutions.length, matched };
}
async function ingestBook({ name, subject, level, problemFile, solutionFile, options }, log) {
const book = {
id: db.uid('b'), name, subject, level,
options: { ...DEFAULT_OPTIONS, ...options },
createdAt: new Date().toISOString(),
};
await db.put('books', book);
book.pageCounts = { problem: 0, solution: 0 };
const pm = await ingestPdf(book, 'problem', problemFile, book.options, log);
book.pageCounts.problem = pm.length;
await segmentKind(book, 'problem', pm, log);
if (solutionFile) {
const sm = await ingestPdf(book, 'solution', solutionFile, book.options, log);
book.pageCounts.solution = sm.length;
await segmentKind(book, 'solution', sm, log);
}
const stats = await relink(book.id);
book.stats = stats;
await db.put('books', book);
return book;
}
return { DEFAULT_OPTIONS, segmentKind, finalizeItem, relink, ingestBook };
})();
// ===== part2.js 끝 =====
