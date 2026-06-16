-- ============================================================
-- FNPC - DELTA Supabase v1.0.2 (idempotent, ASCII pur)
-- A coller dans Supabase > SQL Editor > Run.
-- Rejouable sans erreur, ne supprime aucune donnee.
-- ============================================================


-- 1) NOUVELLE TABLE : app_departments
CREATE TABLE IF NOT EXISTS app_departments (
  dept_code  TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_departments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_write" ON app_departments;
CREATE POLICY "public_read_write" ON app_departments FOR ALL USING (true);


-- 2) NOUVELLE TABLE : app_audit_log
CREATE TABLE IF NOT EXISTS app_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_email  TEXT,
  user_role   TEXT,
  action      TEXT NOT NULL,
  request_id  TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE app_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_write" ON app_audit_log;
CREATE POLICY "public_read_write" ON app_audit_log FOR ALL USING (true);

CREATE INDEX IF NOT EXISTS idx_audit_request_id ON app_audit_log(request_id);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON app_audit_log(created_at DESC);


-- 3) (OPTIONNEL) Seed des configs pour eteindre les 406
--    Alternative au correctif .maybeSingle() cote code.
--    ON CONFLICT DO NOTHING : n ecrase jamais une valeur deja saisie.
INSERT INTO app_config (key, value) VALUES
  ('welcome_messages', '{}'::jsonb),
  ('dept_disabled',    '{}'::jsonb)
ON CONFLICT (key) DO NOTHING;


-- ============================================================
-- VERIFICATION
-- ============================================================

-- a) Les 6 tables existent ? (doit renvoyer 6 lignes)
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('app_requests','app_delegates','app_agrafes',
                     'app_config','app_departments','app_audit_log')
ORDER BY table_name;

-- b) RLS + policies
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public' AND tablename LIKE 'app_%'
ORDER BY tablename;

-- c) Index de l audit log
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'app_audit_log';
