import { AuthGate } from "@/components/auth/AuthGate";

/** Tous les écrans de cette zone exigent une session déverrouillée. */
export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return <AuthGate>{children}</AuthGate>;
}
