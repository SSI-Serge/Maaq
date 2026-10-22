import { env } from "@/server/env";
import { DevCalendar } from "./dev";
import { NoCalendar, type CalendarSource } from "./types";

declare global {
  // Une seule instance malgré le rechargement à chaud du serveur de développement.
  var __maaqCalendar: CalendarSource | undefined;
  var __maaqCalendarDev: DevCalendar | undefined;
}

/** Agenda selon CALENDAR_MODE : aucun, ou l'agenda de démonstration. */
export function calendarSource(): CalendarSource {
  if (globalThis.__maaqCalendar) return globalThis.__maaqCalendar;
  globalThis.__maaqCalendar = env().CALENDAR_MODE === "dev" ? devCalendar() : new NoCalendar();
  return globalThis.__maaqCalendar;
}

export function devCalendar(): DevCalendar {
  globalThis.__maaqCalendarDev ??= new DevCalendar();
  return globalThis.__maaqCalendarDev;
}

/** Remplace l'agenda (tests). */
export function useCalendarSource(source: CalendarSource | undefined): void {
  globalThis.__maaqCalendar = source;
}

export type * from "./types";
