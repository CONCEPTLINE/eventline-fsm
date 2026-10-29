// Rechenkern Lohn — öffentliche Schnittstelle.
//
// Rein und eigenständig: keine Datenbank, kein Next.js, keine Importe
// ausserhalb dieses Ordners. Das Backoffice kann den Ordner 1:1 übernehmen.
// Beschreibung: C:\Users\misch\projects\_backoffice-uebergabe\09_Rechenkern.md
//
//   rechneMonat(eingabe)          ein Monat einer Person → Mengen, Positionen,
//                                 Brutto, Abzüge, Netto, NBU, Hinweise
//   stempelBereich(jahr, monat)   welche Stempel der Kern für den Monat braucht
//   auszahlungsdatumNachRegel()   n-ter Arbeitstag des Folgemonats
//   feiertageBaselStadt(jahr)     Feiertage am Einsatzort Basel-Stadt
//   jahresEinsaetze()             Nächte/Sonntage eines Jahres mit Rang

export * from "./typen";
export { rechneMonat, jahresEinsaetze, firmensatzAm, lohnzeileAm, KernFehler } from "./monat";
export { nbuStatus, nbuZeitraum, ganzeWochen, fmtStundenAbgerundet } from "./nbu";
export { auszahlungsdatumNachRegel, stempelBereich } from "./auszahlung";
export { feiertageBaselStadt, feiertageBaselStadtJahre } from "./feiertage";
export {
  KERN_VERSION,
  rundeChf,
  summeChf,
  ferienPctNachAlter,
  fmtProzent,
  SONNTAG_ZUSCHLAG_PCT,
  SONNTAG_MAX_JE_JAHR,
  NACHT_ZUSCHLAG_PCT,
  NACHT_MAX_JE_JAHR,
  ZEITZUSCHLAG_PCT,
  FERIEN_PCT_ERWACHSEN,
  FERIEN_PCT_JUGEND,
  FEIERTAG_1AUG_PCT,
  AHV_GERINGFUEGIG_GRENZE,
  ALV_HOECHSTLOHN_JAHR,
  UVG_HOECHSTLOHN_JAHR,
  NBU_MIN_STUNDEN_PRO_WOCHE,
} from "./regeln";
export { plusTage, monatsErster, monatsLetzter, monatSchluessel, wochenMontag, lokalesDatum, jeLokalerStunde } from "./zeit";
