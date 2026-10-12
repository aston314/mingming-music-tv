const assert = require('assert/strict');
const path = require('path');

// Deterministic native bridge signals exercise the TV presentation without
// playing upstream audio or altering real accounts.
module.exports = async function testCommentsVisibility({browser, url, screenshotsDir}) {
  for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}]) {
    const context = await browser.newContext({viewport: size});
    const song = {id: 'comments-visibility', name: '评论与歌词布局', artist: '测试歌手', dt: 180000, picUrl: 'https://example.invalid/cover.svg'};
    const snapshot = {schema: 1, track: song, position: 45, duration: 180, mode: 'list', list: [song], listSource: 'recommend'};
    await context.addInitScript(saved => {
      window.mockPlayback = {snapshot: saved, state: 'playing', wantPlay: true, ready: true};
      window.MingmingNativePlayer = {
        read() { return JSON.stringify(window.mockPlayback); },
        command(action, body) {
          const data = window.mockPlayback;
          if (action === 'configure') data.snapshot = JSON.parse(body);
          if (action === 'pause' || action === 'play') { data.wantPlay = action === 'play'; data.state = data.wantPlay ? 'playing' : 'paused'; }
        }
      };
    }, snapshot);
    await context.route('**/api/library', route => route.fulfill({json: {favorites: [], playlists: [], recent: [song]}}));
    await context.route('**/api/music/lrc', route => route.fulfill({json: {data: Array.from({length: 30}, (_, i) => `[00:${String(i * 2).padStart(2, '0')}.00]这是第 ${i + 1} 行同步歌词`).join('\n')}}));
    await context.route(/https:\/\/(example\.invalid|picsum\.photos)\//, route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#71965f"/></svg>'}));
    const requests = [];
    let pending = null, releasePending;
    await context.route('**/api/netease/comments?*', async route => {
      const params = new URL(route.request().url()).searchParams;
      const offset = Number(params.get('offset'));
      requests.push({song: params.get('songId'), offset});
      if (offset === 10 && pending) await pending;
      await route.fulfill({json: {comments: Array.from({length: 10}, (_, i) => ({user: {nickname: '评论用户 ' + (offset + i), avatarUrl: song.picUrl}, content: '评论区隐藏后保留这条评论与阅读位置。'.repeat(4)})), total: 30, more: offset < 20}});
    });
    const page = await context.newPage();
    const button = page.locator('#player-comments-toggle'), comments = page.locator('#overlay-comments');
    const focus = () => page.evaluate(() => document.activeElement.id);
    const rects = () => page.evaluate(() => {
      const lyric = document.getElementById('overlay-lyrics').getBoundingClientRect();
      const toggle = document.getElementById('player-comments-toggle').getBoundingClientRect();
      const active = document.querySelector('#overlay-lyrics .active').getBoundingClientRect();
      const lyricTitle = document.querySelector('.lyric-badge').getBoundingClientRect();
      const commentTitle = document.querySelector('.comment-badge').getBoundingClientRect();
      return {width: lyric.width, height: lyric.height, toggle: [toggle.x, toggle.y, toggle.width, toggle.height], activeVisible: active.top >= lyric.top - 1 && active.bottom <= lyric.bottom + 1, lyricTitleCenter: lyricTitle.top + lyricTitle.height / 2, commentTitleCenter: commentTitle.top + commentTitle.height / 2, commentTitleRight: commentTitle.right};
    });
    async function capture(state) {
      if (!screenshotsDir) return;
      const file = path.join(screenshotsDir, `comments-${state}-${size.width}.png`);
      await page.screenshot({path: file}); console.log('Comments visibility screenshot: ' + file);
    }
    try {
      await page.goto(url); await page.waitForSelector('#side-lyrics .active');
      await page.locator('#now-playing').click();
      await page.waitForSelector('#overlay-comments .comment');
      await page.waitForFunction(() => document.getElementById('overlay-comments').scrollTop > 2);
      // Pause before comparing exact scroll positions.
      await page.locator('#overlay-play').click();
      await page.waitForFunction(() => window.mockPlayback.state === 'paused');
      await comments.evaluate(el => {el.scrollTop = 140;});
      const position = await comments.evaluate(el => el.scrollTop);
      const shown = await rects(), shownIcon = await button.innerHTML();
      const toggleCenter = shown.toggle[1] + shown.toggle[3] / 2;
      assert.ok(Math.abs(toggleCenter - shown.lyricTitleCenter) < 1, 'toggle aligns with the lyric heading');
      if (size.width > 1050) {
        assert.ok(Math.abs(toggleCenter - shown.commentTitleCenter) < 1, 'toggle aligns with the comment heading');
        assert.ok(shown.toggle[0] - shown.commentTitleRight >= 16, 'comment title has space before the toggle');
      }
      await capture('shown');
      await button.click();
      assert.equal(await focus(), 'player-comments-toggle');
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      assert.equal(await button.getAttribute('aria-label'), '显示评论');
      assert.equal(await button.locator('.comments-toggle-label').innerText(), '评论');
      assert.match(await button.locator('.comments-toggle-count').innerText(), /^\d+$/);
      assert.equal(await button.locator('svg').count(), 1);
      assert.notEqual(await button.innerHTML(), shownIcon);
      assert.equal(await page.locator('#player-comment-section').isVisible(), false);
      const hidden = await rects();
      assert.equal(hidden.toggle[0] + hidden.toggle[2], shown.toggle[0] + shown.toggle[2], 'toggle keeps its fixed right edge');
      assert.ok(hidden.toggle[2] > shown.toggle[2], 'hidden comments use the wider comment pill');
      assert.ok(Math.abs(hidden.toggle[1] + hidden.toggle[3] / 2 - hidden.lyricTitleCenter) < 1, 'hidden comments retain heading alignment');
      assert.ok(size.width > 1050 ? hidden.width > shown.width + 100 : hidden.height > shown.height + 100, 'lyrics fill the vacated comment space');
      assert.equal(hidden.activeVisible, true, 'resizing keeps the active lyric visible');
      const count = requests.length;
      await comments.evaluate(el => {el.scrollTop = 99999; el.dispatchEvent(new Event('scroll'));});
      await page.waitForTimeout(600);
      assert.equal(requests.length, count, 'hidden comments do not paginate');
      await page.locator('#overlay-queue').focus(); await page.keyboard.press('ArrowRight');
      assert.equal(await focus(), 'player-comments-toggle');
      await page.keyboard.press('Enter');
      assert.equal(await focus(), 'player-comments-toggle');
      assert.equal(await button.getAttribute('aria-label'), '隐藏评论');
      assert.equal(await comments.evaluate(el => el.scrollTop), position, 'show restores the exact paused scroll position');
      assert.deepEqual(await rects(), shown, 'show restores the lyric layout');
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.evaluate(() => document.getElementById('overlay-comments').contains(document.activeElement)), true);

      // A pending page may finish while hidden, but cannot start another page
      // or pull focus away from the toggle.
      pending = new Promise(resolve => {releasePending = resolve;});
      const nextPage = page.waitForRequest(request => request.url().includes('/api/netease/comments?') && new URL(request.url()).searchParams.get('offset') === '10');
      await comments.evaluate(el => {el.scrollTop = el.scrollHeight;});
      await nextPage;
      await button.click();
      const pendingCount = requests.length;
      releasePending(); pending = null;
      await page.waitForFunction(() => document.querySelectorAll('#overlay-comments .comment').length === 20);
      assert.equal(await focus(), 'player-comments-toggle');
      assert.equal(await page.locator('#player-comment-section').isVisible(), false);
      assert.equal(requests.length, pendingCount);
      await capture('hidden');
      await button.click();
      await page.locator('#overlay-play').click();
      await page.waitForFunction(() => window.mockPlayback.state === 'playing');
      const start = await comments.evaluate(el => el.scrollTop);
      await page.waitForFunction(before => document.getElementById('overlay-comments').scrollTop > before + 2, start);
      await button.click();
      const stopped = await comments.evaluate(el => el.scrollTop), stoppedCount = requests.length;
      await page.waitForTimeout(600);
      assert.equal(await comments.evaluate(el => el.scrollTop), stopped, 'hidden comments remain stopped during playback');
      assert.equal(requests.length, stoppedCount);

      // Hiding survives player close/reopen and a song change; the next song
      // resets comment position and fetches its first page on expansion.
      await page.keyboard.press('Escape'); await page.locator('#now-playing').click();
      assert.equal(await button.getAttribute('aria-expanded'), 'false');
      await page.evaluate(() => {window.mockPlayback.snapshot.track = {...window.mockPlayback.snapshot.track, id: 'comments-next', name: '下一首布局测试'};});
      await page.waitForFunction(() => document.getElementById('overlay-title').textContent === '下一首布局测试');
      assert.equal(requests.some(request => request.song === 'comments-next'), false);
      await button.click();
      await page.waitForSelector('#overlay-comments .comment');
      assert.equal(requests.some(request => request.song === 'comments-next' && request.offset === 0), true);
      assert.ok(await comments.evaluate(el => el.scrollTop) < 50, 'next song starts comments at the beginning');
      assert.equal(await page.locator('#overlay-lyrics').getAttribute('tabindex'), '-1');
      assert.equal(await page.locator('#overlay-lyrics').evaluate(el => el.classList.contains('focusable')), false);
      await page.locator('#overlay-play').click();
      await page.keyboard.press('Escape');
      assert.equal(await focus(), 'now-playing');
    } finally {
      if (releasePending) releasePending();
      await context.close();
    }
  }
  console.log('Comments visibility: SVG state, both layouts, D-pad access, scroll restore, hidden pagination, in-flight response and playback motion passed');
};
