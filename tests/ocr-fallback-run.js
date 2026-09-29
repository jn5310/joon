// OCR 실행 조건·텍스트층 우선·OCR 없는 텍스트 PDF·빽빽한 2단 텍스트 회귀 테스트 (저장소 외부)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs } = require('./fakes');
const { problemBook } = require('./gen');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const server = http.createServer((req, res) => { const f = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res); });
async function run(browser, { tesseract, spec, name }) {
  const context = await browser.newContext();
  if (tesseract) await context.addInitScript(tesseract);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.request().url().endsWith('pdf.min.mjs') ? r.fulfill({ contentType: 'text/javascript', body: fakePdfjs }) : r.fulfill({ status: 404 }));
  await page.goto('http://localhost:8773/');
  await page.fill('#in-name', name);
  await page.setInputFiles('#in-problem', { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(spec)) });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled && /판정 완료|오류:/.test(document.querySelector('#ingest-log').textContent), null, { timeout: 90000 });
  const st = await page.evaluate(async () => ({
    log: document.querySelector('#ingest-log').textContent,
    book: (await M.db.all('books'))[0],
    pages: (await M.db.all('pages')).sort((a, b) => a.index - b.index).map((p) => ({ cols: p.columns, diag: p.diagnostics, ocr: p.ocr, lines: p.lines.map((l) => l.text) })),
    items: (await M.db.all('items')).filter((x) => x.kind === 'problem').sort((a, b) => a.section - b.section || a.number - b.number).map((x) => ({ key: `${x.section}-${x.number}`, inferred: !!x.detection?.inferred, x0: x.fragments[0].x0, x1: x.fragments[0].x1, text: x.text })),
    calls: window.__calls ? window.__calls() : null,
  }));
  st.errors = errors;
  await context.close();
  return st;
}
(async () => {
  await new Promise((r) => server.listen(8773, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // 1) 5지선다 쪽: 전체 OCR이 본문과 선택지 줄만 읽고 번호 배지는 못 읽음 → 번호 영역 OCR로 번호를 찾아야 한다 (스캔·텍스트 PDF 모두)
  const gateTesseract = () => {
    const calls = [];
    const word = (text, x, y, w = 60, h = 24) => ({ text, confidence: 85, bbox: { x0: x, y0: y, x1: x + w, y1: y + h } });
    const ln = (text, x, y) => ({ text, confidence: 85, bbox: { x0: x, y0: y, x1: x + 400, y1: y + 24 }, words: text.split(' ').map((t, i) => word(t, x + i * 70, y)) });
    window.Tesseract = { createWorker: async () => ({ recognize: async (canvas) => {
      calls.push(canvas.width);
      const ys = [760, 480].map((py) => Math.round(1684 - py * 2 - 22)), z = 1.35;
      if (canvas.width >= 400) return { data: { lines: ys.flatMap((y) => [ln('다음 식의 값을 구하시오', 116, y), ln('① 1 ② 2 ③ 3 ④ 4 ⑤ 5', 116, y + 120)]) } };
      return { data: { lines: ys.map((y, k) => ({ text: `${k + 1}.`, confidence: 92, bbox: { x0: 6, y0: y * z, x1: 40, y1: (y + 24) * z }, words: [word(`${k + 1}.`, 6, y * z, 34)] })) } };
    }, terminate: async () => {} }) };
    window.__calls = () => calls;
  };
  const gateSpec = (scan) => {
    const items = [], rects = [];
    for (const y of [760, 480]) {
      rects.push({ x: 40, y: y - 4, w: 14, h: 14, color: '#333' }); // 그림으로 된 번호 배지 (글자층 없음)
      items.push({ str: '다음 식의 값을 구하시오 다음 식의 값을 구하시오', x: 58, y, size: 11 }, { str: '조건을 만족시키는 실수 x의 값은?', x: 58, y: y - 20, size: 11 }, { str: '① 1   ② 2   ③ 3   ④ 4   ⑤ 5', x: 58, y: y - 60, size: 11 });
    }
    return { pages: [{ noText: scan, items, rects }] };
  };
  for (const scan of [true, false]) {
    const st = await run(browser, { tesseract: gateTesseract, spec: gateSpec(scan), name: scan ? '5지선다 스캔' : '5지선다 텍스트' });
    const d = st.pages[0].diag;
    check(`${scan ? '스캔' : '텍스트 PDF(번호가 그림)'} 5지선다 쪽: 선택지 줄이 있어도 번호 영역 OCR 실행`, st.pages[0].ocr && d.stripRetried && st.calls.length === 2, JSON.stringify({ d, calls: st.calls }));
    check(`${scan ? '스캔' : '텍스트 PDF'}: 두 문제 모두 번호로 분리 (선택지 줄로 쪼개지 않음)`, st.items.map((x) => x.key + (x.inferred ? '*' : '')).join() === '1-1,1-2', JSON.stringify(st.items.map((x) => x.key + (x.inferred ? '*' : ''))));
    if (!scan) check('텍스트 PDF: OCR을 보태도 정확한 글자층 유지', st.pages[0].lines.some((t) => t.includes('조건을 만족시키는 실수 x의 값은?')) && st.items.every((x) => x.text.includes('다음 식의 값을 구하시오')), JSON.stringify(st.pages[0].lines.slice(0, 4)));
  }

  // 2) OCR 프로그램을 내려받을 수 없어도(인터넷 끊김) 텍스트 PDF는 번호 없는 개념 쪽이 있어도 끝까지 처리
  const noTess = () => { window.Tesseract = { createWorker: async () => { throw new Error('Tesseract.js 로드 실패: 테스트'); } }; };
  const spec = problemBook();
  spec.pages.splice(1, 0, { items: [
    { str: '개념 정리: 지수와 로그의 성질을 정리하면 다음과 같다', x: 40, y: 760, size: 11 },
    { str: '거듭제곱근의 정의와 지수법칙을 이용하여 식을 간단히 한다', x: 40, y: 740, size: 11 },
    { str: '로그의 정의에 따라 밑과 진수의 조건을 확인한다', x: 40, y: 720, size: 11 },
  ] });
  const nt = await run(browser, { tesseract: noTess, spec, name: '개념 쪽 있는 텍스트 책' });
  check('OCR을 못 써도 텍스트 PDF는 완료 (문제 12개, 오류 없음)', nt.book.ingest.status === 'complete' && nt.items.length === 12 && !nt.log.includes('오류:'), `${nt.book.ingest.status} items=${nt.items.length}`);
  check('OCR을 건너뛴 쪽은 안내하고 한 번만 시도', nt.log.includes('텍스트층만 사용') && nt.pages[1].diag.ocrSkipped === true, nt.log.split('\n').filter((l) => l.includes('텍스트층')).join(' / '));

  // 3) 빽빽한 2단 텍스트: 단 경계가 줄 끝·번호까지 들어가야 한다
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const WORDS = ['MEHWB', 'KRDNA', 'BEMHW', 'NKRDE', 'WMBHE', 'DARKN', 'HEMBW', 'RKNDA', 'EWMHB', 'ANDRK'];
  const dense = (k) => { let s = ''; while (s.length < k) s += WORDS[Math.floor(rnd() * WORDS.length)] + ' '; return s.slice(0, k).trim(); };
  const pages = []; let n = 1;
  for (let p = 0; p < 2; p++) {
    const items = [{ str: 'HEADER TITLE', x: 40, y: 815, size: 11 }];
    for (const cx of [40, 310]) { let y = 760; for (let k = 0; k < 2; k++, n++) { items.push({ str: String(n).padStart(2, '0'), x: cx, y, size: 11 }); for (let i = 0; i < 7; i++) items.push({ str: dense(i === 6 ? 18 : 33), x: cx + 18, y: y - i * 16, size: 10 }); y -= 7 * 16 + 70; } }
    pages.push({ items });
  }
  const dn = await run(browser, { tesseract: null, spec: { pages }, name: '빽빽한 2단' });
  const c = dn.pages[0].cols;
  check('빽빽한 2단 텍스트: 단 경계가 번호(x≈80)와 줄 끝(x≈550)을 포함', c.length === 2 && c[0].x0 <= 82 && c[0].x1 >= 545 && c[1].x0 <= 622, JSON.stringify(c));
  check('빽빽한 2단 텍스트: 8문제 모두 글자층 번호로 분리하고 crop이 줄 끝까지 포함', dn.items.length === 8 && dn.items.every((x) => !x.inferred) && dn.items.filter((x) => x.x0 < 600).every((x) => x.x0 <= 82 && x.x1 >= 545), JSON.stringify(dn.items.map((x) => [x.key, Math.round(x.x0), Math.round(x.x1)])));
  check('OCR 흐름 JS 오류 없음', [nt, dn].every((s) => !s.errors.length), [nt, dn].flatMap((s) => s.errors).join(' | '));
  await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
