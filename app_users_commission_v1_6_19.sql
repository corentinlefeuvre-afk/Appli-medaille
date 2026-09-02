-- ════════════════════════════════════════════════════════════════════════════
--  COMPTES DE TEST — session Commission (v1.6.19)
--  À exécuter dans Supabase → SQL Editor.
--  Format conforme à la sécurisation v1.4.0 : mots de passe hachés bcrypt,
--  vérifiés par verify_login (avec anti brute-force v1.6.16 : 5 échecs → 15 min).
--
--  Chaque compte est MULTI-RÔLES (sélecteur de vue en haut de l'appli) :
--    · commission  → validation des dossiers (Validation en tableau, votes)
--    · departement → vue APC 75 (créer/valider des demandes, paramètres APC)
--    · antenne     → vue antenne (dépôt de demandes)
--  → permet la découverte générale ET la simulation des 2 validations.
-- ════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

insert into app_users (email, password_hash, nom, prenom, role, roles, dept, antenne, actif) values
  ('commission1.test@fnpc.fr', crypt('Medaille26!C1', gen_salt('bf')), 'COMMISSION', 'Membre 1', 'commission', 'commission,departement,antenne', '75 - Paris Seine', 'Paris 12ème', true),
  ('commission2.test@fnpc.fr', crypt('Medaille26!C2', gen_salt('bf')), 'COMMISSION', 'Membre 2', 'commission', 'commission,departement,antenne', '75 - Paris Seine', 'Paris 12ème', true)
on conflict (email) do update set
  password_hash = excluded.password_hash,
  role          = excluded.role,
  roles         = excluded.roles,
  dept          = excluded.dept,
  antenne       = excluded.antenne,
  actif         = true;

-- ── Identifiants à communiquer (e-mail d'invitation) ──────────────────────────
--   commission1.test@fnpc.fr  /  Medaille26!C1
--   commission2.test@fnpc.fr  /  Medaille26!C2
--
--   ⚠️ Il faut DEUX comptes distincts pour tester le passage 1/2 → 2/2 :
--   chaque membre vote avec le sien (le second vote du même compte est refusé).
--
-- ── Variante : un compte par membre réel ─────────────────────────────────────
--   Dupliquer une ligne VALUES par personne avec son e-mail réel et un mot de
--   passe individuel — recommandé si plus de 2 testeurs, pour un journal
--   d'audit nominatif.
--
-- ── Vérification ─────────────────────────────────────────────────────────────
--   select email, role, roles, actif from app_users where email like 'commission%';
