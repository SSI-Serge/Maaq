"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiQuery, useDebounced } from "@/client/hooks";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { Button, RetryNotice } from "@/components/ui";

type Category = "pro" | "perso" | "contracts";

interface Item {
  id: string;
  name: string;
  shortDescription: string;
  category: Category;
  categoryLabel: string;
  maintenance: boolean;
  added: boolean;
}

const LABEL: Record<Category, string> = { pro: "Pro", perso: "Perso", contracts: "Agents des Contrats" };
const MIN_SEARCH = 2;

/** Catalogue d'agents par rubrique, avec recherche toutes rubriques (US-23, US-25), maquette Catalogue. */
export default function CatalogPage() {
  return (
    <Suspense>
      <Catalog />
    </Suspense>
  );
}

function Catalog() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const initialCategory = params.get("categorie");
  const [category, setCategory] = useState<Category>(initialCategory === "perso" || initialCategory === "contracts" ? initialCategory : "pro");
  const [input, setInput] = useState(params.get("q") ?? "");
  const query = useDebounced(input.trim());
  const searching = query.length >= MIN_SEARCH;

  // La rubrique et la recherche en cours sont gardées dans l'adresse : la fiche y ramène (US-24 RF5).
  function syncUrl(nextCategory: Category, nextQuery: string) {
    const next = new URLSearchParams();
    next.set("categorie", nextCategory);
    if (nextQuery.trim().length >= MIN_SEARCH) next.set("q", nextQuery.trim());
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const url = searching ? `/api/catalog?q=${encodeURIComponent(query)}` : `/api/catalog?categorie=${category}`;
  const catalog = useApiQuery<{ categories: Category[]; agents: Item[] }>(url);
  const categories = catalog.data?.categories ?? ["pro", "perso", "contracts"];

  return (
    <AppShell title="Catalogue d'agents" back={{ href: "/accueil", label: "Dashboard" }}>
      <p className={s.muted}>Les agents mis à disposition par l&apos;administrateur, classés en 3 rubriques. Chaque agent n&apos;appartient qu&apos;à une seule.</p>

      <div className={s.searchBox}>
        <svg className={s.searchIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" />
        </svg>
        <input
          className={s.searchInput}
          type="search"
          aria-label="Rechercher un agent"
          placeholder="Rechercher (ex. mutuelle, courrier…)"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            syncUrl(category, e.target.value);
          }}
        />
        {input && (
          <button
            className={s.searchClear}
            aria-label="Effacer la recherche"
            onClick={() => {
              setInput("");
              syncUrl(category, "");
            }}
          >
            ×
          </button>
        )}
      </div>

      {!searching && (
        <div className={s.segments} role="tablist">
          {categories.map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={category === c}
              className={`${s.segment} ${category === c ? s.segmentOn : ""}`}
              onClick={() => {
                setCategory(c);
                syncUrl(c, "");
              }}
            >
              {LABEL[c]}
            </button>
          ))}
        </div>
      )}

      {searching && catalog.data && !catalog.loading && <div className={s.counter}>{catalog.data.agents.length} résultat{catalog.data.agents.length > 1 ? "s" : ""}</div>}

      {catalog.loading && (
        <>
          <div className={s.skeleton} aria-hidden />
          <div className={s.skeleton} aria-hidden />
          <div className={s.skeleton} aria-hidden />
        </>
      )}
      {catalog.error && !catalog.loading && <RetryNotice message={catalog.error.message} onRetry={catalog.reload} />}

      {!catalog.loading &&
        catalog.data?.agents.map((agent) => (
          <Link
            key={agent.id}
            href={`/catalogue/${agent.id}?categorie=${category}${searching ? `&q=${encodeURIComponent(query)}` : ""}`}
            className={s.agentCard}
          >
            <div className={s.cardActions}>
              <div className={s.agentName}>{agent.name}</div>
              <div style={{ display: "flex", gap: 4 }}>
                {agent.maintenance && <span className={`${s.badge} ${s.warn}`}>En maintenance</span>}
                {agent.added && <span className={`${s.badge} ${s.ok}`}>Ajouté</span>}
              </div>
            </div>
            {searching && <span className={s.rank} style={{ alignSelf: "flex-start", marginLeft: 0 }}>{agent.categoryLabel}</span>}
            <p className={s.muted}>{agent.shortDescription}</p>
            <span className={s.smallButton} style={{ alignSelf: "flex-start", padding: 0 }}>
              Voir la fiche ›
            </span>
          </Link>
        ))}

      {!catalog.loading && catalog.data && catalog.data.agents.length === 0 && !catalog.error && (
        <div className={s.empty}>
          {searching ? (
            <>
              <p className={s.text}>Aucun agent ne correspond à « {query} »</p>
              <Button
                variant="secondary"
                onClick={() => {
                  setInput("");
                  syncUrl(category, "");
                }}
              >
                Parcourir les rubriques
              </Button>
            </>
          ) : (
            <p className={s.text}>Aucun agent disponible dans cette rubrique pour le moment.</p>
          )}
        </div>
      )}
    </AppShell>
  );
}
