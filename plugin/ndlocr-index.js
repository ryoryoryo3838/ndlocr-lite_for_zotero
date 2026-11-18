/* global Zotero, Services, ChromeUtils, IOUtils, PathUtils, Ci */
// NDLOCR-Lite for Zotero — NDLOCR-Lite で PDF を OCR し、Zotero の全文インデックスに登録する。
//
// 仕組み:
//   1. NDLOCR-Lite（インストーラで作ったフォルダ内の Python 環境）を外部プロセスとして実行
//   2. 認識テキストを添付の保存フォルダに `.zotero-ft-unprocessed`（Zotero が全文同期で
//      受け取ったテキストを置く中間ファイル）として書き、Zotero.Fulltext.indexItems() で索引させる
//      → Zotero 7〜10 で共通の経路。PDF 自体は変更しない
//   3. 結果を `.zotero-ndlocr.json` に保存し、再索引で消えたときに自動で戻す

var { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');

var PREF_PREFIX = 'extensions.zotero.ndlocrindex.';
var PROCESSOR_CACHE = '.zotero-ft-unprocessed';
var SIDECAR = '.zotero-ndlocr.json';
var MENU_IDS = {
	itemSep: 'ndlocr-index-item-sep',
	itemRun: 'ndlocr-index-item-run',
	itemForce: 'ndlocr-index-item-force',
	itemRemove: 'ndlocr-index-item-remove',
	toolsSep: 'ndlocr-index-tools-sep',
	toolsLibrary: 'ndlocr-index-tools-library',
	toolsCancel: 'ndlocr-index-tools-cancel',
};

function CancelledError() {
	const e = new Error('中止しました');
	e.cancelled = true;
	return e;
}

NDLOCRIndex = {
	id: null,
	version: null,
	rootURI: null,
	paneID: null,
	notifierID: null,
	running: false,
	cancelRequested: false,
	currentProc: null,
	_applying: new Set(),
	_removing: new Set(),

	init({ id, version, rootURI }) {
		this.id = id;
		this.version = version;
		this.rootURI = rootURI;
		Zotero.NDLOCRIndex = this; // 設定画面のスクリプトから呼べるように
	},

	log(msg) {
		Zotero.debug('NDLOCR-Lite for Zotero: ' + msg);
	},

	pref(key) {
		return Zotero.Prefs.get(PREF_PREFIX + key, true);
	},

	// ------------------------------------------------------------------ UI

	addToWindow(win) {
		const doc = win.document;
		const itemMenu = doc.getElementById('zotero-itemmenu');
		if (itemMenu) {
			itemMenu.appendChild(this._el(doc, 'menuseparator', MENU_IDS.itemSep));
			itemMenu.appendChild(this._el(doc, 'menuitem', MENU_IDS.itemRun,
				'NDLOCR-Lite で OCR して全文インデックスに登録',
				() => this.runSelected(win, false)));
			itemMenu.appendChild(this._el(doc, 'menuitem', MENU_IDS.itemForce,
				'NDLOCR-Lite で再 OCR（既存のテキストを上書き）',
				() => this.runSelected(win, true)));
			itemMenu.appendChild(this._el(doc, 'menuitem', MENU_IDS.itemRemove,
				'NDLOCR の全文インデックスを解除',
				() => this.removeSelected(win)));
		}
		const toolsMenu = doc.getElementById('menu_ToolsPopup');
		if (toolsMenu) {
			toolsMenu.appendChild(this._el(doc, 'menuseparator', MENU_IDS.toolsSep));
			toolsMenu.appendChild(this._el(doc, 'menuitem', MENU_IDS.toolsLibrary,
				'NDLOCR: このライブラリのテキストなし PDF をすべて OCR…',
				() => this.runLibrary(win)));
			toolsMenu.appendChild(this._el(doc, 'menuitem', MENU_IDS.toolsCancel,
				'NDLOCR: 実行中の OCR を中止',
				() => this.cancel()));
			toolsMenu.addEventListener('popupshowing', this._onToolsPopup);
		}
	},

	_onToolsPopup(event) {
		const item = event.target.ownerDocument.getElementById(MENU_IDS.toolsCancel);
		if (item && Zotero.NDLOCRIndex) item.disabled = !Zotero.NDLOCRIndex.running;
	},

	_el(doc, tag, id, label, onCommand) {
		const el = doc.createXULElement(tag);
		el.id = id;
		if (label) el.setAttribute('label', label);
		if (onCommand) el.addEventListener('command', onCommand);
		return el;
	},

	addToAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.addToWindow(win);
		}
	},

	removeFromWindow(win) {
		const doc = win.document;
		for (const id of Object.values(MENU_IDS)) doc.getElementById(id)?.remove();
		doc.getElementById('menu_ToolsPopup')?.removeEventListener('popupshowing', this._onToolsPopup);
	},

	removeFromAllWindows() {
		for (const win of Zotero.getMainWindows()) {
			if (win.ZoteroPane) this.removeFromWindow(win);
		}
	},

	alert(win, msg) {
		Services.prompt.alert(win, 'NDLOCR-Lite for Zotero', msg);
	},

	// ------------------------------------------------------------------ 環境

	/** 入力されたパスを整える（前後の空白・引用符、~、末尾の区切り文字） */
	resolveDir(dir) {
		dir = (dir || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
		if (dir.startsWith('~')) {
			dir = Services.dirsvc.get('Home', Ci.nsIFile).path + dir.slice(1);
		}
		if (dir.length > 1 && !/^[A-Za-z]:[\\/]$/.test(dir)) {
			dir = dir.replace(/[\\/]+$/, '');
		}
		return dir;
	},

	_envPaths(dir) {
		return {
			dir,
			python: Zotero.isWin
				? PathUtils.join(dir, '.venv', 'Scripts', 'python.exe')
				: PathUtils.join(dir, '.venv', 'bin', 'python'),
			ocrPy: PathUtils.join(dir, 'ndlocr-lite', 'src', 'ocr.py'),
		};
	},

	async checkEnv() {
		const raw = this.pref('installDir');
		const dir = this.resolveDir(raw);
		if (!dir) {
			return { ok: false, msg: 'NDLOCR-Lite のインストール先フォルダが未設定です。\n設定 → NDLOCR-Lite for Zotero で指定してください。' };
		}
		let start = dir;
		try {
			// ファイル（python.exe や ocr.py）が指定されたら、そのフォルダから探す
			if (await IOUtils.exists(start) && (await IOUtils.stat(start)).type === 'regular') {
				start = PathUtils.parent(start);
			}
			// インストール先の中のフォルダ（ndlocr-lite, src, .venv など）が指定されても見つかるよう、3 階層上まで探す
			let cur = start;
			for (let i = 0; i < 4 && cur; i++) {
				const env = this._envPaths(cur);
				if (await IOUtils.exists(env.python) && await IOUtils.exists(env.ocrPy)) {
					if (cur !== raw) {
						Zotero.Prefs.set(PREF_PREFIX + 'installDir', cur, true);
					}
					return { ok: true, ...env };
				}
				cur = PathUtils.parent(cur);
			}
		}
		catch (e) {
			this.log(e);
			return { ok: false, msg: `フォルダのパスとして読めません（フルパスで指定してください）: ${dir}` };
		}
		if (!(await IOUtils.exists(dir))) {
			return { ok: false, msg: `フォルダが見つかりません: ${dir}` };
		}
		const env = this._envPaths(start);
		return {
			ok: false,
			msg: `NDLOCR-Lite が見つかりません。インストーラで作ったフォルダ（中に .venv と ndlocr-lite があるフォルダ）を指定してください。\n`
				+ `確認したファイル: ${env.python}\n${env.ocrPy}`,
		};
	},

	/** 設定画面の「動作確認」ボタン用。NDLOCR-Lite のバージョン表示を返す */
	async testInstall() {
		const env = await this.checkEnv();
		if (!env.ok) return env;
		try {
			const out = await this._exec(env, ['-u', env.ocrPy, '--version']);
			return out.exitCode === 0
				? { ok: true, dir: env.dir, msg: `動作確認 OK（${env.dir}）: ${out.output.trim()}` }
				: { ok: false, dir: env.dir, msg: `起動に失敗しました (終了コード ${out.exitCode}):\n${out.output.slice(-1500)}` };
		}
		catch (e) {
			return { ok: false, msg: `起動に失敗しました: ${e.message}` };
		}
	},

	async _exec(env, args, onLine) {
		const proc = await Subprocess.call({
			command: env.python,
			arguments: args,
			workdir: PathUtils.parent(env.ocrPy),
			stderr: 'stdout',
			environment: { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
			environmentAppend: true,
		});
		this.currentProc = proc;
		let output = '';
		let buf = '';
		let chunk;
		try {
			while ((chunk = await proc.stdout.readString())) {
				output += chunk;
				if (onLine) {
					buf += chunk;
					const lines = buf.split(/\r?\n/);
					buf = lines.pop();
					for (const line of lines) onLine(line);
				}
			}
			const { exitCode } = await proc.wait();
			return { exitCode, output };
		}
		finally {
			this.currentProc = null;
		}
	},

	// ------------------------------------------------------------------ OCR

	async runOCR(env, pdfPath, onPage) {
		const dpi = parseInt(this.pref('dpi')) || 150;
		// 作業フォルダはインストール先の中（ASCII パス）に作り、入力も input.pdf にコピーする。
		// 日本語を含むパスで NDLOCR-Lite が失敗するのを避けるため
		const work = PathUtils.join(env.dir, 'work', `job-${Date.now()}-${Zotero.Utilities.randomString(6)}`);
		const outDir = PathUtils.join(work, 'out');
		await IOUtils.makeDirectory(outDir, { createAncestors: true });
		try {
			const input = PathUtils.join(work, 'input.pdf');
			await IOUtils.copy(pdfPath, input);
			const args = [
				'-u', env.ocrPy,
				'--sourcepdf', input,
				'--output', outDir,
				'--no-pdf-page-output',
				'--pdf-dpi', String(dpi),
				'--pdf-output', PathUtils.join(work, 'text-layer.pdf'),
			];
			const res = await this._exec(env, args, (line) => {
				const m = line.match(/OCR PDF page (\d+)\/(\d+)/);
				if (m && onPage) onPage(parseInt(m[1]), parseInt(m[2]));
			});
			if (this.cancelRequested) throw CancelledError();

			const txtPath = PathUtils.join(outDir, 'input.txt');
			const jsonPath = PathUtils.join(outDir, 'input.json');
			if (res.exitCode !== 0 || !(await IOUtils.exists(txtPath)) || !(await IOUtils.exists(jsonPath))) {
				this.log(res.output);
				throw new Error(`NDLOCR-Lite が失敗しました（終了コード ${res.exitCode}）。`
					+ `詳細はヘルプ → デバッグ出力ログに記録されています。\n${res.output.slice(-800)}`);
			}
			const text = (await IOUtils.readUTF8(txtPath)).trim();
			const json = await IOUtils.readJSON(jsonPath);
			const pages = parseInt(json?.pdfinfo?.page_count) || 0;
			return { text, pages, dpi };
		}
		finally {
			await IOUtils.remove(work, { recursive: true, ignoreAbsent: true });
		}
	},

	// ------------------------------------------------------------------ 全文インデックス

	storageDir(item) {
		return Zotero.Attachments.getStorageDirectory(item).path;
	},

	async readCache(item) {
		const path = Zotero.Fulltext.getItemCacheFile(item).path;
		if (!(await IOUtils.exists(path))) return null;
		return IOUtils.readUTF8(path);
	},

	async readSidecar(item) {
		const path = PathUtils.join(this.storageDir(item), SIDECAR);
		if (!(await IOUtils.exists(path))) return null;
		try {
			return await IOUtils.readJSON(path);
		}
		catch (e) {
			return null;
		}
	},

	async writeSidecar(item, result) {
		await IOUtils.writeJSON(PathUtils.join(this.storageDir(item), SIDECAR), {
			tool: 'NDLOCR-Lite',
			plugin: `${this.id} ${this.version}`,
			date: new Date().toISOString(),
			dpi: result.dpi,
			pages: result.pages,
			text: result.text,
		});
	},

	async applyIndex(item, text, pages) {
		const dir = this.storageDir(item);
		// createDirectoryForItem() は既存フォルダを作り直すので使わない
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		this._applying.add(item.id);
		try {
			await IOUtils.writeUTF8(PathUtils.join(dir, PROCESSOR_CACHE), JSON.stringify({
				indexedPages: pages,
				totalPages: pages,
				version: 0,
				text,
			}));
			await Zotero.Fulltext.indexItems([item.id]);
			const cached = await this.readCache(item);
			if (cached !== text) {
				throw new Error('全文インデックスへの登録を確認できませんでした');
			}
			if (this.pref('syncFulltext')) {
				// 「未同期」に戻して、次回の同期で OCR テキストをサーバーにも送る
				await Zotero.DB.queryAsync(
					'UPDATE fulltextItems SET synced=? WHERE itemID=?',
					[Zotero.Fulltext.SYNC_STATE_UNSYNCED, item.id]
				);
			}
			this.log(`indexed ${item.libraryKey}: ${pages} pages, ${text.length} chars`);
		}
		finally {
			this._applying.delete(item.id);
		}
	},

	async removeIndex(item) {
		this._removing.add(item.id);
		try {
			await IOUtils.remove(PathUtils.join(this.storageDir(item), SIDECAR), { ignoreAbsent: true });
			await Zotero.DB.executeTransaction(async () => {
				await Zotero.Fulltext.clearItemWords(item.id);
			});
			await Zotero.Notifier.trigger('refresh', 'item', [item.id]);
			// PDF 自体にテキストがあれば、Zotero 標準の索引に戻る
			await Zotero.Fulltext.indexItems([item.id], { ignoreErrors: true });
		}
		finally {
			this._removing.delete(item.id);
		}
	},

	// 再索引などで OCR テキストが上書きされたら、保存しておいた結果を戻す
	registerNotifier() {
		this.notifierID = Zotero.Notifier.registerObserver({
			notify: (event, type, ids) => {
				if (event === 'index' && type === 'item') {
					this.onIndexed(ids).catch(e => Zotero.logError(e));
				}
			},
		}, ['item'], 'ndlocrIndex');
	},

	unregisterNotifier() {
		if (this.notifierID) Zotero.Notifier.unregisterObserver(this.notifierID);
		this.notifierID = null;
	},

	async onIndexed(ids) {
		if (!this.pref('restoreOnReindex')) return;
		for (const id of ids) {
			if (this._applying.has(id) || this._removing.has(id)) continue;
			const item = Zotero.Items.get(id);
			if (!item || !item.isAttachment()) continue;
			const side = await this.readSidecar(item);
			if (!side || !side.text) continue;
			if ((await this.readCache(item)) === side.text) continue;
			this.log(`restoring OCR index for ${item.libraryKey}`);
			await this.applyIndex(item, side.text, side.pages);
		}
	},

	// ------------------------------------------------------------------ 対象の選び方

	isPDF(item) {
		return item && item.isAttachment()
			&& item.attachmentContentType === 'application/pdf'
			&& item.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_URL;
	},

	collectPDFs(items) {
		const out = new Map();
		for (const item of items) {
			if (item.isRegularItem()) {
				for (const id of item.getAttachments()) {
					const att = Zotero.Items.get(id);
					if (this.isPDF(att)) out.set(att.id, att);
				}
			}
			else if (this.isPDF(item)) {
				out.set(item.id, item);
			}
		}
		return [...out.values()];
	},

	/** OCR が必要か判定する。不要なら { skip: 理由 } */
	async classify(item, force) {
		const path = await item.getFilePathAsync();
		if (!path) return { skip: 'ファイルがこの端末にありません' };
		if (force) return { path };
		if (await this.readSidecar(item)) return { skip: 'OCR 済み' };
		let text = await this.readCache(item);
		if (text === null) {
			// まだ索引されていなければ、Zotero 標準の抽出を先に試す
			await Zotero.Fulltext.indexItems([item.id], { ignoreErrors: true });
			text = await this.readCache(item);
		}
		const minChars = parseInt(this.pref('minChars')) || 100;
		if (text && text.replace(/\s+/g, '').length >= minChars) {
			return { skip: 'PDF にテキストあり' };
		}
		return { path };
	},

	// ------------------------------------------------------------------ コマンド

	async runSelected(win, force) {
		const pdfs = this.collectPDFs(win.ZoteroPane.getSelectedItems());
		if (!pdfs.length) {
			this.alert(win, '選択したアイテムに PDF 添付がありません。');
			return;
		}
		await this.runBatch(win, pdfs, { force, label: force ? '再 OCR' : '選択した PDF' });
	},

	async runLibrary(win) {
		const libraryID = win.ZoteroPane.getSelectedLibraryID();
		const library = Zotero.Libraries.get(libraryID);
		const all = await Zotero.Items.getAll(libraryID, false, false);
		const pdfs = all.filter(item => this.isPDF(item));
		if (!pdfs.length) {
			this.alert(win, `「${library.name}」に PDF 添付がありません。`);
			return;
		}
		const ok = Services.prompt.confirm(win, 'NDLOCR-Lite for Zotero',
			`「${library.name}」の PDF ${pdfs.length} 件を確認し、テキストのないものを OCR します。\n`
			+ 'OCR は 1 ページあたり数秒かかります。途中で止めるときは\n'
			+ '「ツール → NDLOCR: 実行中の OCR を中止」を使ってください。\n\n開始しますか？');
		if (!ok) return;
		await this.runBatch(win, pdfs, { force: false, label: library.name });
	},

	async removeSelected(win) {
		const pdfs = this.collectPDFs(win.ZoteroPane.getSelectedItems());
		const targets = [];
		for (const item of pdfs) {
			if (await this.readSidecar(item)) targets.push(item);
		}
		if (!targets.length) {
			this.alert(win, '選択したアイテムに、NDLOCR で登録した全文インデックスはありません。');
			return;
		}
		if (!Services.prompt.confirm(win, 'NDLOCR-Lite for Zotero',
			`${targets.length} 件の PDF から OCR テキストの全文インデックスを外します。よろしいですか？`)) return;
		for (const item of targets) {
			try {
				await this.removeIndex(item);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		this.alert(win, `${targets.length} 件の OCR インデックスを解除しました。`);
	},

	cancel() {
		if (!this.running) return;
		this.cancelRequested = true;
		try {
			this.currentProc?.kill();
		}
		catch (e) {
			Zotero.logError(e);
		}
	},

	async runBatch(win, items, { force, label }) {
		if (this.running) {
			this.alert(win, 'すでに OCR を実行中です。終わるまで待つか、ツールメニューから中止してください。');
			return;
		}
		const env = await this.checkEnv();
		if (!env.ok) {
			this.alert(win, env.msg);
			if (this.paneID) Zotero.Utilities.Internal.openPreferences(this.paneID);
			return;
		}

		this.running = true;
		this.cancelRequested = false;
		const n = items.length;
		const done = [], skipped = [], failed = [];

		const pw = new Zotero.ProgressWindow({ closeOnClick: false });
		pw.changeHeadline(`NDLOCR-Lite for Zotero: ${label}`);
		pw.show();
		const prog = new pw.ItemProgress('attachmentPDF', '準備中…');

		try {
			for (let i = 0; i < n; i++) {
				if (this.cancelRequested) break;
				const item = items[i];
				const name = item.attachmentFilename || item.getDisplayTitle();
				const head = `(${i + 1}/${n})`;
				prog.setText(`${head} 確認中: ${name}`);
				prog.setProgress(Math.round(i / n * 100));
				try {
					const c = await this.classify(item, force);
					if (c.skip) {
						skipped.push(`${name}（${c.skip}）`);
						continue;
					}
					const result = await this.runOCR(env, c.path, (page, total) => {
						prog.setText(`${head} OCR ${page}/${total} ページ: ${name}`);
						prog.setProgress(Math.round((i + page / total) / n * 100));
					});
					if (!result.text) {
						skipped.push(`${name}（文字を認識できませんでした）`);
						continue;
					}
					await this.applyIndex(item, result.text, result.pages);
					await this.writeSidecar(item, result);
					done.push(name);
				}
				catch (e) {
					if (e.cancelled) break;
					Zotero.logError(e);
					failed.push(`${name}: ${String(e.message).split('\n')[0]}`);
				}
			}
		}
		finally {
			this.running = false;
			this.currentProc = null;
		}

		const cancelled = this.cancelRequested;
		this.cancelRequested = false;
		prog.setProgress(100);
		prog.setText(`${cancelled ? '中止' : '完了'}: 登録 ${done.length} / スキップ ${skipped.length} / 失敗 ${failed.length}`);
		pw.startCloseTimer(4000);

		const lines = [
			cancelled ? '途中で中止しました。' : '完了しました。',
			`登録 ${done.length} 件 / スキップ ${skipped.length} 件 / 失敗 ${failed.length} 件`,
		];
		if (failed.length) lines.push('', '失敗:', ...failed.slice(0, 10), failed.length > 10 ? `ほか ${failed.length - 10} 件` : '');
		if (skipped.length && skipped.length <= 15) lines.push('', 'スキップ:', ...skipped);
		this.alert(win, lines.filter(l => l !== undefined).join('\n').trim());
	},
};
