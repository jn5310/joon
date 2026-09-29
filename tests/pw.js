// Playwright 불러오기: 이 폴더나 전역에 설치된 'playwright'를 먼저 찾고, 없으면 PLAYWRIGHT_PATH(또는 개발 샌드박스의 경로)를 쓴다.
// 브라우저가 기본 위치에 없으면 PLAYWRIGHT_BROWSERS_PATH를 지정한다 (예: /opt/playwright).
const candidates = ['playwright', process.env.PLAYWRIGHT_PATH, '/root/.nvm/versions/node/v22.23.2/lib/node_modules/@playwright/mcp/node_modules/playwright'].filter(Boolean);
let pw = null;
for (const c of candidates) {
  try { pw = require(c); break; } catch { /* 다음 후보 */ }
}
if (!pw) throw new Error('Playwright를 찾을 수 없습니다. `npm i -D playwright && npx playwright install chromium` 후 다시 실행하거나 PLAYWRIGHT_PATH를 지정하세요.');
module.exports = pw;
