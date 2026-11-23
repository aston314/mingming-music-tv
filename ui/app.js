(function () {
  "use strict";
  // Keep one logical TV canvas for rendering, focus and scroll geometry. The
  // root client size is the visible WebView size; innerWidth may include the
  // overflowing logical canvas on Android WebView.
  var canvasWidth = 1280, canvasHeight = 720, viewportTimer = 0;
  function supportsFlexGap() {
    var box = document.createElement("div"), first = document.createElement("div"), second = document.createElement("div"), gap;
    box.style.cssText = "position:absolute;left:-1000px;top:-1000px;display:flex;flex-direction:column;gap:1px;padding:0;border:0";
    first.style.cssText = second.style.cssText = "width:1px;height:1px;flex:none";
    box.appendChild(first); box.appendChild(second); document.body.appendChild(box);
    gap = second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
    document.body.removeChild(box);
    return gap >= 0.5;
  }
  function supportsGrid() {
    var box = document.createElement("div"), first = document.createElement("div"), second = document.createElement("div"), columns;
    box.style.cssText = "position:absolute;left:-1000px;top:-1000px;display:grid;grid-template-columns:1px 1px;width:2px;padding:0;border:0";
    first.style.cssText = second.style.cssText = "width:1px;height:1px";
    box.appendChild(first); box.appendChild(second); document.body.appendChild(box);
    columns = second.getBoundingClientRect().left - first.getBoundingClientRect().left;
    document.body.removeChild(box);
    return columns >= 0.5;
  }
  if (!supportsFlexGap() || !supportsGrid()) document.documentElement.className += " legacy-layout";
  // The softer surface hierarchy is now the default. Keep ?layout=current
  // as a browser comparison switch while the layout is being reviewed.
  if (!/(?:^|&)layout=current(?:&|$)/.test(window.location.search.replace(/^\?/, ""))) document.documentElement.className += " layout-soft";
  function fitViewport() {
    var root = document.documentElement, stage = document.getElementById("stage"), width = root.clientWidth || window.innerWidth, height = root.clientHeight || window.innerHeight, scale;
    if (!stage || !(width > 0 && height > 0)) return false;
    scale = Math.min(width / canvasWidth, height / canvasHeight);
    if (!(scale > 0)) return false;
    stage.style.width = (width / scale) + "px";
    stage.style.height = (height / scale) + "px";
    stage.style.transform = "scale(" + scale + ")";
    stage.style.left = "0px";
    stage.style.top = "0px";
    window.__tvScale = scale;
    window.__tvViewport = {width: width, height: height, scale: scale, stageWidth: width / scale, stageHeight: height / scale};
    return true;
  }
  function refreshViewport() {
    var active, node, style;
    if (!fitViewport()) return;
    window.clearTimeout(viewportTimer);
    viewportTimer = window.setTimeout(function () {
      active = document.activeElement;
      if (active && isFocusable(active)) {
        node = active.parentNode;
        while (node && node !== document.body) {
          style = window.getComputedStyle(node);
          if (/(auto|scroll)/.test(style.overflowY) && node.clientHeight > 0) scrollFocusIntoView(node, active, false);
          node = node.parentNode;
        }
      }
      if (typeof centerLyrics === "function") centerLyrics();
      updateLyrics(playbackPosition(), true);
    }, 100);
  }
  window.refreshViewport = refreshViewport;
  fitViewport();
  window.addEventListener("resize", refreshViewport);
  window.addEventListener("orientationchange", refreshViewport);
  window.addEventListener("pageshow", refreshViewport);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) refreshViewport(); });

  // TV fixed canvas is transformed, so getBoundingClientRect returns viewport
  // pixels while clientHeight/scrollTop remain logical canvas pixels.
  function rectOf(node) {
    var r = node.getBoundingClientRect(), k = window.__tvScale || 1;
    return {left: r.left / k, top: r.top / k, right: r.right / k, bottom: r.bottom / k, width: r.width / k, height: r.height / k};
  }
  var state = {
    page: "recommend", songs: [], queue: [], favorites: [], recent: [], current: null, fixture: false,
    authenticated: false, librarySynced: false,
    catalogue: [], categoryIndex: 0,
    libraryView: "queue",
    activeCat: "华语", playlists: [], playbackList: [], playbackListSource: "", searchProvider: "wy",
    lyricsText: "", lyricLines: [], lyricIndex: -1, lyricsLoaded: false, lyricsWordLoaded: false, comments: [], commentsLoaded: false,
    commentsHidden: false, commentsScroll: 0,
    commentsPage: 0, commentsPageSize: 10, commentsTotal: 0, commentsMore: false, commentsLoading: false, commentsError: false, commentsRetryAt: 0,
    playbackStatus: "idle",
    playerOpen: false, playerPreviousFocus: null, queueOpen: false, queuePreviousFocus: null, modalPreviousFocus: null, exitDialog: false, playMode: "list", playToken: 0,
    searchQuery: "", searchPage: 0, searchPageSize: 30, searchMore: false, searchLoading: false, searchRequest: 0, searchHistory: [], seekInput: null, detailReturn: null, detailKind: "", artistDetail: null, artistAlbums: [], artistAlbumsMore: false, artistAlbumsLoading: false, artistAlbumsError: "", artistAlbumsOffset: 0, artistAlbumsRequest: 0, albumDetail: null, shareMenu: null, returnPlaylist: null, scan: null, scanGeneration: 0
  };
  var content = document.getElementById("content"), audio = document.getElementById("audio");
  var nativePlayer = window.MingmingNativePlayer && window.MingmingNativePlayer.command && window.MingmingNativePlayer.read ? window.MingmingNativePlayer : null;
  var nativeApp = !!(window.MingmingTVApp || nativePlayer);
  var nativeSelection = 0, nativePendingSelection = 0, settingsUpdateTimer = null;
  var commentMotion = {frame: null, last: 0, position: 0, scroll: 0, background: false, holdUntil: 0};
  var lyricMotion = {frame: null, base: 0, at: 0, wordTime: -1};
  var commentView = {token: -1, count: 0};
  var overlayLyricView = {lines: null, message: null, four: false, width: 0, height: 0, index: -1, time: null, measure: null};
  var lyricActiveNode = null;
  var requestFrame = window.requestAnimationFrame ? function (fn) { return window.requestAnimationFrame(fn); } : function (fn) { return window.setTimeout(function () { fn(Date.now()); }, 32); };
  var cancelFrame = window.cancelAnimationFrame ? function (id) { window.cancelAnimationFrame(id); } : function (id) { window.clearTimeout(id); };
  var lyricWordClipSupported = typeof document.createElement("span").style.webkitBackgroundClip !== "undefined";
  function lyricClockNow() { return window.performance && typeof window.performance.now === "function" ? window.performance.now() : Date.now(); }

  function each(root, selector, fn) { var nodes = root.querySelectorAll(selector), i; for (i = 0; i < nodes.length; i++) fn(nodes[i]); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>\"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }
  function visibleText(value) {
    var text = String(value == null ? "" : value);
    if (state.page === "search") return text;
    return text.replace(/网易云/g, "").replace(/\s{2,}/g, " ").replace(/^\s*[·|｜]\s*|\s*[·|｜]\s*$/g, "");
  }
  function api(path, method, body, done) {
    var xhr = new XMLHttpRequest(), settled = false;
    function finish(err, data) { if (settled) return; settled = true; done(err, data); }
    xhr.open(method || "GET", path, true); xhr.timeout = 30000;
    if (body) xhr.setRequestHeader("Content-Type", body.charAt(0) === "{" ? "application/json; charset=UTF-8" : "application/x-www-form-urlencoded; charset=UTF-8");
    xhr.onreadystatechange = function () { var data; if (xhr.readyState !== 4) return; data = null; try { data = JSON.parse(xhr.responseText); } catch (ignore) {} if (xhr.status >= 200 && xhr.status < 300) finish(null, data); else finish(new Error((data && (data.message || data.msg)) || "请求失败"), data); };
    xhr.ontimeout = function () { finish(new Error("请求超时")); }; xhr.onerror = function () { finish(new Error("网络不可用")); }; xhr.send(body || null);
  }
  function isUrl(value) { return typeof value === "string" && /^(https?:\/\/|\/)/.test(value); }
  function cover(song, size) { var value; if (!song) return "https://picsum.photos/seed/mingming-default/300/300"; value = song.picUrl || (song.al && song.al.picUrl) || song.coverPath || song.image || song.pic || song.pic_id; if (!isUrl(value)) return "https://picsum.photos/seed/mingming-default/300/300"; return value.charAt(0) === "/" ? "/media?url=" + encodeURIComponent(value) : sizedArtwork(value, size || 160); }
  function sizedArtwork(value, size) {
    var hash, parts, query, i, params = [];
    if (!/^https?:\/\/p\d+\.music\.126\.net\//i.test(value)) return value;
    hash = value.indexOf("#"); hash = hash < 0 ? "" : value.slice(hash); if (hash) value = value.slice(0, -hash.length);
    parts = value.split("?"); query = parts[1] ? parts[1].split("&") : [];
    for (i = 0; i < query.length; i++) if (query[i] && !/^param=/i.test(query[i])) params.push(query[i]);
    params.push("param=" + size + "y" + size);
    return parts[0] + "?" + params.join("&") + hash;
  }
  function fullscreenCover(song) { return cover(song, 400); }
  function songName(song) { return visibleText(song && (song.name || song.title || song.mainTitle || "未命名歌曲")); }
  function artist(song) { var names = song && (song.ar || song.artists); if (names && names.length) return visibleText(names.map(function (x) { return typeof x === "string" ? x : x.name; }).join(" / ")); return visibleText(song && (song.artist || "未知歌手")); }
  function album(song) { var value = song && (song.al || song.album); return visibleText((value && typeof value === "object" ? value.name : value) || "单曲"); }
  function pageTitle(title, sub) { return '<div class="page-title"><h1>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>'; }
  function renderState(message, error) { content.innerHTML = '<div class="state' + (error ? ' error' : '') + '">' + esc(message) + '</div>'; }

  var focusMemory = {content: {}, footerReturn: null, overlayControl: "overlay-queue"};
  var progressView = {percent: null, elapsed: null, duration: null};
  var libraryWrite = {inFlight: false, pending: false, revision: 0, callbacks: []};
  var queueLoading = {data: 0, covers: 0, token: 0};
  var playback = {position: 0, duration: 0, pendingSeek: null, needsSource: false, sourceReady: false, resolving: false, wantPlay: false, errorKind: "", errorCode: 0, autoSkipCount: 0};
  var playbackWrite = {clientId: String(Date.now()) + "-" + String(Math.random()).slice(2), sequence: 0, revision: 0, inFlight: false, pending: null, lastSave: 0};
  function playbackPaused() { return nativePlayer ? !playback.wantPlay : audio.paused; }
  function playbackPosition() { return nativePlayer ? playback.position : playback.pendingSeek != null ? playback.pendingSeek : (playback.sourceReady ? (audio.currentTime || 0) : playback.position); }
  function playbackDuration() { return !nativePlayer && playback.sourceReady && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : playback.duration; }
  function snapshotTrack(song) {
    var copy = {}, keys = ["id", "name", "title", "mainTitle", "artist", "album", "type", "provider", "source", "picUrl", "coverPath", "image", "pic", "pic_id", "dt", "duration", "interval", "time", "ar", "artists", "al"], i;
    for (i = 0; i < keys.length; i++) if (song[keys[i]] != null) copy[keys[i]] = song[keys[i]];
    return copy;
  }
  function savePlayback(synchronous) {
    var body, xhr;
    playbackWrite.revision += 1;
    if (!state.current) return;
    if (nativePlayer) { nativePlayer.command("configure", JSON.stringify(nativeSnapshot())); return; }
    body = JSON.stringify({clientId: playbackWrite.clientId, sequence: ++playbackWrite.sequence, snapshot: {schema: 1, track: snapshotTrack(state.current), position: playbackPosition(), duration: playbackDuration(), mode: state.playMode, list: state.playbackList.slice(0, 500).map(snapshotTrack), listSource: state.playbackListSource}});
    playbackWrite.lastSave = Date.now(); playbackWrite.pending = body;
    if (synchronous) {
      // Loopback only. Flush before native exit destroys the WebView/core.
      // Sequence numbers stop an older asynchronous write replacing this one.
      xhr = new XMLHttpRequest(); xhr.open("PUT", "/api/playback", false); xhr.setRequestHeader("Content-Type", "application/json");
      try { xhr.send(body); if (xhr.status >= 200 && xhr.status < 300) playbackWrite.pending = null; } catch (ignore) {}
    } else flushPlaybackWrite();
  }
  function nativeSnapshot() { return {schema: 1, track: snapshotTrack(state.current), position: playback.position, duration: playback.duration, mode: state.playMode, list: playbackItems().slice(0, 500).map(snapshotTrack), listSource: state.playbackListSource, selectionTag: nativePendingSelection}; }
  function refreshNativePlayback() {
    var data, saved, changed, oldDuration = playback.duration, oldPosition = playback.position, oldStatus = state.playbackStatus, shouldSyncTicker;
    if (!nativePlayer) return false;
    try { data = JSON.parse(nativePlayer.read()); } catch (ignore) { return false; }
    saved = data && data.snapshot;
    if (!saved || !saved.track || (nativePendingSelection && data.selectionTag !== nativePendingSelection)) return false;
    nativePendingSelection = 0;
    changed = !state.current || !sameSong(state.current, saved.track);
    state.playMode = saved.mode || "list"; state.playbackList = saved.list || []; state.playbackListSource = saved.listSource || "";
    if (changed) { selectTrack(saved.track, saved.position, saved.duration, true); rememberRecent(saved.track); }
    playback.position = saved.position || 0; playback.duration = saved.duration || 0; playback.pendingSeek = null;
    playback.sourceReady = !!data.ready; playback.needsSource = !data.ready; playback.wantPlay = !!data.wantPlay;
    playback.resolving = data.state === "preparing";
    playback.errorKind = data.errorKind || ""; playback.errorCode = Number(data.errorCode) || 0;
    setPlaybackStatus(data.state || "paused"); renderPlayMode(); syncProgress(); updateLyrics(playback.position); renderQueueButton();
    // Lyrics may arrive after playback has already entered the playing state.
    // Restart the ticker whenever no frame is scheduled, otherwise the first
    // async word-lyric response can leave the fullscreen lyrics frozen.
    shouldSyncTicker = data.state !== "playing" || oldStatus !== "playing" || Math.abs(playback.position - oldPosition) > .75 || lyricMotion.frame === null;
    if (data.state === "playing" && shouldSyncTicker) syncLyricTicker(playback.position);
    if (oldDuration !== playback.duration) updateTrackStates();
    return true;
  }
  function flushPlaybackWrite() {
    var body, settled = false;
    if (playbackWrite.inFlight || !playbackWrite.pending) return;
    body = playbackWrite.pending; playbackWrite.pending = null; playbackWrite.inFlight = true;
    api("/api/playback", "PUT", body, function (err) {
      if (settled) return; settled = true; playbackWrite.inFlight = false;
      if (err && !playbackWrite.pending) playbackWrite.pending = body;
      if (!err && playbackWrite.pending) flushPlaybackWrite();
    });
  }
  function loadPlayback() {
    var revision = playbackWrite.revision, token = state.playToken;
    if (nativePlayer && refreshNativePlayback()) return;
    queueLoading.data += 1; updateQueueLoading();
    api("/api/playback", "GET", null, function (err, data) {
      var saved = data && data.snapshot;
      if (err || !saved || !saved.track || state.current || token !== state.playToken || revision !== playbackWrite.revision) { finishQueueData(); return; }
      if (nativePlayer && refreshNativePlayback()) { finishQueueData(); return; }
      state.playMode = saved.mode || "list"; state.playbackList = saved.list || []; state.playbackListSource = saved.listSource || "";
      // Native playback is authoritative on an Android build; seed it with the
      // persisted snapshot before the first play command.
      selectTrack(saved.track, saved.position || 0, saved.duration || 0, false);
      setPlaybackStatus("paused"); renderPlayMode(); syncProgress(); finishQueueData();
    });
  }
  function focusRoot() { var modal = document.getElementById("modal-root"); return !modal.hidden ? modal : state.queueOpen ? document.getElementById("queue-popup") : state.playerOpen ? document.getElementById("player-overlay") : document; }
  function isFocusable(node) { return !!node && document.body.contains(node) && !node.disabled && node.getClientRects().length > 0 && window.getComputedStyle(node).visibility !== "hidden"; }
  function visibleFocusables(root) { var all = (root || document).querySelectorAll(".focusable"), visible = [], i; for (i = 0; i < all.length; i++) if (isFocusable(all[i])) visible.push(all[i]); return visible; }
  function firstFocusable(root) { var all = root.querySelectorAll(".focusable"), i; for (i = 0; i < all.length; i++) if (isFocusable(all[i])) return all[i]; return null; }
  function focusableNearIndex(root, index) {
    var all = root.querySelectorAll(".focusable"), start = Math.max(0, Math.min(index || 0, all.length - 1)), distance;
    for (distance = 0; distance < all.length; distance++) {
      if (isFocusable(all[start + distance])) return all[start + distance];
      if (distance && isFocusable(all[start - distance])) return all[start - distance];
    }
    return null;
  }
  function parentMatch(node, selector, boundary) { while (node && node !== boundary && node !== document) { if (node.matches ? node.matches(selector) : node.webkitMatchesSelector && node.webkitMatchesSelector(selector)) return node; node = node.parentNode; } return null; }
  function activeNav() { return document.querySelector('.nav-item[data-page="' + state.page + '"]') || document.getElementById("nav-recommend"); }
  function bookmark(root) {
    var active = document.activeElement, row, attributes = ["data-playlist-id", "data-search-history", "data-provider", "data-library-tab", "data-category-index", "data-subcat", "data-current-action", "data-mode", "data-comment-index", "data-album-id"], key = {}, i;
    if (!active || !active.classList.contains("focusable") || !root.contains(active)) return null;
    // Remember the DOM position without measuring every row and hidden action.
    // Only a detached return target needs the nearby-visible fallback.
    key.node = active; key.top = root.scrollTop; key.owner = focusRoot(); key.index = Array.prototype.indexOf.call(root.querySelectorAll(".focusable"), active);
    row = parentMatch(active, ".track-row", root);
    if (row && row.id === "recent-current-track") { key.id = row.id; key.action = active.getAttribute("data-action"); }
    else if (row) { key.song = row.getAttribute("data-track-id"); key.action = active.getAttribute("data-action"); key.rowIndex = parseInt(row.getAttribute("data-song"), 10); }
    else if (active.id) key.id = active.id;
    else for (i = 0; i < attributes.length; i++) if (active.hasAttribute(attributes[i])) { key.attribute = attributes[i]; key.value = active.getAttribute(attributes[i]); break; }
    return key;
  }
  function resolveBookmark(root, key) {
    var nodes, i, row, actions;
    if (!key) return null;
    if (root.contains(key.node) && isFocusable(key.node)) return key.node;
    if (key.song != null) { nodes = root.querySelectorAll(".track-row[data-song][data-track-id]"); for (i = 0; i < nodes.length; i++) if (nodes[i].getAttribute("data-track-id") === key.song) { row = nodes[i]; break; } if (!row && nodes.length) row = nodes[Math.min(key.rowIndex || 0, nodes.length - 1)]; if (row && key.action) { actions = row.querySelectorAll("[data-action]"); for (i = 0; i < actions.length; i++) if (actions[i].getAttribute("data-action") === key.action) return actions[i]; } return row || null; }
    if (key.id) { row = document.getElementById(key.id); if (row && root.contains(row) && isFocusable(row)) return key.action ? row.querySelector('[data-action="' + key.action + '"]') || row : row; }
    if (key.attribute) { nodes = root.querySelectorAll("[" + key.attribute + "]"); for (i = 0; i < nodes.length; i++) if (nodes[i].getAttribute(key.attribute) === key.value && isFocusable(nodes[i])) return nodes[i]; }
    return null;
  }
  function restoreBookmark(root, key) {
    var target;
    if (!key || key.owner !== focusRoot() || isFocusable(key.node) || (document.activeElement !== document.body && document.activeElement !== document.documentElement)) return;
    target = resolveBookmark(root, key) || focusableNearIndex(root, key.index);
    root.scrollTop = key.top || 0;
    focusTarget(target || (root === content ? activeNav() : document.getElementById("player-close")));
  }
  function contentEntry() { var key = focusMemory.content[state.page], target = resolveBookmark(content, key); return target || firstFocusable(content) || activeNav(); }
  function focusInitial() { var root = focusRoot(), target; if (root === document) target = activeNav(); else if (state.queueOpen && root.id === "queue-popup") target = root.querySelector(".track-row") || document.getElementById("queue-popup-close"); else target = firstFocusable(root); focusTarget(target); }
  function scrollFocusIntoView(root, target, keepTallPosition) {
    var rootRect, targetRect, top, bottom, padding = 8, next, max;
    if (!root || !target || root.clientHeight <= 0) return;
    rootRect = rectOf(root); targetRect = rectOf(target);
    top = targetRect.top - rootRect.top; bottom = targetRect.bottom - rootRect.top; next = root.scrollTop;
    if (targetRect.height > root.clientHeight - padding * 2) { if (!keepTallPosition || bottom < padding || top > root.clientHeight - padding) next += top - padding; }
    else if (top < padding) next += top - padding;
    else if (bottom > root.clientHeight - padding) next += bottom - (root.clientHeight - padding);
    max = Math.max(0, root.scrollHeight - root.clientHeight); next = Math.max(0, Math.min(max, next));
    if (root.scrollTop !== next) root.scrollTop = next;
  }
  function focusTarget(target) {
    var previous = document.activeElement, node, row, roots = [], positions = [], i, style;
    if (!target || !document.body.contains(target)) return;
    if (target.classList.contains("nav-item")) {
      // Sidebar moves do not need content/player geometry or ancestor styles.
      target.focus(); node = target.parentNode;
      if (node.scrollHeight > node.clientHeight) scrollFocusIntoView(node, target, previous === target);
      return;
    }
    row = parentMatch(target, ".track-row", document);
    node = target.parentNode;
    while (node && node !== document.body) { style = window.getComputedStyle(node); if (/(auto|scroll)/.test(style.overflowY) && node.clientHeight > 0) { roots.push(node); positions.push(node.scrollTop); } node = node.parentNode; }
    if (row && row !== target && window.getComputedStyle(target).visibility === "hidden") row.focus();
    try { target.focus({preventScroll: true}); } catch (ignore) { target.focus(); }
    for (i = 0; i < roots.length; i++) { if (roots[i].scrollTop !== positions[i]) roots[i].scrollTop = positions[i]; if (roots[i].scrollLeft) roots[i].scrollLeft = 0; scrollFocusIntoView(roots[i], row || target, previous === target); }
  }
  function focusQueueTarget(target) { focusTarget(target); }
  function focusRect(node) { var rect = rectOf(node); return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, width: rect.width, height: rect.height}; }
  function nearestFocus(code, active, nodes) {
    var a = focusRect(active), b, horizontal = code === 37 || code === 39, primary, cross, overlap, score, best = null, bestScore = Infinity, i;
    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] === active || active.contains(nodes[i]) || nodes[i].contains(active)) continue;
      b = focusRect(nodes[i]);
      if ((code === 37 && b.centerX >= a.centerX - 1) || (code === 39 && b.centerX <= a.centerX + 1) || (code === 38 && b.centerY >= a.centerY - 1) || (code === 40 && b.centerY <= a.centerY + 1)) continue;
      overlap = horizontal ? b.bottom > a.top + 1 && b.top < a.bottom - 1 : b.right > a.left + 1 && b.left < a.right - 1;
      // Horizontal movement stays on its row; vertical movement chooses the nearest row first.
      if (horizontal && !overlap) continue;
      if (!horizontal && b.bottom > a.top + 1 && b.top < a.bottom - 1) continue;
      primary = horizontal ? Math.abs(b.centerX - a.centerX) : Math.abs(b.centerY - a.centerY);
      cross = horizontal ? Math.abs(b.centerY - a.centerY) : Math.abs(b.centerX - a.centerX);
      score = primary * (horizontal ? 1 : 10) + cross + (overlap ? 0 : 150);
      if (score < bestScore) { best = nodes[i]; bestScore = score; }
    }
    return best;
  }
  function trackCardFocus(code, active) {
    var root = state.queueOpen ? document.getElementById("queue-popup") : content, row = parentMatch(active, ".track-row", root), rows, actions, index, actionIndex, next;
    if (state.queueOpen && active.id === "queue-popup-close") return code === 40 ? root.querySelector(".track-row[data-song]") || active : active;
    if (!row || !root.contains(row)) return null;
    rows = root.querySelectorAll(".track-row[data-song], #recent-current-track"); actions = row.querySelectorAll(".track-actions .focusable");
    index = Array.prototype.indexOf.call(rows, row); actionIndex = Array.prototype.indexOf.call(actions, active);
    if (code === 39) return actions[Math.min(actions.length - 1, actionIndex + 1)] || row;
    if (code === 37) return actionIndex >= 0 ? actions[actionIndex - 1] || row : (state.queueOpen ? row : activeNav());
    next = index + (code === 40 ? 1 : -1);
    if (rows[next]) return rows[next];
    if (state.queueOpen) return code === 38 ? document.getElementById("queue-popup-close") : active;
    if (code === 40) { focusMemory.footerReturn = bookmark(content); return document.getElementById("now-playing"); }
    return nearestFocus(code, row, Array.prototype.filter.call(content.querySelectorAll(".focusable:not(.track-row):not(.track-action)"), isFocusable)) || row;
  }
  function albumCardFocus(code, active) {
    var card = parentMatch(active, ".album-card", content), cards, next;
    if (!card || code !== 40) return null;
    cards = content.querySelectorAll(".album-card"); next = nearestFocus(code, card, cards);
    if (next) return next;
    if (state.detailKind === "artist" && state.artistDetail && state.artistDetail.tab === "albums" && state.artistAlbumsMore && !state.artistAlbumsLoading && !state.artistAlbumsError) loadArtistAlbums(true);
    return card;
  }
  function playerFocusKey(code, active) {
    if (code !== 37 && code !== 38 && code !== 39 && code !== 40 && active.id !== "seek" && active.id !== "overlay-seek") return false;
    var ids = state.playerOpen ? ["player-repeat", "overlay-prev", "overlay-play", "overlay-next", "overlay-queue"] : ["now-playing", "play-mode", "queue-open", "prev", "play", "next"], index = ids.indexOf(active.id), target, comments = document.getElementById("overlay-comments"), toggle = document.getElementById("player-comments-toggle"), comment = state.playerOpen ? parentMatch(active, ".comment", comments) : null, commentEntry = state.playerOpen ? (state.commentsHidden ? toggle : firstFocusable(comments) || comments) : null, nodes, next;
    if (active.id === "seek" || active.id === "overlay-seek") {
      if (code === 37 || code === 39) { seekTo(playbackPosition() + (code === 39 ? 5 : -5)); return true; }
      if (code === 13 || code === 23 || code === 66) return true;
      target = code === 40 ? document.getElementById(state.playerOpen ? "overlay-play" : "play") : (state.playerOpen ? document.getElementById("overlay-favorite") : resolveBookmark(content, focusMemory.footerReturn) || contentEntry());
    } else if (index >= 0) {
      if (code === 37 || code === 39) {
        if (!state.playerOpen && code === 39 && active.id === "next") target = document.getElementById("seek");
        else if (state.playerOpen && code === 39 && index === ids.length - 1) target = commentEntry;
        else target = document.getElementById(ids[Math.max(0, Math.min(ids.length - 1, index + (code === 39 ? 1 : -1)))]);
      } else if (code === 38) target = active.id === "now-playing" ? resolveBookmark(content, focusMemory.footerReturn) || contentEntry() : state.playerOpen ? document.getElementById("overlay-seek") : resolveBookmark(content, focusMemory.footerReturn) || contentEntry();
      else if (code === 40) target = active;
      else return false;
    } else if (state.playerOpen) {
      if (active.id === "player-close") target = code === 39 ? toggle : code === 40 ? document.getElementById("overlay-favorite") : active;
      else if (active === toggle) target = code === 37 ? document.getElementById("player-close") : code === 40 ? (state.commentsHidden ? document.getElementById("overlay-favorite") : commentEntry) : active;
      else if (active.id === "overlay-favorite") target = code === 40 ? document.getElementById("overlay-seek") : code === 39 ? document.getElementById("overlay-artist-info") : code === 38 ? document.getElementById("player-close") : active;
      else if (active.id === "overlay-artist-info") target = code === 37 ? document.getElementById("overlay-favorite") : code === 40 ? document.getElementById("overlay-seek") : code === 39 ? commentEntry : code === 38 ? document.getElementById("player-close") : active;
      else if (comments.contains(active) || active === comments) {
        if (comment && (code === 38 || code === 40)) { var commentRect = rectOf(comment), viewRect = rectOf(comments), oldTop = comments.scrollTop; if (code === 40 && commentRect.bottom > viewRect.bottom - 8) comments.scrollTop += Math.min(comments.clientHeight * .45, commentRect.bottom - viewRect.bottom + 8); else if (code === 38 && commentRect.top < viewRect.top + 8) comments.scrollTop -= Math.min(comments.clientHeight * .45, viewRect.top + 8 - commentRect.top); if (comments.scrollTop !== oldTop) return true; }
        if (code === 37) target = document.getElementById(focusMemory.overlayControl);
        else if (code === 39) target = active;
        else { nodes = visibleFocusables(comments); next = nodes.indexOf(active) + (code === 40 ? 1 : -1); target = nodes[next]; if (!target) { if (code === 40) { loadMoreComments(comments); target = active; } else target = toggle; } }
      } else return false;
    } else return false;
    if (target) focusTarget(target);
    return true;
  }
  function modalFocus(code, active, root) {
    var close = document.getElementById(state.scan ? "scan-close" : state.shareMenu ? "share-close" : "modal-close"), target;
    if (state.scan) { if (active === close) return code === 40 ? document.getElementById("scan-cancel") : active; if (code === 38) return close; }
    else if (state.shareMenu) { if (active === close) return code === 40 ? root.querySelector("[data-share-action]") : active; }
    else { if (active === close) return code === 40 ? root.querySelector(".modal-tabs .is-active") : active; if (active.hasAttribute("data-mode") && code === 38) return close; if (active.id === "auth-user" && code === 38) return root.querySelector(".modal-tabs .is-active"); }
    target = nearestFocus(code, active, visibleFocusables(root)); return target || active;
  }
  function moveFocus(code) {
    var root = focusRoot(), active = document.activeElement, target, navs, index;
    code = {19: 38, 20: 40, 21: 37, 22: 39}[code] || code;
    if (code === 4 || code === 27) { handleBack(); return; }
    if (!isFocusable(active) || !active.classList.contains("focusable") || (root !== document && !root.contains(active))) { focusInitial(); active = document.activeElement; }
    if (!active || !active.classList.contains("focusable")) return;
    if (root === document && active.classList.contains("nav-item") && (code === 38 || code === 40)) {
      navs = visibleFocusables(document.querySelector(".sidebar")); index = navs.indexOf(active);
      target = code === 38 ? navs[Math.max(0, index - 1)] : navs[index + 1] || document.getElementById("now-playing");
      if (code === 40 && index === navs.length - 1) focusMemory.footerReturn = null;
      focusTarget(target); return;
    }
    if (root.id !== "modal-root" && !state.queueOpen && playerFocusKey(code, active)) return;
    if (code === 23 || code === 66 || code === 13) { if (active.click) active.click(); return; }
    if (code !== 37 && code !== 38 && code !== 39 && code !== 40) return;
    if (root.id === "modal-root") target = modalFocus(code, active, root);
    else if (state.queueOpen) target = trackCardFocus(code, active) || active;
    else if (active.classList.contains("nav-item")) {
      navs = visibleFocusables(document.querySelector(".sidebar")); index = navs.indexOf(active);
      if (code === 39) target = contentEntry();
      else if (code === 38) target = navs[Math.max(0, index - 1)];
      else if (code === 40) { target = navs[index + 1] || document.getElementById("now-playing"); if (index === navs.length - 1) focusMemory.footerReturn = null; }
      else target = active;
    } else if (content.contains(active)) {
      target = albumCardFocus(code, active) || trackCardFocus(code, active) || nearestFocus(code, active, Array.prototype.filter.call(content.querySelectorAll(".focusable:not(.track-action)"), isFocusable));
      if (!target && code === 37) target = activeNav();
      if (!target && code === 39) target = active;
      if (!target && code === 40) { focusMemory.footerReturn = bookmark(content); target = document.getElementById("now-playing"); }
    }
    focusTarget(target || active);
  }
  window.MingmingTVKey = moveFocus;
  document.addEventListener("focusin", function (event) {
    var target = event.target;
    if (focusRoot() === document && target.classList.contains("focusable") && content.contains(target)) focusMemory.content[state.page] = bookmark(content);
    if (state.playerOpen && parentMatch(target, ".overlay-controls", document)) focusMemory.overlayControl = target.id;
  });

  function sameSong(a, b) { return !!a && !!b && String(a.id) === String(b.id); }
  function isFavorite(song) { return state.favorites.some(function (item) { return sameSong(item, song); }); }
  function isQueued(song) { return state.queue.some(function (item) { return sameSong(item, song); }); }
  function songDuration(song) { var value = song && (song.dt || song.duration || song.time || song.interval), seconds; if (!value) return "--:--"; if (typeof value === "string" && /^\d+:\d{2}$/.test(value)) return value; seconds = Number(value); if (!isFinite(seconds) || seconds <= 0) return "--:--"; if (song.dt || seconds > 1000) seconds /= 1000; return fmt(seconds); }
  function songActionIcon(name) {
    var attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    if (name === "delete") return '<svg ' + attrs + '><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg>';
    if (name === "favorite") return '<svg ' + attrs + '><path d="M20.8 5.6a5.4 5.4 0 0 0-7.6 0L12 6.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 22l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z"/></svg>';
    if (name === "share") return '<svg ' + attrs + '><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.5-4.4M8.2 13.2l7.5 4.4"/></svg>';
    if (name === "artist-info") return '<svg ' + attrs + '><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.4 3.1-5.2 7-5.2s6.3 1.8 7 5.2"/><circle cx="19" cy="18" r="3"/><path d="M19 16.6v2.8M17.6 18h2.8"/></svg>';
    if (name === "artist") return '<svg ' + attrs + '><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.4 3.1-5.2 7-5.2s6.3 1.8 7 5.2"/></svg>';
    if (name === "album") return '<svg ' + attrs + '><rect x="4" y="4" width="16" height="16" rx="2"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/></svg>';
    if (name === "link") return '<svg ' + attrs + '><path d="M10 13.5 8.2 15.3a3.5 3.5 0 0 1-5-5l2.5-2.5a3.5 3.5 0 0 1 5-.1"/><path d="m14 10.5 1.8-1.8a3.5 3.5 0 1 1 5 5l-2.5 2.5a3.5 3.5 0 0 1-5 .1"/><path d="m8.5 15.5 7-7"/></svg>';
    return '<svg ' + attrs + '><path d="M12 5v14M5 12h14"/></svg>';
  }
  function trackAction(action, icon, label, selected) { return '<button class="track-action focusable' + (selected ? ' is-selected' : '') + '" type="button" data-action="' + action + '" aria-label="' + label + '" title="' + label + '">' + songActionIcon(icon) + '</button>'; }
  function queueTrackAction(song) { var queued = isQueued(song); return trackAction("queue", queued ? "delete" : "queue", queued ? "从播放列表删除" : "加入播放列表", queued); }
  function track(song, index) {
    var favorite = isFavorite(song), actions = trackAction("artist-info", "artist-info", "查看歌手和专辑详情");
    if (state.page === "queue" && state.libraryView === "queue") actions += trackAction("remove-queue", "delete", "从播放列表删除");
    else actions += queueTrackAction(song);
    if (state.page === "favorites") actions += trackAction("remove-favorite", "delete", "从收藏删除");
    else actions += trackAction("favorite", "favorite", favorite ? "取消收藏" : "收藏歌曲", favorite);
    return songRowMarkup(song, index, actions, false);
  }
  function songRowMarkup(song, index, actions, queueView) {
    var current = sameSong(state.current, song);
    return '<div class="track-row focusable' + (queueView ? ' queue-popup-item' : '') + (current ? ' is-current' : '') + '" role="button" tabindex="0" data-song="' + index + '" data-track-id="' + esc(song.id) + '" aria-label="播放 ' + esc(songName(song)) + '">' + (queueView ? '<span class="queue-popup-index">' + (index + 1) + '</span>' : '') + '<img data-cover-song="' + index + '" src="' + esc(cover(song)) + '" alt=""><div class="track-info"><strong>' + esc(songName(song)) + '</strong><span>' + esc(artist(song)) + '</span></div><span class="track-playing" aria-label="当前歌曲"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="equalizer-bar equalizer-bar-one" d="M5 12v8"/><path class="equalizer-bar equalizer-bar-two" d="M12 4v16"/><path class="equalizer-bar equalizer-bar-three" d="M19 8v12"/></svg></span><div class="track-actions">' + actions + '</div>' + (queueView ? '' : '<span class="track-duration">' + songDuration(song) + '</span>') + '</div>';
  }
  function card(song, index) { return '<button class="music-card focusable" data-song="' + index + '"><span class="poster-cover"><img data-cover-song="' + index + '" src="' + esc(cover(song, 300)) + '" alt=""></span><strong>' + esc(songName(song)) + '</strong><span>' + esc(artist(song)) + '</span></button>'; }
  function playlistCard(playlist) { var id = playlist.id || playlist.playlistId || "", title = visibleText(playlist.name || playlist.title || "精选歌单"), creator = visibleText(playlist.creator && playlist.creator.nickname || ""), detail = creator ? creator + " · " : ""; return '<button class="playlist-card focusable" data-playlist-id="' + esc(id) + '" data-playlist-name="' + esc(title) + '"><div class="playlist-cover"><img src="' + esc(sizedArtwork(playlist.coverImgUrl || playlist.cover || "https://picsum.photos/seed/playlist/360/360", 300)) + '" alt=""></div><strong>' + esc(title) + '</strong><small>' + esc(detail + (playlist.trackCount || 0) + ' 首') + '</small></button>'; }
  function rankingDefinitions() { return [
    {id: "3778678", name: "热歌榜", trackCount: 200},
    {id: "3779629", name: "新歌榜", trackCount: 100},
    {id: "19723756", name: "飙升榜", trackCount: 100},
    {id: "2884035", name: "原创榜", trackCount: 100},
    {id: "10520166", name: "电音榜", trackCount: 20},
    {id: "71385702", name: "ACG榜", trackCount: 100},
    {id: "180106", name: "欧美榜", trackCount: 89},
    {id: "60198", name: "Billboard榜", trackCount: 90}
  ]; }
  function hydrateCovers(root, source, pending) {
    function hydrate(image, song) {
      var value = song && song.pic_id;
      if (!song || isUrl(value) || (song.al && isUrl(song.al.picUrl)) || isUrl(song.picUrl) || isUrl(song.coverPath) || !song.id) return;
      if (pending) pending(1);
      api("/api/music/pic", "POST", "id=" + encodeURIComponent(song.id) + "&type=wy", function (err, data) {
        var resolved = data && data.data;
        if (!err && isUrl(resolved)) { song.picUrl = resolved; image.src = sizedArtwork(resolved, parentMatch(image, ".poster-cover", root) ? 300 : 160); }
        if (pending) pending(-1);
      });
    }
    each(root, "img[data-cover-song]", function (image) { var songs = source || state.songs; hydrate(image, songs[parseInt(image.getAttribute("data-cover-song"), 10)]); });
    each(root, "img[data-current-cover]", function (image) { hydrate(image, (source && source[0]) || state.current || state.recent[0]); });
  }
  function bindTrackRowFocus(el) {
    el.addEventListener("focusin", function () { el.classList.add("has-focus"); });
    el.addEventListener("focusout", function () { window.setTimeout(function () { if (!el.contains(document.activeElement)) el.classList.remove("has-focus"); }, 0); });
  }
  function bindSongActions(root, source) {
    each(root, ".track-row[data-song], .music-card[data-song]", function (el) {
      bindTrackRowFocus(el);
      el.addEventListener("click", function (event) {
        var target = event.target, action = null, i, list = source || state.songs;
        while (target && target !== el) { if (target.getAttribute && target.getAttribute("data-action")) { action = target.getAttribute("data-action"); break; } target = target.parentNode; }
        i = parseInt(el.getAttribute("data-song"), 10);
        if (action === "artist-info" || action === "artist-album") { openShareMenu(list[i]); event.stopPropagation(); return; }
        if (action === "queue") { toggleQueue(list[i]); event.stopPropagation(); return; }
        if (action === "favorite") { toggleFavorite(list[i]); event.stopPropagation(); return; }
        if (action === "remove-queue" || action === "remove-favorite") { removeLibrarySong(list[i], action, i); event.stopPropagation(); return; }
        state.playbackList = list.slice(0); state.playbackListSource = state.page === "queue" ? state.libraryView : state.page; play(list[i]);
      });
    });
    hydrateCovers(root, source); updateTrackStates();
  }
  function updateTrackStates() {
    var hero = document.getElementById("recent-current-track"), song = state.current || state.recent[0];
    if (hero && song) { hero.setAttribute("data-track-id", song.id); hero.setAttribute("aria-label", "播放 " + songName(song)); hero.querySelector("strong").textContent = songName(song); hero.querySelector(".recent-hero-info>span:last-child").textContent = artist(song); hero.querySelector("img").src = cover(song); }
    each(document, ".track-row[data-track-id]", function (row) {
      var current = state.current && row.getAttribute("data-track-id") === String(state.current.id), button = row.querySelector('[data-action="favorite"]'), favorite = state.favorites.some(function (song) { return String(song.id) === row.getAttribute("data-track-id"); }), queueButton = row.querySelector('[data-action="queue"]'), queued = isQueued({id: row.getAttribute("data-track-id")}), time = row.querySelector(".track-duration"), queueLabel = queued ? "从播放列表删除" : "加入播放列表";
      row.classList.toggle("is-current", !!current);
      row.classList.toggle("is-playing", !!current && state.playbackStatus === "playing");
      if (button) { button.classList.toggle("is-selected", favorite); button.title = favorite ? "取消收藏" : "收藏歌曲"; button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", favorite ? "true" : "false"); }
      if (queueButton) { queueButton.classList.toggle("is-selected", queued); queueButton.title = queueLabel; queueButton.setAttribute("aria-label", queueLabel); if (queueButton.getAttribute("aria-pressed") !== (queued ? "true" : "false")) queueButton.innerHTML = songActionIcon(queued ? "delete" : "queue"); queueButton.setAttribute("aria-pressed", queued ? "true" : "false"); }
      if (current && time && state.current.dt) time.textContent = songDuration(state.current);
    });
    renderOverlayFavorite(); renderQueueButton();
  }
  function restoreLibraryFocus(index, scrollTop) {
    var rows = content.querySelectorAll(".track-row[data-song]"), target = rows[Math.min(index, rows.length - 1)] || content.querySelector(".tab.focusable") || document.querySelector('.nav-item[data-page="' + state.page + '"]');
    content.scrollTop = scrollTop;
    if (target) { target.focus(); scrollFocusIntoView(content, target); }
  }
  function removeLibrarySong(song, action, index) {
    var scrollTop = content.scrollTop;
    if (action === "remove-queue") { removeQueuedSong(song); renderQueue(); }
    else { state.favorites = state.favorites.filter(function (item) { return !sameSong(item, song); }); renderFavorites(); }
    restoreLibraryFocus(index, scrollTop); saveLibrary();
  }
  function removeQueuedSong(song) {
    state.queue = state.queue.filter(function (item) { return !sameSong(item, song); });
    if (state.playbackListSource === "queue") state.playbackList = state.queue.slice(0);
    renderQueueButton(); document.getElementById("queue-count").textContent = state.queue.length;
    updateTrackStates();
  }
  function restorePlaylistReturn(root) {
    var pending = state.returnPlaylist;
    if (!pending) return;
    if (focusRoot() !== document || state.page !== pending.page || document.activeElement !== pending.anchor) { state.returnPlaylist = null; return; }
    each(root, "[data-playlist-id]", function (el) { if (el.getAttribute("data-playlist-id") === pending.id) { state.returnPlaylist = null; focusTarget(el); } });
  }
  function bindPlaylistActions(root, backPage) { each(root, "[data-playlist-id]", function (el) { el.addEventListener("click", function () { loadPlaylistDetail(el.getAttribute("data-playlist-id"), el.getAttribute("data-playlist-name"), backPage || "recommend"); }); }); restorePlaylistReturn(root); }


  function catalogueGroups(data) { var names = ["语种", "风格", "场景", "情感", "主题"], groups = [], sub = data && data.sub || [], i, cat, found = -1; for (i = 0; i < names.length; i++) groups.push({name: names[i], items: []}); for (i = 0; i < sub.length; i++) { cat = parseInt(sub[i].category, 10); if (cat >= 0 && cat < groups.length) groups[cat].items.push(sub[i].name); } for (i = 0; i < groups.length; i++) if (!groups[i].items.length) groups[i].items = i === 0 ? ["华语", "欧美", "日语", "韩语", "粤语"] : ["热门"]; for (i = 0; i < groups.length; i++) if (groups[i].items.indexOf(state.activeCat) >= 0) { found = i; break; } if (found < 0) { found = 0; state.activeCat = groups[0].items[0]; } state.categoryIndex = found; return groups; }

  function renderCategoryControls() { var tabs = "", subs = "", i, group = state.catalogue[state.categoryIndex] || {items: []}; for (i = 0; i < state.catalogue.length; i++) tabs += '<button class="category-tab focusable' + (i === state.categoryIndex ? ' is-active' : '') + '" data-category-index="' + i + '">' + esc(state.catalogue[i].name) + '</button>'; for (i = 0; i < group.items.length; i++) subs += '<button class="subcat-tab focusable' + (group.items[i] === state.activeCat ? ' is-active' : '') + '" data-subcat="' + esc(group.items[i]) + '">' + esc(group.items[i]) + '</button>'; return '<div class="category-tabs">' + tabs + '</div><div class="subcategory-tabs">' + subs + '</div>'; }
  function bindCategoryControls() { each(content, "[data-category-index]", function (button) { button.addEventListener("click", function () { state.categoryIndex = parseInt(button.getAttribute("data-category-index"), 10); state.activeCat = state.catalogue[state.categoryIndex].items[0]; renderRecommendBody(); }); }); each(content, "[data-subcat]", function (button) { button.addEventListener("click", function () { state.activeCat = button.getAttribute("data-subcat"); renderRecommendBody(); }); }); }
  function renderPlaylistGrid(items, error) { var box = document.getElementById("recommend-playlists"); if (!box) return; state.playlists = items || []; box.innerHTML = error ? '<div class="state error">' + esc(error.message) + '</div>' : (state.playlists.length ? state.playlists.map(playlistCard).join("") : '<div class="empty">暂无该分类歌单</div>'); bindPlaylistActions(box, "recommend"); }
  function loadRecommendPlaylists() { var cat = state.activeCat, requestBox = document.getElementById("recommend-playlists"), box = document.getElementById("recommend-playlists"); if (box) box.innerHTML = '<div class="state">正在加载歌单…</div>'; api("/api/netease/catplaylists?cat=" + encodeURIComponent(state.activeCat) + "&offset=0&limit=20&order=hot", "GET", null, function (err, data) { if (state.page !== "recommend" || state.detailReturn || state.activeCat !== cat || requestBox !== document.getElementById("recommend-playlists")) return; renderPlaylistGrid(data && (data.playlists || data.data || data.items) || [], err); }); }
  function renderRecommendBody() { var savedFocus = bookmark(content), heading = document.getElementById("recommend-controls"); if (!heading) return; heading.innerHTML = renderCategoryControls(); bindCategoryControls(); loadRecommendPlaylists(); var section = document.querySelector(".recommend-heading"); if (section) section.textContent = "热门歌单 · " + state.activeCat; restoreBookmark(content, savedFocus); }
  function renderRecommend() { var request = (state.recommendRequest || 0) + 1; state.recommendRequest = request; renderState("正在加载推荐内容…"); api("/api/netease/catalogue", "GET", null, function (catalogErr, catalogue) { if (state.page !== "recommend" || state.detailReturn || request !== state.recommendRequest) return; state.catalogue = catalogueGroups(catalogue); content.innerHTML = pageTitle("今日推荐", "发现适合大屏聆听的音乐") + '<div id="recommend-controls">' + renderCategoryControls() + '</div><div class="section-heading"><h2 class="recommend-heading">热门歌单 · ' + esc(state.activeCat) + '</h2></div><div id="recommend-playlists" class="playlist-grid"><div class="state">正在加载歌单…</div></div>'; bindCategoryControls(); loadRecommendPlaylists(); if (catalogErr) { var label = document.getElementById("connection-label"); if (label) label.textContent = "部分推荐暂不可用"; } }); }

  function bindSearchProviders() { each(content, "[data-provider]", function (button) { button.addEventListener("click", function () { var query; state.searchProvider = button.getAttribute("data-provider") || "wy"; each(content, "[data-provider]", function (item) { item.classList.toggle("is-active", item.getAttribute("data-provider") === state.searchProvider); item.setAttribute("aria-pressed", item.getAttribute("data-provider") === state.searchProvider ? "true" : "false"); }); query = (document.getElementById("search-input") || {}).value || ""; if (query) doSearch(query, false); }); }); }
  function loadSearchHistory() { var raw, parsed, clean = [], i, value; try { raw = window.localStorage.getItem("mingming.searchHistory"); parsed = raw ? JSON.parse(raw) : []; } catch (ignore) { parsed = []; } if (!Array.isArray(parsed)) parsed = []; for (i = 0; i < parsed.length && clean.length < 10; i++) { value = String(parsed[i] || "").replace(/^\s+|\s+$/g, ""); if (value && clean.indexOf(value) < 0) clean.push(value); } state.searchHistory = clean; }
  function saveSearchHistory() { try { window.localStorage.setItem("mingming.searchHistory", JSON.stringify(state.searchHistory.slice(0, 10))); } catch (ignore) {} }
  function renderSearchHistory() { var savedFocus = bookmark(content), box = document.getElementById("search-history"), html = "", i, active = document.activeElement, activeQuery = active && active.getAttribute ? active.getAttribute("data-search-history") : ""; if (!box) return; html = '<div class="search-history-head"><h2>搜索历史</h2><button id="clear-search-history" class="link-button focusable" type="button"' + (state.searchHistory.length ? "" : " disabled") + '>清空</button></div>'; if (!state.searchHistory.length) html += '<div class="search-history-empty">暂无搜索历史</div>'; else { html += '<div class="search-history-list">'; for (i = 0; i < state.searchHistory.length; i++) html += '<button class="search-history-item focusable" type="button" data-search-history="' + esc(state.searchHistory[i]) + '">' + esc(state.searchHistory[i]) + '</button>'; html += '</div>'; } box.innerHTML = html; each(box, "[data-search-history]", function (button) { button.addEventListener("click", function () { var input = document.getElementById("search-input"), query = button.getAttribute("data-search-history") || ""; if (input) input.value = query; doSearch(query, false); }); }); document.getElementById("clear-search-history").addEventListener("click", function () { state.searchHistory = []; saveSearchHistory(); renderSearchHistory(); focusTarget(document.getElementById("search-input")); }); restoreBookmark(content, savedFocus); }
  function rememberSearch(query) { var next = [query], i; for (i = 0; i < state.searchHistory.length && next.length < 10; i++) if (state.searchHistory[i] !== query) next.push(state.searchHistory[i]); state.searchHistory = next; saveSearchHistory(); renderSearchHistory(); }
  function searchItems(data) { var items = data && (data.data || data.items || data.result || data.songs) || []; if (items && items.songs) items = items.songs; return Array.isArray(items) ? items : []; }
  function searchMoreFlag(data, items) { var payload = data && data.data && !Array.isArray(data.data) ? data.data : data; if (payload && typeof payload.more === "boolean") return payload.more; if (payload && typeof payload.hasMore === "boolean") return payload.hasMore; return items.length >= state.searchPageSize; }
  function mergeSearchItems(items, append) { var result = append ? state.songs.slice(0) : [], seen = {}, i, key; for (i = 0; i < result.length; i++) { key = String(result[i] && (result[i].id || result[i].songmid || result[i].hash || i)); seen[key] = true; } for (i = 0; i < items.length; i++) { key = String(items[i] && (items[i].id || items[i].songmid || items[i].hash || (result.length + i))); if (!seen[key]) { seen[key] = true; result.push(items[i]); } } return result; }
  function renderSearchResults(box, message) { var savedFocus = bookmark(content), more = document.getElementById("search-more"), html = message ? '<div class="state error">' + esc(message) + '</div>' : (state.songs.length ? state.songs.map(track).join("") : '<div class="empty">没有找到相关歌曲</div>'); box.innerHTML = html; if (more) more.innerHTML = state.searchLoading ? "正在加载更多…" : (state.searchMore ? "继续下滚加载更多" : (state.songs.length ? "没有更多结果" : "")); bindSongActions(box); restoreBookmark(content, savedFocus); }
  function bindSearchPagination() { if (content.getAttribute("data-search-scroll-bound")) return; content.setAttribute("data-search-scroll-bound", "true"); content.addEventListener("scroll", function () { if (state.page !== "search" || state.searchLoading || !state.searchMore || !state.searchQuery) return; if (content.scrollTop + content.clientHeight >= content.scrollHeight - 180) doSearch(state.searchQuery, true); }); }
  function renderSearch() { content.scrollTop = 0; content.innerHTML = pageTitle("搜索音乐", "网易云 · QQ · 酷狗") + '<form class="search-bar" id="search-form"><input id="search-input" class="focusable" placeholder="搜索歌曲、歌手或专辑" autocomplete="off"><button class="primary focusable">搜索</button><button id="search-scan" class="scan-button focusable" type="button">' + scanIcon() + '<span>扫码搜索</span></button></form><div class="tabs"><button class="tab' + (state.searchProvider === "wy" ? ' is-active' : '') + ' focusable" data-provider="wy" aria-pressed="' + (state.searchProvider === "wy" ? 'true' : 'false') + '">网易云</button><button class="tab' + (state.searchProvider === "qq" ? ' is-active' : '') + ' focusable" data-provider="qq" aria-pressed="' + (state.searchProvider === "qq" ? 'true' : 'false') + '">QQ 音乐</button><button class="tab' + (state.searchProvider === "kg" ? ' is-active' : '') + ' focusable" data-provider="kg" aria-pressed="' + (state.searchProvider === "kg" ? 'true' : 'false') + '">酷狗音乐</button></div><section id="search-history" class="search-history" aria-label="搜索历史"></section><div id="search-results" class="track-list search-results"><div class="empty">输入关键词开始搜索</div></div><div id="search-more" class="search-more" aria-live="polite"></div>'; document.getElementById("search-scan").addEventListener("click", function () { openScan("search"); }); bindSearchProviders(); renderSearchHistory(); bindSearchPagination(); document.getElementById("search-form").addEventListener("submit", function (e) { e.preventDefault(); doSearch(document.getElementById("search-input").value, false); }); }
  function doSearch(q, append) { var box, provider, page, request, query = String(q || "").replace(/^\s+|\s+$/g, ""); if (!query) return; box = document.getElementById("search-results"); provider = state.searchProvider || "wy"; if (!box || (append && state.searchLoading) || (append && (!state.searchMore || query !== state.searchQuery))) return; if (!append) { state.searchQuery = query; state.searchPage = 0; state.searchMore = true; state.songs = []; state.searchRequest += 1; rememberSearch(query); box.innerHTML = '<div class="state">正在搜索…</div>'; } page = append ? state.searchPage + 1 : 1; request = state.searchRequest; state.searchLoading = true; if (append) { var moreBox = document.getElementById("search-more"); if (moreBox) moreBox.textContent = "正在加载更多…"; } api("/api/music/search", "POST", "name=" + encodeURIComponent(query) + "&type=" + encodeURIComponent(provider) + "&page=" + page + "&limit=" + state.searchPageSize + "&format=1", function (err, data) { var items; if (request !== state.searchRequest || state.page !== "search") return; state.searchLoading = false; if (err) { state.searchMore = !!append; if (!append) renderSearchResults(box, err.message); else { var errorBox = document.getElementById("search-more"); if (errorBox) errorBox.textContent = "加载更多失败，请继续下滚重试"; } return; } items = searchItems(data); state.songs = mergeSearchItems(items, append); state.searchPage = page; state.searchMore = searchMoreFlag(data, items); renderSearchResults(box); }); }
  function extractTracks(data) { var payload = data && data.data || data || {}; if (payload.playlist && payload.playlist.tracks) return payload.playlist.tracks; if (payload.tracks) return payload.tracks; return []; }
  function loadPlaylistDetail(id, name, backPage) {
    var origin = document.activeElement, request = {page: backPage || "recommend", id: id, attempt: 0}; state.detailReturn = request; focusMemory.content[state.page] = null; content.scrollTop = 0;
    content.innerHTML = pageTitle(name || "歌单", "歌曲列表") + '<div id="playlist-detail-body" class="track-list"><div class="state">正在加载歌曲…</div></div>';
    function fetch(attempt) {
      var box = document.getElementById("playlist-detail-body");
      if (!box || state.detailReturn !== request) return;
      request.attempt = attempt;
      box.innerHTML = '<div class="state">' + (attempt ? '正在重试加载歌曲…' : '正在加载歌曲…') + '</div>';
      api("/api/music/list", "POST", "id=" + encodeURIComponent(id) + "&type=wy", function (err, data) {
        var first;
        if (state.detailReturn !== request || request.attempt !== attempt) return;
        if (err && attempt === 0) { fetch(1); return; }
        box = document.getElementById("playlist-detail-body"); if (!box) return;
        state.songs = extractTracks(data); box.innerHTML = err ? '<div class="state error">' + esc(err.message) + '<button id="playlist-detail-retry" class="link-button focusable" type="button">重试</button></div>' : (state.songs.length ? state.songs.map(track).join("") : '<div class="empty">暂无歌曲</div>'); bindSongActions(box);
        if (err) { document.getElementById("playlist-detail-retry").addEventListener("click", function () { fetch(0); }); return; }
        first = box.querySelector(".track-row"); if (first && focusRoot() === document && (document.activeElement === document.body || document.activeElement === origin)) focusTarget(first);
      });
    }
    fetch(0);
  }

  function firstArtist(song) { var list = song && (song.ar || song.artists), item; if (list && list.length) { item = list[0]; return typeof item === "string" ? {name: item} : item; } return {name: artist(song)}; }
  function artistId(song) { var item = firstArtist(song); return item && (item.id || song && (song.artistId || song.artist_id)); }
  function albumId(song) { var value = song && (song.al || song.album); return value && typeof value === "object" ? (value.id || value.albumId) : song && (song.albumId || song.album_id); }
  function formatDate(value) { var date; if (!value) return "未知日期"; date = new Date(Number(value)); return isFinite(date.getTime()) ? date.getFullYear() + "-" + (date.getMonth() + 1 < 10 ? "0" : "") + (date.getMonth() + 1) + "-" + (date.getDate() < 10 ? "0" : "") + date.getDate() : "未知日期"; }
  function restoreDetailSource(source) {
    var target, page = source && source.page || "recommend", shareSong = source && source.share ? source.song : null, playerInfo;
    state.detailKind = ""; state.detailReturn = null; state.artistDetail = null; state.albumDetail = null;
    renderPage(page);
    if (page === "search" && state.searchQuery) renderSearchResults(document.getElementById("search-results"));
    target = source && source.trackId ? content.querySelector('.track-row[data-track-id="' + esc(source.trackId) + '"]') : null;
    if (target && source.action) target = target.querySelector('[data-action="' + esc(source.action) + '"]') || target;
    if (target) focusTarget(target);
    if (shareSong) {
      // Details opened from the fullscreen poster must return to that same
      // player context. Re-open it before the share modal so Back first
      // restores the modal's originating artist/album action.
      if (source.player && state.current && sameSong(state.current, shareSong)) {
        openPlayerOverlay();
        playerInfo = document.getElementById("overlay-artist-info");
        if (playerInfo) playerInfo.focus();
      }
      openShareMenu(shareSong);
    }
  }
  function openShareMenu(song) {
    var root = document.getElementById("modal-root"), previous = document.activeElement, html;
    if (!root || !song) return;
    state.shareMenu = {song: song, previous: previous}; state.modalPreviousFocus = previous; root.hidden = false; root.removeAttribute("data-exit-dialog");
    html = '<div class="modal share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title"><button id="share-close" class="modal-close focusable" type="button" aria-label="关闭">×</button><h2 id="share-title">' + esc(songName(song)) + '</h2><p class="share-subtitle">' + esc(artist(song)) + ' · ' + esc(album(song)) + '</p><div class="share-actions"><button class="share-action focusable" data-share-action="artist" type="button">' + songActionIcon("artist") + '<span>歌手详情</span></button><button class="share-action focusable" data-share-action="album" type="button">' + songActionIcon("album") + '<span>专辑详情</span></button></div></div>';
    root.innerHTML = html; syncCommentMotion();
    document.getElementById("share-close").addEventListener("click", closeShareMenu);
    each(root, "[data-share-action]", function (button) { button.addEventListener("click", function () { var action = button.getAttribute("data-share-action"); if (action === "artist") openArtistDetail(song); else if (action === "album") openAlbumDetail(song); }); });
    var first = root.querySelector("[data-share-action]"); if (first) first.focus();
  }
  function findNeteaseSong(data, sourceSong) {
    var result = data && data.result, songs = result && result.songs || [], wantedName = songName(sourceSong), wantedArtist = artist(sourceSong), i, item, names, j;
    for (i = 0; i < songs.length; i++) {
      item = songs[i]; names = item && (item.artists || item.ar);
      if (songName(item) !== wantedName) continue;
      if (!wantedArtist || !names || !names.length) return item;
      for (j = 0; j < names.length; j++) if (String(names[j] && names[j].name || names[j]) === wantedArtist) return item;
    }
    return songs[0] || null;
  }
  function resolveNeteaseSong(sourceSong, done) {
    var query = songName(sourceSong) || artist(sourceSong);
    if (!query) { done(null); return; }
    api("/api/netease/search?keyword=" + encodeURIComponent(query), "GET", null, function (err, data) { done(err ? null : findNeteaseSong(data, sourceSong)); });
  }
  function loadArtistById(id, source, song) {
    api("/api/netease/artist?id=" + encodeURIComponent(id), "GET", null, function (err, data) {
      if (state.detailKind !== "artist" || state.detailReturn !== source) return;
      if (err || !data || !data.artist) { renderState((err && err.message) || "歌手详情加载失败", true); return; }
      renderArtistDetail(data, song);
    });
  }
  function closeShareMenu(restore) {
    var root = document.getElementById("modal-root"), previous = state.shareMenu && state.shareMenu.previous;
    if (!state.shareMenu) return;
    state.shareMenu = null; state.modalPreviousFocus = null; root.hidden = true; root.innerHTML = ""; syncCommentMotion();
    if (restore !== false && previous && document.body.contains(previous)) focusTarget(previous);
  }
  function openArtistDetail(song) {
    var id = artistId(song), fromPlayer = state.playerOpen, source = {kind: "source", page: state.page === "queue" ? "queue" : state.page, trackId: String(song.id), action: "artist-info", rowIndex: parseInt((document.activeElement && document.activeElement.parentNode && document.activeElement.parentNode.getAttribute("data-song")) || 0, 10), share: true, player: fromPlayer, song: song};
    closeShareMenu(false); state.detailKind = "artist"; state.detailReturn = source; content.scrollTop = 0; renderState("正在加载歌手详情…");
    if (fromPlayer) closePlayerOverlay();
    if (id) loadArtistById(id, source, song);
    else resolveNeteaseSong(song, function (resolved) {
      var resolvedID = artistId(resolved);
      if (resolved) { song.ar = resolved.artists || resolved.ar; song.artists = resolved.artists || resolved.ar; song.al = resolved.album || resolved.al; song.album = resolved.album || resolved.album; }
      if (resolvedID) loadArtistById(resolvedID, source, song); else renderState("未找到该歌曲的歌手详情", true);
    });
  }
  function artistTabs(active) { return '<div class="detail-tabs"><button id="artist-hot-tab" class="tab focusable' + (active === "hot" ? ' is-active' : '') + '" type="button">热门歌曲</button><button id="artist-albums-tab" class="tab focusable' + (active === "albums" ? ' is-active' : '') + '" type="button">专辑</button></div>'; }
  function artistHero(data) { var a = data.artist || {}, songs = Number(a.musicSize) || 0, albums = Number(a.albumSize) || 0, image = a.picUrl || a.img1v1Url; return '<section class="detail-hero artist-hero"><img src="' + esc(isUrl(image) ? sizedArtwork(image, 300) : cover(null)) + '" alt="' + esc(a.name || "歌手") + '"><div class="detail-hero-copy"><span class="detail-eyebrow">歌手详情</span><h1>' + esc(a.name || "未知歌手") + '</h1><p>' + esc(songs) + ' 首歌曲 · ' + esc(albums) + ' 张专辑</p>' + (a.alias && a.alias.length ? '<small>' + esc(a.alias.join(" · ")) + '</small>' : '') + '</div></section>'; }
  function detailBackButton() { return nativeApp ? "" : '<button id="detail-back" class="back-button focusable" type="button">返回</button>'; }
  function bindDetailBack() { var button = document.getElementById("detail-back"); if (button) button.addEventListener("click", handleBack); }
  function renderArtistDetail(data, sourceSong) {
    var a = data.artist || {}, songs = data.hotSongs || [], active = state.artistDetail && state.artistDetail.tab || "hot";
    state.artistDetail = {data: data, sourceSong: sourceSong, artistId: a.id, tab: active};
    content.innerHTML = detailBackButton() + artistHero(data) + artistTabs(active) + '<div id="artist-detail-body"></div>';
    bindArtistDetail(); renderArtistDetailBody(); focusTarget(document.getElementById("detail-back") || document.getElementById(active === "albums" ? "artist-albums-tab" : "artist-hot-tab"));
  }
  function bindArtistDetail() {
    bindDetailBack();
    document.getElementById("artist-hot-tab").addEventListener("click", function () { state.artistDetail.tab = "hot"; renderArtistDetail(state.artistDetail.data, state.artistDetail.sourceSong); });
    document.getElementById("artist-albums-tab").addEventListener("click", function () { state.artistDetail.tab = "albums"; state.artistAlbums = []; state.artistAlbumsOffset = 0; state.artistAlbumsMore = true; state.artistAlbumsError = ""; renderArtistDetail(state.artistDetail.data, state.artistDetail.sourceSong); loadArtistAlbums(false); });
  }
  function albumCard(item) { var image = item.picUrl || item.blurPicUrl; return '<button class="album-card focusable" type="button" data-album-id="' + esc(item.id) + '"><span class="poster-cover"><img src="' + esc(isUrl(image) ? sizedArtwork(image, 300) : cover(null)) + '" alt=""></span><strong>' + esc(item.name || "未命名专辑") + '</strong><span>' + esc(item.publishTime ? String(new Date(Number(item.publishTime)).getFullYear()) : "未知年份") + ' · ' + esc(item.size || 0) + ' 首</span></button>'; }
  function renderArtistDetailBody() {
    var box = document.getElementById("artist-detail-body"), detail = state.artistDetail, songs, html, savedFocus, scrollTop;
    if (!box || !detail) return;
    savedFocus = bookmark(content); scrollTop = content.scrollTop;
    if (detail.tab === "albums") {
      html = '<div class="detail-list-heading"><h2>全部专辑</h2><span>' + esc(state.artistAlbums.length ? state.artistAlbums.length + " 张已加载" : "下滑自动加载") + '</span></div><div id="artist-album-grid" class="album-grid">' + (state.artistAlbums.length ? state.artistAlbums.map(albumCard).join("") : '<div class="state">' + (state.artistAlbumsError ? esc(state.artistAlbumsError) : '正在加载专辑…') + '</div>') + '</div><div class="detail-pagination">' + (state.artistAlbumsError ? '<button id="artist-albums-retry" class="secondary-button focusable" type="button">重试加载</button>' : state.artistAlbumsLoading ? '<span>正在加载更多…</span>' : state.artistAlbumsMore ? '<span>继续下滑加载更多专辑</span>' : '<span>已显示全部专辑</span>') + '</div>';
      box.innerHTML = html;
      each(box, "[data-album-id]", function (button) { button.addEventListener("click", function () { openAlbumDetail({id: button.getAttribute("data-album-id"), album: {id: button.getAttribute("data-album-id"), name: button.querySelector("strong").textContent}, artist: detail.data.artist}); }); });
      if (document.getElementById("artist-albums-retry")) document.getElementById("artist-albums-retry").addEventListener("click", function () { state.artistAlbumsError = ""; loadArtistAlbums(true); });
    } else {
      songs = detail.data.hotSongs || [];
      html = '<div class="detail-list-heading"><h2>热门歌曲</h2><span>' + esc(songs.length + " 首") + '</span><button id="artist-play-hot" class="primary detail-play-hot focusable" type="button">' + controlIcon("play") + '<span>播放热门</span></button></div>' + (songs.length ? '<div class="track-list">' + songs.map(track).join("") + '</div>' : '<div class="empty">暂无热门歌曲</div>');
      box.innerHTML = html; bindSongActions(box, songs);
      document.getElementById("artist-play-hot").addEventListener("click", function () { if (songs.length) { state.playbackList = songs.slice(0); state.playbackListSource = "artist"; play(songs[0]); } });
    }
    if (savedFocus) restoreBookmark(content, savedFocus); else content.scrollTop = scrollTop;
  }
  function loadArtistAlbums(append) {
    var detail = state.artistDetail, offset = append ? state.artistAlbumsOffset : 0, id, requestId;
    if (!detail || state.artistAlbumsLoading || (append && (!state.artistAlbumsMore || state.artistAlbumsError))) return;
    id = detail.artistId; requestId = ++state.artistAlbumsRequest; state.artistAlbumsLoading = true; state.artistAlbumsError = ""; renderArtistDetailBody();
    api("/api/netease/artist/albums?id=" + encodeURIComponent(id) + "&offset=" + offset + "&limit=30", "GET", null, function (err, data) {
      var items = data && (data.hotAlbums || data.albums || data.data) || [];
      if (state.detailKind !== "artist" || state.artistDetail !== detail || requestId !== state.artistAlbumsRequest) return;
      state.artistAlbumsLoading = false;
      if (err) { state.artistAlbumsError = (err && err.message) || "专辑加载失败，请重试"; renderArtistDetailBody(); return; }
      if (!append) state.artistAlbums = [];
      state.artistAlbums = state.artistAlbums.concat(items); state.artistAlbumsOffset = offset + items.length;
      state.artistAlbumsMore = data && typeof data.more === "boolean" ? data.more : items.length >= 30; state.artistAlbumsError = ""; renderArtistDetailBody();
    });
  }
  function maybeLoadArtistAlbums() {
    if (state.detailKind !== "artist" || !state.artistDetail || state.artistDetail.tab !== "albums" || !state.artistAlbumsMore || state.artistAlbumsLoading || state.artistAlbumsError || content.clientHeight <= 0) return;
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - Math.max(240, content.clientHeight * .55)) loadArtistAlbums(true);
  }
  function bindArtistAlbumsScroll() {
    if (content.getAttribute("data-artist-albums-scroll-bound")) return;
    content.setAttribute("data-artist-albums-scroll-bound", "true"); content.addEventListener("scroll", maybeLoadArtistAlbums);
  }
  function openAlbumDetail(song) {
    var id = albumId(song), fromPlayer = state.playerOpen, parent = state.detailKind === "artist" && state.artistDetail ? {kind: "artist", detail: state.artistDetail, albums: state.artistAlbums.slice(0), offset: state.artistAlbumsOffset, more: state.artistAlbumsMore, source: state.detailReturn, albumId: String(id || song.id)} : state.detailReturn;
    var source = parent && parent.kind === "artist" ? parent : {kind: "source", page: state.page, trackId: String(song.id), action: "artist-info", share: true, player: fromPlayer, song: song};
    function load(id) { api("/api/netease/album?id=" + encodeURIComponent(id), "GET", null, function (err, data) { if (state.detailKind !== "album" || state.detailReturn !== source) return; if (err || !data || !(data.album || data.songs)) { renderState((err && err.message) || "专辑详情加载失败", true); return; } renderAlbumDetail(data); }); }
    closeShareMenu(false); state.detailKind = "album"; state.detailReturn = source; content.scrollTop = 0; renderState("正在加载专辑详情…");
    if (fromPlayer) closePlayerOverlay();
    if (id) load(id);
    else resolveNeteaseSong(song, function (resolved) {
      var resolvedID = albumId(resolved);
      if (resolved) { song.al = resolved.album || resolved.al; song.album = resolved.album || resolved.al; }
      if (resolvedID) load(resolvedID); else renderState("未找到该歌曲的专辑详情", true);
    });
  }
  function renderAlbumDetail(data) {
    var a = data.album || {}, songs = data.songs || [], artistName = a.artist && a.artist.name || (a.artists && a.artists[0] && a.artists[0].name) || "未知歌手", image = a.picUrl || a.blurPicUrl;
    state.albumDetail = {data: data, songs: songs};
    content.innerHTML = detailBackButton() + '<section class="detail-hero album-hero"><img src="' + esc(isUrl(image) ? sizedArtwork(image, 300) : cover(null)) + '" alt="' + esc(a.name || "专辑") + '"><div class="detail-hero-copy"><span class="detail-eyebrow">专辑详情</span><h1>' + esc(a.name || "未命名专辑") + '</h1><p>' + esc(artistName) + ' · ' + esc(formatDate(a.publishTime)) + ' · ' + esc(a.size || songs.length) + ' 首</p><small>' + esc((a.description || "").replace(/\s+/g, " ").slice(0, 180)) + '</small></div></section><div class="detail-list-heading"><h2>专辑歌曲</h2><span>' + esc(songs.length) + ' 首</span><button id="album-play" class="primary detail-play-hot focusable" type="button">' + controlIcon("play") + '<span>播放专辑</span></button></div><div id="album-detail-body" class="track-list">' + (songs.length ? songs.map(track).join("") : '<div class="empty">暂无歌曲</div>') + '</div>';
    bindDetailBack();
    document.getElementById("album-play").addEventListener("click", function () { if (songs.length) { state.playbackList = songs.slice(0); state.playbackListSource = "album"; play(songs[0]); } });
    bindSongActions(document.getElementById("album-detail-body"), songs); focusTarget(document.getElementById("detail-back") || document.getElementById("album-play"));
  }

  function renderRankingCards(items) { var savedFocus = bookmark(content), box = document.getElementById("playlist-body"); if (!box) return; box.innerHTML = items.map(playlistCard).join(""); bindPlaylistActions(box, "playlists"); restoreBookmark(content, savedFocus); }
  function loadRanking() { var requestBox = document.getElementById("playlist-body"), definitions = rankingDefinitions(), pending = definitions.length, i; renderRankingCards(definitions); for (i = 0; i < definitions.length; i++) (function (index) { api("/api/music/list", "POST", "id=" + encodeURIComponent(definitions[index].id) + "&type=wy", function (err, data) { var playlist = data && data.data && data.data.playlist; if (!err && playlist) { definitions[index] = {id: String(playlist.id || definitions[index].id), name: playlist.name || definitions[index].name, coverImgUrl: playlist.coverImgUrl || "", trackCount: playlist.trackCount || definitions[index].trackCount, creator: {nickname: ""}}; } pending -= 1; if (!pending && state.page === "playlists" && !state.detailReturn && requestBox === document.getElementById("playlist-body")) renderRankingCards(definitions); }); }(i)); }
  function renderPlaylists() { content.innerHTML = pageTitle("排行榜", "官方榜单") + '<div id="playlist-body" class="playlist-grid"><div class="state">正在加载排行榜…</div></div>'; loadRanking(); }
  function renderInspiration() { content.innerHTML = pageTitle("灵感音乐", "来自音乐广场的声音") + '<div id="inspiration-body" class="card-grid"><div class="state">正在加载灵感音乐…</div></div>'; api("/api/aimusic/square?limit=50", "GET", null, function (err, data) { state.songs = data && (data.list || data.data || data.items || []) || []; var box = document.getElementById("inspiration-body"); box.innerHTML = err ? '<div class="state error">' + esc(err.message) + '</div>' : (state.songs.length ? state.songs.map(card).join("") : '<div class="empty">暂无灵感音乐</div>'); bindSongActions(box); }); }
  function queueTabs(active) { return '<div class="library-tabs"><button class="tab focusable' + (active === "queue" ? ' is-active' : '') + '" data-library-tab="queue">播放列表 <b>' + state.queue.length + '</b></button><button class="tab focusable' + (active === "recent" ? ' is-active' : '') + '" data-library-tab="recent">最近播放 <b>' + state.recent.length + '</b></button></div>'; }
  function recentHero() { var song = state.current || state.recent[0], favorite = isFavorite(song); if (!song) return '<div class="recent-hero empty-recent"><span>还没有最近播放的歌曲</span></div>'; return '<div id="recent-current-track" class="recent-hero track-row focusable" role="button" tabindex="0" data-track-id="' + esc(song.id) + '" aria-label="播放 ' + esc(songName(song)) + '"><img data-current-cover src="' + esc(cover(song)) + '" alt=""><div class="recent-hero-info"><span class="eyebrow">最近在播放</span><strong>' + esc(songName(song)) + '</strong><span>' + esc(artist(song)) + '</span></div><div class="track-actions">' + queueTrackAction(song) + trackAction("favorite", "favorite", favorite ? "取消收藏" : "收藏歌曲", favorite) + '</div></div>'; }
  function bindLibraryTabs() { each(content, "[data-library-tab]", function (button) { button.addEventListener("click", function () { state.libraryView = button.getAttribute("data-library-tab") === "recent" ? "recent" : "queue"; if (state.libraryView === "recent") renderRecent(); else renderQueue(); }); }); }
  function bindRecentHero() {
    var hero = document.getElementById("recent-current-track"), song = state.current || state.recent[0];
    if (!hero || !song) return;
    hydrateCovers(hero, [song]); bindTrackRowFocus(hero);
    hero.addEventListener("click", function (event) {
      var currentSong = state.current || state.recent[0], button = parentMatch(event.target, "[data-action]", hero), action = button && button.getAttribute("data-action");
      if (action === "queue") toggleQueue(currentSong);
      else if (action === "favorite") toggleFavorite(currentSong);
      else { state.playbackList = (state.libraryView === "recent" ? state.recent : state.queue).slice(0); state.playbackListSource = state.libraryView; if (!state.playbackList.length) { state.playbackList = state.recent.slice(0); state.playbackListSource = "recent"; } play(currentSong); }
    });
  }
  function renderQueue() { var savedFocus = bookmark(content); state.page = "queue"; state.libraryView = "queue"; content.innerHTML = pageTitle("播放列表", state.queue.length + " 首歌曲") + queueTabs("queue") + recentHero() + (state.queue.length ? '<div class="track-list">' + state.queue.map(track).join("") + '</div>' : '<div class="empty">播放列表还是空的</div>'); bindLibraryTabs(); bindRecentHero(); bindSongActions(content, state.queue);  restoreBookmark(content, savedFocus); }
  function renderRecent() { var savedFocus = bookmark(content); state.page = "queue"; state.libraryView = "recent"; content.innerHTML = pageTitle("最近播放", state.recent.length + " 首歌曲") + queueTabs("recent") + recentHero() + (state.recent.length ? '<div class="track-list">' + state.recent.map(track).join("") + '</div>' : '<div class="empty">还没有最近播放记录</div>'); bindLibraryTabs(); bindRecentHero(); bindSongActions(content, state.recent);  restoreBookmark(content, savedFocus); }
  function renderFavorites() { var savedFocus = bookmark(content); content.innerHTML = pageTitle("我的收藏", state.favorites.length + " 首歌曲") + (state.favorites.length ? '<div class="track-list">' + state.favorites.map(track).join("") + '</div>' : '<div class="empty">' + (state.authenticated ? '暂无收藏，点击歌曲旁的爱心即可收藏' : '登录后收藏喜欢的音乐') + '</div>'); bindSongActions(content, state.favorites);  restoreBookmark(content, savedFocus); }
  function readPreference(key, fallback) {
    try {
      if (window.MingmingTVPreferences && window.MingmingTVPreferences.get) {
        var nativeValue = window.MingmingTVPreferences.get(key, "");
        if (nativeValue !== "") return nativeValue;
      }
    } catch (ignoreNative) {}
    try { var value = window.localStorage.getItem(key); return value == null ? fallback : value; } catch (ignore) { return fallback; }
  }
  function writePreference(key, value) {
    try { if (window.MingmingTVPreferences && window.MingmingTVPreferences.set) window.MingmingTVPreferences.set(key, String(value)); } catch (ignoreNative) {}
    try { window.localStorage.setItem(key, value); } catch (ignore) {}
  }
  function applySidebarMode(mode) {
    var app = document.getElementById("app"), icons = mode === "icons";
    if (app) app.classList.toggle("sidebar-icons-only", icons);
    writePreference("mingming.sidebarMode", icons ? "icons" : "expanded");
  }
  function applyTextScale(mode) { var app = document.getElementById("app"), large = mode === "large"; if (app) app.classList.toggle("text-scale-large", large); writePreference("mingming.textScale", large ? "large" : "standard"); }
  function applyMotionMode(mode) { var app = document.getElementById("app"), reduced = mode === "reduced"; if (app) app.classList.toggle("reduced-motion", reduced); writePreference("mingming.motion", reduced ? "reduced" : "normal"); }
  function renderUpdateStatus(data) {
    var current = document.getElementById("settings-current-version"), status = document.getElementById("settings-update-state"), button = document.getElementById("settings-check-update"), parsed = data;
    if (!current || !status || !button) return;
    if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch (ignore) { parsed = null; } }
    parsed = parsed || {};
    current.textContent = parsed.current_version || "v" + "0.1.31";
    status.textContent = parsed.message || (parsed.state === "browser" ? "浏览器预览不支持安装更新" : "启动后每天自动检查一次，播放时不打扰。");
    button.disabled = parsed.state === "checking" || parsed.state === "downloading";
    button.textContent = parsed.state === "checking" ? "检查中…" : parsed.state === "downloading" ? "下载中…" : parsed.state === "available" ? "查看更新 " + (parsed.latest_version || "") : "检查更新";
  }
  function pollUpdateStatus() {
    var bridge = window.MingmingTVUpdates;
    if (!bridge || !bridge.getStatus) { renderUpdateStatus({state: "browser", current_version: "v0.1.31"}); return; }
    renderUpdateStatus(bridge.getStatus());
    window.clearInterval(settingsUpdateTimer);
    settingsUpdateTimer = window.setInterval(function () {
      if (state.page !== "settings") { window.clearInterval(settingsUpdateTimer); settingsUpdateTimer = null; return; }
      renderUpdateStatus(bridge.getStatus());
    }, 500);
  }
  function renderSettings() {
    var savedFocus = bookmark(content), sidebarMode = readPreference("mingming.sidebarMode", "expanded"), textScale = readPreference("mingming.textScale", "standard"), motion = readPreference("mingming.motion", "normal"), showComments = readPreference("mingming.commentDefault", "show") !== "hide";
    applySidebarMode(sidebarMode); applyTextScale(textScale); applyMotionMode(motion);
    content.innerHTML = pageTitle("设置", "明明音乐") + '<div class="settings-page"><section class="settings-card"><h2>界面设置</h2><p>选择电视端的导航、文字和动画显示方式。</p><h3>侧边栏显示</h3><div class="settings-actions"><button id="settings-sidebar-expanded" class="account-action account-secondary focusable" type="button" aria-pressed="' + (sidebarMode !== "icons" ? "true" : "false") + '">展开显示</button><button id="settings-sidebar-icons" class="account-action account-secondary focusable" type="button" aria-pressed="' + (sidebarMode === "icons" ? "true" : "false") + '">仅显示图标</button></div><p id="settings-sidebar-state" class="settings-state">当前：' + (sidebarMode === "icons" ? "仅显示图标" : "展开显示") + '</p><h3>字体大小</h3><div class="settings-actions"><button id="settings-text-standard" class="account-action account-secondary focusable" type="button" aria-pressed="' + (textScale !== "large" ? "true" : "false") + '">标准</button><button id="settings-text-large" class="account-action account-secondary focusable" type="button" aria-pressed="' + (textScale === "large" ? "true" : "false") + '">大字</button></div><p id="settings-text-state" class="settings-state">当前：' + (textScale === "large" ? "大字" : "标准") + '</p><h3>动画效果</h3><div class="settings-actions"><button id="settings-motion-normal" class="account-action account-secondary focusable" type="button" aria-pressed="' + (motion !== "reduced" ? "true" : "false") + '">正常</button><button id="settings-motion-reduced" class="account-action account-secondary focusable" type="button" aria-pressed="' + (motion === "reduced" ? "true" : "false") + '">减少动画</button></div><p id="settings-motion-state" class="settings-state">当前：' + (motion === "reduced" ? "减少动画" : "正常") + '</p></section><section class="settings-card"><h2>播放器设置</h2><p>全屏播放时是否默认显示评论区域。播放顺序、连续播放和记忆播放属于标准行为。</p><button id="settings-comments-default" class="account-action account-secondary focusable" type="button" aria-pressed="' + (showComments ? "true" : "false") + '">' + (showComments ? "默认显示评论" : "默认隐藏评论") + '</button><p id="settings-comments-state" class="settings-state">当前：' + (showComments ? "进入全屏时显示评论" : "进入全屏时隐藏评论") + '</p></section><section class="settings-card"><h2>版本更新</h2><p>当前版本 <strong id="settings-current-version">读取中…</strong></p><p id="settings-update-state" class="settings-state" role="status" aria-live="polite">启动后每天自动检查一次，播放时不打扰。</p><button id="settings-check-update" class="account-action account-primary focusable" type="button">检查更新</button></section></div>';
    document.getElementById("settings-sidebar-expanded").addEventListener("click", function () { applySidebarMode("expanded"); renderSettings(); focusTarget(document.getElementById("settings-sidebar-expanded")); });
    document.getElementById("settings-sidebar-icons").addEventListener("click", function () { applySidebarMode("icons"); renderSettings(); focusTarget(document.getElementById("settings-sidebar-icons")); });
    document.getElementById("settings-text-standard").addEventListener("click", function () { applyTextScale("standard"); renderSettings(); focusTarget(document.getElementById("settings-text-standard")); });
    document.getElementById("settings-text-large").addEventListener("click", function () { applyTextScale("large"); renderSettings(); focusTarget(document.getElementById("settings-text-large")); });
    document.getElementById("settings-motion-normal").addEventListener("click", function () { applyMotionMode("normal"); renderSettings(); focusTarget(document.getElementById("settings-motion-normal")); });
    document.getElementById("settings-motion-reduced").addEventListener("click", function () { applyMotionMode("reduced"); renderSettings(); focusTarget(document.getElementById("settings-motion-reduced")); });
    document.getElementById("settings-comments-default").addEventListener("click", function () { var enabled = readPreference("mingming.commentDefault", "show") === "hide"; writePreference("mingming.commentDefault", enabled ? "show" : "hide"); state.commentsHidden = !enabled; renderSettings(); focusTarget(document.getElementById("settings-comments-default")); });
    document.getElementById("settings-check-update").addEventListener("click", function () { var bridge = window.MingmingTVUpdates; if (!bridge || !bridge.check) { renderUpdateStatus({state: "browser", current_version: "v0.1.31"}); return; } bridge.check(); pollUpdateStatus(); });
    pollUpdateStatus(); restoreBookmark(content, savedFocus);
  }
  function renderAccount() { var savedFocus = bookmark(content); var loggedIn = state.authenticated, html = pageTitle("我的", "账号与同步") + '<section class="account-page"><div class="account-avatar" aria-hidden="true">♪</div><div class="account-details"><span class="account-eyebrow">明明音乐账号</span><h2>' + (loggedIn ? "已登录" : "还没有登录") + '</h2><p>' + (loggedIn ? "此设备已连接账号，收藏和播放列表会随账号同步。" : "登录账号后，可在设备间同步收藏和播放列表。") + '</p><div class="account-actions">';
    if (loggedIn) html += '<button id="account-logout" class="account-action account-logout focusable" type="button">退出登录</button><span id="account-message" class="account-message" aria-live="polite"></span>';
    else html += '<button id="account-login" class="account-action account-primary focusable" type="button">登录</button><button id="account-register" class="account-action account-secondary focusable" type="button">注册</button><button id="account-scan-login" class="scan-button focusable" type="button">' + scanIcon() + '<span>扫码登录</span></button><button id="account-scan-register" class="scan-button focusable" type="button">' + scanIcon() + '<span>扫码注册</span></button><button id="account-reset" class="account-action account-link focusable" type="button">忘记密码</button>';
    html += '</div></div></section>'; content.innerHTML = html;
    if (loggedIn) document.getElementById("account-logout").addEventListener("click", logout);
    else { document.getElementById("account-scan-login").onclick = function () { openScan("login"); }; document.getElementById("account-scan-register").onclick = function () { openScan("register"); }; document.getElementById("account-login").addEventListener("click", function () { openLogin("login"); }); document.getElementById("account-register").addEventListener("click", function () { openLogin("register"); }); document.getElementById("account-reset").addEventListener("click", function () { openLogin("reset"); }); }
   restoreBookmark(content, savedFocus); }
  function renderPage(page) { var previous = document.activeElement; if (state.scan) closeScan(); state.detailReturn = null; state.detailKind = ""; state.artistDetail = null; state.albumDetail = null; state.returnPlaylist = null; state.page = page; content.scrollTop = 0; focusMemory.footerReturn = null; each(document, ".nav-item", function (b) { b.classList.toggle("is-active", b.getAttribute("data-page") === page); }); if (page === "recommend") renderRecommend(); else if (page === "search") renderSearch(); else if (page === "playlists") renderPlaylists(); else if (page === "inspiration") renderInspiration(); else if (page === "queue") renderQueue(); else if (page === "recent") renderRecent(); else if (page === "account") renderAccount(); else if (page === "settings") renderSettings(); else renderFavorites(); if (!isFocusable(previous) && focusRoot() === document) focusTarget(activeNav()); }
  function toggleQueue(song) {
    if (!song) return;
    if (isQueued(song)) removeQueuedSong(song);
    else { state.queue.push(song); if (state.playbackListSource === "queue") state.playbackList = state.queue.slice(0); }
    document.getElementById("queue-count").textContent = state.queue.length; renderQueueButton(); updateTrackStates();
    if (state.page === "queue") { if (state.libraryView === "recent") renderRecent(); else renderQueue(); }
    saveLibrary();
  }
  function toggleFavorite(song) { if (!song) return; var found = state.favorites.some(function (x) { return String(x.id) === String(song.id); }); state.favorites = found ? state.favorites.filter(function (x) { return String(x.id) !== String(song.id); }) : state.favorites.concat([song]); saveLibrary(); if (state.page === "favorites") renderFavorites(); else updateTrackStates(); }
  function rememberRecent(song) { if (!song) return; state.recent = [song].concat(state.recent.filter(function (x) { return String(x.id) !== String(song.id); })).slice(0, 100); saveLibrary(); }
  function parseLyrics(text) {
    var lines = [], plain = [], source = String(text || ""), rows = source.split(/\r?\n/), i, row, match, re, stamp, lyric;
    for (i = 0; i < rows.length; i++) {
      row = rows[i];
      re = /\[(\d+):(\d+(?:\.\d+)?)\]([^\r\n]*)/g;
      match = re.exec(row);
      if (!match) { if (row.replace(/^\s+|\s+$/g, "")) plain.push(row.replace(/^\s+|\s+$/g, "")); continue; }
      while (match) {
        stamp = parseInt(match[1], 10) * 60 + parseFloat(match[2]);
        lyric = (match[3] || "").replace(/^\s+|\s+$/g, "");
        if (lyric) lines.push({time: stamp, text: lyric});
        match = re.exec(row);
      }
    }
    if (!lines.length && plain.length) for (i = 0; i < plain.length; i++) lines.push({time: -1, text: plain[i]});
    lines.sort(function (a, b) { return a.time - b.time; });
    return lines;
  }
  function parseWordLyrics(payload) {
    var source = payload && typeof payload.data === "string" ? payload.data : payload && payload.data && typeof payload.data === "object" ? payload.data.lyric : payload && payload.lyric;
    var rows = String(source || "").split(/\r?\n/), lines = [], i, row, lineMatch, tokenRe, token, words, lineTime, lineText;
    for (i = 0; i < rows.length; i++) {
      row = rows[i]; lineMatch = /^\[(\d+),(\d+)\](.*)$/.exec(row);
      if (!lineMatch) continue;
      lineTime = Number(lineMatch[1]) / 1000; lineText = lineMatch[3] || ""; words = [];
      tokenRe = /\((\d+),(\d+),[^)]*\)([\s\S]*?)(?=\(\d+,\d+,[^)]*\)|$)/g; token = tokenRe.exec(lineText);
      while (token) {
        if (token[3]) words.push({time: Number(token[1]) / 1000, end: (Number(token[1]) + Number(token[2])) / 1000, text: token[3]});
        token = tokenRe.exec(lineText);
      }
      if (words.length) lines.push({time: lineTime, text: words.map(function (word) { return word.text; }).join(""), words: words});
    }
    lines.sort(function (a, b) { return a.time - b.time; });
    return lines;
  }
  function commentItems(data) {
    var items = data && (data.comments || data.hotComments || data.data || data.items) || [];
    if (items && items.comments) items = items.comments;
    if (!Array.isArray(items)) items = [];
    return items;
  }
  function commentAvatar(item, user) { return user && (user.avatarUrl || user.avatar || user.avatarUrlOrigin) || item.avatarUrl || "https://picsum.photos/seed/mingming-comment/80/80"; }
  function commentTime(item) { return item.timeStr || (item.time ? new Date(item.time).toLocaleDateString() : ""); }
  function commentMarkup(items, startIndex) { return items.length ? items.map(function (x, index) { var user = x.user && (x.user.nickname || x.user.name) || x.user || x.nickname || "音乐用户", profile = typeof x.user === "object" ? x.user : null, meta = commentTime(x), likes = x.likedCount ? " · " + x.likedCount + " 赞" : ""; return '<div class="comment focusable" tabindex="0" data-comment-index="' + ((startIndex || 0) + index) + '"><img class="comment-avatar" src="' + esc(commentAvatar(x, profile)) + '" alt=""><div class="comment-body"><div class="comment-meta"><strong>' + esc(user) + '</strong>' + (meta || likes ? '<span>' + esc(meta) + esc(likes) + '</span>' : '') + '</div><p>' + esc(x.content || x.comment || x.text || "") + '</p></div></div>'; }).join("") : '<div class="state">暂无评论</div>'; }
  function commentDisplayCount() { return state.commentsTotal ? String(state.commentsTotal) : (state.commentsLoading ? "…" : String(state.comments.length)); }
  function updateCommentCount() { var total = state.commentsTotal || 0, count = document.getElementById("comment-count"), toggle = document.getElementById("player-comments-toggle"); if (count) { count.textContent = total ? String(total) : (state.commentsLoading ? "…" : String(state.comments.length)); count.parentNode.setAttribute("aria-label", "评论 " + (total || state.comments.length) + " 条"); } if (toggle && state.commentsHidden) renderCommentsVisibility(); }
  function lyricMarkup() { return state.lyricLines.length ? state.lyricLines.map(function (line, index) { var timed = line.words && line.words.length, text = timed ? line.words.map(function (word, wordIndex) { return '<span class="lyric-word" data-word-index="' + wordIndex + '">' + esc(word.text) + '</span>'; }).join("") : esc(line.text); return '<div class="lyric-line' + (timed ? ' has-word-timing' : '') + (index === state.lyricIndex ? ' active' : '') + '" data-lyric-index="' + index + '">' + text + '</div>'; }).join("") : '<div class="state">' + esc(state.lyricsText || "暂无歌词") + '</div>'; }
  function renderOverlayLyrics() {
    var root = document.getElementById("overlay-lyrics"), four = state.commentsHidden && !!state.lyricLines.length, markup;
    if (!root) return;
    root.classList.toggle("lyrics-four-line", four);
    root.classList.toggle("lyrics-five-line", four);
    if (overlayLyricView.lines === state.lyricLines && overlayLyricView.message === state.lyricsText && overlayLyricView.four === four) return;
    markup = state.current && !state.lyricsLoaded && !state.lyricLines.length ? '<div class="state lyric-loading" role="status"><span class="loading-ring" aria-hidden="true"></span><span>正在加载歌词…</span></div>' : lyricMarkup();
    // Retain every timed line. Two leading and three trailing spacer rows put
    // the current line in the middle of a five-row TV window without
    // duplicating lyric text at the beginning or end of a song.
    root.innerHTML = four ? '<div class="four-lyric-track five-lyric-track"><div class="lyric-spacer" aria-hidden="true"></div><div class="lyric-spacer" aria-hidden="true"></div>' + markup + '<div class="lyric-spacer" aria-hidden="true"></div><div class="lyric-spacer" aria-hidden="true"></div><div class="lyric-spacer" aria-hidden="true"></div></div>' : markup;
    lyricActiveNode = null; lyricMotion.wordTime = -1;
    overlayLyricView.lines = state.lyricLines; overlayLyricView.message = state.lyricsText; overlayLyricView.four = four;
    overlayLyricView.width = 0; overlayLyricView.height = 0; overlayLyricView.index = -1; overlayLyricView.time = null;
    if (four) root.scrollTop = 0;
  }
  function updateFourLineLyrics(index, time, force) {
    var root = document.getElementById("overlay-lyrics"), track, width, height, rowHeight, resized, animate, nodes, i, lineIndex, font, desired, measured, family;
    if (!root || !overlayLyricView.four || !state.playerOpen || index < 0) return;
    track = root.querySelector(".four-lyric-track"); width = root.clientWidth; height = root.clientHeight;
    if (!track || width <= 0 || height <= 0) return;
    resized = width !== overlayLyricView.width || height !== overlayLyricView.height;
    if (force || resized || index !== overlayLyricView.index) {
      rowHeight = height / 5; family = window.getComputedStyle(root).fontFamily;
      if (!overlayLyricView.measure) { try { overlayLyricView.measure = document.createElement("canvas").getContext("2d"); } catch (ignore) {} }
      nodes = track.children;
      for (i = 0; i < nodes.length; i++) {
        nodes[i].style.height = rowHeight + "px"; nodes[i].style.lineHeight = rowHeight + "px";
        lineIndex = parseInt(nodes[i].getAttribute("data-lyric-index"), 10);
        if (isNaN(lineIndex)) continue;
        nodes[i].classList.toggle("four-previous-two", lineIndex === index - 2);
        nodes[i].classList.toggle("four-previous", lineIndex === index - 1);
        nodes[i].classList.toggle("four-next", lineIndex === index + 1);
        nodes[i].classList.toggle("four-last", lineIndex === index + 2);
        desired = lineIndex === index ? Math.min(92, rowHeight * .6) : Math.min(62, rowHeight * .4);
        if (overlayLyricView.measure) {
          overlayLyricView.measure.font = (lineIndex === index ? "700 " : "400 ") + desired + "px " + family;
          measured = overlayLyricView.measure.measureText(state.lyricLines[lineIndex].text).width;
        } else measured = state.lyricLines[lineIndex].text.length * desired;
        font = Math.min(desired, desired * Math.max(1, width - 32) / Math.max(1, measured));
        nodes[i].style.fontSize = Math.floor(font * 10) / 10 + "px";
      }
      animate = !force && !resized && index === overlayLyricView.index + 1 && overlayLyricView.time != null && time >= overlayLyricView.time && time - overlayLyricView.time < 2 && state.playbackStatus === "playing" && !playbackPaused() && !document.hidden && !commentMotion.background;
      track.style.transition = animate ? "transform .45s cubic-bezier(.22,.68,.26,1)" : "none";
      track.style.webkitTransition = animate ? "-webkit-transform .45s cubic-bezier(.22,.68,.26,1)" : "none";
      track.style.transform = "translateY(" + (-index * rowHeight) + "px)";
      track.style.webkitTransform = "translateY(" + (-index * rowHeight) + "px)";
      overlayLyricView.width = width; overlayLyricView.height = height; overlayLyricView.index = index;
    }
    // A paused/buffering player cannot leave a scrolling animation running.
    if (state.playbackStatus !== "playing" || playbackPaused()) { track.style.transition = "none"; track.style.webkitTransition = "none"; }
    overlayLyricView.time = time;
  }
  function stopLyricMotion() {
    var track = document.querySelector("#overlay-lyrics .four-lyric-track"), computed, transform;
    if (!track) return;
    // Freeze an in-flight transform before removing its transition. Otherwise
    // Chromium 44 snaps to the next row when buffering or pausing begins.
    computed = window.getComputedStyle(track); transform = computed.webkitTransform || computed.transform;
    if (transform && transform !== "none") { track.style.webkitTransform = transform; track.style.transform = transform; }
    track.style.transition = "none"; track.style.webkitTransition = "none";
  }
  function lyricTickerAllowed() {
    var modal = document.getElementById("modal-root"), nativePlaying = nativePlayer && playback.wantPlay && playback.sourceReady, playing = state.playbackStatus === "playing" || nativePlaying;
    return state.playerOpen && state.current && state.lyricLines.length && playing && !playbackPaused() && !document.hidden && !state.queueOpen && modal && modal.hidden;
  }
  function stopLyricTicker() {
    if (lyricMotion.frame !== null) cancelFrame(lyricMotion.frame);
    lyricMotion.frame = null;
  }
  function syncLyricTicker(position) {
    if (!lyricTickerAllowed()) { stopLyricTicker(); return; }
    lyricMotion.base = typeof position === "number" ? position : playbackPosition();
    lyricMotion.at = lyricClockNow();
    if (lyricMotion.frame === null) lyricMotion.frame = requestFrame(runLyricTicker);
  }
  function runLyricTicker() {
    var now, time, duration;
    lyricMotion.frame = null;
    if (!lyricTickerAllowed()) return;
    now = lyricClockNow(); time = lyricMotion.base + Math.max(0, Math.min(1.5, (now - lyricMotion.at) / 1000));
    duration = playbackDuration(); if (duration > 0) time = Math.min(duration, time);
    updateLyrics(time, false);
    if (lyricTickerAllowed()) lyricMotion.frame = requestFrame(runLyricTicker);
  }
  function loadMoreComments(root) {
    if (!root || !state.playerOpen || state.commentsHidden || root.clientHeight <= 0 || state.commentsLoading || Date.now() < state.commentsRetryAt) return;
    if (state.commentsError && !state.comments.length) loadCommentsPage(0, state.playToken);
    else if (state.commentsMore && root.scrollTop + root.clientHeight >= root.scrollHeight - Math.max(160, root.clientHeight * .8)) loadCommentsPage(state.commentsPage + 1, state.playToken, true);
  }
  function bindCommentScroll(root) {
    if (!root || root.getAttribute("data-comment-scroll-bound")) return;
    root.setAttribute("data-comment-scroll-bound", "true");
    root.addEventListener("scroll", function () { loadMoreComments(root); });
    root.addEventListener("wheel", holdCommentMotion);
    root.addEventListener("touchstart", holdCommentMotion);
    root.addEventListener("click", function (event) { if (event.target.getAttribute("data-comment-retry") !== null) { state.commentsRetryAt = 0; loadCommentsPage(0, state.playToken); } });
  }
  function bindFocusScroll(root) {
    if (!root || root.getAttribute("data-focus-scroll-bound")) return;
    root.setAttribute("data-focus-scroll-bound", "true");
    root.addEventListener("focusin", function (event) { var target = event.target; if (!target || !target.classList || !target.classList.contains("comment")) return; scrollFocusIntoView(root, target); syncCommentMotion(); });
    root.addEventListener("focusout", function () { window.setTimeout(syncCommentMotion, 0); });
  }
  function holdCommentMotion() { commentMotion.holdUntil = Date.now() + 5000; }
  function canMoveComments() {
    var root = document.getElementById("overlay-comments");
    return state.playerOpen && !state.commentsHidden && !document.getElementById("app").classList.contains("reduced-motion") && state.current && state.playbackStatus === "playing" && !playbackPaused() && (nativePlayer || !audio.ended) && !document.hidden && !commentMotion.background && !state.queueOpen && document.getElementById("modal-root").hidden && root.clientHeight > 0 && !root.contains(document.activeElement);
  }
  function stopCommentMotion() { if (commentMotion.frame !== null) cancelFrame(commentMotion.frame); commentMotion.frame = null; commentMotion.last = 0; }
  function syncCommentMotion() {
    var root = document.getElementById("overlay-comments");
    if (!canMoveComments()) { stopCommentMotion(); return; }
    if (commentMotion.frame !== null) return;
    commentMotion.position = root.scrollTop; commentMotion.scroll = root.scrollTop; commentMotion.last = 0;
    commentMotion.frame = requestFrame(moveCommentsFrame);
  }
  function moveCommentsFrame(time) {
    var root = document.getElementById("overlay-comments"), elapsed, max;
    commentMotion.frame = null;
    if (!canMoveComments()) { commentMotion.last = 0; return; }
    elapsed = commentMotion.last ? Math.max(0, Math.min(100, time - commentMotion.last)) : 0; commentMotion.last = time;
    if (root.scrollTop !== commentMotion.scroll) commentMotion.position = root.scrollTop;
    max = Math.max(0, root.scrollHeight - root.clientHeight);
    if (Date.now() >= commentMotion.holdUntil) {
      // Fractional position keeps slow movement smooth on old WebViews that round scrollTop.
      commentMotion.position = Math.min(max, commentMotion.position + elapsed * .012);
      root.scrollTop = commentMotion.position;
      loadMoreComments(root);
    }
    commentMotion.scroll = root.scrollTop;
    if (!state.commentsLoading && !state.commentsMore && !state.commentsError && commentMotion.position >= max) { commentMotion.last = 0; return; }
    if (commentMotion.frame === null) commentMotion.frame = requestFrame(moveCommentsFrame);
  }
  function renderOverlayComments(root, song) {
    var reset = commentView.token !== state.playToken || commentView.count > state.comments.length, hadFocus = root.contains(document.activeElement), message;
    if (reset) { root.innerHTML = ""; root.scrollTop = 0; state.commentsScroll = 0; commentView.token = state.playToken; commentView.count = 0; commentMotion.position = 0; commentMotion.scroll = 0; }
    if (state.comments.length) {
      if (!commentView.count) root.innerHTML = "";
      if (commentView.count < state.comments.length) root.insertAdjacentHTML("beforeend", commentMarkup(state.comments.slice(commentView.count), commentView.count));
    } else {
      message = state.commentsError ? '<div class="state error">评论暂不可用<button class="link-button focusable" type="button" data-comment-retry>重试</button></div>' : '<div class="state">' + (song ? (state.commentsLoaded ? '暂无评论' : '正在加载评论…') : '选择一首歌曲查看评论') + '</div>';
      if (root.innerHTML !== message) root.innerHTML = message;
    }
    commentView.count = state.comments.length;
    if (reset && hadFocus && state.playerOpen) document.getElementById("player-close").focus();
  }
  function modeIcon(mode) {
    var attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    if (mode === "shuffle") return '<svg ' + attrs + '><path d="m18 3 3 3-3 3M18 15l3 3-3 3M3 6h3c5 0 7 12 12 12h3M3 18h3c1.6 0 3-1.2 4.4-3.2M14 9.2C15.4 7.2 16.7 6 18 6h3"/></svg>';
    return '<svg ' + attrs + '><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>' + (mode === "one" ? '<path d="m10 10 2-1v6M10 15h4"/>' : '') + '</svg>';
  }
  function renderQueueButton() {
    var button = document.getElementById("queue-open"), count = playbackItems().length, label = "播放列表 " + count;
    if (!button) return;
    if (button.getAttribute("aria-label") !== label) { button.innerHTML = controlIcon("queue") + '<span>播放列表 <b>' + count + '</b></span>'; button.setAttribute("aria-label", label); button.title = label; }
  }
  function playModeInfo() { var modes = {list: {label: "列表循环"}, one: {label: "单曲循环"}, shuffle: {label: "随机播放"}}; return modes[state.playMode] || modes.list; }
  function controlIcon(name) {
    var attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    if (name === "prev") return '<svg ' + attrs + '><path d="M6 5v14M19 6l-9 6 9 6V6Z"/></svg>';
    if (name === "next") return '<svg ' + attrs + '><path d="M18 5v14M5 6l9 6-9 6V6Z"/></svg>';
    if (name === "artist-info") return '<svg ' + attrs + '><circle cx="12" cy="8" r="3.5"/><path d="M5 20c.7-3.4 3.1-5.2 7-5.2s6.3 1.8 7 5.2"/><circle cx="19" cy="18" r="3"/><path d="M19 16.6v2.8M17.6 18h2.8"/></svg>';
    if (name === "pause") return '<svg ' + attrs + '><path d="M8 5v14M16 5v14"/></svg>';
    if (name === "queue") return '<svg ' + attrs + '><path d="M4 6h16M4 12h16M4 18h9"/></svg>';
    if (name === "close") return '<svg ' + attrs + '><path d="m15 5-7 7 7 7"/></svg>';
    return '<svg ' + attrs + '><path class="play-triangle" d="m9 5 10 7-10 7V5Z"/></svg>';
  }
  function setControlIcon(id, name, label) { var button = document.getElementById(id); if (!button) return; if (button.getAttribute("data-control-icon") !== name) { button.innerHTML = controlIcon(name); button.setAttribute("data-control-icon", name); } if (label && button.getAttribute("aria-label") !== label) { button.title = label; button.setAttribute("aria-label", label); } }
  function renderControlIcons() { setControlIcon("player-close", "close", "返回"); setControlIcon("prev", "prev", "上一首"); setControlIcon("play", playbackPaused() ? "play" : "pause", playbackPaused() ? "播放" : "暂停"); setControlIcon("next", "next", "下一首"); renderQueueButton(); setControlIcon("overlay-prev", "prev", "上一首"); setControlIcon("overlay-play", playbackPaused() ? "play" : "pause", playbackPaused() ? "播放" : "暂停"); setControlIcon("overlay-next", "next", "下一首"); setControlIcon("overlay-queue", "queue", "播放列表"); setControlIcon("overlay-artist-info", "artist-info", "查看歌手和专辑详情"); renderOverlayFavorite(); }
  function renderOverlayFavorite() {
    var button = document.getElementById("overlay-favorite"), selected = isFavorite(state.current), label = selected ? "取消收藏" : "收藏歌曲";
    if (!button) return;
    if (!button.firstChild) button.innerHTML = songActionIcon("favorite");
    button.disabled = !state.current; button.classList.toggle("is-selected", selected); button.title = label; button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  function renderCommentsVisibility() {
    var overlay = document.getElementById("player-overlay"), button = document.getElementById("player-comments-toggle"), section = document.getElementById("player-comment-section"), hidden = state.commentsHidden, label = hidden ? "显示评论" : "隐藏评论", expanded = hidden ? "false" : "true", count = commentDisplayCount(), attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    if (!button || !section) return;
    overlay.querySelector(".player-detail-panel").classList.toggle("comments-hidden", state.commentsHidden); section.hidden = state.commentsHidden;
    if (hidden) {
      if (button.getAttribute("aria-expanded") !== expanded || !button.querySelector(".comments-toggle-label") || button.getAttribute("data-comment-count") !== count) button.innerHTML = '<svg ' + attrs + '><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H3l2-5a8.5 8.5 0 1 1 16-3.5Z"/></svg><span class="comments-toggle-label">评论</span><span class="comments-toggle-count">' + esc(count) + '</span>';
    } else if (button.getAttribute("aria-expanded") !== expanded || !button.firstChild || button.querySelector(".comments-toggle-label")) button.innerHTML = '<svg ' + attrs + '><path d="m3 3 18 18M10.6 5.1 12 5c6.5 0 10 7 10 7s-1.2 2.4-3.6 4.4M6.4 6.4C3.5 8.5 2 12 2 12s3.5 7 10 7a11 11 0 0 0 5.6-1.6M10 10a2.8 2.8 0 0 0 4 4"/></svg>';
    button.setAttribute("data-comment-count", count);
    button.setAttribute("aria-expanded", expanded); button.setAttribute("aria-label", label); button.title = label;
  }
  function toggleCommentsVisibility() {
    var comments = document.getElementById("overlay-comments"), button = document.getElementById("player-comments-toggle");
    stopCommentMotion();
    if (!state.commentsHidden) state.commentsScroll = comments.scrollTop;
    state.commentsHidden = !state.commentsHidden; writePreference("mingming.commentDefault", state.commentsHidden ? "hide" : "show"); renderCommentsVisibility();
    renderOverlayLyrics();
    if (!state.commentsHidden) comments.scrollTop = state.commentsScroll;
    // Force the grid to settle before centering the active line after the
    // comment column is hidden or restored on older WebViews.
    var panel = document.querySelector(".player-detail-panel"); if (panel) panel.offsetHeight;
    focusTarget(button);
    updateLyrics(playbackPosition(), true);
    if (!state.commentsHidden && state.current && !state.commentsLoaded && !state.commentsLoading) loadCommentsPage(0, state.playToken);
    syncCommentMotion();
  }
  function setPlaybackButtonState(playing) { setControlIcon("play", playing ? "pause" : "play", playing ? "暂停" : "播放"); setControlIcon("overlay-play", playing ? "pause" : "play", playing ? "暂停" : "播放"); }
  function renderPlayMode() { var info = playModeInfo(), mode = document.getElementById("play-mode"), repeat = document.getElementById("player-repeat"); if (mode && mode.getAttribute("data-play-mode") !== state.playMode) { mode.innerHTML = modeIcon(state.playMode) + '<span>' + info.label + '</span>'; mode.title = "播放顺序：" + info.label; mode.setAttribute("aria-label", "播放顺序：" + info.label); mode.setAttribute("data-play-mode", state.playMode); } if (repeat && repeat.getAttribute("data-play-mode") !== state.playMode) { repeat.innerHTML = modeIcon(state.playMode); repeat.title = "播放顺序：" + info.label; repeat.setAttribute("aria-label", "切换播放顺序，当前为" + info.label); repeat.classList.toggle("is-on", state.playMode !== "list"); repeat.setAttribute("data-play-mode", state.playMode); } }
  function renderPlayerOverlay() {
    var overlay = document.getElementById("player-overlay"), song = state.current, title = document.getElementById("overlay-title"), metadata = document.getElementById("overlay-track-meta"), coverNode = document.getElementById("overlay-cover"), coverUrl, lyrics = document.getElementById("overlay-lyrics"), comments = document.getElementById("overlay-comments"), status = document.getElementById("lyric-status"), lyricScroll = lyrics ? lyrics.scrollTop : 0;
    if (!overlay) return;
    if (song) { title.textContent = songName(song); title.title = songName(song); coverUrl = fullscreenCover(song); if (coverNode.getAttribute("src") !== coverUrl) coverNode.src = coverUrl; }
    metadata.textContent = song ? artist(song) + " · " + album(song) : ""; metadata.title = metadata.textContent; metadata.hidden = !song;
    renderOverlayFavorite(); renderCommentsVisibility();
    renderOverlayLyrics(); if (!overlayLyricView.four) lyrics.scrollTop = lyricScroll; renderOverlayComments(comments, song);
    if (state.playbackStatus === "failed") {
      status.textContent = playbackErrorText();
      status.hidden = false;
    } else {
      status.textContent = state.lyricLines.length ? "" : (song ? (state.lyricsLoaded ? "暂无歌词" : "正在加载歌词…") : "等待播放");
      status.hidden = true;
    }
    renderPlayMode(); updateCommentCount(); bindCommentScroll(comments); bindFocusScroll(comments); updateLyrics(playbackPosition(), true); syncCommentMotion();
  }
  function playbackErrorText() {
    if (playback.errorKind === "network") return "播放源网络异常，请稍后重试";
    if (playback.errorKind === "source") return "播放源返回异常，可能是试听或链接已失效";
    if (playback.errorKind === "decode") return "设备不支持此音频格式";
    if (playback.errorKind === "resolver") return "播放地址获取失败";
    return "播放失败，请重试";
  }
  function scrollLyricIntoView(active) {
    var container, target, max, activeRect, containerRect;
    if (!active) return;
    container = active.parentNode;
    if (!container || container.clientHeight <= 0 || container.scrollHeight <= container.clientHeight) return;
    activeRect = rectOf(active); containerRect = rectOf(container);
    // Re-centering every sentence makes Android 6 visibly bounce the scroll
    // layer when timing updates land close together. Keep a broad safe band.
    if (activeRect.top >= containerRect.top + containerRect.height * .26 && activeRect.bottom <= containerRect.bottom - containerRect.height * .26) return;
    target = container.scrollTop + activeRect.top - containerRect.top - (container.clientHeight - activeRect.height) / 2;
    max = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.max(0, Math.min(max, target));
  }
  function clearLyricWordStyles(node) {
    var words, i, style;
    if (!node) return;
    words = node.querySelectorAll(".lyric-word");
    for (i = 0; i < words.length; i++) { style = words[i].style; style.backgroundImage = ""; style.webkitBackgroundClip = ""; style.backgroundClip = ""; style.color = ""; words[i]._lyricProgress = null; }
  }
  function paintLyricWords(node, line, time, force) {
    var wordNodes, j, word, progress, wordStyle, quantized;
    if (!node || !line || !line.words || !line.words.length) return;
    if (!force && lyricMotion.wordTime >= 0 && Math.abs(time - lyricMotion.wordTime) < .033) return;
    lyricMotion.wordTime = time;
    wordNodes = node.querySelectorAll(".lyric-word");
    for (j = 0; j < wordNodes.length; j++) {
      word = line.words[j]; wordStyle = wordNodes[j].style; progress = !word || time <= word.time ? 0 : time >= word.end ? 100 : Math.max(0, Math.min(100, (time - word.time) / Math.max(.001, word.end - word.time) * 100));
      quantized = Math.round(progress * 10) / 10;
      if (!force && wordNodes[j]._lyricProgress === quantized) continue;
      wordNodes[j]._lyricProgress = quantized;
      if (lyricWordClipSupported) {
        wordStyle.backgroundImage = "-webkit-linear-gradient(left,#c7f38d 0,#c7f38d " + quantized + "%,#dce9dd " + quantized + "%,#dce9dd 100%)";
        wordStyle.webkitBackgroundClip = "text"; wordStyle.backgroundClip = "text"; wordStyle.color = "transparent";
      } else wordStyle.color = progress > 0 ? "#c7f38d" : "#dce9dd";
    }
  }
  function lyricIndexForTime(time) {
    var lines = state.lyricLines, low = 0, high = lines.length - 1, answer = -1, middle, stamp;
    if (!lines.length) return -1;
    if (!isFinite(time)) time = 0;
    while (low <= high) {
      middle = Math.floor((low + high) / 2); stamp = Number(lines[middle].time);
      if (stamp >= 0 && stamp <= time) { answer = middle; low = middle + 1; }
      else if (stamp < 0) low = middle + 1;
      else high = middle - 1;
    }
    return answer < 0 ? 0 : answer;
  }
  function updateLyrics(time, force) {
    var next, i, nodes, active, changed, line, isActive;
    if (!state.playerOpen && !force) return;
    next = lyricIndexForTime(time);
    changed = !!force || next !== state.lyricIndex || !lyricActiveNode; state.lyricIndex = next;
    if (changed) {
      clearLyricWordStyles(lyricActiveNode);
      nodes = document.querySelectorAll("#overlay-lyrics .lyric-line");
      for (i = 0; i < nodes.length; i++) {
        isActive = parseInt(nodes[i].getAttribute("data-lyric-index"), 10) === next;
        nodes[i].classList.toggle("active", isActive);
        if (isActive) active = nodes[i];
      }
      lyricActiveNode = active || null;
    } else active = lyricActiveNode;
    line = next >= 0 ? state.lyricLines[next] : null;
    paintLyricWords(active, line, time, !!force || changed);
    updateFourLineLyrics(next, time, force);
    if (!changed) return;
    active = next >= 0 ? document.querySelector('#overlay-lyrics .lyric-line[data-lyric-index="' + next + '"]') : null;
    if (!overlayLyricView.four) scrollLyricIntoView(active);
  }
  function loadCommentsPage(page, token, append) {
    var song = state.current, offset, shouldAppend = !!append && page > 0, requestToken = state.playToken, settled = false;
    // Keep the first page request alive while comments are collapsed so the
    // fullscreen toggle can show the next song's total immediately. Hidden
    // comments still never paginate: only page zero is allowed here.
    if (!song || (state.commentsHidden && (shouldAppend || page > 0)) || (token && token !== requestToken) || state.commentsLoading || Date.now() < state.commentsRetryAt || (!state.commentsMore && shouldAppend)) return;
    page = Math.max(0, page); state.commentsLoading = true; state.commentsError = false;
    if (!shouldAppend) { state.commentsLoaded = false; state.comments = []; }
    renderPlayerOverlay();
    offset = page * state.commentsPageSize;
    api("/api/netease/comments?songId=" + encodeURIComponent(song.id || "") + "&offset=" + offset + "&limit=" + state.commentsPageSize, "GET", null, function (err, data) {
      if (settled || requestToken !== state.playToken) return;
      settled = true;
      var items = err ? [] : commentItems(data), total = !err && data && parseInt(data.total, 10) > 0 ? parseInt(data.total, 10) : 0, hasMore = !err && data && typeof data.more === "boolean" ? data.more : items.length >= state.commentsPageSize;
      state.commentsLoading = false; state.commentsLoaded = true;
      if (err) { state.commentsError = true; state.commentsRetryAt = Date.now() + 8000; renderPlayerOverlay(); return; }
      state.commentsPage = page; state.commentsRetryAt = 0;
      state.comments = shouldAppend ? state.comments.concat(items) : items;
      state.commentsTotal = total || state.commentsTotal || state.comments.length;
      state.commentsMore = items.length > 0 && hasMore && (!total || state.comments.length < total);
      renderPlayerOverlay();
    });
  }
  function loadLyricsComments(song, token) {
    var id = encodeURIComponent(song.id || "");
    api("/api/music/lrc", "POST", "id=" + id + "&type=wy", function (err, data) { var raw = !err && data && data.data || "", text = err ? "歌词暂不可用" : (raw || "暂无歌词"); if (token !== state.playToken) return; state.lyricsLoaded = true; state.lyricsText = text; if (!state.lyricsWordLoaded) state.lyricLines = parseLyrics(raw); state.lyricIndex = -1; renderPlayerOverlay(); if (state.playbackStatus === "playing") syncLyricTicker(playbackPosition()); });
    api("/api/word-lyric?id=" + id, "GET", null, function (err, data) { var enhanced = err ? [] : parseWordLyrics(data); if (token !== state.playToken || !enhanced.length) return; state.lyricsWordLoaded = true; state.lyricLines = enhanced; state.lyricIndex = -1; renderPlayerOverlay(); updateLyrics(playbackPosition(), true); if (state.playbackStatus === "playing") syncLyricTicker(playbackPosition()); });
    state.commentsPage = 0; state.commentsTotal = 0; state.commentsMore = false; loadCommentsPage(0, token);
  }
  function playbackItems() {
    var items = state.playbackList.length ? state.playbackList.slice(0) : state.queue.slice(0), current = state.current, found = false, i;
    // A custom queue is authoritative, including when its last song was removed.
    if (state.playbackListSource === "queue") return state.queue.slice(0);
    if (!items.length) items = state.recent.slice(0);
    if (current) for (i = 0; i < items.length; i++) if (String(items[i].id) === String(current.id)) { found = true; break; }
    if (current && !found) items.unshift(current);
    return items;
  }
  function playRelative(direction, automatic) { var items = playbackItems(), index = -1, i; if (!items.length) return; if (state.current) for (i = 0; i < items.length; i++) if (String(items[i].id) === String(state.current.id)) { index = i; break; } if (index < 0) index = direction > 0 ? -1 : items.length; play(items[(index + direction + items.length) % items.length], automatic); }
  function selectTrack(song, position, duration, fromNative) {
    stopLyricTicker(); stopLyricMotion();
    if (!nativePlayer) { audio.pause(); audio.removeAttribute("src"); audio.load(); }
    playback.position = position || 0; playback.duration = duration || (Number(song.dt) / 1000) || 0; playback.pendingSeek = playback.position; playback.needsSource = true; playback.sourceReady = false; playback.resolving = false; playback.wantPlay = false;
    state.current = song; state.playToken += 1; state.lyricsText = "正在加载歌词…"; state.lyricLines = []; state.lyricIndex = -1; state.lyricsLoaded = false; state.lyricsWordLoaded = false; state.comments = []; state.commentsLoaded = false; state.commentsPage = 0; state.commentsTotal = 0; state.commentsMore = false; state.commentsLoading = false; state.commentsError = false; state.commentsRetryAt = 0; commentMotion.holdUntil = 0;
    document.getElementById("player-title").textContent = songName(song); document.getElementById("player-artist").textContent = artist(song); document.getElementById("player-cover").src = cover(song); updateTrackStates(); renderPlayerOverlay(); syncProgress();
    loadLyricsComments(song, state.playToken);
    if (nativePlayer && !fromNative) { nativePendingSelection = ++nativeSelection; nativePlayer.command("select", JSON.stringify(nativeSnapshot())); }
  }
  function play(song, automatic) {
    if (!song) return;
    if (!automatic) playback.autoSkipCount = 0;
    selectTrack(song, 0, 0); rememberRecent(song); savePlayback(); togglePlayback();
  }
  function continueAfterFailure() { var items = playbackItems(); if (!playback.wantPlay || state.playMode === "one" || items.length < 2 || playback.autoSkipCount >= items.length) return false; playback.autoSkipCount += 1; if (state.playMode === "shuffle") playRandom(true); else playRelative(1, true); return true; }
  function resolveCurrentSource() {
    var song = state.current, token = state.playToken, directSource;
    if (!song || playback.resolving) return;
    playback.resolving = true; playback.errorKind = ""; playback.errorCode = 0; setPlaybackStatus("preparing");
    directSource = song.audioPath || song.audioUrl || song.audio_url;
    if (directSource) setAudioSource(directSource); else api("/api/music/url", "POST", "id=" + encodeURIComponent(song.id || "") + "&type=" + encodeURIComponent(song.type || song.provider || "wy"), function (err, data) { var source = data && data.data, status; if (token !== state.playToken) return; playback.resolving = false; if (err || !source) { playback.errorKind = "resolver"; playback.errorCode = 0; playback.wantPlay = false; setPlaybackStatus("failed"); status = document.getElementById("lyric-status"); status.textContent = playbackErrorText(); status.hidden = false; return; } setAudioSource(source); });
  }
  function applyPendingSeek() {
    var target, i, seekable = false;
    if (playback.pendingSeek == null) return true;
    if (!playback.sourceReady || !playback.duration) return false;
    target = Math.min(playback.pendingSeek, Math.max(0, playback.duration - .1));
    if (!audio.seeking && Math.abs(audio.currentTime - target) < .1) { playback.position = target; playback.pendingSeek = null; return true; }
    for (i = 0; i < audio.seekable.length; i++) if (audio.seekable.start(i) <= target && audio.seekable.end(i) >= target) seekable = true;
    // loadedmetadata can precede a seekable range, especially with older WebViews.
    if (seekable && !audio.seeking) { try { audio.currentTime = target; } catch (ignore) {} }
    return false;
  }
  function startAudio() {
    var token = state.playToken, promise;
    if (!applyPendingSeek()) return;
    promise = audio.play();
    if (promise && promise.catch) promise.catch(function () { if (token === state.playToken && playback.wantPlay && !continueAfterFailure()) { playback.wantPlay = false; setPlaybackStatus("failed"); } });
  }
  function togglePlayback() {
    if (!state.current) return;
    if (nativePlayer) { playback.wantPlay = !playback.wantPlay; nativePlayer.command(playback.wantPlay ? "play" : "pause", ""); setPlaybackStatus(playback.wantPlay ? "preparing" : "paused"); return; }
    if (!audio.paused || playback.wantPlay) { playback.autoSkipCount = 0; playback.wantPlay = false; audio.pause(); setPlaybackStatus("paused"); savePlayback(); return; }
    playback.wantPlay = true;
    if (playback.needsSource) resolveCurrentSource();
    else if (playback.sourceReady) startAudio();
    else setPlaybackStatus("preparing");
  }
  function setAudioSource(source) {
    playback.resolving = false; playback.needsSource = false; playback.sourceReady = false; playback.errorKind = ""; playback.errorCode = 0;
    setPlaybackStatus(playback.wantPlay ? "preparing" : "paused"); audio.src = "/media?url=" + encodeURIComponent(source); audio.load();
  }
  function openPlayerOverlay() { var overlay = document.getElementById("player-overlay"), play; if (!overlay || state.playerOpen) return; state.commentsHidden = readPreference("mingming.commentDefault", "show") === "hide"; state.playerPreviousFocus = document.activeElement; state.playerOpen = true; overlay.hidden = false; renderPlayerOverlay(); syncLyricTicker(playbackPosition()); play = document.getElementById("overlay-play"); if (play) play.focus(); }
  function queuePopupMarkup(items) {
    var html = "", i, song, actions, favorite;
    for (i = 0; i < items.length; i++) {
      song = items[i]; favorite = isFavorite(song);
      actions = trackAction("artist-info", "artist-info", "查看歌手和专辑详情");
      actions += state.playbackListSource === "queue" ? trackAction("remove-queue", "delete", "从播放列表删除") : queueTrackAction(song);
      actions += trackAction("favorite", "favorite", favorite ? "取消收藏" : "收藏歌曲", favorite);
      html += songRowMarkup(song, i, actions, true);
    }
    return html || (queueLoading.data ? '<div class="queue-list-loading" role="status"><span class="loading-ring" aria-hidden="true"></span><span>正在加载播放列表…</span></div>' : '<div class="state">播放列表为空</div>');
  }
  function updateQueueLoading() {
    var popup = document.getElementById("queue-popup"), indicator = document.getElementById("queue-loading"), busy = queueLoading.data + queueLoading.covers > 0;
    if (!state.queueOpen || !popup) return;
    if (indicator) indicator.hidden = !busy || !popup.querySelector(".track-row");
    popup.setAttribute("aria-busy", busy ? "true" : "false");
  }
  function finishQueueData() {
    var popup = document.getElementById("queue-popup"), list, key;
    queueLoading.data = Math.max(0, queueLoading.data - 1);
    if (!state.queueOpen || !popup) return;
    key = bookmark(popup); list = popup.querySelector(".queue-popup-list");
    renderQueuePopup(null, null, list ? list.scrollTop : 0, key);
  }
  function renderQueuePopup(targetIndex, targetAction, scrollTop, focusKey) {
    var popup = document.getElementById("queue-popup"), items = playbackItems(), close, i, row, target, token = ++queueLoading.token;
    if (!popup) return;
    queueLoading.covers = 0;
    popup.innerHTML = '<div class="queue-dialog" role="dialog" aria-modal="true" aria-label="播放列表"><div class="queue-dialog-head"><div><h2>播放列表</h2><div class="queue-summary"><span>' + items.length + ' 首歌曲</span><span id="queue-loading" class="queue-loading" hidden role="status"><span class="loading-ring" aria-hidden="true"></span><span>正在加载…</span></span></div></div><button id="queue-popup-close" class="icon-button focusable" type="button" title="关闭播放列表" aria-label="关闭播放列表"></button></div><div class="queue-popup-list">' + queuePopupMarkup(items) + '</div></div>';
    setControlIcon("queue-popup-close", "close", "关闭播放列表"); close = document.getElementById("queue-popup-close"); close.addEventListener("click", closeQueuePopup);
    each(popup, ".track-row[data-song]", function (el) {
      el.addEventListener("focusin", function () { el.classList.add("has-focus"); });
      el.addEventListener("focusout", function () { window.setTimeout(function () { if (!el.contains(document.activeElement)) el.classList.remove("has-focus"); }, 0); });
      el.addEventListener("click", function (event) {
        var node = event.target, action = null, index = parseInt(el.getAttribute("data-song"), 10), song = items[index], top = popup.querySelector(".queue-popup-list").scrollTop;
        while (node && node !== el) { if (node.getAttribute && node.getAttribute("data-action")) { action = node.getAttribute("data-action"); break; } node = node.parentNode; }
        if (action === "artist-info" || action === "artist-album") { openShareMenu(song); return; }
        if (action === "queue") { toggleQueue(song); return; }
        if (action === "favorite") { toggleFavorite(song); return; }
        if (action === "remove-queue" && state.playbackListSource === "queue") {
          removeQueuedSong(song); renderQueuePopup(index, "remove-queue", top);
          if (state.page === "queue" && state.libraryView === "queue") renderQueue();
          saveLibrary(); return;
        }
        state.playbackList = items.slice(0);
        if (!state.playbackListSource) state.playbackListSource = state.queue.length ? "queue" : "recent";
        closeQueuePopup(); play(song);
      });
    });
    hydrateCovers(popup, items, function (delta) { if (!state.queueOpen || token !== queueLoading.token) return; queueLoading.covers = Math.max(0, queueLoading.covers + delta); updateQueueLoading(); }); updateTrackStates(); updateQueueLoading();
    for (i = 0; i < items.length; i++) if (sameSong(items[i], state.current)) break;
    if (typeof targetIndex === "number") i = Math.min(targetIndex, items.length - 1);
    row = popup.querySelector('[data-song="' + (i < items.length ? i : 0) + '"]'); target = row && targetAction ? row.querySelector('[data-action="' + targetAction + '"]') : row;
    if (focusKey) target = resolveBookmark(popup, focusKey) || target;
    if (typeof scrollTop === "number") popup.querySelector(".queue-popup-list").scrollTop = scrollTop;
    if (focusRoot() === popup) focusQueueTarget(target || row || close);
  }
  function openQueuePopup() { var popup = document.getElementById("queue-popup"); if (!popup || state.queueOpen) return; state.queuePreviousFocus = document.activeElement; state.queueOpen = true; popup.hidden = false; syncCommentMotion(); renderQueuePopup(); }
  function closeQueuePopup() { var popup = document.getElementById("queue-popup"), previous = state.queuePreviousFocus, fallback; if (!popup) return; state.queueOpen = false; popup.hidden = true; queueLoading.token += 1; queueLoading.covers = 0; popup.removeAttribute("aria-busy"); state.queuePreviousFocus = null; fallback = document.getElementById(state.playerOpen ? "overlay-queue" : "queue-open"); if (isFocusable(previous) && previous.focus) previous.focus(); else if (fallback) fallback.focus(); syncCommentMotion(); }
  function closePlayerOverlay() { var overlay = document.getElementById("player-overlay"), previous = state.playerPreviousFocus; if (!overlay) return; if (state.queueOpen) closeQueuePopup(); state.playerOpen = false; overlay.hidden = true; stopCommentMotion(); stopLyricTicker(); stopLyricMotion(); state.playerPreviousFocus = null; if (previous && previous.focus && document.body.contains(previous)) previous.focus(); else focusInitial(); }
  function cyclePlayMode() { state.playMode = state.playMode === "list" ? "one" : (state.playMode === "one" ? "shuffle" : "list"); renderPlayMode(); if (state.playerOpen) renderPlayerOverlay(); savePlayback(); }
  function playRandom(automatic) { var items = playbackItems(), candidates = [], current = state.current, i; for (i = 0; i < items.length; i++) if (!current || String(items[i].id) !== String(current.id)) candidates.push(items[i]); if (!candidates.length) candidates = items; if (candidates.length) play(candidates[Math.floor(Math.random() * candidates.length)], automatic); }
  function handleEnded() { playback.autoSkipCount = 0; if (state.playbackListSource === "queue" && !state.queue.some(function (song) { return sameSong(song, state.current); })) { playRelative(1, true); return; } if (state.playMode === "one") { audio.currentTime = 0; var replay = audio.play(); if (replay && replay.catch) replay.catch(function () {}); return; } if (state.playMode === "shuffle") { playRandom(true); return; } playRelative(1, true); }
  function applyLibrary(data) { if (!data) return; state.favorites = data.favorites || []; state.queue = data.playlists || []; state.recent = data.recent || []; state.authenticated = !!data.authenticated; state.librarySynced = !!data.synced; document.getElementById("queue-count").textContent = state.queue.length; renderQueueButton(); updateTrackStates(); }
  function saveLibrary(done) { libraryWrite.revision += 1; libraryWrite.pending = true; if (nativePlayer && state.current) savePlayback(); if (done) libraryWrite.callbacks.push(done); flushLibraryWrite(); }
  function flushLibraryWrite() {
    var settled = false;
    if (libraryWrite.inFlight || !libraryWrite.pending) return;
    libraryWrite.pending = false; libraryWrite.inFlight = true;
    api("/api/library", "PUT", JSON.stringify({favorites: state.favorites, playlists: state.queue, recent: state.recent}), function (err, data) {
      var callbacks, i;
      if (settled) return; settled = true; libraryWrite.inFlight = false;
      // A later click owns the local state; save it after this request completes.
      if (libraryWrite.pending) { flushLibraryWrite(); return; }
      if (!err && data) applyLibrary(data);
      callbacks = libraryWrite.callbacks; libraryWrite.callbacks = [];
      for (i = 0; i < callbacks.length; i++) callbacks[i](err, data);
    });
  }
  function loadLibrary(done) { var revision = libraryWrite.revision; queueLoading.data += 1; updateQueueLoading(); api("/api/library", "GET", null, function (err, data) { if (!err && data && revision === libraryWrite.revision && !libraryWrite.inFlight && !libraryWrite.pending) { applyLibrary(data); if (state.page === "account") renderAccount(); else if (state.page === "favorites") renderFavorites(); } finishQueueData(); if (done) done(err, data); }); }
  function openLogin(mode) { var root = document.getElementById("modal-root"); state.exitDialog = false; root.removeAttribute("data-exit-dialog"); state.modalPreviousFocus = document.activeElement; root.hidden = false; syncCommentMotion(); root.innerHTML = '<div class="modal" role="dialog"><button id="modal-close" class="modal-close focusable">×</button><h2>明明音乐账号</h2><div class="modal-tabs"><button class="is-active focusable" data-mode="login">登录</button><button class="focusable" data-mode="register">注册</button><button class="focusable" data-mode="reset">找回密码</button></div><form id="auth-form"><div class="field"><label>用户名或邮箱</label><input id="auth-user" class="focusable" autocomplete="username"></div><div class="field"><label>密码</label><input id="auth-pass" class="focusable" type="password" autocomplete="current-password"></div><div id="auth-extra"></div><div class="modal-actions"><button id="auth-scan" type="button" class="scan-button focusable">' + scanIcon() + '<span>扫码登录</span></button><button id="auth-submit" class="primary focusable">登录</button></div><div id="auth-message" class="modal-message" aria-live="polite"></div></form></div>'; document.getElementById("auth-scan").addEventListener("click", function () { openScan(root.getAttribute("data-mode") || "login"); }); document.getElementById("modal-close").addEventListener("click", closeLogin); each(root, "[data-mode]", function (b) { b.addEventListener("click", function () { setAuthMode(b.getAttribute("data-mode")); }); }); document.getElementById("auth-form").addEventListener("submit", submitAuth); setAuthMode(mode || "login"); document.getElementById("auth-user").focus(); }
  function setAuthMode(mode) { var root = document.getElementById("modal-root"), extra = document.getElementById("auth-extra"), submit = document.getElementById("auth-submit"), actions = root.querySelector(".modal-actions"); each(root, "[data-mode]", function (b) { b.classList.toggle("is-active", b.getAttribute("data-mode") === mode); }); extra.innerHTML = mode === "register" ? '<div id="captcha-image" class="captcha-image"></div><div class="field"><label>验证码</label><input id="auth-code" class="focusable" placeholder="请输入验证码"></div>' : mode === "reset" ? '<div class="field"><label>邮箱验证码</label><input id="auth-code" class="focusable"></div><button id="send-reset" type="button" class="link-button focusable">发送验证码</button>' : ''; if (actions) actions.hidden = false; submit.textContent = mode === "register" ? "注册" : mode === "reset" ? "重置密码" : "登录"; root.setAttribute("data-mode", mode); var scan = document.getElementById("auth-scan"); if (scan) { scan.hidden = mode === "reset"; scan.innerHTML = scanIcon() + "<span>扫码" + (mode === "register" ? "注册" : "登录") + "</span>"; } if (mode === "register") api("/api/captcha", "GET", null, function (err, data) { if (!err && data && data.captchaId) root.setAttribute("data-captcha-id", data.captchaId); var svg = data && data.svg, holder = document.getElementById("captcha-image"); if (holder && svg) holder.innerHTML = '<img src="data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '" alt="验证码">'; }); if (mode === "reset") document.getElementById("send-reset").addEventListener("click", sendResetCode); }
  function sendResetCode() { var user = document.getElementById("auth-user").value, message = document.getElementById("auth-message"); if (!user) { message.textContent = "请先填写邮箱"; return; } message.textContent = "正在发送验证码…"; api("/api/user", "POST", JSON.stringify({action: "sendResetCode", email: user}), function (err, data) { message.textContent = err || !data || data.code === 0 ? ((data && data.msg) || (err && err.message) || "验证码发送失败") : "验证码已发送，请查收邮箱"; }); }
  function deviceActivity(device) { var created = Number(device && device.createdAt), age; if (!created || !isFinite(created)) return "登录时间未知"; age = Math.max(0, Date.now() - created); if (age < 60000) return "刚刚登录"; if (age < 3600000) return Math.floor(age / 60000) + " 分钟前登录"; if (age < 86400000) return Math.floor(age / 3600000) + " 小时前登录"; return Math.floor(age / 86400000) + " 天前登录"; }
  function showDeviceLimit(data) {
    var root = document.getElementById("modal-root"), extra = document.getElementById("auth-extra"), actions = root.querySelector(".modal-actions"), devices = data && Array.isArray(data.devices) ? data.devices : [], max = Number(data && data.maxSessions) || 3, html = '<section class="device-limit"><h3>登录设备已达上限</h3><p>当前有 ' + devices.length + ' 台设备登录，最多 ' + max + ' 台。选择一台下线并登录此电视。</p><div class="device-limit-list">', i, device, name, tail;
    document.getElementById("auth-message").textContent = "";
    for (i = 0; i < devices.length; i++) { device = devices[i] || {}; name = device.deviceName || "未知设备"; tail = device.tokenTail || ""; html += '<div class="device-limit-item"><div class="device-limit-info"><strong>' + esc(name) + '</strong><span>' + esc(deviceActivity(device)) + '</span></div><button class="device-kick focusable" type="button" data-kick-tail="' + esc(tail) + '"' + (tail ? "" : " disabled") + '>下线并登录</button></div>'; }
    html += '</div><button id="device-limit-cancel" class="link-button focusable" type="button">返回登录</button></section>'; extra.innerHTML = html; if (actions) actions.hidden = true;
    each(extra, "[data-kick-tail]", function (button) { button.addEventListener("click", function () { kickAndLogin(button.getAttribute("data-kick-tail")); }); });
    document.getElementById("device-limit-cancel").addEventListener("click", function () { extra.innerHTML = ""; if (actions) actions.hidden = false; document.getElementById("auth-message").textContent = ""; document.getElementById("auth-pass").focus(); });
    var first = extra.querySelector(".device-kick:not(:disabled)"); if (first) first.focus(); else document.getElementById("device-limit-cancel").focus();
  }
  function finishAuth(mode) {
    var message = document.getElementById("auth-message");
    api("/api/library", "PUT", JSON.stringify({favorites: state.favorites, playlists: state.queue, recent: state.recent, merge: true}), function (syncErr, syncData) {
      if (!syncErr && syncData) applyLibrary(syncData);
      message.textContent = !syncErr && syncData && syncData.synced ? (mode === "login" ? "登录成功，已同步收藏和播放列表" : "操作成功，已同步收藏和播放列表") : (mode === "login" ? "登录成功，本地数据已保留，云端同步稍后重试" : "操作成功");
      if (state.page === "account") renderAccount();
      setTimeout(closeLogin, 900);
    });
  }
  function kickAndLogin(tokenTail) {
    var user = document.getElementById("auth-user").value, pass = document.getElementById("auth-pass").value, message = document.getElementById("auth-message"), body = {action: "kickAndLogin", password: pass, kickTail: tokenTail}, buttons = document.querySelectorAll("[data-kick-tail]"), i;
    if (!tokenTail) return;
    if (user.indexOf("@") >= 0) body.email = user; else body.username = user;
    for (i = 0; i < buttons.length; i++) buttons[i].disabled = true;
    message.textContent = "正在下线设备并登录…";
    api("/api/user", "POST", JSON.stringify(body), function (err, data) {
      if (!err && data && data.success === true) { finishAuth("login"); return; }
      if (data && data.deviceLimit) { showDeviceLimit(data); message.textContent = "设备列表已更新，请重新选择。"; return; }
      message.textContent = (data && (data.error || data.msg)) || (err && err.message) || "下线设备失败，请重试";
      buttons = document.querySelectorAll("[data-kick-tail]");
      for (i = 0; i < buttons.length; i++) buttons[i].disabled = false;
    });
  }
  function submitAuth(e) {
    e.preventDefault();
    var root = document.getElementById("modal-root"), mode = root.getAttribute("data-mode") || "login", user = document.getElementById("auth-user").value, pass = document.getElementById("auth-pass").value, message = document.getElementById("auth-message");
    message.textContent = "正在提交…";
    var body = {action: mode === "register" ? "register" : mode === "reset" ? "resetPasswordByEmail" : (user.indexOf("@") >= 0 ? "loginByEmail" : "login"), username: user, email: user, password: pass, newPassword: pass, captchaId: root.getAttribute("data-captcha-id") || "", captchaCode: (document.getElementById("auth-code") || {}).value || ""};
    api("/api/user", "POST", JSON.stringify(body), function (err, data) {
      if (mode === "login" && data && data.deviceLimit) { showDeviceLimit(data); return; }
      if (err || !data || data.code === 0 || data.success === false) { message.textContent = (data && (data.msg || data.error)) || (err && err.message) || "账号操作失败"; return; }
      finishAuth(mode);
    });
  }
  function closeLogin() { if (state.scan) { closeScan(); return; } if (state.shareMenu) { closeShareMenu(); return; } var root = document.getElementById("modal-root"), previous = state.modalPreviousFocus, fallback; state.exitDialog = false; root.removeAttribute("data-exit-dialog"); root.hidden = true; root.innerHTML = ""; state.modalPreviousFocus = null; if (previous && previous.focus && document.body.contains(previous)) previous.focus(); else if (state.page === "account") { fallback = document.getElementById(state.authenticated ? "account-logout" : "account-login"); if (fallback) fallback.focus(); } syncCommentMotion(); }
  function openExitConfirm() {
    var root = document.getElementById("modal-root"), cancel, confirm;
    if (!root || !root.hidden) return;
    state.modalPreviousFocus = document.activeElement;
    state.exitDialog = true;
    root.setAttribute("data-exit-dialog", "true");
    root.hidden = false;
    root.innerHTML = '<div class="modal exit-modal" role="dialog" aria-modal="true" aria-labelledby="exit-title"><h2 id="exit-title">退出明明音乐？</h2><p>确认后将停止播放并关闭应用。</p><div class="modal-actions"><button id="exit-cancel" class="exit-cancel focusable" type="button">取消</button><button id="exit-confirm" class="primary focusable" type="button">退出</button></div></div>';
    cancel = document.getElementById("exit-cancel");
    confirm = document.getElementById("exit-confirm");
    cancel.addEventListener("click", closeExitConfirm);
    confirm.addEventListener("click", confirmExit);
    syncCommentMotion();
    cancel.focus();
  }
  function closeExitConfirm() {
    var root = document.getElementById("modal-root"), previous = state.modalPreviousFocus;
    if (!root || !state.exitDialog) return;
    state.exitDialog = false;
    root.removeAttribute("data-exit-dialog");
    root.hidden = true;
    root.innerHTML = "";
    state.modalPreviousFocus = null;
    if (previous && previous.focus && document.body.contains(previous)) previous.focus(); else focusInitial();
    syncCommentMotion();
  }
  function confirmExit() {
    var button = document.getElementById("exit-confirm");
    if (button) { button.disabled = true; button.textContent = "正在退出…"; }
    savePlayback(true);
    if (window.MingmingTVApp && window.MingmingTVApp.exit) {
      window.MingmingTVApp.exit();
      return;
    }
    // Browser previews cannot finish their host tab. Keep the same playback
    // semantics so the flow remains testable outside an APK.
    playback.wantPlay = false;
    if (nativePlayer) nativePlayer.command("pause", ""); else audio.pause();
    closeExitConfirm();
  }
  function scanIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/><path d="M7 7h3v3H7zM14 7h3v3h-3zM7 14h3v3H7zM14 14h3v3h-3z"/></svg>'; }
  function closeScan() {
    var scan = state.scan, root = document.getElementById("modal-root"), dialog = document.getElementById("scan-dialog"); if (!scan) return;
    state.scan = null; state.scanGeneration += 1; window.clearInterval(scan.timer);
    if (scan.id) api("/api/scan/" + scan.id, "DELETE", null, function () {});
    if (dialog && dialog.parentNode) dialog.parentNode.removeChild(dialog);
    if (scan.parentModal) scan.parentModal.hidden = false;
    else { root.hidden = true; state.modalPreviousFocus = null; }
    if (scan.previousFocus && document.body.contains(scan.previousFocus)) scan.previousFocus.focus(); else focusInitial();
    syncCommentMotion();
  }
  function openScan(scope) {
    if (state.scan) closeScan();
    var root = document.getElementById("modal-root"), parent = root.hidden ? null : root.querySelector(".modal"), previous = document.activeElement, generation = ++state.scanGeneration, scan, dialog;
    if (!parent) state.modalPreviousFocus = previous; else parent.hidden = true;
    root.hidden = false; syncCommentMotion(); dialog = document.createElement("section"); dialog.id = "scan-dialog"; dialog.className = "modal scan-modal"; dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML = '<div class="scan-heading"><div><span class="scan-eyebrow">手机输入 · 明明音乐</span><h2>扫码' + (scope === "search" ? "搜索" : scope === "register" ? "注册" : "登录") + '</h2></div><button id="scan-close" class="modal-close focusable" type="button" aria-label="关闭">×</button></div><div class="scan-body"><div class="scan-qr"><img id="scan-qr" alt="手机扫码二维码" hidden><div id="scan-placeholder">正在生成二维码…</div></div><div class="scan-copy"><p>手机和电视连接同一个 Wi-Fi，扫码后在手机上填写。' + (scope === "search" ? '提交关键词后，电视自动搜索。' : '') + '</p><div class="scan-code">配对码 <strong id="scan-code">—</strong></div><div id="scan-expiry" class="scan-expiry"></div><div id="scan-message" class="scan-message" aria-live="polite">等待手机连接</div></div></div><div class="scan-actions"><button id="scan-refresh" class="scan-button focusable" type="button">刷新二维码</button><button id="scan-cancel" class="scan-button focusable" type="button">取消</button></div>';
    root.appendChild(dialog); scan = {scope: scope, id: null, parentModal: parent, previousFocus: previous, timer: null, generation: generation}; state.scan = scan;
    document.getElementById("scan-close").onclick = closeScan; document.getElementById("scan-cancel").onclick = closeScan;
    document.getElementById("scan-refresh").onclick = function () { var origin = scan.previousFocus; closeScan(); if (origin && document.body.contains(origin)) origin.focus(); openScan(scope); };
    document.getElementById("scan-cancel").focus();
    api("/api/scan", "POST", JSON.stringify({scope: scope}), function (err, data) {
      if (state.scan !== scan || generation !== state.scanGeneration) { if (data && data.id) api("/api/scan/" + data.id, "DELETE", null, function () {}); return; }
      if (err || !data || !data.qr) { document.getElementById("scan-placeholder").textContent = "二维码暂不可用"; document.getElementById("scan-message").textContent = data && data.error || err && err.message || "请使用直接输入"; return; }
      scan.id = data.id; document.getElementById("scan-qr").src = data.qr; document.getElementById("scan-qr").hidden = false; document.getElementById("scan-placeholder").hidden = true; document.getElementById("scan-code").textContent = data.code; updateScan(data, scan);
      if (state.scan !== scan) return;
      scan.timer = window.setInterval(function () { api("/api/scan/" + scan.id, "GET", null, function (error, status) { if (state.scan !== scan) return; if (error || !status) { document.getElementById("scan-message").textContent = "连接中断，请刷新二维码"; return; } updateScan(status, scan); }); }, 1000);
    });
  }
  function updateScan(data, scan) {
    var message = document.getElementById("scan-message"), expiry = document.getElementById("scan-expiry"), remaining = Number(data.remaining) || 0, value, input;
    if (state.scan !== scan || !message) return;
    expiry.textContent = Math.floor(remaining / 60) + ":" + (remaining % 60 < 10 ? "0" : "") + remaining % 60 + " 后失效";
    if (data.state === "waiting") message.textContent = data.connected ? "手机已连接，请在手机填写" : "等待手机连接";
    else if (data.state === "processing") message.textContent = "正在处理账号…";
    else if (data.state === "device_limit") message.textContent = "请在手机选择一台设备下线并登录";
    else if (data.state === "complete") {
      window.clearInterval(scan.timer); expiry.textContent = "手机已提交";
      if (scan.scope === "search") {
        value = data.value;
        closeScan();
        if (state.page !== "search") renderPage("search");
        input = document.getElementById("search-input");
        input.value = value;
        input.focus();
        doSearch(value, false);
      }
      else if (!scan.finishing) {
        scan.finishing = true; message.textContent = "账号操作成功，正在同步收藏和播放列表…";
        syncAccount(function (err, synced) {
          if (state.scan !== scan) return; message.textContent = synced ? "已完成账号同步" : "账号已登录，本地数据已保留";
          var parent = scan.parentModal; closeScan(); if (parent) closeLogin(); if (state.page === "account") { renderAccount(); var logoutButton = document.getElementById("account-logout"); if (logoutButton) logoutButton.focus(); }
        });
      }
    } else if (data.state === "expired" || data.state === "cancelled" || data.state === "failed") {
      window.clearInterval(scan.timer); message.textContent = data.message || "二维码已失效，请刷新"; expiry.textContent = "已失效"; document.getElementById("scan-qr").classList.add("is-expired"); document.getElementById("scan-refresh").focus();
    }
  }
  function syncAccount(done) {
    api("/api/library", "PUT", JSON.stringify({favorites: state.favorites, playlists: state.queue, recent: state.recent, merge: true}), function (err, data) { if (!err && data) applyLibrary(data); done(err, !!(data && data.synced)); });
  }
  function handleBack() {
    var modal = document.getElementById("modal-root");
    if (!modal.hidden) { if (state.exitDialog) closeExitConfirm(); else if (state.shareMenu) closeShareMenu(); else closeLogin(); return true; }
    if (state.queueOpen) { closeQueuePopup(); return true; }
    if (state.playerOpen) { closePlayerOverlay(); return true; }
    if (state.detailKind === "album") { var albumParent = state.detailReturn, albumCard; if (albumParent && albumParent.kind === "artist") { state.detailKind = "artist"; state.detailReturn = albumParent.source || albumParent.detail.source; state.artistDetail = albumParent.detail; state.artistAlbums = albumParent.albums; state.artistAlbumsOffset = albumParent.offset; state.artistAlbumsMore = albumParent.more; renderArtistDetail(albumParent.detail.data, albumParent.detail.sourceSong); albumCard = albumParent.albumId && content.querySelector('[data-album-id="' + esc(albumParent.albumId) + '"]'); if (albumCard) focusTarget(albumCard); } else restoreDetailSource(albumParent); return true; }
    if (state.detailKind === "artist") { restoreDetailSource(state.detailReturn); return true; }
    if (state.detailReturn) { var back = state.detailReturn; renderPage(back.page); state.returnPlaylist = {id: back.id, page: back.page, anchor: document.activeElement}; restorePlaylistReturn(content); return true; }
    if (state.page !== "recommend") { renderPage("recommend"); document.getElementById("nav-recommend").focus(); return true; }
    openExitConfirm(); return true;
  }
  window.MingmingTVBack = handleBack;
  window.MingmingTVBackground = function () { savePlayback(true); commentMotion.background = true; stopCommentMotion(); stopLyricTicker(); stopLyricMotion(); if (state.scan) closeScan(); };
  window.MingmingTVForeground = function () { commentMotion.background = false; refreshNativePlayback(); if (state.playbackStatus === "playing") syncLyricTicker(playbackPosition()); syncCommentMotion(); };
  document.addEventListener("visibilitychange", function () { if (document.hidden) window.MingmingTVBackground(); else window.MingmingTVForeground(); });
  window.addEventListener("pageshow", window.MingmingTVForeground);
  window.addEventListener("resize", function () { refreshViewport(); syncCommentMotion(); updateLyrics(playbackPosition(), true); });
  window.addEventListener("pagehide", function () { savePlayback(true); commentMotion.background = true; stopCommentMotion(); stopLyricTicker(); stopLyricMotion(); if (state.scan) { closeScan(); var xhr = new XMLHttpRequest(); xhr.open("POST", "/api/scan/cancel", false); try { xhr.send(); } catch (ignore) {} } });

  function logout() {
    var message = document.getElementById("account-message"), button = document.getElementById("account-logout");
    if (button) button.disabled = true;
    if (message) message.textContent = "正在退出…";
    api("/api/logout", "POST", "{}", function (err, data) {
      if (err || !data) { if (message) message.textContent = (err && err.message) || "退出失败，请重试"; if (button) button.disabled = false; return; }
      applyLibrary(data);
      if (state.page === "account") { renderAccount(); var target = document.getElementById("account-login"); if (target) target.focus(); }
      else if (state.page === "favorites") renderFavorites();
      else if (state.page === "queue") { if (state.libraryView === "recent") renderRecent(); else renderQueue(); }
    });
  }

  each(document, ".nav-item", function (b) { b.addEventListener("click", function () { renderPage(b.getAttribute("data-page")); }); });
  document.getElementById("queue-open").addEventListener("click", openQueuePopup);
  (function bindNowPlaying() {
    var button = document.getElementById("now-playing"), touch = null, lastTouch = 0;
    button.type = "button"; button.setAttribute("aria-label", "打开全屏播放器");
    button.addEventListener("touchstart", function (event) { var point = event.touches && event.touches[0]; touch = point ? {x: point.clientX, y: point.clientY} : null; });
    button.addEventListener("touchmove", function (event) { var point = event.touches && event.touches[0]; if (touch && point && (Math.abs(point.clientX - touch.x) > 12 || Math.abs(point.clientY - touch.y) > 12)) touch = null; });
    button.addEventListener("touchend", function (event) { if (!touch) return; event.preventDefault(); touch = null; lastTouch = Date.now(); openPlayerOverlay(); });
    button.addEventListener("touchcancel", function () { touch = null; });
    button.addEventListener("click", function (event) { if (event.detail > 0 && Date.now() - lastTouch < 800) { event.preventDefault(); return; } openPlayerOverlay(); });
  }());
  document.getElementById("player-close").addEventListener("click", closePlayerOverlay);
  document.getElementById("player-comments-toggle").addEventListener("click", toggleCommentsVisibility);
  document.getElementById("player-repeat").addEventListener("click", cyclePlayMode);
  document.getElementById("play-mode").addEventListener("click", cyclePlayMode);
  document.getElementById("overlay-prev").addEventListener("click", function () { playRelative(-1); });
  document.getElementById("overlay-next").addEventListener("click", function () { playRelative(1); });
  document.getElementById("overlay-queue").addEventListener("click", openQueuePopup);
  document.getElementById("overlay-favorite").addEventListener("click", function () { toggleFavorite(state.current); });
  document.getElementById("overlay-artist-info").addEventListener("click", function () { if (state.current) openShareMenu(state.current); });
  document.getElementById("overlay-play").addEventListener("click", togglePlayback);
  document.getElementById("prev").addEventListener("click", function () { playRelative(-1); });
  document.getElementById("next").addEventListener("click", function () { playRelative(1); });
  document.getElementById("play").addEventListener("click", togglePlayback);
  function seekTo(time) {
    var duration = playbackDuration();
    if (!isFinite(time) || !duration) return;
    stopLyricTicker(); stopLyricMotion();
    time = Math.max(0, Math.min(duration, time));
    playback.position = time;
    if (nativePlayer) { nativePlayer.command("seek", String(time)); playback.pendingSeek = null; }
    else if (playback.sourceReady) audio.currentTime = time; else playback.pendingSeek = time;
    syncProgress(time); updateLyrics(time, true); savePlayback();
    if (state.playbackStatus === "playing") syncLyricTicker(time);
  }
  function finishSeek() {
    var input = state.seekInput, time;
    if (!input) return;
    time = playbackDuration() * parseFloat(input.value) / 100;
    state.seekInput = null;
    if (isFinite(time)) seekTo(time); else syncProgress();
  }
  function bindSeek(input) {
    function begin() { state.seekInput = input; }
    input.addEventListener("mousedown", begin);
    input.addEventListener("touchstart", begin);
    input.addEventListener("input", function () {
      var time = playbackDuration() * parseFloat(input.value) / 100;
      if (!isFinite(time)) return;
      if (state.seekInput === input) syncProgress(time); else seekTo(time);
    });
    input.addEventListener("change", function () { if (state.seekInput) finishSeek(); else seekTo(playbackDuration() * parseFloat(input.value) / 100); });
    input.addEventListener("blur", finishSeek);
  }
  bindSeek(document.getElementById("seek")); bindSeek(document.getElementById("overlay-seek"));
  document.addEventListener("mouseup", finishSeek);
  document.addEventListener("touchend", finishSeek);
  document.addEventListener("touchcancel", finishSeek);
  function syncPlaybackVisuals(playing) { var covers = [document.getElementById("player-cover"), document.getElementById("overlay-cover")], i; for (i = 0; i < covers.length; i++) if (covers[i].classList.contains("is-playing") !== playing) covers[i].classList.toggle("is-playing", playing); }
  function syncProgress(previewTime) {
    var seek = document.getElementById("seek"), overlaySeek = document.getElementById("overlay-seek"), total = playbackDuration(), hasDuration = total > 0, time = typeof previewTime === "number" ? previewTime : playbackPosition(), percent, elapsed, duration, sliders = [seek, overlaySeek], i;
    if (state.seekInput && typeof previewTime !== "number" && hasDuration) time = total * parseFloat(state.seekInput.value) / 100;
    percent = hasDuration ? Math.max(0, Math.min(100, time / total * 100)) : 0;
    if (progressView.percent !== percent) {
      for (i = 0; i < sliders.length; i++) {
        sliders[i].value = percent;
        sliders[i].style.backgroundImage = "linear-gradient(to right,#c7f38d " + percent + "%,#405244 " + percent + "%)";
      }
      progressView.percent = percent;
    }
    elapsed = fmt(time); duration = hasDuration ? fmt(total) : "00:00";
    if (progressView.elapsed !== elapsed) { document.getElementById("player-elapsed").textContent = elapsed; document.getElementById("overlay-elapsed").textContent = elapsed; progressView.elapsed = elapsed; }
    if (progressView.duration !== duration) { document.getElementById("player-duration").textContent = duration; document.getElementById("overlay-duration").textContent = duration; progressView.duration = duration; }
  }
  function setPlaybackStatus(status) { var changed = state.playbackStatus !== status, visualPlaying = (status === "playing" || status === "buffering" || status === "preparing") && playback.wantPlay, label; state.playbackStatus = status; setPlaybackButtonState(!playbackPaused() && status !== "failed" && status !== "ended"); syncPlaybackVisuals(visualPlaying); if (status !== "playing") { stopLyricTicker(); if (changed) stopLyricMotion(); } else if (changed || lyricMotion.frame === null) syncLyricTicker(playbackPosition()); if (changed) updateTrackStates(); label = document.getElementById("lyric-status"); if (label) { if (status === "failed") { label.textContent = playbackErrorText(); label.hidden = false; } else if (!label.hidden) label.hidden = true; } syncCommentMotion(); }
  audio.addEventListener("play", function () { setPlaybackStatus("preparing"); });
  audio.addEventListener("playing", function () { setPlaybackStatus("playing"); savePlayback(); });
  audio.addEventListener("waiting", function () { setPlaybackStatus(audio.paused ? "paused" : "buffering"); });
  audio.addEventListener("seeking", function () { setPlaybackStatus(audio.paused ? "paused" : "buffering"); });
  audio.addEventListener("seeked", function () { if (applyPendingSeek() && playback.wantPlay && audio.paused) startAudio(); if (!audio.paused && audio.readyState >= 3) setPlaybackStatus("playing"); syncProgress(); });
  audio.addEventListener("pause", function () { if (playback.sourceReady) { setPlaybackStatus("paused"); savePlayback(); } });
  audio.addEventListener("error", function () { if (audio.getAttribute("src")) { playback.position = playbackPosition(); playback.sourceReady = false; playback.needsSource = true; playback.pendingSeek = playback.position; if (playback.wantPlay && continueAfterFailure()) return; playback.wantPlay = false; setPlaybackStatus("failed"); } });
  audio.addEventListener("loadedmetadata", function () {
    if (!state.current || !audio.getAttribute("src") || audio.readyState < 1) return;
    if (isFinite(audio.duration) && audio.duration > 0) { playback.duration = audio.duration; state.current.dt = audio.duration * 1000; }
    playback.sourceReady = true; applyPendingSeek(); syncProgress(); updateLyrics(playbackPosition()); updateTrackStates();
    if (playback.wantPlay) startAudio(); else setPlaybackStatus("paused");
  });
  function mediaCanSeek() { if (!playback.sourceReady) return; applyPendingSeek(); if (playback.wantPlay && audio.paused) startAudio(); }
  audio.addEventListener("canplay", mediaCanSeek); audio.addEventListener("progress", mediaCanSeek);
  audio.addEventListener("timeupdate", function () { syncProgress(); updateLyrics(playbackPosition()); if (state.playbackStatus === "playing") syncLyricTicker(playbackPosition()); if (playback.sourceReady && !audio.paused && Date.now() - playbackWrite.lastSave >= 5000) savePlayback(); });
  audio.addEventListener("ended", function () { setPlaybackStatus("ended"); handleEnded(); });
  if (nativePlayer) window.setInterval(function () { if (!commentMotion.background && !document.hidden) refreshNativePlayback(); }, 500);
  function fmt(n) { var minutes; n = Math.floor(n || 0); minutes = Math.floor(n / 60); return (minutes < 10 ? "0" : "") + minutes + ":" + (n % 60 < 10 ? "0" : "") + n % 60; }
  document.addEventListener("keydown", function (e) { if (e.keyCode === 27 || e.keyCode === 4) { if (handleBack()) e.preventDefault(); return; } if (e.keyCode === 37 || e.keyCode === 38 || e.keyCode === 39 || e.keyCode === 40 || e.keyCode === 13 || e.keyCode === 23 || e.keyCode === 66) { e.preventDefault(); moveFocus(e.keyCode); } });

  bindArtistAlbumsScroll(); renderControlIcons(); renderPlayMode(); loadSearchHistory(); state.commentsHidden = readPreference("mingming.commentDefault", "show") === "hide"; applySidebarMode(readPreference("mingming.sidebarMode", "expanded")); applyTextScale(readPreference("mingming.textScale", "standard")); applyMotionMode(readPreference("mingming.motion", "normal")); api("/health", "GET", null, function (err, data) { var dot = document.getElementById("connection-dot"), label = document.getElementById("connection-label"); if (!err && data) { dot.className = "status-dot ready"; label.textContent = data.capabilities && data.capabilities.fixture ? "预览数据" : "在线音乐"; state.fixture = !!(data.capabilities && data.capabilities.fixture); } else label.textContent = "服务连接失败"; }); loadLibrary(); loadPlayback(); renderPage("recommend"); focusInitial();
}());
