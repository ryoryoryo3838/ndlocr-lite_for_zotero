#!/bin/sh
# plugin/ と、設定画面の「セットアップ」が使うインストーラを build/*.xpi にまとめる
set -eu
cd "$(dirname "$0")"
version=$(python3 -c "import json;print(json.load(open('plugin/manifest.json'))['version'])")
xpi="build/ndlocr-lite_for_zotero-${version}.xpi"
rm -rf build && mkdir -p build
(cd plugin && zip -q -DX -r "../$xpi" . -x "**/.*" -x "**/__pycache__/*")
zip -q -X "$xpi" installer/install_mac.command installer/install_windows.ps1
echo "$xpi"
