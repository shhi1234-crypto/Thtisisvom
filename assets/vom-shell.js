/* VOM shared member shell: consistent navigation, contextual back links and current member display. */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://aqfmhqultzpakfqwzulj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const path = (window.location.pathname.replace(/\/+$/, '') || '/');

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
        font: 700 8px/1 "DM Sans", Pretendard, Arial, sans-serif !important;
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
    if (path === '/event' || path.startsWith('/event/')) return 'event';
    return '';
  }

  function normalizeBottomNavigation() {
    const nav = document.querySelector('nav.bottom');
    if (!nav) return;

    const active = activeKey();
    const item = (key, href, icon, label) =>
      `<a href="${href}" class="${active === key ? 'active' : ''}" ${active === key ? 'aria-current="page"' : ''}><span class="nav-icon">${icon}</span>${label}</a>`;

    nav.classList.add('vom-global-bottom');
    nav.setAttribute('aria-label', '주요 메뉴');
    nav.innerHTML =
      item('home', '/', '⌂', 'HOME') +
      item('calendar', '/calendar/', '◫', 'CALENDAR') +
      item('members', '/members/', '♙', 'MEMBERS') +
      item('event', '/event/', '✦', 'EVENT') +
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

  function addMemberStatus(label, loggedIn) {
    const menuButton = document.querySelector('.header .menu-btn');
    const host = (menuButton && menuButton.parentElement) ||
      document.querySelector('.header-actions, .header-right, .header');
    if (!host || host.querySelector('.member-session-chip')) return;

    const chip = document.createElement('a');
    chip.className = 'member-session-chip' + (loggedIn ? '' : ' is-guest');
    chip.href = '/me/';
    chip.setAttribute(
      'aria-label',
      loggedIn ? '현재 로그인: ' + label + '. MY VOM으로 이동' : '현재 로그인 전입니다. MY VOM으로 이동'
    );

    const nameText = document.createElement('span');
    nameText.className = 'member-session-name';
    nameText.textContent = loggedIn ? label + '님' : '로그인 전';
    chip.appendChild(nameText);

    if (menuButton && menuButton.parentElement === host) {
      host.insertBefore(chip, menuButton);
    } else {
      host.appendChild(chip);
    }
  }


  function adminBadgeHost() {
    return document.querySelector('.header-right, .header-actions, .header');
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

  function setUnifiedMenu(isAdmin, isOperator) {
    document.querySelectorAll('.menu-card, .vom-shell-fallback-card').forEach(function (card) {
      const top = card.querySelector('.menu-top');
      if (!top) return;
      card.querySelectorAll(':scope > a').forEach(function (link) { link.remove(); });
      const links = [
        ['HOME', '/'],
        ['INFO', '/info/'],
        ['CALENDAR', '/calendar/'],
        ['VOM LIVE', '/live/'],
        ['BUSKING', '/busking/'],
        ['MEMBERS', '/members/'],
        ['MY VOM', '/me/'],
        ['가입 신청 · OT Room', '/ot-room/'],
        ['Q&A', '/qna/']
      ];
      if (isAdmin || isOperator) links.push(['OT 가입 검토', '/ot-admin/']);
      if (isAdmin) links.push(['운영자료 · ADMIN SETTINGS', '/admin-settings/']);
      links.forEach(function (item) {
        const link = document.createElement('a');
        link.href = item[1];
        if (path === item[1].replace(/\/$/, '') || (item[1] !== '/' && path.indexOf(item[1].replace(/\/$/, '')) === 0)) link.classList.add('active');
        link.innerHTML = '<span>' + item[0] + '</span><span>→</span>';
        card.appendChild(link);
      });
    });
  }

  async function checkAdminShell() {
    const token = storedAccessToken();
    if (!token) {
      setUnifiedMenu(false);
      return false;
    }
    try {
      const userRes = await window.fetch(SUPABASE_URL + '/auth/v1/user', {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token }
      });
      if (!userRes.ok) {
        setUnifiedMenu(false);
        return false;
      }
      const user = await userRes.json();
      const adminRes = await window.fetch(
        SUPABASE_URL + '/rest/v1/admins?select=user_id&user_id=eq.' + encodeURIComponent(user.id),
        { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token } }
      );
      const admins = adminRes.ok ? await adminRes.json() : [];
      const isAdmin = Array.isArray(admins) && admins.length > 0;
      if (isAdmin) addAdminBadge();
      let isOperator = isAdmin;
      if (!isAdmin) {
        const operatorRes = await window.fetch(SUPABASE_URL + '/functions/v1/ot-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ action: 'context' })
        });
        isOperator = operatorRes.ok;
      }
      setUnifiedMenu(isAdmin, isOperator);
      return isAdmin;
    } catch (_) {
      setUnifiedMenu(false);
      return false;
    }
  }

  async function showCurrentMember() {
    const accessToken = storedAccessToken();
    if (!accessToken) {
      addMemberStatus('', false);
      return;
    }

    try {
      const response = await window.fetch(SUPABASE_URL + '/functions/v1/member-account', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + accessToken
        },
        body: JSON.stringify({ action: 'whoami' })
      });
      if (!response.ok) return;

      const data = await response.json();
      const member = data && (data.member || (data.data && data.data.member) || data);
      const name = member && member.name;
      if (name) addMemberStatus(name, true);
    } catch (_) {
      // 로그인 표시는 보조 기능이므로 본문 사용을 막지 않습니다.
    }
  }

  function loadConsultationWidget() {
    if (document.getElementById('vom-consultation-script')) return;
    if (/^\/(admin-settings|admin|operator-alert|site-log)(\/|$)/.test(path)) return;
    const script = document.createElement('script');
    script.id = 'vom-consultation-script';
    script.src = '/assets/vom-consultation.js?v=1';
    script.async = false;
    document.body.appendChild(script);
  }

  function bootstrap() {
    addStyle();
    normalizeBottomNavigation();
    normalizeBackLinks();
    keepBackLinksNormalized();
    ensureFallbackMenu();
    checkAdminShell();
    showCurrentMember();
    loadConsultationWidget();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
