# NDLOCR-Lite を Zotero プラグイン「NDLOCR-Lite for Zotero」用に 1 つのフォルダへまとめてインストールする（Windows）。
# install_windows.cmd をダブルクリックして実行する。
#
# インストール場所はエクスプローラーのダイアログで選ぶ（選んだ場所の中に ndlocr-lite-zotero フォルダを作る）。
# -InstallDir <フォルダ> を付けると、ダイアログを出さずにそのフォルダへ入れる（Zotero の設定画面の「セットアップ」はこの形で実行する）。
#
# フォルダの中身:
#   uv\            パッケージ管理ツール uv（既に入っていればそれを使い、ここには入れない）
#   python\        uv が入れる Python
#   ndlocr-lite\   NDLOCR-Lite 本体とモデル
#   .venv\         NDLOCR-Lite 用の Python 環境
# このフォルダ以外には何も書き込まない（削除すればアンインストール完了）。
param([string]$InstallDir = "")

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Zotero から実行したときはコンソールがないので、設定できなくても続ける
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms

$NdlocrVersion = if ($env:NDLOCR_VERSION) { $env:NDLOCR_VERSION } else { '1.4.0' }
$PyVersion = '3.12'
$DirName = 'ndlocr-lite-zotero'
$Title = 'NDLOCR-Lite インストーラ'

function Test-Ascii([string]$s) { return -not ($s -match '[^\x20-\x7E]') }

function Show-Message([string]$text, [string]$icon = 'Information') {
    if ($env:NDLOCR_FROM_ZOTERO) { return }  # Zotero のセットアップから実行したときはダイアログを出さない
    [void][System.Windows.Forms.MessageBox]::Show($text, $Title, 'OK', $icon)
}

function Select-InstallDir {
    # 最前面に出すための見えない親ウィンドウ
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
    try {
        while ($true) {
            $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
            $dlg.Description = "NDLOCR-Lite をインストールする場所を選んでください。`n選んだ場所の中に $DirName フォルダを作ります。"
            $dlg.ShowNewFolderButton = $true
            if (Test-Ascii $env:USERPROFILE) { $dlg.SelectedPath = $env:USERPROFILE }
            if ($dlg.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
            $picked = $dlg.SelectedPath.TrimEnd('\')
            if (Test-Ascii $picked) { break }
            Show-Message "選んだ場所のパスに日本語などの全角文字が含まれています。`n英数字だけのパスの場所（例: C:\）を選んでください。`n`n$picked" 'Warning'
        }
    }
    finally { $owner.Dispose() }
    # 既存のインストール先を選んだ場合はそのまま使う
    if ((Test-Path (Join-Path $picked 'ndlocr-lite\.installed-version') -PathType Leaf) -or ((Split-Path $picked -Leaf) -eq $DirName)) {
        return $picked
    }
    return (Join-Path $picked $DirName)
}

function Test-UvVersion([string]$exe) {
    # uv 0.5 以上なら使う
    try {
        $out = (& $exe --version 2>$null) -join ' '
        if ($out -match 'uv (\d+)\.(\d+)') { return ([int]$Matches[1] -gt 0) -or ([int]$Matches[2] -ge 5) }
    } catch { }
    return $false
}

function Expand-Zip([string]$zip, [string]$dest) {
    # tar.exe（Windows 10 1803 以降に標準搭載）のほうが Expand-Archive より大幅に速い
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path $tar) {
        & $tar -xf $zip -C $dest
        if ($LASTEXITCODE -ne 0) { throw "展開に失敗しました: $zip" }
    } else {
        Expand-Archive -Path $zip -DestinationPath $dest -Force
    }
}

Write-Host "=== $Title（NDLOCR-Lite $NdlocrVersion）==="

if (-not $InstallDir) {
    Write-Host 'ダイアログで、インストールする場所を選んでください…'
    $InstallDir = Select-InstallDir
    if (-not $InstallDir) { Write-Host 'キャンセルしました。'; exit 1 }
}
if (-not (Test-Ascii $InstallDir)) {
    throw "インストール先のパスに日本語などの全角文字を含めないでください: $InstallDir"
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$dir = (Resolve-Path $InstallDir).Path
Write-Host "インストール先: $dir"

$ndlPath = Join-Path $dir 'ndlocr-lite'
$venvPath = Join-Path $dir '.venv'
$marker = Join-Path $ndlPath '.installed-version'
if (-not (Test-Path $marker -PathType Leaf) -and (Test-Path $ndlPath)) {
    throw "unmarked ndlocr-lite or .venv exists: $dir。既存データは変更せず、別の空のインストール先を選んでください。"
}
foreach ($path in @($ndlPath, $venvPath)) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "install directories must not be reparse points: $path"
    }
}
$venvMarker = Join-Path $venvPath '.ndlocr-zotero-venv'
$venvExists = Test-Path -LiteralPath $venvPath
if ($venvExists) {
    $markerItem = Get-Item -LiteralPath $venvMarker -Force -ErrorAction SilentlyContinue
    if (-not (Test-Path -LiteralPath $venvPath -PathType Container) -or -not $markerItem -or $markerItem.PSIsContainer -or ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ((Get-Content -LiteralPath $venvMarker -First 1) -cne 'ndlocr-lite-zotero-venv-v1')) {
        throw "既存の .venv がこのインストーラのものか確認できません。データを保護するため変更しません。別の空のインストール先を選んでください: $venvPath"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $venvPath 'Scripts\python.exe') -PathType Leaf)) {
        throw "既存の .venv の Python が見つかりません。既存データは変更せず、別の空のインストール先を選んでください: $venvPath"
    }
}

