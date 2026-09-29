// 2차 리뷰 회귀 테스트: 본문 숫자·예제/유제·추정 번호 앞지름·단원 끝 그림/선택지·개념 쪽·제목 이어붙이기·선택지 경계·해설 연결·텍스트층 우선 병합 (Node, 저장소 외부)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {}, console }; ctx.window.window = ctx.window; vm.createContext(ctx);
for (const f of ['part1.js', 'part2.js']) vm.runInContext(fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const { layout: L, segment: S, ocr: O } = ctx.window.M;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const keys = (items) => items.map((x) => `${x.section}-${x.number}${x.detection.inferred ? '*' : ''}`).join(' ');

// ── 텍스트층 해설 쪽 (본문 줄이 들여쓰지 않은 해설 형식)
const LH = 22, STEP = 34, SCOLS = [{ x0: 90, x1: 575 }, { x0: 615, x1: 1100 }];
function solPage(index, cols) {
  const lines = [];
  cols.forEach((blocks, ci) => {
    const c = SCOLS[ci]; let y = 140;
    for (const b of blocks) {
      if (b.n != null) { const t = String(b.n).padStart(2, '0'); lines.push({ text: `${t} 정답 ③`, x0: c.x0, y0: y, x1: c.x0 + 200, y1: y + LH, firstWord: { text: t, x0: c.x0, y0: y, x1: c.x0 + 24, y1: y + LH } }); y += STEP; }
      for (const t of b.lines) { const fw = /^\d/.test(t) ? t.match(/^\d+/)[0] : t.split(/\s+/)[0]; lines.push({ text: t, x0: c.x0 + (b.indent || 0), y0: y, x1: c.x0 + 460, y1: y + LH, firstWord: { text: fw, x0: c.x0 + (b.indent || 0), y0: y, x1: c.x0 + 20, y1: y + LH } }); y += STEP; }
      y += 50;
    }
  });
  return { index, width: 1190, height: 1684, columns: SCOLS, lines, visualStarts: [], ocr: false };
}
const E = ['f(x)=x^2-4x+3에서', '따라서 구하는 값은 ③이다.'];
const seg = (pages) => S.segmentPages(pages, { top: 0.07, bottom: 0.06, continuation: true, maxSkip: 3 });
check('마지막 해설 안의 "2 이상의 자연수"로 새 단원을 만들지 않음', keys(seg([solPage(1, [[{ n: 1, lines: E }, { n: 2, lines: E }], [{ n: 3, lines: E }, { n: 4, lines: ['2 이상의 자연수 n에 대하여', ...E] }]])])) === '1-1 1-2 1-3 1-4');
check('해설 안의 "1 이상 3 이하인" / "2 개이므로" 두 줄로 쪼개지 않음', keys(seg([solPage(1, [[{ n: 1, lines: E }, { n: 2, lines: ['1 이상 3 이하인 정수는', '2 개이므로 조건을 만족', ...E] }], [{ n: 3, lines: E }, { n: 4, lines: E }]])])) === '1-1 1-2 1-3 1-4');
check('단원 끝 해설 안의 "3 이하의…" 뒤 실제 단원 재시작은 그대로', keys(seg([
  solPage(1, [[{ n: 1, lines: E }, { n: 2, lines: E }], [{ n: 3, lines: E }, { n: 4, lines: ['3 이하의 자연수 k에 대하여', ...E] }]]),
  solPage(2, [[{ n: 1, lines: E }, { n: 2, lines: E }], [{ n: 3, lines: E }, { n: 4, lines: E }]]),
])) === '1-1 1-2 1-3 1-4 2-1 2-2 2-3 2-4');
const q = (t) => { const a = S.parseAnchor({ text: t, firstWord: { text: t.split(' ')[0] } }); return a ? `${a.num}${a.quantity ? 'q' : ''}` : '-'; };
const parsed = [q('2 이상의 자연수'), q('3 개의 점'), q('12 이다.'), q('2 + 3 = 5'), q('3 점 P가'), q('7 원 x^2+y^2=4'), q('2 명제 p'), q('05 개수를 구하시오'), q('05 −2 ≤ x ≤ 3에서'), q('05 <보기>에서'), q('05 이 시험에서'), q('05 회사 A에서')].join();
check('수량·식 앞 숫자는 수량 표시, 문제 첫머리(점·원·명제·−2 ≤ x·<보기>·이·회사)는 일반 번호', parsed === '2q,3q,12q,2q,3,7,2,5,5,5,5,5', parsed);

// 예제/유제: 같은 번호라도 서로 다른 라벨이면 모두 남긴다
const lab = []; let ly = 140;
const addL = (t) => { lab.push({ text: t, x0: 90, y0: ly, x1: 500, y1: ly + 22, firstWord: { text: t.split(' ')[0], x0: 90, y0: ly, x1: 130, y1: ly + 22 } }); ly += 34; };
for (let k = 1; k <= 3; k++) { addL(`예제 ${k} 다음 식을 계산하시오.`); addL('식의 값을 구하시오.'); ly += 80; addL(`유제 ${k} 다음 식을 계산하시오.`); addL('식의 값을 구하시오.'); ly += 80; }
const labItems = seg([{ index: 1, width: 1190, height: 1684, columns: [{ x0: 90, x1: 575 }], lines: lab, visualStarts: [], ocr: false }]);
const labKeys = labItems.map((x) => S.itemKey(x));
check('예제 1~3 / 유제 1~3: 여섯 영역 보존, 라벨별 번호 (예제 1-1…, 유제 1-1…)', labKeys.join() === '예제 1-1,유제 1-1,예제 1-2,유제 1-2,예제 1-3,유제 1-3', labKeys.join());

// ── 여백 경계와 인식 번호의 관계 (OCR 스캔)
const line = (text, x, y) => ({ text, x0: x, y0: y, x1: x + 260, y1: y + 22, confidence: 90, source: 'ocr', firstWord: { text: text.split(' ')[0], x0: x, y0: y, x1: x + 26, y1: y + 22 } });
const vis = (y, inkX0 = 102) => ({ col: 0, y0: y, y1: y + 22, cutY: y - 10, h: 22, inkX0, source: 'visual', confidence: 0.6 });
const pg = (index, lines, starts) => ({ index, width: 700, height: 1000, columns: [{ x0: 100, x1: 600 }], ocr: true, visualStarts: starts, lines });
// 1쪽 1, 2쪽 번호 없음, 3쪽 3·4, 4쪽 5·6. 쪽마다 경계 3개(문제 시작 + 그림·선택지 앞 여백)
const overrun = [pg(1, [line('1. 문제', 102, 100)], [vis(100), vis(400, 180), vis(700)]), pg(2, [], [vis(100), vis(400, 180), vis(700)]),
  pg(3, [line('3. 문제', 102, 100), line('4. 문제', 102, 400)], [vis(100), vis(400), vis(700, 180)]), pg(4, [line('5. 문제', 102, 100), line('6. 문제', 102, 400)], [vis(100), vis(400), vis(700, 180)])];
const ov = seg(overrun);
check('추정 경계가 믿을 만한 인식 번호 run을 앞질러도 새 단원 없이 1~6 유지', keys(ov) === '1-1 1-2* 1-3 1-4 1-5 1-6', keys(ov));
const probs = ov.map((x, i) => ({ ...x, id: 'p' + i })), sols = [1, 2, 3, 4, 5, 6].map((n) => ({ id: 's' + n, section: 1, number: n }));
S.matchSolutions(probs, sols);
check('읽은 번호끼리 먼저 해설 연결, 추정 번호 연결은 확인 필요 표시', probs.map((p) => `${p.solutionId}${p.solutionInferred ? '?' : ''}`).join() === 's1,s2?,s3,s4,s5,s6', probs.map((p) => `${p.solutionId}${p.solutionInferred ? '?' : ''}`).join());
// 번호를 거의 못 읽은 스캔: 앞뒤와 맞지 않는 OCR 번호는 순서 번호로 바꾸되 해설은 OCR 번호 쪽을 먼저 찾는다
const sparse = [pg(1, [line('1. 문제', 102, 100)], [vis(100), vis(400), vis(700)]), pg(2, [], [vis(100), vis(400), vis(700)]), pg(3, [line('2. 문제', 102, 100)], [vis(100), vis(400), vis(700)])];
const sp = seg(sparse).map((x, i) => ({ ...x, id: 'q' + i }));
S.matchSolutions(sp, Array.from({ length: 9 }, (_, i) => ({ id: 't' + (i + 1), section: 1, number: i + 1 })));
const demoted = sp.find((x) => x.detection.ocrNumber === 2);
check('희소 OCR: 모든 경계 보존 + OCR이 읽은 2번 문제가 2번 해설과 (확인 필요로) 연결', sp.length === 9 && demoted?.solutionId === 't2' && demoted.solutionInferred && sp.filter((x) => x.solutionId === 't2').length === 1, sp.map((x) => `${x.section}-${x.number}→${x.solutionId}`).join(' '));

// ── 텍스트층 교재 쪽 합성 (이미지 + 줄): 단원 끝 그림·선택지, 개념 쪽, 단 맨 위 제목
const W = 1190, H = 1684, TC = [{ x0: 90, x1: 575 }, { x0: 615, x1: 1100 }];
function makePage(index, colBlocks) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255), img = { data, width: W, height: H }, lines = [];
  const ink = (x0, y0, x1, y1, sparseInk = true) => { for (let y = y0 | 0; y < (y1 | 0); y++) for (let x = x0 | 0; x < (x1 | 0); x++) if (!sparseInk || ((x * 7 + y * 13) % 5) === 0) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 20; } };
  const text = (t, x, y, w, first) => { ink(x, y + 4, x + w, y + LH - 3); const ft = first ?? t.split(/\s+/)[0]; lines.push({ text: t, x0: x, y0: y, x1: x + w, y1: y + LH, firstWord: { text: ft, x0: x, y0: y, x1: x + [...ft].length * 11, y1: y + LH } }); };
  colBlocks.forEach((blocks, ci) => {
    const c = TC[ci]; let y = 140;
    for (const b of blocks) {
      if (b.head) { text(b.head, c.x0, y, 300); y += STEP + 30; continue; }
      if (b.para) { for (let k = 0; k < b.para; k++) { text('개념 설명 문장이 이어진다 개념 설명 문장이 이어진다', c.x0, y, 470); y += STEP; } y += 50; continue; }
      const num = String(b.p).padStart(2, '0');
      text(`${num} 다음 식의 값은?`, c.x0, y, 440, num); y += STEP;
      text('함수 f(x)=x^2-4x+3 에 대하여', c.x0 + 36, y, 404); y += STEP;
      text('f(2)의 값은?', c.x0 + 36, y, 250); y += STEP;
      if (b.fig) { y += 20; ink(c.x0 + 150, y, c.x0 + 152, y + b.fig, false); ink(c.x0 + 100, y + b.fig - 20, c.x0 + 330, y + b.fig - 18, false); y += b.fig + 20; }
      if (b.choices !== false) { y += 16; text('① 1 ② 2 ③ 3 ④ 4 ⑤ 5', c.x0 + 36, y, 420, '①'); y += STEP; }
      y += 90;
    }
  });
  const columns = TC.map((c) => ({ ...c }));
  return { index, width: W, height: H, columns, lines, visualStarts: L.detectBlockStarts(img, columns, { top: 0.07, bottom: 0.06 }), inkBottoms: L.columnInkBottoms(img, columns, { top: 0.07, bottom: 0.06 }), ocr: false };
}
let n = 1;
const section = () => { const s = n; n += 8; return [makePage(0, [[{ p: s }, { p: s + 1 }], [{ p: s + 2 }, { p: s + 3 }]]), makePage(0, [[{ p: s + 4 }, { p: s + 5 }], [{ p: s + 6 }, { p: s + 7, fig: 140 }]])]; };
const reindex = (pages) => pages.map((p, i) => ({ ...p, index: i + 1 }));
n = 1; const two = section(); n = 1; const two2 = section();
const sectionsWithFigures = reindex([...two, ...two2]);
check('단원 끝 문제의 그림·선택지를 따로 문제로 만들지 않음 (16개 그대로)', keys(seg(sectionsWithFigures)) === [...Array(8)].map((_, i) => `1-${i + 1}`).concat([...Array(8)].map((_, i) => `2-${i + 1}`)).join(' '), keys(seg(sectionsWithFigures)));
n = 1; const a1 = section(); n = 1; const a2 = section();
const concept = makePage(0, [[{ para: 5 }, { para: 5 }], [{ para: 5 }, { para: 4 }]]);
const withConcept = reindex([...a1, concept, ...a2]);
check('단원 사이 개념 설명 쪽은 문제로 만들지 않음', seg(withConcept).length === 16 && !seg(withConcept).some((x) => x.fragments[0].page === 3), keys(seg(withConcept)));
n = 1; const b1 = section();
const trailing = reindex([...b1, makePage(0, [[{ para: 6 }], [{ para: 6 }]])]);
check('마지막 문제 뒤 설명 쪽도 문제로 만들지 않음', seg(trailing).length === 8, keys(seg(trailing)));
// 단 중간에서 끝난 문제 뒤, 다음 쪽 맨 위 제목·도입 글은 그 문제에 이어 붙이지 않는다
n = 1;
const headed = reindex([makePage(0, [[{ p: 1 }, { p: 2 }], [{ p: 3 }, { p: 4 }]]), makePage(0, [[{ head: '유형 02  로그의 성질' }, { para: 2 }, { p: 5 }, { p: 6 }], [{ p: 7 }, { p: 8 }]])]);
const hi = seg(headed);
check('다음 쪽 맨 위 단원 제목을 앞 쪽 마지막 문제에 붙이지 않음', hi.length === 8 && hi.every((x) => x.fragments.length === 1), hi.map((x) => `${x.number}:${x.fragments.length}`).join(' '));
// 번호를 못 읽은 쪽: 선택지 줄 앞 여백을 문제 시작으로 보지 않는다
const noNum = makePage(1, [[{ p: 1 }, { p: 2 }], [{ p: 3 }, { p: 4 }]]);
noNum.lines = noNum.lines.map((l) => (/^0\d/.test(l.text) ? { ...l, text: l.text.replace(/^0\d /, ''), firstWord: { ...l.firstWord, text: '다음' } } : l));
const nn = seg([noNum]);
check('번호 없는 쪽에서 5지선다 선택지 줄로 문제를 쪼개지 않음 (4개)', nn.length === 4, keys(nn));

// ── 텍스트 PDF에 OCR을 보탤 때 정확한 글자층을 유지하고, 그림으로 된 번호만 붙인다
const T = (text, x, y, source, fwW = 30) => ({ text, x0: x, y0: y, x1: x + 400, y1: y + 22, firstWord: { text: text.split(' ')[0], x0: x, y0: y, x1: x + fwW, y1: y + 22 }, source });
const merged = O.mergeLines([T('정답 ③ f(x)=x²-4x+3에서 f(2)=-1', 91, 141), T('다음 식의 값은?', 124, 300)], [T('정답 ⑨ f(x)=x2-4x+3 에서 f(2)=-l', 90, 140, 'ocr'), T('3. 다음 식의 값은?', 80, 300, 'ocr', 22)]);
check('텍스트층 우선 병합: 정확한 글자 유지 + 그림 번호만 앞에 붙임', merged[0].text === '정답 ③ f(x)=x²-4x+3에서 f(2)=-1' && merged[1].text === '3. 다음 식의 값은?' && S.parseAnchor(merged[1])?.num === 3, merged.map((l) => l.text).join(' | '));

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
