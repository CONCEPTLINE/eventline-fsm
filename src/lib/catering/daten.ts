// Getränke-Catering — Server-Helfer (nur in API-Routen importieren).
import type { SupabaseClient } from "@supabase/supabase-js";
import { CATERING_STANDARD, type CateringEingabe, type CateringParameter, type MixZeile } from "./rechnen";

import { type KartenKategorie } from "./kategorien";
export { KATEGORIE_REIHENFOLGE, KATEGORIE_TITEL, type KartenKategorie } from "./kategorien";

export interface KartenZeile extends MixZeile {
  id: string;
  kategorie: KartenKategorie;
  name: string;
  einheit: string;
}

export async function ladeKarte(admin: SupabaseClient): Promise<KartenZeile[]> {
  const { data, error } = await admin
    .from("catering_getraenke")
    .select("id, kategorie, name, einheit, verkauf, einkauf, mix_anteil")
    .eq("aktiv", true)
    .order("sort");
  if (error) throw error;
  return (data ?? []).map((z) => ({
    id: z.id as string,
    kategorie: z.kategorie as KartenKategorie,
    name: z.name as string,
    einheit: (z.einheit as string) ?? "",
    verkauf: Number(z.verkauf),
    einkauf: Number(z.einkauf),
    mixAnteil: z.mix_anteil == null ? null : Number(z.mix_anteil),
  }));
}

export async function ladeParameter(admin: SupabaseClient): Promise<CateringParameter> {
  const { data, error } = await admin.from("catering_einstellungen").select("*").eq("id", true).maybeSingle();
  if (error) throw error;
  if (!data) return CATERING_STANDARD;
  return {
    lohnProStunde: Number(data.lohn_pro_stunde),
    gaesteProKraft: Number(data.gaeste_pro_kraft),
    puffer: Number(data.puffer),
    aufschlagA: Number(data.aufschlag_a),
    vor: { anteil: Number(data.anteil_vor), rate: Number(data.rate_vor) },
    pause: { anteil: Number(data.anteil_pause), rate: Number(data.rate_pause) },
    nach: { anteil: Number(data.anteil_nach), rate: Number(data.rate_nach) },
  };
}

export interface JobKontext {
  jobId: string;
  jobNumber: number | null;
  status: string;
  titel: string;
  /** Anlass-Datum als «9. April 2027» (Zürich), null wenn kein Startdatum. */
  datumText: string | null;
  ort: string;
  /** Auftraggeber/in direkt aus dem Auftrag: Kontaktperson (Standort-Auftrag) bzw. Kunde (externer Auftrag). Leer = fehlt im Auftrag. */
  auftraggeber: string;
  /** Adresse direkt aus dem Auftrag: nur bei externen Aufträgen (Kundenadresse); Standort-Aufträge haben keine. */
  auftraggeberAdresse: string;
}

const adresse = (c: { address_street: string | null; address_zip: string | null; address_city: string | null } | null) => {
  if (!c) return null;
  const ortTeil = [c.address_zip, c.address_city].filter(Boolean).join(" ");
  return [c.address_street, ortTeil].filter((x) => x && String(x).trim()).join(", ") || null;
};

/** Auftrag + Kunde + Ort. Bei Standort-Aufträgen kommt der Kunde vom Standort (Verwaltungs-Kunde). */
export async function ladeJobKontext(admin: SupabaseClient, jobId: string): Promise<JobKontext | null> {
  const { data: job, error } = await admin
    .from("jobs")
    .select("id, job_number, status, title, start_date, job_type, customer_id, location_id, room_id, external_address, contact_person")
    .eq("id", jobId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (error) throw error;
  if (!job) return null;

  let ort = (job.external_address as string | null) ?? "";
  if (job.location_id) {
    const { data: loc, error: lErr } = await admin.from("locations").select("name").eq("id", job.location_id).maybeSingle();
    if (lErr) throw lErr;
    if (loc) ort = loc.name as string;
  } else if (job.room_id) {
    const { data: room, error: rErr } = await admin.from("rooms").select("name").eq("id", job.room_id).maybeSingle();
    if (rErr) throw rErr;
    if (room) ort = room.name as string;
  }

  // Standort-Auftrag: der «Kunde» ist der Verwaltungs-Kunde des Standorts (z. B. Theater BAU3), NICHT die
  // Veranstalterin — die steht als Kontaktperson im Auftrag. Externer Auftrag: der Kunde des Auftrags.
  let auftraggeber = "";
  let auftraggeberAdresse = "";
  if (job.job_type === "location") {
    auftraggeber = ((job.contact_person as string | null) ?? "").trim();
  } else if (job.customer_id) {
    const { data: k, error: kErr } = await admin
      .from("customers")
      .select("name, address_street, address_zip, address_city")
      .eq("id", job.customer_id)
      .maybeSingle();
    if (kErr) throw kErr;
    if (k) {
      auftraggeber = k.name as string;
      auftraggeberAdresse = adresse(k as { address_street: string | null; address_zip: string | null; address_city: string | null }) ?? "";
    }
  }

  const datumText = job.start_date
    ? new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "numeric", month: "long", year: "numeric" }).format(new Date(job.start_date as string))
    : null;

  return {
    jobId,
    jobNumber: (job.job_number as number | null) ?? null,
    status: job.status as string,
    titel: job.title as string,
    datumText,
    ort,
    auftraggeber,
    auftraggeberAdresse,
  };
}

export interface GespeichertCatering {
  eingabe: CateringEingabe;
  ausschankBeginn: string;
  anlass: string;
  ergebnis: Record<string, number>;
  updatedAt: string;
}

export async function ladeGespeichert(admin: SupabaseClient, jobId: string): Promise<GespeichertCatering | null> {
  const { data, error } = await admin.from("job_catering").select("*").eq("job_id", jobId).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    eingabe: {
      gaeste: data.gaeste,
      aufbauMin: data.aufbau_min,
      gesamtMin: data.gesamt_min,
      abbauMin: data.abbau_min,
      vorzeitMin: data.vorzeit_min,
      pauseMin: data.pause_min,
      nachzeitMin: data.nachzeit_min,
    },
    ausschankBeginn: (data.ausschank_beginn as string | null) ?? "",
    anlass: (data.anlass as string | null) ?? "",
    ergebnis: data.ergebnis as Record<string, number>,
    updatedAt: data.updated_at as string,
  };
}
