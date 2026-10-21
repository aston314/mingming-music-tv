"""Exercise draft recovery and immutable release safety without network writes."""
import copy
import hashlib
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


class ReleasePublicationTest(unittest.TestCase):
    def exercise(self, scenario):
        config = json.loads((ROOT / 'app.json').read_text())
        commit, previous = 'a' * 40, 'b' * 40
        tag = 'v' + config['versionName']
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            apk = output / (config['productId'] + '-' + config['versionName'] + '.apk')
            apk.write_bytes(b'already-verified-test-bytes')
            digest = hashlib.sha256(apk.read_bytes()).hexdigest()
            (output / 'update.json').write_text(json.dumps({
                'package_name': config['applicationId'], 'version_code': config['versionCode'],
                'sha256': digest, 'size': apk.stat().st_size}))
            (output / 'SHA256SUMS.txt').write_text(digest + '  ' + apk.name + '\n')
            release = {'id': 123, 'tag_name': tag, 'target_commitish': previous,
                       'draft': scenario != 'published', 'assets': [],
                       'upload_url': 'https://uploads.example/releases/123/assets{?name,label}'}
            calls = []

            def gh(command, text=True):
                calls.append(command)
                endpoint = next(a for a in command if a.startswith(('repos/', 'https://uploads.')))
                method = command[command.index('--method') + 1] if '--method' in command else 'GET'
                if endpoint.endswith('/git/ref/tags/' + tag):
                    response = {'object': {'type': 'commit', 'sha': commit}}
                elif endpoint.endswith('releases?per_page=100'):
                    response = [] if scenario == 'lag' else [copy.deepcopy(release)]
                elif method == 'POST' and endpoint.endswith('/releases'):
                    release['target_commitish'] = commit
                    response = copy.deepcopy(release)
                elif method == 'POST' and endpoint.startswith('https://uploads.'):
                    file = Path(command[command.index('--input') + 1])
                    data = file.read_bytes()
                    response = {'name': file.name, 'size': len(data),
                                'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
                    release['assets'].append(response)
                elif method == 'PATCH':
                    # Simulate the observed server behavior: omitted tag_name
                    # can turn an edited draft into an untagged release.
                    release['tag_name'] = tag if 'tag_name=' + tag in command else 'untagged-test'
                    if 'target_commitish=' + commit in command:
                        release['target_commitish'] = commit
                    if 'draft=false' in command:
                        release['draft'] = False
                    response = copy.deepcopy(release)
                else:
                    response = copy.deepcopy(release)
                return json.dumps(response)

            argv = ['publish_release.py', '--directory', directory, '--commit', commit]
            with patch.object(sys, 'argv', argv), patch('subprocess.check_output', gh):
                if scenario == 'published':
                    with self.assertRaises(AssertionError):
                        runpy.run_path(str(ROOT / 'scripts/publish_release.py'), run_name='__main__')
                    self.assertFalse(any('--method' in call for call in calls))
                    self.assertFalse(any(
                        call[2:] == ['repos/' + config['repository']]
                        for call in calls if len(call) >= 3
                    ))
                    return
                runpy.run_path(str(ROOT / 'scripts/publish_release.py'), run_name='__main__')
            self.assertFalse(release['draft'])
            self.assertEqual(release['tag_name'], tag)
            self.assertEqual(release['target_commitish'], commit)
            self.assertEqual(len(release['assets']), 3)
            self.assertEqual(sum('releases?per_page=100' in call[-1] for call in calls), 1)

    def test_creation_does_not_depend_on_immediate_list_visibility(self):
        self.exercise('lag')

    def test_empty_draft_can_retry_without_losing_version_tag(self):
        self.exercise('retry')

    def test_published_release_for_other_commit_is_preserved(self):
        self.exercise('published')


if __name__ == '__main__':
    unittest.main()
