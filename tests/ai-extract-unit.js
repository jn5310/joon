// AI 판정(비전 OCR) 단위 테스트 (Node, 저장소 외부): 시스템 프롬프트 문구, 제공자별 요청 모양, 응답 JSON·LaTeX 읽기,
// 1~5단계 → 등급 환산, 단원 유형 → 과목·표준 유형, 내보내기 모양
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {}, console, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout };
ctx.window.window = ctx.window; vm.createContext(ctx);
for (const f of ['part1.js', 'part2.js']) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const L = ctx.window.M.llm;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tryParse = (text) => { try { return L.parseAnalysis(text); } catch (e) { return { error: e.message, bad: !!e.badResponse }; } };

// ── 1) 시스템 프롬프트: 사용자가 준 문구 그대로 (오타 "추출할 * 것"의 * 하나만 뺌)
const fixture = fs.readFileSync(path.join(__dirname, 'ocr-system-prompt.txt'), 'utf8');
check('시스템 프롬프트가 지정 문구와 글자 하나까지 같음', L.OCR_SYSTEM_PROMPT === fixture, `${L.OCR_SYSTEM_PROMPT.length} / ${fixture.length}자`);
check('프롬프트 핵심 문구 (LaTeX 구분자·[미상]·JSON 항목)', ['`$ ... $`', '`$$ ... $$`', '\\frac{a}{b}', '\\lim_{x \\to \\infty}', '\\text{[미상]}', '"difficulty_level": 2', '"has_figure_or_diagram": false', '1단계(매우 쉬움 / 단순 계산)'].every((s) => L.OCR_SYSTEM_PROMPT.includes(s)) && !L.OCR_SYSTEM_PROMPT.includes('* 것'));

// ── 2) 제공자별 요청: 시스템 프롬프트는 시스템 자리에, 이미지는 문제 1장, 과목 참고는 사용자 메시지에
const img = [{ data: 'AAAA', mime: 'image/png' }];
const user = L.buildUserText('수학I');
const body = (p, extra = {}) => { const r = L.buildRequest({ provider: p, apiKey: 'k', model: 'm', ...extra }, L.OCR_SYSTEM_PROMPT, user, img); return { url: r.url, headers: r.init.headers, b: JSON.parse(r.init.body) }; };
{
  const { url, headers, b } = body('anthropic');
  check('Anthropic: system 필드 = 프롬프트, 이미지 1장 + 사용자 글, max_tokens 4096, temperature 0', url.endsWith('/v1/messages') && b.system === fixture && b.max_tokens === 4096 && b.temperature === 0
    && b.messages.length === 1 && b.messages[0].content[0].type === 'image' && b.messages[0].content[1].text === user && headers['x-api-key'] === 'k', JSON.stringify({ max: b.max_tokens, n: b.messages[0].content.length }));
}
{
  const { b, headers } = body('openai', { model: 'gpt-4o-mini' });
  check('OpenAI: 첫 메시지가 system 프롬프트, JSON 모드, 사용자 메시지에 이미지, GPT-4 계열은 temperature 0', b.messages[0].role === 'system' && b.messages[0].content === fixture && b.response_format.type === 'json_object'
    && b.messages[1].content[0].image_url.url === 'data:image/png;base64,AAAA' && b.messages[1].content[1].text === user && headers.authorization === 'Bearer k' && b.temperature === 0);
  check('OpenAI 추론 모델(o4-mini·gpt-5)에는 temperature를 보내지 않음', !('temperature' in body('openai', { model: 'o4-mini' }).b) && !('temperature' in body('openai', { model: 'gpt-5' }).b));
}
{
  const { url, b } = body('gemini');
  check('Gemini: systemInstruction = 프롬프트, 이미지 다음 글, JSON 응답', url.includes('models/m:generateContent?key=k') && b.systemInstruction.parts[0].text === fixture
    && b.contents[0].parts[0].inline_data.mime_type === 'image/png' && b.contents[0].parts[1].text === user && b.generationConfig.responseMimeType === 'application/json');
}
{
  const { url, b } = body('ollama', { baseUrl: 'http://pc:11434/' });
  check('Ollama: system 메시지 + 이미지 붙은 사용자 메시지, JSON 형식, temperature 0', url === 'http://pc:11434/api/chat' && b.messages[0].role === 'system' && b.messages[0].content === fixture
    && b.messages[1].images[0] === 'AAAA' && b.format === 'json' && b.stream === false && b.options.temperature === 0);
}
check('사용자 메시지에 책 과목 참고, 과목을 모르면 topic 앞에 과목을 붙여 달라고 함', user.includes('이 책의 과목은 "수학I"') && !L.buildUserText('').includes('이 책의 과목은') && L.buildUserText('').includes('topic 앞에 "수학 II - 미분계수와 도함수"처럼 과목을'));

