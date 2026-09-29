// OCR 중지 및 부분 결과 저장 E2E (저장소 외부 테스트 전용)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs } = require('./fakes');
const { problemBook, solutionBook } = require('./gen');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});
function ocrLines(spec) {
  return spec.pages.map((pg) => pg.items.map((it) => {
    const x0 = it.x * 2, y1 = (842 - it.y) * 2, h = it.size * 2;
    const text = it.str, fw = text.trim().split(/\s+/)[0];
    return { text, bbox: { x0, y0: y1 - h, x1: x0 + Math.max(20, text.length * h * .55), y1 }, words: [{ text: fw, bbox: { x0, y0: y1 - h, x1: x0 + Math.max(15, fw.length * h * .55), y1 } }] };
  }));
}
async function setup(browser, outputs) {
  const context = await browser.newContext();
  await context.addInitScript(({ outputs }) => {
    let call = 0;
    window.Tesseract = { createWorker: async () => ({ recognize: async () => {
      const lines = outputs[Math.min(call++, outputs.length - 1)] || [];
      await new Promise((r) => setTimeout(r, 350));
      return { data: { lines } };
    }, terminate: async () => {} }) };
  }, { outputs });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/**', (route) => {
    if (route.request().url().endsWith('pdf.min.mjs')) return route.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    return route.fulfill({ status: 404 });
  });
  await page.goto('http://localhost:8767/');
  return { context, page, errors };
}
async function uploadAndStart(page, pSpec, sSpec, forceOcr) {
  await page.fill('#in-name', '부분 처리 테스트');
  await page.setInputFiles('#in-problem', { name: 'problem.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(pSpec)) });
  if (sSpec) await page.setInputFiles('#in-solution', { name: 'solution.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(sSpec)) });
  if (forceOcr) await page.evaluate(() => { document.querySelector('#opt-ocr').checked = true; });
  await page.click('#btn-ingest');
}
async function dbState(page) {
  return page.evaluate(async () => ({
    books: await M.db.all('books'),
    pages: (await M.db.all('pages')).map((p) => ({ ...p, image: typeof p.image === 'string' ? p.image : null, imageType: p.image instanceof Blob ? p.image.type : p.image?.type || null })),
    items: (await M.db.all('items')).map((i) => ({ ...i, image: typeof i.image === 'string' ? i.image : null, imageType: i.image instanceof Blob ? i.image.type : i.image?.type || null })),
  }));
}
(async () => {
  await new Promise((r) => server.listen(8767, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // 1) 문제집 첫 페이지 OCR 도중 중지
  const pb = problemBook();
  // 첫 페이지 하단에 연속 톤 사진 질감을 추가한다. 텍스트 레이어가 있어도 JPEG를 골라야 한다.
  for (let y = 0; y < 300; y += 6) for (let x = 0; x < 595; x += 6) {
    const r = 170 + ((x * 17 + y * 31) % 76);
    const g = 170 + ((x * 29 + y * 13) % 76);
    const b = 170 + ((x * 7 + y * 43) % 76);
    pb.pages[0].rects.push({ x, y, w: 6, h: 6, color: `rgb(${r},${g},${b})` });
  }
  let env = await setup(browser, ocrLines(pb));
  await uploadAndStart(env.page, pb, null, true);
  await env.page.waitForFunction(() => document.querySelector('#ingest-log').textContent.includes('[문제] 1/3 쪽 OCR 중'));
  check('OCR 처리 중 중지 버튼 활성화', await env.page.locator('#btn-ingest-stop').isEnabled());
  await env.page.click('#btn-ingest-stop');
  check('중지 요청 즉시 중복 클릭 방지', await env.page.locator('#btn-ingest-stop').isDisabled());
  await env.page.waitForFunction(() => document.querySelector('#tab-review').classList.contains('active'), null, { timeout: 30000 });
  let st = await dbState(env.page), b = st.books[0];
  check('문제 OCR 중지 상태 기록', b.ingest.status === 'stopped' && b.ingest.stoppedAt.kind === 'problem' && b.ingest.stoppedAt.processedPages === 1 && b.ingest.stoppedAt.totalPages === 3, JSON.stringify(b.ingest));
  check('현재 OCR 페이지만 온전히 저장', st.pages.length === 1 && b.pageCounts.problem === 1 && st.pages[0].lines.length > 5, `pages=${st.pages.length}`);
  check('텍스트 레이어가 있는 사진성 페이지도 JPEG Blob 선택', st.pages[0].imageFormat === 'JPEG' && st.pages[0].imageType === 'image/jpeg');
  const firstCandidates = await env.page.evaluate(async () => { const p = (await M.db.all('pages'))[0]; return { cols: p.columns, lines: p.lines.map((l) => [l.text, l.firstWord?.text, Math.round(l.firstWord?.x0 || l.x0)]), cands: M.segment.findCandidates(p, {}).map((c) => [c.col, c.num, c.style, +c.score.toFixed(2), c.text]) }; });
  check('저장 페이지의 문제만 분리', st.items.length === 4 && st.items.every((x) => x.kind === 'problem' && (x.image || x.imageType)), `items=${st.items.length} nums=${st.items.map((x) => `${x.section}-${x.number}:${x.detection?.source}`).join(',')} candidates=${JSON.stringify(firstCandidates)}`);
  check('검토 탭에서 문제를 하나씩 선택 가능', (await env.page.locator('#rv-list .card').count()) === 4 && (await env.page.locator('#rv-list button', { hasText: '보기' }).count()) === 4);
  await env.page.locator('#rv-list button', { hasText: '보기' }).nth(2).click();
  await env.page.waitForTimeout(200);
  check('부분 문제 선택 시 해당 상세/페이지 표시', (await env.page.textContent('#rv-side')).includes('문제 1-3') && (await env.page.inputValue('#rv-page')) === '1');
  await env.page.selectOption('#rv-kind', 'solution');
  await env.page.waitForTimeout(200);
  check('0쪽 종류는 빈 검토 상태로 표시', (await env.page.inputValue('#rv-page')) === '' && (await env.page.textContent('#rv-pages')) === '0' && await env.page.locator('#rv-page').isDisabled() && (await env.page.textContent('#rv-side')).includes('저장된 페이지가 없습니다'));
  await env.page.selectOption('#rv-kind', 'problem');
  await env.page.waitForTimeout(200);
  check('부분 완료 로그 표시', (await env.page.textContent('#ingest-log')).includes('부분 처리 완료: 문제집 1/3쪽'));
  check('중지 후 버튼 초기화', await env.page.locator('#btn-ingest-stop').isDisabled() && (await env.page.textContent('#btn-ingest-stop')).includes('현재 페이지'));
  check('문제 중지 흐름 JS 오류 없음', env.errors.length === 0, env.errors.join(' | '));
  await env.context.close();

  // 2) 문제집 완료 후 해설지 첫 페이지 OCR 도중 중지
  const sb = solutionBook();
  sb.pages.forEach((p) => {
    p.noText = true;
    // 120색의 큰 평면 조각(차트/히트맵)은 색이 많아도 사진 질감이 아니므로 PNG여야 한다.
    const swatches = [];
    for (let row = 0; row < 10; row++) for (let col = 0; col < 12; col++) {
      const i = row * 12 + col;
      const r = 176 + (i % 6) * 13, g = 176 + (Math.floor(i / 6) % 6) * 13, b = 176 + (Math.floor(i / 36) % 4) * 18;
      swatches.push({ x: col * (595 / 12), y: row * 15, w: 595 / 12, h: 15, color: `rgb(${r},${g},${b})` });
    }
    p.rects = [...(p.rects || []), ...swatches];
  });
  env = await setup(browser, ocrLines(sb));
  await uploadAndStart(env.page, pb, sb, false);
  await env.page.waitForFunction(() => document.querySelector('#ingest-log').textContent.includes('[해설] 1/2 쪽 OCR 중'), null, { timeout: 30000 });
  await env.page.click('#btn-ingest-stop');
  await env.page.waitForFunction(() => document.querySelector('#tab-review').classList.contains('active'), null, { timeout: 30000 });
  st = await dbState(env.page); b = st.books[0];
  const probs = st.items.filter((x) => x.kind === 'problem'), sols = st.items.filter((x) => x.kind === 'solution');
  check('해설 OCR 중지 상태 기록', b.ingest.status === 'stopped' && b.ingest.stoppedAt.kind === 'solution' && b.ingest.stoppedAt.processedPages === 1 && b.ingest.stoppedAt.totalPages === 2, JSON.stringify(b.ingest));
  check('문제 전체 + 해설 완료 1쪽 저장', b.pageCounts.problem === 3 && b.pageCounts.solution === 1 && st.pages.length === 4, JSON.stringify(b.pageCounts));
  const scannedPage = st.pages.find((p) => p.kind === 'solution');
  check('OCR 전용 고색상 차트·음영 페이지는 무손실 PNG Blob 선택', scannedPage.imageFormat === 'PNG' && scannedPage.imageType === 'image/png');
  check('문제 12개 유지, 부분 해설 6개 분리', probs.length === 12 && sols.length === 6, `${probs.length}/${sols.length} p=${probs.map((x) => `${x.section}-${x.number}`).join(',')} s=${sols.map((x) => `${x.section}-${x.number}`).join(',')}`);
  check('부분 해설 6개만 문제에 연결', probs.filter((p) => p.solutionId).length === 6, `linked=${probs.filter((p) => p.solutionId).length}`);
  check('해설 중지 후에도 문제 검토 목록을 엶', (await env.page.inputValue('#rv-kind')) === 'problem' && (await env.page.locator('#rv-list .card').count()) === 12);
  check('해설 부분 완료 로그 표시', (await env.page.textContent('#ingest-log')).includes('부분 처리 완료: 해설지 1/2쪽'));
  check('해설 중지 흐름 JS 오류 없음', env.errors.length === 0, env.errors.join(' | '));
  await env.context.close();

  await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
