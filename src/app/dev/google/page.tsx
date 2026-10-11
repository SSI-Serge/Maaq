import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { devDigitorn } from "@/server/adapters/digitorn";
import { reportRevokedAuthorization } from "@/server/connectors/service";
import { db } from "@/server/db/client";
import { isDevToolsEnabled } from "@/server/dev-tools";
import { Button, Card, Eyebrow, Screen } from "@/components/ui";

export const dynamic = "force-dynamic";

const SERVICE = { google_drive: "Google Drive", google_calendar: "Google Agenda" } as const;

async function decide(formData: FormData) {
  "use server";
  if (!isDevToolsEnabled()) return;
  const state = String(formData.get("etat") ?? "");
  const outcome = String(formData.get("resultat") ?? "");
  const other = String(formData.get("autre_compte") ?? "").trim();
  if (outcome === "authorized" || outcome === "partial" || outcome === "denied") {
    devDigitorn().completeConsent(state, outcome, outcome === "authorized" && other ? other : undefined);
  }
  redirect(`/connecteurs/retour?etat=${encodeURIComponent(state)}`);
}

async function revoke(formData: FormData) {
  "use server";
  if (!isDevToolsEnabled()) return;
  await reportRevokedAuthorization(
    { db: db(), now: new Date() },
    {
      profileRef: String(formData.get("profil")),
      connector: String(formData.get("connecteur")) as "google_drive" | "google_calendar",
      email: String(formData.get("email")),
    },
  );
  revalidatePath("/dev/google");
}

/**
 * Page de développement qui remplace le consentement Google (US-14) : choisir ce que l'utilisateur
 * ferait sur la vraie page, puis revenir dans MAAQ. Sans paramètre, permet de simuler une
 * autorisation retirée depuis le compte Google (statut « À reconnecter »).
 */
export default async function GoogleSimulationPage({ searchParams }: { searchParams: Promise<{ etat?: string }> }) {
  const { etat } = await searchParams;
  const pending = etat ? devDigitorn().pendingAuthorization(etat) : null;

  const connections = await db()
    .selectFrom("agent_connections as c")
    .innerJoin("users as u", "u.id", "c.user_id")
    .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
    .innerJoin("agents as a", "a.id", "c.agent_id")
    .select(["u.first_name", "u.digitorn_user_ref", "t.code", "c.connected_email", "a.name"])
    .where("c.status", "=", "connected")
    .where("t.code", "in", ["google_drive", "google_calendar"])
    .execute();

  return (
    <Screen>
      <Link href="/" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>
        ← Retour
      </Link>
      <h1 style={{ fontSize: 24, margin: "16px 0 6px" }}>Google simulé</h1>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 16px", lineHeight: 1.5 }}>
        Remplace la page de consentement Google en développement. Aucun vrai compte Google n&apos;est utilisé.
      </p>

      {etat && !pending && (
        <Card>
          <p style={{ margin: 0, fontSize: 14 }}>Cette demande d&apos;autorisation n&apos;existe plus (le simulateur a redémarré). Reprenez la connexion depuis MAAQ.</p>
        </Card>
      )}

      {pending && (
        <form action={decide} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input type="hidden" name="etat" value={etat} />
          <Card>
            <Eyebrow>Demande d&apos;accès</Eyebrow>
            <p style={{ fontSize: 15, fontWeight: 600, margin: "8px 0 4px" }}>MAAQ demande l&apos;accès à {SERVICE[pending.connector]}</p>
            <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: 0 }}>Compte visé : {pending.email}</p>
          </Card>
          <label style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-soft)", display: "flex", flexDirection: "column", gap: 6 }}>
            Compte réellement choisi (facultatif, pour « Autoriser »)
            <input
              name="autre_compte"
              type="email"
              placeholder="autre.compte@gmail.test"
              style={{ padding: "12px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-raised)", fontSize: 14 }}
            />
          </label>
          <Button type="submit" name="resultat" value="authorized" block>
            Autoriser
          </Button>
          <Button type="submit" name="resultat" value="partial" variant="secondary" block>
            Autoriser une partie des permissions
          </Button>
          <Button type="submit" name="resultat" value="denied" variant="secondary" block>
            Refuser
          </Button>
        </form>
      )}

      {!etat && (
        <>
          <h2 style={{ fontSize: 18, margin: "8px 0 10px" }}>Simuler une autorisation retirée</h2>
          {connections.length === 0 && <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>Aucun compte Google connecté pour l&apos;instant.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {connections.map((c) => (
              <Card key={`${c.digitorn_user_ref}-${c.code}-${c.name}`}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>
                  {c.name} — {SERVICE[c.code as keyof typeof SERVICE]}
                </div>
                <div style={{ fontSize: 13, color: "var(--ink-soft)", margin: "2px 0 10px" }}>
                  {c.first_name} · {c.connected_email}
                </div>
                <form action={revoke}>
                  <input type="hidden" name="profil" value={c.digitorn_user_ref ?? ""} />
                  <input type="hidden" name="connecteur" value={c.code} />
                  <input type="hidden" name="email" value={c.connected_email} />
                  <Button type="submit" variant="secondary">
                    Retirer l&apos;autorisation côté Google
                  </Button>
                </form>
              </Card>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}
