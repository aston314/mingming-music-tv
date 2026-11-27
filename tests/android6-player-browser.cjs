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
  const libraryTracks = [track, {...track, id: 'legacy-second', name: '第二首歌曲'}];
  for (const textClip of [true, false]) {
    const context = await browser.newContext({viewport: {width: 960, height: 540}, hasTouch: true});
    try {
      await context.addInitScript(({track, textClip, libraryTracks}) => {
        localStorage.setItem('mingming.searchHistory', JSON.stringify(['周杰伦', '林俊杰', '陈奕迅', '孙燕姿', '五月天', '王菲', '张学友', '许巍', '李健', '陶喆']));
        if (document.documentElement) document.documentElement.className += ' legacy-layout';
        else document.addEventListener('DOMContentLoaded', () => {document.documentElement.className += ' legacy-layout';});
        if (!textClip) {
          const create = document.createElement;
          document.createElement = function (name) {
            const node = create.apply(this, arguments);
            if (name === 'span') Object.defineProperty(node.style, 'webkitBackgroundClip', {get() {return undefined;}});
            return node;
          };
        }
        window.legacyPlayback = {snapshot: {schema: 1, track, position: 2.5, duration: 20, mode: 'list', list: libraryTracks}, state: 'paused', ready: true, wantPlay: false};
        window.MingmingNativePlayer = {read() {return JSON.stringify(window.legacyPlayback);}, command() {}};
      }, {track, textClip, libraryTracks});
      await context.route('**/app.css', route => route.fulfill({contentType: 'text/css', body: legacyCSS}));
      await context.route('**/api/library', route => route.fulfill({json: {favorites: libraryTracks, playlists: libraryTracks, recent: libraryTracks}}));
      await context.route('**/api/music/lrc', route => route.fulfill({json: {data: '[00:00.00]前一句\n[00:02.00]随歌声前进\n[00:10.00]下一句'}}));
      await context.route('**/api/word-lyric?*', route => route.fulfill({json: {data: {lyric: '[0,2000](0,2000,0)前一句\n[2000,8000](2000,1000,0)随(3000,1000,0)歌(4000,6000,0)声前进\n[10000,5000](10000,5000,0)下一句'}}}));
      await context.route('**/api/netease/comments?*', route => route.fulfill({json: {comments: [{user: {nickname: '评论用户', avatarUrl: track.picUrl}, timeStr: '昨天', content: '适合在电视上阅读的评论。'}], total: 1, more: false}}));
      await context.route('**/legacy-cover.svg', route => route.fulfill({contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#71965f"/></svg>'}));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      try {
        await page.waitForFunction(() => document.getElementById('player-title').textContent === '安卓兼容歌词', null, {timeout: 5000});
      } catch (error) {
        const initialState = await page.evaluate(() => {
          let native = null;
          try { native = window.MingmingNativePlayer && window.MingmingNativePlayer.read(); } catch (ignore) {}
          return {title: document.getElementById('player-title') && document.getElementById('player-title').textContent, native: native, appScript: !!document.querySelector('script[src="/app.js"]'), errors: document.documentElement.className};
        });
        throw new Error(error.message + '; initial page state: ' + JSON.stringify(initialState));
      }
      await page.waitForSelector('#recommend-playlists .playlist-card');
      assert.deepEqual(await page.locator('#recommend-playlists .playlist-count-badge').allTextContents(), ['12 首', '24 首', '18 首'], 'playlist counts are shown as badges inside poster covers');
      assert.equal(await page.locator('#recommend-playlists .playlist-card small').count(), 0, 'playlist titles do not reserve a separate count row');
      const countBadgeLayout = await page.locator('#recommend-playlists .playlist-card').first().evaluate(card => {
        const cover = card.querySelector('.playlist-cover').getBoundingClientRect();
        const badge = card.querySelector('.playlist-count-badge').getBoundingClientRect();
        return {
          topInset: badge.top - cover.top,
          rightInset: cover.right - badge.right,
          insideCover: badge.left >= cover.left && badge.right <= cover.right && badge.top >= cover.top && badge.bottom <= cover.bottom
        };
      });
      assert.equal(countBadgeLayout.insideCover, true, 'playlist count badges stay inside the poster cover');
      assert.ok(countBadgeLayout.topInset >= 4 && countBadgeLayout.rightInset >= 4, 'playlist count badges are inset from the poster top-right corner');
      await page.waitForFunction(() => document.getElementById('player-artist').textContent === '随歌声前进');
      assert.equal(await page.locator('#player-artist').evaluate(node => getComputedStyle(node).color), 'rgb(199, 243, 141)', 'footer lyrics keep their accent color without CSS variables');
      await page.waitForFunction(() => !document.getElementById('player-heading-artist').hidden);
      assert.equal(await page.locator('#player-heading-artist').textContent(), '· 测试歌手', 'legacy layout keeps the artist beside the song title');
      assert.equal(await page.locator('#player-heading').evaluate(node => {
        const title = document.getElementById('player-title').getBoundingClientRect(), artist = document.getElementById('player-heading-artist').getBoundingClientRect();
        return artist.left >= title.right && artist.bottom <= document.getElementById('player-artist').getBoundingClientRect().top;
      }), true, 'legacy title and artist share a row without overlapping the lyric');
      const shellLayout = await page.evaluate(() => {
        const cards = document.querySelectorAll('#recommend-playlists .playlist-card');
        const first = cards[0].getBoundingClientRect(), second = cards[1].getBoundingClientRect();
        const categories = document.querySelectorAll('.category-tab');
        const categoryGap = categories[1].getBoundingClientRect().left - categories[0].getBoundingClientRect().right;
        const logo = document.querySelector('.brand-mark').getBoundingClientRect();
        const name = document.querySelector('.brand-name').getBoundingClientRect();
          const sidebar = document.querySelector('.sidebar');
          const content = document.getElementById('content');
        const nav = document.getElementById('nav-recommend');
        nav.focus();
        const focusStyle = getComputedStyle(nav);
        const bar = document.querySelector('.player-bar').getBoundingClientRect();
        const barItems = Array.from(document.querySelector('.player-bar').children).map(node => node.getBoundingClientRect());
        const controlItems = Array.from(document.querySelector('.player-controls').children).map(node => node.getBoundingClientRect());
        const rowGap = controlItems[1].left - controlItems[0].right;
        return {
          legacy: document.documentElement.className.indexOf('legacy-layout') >= 0,
            brandInSidebar: !!document.querySelector('.sidebar .sidebar-brand .brand'),
            topbar: !!document.querySelector('.topbar'),
            outerLayout: {
              workspaceGap: getComputedStyle(document.querySelector('.workspace')).gap,
              sidebarRadius: getComputedStyle(sidebar).borderRadius,
              contentRadius: getComputedStyle(content).borderRadius,
              contentTop: content.getBoundingClientRect().top,
              sidebarTop: sidebar.getBoundingClientRect().top
            },
            navRadius: getComputedStyle(nav).borderRadius,
          gridDisplay: getComputedStyle(document.querySelector('.playlist-grid')).display,
          playlistColumns: Math.abs(first.top - second.top) < 1 && second.left > first.right,
          categoryGap: categoryGap,
          selectedCategory: getComputedStyle(document.querySelector('.category-tab.is-active')).backgroundColor,
          brandGap: (name.left - logo.right) / (window.__tvScale || 1),
          focus: {outline: focusStyle.outlineStyle, radius: focusStyle.borderRadius, shadow: focusStyle.boxShadow},
          barFits: barItems[barItems.length - 1].right <= bar.right + 1 && barItems.every((item, index) => !index || item.left >= barItems[index - 1].right),
          controlGap: rowGap
        };
      });
      assert.equal(shellLayout.legacy, true, 'legacy layout fallback is enabled');
      assert.equal(shellLayout.brandInSidebar, true, 'logo is part of the full-height sidebar rail');
      assert.equal(shellLayout.topbar, false, 'separate top bar is removed');
      assert.equal(shellLayout.outerLayout.workspaceGap === '0px' || shellLayout.outerLayout.workspaceGap === 'normal', true, 'legacy WebView falls back to zero workspace gap');
      assert.deepEqual({sidebarRadius: shellLayout.outerLayout.sidebarRadius, contentRadius: shellLayout.outerLayout.contentRadius, contentTop: shellLayout.outerLayout.contentTop, sidebarTop: shellLayout.outerLayout.sidebarTop}, {sidebarRadius: '0px', contentRadius: '0px', contentTop: 0, sidebarTop: 0}, 'outer rail and content are flush and square');
      assert.equal(shellLayout.navRadius, '9px', 'sidebar button rounding remains unchanged');
      const iconRail = await page.evaluate(() => {
        const app = document.getElementById('app'), brand = document.querySelector('.sidebar-brand'), name = document.querySelector('.sidebar-brand .brand-name');
        app.classList.add('sidebar-icons-only');
        const result = {width: brand.getBoundingClientRect().width, nameDisplay: getComputedStyle(name).display, nameOverflow: name.getBoundingClientRect().right > document.querySelector('.sidebar').getBoundingClientRect().right};
        app.classList.remove('sidebar-icons-only');
        return result;
      });
      assert.equal(iconRail.nameDisplay, 'none', 'icon-only sidebar hides the integrated app name');
      assert.equal(iconRail.nameOverflow, false, 'icon-only sidebar keeps the logo inside the rail');
      assert.equal(shellLayout.gridDisplay, 'flex', 'playlist grid falls back to a flex row');
      assert.equal(shellLayout.playlistColumns, true, 'popular playlists use multiple columns');
      assert.ok(shellLayout.categoryGap >= 4, 'category filters have visible horizontal spacing');
      assert.equal(shellLayout.selectedCategory, 'rgb(199, 243, 141)', 'selected filters retain their theme color without CSS variables');
      assert.ok(Math.abs(shellLayout.brandGap - 18) < 1, 'logo and app name keep an exact, engine-independent spacing');
      assert.equal(shellLayout.focus.outline, 'none', 'legacy focus avoids square outlines');
      assert.match(shellLayout.focus.shadow, /199, 243, 141/, 'legacy focus uses the rounded shadow ring');
      assert.ok(shellLayout.barFits, 'footer controls fit without overlap');
      assert.ok(shellLayout.controlGap >= 8, 'footer controls have a visible gap');
      await page.locator('#seek').focus();
      assert.equal(await page.locator('#seek').evaluate(el => getComputedStyle(el).boxShadow), 'none', 'seek focus uses its thumb without an outer control ring');
      if (screenshotsDir) await page.screenshot({path: path.join(screenshotsDir, 'legacy-home-' + textClip + '.png')});
      await page.evaluate(() => window.MingmingTVBack());
      const exitDialog = await page.evaluate(() => {
        const root = document.getElementById('modal-root'), rect = root.getBoundingClientRect();
        return {visible: !root.hidden, focused: document.activeElement.id, rect: [rect.left, rect.top, rect.width, rect.height]};
      });
      assert.equal(exitDialog.visible, true, 'Back opens the exit confirmation');
      assert.equal(exitDialog.focused, 'exit-cancel', 'exit confirmation defaults focus to cancel');
      assert.deepEqual(exitDialog.rect, [0, 0, 960, 540], 'legacy modal fills the visible viewport without inset');
      await page.evaluate(() => window.MingmingTVBack());
      await page.locator('.playlist-card').first().click();
      await page.waitForSelector('#playlist-detail-body .track-row:nth-child(2)');
      const songRowsGap = await page.evaluate(() => {
        const rows = document.querySelectorAll('#playlist-detail-body .track-row');
        return rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().bottom;
      });
      assert.ok(songRowsGap >= 8, 'song rows keep vertical spacing without flex gap');
      await page.evaluate(() => window.MingmingTVBack());
      await page.waitForSelector('.playlist-card');
      await page.locator('[data-page="queue"]').click();
      await page.waitForSelector('.track-list .track-row:nth-child(2)');
      await page.locator('#queue-open').click();
      await page.waitForSelector('#queue-popup .track-row:nth-child(2)');
      const queueLayout = await page.evaluate(() => {
        const rows = document.querySelectorAll('#queue-popup .track-row'), first = rows[0].getBoundingClientRect(), next = rows[1].getBoundingClientRect();
        rows[0].focus();
        const cover = rows[0].querySelector('img').getBoundingClientRect(), copy = rows[0].querySelector('.track-info').getBoundingClientRect();
        const actions = rows[0].querySelectorAll('.track-action'), a = actions[0].getBoundingClientRect(), b = actions[1].getBoundingClientRect();
        return {rowGap: next.top - first.bottom, coverGap: copy.left - cover.right, actionGap: b.left - a.right};
      });
      assert.ok(queueLayout.rowGap >= 8 && queueLayout.coverGap >= 8 && queueLayout.actionGap >= 4, 'queue popup rows and their action icons have separate gutters');
      if (screenshotsDir) await page.screenshot({path: path.join(screenshotsDir, 'legacy-queue-' + textClip + '.png')});
      await page.evaluate(() => window.MingmingTVBack());
      await page.locator('#nav-account').click();
      const accountLayout = await page.locator('.account-page').evaluate(panel => {
        const nodes = Array.from(panel.querySelectorAll('.account-actions button')), boxes = nodes.map(node => node.getBoundingClientRect()), bounds = panel.getBoundingClientRect();
        return {fits: boxes.every(box => box.left >= bounds.left && box.right <= bounds.right), separated: boxes.every((box, i) => boxes.slice(0, i).every(other => box.left >= other.right + 3 || box.right <= other.left - 3 || box.top >= other.bottom + 3 || box.bottom <= other.top - 3)), avatar: [panel.querySelector('.account-avatar').getBoundingClientRect().width, panel.querySelector('.account-avatar').getBoundingClientRect().height], loginColor: getComputedStyle(document.getElementById('account-login')).backgroundColor};
      });
      assert.ok(accountLayout.fits && accountLayout.separated, 'account actions wrap without overlap');
      assert.ok(Math.abs(accountLayout.avatar[0] - accountLayout.avatar[1]) < 1, 'account avatar stays circular without CSS Grid');
      assert.equal(accountLayout.loginColor, 'rgb(199, 243, 141)', 'login retains a visible primary background');
      await page.locator('#account-login').click();
      const authTabs = await page.locator('.modal-tabs').evaluate(panel => Array.from(panel.children).map(node => node.getBoundingClientRect()).every((box, i, boxes) => !i || box.left - boxes[i - 1].right >= 8));
      assert.equal(authTabs, true, 'login/register/reset tabs have focus-ring clearance');
      await page.evaluate(() => window.MingmingTVBack());
      await page.locator('.nav-item[data-page="search"]').click();
      const historyLayout = await page.locator('.search-history-list').evaluate(panel => {
        const boxes = Array.from(panel.children).map(node => node.getBoundingClientRect());
        return boxes.length === 10 && boxes.every((box, i) => boxes.slice(0, i).every(other => box.left >= other.right + 3 || box.right <= other.left - 3 || box.top >= other.bottom + 3 || box.bottom <= other.top - 3));
      });
      assert.equal(historyLayout, true, 'all ten search-history chips remain separated when wrapping');
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
      await page.waitForSelector('#overlay-comments .comment');
      assert.ok(await page.locator('#overlay-comments .comment').evaluate(row => row.querySelector('.comment-body').getBoundingClientRect().left - row.querySelector('.comment-avatar').getBoundingClientRect().right) >= 8, 'comment text stays clear of its avatar');
      for (const selector of ['#overlay-lyrics']) {
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
  console.log('Legacy CSS capability simulation: card grids, spacing, focus ring, exit modal, player, remote/touch entry and lyrics passed');
};
