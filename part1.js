// Math Finder part1.js — 이 줄부터 끝까지 전부 복사
var M = window.M || (window.M = {});
M.db = (() => {
const DB_NAME = 'mathbook';
const DB_VERSION = 2;
let dbPromise = null;
function open() {
if (dbPromise) return dbPromise;
const p = new Promise((resolve, reject) => {
const req = indexedDB.open(DB_NAME, DB_VERSION);
req.onupgradeneeded = () => {
const db = req.result;
if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
if (!db.objectStoreNames.contains('pages')) {
const s = db.createObjectStore('pages', { keyPath: 'id' });
s.createIndex('bookId', 'bookId');
}
if (!db.objectStoreNames.contains('items')) {
const s = db.createObjectStore('items', { keyPath: 'id' });
s.createIndex('bookId', 'bookId');
}
if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'id' });
};
req.onsuccess = () => {
const db = req.result;
db.onversionchange = () => { db.close(); dbPromise = null; }; // 다른 탭이 새 버전을 열면 연결을 넘겨준다
resolve(db);
};
req.onerror = () => reject(req.error);
});
dbPromise = p;
p.catch(() => { if (dbPromise === p) dbPromise = null; }); // 열기에 실패하면 다음 호출에서 다시 시도
return p;
}
function wrap(req) {
return new Promise((resolve, reject) => {
req.onsuccess = () => resolve(req.result);
req.onerror = () => reject(req.error);
});
}
/** 트랜잭션이 실제로 저장(commit)되면 끝난다. 용량 초과 등으로 취소되면 실패한다 */
function done(t) {
return new Promise((resolve, reject) => {
t.oncomplete = () => resolve();
t.onabort = () => reject(t.error || new DOMException('저장이 취소되었습니다.', 'AbortError'));
t.onerror = (ev) => reject(ev?.target?.error || t.error || new Error('저장 실패'));
});
}
async function write(names, fn) {
const db = await open();
const t = db.transaction(names, 'readwrite');
let failure = null;
const fail = (e) => { failure = failure || e; try { t.abort(); } catch { /* 이미 끝남 */ } };
try { fn(t, fail); } catch (e) { fail(e); }
try { await done(t); } catch (e) { throw failure || e; }
if (failure) throw failure;
}
async function store(name) {
const db = await open();
return db.transaction(name, 'readonly').objectStore(name);
}
function put(name, value) {
return write(name, (t) => { t.objectStore(name).put(value); });
}
function putMany(name, values) {
return write(name, (t) => { const s = t.objectStore(name); for (const v of values) s.put(v); });
}
function del(name, id) {
return write(name, (t) => { t.objectStore(name).delete(id); });
}
/** update의 fn이 이 값을 돌려주면 아무것도 쓰지 않는다 (예: 그사이 다른 편집으로 바뀐 기록) */
const SKIP = Symbol('skip');
/** 한 트랜잭션 안에서 다시 읽고 고쳐 쓴다 (동시에 저장하는 다른 작업의 변경을 덮어쓰지 않음). 기록이 없거나 SKIP이면 null */
async function update(name, id, fn) {
let result = null;
await write(name, (t, fail) => {
const s = t.objectStore(name);
const req = s.get(id);
req.onsuccess = () => {
if (!req.result) return;
try {
const r = fn(req.result);
if (r === SKIP) return;
result = r || req.result; s.put(result);
} catch (e) { fail(e); }
};
});
return result;
}
/** 한 트랜잭션에서 읽고 지운다. 지운 기록(없으면 null)을 돌려준다 */
async function take(name, id) {
let old = null;
await write(name, (t) => {
const s = t.objectStore(name);
const req = s.get(id);
req.onsuccess = () => { old = req.result || null; if (old) s.delete(id); };
});
return old;
}
/** 여러 기록을 한 트랜잭션에서 각각 다시 읽어 고쳐 쓴다. 없는 기록은 건너뛴다. 반환: 고친 개수 */
async function updateMany(name, ids, fn) {
let n = 0;
await write(name, (t, fail) => {
const s = t.objectStore(name);
for (const id of ids) {
const req = s.get(id);
req.onsuccess = () => {
if (!req.result) return;
try { s.put(fn(req.result) || req.result); n++; } catch (e) { fail(e); }
};
}
});
return n;
}
/**
* 한 책의 한 종류(문제/해설) 항목을 한 번에 바꾼다. 중간에 실패하면 기존 항목이 그대로 남는다.
* 이미지를 읽지 않도록 키만 본다: 항목 id는 종류 첫 글자(p/s)로 시작하고, knownIds로 알려 준 id도 지운다.
*/
function replaceItems(bookId, kind, items, knownIds = []) {
return write('items', (t, fail) => {
const s = t.objectStore('items');
const req = s.index('bookId').getAllKeys(bookId);
req.onsuccess = () => {
try {
const drop = new Set(knownIds);
for (const key of req.result) if (String(key).startsWith(kind[0])) drop.add(key);
for (const key of drop) s.delete(key);
for (const it of items) s.put(it);
} catch (e) { fail(e); }
};
});
}
/** 책의 문제·해설 개수 (이미지를 읽지 않고 키만 센다) */
async function kindCounts(bookId) {
const keys = await wrap((await store('items')).index('bookId').getAllKeys(bookId));
const c = { problem: 0, solution: 0 };
for (const k of keys) { const s = String(k); if (s.startsWith('p')) c.problem++; else if (s.startsWith('s')) c.solution++; }
return c;
}
/** 기록을 하나씩 읽어 fn에 넘긴다 (전체를 한꺼번에 메모리에 올리지 않음). fn은 동기 함수여야 한다 */
async function forEach(name, fn) {
const db = await open();
return new Promise((resolve, reject) => {
const t = db.transaction(name, 'readonly');
const req = t.objectStore(name).openCursor();
req.onsuccess = () => {
const c = req.result;
if (!c) return;
try { fn(c.value); } catch (e) { reject(e); try { t.abort(); } catch { /* 이미 끝남 */ } return; }
c.continue();
};
t.oncomplete = () => resolve();
t.onerror = () => reject(t.error);
t.onabort = () => reject(t.error || new Error('읽기가 취소되었습니다.'));
});
}
async function get(name, id) {
return wrap((await store(name)).get(id));
}
async function all(name) {
return wrap((await store(name)).getAll());
}
async function keys(name) {
return wrap((await store(name)).getAllKeys());
}
async function byBook(name, bookId) {
return wrap((await store(name)).index('bookId').getAll(bookId));
}
async function keysByBook(name, bookId) {
return wrap((await store(name)).index('bookId').getAllKeys(bookId));
}
/** 한 책의 기록을 하나씩 fn에 넘긴다 (책 전체를 한꺼번에 메모리에 올리지 않음). fn은 동기 함수여야 한다 */
async function forEachByBook(name, bookId, fn) {
const db = await open();
return new Promise((resolve, reject) => {
const t = db.transaction(name, 'readonly');
const req = t.objectStore(name).index('bookId').openCursor(bookId);
req.onsuccess = () => {
const c = req.result;
if (!c) return;
try { fn(c.value); } catch (e) { reject(e); try { t.abort(); } catch { /* 이미 끝남 */ } return; }
c.continue();
};
t.oncomplete = () => resolve();
t.onerror = () => reject(t.error);
t.onabort = () => reject(t.error || new Error('읽기가 취소되었습니다.'));
});
}
/**
* 책과 그 페이지·항목을 한 트랜잭션으로 지운다 (이미지를 메모리로 읽지 않음).
* 대용량 폴더를 쓴 적이 있으면 같은 트랜잭션에 '폴더 정리 대기' 기록을 남겨, 폴더 연결이 끊겨 있어도 다음 연결 때 지운다.
* 반환: { externalPending } — 외부 폴더 정리가 아직 남았으면 true
*/
async function deleteBook(bookId) {
const external = M.assets ? await M.assets.hasFolder().catch(() => false) : false;
await write(['books', 'pages', 'items', 'settings'], (t, fail) => {
for (const name of ['pages', 'items']) {
const s = t.objectStore(name);
const req = s.index('bookId').getAllKeys(bookId);
req.onsuccess = () => { try { for (const key of req.result) s.delete(key); } catch (e) { fail(e); } };
}
t.objectStore('books').delete(bookId);
if (external) t.objectStore('settings').put({ id: CLEANUP_PREFIX + bookId, kind: 'external-book-cleanup', bookId, at: Date.now() });
});
if (!external) return { externalPending: false };
let r;
try { r = await M.assets.cleanupBook(bookId); } catch (e) { console.warn('외부 이미지 폴더를 지우지 못했습니다. 다음에 폴더를 연결하면 다시 정리합니다.', e); r = { pending: true }; }
return { externalPending: !!r.pending };
}
const CLEANUP_PREFIX = 'cleanup:';
function uid(prefix = '') {
return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
/** 저장 공간 부족 오류인지 */
function isQuotaError(e) {
return !!e && (e.name === 'QuotaExceededError' || /quota/i.test(String(e.message || '')));
}
return { SKIP, CLEANUP_PREFIX, put, update, updateMany, replaceItems, putMany, get, take, del, all, keys, byBook, keysByBook, forEach, forEachByBook, kindCounts, deleteBook, uid, isQuotaError };
})();
/**
* 큰 이미지 저장소. 기본은 IndexedDB Blob(기존 data URL보다 약 25% 작음).
* 데스크톱 Chrome/Edge에서 사용자가 폴더를 연결하면 이미지 파일은 브라우저 quota 밖의 실제 디스크에 저장한다.
*/
M.assets = (() => {
const db = M.db;
const SETTING_ID = 'external-storage';
const ROOT_NAME = 'MathFinderData';
let setting = null, root = null, readyPromise = null;
const isRef = (v) => v && v.storage === 'external-v1';
const safe = (s) => String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
function dataUrlToBlob(url) {
const m = String(url).match(/^data:([^;,]+);base64,(.*)$/s);
if (!m) throw new Error('지원하지 않는 이미지 데이터입니다.');
const bin = atob(m[2]), bytes = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
return new Blob([bytes], { type: m[1] });
}
function blobToDataURL(blob) {
return new Promise((resolve, reject) => {
const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(r.error); r.readAsDataURL(blob);
});
}
function canvasToBlob(canvas, type = 'image/png', quality) {
return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('이미지를 압축할 수 없습니다.')), type, quality));
}
async function permission(handle, request = false) {
if (!handle) return false;
if (!handle.queryPermission) return true; // OPFS/테스트용 handle은 별도 권한 API가 없음
const opts = { mode: 'readwrite' };
if ((await handle.queryPermission?.(opts)) === 'granted') return true;
return request && (await handle.requestPermission?.(opts)) === 'granted';
}
// 폴더 안 구조: MathFinderData/<이 브라우저 저장소의 고유 id>/<책 id>/<파일>.
// 같은 폴더를 다른 브라우저(프로필)와 함께 연결해도 서로의 책 폴더를 정리 대상으로 보지 않는다.
let base = null, pendingCleanup = 0;
const token = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
async function openRoot(handle, ns) {
// MathFinderData 폴더 자체를 골랐으면 그 안에 또 만들지 않는다
const b = handle.name === ROOT_NAME ? handle : await handle.getDirectoryHandle(ROOT_NAME, { create: true });
const r = await b.getDirectoryHandle(safe(ns), { create: true });
base = b; root = r;
}
async function init() {
if (readyPromise) return readyPromise;
readyPromise = (async () => {
try {
setting = await db.get('settings', SETTING_ID);
if (setting?.handle && setting.ns && await permission(setting.handle)) await openRoot(setting.handle, setting.ns);
} catch { root = null; base = null; }
// 폴더 연결이 끊긴 동안 삭제한 책이 있으면 이제 그 이미지 폴더를 지운다 (연결이 없으면 개수만 센다)
try { await processCleanup(); } catch (e) { console.warn('삭제 대기 중인 이미지 폴더를 정리하지 못했습니다.', e); }
return !!root;
})();
return readyPromise;
}
async function connect() {
if (!window.showDirectoryPicker) throw new Error('이 브라우저는 외부 폴더 저장을 지원하지 않습니다. 데스크톱 Chrome 또는 Edge를 사용하세요.');
await init();
const ns = setting?.ns || `mf-${token()}`;
let handle = setting?.handle || null;
// 전에 고른 폴더를 먼저 다시 연다. 권한이 거부됐거나 폴더를 옮기거나 지웠으면 새로 고르게 한다
// (옮긴 폴더를 다시 고르면 그 안의 이미지를 그대로 이어서 쓴다)
if (handle) {
try { if (await permission(handle, true)) await openRoot(handle, ns); else handle = null; }
catch (e) { console.warn('전에 연결한 폴더를 열 수 없어 새로 고릅니다.', e); handle = null; }
}
if (!handle) {
handle = await window.showDirectoryPicker({ id: 'math-finder-storage', mode: 'readwrite', startIn: 'documents' });
if (!await permission(handle, true)) throw new Error('폴더 쓰기 권한이 필요합니다.');
await openRoot(handle, ns);
}
setting = { id: SETTING_ID, enabled: true, handle, ns };
await db.put('settings', setting);
try { await processCleanup(); } catch (e) { console.warn('삭제 대기 중인 이미지 폴더를 정리하지 못했습니다.', e); }
return status();
}
/**
* 전에 연결한 폴더의 접근 권한만 다시 요청한다 (새 폴더를 고르게 하지 않음). 브라우저가 권한 창을 띄우려면 사용자의 클릭 안에서 불러야 한다.
* 반환: 이제 폴더를 읽을 수 있는지
*/
async function reconnect() {
await init();
if (root) return true;
if (!setting?.handle || !setting?.ns) return false;
try {
if (!await permission(setting.handle, true)) return false;
await openRoot(setting.handle, setting.ns);
} catch (e) { console.warn('전에 연결한 폴더를 다시 열지 못했습니다.', e); root = null; base = null; return false; }
try { await processCleanup(); } catch (e) { console.warn('삭제 대기 중인 이미지 폴더를 정리하지 못했습니다.', e); }
return true;
}
async function disconnect() {
setting = { ...(setting || { id: SETTING_ID }), enabled: false };
await db.put('settings', setting); // root는 기존 외부 이미지를 읽기 위해 유지
return status();
}
function status() {
return {
supported: !!window.showDirectoryPicker, connected: !!root, enabled: !!root && !!setting?.enabled,
mode: root && setting?.enabled ? 'external' : 'indexeddb', ns: setting?.ns || null, pendingCleanup,
// 전에 연결한 폴더가 있지만 지금은 접근 권한이 없음 (브라우저를 다시 켜면 권한을 다시 허용해야 하는 경우가 많다)
needsPermission: !!setting?.handle && !!setting?.ns && !root,
};
}
/** 대용량 폴더를 한 번이라도 연결한 적이 있는지 (책을 지울 때 외부 파일 정리 기록이 필요한지) */
async function hasFolder() { await init(); return !!setting?.handle; }
async function bookDir(ref, create = false) {
if (!root) throw new Error('대용량 저장 폴더 연결이 끊겼습니다. 라이브러리에서 같은 폴더를 다시 연결하세요.');
const nsDir = ref.ns && ref.ns !== setting?.ns ? await base.getDirectoryHandle(ref.ns) : root;
return nsDir.getDirectoryHandle(ref.book, { create });
}
async function storeImage(blob, { bookId, role, id }) {
await init();
if (!root || !setting?.enabled) return blob;
const book = await root.getDirectoryHandle(safe(bookId), { create: true });
const ext = /jpe?g/i.test(blob.type) ? 'jpg' : 'png';
// 쓸 때마다 새 파일 이름을 쓴다. 같은 번호 항목이 여럿이거나, 다시 분리가 거부·실패해도 이미 저장된 기록의 파일을 덮어쓰지 않는다.
let name;
for (;;) {
name = `${safe(role)}-${safe(id).slice(0, 40)}-${token()}.${ext}`;
try { await book.getFileHandle(name); } catch { break; } // 없는 이름이면 사용
}
const fh = await book.getFileHandle(name, { create: true });
const w = await fh.createWritable();
try { await w.write(blob); await w.close(); } catch (e) {
try { await w.abort?.(); } catch { /* 이미 닫힘 */ }
try { await book.removeEntry(name); } catch { /* 만들어지지 않음 */ }
throw e;
}
return { storage: 'external-v1', ns: setting.ns, book: safe(bookId), file: name, type: blob.type, size: blob.size };
}
async function getBlob(source) {
if (source instanceof Blob) return source;
if (typeof source === 'string') return dataUrlToBlob(source);
if (!isRef(source)) throw new Error('이미지 저장 위치를 알 수 없습니다.');
await init();
const fh = await (await bookDir(source)).getFileHandle(source.file);
return fh.getFile();
}
async function asDataURL(source) { return typeof source === 'string' ? source : blobToDataURL(await getBlob(source)); }
/** 외부 파일 하나를 지운다. 이미 없으면 성공. 연결이 없거나 실패하면 false (남은 파일은 '저장 공간 최적화' 때 정리) */
async function removeRef(ref) {
if (!isRef(ref)) return true;
await init();
if (!root) return false;
try { await (await bookDir(ref)).removeEntry(ref.file); return true; }
catch (e) { if (e?.name === 'NotFoundError') return true; console.warn('외부 이미지 파일을 지우지 못했습니다.', e); return false; }
}
async function removeRefs(refs) {
let ok = true;
for (const r of refs || []) ok = (await removeRef(r)) && ok;
return ok;
}
async function countCleanup() {
pendingCleanup = (await db.keys('settings')).filter((k) => String(k).startsWith(db.CLEANUP_PREFIX)).length;
return pendingCleanup;
}
async function removeBookDir(bookId) {
if (!root) return false;
try { await root.removeEntry(safe(bookId), { recursive: true }); return true; }
catch (e) { if (e?.name === 'NotFoundError') return true; console.warn('외부 이미지 폴더를 지우지 못했습니다.', e); return false; }
}
/** 삭제 대기 기록을 처리한다. init 안에서도 부르므로 init을 기다리지 않는다. 반환: 남은 개수 */
async function processCleanup() {
if (root) {
for (const key of (await db.keys('settings')).filter((k) => String(k).startsWith(db.CLEANUP_PREFIX))) {
const rec = await db.get('settings', key);
// 백업 가져오기로 같은 책이 되살아났으면 폴더는 두고(참조 없는 파일만 최적화 때 정리) 기록만 지운다
if (rec?.bookId && !(await db.get('books', rec.bookId)) && !(await removeBookDir(rec.bookId))) continue;
await db.del('settings', key);
}
}
return countCleanup();
}
/** 책을 지운 직후 부른다 (정리 기록은 deleteBook 트랜잭션에서 이미 남김) */
async function cleanupBook(bookId) {
await init();
if (!root || !(await removeBookDir(bookId))) { await countCleanup(); return { pending: true }; }
await db.del('settings', db.CLEANUP_PREFIX + bookId);
await countCleanup();
return { pending: false };
}
// 다른 창에서 큰 책을 다시 분리하는 중이면 새 자르기 파일이 한동안 기록에 연결되기 전 상태일 수 있다.
// 그런 파일을 지우지 않도록 하루가 지난 파일만 정리한다 (남은 파일은 다음 최적화 때 정리됨).
const SWEEP_MIN_AGE_MS = 24 * 3600000;
/** 책 폴더에서 어떤 기록도 가리키지 않는 파일을 지운다. 아직 저장(commit) 전일 수 있는 최근 파일은 그대로 둔다. */
async function sweepBook(bookId) {
if (!root) return 0;
let dir;
try { dir = await root.getDirectoryHandle(safe(bookId)); } catch { return 0; }
const used = new Set();
for (const store of ['pages', 'items']) await db.forEachByBook(store, bookId, (r) => { if (isRef(r.image)) used.add(r.image.file); });
const names = [];
for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && !used.has(name)) names.push([name, handle]);
let removed = 0;
for (const [name, handle] of names) {
try {
if (Date.now() - (await handle.getFile()).lastModified < SWEEP_MIN_AGE_MS) continue;
await dir.removeEntry(name); removed++;
} catch { /* 다른 작업이 먼저 지움 */ }
}
return removed;
}
/** 기록 하나의 이미지를 현재 저장 모드로 옮긴다. 반환: 바꿨으면 true */
async function moveRecord(store, key) {
const rec = await db.get(store, key);
if (rec?.image == null) return false;
const external = !!(root && setting?.enabled);
if (!(typeof rec.image === 'string' || (external && !isRef(rec.image)))) return false;
const blob = await getBlob(rec.image);
const role = store === 'pages' ? `page-${rec.kind || 'unknown'}` : `item-${rec.kind || 'unknown'}`;
const image = await storeImage(blob, { bookId: rec.bookId, role, id: store === 'pages' ? rec.index ?? rec.id : `${rec.section ?? 0}-${rec.number ?? rec.id}` });
let previous = null;
const saved = await db.update(store, key, (fresh) => {
// 읽은 뒤 검토 편집·다시 분리로 이미지가 바뀌었으면 옛 이미지로 되돌리지 않는다
if ((fresh.imageId ?? null) !== (rec.imageId ?? null)) return db.SKIP;
previous = fresh.image;
fresh.image = image; fresh.imageBytes = blob.size; fresh.imageId = db.uid('i');
});
if (!saved) { await removeRef(image); return false; } // 기록이 지워졌거나 바뀜: 방금 쓴 파일만 치운다
if (isRef(previous) && previous.file !== image.file) await removeRef(previous);
return true;
}
/**
* 기존 data URL/Blob 이미지를 현재 저장 모드(내부 Blob 또는 외부 폴더)로 한 장씩 옮기고, 기록이 가리키지 않는 외부 파일을 정리한다.
* 책 단위로 opts.acquire(bookId)를 불러 잠그고(false면 그 책은 건너뜀: 다시 분리·삭제 중), 끝나면 opts.release(bookId).
*/
async function optimizeExisting(onProgress, opts = {}) {
await init();
const plan = [];
let total = 0;
for (const bookId of await db.keys('books')) {
const keys = [];
for (const store of ['pages', 'items']) for (const key of await db.keysByBook(store, bookId)) keys.push([store, key]);
plan.push([bookId, keys]); total += keys.length;
}
let done = 0, changed = 0, failed = 0, skippedBooks = 0, removedFiles = 0;
for (const [bookId, keys] of plan) {
if (opts.acquire && !(await opts.acquire(bookId))) { skippedBooks++; done += keys.length; onProgress?.(done, total, changed); continue; }
try {
for (const [store, key] of keys) {
try { if (await moveRecord(store, key)) changed++; }
catch (e) {
// 저장 공간·권한 문제는 다음 기록도 실패하므로 멈춘다. 손상된 이미지 하나는 건너뛴다.
if (db.isQuotaError(e) || e?.name === 'NotAllowedError' || e?.name === 'SecurityError') throw e;
failed++; console.warn('이미지 하나를 옮기지 못했습니다.', store, key, e);
}
done++; onProgress?.(done, total, changed);
// 긴 작업 중 UI가 멈추지 않게 가끔 이벤트 루프에 양보
if (done % 10 === 0) await new Promise((r) => setTimeout(r, 0));
}
removedFiles += await sweepBook(bookId);
} finally { opts.release?.(bookId); }
}
await processCleanup().catch(() => {});
return { total, changed, failed, skippedBooks, removedFiles, pendingCleanup };
}
return { init, connect, reconnect, disconnect, status, hasFolder, storeImage, getBlob, asDataURL, dataUrlToBlob, blobToDataURL, canvasToBlob, removeRef, removeRefs, cleanupBook, processCleanup, sweepBook, optimizeExisting, isRef };
})();
M.layout = (() => {
const DARK = 170; // 기본값. 스캔 페이지는 배경 밝기에 맞춰 동적으로 조정
function luminance(d, i) { return (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; }
function isDark(d, i, threshold = DARK) {
return luminance(d, i) < threshold;
}
/** 페이지 표본의 상위 밝기 중앙값으로 종이 배경을 추정하고, 누런/연한 스캔에도 글자가 잡히게 한다. */
function pageInkThreshold(img) {
const samples = [];
const step = Math.max(4, Math.floor(Math.sqrt((img.width * img.height) / 20000)));
for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) samples.push(luminance(img.data, (y * img.width + x) * 4));
samples.sort((a, b) => a - b);
const background = samples[Math.floor(samples.length * 0.72)] ?? 255;
return Math.max(165, Math.min(225, background - 25));
}
/** x별 잉크 개수 (y0~y1 구간, step 간격 샘플링) */
function columnProfile(img, y0, y1, step = 2, threshold = DARK) {
const { data, width } = img;
const counts = new Uint32Array(width);
for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1); y += step) {
const row = y * width * 4;
for (let x = 0; x < width; x++) if (isDark(data, row + x * 4, threshold)) counts[x]++;
}
return counts;
}
/** y별 잉크 개수 (x0~x1 구간) */
function rowProfile(img, x0, x1, y0 = 0, y1 = img.height, step = 1, threshold = DARK) {
const { data, width } = img;
const counts = new Uint32Array(img.height);
x0 = Math.max(0, x0 | 0); x1 = Math.min(width, x1 | 0);
for (let y = Math.max(0, y0 | 0); y < Math.min(img.height, y1); y++) {
const row = y * width * 4;
let c = 0;
for (let x = x0; x < x1; x += step) if (isDark(data, row + x * 4, threshold)) c++;
counts[y] = c;
}
return counts;
}
/**
* 단(column) 검출. 가운데 여백(또는 얇은 세로 구분선)을 찾아 1~3단으로 나눈다.
* opts.top / opts.bottom: 머리말·꼬리말로 무시할 비율
*/
function detectColumns(img, opts = {}) {
const { width: W, height: H } = img;
const yTop = Math.floor(H * (opts.top ?? 0.07));
const yBot = Math.floor(H * (1 - (opts.bottom ?? 0.06)));
const step = 2;
// 사진/회색 음영이 gutter를 메우더라도 단을 합치지 않도록 column 검출은 어두운 잉크만 사용한다.
const threshold = Math.min(190, pageInkThreshold(img));
const lumAt = (i) => (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
// 글자 획은 짧게 끊긴 잉크다. 한 줄로 길게 이어진 잉크(진한 사진·넓은 음영·가로 괘선)는 gutter 통계에서 뺀다.
const longRun = Math.max(40, Math.round(W * 0.035));
const nRows = Math.max(0, Math.ceil((yBot - yTop) / step));
const rowXs = new Array(nRows), light = new Uint8Array(nRows), hist = new Uint32Array(256);
for (let r = 0, y = yTop; r < nRows; r++, y += step) {
const row = y * W * 4, xs = [];
let s = -1, dark = 0;
hist.fill(0);
for (let x = 0; x <= W; x++) {
const l = x < W ? lumAt(row + x * 4) : 255;
if (l < threshold) { if (s < 0) s = x; dark++; hist[l | 0]++; continue; }
if (s >= 0 && x - s < longRun) for (let k = s; k < x; k++) xs.push(k);
s = -1;
}
rowXs[r] = xs;
if (dark > W * 0.03) {
// 이 행 잉크의 가장 진한 10% 밝기: 글자 획(흐린 스캔이라도)은 가운데가 진하고, 연한 질감 사진·음영은 문턱값 가까이 밝다
let core = 0;
for (let acc = 0; core < 255 && (acc += hist[core]) < dark * 0.1; core++);
light[r] = core > threshold - 35 ? 1 : 0;
}
}
// 연한 행이 길게(글줄 한 줄보다 높게) 이어진 구간만 사진·음영 영역으로 보고 뺀다. 흐리거나 연한 글줄 하나는 그대로 센다.
const minRun = Math.ceil(Math.max(40, H * 0.025) / step);
for (let i = 0; i < nRows;) {
if (!light[i]) { i++; continue; }
let j = i;
while (j < nRows && light[j]) j++;
if (j - i < minRun) light.fill(0, i, j);
i = j;
}
const counts = new Uint32Array(W);
for (let r = 0; r < nRows; r++) if (!light[r]) for (const x of rowXs[r]) counts[x]++;
return columnsFromCounts(counts, Math.max(1, nRows));
function columnsFromCounts(counts, rows) {
const lowTh = Math.max(1, rows * 0.004);
let inkL = 0, inkR = W - 1;
while (inkL < W && counts[inkL] <= lowTh) inkL++;
while (inkR > 0 && counts[inkR] <= lowTh) inkR--;
if (inkL >= inkR) return [{ x0: 0, x1: W }];
const blank = new Uint8Array(W);
for (let x = 0; x < W; x++) blank[x] = counts[x] <= lowTh ? 1 : 0;
const maxLine = Math.max(2, Math.round(W * 0.006));
for (let x = 1; x < W; x++) {
if (!blank[x] && blank[x - 1]) {
let e = x;
while (e < W && !blank[e]) e++;
if (e - x <= maxLine && e < W && blank[e]) {
let peak = 0;
for (let k = x; k < e; k++) peak = Math.max(peak, counts[k]);
// 가는 세로 구분선: 점선·일부 구간만 있는 선(쪽 높이의 20% 이상)도 여백으로 본다
if (peak > rows * 0.2) for (let k = x; k < e; k++) blank[k] = 1;
}
x = e;
}
}
// 비율은 이미지 전체가 아니라 실제 글이 있는 영역(inkL~inkR) 기준으로 잡는다.
// 작은 책을 큰 스캐너에 올려 한쪽으로 치우치게 스캔해도(넓은 여백) 가운데 골과 단 폭을 제대로 본다.
// 글이 몇 줄 없는 쪽은 글 폭이 좁아 선택지 사이 공백을 단으로 오인할 수 있으므로 기준 폭을 쪽 너비의 55% 이상으로 둔다.
const inkW = Math.max(inkR - inkL + 1, W * 0.55);
const refL = Math.max(0, Math.min(W - inkW, (inkL + inkR) / 2 - inkW / 2));
const at = (f) => refL + inkW * f;
// 2단 책은 가운데의 짧은 이동 창으로 한 번 더 판단한다. 사진/점수 표기가 여백을 잘게 나눠도 중앙에 가까운 넓은 골을 고른다.
const win = Math.max(12, Math.round(inkW * 0.025));
const mid0 = at(0.5);
let bestX = -1, bestScore = Infinity;
for (let cx = Math.round(at(0.36)); cx <= at(0.64); cx++) {
let score = 0;
for (let x = Math.max(0, cx - win); x <= Math.min(W - 1, cx + win); x++) score += counts[x];
if (score < bestScore * 0.98 || (score <= bestScore * 1.02 && Math.abs(cx - mid0) < Math.abs(bestX - mid0))) { bestScore = score; bestX = cx; }
}
if (bestX > 0) {
let gs = bestX, ge = bestX + 1;
while (gs > inkL && blank[gs - 1]) gs--;
while (ge <= inkR && blank[ge]) ge++;
const leftInk = counts.slice(Math.round(at(0.08)), Math.max(0, gs - win)).some((n) => n > lowTh);
const rightInk = counts.slice(Math.min(W, ge + win), Math.round(at(0.92))).some((n) => n > lowTh);
const avg = bestScore / Math.max(1, win * 2 + 1);
if (leftInk && rightInk && gs > at(0.28) && ge < at(0.72) && ge - gs >= Math.max(W * 0.008, inkW * 0.012) && avg <= rows * 0.02) {
return [{ x0: inkL, x1: gs }, { x0: ge, x1: inkR + 1 }];
}
}
const minGap = Math.max(W * 0.008, inkW * 0.012);
const gaps = [];
for (let x = inkL; x <= inkR; x++) {
if (blank[x]) {
let e = x;
while (e <= inkR && blank[e]) e++;
const mid = (x + e) / 2;
if (e - x >= minGap && mid > at(0.2) && mid < at(0.8)) gaps.push({ s: x, e });
x = e;
}
}
const cols = [];
// 실제 단 사이는 페이지에서 가장 넓은 여백들과 비슷하다. 점수/수식 사이의 짧은 공백은 단으로 만들지 않는다.
const widest = Math.max(0, ...gaps.map((g) => g.e - g.s));
const strongGaps = gaps.filter((g) => g.e - g.s >= Math.max(minGap, widest * 0.42))
.sort((a, b) => (b.e - b.s) - (a.e - a.s)).slice(0, 2).sort((a, b) => a.s - b.s);
let start = inkL;
const minCol = inkW * 0.2;
for (const g of strongGaps) {
if (g.s - start >= minCol) { cols.push({ x0: start, x1: g.s }); start = g.e; }
}
if (inkR + 1 - start >= minCol || cols.length === 0) cols.push({ x0: start, x1: inkR + 1 });
else cols[cols.length - 1].x1 = inkR + 1;
return cols;
}
}
/** 박스의 배경 밝기를 추정해 연한 그래프 축·격자까지 포함한다. 실제 픽셀은 바꾸지 않는다. */
function trimThreshold(img, x0, y0, x1, y1) {
const { data, width } = img;
const samples = [];
const sx = Math.max(1, Math.floor((x1 - x0) / 100));
const sy = Math.max(1, Math.floor((y1 - y0) / 100));
const add = (x, y) => {
const i = (y * width + x) * 4;
samples.push((data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000);
};
for (let x = x0; x < x1; x += sx) { add(x, y0); add(x, y1 - 1); }
for (let y = y0; y < y1; y += sy) { add(x0, y); add(x1 - 1, y); }
samples.sort((a, b) => a - b);
const background = samples[Math.floor(samples.length / 2)] ?? 255;
return Math.max(DARK, Math.min(230, background - 15));
}
/**
* 상자 가장자리 띠에 있는 긴 직선(스캔 테두리·단 구분선·머리말 괘선) 중 실제 내용보다 훨씬 길게 뻗은 것만 찾는다.
* 문제를 감싼 네모 틀처럼 내용과 같은 길이의 선은 남긴다. 반환: {col, row} 마스크(상자 기준 좌표) 또는 null
*/
function findFrameLines(dark, x0, y0, bw, bh, safePad) {
const colInk = new Uint32Array(bw), rowInk = new Uint32Array(bh);
const colTop = new Int32Array(bw).fill(-1), colBot = new Int32Array(bw).fill(-1);
const rowLeft = new Int32Array(bh).fill(-1), rowRight = new Int32Array(bh).fill(-1);
for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
if (!dark(x + x0, y + y0)) continue;
colInk[x]++; rowInk[y]++;
if (colTop[x] < 0) colTop[x] = y; colBot[x] = y;
if (rowLeft[y] < 0) rowLeft[y] = x; rowRight[y] = x;
}
const bandX = Math.max(8, Math.round(bw * 0.05)), bandY = Math.max(8, Math.round(bh * 0.05));
const candCol = [], candRow = [];
for (let x = 0; x < bw; x++) if ((x < bandX || x >= bw - bandX) && colInk[x] >= bh * 0.6) candCol.push(x);
for (let y = 0; y < bh; y++) if ((y < bandY || y >= bh - bandY) && rowInk[y] >= bw * 0.6) candRow.push(y);
if (!candCol.length && !candRow.length) return null;
const col = new Uint8Array(bw), row = new Uint8Array(bh);
for (const x of candCol) col[x] = 1;
for (const y of candRow) row[y] = 1;
const mY = Math.max(2 * safePad, bh * 0.08), mX = Math.max(2 * safePad, bw * 0.08);
// 확정된 선을 뺀 내용 범위로 다시 확인한다. 되살린 선이 내용 범위를 넓힐 수 있어 몇 번 반복한다.
for (let round = 0; round < 3; round++) {
let cMinX = Infinity, cMaxX = -1, cMinY = Infinity, cMaxY = -1;
for (let y = 0; y < bh; y++) {
if (row[y]) continue;
for (let x = 0; x < bw; x++) {
if (col[x] || !dark(x + x0, y + y0)) continue;
if (x < cMinX) cMinX = x; if (x > cMaxX) cMaxX = x;
if (y < cMinY) cMinY = y; if (y > cMaxY) cMaxY = y;
}
}
if (cMaxX < 0) return { col, row, empty: true }; // 선만 있는 조각
let changed = false;
for (const x of candCol) {
const keep = cMinY - colTop[x] >= mY || colBot[x] - cMaxY >= mY;
if (col[x] !== (keep ? 1 : 0)) { col[x] = keep ? 1 : 0; changed = true; }
}
for (const y of candRow) {
const keep = cMinX - rowLeft[y] >= mX || rowRight[y] - cMaxX >= mX;
if (row[y] !== (keep ? 1 : 0)) { row[y] = keep ? 1 : 0; changed = true; }
}
if (!changed) break;
}
return col.some(Boolean) || row.some(Boolean) ? { col, row, empty: false } : null;
}
/** 박스 안의 잉크 영역에 맞게 자르되 밝은 도형선과 안전 여백을 보존한다. 스캔 테두리·구분선은 내용으로 보지 않는다. */
function trimBox(img, box, pad = null) {
const { data, width } = img;
const x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(width, Math.ceil(box.x1));
const y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(img.height, Math.ceil(box.y1));
if (x1 <= x0 || y1 <= y0) return null;
const threshold = trimThreshold(img, x0, y0, x1, y1);
const safePad = pad ?? Math.max(8, Math.round(Math.min(img.width, img.height) * 0.0045));
const rawDark = (x, y) => { const i = (y * width + x) * 4; return (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 < threshold; };
const frame = findFrameLines(rawDark, x0, y0, x1 - x0, y1 - y0, safePad);
if (frame?.empty) return null;
const dark = frame ? (x, y) => !frame.col[x - x0] && !frame.row[y - y0] && rawDark(x, y) : rawDark;
const rowInk = new Uint32Array(y1 - y0), colInk = new Uint32Array(x1 - x0);
let anyMinX = Infinity, anyMinY = Infinity, anyMaxX = -1, anyMaxY = -1;
for (let y = y0; y < y1; y++) {
for (let x = x0; x < x1; x++) {
if (!dark(x, y)) continue;
rowInk[y - y0]++; colInk[x - x0]++;
if (x < anyMinX) anyMinX = x; if (x > anyMaxX) anyMaxX = x;
if (y < anyMinY) anyMinY = y; if (y > anyMaxY) anyMaxY = y;
}
}
if (anyMaxX < 0) return null;
// 고립된 먼지 한두 점은 crop을 페이지 끝까지 넓히지 못하게 투영 밀도로 경계를 잡는다.
const rowMin = Math.max(2, Math.round((x1 - x0) * 0.0015));
const colMin = Math.max(2, Math.round((y1 - y0) * 0.001));
let minY = rowInk.findIndex((n) => n >= rowMin);
let maxY = rowInk.length - 1; while (maxY >= 0 && rowInk[maxY] < rowMin) maxY--;
let minX = colInk.findIndex((n) => n >= colMin);
let maxX = colInk.length - 1; while (maxX >= 0 && colInk[maxX] < colMin) maxX--;
if (minX < 0 || minY < 0) return { x0: anyMinX, y0: anyMinY, x1: anyMaxX + 1, y1: anyMaxY + 1 };
// 가로·세로로 이어진 얇은 그래프 축은 한 방향 투영값이 1이어도 보존한다.
let keepMinX = Infinity, keepMaxX = -1, keepMinY = Infinity, keepMaxY = -1;
for (let y = y0; y < y1; y++) {
for (let x = x0; x < x1; x++) {
const rowStrong = rowInk[y - y0] >= rowMin, colStrong = colInk[x - x0] >= colMin;
if (!rowStrong && !colStrong) continue;
if (!dark(x, y)) continue;
// 한 방향 투영만 강하면 가까운 픽셀과 이어진 선인지 확인한다. 같은 행 멀리 있는 먼지 한 점은 제외한다.
if (!(rowStrong && colStrong)) {
let neighbors = 0;
for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
if ((!dx && !dy) || x + dx < x0 || x + dx >= x1 || y + dy < y0 || y + dy >= y1) continue;
if (dark(x + dx, y + dy)) neighbors++;
}
if (neighbors < 1) continue;
}
keepMinX = Math.min(keepMinX, x); keepMaxX = Math.max(keepMaxX, x);
keepMinY = Math.min(keepMinY, y); keepMaxY = Math.max(keepMaxY, y);
}
}
if (keepMaxX >= 0) { minX = keepMinX - x0; maxX = keepMaxX - x0; minY = keepMinY - y0; maxY = keepMaxY - y0; }
minX += x0; maxX += x0; minY += y0; maxY += y0;
// raw 경계에 붙은 긴 스캔 테두리/단 구분선은 내용으로 보지 않는다.
const bh = y1 - y0, bw = x1 - x0;
while (minX <= maxX && minX - x0 < 4 && colInk[minX - x0] > bh * 0.65) minX++;
while (maxX >= minX && x1 - 1 - maxX < 4 && colInk[maxX - x0] > bh * 0.65) maxX--;
while (minY <= maxY && minY - y0 < 4 && rowInk[minY - y0] > bw * 0.65) minY++;
while (maxY >= minY && y1 - 1 - maxY < 4 && rowInk[maxY - y0] > bw * 0.65) maxY--;
return {
x0: Math.max(x0, minX - safePad), y0: Math.max(y0, minY - safePad),
x1: Math.min(x1, maxX + 1 + safePad), y1: Math.min(y1, maxY + 1 + safePad),
};
}
/** 박스 안 잉크 비율 */
function inkRatio(img, box) {
const prof = rowProfile(img, box.x0, box.x1, box.y0, box.y1, 2);
let s = 0;
for (let y = Math.max(0, box.y0 | 0); y < Math.min(img.height, box.y1); y++) s += prof[y];
const area = Math.max(1, ((box.x1 - box.x0) / 2) * (box.y1 - box.y0));
return s / area;
}
const median = (a) => {
if (!a.length) return 0;
const b = a.slice().sort((x, y) => x - y);
return b[Math.floor(b.length / 2)];
};
/**
* 번호 OCR이 실패해도 문제 경계를 찾기 위한 시각적 블록 분석.
* 각 단의 가로 잉크 투영에서 글줄 묶음과 큰 세로 여백을 찾고, 여백 아래 왼쪽에 본문 잉크가 있을 때 시작점으로 삼는다.
* 원본 픽셀은 바꾸지 않고 작은 좌표 목록만 반환한다.
*/
function detectBlockStarts(img, columns, opts = {}) {
const H = img.height;
const yTop = Math.floor(H * (opts.top ?? 0.07));
const yBot = Math.floor(H * (1 - (opts.bottom ?? 0.06)));
const result = [];
const threshold = pageInkThreshold(img);
for (let ci = 0; ci < columns.length; ci++) {
const col = columns[ci], cw = Math.max(1, col.x1 - col.x0);
const prof = rowProfile(img, col.x0, col.x1, yTop, yBot, 2, threshold);
const activeMin = Math.max(2, Math.round(cw * 0.0025));
const raw = [];
let s = -1, last = -1;
for (let y = yTop; y < yBot; y++) {
if (prof[y] >= activeMin) {
if (s < 0) s = y;
last = y;
} else if (s >= 0 && y - last > 3) {
raw.push({ y0: s, y1: last + 1 }); s = -1;
}
}
if (s >= 0) raw.push({ y0: s, y1: last + 1 });
if (!raw.length) continue;
const gaps = [];
for (let i = 1; i < raw.length; i++) gaps.push(raw[i].y0 - raw[i - 1].y1);
const ordinary = gaps.filter((g) => g > 1 && g < H * 0.035);
const typicalGap = median(ordinary) || Math.max(4, H * 0.005);
const typicalBand = median(raw.map((b) => b.y1 - b.y0)) || Math.max(6, H * 0.008);
const bigGap = Math.max(12, H * 0.013, typicalGap * 2.4, typicalBand * 0.75);
const leftX1 = col.x0 + cw * 0.28;
const left = rowProfile(img, col.x0, leftX1, yTop, yBot, 2, threshold);
const hasLeftInk = (y) => {
let n = 0;
const end = Math.min(yBot, y + Math.max(typicalBand * 2.5, H * 0.035));
for (let k = Math.max(yTop, y - 2); k < end; k++) n += left[k];
return n >= Math.max(4, typicalBand * 0.35);
};
// 블록 첫 줄의 가장 왼쪽 잉크 위치: 문제 시작이면 번호가 번호 자리(lane)에 있고, 그림·선택지·본문은 들여쓰기 위치에서 시작한다
const firstInkX = (band) => {
const x1 = Math.min(img.width, Math.ceil(col.x1));
for (let x = Math.max(0, Math.floor(col.x0)); x < x1; x++) {
let n = 0;
for (let y = band.y0; y < band.y1; y++) if (isDark(img.data, (y * img.width + x) * 4, threshold) && ++n >= 2) return x;
}
return null;
};
// 단의 첫 블록: 왼쪽에서 시작하면 이 단의 첫 문제일 수 있다. top 표시를 붙여 늘 남기고,
// 머리말 선과의 간격이 보통 줄 간격(여백 중 하위 25%)보다 넓으면 topGap으로 표시한다.
// 간격이 좁은 첫 블록은 앞 단에서 이어진 글일 수도 있어, 쓰는 쪽(buildAnchors)에서 번호 자리에서 시작하는지로 다시 가린다.
const firstGap = raw[0].y0 - yTop;
const lineGap = ordinary.length ? ordinary.slice().sort((x, y) => x - y)[Math.floor((ordinary.length - 1) * 0.25)] : typicalGap;
if (hasLeftInk(raw[0].y0)) {
const topGap = firstGap >= Math.max(H * 0.008, lineGap * 1.2);
result.push({ col: ci, y0: raw[0].y0, y1: raw[0].y1, cutY: yTop, h: typicalBand, inkX0: firstInkX(raw[0]), source: 'visual', confidence: topGap ? 0.48 : 0.4, top: true, topGap });
}
for (let i = 1; i < raw.length; i++) {
const gap = raw[i].y0 - raw[i - 1].y1;
if (gap < bigGap || !hasLeftInk(raw[i].y0)) continue;
result.push({
col: ci, y0: raw[i].y0, y1: raw[i].y1,
cutY: Math.round((raw[i - 1].y1 + raw[i].y0) / 2), inkX0: firstInkX(raw[i]),
h: typicalBand, source: 'visual', confidence: Math.min(0.78, 0.42 + gap / Math.max(1, H) * 5),
});
}
}
return result;
}
/** 단마다 마지막 잉크가 있는 높이 (머리말·꼬리말 제외). 문제가 단 끝까지 이어지는지 판단할 때 쓴다 */
function columnInkBottoms(img, columns, opts = {}) {
const H = img.height;
const yTop = Math.floor(H * (opts.top ?? 0.07)), yBot = Math.floor(H * (1 - (opts.bottom ?? 0.06)));
const threshold = pageInkThreshold(img);
return columns.map((col) => {
const prof = rowProfile(img, col.x0, col.x1, yTop, yBot, 2, threshold);
const min = Math.max(2, Math.round((col.x1 - col.x0) * 0.0025));
for (let y = yBot - 1; y >= yTop; y--) if (prof[y] >= min) return y + 1;
return null;
});
}
return { columnProfile, rowProfile, pageInkThreshold, detectColumns, detectBlockStarts, columnInkBottoms, trimBox, inkRatio };
})();
M.segment = (() => {
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const DINGBAT = '❶❷❸❹❺❻❼❽❾❿';
const NUM_WORD = /^[\[(【<□]?(?:No\.?|#)?0*(\d{1,4})[\])】>.]?$/i;
// "유제 1-2"처럼 단원-번호가 붙은 라벨도 읽는다
const LABEL_NUM = /^(연습\s*문제|문제|문항|예제|유제|question|q)\s*[:.#-]?\s*0*(\d{1,4})(?:\s*[-–]\s*0*(\d{1,3}))?(?!\d)/i;
// 예제·유제·연습문제는 본문 문제와 따로 번호를 매기는 체계다. "문제 3"·"문항 3"은 본문 번호와 같은 체계로 본다.
const SERIES_LABELS = new Set(['예제', '유제', '연습문제']);
// "1. 다음", "1.다음"(띄어쓰기 없음) 모두 인정. "1.5배" 같은 소수는 제외
const NUM_LINE = /^[\[(【<□]?0*(\d{1,4})(?:([\])】>.:])(?=\s|[가-힣A-Za-z({]|$)|(?=\s|$))/i;
// 구두점 없는 숫자 뒤에 이런 말이 오면 본문 속 수량·식일 가능성이 높다 ("2 이상의 자연수", "3 개의 점", "12 이다", "2 + 3 = 5").
// 문제 첫머리일 수 있는 말(점 P, 원, 명제, 개수, 회사, 이 시험, −2 ≤ x, <보기>, ·)은 넣지 않았다.
// 이 표시가 붙은 후보는 버리지 않고, 문제 사이 여백과 앞뒤 번호 근거가 모두 있을 때만 문제 번호로 쓴다.
const QUANTITY_AFTER = /^(?:(?:이상|이하|초과|미만|번째|가지|마리|자리)|개(?![수념])|배(?![열수])|명(?![제])|번(?![호])|살|권|%|cm|mm|km|kg|mL|[=+×÷*/>≤≥≠]|(?:이다|이고|이며|이므로|이면|보다|만큼|씩|와|과|을|를|은|는|가|의|에|로|으로|에서|부터|까지|도|만)(?=$|[\s,.)!?]))/;
function circledNumber(text) {
const ch = String(text || '').trim()[0];
let i = CIRCLED.indexOf(ch);
if (i >= 0) return i + 1;
i = DINGBAT.indexOf(ch);
return i >= 0 ? i + 1 : null;
}
function parseAnchorNumber(line) {
return parseAnchor(line)?.num ?? null;
}
/**
* 번호와 표기 방식. line 전체의 첫머리를 보므로 OCR이 번호와 본문을 한 word로 붙여도 된다.
* 문제 12 / 예제 3 / ① / □1 / O1. 같은 흔한 스캔 표기도 지원한다.
*/
function parseAnchor(line) {
const original = String(line?.text || line?.firstWord?.text || '').trim();
if (!original) return null;
const circle = circledNumber(original);
if (circle) return { num: circle, style: 'circled', explicit: 0.88, token: original[0] };
const text = original.normalize('NFKC').replace(/[｜|]/g, 'I');
let m = text.match(LABEL_NUM);
if (m) {
// labelWord: 예제·유제·연습문제는 본문 번호와 다른 번호 체계. labelSection: "유제 1-2"의 1 (단원)
const word = m[1].replace(/\s+/g, '');
const minor = m[3] != null ? +m[3] : null;
return { num: minor ?? +m[2], labelSection: minor != null ? +m[2] : null, style: 'label', explicit: 1, token: m[0], labelWord: SERIES_LABELS.has(word) ? word : undefined };
}
// OCR에서 01을 O1로, 1.을 I.로 읽는 경우: 구두점/공백이 있을 때만 제한적으로 복원
m = text.match(/^[Oo]([1-9]\d{0,2})([.)\]:]|\s)/);
if (m) return { num: +m[1], style: 'plain', explicit: 0.62, token: m[0], corrected: true };
if (/^[Il][.)\]:](?=\s|[가-힣A-Za-z])/.test(text)) return { num: 1, style: 'plain', explicit: 0.58, token: text.slice(0, 2), corrected: true };
const first = String(line?.firstWord?.text || '').trim();
m = first.match(NUM_WORD) || text.match(NUM_LINE);
if (!m) return null;
const n = parseInt(m[1], 10);
if (!(n >= 1 && n <= 9999)) return null;
const token = m[0];
const paren = /[()]/.test(token);
const punctuated = /[\])】>.:]/.test(token) || /^[\[(【<□]/.test(token);
const quantity = !punctuated && QUANTITY_AFTER.test(text.slice(token.length).trimStart());
return { num: n, style: paren ? 'paren' : 'plain', explicit: punctuated ? 0.78 : 0.48, token, ...(quantity ? { quantity: true } : {}) };
}
/** 페이지 한 장에서 넓게 번호 후보를 모은다. x 위치는 탈락 조건이 아니라 뒤의 점수에 사용한다. */
function findCandidates(page, opts = {}) {
const out = [];
const yTop = page.height * (opts.top ?? 0.07);
const yBot = page.height * (1 - (opts.bottom ?? 0.06));
page.columns.forEach((col, ci) => {
const cw = Math.max(1, col.x1 - col.x0);
const lines = page.lines.filter((ln) => {
const x = (ln.firstWord || ln).x0;
return ln.y1 >= yTop && ln.y0 <= yBot && x >= col.x0 - cw * 0.04 && x < col.x1;
}).sort((a, b) => a.y0 - b.y0);
const visual = (page.visualStarts || []).filter((v) => v.col === ci);
// 문제 사이 여백: 이 단의 보통 줄 간격보다 확실히 넓은 공백 (빽빽한 책·넉넉한 책 모두에 맞춘다)
const lineGaps = [];
for (let k = 1; k < lines.length; k++) { const g = lines[k].y0 - lines[k - 1].y1; if (g > 0) lineGaps.push(g); }
lineGaps.sort((x, y) => x - y);
// 줄이 몇 개 없으면(번호 줄만 읽힌 OCR 등) 중앙값이 문제 사이 여백이 되므로 쪽 높이 기준값을 쓴다
const typicalGap = lineGaps.length >= 5 ? lineGaps[Math.floor(lineGaps.length / 2)] : page.height * 0.006;
const blockGap = Math.max(6, page.height * 0.009, typicalGap * 1.8);
let previousBottom = yTop, firstLine = true;
for (const ln of lines) {
const fw = ln.firstWord || ln;
const anchor = parseAnchor(ln);
const gapBefore = Math.max(0, ln.y0 - previousBottom);
// 단의 첫 줄: 위에 다른 글이 없으므로 그 자체로 블록 시작이다 (머리말 선에 바짝 붙은 첫 문제도 놓치지 않도록)
const colTop = firstLine;
firstLine = false;
previousBottom = Math.max(previousBottom, ln.y1);
if (!anchor) continue;
const xRel = Math.max(0, (fw.x0 - col.x0) / cw);
if (xRel > (anchor.style === 'label' ? 0.55 : 0.42)) continue;
const lineConf = Number.isFinite(ln.confidence) ? Math.max(0, Math.min(1, ln.confidence / 100)) : 0.65;
const lane = Math.max(0, 0.42 - xRel) * 1.15;
const whitespace = gapBefore > page.height * 0.008 ? Math.min(0.2, gapBefore / page.height * 5) : 0;
const y0 = Math.min(fw.y0, ln.y0), h = Math.max(1, ln.y1 - ln.y0);
// 여백 분석으로 찾은 문제 시작과 같은 높이인지 (본문 속 숫자는 보통 블록 시작이 아니다)
const atVisual = visual.some((v) => Math.abs(v.y0 - y0) < Math.max(h, v.h || 1, page.height * 0.014));
out.push({
page: page.index, col: ci, ncol: page.columns.length, cw, pageH: page.height, num: anchor.num, style: anchor.style, explicit: anchor.explicit,
labelWord: anchor.labelWord, labelSection: anchor.labelSection ?? null, quantity: !!anchor.quantity, x0: fw.x0, xRel, y0, y1: ln.y1, h,
gapBefore, score: anchor.explicit + lane + whitespace + lineConf * 0.12,
visual: atVisual, block: atVisual || gapBefore >= blockGap, colTop,
// 한 줄에 원문자가 여러 개면 "① 3 ② 5 ③ 7" 같은 선택지 줄이다
circles: (String(ln.text || '').match(/[\u2460-\u2473\u2776-\u277F]/g) || []).length,
source: ln.source || (page.ocr ? 'ocr' : 'text'), corrected: !!anchor.corrected, text: ln.text,
});
}
});
return out;
}
/**
* 읽는 순서대로 정렬된 후보에서 '번호가 1씩(가끔 건너뛰며) 증가하는' 가장 긴 사슬을 찾는다.
* 번호가 1~3으로 되돌아가면 새 단원(section) 시작으로 본다.
*/
function chainAnchors(cands, opts = {}) {
const maxSkip = opts.maxSkip ?? 3;
const n = cands.length;
if (!n) return [];
const score = new Float64Array(n);
const prev = new Int32Array(n).fill(-1);
const isReset = new Uint8Array(n);
for (let i = 0; i < n; i++) {
score[i] = 1 - Math.min(cands[i].num - 1, 50) * 0.02;
for (let j = Math.max(0, i - 400); j < i; j++) {
// 표기가 다른 번호끼리는 잇지 않는다 (본 문제 "5." 사이에 끼어든 소문항 "(1)(2)" 무시)
if ((cands[i].style || 'plain') !== (cands[j].style || 'plain')) continue;
const d = cands[i].num - cands[j].num;
let s = -Infinity, reset = 0;
if (d >= 1 && d <= maxSkip) s = score[j] + 1 - (d - 1) * 0.3;
else if (cands[i].num <= 3 && cands[j].num >= 5) { s = score[j] + 1 - (cands[i].num - 1) * 0.3 - 0.5; reset = 1; }
if (s > score[i]) { score[i] = s; prev[i] = j; isReset[i] = reset; }
}
}
let best = 0;
for (let i = 1; i < n; i++) if (score[i] > score[best]) best = i;
const path = [];
for (let i = best; i >= 0; i = prev[i]) path.push(i);
path.reverse();
let section = 1;
return path.map((i, k) => {
if (k > 0 && isReset[i]) section++;
return { ...cands[i], section };
});
}
const readingSort = (a, b) => (a.page - b.page) || (a.col - b.col) || (a.y0 - b.y0);
const styleGroup = (s) => (s === 'paren' || s === 'circled' ? s : 'main');
/** 같은 번호 체계인지. 원문자와 일반 번호는 둘 다 번호 자리(왼쪽 끝)에 있을 때만 섞어 본다 (OCR이 1.을 ①로 읽는 경우) */
/** 번호 체계 이름: 예제·유제·연습문제 라벨은 각자 따로, 그 밖(일반 번호, "문제 3")은 본문 체계 '' */
const seriesOf = (c) => (c.style === 'label' && c.labelWord ? c.labelWord : '');
/** 같은 번호인지 ("유제 1-1"과 "유제 2-1"은 다른 번호) */
const sameNumber = (x, y) => x.num === y.num && (x.labelSection ?? null) === (y.labelSection ?? null);
function sameSeries(x, y) {
// 예제 1 / 유제 1 / 01처럼 번호 체계가 다르면 서로 순서 근거가 되지 않는다
if (seriesOf(x) !== seriesOf(y)) return false;
const gx = styleGroup(x.style), gy = styleGroup(y.style);
if (gx === gy) return true;
return ((gx === 'circled' && gy === 'main') || (gx === 'main' && gy === 'circled')) && x.xRel <= 0.18 && y.xRel <= 0.18;
}
const clampSkip = (v) => Math.max(1, Math.min(10, Math.round(Number(v) || 3)));
const LANE_DEFAULT = 0.04, LANE_CLUSTER = 0.05;
/** 번호 자리(lane) 허용 폭: 자릿수가 다른 번호(1. / 12.)의 오른쪽 정렬은 받아들이고, 번호 뒤 본문 들여쓰기 위치는 벗어나게 한다 */
const laneTolerance = (c) => Math.min(0.1, Math.max(0.035, (c.h || 20) * 1.5 / Math.max(1, c.cw || 500)));
/**
* 후보를 책 전체의 단 하나 사슬로 줄이지 않는다. 각 후보가 번호 자리·앞뒤 번호·여백 근거와 맞는지 따져, 서로 끊어진 정상 run도 모두 보존한다.
* - 단마다 번호가 놓이는 x 위치(lane)를 배워, lane 밖(본문 들여쓰기 위치) 숫자는 순서 근거와 여백 근거가 함께 있을 때만 쓴다.
* - 앞뒤 번호가 서로 이어지는데(예: 1과 2) 그 사이에 들어갈 수 없는 번호(예: 10)는 본문 숫자로 본다.
* - opts.maxSkip(고급 설정 '번호 건너뛰기 허용 폭')까지만 건너뛴 번호를 순서 근거로 인정한다.
* - 주 번호 체계가 있으면 그 근처의 소문항 (1)(2)와 선택지 ①②는 문제 번호로 쓰지 않는다.
*/
function selectAnchors(cands, opts = {}) {
const maxSkip = clampSkip(opts.maxSkip);
// 0) 같은 줄을 전체 OCR과 번호 영역 OCR이 둘 다 찾았으면 점수가 높은 하나만 (순서 판단 전에)
const a = [];
for (const c of cands.slice().sort(readingSort)) {
let at = -1;
for (let k = a.length - 1; k >= 0 && a[k].page === c.page && a[k].col === c.col; k--) {
if (Math.abs(a[k].y0 - c.y0) < Math.max(a[k].h, c.h) * 0.7) { at = k; break; }
}
if (at < 0) a.push(c); else if (c.score > a[at].score) a[at] = c;
}
a.sort(readingSort);
// 1) 번호 자리(lane): 문제 번호는 단 안에서 가장 왼쪽에 모이고, 본문 속 숫자는 번호 뒤 들여쓰기 위치(오른쪽)에 있다.
// - 책 전체: 같은 단(단 수·순서가 같은 쪽)의 후보 x 위치에서 가장 왼쪽의 촘촘한 무리(3개 이상, 10% 이상)
// - 쪽마다: 단 경계를 잘못 잡아 번호가 단 왼쪽 끝에서 떨어져 있으면, 그 쪽 그 단의 가장 왼쪽 무리(2개 이상)
const laneKey = (c) => `${c.ncol || 0}:${c.col}`;
const leftCluster = (xs, min) => {
xs.sort((x, y) => x - y);
const need = Math.max(min, Math.ceil(xs.length * 0.1));
for (let i = 0; i + need - 1 < xs.length; i++) if (xs[i + need - 1] - xs[i] <= LANE_CLUSTER) return Math.min(0.25, xs[i]);
return null;
};
const bookXs = new Map(), pageCands = new Map();
for (const c of a) {
if (c.style === 'label') continue;
const bk = laneKey(c), pk = `${c.page}:${c.col}`;
if (!bookXs.has(bk)) bookXs.set(bk, []);
if (!pageCands.has(pk)) pageCands.set(pk, []);
bookXs.get(bk).push(c.xRel); pageCands.get(pk).push(c);
}
const bookLane = new Map(), pageLane = new Map();
for (const [k, xs] of bookXs) bookLane.set(k, leftCluster(xs, 3));
// 쪽 단위 lane은 그 무리 안에서 번호가 실제로 이어질 때만 믿는다 (본문 숫자 한두 개가 lane이 되지 않도록)
for (const [k, list] of pageCands) {
const x = leftCluster(list.map((c) => c.xRel), 2);
if (x == null) continue;
const members = list.filter((c) => c.xRel - x <= LANE_CLUSTER).sort((p, q) => p.y0 - q.y0);
if (members.some((c, i) => i > 0 && c.num - members[i - 1].num >= 1 && c.num - members[i - 1].num <= maxSkip)) pageLane.set(k, x);
}
const onLane = a.map((c) => {
if (c.style === 'label') return true;
const tol = laneTolerance(c), local = pageLane.get(`${c.page}:${c.col}`);
return c.xRel <= (bookLane.get(laneKey(c)) ?? LANE_DEFAULT) + tol || (local != null && c.xRel <= local + tol);
});
// 2) 주 번호 체계: lane 위의 강한 후보가 가장 많은 표기. 그 밖의 표기(소문항·선택지)는 보조로만 쓴다.
const choiceRow = (c) => styleGroup(c.style) === 'circled' && (c.circles || 1) > 1;
const count = { main: 0, paren: 0, circled: 0 };
a.forEach((c, i) => { if (onLane[i] && c.score >= 0.82 && !choiceRow(c)) count[styleGroup(c.style)]++; });
const primary = Object.keys(count).reduce((p, g) => (count[g] > count[p] ? g : p), 'main');
const secondary = (g) => g !== primary && count[primary] >= 3 && count[primary] > count[g];
const primaryPages = new Set();
a.forEach((c, i) => { if (onLane[i] && c.score >= 0.82 && styleGroup(c.style) === primary) primaryPages.add(c.page); });
const nearPrimary = (c) => primaryPages.has(c.page) || primaryPages.has(c.page - 1) || primaryPages.has(c.page + 1);
// 3) 바로 이어서 같은 번호가 또 나오면(문제 번호와 그림 속 숫자 등) 더 문제 시작다운 하나만 남긴다.
// 선택지 줄(①…⑤)은 문제 번호가 될 수 없으므로 비교에 넣지 않는다 (① 줄이 바로 위 "1." 번호를 밀어내지 않도록).
const dropped = new Uint8Array(a.length);
a.forEach((c, i) => { if (choiceRow(c)) dropped[i] = 1; });
const strength = (i) => (onLane[i] ? 2 : 0) + (a[i].visual ? 1 : 0) + a[i].score / 10;
for (let i = 0; i < a.length; i++) {
if (dropped[i]) continue;
for (let j = i + 1, n = 0; j < a.length && n < 40 && a[j].page - a[i].page <= 1; j++, n++) {
if (dropped[j] || !sameSeries(a[i], a[j])) continue;
if (sameNumber(a[i], a[j])) { if (strength(j) > strength(i)) dropped[i] = 1; else dropped[j] = 1; }
break; // 같은 체계의 바로 다음 후보만 본다 (다른 단원의 같은 번호는 사이에 다른 번호가 있다)
}
}
// 4) 같은 번호 체계에서 가장 가까운 번호 자리(lane) 위 이웃 (읽는 순서, 2쪽 이내).
// 본문 들여쓰기 위치의 숫자는 누구의 이웃도 되지 못한다 (본문 숫자 둘이 서로 1→2 순서 근거가 되지 않도록).
const near = (x, y) => Math.abs(x.page - y.page) <= 2;
const neighbor = (i, dir) => {
for (let j = i + dir, n = 0; j >= 0 && j < a.length && n < 80; j += dir, n++) {
if (!near(a[i], a[j])) return null;
if (!dropped[j] && onLane[j] && !choiceRow(a[j]) && sameSeries(a[i], a[j])) return a[j];
}
return null;
};
// 앞뒤 번호가 서로 이어지는데 이 번호가 그 사이에 들어가지 못하면 본문 속 숫자·OCR 오인이다 ([1, 10, 2]의 10).
// 먼저 이런 후보를 모두 찾아 빼고, 남은 후보끼리 순서 근거를 다시 본다 (잘못된 후보가 이웃 자리를 가로막지 않도록).
const incoherentAt = (i) => {
const P = neighbor(i, -1), N = neighbor(i, 1), c = a[i];
return !!P && !!N && near(P, N) && N.num - P.num >= 1 && N.num - P.num <= maxSkip + 1 && !(P.num < c.num && c.num < N.num);
};
const incoherent = a.map((c, i) => !dropped[i] && c.style !== 'label' && incoherentAt(i));
incoherent.forEach((x, i) => { if (x) dropped[i] = 1; });
// 바로 위아래(3.5줄 이내)에 원문자가 또 있으면 세로로 늘어선 선택지 목록이다
const listed = (i) => {
for (let j = Math.max(0, i - 6); j < Math.min(a.length, i + 7); j++) {
if (j === i || a[j].page !== a[i].page || a[j].col !== a[i].col || styleGroup(a[j].style) !== 'circled') continue;
if (Math.abs(a[j].y0 - a[i].y0) < Math.max(a[i].h, a[j].h) * 3.5) return true;
}
return false;
};
const keep = [];
for (let i = 0; i < a.length; i++) {
if (dropped[i]) continue;
const c = a[i], g = styleGroup(c.style);
const P = neighbor(i, -1), N = neighbor(i, 1);
const prevOk = !!P && c.num - P.num >= 1 && c.num - P.num <= maxSkip;
const nextOk = !!N && N.num - c.num >= 1 && N.num - c.num <= maxSkip;
const seq = prevOk || nextOk, both = prevOk && nextOk;
// 문제 시작다운 여백: 여백 분석의 블록 시작과 같은 높이이거나, 단의 보통 줄 간격보다 넓은 공백 뒤
const block = c.block ?? (!!c.visual || c.gapBefore >= (c.pageH || 1000) * 0.015);
let ok;
if (c.style === 'label') ok = c.xRel <= 0.55; // "문제 12", "예제 3"처럼 명시적인 표기
else if (g === 'circled') {
ok = onLane[i] && !choiceRow(c) && !listed(i) && (seq || block)
&& (!secondary('circled') || (block && seq && !nearPrimary(c)));
} else if (g === 'paren') {
// "(1)" 표기는 문제 번호보다 소문항인 경우가 훨씬 많다: 문제 사이 여백(또는 단의 첫 줄)에서 시작할 때만 문제 번호로 쓴다
// (번호 배지를 못 읽은 스캔 쪽에서 발문 속 (1)(2)가 문제 번호로 잡혀 문제가 쪼개지지 않도록)
ok = onLane[i] && (block || !!c.colTop) && (seq || c.score >= 0.9)
&& (!secondary('paren') || (block && seq && !nearPrimary(c)));
} else if (c.quantity) {
// "2 이상의…", "3 개의…"처럼 수량으로 읽히는 숫자: 문제 사이 여백과 앞뒤 번호 근거가 모두 있어야 문제 번호다
// ("05 이 시험에서"처럼 드문 문제 첫머리는 앞뒤 번호와 여백으로 살리고, 해설 본문의 수량은 버린다)
ok = onLane[i] && c.score >= 0.58 && block && seq;
} else if (onLane[i]) {
// 번호 자리의 숫자: 앞뒤 한쪽 번호와 이어지거나, 문제 시작 여백(또는 단의 첫 줄)이 있으면 문제 번호다
const start = block || !!c.colTop;
if (c.explicit >= 0.7) ok = (c.score >= 0.82 && (start || seq)) || (c.score >= 0.58 && ((seq && start) || both));
else ok = c.score >= 0.58 && (seq || (start && c.score >= 0.92));
} else {
// 번호 자리 밖(본문 들여쓰기 위치)의 숫자는 순서 근거와 여백 근거가 함께 있어야 한다
ok = c.score >= 0.58 && seq && block;
}
if (ok) keep.push(c);
}
return keep;
}
/** 번호 체계별로, 인식된 번호의 감소를 단원 시작으로 보고 section을 붙인다. "유제 1-2"처럼 단원이 적힌 라벨은 그 단원을 쓴다. */
function numberKnownAnchors(known) {
const state = new Map(), used = new Set();
for (const a of known) {
const s = seriesOf(a);
let st = state.get(s);
if (!st) state.set(s, (st = { section: 1, prev: null }));
if (a.labelSection != null) st.section = a.labelSection;
else {
if (st.prev && (a.num < st.prev.num || (a.num === st.prev.num && (a.page !== st.prev.page || a.col !== st.prev.col)))) st.section++;
while (used.has(`${s}|${st.section}-${a.num}`)) st.section++;
}
a.series = s; a.section = st.section; a.number = a.num; used.add(`${s}|${st.section}-${a.num}`); st.prev = a;
}
return known;
}
// 번호를 못 읽은 단이 문제 단인지 개념 설명 단인지는 블록(문단)마다 가른다.
// 문제 블록: 발문의 마지막 줄이 물음(…값은? / …구하시오.)으로 끝나거나, 한 줄에 원 번호가 여럿인 선택지 줄(① 1 ② 2 …)·[n점]·<보기>가 있다.
// 개념 설명의 "① a>1일 때 …" 같은 한 줄 나열, 설명 중간의 물음, "…어떻게 될까?" 같은 되묻기는 문제 근거로 보지 않는다.
const CIRCLED_ALL = /[\u2460-\u2473\u2776-\u277F]/g;
const STRONG_CUE = /\[\s*\d\s*점\s*\]|<\s*보\s*기\s*>/;
/** 줄이 물음으로 끝나는지: "…값은?" "…구하시오." "…구하여라." (끝의 "(단, …)"·마침표는 무시). "…될까?" 같은 되묻기는 아니다 */
function asksQuestion(t) {
const q = String(t).replace(/[(（]\s*단\s*[,，].*$/, '').replace(/[\s.。,|)\]】]+$/, '');
return (/[?？]$/.test(q) && !/까\s*[?？]$/.test(q)) || /(?:시\s*오|여\s*라)$/.test(q);
}
const hangulCount = (t) => (String(t || '').match(/[가-힣]/g) || []).length;
function problemBlock(lines) {
let stem = null;
const shortChoices = new Set();
for (const l of lines) {
const t = String(l.text || '').trim();
if (!t) continue;
if (STRONG_CUE.test(t)) return true;
const circles = t.match(CIRCLED_ALL) || [];
if (circles.length >= 2) return true; // 선택지 줄
if (circles.length && /^[\u2460-\u2473\u2776-\u277F]/.test(t)) {
// 세로 선택지 "① 1" "② √2"는 짧다. 개념 설명의 "① a>1일 때 …" 나열은 긴 문장이다.
if (t.replace(/\s+/g, '').length <= 16) shortChoices.add(t[0]);
continue; // 선택지·나열 한 줄은 발문이 아니다
}
if (/^[(（]?\s*단\s*[,，]/.test(t)) continue; // (단, …) 조건
if (/^[(（]\s*[가나다라마]\s*[)）]|^[ㄱㄴㄷㄹㅁ]\s*[.．]/.test(t)) continue; // 조건 (가)(나) · <보기> ㄱ. ㄴ. 항목 (소문항 (1)(2)는 물음이므로 발문으로 본다)
// 그림·표 속 글자(y=f(x), O), 짧은 OCR 잡음, OCR이 원 번호를 못 읽은 세로 선택지("3개")는 발문으로 보지 않는다. 물음으로 끝나면 짧아도 발문이다.
if (!asksQuestion(t) && hangulCount(t) < 3) continue;
stem = t;
}
if (shortChoices.size >= 3) return true; // 세로 선택지
return !!stem && asksQuestion(stem);
}
/** 단의 글줄을 블록(문단)으로 나눈다: 여백 분석의 블록 시작과 큰 줄 간격에서 끊는다 */
function columnBlocks(p, ci) {
const col = p.columns?.[ci];
if (!col) return { lines: [], blocks: [] };
const lines = (p.lines || []).filter((l) => { const x = (l.firstWord || l).x0; return x >= col.x0 - 8 && x < col.x1; }).sort((a, b) => a.y0 - b.y0);
const cuts = (p.visualStarts || []).filter((v) => v.col === ci).map((v) => v.y0);
const gaps = [];
for (let i = 1; i < lines.length; i++) { const g = lines[i].y0 - lines[i - 1].y1; if (g > 0) gaps.push(g); }
gaps.sort((a, b) => a - b);
const typical = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : p.height * 0.006;
const bigGap = Math.max(6, p.height * 0.009, typical * 1.8);
const blocks = [];
let cur = [];
lines.forEach((l, i) => {
const tol = Math.max(l.y1 - l.y0, p.height * 0.014);
if (i && cur.length && (l.y0 - lines[i - 1].y1 > bigGap || cuts.some((y) => Math.abs(y - l.y0) < tol))) { blocks.push(cur); cur = []; }
cur.push(l);
});
if (cur.length) blocks.push(cur);
return { lines, blocks };
}
// 해설 머리: "01 정답 ③", "[정답] 12", "답 ④", 번호 배지를 못 읽고 답만 읽힌 "③" (번호를 못 읽어도 새 해설의 시작임을 알 수 있는 줄).
// "답은 ③이다." "따라서 ③" 같은 결론 문장은 아니다.
const SOLUTION_HEAD = /^\S{0,6}\s*[\[(【]?\s*(?:정\s*답|해\s*답|답)\s*[\]】):：]?\s*(?:[\u2460-\u2473]|[-−]?\d)|^[0-9A-Za-z|]{0,4}\s*[\u2460-\u2473]\s*$/;
/** 여백 분석의 블록 시작 v와 같은 높이에서 시작하는, 그 단의 글줄들 */
function linesAt(p, v) {
const col = p?.columns?.[v.col];
if (!col) return [];
const tol = Math.max(v.h || 1, p.height * 0.014);
return (p.lines || []).filter((l) => Math.abs(l.y0 - v.y0) < tol && (l.firstWord || l).x0 < col.x1 && (l.x1 ?? l.x0) > col.x0);
}
/** OCR 번호와 시각 경계를 합치고, 번호를 못 읽은 경계에는 양옆 번호로 추론한 번호를 붙인다. */
/** 여백 분석의 블록 시작이 선택지 줄(①…⑤)·소문항 (1) 줄이면 문제 시작이 아니다 (그 문제의 일부) */
function startsInsideProblem(p, v) {
const col = p.columns?.[v.col];
if (!col) return false;
const tol = Math.max(v.h || 1, p.height * 0.014);
const ln = (p.lines || []).find((l) => Math.abs(l.y0 - v.y0) < tol && (l.firstWord || l).x0 < col.x1 && (l.x1 ?? l.x0) > col.x0);
if (!ln) return false;
if (/[\u2460-\u2473\u2776-\u277F][^\u2460-\u2473\u2776-\u277F]*[\u2460-\u2473\u2776-\u277F]/.test(ln.text || '')) return true;
const a = parseAnchor(ln);
return !!a && (a.style === 'circled' || a.style === 'paren');
}
function buildAnchors(pages, candidates, opts = {}) {
const known = numberKnownAnchors(selectAnchors(candidates, opts));
const starts = known.map((a) => ({ ...a, number: a.num, inferred: false }));
const pageByIndex = new Map(pages.map((p) => [p.index, p]));
// 문제 번호 자리(lane): 받아들인 번호의 단 안 x 위치. 같은 쪽·단의 번호가 있으면 그것, 없으면 책 전체의 같은 단(3개 이상이고 위치가 고를 때)
const lanePage = new Map(), laneBook = new Map();
for (const a of known) {
if (a.style === 'label') continue;
for (const [m, k] of [[lanePage, `${a.page}:${a.col}`], [laneBook, `${a.ncol || 0}:${a.col}`]]) { if (!m.has(k)) m.set(k, []); m.get(k).push(a.xRel); }
}
const pick = (xs, q) => xs.slice().sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor(xs.length * q))];
// 번호를 거의 못 읽은 스캔: 여백으로 찾은 블록 시작들의 첫 잉크 위치 중 단 왼쪽 끝의 촘촘한 무리(전체의 30% 이상)를 번호 자리로 본다.
// 문제 번호는 단 왼쪽 끝에 모이고, 선택지 줄·그림은 들여쓴 위치에서 시작한다.
const visualLane = new Map();
{
const xs = new Map();
for (const p of pages) for (const v of p.visualStarts || []) {
const col = p.columns?.[v.col];
if (!col || v.inkX0 == null) continue;
const k = `${p.columns.length}:${v.col}`;
if (!xs.has(k)) xs.set(k, []);
xs.get(k).push((v.inkX0 - col.x0) / Math.max(1, col.x1 - col.x0));
}
for (const [k, arr] of xs) {
arr.sort((x, y) => x - y);
const need = Math.max(3, Math.ceil(arr.length * 0.3));
for (let i = 0; i + need - 1 < arr.length && arr[i] <= 0.15; i++) if (arr[i + need - 1] - arr[i] <= LANE_CLUSTER) { visualLane.set(k, arr[i + Math.floor((need - 1) / 2)]); break; }
}
}
const laneRel = (p, ci) => {
const pg = lanePage.get(`${p.index}:${ci}`);
if (pg?.length) return pick(pg, 0.5);
const bk = laneBook.get(`${p.columns.length}:${ci}`);
if (bk && bk.length >= 3 && pick(bk, 0.8) - pick(bk, 0.2) <= 0.06) return pick(bk, 0.5);
return visualLane.get(`${p.columns.length}:${ci}`) ?? null;
};
// 블록의 첫 잉크가 번호 자리보다 확실히 오른쪽(들여쓴 그림·선택지·본문)이면 1, 번호 자리면 0, 알 수 없으면 null
const laneOffset = (p, v) => {
const col = p.columns?.[v.col], rel = col ? laneRel(p, v.col) : null;
if (v.inkX0 == null || rel == null) return null;
const cw = Math.max(1, col.x1 - col.x0);
return v.inkX0 > col.x0 + rel * cw + Math.max(12, cw * 0.03, (v.h || 20) * 1.2) ? 1 : 0;
};
// 번호를 하나도 못 읽은 단이라도 글줄이 있으면 내용으로 가른다: 문제 블록이 하나도 없으면 개념 설명·제목 단으로 보고 문제를 만들지 않는다.
// (쪽 거리로 가르지 않는다: 번호 배지만 못 읽은 문제 쪽은 물음·선택지 줄이 있어 살아남는다. 글줄이 없는 스캔 단은 판단하지 않는다.)
const knownCols = new Set(known.map((a) => `${a.page}:${a.col}`));
const blockMemo = new Map(), conceptMemo = new Map();
const blocksOf = (p, ci) => { const k = `${p.index}:${ci}`; if (!blockMemo.has(k)) blockMemo.set(k, columnBlocks(p, ci)); return blockMemo.get(k); };
const conceptColumn = (p, ci) => {
if (opts.kind === 'solution' || knownCols.has(`${p.index}:${ci}`)) return false;
const k = `${p.index}:${ci}`;
if (!conceptMemo.has(k)) {
const { lines, blocks } = blocksOf(p, ci);
conceptMemo.set(k, lines.length >= 3 && !blocks.some(problemBlock));
}
return conceptMemo.get(k);
};
if (opts.visualFallback !== false) {
for (const p of pages) {
const visual = (p.visualStarts || []).slice().sort((a, b) => b.confidence - a.confidence).slice(0, 14).sort((a, b) => a.y0 - b.y0);
for (const v of visual) {
const onKnown = starts.some((a) => a.page === p.index && a.col === v.col && Math.abs(a.y0 - v.y0) < Math.max(a.h || 1, v.h || 1, p.height * 0.014));
// 해설집에서 번호 배지를 못 읽고 답 "③"만 읽힌 줄은 선택지 줄이 아니라 해설의 시작이다
const solutionHead = opts.kind === 'solution' && linesAt(p, v).some((l) => SOLUTION_HEAD.test(String(l.text || '').trim()));
if (!onKnown && ((startsInsideProblem(p, v) && !solutionHead) || laneOffset(p, v) === 1 || conceptColumn(p, v.col))) continue;
// 머리말 선에 바짝 붙은 단 첫 블록: 문제집에서 번호 자리(배지·번호 위치)에서 시작할 때만 새 문제로 본다 (해설은 이어진 풀이일 수 있어 여백이 있을 때만)
if (!onKnown && v.top && !v.topGap && !(opts.kind !== 'solution' && laneOffset(p, v) === 0)) continue;
const same = starts.filter((a) => a.page === p.index && a.col === v.col).sort((a, b) => a.y0 - b.y0);
const knownSame = same.filter((a) => a.num != null);
const near = same.find((a) => Math.abs(a.y0 - v.y0) < Math.max(a.h || 1, v.h || 1, p.height * 0.014));
if (near) { if (v.cutY != null) near.cutY = v.cutY; continue; }
// 한 단에서 번호를 이미 2개 이상 안정적으로 읽었다면, 두 번호 사이 실제 누락 번호만 시각 경계로 보완한다.
if (knownSame.length >= 2) {
const prev = knownSame.filter((a) => a.y0 < v.y0).at(-1), next = knownSame.find((a) => a.y0 > v.y0);
if (prev && next) { if (next.num - prev.num <= 1) continue; }
else {
const onSide = visual.filter((x) => x.col === v.col && (prev ? x.y0 > prev.y0 : next ? x.y0 < next.y0 : false))
.filter((x) => !knownSame.some((a) => Math.abs(a.y0 - x.y0) < Math.max(a.h || 1, x.h || 1, p.height * 0.014)));
if (onSide.length < 2) continue; // 확실한 번호 뒤 시각 경계 하나뿐이면 내부 그래프일 가능성이 큼
}
}
starts.push({ ...v, page: p.index, num: null, number: null, inferred: true, source: 'visual', laneAligned: laneOffset(p, v) === 0 });
}
}
}
starts.sort(readingSort);
if (!starts.some((a) => a.num != null)) {
let n = 1;
for (const a of starts) { a.series = ''; a.section = 1; a.number = n++; }
starts.laneOffset = () => null; starts.conceptColumn = conceptColumn;
return starts;
}
const maxSkip = clampSkip(opts.maxSkip);
const knownPos = starts.map((a, i) => a.num != null ? i : -1).filter((i) => i >= 0);
// 인식 번호의 신뢰도: 가까운(2쪽 이내) 앞뒤 인식 번호와 번호가 이어지고, 그 사이 시각 경계 수도 번호 차와 맞아야 믿을 만하다.
const visualBetween = (i, j) => { let n = 0; for (let k = i + 1; k < j; k++) if (starts[k].num == null) n++; return n; };
const agrees = (li, ri) => {
const L = starts[li], R = starts[ri], d = R.num - L.num;
return R.page - L.page <= 2 && sameSeries(L, R) && d >= 1 && d <= maxSkip && visualBetween(li, ri) <= 2 * (d - 1) + 2;
};
knownPos.forEach((p, k) => {
starts[p].reliable = (k > 0 && agrees(knownPos[k - 1], p)) || (k + 1 < knownPos.length && agrees(p, knownPos[k + 1]));
});
// 인식 번호 사이의 시각 경계 수가 번호 차보다 많으면 낮은 신뢰도 경계(그림·선택지 앞 여백 등)를 버린다.
// - 오른쪽 번호가 믿을 만하면(이어지는 run) 그 번호를 믿고 사이 경계를 번호 차만큼만 남긴다.
// - 번호를 믿기 어렵고 경계가 번호 차보다 훨씬 많으면 OCR 번호 쪽이 틀렸을 가능성이 커서 경계를 모두 남긴다 (번호를 거의 못 읽은 스캔).
// - 서로 다른 번호 체계(예제 ↔ 본문 번호) 사이는 번호 차로 줄이지 않는다.
// 경계 v부터 같은 단의 다음 경계까지가 글줄은 있는데 문제 블록이 하나도 없으면 글로만 된 영역(단원 표지 제목·도입 글·개념 글)이다.
// 글줄이 없으면(글자를 못 읽은 스캔·그림) 판단하지 않는다.
const textOnlyRegion = (v) => {
const p = pageByIndex.get(v.page);
if (!p?.columns?.[v.col]) return false;
const next = starts.find((a) => a !== v && a.page === v.page && a.col === v.col && a.y0 > v.y0 + 1);
const tol = Math.max(v.h || 1, p.height * 0.014);
const region = blocksOf(p, v.col).blocks.map((b) => b.filter((l) => l.y0 >= v.y0 - tol && (!next || l.y0 < next.y0 - 1))).filter((b) => b.length);
return region.length > 0 && !region.some(problemBlock);
};
const keepVisual = new Set();
for (let k = -1; k < knownPos.length; k++) {
const leftI = k < 0 ? -1 : knownPos[k];
const rightI = k + 1 < knownPos.length ? knownPos[k + 1] : starts.length;
let visual = starts.slice(leftI + 1, rightI).filter((a) => a.num == null);
let slots = visual.length;
const trimTo = (cap, trusted) => { if (visual.length > cap && (trusted || visual.length <= 2 * cap + 2)) slots = cap; };
const left = leftI >= 0 ? starts[leftI] : null, right = rightI < starts.length ? starts[rightI] : null;
if (!left) { if (right) trimTo(Math.max(0, right.num - 1), right.reliable); }
else if (right && left.series === right.series && left.section === right.section && right.num > left.num) trimTo(right.num - left.num - 1, right.reliable);
else {
// 단원·책의 마지막 인식 번호 뒤 (몇 개가 빠졌는지 번호 차로 알 수 없는 구간)
let prefix = [];
if (right?.reliable && left.series === right.series) {
// 믿을 만한 재시작 번호 R과 같은 단에서 R 바로 위에 있는 경계는 새 단원의 앞 번호 자리(R-1개)만큼만 남긴다.
// R이 1이면 그 위는 단원 제목·도입 글이다. 다른 단·쪽의 경계는 앞 단원의 번호를 못 읽은 문제일 수 있어 그대로 둔다.
const before = visual.filter((v) => v.page === right.page && v.col === right.col);
const room = Math.max(0, right.num - 1);
prefix = room ? before.slice(-room) : [];
visual = [...visual.filter((v) => !before.includes(v)), ...prefix];
}
// 해설: 마지막 풀이의 문단·다음 단으로 넘어간 부분이 경계로 잡히는 경우가 대부분이다 (본문이 번호 자리에서 시작하는 해설집).
// "정답 ③"처럼 해설 머리가 보이는 경계만 새 해설로 남기고, 나머지는 앞 해설에 이어 붙인다.
if (opts.kind === 'solution') visual = visual.filter((v) => prefix.includes(v) || linesAt(pageByIndex.get(v.page), v).some((l) => SOLUTION_HEAD.test(String(l.text || '').trim())));
// 문제: 그 경계부터 같은 단의 다음 인식 번호까지가 글로만 되어 있고 문제 블록이 없으면(단원 표지 제목·도입 글) 문제로 만들지 않는다
else visual = visual.filter((v) => prefix.includes(v) || !textOnlyRegion(v));
slots = visual.length;
}
if (visual.length > slots) visual = visual.slice().sort((x, y) => y.confidence - x.confidence).slice(0, slots);
for (const v of visual) keepVisual.add(v);
}
const filtered = starts.filter((a) => a.num != null || keepVisual.has(a)).sort(readingSort);
// 최종 번호 (번호 체계별로 따로 센다. 번호를 못 읽은 경계는 가장 많이 쓰인 체계, 보통 본문 번호로 센다).
// - 새 단원은 인식 번호가 앞 인식 번호보다 작아지는 '재시작'일 때만 연다: 믿을 만한 run이거나, 라벨이거나, 문제 시작 여백이 있는 1번.
//   재시작 번호가 R(>1)이면 바로 앞의 추정 경계 R-1개까지는 새 단원의 앞 번호(1~R-1)로 옮긴다 (새 단원 첫 문제들의 번호를 못 읽은 경우).
// - 믿을 만한 인식 번호 앞에 추정 번호가 더 많으면(그림·선택지 여백을 문제로 본 것) 새 단원 없이 그 추정 경계를 줄여 번호를 맞춘다.
// - 앞뒤와 맞지 않는 OCR 번호는 경계로만 쓰고 번호는 순서로 추정한다 (detection.ocrNumber에 읽은 값을 남김).
const tally = new Map();
for (const a of known) tally.set(seriesOf(a), (tally.get(seriesOf(a)) || 0) + 1);
let dominant = '', most = -1;
for (const [s, n] of tally) if (n > most || (n === most && s === '')) { dominant = s; most = n; }
const states = new Map();
const stateOf = (s) => { if (!states.has(s)) states.set(s, { section: 1, running: 0, lastKnown: 0, lastAccepted: null }); return states.get(s); };
const key = (s, sec, n) => `${s}|${sec}-${n}`;
const used = new Set(), out = [];
// 이 체계에서 마지막으로 받아들인 인식 번호 뒤에 붙은 추정 항목들 (읽는 순서)
const tailOf = (st, s) => out.slice(st.lastAccepted ? out.indexOf(st.lastAccepted) + 1 : 0).filter((t) => t.series === s && (t.num == null || t.inferred));
const rank = (t) => (t.num != null ? 2 : 0) + (t.confidence ?? t.score ?? 0);
for (const a of filtered) {
const s = a.num != null ? seriesOf(a) : dominant;
const st = stateOf(s);
a.series = s;
let number;
if (a.num != null) {
const R = a.num;
let accept = false, newSection = false;
if (a.labelSection != null) {
// "유제 1-2": 단원과 번호가 적혀 있으므로 그대로 쓴다
if (a.labelSection !== st.section) { st.section = a.labelSection; st.running = 0; st.lastKnown = 0; }
accept = true;
} else if (R > st.running) accept = true; // 중간 번호가 빠졌어도 인식 번호를 따른다
else if (R <= st.lastKnown) {
accept = newSection = !!(a.reliable || a.style === 'label' || (R === 1 && (a.block || a.colTop) && a.score >= 0.82 && !a.corrected));
} else if (a.reliable) {
// st.lastKnown < R <= st.running: 추정 번호가 믿을 만한 번호를 앞질렀다
const tail = tailOf(st, s);
for (const t of tail) used.delete(key(s, t.section, t.number));
const keep = new Set(tail.slice().sort((x, y) => rank(y) - rank(x)).slice(0, Math.max(0, R - st.lastKnown - 1)));
for (const t of tail) if (!keep.has(t)) out.splice(out.indexOf(t), 1);
st.running = st.lastKnown;
for (const t of tail) if (keep.has(t)) { t.section = st.section; t.number = ++st.running; used.add(key(s, t.section, t.number)); }
accept = true;
}
if (accept) {
if (newSection) {
const tail = tailOf(st, s), k = Math.min(Math.max(0, R - 1), tail.length);
st.section++;
tail.slice(tail.length - k).forEach((t, i) => {
used.delete(key(s, t.section, t.number));
t.section = st.section; t.number = R - k + i; used.add(key(s, t.section, t.number));
});
}
number = R; st.lastKnown = R;
} else { number = st.running + 1; a.inferred = true; a.ocrNumber = R; }
} else number = st.running + 1;
while (used.has(key(s, st.section, number))) number++;
a.section = st.section; a.number = number; used.add(key(s, a.section, number)); st.running = number;
out.push(a);
if (a.num != null && !a.inferred) st.lastAccepted = a;
}
out.laneOffset = laneOffset; out.conceptColumn = conceptColumn;
return out;
}
/**
* 다시 분리한 새 항목마다 같은 문제였던 옛 항목을 찾는다 (난이도·유형·직접 고친 정답을 옮기기 위해).
* 추정 번호는 분석할 때마다 다른 문제를 가리킬 수 있으므로 먼저 첫 조각의 쪽·단·시작 높이가 같은 항목끼리 1:1로 잇는다.
* 위치로 못 찾았을 때만, 양쪽 모두 읽은 번호(추정 아님)이고 그 번호(key)가 양쪽에 하나씩뿐이면 번호로 잇는다.
* 반환: Map(새 항목 → 옛 항목)
*/
function matchPrevious(oldItems, newItems) {
const start = (it) => (it.fragments || []).find((f) => !f.cont) || it.fragments?.[0] || null;
const byPage = new Map();
for (const o of oldItems) {
const s = start(o);
if (!s) continue;
if (!byPage.has(s.page)) byPage.set(s.page, []);
byPage.get(s.page).push([o, s]);
}
const pairs = [];
for (const n of newItems) {
const s = start(n);
if (!s) continue;
const tol = Math.max(16, (n.pageHeight || 1200) * 0.025);
for (const [o, t] of byPage.get(s.page) || []) {
const overlap = Math.min(s.x1, t.x1) - Math.max(s.x0, t.x0);
if (overlap < 0.5 * Math.min(s.x1 - s.x0, t.x1 - t.x0)) continue; // 다른 단
const d = Math.abs(s.y0 - t.y0);
if (d <= tol) pairs.push([d, n, o]);
}
}
pairs.sort((x, y) => x[0] - y[0]);
const out = new Map(), used = new Set();
for (const [, n, o] of pairs) if (!out.has(n) && !used.has(o)) { out.set(n, o); used.add(o); }
const lexical = (it) => !it.detection?.inferred;
const tally = (list) => { const m = new Map(); for (const it of list) m.set(itemKey(it), (m.get(itemKey(it)) || 0) + 1); return m; };
const oldCount = tally(oldItems), newCount = tally(newItems);
const oldByKey = new Map(oldItems.map((o) => [itemKey(o), o]));
for (const n of newItems) {
const k = itemKey(n);
if (out.has(n) || !lexical(n) || newCount.get(k) !== 1 || oldCount.get(k) !== 1) continue;
const o = oldByKey.get(k);
if (o && !used.has(o) && lexical(o)) { out.set(n, o); used.add(o); }
}
return out;
}
/**
* 전체 분리. pages: [{index, width, height, columns, lines, visualStarts}]
* 번호 OCR과 시각적 블록 경계를 합쳐 반환한다. 번호를 못 읽어도 영역은 보존한다.
*/
const MAX_CONT_FRAGMENTS = 6;
function segmentPages(pages, opts = {}) {
const continuation = opts.continuation ?? true;
const cands = [];
for (const p of pages) cands.push(...findCandidates(p, opts));
const anchors = buildAnchors(pages, cands, opts);
const items = [];
const byPageCol = new Map();
for (const a of anchors) {
const k = a.page + ':' + a.col;
if (!byPageCol.has(k)) byPageCol.set(k, []);
byPageCol.get(k).push(a);
}
const byIndex = new Map(pages.map((p) => [p.index, p]));
/**
* 앞 항목이 자기 단의 끝까지 내려왔는지. 단 중간에서 끝난 문제 뒤의 다음 단 맨 위(단원 제목·개념 설명 등)는 그 문제에 이어 붙이지 않는다.
* 근거: 저장된 단별 마지막 잉크 높이 → 없으면 글줄 위치 → 둘 다 없으면 이어 붙인다(예전 동작).
*/
const reachesBottom = (it) => {
const f = it.fragments[it.fragments.length - 1];
const q = byIndex.get(f.page);
if (!q) return true;
const qBot = q.height * (1 - (opts.bottom ?? 0.06));
const ci = (q.columns || []).findIndex((c) => Math.min(c.x1, f.x1) - Math.max(c.x0, f.x0) > 0.5 * Math.min(c.x1 - c.x0, f.x1 - f.x0));
let last = ci >= 0 ? q.inkBottoms?.[ci] ?? null : null;
if (last == null) {
const inside = (q.lines || []).filter((ln) => { const cx = (ln.x0 + ln.x1) / 2; return cx >= f.x0 && cx <= f.x1 && ln.y0 >= f.y0 - 2 && ln.y1 <= f.y1 + 2; });
if (!inside.length) return true;
last = Math.max(...inside.map((ln) => ln.y1));
}
return Math.min(f.y1, qBot) - last <= Math.max(q.height * 0.05, 40);
};
const laneOffset = anchors.laneOffset || (() => null);
/**
* 단 맨 위(첫 번호 앞) 영역을 앞 항목에 이어 붙일지.
* - 해설: 예전처럼 늘 이어 붙인다 (그래프·표가 안 들어가 일찍 단을 넘긴 해설도 이어진다).
* - 문제: 앞 문제가 자기 단 끝까지 찼고, 이 영역이 들여쓴 그림·선택지로 시작하며, 영역 안에 번호 자리에서 시작하는
*   글 블록(단원 제목 아래 도입 글·개념 글)이 없을 때만. 번호 자리의 선택지 줄·소문항 (1) 줄은 문제의 일부로 본다.
*   (글자가 거의 없는 번호 자리 블록 — 그림·표, OCR이 원 번호를 못 읽은 선택지 — 은 문제의 일부일 수 있어 막지 않는다)
*/
const continuesInto = (p, ci, firstY) => {
if (opts.kind === 'solution') return true;
if (!reachesBottom(current)) return false;
if (anchors.conceptColumn?.(p, ci) && firstY >= p.height * (1 - (opts.bottom ?? 0.06)) - 1) return false; // 문제 블록이 없는 단 전체
const vs = (p.visualStarts || []).filter((x) => x.col === ci && x.y0 < firstY).sort((x, y) => x.y0 - y.y0);
if (!vs.length) return true;
// 번호 자리에서 시작해도 문제의 일부인 줄: 한 줄에 원 번호가 여럿인 선택지 줄, (1) 소문항 (원 번호 하나로 시작하는 줄은 소제목일 수 있어 제외)
const partOfProblem = (v) => linesAt(p, v).some((l) => (String(l.text || '').match(CIRCLED_ALL) || []).length >= 2 || parseAnchor(l)?.style === 'paren');
const prose = (v) => linesAt(p, v).some((l) => hangulCount(l.text) >= 5);
return (laneOffset(p, vs[0]) === 1 || partOfProblem(vs[0])) && !vs.slice(1).some((v) => laneOffset(p, v) === 0 && !partOfProblem(v) && prose(v));
};
let current = null;
for (const p of pages) {
const yTop = p.height * (opts.top ?? 0.07);
const yBot = p.height * (1 - (opts.bottom ?? 0.06));
const guardX = Math.max(8, p.width * 0.008);
const captureBounds = (ci) => {
const col = p.columns[ci];
const leftLimit = ci ? (p.columns[ci - 1].x1 + col.x0) / 2 : 0;
const rightLimit = ci + 1 < p.columns.length ? (col.x1 + p.columns[ci + 1].x0) / 2 : p.width;
return { x0: Math.max(leftLimit, col.x0 - guardX), x1: Math.min(rightLimit, col.x1 + guardX) };
};
p.columns.forEach((col, ci) => {
const capture = captureBounds(ci);
const list = byPageCol.get(p.index + ':' + ci) || [];
const firstY = list.length ? (list[0].cutY ?? list[0].y0) : yBot;
// 번호를 못 찾은 쪽이 계속되면 한 문제가 다음 단/쪽으로 이어질 수 있다
if (continuation && current && firstY - yTop > p.height * 0.02 && current.fragments.length < MAX_CONT_FRAGMENTS && continuesInto(p, ci, firstY)) {
current.fragments.push({ page: p.index, x0: capture.x0, y0: yTop, x1: capture.x1, y1: firstY - 2, cont: true });
}
list.forEach((a, k) => {
const pad = Math.max(4, a.h * 0.35);
const next = list[k + 1];
const y0 = Math.max(yTop, a.cutY ?? (a.y0 - pad));
const y1 = next ? Math.max(y0 + 2, next.cutY ?? (next.y0 - pad * 0.5)) : yBot;
const confidence = a.num == null ? (a.confidence ?? 0.4) : (a.score || 0) / (a.inferred ? 3 : 1.5);
current = {
section: a.section, number: a.number, ...(a.series ? { label: a.series } : {}),
detection: {
source: a.num == null ? 'visual' : a.source || 'ocr', inferred: !!a.inferred,
...(a.ocrNumber != null ? { ocrNumber: a.ocrNumber } : {}),
...(a.labelWord ? { label: a.labelWord } : {}),
confidence: Math.max(0, Math.min(1, confidence)),
},
fragments: [{ page: p.index, x0: capture.x0, y0, x1: capture.x1, y1 }],
};
items.push(current);
});
});
}
return items;
}
/** 조각 안의 텍스트 */
function textInFragments(pagesByIndex, fragments) {
const out = [];
for (const f of fragments) {
const p = pagesByIndex.get(f.page);
if (!p) continue;
for (const ln of p.lines) {
const cx = (ln.x0 + ln.x1) / 2, cy = (ln.y0 + ln.y1) / 2;
if (cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1) out.push(ln.text);
}
}
return out.join('\n');
}
/** 항목 번호 (예제·유제·연습문제는 라벨을 붙여 본문 번호와 구분: "유제 1-2") */
function itemKey(it) {
return `${it.label ? it.label + ' ' : ''}${it.section}-${it.number}`;
}
/**
* 문제 ↔ 해설 매칭. section-number가 같으면 연결, 없으면 번호만으로(유일할 때) 연결.
* 양쪽 모두 읽은 번호(추정 아님)끼리 먼저 잇고, 추정 번호가 낀 연결은 남은 해설로만 하며 solutionInferred(확인 필요)로 표시한다.
* 그래야 여백으로 센 추정 번호가 제대로 읽힌 문제의 해설을 가져가지 않는다.
*/
function matchSolutions(problems, solutions) {
const lexical = (it) => !it.detection?.inferred;
const byKey = new Map(solutions.map((s) => [itemKey(s), s]));
// 번호만으로 잇는 것도 같은 번호 체계(라벨) 안에서만 (예제 1을 유제 1 해설에 잇지 않도록)
const numKey = (it) => `${it.label || ''}|${it.number}`;
const byNum = new Map();
for (const s of solutions) byNum.set(numKey(s), byNum.has(numKey(s)) ? null : s);
// 번호만으로 잇는 것은 문제 쪽에서도 그 번호가 하나뿐일 때만 (여러 단원의 같은 번호를 한 해설에 잇지 않도록)
const probCount = new Map();
for (const p of problems) probCount.set(numKey(p), (probCount.get(numKey(p)) || 0) + 1);
const claimed = new Set();
let matched = 0;
const link = (p, s, verified) => { p.solutionId = s.id; p.solutionInferred = !verified; claimed.add(s.id); matched++; };
for (const p of problems) { p.solutionId = null; p.solutionInferred = false; }
// 1) 읽은 번호 ↔ 읽은 번호
for (const p of problems) {
if (!lexical(p)) continue;
const s = byKey.get(itemKey(p)) || (probCount.get(numKey(p)) === 1 ? byNum.get(numKey(p)) : null);
if (s && lexical(s) && !claimed.has(s.id)) link(p, s, true);
}
// 2) 남은 것: 번호가 앞뒤와 안 맞아 순서로 바꾼 문제는 OCR이 읽은 번호를 먼저, 그다음 자기 번호로 (모두 확인 필요)
const rest = problems.filter((p) => !p.solutionId).sort((x, y) => (y.detection?.ocrNumber != null) - (x.detection?.ocrNumber != null));
for (const p of rest) {
const keys = p.detection?.ocrNumber != null ? [itemKey({ ...p, number: p.detection.ocrNumber }), itemKey(p)] : [itemKey(p)];
for (const k of keys) {
const s = byKey.get(k);
if (s && !claimed.has(s.id)) { link(p, s, false); break; }
}
}
return matched;
}
/**
* 해설 텍스트에서 정답 추출. "정답 ③", "[정답] ③", "정답은 ③", "답: 12", "해답 ③", "정답 -3", "정답 1/2"
* "해답 1. …"처럼 번호가 붙은 제목·"정답률"은 무시하고, "2√3"처럼 일부만 읽힐 답은 틀린 값 대신 null
*/
const ANSWER_RE = /(정답|해답|답)\s*[\]】)]?\s*(?:은|는|[:：])?\s*([①②③④⑤]|[-−]?\d{1,4}(?:\.\d+)?(?:\s*\/\s*\d{1,4})?)(?![\d√\/^]|\.\d)/g;
function extractAnswer(text) {
if (!text) return null;
const s = String(text);
for (const m of s.matchAll(ANSWER_RE)) {
if (m[1] === '해답' && /^\s*\d+\s*[.)]/.test(s.slice(m.index + 2))) continue; // "해답 1. 풀이" 같은 제목
return m[2].replace('−', '-').replace(/\s+/g, '');
}
return null;
}
/** 문제 텍스트에서 배점 추출 */
function extractPoints(text) {
if (!text) return null;
// "[4점]" "(4점)" 형태를 우선, 없으면 줄 끝에 단독으로 있는 "4점" ("14점", "2.4점", "두 점" 등은 제외)
const m = text.match(/[\[(【]\s*([2-4])\s*점\s*[\])】]/) || text.match(/(?:^|[^\d.])([2-4])\s*점\s*$/m);
return m ? parseInt(m[1], 10) : null;
}
return { parseAnchorNumber, parseAnchor, findCandidates, chainAnchors, selectAnchors, buildAnchors, segmentPages, matchPrevious, textInFragments, itemKey, matchSolutions, extractAnswer, extractPoints };
})();
M.grade = (() => {
const BOOK_LEVELS = {
auto:     { label: '모름/혼합 (1~9)', range: [1, 9] },
concept:  { label: '개념서 (4~9)', range: [4, 9] },
basic:    { label: '기본 유형서 (3~8)', range: [3, 8] },
advanced: { label: '실력·심화서 (2~6)', range: [2, 6] },
exam:     { label: '기출·모의고사 (1~7)', range: [1, 7] },
killer:   { label: '최상위·킬러 (1~3)', range: [1, 3] },
};
const HARD_KEYWORDS = [
'(가)', '(나)', '(다)', '조건을 만족', '모든 실수', '서로 다른', '최댓값', '최솟값', '개수', '합의 최댓값',
'미분가능', '연속', '실수 전체의 집합', '만족시키는', '<보기>', '보기', 'ㄱ', 'ㄴ', 'ㄷ', '역함수', '합성함수',
'절댓값', '극값', '변곡점', '넓이', '정적분', '수열', '귀납', '확률', '경우의 수', '벡터', '이차곡선',
];
function keywordCount(text) {
if (!text) return 0;
let c = 0;
for (const k of HARD_KEYWORDS) if (text.includes(k)) c++;
return c;
}
function nonSpaceLen(t) { return t ? t.replace(/\s/g, '').length : 0; }
/** 문제 하나의 원시 특징값 */
function features(problem, solution, sectionMax) {
const ph = problem.pageHeight || 1;
return {
pos: sectionMax > 1 ? (problem.number - 1) / (sectionMax - 1) : 0.5,
height: Math.log(1 + (problem.h || 0) / ph * 10),
len: Math.log(1 + nonSpaceLen(problem.text)),
kw: keywordCount(problem.text),
pts: problem.points ?? null,
sol: solution ? Math.log(1 + (solution.h || 0) / (solution.pageHeight || 1) * 10) + 0.3 * Math.log(1 + nonSpaceLen(solution.text)) : null,
};
}
const WEIGHTS = { sol: 0.35, pts: 0.3, pos: 0.2, height: 0.15, len: 0.1, kw: 0.1 };
function zscores(values) {
const v = values.filter((x) => x != null && Number.isFinite(x));
if (v.length < 2) return values.map((x) => (x == null ? null : 0));
const m = v.reduce((a, b) => a + b, 0) / v.length;
const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
return values.map((x) => (x == null || !Number.isFinite(x) ? null : (x - m) / sd));
}
/**
* 한 권의 문제 전체에 규칙 기반 난이도 부여.
* problems: 문제 목록, solutionsById: Map, level: BOOK_LEVELS 키
* 반환: [{id, score, grade, features}]
*/
function heuristicGrades(problems, solutionsById, level = 'auto') {
if (!problems.length) return [];
const secMax = new Map();
for (const p of problems) secMax.set(p.section, Math.max(secMax.get(p.section) || 0, p.number));
const feats = problems.map((p) => features(p, solutionsById.get(p.solutionId), secMax.get(p.section)));
const keys = Object.keys(WEIGHTS);
const z = {};
for (const k of keys) z[k] = zscores(feats.map((f) => f[k]));
const scores = feats.map((_, i) => {
let s = 0, w = 0;
for (const k of keys) if (z[k][i] != null) { s += WEIGHTS[k] * z[k][i]; w += WEIGHTS[k]; }
return w ? s / w : 0;
});
const order = scores.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
const pct = new Array(scores.length);
order.forEach(([, i], r) => { pct[i] = scores.length > 1 ? r / (scores.length - 1) : 0.5; });
const [hard, easy] = (BOOK_LEVELS[level] || BOOK_LEVELS.auto).range;
return problems.map((p, i) => ({
id: p.id,
score: scores[i],
grade: Math.round(easy - pct[i] * (easy - hard)),
features: feats[i],
}));
}
/** 실제로 사용할 등급: 수동 > AI > 규칙 */
function effectiveGrade(p) {
return p.gradeManual ?? p.gradeLLM ?? p.gradeHeur ?? null;
}
function gradeSource(p) {
if (p.gradeManual != null) return '수동';
if (p.gradeLLM != null) return 'AI';
if (p.gradeHeur != null) return '규칙';
return '-';
}
return { BOOK_LEVELS, keywordCount, features, heuristicGrades, effectiveGrade, gradeSource };
})();
M.classify = (() => {
const UNCLASSIFIED = '미분류';
const AREAS = ['공통수학', '대수·수학I', '수학II·미적분', '확률과 통계', '기하'];
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
/**
* 비교용 텍스트: 전각·첨자 통일, "실수 전체의 집합" 같은 관용구 제거.
* raw는 띄어쓰기를 지킨 글(짧은 낱말용), flat은 공백을 모두 지운 글(인식 과정의 띄어쓰기 잡음에 강함)
*/
function prepare(text) {
const raw = String(text || '').normalize('NFKC').replace(/[′’`]/g, "'").replace(/[−–]/g, '-').replace(/->|⟶|➝/g, '→')
.replace(/\s+/g, ' ').replace(/(실수|자연수|정수|유리수|양의 ?실수|음이 ?아닌 ?정수) ?전체의 ?집합/g, ' ');
const flat = raw.replace(/\s+/g, '');
// flat에서 낱말이 시작하는 위치 (raw의 공백 바로 다음 글자)
const starts = new Set();
for (let ri = 0, fi = 0; ri < raw.length; ri++) {
if (raw[ri] === ' ') continue;
if (ri === 0 || raw[ri - 1] === ' ') starts.add(fi);
fi++;
}
return { raw, flat, lower: asciiLower(flat), rawLower: asciiLower(raw), starts };
}
/**
* 한 낱말 키워드: 낱말 안에서 찾거나("등차수열" ⊃ "수열"), 띄어 쓴 형태("평균 변화율", 줄바꿈된 "변곡\n점")는
* 낱말 첫머리에서 시작할 때만 인정한다. 그래서 "…이므로 그 함수"(로그함수)·"주어진 수"(진수)처럼
* 앞 낱말 끝에서 시작하는 우연한 일치는 걸러진다. 여러 낱말로 된 구절은 공백을 지운 글에서 찾는다.
*/
const word = (text, w) => {
const key = prepare(text).lower;
if (/\s/.test(text)) return { label: text, w, test: (t) => t.lower.includes(key) };
return {
label: text, w,
test: (t) => {
if (t.rawLower.includes(key)) return true;
for (let i = t.lower.indexOf(key); i >= 0; i = t.lower.indexOf(key, i + 1)) if (t.starts.has(i)) return true;
return false;
},
};
};
const pattern = (re, w, label, field = 'flat') => ({ label, w, test: (t) => re.test(t[field]) });
/** 초월함수(지수·로그·삼각함수) 근거가 있어야 성립하는 규칙. 수학II 계열 책에서는 인식 잡음으로 보고 쓰지 않는다 */
const trans = (rule) => ({ ...rule, trans: true });
const combo = (label, w, ...tests) => trans({ label, w, test: (t) => tests.every((f) => f(t)) });
const LN = /(^|[^a-z])ln(?=[\s(x]|$)/i;
const isTrans = (t) => /sin|cos|tan|log|e\^|지수함수|삼각함수/i.test(t.flat) || /(^|[^프블])로그/.test(t.raw) || LN.test(t.raw);
// 함수 이름은 소문자(f'(x)), 점·집합 이름은 대문자(A'(a, b), X → X)이므로 대소문자를 구분한다
const isDiff = (t) => /미분|도함수|접선|극[대소]|극[댓솟]값/.test(t.raw) || /[a-z]'\(/.test(t.flat);
const isInteg = (t) => /적분|∫/.test(t.raw);
/** 한국 고등학교 수학 단원 기준 유형. 같은 점수면 앞에 있는 유형이 우선한다. */
const TYPES = [
{ label: '다항식', area: '공통수학', rules: [
word('다항식', 2), word('나머지정리', 3), word('인수정리', 3), word('조립제법', 3), word('항등식', 2), word('인수분해', 2),
word('나누었을 때의 나머지', 3), word('나눈 나머지', 3), word('곱셈 공식', 2), word('몫', 1)] },
{ label: '방정식과 부등식', area: '공통수학', rules: [
word('복소수', 3), word('허수', 2), word('켤레', 2), word('판별식', 3), word('근과 계수', 3), word('이차 방정식', 2),
word('삼차 방정식', 2), word('사차 방정식', 2), word('연립 방정식', 2), word('연립 부등식', 2), word('이차 부등식', 2),
word('허근', 2), word('실근', 1), word('중근', 1), word('이차함수', 1), word('부등식', 1)] },
{ label: '행렬', area: '공통수학', rules: [word('행렬', 3), word('단위행렬', 2), word('역행렬', 2)] },
{ label: '도형의 방정식', area: '공통수학', rules: [
word('좌표평면', 1), word('두 점 사이의 거리', 3), word('내분', 2), word('외분', 2), word('직선의 방정식', 3), word('원의 방정식', 3),
word('원의 중심', 2), word('반지름', 1), word('기울기', 1), word('평행이동', 2), word('대칭이동', 2), word('수직이등분선', 2),
word('점과 직선 사이의 거리', 3), pattern(/x\^?2\+y\^?2/i, 1.5, 'x²+y²')] },
{ label: '집합과 명제', area: '공통수학', rules: [
word('집합', 2), word('원소', 1), word('부분집합', 2), word('교집합', 2), word('합집합', 2), word('여집합', 2), word('차집합', 2),
word('명제', 3), word('필요조건', 3), word('충분조건', 3), word('필요충분', 2), word('진리집합', 2), word('대우', 2),
word('절대부등식', 3), word('산술평균', 2), word('기하평균', 2), pattern(/[∈∉⊂⊄⊆⊇]/, 2, '집합 기호')] },
{ label: '함수와 그래프', area: '공통수학', rules: [
word('합성함수', 3), word('역함수', 3), word('일대일대응', 3), word('일대일 함수', 3), word('항등함수', 2), word('상수함수', 1),
word('정의역', 1), word('치역', 2), word('공역', 2), word('유리함수', 3), word('무리함수', 3), word('분수함수', 2), word('점근선', 1),
pattern(/∘/, 2, 'f∘g')] },
{ label: '지수와 로그', area: '대수·수학I', rules: [
word('거듭제곱근', 3), word('지수법칙', 3), word('제곱근', 1), word('세제곱근', 2), pattern(/(^|[^프블])로그/, 2, '로그', 'raw'),
pattern(/log/i, 2, 'log'), word('진수', 2), word('상용로그', 3), word('지표', 1), word('가수', 1)] },
{ label: '지수함수와 로그함수', area: '대수·수학I', rules: [
word('지수 함수', 3), word('로그함수', 3), word('지수 방정식', 3), word('로그방정식', 3), word('지수 부등식', 3), word('로그부등식', 3),
pattern(/(^|[^가-힣])로그 (함수|방정식|부등식)/, 3, '로그 함수', 'raw'),
pattern(/y=log/i, 3, 'y=log'), pattern(/y=\(?\d+(\/\d+)?\)?\^x/i, 2, 'y=aˣ'), word('점근선', 1)] },
{ label: '삼각함수', area: '대수·수학I', rules: [
word('삼각 함수', 3), pattern(/sin|cos|tan/i, 3, 'sin·cos·tan'), word('사인법칙', 3), word('코사인법칙', 3), word('라디안', 3),
word('호도법', 3), word('부채꼴', 2), word('일반각', 3), word('동경', 2), word('주기', 1)] },
{ label: '수열', area: '대수·수학I', rules: [
word('수열', 3), word('등차', 2), word('등비', 2), word('공차', 3), word('공비', 3), word('첫째항', 3), word('일반항', 2),
pattern(/[Σ∑]/, 3, 'Σ'), word('시그마', 3), word('수학적 귀납법', 3), word('귀납', 1), word('점화식', 3), word('계차', 3),
pattern(/(^|[^a-z])a_?[({]?n\+1/i, 2, 'aₙ₊₁'), pattern(/(^|[^a-z])a_?[({]?n([^a-z+]|$)/i, 1, 'aₙ')] },
{ label: '함수의 극한과 연속', area: '수학II·미적분', rules: [
word('함수의 극한', 3), word('극한값', 2), pattern(/lim/i, 1, 'lim'), pattern(/x→/, 2, 'x→'), word('좌극한', 3), word('우극한', 3),
word('연속', 1), word('불연속', 2), word('사잇값', 3), word('최대·최소 정리', 2)] },
{ label: '다항함수의 미분', area: '수학II·미적분', rules: [
word('미분', 2), word('미분계수', 2), word('평균변화율', 3), word('순간변화율', 3), word('도함수', 3), pattern(/[a-z]'\(/, 3, "f'(x)"),
word('미분가능', 1), word('접선의 방정식', 2), word('접선의 기울기', 2), word('극대', 2), word('극소', 2), word('극값', 2),
word('극댓값', 2), word('극솟값', 2), word('증가', 1), word('감소', 1), word('가속도', 1), word('속도', 1),
word('삼차함수', 1), word('사차함수', 1), word('다항함수', 1), word('최댓값', 0.5), word('최솟값', 0.5)] },
{ label: '다항함수의 적분', area: '수학II·미적분', rules: [
word('적분', 2), word('부정적분', 2), word('정적분', 2), pattern(/∫/, 3, '∫'), word('넓이', 1), word('둘러싸인', 2),
word('움직인 거리', 2), word('원시함수', 3), word('적분상수', 2)] },
{ label: '수열의 극한', area: '수학II·미적분', rules: [
word('수열의 극한', 4), word('급수', 3), word('등비급수', 2), word('무한등비', 3), pattern(/n→∞/i, 4, 'n→∞'), pattern(/limn/i, 3, 'lim n'),
word('수렴', 1), word('발산', 1)] },
{ label: '여러 가지 함수의 미분', area: '수학II·미적분', rules: [
word('자연로그', 2), trans(pattern(LN, 3, 'ln', 'raw')), trans(pattern(/(^|[^a-z])e\s?\^?\s?x([^a-z]|$)/i, 1.5, 'eˣ', 'raw')),
word('몫의 미분', 4), word('합성함수의 미분', 4), word('역함수의 미분', 4), word('음함수', 3), word('매개변수', 3),
word('이계도함수', 3), word('변곡점', 3), word('오목', 2), word('볼록', 2), word('속력', 1), combo('미분 + 초월함수', 3, isDiff, isTrans)] },
{ label: '여러 가지 함수의 적분', area: '수학II·미적분', rules: [
word('치환적분', 4), word('부분적분', 4), word('구분구적', 3), word('부피', 2), word('입체도형', 1), combo('적분 + 초월함수', 3, isInteg, isTrans)] },
{ label: '경우의 수', area: '확률과 통계', rules: [
word('경우의 수', 3), word('순열', 3), word('조합', 2), word('중복조합', 2), word('원순열', 2), word('이항정리', 3), word('이항계수', 3),
word('파스칼', 2), word('방법의 수', 3), word('일렬로', 2), word('나열', 1), word('택하는', 1), word('뽑는', 1), word('선택하는', 1)] },
{ label: '확률', area: '확률과 통계', rules: [
pattern(/확률(?!변수|분포|밀도)/, 3, '확률'), word('조건부확률', 2), word('독립', 2), word('종속', 2), word('여사건', 3), word('배반', 3),
word('시행', 1), word('사건', 1), pattern(/P\([A-WYZ](\)|[∩∪|]|\^?c)/, 2, 'P(A)'), word('주사위', 1), word('동전', 1), word('꺼낼 때', 1)] },
{ label: '통계', area: '확률과 통계', rules: [
word('확률 변수', 3), word('확률 분포', 3), word('기댓값', 3), word('평균', 1), word('분산', 3), word('표준 편차', 3), word('이항 분포', 3),
word('정규 분포', 3), word('표본', 2), word('모평균', 3), word('모표준편차', 3), word('신뢰 구간', 3), word('신뢰도', 2), word('확률 밀도', 3),
pattern(/[EVσ]\(X\)|P\(X[=<>≤≥]/, 3, 'E(X)·P(X=…)')] },
{ label: '이차곡선', area: '기하', rules: [
word('이차곡선', 3), word('포물선', 2), word('타원', 3), word('쌍곡선', 3), word('초점', 2), word('준선', 3), word('장축', 3),
word('단축', 3), word('주축', 3), word('점근선', 1)] },
{ label: '평면벡터', area: '기하', rules: [
word('벡터', 3), word('내적', 3), word('위치벡터', 2), word('단위벡터', 2), word('영벡터', 2), word('방향벡터', 1), word('법선벡터', 1)] },
{ label: '공간도형과 공간좌표', area: '기하', rules: [
word('정사영', 3), word('이면각', 3), word('삼수선', 3), word('공간좌표', 3), word('좌표공간', 3), word('구의 방정식', 3),
word('꼬인 위치', 3), pattern(/평면[αβγ]/, 2, '평면 α'), word('xy평면', 3), word('yz평면', 3), word('zx평면', 3), word('사면체', 2),
word('정육면체', 1), word('직육면체', 1), word('수선의 발', 1), pattern(/z축/i, 2, 'z축')] },
];
const TYPE_INDEX = new Map(TYPES.map((t, i) => [t.label, i]));
const POLY_DIFF = TYPE_INDEX.get('다항함수의 미분'), MULTI_DIFF = TYPE_INDEX.get('여러 가지 함수의 미분');
const POLY_INT = TYPE_INDEX.get('다항함수의 적분'), MULTI_INT = TYPE_INDEX.get('여러 가지 함수의 적분');
const normSubject = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, '');
const SUBJECT_TYPES = new Map(Object.entries({
'수학(상)': ['다항식', '방정식과 부등식', '도형의 방정식'],
'수학(하)': ['집합과 명제', '함수와 그래프', '경우의 수'],
'공통수학1': ['다항식', '방정식과 부등식', '경우의 수', '행렬'],
'공통수학2': ['도형의 방정식', '집합과 명제', '함수와 그래프'],
'수학I': ['지수와 로그', '지수함수와 로그함수', '삼각함수', '수열'],
'대수': ['지수와 로그', '지수함수와 로그함수', '삼각함수', '수열'],
'수학II': ['함수의 극한과 연속', '다항함수의 미분', '다항함수의 적분'],
'미적분I': ['함수의 극한과 연속', '다항함수의 미분', '다항함수의 적분'],
'미적분': ['수열의 극한', '여러 가지 함수의 미분', '여러 가지 함수의 적분'],
'미적분II': ['수열의 극한', '여러 가지 함수의 미분', '여러 가지 함수의 적분'],
'확률과 통계': ['경우의 수', '확률', '통계'],
'기하': ['이차곡선', '평면벡터', '공간도형과 공간좌표'],
}).map(([k, v]) => [normSubject(k), new Set(v)]));
const MIN_SCORE = 2;
/** 문제(가중치 1)와 연결된 해설(가중치 0.5)의 글자로 유형 점수를 매긴다. */
function scoreProblem(problem, solution, subject) {
const scores = new Array(TYPES.length).fill(0);
const reasons = TYPES.map(() => []);
const favored = SUBJECT_TYPES.get(normSubject(subject));
const polyBook = !!favored?.has('다항함수의 미분'); // 수학II·미적분I: 초월함수를 다루지 않는다
let transcendental = false;
const add = (text, weight) => {
const t = prepare(text);
if (!t.flat) return;
if (isTrans(t)) transcendental = true;
TYPES.forEach((type, i) => {
for (const rule of type.rules) {
if ((rule.trans && polyBook) || !rule.test(t)) continue;
scores[i] += rule.w * weight;
if (!reasons[i].includes(rule.label)) reasons[i].push(rule.label);
}
});
};
add(problem?.text, 1);
add(solution?.text, 0.5);
// 초월함수(지수·로그·삼각함수)를 미분·적분하면 미적분 단원이다.
if (transcendental && !polyBook) {
for (const [from, to] of [[POLY_DIFF, MULTI_DIFF], [POLY_INT, MULTI_INT]]) {
if (!scores[from]) continue;
scores[to] += scores[from]; scores[from] = 0;
for (const r of reasons[from]) if (!reasons[to].includes(r)) reasons[to].push(r);
}
}
if (favored) scores.forEach((s, i) => { if (s > 0 && favored.has(TYPES[i].label)) scores[i] = s * 1.3; });
let best = 0;
for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
const top = scores[best];
const second = Math.max(0, ...scores.filter((_, i) => i !== best));
const type = top >= MIN_SCORE ? TYPES[best].label : null;
return { type, score: top, strong: top >= 3 && top - second >= 1, reasons: type ? reasons[best].slice(0, 4) : [] };
}
/**
* 한 권의 문제를 분류한다. 글자 근거가 약한 문제는 같은 단원 안의 앞뒤 문제 유형으로 보정한다
* (문제집은 보통 같은 유형을 연달아 싣는다). 반환: Map(id → {type, source:'rule'|'neighbor'|null, reasons, score})
*/
function classifyBook(problems, solutionsById = new Map(), subject = '') {
const ordered = problems.slice().sort((a, b) => ((a.section ?? 1) - (b.section ?? 1)) || (a.number - b.number));
const base = ordered.map((p) => ({ p, ...scoreProblem(p, solutionsById.get(p.solutionId), p.subjectLLM || subject) }));
const nearest = (i, dir) => {
for (let j = i + dir, d = 1; j >= 0 && j < base.length && d <= 3; j += dir, d++) {
if ((base[j].p.section ?? 1) !== (base[i].p.section ?? 1)) return null;
if (base[j].strong) return { type: base[j].type, d };
}
return null;
};
const out = new Map();
base.forEach((b, i) => {
let type = b.type, source = type ? 'rule' : null, reasons = b.reasons;
if (!b.strong) {
const prev = nearest(i, -1), next = nearest(i, 1);
if (prev && next && prev.type === next.type) {
if (type !== prev.type) { type = prev.type; source = 'neighbor'; reasons = []; }
} else if (!type) {
const only = prev && !next ? prev : next && !prev ? next : null;
if (only && only.d <= 2) { type = only.type; source = 'neighbor'; reasons = []; }
}
}
out.set(b.p.id, { type, source, reasons, score: b.score });
});
return out;
}
const ALIASES = {
'미분': '다항함수의 미분', '적분': '다항함수의 적분', '미분법': '여러 가지 함수의 미분', '적분법': '여러 가지 함수의 적분',
'도함수의활용': '다항함수의 미분', '정적분의활용': '다항함수의 적분', '함수': '함수와 그래프', '순열과조합': '경우의 수',
'순열': '경우의 수', '조합': '경우의 수', '통계적추정': '통계', '확률분포': '통계', '벡터': '평면벡터',
'공간도형': '공간도형과 공간좌표', '공간좌표': '공간도형과 공간좌표', '지수': '지수와 로그', '로그': '지수와 로그',
'지수함수': '지수함수와 로그함수', '로그함수': '지수함수와 로그함수', '극한': '함수의 극한과 연속',
'방정식': '방정식과 부등식', '부등식': '방정식과 부등식', '도형': '도형의 방정식', '집합': '집합과 명제', '명제': '집합과 명제',
'여러가지미분법': '여러 가지 함수의 미분', '여러가지적분법': '여러 가지 함수의 적분',
};
const NO_TYPE = new Set(['미분류', '기타', '없음', '모름', 'null', 'none', 'unknown', 'n/a']);
// 단원 이름이 과목 밖 유형으로 풀렸을 때 그 과목 안의 유형으로 옮긴다 (예: 미적분의 "삼각함수의 극한" → 여러 가지 함수의 미분)
const CALCULUS_REMAP = {
'다항함수의 미분': '여러 가지 함수의 미분', '다항함수의 적분': '여러 가지 함수의 적분', '함수의 극한과 연속': '여러 가지 함수의 미분',
'삼각함수': '여러 가지 함수의 미분', '지수함수와 로그함수': '여러 가지 함수의 미분', '지수와 로그': '여러 가지 함수의 미분', '수열': '수열의 극한',
};
const POLY_REMAP = { '여러 가지 함수의 미분': '다항함수의 미분', '여러 가지 함수의 적분': '다항함수의 적분' };
const SUBJECT_REMAP = new Map([['미적분', CALCULUS_REMAP], ['미적분II', CALCULUS_REMAP], ['수학II', POLY_REMAP], ['미적분I', POLY_REMAP]]);
/**
* AI가 돌려준 유형·단원 이름을 표준 유형으로 맞춘다. 목록의 이름과 정확히 같으면 그대로 믿고,
* 추정한 경우에는 과목 안의 유형만 받아들인다. 알 수 없으면 null (자동 분류에 맡김)
*/
const normCache = new Map();
function normalizeType(value, subject) {
const ck = `${value ?? ''}\u0000${subject ?? ''}`;
if (normCache.has(ck)) return normCache.get(ck);
const r = normalizeTypeUncached(value, subject);
if (normCache.size > 5000) normCache.clear();
normCache.set(ck, r);
return r;
}
function normalizeTypeUncached(value, subject) {
const s = String(value ?? '').normalize('NFKC').trim();
const key = s.replace(/\s+/g, '').toLowerCase();
if (!key || NO_TYPE.has(key)) return null;
const exact = TYPES.find((t) => t.label.replace(/\s+/g, '') === key);
if (exact) return exact.label;
const type = ALIASES[key] || scoreProblem({ text: s }, null, subject).type;
const sk = normSubject(subject);
const allowed = SUBJECT_TYPES.get(sk);
if (!type || !allowed || allowed.has(type)) return type;
return SUBJECT_REMAP.get(sk)?.[type] ?? null;
}
/** 실제로 쓸 유형: 직접 지정 > AI > 자동. bookSubject는 AI가 과목을 남기지 않은 예전 기록에 쓴다 */
function effectiveType(p, auto, bookSubject = '') {
if (p.typeManual) return { type: p.typeManual, source: '수동', reasons: [] };
const ai = p.typeLLM || (p.unit ? normalizeType(p.unit, p.subjectLLM || bookSubject) : null);
if (ai) return { type: ai, source: 'AI', reasons: [] };
if (auto?.type) return { type: auto.type, source: auto.source === 'neighbor' ? '자동·앞뒤 문제' : '자동', reasons: auto.reasons || [] };
return { type: UNCLASSIFIED, source: '', reasons: [] };
}
const isStandardType = (label) => TYPE_INDEX.has(label);
const typeRank = (label) => (TYPE_INDEX.has(label) ? TYPE_INDEX.get(label) : label === UNCLASSIFIED ? TYPES.length + 1 : TYPES.length);
/** 표준 유형 순서 → 직접 만든 유형(가나다순) → 미분류 */
function compareTypes(a, b) {
return (typeRank(a) - typeRank(b)) || String(a).localeCompare(String(b), 'ko');
}
return {
UNCLASSIFIED, AREAS, TYPES: TYPES.map(({ label, area }) => ({ label, area })), TYPE_LABELS: TYPES.map((t) => t.label),
scoreProblem, classifyBook, normalizeType, effectiveType, isStandardType, compareTypes,
};
})();
M.select = (() => {
const { effectiveGrade } = M.grade;
function rng(seed) {
let a = seed >>> 0 || 1;
return () => {
a |= 0; a = (a + 0x6d2b79f5) | 0;
let t = Math.imul(a ^ (a >>> 15), 1 | a);
t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
}
function shuffle(arr, rand) {
const a = arr.slice();
for (let i = a.length - 1; i > 0; i--) {
const j = Math.floor(rand() * (i + 1));
[a[i], a[j]] = [a[j], a[i]];
}
return a;
}
const MIX_PRESETS = {
balanced: { label: '균형 (쉬움 20 / 목표 60 / 도전 20)', easier: 0.2, target: 0.6, harder: 0.2 },
focus:    { label: '목표 집중 (10 / 80 / 10)', easier: 0.1, target: 0.8, harder: 0.1 },
push:     { label: '도전형 (10 / 50 / 40)', easier: 0.1, target: 0.5, harder: 0.4 },
review:   { label: '복습형 (40 / 50 / 10)', easier: 0.4, target: 0.5, harder: 0.1 },
};
function filterPool(pool, opts = {}) {
return pool.filter((p) => {
if (effectiveGrade(p) == null || !p.image) return false;
if (opts.requireSolution && !p.solutionId) return false;
if (opts.bookIds?.length && !opts.bookIds.includes(p.bookId)) return false;
if (opts.subjects?.length && !opts.subjects.includes(p.subject)) return false;
// 끈 것만 빼는 방식: 새로 생긴 책·과목·유형은 기본으로 포함되고, 모두 끄면 아무것도 고르지 않는다
if (opts.excludeBookIds?.includes(p.bookId)) return false;
if (opts.excludeSubjects?.includes(p.subject)) return false;
if (opts.excludeTypes?.length && opts.excludeTypes.includes(p.type)) return false;
return true;
});
}
/**
* pool: 문제 목록, opts: {target(1~9), count, mix, seed, requireSolution, bookIds, subjects, excludeTypes}
* 쉬운 문제 → 어려운 문제 순으로 정렬해서 반환
*/
function selectProblems(pool, opts) {
const target = opts.target;
const count = opts.count;
const mix = opts.mix || MIX_PRESETS.balanced;
const rand = rng(opts.seed ?? Date.now());
const cand = shuffle(filterPool(pool, opts), rand);
const g = (p) => effectiveGrade(p);
const buckets = {
harder: cand.filter((p) => g(p) < target && g(p) >= target - 2),
target: cand.filter((p) => g(p) === target),
easier: cand.filter((p) => g(p) > target && g(p) <= target + 2),
};
const quota = {
harder: target === 1 ? 0 : Math.round(count * mix.harder),
easier: target === 9 ? 0 : Math.round(count * mix.easier),
};
quota.target = Math.max(0, count - quota.harder - quota.easier);
const chosen = new Set();
const take = (list, n) => {
for (const p of list) {
if (n <= 0) break;
if (!chosen.has(p)) { chosen.add(p); n--; }
}
return n;
};
let short = 0;
for (const k of ['target', 'harder', 'easier']) short += take(buckets[k], quota[k]);
if (short > 0) {
const rest = cand.filter((p) => !chosen.has(p)).sort((a, b) => Math.abs(g(a) - target) - Math.abs(g(b) - target));
short = take(rest, short);
}
const result = [...chosen];
result.sort((a, b) => (g(b) - g(a)) || ((a.bookId > b.bookId) - (a.bookId < b.bookId)) || (a.section - b.section) || (a.number - b.number));
return { problems: result, shortage: short, available: cand.length };
}
/** 선택된 목록 중 하나를 같은(가까운) 등급의 다른 문제로 교체 */
function replaceOne(selected, index, pool, opts, seed = Date.now()) {
const cur = selected[index];
const used = new Set(selected.map((p) => p.id));
const target = effectiveGrade(cur);
const cand = shuffle(filterPool(pool, opts).filter((p) => !used.has(p.id)), rng(seed));
cand.sort((a, b) => Math.abs(effectiveGrade(a) - target) - Math.abs(effectiveGrade(b) - target));
if (!cand.length) return selected;
const out = selected.slice();
out[index] = cand[0];
return out;
}
return { rng, MIX_PRESETS, filterPool, selectProblems, replaceOne };
})();
M.imaging = (() => {
const db = M.db;
const { trimBox } = M.layout;
function loadImage(src) {
return new Promise(async (resolve, reject) => {
const im = new Image();
let url = null;
im.onload = () => { if (url) URL.revokeObjectURL(url); resolve(im); };
// 브라우저는 Event 객체만 주므로 알아볼 수 있는 오류로 바꾼다
im.onerror = () => { if (url) URL.revokeObjectURL(url); reject(new Error('저장된 이미지를 열 수 없습니다 (페이지 이미지가 손상되었을 수 있습니다).')); };
try {
if (typeof src === 'string') im.src = src;
else { url = URL.createObjectURL(await M.assets.getBlob(src)); im.src = url; }
} catch (e) { if (url) URL.revokeObjectURL(url); reject(e); }
});
}
/** 페이지 캐시 (최근 몇 장만 메모리에 유지) */
class PageCache {
constructor(limit = 6) { this.limit = limit; this.map = new Map(); }
async get(pageId) {
if (this.map.has(pageId)) {
const v = this.map.get(pageId);
this.map.delete(pageId); this.map.set(pageId, v);
return v;
}
const rec = await db.get('pages', pageId);
if (!rec || rec.image == null) return null; // 백업에서 이미지가 빠진 쪽 (정보만 남아 있음)
const im = await loadImage(rec.image);
const canvas = document.createElement('canvas');
canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
ctx.drawImage(im, 0, 0);
const v = { rec, canvas, imageData: ctx.getImageData(0, 0, canvas.width, canvas.height) };
this.map.set(pageId, v);
while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
return v;
}
}
function pageId(bookId, kind, index) {
return `${bookId}:${kind}:${index}`;
}
/** 조각들을 잉크 영역에 맞게 다듬는다. 너무 작은 조각은 버림 */
async function trimFragments(cache, bookId, kind, fragments) {
const out = [];
for (const f of fragments) {
const pg = await cache.get(pageId(bookId, kind, f.page));
if (!pg) continue;
const t = trimBox(pg.imageData, f);
if (!t) continue;
if (f.cont && t.y1 - t.y0 < pg.canvas.height * 0.015) continue;
out.push({ page: f.page, ...t, cont: !!f.cont });
}
return out;
}
/** 조각을 원래 픽셀 비율 그대로 세로로 이어붙인 무손실 PNG */
async function cropFragments(cache, bookId, kind, fragments, assetKey = 'crop') {
const parts = [];
for (const f of fragments) {
const pg = await cache.get(pageId(bookId, kind, f.page));
if (pg) parts.push({ pg, f });
}
if (!parts.length) return null;
const gap = 8;
const w = Math.max(...parts.map((p) => p.f.x1 - p.f.x0));
const h = parts.reduce((s, p) => s + (p.f.y1 - p.f.y0), 0) + gap * (parts.length - 1);
// 브라우저 캔버스 한계(한 변 약 32,767px, 넓이 약 1,600만px)를 넘으면 비율을 지킨 채 줄인다
const k = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / Math.max(1, w * h)));
const c = document.createElement('canvas');
c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
const ctx = c.getContext('2d');
if (!ctx) throw new Error('문제 이미지가 너무 커서 만들 수 없습니다.');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
if (k < 1) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; }
let y = 0;
for (const { pg, f } of parts) {
const fw = f.x1 - f.x0, fh = f.y1 - f.y0;
ctx.drawImage(pg.canvas, f.x0, f.y0, fw, fh, 0, y * k, fw * k, fh * k);
y += fh + gap;
}
// sizeFactor: 줄인 비율. PDF에 넣을 때 실제 크기를 되살리는 데 쓴다
const blob = await M.assets.canvasToBlob(c, 'image/png');
const size = { w: c.width, h: c.height };
c.width = c.height = 0; // 메모리 해제
const image = await M.assets.storeImage(blob, { bookId, role: `item-${kind}`, id: assetKey });
// imageId: 이미지가 바뀔 때마다 새 값. 저장 공간 최적화가 그사이 고친 이미지를 옛것으로 되돌리지 않게 비교한다
return { image, imageId: db.uid('i'), imageFormat: 'PNG', imageBytes: blob.size, ...size, sizeFactor: k };
}
const MAX_CANVAS_SIDE = 16000, MAX_CANVAS_AREA = 16e6;
/** 한글 텍스트를 이미지로 (jsPDF 한글 폰트 문제 회피) */
function textImage(text, { size = 28, bold = false, color = '#111', maxWidth = 2000 } = {}) {
const c = document.createElement('canvas');
const ctx = c.getContext('2d');
const fontOf = (px) => `${bold ? '700 ' : ''}${px}px "Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo",sans-serif`;
ctx.font = fontOf(size);
const measured = Math.ceil(ctx.measureText(text).width) + 4;
// 긴 제목은 잘리지 않도록 글자를 줄인다 (이미지 높이는 그대로)
const px = measured > maxWidth ? Math.max(8, Math.floor(size * (maxWidth - 4) / (measured - 4))) : size;
ctx.font = fontOf(px);
c.width = Math.max(1, Math.min(maxWidth, Math.ceil(ctx.measureText(text).width) + 4)); c.height = Math.ceil(size * 1.4);
ctx.font = fontOf(px); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
ctx.fillStyle = color; ctx.textBaseline = 'middle';
ctx.fillText(text, 2, c.height / 2);
return { image: c.toDataURL('image/png'), w: c.width, h: c.height };
}
return { loadImage, PageCache, pageId, trimFragments, cropFragments, textImage };
})();
// ===== part1.js 끝 =====
