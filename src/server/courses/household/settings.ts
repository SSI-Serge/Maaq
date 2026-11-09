import { sql, type Kysely } from "kysely";
import { open, seal } from "@/server/assistant/fields";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { emailFingerprint } from "@/server/security/crypto";
import { integerSetting } from "@/server/settings";
import { placeKey } from "../catalog/seed";

/**
 * Droits, réglages du foyer (US-153) et partage anonyme des prix (US-154). Le droit est celui de la base (`grocery_access`) : le couple (utilisateur principal et invité 1)
 * a tout ; un invité secondaire ne voit que la liste de courses et peut y ajouter un produit (CR-10).
 */

export type CourseAccess = "couple" | "list";

export const courseError = (code: string, message: string, status = 409, details?: unknown) => new Rejection(code, message, status, details);

export async function accessOf(db: Kysely<DB>, userId: string): Promise<CourseAccess | null> {
  const r = await sql<{ a: CourseAccess | null }>`select grocery_access(${userId}::uuid) as a`.execute(db);
  return r.rows[0]?.a ?? null;
}

/** Le profil connecté et son droit ; refuse un profil qui n'a aucun droit sur l'agent (administrateur, compte en attente…). */
export async function requireAccess(ctx: Ctx, session: SessionContext, needs: CourseAccess = "list"): Promise<{ accountId: string; userId: string; access: CourseAccess }> {
  const accountId = session.user.accountId;
  if (!accountId || session.user.role === "admin") throw courseError("forbidden", "Cette fonction n'est pas disponible pour ce profil.", 403);
  const access = await accessOf(ctx.db, session.user.id);
  if (!access || (needs === "couple" && access !== "couple")) throw courseError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  return { accountId, userId: session.user.id, access };
}

export interface SettingsOptions {
  cuisines: { id: number; name: string }[];
  diets: { id: number; name: string }[];
  allergens: { id: number; name: string }[];
  defaultRepeatWeeks: number;
}

export interface SettingsView {
  city: string | null;
  householdSize: number | null;
  /** Jours de courses, 1 (lundi) à 7 (dimanche). */
  shoppingDays: number[];
  goals: { time: boolean; ownDishes: boolean; season: boolean };
  repeatWeeks: number | null;
  replacementSource: "own" | "cuisine";
  replacementCuisineId: number | null;
  budgetDay: number;
  /** Budget mensuel des repas en euros (hors restaurant, boissons et réceptions) : le menu du mois dans le budget le compare au coût de 4 semaines (CR-59) ; vide tant qu'il n'est pas renseigné. */
  monthlyBudget: number | null;
  sharePrices: boolean;
  cuisineIds: number[];
  stores: { chain: string; city: string }[];
  /** Régimes et allergies : filtrage indicatif par MAAQ, jamais envoyés à l'agent (CR-16). */
  diets: string[];
  allergens: string[];
  allergyText: string;
  /** Réglages demandés au premier lancement qui manquent (US-153 RF1). */
  missing: string[];
  /** Prénoms des deux parents du couple (« Communs à Camille et Julien »). */
  couple: string[];
  options: SettingsOptions;
  consentText: string;
}

export const CONSENT_LABEL = "provisoire";
export const CONSENT_TEXT = "Les prix de vos tickets sont ajoutés, sans votre nom, à une base commune. En échange, vous voyez les prix relevés par les autres foyers.";

/** Remet une clé en forme pour l'affichage : « nantes » → « Nantes », « lidl » → « Lidl » (la base garde les minuscules, CR-25). */
export function displayPlace(key: string): string {
  return key.replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
}

interface Dietary {
  diets: string[];
  allergens: string[];
  text: string;
}

function readDietary(blob: Buffer | null, other: Buffer | null): Dietary {
  const diets: string[] = [];
  const allergens: string[] = [];
  let text = "";
  try {
    if (blob) diets.push(...(JSON.parse(open(blob)) as { diets: string[] }).diets);
    if (other) {
      const a = JSON.parse(open(other)) as { allergens: string[]; text: string };
      allergens.push(...a.allergens);
      text = a.text;
    }
  } catch {
    // contenu illisible : on repart de réglages vides plutôt que de bloquer l'écran
  }
  return { diets, allergens, text };
}

