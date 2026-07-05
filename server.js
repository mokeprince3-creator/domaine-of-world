require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const dbModule = require('./src/db');
const { setSessionCookie, clearSessionCookie, attachUser, requireAuth, requireAdmin, publicUser } = require('./src/auth');

const PORT = process.env.PORT || 3000;
const CERT_PRICE = Number(process.env.CERT_PRICE_USD || 50);
const PAY_ORANGE = process.env.PAY_ORANGE_NUMBER || '+243 840 446 386';
const PAY_AIRTEL = process.env.PAY_AIRTEL_NUMBER || '+243 974 491 169';

const db = dbModule.load();
function persist() { dbModule.persist(); }
function genId() { return crypto.randomUUID(); }

/* ------------------------------------------------------------------ */
/* Uploads (photos / vidéos)                                           */
/* ------------------------------------------------------------------ */
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeExt = path.extname(file.originalname).slice(0, 10);
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${safeExt}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 80 * 1024 * 1024 }, // 80 Mo, pour laisser passer de courtes vidéos
  fileFilter: (req, file, cb) => {
    if (/^image\/|^video\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Type de fichier non autorisé (image ou vidéo uniquement).'));
  }
});

/* ------------------------------------------------------------------ */
/* App                                                                  */
/* ------------------------------------------------------------------ */
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use(attachUser);

function findUser(username) { return db.users.find(u => u.username === username); }
function findUserByEmail(email) { return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()); }
function followerCount(u) { return (u.followersList ? u.followersList.length : 0) + (u.adminBonus || 0); }

/* ------------------------------------------------------------------ */
/* AUTH                                                                 */
/* ------------------------------------------------------------------ */
app.post('/api/register', (req, res) => {
  let { username, email, password, confirmPassword } = req.body || {};
  username = (username || '').trim();
  email = (email || '').trim().toLowerCase();
  password = password || '';

  if (username.length < 3) return res.status(400).json({ error: "Le nom d'utilisateur doit contenir au moins 3 caractères." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Adresse e-mail invalide." });
  if (password.length < 4) return res.status(400).json({ error: "Le mot de passe doit contenir au moins 4 caractères." });
  if (password !== confirmPassword) return res.status(400).json({ error: "Les mots de passe ne correspondent pas." });
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: "Ce nom d'utilisateur est déjà pris." });
  if (findUserByEmail(email)) return res.status(409).json({ error: "Un compte existe déjà avec cette adresse e-mail." });

  const user = {
    id: genId(),
    username, email,
    passwordHash: bcrypt.hashSync(password, 10),
    isAdmin: false, isCertified: false, isBanned: false,
    profilePic: null, bio: '',
    followersList: [], followingList: [], adminBonus: 0,
    createdAt: Date.now()
  };
  db.users.push(user);
  persist();
  setSessionCookie(res, user.username);
  res.json({ ok: true, me: { ...publicUser(user), email: user.email } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = findUserByEmail(email || '');
  if (!user) return res.status(401).json({ error: "Aucun compte ne correspond à cette adresse e-mail." });
  if (user.isBanned) return res.status(403).json({ error: "Ce compte a été suspendu par un administrateur." });
  if (!bcrypt.compareSync(password || '', user.passwordHash)) return res.status(401).json({ error: "Mot de passe incorrect." });
  setSessionCookie(res, user.username);
  res.json({ ok: true, me: { ...publicUser(user), email: user.email } });
});

app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* ETAT GLOBAL (état consolidé pour le front-end)                       */
/* ------------------------------------------------------------------ */
app.get('/api/state', (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  const me = req.user;

  const users = db.users.filter(u => !u.isBanned || me.isAdmin || u.username === me.username).map(publicUser);
  const posts = db.posts;
  const groups = db.groups;
  const certRequests = me.isAdmin ? db.certRequests : db.certRequests.filter(r => r.requestedBy === me.username);

  const conversations = db.users
    .filter(u => u.username !== me.username && !u.isBanned)
    .map(u => {
      const key = [me.username, u.username].sort().join('||');
      const thread = db.messages[key] || [];
      const last = thread[thread.length - 1] || null;
      return { username: u.username, lastMessage: last };
    });

  res.json({
    authenticated: true,
    me: { ...publicUser(me), email: me.email },
    users, posts, groups, certRequests, conversations,
    config: { certPrice: CERT_PRICE, payOrange: PAY_ORANGE, payAirtel: PAY_AIRTEL }
  });
});

/* ------------------------------------------------------------------ */
/* POSTS                                                                */
/* ------------------------------------------------------------------ */
app.post('/api/posts', requireAuth, upload.single('media'), (req, res) => {
  const caption = (req.body.caption || '').trim();
  const groupId = req.body.groupId || null;
  const file = req.file;

  if (!caption && !file) return res.status(400).json({ error: "Ajoutez une légende ou un fichier avant de publier." });
  if (groupId) {
    const group = db.groups.find(g => g.id === groupId);
    if (!group || !group.members.includes(req.user.username)) {
      return res.status(403).json({ error: "Vous devez être membre du groupe pour y publier." });
    }
  }

  let type = 'text', media = null;
  if (file) {
    type = file.mimetype.startsWith('video/') ? 'video' : 'image';
    media = `/uploads/${file.filename}`;
  }

  const post = {
    id: genId(), author: req.user.username, type, media, caption,
    groupId: groupId || null, likes: [], comments: [], createdAt: Date.now()
  };
  db.posts.unshift(post);
  persist();
  res.json({ ok: true, post });
});

app.post('/api/posts/:id/like', requireAuth, (req, res) => {
  const post = db.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Publication introuvable.' });
  const idx = post.likes.indexOf(req.user.username);
  if (idx > -1) post.likes.splice(idx, 1); else post.likes.push(req.user.username);
  persist();
  res.json({ ok: true, likes: post.likes });
});

app.post('/api/posts/:id/comments', requireAuth, (req, res) => {
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Commentaire vide.' });
  const post = db.posts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Publication introuvable.' });
  post.comments.push({ author: req.user.username, text, ts: Date.now() });
  persist();
  res.json({ ok: true, comments: post.comments });
});

/* ------------------------------------------------------------------ */
/* GROUPES                                                              */
/* ------------------------------------------------------------------ */
app.post('/api/groups', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  if (!name) return res.status(400).json({ error: 'Le nom du groupe est requis.' });
  const group = { id: genId(), name, description, ownerUsername: req.user.username, isCertified: false, members: [req.user.username], createdAt: Date.now() };
  db.groups.push(group);
  persist();
  res.json({ ok: true, group });
});

app.post('/api/groups/:id/join', requireAuth, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });
  if (!group.members.includes(req.user.username)) group.members.push(req.user.username);
  persist();
  res.json({ ok: true, group });
});

