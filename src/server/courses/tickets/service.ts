import { sql } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { nameKey, placeKey } from "../catalog/seed";
import { allowed, applyTicket, intersect, ingPhrases, round2, tokens, ticketTotal, type Ticket } from "../engine";
import { courseError, displayPlace, loadSettings, requireAccess, translateCourseError } from "../household/settings";
import { loadEngineData } from "../menu/data";
import { maskTicketText } from "./mask";
import { ticketReader, TicketReaderError, type TicketImage } from "./reader";
import { normalizeDraft, ticketStructurer, type TicketDraft } from "./structure";

/**
 * Tickets de caisse (US-161, US-160) : lecture d'une ou plusieurs photos par le service de lecture de MAAQ, masquage du texte, mise en forme par le modèle, correction ligne
 * par ligne par l'utilisateur, puis enregistrement. Aucune photo n'est conservée (CR-05) : elles ne sont lues qu'en mémoire, le temps de la lecture.
 */

const MAX_IMAGES = 3;
const MAX_BYTES = 10 * 1024 * 1024;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIN_TEXT = 20;

export interface TicketReadResult {
  draft: TicketDraft;
  /** Total des lignes lues (somme des prix de ligne). */
  total: number;
  /** Ce ticket (même magasin, même date, même total) est déjà enregistré. */
  duplicate: boolean;
  aisles: string[];
  /** Passages du texte masqués avant l'envoi au modèle (carte, nom, prénom du caissier…). */
  masked: number;
}

const todayOf = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

async function receiptsFor(ctx: Ctx, accountId: string) {
  return ctx.db.selectFrom("grocery_receipts").select(["store_chain", "purchased_on", "total_amount"]).where("account_id", "=", accountId).execute();
}

const day = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : todayOf(value));

/** Un ticket déjà enregistré se reconnaît au même magasin, à la même date et au même total (US-161 RT2). */
async function isKnown(ctx: Ctx, accountId: string, ticket: { store: string; date: string; total: number }): Promise<boolean> {
  const store = placeKey(ticket.store);
  return (await receiptsFor(ctx, accountId)).some((r) => r.store_chain === store && day(r.purchased_on as Date | string) === ticket.date && round2(Number(r.total_amount)) === round2(ticket.total));
}

/** Lit un ticket (une à trois photos) et le met en forme pour correction. Le couple seulement (CR-10). */
export async function readTicket(ctx: Ctx, session: SessionContext, images: TicketImage[]): Promise<TicketReadResult> {
  const who = await requireAccess(ctx, session, "couple");
  if (!images.length || images.length > MAX_IMAGES) throw courseError("invalid_photos", `Envoyez de 1 à ${MAX_IMAGES} photos du ticket.`, 422);
  for (const image of images) {
    if (!MIMES.has(image.mime)) throw courseError("invalid_photo_type", "Envoyez des photos au format JPEG, PNG ou WebP.", 422);
    if (image.content.length > MAX_BYTES) throw courseError("photo_too_large", "Une photo dépasse 10 Mo : reprenez-la en plus petit.", 413);
  }
  const reader = ticketReader();
  const structurer = ticketStructurer();
  if (!reader || !structurer) throw courseError("reader_unavailable", "La lecture des tickets n'est pas disponible pour le moment.", 503);

  let text: string;
  try {
    text = (await reader.read(images)).text;
  } catch (error) {
    if (error instanceof TicketReaderError && error.failure === "unreadable") text = "";
    else throw courseError("reader_unavailable", "La lecture des tickets n'est pas disponible pour le moment. Réessayez dans quelques instants.", 503);
  }
  const aislesRows = await ctx.db.selectFrom("grocery_aisles").select("name").where("is_hidden", "=", false).orderBy("sort_order").execute();
  const aisles = aislesRows.map((a) => a.name);
  const settings = await loadSettings(ctx.db, who.accountId);
  const masked = maskTicketText(text);
  let draft: TicketDraft;
  if (masked.text.replace(/\s/g, "").length < MIN_TEXT) {
    draft = normalizeDraft(null, aisles, todayOf(ctx.now));
  } else {
    let answer: unknown;
    try {
      answer = await structurer.structure({ text: masked.text, aisles });
    } catch {
      throw courseError("reader_unavailable", "La mise en forme du ticket n'est pas disponible pour le moment. Réessayez dans quelques instants.", 503);
    }
    draft = normalizeDraft(answer, aisles, todayOf(ctx.now));
  }
  // ville du magasin : celle d'une enseigne du foyer de même nom, à défaut de celle lue
  if (draft.store && !draft.city) draft.city = settings.stores.find((s) => placeKey(s.chain) === placeKey(draft.store))?.city ?? null;
  const total = round2(draft.lines.reduce((s, l) => s + l.total, 0));
  const duplicate = draft.readable && draft.store ? await isKnown(ctx, who.accountId, { store: draft.store, date: draft.date, total }) : false;
  return { draft, total, duplicate, aisles, masked: masked.masked };
}

