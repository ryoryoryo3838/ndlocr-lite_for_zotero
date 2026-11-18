// Zotero を模した環境でプラグインのコード（plugin/ndlocr-index.js）を動かすテスト。
// OCR は本物の NDLOCR-Lite を使う。Zotero の全文インデックスは簡易的な模擬。
//   NDLOCR_DIR=/path/to/ndlocr-lite-zotero node tests/plugin-harness.js
// 最初に設定画面の「セットアップ」と同じ処理を NDLOCR_DIR に対して実行する（未インストールなら約 650MB をダウンロードして入れる）。
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const os = require('os'), crypto = require('crypto');
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
  move: async (a, b) => fs.renameSync(a, b),
  read: async (p, o) => { const b = fs.readFileSync(p); return o?.maxBytes ? b.subarray(0, o.maxBytes) : b; },
  write: async (p, b) => fs.writeFileSync(p, b),
  stat: async p => ({ type: fs.statSync(p).isDirectory() ? 'directory' : 'regular', size: fs.statSync(p).size }),
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
const added = {}; // importFromFile で追加した添付
const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const items = {};
function mkAtt(id, key, file, opts = {}) { return items[id] = { id, key, libraryID: 1, libraryKey: '1/' + key, parentItemID: 10, deleted: false,
  getField: () => file.replace(/\.pdf$/, ''), getCollections: () => [], isAttachment: () => true, isRegularItem: () => false,
  attachmentContentType: 'application/pdf', attachmentLinkMode: 0, attachmentFilename: file, getDisplayTitle: () => file,
  getFilePathAsync: async () => opts.missing ? false : path.join(DATA, 'storage', key, file), ...opts }; }
