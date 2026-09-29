// 유형 분류 규칙 단위 테스트 (Node, 저장소 외부)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ctx = { window: {} };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../part1.js'), 'utf8').replace(/^var M = /m, 'var M = window.M = '), ctx);
const C = ctx.window.M.classify;
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); ok ? pass++ : fail++; };

const cases = [
  ['로그함수 y=log_2 x의 그래프를 x축의 방향으로 평행이동', '지수함수와 로그함수'],
  ['log_2 8 + log_2 4의 값은?', '지수와 로그'],
  ['0 ≤ x < 2π에서 sin x + cos x 의 최댓값', '삼각함수'],
  ['등차수열 {a_n}의 공차가 3일 때 a_10의 값', '수열'],
  ['Σ_{k=1}^{10} (2k+1)의 값', '수열'],
  ['lim_{n→∞} (3n+1)/(n+2)의 값', '수열의 극한'],
  ['실수 전체의 집합에서 미분가능한 함수 f(x)=x^3-3x의 극댓값', '다항함수의 미분'],
  ["곡선 y=e^x sin x 위의 점에서의 접선의 기울기, f'(x)", '여러 가지 함수의 미분'],
  ['함수 f(x)=ln x / x 의 도함수', '여러 가지 함수의 미분'],
  ['정적분 ∫_0^1 (x^2+1) dx의 값', '다항함수의 적분'],
  ['곡선 y=x^2-2x와 직선 y=x로 둘러싸인 부분의 넓이', '다항함수의 적분'],
  ['치환적분을 이용하여 ∫ x e^(x^2) dx', '여러 가지 함수의 적분'],
  ['확률변수 X의 평균 E(X)와 분산', '통계'],
  ['정규분포 N(50, 4^2)을 따르는 모집단에서 표본평균', '통계'],
  ['두 사건 A, B에 대하여 P(A∩B)=1/3일 때 조건부확률', '확률'],
  ['주사위를 두 번 던질 때 나온 눈의 합이 7일 확률', '확률'],
  ['다항식 P(x)를 x-1로 나누었을 때의 나머지', '다항식'],
  ['타원 x^2/4+y^2=1의 두 초점', '이차곡선'],
  ['두 벡터 a, b의 내적', '평면벡터'],
  ['좌표공간에서 평면 α 위로의 정사영의 넓이', '공간도형과 공간좌표'],
  ['집합 A={1,2,3}의 부분집합의 개수', '집합과 명제'],
  ['명제 p→q가 참일 때 필요조건', '집합과 명제'],
  ['합성함수 (f∘g)(x)와 역함수', '함수와 그래프'],
  ['이차방정식의 두 근과 계수의 관계, 판별식', '방정식과 부등식'],
  ['원 x^2+y^2=4 위의 점과 직선 사이의 거리', '도형의 방정식'],
  ['5명을 일렬로 세우는 경우의 수', '경우의 수'],
  ['행렬 A의 (1,2) 성분', '행렬'],
  ['함수의 극한 lim_{x→1} (x^2-1)/(x-1)', '함수의 극한과 연속'],
  ['프로그램으로 계산한 값', null],
  ['', null],
  // 리뷰에서 찾은 띄어쓰기·대소문자 오인 사례
  ['x축에 수직으로 그은 선분의 길이', null],
  ['다음 주어진 수 중에서 가장 큰 것은?', null],
  ['점 P의 이동 경로의 길이', null],
  ['조건을 만족하므로 그 함수의 그래프를 그리면', null],
  ["직선 y=x에 대하여 대칭이동한 점을 A'(a, b)라 할 때", '도형의 방정식'],
  ['함수 f: X → X가 다음 조건을 만족시킬 때 치역', '함수와 그래프'],
  ['로그 함수 y=log_3 x', '지수함수와 로그함수'],
  // 띄어 쓰거나 줄바꿈으로 끊긴 용어 (낱말 첫머리에서 시작하면 인정)
  ['평균 변화율을 구하시오', '다항함수의 미분'],
  ['평균변\n화율과 순간변화율', '다항함수의 미분'],
  ['산술 평균과 기하 평균의 관계를 이용하여', '집합과 명제'],
  ['나머지 정리를 이용하여 상수 a의 값', '다항식'],
  ['인수 정리에 의하여', '다항식'],
  ['이항 정리를 이용하여 x^3의 계수', '경우의 수'],
  ['p는 q이기 위한 필요 조건이지만 충분 조건은 아니다', '집합과 명제'],
  ['곡선의 변곡\n점의 좌표', '여러 가지 함수의 미분'],
  ['매개 변수로 나타낸 곡선', '여러 가지 함수의 미분'],
  ['하므로 그 함수의 값은', null],
];
const wrong = cases.map(([text, want]) => [text, want, C.scoreProblem({ text }, null, '').type]).filter(([, want, got]) => want !== got);
check(`텍스트 유형 판정 ${cases.length}개 사례`, !wrong.length, JSON.stringify(wrong));

