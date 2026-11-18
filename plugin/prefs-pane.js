/* global Zotero, ChromeUtils, document, window */
// Zotero 8 以降、設定画面のスクリプトは独立したサンドボックスで実行され、
// XHTML のインライン oncommand からはここで定義した変数が見えない。
// そのためボタンはイベントの委譲で処理する（Zotero 7 でも同じく動く）。
var NDLOCRIndexPrefs = {
	_status(msg) {
		const el = document.getElementById('ndlocr-index-status');
		if (el) el.textContent = msg;
	},

	async browse() {
		try {
			const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
			const fp = new FilePicker();
			fp.init(window, 'NDLOCR-Lite のインストール先フォルダ', fp.modeGetFolder);
			if ((await fp.show()) !== fp.returnOK) return;
			this._setDir(fp.file);
			await this.test();
		}
		catch (e) {
			Zotero.logError(e);
			this._status('✗ フォルダ選択ダイアログを開けませんでした。パスを直接入力してください。');
		}
	},

	_setDir(path) {
		Zotero.Prefs.set('extensions.zotero.ndlocrindex.installDir', path, true);
		const input = document.getElementById('ndlocr-index-installDir');
		if (input) input.value = path;
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
		if (id === 'ndlocr-index-browse') NDLOCRIndexPrefs.browse();
		else if (id === 'ndlocr-index-test') NDLOCRIndexPrefs.test();
	};
	// 設定画面を開き直すとスクリプトが再読み込みされるので、前回の登録を外してから付け直す
	if (window.__ndlocrIndexPrefsHandler) {
		document.removeEventListener('command', window.__ndlocrIndexPrefsHandler);
	}
	window.__ndlocrIndexPrefsHandler = handler;
	document.addEventListener('command', handler);
})();
