# Math Finder 회귀 테스트

앱 코드(`../index.html`, `../part1.js`~`../part3.js`)를 그대로 불러와 검사합니다. 인터넷은 필요 없습니다. pdf.js, jsPDF, KaTeX와 AI API(Gemini, Claude, OpenAI, Ollama)는 가짜 응답으로 대신합니다.

```bash
node tests/run-all.js                      # 전체 (약 10분)
node tests/run-all.js ai-extract-unit.js   # 일부만
```

- `*-unit.js` 테스트는 Node만 있으면 돌아갑니다.
- `*-run.js` 테스트는 Playwright와 Chromium이 필요합니다.
  - 설치: `npm i -D playwright && npx playwright install chromium`
  - 이미 설치돼 있으면 `PLAYWRIGHT_PATH` 환경 변수로 모듈 위치를, `PLAYWRIGHT_BROWSERS_PATH`로 브라우저 위치를 알려 주면 됩니다.

| 파일 | 다루는 것 |
|---|---|
| `classify-unit.js` | 단원 유형 자동 분류 |
| `segment-unit.js`, `scan-recognition-unit.js`, `review-fixes-unit.js`, `recognition-round2~4-unit.js` | 문제 번호 인식, 여백으로 찾는 문제 경계, 개념 쪽과 해설 이어붙이기, 예제·유제 |
| `ai-extract-unit.js` | AI 판정: 지정 시스템 프롬프트, 제공자별 요청, LaTeX JSON 읽기와 복구, 1~5단계를 등급으로 환산, 시험지 고르기 |
| `run.js` | 책 추가부터 검토, 분류, 난이도, 시험지 PDF, 백업까지 전체 흐름 |
| `stop-run.js`, `stability-run.js` | 처리 중지, 부분 결과 보존, 동시 실행과 잠금 |
| `storage-run.js`, `storage-integrity-run.js`, `restore-safety-run.js` | 대용량 폴더 저장, 파일 무결성, 백업·복원 안전성 |
| `smart-ocr-run.js`, `ocr-fallback-run.js` | 스캔본 OCR 판단과 OCR 실패 대비 |
| `ai-extract-run.js` | AI 판정 화면: 4개 제공자, 검토 표시, JSON 내려받기, 다시 판정 표시, 수식 미리보기 |

`fakes.js`는 가짜 pdf.js·jsPDF이고, `gen.js`는 테스트용 문제집과 해설지를 만듭니다. `ocr-system-prompt.txt`에는 AI 판정 시스템 프롬프트 원문이 들어 있으며, 앱의 문구와 글자 하나까지 같은지 비교합니다.
