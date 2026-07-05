/**
 * Couche de stockage de Domaine Of World.
 *
 * Pour rester simple à installer (aucune dépendance native à compiler),
 * les données sont conservées en mémoire pendant que le serveur tourne et
 * sauvegardées dans un fichier JSON (data/db.json) à chaque écriture.
 *
 * C'est largement suffisant pour démarrer, tester et faire tourner une
 * petite communauté. Pour un vrai lancement à grande échelle avec beaucoup
 * d'utilisateurs simultanés, remplacez ce module par une vraie base de
 * données (PostgreSQL, MySQL, MongoDB...) : toutes les routes de server.js
 * passent par les fonctions exportées ici, donc c'est le seul fichier à
 * réécrire pour changer de moteur de stockage.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function seed() {
  const now = Date.now();
  const adminUsername = process.env.ADMIN_USERNAME || 'Mr Trafalgar D Water Law';
  const adminEmail = (process.env.ADMIN_EMAIL || 'fondateur@domaineofworld.cd').toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || 'Manasse$01';

  const founder = {
    id: 'u_founder',
    username: adminUsername,
    email: adminEmail,
    passwordHash: bcrypt.hashSync(adminPassword, 10),
    isAdmin: true,
    isCertified: true,
    isBanned: false,
    profilePic: null,
    bio: "Fondateur de Domaine Of World. Un seul monde, toutes les communautés.",
    followersList: [],
    followingList: [],
    adminBonus: 128000,
    createdAt: now
  };

  const officialGroup = {
    id: 'g_official',
    name: "Domaine Of World — Officiel",
    description: "La communauté officielle de l'application : annonces, nouveautés et discussions générales.",
    ownerUsername: adminUsername,
    isCertified: true,
    members: [adminUsername],
    createdAt: now
  };

  const welcomePost = {
    id: 'p_welcome',
    author: adminUsername,
    type: 'text',
    media: null,
    caption: "Bienvenue sur Domaine Of World \u{1F30D} — publiez vos photos et vidéos, rejoignez des communautés, et faites certifier votre compte pour plus de visibilité.",
    groupId: null,
    likes: [],
    comments: [],
    createdAt: now
  };

  return {
    users: [founder],
    posts: [welcomePost],
    groups: [officialGroup],
    certRequests: [],
    messages: {}
  };
}

let state = null;

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    state = seed();
    persist();
    console.log('Base de données initialisée avec le compte fondateur.');
    return state;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    state = JSON.parse(raw);
    if (!state.users || !state.users.length) {
      state = seed();
      persist();
    }
  } catch (e) {
    console.error('Erreur de lecture de la base, ré-initialisation :', e.message);
    state = seed();
    persist();
  }
  return state;
}

function persist() {
  fs.writeFileSync(DB_FILE, JSON.stringify(state, null, 2));
}

function getState() {
  if (!state) load();
  return state;
}

module.exports = { load, persist, getState };
