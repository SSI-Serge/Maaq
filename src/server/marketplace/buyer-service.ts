import type { Kysely } from "kysely";
import { z } from "zod";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { db } from "@/server/db/client";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { DbMatchStore } from "./match-db-store";
import type { MarketplacePrefs, MatchStore } from "./match-store";
import type { ServiceCategory } from "./model";
import { CONSENT_TEXT, CONSENT_VERSION } from "./rules";

/**
 * Marketplace silencieux côté acheteur, pour l'application : magasin partagé par l'agent coup_de_main, le
 * traitement périodique et l'écran Réglages › Suggestions de services (consentement, catégories coupées).
 */

let store: MatchStore | undefined;

export function matchStore(connection: Kysely<DB> = db()): MatchStore {
  store ??= new DbMatchStore(connection);
  return store;
}

export interface PrefsView {
  prefs: MarketplacePrefs;
  categories: ServiceCategory[];
  consentText: string;
  consentVersion: string;
}

export const prefsPatchSchema = z.object({
  suggestionsOptIn: z.boolean().optional(),
  mutedCategories: z.array(z.string().regex(/^[a-z0-9_]+$/)).max(50).optional(),
});

export type PrefsPatchInput = z.infer<typeof prefsPatchSchema>;

function requireMember(session: SessionContext): string {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur ne reçoit pas de suggestions.", 403);
  return session.user.id;
}

export async function getPrefsView(ctx: Ctx, session: SessionContext): Promise<PrefsView> {
  const source = matchStore(ctx.db);
  const userId = requireMember(session);
  const [prefs, categories] = await Promise.all([source.getPrefs(userId), source.listCategories()]);
  return { prefs, categories, consentText: CONSENT_TEXT, consentVersion: CONSENT_VERSION };
}

/** Consentement aux suggestions proactives et catégories coupées ; l'agenda reste inactif (stocké, jamais modifié ici). */
export async function updatePrefs(ctx: Ctx, session: SessionContext, patch: PrefsPatchInput): Promise<PrefsView> {
  const source = matchStore(ctx.db);
  const userId = requireMember(session);
  if (patch.mutedCategories) {
    const known = new Set((await source.listCategories()).map((c) => c.code));
    const unknown = patch.mutedCategories.find((code) => !known.has(code));
    if (unknown) throw new Rejection("unknown_category", "Cette catégorie n'existe pas.");
  }
  await source.setPrefs(userId, { ...patch, ...(patch.suggestionsOptIn ? { consentVersion: CONSENT_VERSION } : {}) });
  return getPrefsView(ctx, session);
}
