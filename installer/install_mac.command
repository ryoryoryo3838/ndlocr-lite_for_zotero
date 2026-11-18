#!/bin/bash
# NDLOCR-Lite を Zotero プラグイン「NDLOCR-Lite for Zotero」用に 1 つのフォルダへまとめてインストールする（macOS / Linux）。
#
#   bash install_mac.command            … Finder のダイアログでインストール場所を選ぶ
#   bash install_mac.command <フォルダ>  … インストール先を直接指定する（Zotero の設定画面の「セットアップ」はこの形で実行する）
#
# フォルダの中身:
#   uv/            パッケージ管理ツール uv
#   python/        uv が入れる Python
#   ndlocr-lite/   NDLOCR-Lite 本体とモデル
#   .venv/         NDLOCR-Lite 用の Python 環境
# uv が既に入っていればそれを使う。ほかはこのフォルダ以外に何も書き込まない（削除すればアンインストール完了）。
set -euo pipefail

NDLOCR_VERSION="${NDLOCR_VERSION:-1.4.0}"
PY_VERSION="3.12"
DIR_NAME="ndlocr-lite-zotero"
DEFAULT_DIR="$HOME/$DIR_NAME"

echo "=== NDLOCR-Lite インストーラ（NDLOCR-Lite ${NDLOCR_VERSION}）==="

for c in curl unzip; do
  if ! command -v "$c" >/dev/null; then
    echo "エラー: $c が見つかりません。先にインストールしてください（Debian / Ubuntu: sudo apt install curl unzip）" >&2
    exit 1
  fi
done

is_ascii() { ! LC_ALL=C printf '%s' "$1" | LC_ALL=C grep -q '[^ -~]'; }
# Zotero のセットアップから実行したとき（NDLOCR_FROM_ZOTERO=1）はダイアログを出さない
gui_alert() { [ -z "${NDLOCR_FROM_ZOTERO:-}" ] && [ "$(uname -s)" = Darwin ] && osascript -e "display alert \"NDLOCR-Lite インストーラ\" message \"$1\"" >/dev/null 2>&1 || true; }

dir="${1:-}"
if [ -z "$dir" ]; then
  if [ "$(uname -s)" = Darwin ] && command -v osascript >/dev/null; then
    # Finder のダイアログで場所を選ぶ。選んだ場所の中に ndlocr-lite-zotero フォルダを作る
    while :; do
      echo "Finder のダイアログで、インストールする場所を選んでください…"
      picked="$(osascript \
        -e 'set f to choose folder with prompt "NDLOCR-Lite をインストールする場所を選んでください（この中に ndlocr-lite-zotero フォルダを作ります）" default location (path to home folder)' \
        -e 'POSIX path of f' 2>/dev/null || true)"
      if [ -z "$picked" ]; then echo "キャンセルしました。"; exit 1; fi
      picked="${picked%/}"
      if is_ascii "$picked"; then break; fi
      gui_alert "選んだ場所のパスに日本語などの全角文字が含まれています。英数字だけのパスの場所を選んでください。\n\n$picked"
    done
    if [ -d "$picked/.venv" ] || [ -d "$picked/ndlocr-lite" ] || [ "$(basename "$picked")" = "$DIR_NAME" ]; then
      dir="$picked"            # 既存のインストール先を選んだ場合はそのまま使う
    else
      dir="$picked/$DIR_NAME"
    fi
  else
    read -r -p "インストール先フォルダ [${DEFAULT_DIR}]: " dir
    dir="${dir:-$DEFAULT_DIR}"
  fi
fi
dir="${dir/#\~/$HOME}"
if ! is_ascii "$dir"; then
  echo "エラー: インストール先のパスに日本語などの全角文字を含めないでください: $dir" >&2
  exit 1
fi
mkdir -p "$dir"
dir="$(cd "$dir" && pwd)"
echo "インストール先: $dir"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  target="aarch64-apple-darwin" ;;
  Darwin-x86_64) target="x86_64-apple-darwin" ;;
  Linux-x86_64)  target="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64) target="aarch64-unknown-linux-gnu" ;;
  *) echo "エラー: 未対応の環境です: $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. uv（すでに入っていればそれを使う）
