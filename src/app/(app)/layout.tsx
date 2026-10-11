import { AuthGate } from "@/components/auth/AuthGate";
import { UploadToaster } from "@/components/contracts/UploadToaster";

/** Tous les écrans de cette zone exigent une session déverrouillée. */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      {children}
      <UploadToaster />
    </AuthGate>
  );
}
