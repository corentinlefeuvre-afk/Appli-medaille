// ─── AUTH SERVICE ─────────────────────────────────────────────────────────────
// Couche d'abstraction pour l'authentification.
// Actuellement : login email/password via la fonction sécurisée verify_login (mot de passe haché).
// À remplacer par Entra ID (MSAL) lors de la recette SSO,
// en modifiant uniquement ce fichier — pas App.jsx.

import { db } from './supabase.js';

const SESSION_KEY = 'fnpc_user';

export const auth = {
  // Restaure la session depuis sessionStorage
  restoreSession() {
    try {
      const saved = sessionStorage.getItem(SESSION_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  },

  // Sauvegarde la session
  saveSession(user) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
  },

  // Supprime la session
  clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
  },

  // Login email/password via la fonction sécurisée verify_login (mot de passe haché côté base)
  async login(email, password) {
    const { data, error } = await db.supabase
      .rpc('verify_login', { p_email: email.toLowerCase().trim(), p_password: password });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || !row) throw new Error('E-mail ou mot de passe incorrect, ou compte désactivé.');
    const user = {
      id:       row.id,
      email:    row.email,
      nom:      row.nom,
      prenom:   row.prenom,
      role:     row.role,
      roles:    row.roles ? row.roles.split(',').map(s => s.trim()).filter(Boolean) : [row.role],
      dept:     row.dept,
      antenne:  row.antenne,
    };
    auth.saveSession(user);
    return user;
  },

  // Logout
  logout() {
    auth.clearSession();
  },

  // ── À implémenter pour Entra ID ──────────────────────────────────────────
  // async loginSSO() {
  //   const msalInstance = new PublicClientApplication(msalConfig);
  //   const result = await msalInstance.loginPopup(loginRequest);
  //   const user = mapEntraIdToUser(result.account);
  //   auth.saveSession(user);
  //   return user;
  // },
};
