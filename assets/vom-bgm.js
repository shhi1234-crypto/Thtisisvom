/* Compact, site-wide BGM player. Tracks are managed in Admin Settings. */
(() => {
  'use strict';
  if (/^\/(admin|admin-settings|ot-admin|operator-alert|site-log)(\/|$)/.test(location.pathname)) return;

  const API = 'https://aqfmhqultzpakfqwzulj.supabase.co';
  const KEY = 'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const STATE_KEY = 'vom-bgm-state-v1';
  const CATEGORY_KEY = 'vom-bgm-category-v1';
  const categoryNames = {ALL:'전체',OST:'OST',KPOP:'K-POP',POP:'POP',JAZZ:'재즈',ETC:'기타'};
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = 0.55;

  let tracks = [];
  let currentId = '';
  let currentCategory = 'ALL';
  let wantsPlayback = true;
  let expanded = false;
  let blocked = false;
  let lastSavedSecond = -1;
  let root;
  let resumeTime = 0;

  try {
    const previous = JSON.parse(sessionStorage.getItem(STATE_KEY) || '{}');
    currentId = String(previous.id || '');
    wantsPlayback = previous.playing !== false;
    resumeTime = Number(previous.time) || 0;
    currentCategory = localStorage.getItem(CATEGORY_KEY) || 'ALL';
  } catch (_) {}
  if (!categoryNames[currentCategory]) currentCategory = 'ALL';

  function saveState() {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify({
        id: currentId, playing: wantsPlayback,
        time: Number.isFinite(audio.currentTime) ? audio.currentTime : 0
      }));
    } catch (_) {}
  }

  function safeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
  }
  function currentTrack() { return tracks.find(track => track.id === currentId) || null; }
  function visibleTracks() {
    return currentCategory === 'ALL' ? tracks : tracks.filter(track => track.category === currentCategory);
  }
  function fileUrl(path) {
    return API + '/storage/v1/object/public/site-bgm/' + path.split('/').map(encodeURIComponent).join('/');
  }
  function paint() {
    if (!root) return;
    root.hidden = !tracks.length;
    if (!tracks.length) return;
    const track = currentTrack();
    root.classList.toggle('is-open', expanded);
    root.querySelector('[data-bgm-title]').textContent = track?.title || '음악 선택';
    root.querySelector('[data-bgm-artist]').textContent = track?.artist || categoryNames[track?.category] || 'VOM BGM';
    const play = root.querySelector('[data-bgm-play]');
    play.textContent = audio.paused ? '▶' : 'Ⅱ';
    play.setAttribute('aria-label', audio.paused ? '음악 재생' : '음악 일시정지');
    root.querySelector('[data-bgm-status]').textContent = blocked ? '재생을 눌러 시작하세요' : '';
    root.querySelector('[data-bgm-expand]').setAttribute('aria-expanded', String(expanded));
    const categories = root.querySelector('[data-bgm-categories]');
    categories.innerHTML = Object.entries(categoryNames).filter(([id]) =>
      id === 'ALL' || tracks.some(item => item.category === id)
    ).map(([id,label]) => `<button type="button" data-bgm-category="${id}" class="${id===currentCategory?'active':''}" aria-pressed="${id===currentCategory}">${label}</button>`).join('');
    root.querySelector('[data-bgm-list]').innerHTML = visibleTracks().map(item =>
      `<button type="button" data-bgm-track="${safeText(item.id)}" class="${item.id===currentId?'active':''}"><span>${safeText(item.title)}<small>${safeText(item.artist || categoryNames[item.category] || '')}</small></span><i>${item.id===currentId&&!audio.paused?'♫':''}</i></button>`
    ).join('');
  }
  function setTrack(track, keepTime = false) {
    if (!track) return;
    const wasDifferent = currentId !== track.id;
    currentId = track.id;
    if (wasDifferent || !audio.src) {
      audio.src = fileUrl(track.file_path);
      audio.load();
      if (!keepTime) lastSavedSecond = -1;
    }
    if (keepTime) {
      if (resumeTime > 0) audio.addEventListener('loadedmetadata', () => {
        if (Number.isFinite(audio.duration)) audio.currentTime = Math.min(resumeTime, Math.max(0,audio.duration-0.5));
        resumeTime = 0;
      }, {once:true});
    }
    saveState();
    paint();
  }
  async function play() {
    if (!currentTrack()) return;
    wantsPlayback = true;
    try {
      await audio.play();
      blocked = false;
    } catch (_) {
      blocked = true;
    }
    saveState();
    paint();
  }
  function pause() {
    wantsPlayback = false;
    audio.pause();
    blocked = false;
    saveState();
    paint();
  }
  function step(direction) {
    const list = visibleTracks();
    if (!list.length) return;
    let index = list.findIndex(track => track.id === currentId);
    if (index < 0) index = direction > 0 ? -1 : 0;
    setTrack(list[(index + direction + list.length) % list.length]);
    if (wantsPlayback) void play();
  }
  async function refreshTracks() {
    try {
      const response = await fetch(API + '/rest/v1/site_bgm_tracks?select=id,title,artist,category,file_path,sort_order&is_active=eq.true&order=sort_order.asc,created_at.asc', {
        headers: {apikey:KEY, Authorization:'Bearer ' + KEY}
      });
      if (!response.ok) throw new Error('BGM list unavailable');
      const rows = await response.json();
      tracks = Array.isArray(rows) ? rows.filter(item => item.id && item.file_path) : [];
      if (!tracks.length) { audio.pause(); audio.removeAttribute('src'); paint(); return; }
      if (currentCategory !== 'ALL' && !tracks.some(item => item.category === currentCategory)) currentCategory = 'ALL';
      const selected = currentTrack() || tracks[0];
      if (audio.src && selected.id === currentId) { paint(); return; }
      setTrack(selected, selected.id === currentId);
      if (wantsPlayback) void play();
    } catch (_) { if (root) root.hidden = true; }
  }
  function mount() {
    if (document.getElementById('vomBgm')) return;
    const style = document.createElement('style');
    style.textContent = `
      #vomBgm[hidden]{display:none!important}
      #vomBgm{position:fixed;z-index:79;left:14px;bottom:14px;width:248px;max-width:calc(100vw - 28px);color:#f9f7ff;font:600 12px/1.3 Pretendard,"Noto Sans KR",Arial,sans-serif}
      #vomBgm *{box-sizing:border-box}
      .vom-bgm-bar{display:flex;align-items:center;gap:5px;min-height:50px;padding:5px 7px 5px 10px;border:1px solid rgba(199,191,255,.25);border-radius:16px;background:rgba(28,27,53,.94);box-shadow:0 12px 32px rgba(7,8,28,.25);backdrop-filter:blur(18px)}
      .vom-bgm-open{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0;border:0;background:none;color:inherit;text-align:left;cursor:pointer}
      .vom-bgm-note{display:grid;flex:0 0 30px;place-items:center;width:30px;height:30px;border-radius:10px;background:#7162d9;font-size:15px}
      .vom-bgm-copy{min-width:0}.vom-bgm-copy strong,.vom-bgm-copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.vom-bgm-copy strong{font-size:11px}.vom-bgm-copy small{margin-top:3px;color:#b5b0d3;font-size:9px}
      .vom-bgm-bar button:not(.vom-bgm-open){flex:0 0 29px;width:29px;height:32px;padding:0;border:0;border-radius:9px;background:transparent;color:#f7f4ff;font-size:14px;cursor:pointer}
      .vom-bgm-bar button:hover,.vom-bgm-bar button:focus-visible{background:rgba(255,255,255,.13)}
      .vom-bgm-panel{display:none;position:absolute;left:0;bottom:calc(100% + 7px);width:min(320px,calc(100vw - 28px));max-height:min(350px,48vh);overflow:hidden;border:1px solid rgba(199,191,255,.3);border-radius:17px;background:#20213d;box-shadow:0 18px 38px rgba(7,8,28,.35)}
      #vomBgm.is-open .vom-bgm-panel{display:flex;flex-direction:column}
      .vom-bgm-panel-head{display:flex;justify-content:space-between;gap:8px;padding:12px 13px 8px}.vom-bgm-panel-head b{font-size:12px}.vom-bgm-panel-head span{font-size:10px;color:#aaa4c9}
      .vom-bgm-categories{display:flex;gap:5px;overflow:auto;padding:0 10px 10px}.vom-bgm-categories button{flex:none;padding:6px 9px;border:1px solid #4b486d;border-radius:999px;background:transparent;color:#c7c2dd;font:700 10px Pretendard,Arial,sans-serif;cursor:pointer}
      .vom-bgm-categories button.active{border-color:#9d8efa;background:#6d5bd5;color:#fff}
      .vom-bgm-list{overflow:auto;padding:0 7px 7px}.vom-bgm-list button{display:flex;justify-content:space-between;align-items:center;width:100%;padding:9px;border:0;border-radius:10px;background:transparent;color:#fff;text-align:left;cursor:pointer}.vom-bgm-list button.active,.vom-bgm-list button:hover{background:#343456}.vom-bgm-list span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.vom-bgm-list small{display:block;margin-top:3px;color:#aaa4c9;font-size:9px}.vom-bgm-list i{font-style:normal;color:#b4a5ff}
      .vom-bgm-status{min-height:0;padding:0 12px;color:#cfc2ff;font-size:10px}.vom-bgm-status:not(:empty){padding-bottom:8px}
      @media(max-width:1100px){#vomBgm{bottom:calc(86px + env(safe-area-inset-bottom));left:12px}}
      @media(max-width:480px){#vomBgm{width:214px}.vom-bgm-bar{min-height:45px}.vom-bgm-note{flex-basis:26px;width:26px;height:26px}.vom-bgm-bar button:not(.vom-bgm-open){flex-basis:26px;width:26px}}
    `;
    document.head.appendChild(style);
    root = document.createElement('aside');
    root.id = 'vomBgm';
    root.hidden = true;
    root.setAttribute('aria-label','VOM 배경 음악');
    root.innerHTML = '<div class="vom-bgm-panel"><div class="vom-bgm-panel-head"><b>VOM MUSIC</b><span>곡을 골라 들으세요</span></div><div class="vom-bgm-categories" data-bgm-categories></div><div class="vom-bgm-list" data-bgm-list></div><div class="vom-bgm-status" data-bgm-status aria-live="polite"></div></div><div class="vom-bgm-bar"><button type="button" class="vom-bgm-open" data-bgm-expand aria-label="음악 목록 펼치기" aria-expanded="false"><span class="vom-bgm-note">♫</span><span class="vom-bgm-copy"><strong data-bgm-title>VOM MUSIC</strong><small data-bgm-artist></small></span></button><button type="button" data-bgm-prev aria-label="이전 곡">Ⅰ◀</button><button type="button" data-bgm-play aria-label="음악 재생">▶</button><button type="button" data-bgm-next aria-label="다음 곡">▶Ⅰ</button></div>';
    document.body.appendChild(root);
    root.querySelector('[data-bgm-expand]').addEventListener('click', () => { expanded = !expanded; paint(); if (expanded) void refreshTracks(); });
    root.querySelector('[data-bgm-play]').addEventListener('click', () => audio.paused ? void play() : pause());
    root.querySelector('[data-bgm-prev]').addEventListener('click', () => step(-1));
    root.querySelector('[data-bgm-next]').addEventListener('click', () => step(1));
    root.querySelector('[data-bgm-categories]').addEventListener('click', event => {
      const category = event.target.closest('[data-bgm-category]')?.dataset.bgmCategory;
      if (!category || !categoryNames[category]) return;
      currentCategory = category;
      try { localStorage.setItem(CATEGORY_KEY,category); } catch (_) {}
      const list = visibleTracks();
      if (list.length && !list.some(item => item.id === currentId)) {
        setTrack(list[0]); if (wantsPlayback) void play();
      }
      paint();
    });
    root.querySelector('[data-bgm-list]').addEventListener('click', event => {
      const id = event.target.closest('[data-bgm-track]')?.dataset.bgmTrack;
      const track = tracks.find(item => item.id === id);
      if (!track) return;
      setTrack(track);
      void play();
    });
    document.addEventListener('pointerdown', event => {
      if (blocked && wantsPlayback && !root.contains(event.target)) void play();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshTracks(); });
    window.addEventListener('pagehide', saveState);
    audio.addEventListener('ended', () => step(1));
    audio.addEventListener('play', () => { blocked = false; paint(); });
    audio.addEventListener('pause', paint);
    audio.addEventListener('timeupdate', () => {
      const second = Math.floor(audio.currentTime);
      if (second !== lastSavedSecond) { lastSavedSecond = second; saveState(); }
    });
    audio.addEventListener('error', () => { blocked = true; paint(); });
    void refreshTracks();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true});
  else mount();
})();
