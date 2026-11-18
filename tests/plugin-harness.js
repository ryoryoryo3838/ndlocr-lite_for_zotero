// Zotero を模した環境でプラグインのコード（plugin/ndlocr-index.js）を動かすテスト。
// OCR は本物の NDLOCR-Lite を使う。Zotero の全文インデックスは簡易的な模擬。
//   NDLOCR_DIR=/path/to/ndlocr-lite-zotero node tests/plugin-harness.js
// 最初に設定画面の「セットアップ」と同じ処理を NDLOCR_DIR に対して実行する（未インストールなら約 650MB をダウンロードして入れる）。
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const os = require('os');
const ROOT = path.resolve(__dirname, '..');
const NDLOCR_DIR = process.env.NDLOCR_DIR;
if (!NDLOCR_DIR) { console.error('NDLOCR_DIR（インストーラで作ったフォルダ）を指定してください'); process.exit(2); }
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ndlocr-index-test-'));
for (const [key, name] of [['AAAA1111', '日本語の論文.pdf'], ['BBBB2222', 'born-digital.pdf']]) {
  fs.mkdirSync(path.join(DATA, 'storage', key), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'tests/fixtures/vertical-ja-2pages.pdf'), path.join(DATA, 'storage', key, name));
}
fs.mkdirSync(path.join(DATA, 'storage', 'CCCC3333'), { recursive: true });
const log = [];
// ---- IOUtils / PathUtils
const IOUtils = {
  exists: async p => fs.existsSync(p),
  readUTF8: async p => fs.readFileSync(p, 'utf8'),
  readJSON: async p => JSON.parse(fs.readFileSync(p, 'utf8')),
  writeUTF8: async (p, s) => fs.writeFileSync(p, s),
  writeJSON: async (p, o) => fs.writeFileSync(p, JSON.stringify(o)),
  makeDirectory: async (p, o) => fs.mkdirSync(p, { recursive: true }),
  copy: async (a, b) => fs.copyFileSync(a, b),
  stat: async p => ({ type: fs.statSync(p).isDirectory() ? 'directory' : 'regular' }),
  remove: async (p, o) => fs.rmSync(p, { recursive: true, force: true }),
};
const PathUtils = { filename: p => path.basename(p), join: (...a) => { if (!path.isAbsolute(a[0])) throw new Error('not absolute'); return path.join(...a); }, parent: p => (p === '/' ? null : path.dirname(p)) };
// ---- Subprocess (real process)
const Subprocess = { call: async ({ command, arguments: args, workdir, environment }) => {
  const child = cp.spawn(command, args, { cwd: workdir, env: { ...process.env, ...environment } });
  const chunks = []; let ended = false, waiters = [];
  const push = d => { chunks.push(d.toString()); waiters.splice(0).forEach(f => f()); };
  child.stdout.on('data', push); child.stderr.on('data', push);
  const exit = new Promise(r => child.on('close', code => { ended = true; waiters.splice(0).forEach(f => f()); r(code); }));
  return { stdout: { readString: async () => { while (!chunks.length && !ended) await new Promise(r => waiters.push(r)); return chunks.splice(0).join(''); } },
    wait: async () => ({ exitCode: await exit }), kill: () => child.kill() };
}};
// ---- Zotero mock
const fulltext = {}; // itemID -> {text, synced}
const items = {};
function mkAtt(id, key, file, opts = {}) { return items[id] = { id, key, libraryKey: '1/' + key, isAttachment: () => true, isRegularItem: () => false,
  attachmentContentType: 'application/pdf', attachmentLinkMode: 0, attachmentFilename: file, getDisplayTitle: () => file,
  getFilePathAsync: async () => opts.missing ? false : path.join(DATA, 'storage', key, file), ...opts }; }
