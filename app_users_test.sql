-- ============================================================
-- FNPC — Table des utilisateurs + comptes de test
-- À exécuter dans Supabase (SQL Editor).
-- La colonne "roles" (CSV) liste les rôles autorisés pour un
-- même compte : si > 1, un sélecteur de vue apparaît dans l'app.
-- ============================================================

create table if not exists app_users (
  id         uuid primary key default gen_random_uuid(),
  email      text unique not null,
  password   text not null,          -- en clair pour la recette ; à hacher / remplacer par SSO en prod
  nom        text,
  prenom     text,
  role       text not null,          -- rôle par défaut à la connexion
  roles      text,                   -- rôles autorisés, séparés par des virgules (multi-rôles)
  dept       text,
  antenne    text,
  actif      boolean default true,
  created_at timestamptz default now()
);

-- Compte 1 : Antenne + Département (APC) — peut basculer entre les deux vues
-- Compte 2 : Commission FNPC uniquement
insert into app_users (email, password, nom, prenom, role, roles, dept, antenne, actif) values
  ('terrain.test@fnpc.fr',    'Test2026!', 'TERRAIN',    'Compte', 'antenne',    'antenne,departement', '75 - Paris Seine', 'Paris 12ème', true),
  ('commission.test@fnpc.fr', 'Test2026!', 'COMMISSION', 'Compte', 'commission', 'commission',          null,               null,          true)
on conflict (email) do update set
  password = excluded.password,
  role     = excluded.role,
  roles    = excluded.roles,
  dept     = excluded.dept,
  antenne  = excluded.antenne,
  actif    = true;

-- Identifiants :
--   terrain.test@fnpc.fr    / Test2026!   (Antenne + APC, sélecteur de vue)
--   commission.test@fnpc.fr / Test2026!   (Commission FNPC)
