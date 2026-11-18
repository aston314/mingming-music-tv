const fs = require('fs');
const os = require('os');
const path = require('path');
const {spawn, execFileSync} = require('child_process');
const {chromium} = require('playwright');

(async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mingming-browser-'));
  const binary = path.join(scratch, 'core');
  execFileSync('go', ['build', '-o', binary, './core/cmd/mingmingmusic'], {stdio: 'inherit'});
  let child;
  async function startCore() {
    child = spawn(binary, ['-port', '0', '-instance-id', 'browser-ci', '-fixture=true'], {
      env: {...process.env, MINGMING_DATA_DIR: path.join(scratch, 'data')}
    });
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Fixture readiness timeout')), 30000);
      child.stdout.on('data', data => {
        output += data.toString();
        const match = output.match(/MINGMING_MUSIC_READY (\d+) browser-ci/);
        if (match) {clearTimeout(timer); resolve(match[1]);}
      });
      child.on('exit', code => {clearTimeout(timer); reject(new Error('Core exited: ' + code));});
    });
    return 'http://127.0.0.1:' + port;
  }
  let browser;
  try {
    const url = await startCore();
    browser = await chromium.launch({headless: true});
    const restart = async () => {
      await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
      return startCore();
    };
    if (process.argv.includes('--playback-only')) {
      await require('../tests/playback-browser.cjs')({browser, url, restart, screenshotsDir: scratch});
      return;
    }
    if (process.argv.includes('--four-lyrics-only')) {
      await require('../tests/four-line-lyrics-browser.cjs')({browser, url, screenshotsDir: scratch});
      return;
    }
    if (process.argv.includes('--legacy-player-only')) {
      await require('../tests/android6-player-browser.cjs')({browser, url, screenshotsDir: scratch});
      return;
    }
    if (process.argv.includes('--focus-performance-only')) {
      await require('../tests/focus-performance-browser.cjs')({browser, url});
      return;
    }
    const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
    const page = await context.newPage();
    const harness = fs.readFileSync('tests/focus-browser.js', 'utf8');
    await page.goto(url + '/');
    async function assertCanvas(size, label) {
      await page.setViewportSize(size);
      await page.waitForFunction(target => {
        const rect = document.getElementById('stage').getBoundingClientRect();
        return document.documentElement.clientWidth === target.width && document.documentElement.clientHeight === target.height && Math.abs(rect.width - target.width) <= 1 && Math.abs(rect.height - target.height) <= 1;
      }, size);
      const metrics = await page.evaluate(() => {
        const root = document.documentElement;
        const stage = document.getElementById('stage');
        const rect = stage.getBoundingClientRect();
        return {
          client: [root.clientWidth, root.clientHeight],
          scale: window.__tvScale,
          logical: [stage.offsetWidth, stage.offsetHeight],
          rendered: [rect.left, rect.top, rect.width, rect.height],
          bodyTransform: getComputedStyle(document.body).transform
        };
      });
      if (metrics.client[0] !== size.width || metrics.client[1] !== size.height) throw new Error('Viewport client size mismatch (' + label + '): ' + JSON.stringify(metrics));
      if (!(metrics.scale > 0) || metrics.logical[0] < 1280 || metrics.logical[1] < 720) throw new Error('Logical canvas mismatch (' + label + '): ' + JSON.stringify(metrics));
      if (Math.abs(metrics.rendered[0]) > 1 || Math.abs(metrics.rendered[1]) > 1 || Math.abs(metrics.rendered[2] - size.width) > 1 || Math.abs(metrics.rendered[3] - size.height) > 1) throw new Error('Rendered canvas does not fill viewport (' + label + '): ' + JSON.stringify(metrics));
      if (metrics.bodyTransform !== 'none') throw new Error('Body has a second transform (' + label + '): ' + JSON.stringify(metrics));
    }
    for (const size of [{width: 960, height: 540}, {width: 1280, height: 720}, {width: 1920, height: 1080}, {width: 928, height: 696}, {width: 1280, height: 800}, {width: 1920, height: 800}]) await assertCanvas(size, 'desktop ' + size.width + 'x' + size.height);
    console.log('Fixed canvas desktop viewports passed');
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
    for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}, {width: 928, height: 696}, {width: 1280, height: 800}, {width: 1920, height: 800}]) {
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
    const mobileContext = await browser.newContext({viewport: {width: 960, height: 540}, isMobile: true, deviceScaleFactor: 2, userAgent: 'Mozilla/5.0 (Linux; Android 11; Android TV) AppleWebKit/537.36 Chrome/120 Safari/537.36'});
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(url + '/');
    for (const size of [{width: 960, height: 540}, {width: 1280, height: 720}, {width: 1920, height: 1080}]) {
      await mobilePage.setViewportSize(size);
      await mobilePage.waitForFunction(target => {
        const rect = document.getElementById('stage').getBoundingClientRect();
        return document.documentElement.clientWidth === target.width && document.documentElement.clientHeight === target.height && Math.abs(rect.width - target.width) <= 1 && Math.abs(rect.height - target.height) <= 1;
      }, size);
      const metrics = await mobilePage.evaluate(() => { const root = document.documentElement, stage = document.getElementById('stage'), rect = stage.getBoundingClientRect(); return {client: [root.clientWidth, root.clientHeight], inner: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio, scale: window.__tvScale, rendered: [rect.left, rect.top, rect.width, rect.height], logical: [stage.offsetWidth, stage.offsetHeight]}; });
      if (metrics.client[0] !== size.width || metrics.client[1] !== size.height || Math.abs(metrics.rendered[2] - size.width) > 1 || Math.abs(metrics.rendered[3] - size.height) > 1 || metrics.logical[0] < 1280 || metrics.logical[1] < 720) throw new Error('Android-like canvas mismatch: ' + JSON.stringify(metrics));
    }
    await mobileContext.close();
    console.log('Fixed canvas Android-like viewports passed');
    console.log('Player headings and two viewport sizes passed');
    await context.close();
    await require('../tests/details-browser.cjs')({browser, url, screenshotsDir: scratch});
    await require('../tests/queue-loading-browser.cjs')({browser, url, screenshotsDir: scratch});
    await require('../tests/comments-visibility-browser.cjs')({browser, url, screenshotsDir: scratch});
    await require('../tests/four-line-lyrics-browser.cjs')({browser, url, screenshotsDir: scratch});
    await require('../tests/android6-player-browser.cjs')({browser, url, screenshotsDir: scratch});
    await require('../tests/focus-performance-browser.cjs')({browser, url});
    await require('../tests/phone-login-browser.cjs')({browser, url});
    await require('../tests/playback-browser.cjs')({browser, url, restart, screenshotsDir: scratch});
  } finally {
    if (browser) await browser.close();
    if (child) child.kill('SIGTERM');
  }
})().catch(error => {console.error(error); process.exitCode = 1;});
