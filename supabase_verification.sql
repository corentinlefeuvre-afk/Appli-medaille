-- ════════════════════════════════════════════════════════════════════════════
--  VÉRIFICATION DE LA BASE — Appli Médaille FNPC
--  À coller dans Supabase → SQL Editor → Run.
--  Renvoie un tableau (élément / état). Copier-coller le résultat à Claude.
-- ════════════════════════════════════════════════════════════════════════════

with checks as (

  -- ─── Tables (7 attendues) ───────────────────────────────────────────────
  select 1 as ord, 'Table app_requests'        as element, (to_regclass('public.app_requests')   is not null) as ok union all
  select 2,        'Table app_agrafes',         (to_regclass('public.app_agrafes')     is not null) union all
  select 3,        'Table app_delegates',       (to_regclass('public.app_delegates')   is not null) union all
  select 4,        'Table app_config',          (to_regclass('public.app_config')      is not null) union all
  select 5,        'Table app_departments',     (to_regclass('public.app_departments') is not null) union all
  select 6,        'Table app_audit_log',       (to_regclass('public.app_audit_log')   is not null) union all
  select 7,        'Table app_users',           (to_regclass('public.app_users')       is not null) union all

  -- ─── Colonnes clés app_requests ─────────────────────────────────────────
  select 10, 'app_requests.data (JSONB)',  exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_requests' and column_name='data') union all
  select 11, 'app_requests.dept',          exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_requests' and column_name='dept') union all
  select 12, 'app_requests.statut',        exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_requests' and column_name='statut') union all

  -- ─── Colonnes clés app_users ────────────────────────────────────────────
  select 20, 'app_users.dept',             exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='dept') union all
  select 21, 'app_users.roles',            exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='roles') union all
  select 22, 'app_users.antenne',          exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='antenne') union all

  -- ─── Sécurité 1.4.0 (hachage des mots de passe) ─────────────────────────
  select 30, 'SECU app_users.password_hash présente', exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='password_hash') union all
  select 31, 'SECU ancienne colonne password SUPPRIMÉE', not exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_users' and column_name='password') union all
  select 32, 'SECU fonction verify_login présente', exists(select 1 from pg_proc where proname='verify_login') union all
  select 33, 'SECU extension pgcrypto activée', exists(select 1 from pg_extension where extname='pgcrypto') union all

  -- ─── app_departments : bonne clé ────────────────────────────────────────
  select 40, 'app_departments.dept_code', exists(select 1 from information_schema.columns where table_schema='public' and table_name='app_departments' and column_name='dept_code')

)
select
  element                                  as "Élément",
  case when ok then '✅ OK' else '❌ MANQUANT' end as "État"
from checks
order by ord;


-- ════════════════════════════════════════════════════════════════════════════
--  (Optionnel) À lancer SÉPARÉMENT — l'éditeur n'affiche que le dernier résultat.
-- ════════════════════════════════════════════════════════════════════════════

-- A) Nombre de lignes par table (sanity check)
-- select 'app_requests' as t, count(*) from app_requests
-- union all select 'app_users',       count(*) from app_users
-- union all select 'app_agrafes',     count(*) from app_agrafes
-- union all select 'app_delegates',   count(*) from app_delegates
-- union all select 'app_config',      count(*) from app_config
-- union all select 'app_departments', count(*) from app_departments
-- union all select 'app_audit_log',   count(*) from app_audit_log;

-- B) Clés de configuration présentes (doit contenir groupements, diploma_templates, etc.)
-- select key from app_config order by key;

-- C) Comptes et leur département (pour le souci de visibilité antenne/APC)
-- select email, role, roles, dept, antenne, actif from app_users order by role, email;

-- D) Demandes sans département (les « fantômes » invisibles pour antenne/APC)
-- select id, dept, statut from app_requests where dept is null or dept = '';

-- E) État RLS de chaque table
-- select relname as table, relrowsecurity as rls_active
-- from pg_class where relnamespace = 'public'::regnamespace
--   and relname like 'app_%' order by relname;
