import { digitorn } from "@/server/adapters/digitorn";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { asRejection } from "@/server/digitorn-errors";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { getAgentInfoForm } from "@/server/profile/agent-info";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { blockedMessage, gateOf, isEmbedded, loadAgent, rankOf } from "./service";

/** Tchat embarqué de Digitorn (US-37) : lien de lancement, faits vérifiés et contexte de la page. */

/** Limite des faits vérifiés (`claims`) que Digitorn accepte. */
const MAX_CLAIMS_BYTES = 1000;

export interface EmbeddedChat {
  /**
   * Adresse du cadre. Avec la clé du projet : lien de lancement à usage unique, valable quelques minutes (à ne jamais
   * journaliser ni conserver). Sans clé : adresse publiée de l'application.
   */
  url: string;
  /** Origine du cadre, à qui l'on peut écrire (`postMessage`) et dont on accepte les messages. */
  origin: string;
  /** Fin de validité du lien de lancement ; null pour l'adresse publiée. */
  expiresAt: string | null;
  /** Digitorn reconnaît la personne (lien de lancement). Sinon elle reste un visiteur anonyme : rien n'est vérifié. */
  identified: boolean;
  /** Message `digitorn:context` : déclaré par MAAQ depuis le navigateur, donc non vérifié par Digitorn. */
  context: { page: { title: string; url: string }; data: Record<string, unknown> };
}

type MemberRank = "primary_user" | "core_guest" | "secondary_guest";

function memberRank(role: string, guestRank: string | null): MemberRank {
  if (role === "primary_user") return "primary_user";
  return guestRank === "core" ? "core_guest" : "secondary_guest";
}

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Faits que Digitorn doit croire : le rang du demandeur et les membres du compte, posés par notre serveur. Si tout ne
 * tient pas dans la limite, on retire d'abord les adresses email, puis la liste des membres.
 */
export function buildClaims(session: SessionContext, members: { firstName: string; email: string; rank: MemberRank }[]): Record<string, unknown> {
  const base = { app: "maaq", rank: rankOf(session), account: `maaq-acc-${session.user.accountId}` };
  const withEmail = { ...base, members: members.map((m) => ({ rank: m.rank, name: m.firstName, email: m.email })) };
  if (sizeOf(withEmail) <= MAX_CLAIMS_BYTES) return withEmail;
  const withoutEmail = { ...base, members: members.map((m) => ({ rank: m.rank, name: m.firstName })) };
  return sizeOf(withoutEmail) <= MAX_CLAIMS_BYTES ? withoutEmail : base;
}

/**
 * Prépare l'ouverture du tchat embarqué d'un agent pour le profil connecté. Mêmes garde-fous que le tchat construit par
 * MAAQ : agent présent sur le dashboard, non bloqué, informations de profil renseignées. Les connecteurs, eux, sont guidés par
 * le tchat de Digitorn.
 */
export async function openEmbeddedChat(ctx: Ctx, session: SessionContext, agentId: string): Promise<EmbeddedChat> {
  const agent = await loadAgent(ctx, session, agentId);
  if (!isEmbedded(agent)) throw new Rejection("not_embedded", "Cet agent n'a pas de tchat Digitorn intégré.", 409);
  const viaProject = agent.has_project && digitorn().embeddedChat;
  const blocked = blockedMessage(agent);
  if (blocked !== null) throw new Rejection("agent_blocked", `Cet agent est en maintenance : ${blocked}`, 409);
  if (await gateOf(ctx, session, agentId, { infoOnly: true })) throw new Rejection("agent_to_configure", "Cet agent doit d'abord être configuré.", 409);

  const people = await ctx.db
    .selectFrom("users")
    .select(["first_name", "email", "role", "guest_rank"])
    .where("account_id", "=", session.user.accountId!)
    .where("status", "in", ["active", "grace_period"])
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  const members = people.map((p) => ({ firstName: p.first_name, email: p.email, rank: memberRank(p.role, p.guest_rank) }));

  // Avec la clé du projet : lien de lancement, la personne est reconnue et les faits sont vérifiés. Sans clé : adresse publiée.
  let opened: { url: string; expiresAt: string | null } | null = null;
  if (viaProject) {
    const userRef = await ensureDigitornRef(ctx.db, session.user.id);
    opened = await digitorn()
      .openChat({ userRef, agentRef: agent.digitorn_agent_ref, name: session.user.firstName, claims: buildClaims(session, members) })
      .catch((error) => {
        throw asRejection(error);
      });
  }
  const identified = opened !== null;
  opened ??= agent.digitorn_app_url ? { url: agent.digitorn_app_url, expiresAt: null } : null;
  if (!opened) throw new Rejection("not_embedded", "Cet agent n'a pas de tchat Digitorn intégré.", 409);
  if (!/^https:\/\/[^\s]+$/.test(opened.url)) throw new Rejection("invalid_launch_url", "Digitorn a renvoyé un lien de tchat inattendu.", 502);

  const [form, cc] = await Promise.all([
    getAgentInfoForm(ctx, session, session.user.id, agentId),
    ctx.db.selectFrom("cc_addresses").select("email").where("user_id", "=", session.user.id).where("agent_id", "=", agentId).orderBy("created_at").orderBy("id").execute(),
  ]);

  return {
    url: opened.url,
    origin: new URL(opened.url).origin,
    expiresAt: opened.expiresAt,
    identified,
    context: {
      page: { title: `MAAQ — ${agent.name}`, url: `${env().APP_URL.replace(/\/$/, "")}/tchat/${agent.id}` },
      data: {
        settings: Object.fromEntries(form.fields.map((f) => [f.label, f.maxItems > 1 ? f.values : (f.values[0] ?? "")])),
        ccAddresses: cc.map((c) => c.email),
        timezone: session.device.timezone,
        language: "fr",
        // Visiteur anonyme : Digitorn ne peut pas recevoir de faits vérifiés, le rang et le foyer passent par la page (non vérifiés).
        ...(identified ? {} : { rank: rankOf(session), household: members.map((m) => ({ rank: m.rank, name: m.firstName, email: m.email })) }),
      },
    },
  };
}
