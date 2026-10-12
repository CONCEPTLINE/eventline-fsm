"use client";

// Gruppe «Fristen» im Tab «Ablage» (docs/lokale-ki/MASTERPLAN.md §3.8 MP-7,
// Paket E3.4): alle offenen Fristen der NAS-Ablage aus ablage_fristen (RLS
// nur Admin) — Vorschlaege der lokalen KI zuerst, dann die aktiven, je nach
// Datum. Gleiche Karte wie «Rückstau ZZ».
//   - Vorschlag (quelle 'ki'): Datum (aenderbar), Art, Bezeichnung, Quelle +
//     Sicherheit, woraus das Datum gerechnet wurde (Bedingungen, ohne Text);
//     «Bestätigen» -> aktiv (Erinnerung 30/7/0 Tage vorher per Mail),
//     «Verwerfen» -> kommt nie wieder.
//   - Aktiv (beim Ablegen erfasst oder bestaetigt): «Erledigt» -> keine
//     Erinnerungen mehr.
// Entscheide gehen einzeln an POST /api/ablage/fristen (atomar, idempotent;
// Rueckgabe { success, status?, datum?, error? }). Ein schon anders
// entschiedener Eintrag (zweiter Admin, zweiter Tab) verschwindet mit Hinweis.
//
// Nur sichtbar, wenn es Eintraege gibt. Deep-Link aus dem Dashboard
// (?gruppe=fristen) scrollt die Karte einmal in den Blick. Geaenderte Daten
// ueberleben den Reload (§10, localStorage — nur IDs und Daten).