// ── 3) 응답 읽기
const ok = { problems: [{ problem_number: '01', passage: null, question: '함수 $f(x) = x^2 + 3x$에 대하여 $f\'(2)$의 값을 구하시오.', choices: ['① $5$', '② $7$', '③ $9$', '④ $11$', '⑤ $13$'], has_figure_or_diagram: false, topic: '미분 - 도함수', difficulty_level: 2, difficulty_reasoning: '단순 유형임.' }] };
{
  const r = tryParse(JSON.stringify(ok));
  check('올바른 JSON 그대로 읽음 (항목 8개·값 그대로)', same(r, ok.problems), JSON.stringify(r).slice(0, 120));
  const fenced = tryParse('다음은 결과입니다.\n```json\n' + JSON.stringify(ok, null, 2) + '\n```\n끝.');
  check('```json 코드 블록과 앞뒤 설명이 붙어도 읽음', same(fenced, ok.problems));
}
{
  // 역슬래시를 하나만 쓴 LaTeX (JSON에서 허용되지 않는 \s \l \i 등이 섞여 파싱이 실패하는 경우)
  const Q = String.raw`$\frac{1}{2} + \sqrt{3}$의 값은? $\lim_{x \to \infty} \left( 1 + \frac{1}{x} \right)^x$, $a \neq b$, $2 \times 3$, $\beta + \theta$, \text{[미상]}`;
  const raw = String.raw`{"problems":[{"problem_number":"03","passage":null,"question":"` + Q + String.raw`","choices":["① $\frac{1}{2}$","② $\sqrt{2}$"],"has_figure_or_diagram":"true","topic":"수학 II - 함수의 연속","difficulty_level":"4","difficulty_reasoning":"근거"}]}`;
  const r = tryParse(raw);
  check('역슬래시 하나짜리 LaTeX 복구 (\\frac \\sqrt \\lim \\to \\infty \\left \\right \\neq \\times \\beta \\theta \\text)', r[0]?.question === Q && same(r[0]?.choices, [String.raw`① $\frac{1}{2}$`, String.raw`② $\sqrt{2}$`]), JSON.stringify(r[0]?.question));
  check('문자열 "true"·"4"도 값으로 읽음', r[0]?.has_figure_or_diagram === true && r[0]?.difficulty_level === 4);
}
for (const [label, q] of [
  ['\\frac (폼피드로 바뀜)', String.raw`$\frac{a}{b}$의 값은?`],
  ['\\text·\\times·\\to (탭으로 바뀜)', String.raw`$2 \times 3 \to \text{[미상]}$`],
  ['\\beta·\\binom (백스페이스로 바뀜)', String.raw`$\beta + \binom{5}{2}$`],
  ['\\neq·\\ne (줄바꿈으로 바뀜)', String.raw`$a \neq b$, $c \ne d$`],
  ['\\right·\\rho (CR로 바뀜)', String.raw`$\rho = 1$, $f(x) \rightarrow 2$`],
]) {
  // JSON.parse는 성공하지만 LaTeX가 제어 문자로 조용히 깨지는 경우
  const raw = `{"problems":[{"question":"${q}","choices":[],"difficulty_level":3}]}`;
  let strictOk = true; try { JSON.parse(raw); } catch { strictOk = false; }
  const r = tryParse(raw);
  check(`올바른 JSON이지만 깨진 LaTeX 복구: ${label}`, strictOk && r[0]?.question === q, JSON.stringify(r[0]?.question));
}
{
  const good = { problems: [{ question: '첫째 줄\n$x^2 + 1$은\n(단, $x > 0$)\n\\text{[미상]} $\\frac{1}{2}$', choices: [], difficulty_level: 1 }] };
  const r = tryParse(JSON.stringify(good));
  check('제대로 이스케이프된 JSON의 진짜 줄바꿈과 \\\\frac는 그대로', r[0]?.question === good.problems[0].question, JSON.stringify(r[0]?.question));
  const mixed = String.raw`{"problems":[{"question":"첫째 줄\n$\frac{1}{2}$ 둘째 줄\n(단, $x>0$)","difficulty_level":2}]}`;
  const m = tryParse(mixed);
  check('깨진 LaTeX와 진짜 줄바꿈이 섞여도 줄바꿈은 줄바꿈으로', m[0]?.question === '첫째 줄\n' + String.raw`$\frac{1}{2}$` + ' 둘째 줄\n(단, $x>0$)', JSON.stringify(m[0]?.question));
  const rawNewline = '{"problems":[{"question":"첫째 줄\n둘째 줄 $\\\\sqrt{2}$","difficulty_level":2}]}';
  check('문자열 안에 그대로 들어간 줄바꿈도 읽음', tryParse(rawNewline)[0]?.question === '첫째 줄\n둘째 줄 $\\sqrt{2}$', JSON.stringify(tryParse(rawNewline)));
}
{
  const bare = tryParse(JSON.stringify(ok.problems[0]));
  check('problems 없이 문제 하나만 와도 읽음', same(bare, ok.problems));
  const obj = tryParse(JSON.stringify({ problems: ok.problems[0] }));
  check('problems가 배열이 아닌 객체여도 읽음', same(obj, ok.problems));
  const str = tryParse(JSON.stringify({ problems: [{ ...ok.problems[0], choices: '① $5$ ② $7$ ③ $9$' }] }));
  check('선지가 한 줄 글로 와도 번호별로 나눔', same(str[0]?.choices, ['① $5$', '② $7$', '③ $9$']), JSON.stringify(str[0]?.choices));
  const odd = tryParse(JSON.stringify({ problems: [{ ...ok.problems[0], passage: '공통 지문이 있는 경우 여기에 작성, 없으면 null', problem_number: 'null', difficulty_level: 7 }] }));
  check('예시 문구를 베낀 지문·"null" 글자는 null, 범위 밖 난이도는 null', odd[0]?.passage === null && odd[0]?.problem_number === null && odd[0]?.difficulty_level === null);
  const nothing = tryParse('죄송합니다. 이미지를 읽을 수 없습니다.');
  const cut = tryParse('{"problems":[{"question":"$\\\\frac{1}{');
  const empty = tryParse('{"problems":[]}');
  check('JSON이 없거나 잘리거나 문제가 없으면 "다시 시도할 만한 응답 오류"', nothing.error && nothing.bad && cut.error && cut.bad && empty.error && empty.bad, [nothing.error, cut.error, empty.error].map((x) => String(x).slice(0, 30)).join(' | '));
  check('JSON 추출: 문자열 안 괄호는 세지 않고 뒤 설명은 버림', L.extractJsonObject('앞 {"a":"} {","b":{"c":1}} 뒤 {x}') === '{"a":"} {","b":{"c":1}}');
}
{
  const two = L.parseAnalysis(JSON.stringify({ problems: [{ problem_number: '06', question: 'a', difficulty_level: 2 }, { problem_number: '07.', question: 'b', difficulty_level: 5 }] }));
  check('한 영역에서 문제 두 개: 이 항목 번호(7)와 같은 문제를 고름, 없으면 첫 문제', L.primaryIndex(two, { number: 7 }) === 1 && L.primaryIndex(two, { number: 9 }) === 0);
  check('번호 읽기: "01." "12번" "유제 1-2" "[미상]"', L.numberOf('01.') === 1 && L.numberOf('12번') === 12 && L.numberOf('유제 1-2') === 2 && L.numberOf('\\text{[미상]}') === null);
}

