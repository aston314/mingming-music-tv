#!/usr/bin/env python3
"""Verify the APK identity and embedded executable against the release checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import zipfile


def verify(apk, debug=False):
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / 'app.json').read_text())
    version = os.environ.get('MINGMING_CORE_VERSION', config['versionName'] + '-dev')
    machines = {'arm64-v8a': 183, 'armeabi-v7a': 40, 'x86_64': 62}
    embedded = {}
    with zipfile.ZipFile(apk) as archive:
        assert archive.testzip() is None, 'corrupt APK entry'
        for abi in config['abis']:
            binary = archive.read('lib/' + abi + '/libmingmingmusic.so')
            assert binary[:4] == b'\x7fELF', 'invalid core binary'
            assert struct.unpack_from('<H', binary, 18)[0] == machines[abi], 'wrong ABI'
            # A PIE must contain an interpreter. A c-shared library cannot be
            # executed by CoreService's ProcessBuilder as the standalone core.
            elf64 = binary[4] == 2
            phoff = struct.unpack_from('<Q' if elf64 else '<I', binary, 32 if elf64 else 28)[0]
            phentsize, phnum = struct.unpack_from('<HH', binary, 54 if elf64 else 42)
            assert any(struct.unpack_from('<I', binary, phoff + i * phentsize)[0] == 3 for i in range(phnum)), 'missing ELF interpreter'
            assert version.encode() in binary, 'wrong core build identity'
            assert (root / 'app.json').read_bytes() in binary, 'wrong product configuration'
            for name in ['index.html', 'app.css', 'app.js', 'phone.html', 'phone.js']:
                assert (root / 'ui' / name).read_bytes() in binary, 'stale UI: ' + abi + '/' + name
            embedded[abi] = len(binary)
    sdk = Path(os.environ['ANDROID_HOME'])
    tools = sdk / 'build-tools/35.0.0'
    badging = subprocess.check_output([str(tools / 'aapt'), 'dump', 'badging', str(apk)], text=True)
    assert "name='" + config['applicationId'] + ('.debug' if debug else '') + "'" in badging
    assert "versionName='" + config['versionName'] + ('-debug' if debug else '') + "'" in badging
    assert "versionCode='" + str(config['versionCode']) + "'" in badging
    assert "sdkVersion:'" + str(config['minSdk']) + "'" in badging
    assert "application-label:'" + config['displayName'] + "'" in badging
    assert ('application-debuggable' in badging) == debug
    signer = subprocess.check_output([str(tools / 'apksigner'), 'verify', '--verbose', '--print-certs', str(apk)], text=True)
    digest = re.search(r'certificate SHA-256 digest: ([a-fA-F0-9]+)', signer).group(1).lower()
    if not debug:
        assert digest == config['signingCertificateSha256'], (
            'unexpected release signer: actual=' + digest
            + ', expected=' + config['signingCertificateSha256'])
    return {'apk': apk.name, 'bytes': apk.stat().st_size,
            'sha256': hashlib.sha256(apk.read_bytes()).hexdigest(), 'core_version': version,
            'abis': embedded, 'embedded_ui_matches': True, 'product_matches': True,
            'manifest_verified': True, 'signature_verified': True, 'certificate_sha256': digest, 'debug': debug}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('apk', type=Path)
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    report = verify(args.apk, args.debug)
    data = json.dumps(report, ensure_ascii=False, indent=2) + '\n'
    if args.out:
        args.out.write_text(data)
    print(data)
