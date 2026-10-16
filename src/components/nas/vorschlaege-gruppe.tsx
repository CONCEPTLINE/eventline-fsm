"use client";

// Bereich «Einsortieren» (Rückstau ZZ) im Tab «Ablage» (docs/lokale-ki/
// MASTERPLAN.md §3.8 MP-7, Paket E3.2, Entscheid E6): die Nachtarbeit der
// lokalen KI schlaegt fuer Dateien in den ZZ_*-Ordnern einen Zielordner vor
// (Tabelle nas_vorschlaege, art 'zz', status 'offen'; RLS nur Admin).
//
// Layout (Okt. 2026, «unübersichtlich, man muss scrollen»): gruppiert nach
// dem Zielordner der KI (groesste Gruppe zuerst, aufklappbar), je Datei EINE
// Zeile — Name, Sicherheit, «Übernehmen», «Ablehnen». Alles Weitere (wo die
// Datei liegt, Begruendung, «Oder:»-Chips der Alternativen, «Anderer
// Ordner…») erst beim Aufklappen der Zeile. Die Liste scrollt intern, die
// Seite nicht.
//
// Bedienung wie bisher: Übernehmen = annehmen (Ziel unveraendert) bzw.
// korrigieren (anderer Ordner), Ablehnen = Datei bleibt, wo sie ist.
// Bewusst immer EINZELN, keine Sammelaktion (Entscheid Hauptsession
// 2026-10-14: Vorschlagsqualitaet reicht dafuer nicht). Verschoben wird beim
// naechsten NAS-Sync (ablage_moves).
//
// Rueckgabe-Vertrag der Route (src/app/api/ablage/nas-vorschlaege/route.ts):
// { success, ergebnisse: [{ id, ok, status?, fehler?, code? }] } — status
// «veraltet», wenn die Datei nicht mehr im Index liegt (MP-7, 409); ein
// schon entschiedener Vorschlag (zweiter Admin, zweiter Tab) kommt mit
// seinem End-Status zurueck und verschwindet ebenfalls.
//
// Neuer Dateiname (Migration 329): die Zeile zeigt den Namensvorschlag
// dezent («→ …»), das Detail ein Feld «Neuer Dateiname» (vorbefuellt mit dem
// Vorschlag, sonst dem aktuellen Namen; gleiche Pruefung wie der Server,
// lib/ki/dateiname). «Übernehmen» schickt `name`, wenn er vom aktuellen
// Namen abweicht — der NAS-Sync verschiebt UND benennt um. Vorschlaege von
// Claude (quelle 'claude') tragen einen Chip «Claude»; ein vorgeschlagener
// NEUER Ordner (ziel_neu) das Badge «neuer Ordner» — angelegt wird er erst
// beim Übernehmen. Vorschlaege aus dem zweiten Blick (Migration 347, Rezept
// «…+zb»: nachts vom grossen Modell der lokalen KI nochmals gelesen) tragen
// den Chip «zweiter Blick»; der Tooltip sagt, ob Ordner/Name vorher anders waren.
//
// Links in jeder Zeile eine kleine Dokumentenvorschau (zz-vorschau.tsx):
// erst bei Hover-Absicht vom NAS geholt, dann vergroessert beim Darueberfahren.
// Der Pfad-Tooltip haengt nur am Dateinamen (nicht an der Vorschau).
//
// Doppel-Pruefung (Migration 334, lib/ki/doppel, doppel-daten.ts): Chip
// «Doppel» / «gleicher Inhalt» / «neuere Fassung» / «ältere Fassung» in der
// Zeile, im Detail ein Kasten mit beiden Mini-Vorschauen, dem Pfad der anderen
// Datei und den Aktionen «Doppel entfernen» (Quarantaene 99_System/Duplikate,
// nie loeschen), «Als neue Fassung ablegen» (alte in die Historie daneben, diese
// an ihren Platz — Name aus dem Feld) und «Beide behalten» (Hinweis weg).
//
// Gewaehlte Ordner und Namen, offene Gruppen und die aufgeklappte Zeile
// ueberleben den Reload (§10, localStorage — nur IDs, Ordner, Dateinamen).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { Archive, ChevronDown, ChevronRight, Copy, Folder, FolderInput, History, Inbox, Loader2, TriangleAlert, X } from "lucide-react";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { pruefeDateiname } from "@/lib/ki/dateiname";
import type { NasVorschlagQuelle, OrdnerSicherheit } from "@/lib/ki/typen";
import { zielGesperrt as istGesperrtesZiel } from "@/lib/ki/pfade";
import { DOPPEL_QUARANTAENE, hinweisFuer, type DoppelHinweis, type DoppelMitglied } from "@/lib/ki/doppel";
import { istZweiterBlick, zweiterBlickHinweis } from "@/lib/ki/zweiter-blick";
import { behaltenSchluessel, doppelAktion, useDoppelDaten } from "./doppel-daten";
import { nameVon } from "./ki-hilfen";
import { ZzVorschau } from "./zz-vorschau";

