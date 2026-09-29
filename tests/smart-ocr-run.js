// OCR nested-output·번호 lane 재시도·시각 fallback 통합 테스트
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs } = require('./fakes');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const server = http.createServer((req, res) => { const f = path.join(ROOT, req.url === '/' ? 'index.html' : req.url.split('?')[0]); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(8770, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    let call = 0, twoColCall = 0;
    const stripWidths = [];
    const word = (text, x, y, w = 80, h = 24) => ({ text, confidence: 80, bbox: { x0: x, y0: y, x1: x + w, y1: y + h } });
    const ln = (text, x, y, words) => ({ text, confidence: 88, bbox: { x0: x, y0: y, x1: x + 300, y1: y + 24 }, words: words || text.split(' ').map((t, i) => word(t, x + i * 90, y)) });
    // 2단 스캔: 같은 높이의 왼쪽·오른쪽 번호. 여러 단을 옆으로 붙인 넓은 strip을 주면 Tesseract처럼 한 줄로 합쳐 돌려준다.
    const twoCol = (canvas) => {
      twoColCall++;
      if (twoColCall === 1) return { data: { lines: [ // 전체 OCR: 본문만 읽고 번호는 못 읽음
        ln('함수의 값을 구하시오', 120, 146), ln('함수의 값을 구하시오', 700, 146), ln('수열의 합을 구하시오', 120, 826), ln('수열의 합을 구하시오', 700, 826),
      ] } };
      stripWidths.push(canvas.width);
      const z = 1.35;
      if (canvas.width > 350) return { data: { lines: [146, 826].map((y, k) => ({
        text: `${k + 1}. ${k + 3}.`, confidence: 90, bbox: { x0: 8, y0: y * z, x1: 300, y1: (y + 24) * z },
        words: [word(`${k + 1}.`, 8, y * z, 26), word(`${k + 3}.`, 250, y * z, 26)],
      })) } };
      const lane = stripWidths.filter((w) => w <= 350).length - 1; // 0: 왼쪽 단, 1: 오른쪽 단
      return { data: { lines: [146, 826].map((y, k) => {
        const t = `${lane * 2 + k + 1}.`;
        return { text: t, confidence: 90, bbox: { x0: 8, y0: y * z, x1: 34, y1: (y + 24) * z }, words: [word(t, 8, y * z, 26)] };
      }) } };
    };
    window.Tesseract = { createWorker: async () => ({
      recognize: async (canvas) => {
        call++;
        if (window.__scenario === 'two-col') return twoCol(canvas);
        if (call === 1) return { data: { // flat lines 없음: nested blocks만 있는 출력
          text: '함수 값을 구하시오', blocks: [{ paragraphs: [{ lines: [
            { text: '함수 값을 구하시오', confidence: 75, bbox: { x0: 80, y0: 170, x1: 400, y1: 195 }, words: [word('함수', 80, 170), word('값을', 180, 170), word('구하시오', 270, 170)] },
            { text: '수열의 합', confidence: 75, bbox: { x0: 80, y0: 550, x1: 300, y1: 575 }, words: [word('수열의', 80, 550), word('합', 230, 550)] },
          ] }] }], words: []
        } };
        // 번호 strip은 1,2만 읽는다. 나머지 두 문제는 시각 경계가 살려야 한다. 좌표는 zoom(1.35)된 strip 기준.
        return { data: { lines: [
          { text: '①', confidence: 92, bbox: { x0: 8, y0: 164 * 1.35, x1: 30, y1: 188 * 1.35 }, words: [word('①', 8, 164 * 1.35, 22, 24)] },
          { text: '2.', confidence: 92, bbox: { x0: 8, y0: 544 * 1.35, x1: 34, y1: 568 * 1.35 }, words: [word('2.', 8, 544 * 1.35, 26, 24)] },
        ] } };
      }, terminate: async () => {},
    }) };
    window.__ocrCalls = () => call;
    window.__stripWidths = () => stripWidths;
  });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.request().url().endsWith('pdf.min.mjs') ? r.fulfill({ contentType: 'text/javascript', body: fakePdfjs }) : r.fulfill({ status: 404 }));
  await page.goto('http://localhost:8770/');
  const items = [];
  for (const y of [760, 570, 380, 190]) {
    items.push({ str: '□', x: 40, y, size: 12 }, { str: '함수의 값을 구하시오', x: 60, y, size: 11 }, { str: '식을 정리하면 답을 구할 수 있다', x: 60, y: y - 28, size: 10 });
  }
  const spec = { pages: [{ noText: true, items }] };
  await page.fill('#in-name', '스마트 OCR');
  await page.setInputFiles('#in-problem', { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(spec)) });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled && /판정 완료|오류:/.test(document.querySelector('#ingest-log').textContent), null, { timeout: 30000 });
  const state = await page.evaluate(async () => {
    const p = (await M.db.all('pages'))[0], items = (await M.db.all('items')).filter((x) => x.kind === 'problem');
    return { diag: p.diagnostics, lines: p.lines.map((x) => [x.text, x.source]), items: items.map((x) => [x.number, x.detection]), calls: window.__ocrCalls() };
  });
  check('nested blocks OCR 출력을 line으로 복구', state.lines.some(([t]) => t.includes('함수 값을')));
  check('전체 OCR 번호 0개이면 번호 lane 정밀 OCR 1회', state.diag.stripRetried && state.calls === 2 && state.diag.lexicalCandidates >= 2, JSON.stringify(state.diag));
  check('원문자·일반 번호와 시각 경계를 합쳐 문제 4개 자동 분리', state.items.length === 4 && state.items.map((x) => x[0]).join() === '1,2,3,4', JSON.stringify(state.items));
  check('OCR 못 읽은 두 문제는 번호 추정 표시', state.items.filter((x) => x[1]?.inferred).length === 2);
  const reanalyzed = await page.evaluate(async () => {
    const b = (await M.db.all('books'))[0], p = (await M.db.all('pages'))[0];
    await M.db.update('pages', p.id, (x) => { delete x.visualStarts; delete x.diagnostics; }); // 이전 버전 페이지처럼 만듦
    const items = await M.pipeline.segmentKind(b, 'problem');
    const upgraded = await M.db.get('pages', p.id);
    return { n: items.length, visual: upgraded.visualStarts?.length || 0, upgraded: !!upgraded.diagnostics?.upgradedVisualLayout };
  });
  check('예전에 저장한 페이지도 PDF 재스캔 없이 시각 경계를 다시 분석', reanalyzed.n === 4 && reanalyzed.visual >= 3 && reanalyzed.upgraded, JSON.stringify(reanalyzed));

  // 2단 스캔: 번호 영역 OCR을 단마다 따로 해야 같은 높이의 오른쪽 번호(3, 4)를 잃지 않는다
  await page.evaluate(() => { window.__scenario = 'two-col'; });
  const twoItems = [];
  // 실제 2단 책처럼 각 단의 글줄이 쪽 너비의 40% 가까이 차도록 (왼쪽 단 40~280pt, 오른쪽 단 330~570pt)
  for (const [x, y] of [[40, 760], [40, 420], [330, 760], [330, 420]]) {
    twoItems.push({ str: '□', x, y, size: 12 }, { str: '함수의 값을 구하시오 단 조건을 모두 만족', x: x + 20, y, size: 10 },
      { str: '식을 정리하면 답을 구할 수 있다 따라서', x: x + 20, y: y - 28, size: 10 }, { str: '그 값을 이용해 넓이를 구한다', x: x + 20, y: y - 56, size: 10 });
  }
  await page.fill('#in-name', '2단 스캔');
  await page.setInputFiles('#in-problem', { name: 'scan2.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify({ pages: [{ noText: true, items: twoItems }] })) });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled, null, { timeout: 30000 });
  await page.waitForFunction(async () => (await M.db.all('books')).some((b) => b.name === '2단 스캔' && b.ingest?.status === 'complete'), null, { timeout: 30000 });
  const two = await page.evaluate(async () => {
    const b = (await M.db.all('books')).find((x) => x.name === '2단 스캔');
    const p = (await M.db.byBook('pages', b.id))[0];
    const items = (await M.db.byBook('items', b.id)).filter((x) => x.kind === 'problem').sort((x, y) => x.number - y.number);
    return { cols: p.columns.length, diag: p.diagnostics, widths: window.__stripWidths(), items: items.map((x) => [x.number, !!x.detection?.inferred, x.fragments[0].x0 > 560 ? 'R' : 'L']) };
  });
  check('2단 페이지의 번호 영역 OCR을 단마다 따로 실행 (넓게 붙인 strip 없음)', two.cols === 2 && two.widths.length === 2 && two.widths.every((w) => w <= 350), JSON.stringify({ cols: two.cols, widths: two.widths }));
  check('같은 높이의 오른쪽 단 번호까지 읽어 문제 4개 모두 OCR 번호로 분리', JSON.stringify(two.items) === JSON.stringify([[1, false, 'L'], [2, false, 'L'], [3, false, 'R'], [4, false, 'R']]) && two.diag.lexicalCandidates >= 4, JSON.stringify(two));
  check('스마트 OCR 흐름 JS 오류 없음', errors.length === 0, errors.join(' | '));
  await context.close(); await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
