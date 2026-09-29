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
const { normalizeType } = M.classify;
const PROVIDERS = {
gemini:    { label: 'Google Gemini (무료 등급 있음)', model: 'gemini-2.5-flash', needsKey: true },
anthropic: { label: 'Anthropic Claude', model: 'claude-sonnet-4-5', needsKey: true },
openai:    { label: 'OpenAI', model: 'gpt-4o-mini', needsKey: true },
ollama:    { label: 'Ollama (내 PC, 키 불필요)', model: 'qwen2.5vl:7b', needsKey: false },
};
const SUBJECTS = ['수학(상)', '수학(하)', '공통수학1', '공통수학2', '수학I', '수학II', '대수', '미적분I', '미적분', '미적분II', '확률과 통계', '기하'];
/**
* AI 판정(비전 OCR)의 시스템 프롬프트 — 사용자가 정한 문구 그대로 둔다.
* 수식은 LaTeX($ … $, $$ … $$)로 옮기고, 지문·문제·선지·번호를 나누고, 1~5단계 난이도와 단원·유형을 JSON으로 받는다.
*/
const OCR_SYSTEM_PROMPT = `너는 20년 경력의 수학 시험지 정보화 및 OCR 전문가이자 수학 교육과정 평가 전문가다.

너의 역할은 제공된 수학 문제 이미지를 고정밀 비전(Vision) 기술로 분석하여, 수식과 문제 구조를 완벽히 추출하고 지정된 JSON 포맷으로 변환하는 것이다.

### 핵심 지시사항:
1. **수학 기호 및 수식 포맷팅 (LaTeX 사용)**:
   - 모든 수학 기호, 수식, 변수, 연산자는 표준 LaTeX 구문으로 변환할 것.
   - 문장 내에 포함된 단일 수식은 \`$ ... $\` 구분을 사용할 것 (예: $x^2 + y^2 = 1$).
   - 독립된 줄로 표시되는 복잡한 다항식, 분수식, 수식 단계는 \`$$ ... $$\` 구분을 사용할 것.
   - 분수(\`\\frac{a}{b}\`), 루트(\`\\sqrt{n}\`), 극한(\`\\lim_{x \\to \\infty}\`), 행렬, 적분, 기하 기호를 정확히 파악할 것.

2. **문제 구조 분리**:
   - 여러 문제에 공통으로 적용되는 지문/보기(\`passage\`)가 있다면 일반 문제(\`question\`)와 명확히 분리할 것.
   - 객관식 선지(①, ②, ③, ④, ⑤)를 인식하여 수식 포맷을 유지한 채 배열(\`choices\`) 형식으로 추출할 것.
   - 문제 번호(예: "01.", "12번")를 정확히 추출할 것.

3. **난이도 및 유형 자동 분류 엔진 (1~5단계)**:
   - 문제의 난이도를 1단계(매우 쉬움 / 단순 계산)부터 5단계(고난도 / 킬러 문항)까지 자체 평가하여 지정할 것.
   - 수학 단원 및 유형(예: "수학 II - 미분계수와 도함수", "다항식의 연산")을 추론하여 명시할 것.

4. **엄격한 JSON 출력 포맷**:
   - 오직 아래 명시된 JSON 구조로만 응답할 것. JSON 코드 블록 외에 다른 서론이나 결론 텍스트를 포함하지 말 것.

\`\`\`json
{
  "problems": [
    {
      "problem_number": "01",
      "passage": "공통 지문이 있는 경우 여기에 작성, 없으면 null",
      "question": "함수 $f(x) = x^2 + 3x$에 대하여 $f'(2)$의 값을 구하시오.",
      "choices": [
        "① $5$",
        "② $7$",
        "③ $9$",
        "④ $11$",
        "⑤ $13$"
      ],
      "has_figure_or_diagram": false,
      "topic": "미분 - 도함수",
      "difficulty_level": 2,
      "difficulty_reasoning": "다항함수의 기본 미분 공식을 적용하여 지점에서의 함숫값을 구하는 단순 유형임."
    }
  ]
}
\`\`\`

잘려서 안 보이거나 흐릿한 부분은 임의로 지어내지 말고 \\text{[미상]}으로 표기할 것.

한국어 오탈자 없이 원문 그대로 정확하게 추출할 것.`;
/** 응답 JSON에서 문제 하나가 가지는 항목 (내보낼 때도 이 순서) */
const PROBLEM_KEYS = ['problem_number', 'passage', 'question', 'choices', 'has_figure_or_diagram', 'topic', 'difficulty_level', 'difficulty_reasoning'];
/** 사용자 메시지: 이미지가 무엇인지와 참고할 과목만 알린다 (형식·규칙은 모두 시스템 프롬프트에 있다) */
function buildUserText(subjectHint) {
return '첨부한 이미지는 수학 문제집에서 잘라 낸 문제 영역입니다. 지시사항에 따라 분석하고 지정된 JSON 구조로만 답하세요.'
+ (subjectHint ? `\n참고: 이 책의 과목은 "${subjectHint}"입니다.`
// 과목을 모르는 책: 지시사항의 첫 예시처럼 topic 앞에 과목을 붙여 달라고 한다 (시험지 과목 필터에 쓴다)
: '\n과목을 알 수 있으면 topic 앞에 "수학 II - 미분계수와 도함수"처럼 과목을 붙여 주세요.');
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
/** 제공자별 요청. 시스템 프롬프트는 각 API의 시스템 자리(system · system 메시지 · systemInstruction)에 넣는다 */
function buildRequest(cfg, system, userText, images) {
const { provider, apiKey, model } = cfg;
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
if (provider === 'anthropic') {
return {
url: 'https://api.anthropic.com/v1/messages',
init: post({
model, max_tokens: 4096, temperature: 0, system, // 문제 글과 수식을 모두 옮겨 적으므로 넉넉하게, 원문 그대로 옮기도록 무작위성 없이
messages: [{ role: 'user', content: [
...images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } })),
{ type: 'text', text: userText },
] }],
}, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }),
};
}
if (provider === 'openai') {
return {
url: 'https://api.openai.com/v1/chat/completions',
init: post({
// temperature는 GPT-4 계열에만 보낸다 (o 시리즈·GPT-5 같은 추론 모델은 기본값 외의 temperature를 거부한다)
model, response_format: { type: 'json_object' }, ...(/^gpt-4/i.test(model) ? { temperature: 0 } : {}),
messages: [
{ role: 'system', content: system },
{ role: 'user', content: [
...images.map((d) => ({ type: 'image_url', image_url: { url: `data:${d.mime};base64,${d.data}` } })),
{ type: 'text', text: userText },
] },
],
}, { authorization: `Bearer ${apiKey}` }),
};
}
if (provider === 'gemini') {
return {
url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
init: post({
systemInstruction: { parts: [{ text: system }] },
contents: [{ role: 'user', parts: [...images.map((d) => ({ inline_data: { mime_type: d.mime, data: d.data } })), { text: userText }] }],
generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
}),
};
}
if (provider === 'ollama') {
const base = (cfg.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
return {
url: `${base}/api/chat`,
init: post({ model, stream: false, format: 'json', options: { temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: userText, images: images.map((d) => d.data) }] }),
};
}
throw new Error('알 수 없는 제공자: ' + provider);
}
/** 제공자별 응답에서 모델이 쓴 글만 꺼낸다 */
function responseText(provider, j) {
if (provider === 'anthropic') return (j?.content || []).map((c) => c.text || '').join('');
if (provider === 'openai') return j?.choices?.[0]?.message?.content || '';
if (provider === 'gemini') return (j?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
return j?.message?.content || '';
}
/** 정상 종료가 아니면 그 이유 (응답이 잘렸거나 막힌 경우를 알리기 위해). 정상이면 '' */
function stopNote(provider, j) {
const r = provider === 'gemini' ? (j?.promptFeedback?.blockReason || j?.candidates?.[0]?.finishReason)
: provider === 'anthropic' ? j?.stop_reason
: provider === 'openai' ? (j?.choices?.[0]?.message?.refusal ? 'refusal' : j?.choices?.[0]?.finish_reason)
: j?.done_reason;
if (!r || ['STOP', 'end_turn', 'stop', 'stop_sequence'].includes(r)) return '';
if (r === 'RECITATION') return 'RECITATION: 교재 원문을 그대로 옮기는 응답을 Gemini가 막았습니다. 다시 시도하거나 다른 제공자를 쓰세요';
if (['MAX_TOKENS', 'max_tokens', 'length'].includes(r)) return `${r}: 응답이 너무 길어 잘렸습니다. 영역에 문제가 여러 개 들어 있지 않은지 확인하세요`;
return String(r);
}
const TRUNCATED = /^(?:MAX_TOKENS|max_tokens|length):/;
/** 응답은 왔지만 쓸 수 없는 경우 (한 번 더 시도해 볼 만하다) */
function badResponse(message) { const e = new Error(message); e.badResponse = true; return e; }
/** 글에서 첫 JSON 객체만 꺼낸다 (```json 코드 블록이나 앞뒤 설명이 붙어도). 문자열 안의 괄호는 세지 않는다 */
function extractJsonObject(text) {
const s = String(text ?? '');
const start = s.indexOf('{');
if (start < 0) return null;
let depth = 0, inStr = false;
for (let i = start; i < s.length; i++) {
const ch = s[i];
if (inStr) { if (ch === '\\') i++; else if (ch === '"') inStr = false; continue; }
if (ch === '"') inStr = true;
else if (ch === '{') depth++;
else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
}
return s.slice(start); // 끝이 잘린 응답: 그대로 읽어 보고 오류를 알린다
}
// 모델이 JSON 이스케이프를 잊고 LaTeX 역슬래시를 하나만 쓰면, \frac \beta \text \right \neq 같은 명령이 JSON에서는
// 폼피드·백스페이스·탭·CR·줄바꿈으로 읽혀 수식이 조용히 깨진다. 문자열마다 따로 판단해 고친다 (올바르게 쓴 문자열은 건드리지 않는다).
// \n 뒤에 오면 LaTeX 명령일 수 있는 이름: 진짜 줄바꿈 뒤에도 올 수 있어(e^{x}, i^{2}) 수식 안에서만 명령으로 본다
const LATEX_N = /^n(?:eq|e|eg|abla|otin|ot|i|u|leq|geq|less|gtr|mid|parallel|subseteq|supseteq|subset|supset|exists|olimits)(?![A-Za-z])/;
/** 문자열 하나(따옴표 안, 이스케이프 전)를 고친다 */
function repairLiteral(raw) {
// 이 문자열에 역슬래시를 하나만 쓴 흔적(JSON에 없는 이스케이프, 글자 앞의 \b \f \r \t)이 있는지
let single = false;
for (let i = 0; i < raw.length && !single; i++) {
if (raw[i] !== '\\') continue;
const nx = raw[i + 1] ?? '';
if (nx === '\\' || nx === '"' || nx === '/' || nx === 'n') { i++; continue; }
if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) { i += 5; continue; }
if ('bfrt'.includes(nx) && nx && !/[A-Za-z]/.test(raw[i + 2] ?? '')) { i++; continue; }
single = true;
}
let out = '', math = '', prev = '';
for (let i = 0; i < raw.length; i++) {
const ch = raw[i];
// 문자열 안에 그대로 들어간 줄바꿈·탭 (JSON에서는 허용되지 않는다)
if (ch === '\n' || ch === '\r' || ch === '\t') { out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t'; prev = ch; continue; }
if (ch === '$') {
if (raw[i + 1] === '$' && math !== '$') { math = math === '$$' ? '' : '$$'; out += '$$'; i++; prev = '$'; continue; }
if (math !== '$$') math = math === '$' ? '' : '$';
out += ch; prev = ch; continue;
}
if (ch !== '\\') { out += ch; prev = ch; continue; }
const nx = raw[i + 1] ?? '';
if (nx === '\\' || nx === '"' || nx === '/') { out += ch + nx; i++; prev = nx; continue; }
if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))) { out += raw.slice(i, i + 6); i += 5; prev = 'u'; continue; }
if (nx === '$') { out += '\\\\$'; i++; prev = '$'; continue; } // LaTeX의 \$ (달러 기호 글자): 수식 구분자가 아니다
let latex;
if (nx === 'n') {
const m = raw.slice(i + 1, i + 24).match(LATEX_N);
const after = m ? raw[i + 1 + m[0].length] ?? '' : '';
// 수식 안에서만 명령으로 본다. 행렬·연립의 줄바꿈 \\ 바로 뒤(다음 줄 시작)와, 뒤에 ^ _ 한글이 오는 경우(e^{x}, i^{2}, e는)는 진짜 줄바꿈.
// $ … $ 안은 그 밖에는 명령. $$ … $$ 안에서 \neq \neg \nabla \not 처럼 두 글자 이상인 이름은 진짜 줄바꿈 뒤에 올 일이 없어 명령,
// \ne \ni \nu처럼 한 글자는 e(x)·i·u(x)로 시작하는 새 줄일 수 있어, 역슬래시 하나짜리 문자열이고 앞에 띄어쓰기가 있을 때("a \ne b")만 명령
if (!m || prev === '\\' || (m[0].length === 2 && /[\^_가-힣]/.test(after))) latex = false; // ^ _ 한글 확인은 \ne \ni \nu만 (\nolimits_ \nabla^는 명령)
else if (math === '$') latex = true;
else if (math === '$$') latex = m[0].length > 2 || (single && prev === ' ');
else latex = false;
} else if ('bfrt'.includes(nx) && nx) latex = /[A-Za-z]/.test(raw[i + 2] ?? '');
else latex = true; // JSON에 없는 이스케이프(\s \l \{ \, \\ 앞 공백 …)는 LaTeX
if (latex) { out += '\\\\'; prev = '\\'; continue; } // LaTeX의 역슬래시 하나 (다음 글자부터 그대로 이어 읽는다)
out += ch + nx; i++; prev = nx === 'n' ? '\n' : nx;
}
return out;
}
/** JSON 글 전체에서 문자열마다 repairLiteral을 적용한다 */
function repairJsonText(s) {
let out = '';
for (let i = 0; i < s.length; i++) {
if (s[i] !== '"') { out += s[i]; continue; }
let j = i + 1;
for (; j < s.length && s[j] !== '"'; j++) if (s[j] === '\\') j++;
out += '"' + repairLiteral(s.slice(i + 1, Math.min(j, s.length))) + (j < s.length ? '"' : '');
i = j;
}
return out;
}
// 행렬·연립(cases) 안의 줄바꿈 \\ 가 역슬래시 하나로 줄어든 것을 되돌린다: " \ " → " \\ ", "2\3" "0)\-x" → "2\\3" "0)\\-x".
// 환경 안에 제대로 쓴 \\ 가 하나라도 있으면 줄바꿈을 올바르게 쓴 것이므로 남은 "\ "는 LaTeX의 띄어쓰기로 두고, "\ \ "처럼 이어 쓴 띄어쓰기도 둔다
const ROW_ENV = /\\begin\{(cases|rcases|dcases|[pbvBV]?matrix|smallmatrix|aligned|align\*?|array|gathered|split)\}([\s\S]*?)\\end\{\1\}/g;
function fixRowBreaks(s) {
return s.replace(ROW_ENV, (m, env, body) => {
if (body.includes('\\\\')) return m;
const fixed = body.replace(/\\(?=[\s\d-])/g, (bs, at) => {
const before = body.slice(0, at), after = body.slice(at + 1);
if (/\s/.test(after[0] ?? '')) {
if (/\\(?:text|mathrm|textrm|mbox)\{[^{}]*\}$/.test(before)) return bs; // "\text{if}\ x" 같은 글 뒤 띄어쓰기 (x^{2}\ g(x)처럼 수식 뒤는 줄바꿈)
if (/\\\s*$/.test(before) || /^\s*\\\s/.test(after)) return bs; // "\ \ " 두 칸 띄어쓰기
if (body.includes('&') && !after.includes('&')) return bs; // & 로 칸을 나누는 환경의 마지막 줄 안: 줄바꿈이 아니라 띄어쓰기 (x^{2}\ (x > 0))
}
return '\\\\';
});
return `\\begin{${env}}${fixed}\\end{${env}}`;
});
}
function mapStrings(v, fn) {
if (typeof v === 'string') return fn(v);
if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
return v;
}
/** AI 응답 글 → JSON 객체. 코드 블록·앞뒤 설명을 걷어 내고, 역슬래시 하나짜리 LaTeX를 문자열마다 고쳐 읽는다 */
function parseJsonText(text) {
const raw = extractJsonObject(text);
if (raw == null) throw badResponse('AI 응답에 JSON이 없습니다: ' + String(text ?? '').slice(0, 160));
let o;
try { o = JSON.parse(repairJsonText(raw)); }
catch (e) {
try { o = JSON.parse(raw); } // 고친 글만 읽지 못하는 경우를 대비해 원래 글로도 읽어 본다
catch { throw badResponse(`AI 응답을 JSON으로 읽지 못했습니다 (${e.message}): ${raw.slice(0, 160)}`); }
}
return mapStrings(o, fixRowBreaks);
}
const clean = (v) => { if (v == null) return null; const s = String(v).trim(); return !s || /^null$/i.test(s) ? null : s; };
const PASSAGE_PLACEHOLDER = '공통 지문이 있는 경우 여기에 작성, 없으면 null';
/** 문제 하나를 정해진 모양으로: 빈 값·"null" 글자는 null, 선지는 글자 배열, 난이도는 1~5 정수(아니면 null) */
function normalizeProblem(o) {
if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
let choices = o.choices;
if (typeof choices === 'string') choices = choices.split(/(?=[\u2460-\u2473])/);
choices = Array.isArray(choices) ? choices.map(clean).filter(Boolean) : [];
// "3", "3단계", "4 (어려움)"처럼 글로 와도 앞의 숫자를 읽는다
const lv = o.difficulty_level;
const level = Math.round(Number(typeof lv === 'string' ? lv.match(/^\s*(\d+(?:\.\d+)?)(?!\d)/)?.[1] : lv));
const fig = o.has_figure_or_diagram;
const passage = clean(o.passage);
return {
problem_number: clean(o.problem_number),
passage: passage === PASSAGE_PLACEHOLDER ? null : passage, // 예시 문구를 그대로 베낀 경우
question: clean(o.question) ?? '',
choices,
has_figure_or_diagram: fig === true || /^(true|yes|있음)$/i.test(String(fig ?? '').trim()),
topic: clean(o.topic),
difficulty_level: level >= 1 && level <= 5 ? level : null,
difficulty_reasoning: clean(o.difficulty_reasoning) ?? '',
};
}
/** AI 응답 글 → 이 영역에서 읽은 문제 목록 (problems 배열이 없이 문제 하나만 온 경우도 받는다) */
function parseAnalysis(text) {
const o = parseJsonText(text);
let list = o.problems;
if (list && typeof list === 'object' && !Array.isArray(list)) list = [list];
if (!Array.isArray(list)) list = 'question' in o || 'difficulty_level' in o ? [o] : [];
const problems = list.map(normalizeProblem).filter((p) => p && (p.question || p.choices.length || p.difficulty_level != null));
if (!problems.length) throw badResponse('AI 응답에 문제(problems)가 없습니다: ' + String(text ?? '').slice(0, 160));
return problems;
}
/** 1~5단계(1 매우 쉬움 … 5 킬러)를 이 앱의 수능식 1~9등급(1이 가장 어려움)으로: 1→9, 2→7, 3→5, 4→3, 5→1 */
const levelToGrade = (level) => (Number.isInteger(level) && level >= 1 && level <= 5 ? 11 - 2 * level : null);
/** "01." "12번" "유제 1-2" → 문제 번호(마지막 숫자). 숫자가 없으면 null */
const numberOf = (s) => { const m = String(s ?? '').normalize('NFKC').match(/\d+/g); return m ? +m[m.length - 1] : null; };
/** 여러 문제를 읽었으면 이 항목 번호와 같은 문제, 없으면 첫 문제 */
function primaryIndex(problems, item) {
const i = problems.findIndex((p) => numberOf(p.problem_number) === item?.number);
return i >= 0 ? i : 0;
}
// 과목 이름 비교용: 띄어쓰기·괄호를 빼고, 수학·미적분은 1·2 → I·II, 공통수학은 I·II → 1·2 (SUBJECTS의 표기에 맞춘다)
const subjectKey = (s) => String(s ?? '').normalize('NFKC').replace(/[\s()（）]/g, '')
.replace(/^(수학|미적분)([12])(?!\d)/, (m, w, d) => w + 'I'.repeat(+d))
.replace(/^공통수학(II|I)(?![A-Za-z])/, (m, r) => '공통수학' + r.length);
/** 단원 유형 글의 앞머리에서 과목을 찾는다 ("수학 II - 미분계수와 도함수" → 수학II, "수학Ⅰ" "수학 1"도). 없으면 null */
function subjectFromTopic(topic) {
const k = subjectKey(topic);
let best = null;
for (const s of SUBJECTS) {
const sk = subjectKey(s);
if (k.startsWith(sk) && (!best || sk.length > subjectKey(best).length)) best = s;
}
return best;
}
// LaTeX 명령을 자동 분류 규칙이 알아보는 기호·낱말로 (∫ Σ → ∞ √ ∘ ∈ …, 나머지는 명령 이름 그대로: \sin → sin)
const LATEX_SYMBOLS = {
int: '∫', iint: '∬', oint: '∮', sum: 'Σ', prod: 'Π', to: '→', rightarrow: '→', infty: '∞', sqrt: '√', times: '×', cdot: '·', div: '÷', pm: '±',
circ: '∘', in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', pi: 'π', theta: 'θ', alpha: 'α', beta: 'β', angle: '∠', triangle: '△', perp: '⊥', parallel: '∥',
overline: '', vec: '', left: '', right: '', displaystyle: '', quad: ' ', qquad: ' ',
};
function latexToPlain(s) {
let t = String(s ?? '');
// 안쪽부터 풀어 나간다 (\frac{\sqrt{x}}{x} 같은 중첩)
for (let k = 0, prev = null; k < 6 && prev !== t; k++) {
prev = t;
t = t.replace(/\\(?:text|mathrm|operatorname)\s*\{([^{}]*)\}/g, '$1')
.replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)');
}
return t
.replace(/\\([A-Za-z]+)/g, (m, name) => LATEX_SYMBOLS[name] ?? name)
.replace(/\\[,;:! ]/g, ' ')
.replace(/[{}$]/g, '')
.replace(/[ \t]+/g, ' ').trim();
}
/** AI가 적은 단원 유형(topic)을 이 앱의 표준 유형으로: 단원 부분 → 전체 → 문제 글(LaTeX를 기호로 바꿔) 순서로 찾는다 */
function typeFromAnalysis(p, subject) {
const topic = p?.topic || '';
const unit = topic.split(/\s*[-–—:>|]\s*/).filter(Boolean).pop() || '';
const body = latexToPlain([p?.passage, p?.question, ...(p?.choices || [])].filter(Boolean).join('\n'));
return normalizeType(unit, subject) || normalizeType(topic, subject) || normalizeType(body, subject) || null;
}
/** 저장한 분석 결과를 지정된 JSON 구조 {"problems": [...]}로 (항목 순서도 그대로) */
function toSchemaJson(problems) {
const empty = { choices: [], has_figure_or_diagram: false, question: '', difficulty_reasoning: '' };
return { problems: (problems || []).map((p) => Object.fromEntries(PROBLEM_KEYS.map((k) => [k, p?.[k] ?? empty[k] ?? null]))) };
}
function summarize(problems, item, subjectHint) {
const primary = primaryIndex(problems, item);
const p = problems[primary];
const subject = subjectFromTopic(p.topic);
return {
problems, primary, level: p.difficulty_level, grade: levelToGrade(p.difficulty_level),
topic: p.topic, subject, type: typeFromAnalysis(p, subject || subjectHint), reason: p.difficulty_reasoning,
};
}
function httpError(res, body) {
const e = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
e.status = res.status;
return e;
}
async function send(provider, req) {
const res = await fetch(req.url, req.init);
if (!res.ok) throw httpError(res, await res.text());
let j;
try { j = await res.json(); } catch { throw badResponse('AI 서버의 응답을 읽지 못했습니다.'); }
return { text: responseText(provider, j), note: stopNote(provider, j) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
* 문제 이미지 1장을 AI로 분석한다 (429·5xx는 기다렸다 다시, 읽을 수 없는 응답은 한 번 더).
* 반환: { problems: 이 영역에서 읽은 문제들, primary: 이 항목에 해당하는 문제의 순번, level: 1~5단계, grade: 환산 등급(1~9),
*         topic: 단원 유형 글, subject: 그 글의 과목, type: 이 앱의 표준 유형, reason: 난이도 근거 }
*/
async function analyzeWithLLM(cfg, problem, subjectHint) {
const images = [await shrink(problem.image)];
const req = buildRequest(cfg, OCR_SYSTEM_PROMPT, buildUserText(subjectHint), images);
for (let attempt = 0; ; attempt++) {
try {
const { text, note } = await send(cfg.provider, req);
let problems;
try { problems = parseAnalysis(text); }
catch (e) {
if (note) { e.message = `${e.message} (${note})`; e.truncated = TRUNCATED.test(note); }
throw e;
}
return summarize(problems, problem, subjectHint);
} catch (e) {
// 잘린 응답은 같은 요청으로 다시 보내도 또 잘리므로 다시 보내지 않는다
const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || (e.badResponse && !e.truncated && attempt === 0);
if (!retryable || attempt >= 3) throw e;
await sleep(e.badResponse ? 1000 : 2000 * 2 ** attempt);
}
}
}
function loadConfig() {
try { return JSON.parse(localStorage.getItem('mathbook.llm') || '{}'); } catch { return {}; }
}
function saveConfig(cfg) {
localStorage.setItem('mathbook.llm', JSON.stringify(cfg));
}
return {
PROVIDERS, SUBJECTS, OCR_SYSTEM_PROMPT, PROBLEM_KEYS, buildUserText, buildRequest, responseText, stopNote,
extractJsonObject, repairJsonText, parseJsonText, parseAnalysis, levelToGrade, numberOf, primaryIndex,
subjectFromTopic, latexToPlain, typeFromAnalysis, toSchemaJson, analyzeWithLLM, loadConfig, saveConfig,
};
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
// AI가 옮겨 적은 문제 글은 그 영역의 것이다: 영역이 그대로면 그대로 쓰고, 바뀌었으면 '다시 분석 필요'로 표시해 둔다
if (prev.aiExtract) item.aiExtract = sameRegions(prev.fragments, item.fragments) ? prev.aiExtract : { ...prev.aiExtract, stale: true };
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
const KEEP_ON_RESEGMENT = ['gradeManual', 'gradeLLM', 'difficultyLLM', 'unit', 'subjectLLM', 'llmReason', 'typeLLM', 'typeManual'];
/** 두 항목의 영역(쪽·상자)이 같은지 (다듬기 결과가 몇 px 다른 것은 같은 영역으로 본다) */
function sameRegions(a = [], b = [], tol = 4) {
return a.length === b.length && a.every((f, i) => f.page === b[i].page && ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs((f[k] ?? 0) - (b[i][k] ?? 0)) <= tol));
}
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
return { DEFAULT_OPTIONS, HEARTBEAT_STALE_MS, segmentKind, finalizeItem, pagesWithoutImage, PageImageMissingError, relink, ingestBook, sameRegions };
})();
// ===== part2.js 끝 =====
