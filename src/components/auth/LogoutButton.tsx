"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/client/auth";
import { Button } from "@/components/ui";
import { ConfirmDialog } from "./parts";

/**
 * Bouton « Se déconnecter » des Réglages (US-9). Utilisateur et invité sont prévenus que
 * l'historique des tchats sera effacé ; l'administrateur, qui n'a pas de tchat, non (RF2, RF3).
 * Même si le serveur ne répond pas, l'appareil est déconnecté (RF8, RF9).
 */
export function LogoutButton({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    await signOut();
    router.replace("/connexion");
  }

  return (
    <>
      <Button variant="secondary" block onClick={() => setAsking(true)}>
        Se déconnecter
      </Button>
      {asking && (
        <ConfirmDialog
          title="Vous déconnecter ?"
          text={
            isAdmin
              ? undefined
              : "L'historique de vos conversations avec les agents sera effacé. Votre carnet de bord est conservé."
          }
          confirmLabel="Se déconnecter"
          confirming={pending}
          onConfirm={confirm}
          onCancel={() => setAsking(false)}
        />
      )}
    </>
  );
}
