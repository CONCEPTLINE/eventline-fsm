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
// Sammelaktion je Gruppe «n übernehmen»: schickt fuer alle NICHT unsicheren
// Vorschlaege der Gruppe mit KI-Ziel denselben Entscheid «annehmen» an
// dieselbe Route (Stuecke zu 50, Vertrag MP-7) — nach Rueckfrage; unsichere
// und von Hand umgestellte bleiben Einzelentscheide. Verschoben wird beim
// naechsten NAS-Sync (ablage_moves).
//
// Rueckgabe-Vertrag der Route (src/app/api/ablage/nas-vorschlaege/route.ts):
// { success, ergebnisse: [{ id, ok, status?, fehler?, code? }] } — status
// «veraltet», wenn die Datei nicht mehr im Index liegt (MP-7, 409); ein
// schon entschiedener Vorschlag (zweiter Admin, zweiter Tab) kommt mit
// seinem End-Status zurueck und verschwindet ebenfalls.
//
// Gewaehlte Ordner, offene Gruppen und die aufgeklappte Zeile ueberleben den
// Reload (§10, localStorage — nur IDs und Ordner).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { CheckCheck, ChevronDown, ChevronRight, FileText, Folder, FolderInput, Inbox, Loader2, TriangleAlert, X } from "lucide-react";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import type { NasVorschlagQuelle, OrdnerSicherheit } from "@/lib/ki/typen";
import { zielGesperrt as istGesperrtesZiel } from "@/lib/ki/pfade";
import { nameVon } from "./ki-hilfen";

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
}

type Aktion = "annehmen" | "korrigieren" | "ablehnen";
interface Entscheid { id: string; aktion: Aktion; ordner?: string }
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
/** Hoechstens so viele Entscheide je Aufruf (Route, MP-7). */
const STUECK = 50;
const WAHL_KEY = "nas-zz-wahl";
const OFFEN_KEY = "nas-zz-gruppen-offen";
const AUF_KEY = "nas-zz-auf";