export interface TicketInput {
  store: string;
  city: string | null;
  date: string;
  lines: { product: string; reference: string | null; total: number; qty: number; aisle: string }[];
}

export interface TicketConfirmation {
  duplicate: boolean;
  recorded: number;
  total: number;
  /** Produits de la liste de courses trouvés sur le ticket : ils en sortent. */
  removed: string[];
  /** Rayons dont le budget est mis à jour. */
  aisles: string[];
  /** Prix ajoutés, sans le foyer, à la base commune. */
  shared: number;
  /** Identifiant du ticket, pour proposer un menu à partir de ce qui a été acheté. */
  receiptId: string | null;
}

/** Enregistre un ticket confirmé (US-161 RF5) : prix et journal d'achats, produits retirés de la liste, budget, base commune si le foyer partage. Un doublon est ignoré. */
export async function confirmTicket(ctx: Ctx, session: SessionContext, input: TicketInput): Promise<TicketConfirmation> {
  const who = await requireAccess(ctx, session, "couple");
  const store = input.store.trim().replace(/\s+/g, " ");
  if (!store || store.length > 80) throw courseError("invalid_store", "Indiquez l'enseigne du ticket (80 caractères au plus).", 422);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(Date.parse(`${input.date}T12:00:00Z`)) || input.date > todayOf(new Date(ctx.now.getTime() + 86_400_000))) throw courseError("invalid_date", "La date du ticket n'est pas valable.", 422);
  if (!input.lines.length || input.lines.length > 100) throw courseError("invalid_lines", "Un ticket compte de 1 à 100 lignes.", 422);
  const city = input.city?.trim() ? input.city.trim().slice(0, 80) : null;

  const aisleRows = await ctx.db.selectFrom("grocery_aisles").select(["id", "name"]).execute();
  const aisleId = new Map(aisleRows.map((a) => [nameKey(a.name), a.id]));
  const lines = input.lines.map((l, i) => {
    const product = l.product.trim().replace(/\s+/g, " ");
    const id = aisleId.get(nameKey(l.aisle));
    if (!product || product.length > 120) throw courseError("invalid_line", `Ligne ${i + 1} : indiquez le produit (120 caractères au plus).`, 422);
    if (!Number.isFinite(l.total) || l.total === 0 || Math.abs(l.total) > 10_000) throw courseError("invalid_line", `Ligne ${i + 1} : le prix doit être un montant non nul.`, 422);
    if (!Number.isFinite(l.qty) || l.qty <= 0 || l.qty > 999) throw courseError("invalid_line", `Ligne ${i + 1} : la quantité doit être supérieure à 0.`, 422);
    if (!id) throw courseError("invalid_line", `Ligne ${i + 1} : rayon inconnu.`, 422);
    return { product, reference: l.reference?.trim().slice(0, 160) || null, total: round2(l.total), qty: l.qty, aisle: l.aisle, aisleId: id };
  });
  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  if (await isKnown(ctx, who.accountId, { store, date: input.date, total })) return { duplicate: true, recorded: 0, total, removed: [], aisles: [], shared: 0, receiptId: null };

  const open = await ctx.db
    .selectFrom("grocery_list_items")
    .select(["id", "label"])
    .where("account_id", "=", who.accountId)
    .where("state", "in", ["validated", "added_after_validation"])
    .execute();
  const ticket: Ticket = { store, date: input.date, lines: lines.map((l) => ({ product: l.product, ref: l.reference ?? "", total: l.total, qty: l.qty, rayon: l.aisle })) };
  const outcome = applyTicket(ticket, [], open.map((o) => o.label));
  const removedLabels = new Set(outcome.removedFromList);

  let receiptId = "";
  let shared = 0;
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      const receipt = await trx
        .insertInto("grocery_receipts")
        .values({ account_id: who.accountId, store_chain: placeKey(store).slice(0, 80), store_city: city ? placeKey(city).slice(0, 80) : null, purchased_on: input.date as never, total_amount: total.toFixed(2), recorded_by_user_id: who.userId, created_at: ctx.now })
        .returning("id")
        .executeTakeFirstOrThrow();
      receiptId = receipt.id;
      const keys = lines.map((l) => nameKey(l.product).slice(0, 120));
      const products = await trx.selectFrom("grocery_products").select(["id", "name_key"]).where("name_key", "in", keys).execute();
      const byKey = new Map(products.map((p) => [p.name_key, p.id]));
      await trx
        .insertInto("grocery_receipt_lines")
        .values(lines.map((l, i) => ({ receipt_id: receipt.id, account_id: who.accountId, position: i + 1, label: l.product, name_key: keys[i], reference_name: l.reference, line_total: l.total.toFixed(2), quantity: l.qty.toFixed(3), aisle_id: l.aisleId, product_id: byKey.get(keys[i]) ?? null })))
        .execute();
      // produits de la liste trouvés sur le ticket : cochés « acheté » (ils sortent de la liste et rejoignent l'historique)
      const ids = open.filter((o) => removedLabels.has(o.label)).map((o) => o.id);
      if (ids.length) await trx.updateTable("grocery_list_items").set({ state: "bought", bought_at: ctx.now, bought_by_user_id: who.userId, updated_at: ctx.now }).where("id", "in", ids).execute();
      for (const [i, l] of lines.entries()) {
        const unit = l.total / l.qty;
        const productId = byKey.get(keys[i]);
        if (productId && l.total > 0 && city && l.reference) {
          const done = await sql<{ id: string | null }>`select share_grocery_price(${who.accountId}::uuid, ${productId}::bigint, ${l.reference}, ${unit.toFixed(2)}::numeric, ${store}, ${city}, ${input.date}::date) as id`.execute(trx);
          if (done.rows[0]?.id) shared += 1;
        }
        if (!productId) {
          await sql`select note_grocery_unreferenced(${who.accountId}::uuid, ${l.product}, 'unknown'::grocery_unreferenced_kind, 'ticket'::grocery_unreferenced_source, ${l.aisleId}::integer, ${city}, ${l.reference}, ${l.total > 0 ? unit.toFixed(2) : null}::numeric, ${store})`.execute(trx);
        }
      }
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return { duplicate: true, recorded: 0, total, removed: [], aisles: [], shared: 0, receiptId: null };
    throw translateCourseError(error);
  }
  return { duplicate: false, recorded: lines.length, total: ticketTotal(ticket), removed: outcome.removedFromList, aisles: [...new Set(lines.map((l) => l.aisle))], shared, receiptId };
}

