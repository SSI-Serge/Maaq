import { listSettings, updateSettings } from "@/server/admin/settings";
import { courseError } from "../../household/settings";
import type { ConsoleObject } from "../types";

/** Réglages du module (US-171 RF1, US-156) : valeurs des calculs de MAAQ pour cet agent. Elles passent par les paramètres de la plateforme (US-65), donc par son historique. */

const KEYS = [
  { key: "meal_session_cap_minutes", label: "Plafond de la séance de batch (min)" },
  { key: "meal_repeat_weeks_default", label: "Répétition par défaut (semaines)" },
  { key: "meal_match_sure_pct", label: "Correspondance « sûre » à partir de (%)" },
  { key: "meal_match_check_pct", label: "Correspondance « à confirmer » à partir de (%)" },
  { key: "meal_season_dishes_count", label: "Plats de saison demandés par menu du mois" },
  { key: "meal_season_dishes_max", label: "Plafond de plats de saison par menu du mois" },
] as const;

export const moduleSettings: ConsoleObject = {
  async load(c) {
    const settings = await listSettings(c.ctx);
    return {
      object: "reglages",
      title: "Réglages du module",
      intro: "Valeurs utilisées par les calculs de MAAQ pour cet agent. Chaque changement est inscrit à l'historique des paramètres.",
      info: null,
      columns: [
        { key: "label", label: "Réglage" },
        { key: "value", label: "Valeur", align: "right" },
        { key: "range", label: "Bornes" },
      ],
      rows: KEYS.map((k) => {
        const s = settings.find((x) => x.key === k.key);
        return {
          id: k.key,
          cells: { label: k.label, value: s?.value ?? "", range: s ? `${s.min ?? "—"} à ${s.max ?? "—"}` : "" },
          actions: [{ key: "edit", label: "Modifier", fields: [{ key: "value", label: k.label, type: "number" as const, value: s?.value ?? "", required: true }] }],
        };
      }),
      filters: [],
      search: false,
      total: KEYS.length,
      footer: "Le seuil « sûre » doit rester au-dessus du seuil « à confirmer ».",
      tools: {},
    };
  },

  async act(c, action, id, values) {
    if (action !== "edit" || !KEYS.some((k) => k.key === id)) throw courseError("unknown_action", "Action inconnue.", 422);
    const settings = await listSettings(c.ctx);
    const next = new Map(settings.map((s) => [s.key, Number(s.value)]));
    next.set(id, Number((values.value ?? "").trim()));
    const sure = next.get("meal_match_sure_pct") as number;
    const check = next.get("meal_match_check_pct") as number;
    if (sure <= check) throw courseError("invalid_thresholds", "Le seuil « sûre » doit rester au-dessus du seuil « à confirmer ».", 422);
    await updateSettings(c.ctx, c.adminId, { [id]: values.value ?? "" });
  },
};
