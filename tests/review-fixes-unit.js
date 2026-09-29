// 리뷰 지적 사항 회귀 테스트: 본문 숫자 오인·maxSkip·선택지/소문항, 다시 분석 시 판정값 이전, 스캔 테두리 crop (Node, 저장소 외부)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {} }; ctx.window.window = ctx.window; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../part1.js'), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const { layout: L, segment: S } = ctx.window.M;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };
const line = (text, x, y, conf = 90) => ({ text, x0: x, y0: y, x1: x + 260, y1: y + 22, confidence: conf, source: 'ocr', firstWord: { text: text.split(' ')[0], x0: x, y0: y, x1: x + 26, y1: y + 22 } });
const onePage = (lines, visualStarts = [], index = 1) => ({ index, width: 700, height: 1000, columns: [{ x0: 100, x1: 600 }], ocr: true, visualStarts, lines });
const vis = (y) => ({ col: 0, y0: y, y1: y + 22, cutY: y - 10, h: 22, source: 'visual', confidence: 0.6 });
const nums = (list) => list.map((c) => c.num).join(',');

// 1-a) 번호 자리의 1., 2. 사이에 본문 들여쓰기 위치(xRel .35)의 "10."
const bodyPage = onePage([line('1. 다음 식의 값은?', 102, 100), line('10. 을 넘지 않는다', 275, 200), line('2. 함수 f(x)', 102, 400)], [vis(100), vis(400)]);
const bodyCands = S.findCandidates(bodyPage, {});
check('본문 속 "10."은 번호 후보여도 문제 번호로 쓰지 않음 [1, 10, 2] → [1, 2]', nums(S.selectAnchors(bodyCands, {})) === '1,2', nums(S.selectAnchors(bodyCands, {})));
const bodyItems = S.segmentPages([bodyPage], { continuation: true, top: 0.05, bottom: 0.05 });
check('본문 숫자로 문제를 쪼개지 않고 2번은 같은 단원 1-2 유지', bodyItems.map((x) => `${x.section}-${x.number}`).join(',') === '1-1,1-2', bodyItems.map((x) => `${x.section}-${x.number}`).join(','));
// 번호 자리에 있어도 앞뒤(1, 2)와 이어지지 않는 번호는 OCR 오인
const laneOdd = S.findCandidates(onePage([line('1. 다음', 102, 100), line('7. 오인', 102, 250), line('2. 함수', 102, 400)]), {});
check('앞뒤 번호가 이어지면 그 사이의 맞지 않는 번호(1, 7, 2의 7)는 버림', nums(S.selectAnchors(laneOdd, {})) === '1,2', nums(S.selectAnchors(laneOdd, {})));

// 1-b) maxSkip 설정이 실제로 반영된다: lane 밖 "5."의 순서 근거는 1 → 5 (4칸 건너뜀)뿐
const skipPage = onePage([line('1. 다음', 102, 100), line('5. 조건', 250, 400), line('20. 끝', 102, 800)], [vis(100), vis(400), vis(800)]);
const skipCands = S.findCandidates(skipPage, {});
const with3 = nums(S.selectAnchors(skipCands, { maxSkip: 3 })), with5 = nums(S.selectAnchors(skipCands, { maxSkip: 5 }));
check('maxSkip 3이면 4칸 건너뛴 lane 밖 번호를 버리고, 5이면 받아들임', with3 === '1,20' && with5 === '1,5,20', `maxSkip3=${with3} maxSkip5=${with5}`);

// 1-c) 5지선다 선택지·소문항은 주 번호가 있는 책에서 문제 번호가 아니다
const choicePages = [1, 2].map((p) => onePage([
  line(`${p * 2 - 1}. 다음 중 옳은 것은?`, 102, 100), line('① 1  ② 2  ③ 3', 130, 180), line('④ 4  ⑤ 5', 130, 215),
  line(`${p * 2}. 함수의 값은?`, 102, 400), line('① 3', 130, 470), line('② 5', 130, 500), line('③ 7', 130, 530), line('④ 9', 130, 560), line('⑤ 11', 130, 590),
  line('(1) 극값을 구하시오.', 130, 650), line('(2) 넓이를 구하시오.', 130, 720),
], [vis(100), vis(400)], p));
const choiceItems = S.segmentPages(choicePages, { continuation: true, top: 0.05, bottom: 0.05 });
check('가로·세로 선택지(①~⑤)와 소문항 (1)(2)로 문제를 쪼개지 않음', choiceItems.map((x) => `${x.section}-${x.number}`).join(',') === '1-1,1-2,1-3,1-4', choiceItems.map((x) => `${x.section}-${x.number}`).join(','));