// ── 3-2) 5차 리뷰: 올바르게 쓴 줄바꿈은 건드리지 않고, 문자열마다 따로 고친다. 행렬·연립의 \\ 줄바꿈과 빠졌던 명령도 복구
for (const [label, question] of [
  ['$$ 블록 첫 줄이 e^로 시작', '방정식\n$$\ne^{2x} - 3e^{x} + 2 = 0\n$$\n의 모든 실근의 합은?'],
  ['$$ 블록 첫 줄이 i^로 시작', '다음 식의 값은?\n$$\ni^{2} + i^{4} + i^{6}\n$$'],
  ['줄 첫머리 "e는" (글)', '양수 $a$에 대하여 $\\ln a = 2$일 때 $a$의 값은?\ne는 자연로그의 밑이다.'],
  ['행렬 줄바꿈 뒤 새 줄이 i로 시작', '$$\\begin{aligned} a &= 1 \\\\\ni &= 2 \\end{aligned}$$'],
]) {
  const r = tryParse(JSON.stringify({ problems: [{ question, choices: [], difficulty_level: 3 }] }));
  check(`올바르게 쓴 JSON은 그대로: ${label}`, r[0]?.question === question, JSON.stringify(r[0]?.question));
}
{
  const question = '다음 식의 값은?\n$$\ni^{2} + i^{3}\n$$';
  const raw = '{"problems":[{"question":' + JSON.stringify(question) + ',"choices":["① $\\frac{1}{2}$"],"difficulty_level":2}]}';
  const r = tryParse(raw);
  check('다른 칸(선지)의 깨진 \\frac를 고쳐도 올바른 문제 글의 줄바꿈은 그대로', r[0]?.question === question && r[0]?.choices[0] === '① $\\frac{1}{2}$', JSON.stringify(r[0]));
}
for (const [label, latex] of [
  ['cases의 \\\\ 줄바꿈', String.raw`$f(x) = \begin{cases} x^2 & (x \ge 0) \\ -x & (x < 0) \end{cases}$`],
  ['pmatrix의 \\\\ 줄바꿈', String.raw`$A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}$`],
  ['\\rvert', String.raw`$\lvert \vec{a} \rvert = 3$`],
  ['\\nsubseteq', String.raw`$A \nsubseteq B$`],
  ['\\not=', String.raw`$a \not= b$`],
  ['\\textstyle', String.raw`$\textstyle\sum_{k=1}^{n} k$`],
  ['\\nu', String.raw`$\nu = 2$`],
  ['\\$ (달러 글자) 뒤 수식', String.raw`$\$5$와 $\frac{1}{2}$`],
]) {
  const r = tryParse(`{"problems":[{"question":"${latex}","choices":[],"difficulty_level":3}]}`);
  check(`역슬래시 하나짜리 LaTeX 복구: ${label}`, r[0]?.question === latex, JSON.stringify(r[0]?.question));
}
{
  const good = { problems: [{ question: '$f(x) = \\begin{cases} x^2 & (x \\ge 0) \\\\ -x & (x < 0) \\end{cases}$', choices: [], difficulty_level: 3 }] };
  check('올바르게 쓴 cases 줄바꿈(\\\\)은 그대로', tryParse(JSON.stringify(good))[0]?.question === good.problems[0].question);
  const lost = { problems: [{ question: '$\\begin{pmatrix} 1 & 2 \\ 3 & 4 \\end{pmatrix}$', choices: [], difficulty_level: 3 }] }; // JSON 모드에서 \\\\ 대신 \\ 만 쓴 경우
  check('JSON 모드에서 줄어든 행렬 줄바꿈도 \\\\로 되돌림', tryParse(JSON.stringify(lost))[0]?.question === '$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$', tryParse(JSON.stringify(lost))[0]?.question);
  const lv = ['3단계', '4 (어려움)', ' 5 ', '12'].map((v) => tryParse(JSON.stringify({ problems: [{ question: 'q', difficulty_level: v }] }))[0]?.difficulty_level);
  check('난이도가 "3단계"·"4 (어려움)"처럼 글로 와도 앞 숫자를 읽음 (범위 밖은 없음)', same(lv, [3, 4, 5, null]), JSON.stringify(lv));
}

