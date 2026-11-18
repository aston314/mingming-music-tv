const assert = require('assert/strict');
const path = require('path');

module.exports = async function fourLineLyrics({browser, url, screenshotsDir}) {
  const texts = ['第一句歌词', '风吹过远方', '记忆慢慢浮现', '只盼望有一双温柔手', '能抚慰我内心的寂寞', '这是用来验证长句完整显示的歌词'.repeat(4), '在音乐里等你', '世界如此安静', '下一段旋律响起', '星光照亮夜空', '最后的回声', '最后一句歌词'];
  const lyric = texts.map((text, index) => `[${index * 10000},10000]` + [...text].map((char, word) => `(${index * 10000 + Math.floor(word * 10000 / text.length)},${Math.floor(10000 / text.length)},0)${char}`).join('')).join('\n');
  for (const size of [{width: 1920, height: 1080}, {width: 960, height: 540}]) {
    const context = await browser.newContext({viewport: size, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 6.0; Android TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/44.0.2403.133 Safari/537.36'});
    const song = {id: 'four-line-test', name: '四行歌词测试', artist: '测试歌手', al: {name: '测试专辑'}, dt: 120000, picUrl: 'https://p3.music.126.net/test-cover.jpg?param=800y800&keep=1#cover'};
    await context.addInitScript(track => {
      window.mockPlayback = {snapshot: {schema: 1, track, position: 34.5, duration: 120, mode: 'list', list: [track], listSource: 'recommend'}, state: 'paused', wantPlay: false, ready: true};
      window.MingmingNativePlayer = {
        read() {return JSON.stringify(window.mockPlayback);},
        command(action, body) {
          if (action === 'configure') window.mockPlayback.snapshot = JSON.parse(body);
          if (action === 'seek') window.mockPlayback.snapshot.position = Number(body);
          if (action === 'play' || action === 'pause') {window.mockPlayback.wantPlay = action === 'play'; window.mockPlayback.state = action === 'play' ? 'playing' : 'paused';}
        }
      };
    }, song);
    await context.route('**/api/library', route => route.fulfill({json: {favorites: [], playlists: [], recent: []}}));
    let releaseLyrics;
    const lyricsReady = new Promise(resolve => {releaseLyrics = resolve;});
    await context.route('**/api/music/lrc', async route => {await lyricsReady; return route.fulfill({json: {data: ''}});});
    await context.route('**/api/word-lyric?*', async route => {await lyricsReady; return route.fulfill({json: {code: 1, data: {lyric}}});});
    await context.route('**/api/netease/comments?*', route => route.fulfill({json: {comments: [], total: 0, more: false}}));
    await context.route(/https:\/\/(example\.invalid|picsum\.photos|p3\.music\.126\.net)\//, route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#71965f"/></svg>'}));
    const page = await context.newPage();
    async function inspect() {
      return page.locator('#overlay-lyrics').evaluate(root => {
        const box = root.getBoundingClientRect(), active = root.querySelector('.active'), rect = active.getBoundingClientRect(), style = getComputedStyle(active);
        const visible = [...root.querySelectorAll('.lyric-line')].filter(node => {const r = node.getBoundingClientRect(); return Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top) > 1;});
        return {visible: visible.map(node => Number(node.dataset.lyricIndex)), count: root.querySelectorAll('.lyric-line').length, active: Number(active.dataset.lyricIndex),
          slot: (rect.top + rect.height / 2 - box.top) / box.height, font: parseFloat(style.fontSize), nextFont: parseFloat(getComputedStyle(root.querySelector('.four-next') || active).fontSize),
          clipped: active.scrollWidth > active.clientWidth, nowrap: style.whiteSpace, transition: getComputedStyle(root.firstChild).transitionDuration,
          transform: getComputedStyle(root.firstChild).transform, gradient: getComputedStyle(active.querySelector('.lyric-word')).backgroundImage,
          inlineGradient: active.querySelector('.lyric-word').style.backgroundImage, wordClip: getComputedStyle(active.querySelector('.lyric-word')).webkitBackgroundClip,
          wordProgress: [...active.querySelectorAll('.lyric-word')].map(node => {const match = /rgb\(220, 233, 221\) ([\d.]+)%/.exec(node.style.backgroundImage); return match ? parseFloat(match[1]) : NaN;}),
          focus: document.activeElement.id, focusable: root.classList.contains('focusable')};
      });
    }
    async function position(time, index) {
      await page.evaluate(value => {window.mockPlayback.snapshot.position = value;}, time);
      await page.waitForFunction(expected => Number(document.querySelector('#overlay-lyrics .active').dataset.lyricIndex) === expected && document.getElementById('overlay-elapsed').textContent === `${Math.floor(window.mockPlayback.snapshot.position / 60).toString().padStart(2, '0')}:${Math.floor(window.mockPlayback.snapshot.position % 60).toString().padStart(2, '0')}`, index);
    }
    try {
      await page.goto(url);
      await page.waitForFunction(() => document.getElementById('player-title').textContent === '四行歌词测试');
      await page.locator('.nav-item[data-page="search"]').click();
      await page.locator('#now-playing').tap();
      assert.equal(await page.locator('#now-playing').getAttribute('type'), 'button', 'footer entry has explicit button semantics');
      assert.equal(await page.locator('#now-playing').getAttribute('aria-label'), '打开全屏播放器');
      assert.equal(await page.locator('#player-overlay').isVisible(), true, 'Android-style touch opens the fullscreen player');
      const overlayBounds = await page.locator('#player-overlay').evaluate(node => {const rect = node.getBoundingClientRect(); return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};});
      assert.deepEqual(overlayBounds, {left: 0, top: 0, width: size.width, height: size.height}, 'fullscreen overlay covers the visible Android viewport');
      assert.equal(await page.locator('#overlay-lyrics .lyric-loading').count(), 1);
      assert.equal(await page.locator('#lyric-status').isVisible(), false, 'fullscreen has one lyric loading message');
      assert.equal((await page.locator('#player-overlay').innerText()).match(/正在加载歌词/g).length, 1);
      await page.locator('#player-comments-toggle').click();
      assert.equal((await page.locator('#player-overlay').innerText()).match(/正在加载歌词/g).length, 1, 'hiding comments also keeps one loading state');
      await page.locator('#player-comments-toggle').click();
      assert.equal(await page.locator('#overlay-track-meta').textContent(), '测试歌手 · 测试专辑');
      assert.equal(await page.locator('#overlay-cover').getAttribute('src'), 'https://p3.music.126.net/test-cover.jpg?keep=1&param=400y400#cover', 'fullscreen CDN artwork requests its display size and retains other parameters');
      assert.equal(await page.locator('#player-cover').getAttribute('src'), 'https://p3.music.126.net/test-cover.jpg?keep=1&param=160y160#cover', 'footer artwork requests a thumbnail without mutating song data');
      assert.equal(await page.locator('.player-overlay-head').innerText(), '测试歌手 · 测试专辑');
      assert.equal(await page.locator('.overlay-song-heading span').count(), 0, 'song title row only contains the title and favorite');
      releaseLyrics();
      await page.waitForSelector('#overlay-lyrics .has-word-timing.active');
      assert.equal(await page.locator('#overlay-lyrics .lyric-loading').count(), 0);
      assert.equal(await page.locator('#overlay-lyrics .lyric-line').count(), texts.length);
      const normalFont = await page.locator('#overlay-lyrics .active').evaluate(node => getComputedStyle(node).fontSize);
      await page.locator('#player-comments-toggle').click();
      let view = await inspect();
      assert.deepEqual(view.visible, [2, 3, 4, 5]);
      assert.equal(view.count, texts.length, 'all timing data remains available');
      assert.ok(Math.abs(view.slot - .375) < .01, 'current sentence stays in slot two');
      assert.ok(view.font > view.nextFont * 1.3 && view.font > parseFloat(normalFont) * 2, 'current sentence uses a large TV font');
      assert.equal(view.clipped, false); assert.equal(view.nowrap, 'nowrap'); assert.equal(view.focusable, false);
      assert.equal(view.focus, 'player-comments-toggle'); assert.match(view.gradient, /199, 243, 141/, 'karaoke uses our accent green');
      assert.match(view.inlineGradient, /rgb\(199, 243, 141\)/, 'legacy WebView receives a concrete prefixed word gradient');
      assert.equal(view.inlineGradient.indexOf('var('), -1, 'karaoke does not depend on unsupported CSS custom properties');
      assert.equal(view.wordClip, 'text');
      assert.ok(view.wordProgress.some(p => p > 0 && p < 100), 'word timing retains partial progress');
      assert.equal(await page.locator('#side-lyrics').count(), 0, 'fullscreen keeps the only lyric view');
      await page.waitForTimeout(600);
      assert.deepEqual(await inspect(), view, 'paused lyrics and word progress stay still');
      if (screenshotsDir) await page.screenshot({path: path.join(screenshotsDir, `four-line-lyrics-${size.width}.png`)});

      await page.locator('#overlay-play').click();
      await position(39.75, 3);
      assert.equal(await page.locator('#overlay-cover').evaluate(node => getComputedStyle(node).willChange), 'transform', 'visible playing cover hints compositing');
      await position(40.25, 4);
      view = await inspect();
      assert.equal(view.transition, '0.45s', 'adjacent playing sentences move smoothly');
      await page.locator('#overlay-play').click();
      assert.equal((await inspect()).transition, '0s', 'pause stops the pending motion');
      assert.equal(await page.locator('#overlay-cover').evaluate(node => getComputedStyle(node).willChange), 'auto', 'paused cover releases the compositing hint');

      await page.locator('#overlay-play').click();
      await page.locator('#overlay-seek').evaluate(input => {input.value = String(50.25 / 120 * 100); input.dispatchEvent(new Event('input', {bubbles: true})); input.dispatchEvent(new Event('change', {bubbles: true}));});
      view = await inspect();
      assert.equal(view.active, 5); assert.equal(view.transition, '0s', 'progress-bar seeking never animates even to an adjacent sentence');
      await page.locator('#overlay-play').click();

      await position(55, 5);
      view = await inspect();
      assert.equal(view.clipped, false, 'long sentence fits without truncating');
      assert.ok(view.font < 40, 'long sentence reduces its size to fit');
      await page.locator('#overlay-play').click();
      await position(85, 8);
      view = await inspect();
      assert.deepEqual(view.visible, [7, 8, 9, 10]); assert.equal(view.transition, '0s', 'seek jumps directly to its four-line window');
      await position(.25, 0); view = await inspect();
      assert.deepEqual(view.visible, [0, 1, 2]); assert.ok(Math.abs(view.slot - .375) < .01, 'first line leaves its previous slot blank');
      await position(115, 11); view = await inspect();
      assert.deepEqual(view.visible, [10, 11]); assert.ok(Math.abs(view.slot - .375) < .01, 'last line leaves trailing slots blank');
      await page.locator('#player-comments-toggle').click();
      assert.equal(await page.locator('#overlay-lyrics .four-lyric-track').count(), 0);
      assert.equal(await page.locator('#overlay-lyrics .lyric-line').count(), texts.length);
      assert.equal(await page.locator('#overlay-lyrics .active').evaluate(node => getComputedStyle(node).fontSize), normalFont);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'player-comments-toggle');
      const placement = await page.locator('#overlay-lyrics .active').evaluate(node => {const a = node.getBoundingClientRect(), b = node.parentNode.getBoundingClientRect(); return {top: a.top, bottom: a.bottom, containerTop: b.top, containerBottom: b.bottom};});
      assert.ok(placement.top >= placement.containerTop - 1 && placement.bottom <= placement.containerBottom + 1, 'expanded list follows current playback: ' + JSON.stringify(placement));
      await page.locator('#player-comments-toggle').click();
      await page.keyboard.press('Escape'); await page.locator('#now-playing').click();
      assert.deepEqual((await inspect()).visible, [10, 11], 'reopening keeps the current four-line view');
      await page.evaluate(() => {window.mockPlayback.snapshot.track = {...window.mockPlayback.snapshot.track, id: 'four-line-next'}; window.mockPlayback.snapshot.position = .25;});
      await page.waitForFunction(() => {const active = document.querySelector('#overlay-lyrics .active'); return active && Number(active.dataset.lyricIndex) === 0;});
      assert.deepEqual((await inspect()).visible, [0, 1, 2], 'next song resets the window');

      // Plain LRC retains the four-row layout; no lyric data keeps the usual
      // empty state rather than producing four fake sentences.
      await context.route('**/api/word-lyric?*', route => route.fulfill({json: {code: 1, data: {lyric: ''}}}));
      await context.route('**/api/music/lrc', route => route.fulfill({json: {data: '[00:00.00]普通歌词第一句\n[00:10.00]普通歌词第二句\n[00:20.00]普通歌词第三句\n[00:30.00]普通歌词第四句'}}));
      await page.evaluate(() => {window.mockPlayback.snapshot.track = {...window.mockPlayback.snapshot.track, id: 'plain-lrc'}; window.mockPlayback.snapshot.position = 15;});
      await page.waitForFunction(() => document.querySelector('#overlay-lyrics .active')?.textContent === '普通歌词第二句');
      assert.equal(await page.locator('#overlay-lyrics.lyrics-four-line').count(), 1);
      assert.equal(await page.locator('#overlay-lyrics .lyric-word').count(), 0);
      await context.route('**/api/music/lrc', route => route.fulfill({json: {data: ''}}));
      await page.evaluate(() => {window.mockPlayback.snapshot.track = {...window.mockPlayback.snapshot.track, id: 'no-lyrics'};});
      await page.waitForFunction(() => document.getElementById('lyric-status').textContent === '暂无歌词');
      assert.equal(await page.locator('#overlay-lyrics .four-lyric-track').count(), 0);
      assert.equal(await page.locator('#overlay-lyrics .state').textContent(), '暂无歌词');

      await page.evaluate(() => {window.mockPlayback.snapshot.track = {...window.mockPlayback.snapshot.track, id: 'long-title', name: '这是一个特别长的歌名需要省略但不能挤掉收藏按钮', ar: [{name: '很长的第一位歌手'}, {name: '很长的第二位歌手'}], al: {name: '非常长的音乐专辑名称'}};});
      await page.waitForFunction(() => document.getElementById('overlay-title').textContent.startsWith('这是一个特别长的歌名'));
      const layout = await page.locator('.overlay-song-heading').evaluate(heading => {
        const title = heading.querySelector('strong'), meta = document.getElementById('overlay-track-meta'), favorite = heading.querySelector('button');
        const h = heading.getBoundingClientRect(), t = title.getBoundingClientRect(), m = meta.getBoundingClientRect(), f = favorite.getBoundingClientRect();
        const head = meta.parentNode.parentNode.getBoundingClientRect();
        return {titleOverflow: title.scrollWidth > title.clientWidth, singleLine: getComputedStyle(title).whiteSpace === 'nowrap' && getComputedStyle(meta).whiteSpace === 'nowrap',
          titleSize: parseFloat(getComputedStyle(title).fontSize), metadataSize: parseFloat(getComputedStyle(meta).fontSize), headerVisible: m.right <= head.right + 1,
          separated: f.left >= t.right && m.bottom <= h.top, favoriteVisible: f.right <= h.right + 1, height: h.height, buttonHeight: f.height};
      });
      assert.ok(layout.titleOverflow && layout.singleLine, 'long title uses a single-line ellipsis');
      assert.ok(layout.metadataSize < layout.titleSize && layout.headerVisible, 'small metadata stays in the fullscreen header');
      assert.ok(layout.separated && layout.favoriteVisible && layout.height === layout.buttonHeight, 'heading stays compact and favorite remains visible');
      if (screenshotsDir) await page.locator('.overlay-song-heading').screenshot({path: path.join(screenshotsDir, `fullscreen-long-title-${size.width}.png`)});
      await page.evaluate(() => {window.mockPlayback.snapshot.track = {...window.mockPlayback.snapshot.track, id: 'long-meta', ar: [{name: '很长的歌手名称'.repeat(20)}], al: {name: '很长的专辑名称'.repeat(20)}};});
      await page.waitForFunction(() => document.getElementById('overlay-track-meta').textContent.length > 200);
      const headerFit = await page.locator('#overlay-track-meta').evaluate(node => {
        const r = node.getBoundingClientRect(), head = node.parentNode.parentNode.getBoundingClientRect();
        return node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis' && getComputedStyle(node).whiteSpace === 'nowrap' && r.right <= head.right + 1;
      });
      assert.equal(headerFit, true, 'very long artist/album names remain inside the header with an ellipsis');
    } finally {releaseLyrics(); await context.close();}
  }
  console.log('Four-line lyrics: TV sizing, word timing, fit, pause, seek, edge slots, toggle focus and song changes passed');
};
