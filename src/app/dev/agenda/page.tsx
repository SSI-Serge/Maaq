"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiAction, useApiQuery } from "@/client/hooks";
import { Button, Card, Eyebrow, Field, Loading, RetryNotice, Screen } from "@/components/ui";
import type { CalendarEvent } from "@/server/adapters/calendar/types";

interface Profile {
  id: string;
  email: string;
  firstName: string;
  events: CalendarEvent[];
}

/**
 * Agenda de démonstration (CALENDAR_MODE=dev) : ajouter des événements à un profil, puis lancer le passage du
 * marketplace silencieux pour voir coup_de_main poser sa question dans le tchat. Tient lieu du calendrier maître.
 */
export default function AgendaDemoPage() {
  const profiles = useApiQuery<{ profiles: Profile[] }>("/api/dev/agenda");
  const [email, setEmail] = useState("camille@maaq.test");
  const [title, setTitle] = useState("Coiffeur pour les enfants");
  const [date, setDate] = useState(() => new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10));
  const act = useApiAction<Record<string, unknown>, unknown>("/api/dev/agenda");
  const [scan, setScan] = useState<string | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (await act.run({ action: "add", email, title, date })) profiles.reload();
  }

  async function remove(profile: Profile, eventId: string) {
    if (await act.run({ action: "remove", email: profile.email, eventId })) profiles.reload();
  }

  async function runScan() {
    setScan(null);
    const result = await act.run({ action: "scan" });
    if (result) setScan(JSON.stringify(result, null, 2));
  }

  return (
    <Screen>
      <Eyebrow>Outils de développement</Eyebrow>
      <h1>Agenda de démonstration</h1>
      <p>
        Tient lieu du calendrier maître : les événements ajoutés ici sont lus par le marketplace silencieux pour les profils qui ont activé « Utiliser mon agenda » (Réglages › Suggestions de services). <Link href="/dev/whatsapp">WhatsApp</Link> · <Link href="/dev/boite">Boîte</Link>
      </p>
      <Card>
        <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="Email du profil" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Field label="Titre de l'événement" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Field label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button type="submit" loading={act.pending}>
            Ajouter l&apos;événement
          </Button>
        </form>
      </Card>
      <Card>
        <p>Lance le passage périodique (réexamen des demandes « me prévenir » et lecture des agendas) comme le ferait le serveur.</p>
        <Button type="button" variant="secondary" loading={act.pending} onClick={runScan}>
          Lancer le passage maintenant
        </Button>
        {act.error && <p style={{ color: "var(--error)" }}>{act.error.message}</p>}
        {scan && <pre style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{scan}</pre>}
      </Card>
      {profiles.loading && !profiles.data && <Loading slow={profiles.slow} />}
      {profiles.error && !profiles.data && <RetryNotice message={profiles.error.message} onRetry={profiles.reload} />}
      {profiles.data?.profiles
        .filter((p) => p.events.length)
        .map((profile) => (
          <Card key={profile.id}>
            <b>
              {profile.firstName} · {profile.email}
            </b>
            <ul>
              {profile.events.map((event) => (
                <li key={event.id}>
                  {event.date}
                  {event.time ? ` ${event.time}` : ""} — {event.title}{" "}
                  <button type="button" onClick={() => remove(profile, event.id)} style={{ background: "none", border: "none", color: "var(--error)", fontSize: 12 }}>
                    retirer
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        ))}
    </Screen>
  );
}
