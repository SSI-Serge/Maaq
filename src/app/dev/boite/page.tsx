import Link from "next/link";
import { revalidatePath } from "next/cache";
import { devOutbox, messenger } from "@/server/adapters/messaging";
import { Button, Card, Eyebrow, Screen } from "@/components/ui";
import { isDevToolsEnabled } from "@/server/dev-tools";

export const dynamic = "force-dynamic";

async function sendTestEmail() {
  "use server";
  if (!isDevToolsEnabled()) return;
  await messenger().sendEmail({
    to: "camille@maaq.test",
    subject: "Email de test MAAQ",
    text: "Ceci est un email de test envoyé depuis la boîte de développement.",
  });
  revalidatePath("/dev/boite");
}

/** Boîte de test : tout ce que l'application « envoie » en développement arrive ici. */
export default async function OutboxPage() {
  const messages = await devOutbox().list();
  return (
    <Screen>
      <Link href="/" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>← Retour</Link>
      <h1 style={{ fontSize: 24, margin: "16px 0 6px" }}>Boîte de test</h1>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 16px", lineHeight: 1.5 }}>
        En développement, aucun email ni SMS ne part réellement : ils arrivent ici.
      </p>
      <form action={sendTestEmail} style={{ marginBottom: 18 }}>
        <Button variant="secondary" type="submit">Envoyer un email de test</Button>
      </form>
      {messages.length === 0 ? (
        <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>Aucun message pour l&apos;instant.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {messages.map((m) => (
            <Card key={m.id}>
              <Eyebrow>
                {m.channel === "email" ? "Email" : "SMS"} · {new Date(m.sentAt).toLocaleString("fr-FR")}
              </Eyebrow>
              <div style={{ fontSize: 13, marginTop: 6, color: "var(--ink-soft)" }}>À : {m.to}</div>
              {m.subject && <div style={{ fontWeight: 600, fontSize: 14, marginTop: 4 }}>{m.subject}</div>}
              <p style={{ fontSize: 14, margin: "8px 0 0", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.text}</p>
            </Card>
          ))}
        </div>
      )}
    </Screen>
  );
}
