const assert = require('assert/strict');

module.exports = async function focusPerformance({browser, url}) {
  const results = [];
  for (const count of [24, 240]) {
    const tracks = Array.from({length: count}, (_, i) => ({id: 'focus-perf-' + i, name: '歌曲 ' + i, artist: '测试歌手', dt: 180000, picUrl: 'https://p3.music.126.net/perf-cover.jpg?param=800y800'}));
    const context = await browser.newContext({viewport: {width: 1280, height: 720}});
    try {
      await context.addInitScript(list => {
        window.performancePlayback = {snapshot: {schema: 1, track: list[0], position: 2, duration: 180, mode: 'list', list}, state: 'paused', ready: true, wantPlay: false};
        window.MingmingNativePlayer = {read() {return JSON.stringify(window.performancePlayback);}, command() {}};
      }, tracks);
      await context.route('**/api/library', route => route.fulfill({json: {favorites: [], playlists: tracks, recent: []}}));
      await context.route('**/api/music/lrc', route => route.fulfill({json: {data: '[00:00.00]歌词'}}));
      await context.route('**/api/word-lyric?*', route => route.fulfill({json: {data: {lyric: ''}}}));
      await context.route('**/api/netease/comments?*', route => route.fulfill({json: {comments: Array.from({length: 10}, () => ({user: {nickname: '评论用户'}, content: '测试评论'})), total: 10, more: false}}));
      await context.route('https://p3.music.126.net/**', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"/>'}));
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForFunction(expected => document.getElementById('queue-count').textContent === String(expected), count);
      await page.locator('[data-page="queue"]').click();
      await page.waitForFunction(expected => document.querySelectorAll('#content .track-list .track-row').length === expected, count);
      await page.waitForSelector('#overlay-comments .comment', {state: 'attached'});
      await page.waitForTimeout(1100);
      const result = await page.evaluate(() => {
        const root = document.getElementById('content'), player = document.getElementById('player-overlay');
        const originals = {bounds: Element.prototype.getBoundingClientRect, rects: Element.prototype.getClientRects, style: window.getComputedStyle};
        let reads = null;
        function record(node) {if (reads) {const zone = root.contains(node) ? 'content' : player.contains(node) ? 'player' : 'other'; reads[zone]++;}}
        Element.prototype.getBoundingClientRect = function () {record(this); return originals.bounds.apply(this, arguments);};
        Element.prototype.getClientRects = function () {record(this); return originals.rects.apply(this, arguments);};
        window.getComputedStyle = function (node) {record(node); return originals.style.apply(this, arguments);};
        function move(code) {reads = {content: 0, player: 0, other: 0}; const start = performance.now(); window.MingmingTVKey(code); const result = {...reads, handler: performance.now() - start}; reads = null; return result;}
        try {
          document.querySelectorAll('#content .track-list .track-row')[2].focus();
          const row = move(20), track = document.activeElement.getAttribute('data-track-id');
          move(21);
          const sidebar = move(20);
          return {row, sidebar, track, cover: document.querySelector('#content .track-row img').getAttribute('src'), rawCover: window.performancePlayback.snapshot.track.picUrl};
        } finally {
          Element.prototype.getBoundingClientRect = originals.bounds; Element.prototype.getClientRects = originals.rects; window.getComputedStyle = originals.style;
        }
      });
      assert.equal(result.track, 'focus-perf-3', 'Down still selects exactly the next song');
      assert.ok(result.row.content <= 24, 'song movement measures only its destination and scroll viewport');
      assert.equal(result.row.player, 0, 'song movement does not measure hidden player comments');
      assert.equal(result.sidebar.content, 0, 'sidebar movement does not measure the song list');
      assert.equal(result.sidebar.player, 0, 'sidebar movement does not measure the hidden player');
      assert.match(result.cover, /param=160y160$/, 'song rows request thumbnails sized for TV rendering');
      assert.match(result.rawCover, /param=800y800$/, 'thumbnail rendering preserves the original song data');
      const idleMutations = await page.evaluate(() => new Promise(resolve => {
        let mutations = 0;
        const observer = new MutationObserver(items => {mutations += items.length;});
        observer.observe(document.getElementById('stage'), {subtree: true, attributes: true, childList: true, characterData: true});
        setTimeout(() => {observer.disconnect(); resolve(mutations);}, 1100);
      }));
      assert.equal(idleMutations, 0, 'paused native polling does not redraw unchanged controls or song rows');
      results.push({count, ...result.row, sidebar: result.sidebar});
    } finally {await context.close();}
  }
  assert.ok(results[1].content <= results[0].content + 2, 'focus geometry work stays bounded as the list grows tenfold');
  console.log('Focus performance: bounded geometry for 24/240 songs, scoped sidebar, thumbnail sizes and no idle native redraws passed');
};
