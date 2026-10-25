-- Notifications web (US-94, US-81 RF6, RT3) : un abonnement par appareil et par navigateur.
-- La table des appareils est propre à chaque profil (un téléphone partagé par deux profils = deux lignes), donc l'abonnement
-- appartient au bon profil. Il disparaît avec l'appareil, à la déconnexion et à la révocation (US-94 RF9).
CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   uuid NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  -- Adresse du service de notification du navigateur (Apple, Google, Mozilla) : propre à une installation
  endpoint    text NOT NULL UNIQUE CHECK (endpoint LIKE 'https://%'),
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_push_subscriptions_device ON push_subscriptions (device_id);
COMMENT ON TABLE push_subscriptions IS $$Abonnement aux notifications web d'un appareil. Les clés servent à chiffrer chaque notification pour cet appareil seul. [US-94 RT2]$$;
COMMENT ON COLUMN push_subscriptions.endpoint IS $$Adresse du service de notification du navigateur ; une adresse devenue invalide (404, 410) entraîne la suppression de l'abonnement [US-81 RT4]$$;
