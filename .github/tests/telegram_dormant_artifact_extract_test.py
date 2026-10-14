import importlib.util
import hashlib
import json
import pathlib
import stat
import tempfile
import unittest
import zipfile

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / 'ops/telegram-dormant-artifact-extract.py'
spec = importlib.util.spec_from_file_location('tg_extract', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA = 'a' * 40
FILES = module.FILES


def make_payload():
    p = {name: ('file-' + name).encode('utf-8') for name in FILES}
    p['.deploy/telegram-sha256.manifest'] = ''.join(
        hashlib.sha256(p[f]).hexdigest() + '  ' + f + '\n' for f in FILES
    ).encode('utf-8')
    p['.deploy/preparation.json'] = (json.dumps({
        'schemaVersion': 'telegram-isolated-dormant-package-v1',
        'sha': SHA, 'mode': 'PREPARE_ONLY', 'workerStarted': False,
        'productionAppChanged': False, 'pm2Restarts': 0,
        'telegramMessages': 0, 'financialMutations': 0, 'paths': list(FILES),
    }) + '\n').encode('utf-8')
    p['.deploy/current-sha'] = (SHA + '\n').encode('ascii')
    return p


def write_zip(path, payload, duplicate=None, symlink=None):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in payload.items():
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = ((stat.S_IFLNK if name == symlink else stat.S_IFREG)
                                  | 0o600) << 16
            z.writestr(info, data)
        if duplicate:
            z.writestr(duplicate, b'evil')


class ArtifactExtractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / 'artifact.zip'
        self.target = self.root / 'extracted'

    def exercise(self, payload, **kw):
        write_zip(self.source, payload, **kw)
        return module.extract(str(self.source), str(self.target), SHA)

    def test_exact_package_extracted_to_new_dir_without_start(self):
        result = self.exercise(make_payload())
        self.assertEqual(result['files'], 6)
        self.assertEqual(result['status'], 'EXTRACTED_INACTIVE')
        self.assertEqual((self.target / '.deploy/current-sha').read_text().strip(), SHA)
        self.assertEqual((self.target.stat().st_mode & 0o777), 0o700)

    def test_missing_duplicate_and_extra_paths_blocked(self):
        for kind in ('missing', 'duplicate', 'traversal'):
            with self.subTest(kind=kind):
                p = make_payload()
                duplicate = None
                if kind == 'missing':
                    p.pop(FILES[0])
                if kind == 'duplicate':
                    duplicate = FILES[0]
                if kind == 'traversal':
                    p['../not-allowed'] = b'evil'
                with self.assertRaises(ValueError):
                    self.exercise(p, duplicate=duplicate)
                self.assertFalse(self.target.exists())

    def test_symlink_cannot_extract(self):
        with self.assertRaisesRegex(ValueError, 'SPECIAL_FILE'):
            self.exercise(make_payload(), symlink=FILES[0])
        self.assertFalse(self.target.exists())

    def test_wrong_digest_source_sha_and_receipt_blocked(self):
        for kind in ('digest', 'sha', 'receipt'):
            with self.subTest(kind=kind):
                p = make_payload()
                if kind == 'digest':
                    p[FILES[0]] += b'injected'
                if kind == 'sha':
                    p['.deploy/current-sha'] = b'b' * 40 + b'\n'
                if kind == 'receipt':
                    r = json.loads(p['.deploy/preparation.json'])
                    r['workerStarted'] = True
                    p['.deploy/preparation.json'] = json.dumps(r).encode()
                with self.assertRaises(ValueError):
                    self.exercise(p)
                self.assertFalse(self.target.exists())

    def test_never_overwrites_an_existing_output(self):
        self.target.mkdir()
        with self.assertRaisesRegex(ValueError, 'DESTINATION_UNSAFE'):
            self.exercise(make_payload())

    def test_wrong_current_sha_rejected(self):
        write_zip(self.source, make_payload())
        with self.assertRaisesRegex(ValueError, 'SHA_INVALID'):
            module.extract(str(self.source), str(self.target), 'unsafe')


if __name__ == '__main__':
    unittest.main()
