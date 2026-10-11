"use client";

// Gruppe «Rückstau ZZ» im Tab «Ablage» (docs/lokale-ki/MASTERPLAN.md §3.8
// MP-7, Paket E3.2, Entscheid E6): die Nachtarbeit der lokalen KI schlaegt
// fuer Dateien in den ZZ_*-Ordnern einen Zielordner vor (Tabelle
// nas_vorschlaege, art 'zz', status 'offen'; RLS nur Admin). Gleiche Karte
// wie «Per Mail eingegangen», Bedienung wie die bestehenden KI-Vorschlaege
// beim Ablegen: Ziel-Chip, «Oder:»-Chips der Alternativen (Klick tauscht,
// zurueck mit einem Klick), «Anderer Ordner…» per SearchableSelect,
// Sicherheits-Chip (amber bei «niedrig»), Begruendung als data-tooltip.
// Uebernehmen = annehmen (Ziel unveraendert) bzw. korrigieren (anderer
// Ordner), Ablehnen = Datei bleibt, wo sie ist — immer einzeln, keine
// Sammelaktion. Entscheide gehen an POST /api/ablage/nas-vorschlaege;
// verschoben wird beim naechsten NAS-Sync (ablage_moves).
//
// Rueckgabe-Vertrag der Route (src/app/api/ablage/nas-vorschlaege/route.ts):
// { success, ergebnisse: [{ id, ok, status?, fehler?, code? }] } — status
// «veraltet», wenn die Datei nicht mehr im Index liegt (MP-7, 409); ein
// schon entschiedener Vorschlag (zweiter Admin, zweiter Tab) kommt mit
// seinem End-Status zurueck und verschwindet ebenfalls.
//
// Nur sichtbar, wenn es offene Vorschlaege gibt. Gewaehlte Ordner
// ueberleben den Reload (§10, localStorage — nur IDs und Ordner).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { ChevronDown, FileText, Folder, FolderInput, Inbox, Loader2, TriangleAlert, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
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

const SEITE = 50;
const WAHL_KEY = "nas-zz-wahl";

const QUELLE_LABEL: Record<ZzVorschlag["quelle"], string> = {
  regel: "nach fester Regel",
  vorbild: "nach ähnlichen abgelegten Dokumenten",
  modell: "von der lokalen KI gelesen",
};
const SICHERHEIT_LABEL: Record<ZzVorschlag["sicherheit"], string> = { hoch: "sicher", mittel: "eher sicher", niedrig: "unsicher" };
const SICHERHEIT_KLASSE: Record<ZzVorschlag["sicherheit"], string> = {
  hoch: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300",
  mittel: "bg-muted text-muted-foreground",
  niedrig: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
};

