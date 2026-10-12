#!/usr/bin/env python3
"""Publish verified private release bytes; never replace an existing asset."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

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
    gh('release', 'create', tag, '--repo', repo, '--target', args.commit, '--draft',
       '--title', '明明音乐 ' + tag, '--notes-file', 'docs/releases/' + tag + '.md')
    releases = json.loads(gh('api', 'repos/' + repo + '/releases?per_page=100'))
    release = next(r for r in releases if r['tag_name'] == tag)
assert release['target_commitish'] == args.commit, 'release belongs to another source commit'
existing = {a['name']: a for a in release['assets']}
for file in files:
    digest = 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
    if file.name in existing:
        assert existing[file.name]['digest'] == digest, 'existing bytes differ; preserving release'
    else:
        assert release['draft'], 'published release is missing assets'
        gh('release', 'upload', tag, str(file), '--repo', repo)
release = json.loads(gh('api', 'repos/' + repo + '/releases/' + str(release['id'])))
assets = {a['name']: a for a in release['assets']}
for file in files:
    assert assets[file.name]['digest'] == 'sha256:' + hashlib.sha256(file.read_bytes()).hexdigest()
    assert assets[file.name]['size'] == file.stat().st_size
if release['draft']:
    gh('release', 'edit', tag, '--repo', repo, '--draft=false')
print('Published verified private release:', tag)