mkAtt(11, 'AAAA1111', '日本語の論文.pdf'); mkAtt(12, 'BBBB2222', 'born-digital.pdf', { nativeText: 'This PDF already has a text layer. '.repeat(10) }); mkAtt(13, 'CCCC3333', 'missing.pdf', { missing: true });
items[10] = { id: 10, isAttachment: () => false, isRegularItem: () => true, getAttachments: () => [11, 12, 13] };
const cacheFile = it => ({ path: path.join(DATA, 'storage', it.key, '.zotero-ft-cache') });
const Zotero = {
  debug: m => log.push(m), logError: e => console.log('logError:', e.message || e),
  Prefs: { _p: { 'extensions.zotero.ndlocrindex.installDir': NDLOCR_DIR, 'extensions.zotero.ndlocrindex.dpi': '150', 'extensions.zotero.ndlocrindex.minChars': '100', 'extensions.zotero.ndlocrindex.syncFulltext': true, 'extensions.zotero.ndlocrindex.restoreOnReindex': true }, get(k) { return this._p[k]; }, set(k, v) { this._p[k] = v; } },
  isWin: process.platform === 'win32', Utilities: { randomString: n => Math.random().toString(36).slice(2, 2 + n), Internal: { openPreferences() {} } },
  Attachments: { LINK_MODE_LINKED_URL: 3, getStorageDirectory: it => ({ path: path.join(DATA, 'storage', it.key) }) },
  Items: { get: id => items[id] },
  File: { getContentsFromURLAsync: async url => fs.readFileSync(url, 'utf8') },
  Fulltext: { SYNC_STATE_UNSYNCED: 0, SYNC_STATE_IN_SYNC: 1, getItemCacheFile: cacheFile,
    async indexItems(ids) { for (const id of ids) { const it = items[id]; const dir = path.join(DATA, 'storage', it.key); const pc = path.join(dir, '.zotero-ft-unprocessed');
      if (fs.existsSync(pc)) { const d = JSON.parse(fs.readFileSync(pc, 'utf8')); fs.writeFileSync(cacheFile(it).path, d.text); fs.unlinkSync(pc); fulltext[id] = { text: d.text, synced: 1, pages: d.indexedPages }; notify('index', [id]); continue; }
      if (it.nativeText && !it.missing) { fs.writeFileSync(cacheFile(it).path, it.nativeText); fulltext[id] = { text: it.nativeText, synced: 0 }; notify('index', [id]); } } },
    async clearItemWords(id) { delete fulltext[id]; fs.rmSync(cacheFile(items[id]).path, { force: true }); } },
  DB: { queryAsync: async (sql, p) => { if (/UPDATE fulltextItems SET synced/.test(sql)) fulltext[p[1]].synced = p[0]; }, executeTransaction: async f => f() },
  Notifier: { _obs: null, registerObserver(o) { this._obs = o; return 'obs1'; }, unregisterObserver() {}, trigger: async () => {} },
};
function notify(ev, ids) { Zotero.Notifier._obs && Zotero.Notifier._obs.notify(ev, 'item', ids); }
const alerts = [];
const Services = { dirsvc: { get: () => ({ path: os.homedir() }) }, prompt: { alert: (w, t, m) => alerts.push(m), confirm: () => true } };
let pwText = [];
Zotero.ProgressWindow = function () { this.changeHeadline = () => {}; this.show = () => {}; this.startCloseTimer = () => {};
  this.ItemProgress = function () { this.setText = t => pwText.push(t); this.setProgress = () => {}; }; };
const ctx = vm.createContext({ Zotero, Services, IOUtils, PathUtils, Ci: {}, ChromeUtils: { importESModule: () => ({ Subprocess }) }, console, Date, Math, JSON, Error, Map, Set, String, parseInt, Promise });
vm.runInContext('var NDLOCRIndex;' + fs.readFileSync(path.join(ROOT, 'plugin/ndlocr-index.js'), 'utf8') + ';this.P=NDLOCRIndex;', ctx);
const P = ctx.P; P.init({ id: 'x', version: '0.1.0', rootURI: ROOT + '/' }); P.registerNotifier();
const win = { ZoteroPane: { getSelectedItems: () => [items[10]] } };
let failures = 0;
function check(name, cond, detail = '') { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!cond) failures++; }
const sidecar = path.join(DATA, 'storage/AAAA1111/.zotero-ndlocr.json');
const K = 'extensions.zotero.ndlocrindex.installDir';

