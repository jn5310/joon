// 안정성 회귀 테스트: 감사에서 찾은 오류들이 다시 생기지 않는지 (저장소 외부 테스트 전용)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs, fakeJspdf } = require('./fakes');
const { problemBook, solutionBook } = require('./gen');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});
const pdf = (spec) => ({ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(spec)) });

async function newEnv(browser, { ocrFailures = 0 } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(({ ocrFailures }) => {
    let created = 0;
    window.Tesseract = { createWorker: async () => {
      if (created++ < ocrFailures) throw new Error('Tesseract.js 로드 실패: 테스트');
      return { recognize: async () => ({ data: { lines: [] } }), terminate: async () => {} };
    } };
  }, { ocrFailures });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { dialogs.push(d.message()); if (d.type() === 'prompt') await d.accept(page.__answer ?? ''); else await d.accept(); });
  let llmCalls = 0;
  await page.route('https://cdn.jsdelivr.net/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('pdf.min.mjs')) return route.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    if (u.includes('jspdf')) return route.fulfill({ contentType: 'text/javascript', body: fakeJspdf });
    return route.fulfill({ status: 404 });
  });
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    llmCalls++;
    await new Promise((r) => setTimeout(r, 60));
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"problems":[{"problem_number":null,"passage":null,"question":"$\\\\sum_{k=1}^{n} a_k$의 값은?","choices":["① $1$","② $2$"],"has_figure_or_diagram":false,"topic":"수학 I - 수열","difficulty_level":4,"difficulty_reasoning":"t"}]}' }] } }] }) });
  });
  await page.goto('http://localhost:8768/');
  return { context, page, errors, dialogs, calls: () => llmCalls };
}
async function ingest(page, pSpec, sSpec, { name = '안정성 테스트', forceOcr = false, clearSkip = false } = {}) {
  await page.click('#tabs button[data-tab=ingest]');
  await page.fill('#in-name', name);
  await page.setInputFiles('#in-problem', pdf(pSpec));
  if (sSpec) await page.setInputFiles('#in-solution', pdf(sSpec)); else await page.setInputFiles('#in-solution', []);
  await page.evaluate(({ forceOcr, clearSkip }) => {
    document.querySelector('#opt-ocr').checked = forceOcr;
    if (clearSkip) document.querySelector('#opt-skip').value = '';
  }, { forceOcr, clearSkip });
  await page.evaluate(() => { document.querySelector('#ingest-log').textContent = ''; });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled && /판정 완료|분리 완료|오류:/.test(document.querySelector('#ingest-log').textContent), null, { timeout: 60000 });
  return page.textContent('#ingest-log');
}
const state = (page) => page.evaluate(async () => ({ books: await M.db.all('books'), pages: (await M.db.all('pages')).length, items: await M.db.all('items') }));

