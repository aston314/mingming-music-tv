const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const {chromium} = require('playwright');

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mingming-browser-'));
  const binary = path.join(scratch, 'core');
  execFileSync('go', ['build', '-o', binary, './core/cmd/mingmingmusic'], {stdio: 'inherit'});
  const child = spawn(binary, ['-port', '0', '-instance-id', 'browser-ci', '-fixture=true'], {
    env: {...process.env, MINGMING_DATA_DIR: path.join(scratch, 'data')}
  });
  let browser;
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture readiness timeout')), 30000);
      child.stdout.on('data', data => {
        const match = data.toString().match(/MINGMING_MUSIC_READY (\d+) browser-ci/);
        if (match) {clearTimeout(timer); resolve(match[1]);}
      });
      child.on('exit', code => {clearTimeout(timer); reject(new Error('Core exited: ' + code));});
    });
    browser = await chromium.launch({headless: true});
    const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
    const page = await context.newPage();
    const harness = fs.readFileSync('tests/focus-browser.js', 'utf8');
    await page.goto('http://127.0.0.1:' + port + '/');
    for (const stage of ['queue-toggle', 'pages', 'player']) {
      await page.evaluate(harness + '\nseedFocusAudit()');
      await page.reload();
      await page.waitForFunction(() => document.getElementById('connection-label').textContent === '预览数据');
      await page.evaluate(harness + '\ninstallFocusAudit()');
      const result = await page.evaluate(stage => runFocusAudit(stage), stage);
      console.log(JSON.stringify(result));
      if (result.errors.length) throw new Error('Focus regression: ' + stage);
    }
    await page.reload();
    await page.waitForSelector('.playlist-card');
    await page.locator('.playlist-card').first().click();
    await page.locator('.track-row').first().click();
    await page.locator('#now-playing').click();
    await page.waitForFunction(() => document.getElementById('lyric-status').hidden);
    for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}]) {
      await page.setViewportSize(size);
      const badge = await page.evaluate(() => {
        const lyric = document.querySelector('.lyric-badge');
        const comment = document.querySelector('.comment-badge');
        const a = getComputedStyle(lyric), b = getComputedStyle(comment);
        return a.borderRadius === b.borderRadius && a.backgroundColor === b.backgroundColor &&
          a.fontSize === b.fontSize && !!lyric.querySelector('svg') && !lyric.classList.contains('focusable') &&
          document.getElementById('lyric-status').hidden;
      });
      if (!badge) throw new Error('Player heading style mismatch');
    }
    console.log('Player headings and two viewport sizes passed');
  } finally {
    if (browser) await browser.close();
    child.kill('SIGTERM');
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
