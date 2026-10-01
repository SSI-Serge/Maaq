"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";

type Category = "pro" | "perso" | "contracts";
type Scope = "each_profile" | "primary_user" | "account";

interface Sheet {
  id: string;
  name: string;
  category: Category;
  categoryLabel: string;
  shortDescription: string;
  description: string;
  examples: string[];
  requirements: { connector: string; label: string; scope: Scope }[];
  needsGeneralInfo: boolean;
  validatedActions: string[];
  maintenance: boolean;
  added: boolean;
  inCategory: number;
  max: number;
}

interface AddResult {
  category: Category;
  categoryLabel: string;
  agentName: string;
  status: "ready" | "to_configure" | "blocked";
  needsInfo: boolean;
  alreadyAdded: boolean;
}

const SCOPE_TEXT: Record<Scope, string> = {
  each_profile: "à connecter par chaque profil",
  primary_user: "à connecter par l'utilisateur principal",
  account: "connexion unique du compte, faite par l'utilisateur principal",
};

/** Fiche descriptive d'un agent et ajout à son dashboard (US-24, US-26, US-27), maquette Fiche. */
export default function AgentSheetPage() {
  return (
    <Suspense>
      <AgentSheet />
    </Suspense>
  );
}

function AgentSheet() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const sheet = useApiQuery<Sheet>(`/api/catalog/agents/${id}`);

  // Le retour ramène au catalogue, dans la rubrique et avec la recherche en cours (US-24 RF5).
  const back = new URLSearchParams();
  const fromCategory = params.get("categorie");
  if (fromCategory) back.set("categorie", fromCategory);
  if (params.get("q")) back.set("q", params.get("q")!);
  const backHref = `/catalogue${back.size ? `?${back.toString()}` : ""}`;

  return (
    <AppShell title="Fiche de l'agent" back={{ href: backHref, label: "Catalogue" }}>
      {sheet.loading && !sheet.data && <Loading slow={sheet.slow} />}
      {sheet.error && !sheet.data && <RetryNotice message={sheet.error.message} onRetry={sheet.reload} />}
      {sheet.data && <SheetBody sheet={sheet.data} onChanged={sheet.reload} />}
    </AppShell>
  );
}

function SheetBody({ sheet, onChanged }: { sheet: Sheet; onChanged: () => void }) {
  const router = useRouter();
  const add = useApiMutation();
  const [done, setDone] = useState<AddResult | null>(null);
  const limit = add.error?.body?.code === "limit_reached" ? (add.error.body.details as { category: Category; categoryLabel: string; max: number }) : null;

  async function addToDashboard() {
    const result = await add.run<AddResult>("/api/dashboard/agents", { method: "POST", body: { agentId: sheet.id } });
    if (!result) return;
    setDone(result);
    onChanged();
    // L'agent demande des informations non encore fournies : le formulaire s'ouvre aussitôt (US-10 RF12).
    if (result.needsInfo && !result.alreadyAdded) router.push(`/informations/${sheet.id}?retour=${encodeURIComponent("/accueil")}`);
  }

  const dashboardHref = "/accueil";
  const added = sheet.added || done !== null;

  return (
    <>
      <div className={s.cardActions}>
        <div>
          <div className={s.agentName} style={{ fontSize: 20 }}>
            {sheet.name}
          </div>
          <p className={s.muted}>{sheet.shortDescription}</p>
        </div>
        <span className={`${s.badge} ${s.neutral}`}>{sheet.categoryLabel}</span>
      </div>

      {sheet.maintenance && <Notice tone="warning">Cet agent est temporairement en maintenance.</Notice>}

      <Section title="À quoi il sert">
        <p className={s.text} style={{ whiteSpace: "pre-wrap" }}>
          {sheet.description}
        </p>
      </Section>

      {sheet.examples.length > 0 && (
        <Section title="Exemples de demandes">
          {sheet.examples.map((example) => (
            <div key={example} className={s.listLine}>
              <span aria-hidden>›</span>
              <span>« {example} »</span>
            </div>
          ))}
        </Section>
      )}

      <Section title="Ce qu'il faut configurer">
        {sheet.needsGeneralInfo && (
          <div className={s.listLine}>
            <span aria-hidden>●</span>
            <span>Quelques informations vous concernant, demandées à l&apos;ajout</span>
          </div>
        )}
        {sheet.requirements.map((r) => (
          <div key={r.connector} className={s.listLine}>
            <span aria-hidden>●</span>
            <span>
              {r.label} <span className={s.muted}>— {SCOPE_TEXT[r.scope]}</span>
            </span>
          </div>
        ))}
        {!sheet.needsGeneralInfo && sheet.requirements.length === 0 && <p className={s.muted}>Rien à configurer : cet agent est utilisable dès l&apos;ajout.</p>}
        <p className={s.muted}>
          Cet agent apparaîtra {sheet.category === "contracts" ? "dans l'onglet Agents des Contrats de la page Contrats" : `dans l'onglet ${sheet.categoryLabel} de votre dashboard`}. Rien à saisir
          maintenant : la fiche informe sur la configuration, elle ne la demande pas.
        </p>
      </Section>

      {sheet.validatedActions.length > 0 && (
        <Section title="Actions soumises à votre validation">
          {sheet.validatedActions.map((action) => (
            <div key={action} className={s.listLine}>
              <span aria-hidden>✓</span>
              <span>{action}</span>
            </div>
          ))}
          <p className={s.muted}>L&apos;agent vous demande toujours votre accord avant d&apos;exécuter ces actions.</p>
        </Section>
      )}

      <div className={s.stickyAction}>
        {limit && (
          <Notice tone="error">
            {add.error!.message}{" "}
            <Link href={limit.category === "contracts" ? "/accueil" : dashboardHref} style={{ textDecoration: "underline" }}>
              Gérer mes agents {limit.categoryLabel} ›
            </Link>
          </Notice>
        )}
        {!limit && <ErrorLine error={add.error} onRetry={addToDashboard} />}
        {done && !done.alreadyAdded && (
          <Notice tone="success">
            {done.agentName} a été ajouté à votre onglet {done.categoryLabel}.{" "}
            <Link href={dashboardHref} style={{ textDecoration: "underline" }}>
              Voir mon dashboard ›
            </Link>
            {done.status === "to_configure" && !done.needsInfo && <> Cet agent est « À configurer ».</>}
          </Notice>
        )}
        {added ? (
          <Button block disabled>
            Déjà ajouté
          </Button>
        ) : (
          <Button block loading={add.pending} onClick={addToDashboard}>
            Ajouter à mon dashboard
          </Button>
        )}
      </div>
    </>
  );
}
