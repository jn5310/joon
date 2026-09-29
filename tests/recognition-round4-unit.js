// 4차 리뷰 회귀 테스트 (Node, 저장소 외부): 번호 자리에서 시작하는 해설의 단원·책 끝 이어붙이기, "정답" 머리가 보이는 못 읽은 해설,
// 개념 쪽의 ①②③ 나열·되묻는 물음, 번호 못 읽은 문제 단(물음 끝·세로 선택지·(단, …)), 단원 표지 제목, 들여쓴 제목 뒤 이어붙이기, 선택지 이어붙이기
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {}, console }; ctx.window.window = ctx.window; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(process.env.PART1 || path.resolve(__dirname, '../part1.js'), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const { layout: L, segment: S } = ctx.window.M;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const W = 1190, H = 1684, LH = 22, STEP = 34, COLS = [{ x0: 90, x1: 575 }, { x0: 615, x1: 1100 }];
const O = { top: 0.07, bottom: 0.06 };
const BODY = '풀이 과정 식을 정리하면 다음과 같다 풀이 과정 식을';
/**
* 블록:
*  {p, number:false, stem:[...], choices:'row'|'vertical'|false, fig, gapAfter}  문제 (본문은 36px 들여씀, 번호를 못 읽으면 배지만 그림)
*  {sol, number:false, paras:[k…], fig}  해설 (본문이 번호 자리에서 시작 — 들여쓰지 않음)
*  {cont:[k…]}  앞 해설이 이어진 문단 (들여쓰지 않음)
*  {contProblem:{fig, choices:'row'|'lane-row'}}  앞 문제가 이어진 부분 (들여쓴 그림 → 선택지)
*  {para:k, cue, gap}  개념 글 (cue: 'circled' 한 줄 나열, 'question' 문단 중간 물음, 'question-end' 문단 끝 되묻기)
*  {head, indent}  제목   {title}  단원 표지 큰 제목   {space}
*/
function makePage(colBlocks, { startY = 140, header = '수학Ⅰ 유형 연습' } = {}) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255), img = { data, width: W, height: H }, lines = [];
  const ink = (x0, y0, x1, y1, sparse = true) => { for (let y = y0 | 0; y < (y1 | 0); y++) for (let x = x0 | 0; x < (x1 | 0); x++) if (!sparse || ((x * 7 + y * 13) % 5) === 0) { const i = (y * W + x) * 4; data[i] = data[i + 1] = data[i + 2] = 20; } };
  const text = (t, x, y, w, first) => { ink(x, y + 4, x + w, y + LH - 3); const ft = first ?? t.split(/\s+/)[0]; lines.push({ text: t, x0: x, y0: y, x1: x + w, y1: y + LH, firstWord: { text: ft, x0: x, y0: y, x1: x + [...ft].length * 11, y1: y + LH } }); };
  const figure = (c, y, h) => { ink(c.x0 + 150, y, c.x0 + 152, y + h, false); ink(c.x0 + 100, y + h - 20, c.x0 + 330, y + h - 18, false); };
  text(header, 90, 60, 300);
  colBlocks.forEach((blocks, ci) => {
    const c = COLS[ci]; let y = startY;
    for (const b of blocks) {
      if (b.space) { y += b.space; continue; }
      if (b.title) { ink(c.x0, y, c.x0 + 300, y + 60); lines.push({ text: b.title, x0: c.x0, y0: y, x1: c.x0 + 300, y1: y + 60, firstWord: { text: b.title.split(' ')[0], x0: c.x0, y0: y, x1: c.x0 + 40, y1: y + 60 } }); y += 120; continue; }
      if (b.head) { text(b.head, c.x0 + (b.indent || 0), y, 260); y += STEP + 30; continue; }
      if (b.para) {
        for (let k = 0; k < b.para; k++) {
          let t = '개념 설명 문장이 이어진다 개념 설명 문장이 이어진다', x = c.x0;
          if (k === 1 && b.cue === 'circled') { t = '② a>1일 때 x의 값이 증가하면 y의 값도 증가한다'; x += 20; }
          if (k === 1 && b.cue === 'question') t = '그렇다면 a<0일 때에는 그래프가 어떻게 될까?';
          if (k === b.para - 1 && b.cue === 'question-end') t = '그렇다면 a<0일 때에는 어떻게 될까?';
          text(t, x, y, 470); y += STEP;
        }
        y += b.gap ?? 60; continue;
      }
      if (b.cont) {
        b.cont.forEach((k, pi) => { if (pi) y += 40; for (let i = 0; i < k; i++) { text(i === 0 && pi ? '따라서 구하는 값은 다음과 같다' : BODY, c.x0, y, i === k - 1 ? 260 : 470); y += STEP; } });
        y += 50; continue;
      }
      if (b.contProblem) {
        const cp = b.contProblem;
        if (cp.fig) { y += 10; figure(c, y, cp.fig); y += cp.fig + 20; }
        const garbled = cp.choices === 'lane-garbled';
        y += 16; text(garbled ? '@1 @2 ®3 @4 ©5' : '① 1 ② 2 ③ 3 ④ 4 ⑤ 5', c.x0 + (cp.choices === 'lane-row' || garbled ? 0 : 36), y, 420, garbled ? '@1' : '①'); y += STEP + 90; continue;
      }
      if (b.sol != null) {
        const t = String(b.sol).padStart(2, '0');
        if (b.number === false) { ink(c.x0, y + 2, c.x0 + 26, y + LH - 2, false); text(b.lone ? '③' : '정답 ③', c.x0 + 30, y, b.lone ? 20 : 170); }
        else text(`${t} 정답 ③`, c.x0, y, 200, t);
        y += STEP;
        (b.paras || [3]).forEach((k, pi) => {
          if (pi) y += 40;
          for (let i = 0; i < k; i++) { text(i === 0 && pi ? '따라서 구하는 값은 다음과 같다' : BODY, c.x0, y, i === k - 1 ? 260 : 470); y += STEP; }
          if (pi === 0 && b.fig) { y += 24; figure(c, y, b.fig); y += b.fig + 24; }
        });
        y += 50; continue;
      }
      const num = String(b.p).padStart(2, '0');
      const stem = b.stem || ['다음 조건을 만족시키는', '함수 f(x)=x^2-4x+3 에 대하여', 'f(2)의 값은?'];
      if (b.number === false) { ink(c.x0, y + 2, c.x0 + 26, y + LH - 2, false); text(stem[0], c.x0 + 36, y, 404); }
      else text(`${num} ${stem[0]}`, c.x0, y, 440, num);
      y += STEP;
      for (let k = 1; k < stem.length; k++) { text(stem[k], c.x0 + 36, y, k === stem.length - 1 ? 250 : 404); y += STEP; }
      if (b.fig) { y += 20; figure(c, y, b.fig); if (b.figLabel) text(b.figLabel, c.x0 + 200, y + 30, 40); y += b.fig + 20; }
      if (b.choices === 'row' || b.choices === undefined) { y += 16; text('① 1 ② 2 ③ 3 ④ 4 ⑤ 5', c.x0 + 36, y, 420, '①'); y += STEP; }
      if (b.choices === 'garbled') { y += 16; text('@ 1 @ 2 ® 3 @ 4 ® 5', c.x0 + 36, y, 420, '@'); y += STEP; } // OCR이 원 번호를 못 읽음
      if (b.choices === 'vertical') { y += 16; ['① 1', '② 2', '③ 3', '④ 4', '⑤ 5'].forEach((t) => { text(t, c.x0 + 36, y, 64); y += STEP; }); }
      if (b.choices === 'vertical-garbled') { y += 16; ['@ 3개', '® 4개', '@ 5개', '® 6개', '© 7개'].forEach((t) => { text(t, c.x0 + 36, y, 64); y += STEP; }); }
      y += b.gapAfter ?? 90;
    }
  });
  const columns = COLS.map((c) => ({ ...c }));
  return { index: 0, width: W, height: H, columns, lines, visualStarts: L.detectBlockStarts(img, columns, O), inkBottoms: L.columnInkBottoms(img, columns, O), ocr: false };
}
const reindex = (pages) => pages.map((p, i) => ({ ...p, index: i + 1 }));
const seg = (pages, kind = 'problem') => S.segmentPages(pages, { ...O, continuation: true, maxSkip: 3, kind });
const keys = (items) => items.map((x) => `${S.itemKey(x)}${x.detection?.inferred ? '*' : ''}`).join(' ');
const frags = (it) => (it ? it.fragments.map((f) => `p${f.page}c${f.x0 < 600 ? 0 : 1}${f.cont ? 'cont' : ''}`).join('+') : 'none');
const range = (sec, a, b) => Array.from({ length: b - a + 1 }, (_, i) => `${sec}-${a + i}`).join(' ');
const inferredCount = (items) => items.filter((x) => x.detection?.inferred).length;
const find = (items, sec, n) => items.find((x) => x.section === sec && x.number === n && !x.label);

