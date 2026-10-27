-- MAAQ — lot 6 : Rappels de tâches et point de la semaine : valeurs ajoutées à des types énumérés existants.
-- Fichier à part : une valeur ajoutée n'est utilisable qu'après validation de la transaction qui l'ajoute.
-- À appliquer AVANT lot_6_2_schema.sql.

ALTER TYPE notification_kind ADD VALUE 'task_daily' AFTER 'follow_up_48h';
ALTER TYPE notification_kind ADD VALUE 'task_due_1h' AFTER 'task_daily';
ALTER TYPE notification_kind ADD VALUE 'task_assigned' AFTER 'task_due_1h';
ALTER TYPE notification_kind ADD VALUE 'weekly_digest' AFTER 'task_assigned';
