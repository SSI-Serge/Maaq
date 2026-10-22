import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/server/data-dir";
import type { CalendarEvent, CalendarSource } from "./types";

/** Agenda en mémoire pour les tests : événements ajoutés par profil. */
export class MemoryCalendar implements CalendarSource {
  private readonly events = new Map<string, CalendarEvent[]>();

  add(userId: string, event: Omit<CalendarEvent, "id"> & { id?: string }): CalendarEvent {
    const full: CalendarEvent = { id: event.id ?? randomUUID(), title: event.title, date: event.date, time: event.time ?? null };
    this.events.set(userId, [...(this.events.get(userId) ?? []), full]);
    return full;
  }

  async listUpcoming(userId: string, from: string, to: string): Promise<CalendarEvent[]> {
    return (this.events.get(userId) ?? []).filter((e) => e.date >= from && e.date <= to).map((e) => ({ ...e }));
  }
}

const SAFE_ID = /^[0-9a-f-]{36}$/;

/**
 * Agenda de démonstration (CALENDAR_MODE=dev) : un fichier par profil dans .data/calendar, alimenté depuis
 * /dev/agenda. Tient lieu du calendrier maître en attendant qu'il existe.
 */
export class DevCalendar implements CalendarSource {
  constructor(private readonly root: string = path.join(dataDir(), "calendar")) {}

  private file(userId: string): string {
    if (!SAFE_ID.test(userId)) throw new Error("Identifiant de profil invalide");
    return path.join(this.root, `${userId}.json`);
  }

  async list(userId: string): Promise<CalendarEvent[]> {
    try {
      return JSON.parse(await readFile(this.file(userId), "utf8")) as CalendarEvent[];
    } catch {
      return [];
    }
  }

  private async save(userId: string, events: CalendarEvent[]): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.file(userId), JSON.stringify(events, null, 2), "utf8");
  }

  async add(userId: string, event: Omit<CalendarEvent, "id">): Promise<CalendarEvent> {
    const full: CalendarEvent = { id: randomUUID(), title: event.title, date: event.date, time: event.time ?? null };
    await this.save(userId, [...(await this.list(userId)), full]);
    return full;
  }

  async remove(userId: string, eventId: string): Promise<void> {
    await this.save(userId, (await this.list(userId)).filter((e) => e.id !== eventId));
  }

  async listUpcoming(userId: string, from: string, to: string): Promise<CalendarEvent[]> {
    return (await this.list(userId)).filter((e) => e.date >= from && e.date <= to);
  }
}