// ── 1) 해설: 본문이 번호 자리에서 시작 (들여쓰지 않은 해설집)
const solPage = (cols) => makePage(cols, { header: '정답과 해설' });
{
  const r = seg(reindex([
    solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4, paras: [28] }]]),
    solPage([[{ cont: [4, 2] }], [{ sol: 1 }, { sol: 2 }]]),
    solPage([[{ sol: 3 }, { sol: 4 }], [{ sol: 5 }]]),
  ]), 'solution');
  check('해설: 단원 마지막 풀이가 다음 쪽 단으로 넘어가면 이어 붙이고 가짜 해설을 만들지 않음', inferredCount(r) === 0 && keys(r) === `${range(1, 1, 4)} ${range(2, 1, 5)}` && frags(find(r, 1, 4)) === 'p1c1+p2c0cont', `${keys(r)} | 1-4: ${frags(find(r, 1, 4))}`);
}
{
  const r = seg(reindex([
    solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5, paras: [22] }]]),
    solPage([[{ cont: [4, 2] }], []]),
  ]), 'solution');
  check('해설: 책 마지막 풀이가 다음 쪽으로 넘어가도 한 해설로 (가짜 해설 없음)', inferredCount(r) === 0 && r.length === 5 && frags(find(r, 1, 5)).startsWith('p1c1+p2c0cont'), `${keys(r)} | 1-5: ${frags(find(r, 1, 5))}`);
}
{
  const r = seg(reindex([solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5, paras: [3, 2], fig: 160 }]])]), 'solution');
  const s5 = find(r, 1, 5);
  check('해설: 책 마지막 풀이의 그래프 뒤 결론 문단도 그 해설에 포함', inferredCount(r) === 0 && r.length === 5 && s5 && s5.fragments[0].y1 > 1400, `${keys(r)} | 1-5 y1=${Math.round(s5?.fragments[0].y1)}`);
}
{
  const r = seg(reindex([
    solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5 }, { sol: 6, paras: [14] }]]),
    solPage([[{ cont: [4, 2] }], [{ head: '유형 02' }, { sol: 1 }, { sol: 2 }, { sol: 3 }]]),
    solPage([[{ sol: 4 }, { sol: 5 }, { sol: 6 }], []]),
  ]), 'solution');
  check('해설: 이어진 단 옆 단에서 새 단원이 시작해도 12개 그대로', inferredCount(r) === 0 && keys(r) === `${range(1, 1, 6)} ${range(2, 1, 6)}` && frags(find(r, 1, 6)).startsWith('p1c1+p2c0cont'), `${keys(r)} | 1-6: ${frags(find(r, 1, 6))}`);
}
{
  // 단원 끝 두 해설의 번호를 못 읽었지만 "정답 ③" 머리는 읽힌 경우: 새 해설로 남긴다
  const r = seg(reindex([
    solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5, number: false }, { sol: 6, number: false }]]),
    solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5 }, { sol: 6 }]]),
  ]), 'solution');
  check('해설: 번호를 못 읽어도 "정답 ③" 머리가 보이는 단원 끝 해설은 새 해설로 (1-5*, 1-6*)', keys(r) === `${range(1, 1, 4)} 1-5* 1-6* ${range(2, 1, 6)}`, keys(r));
}
{
  // 번호 배지를 못 읽고 답 "③"만 읽힌 책 끝 해설도 새 해설로
  const r = seg(reindex([solPage([[{ sol: 1 }, { sol: 2 }, { sol: 3 }], [{ sol: 4 }, { sol: 5, number: false, lone: true }, { sol: 6, number: false, lone: true }]])]), 'solution');
  check('해설: 번호 배지를 못 읽고 답(③)만 읽힌 책 끝 해설도 새 해설로 (1-5*, 1-6*)', keys(r) === `${range(1, 1, 4)} 1-5* 1-6*`, keys(r));
}

