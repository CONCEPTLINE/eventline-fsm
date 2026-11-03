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
 *  keins hochgeladen ist. */
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