export interface TicketMenuIdea {
  id: string;
  name: string;
  minutes: number;
  /** Ingrédients du plat que le ticket couvre. */
  have: string[];
  /** Ingrédients qui restent à acheter. */
  missing: string[];
}

/** Plats dont les ingrédients correspondent à ce que le foyer vient d'acheter, avec ce qui reste à acheter (US-160). Le filtrage des allergies et des régimes reste appliqué. */
export async function menuFromTicket(ctx: Ctx, session: SessionContext, receiptId: string): Promise<TicketMenuIdea[]> {
  const who = await requireAccess(ctx, session, "couple");
  const lines = await ctx.db.selectFrom("grocery_receipt_lines").select(["label", "line_total"]).where("account_id", "=", who.accountId).where("receipt_id", "=", receiptId).execute();
  if (!lines.length) throw courseError("not_found", "Ce ticket n'existe pas.", 404);
  const bought = new Set<string>();
  for (const l of lines) if (Number(l.line_total) > 0) for (const t of tokens(l.label)) bought.add(t);
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings);
  const ideas: (TicketMenuIdea & { score: number })[] = [];
  for (const d of data.dishes) {
    if (!allowed(d, data.profile)) continue;
    const phrases = ingPhrases(d.ing);
    if (!phrases.length) continue;
    const have = phrases.filter((p) => intersect(tokens(p), bought).size > 0);
    if (!have.length) continue;
    const missing = phrases.filter((p) => !have.includes(p));
    ideas.push({ id: d.id, name: d.name, minutes: d.minutes, have, missing, score: have.length / phrases.length + have.length * 0.05 });
  }
  return ideas
    .sort((a, b) => b.score - a.score || a.minutes - b.minutes)
    .slice(0, 3)
    .map((idea) => ({ id: idea.id, name: idea.name, minutes: idea.minutes, have: idea.have, missing: idea.missing }));
}

export { displayPlace };
