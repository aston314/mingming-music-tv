#!/usr/bin/env python3
"""Prepare the three distribution files from the verified signed APK."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shutil
from verify_apk import verify

parser = argparse.ArgumentParser()
parser.add_argument('--apk', type=Path, required=True)
parser.add_argument('--out', type=Path, required=True)
args = parser.parse_args()
config = json.loads(Path('app.json').read_text())
report = verify(args.apk)
args.out.mkdir(parents=True, exist_ok=True)
name = config['productId'] + '-' + config['versionName'] + '.apk'
apk = args.out / name
shutil.copyfile(args.apk, apk)
sha = hashlib.sha256(apk.read_bytes()).hexdigest()
assert sha == report['sha256']
repository = config.get('publicReleaseRepository') or config['privateRepository']
notes = Path('docs/releases/v' + config['versionName'] + '.md').read_text().strip()
manifest = {'schema': 1, 'package_name': config['applicationId'],
            'version_code': config['versionCode'], 'version_name': config['versionName'],
            'min_sdk': config['minSdk'], 'size': apk.stat().st_size, 'sha256': sha,
            'signing_certificate_sha256': report['certificate_sha256'],
            'download_url': 'https://github.com/' + repository + '/releases/download/v' + config['versionName'] + '/' + name,
            'release_notes': notes, 'published_at': datetime.now(timezone.utc).isoformat()}
(args.out / 'update.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
(args.out / 'SHA256SUMS.txt').write_text(sha + '  ' + name + '\n')
print('Prepared signed distribution:', name)