app.post('/api/groups/:id/leave', requireAuth, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });
  group.members = group.members.filter(m => m !== req.user.username);
  persist();
  res.json({ ok: true, group });
});

app.post('/api/admin/groups/:id/certify', requireAdmin, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });
  group.isCertified = !group.isCertified;
  persist();
  res.json({ ok: true, group });
});

app.delete('/api/admin/groups/:id', requireAdmin, (req, res) => {
  const group = db.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: 'Groupe introuvable.' });
  db.groups = db.groups.filter(g => g.id !== req.params.id);
  db.posts = db.posts.filter(p => p.groupId !== req.params.id);
  persist();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* PROFIL                                                               */
/* ------------------------------------------------------------------ */
app.post('/api/profile/photo', requireAuth, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucune image reçue.' });
  req.user.profilePic = `/uploads/${req.file.filename}`;
  persist();
  res.json({ ok: true, profilePic: req.user.profilePic });
});

app.put('/api/profile/bio', requireAuth, (req, res) => {
  req.user.bio = String(req.body.bio || '').slice(0, 500);
  persist();
  res.json({ ok: true, bio: req.user.bio });
});

app.post('/api/users/:username/follow', requireAuth, (req, res) => {
  const target = findUser(req.params.username);
  if (!target) return res.status(404).json({ error: 'Compte introuvable.' });
  if (target.username === req.user.username) return res.status(400).json({ error: 'Impossible de vous suivre vous-même.' });
  const idx = target.followersList.indexOf(req.user.username);
  if (idx > -1) {
    target.followersList.splice(idx, 1);
    req.user.followingList = req.user.followingList.filter(u => u !== target.username);
  } else {
    target.followersList.push(req.user.username);
    if (!req.user.followingList.includes(target.username)) req.user.followingList.push(target.username);
  }
  persist();
  res.json({ ok: true, following: target.followersList.includes(req.user.username) });
});