import { useCallback, useEffect, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { CalendarClock, Check, CheckCheck, Loader2, TriangleAlert, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { todayLocalIso } from "@/lib/swiss-time";
import type { FristArt, FristQuelle, OrdnerSicherheit } from "@/lib/ki/typen";
import { artLabel, beschreibeGrundlage, datumTon, fmtTag, ordnerVon, relativ } from "./fristen-hilfen";

/** Zeile aus ablage_fristen (Migration 304) — nur die Spalten der Anzeige. */
interface Frist {
  id: string;
  pfad: string | null;
  art: FristArt;
  datum: string;
  bezeichnung: string;
  grundlage: unknown;
  quelle: FristQuelle;
  status: "vorschlag" | "aktiv";
  sicherheit: OrdnerSicherheit | null;
}

type Aktion = "bestaetigen" | "verwerfen" | "erledigt";
type Ausgang = { art: "ok"; status?: string; datum?: string } | { art: "schon"; meldung: string } | { art: "fehler"; meldung: string };

const SEITE = 50;
const DATUM_KEY = "nas-fristen-datum";

const QUELLE_LABEL: Record<FristQuelle, string> = {
  ki: "lokale KI",
  ablage: "beim Ablegen erfasst",
  manuell: "von Hand erfasst",
};
// Einschätzung der KI, kein Gewissheitsversprechen: «hoch» heisst nur «Wort der Art im Abschnitt, kein OCR» — daher
// kein Grün. Gleiche Stufen und Farben wie in der Gruppe «Rückstau ZZ» (vorschlaege-gruppe.tsx).
const SICHERHEIT_LABEL: Record<OrdnerSicherheit, string> = { hoch: "wahrscheinlich", mittel: "möglich", niedrig: "unsicher" };
const SICHERHEIT_KLASSE: Record<OrdnerSicherheit, string> = {
  hoch: "bg-muted text-foreground",
  mittel: "bg-muted text-muted-foreground",
  niedrig: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
};
const DATUM_KLASSE: Record<ReturnType<typeof datumTon>, string> = {
  rot: "border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200",
  amber: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
  neutral: "border-border bg-background",
};

function leseJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const roh = localStorage.getItem(key);
    return roh ? (JSON.parse(roh) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function FristenGruppe({
  supabase,
  takt,
}: {
  supabase: SupabaseClient;
  /** Live-Takt der Seite (NAS hat gepollt) — laedt still nach. */
  takt: number;
}) {
  const [liste, setListe] = useState<Frist[]>([]);
  const [gesamt, setGesamt] = useState(0);
  const [heute, setHeute] = useState("");
  const [anzahlGeladen, setAnzahlGeladen] = useState(SEITE);
  const [laedtMehr, setLaedtMehr] = useState(false);
  /** Vom Admin geaendertes Datum je Vorschlag (fehlt = Datum der KI). */
  const [datumWahl, setDatumWahl] = useState<Record<string, string>>(() => leseJson(DATUM_KEY, {}));
  /** ID + Aktion, deren Entscheid gerade unterwegs ist (Spinner + gesperrt). */
  const [busy, setBusy] = useState<Map<string, Aktion>>(new Map());
  const fehlerGemeldet = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(DATUM_KEY, JSON.stringify(datumWahl)); } catch { /* egal */ }
  }, [datumWahl]);

  /** Nur die Antwort des JUENGSTEN Ladevorgangs setzt den Stand. */
  const ladeNr = useRef(0);

  const laden = useCallback(async (anzahl: number) => {
    const nr = ++ladeNr.current;
    const { data, error, count } = await supabase
      .from("ablage_fristen")
      .select("id, pfad, art, datum, bezeichnung, grundlage, quelle, status, sicherheit", { count: "exact" })
      .in("status", ["vorschlag", "aktiv"])
      // «vorschlag» > «aktiv»: absteigend = erst die offenen Entscheide.
      .order("status", { ascending: false })
      .order("datum", { ascending: true })
      .order("id", { ascending: true })
      .range(0, anzahl - 1);
    if (nr !== ladeNr.current) return; // ueberholt — ein neuerer Stand kommt
    setLaedtMehr(false);
    if (error) {
      const fehlt = error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message);
      if (!fehlt && !fehlerGemeldet.current) {
        fehlerGemeldet.current = true;
        toast.error("Fristen konnten nicht geladen werden: " + error.message);
      }
      return;
    }
    fehlerGemeldet.current = false;
    setHeute(todayLocalIso());
    setListe((data ?? []) as Frist[]);
    setGesamt(count ?? (data ?? []).length);
  }, [supabase]);

  useEffect(() => {
    void (async () => { await laden(anzahlGeladen); })();
  }, [laden, anzahlGeladen, takt]);

  // Deep-Link aus dem Dashboard: einmal in den Blick scrollen (§15 —
  // Callback-Ref, kein Effekt, der bei jedem Nachladen zurueckreisst).
  const gescrollt = useRef(false);
  const karteRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || gescrollt.current) return;
    if (new URLSearchParams(window.location.search).get("gruppe") !== "fristen") return;
    gescrollt.current = true;
    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  function vergiss(id: string) {
    setDatumWahl((w) => {
      if (!(id in w)) return w;
      const n = { ...w };
      delete n[id];
      return n;
    });
  }

  async function sende(id: string, aktion: Aktion, datum: string | null): Promise<Ausgang> {
    let json: { success?: boolean; status?: string; datum?: string; error?: string } | null = null;
    let status = 0;
    try {
      const res = await fetch("/api/ablage/fristen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(datum ? { id, aktion, datum } : { id, aktion }),
      });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch {
      return { art: "fehler", meldung: "Netzwerkfehler" };
    }
    if (status >= 200 && status < 300 && json?.success) return { art: "ok", status: json.status, datum: json.datum };
    // 409 mit End-Status: jemand anderes hat schon (anders) entschieden.
    if (status === 409 && json?.status && json.status !== "vorschlag" && json.status !== "aktiv") {
      return { art: "schon", meldung: json.error ?? "Schon entschieden" };
    }
    if (status === 404) return { art: "schon", meldung: "Frist gibt es nicht mehr" };
    return { art: "fehler", meldung: json?.error ?? `HTTP ${status}` };
  }

  async function entscheide(f: Frist, aktion: Aktion) {
    if (busy.has(f.id)) return;
    const gewaehlt = aktion === "bestaetigen" ? datumWahl[f.id] : undefined;
    const neuesDatum = gewaehlt && gewaehlt !== f.datum ? gewaehlt : null;
    if (aktion === "bestaetigen" && gewaehlt !== undefined && !gewaehlt) {
      toast.error("Bitte ein Datum wählen");
      return;
    }
    setBusy((b) => new Map(b).set(f.id, aktion));
    const ausgang = await sende(f.id, aktion, neuesDatum);
    setBusy((b) => { const n = new Map(b); n.delete(f.id); return n; });
    if (ausgang.art === "fehler") {
      const was = aktion === "bestaetigen" ? "Bestätigen" : aktion === "verwerfen" ? "Verwerfen" : "Erledigt";
      toast.error(`${was} fehlgeschlagen: ${ausgang.meldung}`);
      return;
    }
    vergiss(f.id);
    if (ausgang.art === "ok" && aktion === "bestaetigen") {
      // Bleibt in der Liste — jetzt als aktive Frist.
      setListe((l) => l.map((x) => (x.id === f.id ? { ...x, status: "aktiv", datum: ausgang.datum ?? neuesDatum ?? x.datum } : x)));
    } else {
      setListe((l) => l.filter((x) => x.id !== f.id));
      setGesamt((g) => Math.max(0, g - 1));
    }
    void laden(anzahlGeladen);
    if (ausgang.art === "schon") toast.info(ausgang.meldung);
    else if (aktion === "bestaetigen") toast.success(`Frist bestätigt — Erinnerung 30, 7 und 0 Tage vor dem ${fmtTag(ausgang.datum ?? neuesDatum ?? f.datum)}`);
    else if (aktion === "verwerfen") toast.success("Vorschlag verworfen — er kommt nicht wieder");
    else toast.success("Frist erledigt — keine Erinnerungen mehr");
  }

  if (liste.length === 0) return null;
  const offen = liste.filter((f) => f.status === "vorschlag").length;

  return (
    <Card ref={karteRef} className="bg-card scroll-mt-24" data-testid="fristen-gruppe">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-1.5">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          Fristen ({gesamt})
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          {offen > 0
            ? "Die lokale KI hat nachts Fristen in Verträgen gefunden. Erinnert wird erst nach «Bestätigen» — 30, 7 und 0 Tage vorher per Mail."
            : "Erinnerung 30, 7 und 0 Tage vorher per Mail an die Admins."}
        </p>
      </CardHeader>
      <CardContent className="space-y-1">
        <ul className="max-h-[32rem] overflow-y-auto overflow-x-hidden">
          {liste.map((f) => {
            const vorschlag = f.status === "vorschlag";
            const datum = (vorschlag ? datumWahl[f.id] : undefined) ?? f.datum;
            const geaendert = vorschlag && datum !== f.datum;
            const laeuft = busy.get(f.id);
            const grundlage = f.quelle === "ki" ? beschreibeGrundlage(f.grundlage) : "";
            const ton = heute ? datumTon(f.datum, heute) : "neutral";
            return (
              <li key={f.id} className="row-hover [--row-hover-x:0rem] px-2 py-2 flex items-start gap-2.5" data-testid="frist-zeile">
                <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="min-w-0">
                    <p className="text-sm truncate">{f.bezeichnung}</p>
                    {f.pfad && (
                      <p className="text-[11px] text-muted-foreground font-mono truncate" data-tooltip={f.pfad}>
                        {/* Beim Ablegen erfasst: die Bezeichnung ist schon der Dateiname. */}
                        {f.quelle === "ki" ? f.pfad : ordnerVon(f.pfad) || f.pfad}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span
                      className={cn("inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] tabular-nums", geaendert ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200" : DATUM_KLASSE[ton])}
                    >
                      {ton === "rot" && !geaendert && <TriangleAlert className="h-3 w-3 shrink-0" />}
                      {fmtTag(datum)}
                      {heute && <span className="opacity-75">· {relativ(datum, heute)}</span>}
                    </span>
                    {/* Art nur, wenn sie nicht schon in der Bezeichnung steht
                        («Kündigung · …» der KI) und mehr sagt als «Frist». */}
                    {f.art !== "sonstige" && !f.bezeichnung.startsWith(artLabel(f.art)) && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
                        {artLabel(f.art)}
                      </span>
                    )}
                    {geaendert ? (
                      <span className="text-[10px] text-blue-700 dark:text-blue-300">Datum von dir geändert (KI: {fmtTag(f.datum)})</span>
                    ) : f.quelle === "ki" && f.sicherheit ? (
                      <span
                        className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium", SICHERHEIT_KLASSE[f.sicherheit])}
                        data-tooltip={`Gefunden von der lokalen KI${grundlage ? ` — ${grundlage}` : ""}`}
                      >
                        {f.sicherheit === "niedrig" && <TriangleAlert className="h-2.5 w-2.5" />}
                        lokale KI · {SICHERHEIT_LABEL[f.sicherheit]}
                      </span>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">{QUELLE_LABEL[f.quelle] ?? f.quelle}</span>
                    )}
                  </div>
                  {grundlage && (
                    <p className="text-[11px] text-muted-foreground truncate" data-tooltip={`Daraus hat EVENTLINE das Datum berechnet: ${grundlage}`}>
                      {grundlage}
                    </p>
                  )}
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  {vorschlag ? (
                    <>
                      <Input
                        type="date"
                        value={datum}
                        min={heute || undefined}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDatumWahl((w) => {
                            const n = { ...w };
                            if (v === f.datum) delete n[f.id];
                            else n[f.id] = v;
                            return n;
                          });
                        }}
                        disabled={!!laeuft}
                        className="h-7 w-[8.5rem] text-xs"
                        aria-label="Datum der Frist"
                        data-tooltip="Datum vor dem Bestätigen anpassen"
                      />
                      <button
                        type="button"
                        onClick={() => entscheide(f, "bestaetigen")}
                        disabled={!!laeuft}
                        className="kasten"
                        aria-label="Bestätigen"
                      >
                        {laeuft === "bestaetigen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        <span className="hidden sm:inline">Bestätigen</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => entscheide(f, "verwerfen")}
                        disabled={!!laeuft}
                        className="icon-btn shrink-0"
                        aria-label="Verwerfen"
                        data-tooltip="Verwerfen — diese Frist wird nicht wieder vorgeschlagen"
                      >
                        {laeuft === "verwerfen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => entscheide(f, "erledigt")}
                      disabled={!!laeuft}
                      className="kasten kasten-muted"
                      aria-label="Erledigt"
                      data-tooltip="Erledigt — keine Erinnerungen mehr"
                    >
                      {laeuft === "erledigt" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                      <span className="hidden sm:inline">Erledigt</span>
                    </button>
                  )}
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
