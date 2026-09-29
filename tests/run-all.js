// 모든 회귀 테스트를 차례로 실행한다: node tests/run-all.js  (일부만: node tests/run-all.js ai-extract-unit.js run.js)
// 브라우저 테스트는 Playwright(Chromium)가 필요하다 (tests/pw.js 참고). 인터넷은 필요 없다 (CDN·AI API는 가짜로 대신한다).
const { spawnSync } = require('child_process');
const path = require('path');
const SUITES = [
  'classify-unit.js', 'segment-unit.js', 'scan-recognition-unit.js', 'review-fixes-unit.js',
  'recognition-round2-unit.js', 'recognition-round3-unit.js', 'recognition-round4-unit.js', 'ai-extract-unit.js',
  'run.js', 'stop-run.js', 'stability-run.js', 'storage-run.js', 'storage-integrity-run.js',
  'smart-ocr-run.js', 'ocr-fallback-run.js', 'restore-safety-run.js', 'ai-extract-run.js',
];
const pick = process.argv.slice(2);
let bad = 0, total = 0, passed = 0;
for (const s of pick.length ? pick : SUITES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, s)], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 15 * 60000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const m = out.match(/(\d+)\/(\d+) 통과\s*$/);
  const fails = out.split('\n').filter((l) => l.startsWith('FAIL'));
  if (m) { passed += +m[1]; total += +m[2]; }
  const ok = r.status === 0 && m && m[1] === m[2];
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${s.padEnd(28)} ${m ? `${m[1]}/${m[2]}` : '(결과 없음)'}`);
  if (!ok) console.log((fails.length ? fails : out.trim().split('\n').slice(-8)).map((l) => '      ' + l.slice(0, 240)).join('\n'));
}
console.log(`\n합계 ${passed}/${total} 통과${bad ? ` · 실패한 묶음 ${bad}개` : ''}`);
process.exit(bad ? 1 : 0);
