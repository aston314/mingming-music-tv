#!/usr/bin/env python3
"""Publish verified private release bytes; never replace an existing asset."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import quote

def gh(*args):
    return subprocess.check_output(['gh', *args], text=True)

parser = argparse.ArgumentParser()
parser.add_argument('--directory', type=Path, required=True)
parser.add_argument('--commit', required=True)
args = parser.parse_args()
assert re.fullmatch(r'[0-9a-f]{40}', args.commit)
config = json.loads(Path('app.json').read_text())
repo = config['privateRepository']
assert json.loads(gh('api', 'repos/' + repo))['private'], 'source repository must remain private'
manifest = json.loads((args.directory / 'update.json').read_text())
assert manifest['package_name'] == config['applicationId']
assert manifest['version_code'] == config['versionCode']
tag = 'v' + config['versionName']
name = config['productId'] + '-' + config['versionName'] + '.apk'
apk = args.directory / name
sha = hashlib.sha256(apk.read_bytes()).hexdigest()
assert sha == manifest['sha256'] and apk.stat().st_size == manifest['size']
assert (args.directory / 'SHA256SUMS.txt').read_text().split() == [sha, name]
files = [apk, args.directory / 'update.json', args.directory / 'SHA256SUMS.txt']
releases = json.loads(gh('api', 'repos/' + repo + '/releases?per_page=100'))
release = next((r for r in releases if r['tag_name'] == tag), None)
if release is None:
    # Use the creation response directly: the list endpoint can lag behind a
    # newly created draft and cannot be used as proof that creation failed.
    release = json.loads(gh('api', '--method', 'POST', 'repos/' + repo + '/releases',
        '-f', 'tag_name=' + tag, '-f', 'target_commitish=' + args.commit,
        '-f', 'name=明明音乐 ' + tag, '-F', 'draft=true',
        '-f', 'body=' + Path('docs/releases/' + tag + '.md').read_text()))
elif release['target_commitish'] != args.commit and release['draft'] and not release['assets']:
    # A failed initial upload may leave an empty draft. It contains no signed
    # bytes, so it can be pointed at the repaired build without deleting assets.
    release = json.loads(gh('api', '--method', 'PATCH',
        'repos/' + repo + '/releases/' + str(release['id']),
        '-f', 'target_commitish=' + args.commit,
        '-f', 'body=' + Path('docs/releases/' + tag + '.md').read_text()))
assert release['target_commitish'] == args.commit, 'release belongs to another source commit'
existing = {a['name']: a for a in release['assets']}
for file in files:
    digest = 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
    if file.name in existing:
        assert existing[file.name]['digest'] == digest, 'existing bytes differ; preserving release'
    else:
        assert release['draft'], 'published release is missing assets'
        # Address this exact draft, without resolving its tag through a list.
        upload = release['upload_url'].split('{')[0] + '?name=' + quote(file.name)
        uploaded = json.loads(gh('api', '--method', 'POST', upload,
            '-H', 'Content-Type: application/octet-stream', '--input', str(file)))
        assert uploaded['digest'] == digest and uploaded['size'] == file.stat().st_size
release = json.loads(gh('api', 'repos/' + repo + '/releases/' + str(release['id'])))
assets = {a['name']: a for a in release['assets']}
for file in files:
    assert assets[file.name]['digest'] == 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
    assert assets[file.name]['size'] == file.stat().st_size
if release['draft']:
    gh('api', '--method', 'PATCH', 'repos/' + repo + '/releases/' + str(release['id']),
       '-F', 'draft=false')
print('Published verified private release:', tag)
