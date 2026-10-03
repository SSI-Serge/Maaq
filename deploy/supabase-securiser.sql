-- À exécuter UNE FOIS dans Supabase (SQL Editor), après avoir appliqué les migrations de MAAQ.
--
-- Pourquoi : Supabase expose par défaut les tables du schéma « public » sur Internet, par une interface web
-- (Data API) accessible avec une clé publique. MAAQ n'en a pas besoin : il se connecte directement à la base avec
-- le rôle « postgres ». Ce script ferme cette porte, au cas où la Data API serait activée :
--   1. active la sécurité par ligne (RLS) sur toutes les tables, sans aucune règle d'accès : rien ne passe ;
--   2. retire tous les droits aux rôles publics « anon » et « authenticated » ;
--   3. fait de même pour les objets créés par les prochaines migrations.
-- Le rôle « postgres » (propriétaire des tables, utilisé par MAAQ) n'est pas concerné.
-- À relancer après chaque migration qui ajoute des tables.

DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;

-- Contrôle : toutes les lignes doivent afficher « true » dans la colonne rls_active.
SELECT tablename, rowsecurity AS rls_active FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;
