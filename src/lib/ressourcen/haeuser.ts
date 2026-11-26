// Häuser, die auf Ressourcen › Karte in jedem Fall erscheinen sollen
// (Leo, 26.11.2026), auch wenn sie noch nicht als Location erfasst sind.
// Fehlt ein Haus in `locations`, zeigt die Karte es als «noch nicht angelegt»
// mit einem Knopf, der es mit diesen Angaben als Location anlegt. Sobald eine
// Location mit passendem Namen existiert, gilt nur noch die Location.
//
// Koordinaten: OpenStreetMap (Nominatim), abgefragt am 26.11.2026. Plätze und
// Technik stammen aus den Kooperationskonzepten und sind dort nicht bestätigt.

export type VorgemerktesHaus = {
  schluessel: string;
  name: string;
  /** Kleingeschriebener Namensteil, an dem eine bestehende Location erkannt wird. */
  muster: string;
  address_street: string;
  address_zip: string;
  address_city: string;
  capacity: number | null;
  technical_details: string | null;
  notes: string;
  latitude: number;
  longitude: number;
};

export const VORGEMERKTE_HAEUSER: VorgemerktesHaus[] = [
  {
    schluessel: "querfeldhalle",
    name: "Querfeldhalle",
    muster: "querfeld",
    address_street: "Dornacherstrasse 192",
    address_zip: "4053",
    address_city: "Basel",
    capacity: null,
    technical_details: null,
    notes: "Träger: Zirkusschule Basel (ZSB). Über KULTURLINE.",
    latitude: 47.5411522,
    longitude: 7.592874,
  },
  {
    schluessel: "palazzo",
    name: "Palazzo Liestal",
    muster: "palazzo",
    address_street: "Poststrasse 2",
    address_zip: "4410",
    address_city: "Liestal",
    capacity: 70,
    technical_details: "Theatersaal mit Tribünenbestuhlung, Bar, Garderobe, Schminkraum. Technik laut Konzept betriebsbereit.",
    notes: "Träger: Kulturhaus Palazzo AG. Über KULTURLINE. Rund 70 Plätze laut Konzept, nicht bestätigt.",
    latitude: 47.4840401,
    longitude: 7.7322536,
  },
  {
    schluessel: "trafohalle",
    name: "Trafohalle Bottmingen",
    muster: "trafohalle",
    address_street: "Therwilerstrasse 56",
    address_zip: "4103",
    address_city: "Bottmingen",
    capacity: 100,
    technical_details: "Halle ca. 360 m², unbeheizt, Saison Ende März bis Ende Oktober. Haustechnik nicht bekannt.",
    notes: "Träger: Trägerverein Leimentale. Über KULTURLINE. Ca. 100 Sitzplätze, nicht vom Verein bestätigt.",
    latitude: 47.5196255,
    longitude: 7.5678395,
  },
  {
    schluessel: "gemeinschaftsbank",
    name: "Freie Gemeinschaftsbank",
    muster: "gemeinschaftsbank",
    address_street: "Meret Oppenheim-Strasse 10",
    address_zip: "4053",
    address_city: "Basel",
    capacity: 140,
    technical_details:
      "Saal im Erdgeschoss ca. 16 x 9.5 m mit Podestbühne, Beamer, Theaterbeleuchtung, Mikrofonen. Tagungsraum im Dachgeschoss ca. 48 m² für 20 bis 50 Personen.",
    notes: "Träger: Freie Gemeinschaftsbank Genossenschaft. Über KULTURLINE. Mietzeit ab 17 Uhr.",
    latitude: 47.5468427,
    longitude: 7.585531,
  },
];

/** Kennung eines vorgemerkten Hauses in der Auswahl (?ort=neu:<schluessel>). */
export const VORGEMERKT_PRAEFIX = "neu:";

/** Vorgemerkte Häuser, zu denen es noch keine Location gibt. */
export function fehlendeHaeuser(vorhandeneNamen: readonly string[]): VorgemerktesHaus[] {
  const namen = vorhandeneNamen.map((n) => n.toLowerCase());
  return VORGEMERKTE_HAEUSER.filter((h) => !namen.some((n) => n.includes(h.muster)));
}
