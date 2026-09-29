// 3차 리뷰 회귀 테스트 (Node, 저장소 외부): 단 맨 위 번호, 번호 못 읽은 문제 쪽 vs 개념 쪽, 새 단원 앞 추정 번호,
// 해설 이어붙이기·문제 제목 이어붙이기, 예제/유제/복합 라벨, 문제 첫머리 수량어, 흐린 스캔의 단 검출
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {}, console }; ctx.window.window = ctx.window; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../part1.js'), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const { layout: L, segment: S } = ctx.window.M;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const W = 1190, H = 1684, LH = 22, STEP = 34, COLS = [{ x0: 90, x1: 575 }, { x0: 615, x1: 1100 }];
/**
* 텍스트층 교재 쪽 (글줄 + 래스터). 블록:
* {p} 본문 번호 문제 "0p" · {label:'유제 1-2'} 라벨 문제 · {sol, lines} 해설 · {para} 개념 글 · {head} 제목 · {cont, fig} 앞 항목의 이어진 부분
* number:false 이면 번호를 글줄에서 뺀다(번호 배지를 OCR이 못 읽은 스캔). opening: 문제 첫 줄 글.
*/
function makePage(index, colBlocks, { startY = 140 } = {}) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255), img = { data, width: W, height: H }, lines = [];
  const ink = (x0, y0, x1, y1, sparse = true) => { for (let y = y0 | 0; y < (y1 | 0); y++) for (let x = x0 | 0; x < (x1 | 0); x++) if (!sparse || ((x * 7 + y * 13) % 5) === 0) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 20; } };
  const text = (t, x, y, w, first, draw = true) => { if (draw) ink(x, y + 4, x + w, y + LH - 3); if (t == null) return; const ft = first ?? t.split(/\s+/)[0]; lines.push({ text: t, x0: x, y0: y, x1: x + w, y1: y + LH, firstWord: { text: ft, x0: x, y0: y, x1: x + [...ft].length * 11, y1: y + LH } }); };
  colBlocks.forEach((blocks, ci) => {
    const c = COLS[ci]; let y = startY;
    for (const b of blocks) {
      if (b.head) { text(b.head, c.x0, y, 300); y += STEP + 30; continue; }
      if (b.para) { for (let k = 0; k < b.para; k++) { text('개념 설명 문장이 이어진다 개념 설명 문장이 이어진다', c.x0, y, 470); y += STEP; } y += 50; continue; }
      if (b.cont) { for (const t of b.cont) { text(t, c.x0 + 36, y, 380); y += STEP; } if (b.fig) { ink(c.x0 + 150, y, c.x0 + 152, y + b.fig, false); ink(c.x0 + 100, y + b.fig - 20, c.x0 + 330, y + b.fig - 18, false); y += b.fig + 20; } y += 50; continue; }
      if (b.sol != null) {
        const t = String(b.sol).padStart(2, '0');
        text(`${t} 정답 ③`, c.x0, y, 200, t); y += STEP;
        for (let k = 0; k < (b.lines || 2); k++) { text('풀이 과정을 정리하면 다음과 같다', c.x0, y, 440); y += STEP; }
        y += b.gapAfter ?? 50; continue;
      }
      const num = b.label ?? String(b.p).padStart(2, '0');
      const opening = b.opening ?? '다음 식의 값은?';
      if (b.number === false) { ink(c.x0, y + 2, c.x0 + 26, y + LH - 2, false); text(opening, c.x0 + 36, y, 404); }
      else text(`${num} ${opening}`, c.x0, y, 440, b.label ? b.label.split(' ')[0] : num);
      y += STEP;
      text('함수 f(x)=x^2-4x+3 에 대하여', c.x0 + 36, y, 404); y += STEP;
      if (b.fig) { y += 20; ink(c.x0 + 150, y, c.x0 + 152, y + b.fig, false); ink(c.x0 + 100, y + b.fig - 20, c.x0 + 330, y + b.fig - 18, false); y += b.fig + 20; }
      if (b.choices !== false) { y += 16; text('① 1 ② 2 ③ 3 ④ 4 ⑤ 5', c.x0 + 36, y, 420, '①'); y += STEP; }
      y += b.gapAfter ?? 90;
    }
  });
  const columns = COLS.map((c) => ({ ...c }));
  return { index, width: W, height: H, columns, lines, visualStarts: L.detectBlockStarts(img, columns, { top: 0.07, bottom: 0.06 }), inkBottoms: L.columnInkBottoms(img, columns, { top: 0.07, bottom: 0.06 }), ocr: false };
}
const reindex = (pages) => pages.map((p, i) => ({ ...p, index: i + 1 }));
const seg = (pages, kind = 'problem') => S.segmentPages(pages, { top: 0.07, bottom: 0.06, continuation: true, maxSkip: 3, kind });
const keys = (items) => items.map((x) => `${S.itemKey(x)}${x.detection?.inferred ? '*' : ''}`).join(' ');
const range = (sec, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${sec}-${a + i}`).join(' ');

// 1) 머리말 선에 바짝 붙은 단 맨 위 번호: 책·단원의 첫 문제, 단원의 마지막 문제
const top = reindex([
  makePage(0, [[{ p: 1 }, { p: 2 }], [{ p: 3 }, { p: 4 }]], { startY: 122 }),
  makePage(0, [[{ p: 5 }], [{ p: 1 }, { p: 2 }]], { startY: 122 }),
  makePage(0, [[{ p: 3 }, { p: 4 }], [{ p: 5 }, { p: 6 }]], { startY: 122 }),
]);
check('머리말 선 바로 아래 단 맨 위 번호(책 첫 문제·단원 첫/끝 문제)도 모두 인식', keys(seg(top)) === `${range(1, 1, 5)} ${range(2, 1, 6)}`, keys(seg(top)));

// 2) 번호 배지를 못 읽은 문제 쪽(선택지·물음표가 있음)은 살리고, 번호 없는 개념 쪽은 문제로 만들지 않는다
let n = 1;
const read = () => makePage(0, [[{ p: n++ }, { p: n++ }], [{ p: n++ }, { p: n++ }]]);
const unread = () => makePage(0, [[{ p: n++, number: false }, { p: n++, number: false }], [{ p: n++, number: false }, { p: n++, number: false }]]);
n = 1; const tail = reindex([read(), read(), unread(), unread()]);
const tailItems = seg(tail);
check('읽은 번호 뒤 번호를 못 읽은 문제 쪽 2장도 문제로 보존 (16개)', tailItems.length === 16 && tailItems.filter((x) => x.fragments[0].page >= 3).length === 8, keys(tailItems));
const concept = () => makePage(0, [[{ para: 5 }, { para: 5 }], [{ para: 5 }, { para: 4 }]]);
n = 1; const s1 = [read(), read()]; n = 1; const s2 = [read(), read()];
for (const k of [2, 3]) {
  const pages = reindex([...s1, ...Array.from({ length: k }, concept), ...s2]);
  const it = seg(pages);
  check(`단원 사이 개념 쪽 ${k}장은 문제로 만들지 않음 (16개)`, it.length === 16 && keys(it) === `${range(1, 1, 8)} ${range(2, 1, 8)}`, keys(it));
}
n = 1; const t3 = reindex([read(), read(), concept(), concept(), concept()]);
check('마지막 문제 뒤 설명 쪽 3장도 문제로 만들지 않음 (8개)', seg(t3).length === 8, keys(seg(t3)));

// 3) 새 단원의 앞 문제 번호를 못 읽은 경우: 재시작 번호 앞 경계는 새 단원 번호(2-1, 2-2)
n = 1; const r1 = [read(), read()];
const r2 = makePage(0, [[{ p: 1, number: false }, { p: 2, number: false }], [{ p: 3 }, { p: 4 }]]);
n = 5; const r3 = read();
const restart = seg(reindex([...r1, r2, r3]));
check('새 단원 첫 문제들의 번호를 못 읽으면 새 단원 번호 2-1*, 2-2*로', keys(restart).startsWith(`${range(1, 1, 8)} 2-1* 2-2* 2-3 2-4 2-5`), keys(restart));

// 4) 이어붙이기: 해설은 일찍 단을 넘겨도 늘 이어 붙이고, 문제는 앞 단이 꽉 찼어도 다음 쪽 제목·도입 글을 붙이지 않는다
const sols = reindex([
  makePage(0, [[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5 }, { sol: 6, lines: 25 }]]),
  makePage(0, [[{ cont: ['그래프는 다음과 같다'], fig: 180 }, { cont: ['따라서 구하는 값은', '12 이다.'] }, { sol: 7 }, { sol: 8 }], [{ sol: 9 }, { sol: 10 }]]),
]);
const s6 = seg(sols, 'solution').find((x) => x.number === 6);
check('해설: 그래프가 안 들어가 일찍 단을 넘긴 풀이도 다음 쪽 부분을 이어 붙임', s6?.fragments.length === 2 && s6.fragments[1].page === 2 && s6.fragments[1].cont, JSON.stringify(s6?.fragments.map((f) => [f.page, Math.round(f.y0), Math.round(f.y1)])));
const full = reindex([
  makePage(0, [[{ p: 1 }, { p: 2 }, { p: 3 }], [{ p: 4 }, { p: 5 }, { p: 6, fig: 540 }]]),
  makePage(0, [[{ head: '유형 02  로그의 성질' }, { para: 2 }, { p: 7 }, { p: 8 }], [{ p: 9 }, { p: 10 }]]),
]);
const p6 = seg(full).find((x) => x.number === 6);
check('문제: 앞 단이 꽉 차도 다음 쪽 맨 위 단원 제목·도입 글은 붙이지 않음', p6?.fragments.length === 1, JSON.stringify(p6?.fragments.map((f) => [f.page, Math.round(f.y0), Math.round(f.y1), !!f.cont])));

// 5) 라벨: 예제·유제는 본문 번호와 따로, 키에 라벨 포함. 유제 1-2 같은 복합 번호. 예제가 본문 01을 삼키지 않음
const lab = seg([makePage(1, [[{ label: '예제 1' }, { label: '유제 1' }, { label: '예제 2' }], [{ label: '유제 2' }, { label: '예제 3' }, { label: '유제 3' }]])]);
const solsOnlyU = [1, 2, 3].map((k) => ({ id: 'u' + k, label: '유제', section: 1, number: k }));
const probs = lab.map((x, i) => ({ ...x, id: 'q' + i }));
S.matchSolutions(probs, solsOnlyU);
check('예제 1은 유제 1 해설과 이어지지 않고, 유제끼리만 이어짐', probs.filter((x) => x.label === '예제').every((x) => !x.solutionId) && probs.filter((x) => x.label === '유제').every((x) => x.solutionId === 'u' + x.number && !x.solutionInferred), probs.map((x) => `${S.itemKey(x)}→${x.solutionId}`).join(' '));
const comp = seg([makePage(1, [[{ label: '유제 1-1' }, { label: '유제 1-2' }, { label: '유제 1-3' }], [{ label: '유제 2-1' }, { label: '유제 2-2' }]])]);
check('복합 라벨 유제 1-1~1-3, 2-1~2-2 다섯 개 모두', keys(comp) === '유제 1-1 유제 1-2 유제 1-3 유제 2-1 유제 2-2', keys(comp));
const mixed = seg(reindex([
  makePage(0, [[{ label: '예제 1' }, { p: 1 }, { p: 2 }], [{ label: '예제 2' }, { p: 3 }, { p: 4 }]]),
  makePage(0, [[{ label: '예제 3' }, { p: 5 }, { p: 6 }], [{ p: 7 }, { p: 8 }]]),
]));
const plain = mixed.filter((x) => !x.label).map((x) => `${x.section}-${x.number}`).join(' ');
check('예제 라벨과 본문 01~08은 서로 섞이지 않음 (본문 1-1~1-8, 예제 1~3)', plain === range(1, 1, 8) && mixed.filter((x) => x.label === '예제').length === 3, keys(mixed));

// 6) 문제 첫머리가 수량어·기호처럼 보여도(−2 ≤ x, <보기>, 이 시험, 회사) 번호 자리·여백·순서가 맞으면 번호로 인식
const openings = ['−2 ≤ x ≤ 3에서 정의된 함수', '<보기>에서 옳은 것만을 고른 것은?', '이 시험에서 A가 받은 점수', '회사 A에서 생산한 제품'];
n = 1;
const op = seg([makePage(1, [[{ p: 1 }, { p: 2, opening: openings[0] }, { p: 3, opening: openings[1] }], [{ p: 4, opening: openings[2] }, { p: 5, opening: openings[3] }, { p: 6 }]])]);
check('문제 첫머리 −2 ≤ x · <보기> · 이 시험 · 회사도 번호 인식 (추정 없음)', keys(op) === range(1, 1, 6), keys(op));

// 7) 흐린 스캔: 글자 획이 흐려도(가운데 밝기 ~110) 진한 번호 배지와 함께 있을 때 단을 합치거나 줄 끝을 잃지 않는다
{
  const data = new Uint8ClampedArray(W * H * 4).fill(255), img = { data, width: W, height: H };
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const px = (x, y, v) => { const i = (y * W + x) * 4; if (data[i] > v) data[i] = data[i + 1] = data[i + 2] = v; };
  for (const [x0, x1] of [[90, 557], [615, 1082]]) for (let y = 150; y < 1500; y += 34) {
    for (let yy = y; yy < y + 26; yy++) for (let xx = x0; xx < x0 + 26; xx++) px(xx, yy, 20); // 진한 번호 배지
    for (let x = x0 + 36; x < x1; x++) if (rnd() < 0.35) { const core = 100 + Math.floor(rnd() * 40); for (let yy = y + 4; yy < y + 20; yy++) { px(x, yy, core); if (x + 1 < x1) px(x + 1, yy, Math.min(185, core + 45)); } }
  }
  const cols = L.detectColumns(img, { top: 0.07, bottom: 0.06 });
  check('흐린 글자 + 진한 번호 배지 쪽도 2단과 줄 끝(≈557/1082) 유지', cols.length === 2 && cols[0].x1 >= 550 && cols[1].x0 <= 620 && cols[1].x1 >= 1075, JSON.stringify(cols));
}

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
