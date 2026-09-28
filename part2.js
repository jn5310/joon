// Math Finder part2.js — 이 줄부터 끝까지 전부 복사
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
* 페이지를 canvas로 렌더링하고 텍스트 레이어 조각을 함께 돌려준다.
* 줄 만들기(textItemsToLines)는 단(column)을 찾은 뒤에 해야 하므로 호출하는 쪽에서 한다.
*/
async function renderPage(doc, pageNo, scale) {
const page = await doc.getPage(pageNo);
const viewport = page.getViewport({ scale });
const canvas = document.createElement('canvas');
canvas.width = Math.ceil(viewport.width);
canvas.height = Math.ceil(viewport.height);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
if (!ctx) throw new Error('페이지가 너무 커서 그릴 수 없습니다. 고급 설정의 렌더링 배율을 낮춰 보세요.');
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
await page.render({ canvasContext: ctx, viewport }).promise;
let textItems = [];
try {
textItems = (await page.getTextContent()).items || [];
} catch (e) { /* 텍스트 없음 */ }
try { page.cleanup?.(); } catch { /* pdf.js 내부 캐시 정리 실패는 무시 */ }
const charCount = textItems.reduce((s, it) => s + String(it.str || '').replace(/\s/g, '').length, 0);
return { canvas, textItems, viewport, hasText: charCount >= 40 };
}
/**
* PDF 텍스트 조각을 줄로 묶는다. 먼저 기준선이 거의 같은 조각끼리 한 행으로 모은 뒤 왼쪽부터 읽으며,
* 단이 바뀌거나 간격이 크게 벌어지면 줄을 나눈다. 첫 낱말은 줄의 가장 왼쪽 조각에서 잡는다.
* (2단 편집에서 왼쪽·오른쪽 줄이 합쳐지거나 위첨자 때문에 문제 번호를 놓치던 문제 방지)
*/
function textItemsToLines(items, viewport, columns = null) {
const boxes = [];
for (const it of items) {
if (!it.str || !it.str.trim()) continue;
const [, , c, d, e, f] = it.transform;
const [x, yBase] = viewport.convertToViewportPoint(e, f);
const h = (it.height || Math.hypot(c, d)) * viewport.scale;
const w = it.width * viewport.scale;
if (!(h > 0) || !Number.isFinite(x) || !Number.isFinite(yBase)) continue;
boxes.push({ text: it.str, x0: x, y0: yBase - h, x1: x + w, y1: yBase });
}
boxes.sort((a, b) => (a.y1 - b.y1) || (a.x0 - b.x0));
const rows = [];
for (const b of boxes) {
const h = b.y1 - b.y0;
const r = rows[rows.length - 1];
if (r && b.y1 - r.maxY1 < Math.max(h, r.h) * 0.4) { r.items.push(b); r.maxY1 = b.y1; r.h = Math.max(r.h, h); }
else rows.push({ maxY1: b.y1, h, items: [b] });
}
const colOf = (x) => {
if (!columns?.length) return 0;
for (let i = 0; i < columns.length; i++) if (x < columns[i].x1) return i;
return columns.length - 1;
};
const lines = [];
const finish = ({ h, col, ...line }) => lines.push(line);
for (const r of rows) {
r.items.sort((a, b) => a.x0 - b.x0);
let cur = null;
for (const b of r.items) {
const h = b.y1 - b.y0;
const gap = cur ? b.x0 - cur.x1 : 0;
if (cur && colOf(b.x0) === cur.col && gap < Math.max(h, cur.h) * 3) {
cur.text += (gap > h * 0.2 ? ' ' : '') + b.text;
cur.x1 = Math.max(cur.x1, b.x1); cur.y0 = Math.min(cur.y0, b.y0); cur.y1 = Math.max(cur.y1, b.y1); cur.h = Math.max(cur.h, h);
} else {
if (cur) finish(cur);
const first = b.text.trim().split(/\s+/)[0];
const fw = (b.x1 - b.x0) * (first.length / Math.max(1, b.text.length));
cur = { text: b.text, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, h, col: colOf(b.x0), firstWord: { text: first, x0: b.x0, y0: b.y0, x1: b.x0 + fw, y1: b.y1 } };
}
}
if (cur) finish(cur);
}
return lines;
}
return { openPdf, renderPage, textItemsToLines };
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
s.onerror = () => { s.remove(); reject(new Error('Tesseract.js 로드 실패: ' + src)); };
document.head.appendChild(s);
});
}
function worker() {
if (!workerPromise) {
const p = (async () => {
await loadScript(TESS_URL);
return window.Tesseract.createWorker('kor+eng', 1);
})();
workerPromise = p;
p.catch(() => { if (workerPromise === p) workerPromise = null; }); // 실패한 로드는 기억하지 않고 다음에 다시 시도
}
return workerPromise;
}
/** canvas를 OCR 해서 lines [{text, x0,y0,x1,y1, firstWord}] 반환 */
async function ocrCanvas(canvas) {
let data;
try {
data = (await (await worker()).recognize(canvas)).data;
} catch (e) {
// 워커가 망가졌을 수 있으니 새로 띄워 한 번 더 시도한다
await terminateOcr();
data = (await (await worker()).recognize(canvas)).data;
}
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
/** OCR 워커를 끝내 메모리를 돌려준다. 로드에 실패했거나 이미 끝난 워커여도 안전하다 */
async function terminateOcr() {
const p = workerPromise;
workerPromise = null;
if (!p) return;
try { await (await p).terminate(); } catch { /* 이미 끝났거나 로드 실패 */ }
}
return { ocrCanvas, terminateOcr };
})();
M.llm = (() => {
const { loadImage } = M.imaging;
const { TYPE_LABELS, normalizeType } = M.classify;
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
유형(type)은 다음 목록에서 가장 알맞은 하나를 글자 그대로 고르세요: ${TYPE_LABELS.join(', ')}
반드시 아래 JSON 형식으로만 답하세요:
{"grade": 정수, "subject": "과목(${SUBJECTS.join('/')} 중 하나)", "unit": "단원명", "type": "유형(위 목록 중 하나)", "answer": "정답(알 수 있으면, 없으면 null)", "reason": "한 문장 근거"}`;
}
/** LLM에는 원본 포맷을 유지하고, 필요할 때만 고품질 무손실로 축소한다. */
async function shrink(dataURL, maxW = 1600) {
const im = await loadImage(dataURL);
const sourceMime = (dataURL.match(/^data:(image\/(?:png|jpe?g));base64,/)?.[1] || 'image/png').replace('jpg', 'jpeg');
const r = Math.min(1, maxW / im.naturalWidth);
if (r === 1) return { data: dataURL.split(',')[1], mime: sourceMime };
const c = document.createElement('canvas');
c.width = Math.max(1, Math.round(im.naturalWidth * r));
c.height = Math.max(1, Math.round(im.naturalHeight * r));
const ctx = c.getContext('2d');
ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
ctx.drawImage(im, 0, 0, c.width, c.height);
return { data: c.toDataURL('image/png').split(',')[1], mime: 'image/png' };
}
function parseJsonLoose(text) {
const m = text.match(/\{[\s\S]*\}/);
if (!m) throw new Error('JSON 응답 없음: ' + text.slice(0, 200));
const o = JSON.parse(m[0]);
const g = Math.round(Number(o.grade));
if (!(g >= 1 && g <= 9)) throw new Error('grade 범위 오류: ' + o.grade);
return {
grade: g, subject: o.subject || null, unit: o.unit || null, type: o.type == null || o.type === 'null' ? null : String(o.type),
answer: o.answer == null || o.answer === 'null' ? null : String(o.answer), reason: o.reason || '',
};
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
...images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } })),
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
...images.map((d) => ({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } })),
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
contents: [{ parts: [{ text: prompt }, ...images.map((d) => ({ inline_data: { mime_type: d.mime, data: d.data } }))] }],
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
body: JSON.stringify({ model, stream: false, format: 'json', messages: [{ role: 'user', content: prompt, images: images.map((d) => d.data) }] }),
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
const r = await call(cfg, prompt, images);
const subject = r.subject || subjectHint;
r.type = normalizeType(r.type, subject) || normalizeType(r.unit, subject);
return r;
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
s.onerror = () => { s.remove(); reject(new Error('jsPDF 로드 실패')); };
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
const PW = 210, PH = 297, MARGIN = 14, GUT = 8;
const cols = opts.columns === 2 ? 2 : 1;
const colW = (PW - 2 * MARGIN - (cols - 1) * GUT) / cols;
const bottom = PH - MARGIN - 6;
const zoom = opts.zoom || 1;
let pageNo = 1, col = 0, y = MARGIN, pageTop = MARGIN;
const colX = (c) => MARGIN + c * (colW + GUT);
const fullH = () => bottom - MARGIN;
const decorate = () => {
doc.setFontSize(9); doc.setTextColor(120);
doc.text(String(pageNo), PW / 2, PH - MARGIN / 2, { align: 'center' });
};
const divider = () => {
if (cols === 2) { doc.setDrawColor(200); doc.line(PW / 2, pageTop, PW / 2, bottom); }
};
const newPage = () => { divider(); doc.addPage(); pageNo++; col = 0; pageTop = MARGIN; y = MARGIN; decorate(); };
const nextCol = () => { if (++col >= cols) newPage(); else y = pageTop; };
const label = (text, size = 26, bold = true, color = '#1f3a93') => {
const t = textImage(text, { size, bold, color });
const h = size * 0.2; // mm
return { image: t.image, fmt: 'PNG', h, w: Math.min(colW, (t.w / t.h) * h) };
};
const pic = (item) => {
if (!item?.image || !(item.w > 0) || !(item.h > 0)) return null;
const s = item.scale > 0 ? item.scale : 2;
let w = (item.w / s) * PX_TO_MM * zoom;
let h = (item.h / s) * PX_TO_MM * zoom;
if (w > colW) { h *= colW / w; w = colW; }
if (h > fullH()) { w *= fullH() / h; h = fullH(); }
const fmt = item.imageFormat || (item.image.startsWith('data:image/png') ? 'PNG' : 'JPEG');
return { image: item.image, fmt, w, h };
};
const heightOf = (blocks) => blocks.reduce((s, b) => s + b.h + 1.5, 0);
const place = (b) => {
if (y + b.h > bottom && y > pageTop) nextCol();
// 첫 쪽처럼 제목 아래에서 시작해 단 높이가 모자라면 비율을 지킨 채 남은 높이에 맞춘다
if (y + b.h > bottom) { const k = Math.max(0.1, (bottom - y) / b.h); b = { ...b, w: b.w * k, h: b.h * k }; }
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
doc.addImage(t1.image, 'PNG', MARGIN, y, Math.min(PW - 2 * MARGIN, (t1.w / t1.h) * th), th);
y += th + 1;
if (opts.subtitle) {
const t2 = textImage(opts.subtitle, { size: 30, color: '#555' });
const sh = 6;
doc.addImage(t2.image, 'PNG', MARGIN, y, Math.min(PW - 2 * MARGIN, (t2.w / t2.h) * sh), sh);
y += sh + 2;
}
doc.setDrawColor(60); doc.setLineWidth(0.6); doc.line(MARGIN, y, PW - MARGIN, y); doc.setLineWidth(0.2);
y += 4;
pageTop = y; // 2단일 때 첫 페이지 오른쪽 단도 제목 아래부터
const header = (i, e) => {
const g = effectiveGrade(e.problem);
const num = e.problem.section > 1 ? `${e.problem.section}-${e.problem.number}` : e.problem.number;
const src = opts.showSource !== false ? `  ·  ${e.book?.name ?? ''} ${num}번` : '';
return label(`${i + 1}번  [${g ?? '-'}등급]${src}`);
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
const { openPdf, renderPage, textItemsToLines } = M.pdfsource;
const { ocrCanvas, terminateOcr } = M.ocr;
const { detectColumns } = M.layout;
const { segmentPages, textInFragments, matchSolutions, extractAnswer, extractPoints, itemKey } = M.segment;
const { PageCache, pageId, trimFragments, cropFragments } = M.imaging;
const DEFAULT_OPTIONS = {
scale: 2,          // 렌더링 배율 (1 = 72dpi, 2 ≈ 144dpi)
top: 0.07,         // 머리말로 무시할 위쪽 비율
bottom: 0.06,      // 꼬리말로 무시할 아래쪽 비율
leftTol: 0.1,      // 번호가 단 왼쪽 끝에서 이 비율 안에 있어야 함
maxSkip: 3,        // 번호 건너뛰기 허용 폭
forceOcr: false,   // 텍스트가 있어도 OCR 강제
};
/** 명확한 사진성 질감만 JPEG로 저장하고, 그래프·도형처럼 애매한 페이지는 PNG를 우선한다. */
function encodeRenderedPage(canvas, imageData) {
let sampled = 0, midtone = 0, softChanges = 0, comparisons = 0;
const toneBins = new Set(), colorBins = new Set();
const step = Math.max(1, Math.floor(Math.sqrt((imageData.width * imageData.height) / 50000)));
for (let y = 0; y < imageData.height; y += step) {
let previousLum = null;
for (let x = 0; x < imageData.width; x += step) {
const i = (y * imageData.width + x) * 4;
const r = imageData.data[i], g = imageData.data[i + 1], b = imageData.data[i + 2];
const lum = (r * 299 + g * 587 + b * 114) / 1000;
if (lum > 40 && lum < 245) midtone++;
toneBins.add(Math.floor(lum / 8));
colorBins.add((r >> 4) << 8 | (g >> 4) << 4 | (b >> 4));
if (previousLum != null) {
const delta = Math.abs(lum - previousLum);
if (delta >= 3 && delta <= 48) softChanges++;
comparisons++;
}
previousLum = lum;
sampled++;
}
}
const midtoneRatio = midtone / sampled;
const textureRatio = comparisons ? softChanges / comparisons : 0;
const photographic = midtoneRatio > 0.12 && textureRatio > 0.12 && (
colorBins.size > 96 || toneBins.size > 24
);
return photographic
? { image: canvas.toDataURL('image/jpeg', 0.95), imageFormat: 'JPEG' }
: { image: canvas.toDataURL('image/png'), imageFormat: 'PNG' };
}
async function ingestPdf(book, kind, file, opts, log, control) {
const doc = await openPdf(file);
const metas = [];
if (control) {
control.activeKind = kind;
control.acceptingStops = true;
control.onStateChange?.();
}
try {
for (let p = 1; p <= doc.numPages; p++) {
// 이미 중지가 요청됐다면 새 페이지를 시작하지 않는다.
if (control?.stopRequested) break;
const { canvas, textItems, viewport, hasText } = await renderPage(doc, p, opts.scale);
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const pageImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
const columns = detectColumns(pageImageData, opts);
let lines, ocr = false;
if (!hasText || opts.forceOcr) {
log(`[${kind === 'problem' ? '문제' : '해설'}] ${p}/${doc.numPages} 쪽 OCR 중...`, p / doc.numPages);
lines = await ocrCanvas(canvas);
ocr = true;
} else {
log(`[${kind === 'problem' ? '문제' : '해설'}] ${p}/${doc.numPages} 쪽 (텍스트 PDF)`, p / doc.numPages);
lines = textItemsToLines(textItems, viewport, columns); // 단 경계를 넘어 줄이 합쳐지지 않도록
}
const encoded = encodeRenderedPage(canvas, pageImageData);
const meta = { id: pageId(book.id, kind, p), bookId: book.id, kind, index: p, width: canvas.width, height: canvas.height, columns, lines, ocr, imageFormat: encoded.imageFormat };
await db.put('pages', { ...meta, image: encoded.image });
metas.push(meta);
// 쪽마다 진행 상황을 저장해 두면, 오류나 탭 종료로 끊겨도 저장된 쪽까지 검토·다시 분리할 수 있다
book.pageCounts[kind] = metas.length;
if (book.ingest) book.ingest.updatedAt = Date.now();
await db.put('books', book);
canvas.width = canvas.height = 0; // 메모리 해제
// 진행 중이던 페이지는 온전히 저장한 뒤에만 멈춘다.
if (control?.stopRequested) break;
}
} finally {
if (control) {
control.acceptingStops = false;
control.onStateChange?.();
}
try { await doc.destroy?.(); } catch { /* 이미 정리됨 */ }
}
return { metas, totalPages: doc.numPages, stopped: !!control?.stopRequested };
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
// 옮겨 줄 판정값만 기억한다 (이미지는 버려 메모리 절약)
const old = (await db.byBook('items', book.id)).filter((it) => it.kind === kind).map(({ image, ...rest }) => rest);
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
// 다시 분리해도 같은 번호 문제에 매긴 난이도·유형(직접 지정·AI)과 직접 고친 정답은 유지한다
const oldByKey = new Map(old.map((it) => [itemKey(it), it]));
for (const item of items) {
const prev = oldByKey.get(itemKey(item));
if (!prev) continue;
for (const k of KEEP_ON_RESEGMENT) if (prev[k] != null) item[k] = prev[k];
if (prev.answerManual || prev.answerLLM) Object.assign(item, { answer: prev.answer, answerManual: prev.answerManual, answerLLM: prev.answerLLM });
}
// 새 항목을 다 만든 뒤 한 번에 바꾼다. 중간에 실패하면 기존 항목이 그대로 남는다
await db.replaceItems(book.id, kind, items, old.map((it) => it.id));
// 이 종류는 나누기를 마쳤다고 기록한다 (번호를 하나도 못 찾아 0개여도 "아직 안 나눔"과 구분)
book.segmented = { ...(book.segmented || {}), [kind]: true };
await db.update('books', book.id, (f) => { f.segmented = book.segmented; });
return items;
}
const KEEP_ON_RESEGMENT = ['gradeManual', 'gradeLLM', 'unit', 'subjectLLM', 'llmReason', 'typeLLM', 'typeManual'];
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
// 렌더링 배율 (PDF 출력 시 원래 크기 복원용). 너무 커서 줄인 이미지는 그만큼 반영한다
if (scale) item.scale = scale * (item.sizeFactor || 1);
delete item.sizeFactor;
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
const link = new Map(problems.map((p) => [p.id, p.solutionId]));
const answerOf = new Map(solutions.map((s) => [s.id, s.answer ?? null]));
// 연결·정답만 고쳐 쓴다 (그사이 AI 판정이나 직접 지정한 값을 덮어쓰지 않도록 저장 직전 기록에 반영)
await db.updateMany('items', problems.map((p) => p.id), (fresh) => {
fresh.solutionId = link.get(fresh.id) ?? null;
if (!fresh.answerManual && !fresh.answerLLM) fresh.answer = fresh.solutionId ? answerOf.get(fresh.solutionId) ?? null : null;
});
return { problems: problems.length, solutions: solutions.length, matched };
}
async function ingestBook({ name, subject, level, problemFile, solutionFile, options }, log, control) {
const book = {
id: db.uid('b'), name, subject, level,
options: { ...DEFAULT_OPTIONS, ...options },
createdAt: new Date().toISOString(),
pageCounts: { problem: 0, solution: 0 },
ingest: { status: 'processing', stoppedAt: null, updatedAt: Date.now() },
};
if (control) control.bookId = book.id; // 화면에서 "처리 중"과 "끊긴 책"을 구분하는 데 쓴다
await db.put('books', book);
let phase = 'problem';
// 다른 창에서도 "아직 처리 중"임을 알 수 있게 1분마다 살아 있다는 표시를 남긴다
const heartbeat = setInterval(() => {
if (book.ingest?.status !== 'processing') return;
book.ingest.updatedAt = Date.now();
db.put('books', book).catch(() => {});
}, 60000);
try {
const problemResult = await ingestPdf(book, 'problem', problemFile, book.options, log, control);
book.pageCounts.problem = problemResult.metas.length;
await db.put('books', book); // 후처리 실패 시에도 실제 수집 페이지 수를 보존
await segmentKind(book, 'problem', problemResult.metas, log);

let stoppedAt = problemResult.stopped ? {
kind: 'problem', processedPages: problemResult.metas.length, totalPages: problemResult.totalPages,
} : null;
if (!stoppedAt && solutionFile) {
phase = 'solution';
const solutionResult = await ingestPdf(book, 'solution', solutionFile, book.options, log, control);
book.pageCounts.solution = solutionResult.metas.length;
await db.put('books', book);
await segmentKind(book, 'solution', solutionResult.metas, log);
if (solutionResult.stopped) stoppedAt = {
kind: 'solution', processedPages: solutionResult.metas.length, totalPages: solutionResult.totalPages,
};
}

const stats = await relink(book.id);
book.stats = stats;
book.ingest = { status: stoppedAt ? 'stopped' : 'complete', stoppedAt };
await db.put('books', book);
return book;
} catch (e) {
// 실패해도 저장된 쪽까지는 남긴다. 검토 탭의 "다시 분리"로 이어서 쓸 수 있다
book.ingest = { status: 'error', error: String(e?.message || e), stoppedAt: { kind: phase, processedPages: book.pageCounts[phase] || 0, totalPages: null } };
try { await db.put('books', book); } catch { /* 저장 공간 부족 등으로 기록도 실패할 수 있음 */ }
e.bookId = book.id;
throw e;
} finally {
clearInterval(heartbeat);
await terminateOcr(); // OCR 워커 메모리 해제 (다음 처리 때 다시 띄운다)
}
}
/** 다른 창에서 처리 중인 책인지 판단할 때 쓰는 기준 (이보다 오래 소식이 없으면 끊긴 것으로 본다) */
const HEARTBEAT_STALE_MS = 5 * 60000;
return { DEFAULT_OPTIONS, HEARTBEAT_STALE_MS, segmentKind, finalizeItem, relink, ingestBook };
})();
// ===== part2.js 끝 =====
