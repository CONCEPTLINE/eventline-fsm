// Getränke-Catering — beim Speichern der Kalkulation die drei PDFs (Vertrag A, Vertrag B, Getränkekarte) als
// Dokumente im Auftrag ablegen («Dokumente & Historie», Ordner «Catering»). Nur serverseitig.
//
// Ablauf pro Speichern: Dateien hochladen (fester Pfad je Datei, upsert) → neue documents-Zeilen anlegen → ERST DANACH
// die Zeilen der vorherigen Ablage löschen. So geht bei einem Fehler nie eine bestehende Ablage verloren.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobKontext, KartenZeile } from "./daten";
import { karteTitel, kartePdf, vertragPdf } from "./pdf";
import type { CateringEingabe, CateringErgebnis } from "./rechnen";

export const CATERING_ORDNER = "Catering";

export type DokumentArt = "vertrag-a" | "vertrag-b" | "karte";
const DATEINAME: Record<DokumentArt, string> = { "vertrag-a": "Vertrag_A_Bestellung", "vertrag-b": "Vertrag_B_Mindestumsatz", karte: "Getraenkekarte" };

export const dokumentName = (nr: string, art: DokumentArt) => `${nr}_${DATEINAME[art]}.pdf`;
/** Fester Speicherpfad je Auftrag und Datei; liegt unter jobs/ (erlaubter Prefix, Archiv-Sperre gilt). */
export const dokumentPfad = (jobId: string, nr: string, art: DokumentArt) => `jobs/${jobId}/catering/${dokumentName(nr, art)}`;

export interface AblageDaten {
  job: JobKontext;
  eingabe: CateringEingabe;
  ergebnis: CateringErgebnis;
  ausschankBeginn: string;
  anlass: string;
  karte: KartenZeile[];
}

/** Die drei PDFs mit dem soeben gespeicherten Ergebnis erzeugen. */
export async function erzeugeCateringPdfs(d: AblageDaten): Promise<{ art: DokumentArt; bytes: Uint8Array }[]> {
  const gemeinsam = {
    job: d.job, eingabe: d.eingabe, ergebnis: d.ergebnis, ausschankBeginn: d.ausschankBeginn,
    auftraggeber: d.job.auftraggeber, auftraggeberAdresse: d.job.auftraggeberAdresse, anlass: d.anlass,
  };
  return [
    { art: "vertrag-a", bytes: await vertragPdf({ art: "A", ...gemeinsam }) },
    { art: "vertrag-b", bytes: await vertragPdf({ art: "B", ...gemeinsam }) },
    { art: "karte", bytes: await kartePdf(d.karte, karteTitel(d.job, d.anlass)) },
  ];
}

export async function legeDokumenteAb(
  admin: SupabaseClient,
  p: { jobId: string; userId: string; nr: string; dateien: { art: DokumentArt; bytes: Uint8Array }[] },
): Promise<void> {
  const { data: alt, error: aErr } = await admin
    .from("documents")
    .select("id, storage_path")
    .eq("job_id", p.jobId)
    .like("storage_path", `jobs/${p.jobId}/catering/%`);
  if (aErr) throw aErr;

  const neu: Record<string, unknown>[] = [];
  for (const f of p.dateien) {
    const pfad = dokumentPfad(p.jobId, p.nr, f.art);
    const { error } = await admin.storage.from("documents").upload(pfad, f.bytes, { contentType: "application/pdf", upsert: true });
    if (error) throw error;
    neu.push({
      name: dokumentName(p.nr, f.art), storage_path: pfad, file_size: f.bytes.length, mime_type: "application/pdf",
      job_id: p.jobId, uploaded_by: p.userId, folder: CATERING_ORDNER,
    });
  }
  const { error: iErr } = await admin.from("documents").insert(neu);
  if (iErr) throw iErr;

  const altIds = (alt ?? []).map((z) => z.id as string);
  if (altIds.length > 0) {
    const { error: dErr } = await admin.from("documents").delete().in("id", altIds);
    if (dErr) throw dErr;
  }
}
