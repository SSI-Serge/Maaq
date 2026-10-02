/**
 * Planificateur intégré : lance les traitements périodiques (synchronisation du carnet, nettoyages) toutes
 * les 5 minutes tant que le serveur tourne. En production, un planificateur externe peut appeler
 * `/api/cron/run` à la place (MAAQ_SCHEDULER=off pour désactiver celui-ci).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.MAAQ_SCHEDULER === "off" || process.env.NODE_ENV === "test") return;
  const globalScope = globalThis as { __maaqScheduler?: ReturnType<typeof setInterval> };
  if (globalScope.__maaqScheduler) return; // un seul planificateur, même après un rechargement à chaud
  const tick = async () => {
    try {
      const { runDueJobs } = await import("@/server/jobs");
      const { db } = await import("@/server/db/client");
      await runDueJobs({ db: db(), now: new Date() });
    } catch (error) {
      console.error("Traitements périodiques :", error);
    }
  };
  setTimeout(tick, 30_000);
  globalScope.__maaqScheduler = setInterval(tick, 5 * 60_000);
}
