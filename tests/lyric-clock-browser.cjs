const assert = require('assert/strict');

module.exports = async function lyricClock({browser, url}) {
  const context = await browser.newContext({viewport: {width: 1280, height: 720}});
  const track = {id: 'lyric-clock', name: '连续时钟测试', artist: '测试歌手', dt: 20000, picUrl: 'https://example.invalid/clock-cover.svg'};
  const lyric = '[0,4000](0,2000,0)随(2000,2000,0)节拍\n[4000,4000](4000,2000,0)继续(6000,2000,0)播放';
  try {
    await context.addInitScript(({track}) => {
      window.clockPlayback = {
        snapshot: {schema: 1, track, position: 0, duration: 20, mode: 'list', list: [track]},
        state: 'playing', wantPlay: true, ready: true, positionAt: Date.now() - 400
      };
      window.MingmingNativePlayer = {
        read() { return JSON.stringify(window.clockPlayback); },
        command(action) {
          if (action === 'pause') { window.clockPlayback.state = 'paused'; window.clockPlayback.wantPlay = false; window.clockPlayback.positionAt = Date.now(); }
          if (action === 'play') { window.clockPlayback.state = 'playing'; window.clockPlayback.wantPlay = true; window.clockPlayback.positionAt = Date.now(); }
        }
      };
    }, {track});
    await context.route('**/api/library', route => route.fulfill({json: {favorites: [], playlists: [], recent: []}}));
    await context.route('**/api/music/lrc', route => route.fulfill({json: {data: ''}}));
    await context.route('**/api/word-lyric?*', route => route.fulfill({json: {data: {lyric}}}));
    await context.route('**/api/netease/comments?*', route => route.fulfill({json: {comments: [], total: 0, more: false}}));
    await context.route('https://example.invalid/clock-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"/>'}));
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(() => document.getElementById('player-title').textContent === '连续时钟测试');
    await page.locator('#now-playing').click();
    await page.waitForSelector('#overlay-lyrics .has-word-timing.active');
    // Navigation/loading can take longer than a second on a busy runner.
    // Start the measured native sample after the lyric view is ready.
    const sample = await page.evaluate(() => {
      window.clockPlayback.snapshot.position = 0;
      window.clockPlayback.positionAt = Date.now() - 400;
      window.MingmingTVForeground();
      return {elapsed: document.getElementById('overlay-elapsed').textContent,
        style: document.querySelector('.lyric-word').getAttribute('style')};
    });
    const elapsed = sample.elapsed;
    assert.equal(elapsed, '00:00', 'positionAt keeps the short native sample in the first second: ' + elapsed);
    const before = sample.style;
    await page.waitForTimeout(250);
    const after = await page.locator('.lyric-word').first().getAttribute('style');
    assert.notEqual(after, before, 'active word continues to advance between native polls');
    await page.evaluate(() => { window.clockPlayback.state = 'paused'; window.clockPlayback.wantPlay = false; window.clockPlayback.positionAt = Date.now(); });
    await page.waitForTimeout(650);
    const frozen = await page.locator('.lyric-word').first().getAttribute('style');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.lyric-word').first().getAttribute('style'), frozen, 'paused lyric progress freezes');
  } finally {
    await context.close();
  }
  console.log('Lyric clock: native positionAt extrapolation, active-word updates and pause freeze passed');
};
