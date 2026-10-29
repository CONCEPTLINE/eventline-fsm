// Geplante (Termine) und rapportierte Minuten — nur zur Information neben dem
// Lohn (Auszahlung = gestempelte Zeit, Entscheid Leo 2026-06-17). Eine Stelle
// für Monatstabelle, Excel und Lohn-Details.

import type { SupabaseClient } from "@supabase/supabase-js";
import { lokalesDatum } from "./kern";
import { ladeAlleSeiten } from "./daten";

export interface RapportBereich {
  technician_id?: unknown;
  start?: unknown;
  end?: unknown;
  pause?: unknown;
}

/** Minuten eines Rapport-Bereichs (HH:MM–HH:MM minus Pause, über Mitternacht +24 h). */
export function rapportMinuten(r: RapportBereich): number {
  const s = typeof r.start === "string" ? r.start : "";
  const e = typeof r.end === "string" ? r.end : "";
  if (!/^\d{2}:\d{2}/.test(s) || !/^\d{2}:\d{2}/.test(e)) return 0;
  const [sh, sm] = s.split(":").map(Number);
  const [eh, em] = e.split(":").map(Number);
  let min = eh * 60 + em - (sh * 60 + sm);
  if (min < 0) min += 1440;
  const pause = Number(r.pause ?? 0);
  return Math.max(0, min - (Number.isFinite(pause) ? pause : 0));
}

export interface InfoMinuten {
  /** Person → lokaler Tag → Minuten */
  geplant: Map<string, Map<string, number>>;
  rapport: Map<string, Map<string, number>>;
}

function add(m: Map<string, Map<string, number>>, id: string, tag: string, min: number) {
  let t = m.get(id);
  if (!t) {
    t = new Map();
    m.set(id, t);
  }
  t.set(tag, (t.get(tag) ?? 0) + min);
}

/** Geplante und rapportierte Minuten je Person und Tag im Zeitraum [von, bis] (lokale Tage). */
export async function ladeInfoMinuten(admin: SupabaseClient, profileIds: string[], von: string, bis: string): Promise<InfoMinuten> {
  const out: InfoMinuten = { geplant: new Map(), rapport: new Map() };
  const ids = new Set(profileIds);
  if (ids.size === 0) return out;
  const [termine, rapporte] = await Promise.all([
    ladeAlleSeiten<{ id: string; assigned_to: string; start_time: string; end_time: string | null }>(
      (a, b) => admin.from("job_appointments").select("id, assigned_to, start_time, end_time").in("assigned_to", Array.from(ids))
        .gte("start_time", `${von}T00:00:00Z`).lt("start_time", `${bis}T23:59:59Z`).order("id").range(a, b),
      "Termine",
    ),
    ladeAlleSeiten<{ id: string; report_date: string; time_ranges: RapportBereich[] | null }>(
      (a, b) => admin.from("service_reports").select("id, report_date, time_ranges").eq("status", "abgeschlossen")
        .gte("report_date", von).lte("report_date", bis).order("id").range(a, b),
      "Rapporte",
    ),
  ]);
  for (const t of termine) {
    if (!t.end_time) continue;
    const tag = lokalesDatum(new Date(t.start_time).getTime());
    if (tag < von || tag > bis) continue;
    const min = Math.max(0, Math.floor((new Date(t.end_time).getTime() - new Date(t.start_time).getTime()) / 60000));
    add(out.geplant, t.assigned_to, tag, min);
  }
  for (const r of rapporte) {
    for (const b of Array.isArray(r.time_ranges) ? r.time_ranges : []) {
      const id = typeof b.technician_id === "string" ? b.technician_id : "";
      if (!ids.has(id)) continue;
      const min = rapportMinuten(b);
      if (min > 0) add(out.rapport, id, r.report_date, min);
    }
  }
  return out;
}

export function summeImMonat(m: Map<string, number> | undefined, prefix: string): number {
  let n = 0;
  for (const [tag, min] of m ?? []) if (tag.startsWith(prefix)) n += min;
  return n;
}
