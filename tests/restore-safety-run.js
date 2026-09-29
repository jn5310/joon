// 4차 리뷰 회귀 테스트 (브라우저): 이미지가 빠진 백업을 이미지가 있는 라이브러리에 가져와도 이미지·폴더 파일을 지킨다(폴더·IndexedDB),
// 폴더 권한이 없을 때 백업은 권한을 다시 요청하고 그래도 없으면 묻는다, 이미지 없는 쪽의 문제 편집은 자르기를 지킨다, 드래그 추가의 예제·유제 번호
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs, fakeJspdf } = require('./fakes');
const { problemBook, solutionBook } = require('./gen');
const ROOT = process.env.APP_ROOT || path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) return false; await sleep(100); } return true; };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  await new Promise((r) => server.listen(8775, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => navigator.storage.getDirectory() });
    // 폴더 권한: __perm='prompt'면 새로고침 뒤 권한 없음, __deny가 있으면 사용자가 권한 요청을 거절
    const perm = () => localStorage.getItem('__perm') || 'granted';
    FileSystemHandle.prototype.queryPermission = async function () { return perm(); };
    FileSystemHandle.prototype.requestPermission = async function () { if (localStorage.getItem('__deny')) return 'denied'; localStorage.setItem('__perm', 'granted'); return 'granted'; };
    window.__t = {
      async dir(bookId) {
        const root = await navigator.storage.getDirectory();
        try { return await (await (await root.getDirectoryHandle('MathFinderData')).getDirectoryHandle(localStorage.getItem('__ns'))).getDirectoryHandle(bookId); } catch { return null; }
      },
      async files(bookId) { const d = await this.dir(bookId); if (!d) return []; const out = []; for await (const [n, h] of d.entries()) if (h.kind === 'file') out.push(n); return out.sort(); },
      async readable(r) { return r.image != null && await M.assets.getBlob(r.image).then((b) => b.size > 0, () => false); },
      async state(bookId) {
        const pages = await M.db.byBook('pages', bookId), items = await M.db.byBook('items', bookId);
        return {
          pages: pages.length, pagesWithImage: (await Promise.all(pages.map((r) => this.readable(r)))).filter(Boolean).length,
          items: items.length, itemsWithImage: (await Promise.all(items.map((r) => this.readable(r)))).filter(Boolean).length,
          files: (await this.files(bookId)).length,
        };
      },
    };
  });
  const page = await context.newPage();
  const errors = [], dialogs = [], prompts = [];
  let downloads = 0;
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('download', () => { downloads++; });
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    if (d.type() === 'prompt') { prompts.push({ message: d.message(), def: d.defaultValue() }); await d.accept(page.__answer ?? d.defaultValue()); }
    else if (d.type() === 'confirm' && page.__dismiss) await d.dismiss();
    else await d.accept();
  });
  await page.route('https://cdn.jsdelivr.net/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('pdf.min.mjs')) return r.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    if (u.includes('jspdf')) return r.fulfill({ contentType: 'text/javascript', body: fakeJspdf });
    return r.fulfill({ status: 404 });
  });
  const ingest = async (name, withSolution) => {
    await page.click('#tabs button[data-tab=ingest]');
    await page.fill('#in-name', name);
    await page.setInputFiles('#in-problem', { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(problemBook())) });
    await page.setInputFiles('#in-solution', withSolution ? { name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(solutionBook())) } : []);
    await page.click('#btn-ingest');
    await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled, null, { timeout: 60000 });
    return page.evaluate(async (n) => (await M.db.all('books')).find((b) => b.name === n).id, name);
  };
  const exportTo = async (file) => {
    await page.click('#tabs button[data-tab=library]'); await sleep(200);
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#lib-export')]);
    const p = path.join(__dirname, file); await dl.saveAs(p); await sleep(300);
    return p;
  };
  const importFrom = async (p) => {
    const nd = dialogs.length;
    await page.setInputFiles('#lib-import', p);
    await until(() => dialogs.slice(nd).some((m) => m.startsWith('가져오기')));
    await sleep(300);
    return dialogs.slice(nd).find((m) => m.startsWith('가져오기')) || '';
  };
  const recordsIn = (p) => fs.readFileSync(p, 'utf8').trim().split('\n').slice(1).map(JSON.parse).filter((x) => x.s !== 'books');
  const state = (id) => page.evaluate((b) => window.__t.state(b), id);

  await page.goto('http://localhost:8775/');
  await page.click('#tabs button[data-tab=library]');
  await page.click('#lib-folder'); await sleep(300);
  await page.evaluate(() => localStorage.setItem('__ns', M.assets.status().ns));
  const A = await ingest('A책', true);
  const s0 = await state(A);
  check('준비: 폴더 저장 책 (5쪽 · 24개 · 파일 29개)', s0.pages === 5 && s0.pagesWithImage === 5 && s0.items === 24 && s0.itemsWithImage === 24 && s0.files === 29, JSON.stringify(s0));

  // ── 1) 내보낼 때 쪽 파일 하나를 잠깐 못 읽음 → 파일이 돌아온 뒤 그 백업을 가져와도 이미지·파일을 지킨다
  const movedFile = await page.evaluate(async (id) => {
    const pg = (await M.db.byBook('pages', id)).find((x) => x.kind === 'problem' && x.index === 2);
    const d = await window.__t.dir(id), blob = await (await d.getFileHandle(pg.image.file)).getFile();
    window.__saved = { name: pg.image.file, buf: await blob.arrayBuffer(), type: blob.type };
    await d.removeEntry(pg.image.file);
    return pg.image.file;
  }, A);
  let nd = dialogs.length;
  const p1 = await exportTo('restore-partial-1.jsonl');
  check('파일 하나를 못 읽어도 백업을 만들고 알림', dialogs.slice(nd).some((m) => m.includes('이미지 1개는 읽을 수 없어')) && recordsIn(p1).filter((x) => x.v.image === null).length === 1, JSON.stringify(dialogs.slice(nd)).slice(0, 160));
  await page.evaluate(async (id) => {
    const d = await window.__t.dir(id), s = window.__saved;
    const w = await (await d.getFileHandle(s.name, { create: true })).createWritable(); await w.write(new Blob([s.buf], { type: s.type })); await w.close();
  }, A);
  const msg1 = await importFrom(p1);
  const s1 = await state(A);
  const kept1 = await page.evaluate(async ({ id, f }) => {
    const pg = (await M.db.byBook('pages', id)).find((x) => x.kind === 'problem' && x.index === 2);
    return { sameFile: pg.image?.file === f, fileThere: (await window.__t.files(id)).includes(f), missingFlag: !!pg.imageMissing };
  }, { id: A, f: movedFile });
  check('이미지가 빠진 백업을 같은 라이브러리에 가져와도 쪽 이미지·폴더 파일 유지 (5/5 · 24/24 · 29개)', s1.pagesWithImage === 5 && s1.itemsWithImage === 24 && s1.files === 29 && kept1.sameFile && kept1.fileThere && !kept1.missingFlag, JSON.stringify({ s1, kept1 }));
  check('가져오기 알림: 라이브러리 이미지를 그대로 둔 개수', msg1.includes('1개는 라이브러리에 있던 이미지를 그대로'), msg1);
  const reseg1 = await page.evaluate(async (id) => { try { await M.pipeline.segmentKind(await M.db.get('books', id), 'problem'); await M.pipeline.relink(id); return 'ok'; } catch (e) { return e.message; } }, A);
  check('가져온 뒤에도 문제 다시 분리 가능', reseg1 === 'ok', reseg1);

  // ── 2) 이미 이미지가 없던 기록도 백업 알림에 센다
  const hollow = await page.evaluate(async (id) => {
    const it = (await M.db.byBook('items', id)).find((x) => x.kind === 'solution');
    window.__hollow = { id: it.id, image: it.image };
    await M.db.update('items', it.id, (f) => { f.image = null; });
    return it.id;
  }, A);
  nd = dialogs.length;
  await exportTo('restore-hollow.jsonl');
  check('백업 알림에 원래 이미지가 없던 기록 수도 적음', dialogs.slice(nd).some((m) => m.includes('원래 이미지가 없던 기록 1개')), JSON.stringify(dialogs.slice(nd)).slice(0, 200));
  await page.evaluate(async () => { await M.db.update('items', window.__hollow.id, (f) => { f.image = window.__hollow.image; }); });

  // ── 3) 브라우저를 다시 켜 폴더 권한이 없는 상태에서 백업
  await page.evaluate(() => { localStorage.setItem('__perm', 'prompt'); localStorage.setItem('__deny', '1'); });
  await page.reload(); await sleep(600);
  await page.click('#tabs button[data-tab=library]'); await sleep(300);
  check('준비: 새로고침 뒤 폴더 권한 없음', await page.evaluate(() => M.assets.status().needsPermission));
  nd = dialogs.length; let dl0 = downloads;
  page.__dismiss = true;
  await page.click('#lib-export'); await sleep(1500);
  page.__dismiss = false;
  check('권한 요청을 거절하면 이미지 없는 백업인지 묻고, 취소하면 백업하지 않음', downloads === dl0 && dialogs.slice(nd).some((m) => m.includes('접근 권한이 없어') && m.includes('이미지 없이 백업')), JSON.stringify(dialogs.slice(nd)).slice(0, 160));
  nd = dialogs.length;
  const p2 = await exportTo('restore-noperm.jsonl');
  const r2 = recordsIn(p2);
  check('그래도 만들면 이미지 없이 저장하고 빠진 개수(29)를 알림', r2.filter((x) => typeof x.v.image === 'string').length === 0 && r2.length === 29 && dialogs.slice(nd).some((m) => m.includes('이미지 29개는 읽을 수 없어')), JSON.stringify(dialogs.slice(nd)).slice(0, 200));
  await page.evaluate(() => localStorage.removeItem('__deny'));
  nd = dialogs.length;
  const p3 = await exportTo('restore-regranted.jsonl');
  const r3 = recordsIn(p3);
  const st3 = await page.evaluate(() => ({ connected: M.assets.status().connected, needs: M.assets.status().needsPermission, status: document.querySelector('#lib-folder-status').textContent }));
  check('백업을 누르면 폴더 권한을 다시 요청해 이미지를 모두 담음 (묻지 않음)', r3.filter((x) => typeof x.v.image === 'string').length === 29 && !dialogs.slice(nd).some((m) => m.includes('접근 권한이 없어')) && st3.connected && !st3.needs && !st3.status.includes('접근 권한이 필요'), JSON.stringify({ n: r3.filter((x) => typeof x.v.image === 'string').length, st3 }));
  const msg4 = await importFrom(p2);
  const s4 = await state(A);
  check('이미지 없는 백업을 가져와도 모든 이미지·폴더 파일 유지 (5/5 · 24/24 · 29개)', s4.pagesWithImage === 5 && s4.itemsWithImage === 24 && s4.files === 29 && msg4.includes('29개는 라이브러리에 있던 이미지를 그대로'), JSON.stringify(s4) + ' ' + msg4);

  // ── 4) 브라우저 내부(IndexedDB) 저장에서도 같은 기록의 Blob을 지킨다
  await page.click('#tabs button[data-tab=library]');
  await page.click('#lib-folder-off'); await sleep(200);
  const B = await ingest('B책', false);
  const before = await page.evaluate(async (id) => [...await M.db.byBook('pages', id), ...await M.db.byBook('items', id)].map((r) => [r.id, r.image instanceof Blob ? r.image.size : -1]).sort(), B);
  const full = await exportTo('restore-idb-full.jsonl');
  const lines = fs.readFileSync(full, 'utf8').trim().split('\n');
  const partial = [lines[0], ...lines.slice(1).filter((l) => { const r = JSON.parse(l); return r.v.id === B || r.v.bookId === B; }).map((l) => { const r = JSON.parse(l); if (r.s !== 'books') r.v.image = null; return JSON.stringify(r); })];
  const pIdb = path.join(__dirname, 'restore-idb-partial.jsonl'); fs.writeFileSync(pIdb, partial.join('\n') + '\n');
  const msg5 = await importFrom(pIdb);
  const after = await page.evaluate(async (id) => [...await M.db.byBook('pages', id), ...await M.db.byBook('items', id)].map((r) => [r.id, r.image instanceof Blob ? r.image.size : -1]).sort(), B);
  check('내부 저장: 이미지 없는 백업을 가져와도 Blob 이미지를 그대로 둠', before.length > 0 && JSON.stringify(before) === JSON.stringify(after) && before.every(([, s]) => s > 0), `${before.length} records, ${msg5}`);

  // ── 5) 이미지가 없는 쪽의 문제 편집: 번호는 고치고 자르기는 지킨다, 영역은 고치지 않는다
  const setup = await page.evaluate(async (id) => {
    const pg = (await M.db.byBook('pages', id)).find((x) => x.kind === 'problem' && x.index === 2);
    window.__page2 = { id: pg.id, image: pg.image, imageBytes: pg.imageBytes };
    await M.db.update('pages', pg.id, (f) => { f.image = null; f.imageBytes = 0; f.imageMissing = true; });
    const items = (await M.db.byBook('items', id)).filter((x) => x.kind === 'problem');
    const onP2 = items.find((x) => x.fragments[0].page === 2 && x.fragments.length === 1);
    const onP1 = items.filter((x) => x.fragments.every((f) => f.page === 1)).sort((a, b) => b.number - a.number)[0];
    // 1쪽 문제 하나가 이미지 없는 2쪽까지 이어진 것처럼 만든다
    const extra = { ...onP2.fragments[0], cont: true };
    await M.db.update('items', onP1.id, (f) => { f.fragments = [...f.fragments, extra]; });
    const sig = (it) => (it.image?.file || (it.image instanceof Blob ? `blob:${it.image.size}` : String(it.image)));
    return { p2: { id: onP2.id, number: onP2.number, sig: sig(onP2) }, p1: { id: onP1.id, number: onP1.number, sig: sig(onP1), frag: onP1.fragments[0] } };
  }, A);
  await page.click('#tabs button[data-tab=classify]'); await sleep(800);
  await page.locator('#cl-books button', { hasText: 'A책' }).first().click(); await sleep(500);
  await page.locator('#cl-groups .card', { hasText: `A책 ${setup.p2.number}번` }).first().locator('button', { hasText: '검토에서 보기' }).click();
  await sleep(1200);
  const side = await page.evaluate(() => ({ h3: document.querySelector('#rv-side h3')?.textContent, notice: document.querySelector('#rv-side').textContent.includes('이미지를 읽지 못해'), nulls: document.querySelector('#rv-side').textContent.includes('null') }));
  check('분류 → 검토에서 보기: 이미지 없는 쪽이라는 안내와 번호 편집을 함께 보여 줌', side.h3?.includes(`1-${setup.p2.number}`) && side.notice && !side.nulls, JSON.stringify(side));
  await page.evaluate(() => { document.querySelector('#rv-editor').open = true; });
  await page.locator('#rv-side input[type=number]').nth(1).fill(String(setup.p2.number + 40));
  nd = dialogs.length;
  await page.locator('#rv-side button', { hasText: '번호 저장' }).click();
  await until(() => page.evaluate(async (id) => (await M.db.get('items', id)).number, setup.p2.id).then((v) => v === setup.p2.number + 40), 8000);
  const e1 = await page.evaluate(async (id) => { const it = await M.db.get('items', id); return { number: it.number, sig: it.image?.file || (it.image instanceof Blob ? `blob:${it.image.size}` : String(it.image)), manual: it.detection?.numberManual, readable: await window.__t.readable(it) }; }, setup.p2.id);
  check('이미지 없는 쪽의 문제 번호를 고쳐도 자르기 이미지 그대로 (다시 자르지 않음)', e1.number === setup.p2.number + 40 && e1.sig === setup.p2.sig && e1.readable && e1.manual === true && !dialogs.slice(nd).length, JSON.stringify(e1));
  // 1쪽에서 그 문제의 영역 삭제 → 남는 영역이 이미지 없는 2쪽에 걸치므로 막는다
  await page.click('#tabs button[data-tab=review]'); await sleep(300);
  await page.selectOption('#rv-book', A); await sleep(500);
  await page.fill('#rv-page', '1'); await page.dispatchEvent('#rv-page', 'change');
  await page.evaluate(() => { document.querySelector('#rv-editor').open = true; });
  // 쪽 이미지가 다 그려진 뒤에 상자를 누른다 (그리기 전의 클릭은 무시된다). 선택될 때까지 몇 번 다시 누른다
  await page.waitForFunction(() => document.querySelector('#rv-canvas').width > 1 && document.querySelector('#rv-page').value === '1', null, { timeout: 10000 });
  const f0 = setup.p1.frag;
  let cv, k;
  for (let tries = 0; tries < 5; tries++) {
    await page.evaluate(() => document.querySelector('#rv-canvas').scrollIntoView({ block: 'start' }));
    cv = await page.locator('#rv-canvas').boundingBox();
    k = cv.width / await page.evaluate(() => document.querySelector('#rv-canvas').width);
    await page.mouse.click(cv.x + (f0.x0 + 20) * k, cv.y + (f0.y0 + 20) * k); await sleep(300);
    if (await page.locator('#rv-side button', { hasText: '이 영역 삭제' }).count()) break;
  }
  nd = dialogs.length;
  await page.locator('#rv-side button', { hasText: '이 영역 삭제' }).click(); await sleep(800);
  const e2 = await page.evaluate(async (id) => { const it = await M.db.get('items', id); return { n: it.fragments.length, sig: it.image?.file || (it.image instanceof Blob ? `blob:${it.image.size}` : String(it.image)) }; }, setup.p1.id);
  check('이미지 없는 쪽에 걸친 문제의 영역 삭제는 막고 알림 (영역·이미지 그대로)', e2.n === 2 && e2.sig === setup.p1.sig && dialogs.slice(nd).some((m) => m.includes('원본 이미지가 없는 쪽(2쪽)')), JSON.stringify({ e2, d: dialogs.slice(nd) }));
  // 그 문제를 고른 채 빈 곳을 드래그 → 번호가 미리 채워지고, 이어붙이기도 막는다 (알림 뒤 화면이 스크롤될 수 있어 캔버스 위치를 다시 잰다)
  nd = dialogs.length; const np = prompts.length;
  page.__answer = undefined;
  await page.evaluate(() => document.querySelector('#rv-canvas').scrollIntoView({ block: 'start' }));
  cv = await page.locator('#rv-canvas').boundingBox();
  await page.mouse.move(cv.x + 1125 * k, cv.y + 250 * k); await page.mouse.down();
  await page.mouse.move(cv.x + 1180 * k, cv.y + 330 * k, { steps: 5 }); await page.mouse.up(); await sleep(900);
  const e3 = await page.evaluate(async (id) => (await M.db.get('items', id)).fragments.length, setup.p1.id);
  check('고른 문제의 번호가 드래그 번호 칸에 미리 채워짐', prompts.slice(np)[0]?.def === `1-${setup.p1.number}`, JSON.stringify(prompts.slice(np)));
  check('이미지 없는 쪽에 걸친 문제에 영역을 이어붙이는 것도 막음', e3 === 2 && dialogs.slice(nd).some((m) => m.includes('원본 이미지가 없는 쪽(2쪽)')), JSON.stringify({ e3, d: dialogs.slice(nd).slice(-1) }));
  await page.evaluate(async ({ id, p1 }) => {
    await M.db.update('items', p1, (f) => { f.fragments = f.fragments.filter((x) => x.page === 1); });
    const s = window.__page2; await M.db.update('pages', s.id, (f) => { f.image = s.image; f.imageBytes = s.imageBytes; delete f.imageMissing; });
  }, { id: A, p1: setup.p1.id });

  // ── 6) 드래그 추가: "유제 1-3"처럼 라벨 번호를 받아 그 항목에 이어붙이고, 번호 체계는 편집기에서 바꿀 수 있다
  const lab = await page.evaluate(async (id) => {
    const it = (await M.db.byBook('items', id)).find((x) => x.kind === 'problem' && x.number === 3 && x.fragments[0].page === 1);
    await M.db.update('items', it.id, (f) => { f.label = '유제'; });
    return { id: it.id, frags: it.fragments.length, plain: (await M.db.byBook('items', id)).filter((x) => x.kind === 'problem' && !x.label).length };
  }, A);
  await page.selectOption('#rv-kind', 'problem'); await sleep(600); // 목록을 새로 읽는다
  await page.click('#rv-prev').catch(() => {}); await sleep(400);
  const blank = await page.evaluate(() => { const x = document.querySelector('#rv-canvas'); return { w: x.width }; });
  await page.evaluate(() => document.querySelector('#rv-canvas').scrollIntoView({ block: 'start' }));
  cv = await page.locator('#rv-canvas').boundingBox();
  page.__answer = '유제 1-3'; // 번호 칸에 라벨 번호를 직접 입력
  await page.mouse.move(cv.x + 1125 * k, cv.y + 250 * k); await page.mouse.down();
  await page.mouse.move(cv.x + 1180 * k, cv.y + 330 * k, { steps: 5 }); await page.mouse.up(); await sleep(1200);
  page.__answer = undefined;
  const g1 = await page.evaluate(async ({ bookId, id }) => {
    const it = await M.db.get('items', id), probs = (await M.db.byBook('items', bookId)).filter((x) => x.kind === 'problem');
    return { frags: it.fragments.length, label: it.label, plain: probs.filter((x) => !x.label).length, newPlain3: probs.some((x) => !x.label && x.number === 3 && x.fragments.length === 1 && x.manual) };
  }, { bookId: A, id: lab.id });
  check('드래그 번호에 "유제 1-3"을 넣으면 그 유제 항목에 이어붙임 (본문 번호 항목을 새로 만들지 않음)', blank.w > 1 && g1.frags === lab.frags + 1 && g1.label === '유제' && g1.plain === lab.plain && !g1.newPlain3, JSON.stringify(g1));
  // 편집기의 번호 체계를 본문 번호로 바꿔 저장
  await page.locator('#rv-side select[aria-label="번호 체계"]').selectOption('');
  await page.locator('#rv-side button', { hasText: '번호 저장' }).click();
  await until(() => page.evaluate(async (id) => !(await M.db.get('items', id)).label, lab.id), 8000);
  const g2 = await page.evaluate(async (id) => { const it = await M.db.get('items', id); return { label: it.label ?? null, manual: it.detection?.numberManual, key: M.segment.itemKey(it) }; }, lab.id);
  check('편집기에서 번호 체계(유제 → 본문 번호)를 바꿔 저장', g2.label === null && g2.manual === true && g2.key === '1-3', JSON.stringify(g2));

  check('복원·편집 안전성 흐름 JS 오류 없음', errors.length === 0, errors.join(' | '));
  await context.close(); await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
