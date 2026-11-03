import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lokalesDatum } from "@/lib/lohn/kern/zeit";
import { istIntern } from "@/lib/roles";
import { FRAGEN, type Frage, type FrageGilt } from "./katalog";

// «Fragen an dich»: welche Fragen für eine Person gelten (nur Server, Admin-Client
// für die Prüfung von Profil und Anstellung — die Antworten selbst liest/schreibt
// die Route mit der Sitzung der Person, RLS Migration 381).

/**
 * Aktive interne Person (kein Partner-/Lieferanten-Zugang) mit Lohn-Anstellung,
 * die heute oder später noch läuft (kein Austritt vor heute, Ortszeit Zürich;
 * auch künftige Eintritte — sie sollen vor dem ersten Lohn antworten).
 */
async function mitAnstellung(admin: SupabaseClient, profileId: string): Promise<boolean> {
  const { data: p, error: pe } = await admin.from("profiles").select("role, is_active").eq("id", profileId).maybeSingle();
  if (pe) throw new Error(`Profil konnte nicht geladen werden: ${pe.message}`);
  if (!p || p.is_active !== true || !istIntern(p.role as string | null)) return false;
  const heute = lokalesDatum(Date.now());
  const { data, error } = await admin
    .from("lohn_anstellungen")
    .select("id")
    .eq("profile_id", profileId)
    .or(`austritt.is.null,austritt.gte.${heute}`)
    .limit(1);
  if (error) throw new Error(`Anstellung konnte nicht geladen werden: ${error.message}`);
  return (data ?? []).length > 0;
}

/** Fragen aus dem Katalog, die für die Person gelten (Reihenfolge des Katalogs). */
export async function geltendeFragen(admin: SupabaseClient, profileId: string): Promise<Frage[]> {
  const cache = new Map<FrageGilt, boolean>();
  const out: Frage[] = [];
  for (const f of FRAGEN) {
    if (!cache.has(f.gilt)) {
      cache.set(f.gilt, f.gilt === "mitarbeitende_mit_anstellung" ? await mitAnstellung(admin, profileId) : false);
    }
    if (cache.get(f.gilt)) out.push(f);
  }
  return out;
}
