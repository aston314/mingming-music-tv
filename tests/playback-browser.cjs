const assert = require('assert/strict');
const path = require('path');

function silentWave(seconds) {
  const rate = 8000, size = seconds * rate * 2, buffer = Buffer.alloc(44 + size);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(size, 40);
  return buffer;
}

module.exports = async function testPlayback({browser, url, restart, screenshotsDir}) {
  const wave = silentWave(120);
  const tracks = [
    {id: 'resume-first', name: '恢复测试歌曲', artist: '恢复测试歌手', al: {name: '恢复测试专辑'}, dt: 120000, type: 'wy', picUrl: 'https://example.invalid/cover.svg'},
    {id: 'resume-next', name: '下一首测试歌曲', artist: '测试歌手', album: {name: '下一首测试专辑'}, dt: 120000, type: 'wy', picUrl: 'https://example.invalid/cover.svg'}
  ];
  const snapshot = {schema: 1, track: tracks[0], position: 47.25, duration: 120, mode: 'shuffle', list: tracks, listSource: 'recommend'};
  const contexts = [];
  let sourceRequests = 0, delayedSource = null;
  async function freshContext() {
    const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
    contexts.push(context);
    await context.addInitScript(() => {
      window.audioPlayCalls = 0;
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { window.audioPlayCalls++; return play.apply(this, arguments); };
    });
    await context.route('**/api/music/url', async route => {
      sourceRequests++;
      if (delayedSource) await delayedSource;
      await route.fulfill({json: {data: 'https://example.invalid/audio.wav'}});
    });
    await context.route('**/media?url=**', route => {
      const range = route.request().headers().range;
      const match = range && range.match(/bytes=(\d+)-(\d*)/);
      const start = match ? Number(match[1]) : 0, end = match && match[2] ? Math.min(wave.length - 1, Number(match[2])) : wave.length - 1;
      return route.fulfill({status: match ? 206 : 200, contentType: 'audio/wav', headers: {'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), ...(match ? {'Content-Range': `bytes ${start}-${end}/${wave.length}`} : {})}, body: wave.subarray(start, end + 1)});
    });
    await context.route('**/api/music/lrc', route => route.fulfill({json: {data: '[00:00.00]第一行\n[00:40.00]恢复位置对应歌词\n[01:10.00]下一行'}}));
    await context.route('**/api/word-lyric?*', route => route.fulfill({json: {code: 1, data: {lyric: '[0,1000](0,1000,0)第一行\n[40000,1000](40000,1000,0)恢复位置对应歌词\n[70000,1000](70000,1000,0)下一行'}}}));
    await context.route(/https:\/\/(example\.invalid|picsum\.photos)\//, route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#c7f38d"/></svg>'}));
    return context;
  }
  async function stored(context, address) {
    return (await (await context.request.get(address + '/api/playback')).json()).snapshot;
  }
  async function checkPausedRestore(page, expected) {
    await page.waitForFunction(name => document.getElementById('player-title').textContent === name, expected.track.name);
    await page.waitForSelector('#side-lyrics .lyric-line.active');
    const actual = await page.evaluate(() => ({paused: document.getElementById('audio').paused, src: document.getElementById('audio').getAttribute('src'), calls: window.audioPlayCalls, elapsed: document.getElementById('player-elapsed').textContent, duration: document.getElementById('player-duration').textContent, mode: document.getElementById('play-mode').textContent, focus: document.activeElement.id}));
    assert.equal(actual.paused, true); assert.equal(actual.src, null); assert.equal(actual.calls, 0);
    assert.equal(actual.duration, '02:00'); assert.equal(actual.mode, '随机播放'); assert.equal(actual.focus, 'nav-recommend');
    assert.match(actual.elapsed, /^00:4[7-9]$/);
  }
  try {
    let context = await freshContext();
    assert.equal((await context.request.put(url + '/api/library', {data: {favorites: [], playlists: [tracks[1]], recent: tracks}})).status(), 200);
    assert.equal((await context.request.put(url + '/api/playback', {data: {clientId: 'browser-seed', sequence: 1, snapshot}})).status(), 200);
    let page = await context.newPage();
    await page.goto(url);
    await checkPausedRestore(page, snapshot);
    assert.equal(sourceRequests, 0, 'startup must not resolve or fetch audio');
    assert.equal(await page.locator('#side-lyrics .active').textContent(), '恢复位置对应歌词');
    // The footer and fullscreen open the same active-source popup. Custom
    // library membership is separate from the two-song playback source.
    await page.locator('[data-page="favorites"]').click();
    await page.locator('#queue-open').click();
    assert.equal(await page.locator('#player-overlay').isVisible(), false);
    assert.equal(await page.locator('.queue-popup .track-row').count(), 2);
    assert.equal(await page.locator('#queue-open').getAttribute('aria-label'), '播放列表 2');
    assert.equal(await page.locator('.nav-item.is-active').getAttribute('data-page'), 'favorites');
    const firstQueueRow = page.locator('.queue-popup [data-track-id="resume-first"]');
    assert.equal(await firstQueueRow.locator('.track-info span').textContent(), '恢复测试歌手');
    assert.equal(await page.locator('.queue-popup [data-track-id="resume-next"] .track-info span').textContent(), '测试歌手');
    assert.deepEqual(await firstQueueRow.locator('[data-action]').evaluateAll(nodes => nodes.map(n => n.dataset.action)), ['artist-info', 'queue', 'favorite']);
    await firstQueueRow.focus();
    await page.evaluate(() => window.MingmingTVKey(22));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'artist-info');
    await page.evaluate(() => window.MingmingTVKey(22));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'queue');
    for (const selected of ['true', 'false']) {
      await firstQueueRow.locator('[data-action="queue"]').focus();
      await firstQueueRow.locator('[data-action="queue"]').click();
      assert.equal(await firstQueueRow.locator('[data-action="queue"]').getAttribute('aria-pressed'), selected);
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'queue');
      assert.equal(await page.evaluate(() => window.audioPlayCalls), 0, 'queue toggle must not play');
    }
    await page.evaluate(() => window.MingmingTVBack());
    assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-open');
    await page.locator('[data-page="queue"]').click();
    await page.locator('[data-library-tab="recent"]').click();
    const currentRow = page.locator('.track-list [data-track-id="resume-first"]');
    await page.waitForSelector('.track-list .is-current .track-playing svg');
    assert.equal(await currentRow.locator('.equalizer-bar').first().evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
    await page.locator('#now-playing').click();
    assert.equal(await page.locator('#overlay-elapsed').textContent(), '00:47');
    assert.equal(await page.locator('#overlay-lyrics .active').textContent(), '恢复位置对应歌词');
    assert.ok(await page.locator('#overlay-lyrics .lyric-line').count() > 2, 'fullscreen lyrics keep the complete list visible');
    for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}]) {
      await page.setViewportSize(size);
      for (const container of ['#side-lyrics', '#overlay-lyrics']) {
        const typography = await page.locator(container).evaluate(node => {
          const active = getComputedStyle(node.querySelector('.active'));
          const normal = getComputedStyle(node.querySelector('.lyric-line:not(.active)'));
          return {active: parseFloat(active.fontSize), normal: parseFloat(normal.fontSize), whiteSpace: active.whiteSpace};
        });
        assert.equal(typography.active - typography.normal, 3, 'current lyric is one controlled size larger');
        assert.equal(typography.whiteSpace, 'nowrap', 'current lyric stays on a single line');
      }
      assert.equal(await page.locator('.overlay-song-meta').count(), 0, 'metadata does not add a row');
      assert.equal(await page.locator('#overlay-track-meta').textContent(), '恢复测试歌手 · 恢复测试专辑');
      await page.locator('#overlay-queue').click();
      assert.equal(await page.locator('.queue-popup .track-row').count(), 2);
      await page.locator('.queue-popup .track-row').first().focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'artist-info');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(() => document.activeElement.classList.contains('track-row')), true);
      if (screenshotsDir) {
        const shot = path.join(screenshotsDir, `player-popup-${size.width}.png`);
        await page.screenshot({path: shot}); console.log('Player screenshot: ' + shot);
      }
      await page.evaluate(() => window.MingmingTVBack());
      assert.equal(await page.evaluate(() => document.activeElement.id), 'overlay-queue');
    }
    await page.setViewportSize({width: 1920, height: 1080});
    await page.locator('#player-close').click();

    // A second click can cancel playback while source resolution is pending.
    let releaseSource;
    delayedSource = new Promise(resolve => {releaseSource = resolve;});
    await page.locator('#play').click();
    await page.waitForFunction(() => document.getElementById('play').getAttribute('aria-label') === '播放');
    await page.locator('#play').click();
    releaseSource(); delayedSource = null;
    try { await page.waitForFunction(() => { const audio = document.getElementById('audio'); return audio.readyState >= 1 && !audio.seeking && Math.abs(audio.currentTime - 47.25) < .1; }, null, {timeout: 5000}); }
    catch (error) { console.log(await page.evaluate(() => { const a = document.getElementById('audio'); return {time: a.currentTime, duration: a.duration, ready: a.readyState, seeking: a.seeking, seekable: Array.from({length: a.seekable.length}, (_, i) => [a.seekable.start(i), a.seekable.end(i)]), buffered: Array.from({length: a.buffered.length}, (_, i) => [a.buffered.start(i), a.buffered.end(i)]), paused: a.paused, calls: window.audioPlayCalls, elapsed: document.getElementById('player-elapsed').textContent, src: a.src}; })); throw error; }
    assert.equal(await page.evaluate(() => window.audioPlayCalls), 0, 'cancel during prepare must stay paused');
    assert.ok(Math.abs(await page.evaluate(() => document.getElementById('audio').currentTime) - 47.25) < .1);
    await page.locator('#play').click();
    await page.waitForFunction(() => !document.getElementById('audio').paused && document.getElementById('audio').currentTime > 47.3);
    const bar = currentRow.locator('.equalizer-bar').first();
    assert.equal(await bar.evaluate(el => getComputedStyle(el).animationPlayState), 'running');
    const moving = await bar.evaluate(el => getComputedStyle(el).transform);
    await page.waitForTimeout(170);
    assert.notEqual(await bar.evaluate(el => getComputedStyle(el).transform), moving, 'playing bars must move');
    await page.locator('#play').click();
    assert.equal(await bar.evaluate(el => getComputedStyle(el).animationPlayState), 'paused');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const frozen = await bar.evaluate(el => getComputedStyle(el).transform);
    await page.waitForTimeout(170);
    assert.equal(await bar.evaluate(el => getComputedStyle(el).transform), frozen, 'paused bars must stop');
    await page.evaluate(() => window.MingmingTVBackground());
    const beforeRestart = await stored(context, url);
    assert.ok(beforeRestart.position > 47.25 && beforeRestart.position < 50);
    assert.equal(beforeRestart.track.id, tracks[0].id);
    await context.close();

    // A new Go process/loopback port and a fresh browser storage partition.
    const oldURL = url;
    url = await restart();
    assert.notEqual(url, oldURL);
    context = await freshContext(); page = await context.newPage();
    const requestsAtRestart = sourceRequests;
    await page.goto(url);
    await checkPausedRestore(page, beforeRestart);
    assert.equal(sourceRequests, requestsAtRestart);
    await page.locator('#seek').focus();
    await page.evaluate(() => window.MingmingTVKey(22));
    await page.evaluate(() => window.MingmingTVBackground());
    assert.ok(Math.abs((await stored(context, url)).position - (beforeRestart.position + 5)) < .1, 'D-pad seek on paused restore');
    await page.locator('#play').click();
    await page.waitForFunction(position => document.getElementById('audio').currentTime >= position && !document.getElementById('audio').paused, beforeRestart.position + 5);
    await page.locator('#next').click();
    await page.waitForFunction(() => document.getElementById('player-title').textContent === '下一首测试歌曲' && !document.getElementById('audio').paused);
    assert.ok(await page.evaluate(() => document.getElementById('audio').currentTime) < 5, 'next track resets previous seek');
    await page.locator('#play').click();
    await page.evaluate(() => window.MingmingTVBackground());
    await context.close();

    // A late restore response must not replace a song chosen by the user.
    context = await freshContext();
    let releaseRestore;
    const gate = new Promise(resolve => {releaseRestore = resolve;});
    await context.route('**/api/playback', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await gate; await route.fulfill({json: {snapshot}});
    });
    page = await context.newPage();
    await page.goto(url); await page.waitForSelector('.playlist-card');
    await page.locator('.playlist-card').first().click(); await page.locator('.track-row').first().click();
    const selectedName = await page.locator('#player-title').textContent();
    releaseRestore();
    await page.waitForResponse(response => response.url().endsWith('/api/playback') && response.request().method() === 'GET');
    assert.equal(await page.locator('#player-title').textContent(), selectedName, 'late restore cannot replace explicit selection');
    console.log('Playback: paused restore, delayed-source cancellation, real media seek, fresh-port restart, list continuation, stale response passed');
  } finally {
    for (const context of contexts) await context.close();
  }
};