(async () => {
  // セットアップ（同梱インストーラの実行）
  const bad = await P.setup(path.join(os.tmpdir(), '日本語'));
  check('setup: 全角文字を含む場所は断る', !bad.ok && /全角/.test(bad.msg));
  Zotero.Prefs._p[K] = '';
  const lines = [];
  const s = await P.setup(NDLOCR_DIR, l => lines.push(l));
  check('setup', s.ok && path.resolve(s.dir) === path.resolve(NDLOCR_DIR), s.msg.slice(-300));
  check('setup: インストール先を設定に保存', Zotero.Prefs._p[K] === s.dir);
  check('setup: 進捗を 1 行ずつ渡す', lines.some(l => l.includes('[4/4]')));
  check('setup: 終了後は実行中でない', !P.running);

  // パスの正規化とインストール先の自動検出
  for (const v of [NDLOCR_DIR, `"${NDLOCR_DIR}${path.sep}"`, `  ${NDLOCR_DIR}${path.sep}${path.sep}  `,
    path.join(NDLOCR_DIR, 'ndlocr-lite', 'src'), path.join(NDLOCR_DIR, 'ndlocr-lite', 'src', 'ocr.py')]) {
    Zotero.Prefs._p[K] = v;
    const r = await P.checkEnv();
    check(`checkEnv ${JSON.stringify(v)}`, r.ok && path.resolve(r.dir) === path.resolve(NDLOCR_DIR));
  }
  Zotero.Prefs._p[K] = path.join(os.tmpdir(), 'ndlocr-index-no-such-dir');
  check('checkEnv: 存在しないフォルダは NG', !(await P.checkEnv()).ok);
  Zotero.Prefs._p[K] = NDLOCR_DIR;

  check('testInstall', (await P.testInstall()).ok);

  // 選択 OCR: 1 件登録、テキストあり・ファイルなしはスキップ
  await P.runSelected(win, false);
  const a1 = alerts.pop();
  check('runSelected: 登録 1 / スキップ 2', /登録 1 件 \/ スキップ 2 件 \/ 失敗 0 件/.test(a1), JSON.stringify(a1.split('\n')[1]));
  check('縦書きの日本語を認識', fulltext[11]?.text.includes('図書館情報学'));
  check('同期対象（synced=0）にする', fulltext[11]?.synced === 0);
  check('ページ数', fulltext[11]?.pages === 2);
  check('sidecar を保存', fs.existsSync(sidecar));
  check('進捗表示', pwText.some(t => /OCR 2\/2 ページ/.test(t)));
  const work = path.join(NDLOCR_DIR, 'work');
  check('作業フォルダを片付ける', !fs.existsSync(work) || fs.readdirSync(work).length === 0);

  // 再索引で上書きされたら戻す
  fs.writeFileSync(cacheFile(items[11]).path, '  '); fulltext[11] = { text: '  ', synced: 0 }; notify('index', [11]);
  await new Promise(r => setTimeout(r, 500));
  check('再索引後に自動復元', fulltext[11]?.text.includes('図書館情報学'));

  // 2 回目は OCR 済みとしてスキップ
  await P.runSelected(win, false);
  check('2 回目は全件スキップ', /登録 0 件 \/ スキップ 3 件/.test(alerts.pop()));

  // 解除
  await P.removeSelected(win);
  alerts.pop();
  check('解除で索引と sidecar を削除', fulltext[11] === undefined && !fs.existsSync(sidecar));

  // 中止
  setTimeout(() => P.cancel(), 1500);
  await P.runSelected(win, true);
  check('中止できる', /中止しました/.test(alerts.pop()) && !P.running);
  check('中止後も作業フォルダが残らない', !fs.existsSync(work) || fs.readdirSync(work).length === 0);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 件失敗` : '\nすべて成功');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
