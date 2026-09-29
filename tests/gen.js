// 테스트용 문제집/해설지 "PDF"(가짜 pdf.js가 읽는 JSON) 생성
const COLS = [40, 310];
const pad2 = (n) => String(n).padStart(2, '0');
const BODY = [
  ['함수 f(x)=x^2-4x+3 에서', 'f(2)의 값은?'],
  ['수열 {a_n}이 a_1=2 이고', '모든 자연수 n에 대하여', 'a_(n+1)=a_n+3 일 때', 'a_10의 값은?'],
  ['다음 조건을 만족시키는', '최고차항의 계수가 1인', '삼차함수 f(x)에 대하여', '(가) f(0)=0', '(나) 모든 실수 x에 대하여', 'f(x)>=-4 이다', 'f(3)의 최댓값은?'],
  ['점수의 합이 14점일 때', '경우의 수를 구하시오.'],
];
function problemBook() {
  const pages = [];
  let n = 1;
  for (let p = 0; p < 3; p++) {
    const items = [
      { str: '수학I 유형 연습', x: 40, y: 815, size: 11 },
      { str: String(p + 1), x: 295, y: 20, size: 9 },
    ];
    for (const cx of COLS) {
      let y = 760;
      for (let k = 0; k < 2; k++, n++) {
        const body = BODY[(n - 1) % BODY.length];
        items.push({ str: pad2(n), x: cx, y, size: 12 });
        body.forEach((t, i) => items.push({ str: t, x: cx + 22, y: y - i * 18, size: 10 }));
        const pts = body.length >= 7 ? '[4점]' : '[3점]';
        items.push({ str: pts, x: cx + 200, y: y - body.length * 18, size: 10 });
        y -= body.length * 18 + 170;
      }
    }
    pages.push({ items, rects: [{ x: 297, y: 60, w: 0.6, h: 720 }] });
  }
  return { pages };
}
const ANS = ['①', '②', '③', '④', '⑤'];
function solutionBook() {
  const pages = [];
  let n = 1;
  for (let p = 0; p < 2; p++) {
    const items = [{ str: '정답과 해설', x: 40, y: 815, size: 11 }];
    COLS.forEach((cx, ci) => {
      let y = 760;
      if (p === 1 && ci === 0) { // 앞 쪽 6번 해설이 이어지는 부분
        ['따라서 구하는 값은', '12 이다.'].forEach((t, i) => items.push({ str: t, x: cx + 22, y: y - i * 16, size: 10 }));
        y -= 80;
      }
      for (let k = 0; k < 3; k++, n++) {
        const len = 2 + ((n * 7) % 5);
        items.push({ str: pad2(n), x: cx, y, size: 12 });
        items.push({ str: `정답 ${ANS[n % 5]}`, x: cx + 22, y, size: 10 });
        for (let i = 1; i <= len; i++) items.push({ str: `풀이 과정 ${i}번째 줄, 식을 정리하면 다음과 같다`, x: cx + 22, y: y - i * 16, size: 10 });
        y -= (len + 1) * 16 + 50;
      }
    });
    pages.push({ items });
  }
  return { pages };
}
module.exports = { problemBook, solutionBook };
