(function () {
  "use strict";
  var state = {
    page: "recommend", songs: [], queue: [], favorites: [], recent: [], current: null, fixture: false,
    authenticated: false, librarySynced: false,
    catalogue: [], categoryIndex: 0,
    libraryView: "queue",
    activeCat: "华语", playlists: [], playbackList: [], playbackListSource: "", searchProvider: "wy",
    lyricsText: "", lyricLines: [], lyricIndex: -1, lyricsLoaded: false, comments: [], commentsLoaded: false,
    commentsPage: 0, commentsPageSize: 10, commentsTotal: 0, commentsMore: false, commentsLoading: false, commentsError: false, commentsRetryAt: 0,
    playbackStatus: "idle",
    playerOpen: false, playerPreviousFocus: null, queueOpen: false, queuePreviousFocus: null, modalPreviousFocus: null, playMode: "list", playToken: 0,
    searchQuery: "", searchPage: 0, searchPageSize: 30, searchMore: false, searchLoading: false, searchRequest: 0, searchHistory: [], seekInput: null, detailReturn: null, returnPlaylist: null, scan: null, scanGeneration: 0
  };
  var content = document.getElementById("content"), side = document.getElementById("side-panel"), audio = document.getElementById("audio");
  var commentMotion = {frame: null, last: 0, position: 0, scroll: 0, background: false, holdUntil: 0};
  var commentView = {token: -1, count: 0};
  var requestFrame = window.requestAnimationFrame ? function (fn) { return window.requestAnimationFrame(fn); } : function (fn) { return window.setTimeout(function () { fn(Date.now()); }, 32); };
  var cancelFrame = window.cancelAnimationFrame ? function (id) { window.cancelAnimationFrame(id); } : function (id) { window.clearTimeout(id); };

  function each(root, selector, fn) { var nodes = root.querySelectorAll(selector), i; for (i = 0; i < nodes.length; i++) fn(nodes[i]); }
  function esc(v) { return String(v == null ? "" : v).replace(/[&<>\"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }
  function api(path, method, body, done) {
    var xhr = new XMLHttpRequest(); xhr.open(method || "GET", path, true); xhr.timeout = 18000;
    if (body) xhr.setRequestHeader("Content-Type", body.charAt(0) === "{" ? "application/json; charset=UTF-8" : "application/x-www-form-urlencoded; charset=UTF-8");
    xhr.onreadystatechange = function () { var data; if (xhr.readyState !== 4) return; data = null; try { data = JSON.parse(xhr.responseText); } catch (ignore) {} if (xhr.status >= 200 && xhr.status < 300) done(null, data); else done(new Error((data && (data.message || data.msg)) || "请求失败"), data); };
    xhr.ontimeout = function () { done(new Error("请求超时")); }; xhr.onerror = function () { done(new Error("网络不可用")); }; xhr.send(body || null);
  }
  function isUrl(value) { return typeof value === "string" && /^(https?:\/\/|\/)/.test(value); }
  function cover(song) { var value; if (!song) return "https://picsum.photos/seed/mingming-default/300/300"; value = song.picUrl || (song.al && song.al.picUrl) || song.coverPath || song.image || song.pic || song.pic_id; if (!isUrl(value)) return "https://picsum.photos/seed/mingming-default/300/300"; return value.charAt(0) === "/" ? "/media?url=" + encodeURIComponent(value) : value; }
  function songName(song) { return song && (song.name || song.title || song.mainTitle || "未命名歌曲"); }
  function artist(song) { var names = song && (song.ar || song.artists); if (names && names.length) return names.map(function (x) { return typeof x === "string" ? x : x.name; }).join(" / "); return song && (song.artist || "未知歌手"); }
  function album(song) { return song && song.al ? song.al.name : (song && (song.album || "单曲")); }
  function pageTitle(title, sub) { return '<div class="page-title"><h1>' + esc(title) + '</h1>' + (sub ? '<p>' + esc(sub) + '</p>' : '') + '</div>'; }
  function renderState(message, error) { content.innerHTML = '<div class="state' + (error ? ' error' : '') + '">' + esc(message) + '</div>'; }

  var focusMemory = {content: {}, footerReturn: null, overlayControl: "overlay-queue"};
  var libraryWrite = {inFlight: false, pending: false, revision: 0, callbacks: []};
  var playback = {position: 0, duration: 0, pendingSeek: null, needsSource: false, sourceReady: false, resolving: false, wantPlay: false};
  var playbackWrite = {clientId: String(Date.now()) + "-" + String(Math.random()).slice(2), sequence: 0, revision: 0, inFlight: false, pending: null, lastSave: 0};
  function playbackPosition() { return playback.pendingSeek != null ? playback.pendingSeek : (playback.sourceReady ? (audio.currentTime || 0) : playback.position); }
  function playbackDuration() { return playback.sourceReady && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : playback.duration; }
  function snapshotTrack(song) {
    var copy = {}, keys = ["id", "name", "title", "mainTitle", "artist", "album", "type", "provider", "source", "picUrl", "coverPath", "image", "pic", "pic_id", "dt", "duration", "interval", "time", "ar", "artists", "al"], i;
    for (i = 0; i < keys.length; i++) if (song[keys[i]] != null) copy[keys[i]] = song[keys[i]];
    return copy;
  }
  function savePlayback(synchronous) {
    var body, xhr;
    playbackWrite.revision += 1;
    if (!state.current) return;
    body = JSON.stringify({clientId: playbackWrite.clientId, sequence: ++playbackWrite.sequence, snapshot: {schema: 1, track: snapshotTrack(state.current), position: playbackPosition(), duration: playbackDuration(), mode: state.playMode, list: state.playbackList.slice(0, 500).map(snapshotTrack), listSource: state.playbackListSource}});
    playbackWrite.lastSave = Date.now(); playbackWrite.pending = body;
    if (synchronous) {
      // Loopback only. Flush before native exit destroys the WebView/core.
      // Sequence numbers stop an older asynchronous write replacing this one.
      xhr = new XMLHttpRequest(); xhr.open("PUT", "/api/playback", false); xhr.setRequestHeader("Content-Type", "application/json");
      try { xhr.send(body); if (xhr.status >= 200 && xhr.status < 300) playbackWrite.pending = null; } catch (ignore) {}
    } else flushPlaybackWrite();
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
    api("/api/playback", "GET", null, function (err, data) {
      var saved = data && data.snapshot;
      if (err || !saved || !saved.track || state.current || token !== state.playToken || revision !== playbackWrite.revision) return;
      state.playMode = saved.mode || "list"; state.playbackList = saved.list || []; state.playbackListSource = saved.listSource || "";
      selectTrack(saved.track, saved.position || 0, saved.duration || 0);
      setPlaybackStatus("paused"); renderPlayMode(); syncProgress();
    });
  }
  function focusRoot() { var modal = document.getElementById("modal-root"); return !modal.hidden ? modal : state.queueOpen ? document.getElementById("queue-popup") : state.playerOpen ? document.getElementById("player-overlay") : document; }
  function isFocusable(node) { return !!node && document.body.contains(node) && !node.disabled && node.getClientRects().length > 0 && window.getComputedStyle(node).visibility !== "hidden"; }
  function visibleFocusables(root) { var all = (root || document).querySelectorAll(".focusable"), visible = [], i; for (i = 0; i < all.length; i++) if (isFocusable(all[i])) visible.push(all[i]); return visible; }
  function parentMatch(node, selector, boundary) { while (node && node !== boundary && node !== document) { if (node.matches ? node.matches(selector) : node.webkitMatchesSelector && node.webkitMatchesSelector(selector)) return node; node = node.parentNode; } return null; }
  function activeNav() { return document.querySelector('.nav-item[data-page="' + state.page + '"]') || document.getElementById("nav-recommend"); }
  function bookmark(root) {
    var active = document.activeElement, row, attributes = ["data-playlist-id", "data-search-history", "data-provider", "data-library-tab", "data-category-index", "data-subcat", "data-current-action", "data-mode", "data-comment-index"], key = {}, i;
    if (!active || !active.classList.contains("focusable") || !root.contains(active)) return null;
    key.node = active; key.top = root.scrollTop; key.owner = focusRoot(); key.index = visibleFocusables(root).indexOf(active);
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
    if (isFocusable(key.node)) return key.node;
    if (key.song != null) { nodes = root.querySelectorAll(".track-row[data-song][data-track-id]"); for (i = 0; i < nodes.length; i++) if (nodes[i].getAttribute("data-track-id") === key.song) { row = nodes[i]; break; } if (!row && nodes.length) row = nodes[Math.min(key.rowIndex || 0, nodes.length - 1)]; if (row && key.action) { actions = row.querySelectorAll("[data-action]"); for (i = 0; i < actions.length; i++) if (actions[i].getAttribute("data-action") === key.action) return actions[i]; } return row || null; }
    if (key.id) { row = document.getElementById(key.id); if (row && root.contains(row) && isFocusable(row)) return key.action ? row.querySelector('[data-action="' + key.action + '"]') || row : row; }
    if (key.attribute) { nodes = root.querySelectorAll("[" + key.attribute + "]"); for (i = 0; i < nodes.length; i++) if (nodes[i].getAttribute(key.attribute) === key.value && isFocusable(nodes[i])) return nodes[i]; }
    return null;
  }
  function restoreBookmark(root, key) {
    var target;
    if (!key || key.owner !== focusRoot() || isFocusable(key.node) || (document.activeElement !== document.body && document.activeElement !== document.documentElement)) return;
    target = resolveBookmark(root, key) || visibleFocusables(root)[Math.max(0, Math.min(key.index, visibleFocusables(root).length - 1))];
    root.scrollTop = key.top || 0;
    focusTarget(target || (root === content ? activeNav() : document.getElementById("player-close")));
  }
  function contentEntry() { var key = focusMemory.content[state.page], target = resolveBookmark(content, key); return target || visibleFocusables(content)[0] || activeNav(); }
  function focusInitial() { var root = focusRoot(), target; if (root === document) target = activeNav(); else if (state.queueOpen && root.id === "queue-popup") target = root.querySelector(".track-row") || document.getElementById("queue-popup-close"); else target = visibleFocusables(root)[0]; focusTarget(target); }
  function scrollFocusIntoView(root, target, keepTallPosition) {
    var rootRect, targetRect, top, bottom, padding = 8, next, max;
    if (!root || !target || root.clientHeight <= 0) return;
    rootRect = root.getBoundingClientRect(); targetRect = target.getBoundingClientRect();
    top = targetRect.top - rootRect.top; bottom = targetRect.bottom - rootRect.top; next = root.scrollTop;
    if (targetRect.height > root.clientHeight - padding * 2) { if (!keepTallPosition || bottom < padding || top > root.clientHeight - padding) next += top - padding; }
    else if (top < padding) next += top - padding;
    else if (bottom > root.clientHeight - padding) next += bottom - (root.clientHeight - padding);
    max = Math.max(0, root.scrollHeight - root.clientHeight); root.scrollTop = Math.max(0, Math.min(max, next));
  }
  function focusTarget(target) {
    var previous = document.activeElement, node, row, roots = [], positions = [], i, style;
    if (!target || !document.body.contains(target)) return;
    row = parentMatch(target, ".track-row", document);
    node = target.parentNode;
    while (node && node !== document.body) { style = window.getComputedStyle(node); if (/(auto|scroll)/.test(style.overflowY) && node.clientHeight > 0) { roots.push(node); positions.push(node.scrollTop); } node = node.parentNode; }
    if (row && row !== target && window.getComputedStyle(target).visibility === "hidden") row.focus();
    try { target.focus({preventScroll: true}); } catch (ignore) { target.focus(); }
    for (i = 0; i < roots.length; i++) { roots[i].scrollTop = positions[i]; roots[i].scrollLeft = 0; scrollFocusIntoView(roots[i], row || target, previous === target); }
  }
  function focusQueueTarget(target) { focusTarget(target); }
  function focusRect(node) { var rect = node.getBoundingClientRect(); return {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2, width: rect.width, height: rect.height}; }
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
    if (code === 40) { focusMemory.footerReturn = bookmark(content); return document.getElementById("seek"); }
    return nearestFocus(code, row, visibleFocusables(content).filter(function (node) { return !parentMatch(node, ".track-row", content); })) || row;
  }
  function scrollRegionKey(code, active) {
    var max = Math.max(0, active.scrollHeight - active.clientHeight), next;
    if (code !== 38 && code !== 40) return false;
    next = Math.max(0, Math.min(max, active.scrollTop + (code === 40 ? 1 : -1) * Math.max(48, active.clientHeight * .45)));
    if (Math.abs(next - active.scrollTop) > 1) { active.scrollTop = next; return true; }
    return false;
  }
  function playerFocusKey(code, active) {
    if (code !== 37 && code !== 38 && code !== 39 && code !== 40 && active.id !== "seek" && active.id !== "overlay-seek") return false;
    var ids = state.playerOpen ? ["player-repeat", "overlay-prev", "overlay-play", "overlay-next", "overlay-queue"] : ["now-playing", "play-mode", "prev", "play", "next", "queue-open"], index = ids.indexOf(active.id), target, comments = document.getElementById("overlay-comments"), comment = parentMatch(active, ".comment", comments), commentEntry = visibleFocusables(comments)[0] || comments, nodes, next;
    if (active.id === "seek" || active.id === "overlay-seek") {
      if (code === 37 || code === 39) { seekTo(playbackPosition() + (code === 39 ? 5 : -5)); return true; }
      if (code === 13 || code === 23 || code === 66) return true;
      target = code === 40 ? document.getElementById(state.playerOpen ? "overlay-play" : "play") : (state.playerOpen ? document.getElementById("overlay-favorite") : resolveBookmark(content, focusMemory.footerReturn) || contentEntry());
    } else if (index >= 0) {
      if (code === 37 || code === 39) {
        if (state.playerOpen && code === 39 && index === ids.length - 1) target = commentEntry;
        else target = document.getElementById(ids[Math.max(0, Math.min(ids.length - 1, index + (code === 39 ? 1 : -1)))]);
      } else if (code === 38) target = active.id === "now-playing" ? resolveBookmark(content, focusMemory.footerReturn) || contentEntry() : document.getElementById(state.playerOpen ? "overlay-seek" : "seek");
      else if (code === 40) target = active;
      else return false;
    } else if (state.playerOpen) {
      if (active.id === "player-close") target = code === 39 ? commentEntry : code === 40 ? document.getElementById("overlay-favorite") : active;
      else if (active.id === "overlay-favorite") target = code === 40 ? document.getElementById("overlay-seek") : code === 39 ? commentEntry : code === 38 ? document.getElementById("player-close") : active;
      else if (comments.contains(active) || active === comments) {
        if (comment && (code === 38 || code === 40)) { var commentRect = comment.getBoundingClientRect(), viewRect = comments.getBoundingClientRect(), oldTop = comments.scrollTop; if (code === 40 && commentRect.bottom > viewRect.bottom - 8) comments.scrollTop += Math.min(comments.clientHeight * .45, commentRect.bottom - viewRect.bottom + 8); else if (code === 38 && commentRect.top < viewRect.top + 8) comments.scrollTop -= Math.min(comments.clientHeight * .45, viewRect.top + 8 - commentRect.top); if (comments.scrollTop !== oldTop) return true; }
        if (code === 37) target = document.getElementById(focusMemory.overlayControl);
        else if (code === 39) target = active;
        else { nodes = visibleFocusables(comments); next = nodes.indexOf(active) + (code === 40 ? 1 : -1); target = nodes[next]; if (!target) { if (code === 40) { loadMoreComments(comments); target = active; } else target = document.getElementById("player-close"); } }
      } else return false;
    } else if (active.id === "side-lyrics") {
      if (scrollRegionKey(code, active)) return true;
      target = code === 37 ? contentEntry() : code === 40 ? document.getElementById("seek") : active;
    } else return false;
    if (target) focusTarget(target);
    return true;
  }
  function modalFocus(code, active, root) {
    var close = document.getElementById(state.scan ? "scan-close" : "modal-close"), target;
    if (state.scan) { if (active === close) return code === 40 ? document.getElementById("scan-cancel") : active; if (code === 38) return close; }
    else { if (active === close) return code === 40 ? root.querySelector(".modal-tabs .is-active") : active; if (active.hasAttribute("data-mode") && code === 38) return close; if (active.id === "auth-user" && code === 38) return root.querySelector(".modal-tabs .is-active"); }
    target = nearestFocus(code, active, visibleFocusables(root)); return target || active;
  }
  function moveFocus(code) {
    var root = focusRoot(), active = document.activeElement, target, navs, index;
    code = {19: 38, 20: 40, 21: 37, 22: 39}[code] || code;
    if (code === 4 || code === 27) { handleBack(); return; }
    if (!isFocusable(active) || !active.classList.contains("focusable") || (root !== document && !root.contains(active))) { focusInitial(); active = document.activeElement; }
    if (!active || !active.classList.contains("focusable")) return;
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
      target = trackCardFocus(code, active) || nearestFocus(code, active, visibleFocusables(content).filter(function (node) { return !node.classList.contains("track-action"); }));
      if (!target && code === 37) target = activeNav();
      if (!target && code === 39) target = isFocusable(document.getElementById("side-lyrics")) ? document.getElementById("side-lyrics") : active;
      if (!target && code === 40) { focusMemory.footerReturn = bookmark(content); target = document.getElementById("seek"); }
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
    return '<svg ' + attrs + '><path d="M12 5v14M5 12h14"/></svg>';
  }
  function trackAction(action, icon, label, selected) { return '<button class="track-action focusable' + (selected ? ' is-selected' : '') + '" type="button" data-action="' + action + '" aria-label="' + label + '" title="' + label + '">' + songActionIcon(icon) + '</button>'; }
  function queueTrackAction(song) { var queued = isQueued(song); return trackAction("queue", queued ? "delete" : "queue", queued ? "从播放列表删除" : "加入播放列表", queued); }
  function track(song, index) {
    var favorite = isFavorite(song), actions = "";
    if (state.page === "queue" && state.libraryView === "queue") actions += trackAction("remove-queue", "delete", "从播放列表删除");
    else actions += queueTrackAction(song);
    if (state.page === "favorites") actions += trackAction("remove-favorite", "delete", "从收藏删除");
    else actions += trackAction("favorite", "favorite", favorite ? "取消收藏" : "收藏歌曲", favorite);
    return songRowMarkup(song, index, actions, false);
  }
  function songRowMarkup(song, index, actions, queueView) {
    var current = sameSong(state.current, song);
    return '<div class="track-row focusable' + (queueView ? ' queue-popup-item' : '') + (current ? ' is-current' : '') + '" role="button" tabindex="0" data-song="' + index + '" data-track-id="' + esc(song.id) + '" aria-label="播放 ' + esc(songName(song)) + '">' + (queueView ? '<span class="queue-popup-index">' + (index + 1) + '</span>' : '') + '<img data-cover-song="' + index + '" src="' + esc(cover(song)) + '" alt=""><div class="track-info"><strong>' + esc(songName(song)) + '</strong><span>' + esc(artist(song)) + (queueView ? '' : ' · ' + esc(album(song))) + '</span></div><span class="track-playing" aria-label="正在播放">' + (queueView ? '正在播放' : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12v8M12 4v16M19 8v12"/></svg>') + '</span><div class="track-actions">' + actions + '</div>' + (queueView ? '' : '<span class="track-duration">' + songDuration(song) + '</span>') + '</div>';
  }
  function card(song, index) { return '<button class="music-card focusable" data-song="' + index + '"><img data-cover-song="' + index + '" src="' + esc(cover(song)) + '" alt=""><strong>' + esc(songName(song)) + '</strong><span>' + esc(artist(song)) + '</span></button>'; }
  function playlistCard(playlist) { var id = playlist.id || playlist.playlistId || "", title = playlist.name || playlist.title || "精选歌单", creator = playlist.creator && playlist.creator.nickname || "网易云"; return '<button class="playlist-card focusable" data-playlist-id="' + esc(id) + '" data-playlist-name="' + esc(title) + '"><div class="playlist-cover"><img src="' + esc(playlist.coverImgUrl || playlist.cover || "https://picsum.photos/seed/playlist/360/360") + '" alt=""><span>网易云</span></div><strong>' + esc(title) + '</strong><small>' + esc(creator) + ' · ' + esc(playlist.trackCount || 0) + ' 首</small></button>'; }
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
  function hydrateCovers(root, source) { each(root, "img[data-cover-song]", function (image) { var songs = source || state.songs, song = songs[parseInt(image.getAttribute("data-cover-song"), 10)], value = song && song.pic_id; if (!song || isUrl(value) || (song.al && isUrl(song.al.picUrl)) || isUrl(song.picUrl) || isUrl(song.coverPath)) return; if (!song.id) return; api("/api/music/pic", "POST", "id=" + encodeURIComponent(song.id) + "&type=wy", function (err, data) { var resolved = data && data.data; if (!err && isUrl(resolved)) { song.picUrl = resolved; image.src = resolved; } }); }); each(root, "img[data-current-cover]", function (image) { var song = (source && source[0]) || state.current || state.recent[0], value = song && song.pic_id; if (!song || isUrl(value) || (song.al && isUrl(song.al.picUrl)) || isUrl(song.picUrl) || isUrl(song.coverPath) || !song.id) return; api("/api/music/pic", "POST", "id=" + encodeURIComponent(song.id) + "&type=wy", function (err, data) { var resolved = data && data.data; if (!err && isUrl(resolved)) { song.picUrl = resolved; image.src = resolved; } }); }); }
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
    if (hero && song) { hero.setAttribute("data-track-id", song.id); hero.setAttribute("aria-label", "播放 " + songName(song)); hero.querySelector("strong").textContent = songName(song); hero.querySelector(".recent-hero-info>span:last-child").textContent = artist(song) + " · " + album(song); hero.querySelector("img").src = cover(song); }
    each(document, ".track-row[data-track-id]", function (row) {
      var current = state.current && row.getAttribute("data-track-id") === String(state.current.id), button = row.querySelector('[data-action="favorite"]'), favorite = state.favorites.some(function (song) { return String(song.id) === row.getAttribute("data-track-id"); }), queueButton = row.querySelector('[data-action="queue"]'), queued = isQueued({id: row.getAttribute("data-track-id")}), time = row.querySelector(".track-duration"), queueLabel = queued ? "从播放列表删除" : "加入播放列表";
      row.classList.toggle("is-current", !!current);
      if (button) { button.classList.toggle("is-selected", favorite); button.title = favorite ? "取消收藏" : "收藏歌曲"; button.setAttribute("aria-label", button.title); button.setAttribute("aria-pressed", favorite ? "true" : "false"); }
      if (queueButton) { queueButton.classList.toggle("is-selected", queued); queueButton.title = queueLabel; queueButton.setAttribute("aria-label", queueLabel); if (queueButton.getAttribute("aria-pressed") !== (queued ? "true" : "false")) queueButton.innerHTML = songActionIcon(queued ? "delete" : "queue"); queueButton.setAttribute("aria-pressed", queued ? "true" : "false"); }
      if (current && time && state.current.dt) time.textContent = songDuration(state.current);
    });
    renderOverlayFavorite();
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
    var origin = document.activeElement, request = {page: backPage || "recommend", id: id}; state.detailReturn = request; focusMemory.content[state.page] = null; content.scrollTop = 0;
    content.innerHTML = pageTitle(name || "歌单", "网易云 · 歌曲列表") + '<div id="playlist-detail-body" class="track-list"><div class="state">正在加载歌曲…</div></div>';
    api("/api/music/list", "POST", "id=" + encodeURIComponent(id) + "&type=wy", function (err, data) {
      var box = document.getElementById("playlist-detail-body"); if (!box || state.detailReturn !== request) return;
      state.songs = extractTracks(data); box.innerHTML = err ? '<div class="state error">' + esc(err.message) + '</div>' : (state.songs.length ? state.songs.map(track).join("") : '<div class="empty">暂无歌曲</div>'); bindSongActions(box); var first = box.querySelector(".track-row"); if (first && focusRoot() === document && (document.activeElement === document.body || document.activeElement === origin)) focusTarget(first);
    });
  }

  function renderRankingCards(items) { var savedFocus = bookmark(content), box = document.getElementById("playlist-body"); if (!box) return; box.innerHTML = items.map(playlistCard).join(""); bindPlaylistActions(box, "playlists"); restoreBookmark(content, savedFocus); }
  function loadRanking() { var requestBox = document.getElementById("playlist-body"), definitions = rankingDefinitions(), pending = definitions.length, i; renderRankingCards(definitions); for (i = 0; i < definitions.length; i++) (function (index) { api("/api/music/list", "POST", "id=" + encodeURIComponent(definitions[index].id) + "&type=wy", function (err, data) { var playlist = data && data.data && data.data.playlist; if (!err && playlist) { definitions[index] = {id: String(playlist.id || definitions[index].id), name: playlist.name || definitions[index].name, coverImgUrl: playlist.coverImgUrl || "", trackCount: playlist.trackCount || definitions[index].trackCount, creator: {nickname: "网易云"}}; } pending -= 1; if (!pending && state.page === "playlists" && !state.detailReturn && requestBox === document.getElementById("playlist-body")) renderRankingCards(definitions); }); }(i)); }
  function renderPlaylists() { content.innerHTML = pageTitle("排行榜", "网易云官方榜单") + '<div id="playlist-body" class="playlist-grid"><div class="state">正在加载排行榜…</div></div>'; loadRanking(); }
  function renderInspiration() { content.innerHTML = pageTitle("灵感音乐", "来自音乐广场的声音") + '<div id="inspiration-body" class="card-grid"><div class="state">正在加载灵感音乐…</div></div>'; api("/api/aimusic/square?limit=50", "GET", null, function (err, data) { state.songs = data && (data.list || data.data || data.items || []) || []; var box = document.getElementById("inspiration-body"); box.innerHTML = err ? '<div class="state error">' + esc(err.message) + '</div>' : (state.songs.length ? state.songs.map(card).join("") : '<div class="empty">暂无灵感音乐</div>'); bindSongActions(box); }); }
  function queueTabs(active) { return '<div class="library-tabs"><button class="tab focusable' + (active === "queue" ? ' is-active' : '') + '" data-library-tab="queue">播放列表 <b>' + state.queue.length + '</b></button><button class="tab focusable' + (active === "recent" ? ' is-active' : '') + '" data-library-tab="recent">最近播放 <b>' + state.recent.length + '</b></button></div>'; }
  function recentHero() { var song = state.current || state.recent[0], favorite = isFavorite(song); if (!song) return '<div class="recent-hero empty-recent"><span>还没有最近播放的歌曲</span></div>'; return '<div id="recent-current-track" class="recent-hero track-row focusable" role="button" tabindex="0" data-track-id="' + esc(song.id) + '" aria-label="播放 ' + esc(songName(song)) + '"><img data-current-cover src="' + esc(cover(song)) + '" alt=""><div class="recent-hero-info"><span class="eyebrow">最近在播放</span><strong>' + esc(songName(song)) + '</strong><span>' + esc(artist(song)) + ' · ' + esc(album(song)) + '</span></div><div class="track-actions">' + queueTrackAction(song) + trackAction("favorite", "favorite", favorite ? "取消收藏" : "收藏歌曲", favorite) + '</div></div>'; }
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
  function renderAccount() { var savedFocus = bookmark(content); var loggedIn = state.authenticated, html = pageTitle("我的", "账号与同步") + '<section class="account-page"><div class="account-avatar" aria-hidden="true">♪</div><div class="account-details"><span class="account-eyebrow">明明音乐账号</span><h2>' + (loggedIn ? "已登录" : "还没有登录") + '</h2><p>' + (loggedIn ? "此设备已连接账号，收藏和播放列表会随账号同步。" : "登录账号后，可在设备间同步收藏和播放列表。") + '</p><div class="account-actions">';
    if (loggedIn) html += '<button id="account-logout" class="account-action account-logout focusable" type="button">退出登录</button><span id="account-message" class="account-message" aria-live="polite"></span>';
    else html += '<button id="account-login" class="account-action account-primary focusable" type="button">登录</button><button id="account-register" class="account-action account-secondary focusable" type="button">注册</button><button id="account-scan-login" class="scan-button focusable" type="button">' + scanIcon() + '<span>扫码登录</span></button><button id="account-scan-register" class="scan-button focusable" type="button">' + scanIcon() + '<span>扫码注册</span></button><button id="account-reset" class="account-action account-link focusable" type="button">忘记密码</button>';
    html += '</div></div></section>'; content.innerHTML = html;
    if (loggedIn) document.getElementById("account-logout").addEventListener("click", logout);
    else { document.getElementById("account-scan-login").onclick = function () { openScan("login"); }; document.getElementById("account-scan-register").onclick = function () { openScan("register"); }; document.getElementById("account-login").addEventListener("click", function () { openLogin("login"); }); document.getElementById("account-register").addEventListener("click", function () { openLogin("register"); }); document.getElementById("account-reset").addEventListener("click", function () { openLogin("reset"); }); }
   restoreBookmark(content, savedFocus); }
  function renderPage(page) { var previous = document.activeElement; if (state.scan) closeScan(); state.detailReturn = null; state.returnPlaylist = null; state.page = page; content.scrollTop = 0; focusMemory.footerReturn = null; each(document, ".nav-item", function (b) { b.classList.toggle("is-active", b.getAttribute("data-page") === page); }); if (page === "recommend") renderRecommend(); else if (page === "search") renderSearch(); else if (page === "playlists") renderPlaylists(); else if (page === "inspiration") renderInspiration(); else if (page === "queue") renderQueue(); else if (page === "recent") renderRecent(); else if (page === "account") renderAccount(); else renderFavorites(); if (!isFocusable(previous) && focusRoot() === document) focusTarget(activeNav()); }
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
  function commentItems(data) {
    var items = data && (data.comments || data.hotComments || data.data || data.items) || [];
    if (items && items.comments) items = items.comments;
    if (!Array.isArray(items)) items = [];
    return items;
  }
  function commentAvatar(item, user) { return user && (user.avatarUrl || user.avatar || user.avatarUrlOrigin) || item.avatarUrl || "https://picsum.photos/seed/mingming-comment/80/80"; }
  function commentTime(item) { return item.timeStr || (item.time ? new Date(item.time).toLocaleDateString() : ""); }
  function commentMarkup(items, startIndex) { return items.length ? items.map(function (x, index) { var user = x.user && (x.user.nickname || x.user.name) || x.user || x.nickname || "音乐用户", profile = typeof x.user === "object" ? x.user : null, meta = commentTime(x), likes = x.likedCount ? " · " + x.likedCount + " 赞" : ""; return '<div class="comment focusable" tabindex="0" data-comment-index="' + ((startIndex || 0) + index) + '"><img class="comment-avatar" src="' + esc(commentAvatar(x, profile)) + '" alt=""><div class="comment-body"><div class="comment-meta"><strong>' + esc(user) + '</strong>' + (meta || likes ? '<span>' + esc(meta) + esc(likes) + '</span>' : '') + '</div><p>' + esc(x.content || x.comment || x.text || "") + '</p></div></div>'; }).join("") : '<div class="state">暂无评论</div>'; }
  function updateCommentCount() { var total = state.commentsTotal || 0, count = document.getElementById("comment-count"), sideCount = document.getElementById("side-comment-count"); if (count) { count.textContent = total ? String(total) : (state.commentsLoading ? "…" : String(state.comments.length)); count.parentNode.setAttribute("aria-label", "评论 " + (total || state.comments.length) + " 条"); } if (sideCount) sideCount.textContent = total ? state.comments.length + "/" + total + " 条" : (state.commentsLoading ? "加载中…" : state.comments.length + " 条"); }
  function lyricMarkup() { return state.lyricLines.length ? state.lyricLines.map(function (line, index) { return '<div class="lyric-line' + (index === state.lyricIndex ? ' active' : '') + '" data-lyric-index="' + index + '">' + esc(line.text) + '</div>'; }).join("") : '<div class="state">' + esc(state.lyricsText || "暂无歌词") + '</div>'; }
  function loadMoreComments(root) {
    if (!root || !state.playerOpen || root.clientHeight <= 0 || state.commentsLoading || Date.now() < state.commentsRetryAt) return;
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
    return state.playerOpen && state.current && state.playbackStatus === "playing" && !audio.paused && !audio.ended && !document.hidden && !commentMotion.background && !state.queueOpen && document.getElementById("modal-root").hidden && root.clientHeight > 0 && !root.contains(document.activeElement);
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
    if (reset) { root.innerHTML = ""; root.scrollTop = 0; commentView.token = state.playToken; commentView.count = 0; commentMotion.position = 0; commentMotion.scroll = 0; }
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
  function renderSidePanel() {
    var savedFocus = bookmark(side), song = state.current, lyricsBox = document.getElementById("side-lyrics"), lyricScroll = lyricsBox ? lyricsBox.scrollTop : 0;
    if (!song) { side.innerHTML = ""; return; }
    side.innerHTML = '<div id="side-lyrics" class="lyrics focusable" tabindex="0" aria-label="歌词，可上下滚动">' + lyricMarkup() + '</div>';
    lyricsBox = document.getElementById("side-lyrics");
    if (lyricsBox) lyricsBox.scrollTop = lyricScroll; restoreBookmark(side, savedFocus);
    updateLyrics(playbackPosition());
  }
  function modeIcon(mode) {
    var attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    if (mode === "shuffle") return '<svg ' + attrs + '><path d="m18 3 3 3-3 3M18 15l3 3-3 3M3 6h3c5 0 7 12 12 12h3M3 18h3c1.6 0 3-1.2 4.4-3.2M14 9.2C15.4 7.2 16.7 6 18 6h3"/></svg>';
    return '<svg ' + attrs + '><path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>' + (mode === "one" ? '<path d="m10 10 2-1v6M10 15h4"/>' : '') + '</svg>';
  }
  function renderQueueButton() {
    var button = document.getElementById("queue-open");
    if (!button) return;
    button.innerHTML = controlIcon("queue") + '<span>播放列表 <b>' + state.queue.length + '</b></span>';
    button.setAttribute("aria-label", "播放列表 " + state.queue.length);
  }
  function playModeInfo() { var modes = {list: {label: "列表循环"}, one: {label: "单曲循环"}, shuffle: {label: "随机播放"}}; return modes[state.playMode] || modes.list; }
  function controlIcon(name) {
    var attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
    if (name === "prev") return '<svg ' + attrs + '><path d="M6 5v14M19 6l-9 6 9 6V6Z"/></svg>';
    if (name === "next") return '<svg ' + attrs + '><path d="M18 5v14M5 6l9 6-9 6V6Z"/></svg>';
    if (name === "pause") return '<svg ' + attrs + '><path d="M8 5v14M16 5v14"/></svg>';
    if (name === "queue") return '<svg ' + attrs + '><path d="M4 6h16M4 12h16M4 18h9"/></svg>';
    if (name === "close") return '<svg ' + attrs + '><path d="m15 5-7 7 7 7"/></svg>';
    return '<svg ' + attrs + '><path class="play-triangle" d="m9 5 10 7-10 7V5Z"/></svg>';
  }
  function setControlIcon(id, name, label) { var button = document.getElementById(id); if (!button) return; button.innerHTML = controlIcon(name); if (label) { button.title = label; button.setAttribute("aria-label", label); } }
  function renderControlIcons() { setControlIcon("player-close", "close", "返回"); setControlIcon("prev", "prev", "上一首"); setControlIcon("play", audio.paused ? "play" : "pause", audio.paused ? "播放" : "暂停"); setControlIcon("next", "next", "下一首"); renderQueueButton(); setControlIcon("overlay-prev", "prev", "上一首"); setControlIcon("overlay-play", audio.paused ? "play" : "pause", audio.paused ? "播放" : "暂停"); setControlIcon("overlay-next", "next", "下一首"); setControlIcon("overlay-queue", "queue", "播放列表"); renderOverlayFavorite(); }
  function renderOverlayFavorite() {
    var button = document.getElementById("overlay-favorite"), selected = isFavorite(state.current), label = selected ? "取消收藏" : "收藏歌曲";
    if (!button) return;
    if (!button.firstChild) button.innerHTML = songActionIcon("favorite");
    button.disabled = !state.current; button.classList.toggle("is-selected", selected); button.title = label; button.setAttribute("aria-label", label); button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  function setPlaybackButtonState(playing) { setControlIcon("play", playing ? "pause" : "play", playing ? "暂停" : "播放"); setControlIcon("overlay-play", playing ? "pause" : "play", playing ? "暂停" : "播放"); }
  function renderPlayMode() { var info = playModeInfo(), mode = document.getElementById("play-mode"), repeat = document.getElementById("player-repeat"); if (mode) { mode.innerHTML = modeIcon(state.playMode) + '<span>' + info.label + '</span>'; mode.title = "播放顺序：" + info.label; mode.setAttribute("aria-label", "播放顺序：" + info.label); } if (repeat) { repeat.innerHTML = modeIcon(state.playMode); repeat.title = "播放顺序：" + info.label; repeat.setAttribute("aria-label", "切换播放顺序，当前为" + info.label); repeat.classList.toggle("is-on", state.playMode !== "list"); } }
  function renderPlayerOverlay() {
    var overlay = document.getElementById("player-overlay"), song = state.current, title = document.getElementById("overlay-title"), artistNode = document.getElementById("overlay-artist"), albumNode = document.getElementById("overlay-album"), coverNode = document.getElementById("overlay-cover"), lyrics = document.getElementById("overlay-lyrics"), comments = document.getElementById("overlay-comments"), status = document.getElementById("lyric-status");
    if (!overlay) return;
    if (song) { title.textContent = songName(song); artistNode.textContent = artist(song); albumNode.textContent = album(song); coverNode.src = cover(song); }
    renderOverlayFavorite();
    lyrics.innerHTML = lyricMarkup(); renderOverlayComments(comments, song); status.textContent = state.lyricLines.length ? "" : (song ? (state.lyricsLoaded ? "暂无歌词" : "正在加载歌词…") : "等待播放"); status.hidden = !!state.lyricLines.length; renderPlayMode(); updateCommentCount(); bindCommentScroll(comments); bindFocusScroll(comments); updateLyrics(playbackPosition()); syncCommentMotion();
  }
  function scrollLyricIntoView(active) {
    var container, target, max, activeRect, containerRect;
    if (!active) return;
    container = active.parentNode;
    if (!container || container.clientHeight <= 0 || container.scrollHeight <= container.clientHeight) return;
    activeRect = active.getBoundingClientRect(); containerRect = container.getBoundingClientRect();
    target = container.scrollTop + activeRect.top - containerRect.top - (container.clientHeight - activeRect.height) / 2;
    max = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.max(0, Math.min(max, target));
  }
  function updateLyrics(time) {
    var next = -1, i, nodes, active;
    for (i = 0; i < state.lyricLines.length; i++) { if (state.lyricLines[i].time >= 0 && state.lyricLines[i].time <= time) next = i; }
    // Keep the first lyric visibly selected before the first timed line begins
    // or while a WebView has not produced its first timeupdate event yet.
    if (next < 0 && state.lyricLines.length) next = 0;
    state.lyricIndex = next; nodes = document.querySelectorAll("#overlay-lyrics .lyric-line, #side-lyrics .lyric-line"); for (i = 0; i < nodes.length; i++) nodes[i].classList.toggle("active", parseInt(nodes[i].getAttribute("data-lyric-index"), 10) === next);
    active = next >= 0 ? document.querySelector('#overlay-lyrics .lyric-line[data-lyric-index="' + next + '"]') : null;
    if (!active || active.parentNode !== document.activeElement) scrollLyricIntoView(active);
    active = next >= 0 ? document.querySelector('#side-lyrics .lyric-line[data-lyric-index="' + next + '"]') : null;
    if (!active || active.parentNode !== document.activeElement) scrollLyricIntoView(active);
  }
  function loadCommentsPage(page, token, append) {
    var song = state.current, offset, shouldAppend = !!append && page > 0, requestToken = state.playToken, settled = false;
    if (!song || (token && token !== requestToken) || state.commentsLoading || Date.now() < state.commentsRetryAt || (!state.commentsMore && shouldAppend)) return;
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
    api("/api/music/lrc", "POST", "id=" + encodeURIComponent(song.id || "") + "&type=wy", function (err, data) { var text = err ? "歌词暂不可用" : (data && data.data || "暂无歌词"); if (token !== state.playToken) return; state.lyricsLoaded = true; state.lyricsText = text; state.lyricLines = parseLyrics(text); state.lyricIndex = -1; renderSidePanel(); renderPlayerOverlay(); });
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
  function playRelative(direction) { var items = playbackItems(), index = -1, i; if (!items.length) return; if (state.current) for (i = 0; i < items.length; i++) if (String(items[i].id) === String(state.current.id)) { index = i; break; } if (index < 0) index = direction > 0 ? -1 : items.length; play(items[(index + direction + items.length) % items.length]); }
  function selectTrack(song, position, duration) {
    audio.pause(); audio.removeAttribute("src"); audio.load();
    playback.position = position || 0; playback.duration = duration || (Number(song.dt) / 1000) || 0; playback.pendingSeek = playback.position; playback.needsSource = true; playback.sourceReady = false; playback.resolving = false; playback.wantPlay = false;
    state.current = song; state.playToken += 1; state.lyricsText = "正在加载歌词…"; state.lyricLines = []; state.lyricIndex = -1; state.lyricsLoaded = false; state.comments = []; state.commentsLoaded = false; state.commentsPage = 0; state.commentsTotal = 0; state.commentsMore = false; state.commentsLoading = false; state.commentsError = false; state.commentsRetryAt = 0; commentMotion.holdUntil = 0;
    document.getElementById("player-title").textContent = songName(song); document.getElementById("player-artist").textContent = artist(song); document.getElementById("player-cover").src = cover(song); updateTrackStates(); renderSidePanel(); renderPlayerOverlay(); syncProgress();
    loadLyricsComments(song, state.playToken);
  }
  function play(song) {
    if (!song) return;
    selectTrack(song, 0, 0); rememberRecent(song); savePlayback(); togglePlayback();
  }
  function resolveCurrentSource() {
    var song = state.current, token = state.playToken, directSource;
    if (!song || playback.resolving) return;
    playback.resolving = true; setPlaybackStatus("preparing");
    directSource = song.audioPath || song.audioUrl || song.audio_url;
    if (directSource) setAudioSource(directSource); else api("/api/music/url", "POST", "id=" + encodeURIComponent(song.id || "") + "&type=" + encodeURIComponent(song.type || song.provider || "wy"), function (err, data) { var source = data && data.data, status; if (token !== state.playToken) return; playback.resolving = false; if (err || !source) { playback.wantPlay = false; setPlaybackStatus("failed"); status = document.getElementById("lyric-status"); status.textContent = "播放地址获取失败"; status.hidden = false; return; } setAudioSource(source); });
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
    if (promise && promise.catch) promise.catch(function () { if (token === state.playToken && playback.wantPlay) { playback.wantPlay = false; setPlaybackStatus("failed"); } });
  }
  function togglePlayback() {
    if (!state.current) return;
    if (!audio.paused || playback.wantPlay) { playback.wantPlay = false; audio.pause(); setPlaybackStatus("paused"); savePlayback(); return; }
    playback.wantPlay = true;
    if (playback.needsSource) resolveCurrentSource();
    else if (playback.sourceReady) startAudio();
    else setPlaybackStatus("preparing");
  }
  function setAudioSource(source) {
    playback.resolving = false; playback.needsSource = false; playback.sourceReady = false;
    setPlaybackStatus(playback.wantPlay ? "preparing" : "paused"); audio.src = "/media?url=" + encodeURIComponent(source); audio.load();
  }
  function openPlayerOverlay() { var overlay = document.getElementById("player-overlay"), close; if (!state.current || !overlay) return; state.playerPreviousFocus = document.activeElement; state.playerOpen = true; overlay.hidden = false; renderPlayerOverlay(); close = document.getElementById("player-close"); if (close) close.focus(); }
  function queuePopupMarkup(items) {
    var html = "", i, song, actions, favorite;
    for (i = 0; i < items.length; i++) {
      song = items[i]; favorite = isFavorite(song);
      actions = trackAction("favorite", "favorite", favorite ? "取消收藏" : "收藏歌曲", favorite);
      if (state.playbackListSource === "queue") actions += trackAction("remove-queue", "delete", "从播放列表删除");
      html += songRowMarkup(song, i, actions, true);
    }
    return html || '<div class="state">播放列表为空</div>';
  }
  function renderQueuePopup(targetIndex, targetAction, scrollTop) {
    var popup = document.getElementById("queue-popup"), items = playbackItems(), close, i, row, target;
    if (!popup) return;
    popup.innerHTML = '<div class="queue-dialog" role="dialog" aria-modal="true" aria-label="播放列表"><div class="queue-dialog-head"><div><h2>播放列表</h2><span>' + items.length + ' 首歌曲</span></div><button id="queue-popup-close" class="icon-button focusable" type="button" title="返回播放器" aria-label="返回播放器"></button></div><div class="queue-popup-list">' + queuePopupMarkup(items) + '</div></div>';
    setControlIcon("queue-popup-close", "close", "返回播放器"); close = document.getElementById("queue-popup-close"); close.addEventListener("click", closeQueuePopup);
    each(popup, ".track-row[data-song]", function (el) {
      el.addEventListener("focusin", function () { el.classList.add("has-focus"); });
      el.addEventListener("focusout", function () { window.setTimeout(function () { if (!el.contains(document.activeElement)) el.classList.remove("has-focus"); }, 0); });
      el.addEventListener("click", function (event) {
        var node = event.target, action = null, index = parseInt(el.getAttribute("data-song"), 10), song = items[index], top = popup.querySelector(".queue-popup-list").scrollTop;
        while (node && node !== el) { if (node.getAttribute && node.getAttribute("data-action")) { action = node.getAttribute("data-action"); break; } node = node.parentNode; }
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
    hydrateCovers(popup, items); updateTrackStates();
    for (i = 0; i < items.length; i++) if (sameSong(items[i], state.current)) break;
    if (typeof targetIndex === "number") i = Math.min(targetIndex, items.length - 1);
    row = popup.querySelector('[data-song="' + (i < items.length ? i : 0) + '"]'); target = row && targetAction ? row.querySelector('[data-action="' + targetAction + '"]') : row;
    if (typeof scrollTop === "number") popup.querySelector(".queue-popup-list").scrollTop = scrollTop;
    focusQueueTarget(target || row || close);
  }
  function openQueuePopup() { var popup = document.getElementById("queue-popup"); if (!state.playerOpen || !popup) return; state.queuePreviousFocus = document.activeElement; state.queueOpen = true; popup.hidden = false; syncCommentMotion(); renderQueuePopup(); }
  function closeQueuePopup() { var popup = document.getElementById("queue-popup"), previous = state.queuePreviousFocus, fallback; if (!popup) return; state.queueOpen = false; popup.hidden = true; state.queuePreviousFocus = null; fallback = document.getElementById("overlay-queue"); if (previous && previous.focus && document.body.contains(previous) && !previous.hidden) previous.focus(); else if (fallback) fallback.focus(); syncCommentMotion(); }
  function closePlayerOverlay() { var overlay = document.getElementById("player-overlay"), previous = state.playerPreviousFocus; if (!overlay) return; if (state.queueOpen) closeQueuePopup(); state.playerOpen = false; overlay.hidden = true; stopCommentMotion(); state.playerPreviousFocus = null; if (previous && previous.focus && document.body.contains(previous)) previous.focus(); else focusInitial(); }
  function cyclePlayMode() { state.playMode = state.playMode === "list" ? "one" : (state.playMode === "one" ? "shuffle" : "list"); renderPlayMode(); if (state.playerOpen) renderPlayerOverlay(); savePlayback(); }
  function playRandom() { var items = playbackItems(), candidates = [], current = state.current, i; for (i = 0; i < items.length; i++) if (!current || String(items[i].id) !== String(current.id)) candidates.push(items[i]); if (!candidates.length) candidates = items; if (candidates.length) play(candidates[Math.floor(Math.random() * candidates.length)]); }
  function handleEnded() { if (state.playbackListSource === "queue" && !state.queue.some(function (song) { return sameSong(song, state.current); })) { playRelative(1); return; } if (state.playMode === "one") { audio.currentTime = 0; var replay = audio.play(); if (replay && replay.catch) replay.catch(function () {}); return; } if (state.playMode === "shuffle") { playRandom(); return; } playRelative(1); }
  function applyLibrary(data) { if (!data) return; state.favorites = data.favorites || []; state.queue = data.playlists || []; state.recent = data.recent || []; state.authenticated = !!data.authenticated; state.librarySynced = !!data.synced; document.getElementById("queue-count").textContent = state.queue.length; renderQueueButton(); updateTrackStates(); }
  function saveLibrary(done) { libraryWrite.revision += 1; libraryWrite.pending = true; if (done) libraryWrite.callbacks.push(done); flushLibraryWrite(); }
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
  function loadLibrary(done) { var revision = libraryWrite.revision; api("/api/library", "GET", null, function (err, data) { if (!err && data && revision === libraryWrite.revision && !libraryWrite.inFlight && !libraryWrite.pending) { applyLibrary(data); if (state.page === "account") renderAccount(); else if (state.page === "favorites") renderFavorites(); } if (done) done(err, data); }); }
  function openLogin(mode) { var root = document.getElementById("modal-root"); state.modalPreviousFocus = document.activeElement; root.hidden = false; syncCommentMotion(); root.innerHTML = '<div class="modal" role="dialog"><button id="modal-close" class="modal-close focusable">×</button><h2>明明音乐账号</h2><div class="modal-tabs"><button class="is-active focusable" data-mode="login">登录</button><button class="focusable" data-mode="register">注册</button><button class="focusable" data-mode="reset">找回密码</button></div><form id="auth-form"><div class="field"><label>用户名或邮箱</label><input id="auth-user" class="focusable" autocomplete="username"></div><div class="field"><label>密码</label><input id="auth-pass" class="focusable" type="password" autocomplete="current-password"></div><div id="auth-extra"></div><div class="modal-actions"><button id="auth-scan" type="button" class="scan-button focusable">' + scanIcon() + '<span>扫码登录</span></button><button id="auth-submit" class="primary focusable">登录</button></div><div id="auth-message" class="modal-message" aria-live="polite"></div></form></div>'; document.getElementById("auth-scan").addEventListener("click", function () { openScan(root.getAttribute("data-mode") || "login"); }); document.getElementById("modal-close").addEventListener("click", closeLogin); each(root, "[data-mode]", function (b) { b.addEventListener("click", function () { setAuthMode(b.getAttribute("data-mode")); }); }); document.getElementById("auth-form").addEventListener("submit", submitAuth); setAuthMode(mode || "login"); document.getElementById("auth-user").focus(); }
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
  function closeLogin() { if (state.scan) { closeScan(); return; } var root = document.getElementById("modal-root"), previous = state.modalPreviousFocus, fallback; root.hidden = true; root.innerHTML = ""; state.modalPreviousFocus = null; if (previous && previous.focus && document.body.contains(previous)) previous.focus(); else if (state.page === "account") { fallback = document.getElementById(state.authenticated ? "account-logout" : "account-login"); if (fallback) fallback.focus(); } syncCommentMotion(); }
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
    if (!document.getElementById("modal-root").hidden) { closeLogin(); return true; }
    if (state.queueOpen) { closeQueuePopup(); return true; }
    if (state.playerOpen) { closePlayerOverlay(); return true; }
    if (state.detailReturn) { var back = state.detailReturn; renderPage(back.page); state.returnPlaylist = {id: back.id, page: back.page, anchor: document.activeElement}; restorePlaylistReturn(content); return true; }
    if (state.page !== "recommend") { renderPage("recommend"); document.getElementById("nav-recommend").focus(); return true; }
    savePlayback(true); playback.wantPlay = false; audio.pause(); return false;
  }
  window.MingmingTVBack = handleBack;
  window.MingmingTVBackground = function () { savePlayback(true); commentMotion.background = true; stopCommentMotion(); if (state.scan) closeScan(); };
  window.MingmingTVForeground = function () { commentMotion.background = false; syncCommentMotion(); };
  document.addEventListener("visibilitychange", function () { if (document.hidden) window.MingmingTVBackground(); else window.MingmingTVForeground(); });
  window.addEventListener("pageshow", window.MingmingTVForeground);
  window.addEventListener("resize", syncCommentMotion);
  window.addEventListener("pagehide", function () { savePlayback(true); commentMotion.background = true; stopCommentMotion(); if (state.scan) { closeScan(); var xhr = new XMLHttpRequest(); xhr.open("POST", "/api/scan/cancel", false); try { xhr.send(); } catch (ignore) {} } });

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
  document.getElementById("queue-open").addEventListener("click", function () { renderPage("queue"); focusTarget(contentEntry()); });
  document.getElementById("now-playing").addEventListener("click", openPlayerOverlay);
  document.getElementById("player-close").addEventListener("click", closePlayerOverlay);
  document.getElementById("player-repeat").addEventListener("click", cyclePlayMode);
  document.getElementById("play-mode").addEventListener("click", cyclePlayMode);
  document.getElementById("overlay-prev").addEventListener("click", function () { playRelative(-1); });
  document.getElementById("overlay-next").addEventListener("click", function () { playRelative(1); });
  document.getElementById("overlay-queue").addEventListener("click", openQueuePopup);
  document.getElementById("overlay-favorite").addEventListener("click", function () { toggleFavorite(state.current); });
  document.getElementById("overlay-play").addEventListener("click", togglePlayback);
  document.getElementById("prev").addEventListener("click", function () { playRelative(-1); });
  document.getElementById("next").addEventListener("click", function () { playRelative(1); });
  document.getElementById("play").addEventListener("click", togglePlayback);
  function seekTo(time) {
    var duration = playbackDuration();
    if (!isFinite(time) || !duration) return;
    time = Math.max(0, Math.min(duration, time));
    playback.position = time;
    if (playback.sourceReady) audio.currentTime = time; else playback.pendingSeek = time;
    syncProgress(time); updateLyrics(time); savePlayback();
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
  function syncPlaybackVisuals(playing) { document.getElementById("player-cover").classList.toggle("is-playing", playing); document.getElementById("overlay-cover").classList.toggle("is-playing", playing); }
  function syncProgress(previewTime) {
    var seek = document.getElementById("seek"), overlaySeek = document.getElementById("overlay-seek"), total = playbackDuration(), hasDuration = total > 0, time = typeof previewTime === "number" ? previewTime : playbackPosition(), percent, elapsed, duration, sliders = [seek, overlaySeek], i;
    if (state.seekInput && typeof previewTime !== "number" && hasDuration) time = total * parseFloat(state.seekInput.value) / 100;
    percent = hasDuration ? Math.max(0, Math.min(100, time / total * 100)) : 0;
    for (i = 0; i < sliders.length; i++) {
      sliders[i].value = percent;
      sliders[i].style.backgroundImage = "linear-gradient(to right,#c7f38d " + percent + "%,#405244 " + percent + "%)";
    }
    elapsed = fmt(time); duration = hasDuration ? fmt(total) : "00:00";
    document.getElementById("player-elapsed").textContent = elapsed; document.getElementById("player-duration").textContent = duration;
    document.getElementById("overlay-elapsed").textContent = elapsed; document.getElementById("overlay-duration").textContent = duration;
  }
  function setPlaybackStatus(status) { state.playbackStatus = status; setPlaybackButtonState(!audio.paused && status !== "failed" && status !== "ended"); syncPlaybackVisuals(status === "playing"); syncCommentMotion(); }
  audio.addEventListener("play", function () { setPlaybackStatus("preparing"); });
  audio.addEventListener("playing", function () { setPlaybackStatus("playing"); savePlayback(); });
  audio.addEventListener("waiting", function () { setPlaybackStatus(audio.paused ? "paused" : "buffering"); });
  audio.addEventListener("seeking", function () { setPlaybackStatus(audio.paused ? "paused" : "buffering"); });
  audio.addEventListener("seeked", function () { if (applyPendingSeek() && playback.wantPlay && audio.paused) startAudio(); if (!audio.paused && audio.readyState >= 3) setPlaybackStatus("playing"); syncProgress(); });
  audio.addEventListener("pause", function () { if (playback.sourceReady) { setPlaybackStatus("paused"); savePlayback(); } });
  audio.addEventListener("error", function () { if (audio.getAttribute("src")) { playback.position = playbackPosition(); playback.sourceReady = false; playback.needsSource = true; playback.wantPlay = false; playback.pendingSeek = playback.position; setPlaybackStatus("failed"); } });
  audio.addEventListener("loadedmetadata", function () {
    if (!state.current || !audio.getAttribute("src") || audio.readyState < 1) return;
    if (isFinite(audio.duration) && audio.duration > 0) { playback.duration = audio.duration; state.current.dt = audio.duration * 1000; }
    playback.sourceReady = true; applyPendingSeek(); syncProgress(); updateLyrics(playbackPosition()); updateTrackStates();
    if (playback.wantPlay) startAudio(); else setPlaybackStatus("paused");
  });
  function mediaCanSeek() { if (!playback.sourceReady) return; applyPendingSeek(); if (playback.wantPlay && audio.paused) startAudio(); }
  audio.addEventListener("canplay", mediaCanSeek); audio.addEventListener("progress", mediaCanSeek);
  audio.addEventListener("timeupdate", function () { syncProgress(); updateLyrics(playbackPosition()); if (playback.sourceReady && !audio.paused && Date.now() - playbackWrite.lastSave >= 5000) savePlayback(); });
  audio.addEventListener("ended", function () { setPlaybackStatus("ended"); handleEnded(); });
  function fmt(n) { var minutes; n = Math.floor(n || 0); minutes = Math.floor(n / 60); return (minutes < 10 ? "0" : "") + minutes + ":" + (n % 60 < 10 ? "0" : "") + n % 60; }
  document.addEventListener("keydown", function (e) { if (e.keyCode === 27 || e.keyCode === 4) { if (handleBack()) e.preventDefault(); return; } if (e.keyCode === 37 || e.keyCode === 38 || e.keyCode === 39 || e.keyCode === 40 || e.keyCode === 13 || e.keyCode === 23 || e.keyCode === 66) { e.preventDefault(); moveFocus(e.keyCode); } });

  renderControlIcons(); renderPlayMode(); loadSearchHistory(); api("/health", "GET", null, function (err, data) { var dot = document.getElementById("connection-dot"), label = document.getElementById("connection-label"); if (!err && data) { dot.className = "status-dot ready"; label.textContent = data.capabilities && data.capabilities.fixture ? "预览数据" : "在线音乐"; state.fixture = !!(data.capabilities && data.capabilities.fixture); } else label.textContent = "服务连接失败"; }); loadLibrary(); loadPlayback(); renderPage("recommend"); focusInitial();
}());
