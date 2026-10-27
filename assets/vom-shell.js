/* VOM shared member shell: consistent navigation, contextual back links and current member display. */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://aqfmhqultzpakfqwzulj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const path = (window.location.pathname.replace(/\/+$/, '') || '/');

  const VOM_THEME_KEY = 'vom-theme';

  function applyVomTheme() {
    const root = document.documentElement;
    root.setAttribute('data-vom-theme', 'dark');
    root.style.colorScheme = 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0a0f1f');
    try { window.localStorage.removeItem(VOM_THEME_KEY); } catch (_) {}
    document.querySelectorAll('[data-vom-theme-toggle], .vom-theme-toggle').forEach(function(button) {
      button.remove();
    });
  }

  function initVomTheme() {
    applyVomTheme();
  }

  let pwaRegistrationStarted = false;
  function setupPwa() {
    if (!document.querySelector('link[rel="manifest"]')) {
      const manifest = document.createElement('link');
      manifest.rel = 'manifest';
      manifest.href = '/manifest.webmanifest';
      document.head.appendChild(manifest);
    }
    if (!document.querySelector('meta[name="mobile-web-app-capable"]')) {
      const capable = document.createElement('meta');
      capable.name = 'mobile-web-app-capable';
      capable.content = 'yes';
      document.head.appendChild(capable);
    }
    const register = function () {
      if (pwaRegistrationStarted || !('serviceWorker' in navigator) || location.protocol !== 'https:') return;
      pwaRegistrationStarted = true;
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {
        pwaRegistrationStarted = false;
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }

  function addStyle() {
    if (document.getElementById('vom-shared-shell-style')) return;
    const style = document.createElement('style');
    style.id = 'vom-shared-shell-style';
    style.textContent = `
      body.has-vom-bottom { padding-bottom: 100px !important; }
      nav.bottom.vom-global-bottom {
        position: fixed !important;
        z-index: 80 !important;
        left: 50% !important;
        bottom: max(10px, env(safe-area-inset-bottom)) !important;
        transform: translateX(-50%) !important;
        width: min(720px, calc(100% - 24px)) !important;
        height: 67px !important;
        display: grid !important;
        grid-template-columns: repeat(5, minmax(0, 1fr)) !important;
        overflow: hidden !important;
        padding: 0 !important;
        border: 1px solid rgba(255,255,255,.95) !important;
        border-radius: 22px !important;
        background: rgba(255,255,255,.86) !important;
        box-shadow: 0 14px 42px rgba(30,37,75,.12) !important;
        backdrop-filter: blur(23px) !important;
      }
      nav.bottom.vom-global-bottom a,
      nav.bottom.vom-global-bottom button {
        min-width: 0;
        border: 0 !important;
        background: none !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 3px !important;
        color: #777c8d !important;
        cursor: pointer;
        text-decoration: none !important;
        font: 700 10px/1 "DM Sans", Pretendard, Arial, sans-serif !important;
      }
      nav.bottom.vom-global-bottom .nav-icon {
        display: block !important;
        margin: 0 !important;
        color: currentColor !important;
        font-size: 18px !important;
        line-height: 1 !important;
      }
      nav.bottom.vom-global-bottom .active {
        color: #755fe1 !important;
        font-weight: 900 !important;
      }
      .vom-shell-admin-badge{
        display:inline-flex !important;
        align-items:center;
        gap:7px;
        min-height:34px;
        padding:0 12px;
        border:1px solid rgba(126,102,232,.18);
        border-radius:999px;
        background:rgba(126,102,232,.12);
        color:#6955d2 !important;
        font:800 10px/1 Pretendard,"Noto Sans KR",Arial,sans-serif;
        letter-spacing:.7px;
        text-decoration:none !important;
        white-space:nowrap;
      }
      #menuOverlay{z-index:1000 !important;overflow-y:auto;overscroll-behavior:contain}
      #menuOverlay .menu-card{max-height:calc(100dvh - 90px);overflow-y:auto;overscroll-behavior:contain}
      .vom-shell-admin-badge .admin-dot{width:7px;height:7px;border-radius:50%;background:#765fe6}
      .member-session-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 178px;
        min-height: 34px;
        padding: 0 11px;
        overflow: hidden;
        border: 1px solid rgba(118,96,225,.16);
        border-radius: 999px;
        background: rgba(245,243,255,.93);
        color: #6756cf !important;
        box-shadow: 0 8px 20px rgba(78,67,141,.06);
        font: 800 11px/1 Pretendard, "Noto Sans KR", Arial, sans-serif;
        text-decoration: none !important;
        white-space: nowrap;
      }
      .member-session-chip::before {
        content: "●";
        flex: 0 0 auto;
        color: #846ee9;
        font-size: 8px;
      }
      .member-session-chip.is-guest {
        border-color: rgba(119,126,145,.14);
        background: rgba(247,248,251,.92);
        color: #747b8e !important;
      }
      .member-session-chip.is-guest::before { color: #a1a7b5; }
      .member-session-chip .member-session-name {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .member-session-wrap{
        position:relative;
        display:inline-flex;
        align-items:center;
        gap:7px;
        flex:0 0 auto;
      }
      .member-session-logout{
        min-height:34px;
        padding:0 3px;
        border:0;
        background:transparent;
        color:#6d5bdc;
        font:800 11px/1 Pretendard,"Noto Sans KR",Arial,sans-serif;
        white-space:nowrap;
        cursor:pointer;
      }
      .member-session-logout:hover{color:#4f3ebd;text-decoration:underline}
      .member-session-logout:focus-visible{outline:2px solid #9b8cec;outline-offset:3px;border-radius:5px}
      .member-session-chip.logged-in{
        border:1px solid rgba(118,96,225,.20);
        background:rgba(245,243,255,.96);
        color:#5f4dcc !important;
        cursor:pointer;
      }
      .member-session-chip .member-session-chevron{
        flex:0 0 auto;
        margin-left:1px;
        color:#8a78df;
        font-size:13px;
        line-height:1;
      }
      .member-session-popover{
        position:absolute;
        top:calc(100% + 10px);
        right:0;
        z-index:1100;
        width:min(258px,calc(100vw - 36px));
        padding:10px;
        border:1px solid #e6e1f4;
        border-radius:18px;
        background:rgba(255,255,255,.98);
        box-shadow:0 18px 50px rgba(40,31,92,.18);
      }
      .member-session-popover[hidden]{display:none}
      .member-session-summary{
        padding:9px 10px 11px;
        border-bottom:1px solid #eeeaf7;
      }
      .member-session-summary strong{
        display:block;
        color:#353a51;
        font-size:13px;
      }
      .member-session-summary small{
        display:block;
        margin-top:4px;
        color:#8a90a2;
        font-size:10px;
      }
      .member-session-popover a,
      .member-session-popover button{
        display:flex;
        align-items:center;
        justify-content:space-between;
        width:100%;
        min-height:42px;
        padding:0 10px;
        border:0;
        border-bottom:1px solid #f1eef7;
        background:transparent;
        color:#595f73;
        font:700 12px/1 Pretendard,"Noto Sans KR",Arial,sans-serif;
        text-align:left;
        text-decoration:none;
        cursor:pointer;
      }
      .member-session-popover a:last-of-type{border-bottom:0}
      .member-session-popover .member-logout-button{
        margin-top:4px;
        border:1px solid #f1d0d7;
        border-radius:11px;
        background:#fff7f8;
        color:#b85868;
      }
      .member-session-popover .member-logout-button::after{content:"↪";font-size:15px}
      .vom-shell-fallback-overlay{
        position:fixed;
        inset:0;
        z-index:1000;
        display:none;
        align-items:flex-start;
        justify-content:flex-end;
        padding:18px;
        background:rgba(20,20,40,.26);
        backdrop-filter:blur(5px);
      }
      .vom-shell-fallback-overlay.open{display:flex}
      .vom-shell-fallback-card{
        width:min(380px,100%);
        margin-top:55px;
        padding:16px;
        border-radius:24px;
        background:#fff;
        box-shadow:0 22px 70px rgba(31,23,79,.2);
      }
      .vom-shell-fallback-card .menu-top{
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:6px 5px 12px;
      }
      .vom-shell-fallback-card .menu-top h3{margin:0;font:800 17px/1 Pretendard,"Noto Sans KR",Arial,sans-serif}
      .vom-shell-fallback-card .vom-shell-close{
        width:34px;height:34px;border:0;border-radius:50%;background:#f3f2f8;color:#4d5264;font-size:16px;cursor:pointer;
      }
      .vom-shell-fallback-card > a{
        display:flex;
        align-items:center;
        justify-content:space-between;
        min-height:48px;
        padding:0 10px;
        border-top:1px solid #f0eef6;
        color:#2c3043;
        text-decoration:none;
        font:700 13px "DM Sans",Pretendard,"Noto Sans KR",Arial,sans-serif;
      }
      .menu-card > a,.vom-shell-fallback-card > a{color:#6d57cd !important;border-color:#eee7fa !important;text-decoration:none !important}
      .menu-card > a.active,.vom-shell-fallback-card > a.active{background:#f5f0ff;color:#5d43c3 !important;border-radius:10px}
      .menu-card > a.vom-menu-account,.vom-shell-fallback-card > a.vom-menu-account{font-weight:800;font-size:15px}
      .vom-legacy-admin-menu{display:none !important}
      .vom-shell-fallback-card > a.active{color:#6755d9}
      .vom-shell-menu-trigger{
        width:46px;height:46px;border:1px solid rgba(255,255,255,.92);border-radius:50%;
        background:rgba(255,255,255,.66);color:#20253a;font-size:18px;cursor:pointer;
        box-shadow:0 10px 30px rgba(31,38,76,.08);
      }
      .vom-shell-floating-menu-trigger{
        position:fixed;
        z-index:90;
        top:18px;
        right:18px;
      }
      @media (max-width: 640px) {
        body.has-vom-bottom { padding-bottom: 92px !important; }
        nav.bottom.vom-global-bottom {
          bottom: max(8px, env(safe-area-inset-bottom)) !important;
          width: calc(100% - 20px) !important;
          height: 63px !important;
          border-radius: 20px !important;
        }
        .member-session-chip {
          max-width: 106px;
          min-height: 31px;
          padding: 0 9px;
          font-size: 10px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function activeKey() {
    if (path === '/') return 'home';
    if (path === '/calendar' || path.startsWith('/calendar/')) return 'calendar';
    if (path === '/members' || path.startsWith('/members/')) return 'members';
    if (path === '/me' || path.startsWith('/me/')) return 'me';
    if (path === '/ot-room' || path.startsWith('/ot-room/')) return 'join';
    if (path === '/info' || path.startsWith('/info/')) return 'info';
    if (path === '/event' || path.startsWith('/event/')) return 'event';
    return '';
  }

  function normalizeBottomNavigation(approved=false) {
    const nav = document.querySelector('nav.bottom');
    if (!nav) return;

    const active = activeKey();
    const item = (key, href, icon, label) =>
      `<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}><span class="nav-icon">${icon}</span>${label}</a>`;

    nav.classList.add('vom-global-bottom');
    nav.setAttribute('aria-label', '주요 메뉴');
    nav.innerHTML = (approved
      ? item('home','/','⌂','HOME')+item('calendar','/calendar/','◫','CALENDAR')+item('members','/members/','♙','MEMBERS')+item('me','/me/','♡','MY VOM')
      : item('me','/me/','↪','로그인하기')+item('join','/ot-room/','＋','회원가입하기')+item('home','/','⌂','HOME')+item('info','/info/','ⓘ','INFO'))+
      '<button type="button" aria-label="전체 메뉴 열기"><span class="nav-icon">☰</span>MENU</button>';

    nav.querySelector('button').addEventListener('click', function () {
      if (typeof window.openMenu === 'function') {
        window.openMenu();
        return;
      }
      window.location.href = '/';
    });

    document.body.classList.add('has-vom-bottom');
  }

  function normalizeBackLink(link) {
    const label = (link.textContent || '').replace(/\s+/g, ' ').trim();
    const target = label.replace(/^←\s*/, '').replace(/\s*→$/, '').trim();
    if (target) link.setAttribute('aria-label', target + '으로 돌아가기');
  }

  function normalizeBackLinks(root) {
    const scope = root || document;
    if (scope instanceof Element && scope.matches('a.back')) normalizeBackLink(scope);
    if (scope.querySelectorAll) scope.querySelectorAll('a.back').forEach(normalizeBackLink);
  }

  function keepBackLinksNormalized() {
    const observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === Node.ELEMENT_NODE) normalizeBackLinks(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function storedAccessToken() {
    try {
      const raw = window.localStorage.getItem('sb-aqfmhqultzpakfqwzulj-auth-token');
      const parsed = raw && JSON.parse(raw);
      return parsed && parsed.access_token ? parsed.access_token : null;
    } catch (_) {
      return null;
    }
  }

  let shellAuthClient = null;

  function shellClient() {
    try {
      if (typeof db !== 'undefined' && db?.auth?.signOut) return db;
    } catch (_) {}
    if (!shellAuthClient && window.supabase?.createClient) {
      shellAuthClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    }
    return shellAuthClient;
  }

  async function shellLogout() {
    const client = shellClient();
    if (!client) return;
    try {
      const {error} = await client.auth.signOut({scope:'local'});
      if (error) throw error;
      window.location.reload();
    } catch (error) {
      console.error('VOM LOGOUT:', error);
      window.alert('로그아웃하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  function closeSessionPopovers(except) {
    document.querySelectorAll('.member-session-popover').forEach(function(popover) {
      if (popover !== except) {
        popover.hidden = true;
        const button = popover.parentElement?.querySelector('.member-session-chip.logged-in');
        button?.setAttribute('aria-expanded','false');
      }
    });
  }

  function addMemberStatus(label, loggedIn, isAdmin=false) {
    const menuButton = document.querySelector('.vom-header .menu-btn, .vom-header .vom-shell-menu-trigger');
    const host = (menuButton && menuButton.parentElement) ||
      document.querySelector('.vom-header-actions, .header-actions, .header-right');
    if (!host) return;
    host.querySelector('.member-session-wrap')?.remove();

    const wrap = document.createElement('div');
    wrap.className = 'member-session-wrap';

    if (!loggedIn) {
      const chip = document.createElement('a');
      chip.className = 'member-session-chip is-guest';
      chip.href = '/me/';
      chip.setAttribute('aria-label','로그인하기');

      const nameText = document.createElement('span');
      nameText.className = 'member-session-name';
      nameText.textContent = '로그인하기';
      chip.appendChild(nameText);
      wrap.appendChild(chip);
    } else {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'member-session-chip logged-in';
      chip.setAttribute('aria-haspopup','menu');
      chip.setAttribute('aria-expanded','false');
      chip.setAttribute(
        'aria-label',
        '현재 로그인: ' + label + '. 계정 메뉴 열기'
      );

      const nameText = document.createElement('span');
      nameText.className = 'member-session-name';
      nameText.textContent = label + '님';
      chip.appendChild(nameText);

      const chevron = document.createElement('span');
      chevron.className = 'member-session-chevron';
      chevron.textContent = '⌄';
      chip.appendChild(chevron);

      const popover = document.createElement('div');
      popover.className = 'member-session-popover';
      popover.hidden = true;
      popover.setAttribute('role','menu');
      popover.innerHTML =
        '<div class="member-session-summary"><strong>' + escapeShellHtml(label) + '님</strong><small>로그인된 VOM 계정</small></div>' +
        '<a href="/me/">MY VOM <span>→</span></a>' +
        '<a href="/me/#accountSettings">개인 설정 <span>→</span></a>' +
        (isAdmin ? '<a href="/admin-settings/">운영 자료 <span>→</span></a>' : '') +
        '<button type="button" class="member-logout-button">로그아웃</button>';

      chip.addEventListener('click', function(event) {
        event.stopPropagation();
        const willOpen = popover.hidden;
        closeSessionPopovers(popover);
        popover.hidden = !willOpen;
        chip.setAttribute('aria-expanded', String(willOpen));
      });
      popover.querySelector('.member-logout-button').addEventListener('click', shellLogout);
      wrap.appendChild(chip);

      const logoutLink = document.createElement('button');
      logoutLink.type = 'button';
      logoutLink.className = 'member-session-logout';
      logoutLink.setAttribute('aria-label', label + '님 로그아웃');
      logoutLink.textContent = '로그아웃';
      logoutLink.addEventListener('click', shellLogout);
      wrap.appendChild(logoutLink);

      wrap.appendChild(popover);
    }

    if (menuButton && menuButton.parentElement === host) {
      host.insertBefore(wrap, menuButton);
    } else {
      host.appendChild(wrap);
    }
  }

  function escapeShellHtml(value) {
    const div = document.createElement('div');
    div.textContent = String(value ?? '');
    return div.innerHTML;
  }

  document.addEventListener('click', function(event) {
    if (!event.target.closest('.member-session-wrap')) {
      closeSessionPopovers();
    }
  });


  function adminBadgeHost() {
    return document.querySelector('.vom-header-actions, .header-right, .header-actions');
  }

  function addAdminBadge() {
    const existing = document.getElementById('adminBadge');
    if (existing) {
      existing.classList.add('show');
      return;
    }
    const host = adminBadgeHost();
    if (!host || host.querySelector('.vom-shell-admin-badge')) return;
    const badge = document.createElement('a');
    badge.href = '/admin-settings/';
    badge.className = 'admin-badge show vom-shell-admin-badge';
    badge.setAttribute('aria-label', '운영자료로 이동');
    badge.innerHTML = '<span class="admin-dot"></span><span>ADMIN MODE</span>';
    const menuButton = host.querySelector('.menu-btn');
    if (menuButton) host.insertBefore(badge, menuButton);
    else host.appendChild(badge);
  }


  function ensureFallbackMenu() {
    if (document.querySelector('.menu-card') || document.getElementById('vom-shell-fallback-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'vom-shell-fallback-overlay';
    overlay.className = 'vom-shell-fallback-overlay';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML =
      '<div class="vom-shell-fallback-card">' +
      '<div class="menu-top"><h3>VOM Menu</h3><button type="button" class="vom-shell-close" aria-label="메뉴 닫기">✕</button></div>' +
      '</div>';
    document.body.appendChild(overlay);

    const open = function () {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
    };
    const close = function () {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
    };

    overlay.querySelector('.vom-shell-close').addEventListener('click', close);
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) close();
    });

    const host = adminBadgeHost();
    if (host && !host.querySelector('.menu-btn, .vom-shell-menu-trigger')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vom-shell-menu-trigger';
      button.setAttribute('aria-label', '메뉴 열기');
      button.textContent = '☰';
      button.addEventListener('click', open);
      host.appendChild(button);
    } else if (!host && !document.querySelector('.vom-shell-menu-trigger')) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vom-shell-menu-trigger vom-shell-floating-menu-trigger';
      button.setAttribute('aria-label', '메뉴 열기');
      button.textContent = '☰';
      button.addEventListener('click', open);
      document.body.appendChild(button);
    }

    window.openMenu = window.openMenu || open;
    window.closeMenu = window.closeMenu || close;
  }

  function setUnifiedMenu(isAdmin=false,isOperator=false,approved=false) {
    document.querySelectorAll('.menu-card, .vom-shell-fallback-card').forEach(function(card){
      const top=card.querySelector('.menu-top,.modal-head,.modal-top');if(!top)return;
      card.querySelectorAll(':scope > a').forEach(link=>link.remove());
      card.querySelectorAll(':scope > button').forEach(button=>{
        const logout=/logout|로그아웃/i.test(button.id+' '+button.textContent);
        button.classList.toggle('vom-legacy-admin-menu',!isAdmin||!logout);
      });
      const links=approved?[['MY VOM','/me/'],['MEMBERS','/members/'],['CALENDAR','/calendar/']]:[['로그인하기','/me/'],['회원가입하기','/ot-room/']];
      links.push(['HOME','/'],['INFO','/info/'],['VOM LIVE','/live/'],['BUSKING','/busking/'],['PRACTICE','/practice/'],['NOTICE','/#homeNews'],['Q&A','/qna/'],['EVENT','/event/'],['KAKAO CHANNEL','https://pf.kakao.com/_xgIeFX','external']);
      if(isAdmin||isOperator)links.push(['가입 관리','/ot-admin/']);
      if(isAdmin)links.push(['운영자료 · ADMIN SETTINGS','/admin-settings/'],['SITE LOG','/site-log/']);
      links.forEach(item=>{
        const link=document.createElement('a');link.href=item[1];const target=item[1].replace(/\/$/,'')||'/';
        if(path===target||(target!=='/'&&path.startsWith(target+'/')))link.classList.add('active');
        if(item[1]==='/me/'||item[1]==='/ot-room/')link.classList.add('vom-menu-account');
        if(item[2]==='external'){link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','VOM 카카오 채널 열기');}
        link.innerHTML='<span>'+item[0]+'</span><span>'+(item[2]==='external'?'↗':'→')+'</span>';card.appendChild(link);
      });
    });
  }

  let shellRefreshVersion=0;
  async function refreshShell(){
    const version=++shellRefreshVersion;
    let context={approved:false,isAdmin:false,member:null};
    try{context=await window.vomGetMemberAccess();}catch(_){}
    let operator=context.isAdmin;
    if(context.approved&&!operator){
      try{const response=await fetch(SUPABASE_URL+'/functions/v1/ot-review',{method:'POST',headers:{'Content-Type':'application/json',apikey:SUPABASE_KEY,Authorization:'Bearer '+storedAccessToken()},body:JSON.stringify({action:'context'})});operator=response.ok;}catch(_){}
    }
    // Only the latest login state may update the shared navigation.
    if(version!==shellRefreshVersion)return;
    normalizeBottomNavigation(context.approved);
    setUnifiedMenu(context.isAdmin,operator,context.approved);
    addMemberStatus(context.member?.name||context.member?.nickname||(context.isAdmin?'관리자':'회원'),context.approved,context.isAdmin);
    if(context.isAdmin)addAdminBadge();else{document.querySelectorAll('.vom-shell-admin-badge').forEach(badge=>badge.remove());document.getElementById('adminBadge')?.classList.remove('show');}
  }
  window.vomRefreshShell=refreshShell;

  function loadConsultationWidget() {
    if (document.getElementById('vom-consultation-script')) return;
    if (/^\/(me|admin-settings|admin|operator-alert|site-log|ot-room|ot-admin)(\/|$)/.test(path)) return;
    const script = document.createElement('script');
    script.id = 'vom-consultation-script';
    script.src = '/assets/vom-consultation.js?v=1';
    script.async = false;
    document.body.appendChild(script);
  }


  function ensurePageAtmosphere() {
    if (path === '/') return;
    const body = document.body;
    if (!body) return;
    let layer = body.querySelector(':scope > .aurora');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 'aurora';
      body.prepend(layer);
    }
    layer.classList.add('vom-shell-aurora');
    layer.setAttribute('aria-hidden', 'true');
    if (!layer.querySelector('.vom-atmosphere-mist')) {
      ['one', 'two', 'three', 'four'].forEach(function (name) {
        const mist = document.createElement('span');
        mist.className = 'vom-atmosphere-mist ' + name;
        layer.appendChild(mist);
      });
    }
  }

  function bootstrap() {
    initVomTheme();
    setupPwa();
    ensurePageAtmosphere();
    addStyle();
    normalizeBottomNavigation();
    normalizeBackLinks();
    keepBackLinksNormalized();
    ensureFallbackMenu();
    setUnifiedMenu();
    refreshShell();
    loadConsultationWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
