"use client";

import Link from "next/link";
import { useState } from "react";
import { MESSAGES } from "@/client/api";
import { Button, Card, Eyebrow, Field, Loading, Notice, RetryNotice, Screen } from "@/components/ui";

const COLORS = [
  "bg", "bg-raised", "bg-sunken", "ink", "ink-soft", "line",
  "primary", "primary-strong", "primary-soft", "secondary", "secondary-strong", "secondary-soft",
  "success", "success-bg", "warning", "warning-bg", "error", "error-bg",
];

/** Charte et composants de base, pour vérifier la fidélité aux maquettes. */
export default function StyleGuidePage() {
  const [loading, setLoading] = useState(false);

  function simulateLoading() {
    setLoading(true);
    setTimeout(() => setLoading(false), 2000);
  }

  return (
    <Screen>
      <Link href="/" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>← Retour</Link>
      <h1 style={{ fontSize: 24, margin: "16px 0 20px" }}>Charte et composants</h1>

      <Section title="Couleurs">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
          {COLORS.map((c) => (
            <div key={c} style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--ink-soft)" }}>
              <div style={{ height: 36, borderRadius: 8, background: `var(--${c})`, border: "1px solid var(--line)", marginBottom: 4 }} />
              {c}
            </div>
          ))}
        </div>
      </Section>

      <Section title="Typographie">
        <h1 style={{ fontSize: 26 }}>Bienvenue — Newsreader</h1>
        <p style={{ fontSize: 14, margin: "8px 0" }}>Texte courant — Karla. Vos agents IA pour l&apos;administratif et le quotidien.</p>
        <Eyebrow>Étiquette — IBM Plex Mono</Eyebrow>
      </Section>

      <Section title="Boutons">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button>Principal</Button>
          <Button variant="secondary">Secondaire</Button>
          <Button variant="ghost">Lien</Button>
          <Button variant="danger">Supprimer</Button>
          <Button disabled>Inactif</Button>
          <Button loading={loading} onClick={simulateLoading}>
            {loading ? "Envoi…" : "Tester le chargement"}
          </Button>
        </div>
      </Section>

      <Section title="Champs">
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Adresse email" type="email" placeholder="vous@exemple.fr" />
          <Field label="Mot de passe" type="password" placeholder="••••••••" hint="Au moins 10 caractères, dont une lettre et un chiffre." />
          <Field label="Téléphone" defaultValue="06 12" error="Le numéro de téléphone n'est pas valide." />
        </div>
      </Section>

      <Section title="Messages">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Notice tone="error">Trop de tentatives. Réessayez à partir de 14 h 32.</Notice>
          <Notice tone="warning">Cet agent n&apos;est pas encore configuré.</Notice>
          <Notice tone="success">Vos informations ont été enregistrées.</Notice>
          <Notice tone="info">L&apos;invitation a été envoyée.</Notice>
        </div>
      </Section>

      <Section title="Comportements communs (CC)">
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Loading />
          <Loading slow />
          <RetryNotice message={MESSAGES.server} onRetry={() => {}} />
          <RetryNotice message={MESSAGES.timeout} onRetry={() => {}} />
        </div>
      </Section>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <Card>
        <div style={{ marginBottom: 12 }}>
          <Eyebrow>{title}</Eyebrow>
        </div>
        {children}
      </Card>
    </section>
  );
}
