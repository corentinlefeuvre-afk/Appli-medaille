-- ════════════════════════════════════════════════════════════════════════════
--  SÉCURITÉ — v1.4.0  (stopgap avant SSO Entra ID)
--  À exécuter dans Supabase → SQL Editor, AVANT de déployer l'app 1.4.0.
--
--  Objectif : supprimer la pire faille — mots de passe en clair lisibles via la
--  clé publique. Après ce script :
--    • les mots de passe sont HACHÉS (bcrypt via pgcrypto) ;
--    • la table app_users n'est plus lisible avec la clé publique ;
--    • la connexion passe par une fonction sécurisée verify_login() qui ne
--      renvoie jamais le hash et ne renvoie l'utilisateur que si le mot de
--      passe est correct.
--
--  Les comptes de test gardent les mêmes identifiants (ex : Test2026!).
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Extension de chiffrement (hachage bcrypt)
create extension if not exists pgcrypto;

-- 2) Colonne de hash
alter table app_users add column if not exists password_hash text;

-- 3) Hache les mots de passe en clair existants (données de test)
update app_users
   set password_hash = crypt(password, gen_salt('bf'))
 where password is not null
   and (password_hash is null or password_hash = '');

-- 4) Supprime la colonne en clair
alter table app_users drop column if exists password;

-- 5) Fonction de vérification de connexion (le hash n'est jamais exposé)
create or replace function verify_login(p_email text, p_password text)
returns table (
  id text, email text, nom text, prenom text,
  role text, roles text, dept text, antenne text
)
language sql
security definer
set search_path = public
as $$
  select u.id::text, u.email, u.nom, u.prenom,
         u.role, u.roles, u.dept, u.antenne
  from app_users u
  where u.email = lower(trim(p_email))
    and coalesce(u.actif, true) = true
    and u.password_hash = crypt(p_password, u.password_hash);
$$;

-- 6) Verrouille la table : plus aucun accès direct avec la clé publique.
--    Seule la fonction verify_login (SECURITY DEFINER) peut lire app_users.
revoke all on app_users from anon, authenticated;
grant execute on function verify_login(text, text) to anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
--  POUR CRÉER / METTRE À JOUR UN UTILISATEUR ENSUITE (depuis cet éditeur SQL) :
--
--    insert into app_users (email, password_hash, nom, prenom, role, roles, dept, antenne, actif)
--    values ('nouvel.apc@fnpc.fr', crypt('MotDePasse!', gen_salt('bf')),
--            'NOM', 'Prénom', 'departement', 'departement', '75 - Paris Seine', null, true);
--
--    -- changer un mot de passe :
--    update app_users set password_hash = crypt('NouveauMdp!', gen_salt('bf'))
--     where email = 'nouvel.apc@fnpc.fr';
-- ────────────────────────────────────────────────────────────────────────────
