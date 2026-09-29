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
/** Tesseract 버전/출력 옵션이 달라도 line geometry를 한 형식으로 맞춘다. */
function nestedLines(data) {
const out = [];
for (const b of data?.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) out.push(l);
return out;
}
function wordsToLines(words) {
const sorted = (words || []).filter((w) => w?.bbox && String(w.text || '').trim()).slice()
.sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
const rows = [];
for (const w of sorted) {
const h = Math.max(1, w.bbox.y1 - w.bbox.y0), cy = (w.bbox.y0 + w.bbox.y1) / 2;
let row = rows.find((r) => Math.abs(r.cy - cy) < Math.max(r.h, h) * 0.55);
if (!row) { row = { cy, h, words: [] }; rows.push(row); }
row.words.push(w); row.cy = (row.cy * (row.words.length - 1) + cy) / row.words.length; row.h = Math.max(row.h, h);
}
return rows.map((r) => {
r.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);
return { words: r.words, text: r.words.map((w) => w.text).join(' '), bbox: {
x0: Math.min(...r.words.map((w) => w.bbox.x0)), y0: Math.min(...r.words.map((w) => w.bbox.y0)),
x1: Math.max(...r.words.map((w) => w.bbox.x1)), y1: Math.max(...r.words.map((w) => w.bbox.y1)),
} };
});
}
function normalizeOcrData(data, source = 'ocr', mapPoint = (x, y) => ({ x, y })) {
let raw = data?.lines?.length ? data.lines : nestedLines(data);
if (!raw.length && data?.words?.length) raw = wordsToLines(data.words);
const lines = [];
for (const ln of raw) {
const words = (ln.words || []).filter((w) => w?.bbox && String(w.text || '').trim()).slice().sort((a, b) => a.bbox.x0 - b.bbox.x0);
const text = String(ln.text || words.map((w) => w.text).join(' ')).trim();
const box = ln.bbox || (words.length ? {
x0: Math.min(...words.map((w) => w.bbox.x0)), y0: Math.min(...words.map((w) => w.bbox.y0)),
x1: Math.max(...words.map((w) => w.bbox.x1)), y1: Math.max(...words.map((w) => w.bbox.y1)),
} : null);
if (!text || !box) continue;
const p0 = mapPoint(box.x0, box.y0), p1 = mapPoint(box.x1, box.y1);
const first = words[0];
let fw;
if (first) {
const a = mapPoint(first.bbox.x0, first.bbox.y0), b = mapPoint(first.bbox.x1, first.bbox.y1);
fw = { text: first.text, x0: a.x, y0: a.y, x1: b.x, y1: b.y };
} else {
const firstText = text.split(/\s+/)[0];
fw = { text: firstText, x0: p0.x, y0: p0.y, x1: p0.x + (p1.x - p0.x) * firstText.length / Math.max(1, text.length), y1: p1.y };
}
lines.push({ text, x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y, firstWord: fw, confidence: ln.confidence ?? (words.length ? words.reduce((s, w) => s + (w.confidence || 0), 0) / words.length : null), source });
}
return lines.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
}
async function recognize(canvas) {
try { return (await (await worker()).recognize(canvas)).data; }
catch (e) {
// 워커가 망가졌을 수 있으니 새로 띄워 한 번 더 시도한다
await terminateOcr();
return (await (await worker()).recognize(canvas)).data;
}
}
/** canvas를 OCR 해서 정규화된 lines 반환 */
async function ocrCanvas(canvas) {
return normalizeOcrData(await recognize(canvas));
}
/**
* 전체 OCR에서 번호를 하나도 못 찾은 페이지는 각 단의 왼쪽 번호 영역(lane)만 잘라 한 번 더 OCR한다.
* 본문·수식의 방해가 줄어 작은 숫자/배지의 재현율이 올라간다.
* 단마다 따로 OCR한다: 여러 단을 옆으로 붙이면 같은 높이의 왼쪽·오른쪽 번호가 한 줄로 합쳐져 오른쪽 번호를 잃는다.
*/
async function ocrNumberStrips(canvas, columns) {
if (!columns?.length) return [];
const zoom = 1.35;
const out = [];
for (const col of columns) {
const x0 = Math.max(0, Math.floor(col.x0 - 6));
const x1 = Math.min(canvas.width, Math.ceil(col.x0 + (col.x1 - col.x0) * 0.34 + 6));
const w = x1 - x0;
if (w < 4) continue;
const c = document.createElement('canvas');
c.width = Math.max(1, Math.round(w * zoom)); c.height = Math.max(1, Math.round(canvas.height * zoom));
const ctx = c.getContext('2d');
if (!ctx) continue;
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
ctx.drawImage(canvas, x0, 0, w, canvas.height, 0, 0, c.width, c.height);
const kx = w / c.width, ky = canvas.height / c.height;
try {
out.push(...normalizeOcrData(await recognize(c), 'number-strip', (x, y) => ({ x: x0 + Math.max(0, Math.min(w, x * kx)), y: y * ky })));
} finally { c.width = c.height = 0; }
}
return out.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
}
/**
* primary 줄 목록에 extra 줄을 더한다. 겹치는 줄은 primary를 그대로 두고(텍스트 PDF면 정확한 글자층이 primary),
* extra가 primary 줄 바로 왼쪽의 문제 번호를 읽어 냈으면 그 번호만 줄 첫머리에 붙인다 (그림으로 된 번호·배지).
*/
function mergeLines(primary, extra) {
const out = primary.slice();
const anchorOf = (l) => M.segment?.parseAnchor?.(l) || null;
for (const ln of extra) {
const h = Math.max(1, ln.y1 - ln.y0);
const at = out.findIndex((x) => {
const xh = Math.max(1, x.y1 - x.y0);
const overlapY = Math.min(x.y1, ln.y1) - Math.max(x.y0, ln.y0) > 0.4 * Math.min(xh, h);
const nearX = Math.abs(x.x0 - ln.x0) < Math.max(10, xh * 2) || (ln.x0 < x.x1 && ln.x1 > x.x0);
return overlapY && nearX;
});
if (at < 0) { out.push(ln); continue; }
const body = out[at];
const num = anchorOf(ln);
const fw = ln.firstWord || { text: String(ln.text).split(/\s+/)[0], x0: ln.x0, y0: ln.y0, x1: ln.x0 + h, y1: ln.y1 };
const bfw = body.firstWord || body;
// 번호 영역 OCR(strip)은 번호만 따로 읽은 것이라 줄 첫머리와 겹쳐도 되지만, 일반 OCR은 번호가 원래 글자보다 완전히 왼쪽에 있을 때만
// 붙인다 (첫 글자를 숫자로 잘못 읽은 OCR이 정확한 텍스트 줄을 바꾸지 않도록).
const leftOf = ln.source === 'number-strip' ? fw.x0 <= bfw.x0 + Math.max(4, h * 0.5) : fw.x1 <= bfw.x0 + 2;
if (num && !anchorOf(body) && leftOf) {
const token = String(num.token || fw.text).trim();
out[at] = { ...body, text: `${token} ${body.text}`, x0: Math.min(fw.x0, body.x0), y0: Math.min(fw.y0, body.y0), y1: Math.max(fw.y1, body.y1), firstWord: { ...fw, text: token }, confidence: ln.confidence ?? body.confidence, source: ln.source || body.source };
}
}
return out.sort((a, b) => (a.y0 - b.y0) || (a.x0 - b.x0));
}
/** OCR 워커를 끝내 메모리를 돌려준다. 로드에 실패했거나 이미 끝난 워커여도 안전하다 */
async function terminateOcr() {
const p = workerPromise;
workerPromise = null;
if (!p) return;
try { await (await p).terminate(); } catch { /* 이미 끝났거나 로드 실패 */ }
}
return { ocrCanvas, ocrNumberStrips, mergeLines, normalizeOcrData, terminateOcr };
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
async function shrink(source, maxW = 1600) {
const im = await loadImage(source);
const sourceMime = source instanceof Blob ? (source.type || 'image/png')
: typeof source === 'string' ? (source.match(/^data:(image\/(?:png|jpe?g));base64,/)?.[1] || 'image/png').replace('jpg', 'jpeg')
: source?.type || 'image/png';
const r = Math.min(1, maxW / im.naturalWidth);
if (r === 1) return { data: (await M.assets.asDataURL(source)).split(',')[1], mime: sourceMime };
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
// jsPDF는 Blob/외부 폴더 참조를 직접 못 읽으므로 선택된 문제만 이 시점에 data URL로 변환한다.
const materialize = async (item) => item?.image != null && typeof item.image !== 'string'
? { ...item, image: await M.assets.asDataURL(item.image) } : item;
entries = await Promise.all(entries.map(async (e) => ({ ...e, problem: await materialize(e.problem), solution: await materialize(e.solution) })));
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
const fmt = item.imageFormat || (typeof item.image === 'string' && item.image.startsWith('data:image/png') ? 'PNG' : 'JPEG');
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
const num = e.problem.label || e.problem.section > 1 ? M.segment.itemKey(e.problem) : e.problem.number;
const src = opts.showSource !== false ? `  ·  ${e.book?.name ?? ''} ${num}번` : '';
return label(`${i + 1}번  [${g ?? '-'}등급]${src}`);
};
const solBlocks = (title, e) => [
label(title + (e.solution && e.problem.solutionInferred ? ' (번호로 추정한 연결 · 확인 필요)' : '') + (e.problem.answer ? `   정답 ${e.problem.answer}` : ''), 24, true, '#b03a2e'),
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
const { ocrCanvas, ocrNumberStrips, mergeLines, terminateOcr } = M.ocr;
const { detectColumns, detectBlockStarts, columnInkBottoms } = M.layout;
const { segmentPages, findCandidates, selectAnchors, textInFragments, matchSolutions, matchPrevious, extractAnswer, extractPoints } = M.segment;
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
async function encodeRenderedPage(canvas, imageData, asset) {
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
const type = photographic ? 'image/jpeg' : 'image/png';
const format = photographic ? 'JPEG' : 'PNG';
const blob = await M.assets.canvasToBlob(canvas, type, photographic ? 0.92 : undefined);
return { image: await M.assets.storeImage(blob, asset), imageId: db.uid('i'), imageFormat: format, imageBytes: blob.size };
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
const visualStarts = detectBlockStarts(pageImageData, columns, opts);
const inkBottoms = columnInkBottoms(pageImageData, columns, opts);
const textLines = textItemsToLines(textItems, viewport, columns);
const basePage = { index: p, width: canvas.width, height: canvas.height, columns, lines: textLines, visualStarts, ocr: false };
// OCR이 필요한지는 "받아들여진 문제 번호"로 판단한다. 선택지 줄(①…⑤)·소문항·본문 숫자 후보는 번호가 아니다.
const accepted = (page) => selectAnchors(findCandidates(page, opts), opts).length;
const label = kind === 'problem' ? '문제' : '해설';
let lines = textLines, ocr = false, stripRetried = false, ocrSkipped = false;
// 텍스트층이 있어도 문제 번호를 하나도 받아들이지 못하면 번호가 그림이거나 숨은/깨진 텍스트층일 수 있으므로 OCR로 보완한다.
if (!hasText || opts.forceOcr || (accepted(basePage) === 0 && !control?.ocrUnavailable)) {
log(`[${label}] ${p}/${doc.numPages} 쪽 OCR 중...`, p / doc.numPages);
try {
const ocrLines = await ocrCanvas(canvas);
// 텍스트 PDF는 정확한 글자층을 그대로 두고, OCR에서는 글자층에 없는 줄과 그림으로 된 번호만 더한다
lines = hasText ? mergeLines(textLines, ocrLines) : ocrLines;
ocr = true;
// 번호를 거의 못 읽었으면(여백으로 찾은 문제 시작의 절반 미만) 단마다 번호 자리만 잘라 한 번 더 읽는다
if (visualStarts.length && accepted({ ...basePage, lines, ocr: true }) < Math.ceil(visualStarts.length / 2)) {
log(`[${label}] ${p}/${doc.numPages} 쪽 번호 영역 정밀 OCR 중...`, p / doc.numPages);
lines = mergeLines(lines, await ocrNumberStrips(canvas, columns));
stripRetried = true;
}
} catch (e) {
// 스캔 쪽은 OCR 없이는 글자가 없고, 'OCR 강제'는 사용자가 직접 요청한 것이므로 실패로 알린다.
// 자동 보완으로 시도한 텍스트 PDF 쪽만 글자층으로 계속한다 (예: 번호 없는 개념 설명 쪽).
if (!hasText || opts.forceOcr) throw e;
ocrSkipped = true;
if (control) control.ocrUnavailable = true; // 같은 처리 중에는 다시 내려받으려 하지 않는다
log(`[${label}] ${p}/${doc.numPages} 쪽: OCR 프로그램을 쓸 수 없어 텍스트층만 사용합니다.`, p / doc.numPages);
}
} else {
log(`[${label}] ${p}/${doc.numPages} 쪽 (텍스트 PDF)`, p / doc.numPages);
}
const encoded = await encodeRenderedPage(canvas, pageImageData, { bookId: book.id, role: `page-${kind}`, id: p });
// lexicalCandidates: 이 쪽에서 받아들여진 문제 번호 수 (검토 화면의 "번호 OCR이 약한 페이지" 안내에 쓴다)
const diagnostics = { lineCount: lines.length, lexicalCandidates: accepted({ ...basePage, lines, ocr }), visualCandidates: visualStarts.length, stripRetried, ...(ocrSkipped ? { ocrSkipped } : {}) };
const meta = { id: pageId(book.id, kind, p), bookId: book.id, kind, index: p, width: canvas.width, height: canvas.height, columns, lines, visualStarts, inkBottoms, diagnostics, ocr, imageFormat: encoded.imageFormat, imageBytes: encoded.imageBytes };
try { await db.put('pages', { ...meta, image: encoded.image, imageId: encoded.imageId }); }
catch (e) { await M.assets.removeRef(encoded.image); throw e; } // 기록하지 못한 쪽의 외부 파일은 남기지 않는다
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
// kind: 해설은 단을 넘긴 풀이를 늘 이어 붙이고, 문제는 개념 설명 단을 문제로 만들지 않는 등 규칙이 조금 다르다
const opts = { ...DEFAULT_OPTIONS, ...book.options, continuation: true, kind };
if (!metas) {
const stored = (await db.byBook('pages', book.id)).filter((p) => p.kind === kind);
// 백업에서 이미지가 빠진 쪽이 있으면 그 쪽의 문제를 잘라낼 수 없으므로, 기존 분리 결과를 지키고 다시 분리하지 않는다
const missing = stored.filter((p) => p.image == null).map((p) => p.index).sort((a, b) => a - b);
if (missing.length) throw new Error(`이미지가 없는 쪽(${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}쪽)이 있어 다시 분리하지 않았습니다. 기존 문제는 그대로 남아 있습니다. 온전한 백업을 가져오거나 책을 다시 추가하세요.`);
metas = stored.map(({ image, ...m }) => m).sort((a, b) => a.index - b.index);
}
// 옮겨 줄 판정값만 기억한다 (이미지는 버려 메모리 절약). 외부 폴더 파일 참조는 교체 뒤 지우려고 남긴다
const old = (await db.byBook('items', book.id)).filter((it) => it.kind === kind)
.map(({ image, ...rest }) => ({ ...rest, oldRef: M.assets.isRef(image) ? image : null }));
const cache = new PageCache(3);
// 이전 버전에서 저장한 페이지에는 시각 경계가 없다. 다시 PDF/OCR을 돌리지 않고 저장된 페이지 이미지에서 보완한다.
for (const m of metas) {
if (Array.isArray(m.visualStarts) && Array.isArray(m.inkBottoms)) continue;
const pg = await cache.get(pageId(book.id, kind, m.index));
if (!pg) { if (!Array.isArray(m.visualStarts)) m.visualStarts = []; continue; }
const cols = m.columns || [{ x0: 0, x1: m.width }];
if (!Array.isArray(m.visualStarts)) {
m.visualStarts = detectBlockStarts(pg.imageData, cols, opts);
m.diagnostics = { ...(m.diagnostics || {}), visualCandidates: m.visualStarts.length, upgradedVisualLayout: true };
}
m.inkBottoms = columnInkBottoms(pg.imageData, cols, opts);
await db.update('pages', m.id, (fresh) => { fresh.visualStarts = m.visualStarts; fresh.inkBottoms = m.inkBottoms; fresh.diagnostics = m.diagnostics; });
}
const raw = segmentPages(metas, opts);
const pagesByIndex = new Map(metas.map((m) => [m.index, m]));
const items = [];
// 새 항목의 외부 파일은 교체가 확정되기 전까지 임시다. 어떤 이유로든 교체하지 못하면 지운다 (기존 항목의 파일은 건드리지 않음)
const discardNew = () => M.assets.removeRefs(items.map((it) => it.image).filter(M.assets.isRef));
try {
for (let i = 0; i < raw.length; i++) {
const r = raw[i];
log && log(`[${kind === 'problem' ? '문제' : '해설'}] ${i + 1}/${raw.length} 자르는 중`, (i + 1) / raw.length);
const fragments = await trimFragments(cache, book.id, kind, r.fragments);
if (!fragments.length) continue;
const item = { id: db.uid(kind[0]), bookId: book.id, kind, section: r.section, number: r.number, ...(r.label ? { label: r.label } : {}), detection: r.detection, fragments };
items.push(item);
await finalizeItem(item, cache, pagesByIndex, opts.scale);
}
// 다시 분리해도 같은 문제에 매긴 난이도·유형(직접 지정·AI)과 직접 고친 정답은 유지한다.
// 추정 번호는 분석마다 달라질 수 있어 번호가 아니라 페이지 위치로 같은 문제를 찾는다.
const prevOf = matchPrevious(old, items);
for (const item of items) {
const prev = prevOf.get(item);
if (!prev) continue;
for (const k of KEEP_ON_RESEGMENT) if (prev[k] != null) item[k] = prev[k];
if (prev.answerManual || prev.answerLLM) Object.assign(item, { answer: prev.answer, answerManual: prev.answerManual, answerLLM: prev.answerLLM });
// 사용자가 검토 화면에서 직접 고친 번호도 같은 자리의 문제에 그대로 둔다
if (prev.detection?.numberManual) {
const { ocrNumber, ...rest } = item.detection || {};
Object.assign(item, { section: prev.section, number: prev.number, detection: { ...rest, inferred: false, numberManual: true } });
if (prev.label) item.label = prev.label; else delete item.label;
}
}
// 결과가 기존의 25% 아래로 급감하면 잘못된 설정/분석일 가능성이 높으므로 기존 결과를 지킨다.
if (old.length >= 8 && items.length < old.length * 0.25) {
throw new Error(`새 분리 결과가 ${items.length}개로 기존 ${old.length}개의 25%보다 적어 교체하지 않았습니다. OCR·레이아웃 분석을 다시 확인하세요.`);
}
// 새 항목을 다 만든 뒤 한 번에 바꾼다. 중간에 실패하면 기존 항목이 그대로 남는다
await db.replaceItems(book.id, kind, items, old.map((it) => it.id));
} catch (e) {
await discardNew().catch(() => {});
throw e;
}
// 교체가 저장된 뒤에만 옛 항목의 외부 파일을 지운다
await M.assets.removeRefs(old.map((it) => it.oldRef).filter(Boolean)).catch(() => {});
// 이 종류는 나누기를 마쳤다고 기록한다 (번호를 하나도 못 찾아 0개여도 "아직 안 나눔"과 구분)
book.segmented = { ...(book.segmented || {}), [kind]: true };
await db.update('books', book.id, (f) => { f.segmented = book.segmented; });
return items;
}
const KEEP_ON_RESEGMENT = ['gradeManual', 'gradeLLM', 'unit', 'subjectLLM', 'llmReason', 'typeLLM', 'typeManual'];
/** 원본 이미지가 없는 쪽(백업에서 빠진 쪽)에 걸친 항목을 다시 자르려 할 때의 오류. 기존 자르기는 그대로 둔다 */
class PageImageMissingError extends Error {
constructor(pages) {
super(`원본 이미지가 없는 쪽(${pages.join(', ')}쪽)에 걸친 항목이라 영역을 다시 자를 수 없습니다. 기존 이미지는 그대로 두었습니다. (번호·난이도·유형은 고칠 수 있습니다)`);
this.name = 'PageImageMissingError'; this.pages = pages;
}
}
/** 이 조각들이 걸친 쪽 가운데 원본 이미지가 없는 쪽 번호 */
async function pagesWithoutImage(bookId, kind, fragments) {
const idx = [...new Set((fragments || []).map((f) => f.page))].sort((a, b) => a - b);
const recs = await Promise.all(idx.map((i) => db.get('pages', pageId(bookId, kind, i)).catch(() => null)));
return idx.filter((i, k) => recs[k]?.image == null);
}
/** 자르기 이미지 + 텍스트 + 부가정보 갱신 */
async function finalizeItem(item, cache, pagesByIndex, scale) {
// 이미 이미지가 있는 항목(검토 화면에서 고치는 경우)은 모든 쪽의 원본이 있을 때만 다시 자른다: 빠진 쪽의 부분이 사라지지 않도록
if (item.image != null) {
const missing = await pagesWithoutImage(item.bookId, item.kind, item.fragments);
if (missing.length) throw new PageImageMissingError(missing);
}
const crop = await cropFragments(cache, item.bookId, item.kind, item.fragments, `${item.section}-${item.number}`);
Object.assign(item, crop || { image: null, imageId: db.uid('i'), w: 0, h: 0 });
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
const link = new Map(problems.map((p) => [p.id, { id: p.solutionId, inferred: !!p.solutionInferred }]));
const answerOf = new Map(solutions.map((s) => [s.id, s.answer ?? null]));
// 연결·정답만 고쳐 쓴다 (그사이 AI 판정이나 직접 지정한 값을 덮어쓰지 않도록 저장 직전 기록에 반영)
// 추정 번호로 이은 연결(확인 필요)은 정답을 자동으로 옮기지 않는다 (틀린 해설의 정답이 빠른 정답표에 들어가지 않도록)
await db.updateMany('items', problems.map((p) => p.id), (fresh) => {
const l = link.get(fresh.id);
fresh.solutionId = l?.id ?? null;
fresh.solutionInferred = !!(l?.id && l.inferred);
if (!fresh.answerManual && !fresh.answerLLM) fresh.answer = fresh.solutionId && !fresh.solutionInferred ? answerOf.get(fresh.solutionId) ?? null : null;
});
const inferredLinks = problems.filter((p) => p.solutionId && p.solutionInferred).length;
return { problems: problems.length, solutions: solutions.length, matched, inferredLinks };
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
return { DEFAULT_OPTIONS, HEARTBEAT_STALE_MS, segmentKind, finalizeItem, pagesWithoutImage, PageImageMissingError, relink, ingestBook };
})();
// ===== part2.js 끝 =====
