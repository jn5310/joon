// AI 판정(비전 OCR) 브라우저 테스트: 지정 프롬프트로 요청 → LaTeX 문제 글·선지·난이도·단원 유형 저장, 역슬래시 하나짜리 LaTeX·코드 블록 응답,
// 한 영역 여러 문제·번호 다름·[미상] 표시, 읽을 수 없는 응답 재시도, 난이도를 못 받으면 비우고 다시 판정, RECITATION 안내,
// 영역을 고치면 '다시 판정 필요', 판정 중 영역 변경 시 저장 안 함, 차례가 오기 전에 고친 영역은 새 자르기로 판정, 예전 AI 등급·전체 다시는 먼저 묻기,
// 다시 분리해도 같은 영역이면 유지, JSON 내려받기(중복 없이·출처 포함), 수식 미리보기(KaTeX, 실패 뒤 다시 시도), 이미지 없는 백업의 AI 묶음, 정답 직접 입력,
// Claude·OpenAI·Ollama 요청 모양
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('./pw');
const { fakePdfjs, fakeJspdf } = require('./fakes');
const { problemBook, solutionBook } = require('./gen');
const ROOT = path.resolve(__dirname, '..');
const SYSTEM = fs.readFileSync(path.join(__dirname, 'ocr-system-prompt.txt'), 'utf8');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});
// 가짜 KaTeX: auto-render가 $…$를 <span class="katex">로 바꾼다 (전달한 구분자도 기록)
const katexStub = 'window.katex = { version: "stub" };';
const autoRenderStub = '(' + (() => {
  window.renderMathInElement = (root, opts) => {
    window.__katex = { calls: (window.__katex?.calls || 0) + 1, delimiters: opts?.delimiters };
    const walk = (node) => {
      for (const n of [...node.childNodes]) {
        if (n.nodeType === 3 && /\$[^$]+\$/.test(n.nodeValue)) {
          const span = document.createElement('span');
          for (const part of n.nodeValue.split(/(\$[^$]+\$)/)) {
            if (!part) continue;
            if (/^\$[^$]+\$$/.test(part)) { const k = document.createElement('span'); k.className = 'katex'; k.textContent = part.slice(1, -1); span.append(k); } else span.append(part);
          }
          n.replaceWith(span);
        } else if (n.nodeType === 1) walk(n);
      }
    };
    walk(root);
  };
}).toString() + ')();';
const P = (o = {}) => ({ problem_number: null, passage: null, question: '수열 $\\{a_n\\}$의 값은?', choices: ['① $1$', '② $2$', '③ $3$', '④ $4$', '⑤ $5$'], has_figure_or_diagram: false, topic: '수학 I - 수열', difficulty_level: 3, difficulty_reasoning: '보통', ...o });
// 1-1번 응답: 코드 블록 + 역슬래시를 하나만 쓴 LaTeX (그대로는 올바른 JSON이 아님)
const Q1 = String.raw`함수 $f(x) = \frac{1}{3}x^3 - 2x$에 대하여 $\lim_{h \to 0} \frac{f(1+h) - f(1)}{h}$의 값은?`;
const C1 = [String.raw`① $-\frac{1}{2}$`, '② $-1$', String.raw`③ $\sqrt{2}$`, '④ $2$', '⑤ $3$'];
const RAW1 = '```json\n' + String.raw`{"problems":[{"problem_number":"01","passage":null,"question":"` + Q1 + '","choices":[' + C1.map((c) => `"${c}"`).join(',')
  + String.raw`],"has_figure_or_diagram":false,"topic":"수학 II - 미분계수와 도함수","difficulty_level":2,"difficulty_reasoning":"미분계수의 정의를 쓰는 기본 문제"}]}` + '\n```';
const gem = (text, finishReason = 'STOP') => ({ candidates: [{ content: { parts: text == null ? [] : [{ text }] }, finishReason }] });
const ok = (...problems) => gem(JSON.stringify({ problems: problems.length ? problems : [P()] }));

