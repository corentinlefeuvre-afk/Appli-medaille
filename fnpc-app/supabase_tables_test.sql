-- ============================================================
-- FNPC — Tables de test pour l'intégration Supabase
-- Coller dans Supabase → SQL Editor → Run and enable RLS
-- ============================================================

-- Table principale : demandes (stockage JSON pour phase test)
CREATE TABLE IF NOT EXISTS app_requests (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  dept       TEXT,
  statut     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE app_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_test" ON app_requests FOR ALL USING (true);

-- Table délégués
CREATE TABLE IF NOT EXISTS app_delegates (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE app_delegates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_test" ON app_delegates FOR ALL USING (true);

-- Table agrafes
CREATE TABLE IF NOT EXISTS app_agrafes (
  id         TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE app_agrafes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_test" ON app_agrafes FOR ALL USING (true);

-- Table configuration (tarif TDR, messages d'accueil, etc.)
CREATE TABLE IF NOT EXISTS app_config (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_all_test" ON app_config FOR ALL USING (true);

-- ============================================================
-- IMPORTANT : Ces politiques RLS "allow_all" sont uniquement
-- pour la phase de test. En production, remplacer par des
-- politiques basées sur le JWT du SSO.
-- ============================================================
