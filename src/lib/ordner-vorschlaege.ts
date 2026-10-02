// Smarte Ordner-Vorschlaege (Leo 2026-10-02) — BEWUSST DETERMINISTISCH
// berechnet (Struktur vergleichen = rechnen, nicht raten; KI nur fuer
// den "neuer Ordner beim Ablegen"-Fall in der name-vorschlag-Route).
//
// Zwei Muster:
//  1. Geschwister-Konsistenz: haben die meisten Instanz-Ordner unter
//     einem Eltern-Ordner einen bestimmten Unterordner (z.B. Jahres-
//     trennung bei Team-Bildern, Template-Set bei Personalakten),
//     fehlt er aber bei einigen -> vorschlagen, ihn dort anzulegen.
//  2. Jahresordner: enthaelt ein Ordner Jahres-Kinder (2025, 2026, ...)
//     und das aktuelle Jahr fehlt -> neuen Jahresordner vorschlagen.
//
// Nie automatisch anlegen — immer Vorschlag mit einem Klick (explizit
// vor magisch). Ignorierte Vorschlaege merkt sich das UI per id.

export interface OrdnerEintrag {
  pfad: string;
  aktiv: boolean;
}

export interface OrdnerVorschlag {
  /** Stabile ID (fuer die Ignorier-Liste). */
  id: string;
  titel: string;
  /** Die anzulegenden Pfade (alle mit einem Klick). */
  neuePfade: string[];
}

const JAHR_RE = /^20\d{2}$/;

/** Effektiv aktive Pfade (vererbte Deaktivierung beachtet). */
function effektivAktiv(eintraege: OrdnerEintrag[]): string[] {
  const inaktiv = eintraege.filter((e) => !e.aktiv).map((e) => e.pfad);
  return eintraege
    .map((e) => e.pfad)
    .filter((p) => !inaktiv.some((i) => p === i || p.startsWith(i + "/")));
}

export function berechneOrdnerVorschlaege(
  eintraege: OrdnerEintrag[],
  aktuellesJahr: number,
): OrdnerVorschlag[] {
  const pfade = effektivAktiv(eintraege);
  const vorhanden = new Set(pfade);
  const kinderVon = new Map<string, string[]>();
  for (const p of pfade) {
    const i = p.lastIndexOf("/");
    const eltern = i === -1 ? "" : p.slice(0, i);
    const name = i === -1 ? p : p.slice(i + 1);
    if (!kinderVon.has(eltern)) kinderVon.set(eltern, []);
    kinderVon.get(eltern)!.push(name);
  }

  const vorschlaege: OrdnerVorschlag[] = [];

  // ── 2. Jahresordner: aktuelles Jahr fehlt ─────────────────────────
  for (const [eltern, kinder] of kinderVon) {
    if (eltern === "") continue;
    const jahre = kinder.filter((k) => JAHR_RE.test(k));
    if (jahre.length === 0) continue;
    // Nur echte Jahres-Strukturen (Mehrheit der Kinder sind Jahre) und
    // nur, wenn das aktuelle Jahr schon erreicht ist.
    if (jahre.length / kinder.length < 0.5) continue;
    const maxJahr = Math.max(...jahre.map(Number));
    if (maxJahr >= aktuellesJahr) continue;
    const neu = `${eltern}/${aktuellesJahr}`;
    if (vorhanden.has(neu)) continue;
    vorschlaege.push({
      id: `jahr:${eltern}:${aktuellesJahr}`,
      titel: `Neues Jahr ${aktuellesJahr}: «${eltern}» führt Jahresordner (bis ${maxJahr})`,
      neuePfade: [neu],
    });
  }

  // ── 1. Geschwister-Konsistenz ─────────────────────────────────────
  // Instanz-Gruppen = Eltern mit >= 3 Kind-Ordnern, deren Kinder selbst
  // Unterordner haben. Ein Unterordner-Name, der bei >= 60% (und >= 2)
  // der Instanzen existiert, wird den uebrigen vorgeschlagen.
  for (const [eltern, instanzen] of kinderVon) {
    if (eltern === "") continue;
    if (instanzen.length < 3) continue;
    const instanzPfade = instanzen.map((n) => `${eltern}/${n}`);
    const mitKindern = instanzPfade.filter((ip) => (kinderVon.get(ip) ?? []).length > 0);
    if (mitKindern.length < 2) continue;

    const namenZaehler = new Map<string, number>();
    for (const ip of instanzPfade) {
      for (const name of new Set(kinderVon.get(ip) ?? [])) {
        namenZaehler.set(name, (namenZaehler.get(name) ?? 0) + 1);
      }
    }
    for (const [name, anzahl] of namenZaehler) {
      // Jahres-Unterordner laufen ueber Muster 2 pro Instanz mit —
      // hier wuerde "2026 ueberall" nur Rauschen erzeugen.
      if (JAHR_RE.test(name)) continue;
      const schwelle = Math.max(2, Math.ceil(instanzPfade.length * 0.6));
      if (anzahl < schwelle) continue;
      const fehlend = instanzPfade.filter((ip) => !vorhanden.has(`${ip}/${name}`));
      if (fehlend.length === 0) continue;
      vorschlaege.push({
        id: `sib:${eltern}:${name}`,
        titel: `«${name}» existiert bei ${anzahl} von ${instanzPfade.length} Ordnern in «${eltern}» — bei den übrigen ${fehlend.length} anlegen?`,
        neuePfade: fehlend.map((ip) => `${ip}/${name}`),
      });
    }
  }

  // Stabil sortieren (Jahres-Vorschlaege zuerst), sanfte Kappe.
  vorschlaege.sort((a, b) => a.id.localeCompare(b.id));
  return vorschlaege.slice(0, 8);
}
