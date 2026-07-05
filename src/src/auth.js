const jwt = require('jsonwebtoken');
const { getState } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-moi-avec-une-longue-chaine-aleatoire';
const COOKIE_NAME = 'dow_token';
const TOKEN_TTL = '30d';

function signToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function setSessionCookie(res, username) {
  const token = signToken(username);
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME);
}

/** Lit le cookie de session (si présent et valide) et attache req.user. Ne bloque jamais la requête. */
function attachUser(req, res, next) {
  req.user = null;
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const db = getState();
      const user = db.users.find(u => u.username === payload.username);
      if (user && !user.isBanned) req.user = user;
    } catch (e) {
      // jeton invalide ou expiré : on ignore, req.user reste null
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Vous devez être connecté." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Action réservée à l'administrateur." });
  next();
}

/** Représentation publique d'un utilisateur (jamais de mot de passe/e-mail exposé aux autres). */
function publicUser(u) {
  return {
    username: u.username,
    isAdmin: !!u.isAdmin,
    isCertified: !!u.isCertified,
    isBanned: !!u.isBanned,
    profilePic: u.profilePic || null,
    bio: u.bio || '',
    followersCount: (u.followersList ? u.followersList.length : 0) + (u.adminBonus || 0),
    followingCount: u.followingList ? u.followingList.length : 0,
    followersList: u.followersList || [],
    adminBonus: u.adminBonus || 0,
    createdAt: u.createdAt
  };
}

module.exports = {
  COOKIE_NAME, signToken, setSessionCookie, clearSessionCookie,
  attachUser, requireAuth, requireAdmin, publicUser
};
