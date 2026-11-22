/* Admin Settings BGM library. Loaded after the page's Supabase client. */
const bgmCategoryLabels = {OST:'OST',KPOP:'K-POP',POP:'POP',JAZZ:'재즈',ETC:'기타'};
const bgmMime = {mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',webm:'audio/webm',flac:'audio/flac'};
const bgmMaxBytes = 50 * 1024 * 1024;
let bgmTracks = [];
let bgmError = '';
let bgmEditingId = '';
let bgmBusy = false;

function bgmInjectStyle() {
  if (document.getElementById('bgmAdminStyle')) return;
  const style = document.createElement('style');
  style.id = 'bgmAdminStyle';
  style.textContent = `
    .bgm-admin{max-width:920px}.bgm-admin-intro{margin:0 0 18px;color:#a5a8bb;font-size:13px;line-height:1.6}
    .bgm-admin-form{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:19px;border:1px solid #3d3c62;border-radius:18px;background:#1e2039}
    .bgm-admin-form label{display:grid;gap:6px;min-width:0;color:#d8d7ec;font-size:12px;font-weight:700}
    .bgm-admin-form .wide{grid-column:1/-1}
    .bgm-admin-form input,.bgm-admin-form select{width:100%;min-height:42px;padding:9px 11px;border:1px solid #52506f;border-radius:10px;background:#15182c;color:#fff;font:500 14px Pretendard,Arial,sans-serif}
    .bgm-admin-form input[type=file]{padding:8px}.bgm-admin-form small{color:#a5a8bb;font-size:11px;font-weight:500;line-height:1.5}
    .bgm-admin-form .check{display:flex;align-items:center;gap:8px}.bgm-admin-form .check input{width:18px;min-height:18px;height:18px;accent-color:#8a78ed}
    .bgm-admin-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;grid-column:1/-1}
    .bgm-admin-actions button,.bgm-row button{min-height:38px;padding:0 14px;border:1px solid #626080;border-radius:10px;background:#312f50;color:#fff;font:700 12px Pretendard,Arial,sans-serif;cursor:pointer}
    .bgm-admin-actions button.primary{border-color:#7965d8;background:#6f5bcf}.bgm-admin-actions button:disabled{opacity:.55;cursor:wait}
    .bgm-admin-list{display:grid;gap:8px;margin-top:17px}.bgm-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px;border:1px solid #3d3c62;border-radius:13px;background:#1c1e36}
    .bgm-row strong{display:block;color:#f6f4ff;font-size:13px}.bgm-row small{display:block;margin-top:5px;color:#a5a8bb;font-size:11px}
    .bgm-row-actions{display:flex;flex-wrap:wrap;gap:5px}.bgm-row button.delete{border-color:#694454;color:#ffc1c9}
    .bgm-admin-message{padding:12px;border-radius:10px;background:#492a39;color:#ffd6dc;font-size:12px}
    @media(max-width:600px){.bgm-admin-form{grid-template-columns:1fr}.bgm-admin-form .wide{grid-column:auto}.bgm-row{align-items:flex-start;flex-direction:column}.bgm-row-actions{width:100%}}
  `;
  document.head.appendChild(style);
}
async function loadBgmTracks() {
  bgmError = '';
  const {data,error} = await db.from('site_bgm_tracks').select('id,title,artist,category,file_path,sort_order,is_active,created_at').order('sort_order',{ascending:true}).order('created_at',{ascending:true});
  if (error) { bgmError = error.message; bgmTracks = []; return; }
  bgmTracks = data || [];
}
function renderBgmManager() {
  bgmInjectStyle();
  const editing = bgmTracks.find(item => item.id === bgmEditingId);
  const options = Object.entries(bgmCategoryLabels).map(([key,label]) =>
    '<option value="'+key+'" '+((editing?.category||'OST')===key?'selected':'')+'>'+label+'</option>'
  ).join('');
  const rows = bgmTracks.map(item => '<article class="bgm-row"><div><strong>'+esc(item.title)+'</strong><small>'+
    esc(item.artist||'가수 미입력')+' · '+esc(bgmCategoryLabels[item.category]||item.category)+' · '+(item.is_active?'재생 목록에 표시':'숨김')+
    ' · 순서 '+Number(item.sort_order||0)+'</small></div><div class="bgm-row-actions"><button type="button" onclick="editBgmTrack(\''+attr(item.id)+'\')">수정</button><button type="button" class="delete" onclick="deleteBgmTrack(\''+attr(item.id)+'\')">삭제</button></div></article>').join('');
  resourceStack.innerHTML = '<section class="resource-section bgm-admin"><div class="section-head"><div class="section-head-left"><button class="section-back" type="button" onclick="setFilter(&quot;HOME&quot;)">← 운영 자료</button><div><div class="section-kicker">SITE BGM</div><h2>홈페이지 음악</h2></div></div><span class="section-count">'+bgmTracks.length+'곡</span></div>'+
    '<p class="bgm-admin-intro">음원 파일을 올리면 홈페이지의 작은 플레이어에 표시됩니다. 곡이 끝나면 다음 곡이 이어지고 마지막 곡 뒤에는 처음 곡으로 돌아갑니다.</p>'+
    (bgmError?'<p class="bgm-admin-message">'+esc(bgmError)+'</p>':'')+
    '<div class="bgm-admin-form"><label>곡명<input id="bgmTitle" maxlength="120" value="'+esc(editing?.title||'')+'" placeholder="예: 공연 전 분위기 음악"></label>'+
    '<label>가수 또는 출처<input id="bgmArtist" maxlength="120" value="'+esc(editing?.artist||'')+'" placeholder="선택"></label>'+
    '<label>카테고리<select id="bgmCategory">'+options+'</select></label>'+
    '<label>재생 순서<input id="bgmOrder" type="number" min="0" value="'+Number(editing?.sort_order||0)+'"></label>'+
    '<label class="wide">음원 파일 '+(editing?'(교체할 때만 선택)':'(필수)')+'<input id="bgmFile" type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.webm,.flac"><small>MP3 · M4A · AAC · WAV · OGG · WEBM · FLAC, 50MB 이하. 방문자가 들을 수 있도록 공개됩니다.</small></label>'+
    '<label class="check wide"><input id="bgmActive" type="checkbox" '+(editing?.is_active===false?'':'checked')+'> 방문자 재생 목록에 표시</label>'+
    '<div class="bgm-admin-actions">'+(editing?'<button type="button" onclick="cancelBgmEdit()">취소</button>':'')+'<button class="primary" id="bgmSaveButton" type="button" onclick="saveBgmTrack()">'+(editing?'변경사항 저장':'음악 추가')+'</button></div></div>'+
    '<div class="bgm-admin-list">'+(rows||'<p class="bgm-admin-intro">등록된 음악이 없습니다. 첫 곡을 추가하면 플레이어가 표시됩니다.</p>')+'</div></section>';
}
function editBgmTrack(id) { bgmEditingId = id; renderBgmManager(); document.getElementById('bgmTitle')?.focus(); }
function cancelBgmEdit() { bgmEditingId = ''; renderBgmManager(); }
function bgmFileDetails(file) {
  const ext = String(file?.name||'').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
  if (!bgmMime[ext]) throw new Error('지원되는 음원 파일을 선택해 주세요.');
  if (!file.size || file.size > bgmMaxBytes) throw new Error('50MB 이하의 음원 파일을 선택해 주세요.');
  return {ext,mime:ext==='wav'&&file.type==='audio/x-wav'?'audio/x-wav':bgmMime[ext]};
}
async function saveBgmTrack() {
  if (!adminMode || bgmBusy) return;
  const title = document.getElementById('bgmTitle')?.value.trim() || '';
  const file = document.getElementById('bgmFile')?.files?.[0];
  const before = bgmTracks.find(item => item.id === bgmEditingId);
  if (!title) return alert('곡명을 입력해 주세요.');
  if (!before && !file) return alert('음원 파일을 선택해 주세요.');
  let details;
  try { if (file) details = bgmFileDetails(file); } catch (error) { return alert(error.message); }
  const button = document.getElementById('bgmSaveButton');
  bgmBusy = true;
  button.disabled = true; button.textContent = '저장 중…';
  let uploadedPath = '';
  try {
    if (file) {
      uploadedPath = 'tracks/' + (crypto.randomUUID?.() || Date.now()+'-'+Math.random().toString(36).slice(2)) + '.' + details.ext;
      const {error} = await db.storage.from('site-bgm').upload(uploadedPath,file,{cacheControl:'3600',upsert:false,contentType:details.mime});
      if (error) throw error;
    }
    const payload = {
      title, artist:document.getElementById('bgmArtist').value.trim(),
      category:document.getElementById('bgmCategory').value,
      sort_order:Math.max(0,Number(document.getElementById('bgmOrder').value)||0),
      is_active:document.getElementById('bgmActive').checked,
      file_path:uploadedPath || before.file_path, updated_at:new Date().toISOString()
    };
    const {error} = before
      ? await db.from('site_bgm_tracks').update(payload).eq('id',before.id)
      : await db.from('site_bgm_tracks').insert(payload);
    if (error) throw error;
    if (before && uploadedPath) {
      const {error:removeError} = await db.storage.from('site-bgm').remove([before.file_path]);
      if (removeError) console.warn('BGM OLD FILE:',removeError);
    }
    bgmEditingId = '';
    await loadBgmTracks();
    renderBgmManager();
  } catch (error) {
    if (uploadedPath) await db.storage.from('site-bgm').remove([uploadedPath]);
    alert('음악을 저장하지 못했습니다.\n'+(error.message||error));
  } finally {
    bgmBusy = false;
    if (button.isConnected) { button.disabled = false; button.textContent = before?'변경사항 저장':'음악 추가'; }
  }
}
async function deleteBgmTrack(id) {
  if (!adminMode || bgmBusy) return;
  const item = bgmTracks.find(track => track.id === id);
  if (!item || !confirm('‘'+item.title+'’ 음악을 삭제할까요?')) return;
  bgmBusy = true;
  try {
    const {error} = await db.from('site_bgm_tracks').delete().eq('id',id);
    if (error) throw error;
    const {error:removeError} = await db.storage.from('site-bgm').remove([item.file_path]);
    if (removeError) console.warn('BGM FILE DELETE:',removeError);
    if (bgmEditingId === id) bgmEditingId = '';
    await loadBgmTracks();
    renderBgmManager();
  } catch (error) { alert('음악을 삭제하지 못했습니다.\n'+(error.message||error)); }
  finally { bgmBusy = false; }
}
