// Personal-Kosten-PROGNOSE pro Auftrag — fuer die Badge im Termine-Header
// (PlannedCostBadge): geplante Termine × Kosten-Stundensatz der Person.
//
// Kosten-Stundensatz = kosten_chf_h aus Trust flow (personal_saetze, Lohn
// neu Phase 1b; src/lib/personal-saetze.ts) am Zuerich-Tag des Termins —
// dieselbe Basis wie der Standort-Rapport (src/lib/location-report.ts).
// Aenderungen hier IMMER auch dort pruefen (und umgekehrt).

import type { SupabaseClient } from "@supabase/supabase-js";
import { ladeSatzVerlauf, satzAm } from "@/lib/personal-saetze";
import { localDateIso } from "@/lib/swiss-time";

export interface JobCost {
  /** Alle geplanten Minuten mit zugewiesener Person. */
  minutes: number;
  /** Kosten der Minuten MIT Stundensatz. */
  vollkosten_chf: number;
  /** Personen mit geplanten Minuten ohne Stundensatz (nicht in den Kosten). */
  ohne_satz_personen: number;
}

/**
 * PROGNOSE-Kosten aus geplanten Terminen: pro job_appointment (eine Row
 * je zugewiesener Person) Dauer × Kosten-CHF/h der Person zum Termin-Datum.
 * Ein ab einem spaeteren Datum geltender Satz greift automatisch fuer
 * spaetere Termine. Termine ohne Zuweisung fliessen nicht ein. Personen
 * ohne Satz an dem Tag zaehlen in `ohne_satz_personen`, nie als 0 CHF.
 */
export async function computeJobPlannedCosts(
  admin: SupabaseClient,
  jobIds: string[],
): Promise<Map<string, JobCost>> {
  const result = new Map<string, JobCost>();
  if (jobIds.length === 0) return result;

  const apptRes = await admin
    .from("job_appointments")
    .select("job_id, start_time, end_time, assigned_to")
    .in("job_id", jobIds)
    .not("assigned_to", "is", null);
  if (apptRes.error) throw new Error(apptRes.error.message);
  const appts = ((apptRes.data ?? []) as { job_id: string; start_time: string; end_time: string | null; assigned_to: string }[])
    .map((a) => ({ ...a, mins: minutesBetween(a.start_time, a.end_time), tag: localDateIso(new Date(a.start_time)) }))
    .filter((a) => a.mins > 0);
  if (appts.length === 0) return result;

  const bis = appts.reduce((m, a) => (a.tag > m ? a.tag : m), appts[0].tag);
  const verlauf = await ladeSatzVerlauf(admin, appts.map((a) => a.assigned_to), "kosten", bis);

  const ohneSatz = new Map<string, Set<string>>();
  for (const a of appts) {
    const cur = result.get(a.job_id) ?? { minutes: 0, vollkosten_chf: 0, ohne_satz_personen: 0 };
    cur.minutes += a.mins;
    // Satz am Zuerich-Tag des Termins — start_time ist timestamptz, ein
    // UTC-Slice laege 00:00–02:00 einen Tag zurueck.
    const satz = satzAm(verlauf, a.assigned_to, a.tag);
    if (satz === null) {
      const s = ohneSatz.get(a.job_id) ?? new Set<string>();
      s.add(a.assigned_to);
      ohneSatz.set(a.job_id, s);
    } else {
      cur.vollkosten_chf += (satz * a.mins) / 60;
    }
    result.set(a.job_id, cur);
  }
  for (const [jobId, s] of ohneSatz) {
    const cur = result.get(jobId);
    if (cur) cur.ohne_satz_personen = s.size;
  }
  return result;
}

function minutesBetween(from: string, to: string | null): number {
  // Termin OHNE Endzeit: keine berechenbare Dauer → fliesst nicht in die
  // Prognose ein. Der fruehere Fallback "Ende = jetzt" stammt aus der
  // Stempel-Logik (offener Eintrag laeuft noch) und ist fuer GEPLANTE
  // Termine falsch: ein vergangener Termin ohne Endzeit liess die
  // Prognose minuetlich weiterwachsen (Vorfall INT-26316, CHF-Pille
  // stieg seit dem Termin-Start kontinuierlich). Gilt genauso fuer
  // "Fertig bis"-Termine (zeit_modus deadline, end_time bewusst null) —
  // deren Zeitpunkt ist eine Frist, keine Arbeitsdauer.
  if (!to) return 0;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(0, Math.round(ms / 60000));
}

// (computeJobPersonnelCosts — Ist-Kosten pro Auftrag — wurde 2026-09-08
// wieder entfernt: Leo will nur die Termin-Prognose; Ist-Zahlen liefert
// der Standort-Rapport via location-report.ts.)