// ── 3-3) 6차 리뷰: 줄바꿈 \\ 바로 뒤의 새 줄, LaTeX 띄어쓰기 "\ ", 붙여 쓴 줄바꿈, $$ 안의 한 글자·여러 글자 명령
for (const [label, question] of [
  ['인라인 cases: 줄바꿈 뒤 새 줄이 e^{x}', '$f(x) = \\begin{cases} x + 1 & (x < 0) \\\\\ne^{x} & (x \\ge 0) \\end{cases}$'],
  ['인라인 cases: 줄바꿈 뒤 새 줄이 i', '$z = \\begin{cases} 1 & (n = 0) \\\\\ni & (n = 1) \\end{cases}$'],
  ['cases 안의 "\\ " 띄어쓰기 (제대로 쓴 \\\\ 가 있음)', '$f(x) = \\begin{cases} x^2 \\ (x \\ge 0) \\\\ -x \\ (x < 0) \\end{cases}$'],
  ['aligned 안의 "\\ \\ " 두 칸 띄어쓰기', '$$\\begin{aligned} f(x) &= x^2 + 1 \\ \\ (x > 0) \\end{aligned}$$'],
  ['cases 안 \\text{if} 뒤 띄어쓰기', '$\\begin{cases} 1 & \\text{if}\\ x > 0 \\end{cases}$'],
]) {
  const r = tryParse(JSON.stringify({ problems: [{ question, choices: [], difficulty_level: 3 }] }));
  check(`올바르게 쓴 JSON은 그대로: ${label}`, r[0]?.question === question, JSON.stringify(r[0]?.question));
}
for (const [label, rawLatex, meant] of [
  ['붙여 쓴 행렬 줄바꿈 1&2\\\\3&4', String.raw`$A = \begin{pmatrix}1&2\\3&4\end{pmatrix}$`, null],
  ['앞에 띄어쓰기 없는 cases 줄바꿈 (x \\ge 0)\\\\ -x', String.raw`$f(x) = \begin{cases} x^2 & (x \ge 0)\\ -x & (x < 0) \end{cases}$`, null],
  ['$$ 안의 \\neq (다른 역슬래시 없음)', String.raw`$$x \neq 0$$`, null],
  ['$$ 첫머리의 \\neg', String.raw`$$\neg p \lor q$$`, null],
  ['$$ 안 줄바꿈 뒤 새 줄이 u(x)', String.raw`$$\frac{1}{2}f(x) = 1\nu(x) = 2$$`, '$$\\frac{1}{2}f(x) = 1\nu(x) = 2$$'],
  ['$$ 안 띄어 쓴 \\ne', String.raw`$$\frac{1}{2} \ne 0$$`, null],
  ['인라인 \\sum\\nolimits_ (뒤에 _가 와도 여러 글자 명령)', String.raw`$\sum\nolimits_{k=1}^{n} k$`, null],
  ['인라인 \\nabla^{2}', String.raw`$\nabla^{2} f$`, null],
  ['} 바로 뒤의 cases 줄바꿈 x^{2}\\\\ g(x)', String.raw`$\begin{cases} x^{2}\\ g(x) \end{cases}$`, null],
  ['분수 뒤 행렬 줄바꿈', String.raw`$\begin{pmatrix} -\frac{\sqrt{3}}{2}\\ \frac{\sqrt{3}}{2} \end{pmatrix}$`, null],
]) {
  const r = tryParse(`{"problems":[{"question":"${rawLatex}","choices":[],"difficulty_level":3}]}`);
  check(`역슬래시 하나짜리 LaTeX: ${label}`, r[0]?.question === (meant ?? rawLatex), JSON.stringify(r[0]?.question));
}
for (const [label, question] of [
  ['한 줄 aligned의 x^{2}\\ (x > 0) 띄어쓰기', '$$\\begin{aligned} f(x) &= x^{2}\\ (x > 0) \\end{aligned}$$'],
  ['한 줄 aligned의 \\frac{1}{x}\\ (x \\neq 0) 띄어쓰기', '$$\\begin{aligned} g(x) &= \\frac{1}{x}\\ (x \\neq 0) \\end{aligned}$$'],
  ['한 줄 aligned의 x^{2} \\ (x > 0) 띄어쓰기', '$$\\begin{aligned} f(x) &= x^{2} \\ (x > 0) \\end{aligned}$$'],
]) {
  const r = tryParse(JSON.stringify({ problems: [{ question, choices: [], difficulty_level: 3 }] }));
  check(`올바르게 쓴 JSON은 그대로: ${label}`, r[0]?.question === question, JSON.stringify(r[0]?.question));
}

