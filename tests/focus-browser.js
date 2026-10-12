/* Run in the isolated fixture preview via DevTools evaluate_script.
 * First: await seedFocusAudit(); then reload the page.
 * await installFocusAudit(); await runFocusAudit('pages'|'player'|'queue-toggle'|'failures'|'empty'|'empty-pages')
 * Never run this harness in real-data mode: it mutates only fixture library data.
 */
async function seedFocusAudit() {
  var health = await (await fetch('/health')).json();
  if (!health.capabilities.fixture) throw new Error('Focus audit requires an isolated fixture preview');
  var songs = Array.from({length: 18}, function (_, i) { return {id: 'focus-' + i, name: '焦点验收歌曲 ' + (i + 1), artist: '测试歌手', album: '测试专辑', type: 'wy', dt: 180000, picUrl: 'https://picsum.photos/seed/focus-' + i + '/300/300'}; });
  var response = await fetch('/api/library', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({favorites: songs.slice(0, 10), playlists: songs, recent: songs})});
  if (!response.ok) throw new Error('Unable to seed fixture library');
  return {reloadRequired: true};
}
async function installFocusAudit() {
  var health = await (await fetch('/health')).json();
  if (!health.capabilities.fixture) throw new Error('Focus audit requires an isolated fixture preview');
  window.focusAudit = {checks: 0, errors: [], requests: [], libraryWrites: 0, delayDetail: false, delayReturn: false, failAppend: false};
  var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) { this.auditURL = url; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this, url = xhr.auditURL || '', response, delay = 35, params = new URLSearchParams(body || ''), audit = window.focusAudit;
    audit.requests.push({url: url, body: body});
    if (url === '/api/library' && body) {
      var handler = xhr.onreadystatechange, settled = false;
      audit.libraryWrites++;
      xhr.onreadystatechange = function () { if (xhr.readyState === 4 && !settled) { settled = true; audit.libraryWrites--; } if (handler) handler(); };
    }
    if (url === '/api/music/search') {
      var page = Number(params.get('page')) || 1, count = page === 1 ? 30 : 17;
      response = {data: Array.from({length: count}, function (_, i) {return {id: 'search-' + ((page - 1) * 30 + i), name: '搜索歌曲 ' + ((page - 1) * 30 + i), artist: '测试歌手', dt: 180000, picUrl: '/focus-cover.svg'};}), more: page === 1}; delay = page > 1 ? 180 : 50;
      if (page > 1 && audit.failAppend) response = {message: 'fixture append failure'};
    } else if (url === '/api/music/lrc') response = {data: Array.from({length: 60},function (_,i) { return '[00:' + ('0' + i).slice(-2) + '.00]焦点检查歌词 ' + (i+1); }).join('\n')};
    else if (url.indexOf('/api/netease/comments?') === 0) { var offset = Number(new URL(url, location.origin).searchParams.get('offset')); response = {comments: Array.from({length: Math.min(10, 45-offset)},function (_,i){ return {user: {nickname:'评论用户 '+(offset+i),avatarUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" rx="24" fill="#779988"/></svg>')}, content: '独立评论区的焦点与滚动检查。'.repeat((offset+i) === 2 ? 35 : 3)};}),total:45,more:offset+10<45}; }
    else if (url === '/api/music/url') response = {data: ''};
    else if (url === '/api/music/list' && audit.delayDetail) { response={data:{playlist:{tracks:[{id:'detail-0',name:'延迟返回歌曲',artist:'测试',picUrl:'/focus-cover.svg'}]}}};delay=300; }
    else if (url.indexOf('/api/netease/catplaylists?') === 0 && audit.delayReturn) { setTimeout(function () { send.call(xhr, body); }, 300); return; }
    else return send.apply(this, arguments);
    setTimeout(function () { Object.defineProperty(xhr,'readyState',{value:4});Object.defineProperty(xhr,'status',{value:(url === '/api/music/search' && Number(params.get('page'))>1 && audit.failAppend) ? 500 : 200});Object.defineProperty(xhr,'responseText',{value:JSON.stringify(response)});if(xhr.onreadystatechange)xhr.onreadystatechange(); },delay);
  };
  window.auditWait = function(ms) {return new Promise(function(resolve){setTimeout(resolve,ms||100);});};
  window.auditUntil = async function (ready) { var deadline = Date.now() + 5000; while (!ready()) { if (Date.now() >= deadline) throw new Error('Fixture operation did not settle'); await auditWait(20); } };
  window.auditLabel = function(e) {return e && (e.id || e.getAttribute('data-focus') || e.getAttribute('data-track-id') || e.getAttribute('data-action') || e.getAttribute('data-playlist-id') || e.getAttribute('data-search-history') || e.textContent.trim().slice(0,28));};
  window.auditCheck = function(ok,label,extra){focusAudit.checks++;if(!ok)focusAudit.errors.push({label:label,extra:extra});};
  window.auditFocus = function(selector){var e=typeof selector === 'string'?document.querySelector(selector):selector;if(!e)throw new Error('Missing target: '+selector);var row=e.closest('.track-row');if(row)row.focus();e.focus();return e;};
  window.auditMove = function(code){MingmingTVKey(code);return document.activeElement;};
  window.auditPath = function(selector,code,expected,label){auditFocus(selector);var target=auditMove(code);auditCheck(target.matches(expected),label||selector+' -> '+code,{actual:auditLabel(target),expected:expected});return target;};
  window.auditVisible = function(target,label){
    var e=target.closest('.track-row')||target,r=e.getBoundingClientRect(),node=e.parentElement,style,p,focusStyle=getComputedStyle(e),ringInset=focusStyle.outlineStyle==='none'&&focusStyle.boxShadow.indexOf('inset')>=0,margin=ringInset?0:3;
    auditCheck(r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&(r.height>innerHeight-100 ? r.bottom>100&&r.top<innerHeight-50 : r.top>=-1&&r.bottom<=innerHeight+1),label+' viewport',{target:auditLabel(target),rect:[r.left,r.top,r.right,r.bottom]});
    while(node&&node!==document.body){style=getComputedStyle(node);if(/auto|scroll|hidden/.test(style.overflowY)){p=node.getBoundingClientRect();if(r.height<=node.clientHeight-16&&p.height>0)auditCheck(r.top>=p.top+margin-.5&&r.bottom<=p.bottom-margin+.5,label+' vertical ring',{target:auditLabel(target),parent:node.id||node.className,rect:[r.top,r.bottom],clip:[p.top,p.bottom],inset:ringInset});}node=node.parentElement;}
  };
  window.auditSweep = async function(rootSelector){var root=document.querySelector(rootSelector),nodes=Array.from(root.querySelectorAll('.focusable')).filter(function(e){return !e.disabled&&e.getClientRects().length>0&&(getComputedStyle(e).visibility!=='hidden'||e.closest('.track-row'));});
    for(var e of nodes)for(var code of [21,22,19,20]){auditFocus(e);var target=auditMove(code);auditCheck(document.body.contains(target)&&target.classList.contains('focusable'),rootSelector+' retains focus',{from:auditLabel(e),code:code,to:auditLabel(target)});if(rootSelector==='#modal-root'||rootSelector==='#queue-popup')auditCheck(root.contains(target),rootSelector+' traps focus');auditVisible(target,rootSelector+' '+auditLabel(e)+' '+code);}
    await auditWait(30);
  };
  window.runFocusAudit = runFocusAudit;
  return {installed:true};
}
async function runFocusAudit(stage) {
  var a=focusAudit, start=a.checks, firstError=a.errors.length;
  function page(name){document.querySelector('[data-page="'+name+'"]').click();}
  if(stage==='pages') {
    page('recommend');await auditWait(180);
    for(var nav of document.querySelectorAll('.nav-item')){auditFocus(nav);auditMove(22);auditCheck(document.getElementById('content').contains(document.activeElement),'sidebar right enters content');}
    auditPath('.category-tab:last-child',22,'.category-tab:last-child','category right boundary');
    auditFocus('[data-category-index="1"]');document.activeElement.click();await auditWait();auditCheck(document.activeElement.getAttribute('data-category-index')==='1','category redraw retains focus');
    auditFocus('[data-subcat="摇滚"]');document.activeElement.click();await auditWait();auditCheck(document.activeElement.getAttribute('data-subcat')==='摇滚','subcategory redraw retains focus');
    await auditSweep('#content');await auditSweep('.sidebar');
    auditPath('.playlist-card',21,'[data-page="recommend"]','card left returns active navigation');auditMove(22);auditCheck(document.activeElement.classList.contains('playlist-card'),'navigation right restores card');
    var card=document.activeElement;card.click();await auditWait(150);auditCheck(document.activeElement.classList.contains('track-row'),'detail enters first song');await auditSweep('#content');MingmingTVBack();await auditWait(160);auditCheck(document.activeElement.getAttribute('data-playlist-id')===card.getAttribute('data-playlist-id'),'detail back restores card');
    a.delayDetail=true;auditFocus('.playlist-card');document.activeElement.click();auditFocus('[data-page="search"]');await auditWait(350);auditCheck(document.activeElement.getAttribute('data-page')==='search','late detail never steals focus');MingmingTVBack();a.delayDetail=false;await auditWait(100);
    for (var destination of ['player','sidebar']) {
      auditFocus('.playlist-card');document.activeElement.click();await auditWait(100);
      if(destination==='player'){auditFocus('.track-row');document.activeElement.click();await auditWait(100);}
      a.delayReturn=true;MingmingTVBack();
      if(destination==='player'){auditFocus('#now-playing');document.activeElement.click();}
      else auditFocus('[data-page="search"]');
      var returnTarget=document.activeElement;await auditWait(450);auditCheck(document.activeElement===returnTarget,'late playlist return preserves '+destination);
      if(destination==='player')MingmingTVBack();a.delayReturn=false;page('recommend');await auditWait(160);
    }
    page('playlists');auditFocus('.playlist-card');await auditWait(150);auditCheck(document.activeElement.classList.contains('playlist-card'),'ranking refresh retains card');await auditSweep('#content');
    var ranking=document.querySelector('.playlist-card');auditFocus(ranking);ranking.click();await auditWait(100);MingmingTVBack();auditCheck(document.activeElement.getAttribute('data-playlist-id')===ranking.getAttribute('data-playlist-id'),'ranking detail back restores card');
    page('search');await auditWait();auditPath('#search-input',20,'[data-provider]','input down enters providers');await auditSweep('#content');
    document.getElementById('search-input').value='焦点搜索';document.getElementById('search-form').dispatchEvent(new Event('submit',{cancelable:true}));await auditWait(100);
    auditFocus('[data-track-id="search-2"]');auditMove(22);var action=document.activeElement;document.getElementById('content').scrollTop=99999;await auditWait(50);auditCheck(document.activeElement===action,'append loading retains node');await auditWait(220);auditCheck(document.activeElement.getAttribute('data-action')==='queue'&&document.activeElement.closest('.track-row').getAttribute('data-track-id')==='search-2','append completion restores same action');auditVisible(document.activeElement,'append focus');
    auditCheck(document.querySelectorAll('#search-results .track-row').length===47,'search append adds distinct page');await auditSweep('#content');
    auditFocus('#clear-search-history');document.activeElement.click();auditCheck(document.activeElement.id==='search-input','clear history restores input');
    page('queue');
    document.getElementById('content').focus();auditCheck(getComputedStyle(document.activeElement).outlineStyle==='none','content has no native focus frame');auditMove(22);auditCheck(document.getElementById('content').contains(document.activeElement)&&document.activeElement.classList.contains('focusable'),'D-pad recovers from noninteractive content focus');
    auditPath('#recent-current-track',22,'#recent-current-track [data-action="queue"]');auditMove(22);auditCheck(document.activeElement.matches('#recent-current-track [data-action="favorite"]'),'hero right reaches favorite');auditMove(21);auditMove(21);auditCheck(document.activeElement.id==='recent-current-track','hero left returns row');
    auditPath('#recent-current-track',20,'.track-list .track-row');auditMove(19);auditCheck(document.activeElement.id==='recent-current-track','first regular row up returns hero');auditMove(19);auditCheck(document.activeElement.hasAttribute('data-library-tab'),'hero up reaches tabs');
    auditPath('#recent-current-track',21,'[data-page="queue"]');auditMove(22);auditCheck(document.activeElement.id==='recent-current-track','sidebar restores hero rather than duplicate song');
    auditCheck(document.querySelectorAll('#recent-current-track .track-action svg').length===2&&!document.querySelector('#recent-current-track .small-button'),'hero uses shared SVG actions');
    auditFocus('#recent-current-track [data-action="favorite"]');var heroSong=document.activeElement.closest('.track-row').getAttribute('data-track-id'),selected=document.activeElement.getAttribute('aria-pressed');document.activeElement.click();auditCheck(document.activeElement.getAttribute('aria-pressed')!==selected,'hero favorite toggles');var duplicate=document.querySelector('.track-list [data-track-id="'+heroSong+'"] [data-action="favorite"]');auditCheck(!duplicate||duplicate.getAttribute('aria-pressed')===document.activeElement.getAttribute('aria-pressed'),'hero favorite syncs duplicate song');document.activeElement.click();
    page('queue');auditFocus('[data-library-tab="recent"]');document.activeElement.click();auditCheck(document.activeElement.getAttribute('data-library-tab')==='recent','recent tab retains focus');auditFocus('#recent-current-track [data-action="queue"]');document.activeElement.click();auditCheck(document.activeElement.getAttribute('data-action')==='queue'&&document.activeElement.closest('.track-row').id==='recent-current-track','hero add retains focus');await auditSweep('#content');
    auditFocus('[data-library-tab="queue"]');document.activeElement.click();auditCheck(document.activeElement.getAttribute('data-library-tab')==='queue','queue tab retains focus');await auditSweep('#content');
    var last=document.querySelector('.track-row:last-child');auditFocus(last);auditMove(20);auditCheck(document.activeElement.id==='seek','last song down reaches seek');auditMove(19);auditCheck(document.activeElement.getAttribute('data-track-id')===last.getAttribute('data-track-id'),'seek up restores last song');
    var footer=['now-playing','play-mode','prev','play','next','queue-open'];for(var i=0;i<footer.length;i++){auditPath('#'+footer[i],21,'#'+footer[Math.max(0,i-1)],'footer left '+footer[i]);auditPath('#'+footer[i],22,'#'+footer[Math.min(footer.length-1,i+1)],'footer right '+footer[i]);if(i>0)auditPath('#'+footer[i],19,'#seek','footer up '+footer[i]);auditPath('#'+footer[i],20,'#'+footer[i],'footer bottom boundary');}
    page('favorites');await auditSweep('#content');var rows=document.querySelectorAll('.track-row');auditFocus(rows[3]);auditMove(22);auditMove(22);document.activeElement.click();auditCheck(document.activeElement.classList.contains('track-row'),'favorite deletion retains neighboring row');auditVisible(document.activeElement,'favorite deletion');
    page('account');await auditSweep('#content');
    for(var mode of ['login','register','reset']){auditFocus('#account-'+mode);document.activeElement.click();await auditWait();await auditSweep('#modal-root');MingmingTVBack();auditCheck(document.activeElement.id==='account-'+mode,'auth close restores '+mode);}
    auditFocus('#account-register');document.activeElement.click();auditFocus('#auth-scan');document.activeElement.click();await auditWait(150);await auditSweep('#modal-root');MingmingTVBack();auditCheck(document.activeElement.id==='auth-scan','nested scan restores parent action');MingmingTVBack();
    page('search');auditFocus('#search-scan');document.activeElement.click();await auditWait(150);await auditSweep('#modal-root');MingmingTVBack();auditCheck(document.activeElement.id==='search-scan','search scan close restores action');
  } else if(stage==='player') {
    page('queue');auditFocus('.track-row');document.activeElement.click();await auditWait(120);document.getElementById('now-playing').focus();document.getElementById('now-playing').click();await auditWait(100);
    auditPath('#player-close',20,'#overlay-favorite');auditPath('#overlay-favorite',20,'#overlay-seek');auditPath('#overlay-seek',20,'#overlay-play');auditPath('#overlay-play',19,'#overlay-seek');auditPath('#overlay-seek',19,'#overlay-favorite');auditPath('#overlay-favorite',19,'#player-close');
    var controls=['player-repeat','overlay-prev','overlay-play','overlay-next','overlay-queue'];for(var i=0;i<controls.length;i++){auditPath('#'+controls[i],21,'#'+controls[Math.max(0,i-1)]);auditPath('#'+controls[i],22,i===controls.length-1?'#overlay-comments .comment':'#'+controls[i+1]);auditPath('#'+controls[i],19,'#overlay-seek');auditPath('#'+controls[i],20,'#'+controls[i]);}
    auditCheck(!document.getElementById('overlay-lyrics').classList.contains('focusable')&&document.getElementById('overlay-lyrics').tabIndex===-1,'fullscreen lyrics excluded from focus graph');
    auditPath('#player-close',22,'#player-comments-toggle');auditPath('#player-comments-toggle',21,'#player-close');auditPath('#player-comments-toggle',20,'#overlay-comments .comment');
    auditFocus('#player-comments-toggle');document.activeElement.click();auditCheck(document.activeElement.id==='player-comments-toggle'&&document.activeElement.getAttribute('aria-expanded')==='false','hide comments keeps toggle focus');
    auditPath('#overlay-queue',22,'#player-comments-toggle','hidden comments right reaches toggle');auditPath('#overlay-favorite',22,'#player-comments-toggle');auditPath('#player-comments-toggle',20,'#overlay-favorite');await auditSweep('#player-overlay');
    auditFocus('#player-comments-toggle');document.activeElement.click();auditCheck(document.activeElement.id==='player-comments-toggle'&&document.activeElement.getAttribute('aria-expanded')==='true','show comments keeps toggle focus');
    auditPath('#overlay-queue',22,'#overlay-comments .comment');auditMove(21);auditCheck(document.activeElement.id==='overlay-queue','comments left restores controls');
    await auditSweep('#player-overlay');
    auditFocus('#overlay-queue');document.activeElement.click();await auditWait();await auditSweep('#queue-popup');
    auditFocus('.queue-popup .track-row:last-child');auditMove(20);auditCheck(document.activeElement.matches('.queue-popup .track-row:last-child'),'queue bottom stays');auditPath('.queue-popup .track-row',19,'#queue-popup-close');auditPath('#queue-popup-close',20,'.queue-popup .track-row');
    var row=document.querySelector('.queue-popup .track-row');auditFocus(row);auditMove(22);document.activeElement.click();auditCheck(document.activeElement.getAttribute('data-action')==='remove-queue','popup delete restores deletion action');auditVisible(document.activeElement,'popup deletion');MingmingTVBack();auditCheck(document.activeElement.id==='overlay-queue','popup close restores control');
    var comments=document.getElementById('overlay-comments');auditFocus(comments.querySelector('.comment'));for(var k=0;k<36;k++)auditMove(20);await auditWait(180);auditCheck(comments.querySelectorAll('.comment').length>10,'comment focus scroll loads page');auditCheck(comments.contains(document.activeElement),'comment pagination keeps focus');auditVisible(document.activeElement,'comment pagination');
    comments.innerHTML='<div class="state">暂无评论</div>';auditPath('#overlay-queue',22,'#overlay-comments','empty comments can receive focus');auditMove(21);auditCheck(document.activeElement.id==='overlay-queue','empty comments return to controls');
    MingmingTVBack();auditCheck(document.activeElement.id==='now-playing','fullscreen close restores origin');
    var sideLyrics=document.getElementById('side-lyrics');auditCheck(!sideLyrics.classList.contains('focusable')&&sideLyrics.tabIndex===-1,'side lyrics excluded from focus graph');auditFocus(sideLyrics);auditCheck(getComputedStyle(sideLyrics).outlineStyle==='none'&&getComputedStyle(sideLyrics).boxShadow==='none','side lyrics has no focus frame');auditMove(22);auditCheck(document.getElementById('content').contains(document.activeElement)&&document.activeElement.classList.contains('focusable'),'D-pad recovers from noninteractive lyrics focus');
  } else if(stage==='queue-toggle') {
    auditCheck(document.activeElement.id==='nav-recommend'&&getComputedStyle(document.activeElement).outlineStyle==='solid','launch has visible default navigation focus');
    MingmingTVBack();
    auditCheck(!document.getElementById('modal-root').hidden&&document.activeElement.id==='exit-cancel','exit dialog defaults to cancel');
    MingmingTVBack();
    auditCheck(document.getElementById('modal-root').hidden&&document.activeElement.id==='nav-recommend','back cancels exit and restores focus');
    MingmingTVBack();
    auditCheck(!document.getElementById('modal-root').hidden&&document.activeElement.id==='exit-cancel','exit dialog can be reopened');
    document.getElementById('exit-cancel').click();
    auditCheck(document.getElementById('modal-root').hidden&&document.activeElement.id==='nav-recommend','cancel button restores focus');
    auditCheck(document.querySelector('.player-overlay-head').textContent.trim()==='正在播放'&&!document.getElementById('overlay-mode-label'),'fullscreen heading omits playback mode');
    page('queue');auditFocus('[data-library-tab="recent"]');document.activeElement.click();
    var heroSelector='#recent-current-track [data-action="queue"]', duplicateSelector='.track-list .track-row:first-child [data-action="queue"]', songID=document.getElementById('recent-current-track').getAttribute('data-track-id');
    auditCheck(document.querySelector(heroSelector).getAttribute('aria-pressed')==='true','queued hero initially shows delete');
    auditFocus(heroSelector);document.activeElement.click();
    auditCheck(document.activeElement.matches(heroSelector),'hero toggle preserves hero focus');
    auditCheck(document.querySelector(heroSelector).getAttribute('aria-pressed')==='false'&&document.querySelector(duplicateSelector).getAttribute('aria-pressed')==='false','removing hero syncs duplicate add icons');await auditUntil(function(){return a.libraryWrites===0;});
    var plusIcon=document.querySelector(duplicateSelector).innerHTML;
    auditFocus(duplicateSelector);document.activeElement.click();
    auditCheck(document.activeElement.matches(duplicateSelector),'duplicate toggle keeps regular row focus');
    auditCheck(document.querySelector(heroSelector).getAttribute('aria-pressed')==='true'&&document.querySelector(duplicateSelector).innerHTML!==plusIcon,'adding duplicate syncs delete icons');await auditUntil(function(){return a.libraryWrites===0;});
    var send=XMLHttpRequest.prototype.send, writes=0, activeWrites=0, maxWrites=0, title=document.getElementById('player-title').textContent;
    XMLHttpRequest.prototype.send=function(body){var xhr=this;if(xhr.auditURL==='/api/library'&&body){writes++;activeWrites++;maxWrites=Math.max(maxWrites,activeWrites);var handler=xhr.onreadystatechange,settled=false;xhr.onreadystatechange=function(){if(xhr.readyState===4&&!settled){settled=true;activeWrites--;}if(handler)handler();};setTimeout(function(){send.call(xhr,body);},writes===1?350:40);}else return send.apply(this,arguments);};
    try {
      auditFocus(duplicateSelector);document.activeElement.click();document.activeElement.click();
      auditCheck(document.activeElement.matches(duplicateSelector)&&document.activeElement.getAttribute('aria-pressed')==='true','rapid remove/add updates in place');
      await auditUntil(function(){return activeWrites===0;});
      var stored=await(await fetch('/api/library')).json();
      auditCheck(maxWrites===1&&writes===2,'library writes are serialized',{maxWrites:maxWrites,writes:writes});
      auditCheck(stored.playlists.filter(function(s){return String(s.id)===songID;}).length===1,'rapid toggle persists one queued song');
      auditCheck(document.querySelector(duplicateSelector).getAttribute('aria-pressed')==='true','late save cannot revert latest icon');
      auditCheck(document.getElementById('player-title').textContent===title,'queue toggle does not start playback');
    } finally {XMLHttpRequest.prototype.send=send;}
    auditFocus(duplicateSelector);auditMove(21);auditCheck(document.activeElement.classList.contains('track-row'),'toggle left returns its row');auditMove(22);auditCheck(document.activeElement.matches(duplicateSelector),'row right returns toggle');
    auditFocus('.track-list .track-row:first-child [data-action="favorite"]');if(document.activeElement.getAttribute('aria-pressed')!=='true')document.activeElement.click();await auditUntil(function(){return a.libraryWrites===0;});page('favorites');
    var favoriteQueue=document.querySelector('[data-track-id="'+songID+'"] [data-action="queue"]');auditCheck(favoriteQueue.getAttribute('aria-pressed')==='true','favorite list restores queued delete state');
    auditFocus(favoriteQueue);favoriteQueue.click();auditCheck(favoriteQueue.getAttribute('aria-pressed')==='false'&&document.activeElement===favoriteQueue,'favorite list can remove queue without losing focus');await auditUntil(function(){return a.libraryWrites===0;});
    stored=await(await fetch('/api/library')).json();auditCheck(!stored.playlists.some(function(s){return String(s.id)===songID;}),'queue removal is persisted');auditCheck(stored.favorites.some(function(s){return String(s.id)===songID;}),'queue removal preserves favorite');
  } else if(stage==='failures') {
    page('search');await auditWait();document.getElementById('search-input').value='分页失败检查';document.getElementById('search-form').dispatchEvent(new Event('submit',{cancelable:true}));await auditWait(100);
    auditFocus('[data-track-id="search-2"]');auditMove(22);var retained=document.activeElement;a.failAppend=true;document.getElementById('content').scrollTop=99999;await auditWait(240);
    auditCheck(document.querySelectorAll('#search-results .track-row').length===30,'failed append preserves results');auditCheck(document.activeElement===retained,'failed append preserves focus');
    a.failAppend=false;document.getElementById('content').scrollTop=0;await auditWait(30);document.getElementById('content').scrollTop=99999;await auditWait(240);
    auditCheck(document.querySelectorAll('#search-results .track-row').length===47,'append retry loads second page');auditCheck(document.activeElement.getAttribute('data-action')==='queue'&&document.activeElement.closest('.track-row').getAttribute('data-track-id')==='search-2','append retry restores song action');auditVisible(document.activeElement,'append retry');
  } else if(stage==='empty') {
    await fetch('/api/library',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({favorites:[],playlists:[],recent:[]})});
    return {reloadRequired:true};
  } else if(stage==='empty-pages') {
    page('queue');await auditSweep('#content');auditPath('[data-library-tab="queue"]',21,'[data-page="queue"]','empty queue left reaches navigation');auditMove(22);auditCheck(document.activeElement.getAttribute('data-library-tab')==='queue','empty queue right restores tab');
    auditFocus('[data-library-tab="recent"]');document.activeElement.click();await auditSweep('#content');
    page('favorites');auditPath('[data-page="favorites"]',22,'[data-page="favorites"]','empty favorites stays on navigation');auditMove(20);auditCheck(document.activeElement.getAttribute('data-page')==='account','empty favorites down advances navigation');
    auditFocus('#queue-open');document.activeElement.click();auditCheck(document.activeElement.id==='queue-popup-close','footer opens empty playback popup');MingmingTVBack();auditCheck(document.activeElement.id==='queue-open','footer popup restores its origin');
    page('search');document.getElementById('search-input').value='空列表焦点';document.getElementById('search-form').dispatchEvent(new Event('submit',{cancelable:true}));await auditWait(100);
    auditFocus('.track-row');auditMove(22);document.activeElement.click();page('queue');auditFocus('.track-row');document.activeElement.click();await auditWait(100);
    auditFocus('#now-playing');document.activeElement.click();auditFocus('#overlay-queue');document.activeElement.click();auditFocus('.queue-popup .track-row');auditMove(22);document.activeElement.click();
    auditCheck(document.activeElement.id==='queue-popup-close','deleting final popup song focuses close');await auditSweep('#queue-popup');MingmingTVBack();auditCheck(document.activeElement.id==='overlay-queue','empty popup restores fullscreen control');MingmingTVBack();
  }
  return {viewport:[innerWidth,innerHeight],stage:stage,checks:a.checks-start,errors:a.errors.slice(firstError)};
}
