const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

module.exports = async function android6Player({browser, url, screenshotsDir}) {
  // Capability simulation, not an old Chromium engine or Android device test.
  const legacyCSS = fs.readFileSync('ui/app.css', 'utf8')
    .replace(/@supports not \(display:grid\)/g, '@supports (display:block)')
    .replace(/[^{};]+:[^{};]*var\([^{};]*/g, '')
    .replace(/\b(?:inset|gap|aspect-ratio|grid-template-columns|grid-template-rows)\s*:[^;}]*;?/g, '')
    .replace(/display:grid/g, 'display:block');
  const track = {id: 'legacy-player', name: '安卓兼容歌词', artist: '测试歌手', dt: 20000, picUrl: 'https://example.invalid/legacy-cover.svg'};
  for (const textClip of [true, false]) {
    const context = await browser.newContext({viewport: {width: 960, height: 540}, hasTouch: true});
    try {
      await context.addInitScript(({track, textClip}) => {
        if (!textClip) {
          const create = document.createElement;
          document.createElement = function (name) {
            const node = create.apply(this, arguments);
            if (name === 'span') Object.defineProperty(node.style, 'webkitBackgroundClip', {get() {return undefined;}});
            return node;
          };
        }
        window.legacyPlayback = {snapshot: {schema: 1, track, position: 2.5, duration: 20, mode: 'list', list: [track]}, state: 'paused', ready: true, wantPlay: false};
        window.MingmingNativePlayer = {read() {return JSON.stringify(window.legacyPlayback);}, command() {}};
      }, {track, textClip});
      await context.route('**/app.css', route => route.fulfill({contentType: 'text/css', body: legacyCSS}));
      await context.route('**/api/library', route => route.fulfill({json: {favorites: [], playlists: [], recent: []}}));
      await context.route('**/api/music/lrc', route => route.fulfill({json: {data: '[00:00.00]前一句\n[00:02.00]随歌声前进\n[00:10.00]下一句'}}));
      await context.route('**/api/word-lyric?*', route => route.fulfill({json: {data: {lyric: '[0,2000](0,2000,0)前一句\n[2000,8000](2000,1000,0)随(3000,1000,0)歌(4000,6000,0)声前进\n[10000,5000](10000,5000,0)下一句'}}}));
      await context.route('**/api/netease/comments?*', route => route.fulfill({json: {comments: [], total: 0, more: false}}));
      await context.route('**/legacy-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#71965f"/></svg>'}));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById('player-title').textContent === '安卓兼容歌词');
      await page.locator('.nav-item[data-page="search"]').click();
      await page.waitForSelector('#side-lyrics .has-word-timing.active');
      await page.locator('#now-playing').focus();
      await page.evaluate(() => window.MingmingTVKey(23));
      await page.waitForSelector('#player-overlay:not([hidden])');
      await page.waitForFunction(() => document.getElementById('overlay-cover').naturalWidth === 300);
      const layout = await page.evaluate(() => {
        const overlay = document.getElementById('player-overlay').getBoundingClientRect();
        const lyrics = document.getElementById('overlay-lyrics').getBoundingClientRect();
        return {overlay: [overlay.left, overlay.top, overlay.width, overlay.height], lyricWidth: lyrics.width, lyricHeight: lyrics.height, display: getComputedStyle(document.querySelector('.player-overlay-body')).display};
      });
      assert.deepEqual(layout.overlay, [0, 0, 960, 540], 'fullscreen remains on screen without inset');
      assert.equal(layout.display, 'flex', 'non-grid fallback is active');
      assert.ok(layout.lyricWidth > 100 && layout.lyricHeight > 100, 'legacy lyrics have visible space');
      for (const selector of ['#side-lyrics', '#overlay-lyrics']) {
        const word = page.locator(selector + ' .active .lyric-word').first();
        const style = await word.evaluate(node => {const s = getComputedStyle(node); return {color: s.color, background: s.backgroundImage, clip: s.webkitBackgroundClip};});
        if (textClip) {assert.match(style.background, /199, 243, 141/); assert.equal(style.clip, 'text');}
        else {assert.equal(style.background, 'none'); assert.equal(style.color, 'rgb(199, 243, 141)', 'unsupported text clipping retains visible word highlighting');}
      }
      await page.locator('#player-comments-toggle').click();
      assert.equal(await page.locator('#overlay-lyrics.lyrics-four-line').count(), 1);
      await page.evaluate(() => {window.legacyPlayback.snapshot.position = 3.5;});
      await page.waitForFunction(() => document.getElementById('overlay-elapsed').textContent === '00:03');
      assert.equal(await page.locator('#overlay-lyrics .active').textContent(), '随歌声前进');
      if (screenshotsDir) await page.screenshot({path: path.join(screenshotsDir, 'legacy-player-' + textClip + '.png')});
      await page.evaluate(() => window.MingmingTVBack());
      assert.equal(await page.evaluate(() => document.activeElement.id), 'now-playing', 'remote Back restores footer entry');
      await page.locator('#now-playing').tap();
      assert.equal(await page.locator('#player-overlay').isVisible(), true, 'touch opens the same legacy overlay');
      await page.evaluate(() => window.MingmingTVBack());
      await page.evaluate(() => window.MingmingTVKey(66));
      assert.equal(await page.locator('#player-overlay').isVisible(), true, 'native Enter still opens immediately after a touch');
      await page.evaluate(() => window.MingmingTVBack());
      await page.locator('#now-playing').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#player-overlay').isVisible(), true, 'keyboard Enter shares the player action');
      assert.deepEqual(errors, []);
    } finally {await context.close();}
  }
  console.log('Legacy CSS capability simulation: remote/touch entry, overlay bounds, lyric gradients and no-clip fallback passed');
};