async function loadOptions(db: Kysely<DB>): Promise<SettingsOptions> {
  const [cuisines, tags, repeat] = await Promise.all([
    db.selectFrom("meal_cuisines").select(["id", "name"]).where("is_hidden", "=", false).orderBy("sort_order").orderBy("id").execute(),
    db.selectFrom("meal_dish_tags").select(["id", "kind", "name"]).where("is_hidden", "=", false).orderBy("sort_order").orderBy("id").execute(),
    integerSetting(db, "meal_repeat_weeks_default", 2),
  ]);
  return {
    cuisines,
    diets: tags.filter((t) => t.kind === "diet").map(({ id, name }) => ({ id, name })),
    allergens: tags.filter((t) => t.kind === "allergen").map(({ id, name }) => ({ id, name })),
    defaultRepeatWeeks: repeat,
  };
}

/** Réglages du foyer : réservés au couple (US-153 RF5). */
export async function getSettings(ctx: Ctx, session: SessionContext): Promise<SettingsView> {
  const who = await requireAccess(ctx, session, "couple");
  return loadSettings(ctx.db, who.accountId);
}

export async function loadSettings(db: Kysely<DB>, accountId: string): Promise<SettingsView> {
  const [row, cuisines, stores, dietary, options, parents] = await Promise.all([
    db.selectFrom("grocery_household_settings").selectAll().where("account_id", "=", accountId).executeTakeFirst(),
    db.selectFrom("grocery_household_cuisines").select("cuisine_id").where("account_id", "=", accountId).execute(),
    db.selectFrom("grocery_household_stores").select(["store_chain", "store_city"]).where("account_id", "=", accountId).orderBy("id").execute(),
    db.selectFrom("grocery_household_dietary").select(["diets_encrypted", "allergies_encrypted"]).where("account_id", "=", accountId).executeTakeFirst(),
    loadOptions(db),
    db.selectFrom("users").select(["first_name", "role", "guest_rank"]).where("account_id", "=", accountId).where("status", "in", ["active", "grace_period"]).orderBy("created_at").execute(),
  ]);
  const diet = readDietary(dietary?.diets_encrypted ?? null, dietary?.allergies_encrypted ?? null);
  const goals = { time: row?.goal_time ?? false, ownDishes: row?.goal_own_dishes ?? false, season: row?.goal_season ?? false };
  const missing: string[] = [];
  if (!row?.city) missing.push("city");
  if (!row?.household_size) missing.push("householdSize");
  if (!row?.shopping_days?.length) missing.push("shoppingDays");
  if (!cuisines.length) missing.push("cuisines");
  if (!goals.time && !goals.ownDishes && !goals.season) missing.push("goals");
  return {
    city: row?.city ?? null,
    householdSize: row?.household_size ?? null,
    shoppingDays: row?.shopping_days ?? [],
    goals,
    repeatWeeks: row?.repeat_weeks ?? null,
    replacementSource: (row?.replacement_source as "own" | "cuisine" | undefined) ?? "own",
    replacementCuisineId: row?.replacement_cuisine_id ?? null,
    budgetDay: row?.budget_day ?? 1,
    monthlyBudget: row?.monthly_meal_budget === null || row?.monthly_meal_budget === undefined ? null : Number(row.monthly_meal_budget),
    sharePrices: row?.share_prices ?? false,
    cuisineIds: cuisines.map((c) => c.cuisine_id).sort((a, b) => a - b),
    stores: stores.map((s) => ({ chain: displayPlace(s.store_chain), city: displayPlace(s.store_city) })),
    diets: diet.diets,
    allergens: diet.allergens,
    allergyText: diet.text,
    missing,
    couple: parents.filter((u) => u.role === "primary_user" || (u.role === "guest" && u.guest_rank === "core")).map((u) => u.first_name),
    options,
    consentText: CONSENT_TEXT,
  };
}

export interface SettingsInput {
  city?: string | null;
  householdSize?: number | null;
  shoppingDays?: number[];
  goals?: { time?: boolean; ownDishes?: boolean; season?: boolean };
  repeatWeeks?: number | null;
  replacementSource?: "own" | "cuisine";
  replacementCuisineId?: number | null;
  budgetDay?: number;
  monthlyBudget?: number | null;
  cuisineIds?: number[];
  stores?: { chain: string; city: string }[];
  diets?: string[];
  allergens?: string[];
  allergyText?: string;
}

