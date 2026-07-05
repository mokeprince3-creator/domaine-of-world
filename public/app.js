/* ==========================================================================
   DOMAINE OF WORLD — front-end
   Toute la logique parle maintenant à un vrai serveur (dossier /server)
   via l'API /api/*. Les données sont partagées entre tous les appareils.
   ========================================================================== */

let state = { authenticated: false, me: null, users: [], posts: [], groups: [], certRequests: [], conversations: [], config: {} };
let activeView = 'feed';
let viewingProfile = null;
let currentGroupId = null;
let activeConversation = null;
let activeAdminTab = 'users';
let videoObserver = null;

/* ---------------- API helpers ---------------- */
async function apiGet(url) {
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur serveur.');
  return data;
}
async function apiSend(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur serveur.');
  return data;
}
async function apiUpload(url, formData) {
  const r = await fetch(url, { method: 'POST', body: formData });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Erreur serveur.');
  return data;
}
async function refreshState() {
  state = await apiGet('/api/state');
}

/* ---------------- Helpers ---------------- */
function esc(str) {
  return (str === undefined || str === null ? '' : String(str)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(ts) {
  return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function initials(name) {
  return (name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function findUser(username) {
  return state.users.find(u => u.username === username) || { username, isCertified: false, profilePic: null };
}
function currentUser() { return state.me; }
function followerCount(user) { return user.followersCount || 0; }

function avatarHtml(user, size) {
  size = size || 40;
  if (user && user.profilePic) {
    return `<img class="avatar" style="width:${size}px;height:${size}px" src="${user.profilePic}" alt="Photo de profil de ${esc(user.username)}">`;
  }
  return `<div class="avatar-initials" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px">${esc(initials(user ? user.username : '?'))}</div>`;
}
function certBadgeHtml(isCertified) {
  return isCertified ? '<i class="fa-solid fa-circle-check cert-badge" title="Compte certifié"></i>' : '';
}
function toast(message, type) {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.innerHTML = `<i class="fa-solid ${type === 'err' ? 'fa-circle-exclamation' : 'fa-circle-check'}"></i><span>${esc(message)}</span>`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .25s ease'; setTimeout(() => el.remove(), 260); }, 3200);
}
function emptyState(icon, text) {
  return `<div class="empty-state"><i class="fa-solid ${icon}"></i>${esc(text)}</div>`;
}

/* ---------------- Auth ---------------- */
function showAuth() {
  document.getElementById('auth-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
}
function showApp() {
  document.getElementById('auth-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  viewingProfile = state.me.username;
  switchView('feed');
}
async function doLogin(email, password) {
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  try {
    await apiSend('/api/login', 'POST', { email, password });
    document.getElementById('login-form').reset();
    await refreshState();
    showApp();
    toast(`Bienvenue, ${state.me.username} !`);
  } catch (e) {
    errEl.textContent = e.message;
  }
}
async function doRegister(username, email, password, confirm) {
  const errEl = document.getElementById('register-error');
  errEl.textContent = '';
  if (username.trim().length < 3) { errEl.textContent = "Le nom d'utilisateur doit contenir au moins 3 caractères."; return; }
  if (password.length < 4) { errEl.textContent = "Le mot de passe doit contenir au moins 4 caractères."; return; }
  if (password !== confirm) { errEl.textContent = "Les mots de passe ne correspondent pas."; return; }
  try {
    await apiSend('/api/register', 'POST', { username: username.trim(), email: email.trim(), password, confirmPassword: confirm });
    document.getElementById('register-form').reset();
    await refreshState();
    showApp();
    toast('Compte créé avec succès. Bienvenue sur Domaine Of World !');
  } catch (e) {
    errEl.textContent = e.message;
  }
}
async function doLogout() {
  try { await apiSend('/api/logout', 'POST'); } catch (e) { /* ignore */ }
  state = { authenticated: false, me: null, users: [], posts: [], groups: [], certRequests: [], conversations: [], config: {} };
  document.getElementById('profile-dropdown').hidden = true;
  showAuth();
}

/* ---------------- Navigation ---------------- */
const viewRenderers = {
  feed: renderFeed, videos: renderVideos, groups: renderGroups, 'group-detail': renderGroupDetail,
  messages: renderMessages, certification: renderCertification, profile: renderProfile, admin: renderAdmin
};
function switchView(name) {
  const cu = currentUser();
  if (name === 'admin' && !(cu && cu.isAdmin)) name = 'feed';
  activeView = name;
  document.querySelectorAll('.view').forEach(v => v.hidden = (v.id !== 'view-' + name));
  document.querySelectorAll('.nav-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.tab-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  document.getElementById('profile-dropdown').hidden = true;
  rerender();
  window.scrollTo({ top: 0 });
}
function rerender() {
  refreshChrome();
  const fn = viewRenderers[activeView];
  if (fn) fn();
}
function refreshChrome() {
  const cu = currentUser();
  if (!cu) return;
  document.getElementById('topbar-username').textContent = cu.username;
  document.getElementById('topbar-avatar-slot').innerHTML = avatarHtml(cu, 30);
  document.querySelectorAll('.admin-only').forEach(el => el.hidden = !cu.isAdmin);
  renderRightRail();
}

/* ---------------- Feed / Posts ---------------- */
function renderPostCard(post) {
  const author = findUser(post.author);
  const cu = currentUser();
  const liked = cu && post.likes.includes(cu.username);
  const group = post.groupId ? state.groups.find(g => g.id === post.groupId) : null;
  let media = '';
  if (post.type === 'image' && post.media) media = `<img class="post-media" src="${post.media}" alt="Publication de ${esc(author.username)}">`;
  if (post.type === 'video' && post.media) media = `<video class="post-media" src="${post.media}" controls></video>`;
  const commentsHtml = post.comments.map(c => `<div class="comment"><b>${esc(c.author)}</b>${esc(c.text)}</div>`).join('');
  return `
  <div class="card post-card">
    <div class="post-head">
      ${avatarHtml(author, 42)}
      <div class="who">
        <div class="name" onclick="viewProfile('${esc(author.username)}')">${esc(author.username)}${certBadgeHtml(author.isCertified)}</div>
        <div class="meta">${fmtDate(post.createdAt)}${group ? ' · dans ' + esc(group.name) : ''}</div>
      </div>
    </div>
    ${post.caption ? `<div class="post-caption">${esc(post.caption)}</div>` : ''}
    ${media}
    <div class="post-actions">
      <button class="post-action ${liked ? 'liked' : ''}" onclick="toggleLike('${post.id}')"><i class="fa-solid fa-heart"></i> ${post.likes.length}</button>
      <button class="post-action" onclick="focusComment('${post.id}')"><i class="fa-regular fa-comment"></i> ${post.comments.length}</button>
      <button class="post-action" onclick="toast('Le partage arrive bientôt.')"><i class="fa-solid fa-share"></i> Partager</button>
    </div>
    <div class="comments">
      ${commentsHtml}
      <div class="comment-form">
        <input type="text" id="comment-input-${post.id}" placeholder="Écrire un commentaire..." onkeydown="if(event.key==='Enter'){addComment('${post.id}')}">
        <button class="btn btn-ghost btn-sm" onclick="addComment('${post.id}')"><i class="fa-solid fa-paper-plane"></i></button>
      </div>
    </div>
  </div>`;
}
function renderFeed() {
  const list = document.getElementById('feed-list');
  const posts = [...state.posts].sort((a, b) => b.createdAt - a.createdAt);
  list.innerHTML = posts.length ? posts.map(renderPostCard).join('') : emptyState('fa-inbox', "Aucune publication pour l'instant. Soyez le premier à publier.");
}
async function toggleLike(postId) {
  try { await apiSend(`/api/posts/${postId}/like`, 'POST'); await refreshState(); rerender(); }
  catch (e) { toast(e.message, 'err'); }
}
function focusComment(postId) {
  const input = document.getElementById('comment-input-' + postId);
  if (input) input.focus();
}
async function addComment(postId) {
  const input = document.getElementById('comment-input-' + postId);
  const text = input.value.trim();
  if (!text) return;
  try { await apiSend(`/api/posts/${postId}/comments`, 'POST', { text }); await refreshState(); rerender(); }
  catch (e) { toast(e.message, 'err'); }
}
async function createPost(caption, groupId, file) {
  const fd = new FormData();
  fd.append('caption', caption || '');
  if (groupId) fd.append('groupId', groupId);
  if (file) fd.append('media', file);
  try {
    const result = await apiUpload('/api/posts', fd);
    closeModal('modal-create-post');
    document.getElementById('create-post-form').reset();
    resetPostFileLabel();
    toast('Publication mise en ligne !');
    await refreshState();
    switchView(result.post.type === 'video' ? 'videos' : (groupId ? 'group-detail' : 'feed'));
  } catch (e) {
    toast(e.message, 'err');
  }
}

/* ---------------- Videos (style TikTok) ---------------- */
function renderVideos() {
  const container = document.getElementById('video-feed');
  const videos = state.posts.filter(p => p.type === 'video').sort((a, b) => b.createdAt - a.createdAt);
  if (!videos.length) {
    container.innerHTML = `<div style="padding:60px 24px;color:var(--mist);text-align:center;"><i class="fa-solid fa-clapperboard" style="font-size:1.8rem;display:block;margin-bottom:12px;"></i>Aucune vidéo pour l'instant. Publiez la première vidéo courte !</div>`;
    return;
  }
  container.innerHTML = videos.map(post => {
    const author = findUser(post.author);
    const cu = currentUser();
    const liked = cu && post.likes.includes(cu.username);
    return `
    <div class="video-card">
      <video src="${post.media}" loop muted playsinline></video>
      <div class="video-overlay-bottom">
        <div class="name" onclick="viewProfile('${esc(author.username)}')">${esc(author.username)}${certBadgeHtml(author.isCertified)}</div>
        <div class="cap">${esc(post.caption)}</div>
      </div>
      <div class="video-actions-col">
        <div>
          <button class="${liked ? 'liked' : ''}" onclick="toggleLike('${post.id}')"><i class="fa-solid fa-heart"></i></button>
          <span>${post.likes.length}</span>
        </div>
        <div>
          <button onclick="focusComment('${post.id}');switchView('feed')"><i class="fa-regular fa-comment"></i></button>
          <span>${post.comments.length}</span>
        </div>
        <div>
          <button onclick="toggleMuteVideo(this)"><i class="fa-solid fa-volume-xmark"></i></button>
        </div>
      </div>
    </div>`;
  }).join('');
  if (videoObserver) videoObserver.disconnect();
  videoObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const v = entry.target.querySelector('video');
      if (!v) return;
      if (entry.isIntersecting) { v.play().catch(() => {}); } else { v.pause(); }
    });
  }, { threshold: 0.65 });
  document.querySelectorAll('#video-feed .video-card').forEach(c => videoObserver.observe(c));
}
function toggleMuteVideo(btn) {
  const video = btn.closest('.video-card').querySelector('video');
  video.muted = !video.muted;
  btn.innerHTML = video.muted ? '<i class="fa-solid fa-volume-xmark"></i>' : '<i class="fa-solid fa-volume-high"></i>';
}

/* ---------------- Groups ---------------- */
function renderGroups() {
  const grid = document.getElementById('group-grid');
  if (!state.groups.length) { grid.innerHTML = emptyState('fa-people-group', "Aucun groupe pour l'instant. Créez la première communauté."); return; }
  const cu = currentUser();
  grid.innerHTML = state.groups.map(g => {
    const isMember = cu && g.members.includes(cu.username);
    return `
    <div class="card group-card">
      <h3>${esc(g.name)}${certBadgeHtml(g.isCertified)}</h3>
      <p>${esc(g.description || 'Aucune description.')}</p>
      <div class="meta-row">
        <span><i class="fa-solid fa-users"></i> ${g.members.length} membre${g.members.length > 1 ? 's' : ''}</span>
      </div>
      <div class="profile-actions">
        <button class="btn btn-ghost btn-sm" onclick="openGroup('${g.id}')"><i class="fa-solid fa-arrow-right"></i> Ouvrir</button>
        <button class="btn ${isMember ? 'btn-danger' : 'btn-primary'} btn-sm" onclick="${isMember ? `leaveGroup('${g.id}')` : `joinGroup('${g.id}')`}">${isMember ? 'Quitter' : 'Rejoindre'}</button>
      </div>
    </div>`;
  }).join('');
}
async function joinGroup(id) {
  try { await apiSend(`/api/groups/${id}/join`, 'POST'); await refreshState(); rerender(); toast('Vous avez rejoint le groupe.'); }
  catch (e) { toast(e.message, 'err'); }
}
async function leaveGroup(id) {
  try { await apiSend(`/api/groups/${id}/leave`, 'POST'); await refreshState(); rerender(); toast('Vous avez quitté le groupe.'); }
  catch (e) { toast(e.message, 'err'); }
}
async function createGroup(name, description) {
  try {
    await apiSend('/api/groups', 'POST', { name, description });
    closeModal('modal-create-group');
    document.getElementById('create-group-form').reset();
    toast('Groupe créé !');
    await refreshState();
    switchView('groups');
  } catch (e) { toast(e.message, 'err'); }
}
function openGroup(id) { currentGroupId = id; switchView('group-detail'); }
function renderGroupDetail() {
  const g = state.groups.find(x => x.id === currentGroupId);
  if (!g) { switchView('groups'); return; }
  const cu = currentUser();
  const isMember = cu && g.members.includes(cu.username);
  document.getElementById('group-detail-header').innerHTML = `
    <h2>${esc(g.name)}${certBadgeHtml(g.isCertified)}</h2>
    <p style="color:var(--mist);font-size:.88rem;margin:0 0 12px;">${esc(g.description || 'Aucune description.')}</p>
    <div class="meta-row" style="margin-bottom:14px;"><span><i class="fa-solid fa-users"></i> ${g.members.length} membre${g.members.length > 1 ? 's' : ''}</span></div>
    <div class="profile-actions">
      <button class="btn ${isMember ? 'btn-danger' : 'btn-primary'} btn-sm" onclick="${isMember ? `leaveGroup('${g.id}')` : `joinGroup('${g.id}')`}">${isMember ? 'Quitter le groupe' : 'Rejoindre le groupe'}</button>
      <button class="btn btn-ghost btn-sm" onclick="openPostModalForGroup('${g.id}')"><i class="fa-solid fa-pen"></i> Publier ici</button>
    </div>`;
  const posts = state.posts.filter(p => p.groupId === g.id).sort((a, b) => b.createdAt - a.createdAt);
  document.getElementById('group-detail-posts').innerHTML = posts.length ? posts.map(renderPostCard).join('') : emptyState('fa-comments', "Aucune publication dans ce groupe pour l'instant.");
}

/* ---------------- Messages ---------------- */
function renderMessages() {
  const cu = currentUser(); if (!cu) return;
  const list = document.getElementById('conv-list');
  list.innerHTML = state.conversations.length ? state.conversations.map(conv => {
    const u = findUser(conv.username);
    return `<button class="conv-item ${activeConversation === u.username ? 'active' : ''}" onclick="openConversation('${esc(u.username)}')">
      ${avatarHtml(u, 38)}
      <div style="min-width:0;flex:1;">
        <div class="name">${esc(u.username)}${certBadgeHtml(u.isCertified)}</div>
        <div class="preview">${conv.lastMessage ? esc(conv.lastMessage.text) : 'Aucun message pour le moment'}</div>
      </div>
    </button>`;
  }).join('') : `<div style="padding:20px;color:var(--mist-dim);font-size:.82rem;">Aucun autre compte pour l'instant.</div>`;
}
async function openConversation(username) {
  activeConversation = username;
  document.getElementById('messages-layout').classList.add('show-chat');
  renderMessages();
  await renderChatPanel();
}
async function renderChatPanel() {
  const cu = currentUser(); if (!cu || !activeConversation) return;
  const other = findUser(activeConversation);
  const panel = document.getElementById('chat-panel');
  let thread = [];
  try {
    const data = await apiGet(`/api/messages/${encodeURIComponent(other.username)}`);
    thread = data.thread;
  } catch (e) {
    toast(e.message, 'err');
  }
  panel.innerHTML = `
    <div class="chat-header">
      <button class="btn btn-ghost btn-sm" style="width:36px;height:36px;padding:0;border-radius:50%;" onclick="closeConversation()"><i class="fa-solid fa-arrow-left"></i></button>
      ${avatarHtml(other, 34)}
      <div><div style="font-weight:700;font-size:.86rem;">${esc(other.username)}${certBadgeHtml(other.isCertified)}</div></div>
    </div>
    <div class="chat-messages" id="chat-messages">
      ${thread.length ? thread.map(m => `
        <div>
          <div class="msg-bubble ${m.from === cu.username ? 'mine' : ''}">${esc(m.text)}</div>
          <div class="msg-time" style="${m.from === cu.username ? 'text-align:right' : ''}">${fmtDate(m.ts)}</div>
        </div>`).join('') : '<div style="color:var(--mist-dim);font-size:.82rem;text-align:center;margin-top:20px;">Démarrez la conversation.</div>'}
    </div>
    <div class="msg-input-row">
      <input type="text" id="msg-input" placeholder="Écrire un message..." onkeydown="if(event.key==='Enter'){sendMessage()}">
      <button class="btn btn-primary" style="width:44px;padding:0;border-radius:50%;" onclick="sendMessage()"><i class="fa-solid fa-paper-plane"></i></button>
    </div>`;
  const box = document.getElementById('chat-messages');
  if (box) box.scrollTop = box.scrollHeight;
}
function closeConversation() {
  activeConversation = null;
  document.getElementById('messages-layout').classList.remove('show-chat');
  renderMessages();
}
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !activeConversation) return;
  try {
    await apiSend(`/api/messages/${encodeURIComponent(activeConversation)}`, 'POST', { text });
    input.value = '';
    await refreshState();
    renderMessages();
    await renderChatPanel();
  } catch (e) { toast(e.message, 'err'); }
}

/* ---------------- Certification ---------------- */
function renderCertification() {
  const cu = currentUser(); if (!cu) return;
  const el = document.getElementById('cert-content');
  const price = state.config.certPrice || 50;
  const payOrange = state.config.payOrange || '';
  const payAirtel = state.config.payAirtel || '';
  const myGroups = state.groups.filter(g => g.ownerUsername === cu.username);
  let userSection = '';
  const pendingUserReq = state.certRequests.find(r => r.type === 'user' && r.targetId === cu.username && r.status === 'pending');
  if (cu.isCertified) {
    userSection = `<div class="status-banner ok"><i class="fa-solid fa-circle-check"></i><div><b>Votre compte est certifié.</b><br>