// ── 4) 난이도 1~5단계 → 이 앱의 1~9등급 (1등급이 가장 어려움)
check('난이도 환산: 1→9, 2→7, 3→5, 4→3, 5→1등급, 그 밖은 없음', same([1, 2, 3, 4, 5].map(L.levelToGrade), [9, 7, 5, 3, 1]) && L.levelToGrade(0) === null && L.levelToGrade(null) === null && L.levelToGrade(2.5) === null);
{
  // 시험지 고르기: AI 5단계 등급(1·3·5·7·9)은 ±1 폭으로 목표에 맞춘다 → 짝수 목표에도 AI 문제가 목표 칸에 들어간다
  const S = ctx.window.M.select;
  const ai = [], rule = [];
  for (let i = 0; i < 500; i++) { const lvl = 1 + (i % 5); ai.push({ id: 'a' + i, bookId: 'A', section: 1, number: i + 1, image: 'x', difficultyLLM: lvl, gradeLLM: L.levelToGrade(lvl) }); }
  for (let i = 0; i < 200; i++) rule.push({ id: 'h' + i, bookId: 'B', section: 1, number: i + 1, image: 'x', gradeHeur: 1 + (i % 9) });
  const gOf = (p) => p.gradeManual ?? p.gradeLLM ?? p.gradeHeur;
  const onlyAi = [2, 4, 6, 8].map((t) => { const r = S.selectProblems(ai, { target: t, count: 20, mix: S.MIX_PRESETS.focus, seed: 7 }); return r.problems.filter((p) => S.gradeDistance(p, t) === 0).length; });
  check('AI 등급만 있는 책도 짝수 목표(2·4·6·8)의 목표 칸을 채움 (목표 집중 20문제 중 16개 이상, 더 쉬운·어려운 칸이 모자라면 가까운 문제로)', onlyAi.every((n) => n >= 16), JSON.stringify(onlyAi));
  const mixed = S.selectProblems([...ai, ...rule], { target: 4, count: 20, mix: S.MIX_PRESETS.focus, seed: 7 }).problems;
  const aiAtTarget = mixed.filter((p) => p.difficultyLLM != null && S.gradeDistance(p, 4) === 0).length;
  check('AI 책 + 규칙 판정 책을 섞어도 목표 칸에 AI 문제가 들어감', aiAtTarget >= 8 && mixed.length === 20, `${aiAtTarget}개 · ${mixed.map(gOf).join(',')}`);
  check('직접 지정·예전 AI 등급(단계 없음)은 그 등급 그대로 거리', S.gradeDistance({ gradeManual: 3, gradeLLM: 3, difficultyLLM: 4 }, 4) === 1 && S.gradeDistance({ gradeLLM: 3 }, 4) === 1 && S.gradeDistance({ gradeLLM: 3, difficultyLLM: 4 }, 4) === 0 && S.gradeDistance({ gradeLLM: 1, difficultyLLM: 5 }, 4) === 2);
}

