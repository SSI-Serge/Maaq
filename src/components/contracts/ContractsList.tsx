"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { onUploadDone } from "@/client/uploads";
import { appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, RetryNotice } from "@/components/ui";
import type { CategoryView, ContractView, ContractsView } from "@/server/contracts/service";
import { ChannelSwitch, contractState, frDate, TONE_CLASS } from "./ContractParts";
import styles from "./contracts.module.css";

/**
 * « Mes contrats » (US-32, US-124) : les contrats regroupés par catégorie, dans l'ordre choisi par l'administrateur ; le contrat de base d'abord, puis les contrats
 * complémentaires. Chaque carte porte son état et ses deux interrupteurs ; le détail (nom, détails, documents, suppression) est un écran à part.
 */
export function ContractsList() {
  const user = useSessionUser();
  // Relecture passive (?auto=1) : elle ne prolonge pas le déverrouillage de l'application (US-52).
  const query = useApiQuery<ContractsView>("/api/contracts?auto=1");
  const { reload } = query;
  const [overrides, setOverrides] = useState<{ base: ContractsView | undefined; byId: Record<string, ContractView> }>({ base: undefined, byId: {} });
  const view = query.data;

  useEffect(() => onUploadDone(() => reload()), [reload]);

  if (query.loading && !view) {
    return (
      <>
        <div className={s.skeleton} aria-hidden />
        <div className={s.skeleton} aria-hidden />
        {query.slow && <Loading slow />}
      </>
    );
  }
  if (query.error && !view) return <RetryNotice message={query.error.message} onRetry={query.reload} />;
  if (!view) return null;

  const byId = overrides.base === view ? overrides.byId : {};
  const partner = user.role === "primary_user" ? "votre invité 1" : "l'utilisateur principal";

  return (
    <>
      <p className={styles.hint}>Ces contrats sont partagés avec {partner}. Activez l&apos;analyse ou le challenge contrat par contrat.</p>
      {view.categories.length === 0 && <p className={s.muted}>Aucune catégorie de contrat n&apos;est proposée pour le moment.</p>}
      {view.categories.map((category) => (
        <Category
          key={category.id}
          category={category}
          view={view}
          overrides={byId}
          onChanged={(updated) => setOverrides({ base: view, byId: { ...byId, [updated.id]: updated } })}
          onAdded={reload}
        />
      ))}
      <p className={styles.hint}>L&apos;analyse et le challenge sont désactivés par défaut : chacun demande votre accord, contrat par contrat.</p>
    </>
  );
}

function Category({
  category,
  view,
  overrides,
  onChanged,
  onAdded,
}: {
  category: CategoryView;
  view: ContractsView;
  overrides: Record<string, ContractView>;
  onChanged: (contract: ContractView) => void;
  onAdded: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const create = useApiMutation();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await create.run<ContractView>("/api/contracts", { method: "POST", body: { categoryId: category.id, name } });
    if (result) {
      setAdding(false);
      setName("");
      onAdded();
    }
  }

  return (
    <section className={`${styles.group} ${category.archived ? styles.groupArchived : ""}`}>
      <h2 className={styles.groupTitle}>
        {category.name}
        {category.archived && <span className={styles.archivedPill}>Catégorie archivée</span>}
      </h2>
      {category.archived && <p className={styles.hint}>Vos contrats restent consultables, sans transmission possible.</p>}
      {category.contracts.map((base) => {
        const contract = overrides[base.id] ?? base;
        const state = contractState(contract, category.archived);
        return (
          <article key={contract.id} className={styles.card}>
            <Link href={`/contrats/${contract.id}`} className={styles.cardLink}>
              <div className={styles.head}>
                <div>
                  <div className={styles.name}>{contract.name}</div>
                  <div className={styles.docMeta}>{contract.isBase ? "Contrat de base" : `Ajouté par ${contract.createdBy?.firstName ?? "un profil supprimé"} le ${frDate(contract.createdBy?.at ?? "")}`}</div>
                </div>
                <span className={`${styles.pill} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
              </div>
            </Link>
            <div className={styles.channels}>
              <ChannelSwitch contract={contract} channel="analysis" view={view} archived={category.archived} onChanged={onChanged} />
              <ChannelSwitch contract={contract} channel="challenge" view={view} archived={category.archived} onChanged={onChanged} />
            </div>
          </article>
        );
      })}
      {!category.archived &&
        (adding ? (
          <form className={styles.addForm} onSubmit={submit}>
            <label className={styles.label} htmlFor={`new-${category.id}`}>
              Nom du nouveau contrat
            </label>
            <input id={`new-${category.id}`} className={styles.input} maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Clio de Julien" />
            <ErrorLine error={create.error} />
            <div className={styles.choices}>
              <Button type="button" variant="secondary" onClick={() => { setAdding(false); create.reset(); }}>
                Annuler
              </Button>
              <Button type="submit" loading={create.pending} disabled={!name.trim()}>
                Créer
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Button variant="secondary" disabled={!category.canAdd} onClick={() => setAdding(true)}>
              + Ajouter un contrat
            </Button>
            {category.atLimit && <div className={styles.hint}>Nombre maximum de contrats atteint pour cette catégorie.</div>}
          </>
        ))}
    </section>
  );
}