function kurz(pfad: string): string {
  return pfad.split("/").slice(-2).join("/");
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

export function RueckstauZz({
  supabase,
  takt,
  ordnerOptionen,
  waehlbareOrdner,
}: {
  supabase: SupabaseClient;
  /** Live-Takt der Seite (NAS hat gepollt) — laedt still nach. */
  takt: number;
  /** Effektiv aktive Ordner (gleiche Liste wie beim Ablegen). */
  ordnerOptionen: SelectItem[];
  waehlbareOrdner: Set<string>;
}) {
  const [liste, setListe] = useState<ZzVorschlag[]>([]);
  const [gesamt, setGesamt] = useState(0);
  const [anzahlGeladen, setAnzahlGeladen] = useState(SEITE);
  const [laedtMehr, setLaedtMehr] = useState(false);
  /** Vom Nutzer gewaehlter Ordner je Vorschlag (fehlt = Vorschlag der KI). */
  const [wahl, setWahl] = useState<Record<string, string>>(() => leseJson(WAHL_KEY, {}));
  const [andererFuer, setAndererFuer] = useState<string | null>(null);
  /** IDs, deren Entscheid gerade unterwegs ist (Spinner + gesperrt). */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const fehlerGemeldet = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(WAHL_KEY, JSON.stringify(wahl)); } catch { /* egal */ }
  }, [wahl]);

  /** Laufnummer der Ladevorgaenge: nur die Antwort des JUENGSTEN darf den
   *  Stand setzen (Entscheid, Takt und «Weitere anzeigen» laden parallel). */
  const ladeNr = useRef(0);

  const laden = useCallback(async (anzahl: number) => {
    const nr = ++ladeNr.current;
    const { data, error, count } = await supabase
      .from("nas_vorschlaege")
      .select("id, pfad, ordner_ist, ziel_ordner, alternativen, sicherheit, quelle, begruendung", { count: "exact" })
      .eq("art", "zz")
      .eq("status", "offen")
      .order("pfad")
      .range(0, anzahl - 1);
    if (nr !== ladeNr.current) return; // ueberholt — ein neuerer Stand kommt
    setLaedtMehr(false);
    if (error) {
      // Tabelle noch nicht eingespielt (Migration 302) -> Gruppe bleibt still
      // weg. Jeder andere Fehler einmal als Toast, nicht bei jedem Takt.
      const fehlt = error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message);
      if (!fehlt && !fehlerGemeldet.current) {
        fehlerGemeldet.current = true;
        toast.error("Rückstau ZZ konnte nicht geladen werden: " + error.message);
      }
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

  function setzeWahl(id: string, ordner: string, kiZiel: string) {
    setWahl((w) => {
      const n = { ...w };
      if (ordner === kiZiel) delete n[id];
      else n[id] = ordner;
      return n;
    });
  }

  function entferne(id: string) {
    setListe((l) => l.filter((v) => v.id !== id));
    setGesamt((g) => Math.max(0, g - 1));
    setWahl((w) => {
      if (!(id in w)) return w;
      const n = { ...w };
      delete n[id];
      return n;
    });
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
    return ziel === v.ziel_ordner ? { id: v.id, aktion: "annehmen" } : { id: v.id, aktion: "korrigieren", ordner: ziel };
  }

  async function einzeln(v: ZzVorschlag, ablehnen = false) {
    if (busy.has(v.id)) return;
    setBusy((b) => new Set(b).add(v.id));
    setAndererFuer(null);
    const ziel = zielVon(v);
    const ausgang = await sende(entscheidFuer(v, ablehnen));
    setBusy((b) => { const n = new Set(b); n.delete(v.id); return n; });
    if (ausgang.art === "fehler") {
      toast.error((ablehnen ? "Ablehnen" : "Übernehmen") + " fehlgeschlagen: " + ausgang.meldung);
      return;
    }
    entferne(v.id);
    // Stand aus der DB nachladen — sonst bliebe die Gruppe leer, obwohl
    // hinter den geladenen 50 noch Vorschlaege warten.
    void laden(anzahlGeladen);
    if (ausgang.art === "veraltet") toast.info("Datei liegt nicht mehr dort — Vorschlag entfernt");
    else if (ausgang.art === "schon") toast.info(ausgang.meldung);
    else toast.success(ablehnen ? "Vorschlag abgelehnt — die Datei bleibt, wo sie ist" : `Wird beim nächsten Sync nach «${ziel}» verschoben`);
  }

  if (liste.length === 0) return null;

  return (
    <Card className="bg-card" data-testid="rueckstau-zz">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <Inbox className="h-4 w-4 text-muted-foreground" />
          Rückstau ZZ ({gesamt})
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Die lokale KI hat nachts Zielordner für Dateien in den ZZ-Ordnern vorgeschlagen. Verschoben wird erst nach «Übernehmen», beim nächsten Sync.
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        <ul className="max-h-[32rem] overflow-y-auto overflow-x-hidden">
          {liste.map((v) => {
            const ziel = zielVon(v);
            const korrigiert = ziel !== v.ziel_ordner;
            const zielGesperrt = !waehlbareOrdner.has(ziel) || istGesperrtesZiel(ziel);
            // «Oder:»-Chips: Alternativen der KI plus — nach einem Tausch —
            // der urspruengliche Vorschlag; nur waehlbare Ordner, nie ZZ.
            const oder = [v.ziel_ordner, ...v.alternativen].filter((a, i, arr) => a !== ziel && arr.indexOf(a) === i && waehlbareOrdner.has(a) && !istGesperrtesZiel(a));
            const laeuft = busy.has(v.id);
            const tooltip = [
              `${SICHERHEIT_LABEL[v.sicherheit].replace(/^./, (c) => c.toUpperCase())} — ${QUELLE_LABEL[v.quelle]}`,
              v.begruendung ? `«${v.begruendung}»` : null,
            ].filter(Boolean).join(" · ");
            return (
              <li key={v.id} className="row-hover [--row-hover-x:0rem] px-2 py-2 flex items-start gap-2.5" data-testid="zz-zeile">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{nameVon(v.pfad)}</p>
                    <p className="text-[11px] text-muted-foreground font-mono truncate" data-tooltip={v.ordner_ist}>{v.ordner_ist}</p>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="flex min-w-0 max-w-full items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground shrink-0">Nach:</span>
                    <span
                      className={`inline-flex min-w-0 items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] ${korrigiert ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200" : "border-border bg-background"}`}
                      data-tooltip={ziel}
                    >
                      <Folder className="h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" />
                      <span className="min-w-0 truncate font-mono">{kurz(ziel)}</span>
                    </span>
                    </span>
                    {korrigiert ? (
                      <span className="text-[10px] text-blue-700 dark:text-blue-300">von dir gewählt</span>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${SICHERHEIT_KLASSE[v.sicherheit]}`}
                        data-tooltip={tooltip}
                      >
                        {v.sicherheit === "niedrig" && <TriangleAlert className="h-2.5 w-2.5" />}
                        {SICHERHEIT_LABEL[v.sicherheit]}
                      </span>
                    )}
                    {zielGesperrt && (
                      <span className="text-[10px] text-amber-700 dark:text-amber-300">Ordner inzwischen gesperrt — anderen wählen</span>
                    )}
                  </div>
                  {(oder.length > 0 || andererFuer !== v.id) && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {oder.length > 0 && <span className="text-[11px] text-muted-foreground">Oder:</span>}
                      {oder.map((a) => (
                        <button
                          key={a}
                          type="button"
                          onClick={() => setzeWahl(v.id, a, v.ziel_ordner)}
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
                        onClick={() => setAndererFuer((x) => (x === v.id ? null : v.id))}
                        disabled={laeuft}
                        className="text-[11px] text-muted-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
                      >
                        Anderer Ordner…
                        <ChevronDown className={`h-3 w-3 transition-transform ${andererFuer === v.id ? "rotate-180" : ""}`} />
                      </button>
                    </div>
                  )}
                  {andererFuer === v.id && (
                    <div className="max-w-md">
                      <SearchableSelect
                        value=""
                        onChange={(o) => { if (o) { setzeWahl(v.id, o, v.ziel_ordner); setAndererFuer(null); } }}
                        items={ordnerOhneZz.filter((o) => o.id !== ziel)}
                        placeholder="Zielordner wählen…"
                      />
                    </div>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => einzeln(v)}
                    disabled={laeuft || zielGesperrt}
                    className="kasten"
                    aria-label="Übernehmen"
                  >
                    {laeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderInput className="h-3.5 w-3.5" />}
                    <span className="hidden sm:inline">Übernehmen</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => einzeln(v, true)}
                    disabled={laeuft}
                    className="icon-btn shrink-0"
                    aria-label="Ablehnen"
                    data-tooltip="Ablehnen — die Datei bleibt, wo sie ist"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        {gesamt > liste.length && (
          <button
            type="button"
            onClick={() => { setLaedtMehr(true); setAnzahlGeladen((n) => n + SEITE); }}
            disabled={laedtMehr}
            className="kasten kasten-muted w-full justify-center"
          >
            {laedtMehr && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Weitere anzeigen ({gesamt - liste.length})
          </button>
        )}
      </CardContent>
    </Card>
  );
}
