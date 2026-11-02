export interface TranscriptLine {
  /** Heure de la phrase dans la vidéo (« 0:15 »), si le texte la donne. */
  time: string | null;
  text: string;
}

/**
 * Texte de la vidéo : une phrase par ligne, éventuellement précédée de son heure (« 0:15 Dites ou écrivez… »), comme dans la maquette. Les lignes vides sont ignorées.
 */
export function parseTranscript(transcript: string): TranscriptLine[] {
  return transcript
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(\d{1,2}:\d{2})\s+(.+)$/.exec(line);
      return m ? { time: m[1], text: m[2] } : { time: null, text: line };
    });
}

/** « 1:20 » pour un nombre de secondes. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