// 2) 희소 인식: 1쪽의 1, 3쪽의 2, 쪽마다 시각 경계 3개 (리뷰 재현)
const page3 = (index, lines) => ({ index, width: 700, height: 1000, columns: [{ x0: 100, x1: 600 }], ocr: true, visualStarts: [vis(100), vis(400), vis(700)], lines });
const sparse = [page3(1, [line('1. 문제', 102, 100)]), page3(2, []), page3(3, [line('2. 문제', 102, 100)])];
const items = S.segmentPages(sparse, { continuation: true, top: 0.05, bottom: 0.05 });
const real2 = items.find((x) => x.fragments[0].page === 3 && x.fragments[0].y0 < 150);
check('추정 번호가 인식 번호를 앞질러도 새 단원을 만들지 않음 (모두 1단원)', items.every((x) => x.section === 1), items.map((x) => `${x.section}-${x.number}`).join(','));
check('앞뒤와 맞지 않는 OCR 번호는 경계로 쓰되 번호 추정 표시 + OCR 값 보존', real2 && real2.detection.inferred && real2.detection.ocrNumber === 2, JSON.stringify(real2?.detection));
const withGeom = (list) => list.map((x) => ({ ...x, pageHeight: 1000 }));
// 이전 분석: 인식된 1과 2만 있던 결과 (1-2 = 3쪽의 실제 2번), 사용자가 각각 판정값을 매김
const old = [
  { id: 'o1', section: 1, number: 1, gradeManual: 5, typeManual: '함수', fragments: [{ page: 1, x0: 100, y0: 90, x1: 600, y1: 380 }], detection: { inferred: false } },
  { id: 'o2', section: 1, number: 2, gradeManual: 2, typeManual: '수열', answer: '7', answerManual: true, fragments: [{ page: 3, x0: 100, y0: 90, x1: 600, y1: 380 }], detection: { inferred: false } },
];
const fresh = withGeom(items);
const prevOf = S.matchPrevious(old, fresh);
const inferred12 = fresh.find((x) => x.section === 1 && x.number === 2);
check('실제 2번(3쪽)의 판정값은 위치가 같은 새 항목으로 옮김', prevOf.get(fresh.find((x) => x.fragments[0].page === 3 && x.fragments[0].y0 < 150))?.id === 'o2');
check('같은 key(1-2)를 받은 추정 항목(1쪽)에는 옛 판정값을 옮기지 않음', inferred12 && inferred12.fragments[0].page === 1 && !prevOf.has(inferred12), JSON.stringify(inferred12?.fragments[0]));
check('1번은 위치로 그대로 연결', prevOf.get(fresh.find((x) => x.section === 1 && x.number === 1))?.id === 'o1');
// 위치가 달라도(직접 그린 영역 등) 양쪽 모두 읽은 번호이고 key가 하나씩뿐이면 번호로 잇는다. 추정 번호는 key가 같아도 잇지 않는다.
const keyOld = [{ id: 'k5', section: 1, number: 5, gradeManual: 3, fragments: [{ page: 9, x0: 0, y0: 0, x1: 10, y1: 10 }] }, { id: 'k6', section: 1, number: 6, gradeManual: 4, fragments: [{ page: 9, x0: 0, y0: 500, x1: 10, y1: 510 }] }];
const keyNew = [{ section: 1, number: 5, pageHeight: 1000, detection: { inferred: false }, fragments: [{ page: 2, x0: 100, y0: 100, x1: 600, y1: 300 }] }, { section: 1, number: 6, pageHeight: 1000, detection: { inferred: true }, fragments: [{ page: 2, x0: 100, y0: 400, x1: 600, y1: 600 }] }];
const keyMap = S.matchPrevious(keyOld, keyNew);
check('위치로 못 찾으면 읽은 번호끼리만 key로 연결 (추정 번호는 제외)', keyMap.get(keyNew[0])?.id === 'k5' && !keyMap.has(keyNew[1]));
// 같은 key가 여러 개면 모호하므로 key로 잇지 않는다
const dupOld = [{ id: 'd1', section: 1, number: 3, fragments: [{ page: 9, x0: 0, y0: 0, x1: 9, y1: 9 }] }, { id: 'd2', section: 1, number: 3, fragments: [{ page: 8, x0: 0, y0: 0, x1: 9, y1: 9 }] }];
check('옛 항목에 같은 번호가 둘이면 번호로 옮기지 않음', !S.matchPrevious(dupOld, [{ section: 1, number: 3, pageHeight: 1000, fragments: [{ page: 2, x0: 0, y0: 0, x1: 9, y1: 9 }] }]).size);

