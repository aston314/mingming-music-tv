const assert = require('assert/strict');
const path = require('path');

module.exports = async function detailsBrowser({browser, url, screenshotsDir}) {
  for (const android of [false, true]) await detailsFlow({browser, url, screenshotsDir, android});
};

async function detailsFlow({browser, url, screenshotsDir, android}) {
  const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
  if (android) await context.addInitScript(() => { window.MingmingTVApp = {exit: function () {}}; });
  const page = await context.newPage();
  async function checkBack(entry) {
    assert.equal(await page.locator('#detail-back').count(), android ? 0 : 1, 'page back button is browser-only');
    assert.equal(await page.evaluate(() => document.activeElement.id), android ? entry : 'detail-back', 'detail has a valid entry focus');
  }
  async function playButtonLayout(id) {
    return page.locator(id).evaluate(button => {
      const heading = button.parentNode, a = button.getBoundingClientRect(), b = heading.getBoundingClientRect(), style = getComputedStyle(button);
      return {rightGap: b.right - a.right, centerOffset: a.top + a.height / 2 - (b.top + b.height / 2), height: a.height, fontSize: style.fontSize, background: style.backgroundColor, radius: style.borderRadius};
    });
  }
  try {
    await context.route('https://picsum.photos/**', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="360" height="360"><rect width="360" height="360" fill="#668351"/></svg>'}));
    await context.route('**/api/music/search', route => route.fulfill({json: {code: 1, data: [{id: 'short-song', name: '预览歌曲', artist: '预览歌手', album: '夜色专辑'}]}}));
    await context.route('**/api/netease/search?*', route => route.fulfill({json: {code: 200, result: {songs: [{id: 'resolved-song', name: '预览歌曲', artists: [{id: 8926, name: '预览歌手'}], album: {id: 'album-1', name: '夜色专辑'}}]}}}));
    const albumRequests = [];
    await context.route('**/api/netease/artist/albums?*', async route => {
      const requestUrl = new URL(route.request().url());
      const offset = Number(requestUrl.searchParams.get('offset') || 0);
      albumRequests.push(offset);
      const count = offset === 0 ? 30 : 2;
      const albums = Array.from({length: count}, (_, index) => {
        const number = offset + index + 1;
        return {id: `album-${number}`, name: `预览专辑 ${number}`, size: 2, publishTime: 1735689600000 - number * 86400000, picUrl: `https://picsum.photos/seed/artist-album-${number}/360/360`};
      });
      await route.fulfill({json: {code: 200, hotAlbums: albums, more: offset === 0}});
    });
    await page.goto(url + '/');
    await page.waitForFunction(() => document.getElementById('connection-label').textContent === '预览数据');
    await page.locator('[data-page="search"]').click();
    await page.locator('#search-input').fill('预览歌曲');
    await page.locator('#search-form').evaluate(form => form.dispatchEvent(new Event('submit', {cancelable: true})));
    await page.waitForSelector('#search-results .track-row');

    const row = page.locator('#search-results .track-row').first();
    await row.focus();
    await page.evaluate(() => window.MingmingTVKey(22));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'artist-info');
    await page.evaluate(() => window.MingmingTVKey(22));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'queue');
    await page.evaluate(() => window.MingmingTVKey(21));
    await page.evaluate(() => window.MingmingTVKey(23));
    if (await page.locator('#modal-root').getAttribute('hidden') !== null) throw new Error('share menu did not open');
    if (await page.locator('[data-share-action="copy"]').count()) throw new Error('copy link action should be removed');
    if (await page.evaluate(() => document.activeElement.getAttribute('data-share-action')) !== 'artist') throw new Error('share menu focus did not start on artist');
    await page.evaluate(() => window.MingmingTVBack());
    if (await page.evaluate(() => document.activeElement.getAttribute('data-action')) !== 'artist-info') throw new Error('share menu back did not restore artist info focus');

    await row.focus();
    await row.locator('[data-action="artist-info"]').click();
    await page.locator('[data-share-action="album"]').click();
    await page.waitForSelector('.album-hero');
    await checkBack('album-play');
    assert.equal(await page.locator('#album-play svg').count(), 1, 'resolved album has a play icon');
    await page.evaluate(() => window.MingmingTVBack());
    assert.equal(await page.locator('#modal-root').getAttribute('hidden'), null, 'album back restores the artist menu');
    await page.evaluate(() => window.MingmingTVBack());
    assert.equal(await page.locator('#search-results').count(), 1, 'closing restored menu returns to source');

    await row.focus();
    await row.locator('[data-action="artist-info"]').click();
    await page.locator('[data-share-action="artist"]').click();
    await page.waitForSelector('.artist-hero');
    await checkBack('artist-hot-tab');
    if (!(await page.locator('#artist-hot-tab').count())) throw new Error('artist tabs missing');
    const hotButton = page.locator('#artist-detail-body #artist-play-hot');
    if (!(await hotButton.count()) || !(await hotButton.locator('svg').count())) throw new Error('play hot button is not in the list header');
    const hotLayouts = new Map();
    for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}]) {
      await page.setViewportSize(size);
      hotLayouts.set(size.width, await playButtonLayout('#artist-play-hot'));
    }
    await page.locator('#artist-albums-tab').click();
    await page.waitForFunction(() => document.querySelectorAll('.album-card').length === 30);
    if (await page.locator('#artist-albums-more').count()) throw new Error('manual album pagination button should be removed');
    await page.locator('#content').evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelectorAll('.album-card').length === 32);
    if (albumRequests.join(',') !== '0,30') throw new Error('album lazy loading did not request offset 30');
    await page.locator('.album-card').first().click();
    await page.waitForSelector('.album-hero');
    await checkBack('album-play');
    if (!(await page.locator('#album-detail-body .track-row').count())) throw new Error('album songs missing');
    assert.equal(await page.locator('#album-play svg').count(), 1, 'album playback has a play icon');
    for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}]) {
      await page.setViewportSize(size);
      const albumLayout = await playButtonLayout('#album-play');
      assert.deepEqual(albumLayout, hotLayouts.get(size.width), 'hot and album play buttons share placement and style');
      assert.ok(Math.abs(albumLayout.centerOffset) < 1 && albumLayout.rightGap <= 6, 'play button is centered at header right');
      await page.locator('#album-play').focus();
      await page.evaluate(() => window.MingmingTVKey(20));
      assert.equal(await page.evaluate(() => document.activeElement.matches('#album-detail-body .track-row')), true, 'play button down enters songs');
      if (screenshotsDir) await page.screenshot({path: path.join(screenshotsDir, `album-controls-${android ? 'android' : 'browser'}-${size.width}.png`)});
    }
    if (android) await page.evaluate(() => window.MingmingTVBack());
    else await page.locator('#detail-back').click();
    if (!(await page.locator('.artist-hero').count())) throw new Error('album back did not restore artist detail');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('data-album-id')), 'album-1', 'album back restores the originating album focus');
    assert.equal(await page.locator('.album-card').count(), 32, 'back preserves lazy-loaded albums');
    await page.evaluate(() => window.MingmingTVBack());
    if (await page.locator('#modal-root').getAttribute('hidden') !== null) throw new Error('artist back did not restore source menu');
    await page.evaluate(() => window.MingmingTVBack());
    if (!(await page.locator('#search-results').count())) throw new Error('closing restored menu did not return to source page');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'artist-info', 'detail back restores source artist entry');
    console.log(`Artist and album detail controls, lazy loading and Back passed (${android ? 'Android bridge simulation' : 'browser'})`);
  } finally {
    await context.close();
  }
}