(async () => {
  await new Promise((r) => server.listen(8776, r));
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [], dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  page.on('dialog', async (d) => {
    dialogs.push(d.message());
    if (d.type() === 'prompt') return d.accept(page.__answer ?? d.defaultValue());
    if (d.type() === 'confirm' && page.__dismiss) { page.__dismiss = false; return d.dismiss(); }
    return d.accept();
  });
  let katexMode = '404', katexHits = 0;
  await page.route('https://cdn.jsdelivr.net/**', (r) => {
    const u = r.request().url();
    if (u.endsWith('pdf.min.mjs')) return r.fulfill({ contentType: 'text/javascript', body: fakePdfjs });
    if (u.includes('jspdf')) return r.fulfill({ contentType: 'text/javascript', body: fakeJspdf });
    if (u.includes('/katex@0.16.11/')) {
      katexHits++;
      if (katexMode === 'stub') {
        if (u.endsWith('katex.min.css')) return r.fulfill({ contentType: 'text/css', body: '' });
        if (u.endsWith('katex.min.js')) return r.fulfill({ contentType: 'text/javascript', body: katexStub });
        if (u.endsWith('auto-render.min.js')) return r.fulfill({ contentType: 'text/javascript', body: autoRenderStub });
      }
    }
    return r.fulfill({ status: 404, body: '' });
  });
  // Gemini: 미리 정한 응답을 차례로 (없으면 기본 응답). hold가 있으면 그 약속이 풀릴 때까지 응답을 미룬다
  const plan = [], geminiBodies = [];
  let hold = null;
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    geminiBodies.push(JSON.parse(route.request().postData()));
    if (hold) { const h = hold; hold = null; await h; }
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(plan.length ? plan.shift() : ok()) });
  });
  const other = {};
  const answerFor = (tag) => JSON.stringify({ problems: [P({ question: `${tag}: $\\sqrt{3}$`, difficulty_level: 4, topic: '수학 II - 정적분' })] });
  await page.route('https://api.anthropic.com/**', (route) => { other.anthropic = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) }; route.fulfill({ contentType: 'application/json', body: JSON.stringify({ content: [{ type: 'text', text: '```json\n' + answerFor('claude') + '\n```' }], stop_reason: 'end_turn' }) }); });
  await page.route('https://api.openai.com/**', (route) => { other.openai = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) }; route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: answerFor('openai') }, finish_reason: 'stop' }] }) }); });
  await page.route('http://localhost:11434/**', (route) => { other.ollama = { body: JSON.parse(route.request().postData()) }; route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: { content: answerFor('ollama') }, done_reason: 'stop' }) }); });

  await page.goto('http://localhost:8776/');
  await page.fill('#in-name', 'AI 책');
  await page.selectOption('#in-subject', '수학II');
  await page.setInputFiles('#in-problem', { name: 'p.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(problemBook())) });
  await page.setInputFiles('#in-solution', { name: 's.pdf', mimeType: 'application/pdf', buffer: Buffer.from(JSON.stringify(solutionBook())) });
  await page.click('#btn-ingest');
  await page.waitForFunction(() => !document.querySelector('#btn-ingest').disabled, null, { timeout: 60000 });
  const bookId = await page.evaluate(async () => (await M.db.all('books'))[0].id);
  const item = (n) => page.evaluate(async ({ b, n }) => (await M.db.byBook('items', b)).find((i) => i.kind === 'problem' && i.number === n), { b: bookId, n });
  const ends = () => page.evaluate(() => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length);
  const runAndWait = async (sel) => {
    const n = await ends(); await page.click(sel);
    try { await page.waitForFunction((k) => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length > k, n, { timeout: 60000 }); }
    catch (e) { console.log('   (기다리다 멈춤) 로그 끝:', (await page.textContent('#gr-log')).split('\n').slice(-4).join(' / '), '| 대화상자:', JSON.stringify(dialogs.slice(-2)).slice(0, 300), '| 오류:', errors.join(' | ')); throw e; }
  };
  const log = () => page.textContent('#gr-log');
  const card = (key) => page.locator('#rv-list .card').filter({ has: page.locator('b', { hasText: new RegExp(`^${key}$`) }) });
  const toReview = async () => { await page.click('#tabs button[data-tab=review]'); await sleep(300); await page.selectOption('#rv-book', bookId); await sleep(600); };
  const toGrade = async () => { await page.click('#tabs button[data-tab=grade]'); await sleep(200); await page.selectOption('#gr-book', bookId); };

  // ── 1) 1문제로 테스트: 지정 프롬프트, 역슬래시 하나짜리 LaTeX + 코드 블록 응답
  await toGrade();
  await page.fill('#gr-key', 'test-key'); await page.dispatchEvent('#gr-key', 'change');
  await page.fill('#gr-delay', '0'); await page.dispatchEvent('#gr-delay', 'change');
  plan.push(gem(RAW1));
  await runAndWait('#gr-test');
  const b0 = geminiBodies[0];
  check('요청: systemInstruction = 지정 프롬프트, 문제 이미지 1장 + 사용자 글(책 과목)', b0.systemInstruction.parts[0].text === SYSTEM && b0.contents[0].parts.filter((p) => p.inline_data).length === 1
    && b0.contents[0].parts.at(-1).text.includes('"수학II"') && b0.generationConfig.responseMimeType === 'application/json');
  const i1 = await item(1);
  check('역슬래시 하나짜리 LaTeX를 그대로 복원해 저장 (문제 글·선지)', i1.aiExtract?.problems?.[0]?.question === Q1 && JSON.stringify(i1.aiExtract.problems[0].choices) === JSON.stringify(C1), JSON.stringify(i1.aiExtract?.problems?.[0]?.question));
  check('난이도 2단계 → 7등급, 단원 유형 → 과목 수학II·유형 다항함수의 미분, 근거 저장', i1.difficultyLLM === 2 && i1.gradeLLM === 7 && i1.subjectLLM === '수학II' && i1.typeLLM === '다항함수의 미분' && i1.unit === '수학 II - 미분계수와 도함수' && i1.llmReason.includes('미분계수'),
    JSON.stringify([i1.difficultyLLM, i1.gradeLLM, i1.subjectLLM, i1.typeLLM, i1.unit]));
  check('로그: 난이도·단원·유형·선지 수·문제 글 앞부분', (await log()).includes('1-1번 → 난이도 2단계(7등급) · 수학 II - 미분계수와 도함수 · 유형 다항함수의 미분 · 선지 5개 · 문제: 함수 $f(x) = \\frac{1}{3}x^3'), (await log()).split('\n').slice(-2)[0]);

  // ── 2) 아직 안 한 문제만: 한 영역 문제 2개, 읽을 수 없는 응답 → 재시도, 범위 밖 난이도·[미상], 번호 다름, 한 영역에서 다른 영역에 없는 문제
  plan.push(ok(P({ problem_number: '02', question: '둘째 문제' }), P({ problem_number: '03', question: '셋째 문제 $x$의 값' }))); // 1-2: 옆 영역 1-3과 겹쳐 잘림
  plan.push(ok(P({ problem_number: '03', question: '셋째 문제 $x$의 값은? (조건 생략)' }))); // 1-3
  plan.push(gem('죄송합니다. 지금은 답할 수 없습니다.'), ok(P({ question: '다시 시도해 받은 글' }))); // 1-4 (재시도)
  plan.push(ok(P({ problem_number: '05', difficulty_level: 9, question: '$x^2 + \\text{[미상]}$의 값은?' }), P({ problem_number: '유제 05', question: '유제 문제 (5번 영역에 붙어 잘림)' }))); // 1-5
  plan.push(ok()); // 1-6
  plan.push(ok(P({ problem_number: '09' }))); // 1-7
  plan.push(ok(), ok(), ok(), ok()); // 1-8 … 1-11
  plan.push(ok(P({ problem_number: '12' }), P({ problem_number: '13', question: '열셋째 문제 (12번 영역에만 있음)' }), P({ problem_number: '01', question: '2단원 첫 문제 (12번 영역에 붙어 잘림)' }))); // 1-12
  const before = geminiBodies.length;
  await runAndWait('#gr-llm');
  const l2 = await log();
  check('아직 안 한 11문제만 판정 + 읽을 수 없던 응답 1번 재시도 (요청 12번), 모두 성공', geminiBodies.length - before === 12 && l2.includes('AI 판정 끝: 성공 11, 실패 0'), `요청 ${geminiBodies.length - before}회 / ${l2.split('\n').slice(-2)[0]}`);
  const [i2, i4, i5, i7] = [await item(2), await item(4), await item(5), await item(7)];
  check('한 영역에서 문제 2개: 둘 다 저장, 번호가 같은 문제(02)를 이 항목의 것으로', i2.aiExtract.problems.length === 2 && i2.aiExtract.primary === 0 && l2.includes('이 영역에서 문제 2개를 읽음'));
  check('AI가 읽은 번호가 다르면 로그에 알림', i7.aiExtract.problems[0].problem_number === '09' && l2.includes('AI가 읽은 번호 09'));
  check('읽을 수 없는 응답은 한 번 더 요청해 저장', i4.aiExtract.problems[0].question === '다시 시도해 받은 글');
  check('범위 밖 난이도(9): 글은 저장하고 등급은 비움, 로그에 알림', !!i5.aiExtract && i5.difficultyLLM == null && i5.gradeLLM == null && l2.includes('1-5번 → 난이도를 받지 못함'), JSON.stringify([i5.difficultyLLM, i5.gradeLLM]));
  check('[미상]으로 적은 곳이 있으면 로그에 "안 보이는 부분" 알림', l2.split('\n').find((x) => x.startsWith('1-5번'))?.includes('안 보이는 부분 [미상]') && !l2.split('\n').find((x) => x.startsWith('1-4번'))?.includes('[미상]'));

  // ── 3) 검토 화면: 표시, 수식 미리보기 — KaTeX를 못 불러오면 LaTeX 글자 그대로, 다음에 펼칠 때 다시 시도
  await toReview();
  check('검토 카드 표시: "AI: 문제 2개", "AI가 읽은 번호 09", "AI: 안 보이는 부분 있음"', (await card('1-2').textContent()).includes('AI: 문제 2개') && (await card('1-7').textContent()).includes('AI가 읽은 번호 09')
    && (await card('1-5').textContent()).includes('AI: 안 보이는 부분 있음') && !(await card('1-4').textContent()).includes('AI가 읽은') && !(await card('1-4').textContent()).includes('안 보이는'));
  const box1 = card('1-1').locator('details.ai-box');
  check('검토 카드에 접힌 "AI가 옮겨 적은 문제" (난이도 단계 → 등급)', (await box1.locator(':scope > summary').textContent()).includes('AI가 옮겨 적은 문제 (LaTeX) · 난이도 2단계 → 7등급'));
  await box1.locator(':scope > summary').click(); await sleep(500);
  const raw = await box1.evaluate((d) => ({ q: d.querySelector('.ai-question')?.textContent, choices: [...d.querySelectorAll('.ai-choices li')].map((li) => li.textContent), katex: d.querySelectorAll('.katex').length, json: d.querySelector('.ai-json')?.textContent }));
  check('KaTeX를 못 불러오면 LaTeX 글자 그대로 보여 줌 (오류 없음)', raw.q === Q1 && JSON.stringify(raw.choices) === JSON.stringify(C1) && raw.katex === 0 && katexHits > 0, JSON.stringify(raw.q));
  const shown = JSON.parse(raw.json || '{}');
  check('JSON 보기: 지정 구조 그대로', JSON.stringify(Object.keys(shown.problems?.[0] || {})) === JSON.stringify(['problem_number', 'passage', 'question', 'choices', 'has_figure_or_diagram', 'topic', 'difficulty_level', 'difficulty_reasoning']) && shown.problems[0].question === Q1);
  katexMode = 'stub'; // 인터넷이 돌아옴 (새로 고치지 않고)
  await card('1-3').locator('details.ai-box > summary').click(); await sleep(600);
  const drawn = await card('1-3').locator('details.ai-box').evaluate((d) => ({ katex: [...d.querySelectorAll('.ai-question .katex')].map((k) => k.textContent), inJson: d.querySelector('.ai-json .katex') != null, delims: window.__katex?.delimiters,
    nullText: [...d.querySelector('.ai-extract').childNodes].some((n) => n.nodeType === 3 && n.nodeValue.includes('null')) }));
  check('KaTeX 로드에 실패해도 다음에 펼칠 때 다시 불러와 $…$ 수식을 그림 ($$…$$·$…$ 구분자, JSON 칸은 그대로)', drawn.katex[0] === 'x' && !drawn.inJson && JSON.stringify(drawn.delims) === JSON.stringify([{ left: '$$', right: '$$', display: true }, { left: '$', right: '$', display: false }]), JSON.stringify(drawn));
  check('펼친 칸에 빈 값이 "null" 글자로 나오지 않음', !drawn.nullText);
  const css = await page.evaluate(() => ({ links: document.querySelectorAll('link[data-katex]').length, loaded: !!document.querySelector('link[data-katex]')?.sheet }));
  await box1.locator(':scope > summary').click(); await sleep(200); await box1.locator(':scope > summary').click(); await sleep(600); // 처음 실패했던 칸을 다시 펼침
  const again1 = await box1.evaluate((d) => d.querySelectorAll('.ai-question .katex').length);
  check('실패했던 스타일시트도 다시 받고, 처음 실패한 칸도 다시 펼치면 수식을 그림', css.links === 1 && css.loaded && again1 === 2, JSON.stringify({ ...css, again1 }));

  // ── 4) JSON 내려받기: 영역마다 그 항목의 문제, 다른 영역에 없는 문제만 더 넣고, 출처(sources)를 같은 순서로
  await toGrade();
  // 1-1의 영역을 1-2 영역까지 늘려 두 영역이 실제로 겹치게 하고, 1-1에서 02의 윗부분도 읽은 것처럼 만든다 (진짜 중복)
  const [e1, e2] = [await item(1), await item(2)];
  await page.evaluate(async ({ id, y1, extra }) => { await M.db.update('items', id, (f) => { f.fragments = [{ ...f.fragments[0], y1 }]; f.aiExtract = { ...f.aiExtract, problems: [...f.aiExtract.problems, extra] }; }); },
    { id: e1.id, y1: e2.fragments[0].y0 + 40, extra: P({ problem_number: '02', question: '둘째 문제 \\text{[미상]}' }) });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#gr-export')]);
  await page.evaluate(async ({ id, frags, ex }) => { await M.db.update('items', id, (f) => { f.fragments = frags; f.aiExtract = ex; }); }, { id: e1.id, frags: e1.fragments, ex: e1.aiExtract }); // 되돌림
  const out = path.join(__dirname, 'ai-export.json'); await dl.saveAs(out);
  const exp = JSON.parse(fs.readFileSync(out, 'utf8'));
  const keysOk = exp.problems.every((p) => Object.keys(p).join() === 'problem_number,passage,question,choices,has_figure_or_diagram,topic,difficulty_level,difficulty_reasoning');
  check('JSON 파일: {"problems": [16개], "sources": [16개]}, 항목 8개를 지정 순서로, 첫 문제 = 1-1', dl.suggestedFilename() === 'AI 책_AI판정.json' && Object.keys(exp).join() === 'problems,sources' && exp.problems.length === 16 && exp.sources.length === 16 && keysOk && exp.problems[0].question === Q1,
    `${dl.suggestedFilename()} · ${exp.problems?.length}개`);
  const at = (q) => exp.problems.findIndex((p) => p.question.startsWith(q));
  const expLog = (await log()).split('\n').find((l) => l.startsWith('JSON 내려받기')) || '';
  check('겹친 영역에서 같은 번호로 두 번 읽힌 문제(1-1의 02)만 한 번 넣고 로그에 이름을 적음', !exp.problems.some((p) => p.question.startsWith('둘째 문제 \\text')) && expLog.includes('두 번 읽힌 문제 1개는 한 번만 넣음: 1-1의 02'), expLog);
  check('겹치지 않은 영역에서 더 읽은 문제는 번호가 같아도 모두 넣고(1-2의 03·1-5의 유제 05·1-12의 13·01) 로그에 이름을 적음', at('셋째 문제 $x$의 값은?') >= 0 && at('셋째 문제 $x$의 값') >= 0 && exp.problems.filter((p) => p.problem_number === '03').length === 2
    && at('유제 문제') === at('$x^2 + ') + 1 && at('2단원 첫 문제') >= 0 && at('열셋째 문제') >= 0 && expLog.includes('한 영역에서 더 읽은 문제 4개 포함: 1-2의 03, 1-5의 유제 05, 1-12의 13, 1-12의 01'), expLog);
  check('출처(sources): 각 문제의 항목·쪽, 한 영역에서 더 읽은 문제는 extra 표시', JSON.stringify(exp.sources[0]) === JSON.stringify({ book: 'AI 책', item: '1-1', pages: [1] })
    && JSON.stringify(exp.sources.at(-1)) === JSON.stringify({ book: 'AI 책', item: '1-12', pages: [3], extra: true }) && exp.sources[at('유제 문제')].item === '1-5' && exp.sources[at('유제 문제')].extra === true
    && exp.sources[at('셋째 문제 $x$의 값') === at('셋째 문제 $x$의 값은?') ? -1 : exp.problems.findIndex((p) => p.question === '셋째 문제 $x$의 값')]?.extra === true, JSON.stringify(exp.sources.slice(-3)));

  // ── 5) 영역을 고치면 '다시 판정 필요' → "아직 안 한 문제만"이 그 문제와 난이도를 못 받은 문제를 다시 판정
  await toReview();
  await card('1-6').locator('button', { hasText: '원본에서 보기·수정' }).click(); await sleep(800);
  await page.evaluate(() => document.querySelector('#rv-canvas').scrollIntoView({ block: 'start' }));
  const cv = await page.locator('#rv-canvas').boundingBox();
  const k = cv.width / await page.evaluate(() => document.querySelector('#rv-canvas').width);
  await page.mouse.move(cv.x + 1125 * k, cv.y + 250 * k); await page.mouse.down();
  await page.mouse.move(cv.x + 1180 * k, cv.y + 330 * k, { steps: 5 }); await page.mouse.up();
  for (let t0 = Date.now(); Date.now() - t0 < 15000 && (await item(6)).fragments.length < 2;) await sleep(200);
  const i6 = await item(6);
  check('영역을 이어붙이면 AI 결과는 남기고 "다시 판정 필요"로 표시', i6.fragments.length === 2 && i6.aiExtract?.stale === true && i6.difficultyLLM === 3, JSON.stringify([i6.fragments.length, i6.aiExtract?.stale]));
  check('검토 카드에 "AI 다시 판정 필요"', (await card('1-6').textContent()).includes('AI 다시 판정 필요'));
  await toGrade();
  const b5 = geminiBodies.length;
  await runAndWait('#gr-llm');
  const [r5, r6] = [await item(5), await item(6)];
  check('아직 안 한 문제만 = 다시 판정이 필요한 1-6 + 난이도를 못 받은 1-5 (2문제)', geminiBodies.length - b5 === 2 && r6.aiExtract.stale === undefined && r5.difficultyLLM === 3 && r5.gradeLLM === 5, `요청 ${geminiBodies.length - b5}회`);

  // ── 6) 판정하는 사이 영역이 바뀌면(자르기 이미지 교체) 옛 영역의 결과를 저장하지 않는다
  let open; hold = new Promise((r) => { open = r; });
  const at1 = (await item(1)).aiExtract.at;
  const n6 = await ends(), b6 = geminiBodies.length;
  await page.click('#gr-test');
  for (let t0 = Date.now(); Date.now() - t0 < 10000 && geminiBodies.length === b6;) await sleep(100); // 요청이 AI에 닿을 때까지
  await page.evaluate(async (id) => { await M.db.update('items', id, (f) => { f.imageId = 'recut-during-ai'; }); }, i1.id);
  open();
  await page.waitForFunction((k) => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length > k, n6, { timeout: 30000 });
  check('판정 중 영역이 바뀐 문제는 결과를 저장하지 않고 알림', (await item(1)).aiExtract.at === at1 && (await log()).includes('1-1번: 판정하는 사이 영역을 고쳐 이 결과는 저장하지 않았습니다'), (await log()).split('\n').slice(-3).join(' / '));

  // ── 7) RECITATION(교재 원문 차단): 한 번 더 요청하고, 그래도 막히면 이유를 알림
  const b7 = geminiBodies.length;
  plan.push(gem(null, 'RECITATION'), gem(null, 'RECITATION'));
  await runAndWait('#gr-test');
  check('RECITATION 응답: 재시도 1번 뒤 실패로 알림 (이유 포함)', geminiBodies.length - b7 === 2 && (await log()).includes('1-1번 실패: AI 응답에 JSON이 없습니다') && (await log()).includes('RECITATION: 교재 원문을 그대로 옮기는 응답을 Gemini가 막았습니다'), (await log()).split('\n').slice(-2)[0]);
  const b7b = geminiBodies.length;
  plan.push(gem('{"problems":[{"question":"$\\\\frac{1}{', 'MAX_TOKENS'));
  await runAndWait('#gr-test');
  check('잘린 응답(MAX_TOKENS)은 같은 요청으로 다시 보내지 않고 이유를 알림', geminiBodies.length - b7b === 1 && (await log()).includes('응답이 너무 길어 잘렸습니다'), (await log()).split('\n').slice(-2)[0]);

  // ── 8) 예전 방식으로 AI 등급만 받은 문제는 먼저 묻고, 차례가 오기 전에 고친 영역은 새 자르기로 판정
  const [i8, i10, i11] = [await item(8), await item(10), await item(11)];
  await page.evaluate(async (ids) => { for (const id of ids) await M.db.update('items', id, (f) => { delete f.aiExtract; delete f.difficultyLLM; f.gradeLLM = 2; }); }, [i8.id, (await item(9)).id, i10.id]);
  let nd = dialogs.length, b8 = geminiBodies.length;
  page.__dismiss = true;
  await runAndWait('#gr-llm');
  check('예전 AI 등급 문제가 있으면 먼저 묻고, 취소하면 그 문제들은 건너뜀', dialogs.slice(nd).some((m) => m.includes('예전 방식으로 AI 등급만 받은 문제가 3개')) && geminiBodies.length === b8 && (await item(8)).gradeLLM === 2, JSON.stringify(dialogs.slice(nd)).slice(0, 120));
  hold = new Promise((r) => { open = r; });
  const e8 = await ends(); b8 = geminiBodies.length;
  await page.click('#gr-llm');
  for (let t0 = Date.now(); Date.now() - t0 < 10000 && geminiBodies.length === b8;) await sleep(100);
  const newCrop = await page.evaluate(async ({ id10, id11 }) => {
    const other = (await M.db.get('items', id11)).image; // 1-10의 영역을 고쳐 다른 자르기가 된 것처럼
    await M.db.update('items', id10, (f) => { f.image = other; f.imageId = 'recut-before-its-turn'; });
    return (await M.assets.asDataURL(other)).split(',')[1];
  }, { id10: i10.id, id11: i11.id });
  open();
  await page.waitForFunction((k) => (document.querySelector('#gr-log').textContent.match(/AI 판정 끝/g) || []).length > k, e8, { timeout: 30000 });
  const sent10 = geminiBodies[b8 + 2]?.contents?.[0]?.parts?.find((p) => p.inline_data)?.inline_data?.data;
  const g10 = await item(10);
  check('확인하면 예전 AI 등급 3문제를 판정, 차례가 오기 전에 고친 영역은 새 자르기로 보내 저장', geminiBodies.length - b8 === 3 && sent10 === newCrop && !!g10.aiExtract && g10.difficultyLLM === 3 && !(await log()).includes('1-10번: 판정하는 사이'),
    `요청 ${geminiBodies.length - b8}회 · 새 자르기 전송 ${sent10 === newCrop}`);
  nd = dialogs.length; b8 = geminiBodies.length;
  page.__dismiss = true;
  await page.click('#gr-llm-all'); await sleep(800);
  check('"전체 다시"는 문제 수를 알려 주고 묻는다 (취소하면 요청 없음)', dialogs.slice(nd).some((m) => m.includes('문제 12개를 모두 다시 AI로 판정')) && geminiBodies.length === b8 && (await log()).includes('AI 판정을 시작하지 않았습니다'));

  // ── 9) 다시 분리: 영역이 그대로인 문제는 AI 결과 유지, 바뀐 문제(이어붙였던 1-6)는 '다시 판정 필요'
  await toReview();
  const oldIds = await page.evaluate(async (b) => (await M.db.byBook('items', b)).filter((i) => i.kind === 'problem').map((i) => i.id), bookId);
  await page.click('#rv-reseg');
  for (let t0 = Date.now(); Date.now() - t0 < 30000;) { // 새 항목으로 바뀌고 버튼이 다시 켜질 때까지
    const s = await page.evaluate(async ({ b, old }) => ({ fresh: (await M.db.byBook('items', b)).filter((i) => i.kind === 'problem' && !old.includes(i.id)).length, busy: document.querySelector('#rv-reseg').disabled }), { b: bookId, old: oldIds });
    if (s.fresh === 12 && !s.busy) break;
    await sleep(200);
  }
  await sleep(300);
  const after = await page.evaluate(async (b) => (await M.db.byBook('items', b)).filter((i) => i.kind === 'problem').map((i) => [i.number, !!i.aiExtract, !!i.aiExtract?.stale, i.difficultyLLM ?? null]), bookId);
  const kept = after.filter(([n, has, stale]) => has && !stale && n !== 6).length, six = after.find(([n]) => n === 6);
  check('다시 분리 뒤: 같은 영역 11문제는 AI 결과 그대로, 영역이 바뀐 1-6은 다시 판정 필요 (난이도 유지)', kept === 11 && six[1] && six[2] && six[3] === 3, JSON.stringify(after));

  // ── 10) 정답 직접 입력 (AI는 더 이상 정답을 채우지 않으므로): 저장하면 직접 입력으로, 비우면 해설의 정답으로 돌아감
  await card('1-1').locator('button', { hasText: '원본에서 보기·수정' }).click(); await sleep(800);
  const fromSolution = (await item(1)).answer;
  await page.locator('#rv-side input[aria-label="정답 직접 입력"]').fill('④');
  await page.locator('#rv-side button', { hasText: '정답 저장' }).click(); await sleep(600);
  const a1 = await item(1);
  const sideText = await page.textContent('#rv-side');
  await page.locator('#rv-side input[aria-label="정답 직접 입력"]').fill('');
  await page.locator('#rv-side button', { hasText: '정답 저장' }).click(); await sleep(800);
  const a2 = await item(1);
  check('정답 직접 입력: 저장·표시, 비우면 해설에서 읽은 정답으로', a1.answer === '④' && a1.answerManual === true && sideText.includes('직접 입력') && a2.answerManual === false && a2.answer === fromSolution && fromSolution === '②', JSON.stringify([fromSolution, a1.answer, a2.answer]));

  // ── 11) 다른 제공자: 시스템 프롬프트 자리와 응답 형식
  await toGrade();
  for (const prov of ['anthropic', 'openai', 'ollama']) {
    await page.selectOption('#gr-provider', prov);
    await page.fill('#gr-key', prov === 'ollama' ? '' : 'test-key'); await page.dispatchEvent('#gr-key', 'change');
    await runAndWait('#gr-test');
  }
  const a = other.anthropic, o = other.openai, ol = other.ollama;
  check('Claude: system 필드 = 지정 프롬프트, max_tokens 4096, temperature 0, 이미지 다음 글, 코드 블록 응답도 저장', a && a.body.system === SYSTEM && a.body.max_tokens === 4096 && a.body.temperature === 0 && a.body.messages[0].content[0].type === 'image' && a.body.messages[0].content[1].type === 'text' && a.headers['x-api-key'] === 'test-key'
    && (await log()).includes('문제: claude: $\\sqrt{3}$'));
  check('OpenAI: 첫 메시지 system = 지정 프롬프트, JSON 모드, temperature 0 (gpt-4o-mini)', o && o.body.messages[0].role === 'system' && o.body.messages[0].content === SYSTEM && o.body.response_format.type === 'json_object' && o.body.temperature === 0 && o.body.messages[1].content[0].type === 'image_url' && (await log()).includes('문제: openai:'));
  check('Ollama: system 메시지 = 지정 프롬프트, 이미지 첨부, temperature 0', ol && ol.body.messages[0].role === 'system' && ol.body.messages[0].content === SYSTEM && ol.body.messages[1].images.length === 1 && ol.body.options.temperature === 0 && (await log()).includes('문제: ollama:'));
  const last = await item(1);
  check('제공자·모델을 결과와 함께 기록', last.aiExtract.provider === 'ollama' && last.aiExtract.model === 'qwen2.5vl:7b' && last.difficultyLLM === 4 && last.gradeLLM === 3, JSON.stringify([last.aiExtract.provider, last.aiExtract.model]));

  // ── 12) 이미지가 빠진 백업을 가져올 때: AI 판정 결과(글·난이도·등급·유형·단원·과목)는 라이브러리의 자르기와 한 묶음으로
  await page.click('#tabs button[data-tab=library]'); await sleep(300);
  const [bk] = await Promise.all([page.waitForEvent('download'), page.click('#lib-export')]);
  const bkPath = path.join(__dirname, 'ai-backup.jsonl'); await bk.saveAs(bkPath);
  const [n2, n3] = [await item(2), await item(3)];
  const lines = fs.readFileSync(bkPath, 'utf8').trim().split('\n').map((l, i) => {
    if (!i) return l;
    const r = JSON.parse(l);
    if (r.s === 'books') return l;
    r.v.image = null; // 폴더 권한이 없을 때 만든 백업처럼
    if (r.v.id === n2.id) { r.v.aiExtract = { ...r.v.aiExtract, problems: [{ ...r.v.aiExtract.problems[0], question: '백업 속 옛 글' }] }; r.v.gradeLLM = 9; r.v.difficultyLLM = 1; }
    if (r.v.id === n3.id) { r.v.fragments = r.v.fragments.map((f) => ({ ...f, y1: f.y1 + 50 })); r.v.gradeLLM = 9; r.v.difficultyLLM = 1; }
    return JSON.stringify(r);
  });
  const partialPath = path.join(__dirname, 'ai-backup-partial.jsonl'); fs.writeFileSync(partialPath, lines.join('\n') + '\n');
  await page.evaluate(async (id) => { await M.db.update('items', id, (f) => { delete f.aiExtract; }); }, n3.id);
  nd = dialogs.length;
  await page.setInputFiles('#lib-import', partialPath);
  for (let t0 = Date.now(); Date.now() - t0 < 15000 && !dialogs.slice(nd).some((m) => m.startsWith('가져오기')); ) await sleep(200);
  const [m2, m3] = [await item(2), await item(3)];
  check('라이브러리 자르기의 AI 결과는 묶음째 유지 (글과 등급이 섞이지 않음)', m2.aiExtract.problems[0].question === '둘째 문제' && m2.gradeLLM === n2.gradeLLM && m2.difficultyLLM === n2.difficultyLLM && m2.image != null,
    JSON.stringify([m2.aiExtract.problems[0].question, m2.gradeLLM, m2.difficultyLLM]));
  check('라이브러리에 AI 결과가 없으면 백업 것을 묶음째 쓰고, 영역이 다르면 "다시 판정 필요"', m3.aiExtract?.stale === true && m3.gradeLLM === 9 && m3.difficultyLLM === 1 && JSON.stringify(m3.fragments) === JSON.stringify(n3.fragments),
    JSON.stringify([m3.aiExtract?.stale, m3.gradeLLM, m3.difficultyLLM]));

  check('AI 판정 흐름 JS 오류 없음', errors.length === 0, errors.join(' | '));
  await context.close(); await browser.close(); server.close();
  console.log(`\n${pass}/${pass + fail} 통과`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
