import { addDays } from "@/server/assistant/series";
import { localToUtc, utcToLocal } from "@/server/assistant/local-time";

/**
 * Conservation des documents d'un contrat (C-01, CT-3, US-126 RF7 et RF8, US-134). Fonctions pures : la base garde les dates, ce module dit quand un document disparaît
 * et quand la famille en est avertie.
 *
 * - transmis : supprimé 48 h après la transmission ;
 * - jamais transmis : supprimé au bout de 30 jours (réglage de la console), avec un seul avertissement trois jours avant (27 jours après le dépôt) ;
 * - l'avertissement qui tombe la nuit (de 21 h à 8 h, heure de la famille) est reporté à 8 h.
 */

export const HOURS_AFTER_TRANSMISSION = 48;
export const DEFAULT_RETENTION_DAYS = 30;
export const WARNING_DAYS_BEFORE = 3;

const HOUR = 3_600_000;

export interface RetentionInput {
  depositedAt: Date;
  transmittedAt?: Date | null;
  /** Durée de conservation sans transmission (réglage de la console, 30 par défaut). */
  retentionDays?: number;
}

/** Instant de suppression définitive du document. */
export function deletionAt({ depositedAt, transmittedAt, retentionDays = DEFAULT_RETENTION_DAYS }: RetentionInput): Date {
  if (transmittedAt) return new Date(transmittedAt.getTime() + HOURS_AFTER_TRANSMISSION * HOUR);
  return new Date(depositedAt.getTime() + retentionDays * 24 * HOUR);
}

/** Décale à 8 h (heure de la famille) un instant qui tombe entre 21 h et 8 h. */
export function notBeforeMorning(at: Date, timeZone: string): Date {
  const local = utcToLocal(at, timeZone);
  const hour = Number(local.slice(11, 13));
  if (hour >= 21) return localToUtc(`${addDays(local.slice(0, 10), 1)}T08:00`, timeZone);
  if (hour < 8) return localToUtc(`${local.slice(0, 10)}T08:00`, timeZone);
  return at;
}

/**
 * Instant de l'avertissement « supprimés dans 3 jours », ou null : un document transmis n'a pas d'avertissement (sa suppression est annoncée à la transmission, US-134 RF2).
 * Un seul avertissement par document : l'appelant le note envoyé et ne le rejoue pas.
 */
export function warningAt(input: RetentionInput, timeZone: string): Date | null {
  if (input.transmittedAt) return null;
  const deletion = deletionAt(input);
  return notBeforeMorning(new Date(deletion.getTime() - WARNING_DAYS_BEFORE * 24 * HOUR), timeZone);
}

/** Le document est-il à supprimer maintenant ? */
export const isExpired = (input: RetentionInput, now: Date) => deletionAt(input).getTime() <= now.getTime();

/** L'avertissement est-il dû maintenant (jamais envoyé, pas encore supprimé) ? */
export function warningDue(input: RetentionInput, timeZone: string, now: Date, alreadyWarned: boolean): boolean {
  if (alreadyWarned || isExpired(input, now)) return false;
  const at = warningAt(input, timeZone);
  return at !== null && at.getTime() <= now.getTime();
}

/** Texte de l'avertissement ; pour une catégorie archivée, il ne parle plus de transmission (US-139 RF4). */
export function warningText(contractName: string, archivedCategory: boolean): string {
  return archivedCategory
    ? `Les documents de ${contractName} seront supprimés dans 3 jours.`
    : `Les documents de ${contractName} seront supprimés dans 3 jours s'ils ne sont pas transmis.`;
}
