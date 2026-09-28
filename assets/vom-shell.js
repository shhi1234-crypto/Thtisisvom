/* VOM shared member shell: consistent navigation, HOME return and current member display. */
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
      .member-session-chip .member-session-name {
        overflow: hidden;
        text-overflow: ellipsis;
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

  function normalizeBackLinks() {
    document.querySelectorAll('a.back').forEach(function (link) {
      const label = (link.textContent || '').replace(/\s+/g, ' ').trim();
      if (!/^←\s*HOME$/i.test(label)) {
        link.href = '/';
        link.textContent = '← HOME';
        link.setAttribute('aria-label', 'HOME으로 돌아가기');
      }
    });
  }

  async function showCurrentMember() {
    if (!window.supabase || !window.supabase.createClient) return;

    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    const sessionResult = await client.auth.getSession();
    if (!sessionResult || !sessionResult.data || !sessionResult.data.session) return;

    try {
      const result = await client.functions.invoke('member-account', {
        body: { action: 'whoami' }
      });
      const data = result && result.data;
      const member = data && (data.member || (data.data && data.data.member) || data);
      const name = member && member.name;
      if (!name) return;

      const menuButton = document.querySelector('.header .menu-btn');
      const host = (menuButton && menuButton.parentElement) ||
        document.querySelector('.header-actions, .header-right, .header');
      if (!host || host.querySelector('.member-session-chip')) return;

      const chip = document.createElement('a');
      chip.className = 'member-session-chip';
      chip.href = '/me/';
      chip.setAttribute('aria-label', '현재 로그인: ' + name + '. MY VOM으로 이동');
      const nameText = document.createElement('span');
      nameText.className = 'member-session-name';
      nameText.textContent = name + '님';
      chip.appendChild(nameText);

      if (menuButton && menuButton.parentElement === host) {
        host.insertBefore(chip, menuButton);
      } else {
        host.appendChild(chip);
      }
    } catch (_) {
      // 로그인 표시는 보조 기능이므로 본문 사용을 막지 않습니다.
    }
  }

  function bootstrap() {
    addStyle();
    normalizeBottomNavigation();
    normalizeBackLinks();
    showCurrentMember();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();