/** Zeile aus nas_vorschlaege (Migration 303) — nur die Spalten der Anzeige. */
interface ZzVorschlag {
  id: string;
  pfad: string;
  ordner_ist: string;
  ziel_ordner: string;
  alternativen: string[];
  sicherheit: OrdnerSicherheit;
  quelle: NasVorschlagQuelle;
  begruendung: string | null;
  /** Migration 329 */
  name_vorschlag: string | null;
  rezept: string | null;
  ziel_neu: boolean | null;
  /** Migration 347 — Ziel und Name des Vorschlags, den dieser ersetzt hat (null = keiner). */
  ersetzt_ziel: string | null;
  ersetzt_name: string | null;
}

type Aktion = "annehmen" | "korrigieren" | "ablehnen";
interface Entscheid { id: string; aktion: Aktion; ordner?: string; name?: string }
/** Ergebnis je Eintrag laut MP-7 («Antwort je Eintrag ok/Fehler»), siehe
 *  Vertrag oben; tolerant gelesen. */
interface EntscheidErgebnis { id: string; ok: boolean; status?: string; fehler?: string; error?: string }
/** Ausgang eines Entscheids: ok, veraltet (Datei liegt nicht mehr dort —
 *  Vorschlag verschwindet, aber ohne Erfolgsmeldung), schon entschieden
 *  (jemand anderes war schneller — verschwindet mit Hinweis) oder Fehler. */
type Ausgang = { art: "ok" } | { art: "veraltet" } | { art: "schon"; meldung: string } | { art: "fehler"; meldung: string };
/** End-Status, bei denen der Vorschlag nicht mehr offen ist. */
const ENTSCHIEDEN = new Set(["angenommen", "korrigiert", "abgelehnt", "erledigt"]);

/** So viele werden auf einmal geladen (heute ~300) — gruppiert wird ueber
 *  alles Geladene; mehr per «Weitere laden». */
const SEITE = 500;
const WAHL_KEY = "nas-zz-wahl";
const OFFEN_KEY = "nas-zz-gruppen-offen";
const AUF_KEY = "nas-zz-auf";
const NAMEN_KEY = "nas-zz-namen";

const QUELLE_LABEL: Record<ZzVorschlag["quelle"], string> = {
  regel: "nach fester Regel",
  vorbild: "nach ähnlichen abgelegten Dokumenten",
  modell: "von der lokalen KI gelesen",
  claude: "von Claude vorgeschlagen",
};
// Einschätzung der KI, kein Gewissheitsversprechen: «hoch» heisst «Platz 1 der Rangliste UND ein ähnliches Vorbild
// (≥ 0,85) im Zielordner» (Rig-Rezept zz/v2, seit 14.10.; vorher nur Platz 1) — daher kein Grün.
// Gleiche Stufen und Farben wie bei den Fristen (fristen-gruppe.tsx).
const SICHERHEIT_LABEL: Record<ZzVorschlag["sicherheit"], string> = { hoch: "wahrscheinlich", mittel: "möglich", niedrig: "unsicher" };
const SICHERHEIT_KLASSE: Record<ZzVorschlag["sicherheit"], string> = {
  hoch: "bg-muted text-foreground",
  mittel: "bg-muted text-muted-foreground",
  niedrig: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
};

/** Doppel-Prüfung (Migration 334): Chip in der Zeile — kompakt, Text und Pfad im Tooltip, Aktionen im Detail. */
const DOPPEL_CHIP: Record<DoppelHinweis["art"], { label: string; klasse: string; text: string }> = {
  exakt: {
    label: "Doppel",
    klasse: "bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-100",
    text: "Liegt schon unter",
  },
  inhalt: {
    label: "gleicher Inhalt",
    klasse: "border border-violet-300 text-violet-800 dark:border-violet-400/50 dark:text-violet-200",
    text: "Wahrscheinlich gleiches Dokument (andere Form) wie",
  },
  fassung_neu: {
    label: "neuere Fassung",
    klasse: "border border-sky-300 text-sky-800 dark:border-sky-400/50 dark:text-sky-200",
    text: "Neuere Fassung von",
  },
  fassung_alt: {
    label: "ältere Fassung",
    klasse: "bg-muted text-muted-foreground",
    text: "Es gibt eine neuere Fassung:",
  },
};

/** Badge «neuer Ordner» (ziel_neu) — angelegt wird er erst beim Übernehmen. */
function NeuerOrdnerBadge() {
  return (
    <span
      className="shrink-0 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200"
      data-tooltip="Diesen Ordner gibt es noch nicht — er wird beim Übernehmen angelegt"
    >
      neuer Ordner
    </span>
  );
}

/** Name, den «Übernehmen» schickt (null = Name bleibt), und ob er gültig ist. */
function namensWahl(eingabe: string, aktuell: string): { name: string | null; fehler: string | null } {
  const t = eingabe.trim();
  if (!t || t.normalize("NFC") === aktuell.normalize("NFC")) return { name: null, fehler: null };
  const p = pruefeDateiname(t, aktuell);
  return p.ok ? { name: p.name, fehler: null } : { name: null, fehler: p.grund };
}

