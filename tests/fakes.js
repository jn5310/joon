// 네트워크가 막힌 샌드박스에서 CDN 라이브러리 대신 쓰는 가짜 구현 (테스트 전용, 저장소에 포함하지 않음)

// --- 가짜 pdf.js: "PDF" 파일 내용은 JSON {pages:[{items:[{str,x,y,size}]}]} ---
exports.fakePdfjs = `
const W = 595, H = 842;
const mc = new OffscreenCanvas(10, 10).getContext('2d');
const measure = (s, size) => { mc.font = size + 'px sans-serif'; return mc.measureText(s).width; };
export const GlobalWorkerOptions = {};
export function getDocument({ data }) {
  const spec = JSON.parse(new TextDecoder().decode(data));
  return { promise: Promise.resolve({
    numPages: spec.pages.length,
    async getPage(n) {
      const pg = spec.pages[n - 1];
      return {
        getViewport({ scale }) {
          return { width: W * scale, height: H * scale, scale, convertToViewportPoint: (x, y) => [x * scale, (H - y) * scale] };
        },
        render({ canvasContext: ctx, viewport }) {
          if (pg.throwOnRender) throw new Error('테스트용 렌더링 실패');
          const s = viewport.scale;
          for (const r of pg.rects || []) { ctx.fillStyle = r.color || '#000'; ctx.fillRect(r.x * s, (H - r.y - r.h) * s, r.w * s, r.h * s); }
          ctx.fillStyle = '#000';
          for (const it of pg.items) { ctx.font = (it.size * s) + 'px sans-serif'; ctx.fillText(it.str, it.x * s, (H - it.y) * s); }
          return { promise: Promise.resolve() };
        },
        async getTextContent() {
          if (pg.noText) return { items: [] };
          return { items: pg.items.map((it) => ({ str: it.str, transform: [it.size, 0, 0, it.size, it.x, it.y], width: measure(it.str, it.size), height: it.size })) };
        },
      };
    },
  }) };
}
`;

// --- 가짜 jsPDF: 호출 기록만 남김 ---
exports.fakeJspdf = `
window.jspdf = { jsPDF: class {
  constructor(o) { this.ops = [['new', o]]; this.pages = 1; }
  setFontSize(v) { this.ops.push(['fontSize', v]); }
  setTextColor(v) { this.ops.push(['textColor', v]); }
  setDrawColor(v) { this.ops.push(['drawColor', v]); }
  setLineWidth(v) { this.ops.push(['lineWidth', v]); }
  text(t, x, y, o) { this.ops.push(['text', t, x, y]); }
  line(...a) { this.ops.push(['line', ...a]); }
  addPage() { this.pages++; this.ops.push(['addPage']); }
  addImage(img, fmt, x, y, w, h) {
    if (typeof img !== 'string' || !img.startsWith('data:image/')) throw new Error('bad image');
    if (![x, y, w, h].every(Number.isFinite)) throw new Error('bad geometry ' + [x, y, w, h]);
    this.ops.push(['image', fmt, x, y, w, h, this.pages]);
  }
  save(name) { window.__pdf = { name, pages: this.pages, ops: this.ops }; }
} };
`;
