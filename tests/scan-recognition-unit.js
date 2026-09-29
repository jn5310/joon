// 실제 스캔 실패 형태를 닮은 시각 경계·희소 OCR 회귀 테스트 (Node, 저장소 외부)
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = { window: {} }; ctx.window.window = ctx.window; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../part1.js'), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const { layout: L, segment: S } = ctx.window.M;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

function pageImage(W = 1000, H = 1200) {
  const data = new Uint8ClampedArray(W * H * 4); data.fill(255);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const rect = (x, y, w, h, shade = 20) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4; data[i] = data[i + 1] = data[i + 2] = shade;
    }
  };
  const columns = [{ x0: 50, x1: 480 }, { x0: 520, x1: 950 }];
  for (const c of columns) {
    for (const start of [110, 430, 760]) {
      // 번호 배지 + 5줄 본문 + 그래프. 문제 사이에는 큰 공백
      rect(c.x0 + 2, start, 16, 18); rect(c.x0 + 28, start + 2, 260, 7);
      for (let k = 1; k < 5; k++) rect(c.x0 + 28, start + 25 + k * 20, 250 - k * 13, 6);
      rect(c.x0 + 140, start + 145, 120, 3, 80); rect(c.x0 + 195, start + 115, 3, 85, 80);
    }
  }
  // 페이지 가장자리 먼지: crop/블록 경계를 넓히면 안 됨
  rect(1, 300, 1, 1); rect(W - 2, 900, 1, 1);
  return { image: { data, width: W, height: H }, columns };
}
const template = pageImage();
const starts = L.detectBlockStarts(template.image, template.columns, { top: .05, bottom: .05 });
check('한 쪽 2단의 문제 블록 6개를 번호 OCR 없이 시각 검출', starts.length === 6, JSON.stringify(starts.map((s) => [s.col, s.y0])));
check('각 단에서 위에서 아래 순서 유지', [0, 1].every((c) => starts.filter((s) => s.col === c).map((s) => s.y0).join(',') === '110,430,760'));

// 사용자 증상: 130쪽에서 OCR 번호는 단 7개. 시각 경계가 나머지를 보완해야 한다.
const pages = Array.from({ length: 130 }, (_, i) => ({
  index: i + 1, width: 1000, height: 1200, columns: template.columns,
  visualStarts: starts.map((s) => ({ ...s })), lines: [], ocr: true,
}));
for (let k = 0; k < 7; k++) {
  const pi = k * 20, s = starts[0], n = k + 1;
  pages[pi].lines.push({ text: `${n}. 문제`, x0: 52, y0: s.y0, x1: 180, y1: s.y0 + 18, firstWord: { text: `${n}.`, x0: 52, y0: s.y0, x1: 70, y1: s.y0 + 18 }, confidence: 90, source: 'ocr' });
}
const t0 = Date.now();
const items = S.segmentPages(pages, { top: .05, bottom: .05, visualFallback: true, continuation: true });
const ms = Date.now() - t0;
check('130쪽·OCR 번호 7개여도 시각 경계로 700개 이상 문제 보존', items.length >= 700, `items=${items.length}`);
check('시각 추정 문제에 detection 표시', items.filter((x) => x.detection?.inferred).length >= 690, `inferred=${items.filter((x) => x.detection?.inferred).length}`);
const maxFragment = Math.max(...items.map((x) => x.fragments[0].y1 - x.fragments[0].y0));
check('번호 하나만 놓쳐도 앞 문제에 페이지 전체를 합치지 않음', maxFragment < 1200 * .45, `max fragment=${maxFragment}`);
check('130쪽 분할 계산 1초 이내', ms < 1000, `${ms}ms`);

// 서로 멀리 떨어진 정상 OCR run을 하나만 버리지 않는다.
const sparse = [
  { page: 1, col: 0, num: 1, style: 'plain', explicit: .78, xRel: .01, x0: 50, y0: 100, y1: 120, h: 20, score: 1.2 },
  { page: 1, col: 0, num: 2, style: 'plain', explicit: .78, xRel: .01, x0: 50, y0: 300, y1: 320, h: 20, score: 1.2 },
  { page: 50, col: 0, num: 40, style: 'plain', explicit: .78, xRel: .01, x0: 50, y0: 100, y1: 120, h: 20, score: 1.2 },
  { page: 50, col: 0, num: 41, style: 'plain', explicit: .78, xRel: .01, x0: 50, y0: 300, y1: 320, h: 20, score: 1.2 },
  { page: 100, col: 0, num: 1, style: 'plain', explicit: .78, xRel: .01, x0: 50, y0: 100, y1: 120, h: 20, score: 1.2 },
  { page: 100, col: 0, num: 2, style: 'plain', explicit: .78, xRel: .01, x0: 50, y0: 300, y1: 320, h: 20, score: 1.2 },
];
check('책 전체에서 끊어진 번호 run 3개를 모두 보존', S.selectAnchors(sparse).length === 6);

// 번호 표기 확장
const formats = [['① 다음', 1], ['⑳ 마지막', 20], ['❺ 문제', 5], ['문제 12', 12], ['예제 3', 3], ['□7. 함수', 7], ['O8. OCR', 8], ['I. OCR', 1]];
const bad = formats.map(([text, n]) => [text, n, S.parseAnchor({ text, firstWord: { text: text.split(' ')[0] } })?.num]).filter(([, n, got]) => n !== got);
check(`원문자·라벨·박스·OCR 혼동 번호 ${formats.length}개 인식`, !bad.length, JSON.stringify(bad));

// 먼지 제거 + 얇은 그래프 보존 crop
const box = L.trimBox(template.image, { x0: 0, y0: 80, x1: 500, y1: 350 }, 5);
check('페이지 끝 먼지는 버리고 본문·그래프만 최소 여백 crop', box.x0 >= 45 && box.x1 < 490 && box.y0 >= 100 && box.y1 <= 320, JSON.stringify(box));

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
