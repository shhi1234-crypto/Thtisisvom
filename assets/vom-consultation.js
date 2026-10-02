/* VOM 문의 · 기존 Q&A 테이블을 이용하는 공통 상담창 */
(function () {
  'use strict';

  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (/^\/(admin-settings|admin|operator-alert|site-log)(\/|$)/.test(path)) return;

  const SUPABASE_URL = 'https://aqfmhqultzpakfqwzulj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const QUESTION_SELECT = 'id,member_id,category,title,content,status,is_public,is_anonymous,channel,created_at,updated_at,vom_qna_answers(id,content,is_public,created_at,updated_at)';

  const FAQS = [
    {
      category: 'VOM 이용안내',
      title: 'VOM은 어떻게 참여하나요?',
      body: 'VOM의 일정과 기본 안내는 홈페이지 캘린더에서 확인할 수 있어요. 실제 참가 신청은 각 일정의 소모임 앱에서 진행합니다.',
      href: '/calendar/',
      link: '일정 보러가기'
    },
    {
      category: '모임 참여',
      title: '참가 신청은 어디서 하나요?',
      body: '참가 신청은 각 일정의 소모임 앱에서 진행합니다. 원하는 일정의 정모에서 참석 신청해 주세요. 참가 인원·마감·참가비·준비 사항은 해당 정모 공지를 기준으로 확인하면 됩니다.',
      href: '/calendar/',
      link: '일정 확인하기'
    },
    {
      category: '공연·버스킹',
      title: '버스킹·공연 준비 안내',
      body: '버스킹은 공연별 공지와 셋리스트 마감일을 우선 확인해 주세요. 개인 MR은 현장에서 충분히 들릴 수 있도록 음량을 미리 점검하고, 개인 영상은 현장 컨디션에 따라 직접 챙겨 주시면 좋아요.',
      href: '/busking/',
      link: '버스킹 안내'
    },
    {
      category: '일정',
      title: '일정은 어디서 확인하나요?',
      body: 'VOM의 전체 일정과 세부 내용을 캘린더에서 확인할 수 있어요. 날짜·장소·시간이 바뀌는 경우에는 해당 일정 공지와 소모임 안내가 가장 최신입니다.',
      href: '/calendar/',
      link: '캘린더 열기'
    },
    {
      category: '참가비·환불',
      title: '참가비와 환불이 궁금해요',
      body: '참가비와 환불 가능 여부는 일정별 공지의 기준을 먼저 확인해 주세요. 상황 확인이 필요한 경우에는 비공개 문의로 남겨 주시면 운영진이 답변드려요.',
      href: '/qna/',
      link: '공개 질문 찾아보기'
    },
    {
      category: '기타 문의',
      title: '그 외 궁금한 내용',
      body: '빠른 안내에서 해결되지 않은 내용은 운영진에게 바로 문의할 수 있어요. 개인적인 내용은 비공개로, 다른 회원에게도 도움이 될 질문은 공개로 남겨 주세요.',
      href: '/qna/',
      link: 'Q&A 열람하기'
    }
  ];
  const CATEGORIES = FAQS.map(function (item) { return item.category; });
  const state = { open: false, view: 'home', member: null, token: '', loadingMember: false, inquiries: [], loadingInquiries: false, selectedFaq: null };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }

  function storedAccessToken() {
    try {
      const raw = window.localStorage.getItem('sb-aqfmhqultzpakfqwzulj-auth-token');
      const parsed = raw && JSON.parse(raw);
      return parsed && parsed.access_token ? parsed.access_token : '';
    } catch (_) {
      return '';
    }
  }

  function errorMessage(error, fallback) {
    const value = String(error && error.message ? error.message : error || '');
    if (/row-level security|permission denied|401|403/i.test(value)) return '로그인 상태를 다시 확인해 주세요. MY VOM에서 다시 로그인한 뒤 이용할 수 있어요.';
    return fallback || value || '잠시 후 다시 시도해 주세요.';
  }

  async function api(pathname, options, token) {
    const headers = Object.assign({
      apikey: SUPABASE_KEY,
      'Content-Type': 'application/json'
    }, (options && options.headers) || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await window.fetch(SUPABASE_URL + '/rest/v1/' + pathname, Object.assign({}, options || {}, { headers: headers }));
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = text; }
    if (!response.ok) {
      const message = payload && (payload.message || payload.hint || payload.details) || response.statusText;
      throw new Error(message || '요청을 처리하지 못했습니다.');
    }
    return payload;
  }

  async function loadMember() {
    if (state.loadingMember) return state.member;
    state.loadingMember = true;
    state.token = storedAccessToken();
    if (!state.token) {
      state.member = null;
      state.loadingMember = false;
      return null;
    }
    try {
      const response = await window.fetch(SUPABASE_URL + '/functions/v1/member-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: 'Bearer ' + state.token },
        body: JSON.stringify({ action: 'whoami' })
      });
      if (!response.ok) throw new Error('로그인 정보를 확인하지 못했습니다.');
      const payload = await response.json();
      state.member = payload && (payload.member || (payload.data && payload.data.member)) || null;
      if (!state.member || !state.member.id) state.member = null;
    } catch (_) {
      state.member = null;
    } finally {
      state.loadingMember = false;
    }
    return state.member;
  }

  function statusText(status) {
    return ({ '신규': '신규', '대기': '신규', '확인중': '확인중', '답변완료': '답변완료', '보류': '보류' })[status] || '확인중';
  }

  function statusClass(status) {
    return ({ '신규': 'new', '대기': 'new', '확인중': 'progress', '답변완료': 'done', '보류': 'hold' })[status] || 'progress';
  }

  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.getFullYear() + '.' + String(date.getMonth() + 1).padStart(2, '0') + '.' + String(date.getDate()).padStart(2, '0');
  }

  function answersOf(question) {
    const answers = question && question.vom_qna_answers;
    return Array.isArray(answers) ? answers : (answers ? [answers] : []);
  }

  function faqCard(faq, index) {
    return '<button type="button" class="vc-topic" data-vc-action="faq" data-vc-faq="' + index + '"><span>' + esc(faq.category) + '</span><b>' + esc(faq.title) + '</b><i>→</i></button>';
  }

  function memberName() {
    return state.member && (state.member.name || state.member.nickname) || '회원';
  }

  function homeMarkup() {
    return '<div class="vc-hero"><span class="vc-kicker">VOM HELP CENTER</span><h2>무엇을 도와드릴까요?</h2><p>자주 찾는 안내를 먼저 확인하고, 해결되지 않으면 운영진에게 바로 문의할 수 있어요.</p></div>' +
      '<div class="vc-topic-grid">' + FAQS.map(faqCard).join('') + '</div>' +
      '<div class="vc-bottom-actions"><button type="button" class="vc-primary" data-vc-action="form">운영진에게 문의하기 <span>→</span></button>' +
      (state.member ? '<button type="button" class="vc-secondary" data-vc-action="mine">내 문의 확인</button>' : '<a class="vc-secondary" href="/me/">MY VOM 로그인하기</a>') +
      '<a class="vc-text-link" href="/qna/">Q&A에서 공개 질문 찾아보기 →</a></div>';
  }

  function faqMarkup() {
    const faq = FAQS[state.selectedFaq] || FAQS[0];
    return '<button type="button" class="vc-back" data-vc-action="home">← 빠른 안내</button>' +
      '<article class="vc-answer-card"><span class="vc-answer-category">' + esc(faq.category) + '</span><h2>' + esc(faq.title) + '</h2><p>' + esc(faq.body).replace(/\n/g, '<br>') + '</p>' +
      (faq.href ? '<a class="vc-inline-link" href="' + esc(faq.href) + '">' + esc(faq.link) + ' →</a>' : '') + '</article>' +
      '<div class="vc-bottom-actions"><button type="button" class="vc-primary" data-vc-action="form" data-vc-category="' + esc(faq.category) + '">해결되지 않았어요 · 문의하기 <span>→</span></button><button type="button" class="vc-secondary" data-vc-action="home">다른 안내 보기</button></div>';
  }

  function loginMarkup() {
    return '<button type="button" class="vc-back" data-vc-action="home">← 문의 홈</button>' +
      '<article class="vc-login-card"><span class="vc-answer-category">MEMBER ONLY</span><h2>회원 계정으로 문의해 주세요</h2><p>문의 내용과 답변은 MY VOM에 로그인된 회원 계정으로 안전하게 연결돼요.</p><a class="vc-primary" href="/me/">MY VOM 로그인하기 <span>→</span></a><button type="button" class="vc-secondary" data-vc-action="home">빠른 안내로 돌아가기</button></article>';
  }

  function formMarkup() {
    if (!state.member) return loginMarkup();
    const selected = state.pendingCategory && CATEGORIES.indexOf(state.pendingCategory) >= 0 ? state.pendingCategory : '기타 문의';
    return '<button type="button" class="vc-back" data-vc-action="home">← 문의 홈</button>' +
      '<div class="vc-form-head"><span class="vc-answer-category">CONTACT VOM</span><h2>운영진에게 문의하기</h2><p><b>' + esc(memberName()) + '</b>님으로 문의를 남겨요. 답변은 내 문의에서 확인할 수 있어요.</p></div>' +
      '<form id="vomConsultationForm" class="vc-form"><label>문의 유형<select id="vcCategory">' + CATEGORIES.map(function (category) { return '<option' + (category === selected ? ' selected' : '') + '>' + esc(category) + '</option>'; }).join('') + '</select></label>' +
      '<label>문의 내용<textarea id="vcContent" maxlength="3000" minlength="2" placeholder="궁금한 내용을 편하게 적어 주세요." required></textarea><small>개인정보나 민감한 내용은 비공개로 남겨 주세요.</small></label>' +
      '<fieldset class="vc-visibility"><legend>공개 여부</legend><label><input type="radio" name="vcVisibility" value="private" checked><span><b>비공개</b><small>작성자와 운영진만 확인</small></span></label><label><input type="radio" name="vcVisibility" value="public"><span><b>공개</b><small>다른 회원도 Q&A에서 열람 가능</small></span></label></fieldset>' +
      '<button id="vcSubmit" type="submit" class="vc-primary">문의 접수하기 <span>→</span></button></form>';
  }

  function inquiryMarkup(question) {
    const answers = answersOf(question);
    const answer = answers.length ? answers[0] : null;
    const channel = question.channel === 'CONSULTATION' ? 'VOM 문의' : '기존 Q&A';
    return '<article class="vc-inquiry"><div class="vc-inquiry-top"><div><span class="vc-inquiry-category">' + esc(question.category || '기타 문의') + ' · ' + esc(channel) + '</span><h3>' + esc(question.title || '문의') + '</h3></div><span class="vc-status ' + statusClass(question.status) + '">' + statusText(question.status) + '</span></div><p class="vc-inquiry-content">' + esc(question.content || '').replace(/\n/g, '<br>') + '</p><div class="vc-inquiry-meta">' + (question.is_public ? '공개 문의' : '비공개 문의') + ' · ' + formatDate(question.created_at) + '</div>' +
      (answer ? '<div class="vc-reply"><b>VOM 운영진 답변</b><p>' + esc(answer.content || '').replace(/\n/g, '<br>') + '</p></div>' : '<div class="vc-awaiting">운영진이 확인 중이에요.</div>') + '</article>';
  }

  function mineMarkup() {
    if (!state.member) return loginMarkup();
    const list = state.loadingInquiries ? '<div class="vc-empty">내 문의를 불러오는 중이에요.</div>' : state.inquiries.length ? state.inquiries.map(inquiryMarkup).join('') : '<div class="vc-empty">아직 남긴 문의가 없어요.<br>궁금한 점이 생기면 편하게 남겨 주세요.</div>';
    return '<button type="button" class="vc-back" data-vc-action="home">← 문의 홈</button><div class="vc-form-head vc-mine-head"><span class="vc-answer-category">MY CONTACTS</span><h2>내 문의</h2><p><b>' + esc(memberName()) + '</b>님의 문의와 운영진 답변을 확인해요.</p></div><div class="vc-inquiry-list">' + list + '</div><div class="vc-bottom-actions"><button type="button" class="vc-primary" data-vc-action="form">새 문의 작성하기 <span>→</span></button><button type="button" class="vc-secondary" data-vc-action="reload-mine">새로고침</button></div>';
  }

  function successMarkup() {
    return '<div class="vc-success"><span>✓</span><h2>문의가 접수됐어요</h2><p>운영진이 확인한 뒤 답변을 남기면<br>이 상담창의 <b>내 문의</b>에서 확인할 수 있어요.</p><button type="button" class="vc-primary" data-vc-action="mine">내 문의 확인 <span>→</span></button><button type="button" class="vc-secondary" data-vc-action="home">빠른 안내로 돌아가기</button></div>';
  }

  function renderBody() {
    const body = root.querySelector('.vc-body');
    if (!body) return;
    let markup = homeMarkup();
    if (state.view === 'faq') markup = faqMarkup();
    if (state.view === 'form') markup = formMarkup();
    if (state.view === 'mine') markup = mineMarkup();
    if (state.view === 'success') markup = successMarkup();
    body.innerHTML = markup;
  }

  function setOpen(next) {
    state.open = Boolean(next);
    root.classList.toggle('is-open', state.open);
    root.querySelector('.vc-panel').setAttribute('aria-hidden', state.open ? 'false' : 'true');
    root.querySelector('.vc-fab').setAttribute('aria-expanded', state.open ? 'true' : 'false');
    if (state.open) {
      root.querySelector('.vc-panel').focus({ preventScroll: true });
      loadMember().then(function () { renderBody(); });
    }
  }

  async function loadInquiries() {
    if (!state.member || state.loadingInquiries) return;
    state.loadingInquiries = true;
    renderBody();
    try {
      const query = 'vom_qna_questions?select=' + encodeURIComponent(QUESTION_SELECT) + '&member_id=eq.' + encodeURIComponent(state.member.id) + '&order=created_at.desc';
      const data = await api(query, { method: 'GET' }, state.token);
      state.inquiries = Array.isArray(data) ? data : [];
    } catch (error) {
      state.inquiries = [];
      toast(errorMessage(error, '내 문의를 불러오지 못했습니다.'), true);
    } finally {
      state.loadingInquiries = false;
      renderBody();
    }
  }

  async function submitInquiry(form) {
    if (!state.member) {
      state.view = 'form';
      renderBody();
      return;
    }
    const content = (form.querySelector('#vcContent').value || '').trim();
    const category = form.querySelector('#vcCategory').value;
    const visibility = form.querySelector('input[name="vcVisibility"]:checked').value;
    const title = ('[' + category + '] ' + content.replace(/\s+/g, ' ').slice(0, 72)).slice(0, 100);
    if (content.length < 2) {
      toast('문의 내용을 두 글자 이상 입력해 주세요.', true);
      return;
    }
    const button = form.querySelector('#vcSubmit');
    button.disabled = true;
    button.textContent = '문의 접수 중…';
    try {
      await api('vom_qna_questions', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          member_id: Number(state.member.id),
          category: category,
          title: title,
          content: content,
          status: '신규',
          channel: 'CONSULTATION',
          is_public: visibility === 'public',
          is_anonymous: false
        })
      }, state.token);
      state.inquiries = [];
      state.view = 'success';
      renderBody();
    } catch (error) {
      toast(errorMessage(error, '문의 접수에 실패했어요. 잠시 후 다시 시도해 주세요.'), true);
      button.disabled = false;
      button.innerHTML = '문의 접수하기 <span>→</span>';
    }
  }

  function toast(message, isError) {
    const el = root.querySelector('.vc-toast');
    el.textContent = message;
    el.className = 'vc-toast show' + (isError ? ' error' : '');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(function () { el.className = 'vc-toast'; }, 3600);
  }

  const root = document.createElement('aside');
  root.id = 'vom-consultation';
  root.className = 'vom-consultation';
  root.innerHTML = '<button type="button" class="vc-fab" aria-expanded="false" aria-controls="vomConsultationPanel"><span class="vc-fab-icon">💬</span><span class="vc-fab-copy"><b>VOM 문의</b><small>궁금한 내용을 바로 물어보세요</small></span></button>' +
    '<section id="vomConsultationPanel" class="vc-panel" role="dialog" aria-label="VOM 문의 상담센터" aria-hidden="true" tabindex="-1"><header class="vc-header"><div><span>VOM COMPANY</span><h1>VOM 문의</h1></div><div><button type="button" class="vc-qna-link" data-vc-action="qna">Q&A</button><button type="button" class="vc-close" data-vc-action="close" aria-label="문의창 닫기">×</button></div></header><div class="vc-body"></div></section><div class="vc-toast" role="status" aria-live="polite"></div>';
  document.body.appendChild(root);

  const style = document.createElement('style');
  style.id = 'vom-consultation-style';
  style.textContent = `
    .vom-consultation{position:fixed;right:22px;bottom:max(92px,calc(env(safe-area-inset-bottom) + 82px));z-index:260;font-family:Pretendard,"Noto Sans KR","DM Sans",Arial,sans-serif;color:#252a42}.vom-consultation *{box-sizing:border-box}.vc-fab{display:flex;align-items:center;gap:10px;min-height:52px;padding:8px 14px 8px 9px;border:1px solid rgba(255,255,255,.9);border-radius:18px;background:linear-gradient(135deg,#755fdb,#6789e7);color:#fff;box-shadow:0 15px 34px rgba(73,61,148,.26);cursor:pointer;transition:transform .18s ease,box-shadow .18s ease}.vc-fab:hover{transform:translateY(-2px);box-shadow:0 20px 42px rgba(73,61,148,.32)}.vc-fab-icon{display:grid;width:34px;height:34px;place-items:center;border-radius:12px;background:rgba(255,255,255,.2);font-size:17px}.vc-fab-copy{display:grid;gap:2px;text-align:left}.vc-fab-copy b{font-size:12px;line-height:1.15;letter-spacing:-.02em}.vc-fab-copy small{font-size:8px;line-height:1.2;opacity:.85}.vc-panel{position:absolute;right:0;bottom:64px;width:min(386px,calc(100vw - 28px));max-height:min(655px,calc(100vh - 125px));overflow:hidden;border:1px solid rgba(255,255,255,.96);border-radius:24px;background:rgba(255,255,255,.96);box-shadow:0 28px 75px rgba(29,28,67,.24);opacity:0;pointer-events:none;transform:translateY(10px) scale(.985);transform-origin:bottom right;transition:opacity .18s ease,transform .18s ease;backdrop-filter:blur(24px)}.vom-consultation.is-open .vc-panel{opacity:1;pointer-events:auto;transform:translateY(0) scale(1)}.vc-header{display:flex;align-items:center;justify-content:space-between;min-height:72px;padding:14px 16px;border-bottom:1px solid rgba(100,90,163,.09);background:linear-gradient(125deg,rgba(244,240,255,.92),rgba(233,248,247,.88))}.vc-header>div:first-child{display:grid;gap:4px}.vc-header span,.vc-kicker,.vc-answer-category{color:#7562d6;font-size:8px;font-weight:900;letter-spacing:.09em}.vc-header h1{margin:0;color:#252942;font-size:18px;line-height:1;font-weight:900;letter-spacing:-.04em}.vc-header>div:last-child{display:flex;gap:7px}.vc-qna-link,.vc-close{display:inline-grid;place-items:center;border:0;cursor:pointer}.vc-qna-link{min-width:41px;height:31px;border-radius:9px;background:rgba(255,255,255,.78);color:#6b58cc;font-size:9px;font-weight:900}.vc-close{width:31px;height:31px;border-radius:50%;background:rgba(255,255,255,.75);color:#62687c;font-size:21px;line-height:1}.vc-body{max-height:calc(min(655px,calc(100vh - 125px)) - 72px);overflow:auto;padding:17px;overscroll-behavior:contain}.vc-hero h2,.vc-form-head h2,.vc-answer-card h2,.vc-login-card h2,.vc-success h2{margin:5px 0 0;color:#242940;font-size:21px;line-height:1.25;letter-spacing:-.05em}.vc-hero p,.vc-form-head p,.vc-answer-card p,.vc-login-card p,.vc-success p{margin:9px 0 0;color:#71788b;font-size:11px;line-height:1.68}.vc-topic-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:17px}.vc-topic{position:relative;min-height:91px;padding:12px 28px 11px 12px;border:1px solid rgba(105,90,190,.11);border-radius:15px;background:linear-gradient(145deg,#fff,#f8f7fc);text-align:left;cursor:pointer;transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease}.vc-topic:hover{transform:translateY(-1px);border-color:rgba(113,93,212,.28);box-shadow:0 9px 20px rgba(48,43,92,.08)}.vc-topic span{display:block;color:#836edb;font-size:8px;font-weight:900}.vc-topic b{display:-webkit-box;overflow:hidden;margin-top:8px;color:#40465d;font-size:10px;line-height:1.48;letter-spacing:-.035em;-webkit-box-orient:vertical;-webkit-line-clamp:2}.vc-topic i{position:absolute;right:11px;bottom:10px;color:#8d7ade;font-size:13px;font-style:normal}.vc-bottom-actions{display:grid;gap:8px;margin-top:16px}.vc-primary,.vc-secondary{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;min-height:43px;border-radius:12px;font-family:inherit;font-size:11px;font-weight:900;text-decoration:none;cursor:pointer}.vc-primary{border:0;background:linear-gradient(135deg,#755fdb,#6d88e7);color:#fff;box-shadow:0 10px 22px rgba(99,79,202,.19)}.vc-primary:disabled{cursor:wait;opacity:.68}.vc-primary span{font-size:14px}.vc-secondary{border:1px solid rgba(108,94,195,.15);background:#fbfaff;color:#6957c9}.vc-text-link{display:block;padding:2px 0;color:#858a99;font-size:10px;font-weight:800;text-align:center;text-decoration:none}.vc-back{margin:0 0 14px;padding:0;border:0;background:transparent;color:#735fd7;font-family:inherit;font-size:10px;font-weight:900;cursor:pointer}.vc-answer-card,.vc-login-card{padding:17px;border:1px solid rgba(108,92,198,.12);border-radius:17px;background:linear-gradient(145deg,rgba(248,246,255,.96),rgba(241,251,249,.94))}.vc-answer-card p,.vc-login-card p{color:#5f677b}.vc-inline-link{display:inline-flex;margin-top:13px;color:#6754ca;font-size:10px;font-weight:900;text-decoration:underline;text-underline-offset:3px}.vc-login-card .vc-primary{margin-top:16px}.vc-login-card .vc-secondary{margin-top:8px}.vc-form-head{margin-bottom:15px}.vc-form-head p b{color:#5e50b5}.vc-form{display:grid;gap:12px}.vc-form>label{display:grid;gap:6px;color:#565e72;font-size:10px;font-weight:900}.vc-form select,.vc-form textarea{width:100%;border:1px solid #e3e0ee;border-radius:11px;background:#fff;color:#32384e;font-family:inherit;font-size:12px;outline:0}.vc-form select{height:42px;padding:0 10px}.vc-form textarea{min-height:116px;padding:11px;line-height:1.6;resize:vertical}.vc-form select:focus,.vc-form textarea:focus{border-color:#9a87ed;box-shadow:0 0 0 3px rgba(122,99,225,.1)}.vc-form label small{color:#9298a8;font-size:8px;font-weight:600;line-height:1.45}.vc-visibility{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin:0;padding:0;border:0}.vc-visibility legend{grid-column:1/-1;margin-bottom:1px;color:#565e72;font-size:10px;font-weight:900}.vc-visibility label{display:flex;align-items:flex-start;gap:7px;min-height:58px;padding:10px;border:1px solid rgba(108,92,198,.13);border-radius:11px;background:#fbfaff;cursor:pointer}.vc-visibility input{width:14px;height:14px;margin:0;accent-color:#715cdc}.vc-visibility span{display:grid;gap:3px}.vc-visibility b{color:#535b70;font-size:10px}.vc-visibility small{color:#888e9e;font-size:8px;line-height:1.35}.vc-inquiry-list{display:grid;gap:10px}.vc-inquiry{padding:13px;border:1px solid rgba(103,91,174,.12);border-radius:15px;background:#fff}.vc-inquiry-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.vc-inquiry-category{display:block;color:#8170d4;font-size:8px;font-weight:900;line-height:1.4}.vc-inquiry h3{margin:5px 0 0;color:#343a50;font-size:11px;line-height:1.45}.vc-status{flex:0 0 auto;padding:5px 7px;border-radius:8px;font-size:8px;font-weight:900;white-space:nowrap}.vc-status.new{background:#fff1df;color:#b57728}.vc-status.progress{background:#eeeaff;color:#6c5acf}.vc-status.done{background:#e8f7ef;color:#39845b}.vc-status.hold{background:#f0f1f5;color:#777e8d}.vc-inquiry-content{margin:10px 0 0;color:#656d7f;font-size:10px;line-height:1.65}.vc-inquiry-meta{margin-top:8px;color:#9a9fab;font-size:8px}.vc-reply{margin-top:11px;padding:10px 11px;border-radius:11px;background:linear-gradient(130deg,#f2efff,#effaf7)}.vc-reply b{display:block;color:#6654c8;font-size:8px}.vc-reply p{margin:5px 0 0;color:#596276;font-size:10px;line-height:1.62}.vc-awaiting{margin-top:10px;padding:8px 10px;border-radius:10px;background:#f7f6fa;color:#888e9d;font-size:9px}.vc-empty{padding:28px 16px;border:1px dashed rgba(103,91,174,.2);border-radius:15px;color:#8a90a0;font-size:10px;line-height:1.7;text-align:center}.vc-success{padding:28px 7px 7px;text-align:center}.vc-success>span{display:grid;width:48px;height:48px;place-items:center;margin:auto;border-radius:17px;background:linear-gradient(135deg,#7660dc,#6d8ce8);color:#fff;font-size:23px;font-weight:900;box-shadow:0 12px 28px rgba(104,83,207,.2)}.vc-success h2{margin-top:16px}.vc-success .vc-primary{margin-top:20px}.vc-success .vc-secondary{margin-top:8px}.vc-toast{position:fixed;right:0;bottom:0;z-index:1;width:min(360px,calc(100vw - 30px));padding:12px 14px;border-radius:13px;background:#23283d;color:#fff;font-size:10px;line-height:1.5;opacity:0;pointer-events:none;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease;box-shadow:0 15px 32px rgba(22,25,47,.2)}.vc-toast.show{opacity:1;transform:translateY(0)}.vc-toast.error{background:#aa5264}@media(max-width:640px){.vom-consultation{right:14px;bottom:max(79px,calc(env(safe-area-inset-bottom) + 74px))}.vc-fab{min-height:46px;padding:7px 11px 7px 8px;border-radius:16px}.vc-fab-icon{width:31px;height:31px;border-radius:10px;font-size:15px}.vc-fab-copy small{display:none}.vc-panel{bottom:56px;width:min(382px,calc(100vw - 24px));max-height:min(630px,calc(100vh - 114px));border-radius:22px}.vc-body{max-height:calc(min(630px,calc(100vh - 114px)) - 68px);padding:15px}.vc-header{min-height:68px;padding:13px 14px}.vc-topic-grid{gap:7px}.vc-topic{min-height:84px}.vc-toast{right:0;width:calc(100vw - 28px)}}
  `;
  document.head.appendChild(style);

  root.querySelector('.vc-fab').addEventListener('click', function () { setOpen(!state.open); });
  root.addEventListener('submit', function (event) {
    if (event.target && event.target.id === 'vomConsultationForm') {
      event.preventDefault();
      submitInquiry(event.target);
    }
  });
  root.addEventListener('click', function (event) {
    const button = event.target.closest('[data-vc-action]');
    if (!button) return;
    const action = button.getAttribute('data-vc-action');
    if (action === 'close') return setOpen(false);
    if (action === 'home') { state.view = 'home'; state.pendingCategory = ''; renderBody(); return; }
    if (action === 'faq') { state.selectedFaq = Number(button.getAttribute('data-vc-faq')) || 0; state.view = 'faq'; renderBody(); return; }
    if (action === 'form') { state.pendingCategory = button.getAttribute('data-vc-category') || ''; state.view = 'form'; renderBody(); return; }
    if (action === 'mine') { state.view = 'mine'; renderBody(); loadInquiries(); return; }
    if (action === 'reload-mine') { loadInquiries(); return; }
    if (action === 'qna') { window.location.href = '/qna/'; }
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && state.open) setOpen(false); });

  window.VOMConsultation = {
    open: function (view) {
      state.view = view === 'mine' ? 'mine' : view === 'form' ? 'form' : 'home';
      setOpen(true);
      renderBody();
      if (state.view === 'mine') loadInquiries();
    },
    refresh: function () { loadMember().then(function () { if (state.open) renderBody(); }); }
  };
  window.dispatchEvent(new Event('vom-consultation-ready'));
})();
