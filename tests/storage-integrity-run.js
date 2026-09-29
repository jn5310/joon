// 외부 폴더 파일 무결성·동시 실행·삭제 대기·PDF 최신 기록 회귀 테스트 (OPFS를 사용자 선택 폴더 대역으로 사용)
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
// PDF에 실제로 들어간 이미지 data URL을 기록하는 가짜 jsPDF
const captureJspdf = fakeJspdf.replace("this.ops.push(['image', fmt, x, y, w, h, this.pages]);", "this.ops.push(['image', fmt, x, y, w, h, this.pages]); (window.__pdfImages = window.__pdfImages || []).push(img);");
(async () => {
  if (captureJspdf === fakeJspdf) throw new Error('가짜 jsPDF 치환 실패');
  await new Promise((r) => server.listen(8772, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { configurable: true, value: async () => navigator.storage.getDirectory() });
    // 폴더 권한: localStorage.__perm 이 'prompt'면 새로고침 뒤 권한이 없는 상태(사용자가 다시 허용해야 함)를 흉내 낸다
    const perm = () => localStorage.getItem('__perm') || 'granted';
    FileSystemHandle.prototype.queryPermission = async function () { return perm(); };
    FileSystemHandle.prototype.requestPermission = async function () { localStorage.setItem('__perm', 'granted'); return 'granted'; };
    window.__t = {
      async dir(bookId) {
        const root = await navigator.storage.getDirectory();
        try { return await (await (await root.getDirectoryHandle('MathFinderData')).getDirectoryHandle(M.assets.status().ns || localStorage.getItem('__ns'))).getDirectoryHandle(bookId); }
        catch { return null; }
      },
      async files(bookId) {
        const d = await this.dir(bookId);
        if (!d) return null;
        const out = [];
        for await (const [n, h] of d.entries()) if (h.kind === 'file') out.push(n);
        return out.sort();
      },
      async refs(bookId) {
        const out = [];
        for (const s of ['pages', 'items']) for (const r of await M.db.byBook(s, bookId)) if (r.image?.storage === 'external-v1') out.push(r.image.file);
        return out.sort();
      },
      async hash(source) { const b = await M.assets.getBlob(source); const a = new Uint8Array(await b.arrayBuffer()); let h = 0; for (const x of a) h = (h * 31 + x) >>> 0; return `${a.length}:${h}`; },
      async redBlob(color = '#e00') { const c = document.createElement('canvas'); c.width = 50; c.height = 30; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 50, 30); return M.assets.canvasToBlob(c, 'image/png'); },
    };
  });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', async (d) => { dialogs.push(d.type() === 'prompt' ? `${d.message()} [기본값:${d.defaultValue()}]` : d.message()); await (d.type() === 'prompt' ? d.accept(d.defaultValue()) : d.accept()); });
  await page.route('https://cdn.jsdelivr.net/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('pdf.min.mjs')) return r.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    if (u.includes('jspdf')) return r.fulfill({ contentType: 'text/javascript', body: captureJspdf });
    return r.fulfill({ status: 404 });
  });
  const ingest = async (name, withSolution) => {
    await page.click('#tabs button[data-tab=ingest]');
    await page.fill('#in-name', name);
    await page.setInputFiles('#in-problem', { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(problemBook())) });
    await page.setInputFiles('#in-solution', withSolution ? { name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(solutionBook())) } : []);
    await page.click('#btn-ingest');
    await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled, null, { timeout: 60000 });
    return page.evaluate(async (n) => (await M.db.all('books')).find((b) => b.name === n), name);
  };
  await page.goto('http://localhost:8772/');
  await page.click('#tabs button[data-tab=library]');
  await page.click('#lib-folder'); await page.waitForTimeout(300);
  await page.evaluate(() => localStorage.setItem('__ns', M.assets.status().ns));
  const A = await ingest('외부 책 A', true);

  // ── #5 외부 파일은 기록마다 고유하고, 같은 번호로 다시 써도 덮어쓰지 않는다
  const uniq = await page.evaluate(async (id) => {
    const items = await M.db.byBook('items', id), files = await window.__t.files(id), refs = await window.__t.refs(id);
    const b1 = await window.__t.redBlob('#e00'), b2 = await window.__t.redBlob('#00e');
    const r1 = await M.assets.storeImage(b1, { bookId: id, role: 'item-problem', id: '1-1' });
    const r2 = await M.assets.storeImage(b2, { bookId: id, role: 'item-problem', id: '1-1' });
    const ok = r1.file !== r2.file && await window.__t.hash(r1) === await window.__t.hash(b1) && await window.__t.hash(r2) === await window.__t.hash(b2);
    await M.assets.removeRefs([r1, r2]);
    return { items: items.length, distinct: new Set(items.map((x) => x.image.file)).size, filesMatch: JSON.stringify(files) === JSON.stringify(refs), ok, after: JSON.stringify(await window.__t.files(id)) === JSON.stringify(refs) };
  }, A.id);
  check('문제·해설 이미지 파일이 기록마다 고유하고 폴더와 기록이 일치', uniq.items === 24 && uniq.distinct === 24 && uniq.filesMatch, JSON.stringify(uniq));
  check('같은 번호(1-1)로 두 번 저장해도 서로 다른 파일 · 앞 파일 내용 보존', uniq.ok && uniq.after);

  // 품질 기준에 걸려 거부된 다시 분리는 기존 파일을 바꾸지도, 새 파일을 남기지도 않는다
  const gate = await page.evaluate(async (id) => {
    const book = await M.db.get('books', id);
    const before = await window.__t.files(id);
    const probs = (await M.db.byBook('items', id)).filter((x) => x.kind === 'problem');
    const hashes = await Promise.all(probs.map((p) => window.__t.hash(p.image)));
    let error = null;
    try { await M.pipeline.segmentKind({ ...book, options: { ...book.options, top: 0.95, bottom: 0, visualFallback: false } }, 'problem'); } catch (e) { error = e.message; }
    const after = await window.__t.files(id);
    const still = (await M.db.byBook('items', id)).filter((x) => x.kind === 'problem');
    const hashes2 = await Promise.all(still.map((p) => window.__t.hash(p.image)));
    return { error, same: JSON.stringify(before) === JSON.stringify(after), intact: JSON.stringify(hashes) === JSON.stringify(hashes2) && still.length === probs.length };
  }, A.id);
  check('거부된 다시 분리: 기존 문제 파일 그대로 · 새 파일 없음', /25%/.test(gate.error || '') && gate.same && gate.intact, JSON.stringify(gate));

  // 성공한 다시 분리: 교체가 저장된 뒤 옛 파일만 지우고, 같은 자리 문제의 직접 지정 난이도는 유지
  const reseg = await page.evaluate(async (id) => {
    const p1 = (await M.db.byBook('items', id)).find((x) => x.kind === 'problem' && x.number === 1);
    await M.db.update('items', p1.id, (f) => { f.gradeManual = 2; });
    const oldFiles = (await M.db.byBook('items', id)).filter((x) => x.kind === 'problem').map((x) => x.image.file);
    await M.pipeline.segmentKind(await M.db.get('books', id), 'problem');
    await M.pipeline.relink(id);
    const files = await window.__t.files(id), refs = await window.__t.refs(id);
    const n1 = (await M.db.byBook('items', id)).find((x) => x.kind === 'problem' && x.number === 1);
    return { oldGone: oldFiles.every((f) => !files.includes(f)), match: JSON.stringify(files) === JSON.stringify(refs), count: files.length, grade: n1?.gradeManual };
  }, A.id);
  check('다시 분리 성공 후 옛 문제 파일 삭제 · 폴더 파일 = 기록 참조 (29개)', reseg.oldGone && reseg.match && reseg.count === 29, JSON.stringify(reseg));
  check('다시 분리 후에도 같은 자리 문제의 직접 지정 난이도 유지', reseg.grade === 2, JSON.stringify(reseg));

  // 검토 화면에서 번호를 고쳐 저장하면 새 자르기 파일로 바꾸고 옛 파일은 지운다. 항목 삭제 시 그 파일도 지운다.
  await page.click('#tabs button[data-tab=review]'); await page.waitForTimeout(300);
  await page.selectOption('#rv-book', A.id); await page.waitForTimeout(500);
  await page.evaluate(() => { document.querySelector('#rv-editor').open = true; });
  const target = await page.evaluate(async (id) => (await M.db.byBook('items', id)).find((i) => i.kind === 'problem' && i.number === 1), A.id);
  await page.locator('#rv-canvas').scrollIntoViewIfNeeded();
  const cv = await page.locator('#rv-canvas').boundingBox();
  const cw = await page.evaluate(() => document.querySelector('#rv-canvas').width);
  const f0 = target.fragments[0];
  await page.mouse.click(cv.x + (f0.x0 + 20) * cv.width / cw, cv.y + (f0.y0 + 20) * cv.width / cw);
  await page.waitForTimeout(300);
  await page.locator('#rv-side input[type=number]').nth(1).fill('77');
  await page.locator('#rv-side button', { hasText: '번호 저장' }).click();
  await page.waitForFunction(() => document.querySelector('#rv-side h3')?.textContent.includes('1-77'), null, { timeout: 15000 }).catch(() => {});
  const edited = await page.evaluate(async ({ id, oldFile, bookId }) => {
    const it = await M.db.get('items', id), files = await window.__t.files(bookId);
    return { number: it.number, same: it.image.file === oldFile, exists: files.includes(it.image.file), match: JSON.stringify(files) === JSON.stringify(await window.__t.refs(bookId)), manual: it.detection?.numberManual === true && !it.detection?.inferred };
  }, { id: target.id, oldFile: target.image.file, bookId: A.id });
  check('검토에서 번호만 고쳐 저장: 자르기 파일은 그대로 · 폴더와 기록 일치', edited.number === 77 && edited.same && edited.exists && edited.match, JSON.stringify(edited));
  check('직접 고친 번호는 확인된 번호로 기록 (번호 추정 표시 해제)', edited.manual, JSON.stringify(edited));
  // 영역을 이어붙이면 다시 잘라 새 파일로 교체하고 옛 파일은 지운다 (고른 항목의 번호가 드래그 번호 칸에 미리 채워짐)
  // 번호 칸 입력·저장 중에 화면이 스크롤될 수 있으므로 캔버스 위치를 다시 잰다
  await page.evaluate(() => document.querySelector('#rv-canvas').scrollIntoView({ block: 'start' }));
  const cv2 = await page.locator('#rv-canvas').boundingBox();
  const kk = cv2.width / cw;
  const ndrag = dialogs.length;
  await page.mouse.move(cv2.x + 1125 * kk, cv2.y + 250 * kk); await page.mouse.down();
  await page.mouse.move(cv2.x + 1180 * kk, cv2.y + 330 * kk, { steps: 5 }); await page.mouse.up();
  // (waitForFunction은 Promise를 기다리지 않으므로 직접 폴링한다)
  for (let t0 = Date.now(); Date.now() - t0 < 30000;) {
    if (await page.evaluate((id) => M.db.get('items', id).then((it) => it.fragments.length), target.id) >= 2) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const promptDefault = dialogs.slice(ndrag).find((m) => m.startsWith('이 영역의 번호'))?.match(/\[기본값:(.*)\]$/)?.[1];
  check('고른 항목의 번호가 드래그 번호 칸에 미리 채워짐', promptDefault === '1-77', String(promptDefault));
  const recut = await page.evaluate(async ({ id, oldFile, bookId }) => {
    const it = await M.db.get('items', id), files = await window.__t.files(bookId);
    return { frags: it.fragments.length, changed: it.image.file !== oldFile, newExists: files.includes(it.image.file), oldGone: !files.includes(oldFile), match: JSON.stringify(files) === JSON.stringify(await window.__t.refs(bookId)) };
  }, { id: target.id, oldFile: target.image.file, bookId: A.id });
  check('영역을 이어붙여 다시 자르면 새 파일로 교체 · 옛 파일 삭제 · 폴더와 기록 일치', recut.frags === 2 && recut.changed && recut.newExists && recut.oldGone && recut.match, JSON.stringify(recut));
  const editedFile = await page.evaluate(async (id) => (await M.db.get('items', id)).image.file, target.id);
  await page.locator('#rv-side button', { hasText: '항목 삭제' }).click();
  await page.waitForTimeout(600);
  const removed = await page.evaluate(async ({ id, file, bookId }) => ({ gone: !(await M.db.get('items', id)), fileGone: !(await window.__t.files(bookId)).includes(file) }), { id: target.id, file: editedFile, bookId: A.id });
  check('항목 삭제 시 그 이미지 파일도 삭제', removed.gone && removed.fileGone, JSON.stringify(removed));
  // 추정 번호를 직접 고친 문제는 다시 분리해도 같은 자리에서 그 번호를 유지한다
  const carry = await page.evaluate(async (bookId) => {
    const p = (await M.db.byBook('items', bookId)).find((x) => x.kind === 'problem' && x.number === 3);
    await M.db.update('items', p.id, (f) => { f.number = 55; f.detection = { ...(f.detection || {}), inferred: false, numberManual: true }; });
    await M.pipeline.segmentKind(await M.db.get('books', bookId), 'problem');
    await M.pipeline.relink(bookId);
    const f0 = p.fragments[0];
    const n = (await M.db.byBook('items', bookId)).find((x) => x.kind === 'problem' && x.fragments[0].page === f0.page && Math.abs(x.fragments[0].y0 - f0.y0) < 20 && Math.abs(x.fragments[0].x0 - f0.x0) < 40);
    return { number: n?.number, manual: n?.detection?.numberManual, inferred: n?.detection?.inferred };
  }, A.id);
  check('직접 고친 번호는 다시 분리해도 같은 자리 문제에 유지', carry.number === 55 && carry.manual === true && !carry.inferred, JSON.stringify(carry));

  // ── #8 PDF는 만드는 순간의 최신 기록(고친 이미지·다시 연결한 해설)으로 만든다
  // (위에서 직접 다시 분리했으므로 사용자처럼 난이도 탭의 규칙 기반 판정을 한 번 실행)
  await page.click('#tabs button[data-tab=grade]'); await page.waitForTimeout(300);
  await page.selectOption('#gr-book', A.id); await page.click('#gr-heur');
  await page.waitForFunction(() => document.querySelector('#gr-log').textContent.includes('규칙 기반 판정 완료'), null, { timeout: 10000 });
  await page.click('#tabs button[data-tab=build]'); await page.waitForTimeout(500);
  await page.fill('#bd-count', '50'); await page.click('#bd-select'); await page.waitForTimeout(300);
  const staged = await page.evaluate(async (bookId) => {
    const items = await M.db.byBook('items', bookId);
    const probs = items.filter((x) => x.kind === 'problem' && x.solutionId).sort((a, b) => a.number - b.number);
    const [P, Q] = probs;
    const S1 = items.find((x) => x.id === P.solutionId), S2 = items.find((x) => x.id === Q.solutionId);
    const oldImg = await M.assets.asDataURL(P.image), s1 = await M.assets.asDataURL(S1.image), s2 = await M.assets.asDataURL(S2.image);
    const red = await window.__t.redBlob('#0a0');
    await M.db.update('items', P.id, (f) => { f.image = red; f.imageId = 'fresh'; f.w = 50; f.h = 30; f.solutionId = S2.id; });
    window.__pdfImages = []; window.__pdf = null;
    const reqSol = document.querySelector('#bd-reqsol').checked;
    return { oldImg, s1, s2, red: await M.assets.blobToDataURL(red), cards: document.querySelectorAll('#bd-list .card').length, total: items.filter((x) => x.kind === 'problem' && (!reqSol || x.solutionId)).length };
  }, A.id);
  await page.click('#bd-pdf');
  await page.waitForFunction(() => window.__pdf, null, { timeout: 20000 });
  const used = await page.evaluate((s) => {
    const n = (u) => window.__pdfImages.filter((x) => x === u).length;
    return { red: n(s.red), old: n(s.oldImg), s1: n(s.s1), s2: n(s.s2) };
  }, staged);
  check('선택 뒤 고친 문제 이미지를 PDF에 사용 (옛 이미지 0회)', staged.cards === staged.total && staged.total >= 11 && used.red === 1 && used.old === 0, JSON.stringify({ cards: staged.cards, total: staged.total, ...used }));
  check('선택 뒤 다시 연결한 해설을 PDF에 사용', used.s2 === 2 && used.s1 === 0, JSON.stringify(used));
  // 고른 뒤 지워진 문제가 있으면 PDF를 만들지 않고 다시 고르게 한다
  await page.click('#bd-select'); await page.waitForTimeout(300);
  await page.evaluate(async (bookId) => {
    const p = (await M.db.byBook('items', bookId)).find((x) => x.kind === 'problem');
    await M.db.del('items', p.id);
    window.__pdf = null;
  }, A.id);
  const nd = dialogs.length;
  await page.click('#bd-pdf'); await page.waitForTimeout(600);
  const refused = await page.evaluate(() => ({ pdf: window.__pdf, cards: document.querySelectorAll('#bd-list .card').length, disabled: document.querySelector('#bd-pdf').disabled }));
  check('고른 뒤 지워진 문제가 있으면 PDF 대신 다시 고르기 안내', refused.pdf === null && refused.cards === 0 && refused.disabled && dialogs.slice(nd).some((m) => m.includes('다시 눌러')), JSON.stringify({ ...refused, msg: dialogs.slice(nd) }));

  // ── 백업: 폴더에서 파일 하나가 사라져도 나머지는 백업하고 알린다. 가져오기는 연결한 폴더에 저장한다.
  await page.click('#tabs button[data-tab=library]'); await page.waitForTimeout(300);
  const [good] = await Promise.all([page.waitForEvent('download'), page.click('#lib-export')]);
  const goodPath = path.join(__dirname, 'integrity-backup.jsonl'); await good.saveAs(goodPath);
  const lost = await page.evaluate(async (bookId) => {
    const it = (await M.db.byBook('items', bookId)).find((x) => x.kind === 'solution');
    await (await window.__t.dir(bookId)).removeEntry(it.image.file);
    return it.id;
  }, A.id);
  const nb = dialogs.length;
  const [partial] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#lib-export')]);
  await page.waitForTimeout(300);
  const partialPath = path.join(__dirname, 'integrity-partial.jsonl'); await partial.saveAs(partialPath);
  const partialLines = fs.readFileSync(partialPath, 'utf8').trim().split('\n').slice(1).map(JSON.parse);
  const lostRec = partialLines.find((x) => x.v.id === lost);
  check('파일 하나를 못 읽어도 백업을 만들고 빠진 개수를 알림', !!partial && lostRec && lostRec.v.image === null && partialLines.filter((x) => x.s !== 'books' && typeof x.v.image === 'string').length === partialLines.filter((x) => x.s !== 'books').length - 1 && dialogs.slice(nb).some((m) => m.includes('1개는 읽을 수 없어')), JSON.stringify(dialogs.slice(nb)));
  await page.setInputFiles('#lib-import', goodPath);
  await page.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});
  const restored = await page.evaluate(async (bookId) => {
    const recs = [...await M.db.byBook('pages', bookId), ...await M.db.byBook('items', bookId)];
    const readable = await Promise.all(recs.map((r) => M.assets.getBlob(r.image).then((b) => b.size > 0, () => false)));
    return { n: recs.length, external: recs.every((r) => r.image?.storage === 'external-v1'), readable: readable.every(Boolean) };
  }, A.id);
  check('대용량 폴더를 쓰는 중이면 가져온 이미지도 폴더에 저장 (지워졌던 파일도 복구)', restored.n > 0 && restored.external && restored.readable, JSON.stringify(restored));
  // 같은 백업을 다시 가져와도 폴더에 교체된 옛 파일이 쌓이지 않는다 (앞 단계에서 테스트가 DB만 지운 문제 파일 하나는 원래 남아 있음)
  const filesBefore = await page.evaluate(async (bookId) => (await window.__t.files(bookId)).length, A.id);
  for (let k = 0; k < 2; k++) {
    await page.setInputFiles('#lib-import', goodPath);
    await page.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});
  }
  const again = await page.evaluate(async (bookId) => {
    const files = await window.__t.files(bookId), refs = await window.__t.refs(bookId);
    return { files: files.length, refs: refs.length, allRefsExist: refs.every((f) => files.includes(f)) };
  }, A.id);
  check('같은 백업을 두 번 더 가져와도 폴더 파일이 늘지 않고 모든 참조 파일이 있음', again.files === filesBefore && again.refs === restored.n && again.allRefsExist, JSON.stringify({ filesBefore, ...again }));
  // 쪽 이미지가 빠진 백업: 쪽 기록은 남기고, 그 종류는 다시 분리하지 않아 문제가 지워지지 않는다
  const pageLost = await page.evaluate(async (bookId) => {
    const pg = (await M.db.byBook('pages', bookId)).find((x) => x.kind === 'problem' && x.index === 2);
    await (await window.__t.dir(bookId)).removeEntry(pg.image.file);
    return pg.id;
  }, A.id);
  const nb2 = dialogs.length;
  const [skipDl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#lib-export')]);
  await page.waitForTimeout(300);
  const skipPath = path.join(__dirname, 'integrity-pageskip.jsonl'); await skipDl.saveAs(skipPath);
  check('쪽 이미지를 못 읽으면 알림에 그 쪽 이름을 적음', dialogs.slice(nb2).some((m) => m.includes('문제집 2쪽')), JSON.stringify(dialogs.slice(nb2)));
  const before = await page.evaluate(async (bookId) => (await M.db.byBook('items', bookId)).filter((x) => x.kind === 'problem').length, A.id);
  // 라이브러리에 그 쪽 기록이 있으면 (파일을 잃었더라도) 기록의 이미지 참조를 백업의 빈 값으로 바꾸지 않는다
  await page.setInputFiles('#lib-import', skipPath);
  await page.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});
  const keptRef = await page.evaluate(async (pageId) => { const pg = await M.db.get('pages', pageId); return M.assets.isRef(pg?.image) && !pg.imageMissing; }, pageLost);
  check('이미지가 빠진 백업을 가져와도 라이브러리 쪽 기록의 이미지 참조는 그대로', keptRef);
  // 그 쪽 기록이 없는 라이브러리에 복원하는 경우: 쪽 기록은 이미지 없이 복원하고, 그 종류는 다시 분리하지 않는다
  await page.evaluate((pageId) => M.db.del('pages', pageId), pageLost);
  await page.setInputFiles('#lib-import', skipPath);
  await page.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});
  const skipRestore = await page.evaluate(async ({ bookId, pageId }) => {
    const pg = await M.db.get('pages', pageId);
    let err = null;
    try { await M.pipeline.segmentKind(await M.db.get('books', bookId), 'problem'); } catch (e) { err = e.message; }
    return { kept: !!pg, image: pg?.image ?? null, err, problems: (await M.db.byBook('items', bookId)).filter((x) => x.kind === 'problem').length };
  }, { bookId: A.id, pageId: pageLost });
  check('이미지가 빠진 쪽도 쪽 기록은 복원하고, 다시 분리를 거부해 문제를 지키고 안내', skipRestore.kept && skipRestore.image === null && /이미지가 없는 쪽\(2쪽\)/.test(skipRestore.err || '') && skipRestore.problems === before, JSON.stringify(skipRestore));
  // 이후 단계를 위해 온전한 백업으로 되돌린다
  await page.setInputFiles('#lib-import', goodPath);
  await page.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});

  // ── #6 저장 공간 최적화: 책 단위 잠금, 그사이 고치거나 지운 기록을 옛 이미지로 덮어쓰지 않음
  await page.click('#tabs button[data-tab=library]');
  await page.click('#lib-folder-off'); await page.waitForTimeout(200);
  const B = await ingest('내부 책 B', false);
  await page.click('#tabs button[data-tab=library]'); await page.waitForTimeout(300);
  await page.click('#lib-folder'); await page.waitForTimeout(300);
  const XY = await page.evaluate(async (bookId) => {
    const probs = (await M.db.byBook('items', bookId)).filter((x) => x.kind === 'problem').sort((a, b) => a.number - b.number);
    const X = probs[0].id, Y = probs[1].id;
    window.__edited = await window.__t.redBlob('#123');
    const orig = M.db.update;
    let first = true;
    window.__restore = () => { M.db.update = orig; };
    window.__gate = new Promise((r) => { window.__open = r; });
    // 최적화가 기록을 읽은 뒤 저장하기 직전에: X는 검토 화면에서 고친 것처럼, Y는 지운 것처럼 만든다
    M.db.update = async function (name, id, fn) {
      if (first) { first = false; window.__paused = true; await window.__gate; }
      if (name === 'items' && id === X) await orig.call(M.db, 'items', X, (f) => { f.image = window.__edited; f.imageBytes = window.__edited.size; f.imageId = 'edited-in-review'; });
      if (name === 'items' && id === Y) await M.db.del('items', Y);
      return orig.call(M.db, name, id, fn);
    };
    return { X, Y };
  }, B.id);
  await page.click('#lib-optimize');
  await page.waitForFunction(() => window.__paused, null, { timeout: 20000 });
  await page.waitForTimeout(500);
  const locked = await page.evaluate(({ a, b }) => {
    const row = (name) => [...document.querySelectorAll('.bookrow')].find((r) => r.textContent.includes(name));
    const del = (r) => [...r.querySelectorAll('button')].find((x) => x.textContent === '삭제');
    return { bText: row(b).textContent.includes('저장 공간 정리 중'), bDisabled: del(row(b)).disabled, aEnabled: !del(row(a)).disabled };
  }, { a: '외부 책 A', b: '내부 책 B' });
  check('최적화 중인 책만 잠금 (삭제 버튼 비활성, 상태 표시), 끝난 책은 해제', locked.bText && locked.bDisabled && locked.aEnabled, JSON.stringify(locked));
  await page.evaluate(() => window.__open());
  await page.waitForFunction(() => !document.querySelector('#lib-optimize').disabled, null, { timeout: 60000 });
  const race = await page.evaluate(async ({ bookId, X, Y }) => {
    window.__restore();
    const x = await M.db.get('items', X), y = await M.db.get('items', Y);
    const recs = [...await M.db.byBook('pages', bookId), ...await M.db.byBook('items', bookId)];
    const files = await window.__t.files(bookId), refs = await window.__t.refs(bookId);
    return {
      xKept: x.image instanceof Blob && x.image.size === window.__edited.size && x.imageId === 'edited-in-review',
      yGone: !y, othersMoved: recs.filter((r) => r.id !== X).every((r) => r.image?.storage === 'external-v1'),
      noOrphan: JSON.stringify(files) === JSON.stringify(refs), files: files.length, refs: refs.length,
    };
  }, { bookId: B.id, ...XY });
  check('최적화 도중 고친 이미지를 옛 이미지로 되돌리지 않음', race.xKept, JSON.stringify(race));
  check('최적화 도중 지운 기록을 되살리지 않고, 방금 쓴 파일도 남기지 않음', race.yGone && race.othersMoved && race.noOrphan, JSON.stringify(race));
  // 다른 창에서 처리 중(저장된 처리 상태 + 최근 살아 있다는 표시)인 책은 최적화에서 건너뛴다
  await page.evaluate(async (id) => { await M.db.update('books', id, (b) => { b.ingest = { ...(b.ingest || {}), status: 'processing', updatedAt: Date.now() }; }); }, A.id);
  const nd3 = dialogs.length;
  await page.click('#lib-optimize');
  await page.waitForFunction(() => !document.querySelector('#lib-optimize').disabled, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  check('다른 창에서 처리 중인 책은 최적화에서 건너뛰고 알림', dialogs.slice(nd3).some((m) => m.includes('1권은 건너뛰었습니다')), JSON.stringify(dialogs.slice(nd3)));
  await page.evaluate(async (id) => { await M.db.update('books', id, (b) => { b.ingest = { ...(b.ingest || {}), status: 'complete' }; }); }, A.id);

  // ── #7 폴더 연결이 끊긴 상태에서 책을 지우면 정리 대기로 남기고, 다시 연결하면 지운다
  await page.evaluate(() => localStorage.setItem('__perm', 'prompt'));
  await page.reload(); await page.waitForTimeout(500);
  await page.click('#tabs button[data-tab=library]'); await page.waitForTimeout(400);
  const disconnected = await page.evaluate(() => !M.assets.status().connected && M.assets.status().needsPermission);
  const permNotice = await page.evaluate(() => ({ status: document.querySelector('#lib-folder-status').textContent, toast: document.querySelector('#toast').textContent }));
  check('새로고침 뒤 폴더 권한이 없으면 다시 허용하라고 안내 (상태 문구·알림)', permNotice.status.includes('접근 권한이 필요') && permNotice.toast.includes('권한을 다시 허용'), JSON.stringify(permNotice));
  const nd2 = dialogs.length;
  await page.locator('.bookrow', { hasText: '외부 책 A' }).locator('button', { hasText: '삭제' }).click();
  await page.waitForTimeout(800);
  const pending = await page.evaluate(async (id) => ({
    tomb: !!(await M.db.get('settings', 'cleanup:' + id)), count: M.assets.status().pendingCleanup,
    folder: !!(await window.__t.dir(id)), book: !!(await M.db.get('books', id)), status: document.querySelector('#lib-folder-status').textContent,
  }), A.id);
  check('연결이 끊긴 채 삭제: 책은 지우고 폴더 정리 대기 기록을 남김', disconnected && !pending.book && pending.tomb && pending.count === 1 && pending.folder, JSON.stringify(pending));
  check('사용자에게 정리 대기를 알림 (삭제 안내·폴더 상태 문구)', dialogs.slice(nd2).some((m) => m.includes('자동으로 정리')) && pending.status.includes('정리 대기'), JSON.stringify(dialogs.slice(nd2)));
  await page.click('#lib-folder'); await page.waitForTimeout(600);
  const cleaned = await page.evaluate(async (id) => ({ tomb: !!(await M.db.get('settings', 'cleanup:' + id)), count: M.assets.status().pendingCleanup, folder: !!(await window.__t.dir(id)) }), A.id);
  check('폴더를 다시 연결하면 남은 이미지 폴더를 지우고 대기 기록 삭제', !cleaned.tomb && cleaned.count === 0 && !cleaned.folder, JSON.stringify(cleaned));
  // 새로고침으로 권한이 돌아온 경우에도 시작할 때 정리
  await page.evaluate(() => localStorage.setItem('__perm', 'prompt'));
  await page.reload(); await page.waitForTimeout(500);
  await page.click('#tabs button[data-tab=library]'); await page.waitForTimeout(400);
  await page.locator('.bookrow', { hasText: '내부 책 B' }).locator('button', { hasText: '삭제' }).click();
  await page.waitForTimeout(800);
  const pendingB = await page.evaluate(async (id) => ({ tomb: !!(await M.db.get('settings', 'cleanup:' + id)), folder: !!(await window.__t.dir(id)) }), B.id);
  await page.evaluate(() => localStorage.setItem('__perm', 'granted'));
  await page.reload(); await page.waitForTimeout(800);
  const cleanedB = await page.evaluate(async (id) => { await M.assets.init(); return { tomb: !!(await M.db.get('settings', 'cleanup:' + id)), folder: !!(await window.__t.dir(id)), count: M.assets.status().pendingCleanup }; }, B.id);
  check('권한이 돌아온 새로고침 때도 정리 대기 폴더를 지움', pendingB.tomb && pendingB.folder && !cleanedB.tomb && !cleanedB.folder && cleanedB.count === 0, JSON.stringify({ pendingB, cleanedB }));
  check('무결성 흐름 JS 오류 없음', errors.length === 0, errors.join(' | '));
  await context.close(); await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