// ── 2) 문제: 번호 없는 개념 쪽과 번호 못 읽은 문제 쪽
let n = 1;
const read = () => makePage([[{ p: n++ }, { p: n++ }], [{ p: n++ }, { p: n++ }]]);
const concept = (cue) => makePage([[{ head: '개념 정리  지수함수의 그래프' }, { para: 4, cue }, { para: 3, cue }, { para: 4, cue }], [{ para: 4, cue }, { para: 3, cue }, { para: 4, cue }]]);
for (const cue of ['circled', 'question', 'question-end']) {
  for (const k of [1, 2]) {
    n = 1; const a = [read(), read()]; n = 1; const b = [read(), read()];
    const r = seg(reindex([...a, ...Array.from({ length: k }, () => concept(cue)), ...b]));
    check(`개념 쪽 ${k}장(${cue === 'circled' ? '① 한 줄 나열' : cue === 'question' ? '문단 중간 물음' : '문단 끝 "…될까?"'})은 문제로 만들지 않음 (16개)`, r.length === 16 && inferredCount(r) === 0 && keys(r) === `${range(1, 1, 8)} ${range(2, 1, 8)}`, keys(r));
  }
}
{
  const unread = (opts) => makePage([[{ p: n++, number: false, ...opts }, { p: n++, number: false, ...opts }], [{ p: n++, number: false, ...opts }, { p: n++, number: false, ...opts }]]);
  n = 1; const pages = reindex([read(), read(), unread({ choices: 'vertical' }), unread({ choices: false, stem: ['함수 f(x)=x^2-4x+3 에 대하여', 'f(2)의 값을 구하시오.', '(단, x는 실수이다.)'] })]);
  const r = seg(pages);
  check('번호 못 읽은 문제 쪽: 물음으로 끝나는 세로 선택지 문제·"(단, …)"이 붙은 주관식도 보존 (16개)', r.length === 16 && r.filter((x) => x.fragments[0].page >= 3).length === 8, keys(r));
  // OCR이 원 번호를 못 읽은 선택지, 그림 속 짧은 잡음 글자, (1)(2) 소문항으로 끝나는 문제
  n = 1; const noisy = reindex([read(), read(),
    unread({ choices: 'garbled', stem: ['다음 조건을 만족시키는', '함수 f(x)=x^2-4x+3 에 대하여', 'f(2)의 값은?', '으스'] }), // 발문 뒤 짧은 OCR 잡음 줄
    unread({ choices: 'vertical-garbled', stem: ['다음 조건을 만족시키는', '자연수 n의 개수는?'] }),
    unread({ choices: false, stem: ['함수 f(x)=x^2-4x+3 에 대하여', '다음 물음에 답하여라', '(1) f(2)의 값을 구하시오.', '(2) f(x)의 최솟값을 구하시오.'] })]);
  const rn = seg(noisy);
  check('번호 못 읽은 스캔 쪽: 원 번호가 깨진 선택지·그림 잡음·(1)(2) 소문항 문제도 보존 (20개)', rn.length === 20 && rn.filter((x) => x.fragments[0].page >= 3).length === 12, keys(rn));
}
{
  n = 1; const a = [read(), read()]; n = 1;
  const opener = makePage([[{ title: 'Ⅱ 지수함수와 로그함수' }, { space: 200 }], [{ para: 2, gap: 80 }]]);
  const b = [read(), read()];
  const r = seg(reindex([...a, opener, ...b]));
  check('단원 표지 쪽의 큰 제목·소개 글은 문제로 만들지 않음 (16개)', r.length === 16 && inferredCount(r) === 0, keys(r));
}

