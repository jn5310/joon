// 분리·연결·정답 추출 규칙 단위 테스트 (Node, 저장소 외부)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { window: {} };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../part1.js'), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const S = ctx.window.M.segment;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

// 정답 추출
const answers = [
  ['정답 ③', '③'], ['[정답] ③', '③'], ['따라서 정답은 ③이다.', '③'], ['답: 12', '12'], ['정답 -3', '-3'], ['정답 −3', '-3'],
  ['정답 1/2', '1/2'], ['정답 1 / 2', '1/2'], ['정답 3.5', '3.5'], ['따라서 정답은 3.', '3'], ['정답 ⑤', '⑤'],
  ['답 2√3', null], ['정답률 45%', null], ['해답 1. 풀이를 보면', null], ['해답 2) 다음을 보면', null], ['정답 12345', null], ['', null], [null, null],
  ['해답 ③', '③'], ['해답: 12', '12'], ['해답 1. 풀이 … 따라서 정답 ②', '②'], ['이 문제의 답은 5이다', '5'],
];
const badA = answers.map(([t, want]) => [t, want, S.extractAnswer(t)]).filter(([, w, g]) => w !== g);
check(`정답 추출 ${answers.length}개 사례`, !badA.length, JSON.stringify(badA));

// 문제 번호 인식
const line = (text) => ({ text, firstWord: { text: text.split(/\s+/)[0] } });
const anchors = [
  ['1. 다음 중', 1, 'plain'], ['1.다음 중 옳은 것은?', 1, 'plain'], ['01 함수 f(x)', 1, 'plain'], ['[3] 다음', 3, 'plain'],
  ['(1) 구하시오', 1, 'paren'], ['2) 값을', 2, 'paren'], ['1.5배로 늘리면', null, null], ['12다음', null, null], ['3점', null, null],
];
const badN = anchors.map(([t, n, st]) => { const a = S.parseAnchor(line(t)); return [t, n, st, a?.num ?? null, a?.style ?? null]; })
  .filter(([, n, st, gn, gs]) => n !== gn || st !== gs);
check(`문제 번호 인식 ${anchors.length}개 사례`, !badN.length, JSON.stringify(badN));

// 소문항 (1)(2)(3)이 본 문제 번호 사슬을 끊지 않아야 한다
const seq = [1, 2, 3, 4, 5, '(1)', '(2)', '(3)', 6, 7, 8];
const cands = seq.map((v, i) => ({ page: 1, col: 0, y0: i * 10, num: typeof v === 'number' ? v : +v.slice(1, -1), style: typeof v === 'number' ? 'plain' : 'paren' }));
const chain = S.chainAnchors(cands, {});
check('소문항 번호를 건너뛰고 1~8 사슬 유지', chain.map((a) => `${a.section}-${a.num}`).join(',') === '1-1,1-2,1-3,1-4,1-5,1-6,1-7,1-8', chain.map((a) => `${a.section}-${a.num}`).join(','));

// 해설 연결: 다른 단원의 같은 번호 해설에 잇지 않는다
const probs = [1, 2, 3].flatMap((n) => [{ id: `a${n}`, section: 1, number: n }, { id: `b${n}`, section: 2, number: n }]);
const sols = [1, 2, 3].map((n) => ({ id: `s${n}`, section: 1, number: n }));
S.matchSolutions(probs, sols);
check('단원이 여럿이면 번호만으로 다른 단원 해설에 잇지 않음', probs.filter((p) => p.section === 1).every((p) => p.solutionId === `s${p.number}`) && probs.filter((p) => p.section === 2).every((p) => p.solutionId === null), JSON.stringify(probs.map((p) => [p.id, p.solutionId])));
const p7 = [{ id: 'p7', section: 1, number: 7 }];
S.matchSolutions(p7, [{ id: 's7', section: 2, number: 7 }]);
check('번호가 양쪽에서 하나뿐이면 단원이 달라도 연결', p7[0].solutionId === 's7');

// 해설 이어붙이기 조각 수 제한 (번호를 못 찾은 쪽이 계속될 때)
const pages = Array.from({ length: 12 }, (_, i) => ({
  index: i + 1, width: 1000, height: 1400, columns: [{ x0: 50, x1: 480 }, { x0: 520, x1: 950 }],
  lines: i === 0 ? [{ text: '01 풀이', x0: 50, y0: 200, x1: 200, y1: 220, firstWord: { text: '01', x0: 50, y0: 200, x1: 70, y1: 220 } }] : [],
}));
const segs = S.segmentPages(pages, { continuation: true });
check('번호 없는 쪽이 계속돼도 한 해설의 조각은 6개 이하', segs.length === 1 && segs[0].fragments.length <= 6, `조각 ${segs[0]?.fragments.length}`);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
