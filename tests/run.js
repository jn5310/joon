// MathBook 전체 흐름 E2E (헤드리스 Chromium, CDN은 가짜 구현으로 대체)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs, fakeJspdf } = require('./fakes');
const { problemBook, solutionBook } = require('./gen');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || path.join(require('os').tmpdir(), 'math-finder-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = f.endsWith('.html') ? 'text/html; charset=utf-8' : f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'content-type': type }); fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(8765, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  let llmCalls = 0, llmMimes = [], llmPrompts = [];
  await page.route('https://cdn.jsdelivr.net/**', (route) => {
    const u = route.request().url();
    if (u.endsWith('pdf.min.mjs')) return route.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    if (u.includes('jspdf')) return route.fulfill({ contentType: 'text/javascript', body: fakeJspdf });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.route('https://generativelanguage.googleapis.com/**', (route) => {
    llmCalls++;
    page.evaluate((n) => { window.__llmCalls = n; }, llmCalls).catch(() => {});
    const body = JSON.parse(route.request().postData());
    const imageParts = body.contents[0].parts.filter((p) => p.inline_data);
    const nImages = imageParts.length;
    llmMimes.push(...imageParts.map((p) => p.inline_data.mime_type));
    llmPrompts.push({ system: body.systemInstruction?.parts?.[0]?.text || '', user: body.contents[0].parts.find((p) => p.text)?.text || '' });
    const answer = { problems: [{ problem_number: null, passage: null, question: `함수 $f(x) = \\frac{1}{2}x^2$에 대하여 (이미지 ${nImages}장)`, choices: ['① $1$', '② $2$', '③ $3$', '④ $4$', '⑤ $5$'], has_figure_or_diagram: false, topic: '수학 I - 수열', difficulty_level: 5, difficulty_reasoning: '테스트 응답' }] };
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) });
  });
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); if (d.type() === 'prompt') await d.accept(page.__promptAnswer ?? ''); else await d.accept(); });

  // 0. 초기 로딩
  await page.goto('http://localhost:8765/');
  await page.waitForTimeout(500);
  check('페이지 로딩 시 오류 없음', errors.length === 0, errors.join(' | '));
  check('과목/수준 선택지 채워짐', (await page.locator('#in-subject option').count()) > 5 && (await page.locator('#in-level option').count()) === 6);
  await page.screenshot({ path: `${SHOTS}/01-ingest.png` });

  // 1. 책 추가
  await page.fill('#in-name', '테스트 문제집');
  await page.selectOption('#in-subject', '수학I');
  const problemSpec = problemBook();
  problemSpec.pages[0].rects.push(
    { x: 120, y: 650, w: 100, h: 1.5, color: '#ddd' },
    { x: 120, y: 570, w: 1.5, h: 81.5, color: '#ddd' },
  );
  await page.setInputFiles('#in-problem', { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(problemSpec)) });
  await page.setInputFiles('#in-solution', { name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(solutionBook())) });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => /규칙 기반 난이도 판정 완료|오류:/.test(document.querySelector('#ingest-log').textContent), null, { timeout: 60000 });
  const log = await page.textContent('#ingest-log');
  check('처리 완료 (오류 없음)', !log.includes('오류:'), log.split('\n').filter((l) => /완료|오류/.test(l)).join(' / '));
  check('문제 12 / 해설 12 / 연결 12', log.includes('문제 12개, 해설 12개, 연결 12개'));
  check('로그 같은 형식 줄 덮어쓰기 동작 (줄 수 적음)', log.trim().split('\n').length < 12, `${log.trim().split('\n').length}줄`);
  await page.screenshot({ path: `${SHOTS}/02-ingest-done.png` });

  const dump = () => page.evaluate(async () => {
    const items = await M.db.all('items');
    return items.map(({ image, fragments, text, ...r }) => ({ ...r, hasImage: !!image, nfrag: fragments.length, text }));
  });
  let items = await dump();
  const probs = items.filter((i) => i.kind === 'problem').sort((a, b) => a.number - b.number);
  const sols = items.filter((i) => i.kind === 'solution').sort((a, b) => a.number - b.number);
  check('문제 번호 1~12 순서대로', probs.map((p) => p.number).join() === '1,2,3,4,5,6,7,8,9,10,11,12');
  check('모든 항목에 이미지', items.every((i) => i.hasImage));
  const imageState = await page.evaluate(async () => ({
    pages: (await M.db.all('pages')).map((p) => [p.imageFormat, p.image instanceof Blob ? p.image.type : typeof p.image === 'string' ? p.image.slice(5, 15) : p.image?.storage]),
    items: (await M.db.all('items')).map((i) => [i.imageFormat, i.image instanceof Blob ? i.image.type : typeof i.image === 'string' ? i.image.slice(5, 15) : i.image?.storage]),
  }));
  check('디지털 페이지를 무손실 PNG Blob으로 저장', imageState.pages.every(([fmt, src]) => fmt === 'PNG' && src === 'image/png'), JSON.stringify(imageState.pages));
  check('문제·해설 crop을 무손실 PNG Blob으로 저장', imageState.items.every(([fmt, src]) => fmt === 'PNG' && src === 'image/png'), JSON.stringify(imageState.items));
  const graphPixels = await page.evaluate(async () => {
    const p = (await M.db.all('items')).find((i) => i.kind === 'problem' && i.number === 1);
    const im = await M.imaging.loadImage(p.image);
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let gray = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] === 221 && d[i + 1] === 221 && d[i + 2] === 221) gray++;
    return gray;
  });
  check('OCR 후에도 연한 그래프 선 픽셀 원본값 유지', graphPixels > 100, `gray pixels=${graphPixels}`);
  const lightTrim = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 200; c.height = 100;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 200, 100);
    x.fillStyle = 'rgb(220,220,220)'; x.fillRect(10, 10, 181, 1); x.fillRect(10, 10, 1, 70);
    x.fillStyle = '#111'; x.fillRect(80, 40, 40, 20);
    return M.layout.trimBox(x.getImageData(0, 0, 200, 100), { x0: 0, y0: 0, x1: 200, y1: 100 }, 0);
  });
  check('연한 그래프 축도 자르기 경계에 포함', lightTrim.x0 === 10 && lightTrim.y0 === 10 && lightTrim.x1 === 191 && lightTrim.y1 === 80, JSON.stringify(lightTrim));
  check('배점 추출 ([3점]/[4점], "14점" 오탐 없음)', probs.every((p) => p.points === (p.text.split('\n').length >= 8 ? 4 : 3)), probs.map((p) => `${p.number}:${p.points}`).join(' '));
  check('텍스트가 줄바꿈으로 합쳐짐', probs[2].text.includes('\n'));
  check('해설 정답 추출', sols.every((s) => s.answer === ['①', '②', '③', '④', '⑤'][s.number % 5]), sols.map((s) => s.answer).join(''));
  check('해설 6번이 다음 쪽으로 이어짐 (조각 2개)', sols[5].nfrag === 2, `조각 ${sols[5].nfrag}개`);
  check('문제에 정답 복사됨', probs.every((p) => p.answer && p.solutionId));
  check('규칙 기반 등급 1~9', probs.every((p) => p.gradeHeur >= 1 && p.gradeHeur <= 9), probs.map((p) => p.gradeHeur).join(','));

  // 2. 검토·수정
  await page.click('#tabs button[data-tab=review]');
  await page.waitForTimeout(800);
  check('검토 목록 12개', (await page.textContent('#rv-count')) === '(12개)');
  await page.evaluate(() => { document.querySelector('#rv-editor').open = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/03-review.png`, fullPage: false });
  // 상자 클릭 → 선택
  const cv = page.locator('#rv-canvas');
  await cv.scrollIntoViewIfNeeded();
  const box = await cv.boundingBox();
  const cw = await page.evaluate(() => document.querySelector('#rv-canvas').width);
  const k = box.width / cw; // 화면 px / 캔버스 px
  const f0 = await page.evaluate(async () => (await M.db.all('items')).find((i) => i.kind === 'problem' && i.number === 1).fragments[0]);
  await page.mouse.click(box.x + (f0.x0 + 30) * k, box.y + (f0.y0 + 20) * k);
  await page.waitForTimeout(300);
  check('상자 클릭 시 상세 표시', (await page.textContent('#rv-side')).includes('문제 1-1'));
  // 수동 등급
  await page.selectOption('#rv-side select[aria-label="난이도 직접 지정"]', '7');
  await page.waitForTimeout(300);
  check('수동 등급 저장', (await dump()).find((i) => i.kind === 'problem' && i.number === 1).gradeManual === 7);
  // 빈 곳 드래그 → 새 항목 13
  page.__promptAnswer = '13';
  const hit = await page.evaluate(() => { const r = document.querySelector('#rv-canvas').getBoundingClientRect(); return document.elementFromPoint(r.x + r.width * 0.93, r.y + 300 * r.width / 1190)?.id; });
  check('드래그 시작 지점이 화면 안 캔버스', hit === 'rv-canvas', hit);
  await page.mouse.move(box.x + 1090 * k, box.y + 250 * k); await page.mouse.down();
  await page.mouse.move(box.x + 1180 * k, box.y + 350 * k, { steps: 5 }); await page.mouse.up();
  await page.waitForTimeout(800);
  items = await dump();
  const p13 = items.find((i) => i.kind === 'problem' && i.number === 13);
  check('드래그로 새 항목 추가 (prompt 줄바꿈 정상)', !!p13 && dialogs.some((d) => d.includes('\n이미 있는')), dialogs.join(' | '));
  // Delete 키로 삭제
  await page.locator('body').press('Delete');
  await page.waitForTimeout(600);
  check('Delete 키로 영역/항목 삭제', !(await dump()).some((i) => i.kind === 'problem' && i.number === 13));
  // 해설 보기
  await page.selectOption('#rv-kind', 'solution');
  await page.waitForTimeout(800);
  check('해설 검토 목록 12개', (await page.textContent('#rv-count')) === '(12개)');
  await page.click('#rv-next'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/04-review-solution-p2.png` });
  await page.selectOption('#rv-kind', 'problem'); await page.waitForTimeout(500);
  // 다시 분리 (confirm 줄바꿈)
  await page.click('#rv-reseg');
  await page.waitForFunction(() => document.querySelector('#rv-count').textContent === '(12개)', null, { timeout: 30000 });
  await page.waitForTimeout(500);
  check('다시 분리 (confirm 줄바꿈 정상, 12개 유지)', dialogs.some((d) => d.includes('\n분리 설정은')));
  await page.click('#rv-relink'); await page.waitForTimeout(500);
  check('해설 다시 연결', dialogs.some((d) => d.includes('12개 중 12개')), dialogs[dialogs.length - 1]);

  // 2.5 문제 분류 (책별·유형별)
  check('처리 로그에 유형 분류 요약 (미분류는 마지막)', log.includes('유형 분류 완료: 수열 4 · 경우의 수 3 · 미분류 5'), log.split('\n').find((l) => l.includes('유형 분류')));
  await page.click('#tabs button[data-tab=classify]');
  await page.waitForFunction(() => document.querySelectorAll('#cl-groups .card').length > 0);
  const facet = (sel) => page.$$eval(`${sel} button`, (bs) => bs.map((b) => [b.children[0].textContent, +b.children[1].textContent, b.classList.contains('active')]));
  const facetMap = async () => Object.fromEntries((await facet('#cl-types')).map(([t, n]) => [t, n]));
  const clickFacet = async (sel, label) => {
    await page.evaluate(([s, l]) => [...document.querySelectorAll(`${s} button`)].find((b) => b.children[0].textContent === l).click(), [sel, label]);
    await page.waitForTimeout(300);
  };
  const clCard = (n) => page.locator('#cl-groups .card', { hasText: `테스트 문제집 ${n}번` });
  const manualType = (n) => page.evaluate(async (k) => (await M.db.all('items')).find((i) => i.kind === 'problem' && i.number === k).typeManual ?? null, n);
  const bookFacet = await facet('#cl-books');
  check('책별 분류: 방금 넣은 책이 선택되고 12문제', JSON.stringify(bookFacet) === JSON.stringify([['전체 책', 12, false], ['테스트 문제집', 12, true]]), JSON.stringify(bookFacet));
  const typeFacet = await facetMap();
  check('유형별 카테고리 자동 생성', typeFacet['전체 유형'] === 12 && typeFacet['수열'] === 4 && typeFacet['경우의 수'] === 3 && typeFacet['미분류'] === 5, JSON.stringify(typeFacet));
  const groupTitles = await page.$$eval('#cl-groups > details > summary', (s) => s.map((x) => x.textContent));
  check('유형별로 묶어 표시 (표준 순서, 미분류 마지막)', groupTitles.join('|') === '수열 4문제|경우의 수 3문제|미분류 5문제', groupTitles.join('|'));
  check('자동 분류 근거 표시', (await clCard(2).textContent()).includes('근거: 수열'), await clCard(2).textContent());
  check('글자 근거가 약하면 앞뒤 문제로 보정', (await clCard(1).textContent()).includes('수열 (자동·앞뒤 문제)'), await clCard(1).textContent());
  await clickFacet('#cl-types', '수열');
  check('유형 카테고리를 고르면 그 유형만 표시', (await page.locator('#cl-groups .card').count()) === 4 && (await page.textContent('#cl-title')) === '테스트 문제집 · 수열');
  await clickFacet('#cl-books', '전체 책');
  const byBookTitles = await page.$$eval('#cl-groups > details > summary', (s) => s.map((x) => x.textContent));
  check('전체 책에서 유형을 고르면 책별로 묶음', byBookTitles.join('|') === '테스트 문제집 4문제' && (await page.textContent('#cl-title')) === '전체 책 · 수열', byBookTitles.join('|'));
  await clickFacet('#cl-types', '전체 유형');
  await clickFacet('#cl-books', '테스트 문제집');
  await clCard(3).locator('select').selectOption('삼각함수');
  await page.waitForTimeout(400);
  const afterManual = await facetMap();
  check('유형 직접 지정 (수동 우선)', (await manualType(3)) === '삼각함수' && afterManual['삼각함수'] === 1 && afterManual['미분류'] === 4 && (await clCard(3).textContent()).includes('삼각함수 (수동)'), JSON.stringify(afterManual));
  page.__promptAnswer = '조건 해석';
  await clCard(5).locator('select').selectOption('__new__');
  await page.waitForTimeout(400);
  const areas = await page.$$eval('#cl-types .facet-area', (a) => a.map((x) => x.textContent));
  check('새 유형 직접 만들기', (await manualType(5)) === '조건 해석' && areas.includes('직접 만든 유형') && (await facetMap())['조건 해석'] === 1, areas.join(','));
  check('만든 유형을 다른 문제에서도 선택 가능', (await clCard(7).locator('select option').allTextContents()).includes('조건 해석'));
  await page.screenshot({ path: `${SHOTS}/04b-classify.png`, fullPage: true });
  await clCard(5).locator('select').selectOption('');
  await page.waitForTimeout(400);
  check('자동 분류로 되돌리기', (await manualType(5)) === null && !(await facetMap())['조건 해석']);
  await clCard(6).locator('button', { hasText: '검토에서 보기' }).click();
  await page.waitForTimeout(800);
  check('분류 화면에서 검토 화면으로 바로 이동', (await page.locator('#tab-review').evaluate((t) => t.classList.contains('active'))) && (await page.textContent('#rv-side')).includes('문제 1-6') && (await page.inputValue('#rv-page')) === '2');
  check('분류 탭을 떠나면 카드·목록을 비워 메모리 해제', await page.evaluate(() => ['#cl-books', '#cl-types', '#cl-groups'].every((s) => !document.querySelector(s).children.length)));

  // 새로 읽는 중에 누른 카테고리·유형 변경이 옛 화면을 그리지 않아야 한다 (읽기·저장을 일부러 늦춰 재현)
  await page.click('#tabs button[data-tab=classify]');
  await page.waitForFunction(() => document.querySelectorAll('#cl-groups .card').length > 0);
  const id8 = await page.evaluate(async () => (await M.db.all('items')).find((i) => i.kind === 'problem' && i.number === 8).id);
  await page.evaluate(async (id) => {
    await M.db.update('items', id, (f) => { f.typeLLM = '이차곡선'; }); // 화면에는 아직 반영 안 됨
    window.__origAll = M.db.all;
    M.db.all = async (n) => { await new Promise((r) => setTimeout(r, 500)); return window.__origAll(n); };
  }, id8);
  await page.click('#tabs button[data-tab=classify]'); // 다시 읽기 시작 (0.5초 걸림)
  await page.waitForTimeout(50);
  await clickFacet('#cl-types', '전체 유형'); // 읽는 도중 카테고리 클릭
  await page.waitForTimeout(900);
  check('다시 읽는 중에 카테고리를 눌러도 새 데이터 표시', (await clCard(8).textContent()).includes('이차곡선 (AI)'), await clCard(8).textContent());
  await page.click('#tabs button[data-tab=classify]'); // 다시 읽기 시작
  await page.waitForTimeout(50);
  await clCard(4).locator('select').selectOption('확률'); // 읽는 도중 유형 변경
  await page.waitForTimeout(1200);
  check('다시 읽는 중에 바꾼 유형도 화면에 반영', (await manualType(4)) === '확률' && (await clCard(4).textContent()).includes('확률 (수동)'), await clCard(4).textContent());
  await page.evaluate(() => {
    M.db.all = window.__origAll;
    window.__origUpdate = M.db.update;
    M.db.update = async (...a) => { await new Promise((r) => setTimeout(r, 400)); return window.__origUpdate(...a); };
  });
  await clCard(4).locator('select').selectOption(''); // 저장이 끝나기 전에 탭 이동
  await page.click('#tabs button[data-tab=library]');
  await page.waitForTimeout(900);
  check('저장이 늦게 끝나도 숨은 분류 탭을 다시 그리지 않음', (await manualType(4)) === null && await page.evaluate(() => !document.querySelector('#cl-groups').children.length));
  await page.evaluate(async (id) => {
    M.db.update = window.__origUpdate;
    await M.db.update('items', id, (f) => { delete f.typeLLM; });
  }, id8);
  // 문제가 많을 때: 묶음을 접어 두고 펼칠 때만 카드를 만든다 + 사용자가 접은 상태 유지
  const lazy = await page.evaluate(async () => {
    const all = await M.db.all('items');
    const probs = all.filter((i) => i.kind === 'problem');
    const extra = [];
    for (let k = 0; k < 160; k++) extra.push({ ...probs[k % probs.length], id: 'zz' + k, number: 100 + k, typeManual: null });
    await M.db.putMany('items', extra);
    return extra.length;
  });
  await page.click('#tabs button[data-tab=classify]');
  await page.waitForFunction(() => document.querySelectorAll('#cl-groups > details').length > 0);
  const lazyState = await page.$$eval('#cl-groups > details', (ds) => ds.map((d) => [d.open, d.querySelectorAll('.card').length]));
  check('문제가 많으면 묶음을 접고 카드를 만들지 않음', lazyState.every(([open, n]) => !open && n === 0), JSON.stringify(lazyState));
  await page.locator('#cl-groups > details > summary').first().click();
  await page.waitForTimeout(300);
  const firstOpen = await page.$eval('#cl-groups > details', (d) => [d.open, d.querySelectorAll('.card').length]);
  check('펼치면 그때 카드 생성', firstOpen[0] && firstOpen[1] > 0, JSON.stringify(firstOpen));
  await clickFacet('#cl-types', '전체 유형');
  const kept = await page.$eval('#cl-groups > details', (d) => d.open);
  check('다시 그려도 펼친 상태 유지', kept);
  await page.evaluate(async () => { for (let k = 0; k < 160; k++) await M.db.del('items', 'zz' + k); });
  await page.click('#tabs button[data-tab=review]'); await page.waitForTimeout(300);
  check(`임시 문제 ${lazy}개 정리`, (await page.evaluate(async () => (await M.db.all('items')).length)) === 24);

  // 3. 난이도
  await page.click('#tabs button[data-tab=grade]');
  await page.waitForTimeout(300);
  await page.click('#gr-heur'); await page.waitForTimeout(500);
  check('규칙 기반 판정 로그', (await page.textContent('#gr-log')).includes('12문제'));
  check('히스토그램 9칸', (await page.locator('#gr-hist .bar').count()) === 9);
  await page.fill('#gr-key', 'test-key'); await page.dispatchEvent('#gr-key', 'change');
  await page.fill('#gr-delay', '0'); await page.dispatchEvent('#gr-delay', 'change');
  await page.click('#gr-test');
  await page.waitForFunction(() => document.querySelector('#gr-log').textContent.includes('AI 판정 끝'), null, { timeout: 20000 });
  const grLog = await page.textContent('#gr-log');
  check('AI 판정 (Gemini 형식, 문제 이미지 1장 → 난이도 5단계 = 1등급)', grLog.includes('성공 1, 실패 0') && grLog.includes('이미지 1장') && grLog.includes('난이도 5단계(1등급)'), grLog.split('\n').slice(-3).join(' / '));
  check('AI에도 실제 무손실 PNG MIME 전달', llmMimes.length === 1 && llmMimes.every((m) => m === 'image/png'), llmMimes.join(','));
  await page.click('#gr-llm');
  await page.waitForFunction(() => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length >= 2, null, { timeout: 30000 });
  check('아직 안 한 문제만 AI 판정 (11건 추가)', llmCalls === 12, `호출 ${llmCalls}회`);
  const expectedSystem = fs.readFileSync(path.join(__dirname, 'ocr-system-prompt.txt'), 'utf8');
  check('AI 요청: 시스템 자리에 지정 프롬프트 그대로, 사용자 메시지에 책 과목', llmPrompts[0].system === expectedSystem && llmPrompts[0].user.includes('"수학I"'), llmPrompts[0].user);
  const aiTypes = await page.evaluate(async () => (await M.db.all('items')).filter((i) => i.kind === 'problem').map((p) => [p.typeLLM, p.subjectLLM, p.difficultyLLM, p.gradeLLM, p.aiExtract?.problems?.[0]?.question?.includes('\\frac{1}{2}')]));
  check('AI 단원 유형(수학 I - 수열) → 표준 유형·과목, 5단계 → 1등급, LaTeX 문제 글 저장', aiTypes.length === 12 && aiTypes.every((t) => JSON.stringify(t) === JSON.stringify(['수열', '수학I', 5, 1, true])), JSON.stringify(aiTypes[0]));
  check('AI 로그에 유형 표시', (await page.textContent('#gr-log')).includes('유형 수열'));
  await page.click('#tabs button[data-tab=classify]');
  await page.waitForTimeout(500);
  const afterAI = await facetMap();
  check('AI 유형이 자동 분류보다 우선, 직접 지정은 유지', afterAI['수열'] === 11 && afterAI['삼각함수'] === 1 && !afterAI['미분류'], JSON.stringify(afterAI));
  check('AI 출처 표시', (await clCard(1).textContent()).includes('수열 (AI)') && (await clCard(1).textContent()).includes('AI 단원: 수학 I - 수열'), await clCard(1).textContent());
  await page.screenshot({ path: `${SHOTS}/05-grade.png` });

  // 4. 시험지
  await page.click('#tabs button[data-tab=build]');
  await page.waitForTimeout(300);
  await page.selectOption('#bd-target', '2');
  await page.fill('#bd-count', '8');
  await page.click('#bd-select'); await page.waitForTimeout(500);
  check('문제 8개 선택', (await page.locator('#bd-list .card').count()) === 8, await page.textContent('#bd-info'));
  await page.locator('#bd-list .card button', { hasText: '교체' }).first().click(); await page.waitForTimeout(200);
  await page.locator('#bd-list .card button', { hasText: '빼기' }).first().click(); await page.waitForTimeout(200);
  check('교체/빼기 동작', (await page.locator('#bd-list .card').count()) === 7);
  await page.screenshot({ path: `${SHOTS}/06-build.png` });
  for (const [mode, cols] of [['pair', '1'], ['pair', '2'], ['separate', '2']]) {
    await page.selectOption('#bd-mode', mode); await page.selectOption('#bd-cols', cols);
    await page.evaluate(() => { window.__pdf = null; });
    await page.click('#bd-pdf');
    await page.waitForFunction(() => window.__pdf, null, { timeout: 20000 });
    const pdf = await page.evaluate(() => window.__pdf);
    const imgs = pdf.ops.filter((o) => o[0] === 'image');
    const inBounds = imgs.every(([, , x, y, w, h]) => x >= 13.9 && x + w <= 196.1 + 0.01 && y >= 13.9 && y + h <= 297 - 14 - 6 + 0.01);
    const lossless = imgs.every((o) => o[1] === 'PNG');
    check(`PDF 생성 (${mode}, ${cols}단): 쪽수 ${pdf.pages}, 이미지 ${imgs.length}, 무손실·여백 안`, inBounds && lossless && pdf.name.endsWith('_2등급.pdf') && imgs.length >= 7 * 3, pdf.name);
  }
  const typeBoxes = await page.$$eval('#bd-types input', (xs) => xs.map((x) => [x.value, x.checked]));
  check('시험지 유형 필터 목록 (모두 켜짐)', JSON.stringify(typeBoxes) === JSON.stringify([['삼각함수', true], ['수열', true]]), JSON.stringify(typeBoxes));
  await page.uncheck('#bd-types input[value="수열"]');
  await page.click('#bd-select'); await page.waitForTimeout(500);
  const picked = await page.$$eval('#bd-list .card .row .hint', (h) => h.map((x) => x.textContent));
  check('유형 필터로 해당 유형 문제만 선택', picked.length === 1 && picked[0].endsWith('· 삼각함수'), picked.join(' | '));
  await page.check('#bd-types input[value="수열"]');

  // AI 판정이 도는 동안 직접 지정한 유형이 지워지지 않아야 한다
  await page.click('#tabs button[data-tab=grade]');
  await page.fill('#gr-delay', '250'); await page.dispatchEvent('#gr-delay', 'change');
  const lastId = await page.evaluate(async () => (await M.db.all('items')).find((i) => i.kind === 'problem' && i.number === 12).id);
  const callsBefore = llmCalls;
  await page.click('#gr-llm-all');
  await page.waitForFunction((n) => window.__llmCalls > n, callsBefore, { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.evaluate((id) => M.db.update('items', id, (f) => { f.typeManual = '확률'; }), lastId);
  await page.waitForFunction(() => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length >= 3, null, { timeout: 30000 });
  const kept12 = await page.evaluate(async (id) => { const p = await M.db.get('items', id); return [p.typeManual, p.typeLLM, p.gradeLLM]; }, lastId);
  check('AI 판정 중에 직접 지정한 유형 보존', kept12[0] === '확률' && kept12[1] === '수열' && kept12[2] === 1 && llmCalls - callsBefore === 12, JSON.stringify(kept12));
  await page.fill('#gr-delay', '0'); await page.dispatchEvent('#gr-delay', 'change');

  // 5. 라이브러리 백업/복원
  await page.click('#tabs button[data-tab=library]');
  await page.waitForTimeout(300);
  check('라이브러리 책 표시', (await page.textContent('#lib-books')).includes('테스트 문제집'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#lib-export')]);
  const backup = path.join(__dirname, 'backup.json');
  await dl.saveAs(backup);
  const blines = fs.readFileSync(backup, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bcount = (s) => blines.filter((r) => r.s === s).length;
  check('백업 파일 (줄 단위 형식)', blines[0].format === 'math-finder-backup' && bcount('books') === 1 && bcount('pages') === 5 && bcount('items') === 24 && dl.suggestedFilename().endsWith('.jsonl'),
    `${dl.suggestedFilename()} books ${bcount('books')} pages ${bcount('pages')} items ${bcount('items')}`);
  await page.evaluate(() => M.db.deleteBook((document.querySelector('#rv-book').value)));
  await page.setInputFiles('#lib-import', backup);
  await page.waitForTimeout(1000);
  check('백업 가져오기 후 복원', (await page.evaluate(async () => (await M.db.all('items')).length)) === 24);
  await page.screenshot({ path: `${SHOTS}/07-library.png` });

  check('전체 과정에서 JS 오류 없음', errors.length === 0, errors.join(' | '));
  await browser.close(); server.close();
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