// 해설 글자는 절반 가중치로 보탠다
check('해설 텍스트도 근거로 사용', C.scoreProblem({ text: '다음 값을 구하시오.' }, { text: '등비수열의 공비를 r이라 하면' }, '').type === '수열');
// 과목 가산점: 동점이면 책 과목 유형 우선
check('동점이면 책 과목 유형 우선', C.scoreProblem({ text: '포물선과 직선으로 둘러싸인 넓이' }, null, '수학II').type === '다항함수의 적분');
check('과목 밖이라도 강한 근거는 유지', C.scoreProblem({ text: '5명을 일렬로 세우는 경우의 수' }, null, '수학I').type === '경우의 수');
check('수학II 책은 초월함수 잡음으로 미적분 이동 안 함', C.scoreProblem({ text: 'f(x)=x^3의 도함수, 접선 sin' }, null, '수학II').type === '다항함수의 미분');
check('수학II 책: "수직으로 그은"을 초월함수로 보지 않음', C.scoreProblem({ text: 'f(x)=x^2+ax를 미분하면 … x축에 수직으로 그은 선분' }, null, '수학II').type === '다항함수의 미분');
check('수학II 책은 eˣ·ln 규칙을 끔', !C.scoreProblem({ text: '미분 e^x ln x' }, null, '수학II').reasons.some((r) => r === 'eˣ' || r === 'ln'));
const cross = C.scoreProblem({ text: 'f(x)=x^3-3x의 극댓값' }, { text: "f'(x)=0 이므로 그 값은 2" }, '');
check('해설의 "…이므로 그"를 로그로 오인하지 않음', cross.type === '다항함수의 미분', JSON.stringify(cross));
const crossInt = C.scoreProblem({ text: '정적분 ∫_0^2 (3x^2-2x) dx의 값' }, { text: '계산하면 8-4 이므로 그 값은 4' }, '');
check('정적분 해설의 "…이므로 그"도 다항함수의 적분 유지', crossInt.type === '다항함수의 적분', JSON.stringify(crossInt));

// 책 단위 분류: 약한 문제는 앞뒤 문제로 보정
const probs = [
  { id: 'a', section: 1, number: 1, text: '값을 구하시오.' },
  { id: 'b', section: 1, number: 2, text: '등차수열의 공차' },
  { id: 'c', section: 1, number: 3, text: '값을 구하시오.' },
  { id: 'd', section: 1, number: 4, text: '등비수열의 공비' },
  { id: 'e', section: 1, number: 5, text: '값을 구하시오.' },
  { id: 'f', section: 1, number: 6, text: '주사위를 던질 때 확률' },
  { id: 'g', section: 2, number: 1, text: '값을 구하시오.' },
];
const book = C.classifyBook(probs, new Map(), '');
const got = probs.map((p) => `${p.id}:${book.get(p.id).type}/${book.get(p.id).source}`).join(' ');
check('앞뒤 문제 보정(단원 경계 존중)', got === 'a:수열/neighbor b:수열/rule c:수열/neighbor d:수열/rule e:null/null f:확률/rule g:null/null', got);

// 우선순위: 수동 > AI > 자동
const auto = { type: '수열', source: 'rule', reasons: ['수열'] };
check('수동 지정 최우선', C.effectiveType({ typeManual: '내 유형', typeLLM: '확률' }, auto).type === '내 유형');
check('AI 유형이 자동보다 우선', C.effectiveType({ typeLLM: '확률' }, auto).source === 'AI');
check('예전 AI 단원명에서 유형 복원', C.effectiveType({ unit: '삼각함수의 그래프', subjectLLM: '수학I' }, auto).type === '삼각함수');
check('예전 AI 단원명은 책 과목으로 보정', C.effectiveType({ unit: '삼각함수의 극한' }, auto, '미적분').type === '여러 가지 함수의 미분');
check('근거 없으면 미분류', C.effectiveType({}, { type: null }).type === '미분류');

// AI 응답 정규화
const norm = [
  ['수열의 극한', '미적분', '수열의 극한'], ['미분법', '미적분', '여러 가지 함수의 미분'], ['도함수의 활용', '미적분', '여러 가지 함수의 미분'],
  ['도함수의 활용', '수학II', '다항함수의 미분'], ['순열과 조합', '확률과 통계', '경우의 수'], ['미분류', '', null], ['null', '', null],
  ['삼각함수의 그래프', '수학Ⅰ', '삼각함수'], ['지수함수와로그함수', '', '지수함수와 로그함수'],
  ['삼각함수의 극한', '미적분', '여러 가지 함수의 미분'], ['지수함수와 로그함수의 극한', '미적분', '여러 가지 함수의 미분'],
  ['삼각함수의 덧셈정리', '미적분', '여러 가지 함수의 미분'], ['극한', '미적분', '여러 가지 함수의 미분'],
  ['여러 가지 미분법', null, '여러 가지 함수의 미분'], ['등비급수', '미적분', '수열의 극한'],
];
const badNorm = norm.map(([v, s, want]) => [v, s, want, C.normalizeType(v, s)]).filter(([, , want, got]) => want !== got);
check(`AI 유형 정규화 ${norm.length}개 사례`, !badNorm.length, JSON.stringify(badNorm));

const order = ['미분류', '나만의 유형', '확률', '다항식'].sort(C.compareTypes).join(',');
check('유형 정렬: 표준 → 직접 만든 유형 → 미분류', order === '다항식,확률,나만의 유형,미분류', order);

// 성능: 2,000문제 분류
const many = Array.from({ length: 2000 }, (_, i) => ({ id: 'p' + i, section: 1 + Math.floor(i / 100), number: 1 + (i % 100), text: cases[i % cases.length][0].repeat(4) }));
const t0 = Date.now();
C.classifyBook(many, new Map(), '수학I');
const ms = Date.now() - t0;
check('2,000문제 분류 1초 이내', ms < 1000, `${ms}ms`);

console.log(`\n${pass}/${pass + fail} 통과`);
process.exit(fail ? 1 : 0);
