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
    async function sample(position, state = 'paused', id = 'footer-timed', metadata = {}) {
      await page.evaluate(({position, state, track, id, metadata}) => {
        window.holdFooterSample = false;
        window.footerPlayback.snapshot.track = {...track, id, ...metadata};
        window.footerPlayback.snapshot.position = position;
        window.footerPlayback.state = state;
        window.footerPlayback.wantPlay = state === 'playing';
        window.footerPlayback.positionAt = Date.now();
        window.MingmingTVForeground();
      }, {position, state, track, id, metadata});
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
    assert.equal(await page.locator('#player-heading-artist').isVisible(), false, 'artist stays on the second line before lyrics begin');
    await sample(2.1);
    await expectLine('第一句歌词');
    await page.waitForFunction(() => !document.getElementById('player-heading-artist').hidden);
    assert.equal(await page.locator('#player-heading-artist').textContent(), '· 测试歌手');
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
      new MutationObserver(records => { window.footerMutations += records.length; }).observe(document.getElementById('player-heading'), {subtree: true, childList: true, characterData: true, attributes: true});
      new MutationObserver(records => { window.overlayMutations += records.length; }).observe(document.getElementById('overlay-lyrics'), {subtree: true, childList: true, characterData: true, attributes: true});
    });
    await page.waitForTimeout(650);
    assert.equal(await page.locator('#player-artist').textContent(), longLine, 'pause holds the current sentence');
    assert.deepEqual(await page.evaluate(() => [window.footerMutations, window.overlayMutations]), [0, 0], 'paused polls do not rewrite the footer or hidden lyrics');
    await sample(7.5);
    await expectLine('最后一句歌词');
    await sample(0);
    await expectLine(track.artist, false);
    assert.equal(await page.locator('#player-heading-artist').isVisible(), false, 'seeking before the first line removes the duplicate artist');
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
    const box = await page.locator('#now-playing').boundingBox();
    const variants = [
      {id: 'footer-short', name: '红豆', artist: '王菲', shown: true, clippedArtist: false},
      {id: 'footer-many-artists', name: '红豆', artist: '王菲 / 陈奕迅 / 林俊杰 / 孙燕姿 / 五月天', shown: true, clippedArtist: true},
      {id: 'footer-long-title', name: '这是一个非常非常长的歌曲名称与现场演唱版本', artist: '测试歌手', shown: false},
      {id: 'footer-little-space', name: '这是十个字的歌曲名称', artist: '测试歌手', shown: false}
    ];
    for (const variant of variants) {
      await sample(3.2, 'paused', variant.id, variant);
      await expectLine(longLine);
      await page.waitForTimeout(80);
      const actual = await page.locator('#player-heading').evaluate(node => {
        const title = document.getElementById('player-title'), suffix = document.getElementById('player-heading-artist');
        return {shown: !suffix.hidden, titleClipped: title.scrollWidth > title.clientWidth, artistClipped: suffix.scrollWidth > suffix.clientWidth, titleBottom: title.getBoundingClientRect().bottom, lyricTop: document.getElementById('player-artist').getBoundingClientRect().top};
      });
      assert.equal(actual.shown, variant.shown, variant.id + ' gives priority to the full song title');
      if (variant.shown) {
        assert.equal(actual.titleClipped, false, 'artist never truncates a title that fits');
        assert.equal(actual.artistClipped, variant.clippedArtist);
      }
      assert.ok(actual.titleBottom <= actual.lyricTop, 'the two lines do not overlap');
      assert.deepEqual(await page.locator('#now-playing').boundingBox(), box, 'metadata does not resize the footer');
      await page.screenshot({path: path.join(screenshotsDir, variant.id + '.png')});
    }
    // Resizing preserves title priority on the shared logical TV canvas,
    // including while paused. No per-tick measurements.
    await resize({width: 1920, height: 800});
    await sample(3.2, 'paused', 'footer-wide', {name: '红豆'});
    await page.waitForFunction(() => !document.getElementById('player-heading-artist').hidden);
    await resize({width: 960, height: 540});
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#player-heading-artist').isVisible(), true);
    await resize({width: 1280, height: 720});
    await sample(2.2);
    await page.locator('#nav-settings').click();
    await page.locator('#settings-text-large').click();
    await page.waitForTimeout(180);
    assert.equal(await page.locator('#player-heading-artist').isVisible(), true, 'changing text settings preserves readable metadata');
    await page.locator('#settings-text-standard').click();
    await page.locator('#nav-recommend').click();
    await page.waitForTimeout(180);
    const headingReads = await page.evaluate(() => new Promise(resolve => {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth');
      let reads = 0;
      Object.defineProperty(Element.prototype, 'scrollWidth', {...descriptor, get() { if (this.id === 'player-title') reads++; return descriptor.get.call(this); }});
      setTimeout(() => { Object.defineProperty(Element.prototype, 'scrollWidth', descriptor); resolve(reads); }, 650);
    }));
    assert.equal(headingReads, 0, 'native polling never remeasures unchanged heading text');
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
      assert.equal(await page.locator('#player-heading-artist').isVisible(), false, id + ' keeps the artist on the second line');
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
  console.log('Footer lyrics: clock, pause, seek, adaptive title/artist, ellipsis, resize, idle measurements, stable layout and focus passed; screenshot: ' + path.join(screenshotsDir, 'footer-current-lyric.png'));
};