// ── 5) 단원 유형 → 과목·표준 유형
const subj = [['수학 II - 미분계수와 도함수', '수학II'], ['수학Ⅰ - 지수함수', '수학I'], ['수학 1 - 등차수열', '수학I'], ['수학2 - 정적분', '수학II'], ['미적분 - 여러 가지 적분법', '미적분'],
  ['미적분 Ⅰ - 수열의 극한', '미적분I'], ['확률과 통계 - 조건부확률', '확률과 통계'], ['공통수학 1 - 나머지정리', '공통수학1'], ['수학(상) - 판별식', '수학(상)'], ['다항식의 연산', null], ['기하 - 벡터', '기하'],
  ['공통수학Ⅰ - 다항식의 연산', '공통수학1'], ['공통수학 II - 도형의 방정식', '공통수학2']];
const sr = subj.map(([t]) => L.subjectFromTopic(t));
check('단원 유형 앞머리에서 과목 찾기 (Ⅰ·Ⅱ·1·2·띄어쓰기·괄호)', same(sr, subj.map((x) => x[1])), JSON.stringify(sr));
const types = [
  [{ topic: '수학 II - 미분계수와 도함수' }, '수학II', '다항함수의 미분'],
  [{ topic: '다항식의 연산' }, '', '다항식'],
  [{ topic: '수학 II - 함수의 연속' }, '수학II', '함수의 극한과 연속'],
  [{ topic: '미적분 - 여러 가지 적분법' }, '미적분', '여러 가지 함수의 적분'],
  [{ topic: '확률과 통계 - 조건부확률' }, '확률과 통계', '확률'],
  [{ topic: '기타', question: String.raw`$\int_{0}^{1} (3x^2 + 1)\,dx$의 값은?` }, '수학II', '다항함수의 적분'],
  [{ topic: null, question: String.raw`$\displaystyle\sum_{k=1}^{10} (2k+1)$의 값은?` }, '수학I', '수열'],
];
const tr = types.map(([p, s]) => L.typeFromAnalysis(p, s));
check('단원 유형 → 표준 유형 (단원 부분 → 전체 → 문제 글의 LaTeX 기호 순)', same(tr, types.map((x) => x[2])), JSON.stringify(tr));
const plain = L.latexToPlain(String.raw`$\lim_{x \to \infty} \frac{\sqrt{x}}{x}$, $\int_0^1$, $\sum$, \text{[미상]}`);
check('LaTeX → 분류용 글 (∫ Σ → ∞ √ 중첩 분수 · \\text)', plain === 'lim_x → ∞ (√(x))/(x), ∫_0^1, Σ, [미상]', plain);

