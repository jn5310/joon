// Blob·외부 폴더 대용량 저장 회귀 테스트 (OPFS handle을 사용자 선택 폴더 대역으로 사용)
const http = require('http'), fs = require('fs'), path = require('path');
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
(async () => {
  await new Promise((r) => server.listen(8769, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    // 실제 API와 같은 FileSystemDirectoryHandle이며 IndexedDB에 복제 가능하다. 테스트에서는 OPFS root를 picker 결과로 쓴다.
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => navigator.storage.getDirectory() });
  });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.route('https://cdn.jsdelivr.net/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('pdf.min.mjs')) return r.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    if (u.includes('jspdf')) return r.fulfill({ contentType: 'text/javascript', body: fakeJspdf });
    return r.fulfill({ status: 404 });
  });
  await page.goto('http://localhost:8769/');
  await page.click('#tabs button[data-tab=library]');
  await page.click('#lib-folder'); await page.waitForTimeout(300);
  check('대용량 폴더 연결 및 상태 표시', await page.evaluate(() => M.assets.status().enabled) && (await page.textContent('#lib-folder-status')).includes('대용량 폴더 사용 중'));

  // 외부 폴더 모드로 책 추가
  await page.click('#tabs button[data-tab=ingest]');
  await page.fill('#in-name', '외부 저장 책');
  await page.setInputFiles('#in-problem', { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(problemBook())) });
  await page.setInputFiles('#in-solution', { name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(solutionBook())) });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled && document.querySelector('#ingest-log').textContent.includes('판정 완료'), null, { timeout: 60000 });
  const ext = await page.evaluate(async () => {
    const pages = await M.db.all('pages'), items = await M.db.all('items');
    return { pages: pages.length, items: items.length, allRefs: [...pages, ...items].every((x) => x.image?.storage === 'external-v1'), bytes: [...pages, ...items].reduce((s, x) => s + (x.imageBytes || 0), 0), id: (await M.db.all('books'))[0].id };
  });
  check('페이지·문제 이미지를 IndexedDB가 아닌 외부 파일로 저장', ext.pages === 5 && ext.items === 24 && ext.allRefs && ext.bytes > 0, JSON.stringify(ext));
  await page.click('#tabs button[data-tab=review]'); await page.waitForTimeout(600);
  check('외부 이미지 참조를 문제 카드에서 표시', await page.locator('#rv-list img').first().evaluate((im) => im.complete && im.naturalWidth > 0));

  // PDF도 외부 파일을 읽어 생성
  await page.click('#tabs button[data-tab=build]'); await page.waitForTimeout(500);
  await page.fill('#bd-count', '3'); await page.click('#bd-select'); await page.waitForTimeout(300);
  await page.click('#bd-pdf'); await page.waitForFunction(() => window.__pdf, null, { timeout: 20000 });
  check('외부 저장 문제로 PDF 생성', (await page.evaluate(() => window.__pdf.pages)) >= 1);

  // 백업에는 실제 파일을 읽어 portable data URL로 넣음
  await page.click('#tabs button[data-tab=library]'); await page.waitForTimeout(300);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#lib-export')]);
  const file = path.join(__dirname, 'external-backup.jsonl'); await dl.saveAs(file);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const binary = lines.filter((x) => x.s === 'pages' || x.s === 'items');
  check('외부 파일 백업은 복구 가능한 data URL 포함', binary.length === 29 && binary.every((x) => typeof x.v.image === 'string' && x.v.image.startsWith('data:image/')));

  // 새 책을 내부 모드로 전환하면 Blob으로 저장
  await page.click('#lib-folder-off');
  await page.click('#tabs button[data-tab=ingest]'); await page.fill('#in-name', '내부 Blob 책');
  await page.setInputFiles('#in-problem', { name: 'p2.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(problemBook())) });
  await page.setInputFiles('#in-solution', []);
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled && document.querySelector('#ingest-log').textContent.includes('판정 완료'), null, { timeout: 60000 });
  const internal = await page.evaluate(async () => {
    const b = (await M.db.all('books')).find((x) => x.name === '내부 Blob 책');
    const records = [...await M.db.byBook('pages', b.id), ...await M.db.byBook('items', b.id)];
    return records.length > 0 && records.every((x) => x.image instanceof Blob) && records.every((x) => x.image.size === x.imageBytes);
  });
  check('내부 저장도 base64 대신 더 작은 Blob 사용', internal);

  // 다시 폴더를 켜고 기존 Blob 책까지 이동
  await page.click('#tabs button[data-tab=library]'); await page.click('#lib-folder'); await page.waitForTimeout(200);
  await page.click('#lib-optimize');
  await page.waitForFunction(() => !document.querySelector('#lib-optimize').disabled, null, { timeout: 60000 });
  const moved = await page.evaluate(async () => {
    const b = (await M.db.all('books')).find((x) => x.name === '내부 Blob 책');
    return [...await M.db.byBook('pages', b.id), ...await M.db.byBook('items', b.id)].every((x) => x.image?.storage === 'external-v1');
  });
  check('기존 책 저장 공간 최적화로 외부 폴더 이동', moved);

  // 새로고침 뒤 저장된 handle을 복구하고 외부 이미지 읽기
  await page.reload(); await page.click('#tabs button[data-tab=review]'); await page.waitForTimeout(700);
  check('새로고침 후 폴더 handle 복구·이미지 표시', await page.evaluate(() => M.assets.status().connected) && await page.locator('#rv-list img').first().evaluate((im) => im.complete && im.naturalWidth > 0));

  // 삭제 시 외부 책 폴더도 제거
  const deleted = await page.evaluate(async (id) => {
    const root = await navigator.storage.getDirectory();
    const nsDir = await (await root.getDirectoryHandle('MathFinderData')).getDirectoryHandle(M.assets.status().ns);
    const exists = async () => { try { await nsDir.getDirectoryHandle(id); return true; } catch { return false; } };
    const before = await exists();
    const r = await M.db.deleteBook(id);
    return { before, after: await exists(), pending: r.externalPending, book: !!(await M.db.get('books', id)) };
  }, ext.id);
  check('책 삭제 시 외부 이미지 폴더도 제거 (삭제 전에는 폴더가 있었음)', deleted.before && !deleted.after && !deleted.pending && !deleted.book, JSON.stringify(deleted));
  check('대용량 저장 흐름 JS 오류 없음', errors.length === 0, errors.join(' | '));
  await context.close(); await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
