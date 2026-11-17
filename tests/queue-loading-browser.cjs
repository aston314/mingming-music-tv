const assert = require('assert/strict');
const path = require('path');

module.exports = async function testQueueLoading({browser, url, screenshotsDir}) {
  const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const gates = [];
  function gate() {
    let release;
    const promise = new Promise(resolve => {release = resolve;});
    gates.push(release);
    return {promise, release};
  }
  const songs = [
    {id: 'loading-first', name: '紧凑列表测试', artist: '测试歌手', album: '不应显示的专辑', dt: 180000},
    {id: 'loading-second', name: '下一首歌曲', artist: '另一位歌手', album: '不应显示的专辑', dt: 180000}
  ];
  const snapshot = {schema: 1, track: songs[0], position: 45, duration: 180, mode: 'list', list: songs, listSource: 'recommend'};
  const library = {favorites: [], playlists: [], recent: [], authenticated: false, synced: false};
  let playbackGate = gate(), libraryGate = gate(), coverGate = gate(), coverFailure = false, empty = false, dataFailure = false;
  let coverRequests = 0;
  await context.route('**/api/playback', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await playbackGate.promise;
    await route.fulfill({status: dataFailure ? 503 : 200, json: {snapshot: empty ? null : snapshot}});
  });
  await context.route('**/api/library', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    await libraryGate.promise;
    await route.fulfill({status: dataFailure ? 503 : 200, json: library});
  });
  await context.route('**/api/music/pic', async route => {
    const pending = coverGate, fail = coverFailure;
    coverRequests++;
    await pending.promise;
    if (fail) return route.abort('failed');
    await route.fulfill({json: {data: 'https://example.invalid/queue-cover.svg'}});
  });
  await context.route('**/api/music/lrc', route => route.fulfill({json: {data: Array.from({length: 40}, (_, i) => `[${String(i).padStart(2, '0')}:00.00]歌词 ${i + 1}`).join('\n')}}));
  await context.route(/https:\/\/(example\.invalid|picsum\.photos)\//, route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#78945c"/></svg>'}));
  const page = await context.newPage();
  async function idle() {
    await page.waitForFunction(() => document.getElementById('queue-popup').getAttribute('aria-busy') === 'false');
    assert.equal(await page.locator('#queue-loading').isVisible(), false);
  }
  async function shot(name) {
    if (screenshotsDir) {
      const file = path.join(screenshotsDir, name + '.png');
      await page.screenshot({path: file});
      console.log('Queue loading screenshot: ' + file);
    }
  }
  try {
    await page.goto(url);
    await page.locator('#queue-open').click();
    await page.waitForSelector('.queue-list-loading');
    assert.equal(await page.locator('#queue-popup').getAttribute('aria-busy'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-popup-close');
    await shot('queue-data-loading-1920');
    playbackGate.release();
    await page.waitForSelector('.queue-popup .track-row');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-popup-close', 'restore must preserve popup close focus');
    const action = page.locator('.queue-popup .track-row').first().locator('[data-action="favorite"]');
    await page.locator('.queue-popup .track-row').first().focus();
    await action.focus();
    libraryGate.release();
    await page.waitForFunction(() => document.activeElement.dataset.action === 'favorite');
    assert.equal(await action.getAttribute('aria-pressed'), 'false');
    await page.waitForFunction(() => document.getElementById('queue-loading').hidden === false);
    await shot('queue-cover-loading-1920');
    assert.equal(await page.locator('.queue-popup .track-info span').first().textContent(), '测试歌手');
    assert.equal(await page.locator('#queue-loading .loading-ring').evaluate(el => getComputedStyle(el).animationName), 'loading-turn');
    coverGate.release();
    await idle();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'favorite', 'cover completion must preserve action focus');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-open');
    await page.locator('.nav-item[data-page="search"]').click();
    await page.waitForSelector('#side-lyrics .active');
    assert.deepEqual(await page.locator('#side-lyrics').evaluate(el => ({tab: el.tabIndex, focusable: el.classList.contains('focusable')})), {tab: -1, focusable: false});
    await page.locator('#side-lyrics').evaluate(el => {el.focus();});
    assert.equal(await page.locator('#side-lyrics').evaluate(el => getComputedStyle(el).boxShadow), 'none');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.getElementById('content').contains(document.activeElement) && document.activeElement.classList.contains('focusable')), true);

    // A fresh restored list has unresolved covers; both controls share the
    // loading state, and a closed popup must ignore its old responses.
    for (const size of [{width: 960, height: 540}, {width: 1920, height: 1080}]) {
      await page.setViewportSize(size);
      coverGate = gate();
      await page.reload();
      await page.waitForSelector('#overlay-lyrics .active', {state: 'attached'});
      await page.locator('#now-playing').click();
      assert.equal(await page.locator('.overlay-song-meta').count(), 0);
      await page.locator('#overlay-queue').click();
      await page.waitForSelector('#queue-loading');
      await shot('queue-fullscreen-loading-' + size.width);
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'overlay-queue');
      const lateGate = coverGate;
      coverGate = gate();
      await page.locator('#overlay-queue').click();
      lateGate.release();
      await page.waitForFunction(() => document.getElementById('queue-popup').getAttribute('aria-busy') === 'true');
      assert.equal(await page.locator('#queue-loading').isVisible(), true, 'old cover completion cannot hide a new loading state');
      coverGate.release();
      await idle();
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'overlay-queue');
      await page.keyboard.press('Escape');
    }

    coverFailure = true; coverGate = gate();
    await page.reload(); await page.waitForSelector('#overlay-lyrics .active', {state: 'attached'});
    await page.locator('#queue-open').click(); await page.waitForSelector('#queue-loading');
    coverGate.release(); await idle();
    assert.equal(await page.locator('.queue-popup .track-row').count(), 2, 'cover failure must keep usable rows');
    await page.keyboard.press('Escape');

    for (const fail of [false, true]) {
      empty = true; dataFailure = fail; playbackGate = gate(); libraryGate = gate();
      await page.reload(); await page.locator('#queue-open').click();
      await page.waitForSelector('.queue-list-loading');
      playbackGate.release(); libraryGate.release();
      await idle();
      assert.equal(await page.locator('.queue-popup-list').textContent(), '播放列表为空');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'queue-popup-close');
      await page.keyboard.press('Escape');
    }
    assert.ok(coverRequests > 0);
    console.log('Queue: pending data/covers, both player controls, stale responses, failure cleanup, compact metadata and noninteractive lyrics passed');
  } finally {
    gates.forEach(release => release());
    await context.close();
  }
};
