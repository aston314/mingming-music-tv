const assert = require('assert/strict');
const path = require('path');

module.exports = async function footerLyric({browser, url, screenshotsDir}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 720}});
  const track = {id: 'footer-timed', name: '底栏歌词测试', artist: '测试歌手', dt: 20000, picUrl: 'https://example.invalid/footer-cover.svg'};
  const longLine = '这是一句很长很长的歌词，在底部保持单行显示，不挤占播放按钮和进度条';
  let releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  try {
    await context.addInitScript(({track}) => {
      window.footerPlayback = {snapshot: {schema: 1, track, position: 0, duration: 20, mode: 'list', list: [track]}, state: 'paused', ready: true, wantPlay: false};
      window.MingmingNativePlayer = {
        read() { return window.holdFooterSample ? '' : JSON.stringify(window.footerPlayback); }, command() {}
      };
    }, {track});
    await context.route('**/api/library', route => route.fulfill({json: {favorites: [], playlists: [], recent: []}}));
    await context.route('**/api/music/lrc', async route => {
      const id = new URLSearchParams(route.request().postData()).get('id');
      if (id === 'footer-late') await late;
      if (id === 'footer-error') return route.fulfill({status: 503, json: {error: 'unavailable'}});
      const data = id === 'footer-plain' ? '没有时间的歌词\n第二句' : id === 'footer-empty' ? '' : '[00:02.00]第一句歌词\n[00:03.00]' + longLine + '\n[00:07.00]最后一句歌词';
      await route.fulfill({json: {data}});
    });
    await context.route('**/api/word-lyric?*', route => route.fulfill({json: {data: {lyric: route.request().url().includes('footer-word') ? '[2000,5000](2000,1000,0)逐字(3000,4000,0)歌词' : ''}}}));
    await context.route('**/api/netease/comments?*', route => route.fulfill({json: {comments: [], total: 0, more: false}}));
    await context.route('**/footer-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#71965f"/></svg>'}));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('player-title').textContent === '底栏歌词测试');
    await page.waitForSelector('#overlay-lyrics .lyric-line', {state: 'attached'});
    async function sample(position, state = 'paused', id = 'footer-timed') {
      await page.evaluate(({position, state, track, id}) => {
        window.holdFooterSample = false;
        window.footerPlayback.snapshot.track = {...track, id};
        window.footerPlayback.snapshot.position = position;
        window.footerPlayback.state = state;
        window.footerPlayback.wantPlay = state === 'playing';
        window.footerPlayback.positionAt = Date.now();
        window.MingmingTVForeground();
      }, {position, state, track, id});
    }
    async function expectLine(text, lyric = true) {
      await page.waitForFunction(({text, lyric}) => {
        const node = document.getElementById('player-artist');
        return node.textContent === text && node.classList.contains('is-lyric') === lyric;
      }, {text, lyric});
    }
    async function resize(size) {
      await page.setViewportSize(size);
      await page.waitForFunction(size => {
        const rect = document.getElementById('stage').getBoundingClientRect();
        return Math.abs(rect.width - size.width) < 1 && Math.abs(rect.height - size.height) < 1;
      }, size);
    }
    await expectLine(track.artist, false);
    await sample(2.1);
    await expectLine('第一句歌词');
    assert.equal(await page.locator('#player-overlay').isVisible(), false, 'footer works without opening fullscreen');
    await sample(2.95, 'playing');
    await page.evaluate(() => { window.holdFooterSample = true; });
    await page.waitForFunction(text => document.getElementById('player-artist').textContent === text, longLine, {polling: 20, timeout: 300});
    await sample(3.2);
    await page.waitForTimeout(550);
    await page.evaluate(() => {
      window.footerMutations = 0;
      window.overlayMutations = 0;
      new MutationObserver(records => { window.footerMutations += records.length; }).observe(document.getElementById('player-artist'), {subtree: true, childList: true, characterData: true, attributes: true});
      new MutationObserver(records => { window.overlayMutations += records.length; }).observe(document.getElementById('overlay-lyrics'), {subtree: true, childList: true, characterData: true, attributes: true});
    });
    await page.waitForTimeout(650);
    assert.equal(await page.locator('#player-artist').textContent(), longLine, 'pause holds the current sentence');
    assert.deepEqual(await page.evaluate(() => [window.footerMutations, window.overlayMutations]), [0, 0], 'paused polls do not rewrite the footer or hidden lyrics');
    await sample(7.5);
    await expectLine('最后一句歌词');
    await sample(0);
    await expectLine(track.artist, false);
    for (const size of [{width: 960, height: 540}, {width: 1280, height: 720}, {width: 1920, height: 1080}]) {
      await resize(size);
      await sample(0);
      const before = await page.locator('.player-bar').evaluate(node => Array.from(node.children, item => { const r = item.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
      await sample(3.2);
      const after = await page.locator('.player-bar').evaluate(node => Array.from(node.children, item => { const r = item.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
      assert.deepEqual(after, before, 'long lyrics preserve footer geometry at ' + size.width);
      const style = await page.locator('#player-artist').evaluate(node => { const css = getComputedStyle(node); return {whiteSpace: css.whiteSpace, overflow: css.overflow, ellipsis: css.textOverflow, color: css.color, clipped: node.scrollWidth > node.clientWidth, titleSize: parseFloat(getComputedStyle(document.getElementById('player-title')).fontSize), size: parseFloat(css.fontSize)}; });
      assert.deepEqual([style.whiteSpace, style.overflow, style.ellipsis, style.color, style.clipped], ['nowrap', 'hidden', 'ellipsis', 'rgb(199, 243, 141)', true]);
      assert.ok(style.size < style.titleSize, 'lyrics remain smaller than the song title');
    }
    await resize({width: 1280, height: 720});
    await sample(2.2);
    await page.screenshot({path: path.join(screenshotsDir, 'footer-current-lyric.png')});
    assert.equal(await page.locator('#now-playing .focusable, #now-playing [tabindex]').count(), 0, 'lyrics do not add a focus stop');
    await page.locator('#now-playing').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'play-mode');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'now-playing');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#player-overlay').isVisible(), true);
    await page.evaluate(() => window.MingmingTVBack());
    assert.equal(await page.evaluate(() => document.activeElement.id), 'now-playing');
    await sample(2.5, 'paused', 'footer-word');
    await expectLine('逐字歌词');
    const lateRequest = page.waitForRequest(request => request.url().endsWith('/api/music/lrc') && request.postData().includes('footer-late'));
    await sample(0, 'paused', 'footer-late');
    await lateRequest;
    await expectLine(track.artist, false);
    for (const id of ['footer-plain', 'footer-empty', 'footer-error']) {
      const response = page.waitForResponse(response => response.url().endsWith('/api/music/lrc') && response.request().postData().includes(id));
      await sample(3.2, 'paused', id);
      await response;
      await page.waitForTimeout(50);
      await expectLine(track.artist, false);
    }
    const lateResponse = page.waitForResponse(response => response.url().endsWith('/api/music/lrc') && response.request().postData().includes('footer-late'));
    releaseLate();
    await lateResponse;
    await page.waitForTimeout(50);
    await expectLine(track.artist, false);
    assert.deepEqual(errors, []);
  } finally {
    releaseLate();
    await context.close();
  }
  console.log('Footer lyrics: timed clock, pause, seek, ellipsis, stable layout and focus passed; screenshot: ' + path.join(screenshotsDir, 'footer-current-lyric.png'));
};