uv_ok() { # uv 0.5 以上なら使う
  local v; v="$("$1" --version 2>/dev/null | awk '{print $2}')" || return 1
  [ -n "$v" ] && [ "$(printf '%s\n0.5.0\n' "$v" | sort -V | head -1)" = "0.5.0" ]
}
UV=""
if [ -x "$dir/uv/uv" ]; then
  UV="$dir/uv/uv"
elif [ -z "${NDLOCR_BUNDLED_UV:-}" ]; then
  for c in "$(command -v uv 2>/dev/null || true)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" /opt/homebrew/bin/uv /usr/local/bin/uv; do
    if [ -n "$c" ] && [ -x "$c" ] && uv_ok "$c"; then UV="$c"; break; fi
  done
fi
if [ -n "$UV" ]; then
  echo "[1/4] インストール済みの uv を使います: $UV"
else
  echo "[1/4] uv をダウンロード中…"
  curl -fL --progress-bar "https://github.com/astral-sh/uv/releases/latest/download/uv-${target}.tar.gz" -o "$tmp/uv.tar.gz"
  mkdir -p "$dir/uv"
  tar -xzf "$tmp/uv.tar.gz" -C "$dir/uv" --strip-components=1
  UV="$dir/uv/uv"
fi
"$UV" --version

export UV_PYTHON_INSTALL_DIR="$dir/python"
export UV_CACHE_DIR="$dir/cache"
export UV_PYTHON_PREFERENCE="only-managed"

# 2. NDLOCR-Lite 本体（ソースとモデル、約 160MB）
installed="$(cat "$dir/ndlocr-lite/.installed-version" 2>/dev/null || true)"
if [ "$installed" != "$NDLOCR_VERSION" ]; then
  echo "[2/4] NDLOCR-Lite ${NDLOCR_VERSION} をダウンロード中（約 160MB）…"
  if [ -n "${NDLOCR_SRC_ZIP:-}" ]; then
    cp "$NDLOCR_SRC_ZIP" "$tmp/ndlocr.zip"
  else
    curl -fL --progress-bar "https://github.com/ndl-lab/ndlocr-lite/archive/refs/tags/${NDLOCR_VERSION}.zip" -o "$tmp/ndlocr.zip"
  fi
  unzip -q "$tmp/ndlocr.zip" -d "$tmp/src"
  rm -rf "$dir/ndlocr-lite"
  mv "$tmp/src/"*/ "$dir/ndlocr-lite"
  echo "$NDLOCR_VERSION" > "$dir/ndlocr-lite/.installed-version"
else
  echo "[2/4] NDLOCR-Lite ${NDLOCR_VERSION} はインストール済み"
fi

# 3. Python 環境（GUI 用の flet は不要なので除く）
echo "[3/4] Python ${PY_VERSION} と依存パッケージをインストール中…"
if [ ! -x "$dir/.venv/bin/python" ]; then
  "$UV" venv --python "$PY_VERSION" "$dir/.venv"
fi
grep -v -i '^flet' "$dir/ndlocr-lite/requirements.txt" > "$dir/requirements-cli.txt"
"$UV" pip install --python "$dir/.venv/bin/python" -r "$dir/requirements-cli.txt"
"$UV" cache clean >/dev/null 2>&1 || true

# 4. 動作確認
echo "[4/4] 動作確認…"
"$dir/.venv/bin/python" "$dir/ndlocr-lite/src/ocr.py" --version

copied=""
if command -v pbcopy >/dev/null; then printf '%s' "$dir" | pbcopy && copied="（パスはクリップボードにコピーしました）"; fi
echo
echo "インストールが完了しました。"
echo "Zotero の 設定 → NDLOCR-Lite for Zotero で、次のフォルダを指定してください${copied}:"
echo
echo "    $dir"
echo
gui_alert "インストールが完了しました。\n\nZotero の 設定 → NDLOCR-Lite for Zotero で、次のフォルダを指定してください${copied}:\n\n$dir"
