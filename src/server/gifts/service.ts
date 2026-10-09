import type { Kysely } from "kysely";
import { db } from "@/server/db/client";
import type { DB } from "@/server/db/schema.generated";
import { DbGiftStore } from "./db-store";
import { localDate, upcomingOccasions, type Occasion } from "./model";
import { DbPrefsStore, type PrefsStore } from "./prefs";
import type { GiftStore } from "./store";

/** Accès aux données de kdo_help en base (singletons sur la connexion de l'application). */

let store: GiftStore | undefined;
let prefs: PrefsStore | undefined;

export function giftStore(connection: Kysely<DB> = db()): GiftStore {
  store ??= new DbGiftStore(connection);
  return store;
}

export function prefsStore(connection: Kysely<DB> = db()): PrefsStore {
  prefs ??= new DbPrefsStore(connection);
  return prefs;
}

/** Occasions à venir d'un profil, dans la fenêtre donnée, au jour civil de son fuseau. */
export async function occasionsFor(source: GiftStore, userId: string, now: Date, timeZone: string, windowDays: number): Promise<Occasion[]> {
  const [people, events, states] = await Promise.all([source.listPeople(userId), source.listEvents(userId), source.listStates(userId)]);
  return upcomingOccasions({ people, events, states }, localDate(now, timeZone), windowDays);
}

/** Identifiant MAAQ d'un profil à partir de sa référence Digitorn (les agents locaux ne connaissent que celle-ci). */
export async function userIdOfRef(connection: Kysely<DB>, userRef: string): Promise<string | null> {
  const row = await connection.selectFrom("users").select("id").where("digitorn_user_ref", "=", userRef).executeTakeFirst();
  return row?.id ?? null;
}
