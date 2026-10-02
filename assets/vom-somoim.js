/* VOM · 소모임 앱 참가 안내 */
(function () {
  'use strict';

  const SOMOIM_URL = 'https://www.somoim.co.kr/7e263c04-3dd1-4818-b837-4a9351d46d591';
  const SUPABASE_URL = 'https://aqfmhqultzpakfqwzulj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  const supportedPaths = ['/calendar', '/live', '/busking', '/schedule'];

  if (!supportedPaths.includes(path)) return;

  function isPracticeEvent(event) {
    const type = String(event && event.event_type || '').trim().toUpperCase();
    const title = String(event && event.title || '');
    return type === 'PRACTICE' || /(?:연습\s*모임|연습모임|연모)/.test(title);
  }

  function shouldShow(event) {
    return !isPracticeEvent(event) && (!event || event.somoim_open_enabled !== false);
  }

  function installStyle() {
    if (document.getElementById('vom-somoim-bridge-style')) return;
    const style = document.createElement('style');
    style.id = 'vom-somoim-bridge-style';
    style.textContent = [
      '.vom-somoim-bridge{margin:0 0 18px}',
      '.vom-somoim-bridge a{display:grid;grid-template-columns:36px minmax(0,1fr) 22px;align-items:center;gap:11px;padding:13px 14px;border:1px solid rgba(108,89,205,.16);border-radius:17px;background:linear-gradient(135deg,rgba(244,241,255,.98),rgba(235,249,247,.94));color:#272b3f;text-decoration:none;box-shadow:0 10px 24px rgba(62,54,128,.055);transition:transform .16s ease,box-shadow .16s ease}',
      '.vom-somoim-bridge a:hover{transform:translateY(-1px);box-shadow:0 14px 29px rgba(62,54,128,.1)}',
      '.vsm-mark{display:grid;width:36px;height:36px;place-items:center;border-radius:12px;background:linear-gradient(135deg,#7862dc,#6f8ee8);color:#fff;font:800 11px/1 Arial,sans-serif;letter-spacing:-.04em}',
      '.vsm-copy{min-width:0}.vsm-copy span{display:block;color:#7461d5;font-size:8px;font-weight:900;letter-spacing:.09em}.vsm-copy strong{display:block;margin-top:3px;font-size:12px;letter-spacing:-.03em}.vsm-copy small{display:block;margin-top:3px;color:#777f91;font-size:9px;line-height:1.45}',
      '.vsm-arrow{color:#725ed5;font-size:17px;font-weight:900;text-align:right}',
      '@media(max-width:640px){.vom-somoim-bridge{margin-bottom:15px}.vom-somoim-bridge a{padding:12px 13px;border-radius:15px}.vsm-copy strong{font-size:11px}.vsm-copy small{font-size:8.5px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function bridgeCopy() {
    if (path === '/calendar') {
      return {
        title: '일정 참가 신청은 소모임 앱에서',
        detail: '원하는 날짜의 VOM 정모에서 참석 신청해 주세요.'
      };
    }
    return {
      title: '소모임 앱에서 참가 신청하기',
      detail: '참가 신청은 해당 일정의 VOM 정모에서 진행돼요.'
    };
  }

  function createBridge() {
    const copy = bridgeCopy();
    const section = document.createElement('section');
    section.id = 'vom-somoim-bridge';
    section.className = 'vom-somoim-bridge';
    section.innerHTML =
      '<a href="' + SOMOIM_URL + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="vsm-mark" aria-hidden="true">S</span>' +
        '<span class="vsm-copy"><span>VOM × SOMOIM</span><strong>' + copy.title + '</strong><small>' + copy.detail + '</small></span>' +
        '<b class="vsm-arrow" aria-hidden="true">↗</b>' +
      '</a>';
    return section;
  }

  function pageReady(main) {
    const text = String(main && main.textContent || '');
    return !/불러오는 중|불러오지 못했습니다/.test(text);
  }

  function insertBridge(event) {
    const existing = document.getElementById('vom-somoim-bridge');
    if (!shouldShow(event)) {
      if (existing) existing.remove();
      return true;
    }

    const main = document.querySelector('main');
    if (!main || !pageReady(main)) return false;
    if (existing) return true;

    const bridge = createBridge();
    const children = Array.from(main.children);

    if (path === '/calendar') {
      const hero = children.find(function (child) { return child.classList && child.classList.contains('hero'); });
      if (hero) hero.insertAdjacentElement('afterend', bridge);
      else main.prepend(bridge);
      return true;
    }

    const back = children.find(function (child) { return child.classList && child.classList.contains('back'); });
    if (back) back.insertAdjacentElement('afterend', bridge);
    else if (children.length) main.insertBefore(bridge, children[0]);
    else main.appendChild(bridge);
    return true;
  }

  async function getCurrentEvent() {
    const id = new URLSearchParams(window.location.search).get('id');
    if (!id) return {};

    try {
      const response = await fetch(
        SUPABASE_URL + '/rest/v1/events?select=event_type%2Ctitle%2Csomoim_open_enabled&id=eq.' + encodeURIComponent(id),
        { headers: { apikey: SUPABASE_KEY } }
      );
      if (!response.ok) return {};
      const rows = await response.json();
      return Array.isArray(rows) && rows[0] ? rows[0] : {};
    } catch (_) {
      return {};
    }
  }

  function start() {
    installStyle();
    getCurrentEvent().then(function (event) {
      if (insertBridge(event)) return;

      const observer = new MutationObserver(function () {
        insertBridge(event);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      window.setTimeout(function () {
        observer.disconnect();
      }, 15000);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
