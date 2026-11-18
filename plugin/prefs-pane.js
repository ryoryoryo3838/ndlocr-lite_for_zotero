/* global Zotero, ChromeUtils, document, window */
// Zotero 8 以降、設定画面のスクリプトは独立したサンドボックスで実行され、
// XHTML のインライン oncommand からはここで定義した変数が見えない。
// そのためボタンはイベントの委譲で処理する（Zotero 7 でも同じく動く）。
var NDLOCRIndexPrefs = {
	_status(msg) {
		try {
			const el = document.getElementById('ndlocr-index-status');
			if (el) el.textContent = msg;
		}
		catch (e) {} // セットアップ中に設定画面が閉じられた
	},

	async _pickFolder(title) {
		const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
		const fp = new FilePicker();
		fp.init(window, title, fp.modeGetFolder);
		return (await fp.show()) === fp.returnOK ? fp.file : null;
	},

	async browse() {
		let path;
		try {
			path = await this._pickFolder('NDLOCR-Lite のインストール先フォルダ');
		}
		catch (e) {
			Zotero.logError(e);
			this._status('✗ フォルダ選択ダイアログを開けませんでした。パスを直接入力してください。');
			return;
		}
		if (!path) return;
		this._setDir(path);
		await this.test();
	},

	async setup() {
		const plugin = Zotero.NDLOCRIndex;
		if (!plugin) {
			this._status('✗ プラグインが読み込まれていません。Zotero を再起動してください。');
			return;
		}
		let picked;
		try {
			picked = await this._pickFolder('NDLOCR-Lite をインストールする場所（この中に ndlocr-lite-zotero フォルダを作ります）');
		}
		catch (e) {
			Zotero.logError(e);
			this._status('✗ フォルダ選択ダイアログを開けませんでした。');
			return;
		}
		if (!picked) return;
		plugin.askBackup(window);
		const button = document.getElementById('ndlocr-index-setup');
		button.disabled = true;
		this._status('インストール中…（数分〜十数分かかります。ツール → 「NDLOCR: 実行中の OCR を中止」で中止できます）');
		try {
			const res = await plugin.setup(picked, (line) => {
				if (line.trim()) this._status('インストール中… ' + line.trim());
			});
			if (res.ok) {
				this._setDir(res.dir);
				await this.test();
			}
			else {
				this._status('✗ ' + res.msg);
			}
		}
		catch (e) {
			Zotero.logError(e);
			this._status('✗ ' + e.message);
		}
		finally {
			try {
				button.disabled = false;
			}
			catch (e) {}
		}
	},

	_setDir(path) {
		Zotero.Prefs.set('extensions.zotero.ndlocrindex.installDir', path, true);
		try {
			const input = document.getElementById('ndlocr-index-installDir');
			if (input) input.value = path;
		}
		catch (e) {}
	},

	async test() {
		this._status('確認中…');
		const plugin = Zotero.NDLOCRIndex;
		if (!plugin) {
			this._status('✗ プラグインが読み込まれていません。Zotero を再起動してください。');
			return;
		}
		try {
			const res = await plugin.testInstall();
			// 中のフォルダや引用符付きのパスが指定されていたら、見つけたインストール先に直す
			if (res.dir) this._setDir(res.dir);
			this._status((res.ok ? '✓ ' : '✗ ') + res.msg);
		}
		catch (e) {
			Zotero.logError(e);
			this._status('✗ ' + e.message);
		}
	},
};

(function () {
	const handler = (event) => {
		const id = event.target?.id;
		if (id === 'ndlocr-index-setup') NDLOCRIndexPrefs.setup();
		else if (id === 'ndlocr-index-browse') NDLOCRIndexPrefs.browse();
		else if (id === 'ndlocr-index-test') NDLOCRIndexPrefs.test();
	};
	// 設定画面を開き直すとスクリプトが再読み込みされるので、前回の登録を外してから付け直す
	if (window.__ndlocrIndexPrefsHandler) {
		document.removeEventListener('command', window.__ndlocrIndexPrefsHandler);
	}
	window.__ndlocrIndexPrefsHandler = handler;
	document.addEventListener('command', handler);
})();