/* ------------------------------------------------------------------ */
/* CERTIFICATION                                                        */
/* ------------------------------------------------------------------ */
app.post('/api/certification/request', requireAuth, (req, res) => {
  const { type, targetId } = req.body || {};
  if (!['user', 'group'].includes(type)) return res.status(400).json({ error: 'Type de demande invalide.' });
  if (type === 'user' && targetId !== req.user.username) return res.status(403).json({ error: 'Vous ne pouvez demander la certification que pour votre propre compte.' });
  if (type === 'group') {
    const group = db.groups.find(g => g.id === targetId);
    if (!group || group.ownerUsername !== req.user.username) return res.status(403).json({ error: 'Seul le créateur du groupe peut demander sa certification.' });
  }
  const exists = db.certRequests.find(r => r.type === type && r.targetId === targetId && r.status === 'pending');
  if (exists) return res.status(409).json({ error: 'Une demande est déjà en cours pour ce compte ou groupe.' });

  const request = { id: genId(), type, targetId, requestedBy: req.user.username, status: 'pending', amount: CERT_PRICE, createdAt: Date.now() };
  db.certRequests.push(request);
  persist();
  res.json({ ok: true, request });
});

app.post('/api/admin/certification/:id/approve', requireAdmin, (req, res) => {
  const request = db.certRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Demande introuvable.' });
  if (request.type === 'user') { const u = findUser(request.targetId); if (u) u.isCertified = true; }
  if (request.type === 'group') { const g = db.groups.find(x => x.id === request.targetId); if (g) g.isCertified = true; }
  request.status = 'approved';
  persist();
  res.json({ ok: true });
});

app.post('/api/admin/certification/:id/reject', requireAdmin, (req, res) => {
  const request = db.certRequests.find(r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Demande introuvable.' });
  request.status = 'rejected';
  persist();
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* ADMIN — utilisateurs                                                 */
/* ------------------------------------------------------------------ */
app.post('/api/admin/users/:username/ban', requireAdmin, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  if (user.isAdmin) return res.status(400).json({ error: 'Impossible de bannir un administrateur.' });
  user.isBanned = !user.isBanned;
  persist();
  res.json({ ok: true, isBanned: user.isBanned });
});

app.post('/api/admin/users/:username/certify', requireAdmin, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  user.isCertified = !user.isCertified;
  persist();
  res.json({ ok: true, isCertified: user.isCertified });
});

app.put('/api/admin/users/:username/bonus', requireAdmin, (req, res) => {
  const user = findUser(req.params.username);
  if (!user) return res.status(404).json({ error: 'Compte introuvable.' });
  const n = Math.max(0, parseInt(req.body.value, 10) || 0);
  user.adminBonus = n;
  persist();
  res.json({ ok: true, adminBonus: user.adminBonus });
});

/* ------------------------------------------------------------------ */
/* MESSAGES                                                             */
/* ------------------------------------------------------------------ */
app.get('/api/messages/:username', requireAuth, (req, res) => {
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'Compte introuvable.' });
  const key = [req.user.username, other.username].sort().join('||');
  res.json({ ok: true, thread: db.messages[key] || [] });
});

app.post('/api/messages/:username', requireAuth, (req, res) => {
  const other = findUser(req.params.username);
  if (!other) return res.status(404).json({ error: 'Compte introuvable.' });
  const text = (req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Message vide.' });
  const key = [req.user.username, other.username].sort().join('||');
  if (!db.messages[key]) db.messages[key] = [];
  const message = { from: req.user.username, to: other.username, text, ts: Date.now() };
  db.messages[key].push(message);
  persist();
  res.json({ ok: true, message });
});

/* ------------------------------------------------------------------ */
/* Gestion des erreurs (fichiers trop volumineux, etc.)                 */
/* ------------------------------------------------------------------ */
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err) {
    console.error(err.message);
    return res.status(400).json({ error: err.message || 'Une erreur est survenue.' });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`Domaine Of World est en ligne sur http://localhost:${PORT}`);
});
