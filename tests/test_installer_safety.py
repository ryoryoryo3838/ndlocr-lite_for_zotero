import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'installer/install_mac.command'
# インストーラの既定の NDLOCR-Lite の版。既存のインストール先を再利用するテストはこの版で作る
DEFAULT_VERSION = re.search(r'NDLOCR_VERSION="\$\{NDLOCR_VERSION:-([^}]+)\}"', SCRIPT.read_text()).group(1)


class InstallerSafetyTests(unittest.TestCase):
    def test_windows_never_recursively_deletes_source(self):
        script = (SCRIPT.parent / 'install_windows.ps1').read_text()
        self.assertNotIn('Remove-Item -Recurse -Force $ndlDir', script)

    def test_windows_rejects_unmarked_directories_before_download(self):
        script = (SCRIPT.parent / 'install_windows.ps1').read_text()
        self.assertIn('unmarked ndlocr-lite or .venv', script)
        self.assertLess(script.index('unmarked ndlocr-lite or .venv'), script.index('Invoke-WebRequest'))
        self.assertNotIn("(Test-Path (Join-Path $picked '.venv')) -or", script)


    def test_rejects_corrupt_uv_download_before_extraction(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / 'bin'
            fakebin.mkdir()
            curl = fakebin / 'curl'
            curl.write_text('#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\nprintf corrupt > "$2"\n')
            curl.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': f'{fakebin}:/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1', 'NDLOCR_BUNDLED_UV': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(root / 'install')], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('sha256', result.stderr.lower())
            self.assertFalse((root / 'install/uv').exists())

    def test_macos_12_rejected_before_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fakebin = root / 'bin'
            fakebin.mkdir()
            for name, content in {'uname': 'case "$1" in -s) echo Darwin;; -m) echo arm64;; esac', 'sw_vers': 'echo 12.7.6', 'curl': 'exit 99'}.items():
                path = fakebin / name
                path.write_text('#!/bin/sh\n' + content + '\n')
                path.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': f'{fakebin}:/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(root / 'install')], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('macOS 13', result.stderr)
            self.assertFalse((root / 'install/uv').exists())

    def test_legacy_unmarked_venv_is_not_modified_or_executed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            ndl = dest / 'ndlocr-lite'
            ndl.mkdir(parents=True)
            (ndl / '.installed-version').write_text(DEFAULT_VERSION + '\n')
            (ndl / 'requirements.txt').write_text('numpy\n')
            uv = dest / 'uv/uv'
            uv.parent.mkdir()
            uv.write_text('#!/bin/sh\ntouch "$HOME/uv-ran"\n')
            uv.chmod(0o755)
            python = dest / '.venv/bin/python'
            python.parent.mkdir(parents=True)
            python.write_text('#!/bin/sh\ntouch "$HOME/python-ran"\n')
            python.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': '/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('.venv', result.stderr)
            self.assertIn('別の', result.stderr)
            self.assertFalse((root / 'uv-ran').exists())
            self.assertFalse((root / 'python-ran').exists())
            self.assertTrue(python.exists())
            self.assertFalse((dest / '.venv/.ndlocr-zotero-venv').exists())

    def test_version_change_preserves_directory_swapped_after_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            ndl = dest / 'ndlocr-lite'
            ndl.mkdir(parents=True)
            (ndl / '.installed-version').write_text('old\n')
            uv = dest / 'uv/uv'
            uv.parent.mkdir()
            uv.write_text('''#!/bin/sh
if [ "$1" = --version ]; then
  mv "$DEST/ndlocr-lite" "$DEST/original"
  mkdir "$DEST/ndlocr-lite"
  printf keep > "$DEST/ndlocr-lite/important"
fi
exit 0
''')
            uv.chmod(0o755)
            fakebin = root / 'bin'
            fakebin.mkdir()
            curl = fakebin / 'curl'
            curl.write_text('#!/bin/sh\nexit 1\n')
            curl.chmod(0o755)
            import zipfile
            archive = root / 'source.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('source/requirements.txt', 'numpy\n')
            env = {**os.environ, 'HOME': tmp, 'DEST': str(dest), 'PATH': f'{fakebin}:/usr/bin:/bin', 'NDLOCR_SRC_ZIP': str(archive), 'NDLOCR_FROM_ZOTERO': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(ndl.exists())
            if (ndl / 'important').exists():
                self.assertEqual((ndl / 'important').read_text(), 'keep')
            else:
                self.assertEqual((ndl / '.installed-version').read_text(), 'old\n')
            self.assertIn('別の', result.stderr)

    def test_interrupted_source_copy_can_be_retried(self):
        import zipfile
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            uv = dest / 'uv/uv'
            uv.parent.mkdir(parents=True)
            uv.write_text('''#!/bin/sh
if [ "$1" = venv ]; then mkdir -p "$4/bin"; printf '#!/bin/sh\\nexit 0\\n' > "$4/bin/python"; chmod +x "$4/bin/python"; fi
exit 0
''')
            uv.chmod(0o755)
            archive = root / 'source.zip'
            with zipfile.ZipFile(archive, 'w') as z:
                z.writestr('source/requirements.txt', 'numpy\n')
            fakebin = root / 'bin'
            fakebin.mkdir()
            cp = fakebin / 'cp'
            cp.write_text('''#!/bin/sh
if [ "$1" = -R ] && [ ! -e "$HOME/failed" ]; then touch "$HOME/failed"; exit 1; fi
exec /bin/cp "$@"
''')
            cp.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': f'{fakebin}:/usr/bin:/bin', 'NDLOCR_SRC_ZIP': str(archive), 'NDLOCR_FROM_ZOTERO': '1'}
            first = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(first.returncode, 0)
            second = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(second.returncode, 0, second.stderr)
            self.assertEqual((dest / 'ndlocr-lite/.installed-version').read_text().strip(), DEFAULT_VERSION)

    def test_interrupted_venv_creation_can_be_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            ndl = dest / 'ndlocr-lite'
            ndl.mkdir(parents=True)
            (ndl / '.installed-version').write_text(DEFAULT_VERSION + '\n')
            (ndl / 'requirements.txt').write_text('numpy\n')
            uv = dest / 'uv/uv'
            uv.parent.mkdir()
            uv.write_text('''#!/bin/sh
if [ "$1" = venv ]; then
  if [ ! -e "$HOME/failed" ]; then touch "$HOME/failed"; exit 1; fi
  mkdir -p "$4/bin"
  printf '#!/bin/sh\\nexit 0\\n' > "$4/bin/python"
  chmod +x "$4/bin/python"
fi
exit 0
''')
            uv.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': '/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
            first = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(first.returncode, 0)
            second = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(second.returncode, 0, second.stderr)

    def test_new_venv_gets_marker_and_can_be_reused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            ndl = dest / 'ndlocr-lite'
            ndl.mkdir(parents=True)
            (ndl / '.installed-version').write_text(DEFAULT_VERSION + '\n')
            (ndl / 'requirements.txt').write_text('numpy\n')
            uv = dest / 'uv/uv'
            uv.parent.mkdir()
            uv.write_text('#!/bin/sh\nif [ "$1" = venv ]; then mkdir -p "$4/bin"; printf "#!/bin/sh\\nexit 0\\n" > "$4/bin/python"; chmod +x "$4/bin/python"; fi\nexit 0\n')
            uv.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': '/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
            for _ in range(2):
                result = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
            marker = dest / '.venv/.ndlocr-zotero-venv'
            self.assertTrue(marker.is_file())
            self.assertEqual(marker.read_text().strip(), 'ndlocr-lite-zotero-venv-v1')

    def test_venv_created_after_preflight_is_not_adopted(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            ndl = dest / 'ndlocr-lite'
            ndl.mkdir(parents=True)
            (ndl / '.installed-version').write_text(DEFAULT_VERSION + '\n')
            (ndl / 'requirements.txt').write_text('numpy\n')
            uv = dest / 'uv/uv'
            uv.parent.mkdir()
            uv.write_text('#!/bin/sh\nif [ "$1" = --version ]; then mkdir -p "$DEST/.venv/bin"; printf "#!/bin/sh\\ntouch \\\"$HOME/python-ran\\\"\\n" > "$DEST/.venv/bin/python"; chmod +x "$DEST/.venv/bin/python"; fi\nexit 0\n')
            uv.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'DEST': str(dest), 'PATH': '/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((root / 'python-ran').exists())
            self.assertFalse((dest / '.venv/.ndlocr-zotero-venv').exists())

    def test_windows_has_separate_venv_marker_guard(self):
        script = (SCRIPT.parent / 'install_windows.ps1').read_text()
        self.assertIn("Join-Path $venvPath '.ndlocr-zotero-venv'", script)
        self.assertLess(script.index('Join-Path $venvPath \'.ndlocr-zotero-venv\''), script.index('Invoke-WebRequest'))
        self.assertIn('別の', script)

    def test_marked_existing_install_is_reused_offline(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            dest = root / 'install'
            ndl = dest / 'ndlocr-lite'
            ndl.mkdir(parents=True)
            (ndl / '.installed-version').write_text(DEFAULT_VERSION + '\n')
            (ndl / 'requirements.txt').write_text('flet\nnumpy\n')
            (ndl / 'important').write_text('keep')
            uv = dest / 'uv/uv'
            uv.parent.mkdir()
            uv.write_text('#!/bin/sh\nexit 0\n')
            uv.chmod(0o755)
            python = dest / '.venv/bin/python'
            python.parent.mkdir(parents=True)
            (dest / '.venv/.ndlocr-zotero-venv').write_text('ndlocr-lite-zotero-venv-v1\n')
            python.write_text('#!/bin/sh\nexit 0\n')
            python.chmod(0o755)
            fakebin = root / 'bin'
            fakebin.mkdir()
            curl = fakebin / 'curl'
            curl.write_text('#!/bin/sh\nexit 99\n')
            curl.chmod(0o755)
            env = {**os.environ, 'HOME': tmp, 'PATH': f'{fakebin}:/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
            result = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((ndl / 'important').read_text(), 'keep')
            self.assertEqual((dest / 'requirements-cli.txt').read_text(), 'numpy\n')

    def test_unmarked_existing_directory_is_not_touched(self):
        for name in ('ndlocr-lite', '.venv'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                dest = root / 'install'
                item = dest / name
                item.mkdir(parents=True)
                (item / 'important').write_text('keep')
                fakebin = root / 'bin'
                fakebin.mkdir()
                curl = fakebin / 'curl'
                curl.write_text('#!/bin/sh\nexit 99\n')
                curl.chmod(0o755)
                env = {**os.environ, 'HOME': tmp, 'PATH': f'{fakebin}:/usr/bin:/bin', 'NDLOCR_FROM_ZOTERO': '1'}
                result = subprocess.run(['bash', str(SCRIPT), str(dest)], env=env, capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                try:
                    stderr = result.stderr.decode('utf-8')
                except UnicodeDecodeError as exc:
                    self.fail(f'installer stderr is not UTF-8: {exc}; bytes={result.stderr!r}')
                self.assertIn('unmarked', stderr.lower())
                self.assertEqual((item / 'important').read_text(), 'keep')


if __name__ == '__main__':
    unittest.main()