function kurz(pfad: string): string {
  return pfad.split("/").slice(-2).join("/");
}
/** «A/B/C/D» -> ["A/B/", "C/D"]: Vorderteil gedaempft, Ende immer lesbar. */
function teilePfad(pfad: string): [string, string] {
  const t = pfad.split("/");
  if (t.length <= 2) return ["", pfad];
  return [t.slice(0, -2).join("/") + "/", t.slice(-2).join("/")];
}
/** Ordner einer ZZ-Datei ohne den ZZ-Stamm («ZZ_Dokumente…/_EVENTLINE/Leads» -> «_EVENTLINE/Leads»). */
function zzRest(ordner: string): string {
  const t = ordner.split("/");
  return t.length > 1 ? t.slice(1).join("/") : ordner;
}
function leseJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const roh = localStorage.getItem(key);
    return roh ? (JSON.parse(roh) as T) : fallback;
  } catch {
    return fallback;
  }
}
function schreibeJson(key: string, wert: unknown) {
  try { localStorage.setItem(key, JSON.stringify(wert)); } catch { /* egal */ }
}

export function RueckstauZz({
  supabase,
  takt,
  ordnerOptionen,
  waehlbareOrdner,
  onAnzahl,
}: {
  supabase: SupabaseClient;
  /** Live-Takt der Seite (NAS hat gepollt) — laedt still nach. */
  takt: number;
  /** Effektiv aktive Ordner (gleiche Liste wie beim Ablegen). */
  ordnerOptionen: SelectItem[];
  waehlbareOrdner: Set<string>;
  /** Anzahl offener Vorschlaege fuer den Umschalter der Seite (null = laedt). */
  onAnzahl?: (n: number | null) => void;
}) {
  const [liste, setListe] = useState<ZzVorschlag[]>([]);
  const [gesamt, setGesamt] = useState<number | null>(null);
  const [anzahlGeladen, setAnzahlGeladen] = useState(SEITE);
  const [laedtMehr, setLaedtMehr] = useState(false);
  /** Vom Nutzer gewaehlter Ordner je Vorschlag (fehlt = Vorschlag der KI). */
  const [wahl, setWahl] = useState<Record<string, string>>(() => leseJson(WAHL_KEY, {}));
  /** Vom Nutzer eingetippter Dateiname je Vorschlag (fehlt = Namensvorschlag bzw. aktueller Name). */
  const [namen, setNamen] = useState<Record<string, string>>(() => leseJson(NAMEN_KEY, {}));
  const [andererFuer, setAndererFuer] = useState<string | null>(null);
  /** Aufgeklappte Zielordner-Gruppen. */
  const [offen, setOffen] = useState<string[]>(() => leseJson(OFFEN_KEY, []));
  /** Aufgeklappte Zeile (Details). */
  const [auf, setAuf] = useState<string | null>(() => leseJson<string | null>(AUF_KEY, null));
  /** IDs, deren Entscheid gerade unterwegs ist (Spinner + gesperrt). */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const fehlerGemeldet = useRef(false);
  // Doppel-Pruefung (Migration 334): dieselben Daten wie «Doppelte», je Takt neu.
  const { daten: doppel, neuLaden: doppelNeu } = useDoppelDaten(takt);
  const hinweisVon = useCallback(
    (pfad: string): DoppelHinweis | null => {
      if (!doppel) return null;
      const h = hinweisFuer(pfad, doppel.gruppen);
      if (!h) return null;
      const andere = h.andere.filter((m) => !doppel.behalten.has(behaltenSchluessel(pfad, m.pfad)));
      return andere.length ? { ...h, andere } : null;
    },
    [doppel],
  );

  useEffect(() => { schreibeJson(WAHL_KEY, wahl); }, [wahl]);
  useEffect(() => { schreibeJson(NAMEN_KEY, namen); }, [namen]);
  useEffect(() => { schreibeJson(OFFEN_KEY, offen); }, [offen]);
  useEffect(() => { schreibeJson(AUF_KEY, auf); }, [auf]);
  useEffect(() => { onAnzahl?.(gesamt); }, [gesamt, onAnzahl]);

  /** Laufnummer der Ladevorgaenge: nur die Antwort des JUENGSTEN darf den
   *  Stand setzen (Entscheid, Takt und «Weitere laden» laden parallel). */
  const ladeNr = useRef(0);

  const laden = useCallback(async (anzahl: number) => {
    const nr = ++ladeNr.current;
    const { data, error, count } = await supabase
      .from("nas_vorschlaege")
      .select("id, pfad, ordner_ist, ziel_ordner, alternativen, sicherheit, quelle, begruendung, name_vorschlag, rezept, ziel_neu, ersetzt_ziel, ersetzt_name", { count: "exact" })
      .eq("art", "zz")
      .eq("status", "offen")
      .order("ziel_ordner")
      .order("pfad")
      .range(0, anzahl - 1);
    if (nr !== ladeNr.current) return; // ueberholt — ein neuerer Stand kommt
    setLaedtMehr(false);
    if (error) {
      // Tabelle noch nicht eingespielt (Migration 302) -> Bereich bleibt leer.
      // Jeder andere Fehler einmal als Toast, nicht bei jedem Takt.
      const fehlt = error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message);
      if (!fehlt && !fehlerGemeldet.current) {
        fehlerGemeldet.current = true;
        toast.error("Vorschläge zum Einsortieren konnten nicht geladen werden: " + error.message);
      }
      setGesamt((g) => g ?? 0);
      return;
    }
    fehlerGemeldet.current = false;
    setListe((data ?? []) as ZzVorschlag[]);
    setGesamt(count ?? (data ?? []).length);
  }, [supabase]);

  useEffect(() => {
    // State wird erst nach der Antwort gesetzt (asynchron).
    void (async () => { await laden(anzahlGeladen); })();
  }, [laden, anzahlGeladen, takt]);

  /** Ziel, das «Übernehmen» gerade schicken wuerde. */
  const zielVon = useCallback((v: ZzVorschlag) => wahl[v.id] ?? v.ziel_ordner, [wahl]);
  /** Inhalt des Namensfelds: eigene Eingabe, sonst Vorschlag, sonst aktueller Name. */
  const nameEingabeVon = useCallback((v: ZzVorschlag) => namen[v.id] ?? v.name_vorschlag ?? nameVon(v.pfad), [namen]);

  function setzeName(id: string, name: string) {
    setNamen((n) => ({ ...n, [id]: name }));
  }

  // Gleiche Sperre wie der Server (lib/ki/pfade): nie ZZ_* (jede
  // Schreibweise), nie 99_System.
  const ordnerOhneZz = useMemo(() => ordnerOptionen.filter((o) => !istGesperrtesZiel(o.id)), [ordnerOptionen]);

  /** Gruppen nach Zielordner der KI — groesste zuerst, innen nach Dateiname. */
  const gruppen = useMemo(() => {
    const m = new Map<string, ZzVorschlag[]>();
    for (const v of liste) m.set(v.ziel_ordner, [...(m.get(v.ziel_ordner) ?? []), v]);
    return [...m.entries()]
      .map(([ziel, vs]) => ({ ziel, vs: vs.sort((a, b) => nameVon(a.pfad).localeCompare(nameVon(b.pfad), "de")) }))
      .sort((a, b) => b.vs.length - a.vs.length || a.ziel.localeCompare(b.ziel, "de"));
  }, [liste]);

  function setzeWahl(id: string, ordner: string, kiZiel: string) {
    setWahl((w) => {
      const n = { ...w };
      if (ordner === kiZiel) delete n[id];
      else n[id] = ordner;
      return n;
    });
  }

  function entferne(ids: string[]) {
    const weg = new Set(ids);
    setListe((l) => l.filter((v) => !weg.has(v.id)));
    setGesamt((g) => Math.max(0, (g ?? 0) - ids.length));
    const ohne = (w: Record<string, string>) => {
      if (!ids.some((id) => id in w)) return w;
      const n = { ...w };
      for (const id of ids) delete n[id];
      return n;
    };
    setWahl(ohne);
    setNamen(ohne);
  }

  /** Schickt genau einen Entscheid und liest das Ergebnis zu dieser ID. */
  async function sende(entscheid: Entscheid): Promise<Ausgang> {
    let json: { success?: boolean; error?: string; ergebnisse?: EntscheidErgebnis[] } | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/ablage/nas-vorschlaege", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entscheide: [entscheid] }),
      });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch {
      return { art: "fehler", meldung: "Netzwerkfehler" };
    }
    const e = Array.isArray(json?.ergebnisse) ? json.ergebnisse.find((x) => x?.id === entscheid.id) : undefined;
    if (!e) {
      // Kein Einzel-Ergebnis: Erfolg nur bei 2xx + success.
      if (status >= 200 && status < 300 && json?.success) return { art: "ok" };
      return { art: "fehler", meldung: json?.error ?? `HTTP ${status}` };
    }
    if (e.ok) return { art: "ok" };
    // «veraltet» (MP-7: Datei nicht mehr im Index) — der Vorschlag gilt
    // nicht mehr, verschoben wird aber nichts.
    if (e.status === "veraltet") return { art: "veraltet" };
    if (e.status && ENTSCHIEDEN.has(e.status)) return { art: "schon", meldung: e.fehler ?? "Schon entschieden" };
    return { art: "fehler", meldung: e.fehler ?? e.error ?? "Konflikt" };
  }

  function entscheidFuer(v: ZzVorschlag, ablehnen = false): Entscheid {
    if (ablehnen) return { id: v.id, aktion: "ablehnen" };
    const ziel = zielVon(v);
    const { name } = namensWahl(nameEingabeVon(v), nameVon(v.pfad));
    const basis: Entscheid = ziel === v.ziel_ordner ? { id: v.id, aktion: "annehmen" } : { id: v.id, aktion: "korrigieren", ordner: ziel };
    return name ? { ...basis, name } : basis;
  }

  async function einzeln(v: ZzVorschlag, ablehnen = false) {
    if (busy.has(v.id)) return;
    setBusy((b) => new Set(b).add(v.id));
    setAndererFuer(null);
    const ziel = zielVon(v);
    const entscheid = entscheidFuer(v, ablehnen);
    const ausgang = await sende(entscheid);
    setBusy((b) => { const n = new Set(b); n.delete(v.id); return n; });
    if (ausgang.art === "fehler") {
      toast.error((ablehnen ? "Ablehnen" : "Übernehmen") + " fehlgeschlagen: " + ausgang.meldung);
      return;
    }
    entferne([v.id]);
    if (auf === v.id) setAuf(null);
    // Stand aus der DB nachladen — sonst fehlten Vorschlaege hinter den geladenen.
    void laden(anzahlGeladen);
    if (ausgang.art === "veraltet") toast.info("Datei liegt nicht mehr dort — Vorschlag entfernt");
    else if (ausgang.art === "schon") toast.info(ausgang.meldung);
    else if (ablehnen) toast.success("Vorschlag abgelehnt — die Datei bleibt, wo sie ist");
    else toast.success(`Wird beim nächsten Sync nach «${ziel}» verschoben${entscheid.name ? ` und in «${entscheid.name}» umbenannt` : ""}`);
  }

  /** Doppel-Aktion fuer eine Zeile (Spinner wie beim Übernehmen); Fehler → Toast. */
  async function mitBusy<T>(v: ZzVorschlag, f: () => Promise<T>): Promise<T | null> {
    if (busy.has(v.id)) return null;
    setBusy((b) => new Set(b).add(v.id));
    try {
      return await f();
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(v.id); return n; });
    }
  }

  async function doppelEntfernen(v: ZzVorschlag) {
    const r = await mitBusy(v, () => doppelAktion({ aktion: "entfernen", pfad: v.pfad }));
    if (!r) return;
    if (!r.ok) {
      toast.error("Doppel entfernen fehlgeschlagen: " + r.meldung);
      return;
    }
    entferne([v.id]);
    if (auf === v.id) setAuf(null);
    void laden(anzahlGeladen);
    void doppelNeu();
    toast.success(`Wird beim nächsten Sync nach «${r.ziel ?? DOPPEL_QUARANTAENE}» verschoben — nicht gelöscht`);
  }

  async function beideBehalten(v: ZzVorschlag, andere: DoppelMitglied[]) {
    const r = await mitBusy(v, async () => {
      for (const m of andere) {
        const x = await doppelAktion({ aktion: "behalten", pfad: v.pfad, anderer: m.pfad });
        if (!x.ok) return x;
      }
      return { ok: true as const };
    });
    if (!r) return;
    if (!r.ok) {
      toast.error("Speichern fehlgeschlagen: " + r.meldung);
      return;
    }
    void doppelNeu();
    toast.success("Beide bleiben — der Hinweis ist ausgeblendet");
  }

  async function alsNeueFassung(v: ZzVorschlag, alt: DoppelMitglied) {
    const { name, fehler: nameFehler } = namensWahl(nameEingabeVon(v), nameVon(v.pfad));
    if (nameFehler) {
      toast.error(`Dateiname ungültig: ${nameFehler}`);
      return;
    }
    const r = await mitBusy(v, () =>
      doppelAktion({ aktion: "fassung", pfad: v.pfad, anderer: alt.pfad, vorschlag_id: v.id, ...(name ? { name } : {}) }),
    );
    if (!r) return;
    if (!r.ok) {
      toast.error("Als neue Fassung ablegen fehlgeschlagen: " + r.meldung);
      return;
    }
    entferne([v.id]);
    if (auf === v.id) setAuf(null);
    void laden(anzahlGeladen);
    void doppelNeu();
    toast.success(
      r.historie
        ? `Beim nächsten Sync: alte Fassung nach «${r.historie}», die neue an ihren Platz in «${r.ziel}»`
        : `Beim nächsten Sync: die neue Fassung nach «${r.ziel}» (die alte liegt schon in der Historie)`,
    );
  }

  function gruppeUmschalten(ziel: string) {
    setOffen((o) => (o.includes(ziel) ? o.filter((x) => x !== ziel) : [...o, ziel]));
  }

  if (gesamt === null) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2, 3, 4].map((i) => <div key={i} className="shimmer rounded-md h-8" />)}
      </div>
    );
  }
  if (liste.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="Nichts einzusortieren"
        description="Die lokale KI schlägt nachts Zielordner für Dateien in den ZZ-Ordnern vor. Offene Vorschläge erscheinen hier."
      />
    );
  }

  const alleOffen = gruppen.every((g) => offen.includes(g.ziel));

  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="rueckstau-zz">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border">
        <p className="text-[11px] text-muted-foreground min-w-0 flex-1">
          {gesamt} {gesamt === 1 ? "Datei" : "Dateien"} in {gruppen.length} Zielordnern — verschoben wird erst nach «Übernehmen», beim nächsten Sync.
        </p>
        <button
          type="button"
          onClick={() => setOffen(alleOffen ? [] : gruppen.map((g) => g.ziel))}
          className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2"
        >
          {alleOffen ? "Alle zuklappen" : "Alle aufklappen"}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {gruppen.map((g) => {
          const istOffen = offen.includes(g.ziel);
          const [vorne, ende] = teilePfad(g.ziel);
          const unsicher = g.vs.filter((v) => v.sicherheit === "niedrig").length;
          return (
            <section key={g.ziel} className="border-b border-border last:border-b-0">
              <div className={`sticky top-0 z-[1] bg-card flex items-center gap-2 pl-2 pr-3 py-1.5 ${istOffen ? "border-b border-border/60" : ""}`}>
                <button
                  type="button"
                  onClick={() => gruppeUmschalten(g.ziel)}
                  aria-expanded={istOffen}
                  className="row-hover [--row-hover-x:0rem] flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left"
                  data-testid="zz-gruppe-kopf"
                  data-tooltip={g.ziel}
                >
                  <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${istOffen ? "rotate-90" : ""}`} />
                  <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
                  <span className="flex min-w-0 items-baseline font-mono text-xs">
                    {vorne && <span className="min-w-0 truncate text-muted-foreground">{vorne}</span>}
                    <span className="shrink-0 max-w-[85%] truncate font-medium">{ende}</span>
                  </span>
                  <span className="ml-1 shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">{g.vs.length}</span>
                  {g.vs[0]?.ziel_neu && !waehlbareOrdner.has(g.ziel) && <NeuerOrdnerBadge />}
                  {unsicher > 0 && (
                    <span className="shrink-0 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                      <TriangleAlert className="h-2.5 w-2.5" />
                      {unsicher} unsicher
                    </span>
                  )}
                </button>
              </div>
              {istOffen && (
                <ul className="py-0.5">
                  {g.vs.map((v) => (
                    <Zeile
                      key={v.id}
                      supabase={supabase}
                      v={v}
                      ziel={zielVon(v)}
                      nameEingabe={nameEingabeVon(v)}
                      auf={auf === v.id}
                      laeuft={busy.has(v.id)}
                      waehlbareOrdner={waehlbareOrdner}
                      andererOffen={andererFuer === v.id}
                      ordnerOhneZz={ordnerOhneZz}
                      onAuf={() => setAuf((a) => (a === v.id ? null : v.id))}
                      onWahl={(o) => setzeWahl(v.id, o, v.ziel_ordner)}
                      onName={(n) => setzeName(v.id, n)}
                      onAnderer={(an) => setAndererFuer(an ? v.id : null)}
                      onUebernehmen={() => einzeln(v)}
                      onAblehnen={() => einzeln(v, true)}
                      doppel={hinweisVon(v.pfad)}
                      onDoppelEntfernen={() => doppelEntfernen(v)}
                      onBeideBehalten={(andere) => beideBehalten(v, andere)}
                      onNeueFassung={(alt) => alsNeueFassung(v, alt)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {(gesamt ?? 0) > liste.length && (
          <div className="p-3">
            <button
              type="button"
              onClick={() => { setLaedtMehr(true); setAnzahlGeladen((n) => n + SEITE); }}
              disabled={laedtMehr}
              className="kasten kasten-muted w-full justify-center"
            >
              {laedtMehr && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Weitere laden ({(gesamt ?? 0) - liste.length})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Doppel-Hinweis im Detail einer ZZ-Zeile: Mini-Vorschau beider Dateien, Pfad der anderen, Aktionen — kompakt
 *  (zwei Zeilen). Verschoben wird nur auf Klick, beim nächsten Sync; nichts wird gelöscht. */
function DoppelBox({
  supabase, pfad, hinweis, laeuft, onEntfernen, onBehalten, onFassung,
}: {
  supabase: SupabaseClient;
  pfad: string;
  hinweis: DoppelHinweis;
  laeuft: boolean;
  onEntfernen: () => void;
  onBehalten: () => void;
  onFassung: () => void;
}) {
  const anderer = hinweis.andere[0];
  const chip = DOPPEL_CHIP[hinweis.art];
  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/70 px-2 py-1.5 dark:border-violet-500/35 dark:bg-violet-500/10" data-testid="zz-doppel-box">
      <div className="flex min-w-0 items-center gap-1.5">
        <ZzVorschau supabase={supabase} pfad={pfad} />
        <span className="shrink-0 text-violet-700 dark:text-violet-300">↔</span>
        <ZzVorschau supabase={supabase} pfad={anderer.pfad} />
        <span className="shrink-0 text-violet-900 dark:text-violet-100">{chip.text}</span>
        <span className="min-w-0 truncate font-mono text-violet-900 dark:text-violet-100" data-tooltip={anderer.pfad}>{anderer.pfad}</span>
        {hinweis.andere.length > 1 && (
          <span className="shrink-0 text-[10px] text-violet-700 dark:text-violet-300" data-tooltip={hinweis.andere.slice(1).map((m) => m.pfad).join("\n")}>
            +{hinweis.andere.length - 1}
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {(hinweis.art === "exakt" || hinweis.art === "inhalt") && (
          <button
            type="button"
            onClick={onEntfernen}
            disabled={laeuft}
            className="kasten kasten-red px-2 py-0.5 text-[11px]"
            data-tooltip={`Diese ZZ-Datei nach ${DOPPEL_QUARANTAENE}/… verschieben (nicht löschen) — die andere bleibt`}
            data-testid="zz-doppel-entfernen"
          >
            {laeuft ? <Loader2 className="h-3 w-3 animate-spin" /> : <Archive className="h-3 w-3" />}
            Doppel entfernen
          </button>
        )}
        {hinweis.art === "fassung_neu" && (
          <button
            type="button"
            onClick={onFassung}
            disabled={laeuft}
            className="kasten kasten-blue px-2 py-0.5 text-[11px]"
            data-tooltip="Alte Fassung in den Historie-Ordner daneben, diese an ihren Platz (Name aus dem Feld unten)"
            data-testid="zz-doppel-fassung"
          >
            {laeuft ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
            Als neue Fassung ablegen
          </button>
        )}
        {hinweis.art !== "exakt" && (
          <button
            type="button"
            onClick={onBehalten}
            disabled={laeuft}
            className="kasten kasten-muted px-2 py-0.5 text-[11px]"
            data-tooltip="Sind verschiedene Dokumente — Hinweis ausblenden"
            data-testid="zz-doppel-behalten"
          >
            <Copy className="h-3 w-3" />
            Beide behalten
          </button>
        )}
        {hinweis.art === "exakt" && <span className="text-[10px] text-violet-800 dark:text-violet-200">Gleiche Bytes — nicht nochmals ablegen.</span>}
      </div>
    </div>
  );
}

/** Eine Datei: eine Zeile, Details beim Aufklappen. */
function Zeile({
  supabase, v, ziel, nameEingabe, auf, laeuft, waehlbareOrdner, andererOffen, ordnerOhneZz,
  onAuf, onWahl, onName, onAnderer, onUebernehmen, onAblehnen,
  doppel, onDoppelEntfernen, onBeideBehalten, onNeueFassung,
}: {
  doppel: DoppelHinweis | null;
  onDoppelEntfernen: () => void;
  onBeideBehalten: (andere: DoppelMitglied[]) => void;
  onNeueFassung: (alt: DoppelMitglied) => void;
  supabase: SupabaseClient;
  v: ZzVorschlag;
  ziel: string;
  nameEingabe: string;
  auf: boolean;
  laeuft: boolean;
  waehlbareOrdner: Set<string>;
  andererOffen: boolean;
  ordnerOhneZz: SelectItem[];
  onAuf: () => void;
  onWahl: (ordner: string) => void;
  onName: (name: string) => void;
  onAnderer: (offen: boolean) => void;
  onUebernehmen: () => void;
  onAblehnen: () => void;
}) {
  const korrigiert = ziel !== v.ziel_ordner;
  // Neuer Ordner (Claude): gibt es ihn noch nicht, muss der Oberordner
  // waehlbar sein — angelegt wird er beim Übernehmen (Server prueft nochmals).
  const zielNeu = !!v.ziel_neu && ziel === v.ziel_ordner && !waehlbareOrdner.has(ziel);
  const oberordner = ziel.slice(0, Math.max(0, ziel.lastIndexOf("/")));
  const zielGesperrt = istGesperrtesZiel(ziel) || !waehlbareOrdner.has(zielNeu ? oberordner : ziel);
  const aktuellerName = nameVon(v.pfad);
  const { name: neuerName, fehler: nameFehler } = namensWahl(nameEingabe, aktuellerName);
  // «Oder:»-Chips: Alternativen der KI plus — nach einem Tausch — der
  // urspruengliche Vorschlag; nur waehlbare Ordner (bzw. der neue Ordner
  // des Vorschlags), nie ZZ.
  const oder = [v.ziel_ordner, ...v.alternativen].filter(
    (a, i, arr) => a !== ziel && arr.indexOf(a) === i && (waehlbareOrdner.has(a) || (a === v.ziel_ordner && !!v.ziel_neu)) && !istGesperrtesZiel(a),
  );
  const sperrGrund = zielGesperrt ? "Ordner inzwischen gesperrt — anderen wählen" : nameFehler ? `Dateiname ungültig: ${nameFehler}` : null;
  const tooltip = [
    `${SICHERHEIT_LABEL[v.sicherheit].replace(/^./, (c) => c.toUpperCase())} — ${QUELLE_LABEL[v.quelle]}`,
    v.begruendung ? `«${v.begruendung}»` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li data-testid="zz-zeile" className={auf ? "bg-muted/40 dark:bg-muted/60" : ""}>
      <div className="row-hover [--row-hover-x:0.25rem] flex items-center gap-2 pl-7 pr-3 py-1">
        {/* Pfad-Tooltip nur am Dateinamen — nicht an der Vorschau, sonst deckt er die grosse Vorschau ab. */}
        <button
          type="button"
          onClick={onAuf}
          aria-expanded={auf}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          data-testid="zz-auf"
        >
          <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${auf ? "rotate-90" : ""}`} />
          <ZzVorschau supabase={supabase} pfad={v.pfad} />
          <span className="min-w-0 truncate text-[13px]" data-tooltip={v.pfad}>{aktuellerName}</span>
          {neuerName && (
            <span className="min-w-0 max-w-[45%] shrink truncate text-[11px] text-muted-foreground" data-tooltip={`Neuer Name: ${neuerName}`} data-testid="zz-neuer-name">
              → {neuerName}
            </span>
          )}
        </button>
        {doppel && (
          <span
            className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${DOPPEL_CHIP[doppel.art].klasse}`}
            data-tooltip={`${DOPPEL_CHIP[doppel.art].text} ${doppel.andere[0].pfad}${doppel.andere.length > 1 ? ` (+${doppel.andere.length - 1})` : ""}`}
            data-testid="zz-doppel-chip"
          >
            {DOPPEL_CHIP[doppel.art].label}
          </span>
        )}
        {v.quelle === "claude" && (
          <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground" data-tooltip="Vorschlag von Claude">
            Claude
          </span>
        )}
        {istZweiterBlick(v.rezept) && (
          <span
            className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground"
            data-tooltip={zweiterBlickHinweis(v)}
            data-testid="zz-zweiter-blick"
          >
            zweiter Blick
          </span>
        )}
        {zielGesperrt ? (
          // Sichtbar in der Zeile: der Knopf ist dann gesperrt (ohne Tooltip).
          <span
            className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
            data-tooltip={`«${ziel}» ist inzwischen gesperrt — aufklappen und anderen Ordner wählen`}
          >
            <TriangleAlert className="h-2.5 w-2.5" />
            Ordner gesperrt
          </span>
        ) : korrigiert ? (
          <span
            className="hidden sm:inline-flex min-w-0 max-w-[40%] items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200"
            data-tooltip={`Von dir gewählt: ${ziel}`}
          >
            <Folder className="h-2.5 w-2.5 shrink-0" />
            <span className="min-w-0 truncate font-mono">{kurz(ziel)}</span>
          </span>
        ) : (
          <span
            className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${SICHERHEIT_KLASSE[v.sicherheit]}`}
            data-tooltip={tooltip}
          >
            {v.sicherheit === "niedrig" && <TriangleAlert className="h-2.5 w-2.5" />}
            {SICHERHEIT_LABEL[v.sicherheit]}
          </span>
        )}
        <button
          type="button"
          onClick={onUebernehmen}
          disabled={laeuft || !!sperrGrund}
          className="kasten shrink-0 px-2 py-1 text-[11px]"
          aria-label="Übernehmen"
          data-tooltip={sperrGrund ?? `Nach «${ziel}» verschieben${neuerName ? ` und in «${neuerName}» umbenennen` : ""}`}
        >
          {laeuft ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderInput className="h-3 w-3" />}
          <span className="hidden sm:inline">Übernehmen</span>
        </button>
        <button
          type="button"
          onClick={onAblehnen}
          disabled={laeuft}
          className="icon-btn shrink-0"
          aria-label="Ablehnen"
          data-tooltip="Ablehnen — die Datei bleibt, wo sie ist"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {auf && (
        <div className="pl-[3.25rem] pr-3 pb-2 pt-0.5 space-y-1.5 text-[11px]">
          {doppel && (
            <DoppelBox
              supabase={supabase}
              pfad={v.pfad}
              hinweis={doppel}
              laeuft={laeuft}
              onEntfernen={onDoppelEntfernen}
              onBehalten={() => onBeideBehalten(doppel.andere)}
              onFassung={() => onNeueFassung(doppel.andere[0])}
            />
          )}
          <p className="text-muted-foreground flex min-w-0 items-center gap-1">
            <span className="shrink-0">Liegt in:</span>
            <span className="min-w-0 truncate font-mono" data-tooltip={v.ordner_ist}>{zzRest(v.ordner_ist)}</span>
          </p>
          <div className="flex min-w-0 items-center gap-1.5 flex-wrap">
            <span className="text-muted-foreground shrink-0">Nach:</span>
            <span
              className={`inline-flex min-w-0 max-w-full items-center gap-1 px-2 py-0.5 rounded-md border ${korrigiert ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200" : "border-border bg-background"}`}
              data-tooltip={ziel}
            >
              <Folder className="h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" />
              <span className="min-w-0 truncate font-mono">{ziel}</span>
            </span>
            {zielNeu && <NeuerOrdnerBadge />}
            {korrigiert ? (
              <span className="text-[10px] text-blue-700 dark:text-blue-300">von dir gewählt</span>
            ) : (
              <span className="text-[10px] text-muted-foreground">{QUELLE_LABEL[v.quelle]}</span>
            )}
            {zielGesperrt && <span className="text-[10px] text-amber-700 dark:text-amber-300">Ordner inzwischen gesperrt — anderen wählen</span>}
          </div>
          {v.begruendung && <p className="text-muted-foreground">«{v.begruendung}»</p>}
          <div className="flex min-w-0 items-center gap-1.5 flex-wrap">
            <label htmlFor={`zz-name-${v.id}`} className="text-muted-foreground shrink-0">Neuer Dateiname:</label>
            <Input
              id={`zz-name-${v.id}`}
              value={nameEingabe}
              onChange={(ev) => onName(ev.target.value)}
              disabled={laeuft}
              className="h-7 min-w-0 flex-1 max-w-md font-mono text-xs"
              spellCheck={false}
              data-testid="zz-name"
            />
            {nameFehler ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-amber-700 dark:text-amber-300" data-testid="zz-name-fehler">
                <TriangleAlert className="h-2.5 w-2.5 shrink-0" />
                {nameFehler}
              </span>
            ) : neuerName ? (
              <button
                type="button"
                onClick={() => onName(aktuellerName)}
                disabled={laeuft}
                className="text-[10px] text-muted-foreground underline underline-offset-2"
                data-tooltip={`Aktueller Name: ${aktuellerName}`}
              >
                Name behalten
              </button>
            ) : (
              <span className="text-[10px] text-muted-foreground">Name bleibt</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {oder.length > 0 && <span className="text-muted-foreground">Oder:</span>}
            {oder.map((a) => (
              <button
                key={a}
                type="button"
                onClick={() => onWahl(a)}
                disabled={laeuft}
                className="kasten kasten-muted max-w-full px-2 py-0.5 text-[11px]"
                data-tooltip={a === v.ziel_ordner ? `Vorschlag der KI: ${a}` : a}
              >
                <Folder className="h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" />
                <span className="min-w-0 truncate font-mono">{kurz(a)}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => onAnderer(!andererOffen)}
              disabled={laeuft}
              className="text-muted-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
            >
              Anderer Ordner…
              <ChevronDown className={`h-3 w-3 transition-transform ${andererOffen ? "rotate-180" : ""}`} />
            </button>
          </div>
          {andererOffen && (
            <div className="max-w-md">
              <SearchableSelect
                value=""
                onChange={(o) => { if (o) { onWahl(o); onAnderer(false); } }}
                items={ordnerOhneZz.filter((o) => o.id !== ziel)}
                placeholder="Zielordner wählen…"
              />
            </div>
          )}
        </div>
      )}
    </li>
  );
}
