import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { requireFamilyProfile, requireParent } from "./family";

/**
 * Zone scolaire de la famille (A, B ou C), pour l'option « Sauf vacances scolaires » des séries (US-109 RF4). Lisible par tout profil de la famille, modifiable
 * par les parents seuls. Sans zone réglée, l'option n'est pas proposée.
 */

export type SchoolZone = "A" | "B" | "C";

export interface SchoolZoneSetting {
  zone: SchoolZone | null;
  canEdit: boolean;
  /** Des vacances sont chargées pour la zone choisie : sans elles, « Sauf vacances scolaires » ne retirerait rien. */
  holidaysLoaded: boolean;
}

export async function getSchoolZone(ctx: Ctx, session: SessionContext): Promise<SchoolZoneSetting> {
  const { accountId, parent } = requireFamilyProfile(session);
  const row = await ctx.db.selectFrom("family_settings").select("school_zone").where("account_id", "=", accountId).executeTakeFirst();
  const zone = (row?.school_zone as SchoolZone | null | undefined) ?? null;
  const loaded = zone ? await ctx.db.selectFrom("school_holiday_periods").select("id").where("zone", "=", zone).limit(1).executeTakeFirst() : undefined;
  return { zone, canEdit: parent, holidaysLoaded: Boolean(loaded) };
}

export async function setSchoolZone(ctx: Ctx, session: SessionContext, zone: string | null): Promise<SchoolZoneSetting> {
  const accountId = requireParent(session);
  if (zone !== null && !["A", "B", "C"].includes(zone)) throw new Rejection("invalid_zone", "La zone scolaire est A, B ou C.", 422);
  await ctx.db
    .insertInto("family_settings")
    .values({ account_id: accountId, school_zone: zone, updated_by_user_id: session.user.id })
    .onConflict((oc) => oc.column("account_id").doUpdateSet({ school_zone: zone, updated_by_user_id: session.user.id }))
    .execute();
  return getSchoolZone(ctx, session);
}