$target = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
if ($target -like 'aarch64*') { Write-Warning 'ARM 版 Windows での動作は確認していません。' }

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("ndlocr-install-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
    # 1. uv（すでに入っていればそれを使う）
    $uv = $null
    $bundledUv = Join-Path $dir 'uv\uv.exe'
    if (Test-Path $bundledUv) {
        $uv = $bundledUv
    } elseif (-not $env:NDLOCR_BUNDLED_UV) {
        $candidates = @()
        $cmd = Get-Command uv -ErrorAction SilentlyContinue
        if ($cmd) { $candidates += $cmd.Source }
        $candidates += @(
            (Join-Path $env:USERPROFILE '.local\bin\uv.exe'),
            (Join-Path $env:USERPROFILE '.cargo\bin\uv.exe'),
            (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\uv.exe')
        )
        foreach ($c in $candidates) {
            if ($c -and (Test-Path $c) -and (Test-UvVersion $c)) { $uv = $c; break }
        }
    }
    if ($uv) {
        Write-Host "[1/4] インストール済みの uv を使います: $uv"
    } else {
        Write-Host '[1/4] uv をダウンロード中…'
        $uvZip = Join-Path $tmp 'uv.zip'
        # SHA256 digests from the GitHub release assets for uv 0.8.22.
        $uvHash = if ($target -like 'aarch64*') { 'dbb3a5bd06d20c9ab8bb9a79c7c4fb5832ca1c7ba5f231a020bc92e5a3c6dcf4' } else { '5049375aa2a5162f132b2c1cb992e25d42d47d934cab8c174dbe6f60973dcc12' }
        Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/astral-sh/uv/releases/download/0.8.22/uv-$target.zip" -OutFile $uvZip
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $uvZip).Hash -ne $uvHash) { throw 'uv SHA256 mismatch' }
        Expand-Zip $uvZip (Join-Path $dir 'uv')
        $uv = $bundledUv
    }
    & $uv --version

    $env:UV_PYTHON_INSTALL_DIR = Join-Path $dir 'python'
    $env:UV_CACHE_DIR = Join-Path $dir 'cache'
    $env:UV_PYTHON_PREFERENCE = 'only-managed'

    # 2. NDLOCR-Lite 本体（ソースとモデル、約 160MB）
    $ndlDir = Join-Path $dir 'ndlocr-lite'
    $verFile = Join-Path $ndlDir '.installed-version'
    $installed = if (Test-Path $verFile) { (Get-Content $verFile -Raw).Trim() } else { '' }
    if ($installed -ne $NdlocrVersion) {
        Write-Host "[2/4] NDLOCR-Lite $NdlocrVersion をダウンロード中（約 160MB）…"
        $srcZip = Join-Path $tmp 'ndlocr.zip'
        if ($env:NDLOCR_SRC_ZIP) {
            Copy-Item $env:NDLOCR_SRC_ZIP $srcZip
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/ndl-lab/ndlocr-lite/archive/refs/tags/$NdlocrVersion.zip" -OutFile $srcZip
        }
        $srcOut = Join-Path $tmp 'src'
        Expand-Zip $srcZip $srcOut
        if (Get-Item -LiteralPath $ndlDir -Force -ErrorAction SilentlyContinue) { throw "既存の ndlocr-lite は置き換えません。別の空のインストール先を選んでください: $ndlDir" }
        $top = Get-ChildItem -Directory $srcOut | Select-Object -First 1
        Set-Content -LiteralPath (Join-Path $top.FullName '.installed-version') -Value $NdlocrVersion -Encoding ASCII
        [System.IO.Directory]::Move($top.FullName, $ndlDir)
    } else {
        Write-Host "[2/4] NDLOCR-Lite $NdlocrVersion はインストール済み"
    }

    # 3. Python 環境（GUI 用の flet は不要なので除く）
    Write-Host "[3/4] Python $PyVersion と依存パッケージをインストール中…"
    $venvPy = Join-Path $dir '.venv\Scripts\python.exe'
    if (-not $venvExists) {
        New-Item -ItemType Directory -Path $venvPath | Out-Null
        & $uv venv --python $PyVersion (Join-Path $dir '.venv')
        if ($LASTEXITCODE -ne 0) { throw 'Python 環境の作成に失敗しました' }
        if (-not (Test-Path -LiteralPath $venvPy -PathType Leaf)) { throw 'Python 環境が作成されませんでした' }
        Set-Content -LiteralPath $venvMarker -Value 'ndlocr-lite-zotero-venv-v1' -Encoding ASCII
    }
    $req = Join-Path $dir 'requirements-cli.txt'
    Get-Content (Join-Path $ndlDir 'requirements.txt') | Where-Object { $_ -notmatch '^(?i)flet' } | Set-Content -Path $req -Encoding ASCII
    & $uv pip install --python $venvPy -r $req
    if ($LASTEXITCODE -ne 0) { throw 'パッケージのインストールに失敗しました' }
    # uv はメッセージを標準エラーに出すので、PowerShell 5.1 で例外にならないよう try で包む
    try { & $uv cache clean *> $null } catch { }

    # 4. 動作確認
    Write-Host '[4/4] 動作確認…'
    & $venvPy (Join-Path $ndlDir 'src\ocr.py') --version
    if ($LASTEXITCODE -ne 0) {
        $msg = "NDLOCR-Lite の起動に失敗しました。`n`n'DLL load failed' と出ている場合は、Microsoft Visual C++ 再頒布可能パッケージ`nhttps://aka.ms/vs/17/release/vc_redist.x64.exe`nをインストールしてから、このインストーラをもう一度実行してください。"
        Write-Warning $msg
        Show-Message $msg 'Error'
        throw '動作確認に失敗しました'
    }

    $copied = ''
    try { Set-Clipboard -Value $dir; $copied = '（パスはクリップボードにコピーしました）' } catch { }
    $done = "インストールが完了しました。`n`nZotero の 設定 → NDLOCR-Lite for Zotero で、次のフォルダを指定してください$copied`:`n`n$dir"
    Write-Host ''
    Write-Host $done
    Write-Host ''
    Show-Message $done
}
finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