const QUELLE_LABEL: Record<ZzVorschlag["quelle"], string> = {
  regel: "nach fester Regel",
  vorbild: "nach ähnlichen abgelegten Dokumenten",
  modell: "von der lokalen KI gelesen",
};
// Einschätzung der KI, kein Gewissheitsversprechen: «hoch» heisst nur «Platz 1 der Rangliste» — daher kein Grün.
// Gleiche Stufen und Farben wie bei den Fristen (fristen-gruppe.tsx).
const SICHERHEIT_LABEL: Record<ZzVorschlag["sicherheit"], string> = { hoch: "wahrscheinlich", mittel: "möglich", niedrig: "unsicher" };
const SICHERHEIT_KLASSE: Record<ZzVorschlag["sicherheit"], string> = {
  hoch: "bg-muted text-foreground",
  mittel: "bg-muted text-muted-foreground",
  niedrig: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
};

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
  const [andererFuer, setAndererFuer] = useState<string | null>(null);
  /** Aufgeklappte Zielordner-Gruppen. */
  const [offen, setOffen] = useState<string[]>(() => leseJson(OFFEN_KEY, []));
  /** Aufgeklappte Zeile (Details). */
  const [auf, setAuf] = useState<string | null>(() => leseJson<string | null>(AUF_KEY, null));
  /** IDs, deren Entscheid gerade unterwegs ist (Spinner + gesperrt). */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Zielordner, deren Sammelaktion gerade laeuft. */
  const [sammelt, setSammelt] = useState<string | null>(null);
  const fehlerGemeldet = useRef(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  useEffect(() => { schreibeJson(WAHL_KEY, wahl); }, [wahl]);
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
      .select("id, pfad, ordner_ist, ziel_ordner, alternativen, sicherheit, quelle, begruendung", { count: "exact" })
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
    setWahl((w) => {
      if (!ids.some((id) => id in w)) return w;
      const n = { ...w };
      for (const id of ids) delete n[id];
      return n;
    });
  }

  /** Schickt Entscheide (1–50) und liest das Ergebnis je ID. */
  async function sende(entscheide: Entscheid[]): Promise<Map<string, Ausgang>> {
    const aus = new Map<string, Ausgang>();
    let json: { success?: boolean; error?: string; ergebnisse?: EntscheidErgebnis[] } | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/ablage/nas-vorschlaege", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entscheide }),
      });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch {
      for (const e of entscheide) aus.set(e.id, { art: "fehler", meldung: "Netzwerkfehler" });
      return aus;
    }
    for (const entscheid of entscheide) {
      const e = Array.isArray(json?.ergebnisse) ? json.ergebnisse.find((x) => x?.id === entscheid.id) : undefined;
      if (!e) {
        // Kein Einzel-Ergebnis: Erfolg nur bei 2xx + success.
        aus.set(entscheid.id, status >= 200 && status < 300 && json?.success ? { art: "ok" } : { art: "fehler", meldung: json?.error ?? `HTTP ${status}` });
      } else if (e.ok) {
        aus.set(entscheid.id, { art: "ok" });
      } else if (e.status === "veraltet") {
        // «veraltet» (MP-7: Datei nicht mehr im Index) — der Vorschlag gilt
        // nicht mehr, verschoben wird aber nichts.
        aus.set(entscheid.id, { art: "veraltet" });
      } else if (e.status && ENTSCHIEDEN.has(e.status)) {
        aus.set(entscheid.id, { art: "schon", meldung: e.fehler ?? "Schon entschieden" });
      } else {
        aus.set(entscheid.id, { art: "fehler", meldung: e.fehler ?? e.error ?? "Konflikt" });
      }
    }
    return aus;
  }

  function entscheidFuer(v: ZzVorschlag, ablehnen = false): Entscheid {
    if (ablehnen) return { id: v.id, aktion: "ablehnen" };
    const ziel = zielVon(v);
    return ziel === v.ziel_ordner ? { id: v.id, aktion: "annehmen" } : { id: v.id, aktion: "korrigieren", ordner: ziel };
  }

  async function einzeln(v: ZzVorschlag, ablehnen = false) {
    if (busy.has(v.id)) return;
    setBusy((b) => new Set(b).add(v.id));
    setAndererFuer(null);
    const ziel = zielVon(v);
    const ausgang = (await sende([entscheidFuer(v, ablehnen)])).get(v.id)!;
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
    else toast.success(ablehnen ? "Vorschlag abgelehnt — die Datei bleibt, wo sie ist" : `Wird beim nächsten Sync nach «${ziel}» verschoben`);
  }

  /** Sammelbare Vorschlaege einer Gruppe: KI-Ziel unveraendert, nicht
   *  unsicher, Ziel waehlbar, nicht gerade unterwegs. */
  const sammelbar = useCallback(
    (vs: ZzVorschlag[]) => vs.filter((v) => !(v.id in wahl) && v.sicherheit !== "niedrig" && waehlbareOrdner.has(v.ziel_ordner) && !istGesperrtesZiel(v.ziel_ordner) && !busy.has(v.id)),
    [wahl, waehlbareOrdner, busy],
  );

  async function gruppeUebernehmen(ziel: string, vs: ZzVorschlag[]) {
    const kandidaten = sammelbar(vs);
    if (kandidaten.length === 0 || sammelt) return;
    const rest = vs.length - kandidaten.length;
    const ok = await confirm({
      title: `${kandidaten.length} ${kandidaten.length === 1 ? "Datei" : "Dateien"} übernehmen?`,
      message:
        `Ziel: «${ziel}»\n\nVerschoben wird beim nächsten Sync.` +
        (rest > 0 ? `\n\n${rest} weitere (unsicher oder von dir umgestellt) bleiben zum Einzelentscheid stehen.` : ""),
      confirmLabel: "Übernehmen",
      variant: "blue",
    });
    if (!ok) return;
    setSammelt(ziel);
    const ids = kandidaten.map((v) => v.id);
    setBusy((b) => new Set([...b, ...ids]));
    const ergebnis = new Map<string, Ausgang>();
    for (let i = 0; i < kandidaten.length; i += STUECK) {
      const teil = await sende(kandidaten.slice(i, i + STUECK).map((v) => ({ id: v.id, aktion: "annehmen" as const })));
      for (const [id, a] of teil) ergebnis.set(id, a);
    }
    setBusy((b) => { const n = new Set(b); for (const id of ids) n.delete(id); return n; });
    setSammelt(null);
    const weg = ids.filter((id) => ergebnis.get(id)?.art !== "fehler");
    entferne(weg);
    void laden(anzahlGeladen);
    const nOk = ids.filter((id) => ergebnis.get(id)?.art === "ok").length;
    const fehler = ids.filter((id) => ergebnis.get(id)?.art === "fehler");
    if (nOk > 0) toast.success(`${nOk} ${nOk === 1 ? "Datei wird" : "Dateien werden"} beim nächsten Sync nach «${kurz(ziel)}» verschoben`);
    if (weg.length > nOk) toast.info(`${weg.length - nOk} Vorschläge waren veraltet oder schon entschieden — entfernt`);
    if (fehler.length > 0) {
      const a = ergebnis.get(fehler[0]);
      toast.error(`${fehler.length} nicht übernommen: ${a && a.art === "fehler" ? a.meldung : "Fehler"}`);
    }
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
      {ConfirmModalElement}
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
          const sammel = sammelbar(g.vs);
          const unsicher = g.vs.filter((v) => v.sicherheit === "niedrig").length;
          const laeuftSammel = sammelt === g.ziel;
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
                  {unsicher > 0 && (
                    <span className="shrink-0 inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                      <TriangleAlert className="h-2.5 w-2.5" />
                      {unsicher} unsicher
                    </span>
                  )}
                </button>
                {/* Sammelaktion nur in der offenen Gruppe — zugeklappt bleibt
                    die Liste ein ruhiger Ueberblick (Ordner, Anzahl, unsicher). */}
                {istOffen && sammel.length > 0 && (
                  <button
                    type="button"
                    onClick={() => gruppeUebernehmen(g.ziel, g.vs)}
                    disabled={!!sammelt}
                    className="kasten shrink-0 px-2 py-1 text-[11px]"
                    data-tooltip={sammel.length === g.vs.length ? "Alle Vorschläge dieser Gruppe übernehmen" : "Alle nicht unsicheren Vorschläge mit dem KI-Ziel übernehmen — die übrigen einzeln prüfen"}
                  >
                    {laeuftSammel ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3 w-3" />}
                    {sammel.length === g.vs.length ? "Alle übernehmen" : `${sammel.length} übernehmen`}
                  </button>
                )}
              </div>
              {istOffen && (
                <ul className="py-0.5">
                  {g.vs.map((v) => (
                    <Zeile
                      key={v.id}
                      v={v}
                      ziel={zielVon(v)}
                      auf={auf === v.id}
                      laeuft={busy.has(v.id)}
                      waehlbareOrdner={waehlbareOrdner}
                      andererOffen={andererFuer === v.id}
                      ordnerOhneZz={ordnerOhneZz}
                      onAuf={() => setAuf((a) => (a === v.id ? null : v.id))}
                      onWahl={(o) => setzeWahl(v.id, o, v.ziel_ordner)}
                      onAnderer={(an) => setAndererFuer(an ? v.id : null)}
                      onUebernehmen={() => einzeln(v)}
                      onAblehnen={() => einzeln(v, true)}
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

/** Eine Datei: eine Zeile, Details beim Aufklappen. */
function Zeile({
  v, ziel, auf, laeuft, waehlbareOrdner, andererOffen, ordnerOhneZz,
  onAuf, onWahl, onAnderer, onUebernehmen, onAblehnen,
}: {
  v: ZzVorschlag;
  ziel: string;
  auf: boolean;
  laeuft: boolean;
  waehlbareOrdner: Set<string>;
  andererOffen: boolean;
  ordnerOhneZz: SelectItem[];
  onAuf: () => void;
  onWahl: (ordner: string) => void;
  onAnderer: (offen: boolean) => void;
  onUebernehmen: () => void;
  onAblehnen: () => void;
}) {
  const korrigiert = ziel !== v.ziel_ordner;
  const zielGesperrt = !waehlbareOrdner.has(ziel) || istGesperrtesZiel(ziel);
  // «Oder:»-Chips: Alternativen der KI plus — nach einem Tausch — der
  // urspruengliche Vorschlag; nur waehlbare Ordner, nie ZZ.
  const oder = [v.ziel_ordner, ...v.alternativen].filter((a, i, arr) => a !== ziel && arr.indexOf(a) === i && waehlbareOrdner.has(a) && !istGesperrtesZiel(a));
  const tooltip = [
    `${SICHERHEIT_LABEL[v.sicherheit].replace(/^./, (c) => c.toUpperCase())} — ${QUELLE_LABEL[v.quelle]}`,
    v.begruendung ? `«${v.begruendung}»` : null,
  ].filter(Boolean).join(" · ");
  return (
    <li data-testid="zz-zeile" className={auf ? "bg-muted/40 dark:bg-muted/60" : ""}>
      <div className="row-hover [--row-hover-x:0.25rem] flex items-center gap-2 pl-7 pr-3 py-1">
        <button
          type="button"
          onClick={onAuf}
          aria-expanded={auf}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          data-testid="zz-auf"
          data-tooltip={v.pfad}
        >
          <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${auf ? "rotate-90" : ""}`} />
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-[13px]">{nameVon(v.pfad)}</span>
        </button>
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
          disabled={laeuft || zielGesperrt}
          className="kasten shrink-0 px-2 py-1 text-[11px]"
          aria-label="Übernehmen"
          data-tooltip={zielGesperrt ? "Ordner inzwischen gesperrt — anderen wählen" : `Nach «${ziel}» verschieben`}
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
            {korrigiert ? (
              <span className="text-[10px] text-blue-700 dark:text-blue-300">von dir gewählt</span>
            ) : (
              <span className="text-[10px] text-muted-foreground">{QUELLE_LABEL[v.quelle]}</span>
            )}
            {zielGesperrt && <span className="text-[10px] text-amber-700 dark:text-amber-300">Ordner inzwischen gesperrt — anderen wählen</span>}
          </div>
          {v.begruendung && <p className="text-muted-foreground">«{v.begruendung}»</p>}
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