(async () => {
  await new Promise((r) => server.listen(8768, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  // 1) 2단 텍스트 PDF 줄 만들기: 좁은 여백·기준선 차이·위첨자가 있어도 양쪽 번호를 모두 찾는다
  let env = await newEnv(browser);
  const lineCase = await env.page.evaluate(() => {
    const vp = { scale: 2, convertToViewportPoint: (x, y) => [x * 2, (842 - y) * 2] };
    const W = (s, size) => s.length * size * 0.5;
    const item = (str, x, y, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width: W(str, size), height: size });
    const items = [
      // 같은 기준선, 여백 15pt(=1.5em): 예전에는 한 줄로 합쳐져 오른쪽 5번이 사라졌다
      item('1.', 40, 700), item('왼쪽 단의 긴 문장이 단 끝까지 이어집니다', 55, 700),
      item('5.', 300, 700), item('오른쪽 단 문제', 315, 700),
      // 오른쪽 줄이 3pt 높음: 예전에는 왼쪽 줄 전체가 오른쪽에 붙어 왼쪽 2번이 사라졌다
      item('2.', 40, 600), item('왼쪽 두 번째 문제의 본문이 이어짐', 55, 600),
      item('6.', 300, 603), item('오른쪽 두 번째', 315, 603),
      // 번호 줄의 위첨자: 예전에는 위첨자 "2"가 줄 첫 낱말이 되어 3번이 사라졌다
      item('3.', 40, 500), item('이차방정식 x', 55, 500), item('2', 110, 503.3, 6.5), item('-5x+6=0', 115, 500),
    ];
    const columns = [{ x0: 80, x1: 590 }, { x0: 600, x1: 1110 }];
    const lines = M.pdfsource.textItemsToLines(items, vp, columns);
    const page = { index: 1, width: 1190, height: 1684, columns, lines };
    return { nums: M.segment.findCandidates(page, {}).map((c) => `${c.col}:${c.num}`).sort(), lines: lines.map((l) => l.text) };
  });
  check('2단 텍스트: 좁은 여백·기준선 차이·위첨자에도 번호 6개 모두 인식', lineCase.nums.join(',') === '0:1,0:2,0:3,1:5,1:6', JSON.stringify(lineCase));

  // 2) 처리 중 오류: 저장된 쪽은 남고, 책은 "처리 오류"로 표시되며, 다시 분리로 복구된다
  const broken = problemBook();
  broken.pages[1].throwOnRender = true;
  let log = await ingest(env.page, broken, null, { name: '오류 책' });
  let st = await state(env.page);
  let b = st.books.find((x) => x.name === '오류 책');
  check('처리 오류 시 친절한 안내와 복구 방법 표시', log.includes('오류: 테스트용 렌더링 실패') && log.includes('자동 인식 다시 분석'), log.split('\n').slice(-3).join(' / '));
  check('오류 난 책은 상태·저장된 쪽 수를 기록', b.ingest.status === 'error' && b.pageCounts.problem === 1 && st.pages === 1, JSON.stringify(b.ingest));
  await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(300);
  check('라이브러리에 "처리 오류" 표시', (await env.page.textContent('#lib-books')).includes('처리 오류'));
  await env.page.click('#tabs button[data-tab=review]'); await env.page.waitForTimeout(500);
  check('검토 화면에 복구 안내 표시', (await env.page.textContent('#rv-status')).includes('오류로 멈춘 책') && (await env.page.textContent('#rv-pages')) === '1');
  await env.page.click('#rv-reseg');
  await env.page.waitForFunction(() => !document.querySelector('#rv-reseg').disabled && document.querySelector('#rv-count').textContent === '(4개)', null, { timeout: 20000 });
  st = await state(env.page); b = st.books.find((x) => x.name === '오류 책');
  check('다시 분리로 저장된 쪽의 문제 복구 (4개) + 부분 처리로 전환', st.items.filter((i) => i.kind === 'problem').length === 4 && b.ingest.status === 'stopped', JSON.stringify(b.ingest));
  check('오류 흐름 중 예상 밖 JS 오류 없음', env.errors.length === 0, env.errors.join(' | '));
  await env.context.close();

  // 3) OCR 프로그램 로드 실패 후 새로고침 없이 다시 시도하면 성공
  env = await newEnv(browser, { ocrFailures: 2 });
  log = await ingest(env.page, problemBook(), null, { name: 'OCR 1차', forceOcr: true });
  check('OCR 로드 실패 시 인터넷 확인 안내', log.includes('필요한 프로그램을 내려받지 못했습니다'), log.split('\n').slice(-2).join(' / '));
  log = await ingest(env.page, problemBook(), null, { name: 'OCR 2차', forceOcr: true });
  st = await state(env.page);
  check('실패를 기억하지 않고 두 번째 처리는 성공', !log.includes('오류:') && st.books.find((x) => x.name === 'OCR 2차')?.ingest.status === 'complete', log.split('\n').slice(-1).join(''));
  await env.context.close();

  // 4) 정상 책으로 나머지 기능 점검
  env = await newEnv(browser);
  log = await ingest(env.page, problemBook(), solutionBook(), { name: '정상 책', clearSkip: true });
  st = await state(env.page);
  check('고급 설정 칸을 비워도 기본값으로 처리 (문제 12개)', st.items.filter((i) => i.kind === 'problem').length === 12, log.split('\n').find((l) => l.startsWith('완료')));
  const bookId = st.books[0].id;
  const p3 = st.items.find((i) => i.kind === 'problem' && i.number === 3);

  // 4-1) 다시 분리해도 같은 번호 문제의 직접 지정 난이도·유형 유지
  await env.page.evaluate(async (id) => { await M.db.update('items', id, (f) => { f.gradeManual = 1; f.typeManual = '확률'; f.typeLLM = '수열'; }); }, p3.id);
  await env.page.click('#tabs button[data-tab=review]'); await env.page.waitForTimeout(500);
  await env.page.click('#rv-reseg');
  await env.page.waitForFunction(() => !document.querySelector('#rv-reseg').disabled, null, { timeout: 20000 });
  await env.page.waitForTimeout(300);
  st = await state(env.page);
  const new3 = st.items.find((i) => i.kind === 'problem' && i.number === 3);
  check('다시 분리 후에도 직접 지정·AI 판정 유지', new3.id !== p3.id && new3.gradeManual === 1 && new3.typeManual === '확률' && new3.typeLLM === '수열', JSON.stringify([new3.gradeManual, new3.typeManual, new3.typeLLM]));
  check('다시 분리 안내에 유지된다는 설명', env.dialogs.some((d) => d.includes('유지됩니다')));

  // 4-2) 다시 분리 중 실패하면 기존 분리 결과가 그대로 남는다 (페이지 이미지를 일부러 깨뜨림)
  const before = st.items.filter((i) => i.kind === 'problem').map((i) => i.id).sort().join();
  await env.page.evaluate(async (bid) => { await M.db.update('pages', `${bid}:problem:2`, (p) => { p.image = 'data:image/png;base64,AAAA'; }); }, bookId);
  await env.page.click('#rv-reseg');
  await env.page.waitForFunction(() => !document.querySelector('#rv-reseg').disabled, null, { timeout: 20000 });
  await env.page.waitForTimeout(300);
  st = await state(env.page);
  const resegMsg = env.dialogs[env.dialogs.length - 1];
  check('다시 분리 실패 시 기존 문제 12개 그대로 + 알아볼 수 있는 이유', st.items.filter((i) => i.kind === 'problem').map((i) => i.id).sort().join() === before
    && resegMsg.includes('기존 분리 결과는 그대로') && resegMsg.includes('이미지를 열 수 없습니다') && !resegMsg.includes('[object'), resegMsg);
  // 깨뜨린 페이지를 되돌린다 (이후 테스트용)
  await env.page.evaluate(async ({ bid, img }) => { await M.db.update('pages', `${bid}:problem:2`, (p) => { p.image = img; }); },
    { bid: bookId, img: await env.page.evaluate(async (bid) => (await M.db.get('pages', `${bid}:problem:1`)).image, bookId) });

  // 4-3) 한 트랜잭션 교체: 잘못된 항목이 섞이면 전부 취소
  const atomic = await env.page.evaluate(async (bid) => {
    const n0 = (await M.db.all('items')).length;
    let name = null;
    try { await M.db.replaceItems(bid, 'problem', [{ bookId: bid, kind: 'problem' }]); } catch (e) { name = e.name; }
    return { name, same: (await M.db.all('items')).length === n0 };
  }, bookId);
  await env.page.waitForTimeout(200);
  check('항목 교체 중 오류면 전부 취소 + 진짜 원인(DataError)을 돌려줌', atomic.name === 'DataError' && atomic.same && env.errors.length === 0, JSON.stringify(atomic) + ' ' + env.errors.join('|'));

  // 4-4) Backspace로 선택 영역 삭제 (Mac)
  const firstBox = await env.page.evaluate(async (bid) => (await M.db.all('items')).find((i) => i.bookId === bid && i.kind === 'problem' && i.number === 1).fragments[0], bookId);
  await env.page.evaluate(() => { document.querySelector('#rv-editor').open = true; });
  await env.page.locator('#rv-canvas').scrollIntoViewIfNeeded();
  const cv = await env.page.locator('#rv-canvas').boundingBox();
  const cw = await env.page.evaluate(() => document.querySelector('#rv-canvas').width);
  await env.page.evaluate(() => { document.querySelector('#rv-page').value = 1; document.querySelector('#rv-page').dispatchEvent(new Event('change')); });
  await env.page.waitForTimeout(400);
  await env.page.mouse.click(cv.x + (firstBox.x0 + 20) * cv.width / cw, cv.y + (firstBox.y0 + 20) * cv.width / cw);
  await env.page.waitForTimeout(200);
  await env.page.locator('body').press('Backspace');
  await env.page.waitForTimeout(600);
  st = await state(env.page);
  check('Backspace로도 선택 영역 삭제', !st.items.some((i) => i.kind === 'problem' && i.number === 1));

  // 4-5) 잘못된 단원·번호 저장 막기
  await env.page.locator('#rv-list button', { hasText: '보기' }).first().click();
  await env.page.waitForTimeout(500);
  const hasSide = await env.page.locator('#rv-side input[type=number]').count();
  if (hasSide) {
    await env.page.locator('#rv-side input[type=number]').nth(1).fill('');
    await env.page.locator('#rv-side button', { hasText: '번호 저장' }).click();
    await env.page.waitForTimeout(300);
  }
  check('빈 번호로 저장하지 않고 안내', hasSide > 0 && env.dialogs.some((d) => d.includes('1 이상의 정수')), `side inputs ${hasSide}`);

  // 4-6) AI 판정 버튼을 연달아 눌러도 한 번만 실행
  await env.page.click('#tabs button[data-tab=grade]');
  await env.page.fill('#gr-key', 'k'); await env.page.dispatchEvent('#gr-key', 'change');
  await env.page.fill('#gr-delay', '0'); await env.page.dispatchEvent('#gr-delay', 'change');
  await env.page.evaluate(() => { document.querySelector('#gr-llm').click(); document.querySelector('#gr-llm').click(); document.querySelector('#gr-llm-all').click(); });
  await env.page.waitForFunction(() => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length >= 1, null, { timeout: 30000 });
  await env.page.waitForTimeout(500);
  const nProblems = (await state(env.page)).items.filter((i) => i.kind === 'problem').length;
  check('AI 판정 중복 실행 방지 (요청 수 = 문제 수)', env.calls() === nProblems && (await env.page.textContent('#gr-log')).match(/AI 판정 끝/g).length === 1, `호출 ${env.calls()} / 문제 ${nProblems}`);

  // 4-7) 새 책은 시험지 필터에서 자동으로 켜지고, 모두 끄면 아무것도 고르지 않는다
  await ingest(env.page, problemBook(), solutionBook(), { name: '두 번째 책' });
  await env.page.click('#tabs button[data-tab=build]'); await env.page.waitForTimeout(400);
  const bookBoxes = await env.page.$$eval('#bd-books input', (xs) => xs.map((x) => x.checked));
  check('새로 추가한 책도 "전체 선택" 모드에서는 켜진 상태', bookBoxes.length === 2 && bookBoxes.every(Boolean), JSON.stringify(bookBoxes));
  const secondId = (await state(env.page)).books.find((b) => b.name === '두 번째 책').id;
  await env.page.uncheck(`#bd-books input[value="${secondId}"]`);
  await env.page.fill('#bd-count', '6'); await env.page.click('#bd-select'); await env.page.waitForTimeout(300);
  let chosenBooks = await env.page.$$eval('#bd-list .card .hint', (xs) => xs.map((x) => x.textContent));
  check('원하는 책만 선택하면 다른 책 문제는 하나도 들어오지 않음', chosenBooks.length === 6 && chosenBooks.every((x) => x.includes('정상 책') && !x.includes('두 번째 책')), chosenBooks.join(' | '));
  await env.page.selectOption('#bd-target', '4'); await env.page.waitForTimeout(100);
  check('책·난이도 조건을 바꾸면 옛 선택을 비워 잘못된 PDF 방지', (await env.page.locator('#bd-list .card').count()) === 0 && (await env.page.textContent('#bd-info')).includes('다시 골라'));
  await env.page.reload(); await env.page.click('#tabs button[data-tab=build]'); await env.page.waitForTimeout(500);
  check('페이지를 새로 열어도 직접 고른 책 상태 유지', await env.page.locator(`#bd-books input[value="${secondId}"]`).isChecked() === false && (await env.page.textContent('#bd-books-summary')).includes('1/2권'));
  await env.page.click('#bd-books-all');
  check('책 전체 선택 버튼', (await env.page.$$eval('#bd-books input', (xs) => xs.every((x) => x.checked))) && (await env.page.textContent('#bd-books-summary')).includes('2/2권'));
  await env.page.click('#bd-books-none');
  await env.page.click('#bd-select'); await env.page.waitForTimeout(300);
  check('책 전체 해제 버튼: 문제를 고르지 않고 안내', (await env.page.locator('#bd-list .card').count()) === 0 && (await env.page.textContent('#bd-info')).includes('조건에 맞는 문제가 없습니다'));
  await env.page.click('#bd-books-all');
  await env.page.fill('#bd-count', '');
  await env.page.click('#bd-select'); await env.page.waitForTimeout(300);
  check('문항 수를 비우면 기본값 20으로', (await env.page.inputValue('#bd-count')) === '20' && (await env.page.locator('#bd-list .card').count()) > 0);
  await env.page.fill('#bd-count', '999');
  await env.page.click('#bd-select'); await env.page.waitForTimeout(300);
  const cards = await env.page.locator('#bd-list .card').count();
  // 모든 문제를 고른 상태에서 교체하면 바꿀 문제가 없다는 안내
  await env.page.locator('#bd-list .card button', { hasText: '교체' }).first().click();
  await env.page.waitForTimeout(200);
  check('바꿀 문제가 없으면 교체 안내', (await env.page.inputValue('#bd-count')) === '500' && cards > 0 && env.dialogs.some((d) => d.includes('바꿀 수 없습니다')), `cards ${cards}`);

  // 4-8) PDF: 첫 쪽 제목 아래에서 시작하는 아주 긴 문제도 여백 안에
  const tall = await env.page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 12000;
    const img = c.toDataURL('image/png');
    const e = { problem: { image: img, imageFormat: 'PNG', w: 400, h: 12000, scale: 2, number: 7, section: 2, gradeManual: 3 }, solution: null, book: { name: 'B' } };
    const doc = await M.build.buildPdf([e], { title: '아주 긴 제목 '.repeat(40), subtitle: 's', mode: 'pair', columns: 1, zoom: 2, answerKey: false, showSource: true });
    return window.__pdf = null, doc.ops.filter((o) => o[0] === 'image').map(([, , x, y, w, h, pg]) => ({ x, y, w, h, pg }));
  });
  const inside = tall.every((o) => o.y >= 13.9 && o.y + o.h <= 297 - 14 - 6 + 0.01 && o.x + o.w <= 196.01);
  check('첫 쪽의 아주 긴 문제·긴 제목도 여백 안에 배치', inside, JSON.stringify(tall.map((o) => [o.pg, +o.y.toFixed(1), +(o.y + o.h).toFixed(1)])));

  // 4-9) 백업 가져오기: 잘못된 파일 안내, 같은 파일 두 번, createdAt 없는 책
  await env.page.click('#tabs button[data-tab=library]');
  await env.page.setInputFiles('#lib-import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
  await env.page.waitForTimeout(400);
  check('깨진 백업 파일은 이유와 함께 안내', env.dialogs.some((d) => d.includes('가져오기 실패') && d.includes('JSON')));
  const legacy = { books: [{ id: 'legacyB', name: '예전 책' }], pages: [], items: [] };
  for (let k = 0; k < 2; k++) {
    await env.page.setInputFiles('#lib-import', { name: 'old.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy)) });
    await env.page.waitForTimeout(600);
  }
  const imported = env.dialogs.filter((d) => d.startsWith('가져오기 완료')).length;
  check('같은 파일을 두 번 골라도 가져오기 동작 + createdAt 없는 책도 목록에 표시', imported === 2 && (await env.page.textContent('#lib-books')).includes('예전 책'), `완료 알림 ${imported}회`);
  check('라이브러리에 책별 유형 요약·저장 공간 표시', (await env.page.textContent('#lib-books')).includes('유형:') && (await env.page.textContent('#lib-storage')).includes('브라우저 내부 저장'));

  // 4-10) 책 삭제는 페이지·항목까지 한 번에
  const delId = (await state(env.page)).books.find((x) => x.name === '두 번째 책').id;
  const del = await env.page.evaluate(async (id) => {
    await M.db.deleteBook(id);
    return { books: (await M.db.all('books')).some((b) => b.id === id), pages: (await M.db.all('pages')).some((p) => p.bookId === id), items: (await M.db.all('items')).some((i) => i.bookId === id) };
  }, delId);
  check('책 삭제 시 페이지·항목 모두 제거', !del.books && !del.pages && !del.items, JSON.stringify(del));

  check('4번 흐름 전체에서 예상 밖 JS 오류 없음', env.errors.length === 0, env.errors.join(' | '));

  // 4-11) 예상 못한 오류는 화면 아래 알림으로 보인다
  env.errors.length = 0;
  await env.page.evaluate(() => { setTimeout(() => Promise.reject(new Error('테스트 알림')), 0); });
  await env.page.waitForTimeout(300);
  check('처리되지 않은 오류를 화면 알림으로 표시', await env.page.evaluate(() => !document.querySelector('#toast').hidden && document.querySelector('#toast').textContent.includes('테스트 알림')));
  await env.context.close();

  // 5) 해설지 처리 중 오류: 이미 분리된 문제는 판정되어 바로 쓸 수 있고, 해설지가 남았다고 안내한다
  env = await newEnv(browser);
  const sBroken = solutionBook();
  sBroken.pages[1].throwOnRender = true;
  log = await ingest(env.page, problemBook(), sBroken, { name: '해설 오류 책' });
  st = await state(env.page);
  let hb = st.books.find((x) => x.name === '해설 오류 책');
  let hp = st.items.filter((i) => i.bookId === hb.id && i.kind === 'problem');
  check('해설지 오류에도 문제 12개는 난이도 판정까지 완료', hp.length === 12 && hp.every((p) => p.gradeHeur >= 1) && hb.ingest.status === 'error' && hb.pageCounts.solution === 1, JSON.stringify(hb.ingest));
  await env.page.click('#tabs button[data-tab=review]'); await env.page.waitForTimeout(500);
  check('검토 안내에 "해설지는 아직 나뉘지 않음" 표시', (await env.page.textContent('#rv-status')).includes('해설지는 페이지만 저장되고 아직 나뉘지 않았습니다'), await env.page.textContent('#rv-status'));
  await env.page.click('#rv-reseg');
  await env.page.waitForFunction(() => !document.querySelector('#rv-reseg').disabled, null, { timeout: 20000 });
  await env.page.waitForTimeout(300);
  hb = (await state(env.page)).books.find((x) => x.name === '해설 오류 책');
  check('문제집만 다시 분리하면 해설지가 남아 있으므로 상태 유지', hb.ingest.status === 'error');
  await env.page.selectOption('#rv-kind', 'solution'); await env.page.waitForTimeout(400);
  // 다시 분리 도중에는 책·종류 선택을 잠근다 (교체를 일부러 늦춰 확인)
  await env.page.evaluate(() => { window.__r = M.db.replaceItems; M.db.replaceItems = async (...a) => { await new Promise((r) => setTimeout(r, 700)); return window.__r(...a); }; });
  await env.page.click('#rv-reseg');
  await env.page.waitForTimeout(250);
  const locked = await env.page.evaluate(() => ['#rv-book', '#rv-kind', '#rv-relink'].every((s) => document.querySelector(s).disabled));
  await env.page.waitForFunction(() => !document.querySelector('#rv-reseg').disabled, null, { timeout: 20000 });
  await env.page.waitForTimeout(300);
  await env.page.evaluate(() => { M.db.replaceItems = window.__r; });
  st = await state(env.page);
  hb = st.books.find((x) => x.name === '해설 오류 책');
  hp = st.items.filter((i) => i.bookId === hb.id && i.kind === 'problem');
  check('다시 분리 중 책·종류 선택 잠금', locked);
  check('해설지까지 나뉘면 "부분 처리"로 바뀌고 해설 연결', hb.ingest.status === 'stopped' && hp.filter((p) => p.solutionId).length === 6, `${hb.ingest.status} 연결 ${hp.filter((p) => p.solutionId).length}`);

  // 5-1) "보기" 버튼에 커서가 있을 때 Backspace를 눌러도 지우지 않는다
  await env.page.selectOption('#rv-kind', 'problem'); await env.page.waitForTimeout(400);
  const n0 = (await state(env.page)).items.length;
  await env.page.locator('#rv-list button', { hasText: '보기' }).nth(1).click();
  await env.page.waitForTimeout(300);
  await env.page.keyboard.press('Backspace');
  await env.page.waitForTimeout(400);
  check('버튼에 커서가 있으면 Backspace로 지우지 않음', (await state(env.page)).items.length === n0);

  // 5-2) 다른 창에서 처리 중인 책과 끊긴 책 구분 (살아 있다는 표시의 시각으로 판단)
  await env.page.evaluate(async () => {
    const base = { createdAt: new Date().toISOString(), pageCounts: { problem: 0, solution: 0 } };
    await M.db.put('books', { ...base, id: 'bLive', name: '다른 창 처리 중', ingest: { status: 'processing', updatedAt: Date.now() } });
    await M.db.put('books', { ...base, id: 'bDead', name: '오래전 끊긴 책', ingest: { status: 'processing', updatedAt: Date.now() - 3600000 } });
  });
  await env.page.reload();
  await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(600);
  const rowOf = (name) => env.page.locator('.bookrow', { hasText: name });
  check('다른 창에서 처리 중인 책은 "처리 중" + 삭제 잠금', (await rowOf('다른 창 처리 중').textContent()).includes('처리 중') && !(await rowOf('다른 창 처리 중').textContent()).includes('중단') && await rowOf('다른 창 처리 중').locator('button', { hasText: '삭제' }).isDisabled());
  check('오래 소식 없는 책은 "처리 중단됨" + 삭제 가능', (await rowOf('오래전 끊긴 책').textContent()).includes('처리 중단됨') && await rowOf('오래전 끊긴 책').locator('button', { hasText: '삭제' }).isEnabled());
  // 화면의 책 정보가 오래돼도(6분 전) 저장소의 최신 기록이 "처리 중"이면 삭제·다시 분리를 막는다
  await env.page.evaluate(async () => { await M.db.update('books', 'bDead', (b) => { b.ingest.updatedAt = Date.now(); }); });
  await env.page.click('#tabs button[data-tab=review]'); await env.page.waitForTimeout(300);
  await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(600);
  check('라이브러리를 열면 최신 기록으로 상태 갱신 (끊긴 책 → 처리 중)', (await rowOf('오래전 끊긴 책').textContent()).includes('처리 중') && await rowOf('오래전 끊긴 책').locator('button', { hasText: '삭제' }).isDisabled());
  await env.page.evaluate(async () => { await M.db.update('books', 'bLive', (b) => { b.ingest.updatedAt = Date.now() + 1; }); });
  const staleGuard = await env.page.evaluate(async () => {
    // 화면 목록에는 오래된 기록이 있다고 가정: 저장소 기록만 새로 고치고 삭제 버튼을 억지로 누른다
    const row = [...document.querySelectorAll('.bookrow')].find((r) => r.textContent.includes('다른 창 처리 중'));
    const btn = [...row.querySelectorAll('button')].find((b) => b.textContent === '삭제');
    btn.disabled = false; btn.click();
    await new Promise((r) => setTimeout(r, 400));
    return !!(await M.db.get('books', 'bLive'));
  });
  check('화면이 오래돼도 삭제 직전에 최신 기록을 확인해 처리 중인 책은 지키기', staleGuard && env.dialogs.some((d) => d.includes('처리 중입니다')));
  check('5번 흐름 전체에서 예상 밖 JS 오류 없음', env.errors.length === 0, env.errors.join(' | '));
  await env.context.close();

  // 5-3) 줄 단위 백업이 중간에 잘려도 주인 없는 페이지·문제가 남지 않는다 + 외부 이미지 주소 거부
  env = await newEnv(browser);
  const lines = [JSON.stringify({ format: 'math-finder-backup', version: 2 })];
  lines.push(JSON.stringify({ s: 'books', v: { id: 'bT', name: '잘린 백업 책', createdAt: '2026-01-01', pageCounts: { problem: 60, solution: 0 } } }));
  for (let k = 0; k < 60; k++) lines.push(JSON.stringify({ s: 'pages', v: { id: `bT:problem:${k + 1}`, bookId: 'bT', kind: 'problem', index: k + 1, image: 'data:image/png;base64,iVBORw0KGgo=', columns: [], lines: [] } }));
  lines.push(JSON.stringify({ s: 'pages', v: { id: 'bT:problem:99', bookId: 'bT', kind: 'problem', index: 99, image: 'https://example.com/track.png', columns: [], lines: [] } }));
  lines.push(JSON.stringify({ s: 'constructor', v: { id: 'x' } }));
  lines.push('{"s":"items","v":{"id":"p1","bookId":"bT","kind":"problem","sec'); // 잘린 줄
  await env.page.click('#tabs button[data-tab=library]');
  await env.page.setInputFiles('#lib-import', { name: 'cut.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(lines.join('\n')) });
  await env.page.waitForTimeout(1200);
  const cut = await env.page.evaluate(async () => ({ book: !!(await M.db.get('books', 'bT')), pages: (await M.db.all('pages')).length, remote: !!(await M.db.get('pages', 'bT:problem:99')) }));
  const cutMsg = env.dialogs[env.dialogs.length - 1] || '';
  check('잘린 백업: 책 기록이 먼저 저장되어 주인 없는 데이터 없음 + 들어온 양 안내', cut.book && cut.pages === 60 && cutMsg.includes('손상') && cutMsg.includes('이미 들어왔습니다'), JSON.stringify(cut) + ' ' + cutMsg);
  check('백업의 외부 이미지 주소·이상한 저장소 이름은 무시', !cut.remote && env.errors.length === 0, env.errors.join(' | '));
  await env.context.close();

  // 7) 마지막 리뷰 사항: 옛 사본 덮어쓰기 방지, AI 판정 중 잠금, 예전 책 안내
  env = await newEnv(browser);
  await ingest(env.page, problemBook(), solutionBook(), { name: '잠금 테스트 책' });
  const lockBook = (await state(env.page)).books.find((x) => x.name === '잠금 테스트 책');
  // 7-1) 이 창의 목록이 "처리 중" 사본을 들고 있어도, 수준을 바꾸면 수준만 저장되고 완료 상태는 그대로
  await env.page.evaluate(async (id) => { await M.db.update('books', id, (b) => { b.ingest = { status: 'processing', updatedAt: Date.now() }; b.pageCounts = { problem: 1, solution: 0 }; }); }, lockBook.id);
  await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(500); // 이 창은 "처리 중" 사본을 읽음
  await env.page.evaluate(async (b) => { await M.db.put('books', b); }, lockBook); // 다른 창이 처리를 마침 (완료 기록)
  await env.page.locator('.bookrow', { hasText: '잠금 테스트 책' }).locator('select').selectOption('exam');
  await env.page.waitForTimeout(600);
  const afterLevel = await env.page.evaluate(async (id) => M.db.get('books', id), lockBook.id);
  check('옛 사본으로 수준을 바꿔도 완료 기록·쪽 수를 덮어쓰지 않음', afterLevel.level === 'exam' && afterLevel.ingest.status === 'complete' && afterLevel.pageCounts.problem === 3 && afterLevel.pageCounts.solution === 2, JSON.stringify([afterLevel.level, afterLevel.ingest.status, afterLevel.pageCounts]));
  // 7-2) AI 판정 중인 책은 삭제·다시 분리를 막고 상태를 표시
  await env.page.click('#tabs button[data-tab=grade]');
  await env.page.selectOption('#gr-book', lockBook.id);
  await env.page.fill('#gr-key', 'k'); await env.page.dispatchEvent('#gr-key', 'change');
  await env.page.fill('#gr-delay', '150'); await env.page.dispatchEvent('#gr-delay', 'change');
  await env.page.click('#gr-llm-all');
  await env.page.waitForTimeout(300);
  await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(400);
  const busyRow = env.page.locator('.bookrow', { hasText: '잠금 테스트 책' });
  check('AI 판정 중에는 "분리·AI 판정 중" 표시 + 삭제 잠금', (await busyRow.textContent()).includes('분리·AI 판정 중') && await busyRow.locator('button', { hasText: '삭제' }).isDisabled());
  await env.page.click('#tabs button[data-tab=review]'); await env.page.waitForTimeout(400);
  await env.page.selectOption('#rv-book', lockBook.id); await env.page.waitForTimeout(400);
  const dBefore = env.dialogs.length;
  await env.page.click('#rv-reseg'); await env.page.waitForTimeout(300);
  check('AI 판정 중에는 다시 분리 거절', env.dialogs.slice(dBefore).some((d) => d.includes('처리 중(분리·AI 판정)')));
  await env.page.waitForFunction(() => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length >= 1, null, { timeout: 30000 });
  // 7-3) 새 기록(segmented)이 없는 예전 책: 해설이 0개여도 "아직 나뉘지 않았습니다"라고 하지 않는다
  await env.page.evaluate(async () => {
    await M.db.put('books', { id: 'bOld', name: '예전에 만든 책', createdAt: '2025-01-01', pageCounts: { problem: 0, solution: 2 }, ingest: { status: 'complete' } });
  });
  await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(400);
  await env.page.click('#tabs button[data-tab=review]'); await env.page.waitForTimeout(300);
  await env.page.selectOption('#rv-book', 'bOld'); await env.page.waitForTimeout(500);
  check('예전 책에 "아직 나뉘지 않았습니다" 잘못된 안내 없음', !(await env.page.textContent('#rv-status')).includes('나뉘지 않았습니다'));
  check('7번 흐름 전체에서 예상 밖 JS 오류 없음', env.errors.length === 0, env.errors.join(' | '));
  await env.context.close();

  // 6) 저장 공간 부족: 알아볼 수 있는 안내, 책이 목록에 보이고, "처리 중"으로 남지 않는다
  for (const quota of [400000, 900000]) {
    env = await newEnv(browser);
    const cdp = await env.context.newCDPSession(env.page);
    await cdp.send('Storage.overrideQuotaForOrigin', { origin: 'http://localhost:8768', quotaSize: quota });
    log = await ingest(env.page, problemBook(), solutionBook(), { name: `공간 ${quota}` });
    const quotaMsg = log.includes('저장 공간이 부족합니다');
    await env.page.click('#tabs button[data-tab=library]'); await env.page.waitForTimeout(600);
    const lib = await env.page.textContent('#lib-books');
    const booksNow = (await state(env.page)).books;
    const completedWithinQuota = booksNow[0]?.ingest?.status === 'complete' && !log.includes('저장 공간이 부족합니다');
    check(`저장 공간 ${quota / 1000}KB 한도: 실패면 안내·복구, Blob 절감으로 성공하면 완료`,
      completedWithinQuota || (quotaMsg && (booksNow.length === 0 || (lib.includes(`공간 ${quota}`) && !/처리 중(?!단)/.test(lib))) && !(await env.page.locator('#btn-ingest').isDisabled())),
      `${log.split('\n').filter((l) => /저장 공간|주의|오류|완료/.test(l)).join(' / ')} | 책 ${booksNow.length} | ${lib.slice(0, 80)}`);
    await env.context.close();
  }

  await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
