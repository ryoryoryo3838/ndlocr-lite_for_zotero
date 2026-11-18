#!/bin/sh
# plugin/ を .xpi に、配布用 zip（.xpi + installer + README）を dist/ に作る
set -eu
cd "$(dirname "$0")"
version=$(python3 -c "import json;print(json.load(open('plugin/manifest.json'))['version'])")
rm -rf build dist && mkdir -p build dist/ndlocr-lite_for_zotero
(cd plugin && zip -q -DX -r "../build/ndlocr-lite_for_zotero-${version}.xpi" . -x "**/.*")
# 設定画面の「セットアップ」が使うインストーラも .xpi に入れる
zip -q -X "build/ndlocr-lite_for_zotero-${version}.xpi" installer/install_mac.command installer/install_windows.ps1
cp -r README.md installer "build/ndlocr-lite_for_zotero-${version}.xpi" dist/ndlocr-lite_for_zotero/
chmod +x dist/ndlocr-lite_for_zotero/installer/install_mac.command
(cd dist && zip -q -r -X "ndlocr-lite_for_zotero-${version}.zip" ndlocr-lite_for_zotero && rm -rf ndlocr-lite_for_zotero)
echo "build/ndlocr-lite_for_zotero-${version}.xpi"
echo "dist/ndlocr-lite_for_zotero-${version}.zip"
