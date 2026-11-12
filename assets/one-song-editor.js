(() => {
  'use strict';

  const SUPABASE_URL = 'https://aqfmhqultzpakfqwzulj.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_PfwvwgO6402LfeqLPbUBgg_2bCwaX4R';
  const TABLE = 'one_song_projects';
  const PALETTE = {
    male: { text: '#216f9d', background: '#d9efff' },
    female: { text: '#b33963', background: '#ffe0eb' },
    neutral: { text: '#343c50', background: '#edf0f5' },
  };
  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  const ui = Object.fromEntries([
    'accessDenied','accessTitle','accessMessage','editorApp','saveStatus','projectSelect','roundInput','titleInput','lyricsSourceNote',
    'newProjectButton','printButton','saveButton','addParticipantButton','participantList','sihyeonGenderNote',
    'selectionStatus','roleSelect','performerPicker','assignButton','clearAssignmentButton','undoButton','redoButton',
    'foregroundColor','backgroundColor','applyForegroundButton','applyBackgroundButton','boldButton','clearStyleButton',
    'addLineButton','lyricsList','toast'
  ].map(id => [id, document.getElementById(id)]));

  let projects = [];
  let currentProject = null;
  let isDirty = false;
  let inlineEditBefore = null;
  let activeLineId = null;
  let selectedRange = null;
  let selectedPerformerIds = [];
  let undoStack = [];
  let redoStack = [];
  let toastTimer = 0;

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  }
  function safeColor(value, fallback = PALETTE.neutral.text) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback;
  }
  function makeId(prefix = 'id') {
    return `${prefix}-${window.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  }
  function lineNumber(line) {
    const index = currentProject?.data.lines.findIndex(item => item.id === line.id) ?? -1;
    return String(index + 1).padStart(2, '0');
  }
  function newLine() {
    return { id: makeId('line'), sectionTitle: '', lyrics: '', chorus: false, assignments: [], styles: [] };
  }
  function normalizeLine(line) {
    return {
      id: String(line?.id || makeId('line')),
      sectionTitle: String(line?.sectionTitle || ''),
      lyrics: String(line?.lyrics || ''),
      chorus: line?.chorus === true,
      assignments: Array.isArray(line?.assignments) ? line.assignments.map(item => ({
        ...item,
        id: String(item.id || makeId('part')),
        role: ['original','together','additional'].includes(item.role) ? item.role : 'additional',
        participantIds: Array.isArray(item.participantIds) ? item.participantIds.map(String) : [],
      })) : [],
      styles: Array.isArray(line?.styles) ? line.styles.map(item => ({ ...item, id: String(item.id || makeId('style')) })) : [],
    };
  }
  function normalizeProject(row) {
    const data = row?.data && typeof row.data === 'object' ? row.data : {};
    return {
      id: row?.id || null,
      round_number: Number(row?.round_number) || 1,
      song_title: String(row?.song_title || ''),
      data: {
        version: 1,
        participants: Array.isArray(data.participants) ? data.participants.slice(0,4).map(person => ({
          id: String(person.id || makeId('singer')),
          name: String(person.name || ''),
          gender: ['male','female'].includes(person.gender) ? person.gender : '',
          textColor: safeColor(person.textColor, PALETTE.neutral.text),
          additionalColor: safeColor(person.additionalColor, PALETTE.neutral.background),
        })) : [],
        lines: Array.isArray(data.lines) ? data.lines.map(normalizeLine) : [newLine()],
      },
    };
  }
  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => ui.toast.classList.remove('show'), 2600);
  }
  function setSaveStatus(text, tone = '') {
    ui.saveStatus.textContent = text;
    ui.saveStatus.className = `os-save-status${tone ? ` ${tone}` : ''}`;
  }
  function markDirty() {
    isDirty = true;
    setSaveStatus('저장하지 않은 변경', 'dirty');
  }
  function accessMessage(title, message) {
    ui.editorApp.hidden = true;
    ui.accessDenied.hidden = false;
    ui.accessTitle.textContent = title;
    ui.accessMessage.textContent = message;
    setSaveStatus('접근 확인 필요', 'error');
  }
  function getParticipant(id) {
    return currentProject?.data.participants.find(person => person.id === id) || null;
  }
  function gendersAreSame(people) {
    const genders = [...new Set(people.map(person => person.gender).filter(Boolean))];
    return people.length > 0 && people.every(person => person.gender) && genders.length === 1;
  }
  function assignmentRange(item, text) {
    if (item.scope === 'line') return [0, text.length];
    if (item.anchorText) {
      const start = text.indexOf(String(item.anchorText));
      return start < 0 ? null : [start, start + String(item.anchorText).length];
    }
    const start = Math.max(0, Number(item.start) || 0);
    const end = Math.max(start, Math.min(text.length, Number(item.end) || 0));
    return end > start ? [start, end] : null;
  }
  function styleRange(item, text) {
    if (item.scope === 'line') return [0, text.length];
    const start = Math.max(0, Number(item.start) || 0);
    const end = Math.max(start, Math.min(text.length, Number(item.end) || 0));
    return end > start ? [start, end] : null;
  }
  function linePeople(line, role) {
    const text = String(line.lyrics || '');
    const ids = [];
    line.assignments.forEach(item => {
      if (item.role !== role) return;
      const range = assignmentRange(item, text);
      const pendingAnchor = Boolean(item.anchorText && !text.includes(item.anchorText));
      if (range || item.scope === 'line' || pendingAnchor) item.participantIds.forEach(id => { if (!ids.includes(id)) ids.push(id); });
    });
    return ids.map(getParticipant).filter(Boolean);
  }
  function matchingStyles(line, start, end) {
    const text = String(line.lyrics || '');
    return line.styles.filter(item => {
      const range = styleRange(item, text);
      return range && range[0] <= start && range[1] >= end;
    });
  }
  function latestStyleValue(styles, key) {
    for (let index = styles.length - 1; index >= 0; index -= 1) {
      if (Object.prototype.hasOwnProperty.call(styles[index], key)) return styles[index][key];
    }
    return undefined;
  }
  function formatText(line) {
    const text = String(line.lyrics || '');
    if (!text.length) return '';
    const ranges = [];
    line.assignments.forEach(item => {
      const range = assignmentRange(item, text);
      if (range) ranges.push(range);
    });
    line.styles.forEach(item => {
      const range = styleRange(item, text);
      if (range) ranges.push(range);
    });
    const boundaries = [...new Set([0, text.length, ...ranges.flat()])].sort((a,b) => a-b);
    const chunks = [];
    for (let index = 0; index < boundaries.length - 1; index += 1) {
      const start = boundaries[index], end = boundaries[index + 1];
      if (end <= start) continue;
      const active = line.assignments.filter(item => {
        const range = assignmentRange(item, text);
        return range && range[0] <= start && range[1] >= end;
      });
      const leads = [];
      const additions = [];
      active.forEach(item => {
        const list = item.role === 'additional' ? additions : leads;
        item.participantIds.forEach(id => { const person=getParticipant(id); if (person && !list.some(old=>old.id===id)) list.push(person); });
      });
      let color = gendersAreSame(leads) ? safeColor(leads[0].textColor) : '#202638';
      const adlibColors = additions.map(person => safeColor(person.additionalColor, PALETTE.neutral.background));
      let background = '';
      if (adlibColors.length === 1) background = adlibColors[0];
      else if (adlibColors.length > 1) {
        const stop = 100 / adlibColors.length;
        background = `linear-gradient(90deg,${adlibColors.map((value,i)=>`${value} ${i*stop}% ${(i+1)*stop}%`).join(',')})`;
      }
      const styles = matchingStyles(line, start, end);
      const colorOverride = latestStyleValue(styles, 'foregroundColor');
      const backgroundOverride = latestStyleValue(styles, 'backgroundColor');
      const boldOverride = latestStyleValue(styles, 'bold');
      if (colorOverride) color = safeColor(colorOverride, color);
      if (backgroundOverride) background = safeColor(backgroundOverride, '#ffffff');
      const canAutoBold = leads.length > 1 && gendersAreSame(leads) && active.some(item => item.role === 'together');
      const bold = boldOverride === undefined ? canAutoBold : boldOverride === true;
      const css = [];
      if (color) css.push(`color:${color}`);
      if (background) css.push(`background:${background};print-color-adjust:exact;-webkit-print-color-adjust:exact`);
      if (bold) css.push('font-weight:800');
      const value = esc(text.slice(start, end));
      chunks.push(css.length ? `<span style="${css.join(';')}">${value}</span>` : value);
    }
    return chunks.join('');
  }
  function renderNames(people, extra = false) {
    return people.map(person => {
      const color = extra ? '#202638' : safeColor(person.textColor);
      const background = safeColor(person.additionalColor, PALETTE.neutral.background);
      return `<span class="os-name ${extra?'os-name-extra':'os-name-lead'}" style="color:${color};${extra?`background:${background};print-color-adjust:exact;-webkit-print-color-adjust:exact`:''}">${esc(person.name)}</span>`;
    }).join('');
  }
  function assignmentNotes(line) {
    const text = String(line.lyrics || '');
    const notes = [];
    line.assignments.forEach(item => {
      if (item.note && !notes.includes(item.note)) notes.push(item.note);
      if (item.anchorText) {
        const message = text.includes(item.anchorText) ? `구절 지정 · ${item.anchorText}` : `구절 메모 · ${item.anchorText} (가사 확인 필요)`;
        if (!notes.includes(message)) notes.push(message);
      }
    });
    return notes.join(' · ');
  }
  function renderLine(line, index) {
    const lead = linePeople(line, 'original').concat(linePeople(line, 'together'));
    const uniqueLead = lead.filter((person, position) => lead.findIndex(other => other.id === person.id) === position);
    const additional = linePeople(line, 'additional');
    const notes = assignmentNotes(line);
    const number = String(index + 1).padStart(2,'0');
    const section = esc(line.sectionTitle);
    return `<article class="os-line-card${line.chorus?' is-chorus':''}" data-line-card="${esc(line.id)}">
      <div class="os-line-main">
        <label class="os-line-number-wrap"><span class="os-number-label">번호</span><input class="os-line-number" data-number-for="${esc(line.id)}" type="text" inputmode="numeric" pattern="[0-9]{1,3}" value="${number}" aria-label="${number}번 줄 번호"></label>
        <div class="os-line-body">
          <div class="os-lead-names" aria-label="원음 담당">${renderNames(uniqueLead)}</div>
          <div class="os-lyric-editor" data-lyric-id="${esc(line.id)}" contenteditable="true" role="textbox" aria-multiline="false" aria-label="${number}번 가사" data-placeholder="가사를 입력하거나 편집하세요">${formatText(line)}</div>
          <div class="os-line-notes">${esc(notes)}</div>
        </div>
        <div class="os-additional-names" aria-label="추가 보컬">${renderNames(additional,true)}</div>
      </div>
      <div class="os-line-meta">
        <label class="os-section-field">구간명<input data-section-for="${esc(line.id)}" type="text" maxlength="80" value="${section}" placeholder="예: 후렴, 아웃트로"></label>
        <label class="os-chorus-toggle"><input data-chorus-for="${esc(line.id)}" type="checkbox"${line.chorus?' checked':''}> 후렴 노랑</label>
        <div class="os-line-actions"><button class="os-line-action" type="button" data-action="up" data-line-id="${esc(line.id)}" title="위로 이동" aria-label="${number}번 줄 위로 이동">↑</button><button class="os-line-action" type="button" data-action="down" data-line-id="${esc(line.id)}" title="아래로 이동" aria-label="${number}번 줄 아래로 이동">↓</button><button class="os-line-action is-danger" type="button" data-action="remove-line" data-line-id="${esc(line.id)}" title="줄 삭제" aria-label="${number}번 줄 삭제">삭제</button></div>
      </div>
    </article>`;
  }
  function renderLines() {
    if (!currentProject?.data.lines.length) {
      ui.lyricsList.innerHTML = '<div class="os-empty-state">아직 가사 줄이 없습니다. ‘＋ 가사 줄’을 눌러 추가하세요.</div>';
      return;
    }
    let lastSection = '';
    const pieces = [];
    currentProject.data.lines.forEach((line,index) => {
      const section = String(line.sectionTitle || '').trim();
      if (section && section !== lastSection) pieces.push(`<h3 class="os-section-heading">${esc(section)}</h3>`);
      lastSection = section;
      pieces.push(renderLine(line,index));
    });
    ui.lyricsList.innerHTML = pieces.join('');
  }
  function renderParticipants() {
    if (!currentProject?.data.participants.length) {
      ui.participantList.innerHTML = '<div class="os-empty-state">참여자를 아직 등록하지 않았습니다.</div>';
      ui.sihyeonGenderNote.hidden = true;
      renderPerformerPicker();
      return;
    }
    ui.participantList.innerHTML = currentProject.data.participants.map(person => `<div class="os-participant-row" data-person-row="${esc(person.id)}">
      <label>이름<input data-person-name="${esc(person.id)}" type="text" maxlength="30" value="${esc(person.name)}" placeholder="참여자 이름"></label>
      <label>성별 색상 분류<select data-person-gender="${esc(person.id)}"><option value=""${person.gender?'':' selected'}>확인 필요</option><option value="male"${person.gender==='male'?' selected':''}>남성 · 하늘색</option><option value="female"${person.gender==='female'?' selected':''}>여성 · 분홍색</option></select></label>
      <label>원음 글자색<input data-person-text="${esc(person.id)}" type="color" value="${safeColor(person.textColor)}" aria-label="${esc(person.name||'참여자')} 원음 글자색"></label>
      <label>추가 배경색<input data-person-additional="${esc(person.id)}" type="color" value="${safeColor(person.additionalColor,PALETTE.neutral.background)}" aria-label="${esc(person.name||'참여자')} 추가 보컬 배경색"></label>
      <button class="os-delete-participant" data-action="remove-person" data-person-id="${esc(person.id)}" type="button">삭제</button>
    </div>`).join('');
    const sihyeon = currentProject.data.participants.find(person => person.name === '시현');
    ui.sihyeonGenderNote.hidden = !sihyeon || Boolean(sihyeon.gender);
    renderPerformerPicker();
  }
  function renderPerformerPicker() {
    const people = currentProject?.data.participants || [];
    const available = people.filter(person => person.name.trim());
    selectedPerformerIds = selectedPerformerIds.filter(id => available.some(person => person.id === id));
    ui.performerPicker.innerHTML = available.length ? available.map(person => `<button class="os-performer-chip" type="button" data-pick-person="${esc(person.id)}" aria-pressed="${selectedPerformerIds.includes(person.id)}">${esc(person.name)}</button>`).join('') : '<span class="os-picker-empty">참여자를 먼저 등록해 주세요.</span>';
  }
  function renderAll() {
    if (!currentProject) return;
    ui.editorApp.hidden = false;
    ui.accessDenied.hidden = true;
    ui.roundInput.value = currentProject.round_number;
    ui.titleInput.value = currentProject.song_title;
    updatePrintTitle();
    ui.lyricsSourceNote.hidden = currentProject.data.lines.some(line => line.lyrics.trim().length > 0);
    renderParticipants();
    renderLines();
    updateProjectSelect();
    updateSelectionStatus();
    updateHistoryButtons();
  }
  function updatePrintTitle() {
    document.getElementById('projectPrintTitle').textContent = `${String(currentProject.round_number).padStart(2,'0')}회 · ${currentProject.song_title || '곡 제목 미입력'}`;
    document.title = `${currentProject.song_title || 'ONE SONG'} 파트 배분 · Voice of Melody`;
  }
  function updateProjectSelect() {
    const currentKey = currentProject?.id || '__new__';
    const options = ['<option value="__new__">새 프로젝트</option>'].concat(projects.map(row => {
      const selected = String(row.id) === String(currentKey) ? ' selected' : '';
      return `<option value="${esc(row.id)}"${selected}>${Number(row.round_number)}회 · ${esc(row.song_title)}</option>`;
    }));
    ui.projectSelect.innerHTML = options.join('');
    ui.projectSelect.value = projects.some(row => String(row.id) === String(currentKey)) ? String(currentKey) : '__new__';
  }
  function updateSelectionStatus() {
    if (selectedRange && currentProject) {
      const line = currentProject.data.lines.find(item => item.id === selectedRange.lineId);
      if (line) {
        const chosen = line.lyrics.slice(selectedRange.start,selectedRange.end).replace(/\s+/g,' ').trim();
        if (chosen) {
          ui.selectionStatus.textContent = `${lineNumber(line)}번 · ${selectedRange.end-selectedRange.start}자 선택 · “${chosen.slice(0,72)}${chosen.length>72?'…':''}”`;
          ui.selectionStatus.classList.add('has-selection');
          return;
        }
      }
    }
    ui.selectionStatus.classList.remove('has-selection');
    const active = currentProject?.data.lines.find(item => item.id === activeLineId);
    ui.selectionStatus.textContent = active ? `${lineNumber(active)}번 줄 전체에 적용할 준비가 됐습니다. 글자를 드래그하면 선택 구간만 적용됩니다.` : '가사 글자를 드래그해 선택하세요. 선택하지 않으면 활성 줄 전체에 적용됩니다.';
  }
  function updateHistoryButtons() {
    ui.undoButton.disabled = undoStack.length === 0;
    ui.redoButton.disabled = redoStack.length === 0;
  }
  function syncProjectFields() {
    if (!currentProject) return;
    const round = Number(ui.roundInput.value);
    const title = ui.titleInput.value;
    if (currentProject.round_number !== round || currentProject.song_title !== title) {
      currentProject.round_number = round;
      currentProject.song_title = title;
      markDirty();
      updateProjectSelect();
      updatePrintTitle();
    }
  }
  function pushUndo(before) {
    if (!before) return;
    undoStack.push(before);
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }
  function beginMutation() {
    commitInlineEdit();
    return clone(currentProject);
  }
  function finishMutation(before, rerender = true) {
    if (JSON.stringify(before) === JSON.stringify(currentProject)) return;
    pushUndo(before);
    markDirty();
    if (rerender) renderAll();
  }
  function commitInlineEdit() {
    if (!inlineEditBefore || !currentProject) return;
    const before = inlineEditBefore;
    inlineEditBefore = null;
    if (JSON.stringify(before) !== JSON.stringify(currentProject)) {
      pushUndo(before);
      markDirty();
    }
  }
  function undo() {
    commitInlineEdit();
    if (!undoStack.length) return;
    redoStack.push(clone(currentProject));
    currentProject = undoStack.pop();
    selectedRange = null;
    renderAll();
    markDirty();
    updateHistoryButtons();
  }
  function redo() {
    commitInlineEdit();
    if (!redoStack.length) return;
    undoStack.push(clone(currentProject));
    currentProject = redoStack.pop();
    selectedRange = null;
    renderAll();
    markDirty();
    updateHistoryButtons();
  }
  function currentLine() {
    return currentProject?.data.lines.find(line => line.id === (selectedRange?.lineId || activeLineId)) || currentProject?.data.lines[0] || null;
  }
  function targetForLine(line) {
    if (selectedRange?.lineId === line.id && selectedRange.end > selectedRange.start) {
      return { scope:'range', start:selectedRange.start, end:selectedRange.end };
    }
    return { scope:'line' };
  }
  function overlap(range, start, end) {
    return Boolean(range && range[0] < end && range[1] > start);
  }
  function splitOutside(item, range, start, end, textLength) {
    const [from,to] = range;
    if (from < start) return [{ ...item, id:makeId(item.role?'part':'style'), scope:'range', start:from, end:start, anchorText:undefined }];
    if (to > end) return [{ ...item, id:makeId(item.role?'part':'style'), scope:'range', start:end, end:to, anchorText:undefined }];
    return [];
  }
  function replaceRoleInRange(line, role, start, end, wholeLine) {
    const text = String(line.lyrics || '');
    const kept = [];
    line.assignments.forEach(item => {
      if (item.role !== role) { kept.push(item); return; }
      if (wholeLine) return;
      const range = assignmentRange(item,text);
      if (!range) { kept.push(item); return; }
      if (!overlap(range,start,end)) { kept.push(item); return; }
      if (item.scope === 'line' && text.length === 0) return;
      kept.push(...splitOutside(item,range,start,end,text.length));
    });
    line.assignments = kept;
  }
  function subtractAllAssignments(line, start, end, wholeLine) {
    if (wholeLine) { line.assignments = []; return; }
    const text = String(line.lyrics || '');
    const kept = [];
    line.assignments.forEach(item => {
      const range = assignmentRange(item,text);
      if (!range) { kept.push(item); return; }
      if (!overlap(range,start,end)) { kept.push(item); return; }
      if (item.scope === 'line' && text.length === 0) return;
      kept.push(...splitOutside(item,range,start,end,text.length));
    });
    line.assignments = kept;
  }
  function subtractStyles(line, start, end, wholeLine) {
    if (wholeLine) { line.styles = []; return; }
    const text = String(line.lyrics || '');
    const kept = [];
    line.styles.forEach(item => {
      const range = styleRange(item,text);
      if (!range) { kept.push(item); return; }
      if (!overlap(range,start,end)) { kept.push(item); return; }
      if (item.scope === 'line' && text.length === 0) return;
      kept.push(...splitOutside(item,range,start,end,text.length));
    });
    line.styles = kept;
  }
  function applyAssignment() {
    if (!currentProject) return;
    const line = currentLine();
    if (!line) { showToast('먼저 가사 줄을 추가하세요.'); return; }
    const selectedPeople = selectedPerformerIds.filter(id => getParticipant(id));
    if (!selectedPeople.length) { showToast('파트를 맡을 참여자를 선택하세요.'); return; }
    const target = targetForLine(line);
    const role = ui.roleSelect.value;
    const before = beginMutation();
    if (target.scope === 'line') {
      replaceRoleInRange(line,role,0,line.lyrics.length,true);
      line.assignments.push({ id:makeId('part'), role, participantIds:selectedPeople, scope:'line' });
    } else {
      replaceRoleInRange(line,role,target.start,target.end,false);
      line.assignments.push({ id:makeId('part'), role, participantIds:selectedPeople, scope:'range', start:target.start, end:target.end });
    }
    activeLineId = line.id;
    selectedRange = null;
    finishMutation(before);
    showToast('파트를 지정했습니다.');
  }
  function clearAssignment() {
    const line = currentLine();
    if (!line) return;
    const target = targetForLine(line);
    const before = beginMutation();
    subtractAllAssignments(line,target.start || 0,target.end || line.lyrics.length,target.scope === 'line');
    activeLineId = line.id;
    selectedRange = null;
    finishMutation(before);
    showToast('선택 구간의 파트 지정을 취소했습니다. 색 지정은 유지됩니다.');
  }
  function selectedFormatRange() {
    const line = currentLine();
    if (!line) return null;
    return { line, target:targetForLine(line) };
  }
  function applyStyle(properties) {
    const selected = selectedFormatRange();
    if (!selected) { showToast('먼저 가사 줄을 추가하세요.'); return; }
    const { line,target } = selected;
    const before = beginMutation();
    if (target.scope === 'line') line.styles.push({ id:makeId('style'), scope:'line', ...properties });
    else line.styles.push({ id:makeId('style'), scope:'range', start:target.start, end:target.end, ...properties });
    activeLineId = line.id;
    selectedRange = null;
    finishMutation(before);
  }
  function clearStyle() {
    const selected = selectedFormatRange();
    if (!selected) return;
    const { line,target } = selected;
    const before = beginMutation();
    subtractStyles(line,target.start || 0,target.end || line.lyrics.length,target.scope === 'line');
    selectedRange = null;
    finishMutation(before);
    showToast('직접 지정한 색을 지웠습니다. 파트 정보는 유지됩니다.');
  }
  function getTextOffset(editor, node, offset) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.setEnd(node,offset);
    return range.toString().length;
  }
  function selectionChange() {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;
    const anchorElement = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const focusElement = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentElement;
    const anchorEditor = anchorElement?.closest?.('.os-lyric-editor');
    const focusEditor = focusElement?.closest?.('.os-lyric-editor');
    if (!anchorEditor || anchorEditor !== focusEditor) return;
    const lineId = anchorEditor.dataset.lyricId;
    activeLineId = lineId;
    if (selection.isCollapsed) {
      selectedRange = null;
      updateSelectionStatus();
      return;
    }
    const range = selection.getRangeAt(0);
    let start = getTextOffset(anchorEditor,range.startContainer,range.startOffset);
    let end = getTextOffset(anchorEditor,range.endContainer,range.endOffset);
    if (end < start) [start,end] = [end,start];
    if (end <= start) { selectedRange = null; updateSelectionStatus(); return; }
    selectedRange = { lineId,start,end };
    updateSelectionStatus();
  }
  function commonEditMap(oldText,newText) {
    let prefix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < oldText.length-prefix && suffix < newText.length-prefix && oldText[oldText.length-1-suffix] === newText[newText.length-1-suffix]) suffix += 1;
    const oldEnd = oldText.length - suffix;
    const newEnd = newText.length - suffix;
    const delta = newText.length - oldText.length;
    const mapStart = value => {
      if (value < prefix) return value;
      if (value > oldEnd) return value + delta;
      if (value === prefix && value === oldEnd) return newEnd;
      if (value === oldEnd) return newEnd;
      if (value === prefix) return prefix;
      return prefix;
    };
    const mapEnd = value => {
      if (value < prefix) return value;
      if (value > oldEnd) return value + delta;
      if (value === prefix && value === oldEnd) return prefix;
      if (value === prefix) return prefix;
      return newEnd;
    };
    return { mapStart,mapEnd };
  }
  function remapEntries(entries, oldText, newText) {
    const {mapStart,mapEnd} = commonEditMap(oldText,newText);
    return entries.flatMap(item => {
      if (item.scope === 'line' || item.anchorText) return [item];
      const from = mapStart(Math.max(0,Number(item.start)||0));
      const to = mapEnd(Math.max(0,Number(item.end)||0));
      if (to <= from || from >= newText.length) return [];
      return [{ ...item,start:Math.min(from,newText.length),end:Math.min(to,newText.length) }];
    });
  }
  function onLyricInput(event) {
    const editor = event.target.closest('.os-lyric-editor');
    if (!editor || !currentProject) return;
    const line = currentProject.data.lines.find(item => item.id === editor.dataset.lyricId);
    if (!line) return;
    if (!inlineEditBefore) inlineEditBefore = clone(currentProject);
    const oldText = String(line.lyrics || '');
    const nextText = String(editor.textContent || '').replace(/[\r\n]+/g,' ');
    if (nextText !== editor.textContent) editor.textContent = nextText;
    if (oldText !== nextText) {
      line.assignments = remapEntries(line.assignments,oldText,nextText);
      line.styles = remapEntries(line.styles,oldText,nextText);
      line.lyrics = nextText;
      markDirty();
      updateSelectionStatus();
    }
  }
  function moveLine(lineId,destination) {
    const requestedPosition = Number(destination);
    if (!Number.isInteger(requestedPosition) || requestedPosition < 1 || requestedPosition > currentProject.data.lines.length) {
      showToast(`줄 번호는 01부터 ${String(currentProject.data.lines.length).padStart(2,'0')} 사이로 입력해 주세요.`);
      renderLines();
      return;
    }
    const currentIndex = currentProject.data.lines.findIndex(line => line.id === lineId);
    const targetIndex = requestedPosition - 1;
    if (currentIndex < 0 || currentIndex === targetIndex) return;
    const before = beginMutation();
    const [line] = currentProject.data.lines.splice(currentIndex,1);
    currentProject.data.lines.splice(targetIndex,0,line);
    activeLineId = line.id;
    selectedRange = null;
    finishMutation(before);
  }
  function addParticipant() {
    if (currentProject.data.participants.length >= 4) { showToast('참여자는 최대 4명까지 등록할 수 있습니다.'); return; }
    const before = beginMutation();
    currentProject.data.participants.push({ id:makeId('singer'),name:'',gender:'',textColor:PALETTE.neutral.text,additionalColor:PALETTE.neutral.background });
    finishMutation(before);
    ui.participantList.querySelector(`[data-person-name="${CSS.escape(currentProject.data.participants.at(-1).id)}"]`)?.focus();
  }
  function removeParticipant(id) {
    const person = getParticipant(id);
    if (!person) return;
    if (!window.confirm(`${person.name || '이 참여자'}를 삭제할까요? 이 사람에게 지정된 파트도 함께 삭제됩니다.`)) return;
    const before = beginMutation();
    currentProject.data.participants = currentProject.data.participants.filter(item => item.id !== id);
    currentProject.data.lines.forEach(line => {
      line.assignments = line.assignments.flatMap(item => {
        if (!item.participantIds.includes(id)) return [item];
        const participantIds = item.participantIds.filter(value => value !== id);
        return participantIds.length ? [{ ...item,participantIds }] : [];
      });
    });
    selectedPerformerIds = selectedPerformerIds.filter(value => value !== id);
    finishMutation(before);
    showToast('참여자와 연결된 파트를 삭제했습니다.');
  }
  function updateParticipant(event) {
    const input = event.target;
    const keys = ['personName','personGender','personText','personAdditional'];
    const key = keys.find(name => input.hasAttribute(`data-${name.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`)}`));
    if (!key || !currentProject) return;
    const attr = `data-${key.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`)}`;
    const person = getParticipant(input.getAttribute(attr));
    if (!person) return;
    if (key === 'personName') {
      if (person.name !== input.value) {
        if (!inlineEditBefore) inlineEditBefore = clone(currentProject);
        person.name = input.value;
        renderPerformerPicker();
        renderLines();
        markDirty();
      }
      if (event.type === 'change') commitInlineEdit();
      return;
    }
    const before = beginMutation();
    if (key === 'personGender') {
      person.gender = ['male','female'].includes(input.value) ? input.value : '';
      const base = PALETTE[person.gender || 'neutral'];
      person.textColor = base.text;
      person.additionalColor = base.background;
    } else if (key === 'personText') person.textColor = safeColor(input.value);
    else if (key === 'personAdditional') person.additionalColor = safeColor(input.value,PALETTE.neutral.background);
    finishMutation(before);
  }
  function createProject() {
    if (isDirty && !window.confirm('저장되지 않은 변경을 버리고 새 프로젝트를 열까요?')) return;
    currentProject = normalizeProject({ round_number:1,song_title:'',data:{participants:[],lines:[newLine()]} });
    activeLineId = currentProject.data.lines[0].id;
    selectedRange = null;
    selectedPerformerIds = [];
    undoStack = [];
    redoStack = [];
    isDirty = true;
    renderAll();
    markDirty();
    ui.titleInput.focus();
  }
  async function openProject(id) {
    const row = projects.find(item => String(item.id) === String(id));
    if (!row) return;
    if (isDirty && !window.confirm('저장되지 않은 변경을 버리고 선택한 프로젝트를 열까요?')) {
      updateProjectSelect();
      return;
    }
    currentProject = normalizeProject(row);
    activeLineId = currentProject.data.lines[0]?.id || null;
    selectedRange = null;
    selectedPerformerIds = [];
    undoStack = [];
    redoStack = [];
    isDirty = false;
    renderAll();
    setSaveStatus('저장된 프로젝트');
  }
  async function fetchProjects() {
    const {data,error} = await db.from(TABLE).select('id,round_number,song_title,data,updated_at').order('round_number',{ascending:true}).order('song_title',{ascending:true});
    if (error) throw error;
    projects = data || [];
    updateProjectSelect();
    if (projects.length) await openProject(projects[0].id);
    else createProject();
  }
  async function saveProject() {
    if (!currentProject) return;
    commitInlineEdit();
    syncProjectFields();
    const round = Number(currentProject.round_number);
    const title = String(currentProject.song_title || '').trim();
    if (!Number.isInteger(round) || round < 1 || round > 999) { showToast('회차를 1부터 999 사이 숫자로 입력하세요.'); ui.roundInput.focus(); return; }
    if (!title) { showToast('곡 제목을 입력하세요.'); ui.titleInput.focus(); return; }
    const emptyNames = currentProject.data.participants.filter(person => !person.name.trim());
    if (emptyNames.length) { showToast('이름이 비어 있는 참여자 입력을 채우거나 삭제하세요.'); return; }
    const conflict = projects.find(row => Number(row.round_number) === round && row.song_title.trim().toLocaleLowerCase() === title.toLocaleLowerCase() && String(row.id) !== String(currentProject.id));
    if (conflict) { showToast('같은 회차와 곡 제목의 프로젝트가 이미 있습니다. 목록에서 다시 열어 주세요.'); return; }
    ui.saveButton.disabled = true;
    setSaveStatus('저장 중…');
    const payload = {
      round_number:round,
      song_title:title,
      data:currentProject.data,
      updated_at:new Date().toISOString(),
    };
    let query;
    if (currentProject.id) query = db.from(TABLE).update(payload).eq('id',currentProject.id).select('id,round_number,song_title,data,updated_at').single();
    else query = db.from(TABLE).insert(payload).select('id,round_number,song_title,data,updated_at').single();
    let result;
    try {
      result = await query;
    } catch (error) {
      ui.saveButton.disabled = false;
      setSaveStatus('저장 실패','error');
      showToast(`저장에 실패했습니다: ${error?.message || '네트워크 오류'}`);
      return;
    }
    ui.saveButton.disabled = false;
    const {data,error} = result;
    if (error) {
      setSaveStatus('저장 실패','error');
      showToast(error.message.includes(TABLE) ? '저장 테이블이 아직 준비되지 않았습니다. 운영 자료 담당자에게 마이그레이션 적용을 요청하세요.' : `저장에 실패했습니다: ${error.message}`);
      return;
    }
    currentProject = normalizeProject(data);
    const existingIndex = projects.findIndex(row => String(row.id) === String(data.id));
    if (existingIndex < 0) projects.push(data); else projects[existingIndex] = data;
    projects.sort((a,b)=>Number(a.round_number)-Number(b.round_number)||a.song_title.localeCompare(b.song_title,'ko'));
    isDirty = false;
    undoStack = [];
    redoStack = [];
    renderAll();
    const savedAt = new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit'}).format(new Date());
    setSaveStatus(`저장됨 · ${savedAt}`);
    showToast('프로젝트를 저장했습니다. 다시 열어도 편집 내용이 유지됩니다.');
  }
  function editSection(event) {
    const input = event.target.closest('[data-section-for]');
    if (!input || !currentProject) return;
    const line = currentProject.data.lines.find(item => item.id === input.dataset.sectionFor);
    if (!line || line.sectionTitle === input.value) return;
    const before = clone(currentProject);
    line.sectionTitle = input.value;
    pushUndo(before);
    markDirty();
    renderLines();
  }
  function changeChorus(event) {
    const input = event.target.closest('[data-chorus-for]');
    if (!input || !currentProject) return;
    const line = currentProject.data.lines.find(item => item.id === input.dataset.chorusFor);
    if (!line || line.chorus === input.checked) return;
    const before = clone(currentProject);
    line.chorus = input.checked;
    pushUndo(before);
    markDirty();
    renderLines();
  }
  function addLine() {
    const before = beginMutation();
    const line = newLine();
    currentProject.data.lines.push(line);
    activeLineId = line.id;
    selectedRange = null;
    finishMutation(before);
    ui.lyricsList.querySelector(`[data-lyric-id="${CSS.escape(line.id)}"]`)?.focus();
  }
  function lineAction(event) {
    const button = event.target.closest('[data-action]');
    if (!button || !currentProject) return;
    const action = button.dataset.action;
    const lineId = button.dataset.lineId;
    if (action === 'remove-person') { removeParticipant(button.dataset.personId); return; }
    const index = currentProject.data.lines.findIndex(line => line.id === lineId);
    if (index < 0) return;
    if (action === 'up') moveLine(lineId,index);
    else if (action === 'down') moveLine(lineId,index+2);
    else if (action === 'remove-line') {
      const line = currentProject.data.lines[index];
      if (!window.confirm(`${lineNumber(line)}번 줄과 이 줄의 파트·색 지정을 삭제할까요?`)) return;
      const before = beginMutation();
      currentProject.data.lines.splice(index,1);
      activeLineId = currentProject.data.lines[Math.max(0,index-1)]?.id || currentProject.data.lines[0]?.id || null;
      selectedRange = null;
      finishMutation(before);
    }
  }
  function remapParticipantValue(event) {
    const input = event.target;
    if (input.id === 'roundInput' || input.id === 'titleInput') syncProjectFields();
  }
  function preventLineBreak(event) {
    if (event.key === 'Enter') event.preventDefault();
  }
  function plainTextPaste(event) {
    const editor = event.target.closest('.os-lyric-editor');
    if (!editor) return;
    event.preventDefault();
    const value = (event.clipboardData || window.clipboardData).getData('text').replace(/[\r\n]+/g,' ');
    document.execCommand('insertText',false,value);
  }
  async function checkAccess() {
    const {data,error} = await db.auth.getSession();
    const session = data?.session;
    if (error || !session) {
      accessMessage('VOM 회원 전용 기능입니다.','MY VOM에서 로그인한 활동 회원만 파트 마법사를 사용할 수 있습니다.');
      return;
    }
    const access = await window.vomGetMemberAccess?.();
    if (!access?.approved) {
      accessMessage('회원 확인이 필요합니다.','가입 승인된 활동 회원만 사용할 수 있습니다. 회원 상태를 확인하려면 MY VOM을 열어 주세요.');
      return;
    }
    ui.accessDenied.hidden = true;
    setSaveStatus('프로젝트 불러오는 중…');
    try {
      await fetchProjects();
      ui.editorApp.hidden = false;
    } catch (error) {
      accessMessage('프로젝트를 불러오지 못했습니다.',error?.message || '저장 테이블과 접근 권한을 확인해 주세요.');
      ui.accessTitle.textContent = '저장 공간을 확인해 주세요.';
      ui.accessMessage.textContent = '원쏭 프로젝트 저장용 테이블을 아직 사용할 수 없습니다. 배포 전에 Supabase 마이그레이션 적용이 필요합니다.';
    }
  }

  ui.projectSelect.addEventListener('change',event=>{
    if (event.target.value === '__new__') createProject();
    else openProject(event.target.value);
  });
  ui.roundInput.addEventListener('change',remapParticipantValue);
  ui.titleInput.addEventListener('change',remapParticipantValue);
  ui.newProjectButton.addEventListener('click',createProject);
  ui.printButton.addEventListener('click',()=>window.print());
  ui.saveButton.addEventListener('click',saveProject);
  ui.addParticipantButton.addEventListener('click',addParticipant);
  ui.participantList.addEventListener('input',event=>{ if(event.target.matches('[data-person-name]')) updateParticipant(event); });
  ui.participantList.addEventListener('change',updateParticipant);
  ui.participantList.addEventListener('click',lineAction);
  ui.performerPicker.addEventListener('click',event=>{
    const button = event.target.closest('[data-pick-person]');
    if (!button) return;
    const id = button.dataset.pickPerson;
    selectedPerformerIds = selectedPerformerIds.includes(id) ? selectedPerformerIds.filter(value=>value!==id) : [...selectedPerformerIds,id];
    renderPerformerPicker();
  });
  ui.assignButton.addEventListener('click',applyAssignment);
  ui.clearAssignmentButton.addEventListener('click',clearAssignment);
  ui.undoButton.addEventListener('click',undo);
  ui.redoButton.addEventListener('click',redo);
  ui.applyForegroundButton.addEventListener('click',()=>applyStyle({foregroundColor:safeColor(ui.foregroundColor.value)}));
  ui.applyBackgroundButton.addEventListener('click',()=>applyStyle({backgroundColor:safeColor(ui.backgroundColor.value,'#fff1a8')}));
  ui.boldButton.addEventListener('click',()=>{
    const selected = selectedFormatRange();
    if (!selected) return;
    const {line,target} = selected;
    const start = target.start || 0, end = target.end || line.lyrics.length;
    const styles = target.scope === 'line' ? line.styles.filter(item=>item.scope==='line') : matchingStyles(line,start,end);
    const currentlyBold = latestStyleValue(styles,'bold') === true;
    applyStyle({bold:!currentlyBold});
  });
  ui.clearStyleButton.addEventListener('click',clearStyle);
  ui.addLineButton.addEventListener('click',addLine);
  ui.lyricsList.addEventListener('input',event=>{
    if (event.target.matches('[data-number-for]')) return;
    onLyricInput(event);
  });
  ui.lyricsList.addEventListener('focusin',event=>{
    const editor=event.target.closest('.os-lyric-editor');
    if (editor) { activeLineId=editor.dataset.lyricId; updateSelectionStatus(); }
  });
  ui.lyricsList.addEventListener('focusout',event=>{
    if (event.target.closest('.os-lyric-editor')) commitInlineEdit();
  });
  ui.lyricsList.addEventListener('keydown',event=>{ if(event.target.closest('.os-lyric-editor'))preventLineBreak(event); });
  ui.lyricsList.addEventListener('paste',plainTextPaste);
  ui.lyricsList.addEventListener('change',event=>{
    const numberInput=event.target.closest('[data-number-for]');
    if(numberInput)moveLine(numberInput.dataset.numberFor,numberInput.value);
    else if(event.target.matches('[data-section-for]'))editSection(event);
    else if(event.target.matches('[data-chorus-for]'))changeChorus(event);
  });
  ui.lyricsList.addEventListener('click',lineAction);
  document.addEventListener('selectionchange',selectionChange);
  document.addEventListener('pointerdown',event=>{
    if (event.target.closest('.os-tool-panel,.os-lyric-editor')) return;
    selectedRange = null;
    const lineCard = event.target.closest('.os-line-card');
    if (lineCard) activeLineId = lineCard.querySelector('.os-lyric-editor')?.dataset.lyricId || activeLineId;
    updateSelectionStatus();
  });
  document.addEventListener('pointerdown',event=>{
    if (event.target.closest('.os-tool-panel button')) event.preventDefault();
  });
  document.addEventListener('keydown',event=>{
    if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='z') {
      event.preventDefault();
      if (event.shiftKey) redo(); else undo();
    }
    if ((event.ctrlKey||event.metaKey) && event.key.toLowerCase()==='y') { event.preventDefault(); redo(); }
  });
  db.auth.onAuthStateChange((event)=>{ if(event==='SIGNED_IN'||event==='SIGNED_OUT') window.setTimeout(checkAccess,0); });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded',checkAccess,{once:true});
  else checkAccess();
})();