// ── 6) 내보내기 모양과 응답 부가 정보
const exp = L.toSchemaJson([{ question: 'q', choices: ['① 1'], difficulty_level: 3, topic: 't', extra: 1 }]);
check('내보내기: {"problems":[…]}, 항목 8개를 지정 순서로 (다른 값은 빼고)', same(Object.keys(exp), ['problems']) && same(Object.keys(exp.problems[0]), L.PROBLEM_KEYS)
  && same(L.PROBLEM_KEYS, ['problem_number', 'passage', 'question', 'choices', 'has_figure_or_diagram', 'topic', 'difficulty_level', 'difficulty_reasoning']) && exp.problems[0].passage === null && exp.problems[0].has_figure_or_diagram === false);
check('응답 글 꺼내기 (Gemini 생각 부분 제외 · Claude · OpenAI · Ollama)', L.responseText('gemini', { candidates: [{ content: { parts: [{ text: 'x', thought: true }, { text: '{"a":1}' }] } }] }) === '{"a":1}'
  && L.responseText('anthropic', { content: [{ type: 'text', text: 'A' }] }) === 'A' && L.responseText('openai', { choices: [{ message: { content: 'O' } }] }) === 'O' && L.responseText('ollama', { message: { content: 'L' } }) === 'L');
check('비정상 종료 이유 알림 (RECITATION·잘림), 정상이면 없음', L.stopNote('gemini', { candidates: [{ finishReason: 'RECITATION' }] }).startsWith('RECITATION: 교재 원문')
  && L.stopNote('anthropic', { stop_reason: 'max_tokens' }).includes('잘렸') && L.stopNote('openai', { choices: [{ finish_reason: 'length' }] }).includes('잘렸') && L.stopNote('gemini', { candidates: [{ finishReason: 'STOP' }] }) === '' && L.stopNote('anthropic', { stop_reason: 'end_turn' }) === '');

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