/** Messages des gardes de la base traduits pour l'utilisateur ; le reste remonte tel quel. */
export function translateCourseError(error: unknown): unknown {
  const e = error as { code?: string; message?: string; constraint?: string };
  if (e?.code === "23514" || e?.code === "23503") {
    if (/looks_like_address|city/.test(`${e.constraint ?? ""} ${e.message ?? ""}`)) return courseError("invalid_city", "Indiquez une ville, pas une adresse.", 422);
    if (e.constraint === "ck_grocery_household_share_city") return courseError("city_required", "Indiquez d'abord votre ville.", 409);
    if (/réservé|invité secondaire|Un invité/.test(e.message ?? "")) return courseError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  }
  return error;
}

const MAX_STORES = 30;

/** Enregistre les réglages communs au couple (US-153) : le partage des prix ne change que par `setSharing` (preuve de consentement, US-154). */
export async function saveSettings(ctx: Ctx, session: SessionContext, input: SettingsInput): Promise<SettingsView> {
  const who = await requireAccess(ctx, session, "couple");
  const city = input.city === undefined ? undefined : input.city === null || !input.city.trim() ? null : input.city.trim();
  if (city && city.length > 80) throw courseError("invalid_city", "Indiquez une ville, pas une adresse.", 422);
  if (input.householdSize !== undefined && input.householdSize !== null && (input.householdSize < 1 || input.householdSize > 12)) throw courseError("invalid_size", "Le foyer compte de 1 à 12 personnes.", 422);
  if (input.shoppingDays && input.shoppingDays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) throw courseError("invalid_days", "Jours de courses non valides.", 422);
  if (input.budgetDay !== undefined && (!Number.isInteger(input.budgetDay) || input.budgetDay < 1 || input.budgetDay > 31)) throw courseError("invalid_budget_day", "Le jour du budget va de 1 à 31.", 422);
  if (input.repeatWeeks !== undefined && input.repeatWeeks !== null && (input.repeatWeeks < 1 || input.repeatWeeks > 4)) throw courseError("invalid_repeat", "Un plat ne revient pas avant 1 à 4 semaines.", 422);
  if (input.monthlyBudget !== undefined && input.monthlyBudget !== null && (!Number.isFinite(input.monthlyBudget) || input.monthlyBudget < 1 || input.monthlyBudget > 99999)) throw courseError("invalid_budget", "Le budget mensuel va de 1 à 99 999 €.", 422);
  if (input.stores && input.stores.length > MAX_STORES) throw courseError("too_many_stores", `Au plus ${MAX_STORES} enseignes.`, 422);
  const source = input.replacementSource;
  if (source === "cuisine" && !input.replacementCuisineId) throw courseError("cuisine_required", "Choisissez la cuisine des remplacements.", 422);
  const now = ctx.now;
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      const set: Record<string, unknown> = { updated_by_user_id: who.userId, updated_at: now };
      if (city !== undefined) set.city = city;
      if (input.householdSize !== undefined) set.household_size = input.householdSize;
      if (input.shoppingDays) set.shopping_days = [...new Set(input.shoppingDays)].sort((a, b) => a - b);
      if (input.goals) {
        if (input.goals.time !== undefined) set.goal_time = input.goals.time;
        if (input.goals.ownDishes !== undefined) set.goal_own_dishes = input.goals.ownDishes;
        if (input.goals.season !== undefined) set.goal_season = input.goals.season;
      }
      if (input.repeatWeeks !== undefined) set.repeat_weeks = input.repeatWeeks;
      if (source !== undefined) {
        set.replacement_source = source;
        set.replacement_cuisine_id = source === "cuisine" ? (input.replacementCuisineId ?? null) : null;
      }
      if (input.budgetDay !== undefined) set.budget_day = input.budgetDay;
      if (input.monthlyBudget !== undefined) set.monthly_meal_budget = input.monthlyBudget === null ? null : input.monthlyBudget.toFixed(2);
      await trx
        .insertInto("grocery_household_settings")
        .values({ account_id: who.accountId, ...set } as never)
        .onConflict((oc) => oc.column("account_id").doUpdateSet(set as never))
        .execute();
      if (input.cuisineIds) {
        await trx.deleteFrom("grocery_household_cuisines").where("account_id", "=", who.accountId).execute();
        const ids = [...new Set(input.cuisineIds)];
        if (ids.length) await trx.insertInto("grocery_household_cuisines").values(ids.map((id) => ({ account_id: who.accountId, cuisine_id: id }))).execute();
      }
      if (input.stores) {
        await trx.deleteFrom("grocery_household_stores").where("account_id", "=", who.accountId).execute();
        const seen = new Set<string>();
        const rows = input.stores
          .map((s) => ({ account_id: who.accountId, store_chain: placeKey(s.chain).slice(0, 80), store_city: placeKey(s.city).slice(0, 80) }))
          .filter((s) => s.store_chain && s.store_city && !seen.has(`${s.store_chain}|${s.store_city}`) && seen.add(`${s.store_chain}|${s.store_city}`));
        if (rows.length) await trx.insertInto("grocery_household_stores").values(rows).execute();
      }
      if (input.diets || input.allergens || input.allergyText !== undefined) {
        const current = await trx.selectFrom("grocery_household_dietary").select(["diets_encrypted", "allergies_encrypted"]).where("account_id", "=", who.accountId).executeTakeFirst();
        const before = readDietary(current?.diets_encrypted ?? null, current?.allergies_encrypted ?? null);
        const diets = input.diets ?? before.diets;
        const allergens = input.allergens ?? before.allergens;
        const allergyText = (input.allergyText ?? before.text).slice(0, 500);
        const dietBlob = diets.length ? seal(JSON.stringify({ diets })) : null;
        const allergyBlob = allergens.length || allergyText ? seal(JSON.stringify({ allergens, text: allergyText })) : null;
        await trx
          .insertInto("grocery_household_dietary")
          .values({ account_id: who.accountId, diets_encrypted: dietBlob, allergies_encrypted: allergyBlob, updated_by_user_id: who.userId, updated_at: now })
          .onConflict((oc) => oc.column("account_id").doUpdateSet({ diets_encrypted: dietBlob, allergies_encrypted: allergyBlob, updated_by_user_id: who.userId, updated_at: now }))
          .execute();
      }
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return loadSettings(ctx.db, who.accountId);
}

