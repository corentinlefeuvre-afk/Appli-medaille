import { createClient } from '@supabase/supabase-js'

// Clé publique uniquement (anon key) — ne jamais mettre la clé secrète ici
// Les valeurs sont lues depuis .env (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
// À configurer aussi dans Netlify → Site settings → Environment variables
const SUPABASE_URL      = import.meta.env.VITE_SUPABASE_URL      || 'https://bectezvnxlzwahbwlizf.supabase.co'
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_wQ6UUNhMZI3D1yk_G-FJEw_F6Er5-6y'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// ─── TABLE : app_requests ────────────────────────────────────────────────────
// Stockage JSON des demandes pour la phase de test.
// En production, migrer vers la table normalisée "demandes".
// SQL à exécuter dans Supabase → SQL Editor :
//
//   CREATE TABLE app_requests (
//     id         TEXT PRIMARY KEY,
//     data       JSONB NOT NULL,
//     dept       TEXT,
//     statut     TEXT,
//     created_at TIMESTAMPTZ DEFAULT NOW(),
//     updated_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   ALTER TABLE app_requests ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "public_read_write" ON app_requests FOR ALL USING (true);
//   -- Remplacer cette politique par des règles SSO en production

// ─── TABLE : app_delegates ───────────────────────────────────────────────────
// SQL :
//   CREATE TABLE app_delegates (
//     id TEXT PRIMARY KEY, data JSONB NOT NULL,
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   ALTER TABLE app_delegates ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "public_read_write" ON app_delegates FOR ALL USING (true);

// ─── TABLE : app_agrafes ─────────────────────────────────────────────────────
// SQL :
//   CREATE TABLE app_agrafes (
//     id TEXT PRIMARY KEY, data JSONB NOT NULL,
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   ALTER TABLE app_agrafes ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "public_read_write" ON app_agrafes FOR ALL USING (true);

// ─── TABLE : app_config ──────────────────────────────────────────────────────
// SQL :
//   CREATE TABLE app_config (
//     key TEXT PRIMARY KEY, value JSONB NOT NULL,
//     updated_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "public_read_write" ON app_config FOR ALL USING (true);

// ─── DATA LAYER ──────────────────────────────────────────────────────────────

export const db = {
  supabase, // expose client for direct queries (auth, etc.)

  // DEMANDES
  async loadRequests() {
    const { data, error } = await supabase
      .from('app_requests')
      .select('data')
      .order('created_at', { ascending: false })
    if (error) { console.error('Supabase load requests:', error.message); return null }
    return data.map(r => r.data)
  },

  async upsertRequest(req) {
    const { error } = await supabase
      .from('app_requests')
      .upsert({
        id: req.id,
        data: req,
        dept: req.dept,
        statut: req.statut,
        updated_at: new Date().toISOString()
      })
    if (error) console.error('Supabase upsert request:', error.message)
  },

  async deleteRequest(id) {
    const { error } = await supabase.from('app_requests').delete().eq('id', id)
    if (error) console.error('Supabase delete request:', error.message)
  },

  // DÉLÉGUÉS
  async loadDelegates() {
    const { data, error } = await supabase.from('app_delegates').select('data')
    if (error) { console.error('Supabase load delegates:', error.message); return null }
    return data.map(r => r.data)
  },

  async upsertDelegate(d) {
    const { error } = await supabase.from('app_delegates').upsert({ id: d.id, data: d })
    if (error) console.error('Supabase upsert delegate:', error.message)
  },

  async deleteDelegate(id) {
    const { error } = await supabase.from('app_delegates').delete().eq('id', id)
    if (error) console.error('Supabase delete delegate:', error.message)
  },

  // AGRAFES
  async loadAgrafes() {
    const { data, error } = await supabase.from('app_agrafes').select('data')
    if (error) { console.error('Supabase load agrafes:', error.message); return null }
    return data.map(r => r.data)
  },

  async upsertAgrafe(a) {
    const { error } = await supabase.from('app_agrafes').upsert({ id: a.id, data: a })
    if (error) console.error('Supabase upsert agrafe:', error.message)
  },

  async deleteAgrafe(id) {
    const { error } = await supabase.from('app_agrafes').delete().eq('id', id)
    if (error) console.error('Supabase delete agrafe:', error.message)
  },

  // CONFIG (tarif, welcome messages, dept disabled)
  async loadConfig(key) {
    // maybeSingle() renvoie null proprement (HTTP 200) quand la ligne n'existe
    // pas, au lieu d'un 406 bruyant en console avec single().
    const { data, error } = await supabase.from('app_config').select('value').eq('key', key).maybeSingle()
    if (error) { console.error('Supabase load config:', error.message); return null }
    return data?.value
  },

  async saveConfig(key, value) {
    const { error } = await supabase.from('app_config').upsert({
      key,
      value: typeof value === 'object' ? value : { v: value },
      updated_at: new Date().toISOString()
    })
    if (error) console.error('Supabase save config:', error.message)
  },

  // DÉPARTEMENTS (adresse, email, ID PS)
  async loadDepartments() {
    const { data, error } = await supabase.from('app_departments').select('*')
    if (error) { console.error('Supabase load departments:', error.message); return null }
    return Object.fromEntries(data.map(r => [r.dept_code, r.data]))
  },

  async upsertDepartment(deptCode, data) {
    const { error } = await supabase.from('app_departments').upsert({
      dept_code: deptCode,
      data,
      updated_at: new Date().toISOString()
    })
    if (error) console.error('Supabase upsert department:', error.message)
  },

  // AUDIT LOG
  async logAudit(entry) {
    const { error } = await supabase.from('app_audit_log').insert({
      user_email: entry.userEmail,
      user_role:  entry.userRole,
      action:     entry.action,
      request_id: entry.requestId || null,
      details:    entry.details   || null,
      created_at: new Date().toISOString()
    })
    if (error) console.error('Supabase audit log:', error.message)
  },

  async loadAuditLog(requestId = null, limit = 100) {
    let q = supabase.from('app_audit_log').select('*').order('created_at', { ascending: false }).limit(limit)
    if (requestId) q = q.eq('request_id', requestId)
    const { data, error } = await q
    if (error) { console.error('Supabase load audit:', error.message); return [] }
    return data
  },

  // BROUILLON CROSS-SESSION
  // Stocké dans app_config sous la clé `draft:<email>` (pas de table dédiée à créer).
  // Permet de retrouver le brouillon en cours sur n'importe quelle session/appareil.
  async saveDraft(email, data) {
    if (!email) return
    const { error } = await supabase.from('app_config').upsert({
      key: `draft:${email}`,
      value: data,
      updated_at: new Date().toISOString()
    })
    if (error) console.error('Supabase save draft:', error.message)
  },

  async loadDraft(email) {
    if (!email) return null
    const { data, error } = await supabase.from('app_config').select('value').eq('key', `draft:${email}`).maybeSingle()
    if (error) { console.error('Supabase load draft:', error.message); return null }
    return data?.value || null
  },

  async clearDraft(email) {
    if (!email) return
    const { error } = await supabase.from('app_config').delete().eq('key', `draft:${email}`)
    if (error) console.error('Supabase clear draft:', error.message)
  },
}