mkAtt(11, 'AAAA1111', '日本語の論文.pdf'); mkAtt(12, 'BBBB2222', 'born-digital.pdf', { nativeText: 'This PDF already has a text layer. '.repeat(10) }); mkAtt(13, 'CCCC3333', 'missing.pdf', { missing: true });
items[10] = { id: 10, isAttachment: () => false, isRegularItem: () => true, getAttachments: () => [11, 12, 13] };
const cacheFile = it => ({ path: path.join(DATA, 'storage', it.key, '.zotero-ft-cache') });
const Zotero = {
  debug: m => log.push(m), logError: e => console.log('logError:', e.message || e),
  Prefs: { _p: { 'extensions.zotero.ndlocrindex.installDir': NDLOCR_DIR, 'extensions.zotero.ndlocrindex.dpi': '150', 'extensions.zotero.ndlocrindex.minChars': '100', 'extensions.zotero.ndlocrindex.syncFulltext': true, 'extensions.zotero.ndlocrindex.restoreOnReindex': true, 'extensions.zotero.ndlocrindex.pdfOutput': 'attach', 'extensions.zotero.ndlocrindex.backupOriginal': true }, get(k) { return this._p[k]; }, set(k, v) { this._p[k] = v; } },
  isWin: process.platform === 'win32', Utilities: { randomString: n => Math.random().toString(36).slice(2, 2 + n), Internal: { openPreferences() {}, md5Async: async p => md5(p) } },
  DataDirectory: { dir: DATA },
  Attachments: { LINK_MODE_LINKED_URL: 3, getStorageDirectory: it => ({ path: path.join(DATA, 'storage', it.key) }),
    async importFromFile({ file, parentItemID, title }) {
      const id = 100 + Object.keys(added).length, key = 'OCR' + id;
      fs.mkdirSync(path.join(DATA, 'storage', key), { recursive: true }); fs.copyFileSync(file, path.join(DATA, 'storage', key, path.basename(file)));
      return added[id] = mkAtt(id, key, path.basename(file), { parentItemID, title, nativeText: 'text layer' }); } },
  Items: { get: id => items[id], getByLibraryAndKey: (lib, key) => Object.values(items).find(it => it.key === key) || false },
  // .xpi の中では plugin/ の中身が直下に、installer/ はそのまま入る
  File: { getResourceAsync: async url => fs.readFileSync(fs.existsSync(url) ? url : path.join(ROOT, 'plugin', path.relative(ROOT, url)), 'utf8') },
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
const Services = { dirsvc: { get: () => ({ path: os.homedir() }) }, prompt: { alert: (w, t, m) => alerts.push(m), confirm: () => true, BUTTON_POS_0: 1, BUTTON_POS_2: 65536, BUTTON_TITLE_IS_STRING: 127, confirmEx: () => confirmExAnswer } };
let confirmExAnswer = 0;
let pwText = [];
Zotero.ProgressWindow = function () { this.changeHeadline = () => {}; this.show = () => {}; this.startCloseTimer = () => {};
  this.ItemProgress = function () { this.setText = t => pwText.push(t); this.setProgress = () => {}; }; };
const ctx = vm.createContext({ Zotero, Services, IOUtils, PathUtils, Ci: {}, ChromeUtils: { importESModule: () => ({ Subprocess }) }, console, Date, Math, JSON, Error, Map, Set, String, parseInt, Promise });
vm.runInContext('var NDLOCRIndex;' + fs.readFileSync(path.join(ROOT, 'plugin/ndlocr-index.js'), 'utf8') + ';this.P=NDLOCRIndex;', ctx);
const P = ctx.P; P.init({ id: 'x', version: '0.1.0', rootURI: ROOT + '/' }); P.registerNotifier();
const win = { ZoteroPane: { getSelectedItems: () => [items[10]] } };
const win11 = { ZoteroPane: { getSelectedItems: () => [items[11]] } }; // 対象の PDF だけを選ぶ
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
  const origPath = path.join(DATA, 'storage/AAAA1111/日本語の論文.pdf'), origMD5 = md5(origPath);
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

  // 透明テキスト付き PDF を別の添付として追加（既定）
  const ocrAtt = Object.values(added)[0];
  const ocrPath = ocrAtt && path.join(DATA, 'storage', ocrAtt.key, ocrAtt.attachmentFilename);
  check('追加: OCR 版の PDF を添付', Object.keys(added).length === 1 && ocrAtt.attachmentFilename === '日本語の論文_OCR.pdf' && ocrAtt.parentItemID === 10);
  check('追加: 透明テキストあり', /図書館情報学/.test(cp.execFileSync('pdftotext', [ocrPath, '-']).toString()));
  check('追加: 元の PDF は変えない', md5(origPath) === origMD5);
  check('追加: 元の PDF のバイト列を先頭にそのまま残す', fs.readFileSync(ocrPath).subarray(0, fs.statSync(origPath).size).equals(fs.readFileSync(origPath)));
  check('追加: sidecar に記録', JSON.parse(fs.readFileSync(sidecar, 'utf8')).ocrItemKey === ocrAtt.key);

  // 2 回目は OCR 済みとしてスキップ
  await P.runSelected(win, false);
  check('2 回目は全件スキップ', /登録 0 件 \/ スキップ 3 件/.test(alerts.pop()));

  // 解除
  await P.removeSelected(win);
  alerts.pop();
  check('解除で索引と sidecar を削除', fulltext[11] === undefined && !fs.existsSync(sidecar));

  // 再 OCR しても、追加した添付は増やさずファイルを置き換える
  fs.writeFileSync(sidecar, JSON.stringify({ text: 'x', ocrItemKey: ocrAtt.key }));
  await P.runSelected(win11, true);
  alerts.pop();
  check('追加: 再 OCR で添付を増やさない', Object.keys(added).length === 1);
  await P.removeSelected(win11); alerts.pop();

  // 差し替え: 元を退避して置き換え、解除で戻す
  Zotero.Prefs._p['extensions.zotero.ndlocrindex.pdfOutput'] = 'replace';
  await P.runSelected(win11, false);
  check('差し替え: 登録', /登録 1 件/.test(alerts.pop()));
  const backup = path.join(DATA, 'ndlocr-lite-backup', '1', 'AAAA1111', '日本語の論文.pdf');
  check('差し替え: 元の PDF を退避', fs.existsSync(backup) && md5(backup) === origMD5);
  check('差し替え: 透明テキスト付きに置き換え', md5(origPath) !== origMD5 && /図書館情報学/.test(cp.execFileSync('pdftotext', [origPath, '-']).toString()));
  await P.runSelected(win11, true);
  alerts.pop();
  check('差し替え: 再 OCR でも退避は元のまま', md5(backup) === origMD5);
  await P.removeSelected(win11);
  check('差し替え: 解除で元に戻す（バックアップは保持）', /1 件の OCR インデックスを解除/.test(alerts.pop()) && md5(origPath) === origMD5 && fs.existsSync(backup) && md5(backup) === origMD5);

  // 差し替え後にファイルが変わっていたら戻さない
  await P.runSelected(win11, false); alerts.pop();
  fs.appendFileSync(origPath, '%changed');
  await P.removeSelected(win11);
  check('差し替え: 変更されたファイルは戻さない', /解除できなかったもの/.test(alerts.pop()) && fs.existsSync(backup) && fs.existsSync(sidecar));
  fs.copyFileSync(backup, origPath); fs.rmSync(backup); fs.rmSync(sidecar);

  // セットアップ時のバックアップの選択
  confirmExAnswer = 2; P.askBackup(null);
  check('バックアップしないを選べる', Zotero.Prefs._p['extensions.zotero.ndlocrindex.backupOriginal'] === false);
  confirmExAnswer = 0; P.askBackup(null);
  check('バックアップするを選べる', Zotero.Prefs._p['extensions.zotero.ndlocrindex.backupOriginal'] === true);

  // バックアップなしで差し替え: 追記分を取り除いて戻す
  Zotero.Prefs._p['extensions.zotero.ndlocrindex.backupOriginal'] = false;
  await P.runSelected(win11, true); alerts.pop(); // 直前のテストの索引が残っているので強制
  const side1 = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  check('バックアップなし: 退避しない', !fs.existsSync(backup) && side1.backup === null && side1.originalSize === fs.statSync(path.join(ROOT, 'tests/fixtures/vertical-ja-2pages.pdf')).size);
  await P.runSelected(win11, true); alerts.pop();
  const layer = cp.execFileSync('pdftotext', [origPath, '-']).toString();
  check('バックアップなし: 再 OCR でも透明テキストを二重にしない', layer.split('図書館情報学').length === 2, JSON.stringify(layer.slice(0, 80)));
  await P.restoreItems(win11, [items[11]]);
  check('元に戻す（1 クリック）: 追記分を取り除いて元の PDF に戻る', /1 件を元の PDF に戻しました/.test(alerts.pop()) && md5(origPath) === origMD5);
  const side2 = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  check('元に戻す: OCR テキストの索引は残す', !side2.replaced && fulltext[11]?.text.includes('図書館情報学'));
  await P.restoreItems(win11, [items[11]]);
  check('元に戻す: 差し替えていなければ何もしない', /差し替えた PDF はありません/.test(alerts.pop()));
  await P.removeSelected(win11); alerts.pop();
  Zotero.Prefs._p['extensions.zotero.ndlocrindex.backupOriginal'] = true;
  Zotero.Prefs._p['extensions.zotero.ndlocrindex.pdfOutput'] = 'attach';

  // 中止
  setTimeout(() => P.cancel(), 1500);
  await P.runSelected(win, true);
  check('中止できる', /中止しました/.test(alerts.pop()) && !P.running);
  check('中止後も作業フォルダが残らない', !fs.existsSync(work) || fs.readdirSync(work).length === 0);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log(failures ? `\n${failures} 件失敗` : '\nすべて成功');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
