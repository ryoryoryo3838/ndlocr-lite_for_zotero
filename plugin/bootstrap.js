/* global Zotero, Services */
var NDLOCRIndex;

function install() {}

async function startup({ id, version, rootURI }) {
	Services.scriptloader.loadSubScript(rootURI + 'ndlocr-index.js');
	NDLOCRIndex.init({ id, version, rootURI });
	NDLOCRIndex.paneID = await Zotero.PreferencePanes.register({
		pluginID: id,
		src: rootURI + 'prefs.xhtml',
		scripts: [rootURI + 'prefs-pane.js'],
		label: 'NDLOCR-Lite for Zotero',
	});
	NDLOCRIndex.addToAllWindows();
	NDLOCRIndex.registerNotifier();
}

function onMainWindowLoad({ window }) {
	NDLOCRIndex.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	NDLOCRIndex.removeFromWindow(window);
}

function shutdown() {
	if (!NDLOCRIndex) return;
	NDLOCRIndex.cancel();
	NDLOCRIndex.unregisterNotifier();
	NDLOCRIndex.removeFromAllWindows();
	delete Zotero.NDLOCRIndex;
	NDLOCRIndex = undefined;
}

function uninstall() {}
