// Krank melden — Regeln an EINER Stelle (rein, ohne DB; Tests: krank.test.ts).
//
// AAB EVENTLINE: «Spätestens ab dem dritten Kalendertag der Arbeitsunfähigkeit
// ist ein Arztzeugnis einzureichen.» Tag 1 = der erste Krankheitstag («Ab»).
// Kalendertage, nicht Arbeitstage.

import { plusTage } from "@/lib/swiss-time";

/** approved_by_name der Krankmeldungen ohne Freigabe (Migration 378) —
 *  unterscheidet sie von alten, per Antrag bewilligten «krank»-Eintraegen. */
export const KRANKMELDUNG = "Krankmeldung";

/** Ab diesem Kalendertag der Arbeitsunfaehigkeit braucht es ein Arztzeugnis. */
export const ARZTZEUGNIS_AB_TAG = 3;

/** Wie viele Tage nach «Ab» wir bei offenem Ende nach Einsaetzen suchen
 *  (bis und mit dem Tag, ab dem das Arztzeugnis faellig ist). */
export const OFFENES_ENDE_VORSCHAU_TAGE = ARZTZEUGNIS_AB_TAG;

/** So viele Tage nach der Übergabe an Trust flow (arztzeugnis_an_flow_at)
 *  löscht das ERP seine Kopie des Arztzeugnisses (Entscheid Mischa,
 *  2026-11-03; Gesundheitsdaten nicht doppelt, DSG Art. 5, OR 328b). Die
 *  Personalakte in Trust flow bleibt massgebend. Hochgeladen-/Übergabe-
 *  Zeitpunkt, Dateiname, Typ, Grösse und sha256 bleiben als Beleg stehen. */
export const ARZTZEUGNIS_LOESCHEN_NACH_TAGEN = 30;

/** Stand des Arztzeugnisses einer Krankmeldung:
 *   fehlt          nie eins hochgeladen
 *   vorhanden      Datei liegt im ERP (ansehbar)
 *   an_trust_flow  an Trust flow übergeben und hier gelöscht (nur Beleg) */
export type ArztzeugnisStatus = "fehlt" | "vorhanden" | "an_trust_flow";

export function arztzeugnisStatus(z: {
  arztzeugnis_pfad: string | null;
  arztzeugnis_hochgeladen_at: string | null;
  arztzeugnis_an_flow_at: string | null;
}): ArztzeugnisStatus {
  if (z.arztzeugnis_pfad) return "vorhanden";
  if (z.arztzeugnis_hochgeladen_at && z.arztzeugnis_an_flow_at) return "an_trust_flow";
  // Hochgeladen ohne Datei und ohne Übergabe gibt es nicht (der Upload setzt
  // beides zusammen); vorsichtshalber als «fehlt» — dann erinnert nichts falsch.
  return "fehlt";
}

/** Übergaben bis und mit diesem Zeitpunkt sind alt genug zum Löschen (ISO). */
export function arztzeugnisLoeschenBis(jetzt: Date): string {
  return new Date(jetzt.getTime() - ARZTZEUGNIS_LOESCHEN_NACH_TAGEN * 86_400_000).toISOString();
}

/** Ist die Kopie im ERP fällig zum Löschen (Datei da, vor ≥ 30 Tagen übergeben)? */
export function arztzeugnisLoeschfaellig(
  z: { arztzeugnis_pfad: string | null; arztzeugnis_an_flow_at: string | null },
  jetzt: Date,
): boolean {
  if (!z.arztzeugnis_pfad || !z.arztzeugnis_an_flow_at) return false;
  const t = Date.parse(z.arztzeugnis_an_flow_at);
  return Number.isFinite(t) && t <= Date.parse(arztzeugnisLoeschenBis(jetzt));
}

/** Kalendertage von `ab` bis `bis`, beide inklusiv (YYYY-MM-DD). */
export function kalenderTage(ab: string, bis: string): number {
  const [ay, am, ad] = ab.split("-").map(Number);
  const [by, bm, bd] = bis.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000) + 1;
}

/** Datum, ab dem das Arztzeugnis faellig ist (Tag ARZTZEUGNIS_AB_TAG). */
export function arztzeugnisFaelligAb(ab: string): string {
  return plusTage(ab, ARZTZEUGNIS_AB_TAG - 1);
}

/** Bisherige Dauer der Arbeitsunfaehigkeit in Kalendertagen: von «Ab» bis
 *  heute, bei bekanntem (vergangenem) Ende nur bis dahin. 0, wenn «Ab» in
 *  der Zukunft liegt. */
export function bisherigeTage(k: { ab: string; bis: string; endeOffen: boolean }, heute: string): number {
  if (heute < k.ab) return 0;
  const letzter = k.endeOffen ? heute : (k.bis < heute ? k.bis : heute);
  return Math.max(0, kalenderTage(k.ab, letzter));
}

/** Fehlt das Arztzeugnis? Erst ab Tag ARZTZEUGNIS_AB_TAG und nur, wenn noch
 *  keins hochgeladen ist (auch ein an Trust flow übergebenes und hier
 *  gelöschtes zählt als hochgeladen). */
export function arztzeugnisFehlt(
  k: { ab: string; bis: string; endeOffen: boolean; hatZeugnis: boolean },
  heute: string,
): boolean {
  if (k.hatZeugnis) return false;
  return bisherigeTage(k, heute) >= ARZTZEUGNIS_AB_TAG;
}

/** Laeuft die Krankmeldung noch (Ende offen oder erst nach heute)? Endet sie
 *  heute — z. B. nach «Wieder gesund» —, gilt sie als abgeschlossen. */
export function krankLaeuft(k: { bis: string; endeOffen: boolean }, heute: string): boolean {
  return k.endeOffen || k.bis > heute;
}

/** Dateiname des Arztzeugnisses zum Speichern (Migration 380): ohne Pfad und
 *  Steuerzeichen, höchstens 120 Zeichen, Endung passend zum Typ. Leer →
 *  «arztzeugnis.<endung>». */
export function arztzeugnisDateiname(original: string, endung: string): string {
  const basis = (original.split(/[\\/]/).pop() ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const ohneEndung = basis.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/^\.+/, "").trim();
  const kern = ohneEndung.slice(0, 120 - endung.length - 1).trim();
  return `${kern || "arztzeugnis"}.${endung}`;
}
