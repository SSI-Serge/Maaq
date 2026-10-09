/**
 * File d'attente par clé : les messages d'une même personne sont traités l'un après l'autre, quel que soit
 * le canal, pour que deux messages rapprochés ne se marchent pas dessus. Les clés différentes avancent en parallèle.
 */
export class KeyedQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(task, task).catch((error) => console.error(`[canaux] traitement échoué (${key}) :`, error));
    const tracked: Promise<void> = run.finally(() => {
      this.pending.delete(tracked);
      if (this.chains.get(key) === run) this.chains.delete(key);
    });
    this.chains.set(key, run);
    this.pending.add(tracked);
    return tracked;
  }

  /** Attend la fin de tout ce qui est en cours (tests). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