/** Le texte de consentement au partage des prix : celui du DPO s'il est publié, sinon le texte provisoire (comme pour l'analyse des contrats). */
async function consentVersion(db: Kysely<DB>, now: Date): Promise<{ id: string }> {
  const find = () =>
    db.selectFrom("legal_document_versions").select("id").where("document_type", "=", "grocery_price_sharing_consent").where("published_at", "<=", now).orderBy("published_at", "desc").orderBy("id", "desc").executeTakeFirst();
  const existing = await find();
  if (existing) return existing;
  await db
    .insertInto("legal_document_versions")
    .values({ document_type: "grocery_price_sharing_consent", version_label: CONSENT_LABEL, content: CONSENT_TEXT, published_at: new Date(0) })
    .onConflict((oc) => oc.columns(["document_type", "version_label"]).doNothing())
    .execute();
  const created = await find();
  if (!created) throw new Error("Aucun texte de consentement publié");
  return created;
}

/**
 * Active ou désactive le partage anonyme des prix (US-154). La preuve (profil, date, version du texte) est inscrite AVANT le changement du réglage (CR-24) ;
 * désactiver arrête les envois suivants, les lignes déjà partagées restent, anonymes (RF5).
 */
export async function setSharing(ctx: Ctx, session: SessionContext, share: boolean): Promise<SettingsView> {
  const who = await requireAccess(ctx, session, "couple");
  const version = await consentVersion(ctx.db, ctx.now);
  const fingerprint = emailFingerprint(session.user.email, Buffer.from(env().HMAC_KEY, "base64"));
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      const current = await trx.selectFrom("grocery_household_settings").select(["share_prices", "city"]).where("account_id", "=", who.accountId).executeTakeFirst();
      if ((current?.share_prices ?? false) === share) return;
      if (share && !current?.city) throw courseError("city_required", "Indiquez d'abord votre ville.", 409);
      await trx
        .insertInto("grocery_price_sharing_events")
        .values({ account_id: who.accountId, actor_user_id: who.userId, actor_email_hash: fingerprint, action_type: share ? "granted" : "withdrawn", legal_version_id: version.id, occurred_at: ctx.now })
        .execute();
      // la ligne existe forcément ici (on ne change le partage que depuis un réglage déjà enregistré) : une mise à jour, pas un ajout
      await trx.updateTable("grocery_household_settings").set({ share_prices: share, updated_by_user_id: who.userId, updated_at: ctx.now }).where("account_id", "=", who.accountId).execute();
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return loadSettings(ctx.db, who.accountId);
}
