-- MAAQ — rattrapage additif du lot 10 (décision D68) : sous-groupe « Concerts » dans les thèmes de sorties.
-- À appliquer UNE SEULE FOIS sur une base où le lot 10 est déjà appliqué. Une base construite avec le lot 10 régénéré (empreinte indiquée dans le message
-- de livraison) n'en a pas besoin : la colonne et les thèmes y sont déjà.
-- Une seule transaction. Additif : une colonne facultative et 18 lignes de catalogue (6 thèmes de concert pour « Pour moi », « En couple » et « Ados »,
-- aucun pour « Enfants de 3 à 10 ans »). Les thèmes déjà choisis par les parents ne sont pas touchés.

ALTER TABLE outing_themes
  ADD COLUMN theme_group text CHECK (theme_group ~ '^[a-z_]+$');

COMMENT ON COLUMN outing_themes.theme_group IS $$Sous-groupe d'affichage du thème (clé technique, par exemple « concerts » : l'écran range ces thèmes dans un sous-groupe repliable) ; vide = thème sans sous-groupe. Un thème d'un sous-groupe reste un thème ordinaire de sa catégorie (règle « au moins un thème », choix, idées). Le libellé du sous-groupe est porté par l'écran (D68)$$;

INSERT INTO outing_themes (category, theme_key, label, theme_group, sort_order) VALUES
  ('self', 'concert_world', 'Concert du monde', 'concerts', 10), ('self', 'concert_urban', 'Concert urbain', 'concerts', 11),
  ('self', 'concert_pop', 'Concert pop', 'concerts', 12), ('self', 'concert_hiphop', 'Concert hip-hop / rap', 'concerts', 13),
  ('self', 'concert_jazz', 'Concert jazz', 'concerts', 14), ('self', 'concert_rock', 'Concert rock', 'concerts', 15),
  ('couple', 'concert_world', 'Concert du monde', 'concerts', 9), ('couple', 'concert_urban', 'Concert urbain', 'concerts', 10),
  ('couple', 'concert_pop', 'Concert pop', 'concerts', 11), ('couple', 'concert_hiphop', 'Concert hip-hop / rap', 'concerts', 12),
  ('couple', 'concert_jazz', 'Concert jazz', 'concerts', 13), ('couple', 'concert_rock', 'Concert rock', 'concerts', 14),
  ('teens', 'concert_world', 'Concert du monde', 'concerts', 11), ('teens', 'concert_urban', 'Concert urbain', 'concerts', 12),
  ('teens', 'concert_pop', 'Concert pop', 'concerts', 13), ('teens', 'concert_hiphop', 'Concert hip-hop / rap', 'concerts', 14),
  ('teens', 'concert_jazz', 'Concert jazz', 'concerts', 15), ('teens', 'concert_rock', 'Concert rock', 'concerts', 16);