// ── 3) 문제 이어붙이기
const long = ['다음 조건을 만족시키는', '함수 f(x)에 대하여', '(가) f(0)=0', '(나) 모든 실수 x에 대하여', 'f(x) ≥ -4 이다', '다음 중 옳은 것은?'];
for (const indent of [60, 140]) {
  n = 1;
  const p1 = makePage([[{ p: n++ }, { p: n++ }, { p: n++ }], [{ p: n++ }, { p: n++, stem: long }, { p: n++, stem: long, fig: 560 }]]);
  n = 1;
  const p2 = makePage([[{ head: '실전 문제  로그의 성질', indent }, { para: 2, gap: 70 }, { p: n++ }, { p: n++ }], [{ p: n++ }, { p: n++ }]]);
  const r = seg(reindex([p1, p2]));
  check(`문제: 앞 단이 꽉 차도 ${indent}px 들여쓴 제목과 도입 글은 이어 붙이지 않음`, frags(find(r, 1, 6)) === 'p1c1', `1-6: ${frags(find(r, 1, 6))} | ${keys(r)}`);
}
for (const choices of ['row', 'lane-row', 'lane-garbled']) {
  n = 1;
  const p1 = makePage([[{ p: n++ }, { p: n++ }, { p: n++ }], [{ p: n++ }, { p: n++, stem: long }, { p: n++, stem: long, fig: 600, choices: false }]]);
  const p2 = makePage([[{ contProblem: { fig: choices === 'lane-row' ? 0 : 120, choices } }, { p: n++ }, { p: n++ }], [{ p: n++ }, { p: n++ }]]);
  const r = seg(reindex([p1, p2]));
  const what = { row: '들여쓴 그림·선택지', 'lane-row': '번호 자리 선택지 줄', 'lane-garbled': '그림 뒤 번호 자리의 깨진 선택지 줄' }[choices];
  check(`문제: 단 끝까지 찬 문제의 ${what}도 다음 단에서 이어 붙임`, frags(find(r, 1, 6)) === 'p1c1+p2c0cont' && inferredCount(r) === 0, `1-6: ${frags(find(r, 1, 6))} | ${keys(r)}`);
}

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