// 3) 스캔 테두리: 500×500, x=0의 세로선(y 50~449), 내용 x 100~219 / y 120~219
function canvas(W, H) {
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  const rect = (x, y, w, h, shade = 20) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const i = (yy * W + xx) * 4; data[i] = data[i + 1] = data[i + 2] = shade; } };
  return { img: { data, width: W, height: H }, rect };
}
const f1 = canvas(500, 500);
f1.rect(0, 50, 1, 400); f1.rect(100, 120, 120, 100);
const t1 = L.trimBox(f1.img, { x0: 0, y0: 0, x1: 500, y1: 500 }, 8);
check('가장자리 스캔 테두리선을 빼고 내용에 맞춰 최소 여백 crop', JSON.stringify(t1) === JSON.stringify({ x0: 92, y0: 112, x1: 228, y1: 228 }), JSON.stringify(t1));
const f2 = canvas(500, 500);
f2.rect(0, 0, 500, 3); f2.rect(496, 0, 4, 500); f2.rect(0, 497, 500, 3); f2.rect(150, 200, 90, 40);
const t2 = L.trimBox(f2.img, { x0: 0, y0: 0, x1: 500, y1: 500 }, 8);
check('네 변의 두꺼운 스캔 테두리(가로·세로)도 제거', JSON.stringify(t2) === JSON.stringify({ x0: 142, y0: 192, x1: 248, y1: 248 }), JSON.stringify(t2));
// 문제를 감싼 네모 틀은 내용이다: 틀과 안쪽 글이 모두 남아야 한다
const f3 = canvas(500, 500);
f3.rect(4, 60, 1, 300); f3.rect(4, 60, 480, 1); f3.rect(4, 359, 480, 1); f3.rect(483, 60, 1, 300); f3.rect(30, 90, 300, 20); f3.rect(30, 300, 400, 20);
const t3 = L.trimBox(f3.img, { x0: 0, y0: 0, x1: 500, y1: 500 }, 8);
check('문제를 감싼 네모 틀은 지우지 않음', t3.x0 === 0 && t3.y0 === 52 && t3.x1 === 492 && t3.y1 === 368, JSON.stringify(t3));
const f4 = canvas(300, 300);
f4.rect(0, 0, 2, 300);
check('테두리선만 있는 조각은 버림 (빈 이어짐 조각)', L.trimBox(f4.img, { x0: 0, y0: 0, x1: 300, y1: 300 }, 8) === null);

// 4) 한쪽으로 치우쳐 스캔된 2단 쪽 (글 영역 x 82~934 / 쪽 너비 1190): 가운데 골을 글 영역 기준으로 찾는다
const sh = canvas(1190, 1684);
// 글줄처럼 줄마다 위치가 다른 얇은 획: 한 행의 잉크가 쪽 너비의 10% 안팎
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const x0 of [82, 662]) for (let y = 150; y < 1500; y += 40) for (let x = x0; x < x0 + 272; x++) if (rnd() < 0.2) sh.rect(x, y + Math.floor(rnd() * 4), 1, 8);
const shCols = L.detectColumns(sh.img, { top: 0.07, bottom: 0.06 });
check('치우친 2단 스캔도 2단으로 검출', shCols.length === 2 && shCols[0].x1 <= 400 && shCols[1].x0 >= 600, JSON.stringify(shCols));
// 글이 몇 줄 없는 1단 쪽: 선택지 사이 공백을 단으로 오인하지 않는다
const sp = canvas(1190, 1684);
// 앞 쪽에서 이어진 선택지 한 줄만 있는 쪽: "① 3      ② 5      ③ 7"
for (const [x0, w] of [[130, 60], [330, 60], [530, 60]]) for (let x = x0; x < x0 + w; x++) if (rnd() < 0.3) sp.rect(x, 300 + Math.floor(rnd() * 4), 1, 10);
const spCols = L.detectColumns(sp.img, { top: 0.07, bottom: 0.06 });
check('글이 한 줄뿐인 쪽은 선택지 사이 공백을 단으로 나누지 않음', spCols.length === 1 && spCols[0].x0 <= 140 && spCols[0].x1 >= 580, JSON.stringify(spCols));

// 글자가 빽빽한 2단 쪽 (행마다 단 폭의 절반 이상이 잉크): 행을 버리지 않아야 단 끝(번호·줄 끝)을 지킨다
const dn = canvas(1190, 1684);
const strokes = (img, x0, x1, y, h, density) => { for (let x = x0; x < x1;) { const w = 1 + Math.floor(rnd() * 5); if (rnd() < density) img.rect(x, y, Math.min(w, x1 - x), h); x += w; } };
for (const [x0, x1] of [[81, 553], [621, 1102]]) for (let y = 150; y < 1500; y += 30) { strokes(dn, x0, x0 + 24, y, 16, 0.9); strokes(dn, x0 + 36, x1, y, 16, 0.6); }
const dnCols = L.detectColumns(dn.img, { top: 0.07, bottom: 0.06 });
check('빽빽한 2단 글자 쪽도 단 경계(81~553 / 621~1102)를 그대로 검출', dnCols.length === 2 && Math.abs(dnCols[0].x0 - 81) <= 2 && Math.abs(dnCols[0].x1 - 553) <= 3 && Math.abs(dnCols[1].x0 - 621) <= 3 && Math.abs(dnCols[1].x1 - 1102) <= 3, JSON.stringify(dnCols));
// 가운데 여백을 가로지르는 사진(넓은 회색 영역)이 있어도 단을 합치지 않는다
const ph = canvas(1190, 1684);
for (const [x0, x1] of [[81, 553], [621, 1102]]) for (let y = 150; y < 1500; y += 30) strokes(ph, x0, x1, y, 14, 0.5);
ph.rect(300, 700, 600, 260, 120);
const phCols = L.detectColumns(ph.img, { top: 0.07, bottom: 0.06 });
check('가운데를 가로지르는 사진이 있어도 2단 유지', phCols.length === 2 && phCols[0].x1 <= 600 && phCols[1].x0 >= 580, JSON.stringify(phCols));

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
