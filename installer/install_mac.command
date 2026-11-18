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

if [ "$(uname -s)" = Darwin ]; then
  mac_version="$(sw_vers -productVersion)"
  mac_major="${mac_version%%.*}"
  if ! [[ "$mac_major" =~ ^[0-9]+$ ]] || [ "$mac_major" -lt 13 ]; then
    echo "エラー: macOS 13 以降が必要です (現在: $mac_version)" >&2
    exit 1
  fi
fi

# 存在しない証明書を指す環境変数があると curl と uv が失敗する（Flatpak 版 Zotero にホストの設定が引き継がれたときなど）
if [ -n "${SSL_CERT_FILE:-}" ] && [ ! -e "$SSL_CERT_FILE" ]; then unset SSL_CERT_FILE; fi
if [ -n "${SSL_CERT_DIR:-}" ] && [ ! -d "$SSL_CERT_DIR" ]; then unset SSL_CERT_DIR; fi

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
    if [ -f "$picked/ndlocr-lite/.installed-version" ] || [ "$(basename "$picked")" = "$DIR_NAME" ]; then
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

# Never adopt or replace pre-existing directories without an installation marker.
source_pending="$dir/ndlocr-lite/.ndlocr-zotero-source-pending"
if [ ! -f "$dir/ndlocr-lite/.installed-version" ] && { [ -e "$dir/ndlocr-lite" ] || [ -L "$dir/ndlocr-lite" ]; } && ! { [ ! -L "$source_pending" ] && [ -f "$source_pending" ] && [ "$(cat "$source_pending")" = 'ndlocr-lite-zotero-source-v1' ]; }; then
  echo "エラー: unmarked ndlocr-lite exists: ${dir}。既存データは変更せず、別の空のインストール先を選んでください。" >&2
  exit 1
fi
if [ -L "$dir/ndlocr-lite" ] || [ -L "$dir/.venv" ]; then
  echo "エラー: install directories must not be symlinks: $dir" >&2
  exit 1
fi
venv_marker="$dir/.venv/.ndlocr-zotero-venv"
venv_exists=0
venv_reserved=0
if [ -e "$dir/.venv" ]; then
  venv_reserved=1
  venv_exists=1
  if [ ! -d "$dir/.venv" ] || [ -L "$venv_marker" ] || [ ! -f "$venv_marker" ] || { [ "$(cat "$venv_marker")" != 'ndlocr-lite-zotero-venv-v1' ] && [ "$(cat "$venv_marker")" != 'ndlocr-lite-zotero-venv-pending-v1' ]; }; then
    echo "エラー: unmarked .venv。既存の .venv がこのインストーラのものか確認できません。データを保護するため変更しません。別の空のインストール先を選んでください: $dir/.venv" >&2
    exit 1
  fi
  # A marked environment may be incomplete after an interrupted uv venv.
  if [ ! -x "$dir/.venv/bin/python" ] || [ "$(cat "$venv_marker")" = 'ndlocr-lite-zotero-venv-pending-v1' ]; then venv_exists=0; fi
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  target="aarch64-apple-darwin"; uv_sha="3f61099e261e449527141dbf125629fab33ad696468c8c90cebbac40185a306c" ;;
  Darwin-x86_64) target="x86_64-apple-darwin"; uv_sha="76638fdcfa91357858771551a1c88de1f7c3b270b33ab1866f8a0618d9e442d8" ;;
  Linux-x86_64)  target="x86_64-unknown-linux-gnu"; uv_sha="741ff1f5742c5a4a25d2f829e8395355e43f7a5ae2ebc6368e9ae2df0efb69cf" ;;
  Linux-aarch64) target="aarch64-unknown-linux-gnu"; uv_sha="726b72a137fda33565143325f7d31c42cd30ff9ccdf067e00d124d37b4081cb2" ;;
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
  # Digests from the GitHub release assets for uv 0.8.22.
  curl -fL --progress-bar "https://github.com/astral-sh/uv/releases/download/0.8.22/uv-${target}.tar.gz" -o "$tmp/uv.tar.gz"
  if command -v shasum >/dev/null; then
    actual_sha="$(shasum -a 256 "$tmp/uv.tar.gz" | awk '{print $1}')"
  else
    actual_sha="$(sha256sum "$tmp/uv.tar.gz" | awk '{print $1}')"
  fi
  if [ "$actual_sha" != "$uv_sha" ]; then echo 'エラー: uv SHA256 mismatch' >&2; exit 1; fi
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
  if { [ -e "$dir/ndlocr-lite" ] || [ -L "$dir/ndlocr-lite" ]; } && ! { [ ! -L "$dir/ndlocr-lite" ] && [ ! -L "$source_pending" ] && [ -f "$source_pending" ] && [ "$(cat "$source_pending")" = 'ndlocr-lite-zotero-source-v1' ] && [ ! -e "$dir/ndlocr-lite/.installed-version" ]; }; then
    echo "エラー: 既存の ndlocr-lite は置き換えません。別の空のインストール先を選んでください: $dir/ndlocr-lite" >&2
    exit 1
  fi
  echo "[2/4] NDLOCR-Lite ${NDLOCR_VERSION} をダウンロード中（約 160MB）…"
  if [ -n "${NDLOCR_SRC_ZIP:-}" ]; then
    cp "$NDLOCR_SRC_ZIP" "$tmp/ndlocr.zip"
  else
    curl -fL --progress-bar "https://github.com/ndl-lab/ndlocr-lite/archive/refs/tags/${NDLOCR_VERSION}.zip" -o "$tmp/ndlocr.zip"
  fi
  unzip -q "$tmp/ndlocr.zip" -d "$tmp/src"
  if [ ! -e "$dir/ndlocr-lite" ] && [ ! -L "$dir/ndlocr-lite" ]; then
    mkdir "$dir/ndlocr-lite"
    printf '%s\n' 'ndlocr-lite-zotero-source-v1' > "$source_pending"
  fi
  if [ -L "$dir/ndlocr-lite" ] || [ -L "$source_pending" ] || [ ! -f "$source_pending" ] || [ "$(cat "$source_pending")" != 'ndlocr-lite-zotero-source-v1' ]; then
    echo "エラー: unmarked ndlocr-lite。別の空のインストール先を選んでください。" >&2; exit 1
  fi
  cp -R "$tmp/src/"*/. "$dir/ndlocr-lite/"
  echo "$NDLOCR_VERSION" > "$dir/ndlocr-lite/.installed-version"
  rm -f "$source_pending"
else
  echo "[2/4] NDLOCR-Lite ${NDLOCR_VERSION} はインストール済み"
fi

# 3. Python 環境（GUI 用の flet は不要なので除く）
echo "[3/4] Python ${PY_VERSION} と依存パッケージをインストール中…"
if [ "$venv_exists" = 0 ]; then
  if [ "$venv_reserved" = 0 ]; then
    mkdir "$dir/.venv"
    printf '%s\n' 'ndlocr-lite-zotero-venv-pending-v1' > "$venv_marker"
  fi
  "$UV" venv --python "$PY_VERSION" "$dir/.venv" --allow-existing
  [ -x "$dir/.venv/bin/python" ] || { echo 'エラー: .venv の Python が作成されませんでした' >&2; exit 1; }
  printf '%s\n' 'ndlocr-lite-zotero-venv-v1' > "$venv_marker"
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
