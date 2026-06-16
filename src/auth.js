// ─── AUTH SERVICE ─────────────────────────────────────────────────────────────
// Couche d'abstraction pour l'authentification.
// Actuellement : login par email/password via Supabase (app_users).
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

  // Login email/password via Supabase app_users
  async login(email, password) {
    const { data, error } = await db.supabase
      .from('app_users')
      .select('*')
      .eq('email', email.toLowerCase().trim())
      .eq('password', password)
      .eq('actif', true)
      .single();
    if (error || !data) throw new Error('E-mail ou mot de passe incorrect, ou compte désactivé.');
    const user = {
      id:       data.id,
      email:    data.email,
      nom:      data.nom,
      prenom:   data.prenom,
      role:     data.role,
      roles:    data.roles ? data.roles.split(',').map(s => s.trim()).filter(Boolean) : [data.role],
      dept:     data.dept,
      antenne:  data.antenne,
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
