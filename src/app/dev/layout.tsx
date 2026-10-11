import { notFound } from "next/navigation";
import { isDevToolsEnabled } from "@/server/dev-tools";

/** Les outils de développement n'existent jamais en production. */
export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (!isDevToolsEnabled()) notFound();
  return children;
}
