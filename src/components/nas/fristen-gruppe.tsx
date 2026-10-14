"use client";

// Bereich «Fristen» im Tab «Ablage» (docs/lokale-ki/MASTERPLAN.md §3.8
// MP-7, Paket E3.4): alle offenen Fristen der NAS-Ablage aus ablage_fristen
// (RLS nur Admin), als kompakte Zeitleiste nach Faelligkeit in zwei klar
// getrennten Teilen:
//   - «Zu prüfen» (Vorschlaege der lokalen KI, quelle 'ki'): Datum mit
//     Dringlichkeit, Art, Partei, Anzahl Quell-Dokumente, Sicherheit;
//     «Bestätigen» -> aktiv (Erinnerung 30/7/0 Tage vorher per Mail),
//     «Verwerfen» -> kommt nie wieder. Datum aenderbar im aufgeklappten
//     Detail (dort auch: woraus das Datum gerechnet wurde, alle Dokumente).
//   - «Bestätigt» (beim Ablegen erfasst oder bestaetigt): «Erledigt» ->
//     keine Erinnerungen mehr.
// Entscheide gehen einzeln an POST /api/ablage/fristen (atomar, idempotent;
// Rueckgabe { success, status?, datum?, error? }). Ein schon anders
// entschiedener Eintrag (zweiter Admin, zweiter Tab) verschwindet mit Hinweis.
//
// Doppel (Okt. 2026: derselbe SCALA-Vertrag als .docx/.pdf/Entwurf/Historie
// = 4× dieselbe Frist): seit Migration 321 fuehrt die Nachtarbeit sie
// zusammen (weitere_pfade). Kommen trotzdem zwei gleiche Vorschlaege an
// (gleicher Sachverhalt + Datum, lib/ki/fristen-sachverhalt), zeigt die
// Liste sie als EINE Zeile: «Bestätigen» bestaetigt die beste und verwirft
// die Doppel, «Verwerfen» verwirft alle — beides ueber dieselbe Route.
//
// Deep-Link aus Dashboard/Mail (?gruppe=fristen) waehlt die Seite selbst;
// hier scrollt die Liste einmal in den Blick (schmale Fenster). Geaenderte
// Daten und die aufgeklappte Zeile ueberleben den Reload (§10, localStorage).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { CalendarClock, Check, CheckCheck, ChevronRight, FileText, Loader2, TriangleAlert, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { todayLocalIso } from "@/lib/swiss-time";
import { besteZeile, quellPfade, sachSchluessel, sachverhaltDerZeile } from "@/lib/ki/fristen-sachverhalt";
import type { FristArt, FristQuelle, OrdnerSicherheit } from "@/lib/ki/typen";
import { artLabel, beschreibeGrundlage, datumTon, fmtTag, ordnerVon, relativ, relativKurz } from "./fristen-hilfen";
import { nameVon } from "./ki-hilfen";

/** Zeile aus ablage_fristen (Migration 304/321) — nur die Spalten der Anzeige. */
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
  sachverhalt: string | null;
  weitere_pfade: string[] | null;
}

/** Anzeige-Eintrag: eine Frist, ggf. mit gleichartigen Doppeln. */
interface Eintrag {
  key: string;
  haupt: Frist;
  doppel: Frist[];
}

type Aktion = "bestaetigen" | "verwerfen" | "erledigt";
type Ausgang = { art: "ok"; status?: string; datum?: string } | { art: "schon"; meldung: string } | { art: "fehler"; meldung: string };

const SEITE = 200;
const DATUM_KEY = "nas-fristen-datum";
const AUF_KEY = "nas-fristen-auf";

const QUELLE_LABEL: Record<FristQuelle, string> = {
  ki: "lokale KI",
  ablage: "beim Ablegen erfasst",
  manuell: "von Hand erfasst",
};
// Einschätzung der KI, kein Gewissheitsversprechen: «hoch» heisst nur «Wort der Art im Abschnitt, kein OCR» — daher
// kein Grün. Gleiche Stufen und Farben wie beim Einsortieren (vorschlaege-gruppe.tsx).
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

/** «Kündigung · Verein SCALA BASEL» -> Partei-Teil; sonst die ganze Bezeichnung. */
function titelVon(f: Frist): string {
  const praefix = `${artLabel(f.art)} · `;
  return f.bezeichnung.startsWith(praefix) ? f.bezeichnung.slice(praefix.length) : f.bezeichnung;
}

/** Vorschlaege mit gleichem Sachverhalt + Datum zu einem Eintrag buendeln. */
function buendle(liste: Frist[]): Eintrag[] {
  const aus: Eintrag[] = [];
  const jeKey = new Map<string, Frist[]>();
  for (const f of liste) {
    const s = f.status === "vorschlag" && f.quelle === "ki" ? sachverhaltDerZeile(f) : null;
    if (!s) {
      aus.push({ key: f.id, haupt: f, doppel: [] });
      continue;
    }
    const k = sachSchluessel(s, f.datum);
    if (!jeKey.has(k)) {
      jeKey.set(k, []);
      aus.push({ key: k, haupt: f, doppel: [] });
    }
    jeKey.get(k)!.push(f);
  }
  return aus.map((e) => {
    const gruppe = jeKey.get(e.key);
    if (!gruppe || gruppe.length < 2) return e;
    const haupt = besteZeile(gruppe);
    return { key: haupt.id, haupt, doppel: gruppe.filter((f) => f.id !== haupt.id) };
  });
}

export function FristenGruppe({
  supabase,
  takt,
  onAnzahl,
}: {
  supabase: SupabaseClient;
  /** Live-Takt der Seite (NAS hat gepollt) — laedt still nach. */
  takt: number;
  /** Anzahl Eintraege (zu pruefen + bestaetigt) fuer den Umschalter (null = laedt). */
  onAnzahl?: (n: number | null, zuPruefen: number) => void;
}) {
  const [liste, setListe] = useState<Frist[]>([]);
  const [gesamt, setGesamt] = useState<number | null>(null);
  const [heute, setHeute] = useState("");
  const [anzahlGeladen, setAnzahlGeladen] = useState(SEITE);
  const [laedtMehr, setLaedtMehr] = useState(false);
  /** Vom Admin geaendertes Datum je Vorschlag (fehlt = Datum der KI). */
  const [datumWahl, setDatumWahl] = useState<Record<string, string>>(() => leseJson(DATUM_KEY, {}));
  /** Aufgeklappter Eintrag (Details). */
  const [auf, setAuf] = useState<string | null>(() => leseJson<string | null>(AUF_KEY, null));
  /** Eintrag + Aktion, deren Entscheid gerade unterwegs ist (Spinner + gesperrt). */
  const [busy, setBusy] = useState<Map<string, Aktion>>(new Map());
  const fehlerGemeldet = useRef(false);

  useEffect(() => {
    try { localStorage.setItem(DATUM_KEY, JSON.stringify(datumWahl)); } catch { /* egal */ }
  }, [datumWahl]);
  useEffect(() => {
    try { localStorage.setItem(AUF_KEY, JSON.stringify(auf)); } catch { /* egal */ }
  }, [auf]);

  /** Nur die Antwort des JUENGSTEN Ladevorgangs setzt den Stand. */
  const ladeNr = useRef(0);

  const laden = useCallback(async (anzahl: number) => {
    const nr = ++ladeNr.current;
    const { data, error, count } = await supabase
      .from("ablage_fristen")
      .select("id, pfad, art, datum, bezeichnung, grundlage, quelle, status, sicherheit, sachverhalt, weitere_pfade", { count: "exact" })
      .in("status", ["vorschlag", "aktiv"])
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
      setGesamt((g) => g ?? 0);
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

  const zuPruefen = useMemo(() => buendle(liste.filter((f) => f.status === "vorschlag")), [liste]);
  const bestaetigt = useMemo(() => liste.filter((f) => f.status === "aktiv").map((f) => ({ key: f.id, haupt: f, doppel: [] as Frist[] })), [liste]);

  const zuMelden = gesamt === null ? null : zuPruefen.length + bestaetigt.length + Math.max(0, gesamt - liste.length);
  useEffect(() => { onAnzahl?.(zuMelden, zuPruefen.length); }, [zuMelden, zuPruefen.length, onAnzahl]);

  // Deep-Link aus Dashboard/Mail: einmal in den Blick scrollen (§15 —
  // Callback-Ref, kein Effekt, der bei jedem Nachladen zurueckreisst).
  const gescrollt = useRef(false);
  const karteRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || gescrollt.current) return;
    if (new URLSearchParams(window.location.search).get("gruppe") !== "fristen") return;
    gescrollt.current = true;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
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

  async function entscheide(e: Eintrag, aktion: Aktion) {
    const f = e.haupt;
    if (busy.has(e.key)) return;
    const gewaehlt = aktion === "bestaetigen" ? datumWahl[f.id] : undefined;
    const neuesDatum = gewaehlt && gewaehlt !== f.datum ? gewaehlt : null;
    if (aktion === "bestaetigen" && gewaehlt !== undefined && !gewaehlt) {
      toast.error("Bitte ein Datum wählen");
      return;
    }
    setBusy((b) => new Map(b).set(e.key, aktion));
    const ausgang = await sende(f.id, aktion, neuesDatum);
    // Gleichartige Doppel: nach dem Haupt-Entscheid verwerfen (bei
    // «Bestätigen» und «Verwerfen» gleichermassen — es bleibt EINE Frist).
    let doppelFehler = 0;
    if (ausgang.art !== "fehler" && e.doppel.length > 0 && aktion !== "erledigt") {
      for (const d of e.doppel) {
        const a = await sende(d.id, "verwerfen", null);
        if (a.art === "fehler") doppelFehler++;
        else vergiss(d.id);
      }
    }
    setBusy((b) => { const n = new Map(b); n.delete(e.key); return n; });
    if (ausgang.art === "fehler") {
      const was = aktion === "bestaetigen" ? "Bestätigen" : aktion === "verwerfen" ? "Verwerfen" : "Erledigt";
      toast.error(`${was} fehlgeschlagen: ${ausgang.meldung}`);
      return;
    }
    vergiss(f.id);
    if (auf === e.key) setAuf(null);
    const dopIds = new Set(e.doppel.map((d) => d.id));
    if (ausgang.art === "ok" && aktion === "bestaetigen") {
      // Bleibt in der Liste — jetzt als bestaetigte Frist.
      setListe((l) => l.filter((x) => !dopIds.has(x.id)).map((x) => (x.id === f.id ? { ...x, status: "aktiv", datum: ausgang.datum ?? neuesDatum ?? x.datum } : x)));
    } else {
      setListe((l) => l.filter((x) => x.id !== f.id && !dopIds.has(x.id)));
    }
    void laden(anzahlGeladen);
    if (doppelFehler > 0) toast.error(`${doppelFehler} gleiche Vorschläge konnten nicht verworfen werden — bitte einzeln prüfen`);
    if (ausgang.art === "schon") toast.info(ausgang.meldung);
    else if (aktion === "bestaetigen") toast.success(`Frist bestätigt — Erinnerung 30, 7 und 0 Tage vor dem ${fmtTag(ausgang.datum ?? neuesDatum ?? f.datum)}`);
    else if (aktion === "verwerfen") toast.success("Vorschlag verworfen — er kommt nicht wieder");
    else toast.success("Frist erledigt — keine Erinnerungen mehr");
  }

  if (gesamt === null) {
    return (
      <div className="p-4 space-y-2">
        {[0, 1, 2].map((i) => <div key={i} className="shimmer rounded-md h-8" />)}
      </div>
    );
  }
  if (liste.length === 0) {
    return (
      <EmptyState
        icon={CalendarClock}
        title="Keine offenen Fristen"
        description="Fristen aus Verträgen schlägt die lokale KI nachts vor; beim Ablegen erfasste Fristen erscheinen ebenfalls hier."
      />
    );
  }

  const zeile = (e: Eintrag) => (
    <FristZeile
      key={e.key}
      e={e}
      heute={heute}
      datumWahl={datumWahl[e.haupt.id]}
      auf={auf === e.key}
      laeuft={busy.get(e.key)}
      onAuf={() => setAuf((a) => (a === e.key ? null : e.key))}
      onDatum={(v) => setDatumWahl((w) => {
        const n = { ...w };
        if (v === e.haupt.datum) delete n[e.haupt.id];
        else n[e.haupt.id] = v;
        return n;
      })}
      onEntscheid={(a) => entscheide(e, a)}
    />
  );

  return (
    <div ref={karteRef} className="flex flex-col min-h-0 flex-1 scroll-mt-24" data-testid="fristen-gruppe">
      <div className="px-4 py-2 border-b border-border">
        <p className="text-[11px] text-muted-foreground">
          Erinnert wird erst nach «Bestätigen» — 30, 7 und 0 Tage vorher per Mail an die Admins.
        </p>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-2">
        {zuPruefen.length > 0 && (
          <section>
            <h3 className="sticky top-0 z-[1] bg-card px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Zu prüfen · {zuPruefen.length}
            </h3>
            <ul>{zuPruefen.map(zeile)}</ul>
          </section>
        )}
        {bestaetigt.length > 0 && (
          <section className={zuPruefen.length > 0 ? "mt-2 border-t border-border" : ""}>
            <h3 className="sticky top-0 z-[1] bg-card px-4 pt-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Bestätigt · {bestaetigt.length}
            </h3>
            <ul>{bestaetigt.map(zeile)}</ul>
          </section>
        )}
        {gesamt > liste.length && (
          <div className="px-3 pt-2">
            <button
              type="button"
              onClick={() => { setLaedtMehr(true); setAnzahlGeladen((n) => n + SEITE); }}
              disabled={laedtMehr}
              className="kasten kasten-muted w-full justify-center"
            >
              {laedtMehr && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Weitere laden ({gesamt - liste.length})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function FristZeile({
  e, heute, datumWahl, auf, laeuft, onAuf, onDatum, onEntscheid,
}: {
  e: Eintrag;
  heute: string;
  datumWahl: string | undefined;
  auf: boolean;
  laeuft: Aktion | undefined;
  onAuf: () => void;
  onDatum: (v: string) => void;
  onEntscheid: (a: Aktion) => void;
}) {
  const f = e.haupt;
  const vorschlag = f.status === "vorschlag";
  const datum = (vorschlag ? datumWahl : undefined) ?? f.datum;
  const geaendert = vorschlag && datum !== f.datum;
  const ton = heute ? datumTon(datum, heute) : "neutral";
  const grundlage = f.quelle === "ki" ? beschreibeGrundlage(f.grundlage) : "";
  const dokumente = quellPfade({ pfad: f.pfad, weitere_pfade: [...(f.weitere_pfade ?? []), ...e.doppel.flatMap((d) => quellPfade(d))] });
  const titel = titelVon(f);
  // Art als Chip — ausser «Frist» (sonstige) bei Bezeichnungen ohne Art-Praefix.
  const zeigeArt = f.art !== "sonstige" || f.bezeichnung.startsWith(`${artLabel(f.art)} · `);
  return (
    <li data-testid="frist-zeile" className={auf ? "bg-muted/40 dark:bg-muted/60" : ""}>
      <div className="row-hover [--row-hover-x:0.25rem] flex items-center gap-2 px-3 py-1">
        <button
          type="button"
          onClick={onAuf}
          aria-expanded={auf}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          data-testid="frist-auf"
        >
          <ChevronRight className={`h-3 w-3 shrink-0 text-muted-foreground transition-transform ${auf ? "rotate-90" : ""}`} />
          <span
            className={cn(
              "inline-flex shrink-0 min-w-[10.5rem] items-center gap-1 px-1.5 py-0.5 rounded-md border text-[11px] tabular-nums",
              geaendert ? "border-blue-300 bg-blue-50 text-blue-800 dark:border-blue-500/40 dark:bg-blue-500/15 dark:text-blue-200" : DATUM_KLASSE[ton],
            )}
            data-tooltip={geaendert ? `Von dir geändert (KI: ${fmtTag(f.datum)})` : heute ? relativ(datum, heute) : undefined}
          >
            {ton === "rot" && !geaendert && <TriangleAlert className="h-3 w-3 shrink-0" />}
            <span className="font-medium">{fmtTag(datum)}</span>
            {heute && <span className="opacity-75">· {relativKurz(datum, heute)}</span>}
          </span>
          {zeigeArt && (
            <span className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground">
              {artLabel(f.art)}
            </span>
          )}
          <span className="min-w-0 truncate text-[13px]" data-tooltip={f.bezeichnung}>{titel}</span>
        </button>
        {dokumente.length > 1 && (
          <span
            className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-muted text-muted-foreground tabular-nums"
            data-tooltip={`Steht in ${dokumente.length} Dokumenten — aufklappen für die Liste`}
          >
            <FileText className="h-2.5 w-2.5" />
            {dokumente.length}
          </span>
        )}
        {/* In der Zeile nur die Warnung «unsicher» — «wahrscheinlich»/
            «möglich» stehen im Detail (Platz fuer die Partei). */}
        {f.quelle === "ki" && f.sicherheit === "niedrig" ? (
          <span
            className={cn("shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium", SICHERHEIT_KLASSE.niedrig)}
            data-tooltip={`Gefunden von der lokalen KI${grundlage ? ` — ${grundlage}` : ""}`}
          >
            <TriangleAlert className="h-2.5 w-2.5" />
            {SICHERHEIT_LABEL.niedrig}
          </span>
        ) : null}
        {vorschlag ? (
          <>
            <button
              type="button"
              onClick={() => onEntscheid("bestaetigen")}
              disabled={!!laeuft}
              className="kasten shrink-0 px-2 py-1 text-[11px]"
              aria-label="Bestätigen"
              data-tooltip={e.doppel.length > 0 ? `Bestätigen — die ${e.doppel.length} gleichen Vorschläge werden verworfen` : `Bestätigen — Erinnerung 30, 7 und 0 Tage vor dem ${fmtTag(datum)}`}
            >
              {laeuft === "bestaetigen" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              <span className="hidden sm:inline">Bestätigen</span>
            </button>
            <button
              type="button"
              onClick={() => onEntscheid("verwerfen")}
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
            onClick={() => onEntscheid("erledigt")}
            disabled={!!laeuft}
            className="kasten kasten-muted shrink-0 px-2 py-1 text-[11px]"
            aria-label="Erledigt"
            data-tooltip="Erledigt — keine Erinnerungen mehr"
          >
            {laeuft === "erledigt" ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3 w-3" />}
            <span className="hidden sm:inline">Erledigt</span>
          </button>
        )}
      </div>
      {auf && (
        <div className="pl-8 pr-3 pb-2 pt-0.5 space-y-1.5 text-[11px]">
          <p className="text-muted-foreground">
            {f.quelle === "ki" ? (
              <>
                Gefunden von der lokalen KI{f.sicherheit ? ` (${SICHERHEIT_LABEL[f.sicherheit]})` : ""}
                {grundlage && <> — daraus berechnet: <span className="text-foreground">{grundlage}</span></>}
              </>
            ) : (
              QUELLE_LABEL[f.quelle] ?? f.quelle
            )}
          </p>
          {e.doppel.length > 0 && (
            <p className="text-amber-700 dark:text-amber-300 flex items-center gap-1">
              <TriangleAlert className="h-3 w-3 shrink-0" />
              {e.doppel.length + 1} gleiche Vorschläge zusammengefasst — beim Bestätigen bleibt eine Frist, die übrigen werden verworfen.
            </p>
          )}
          {dokumente.length > 0 && (
            <div className="space-y-0.5">
              <p className="text-muted-foreground">{dokumente.length === 1 ? "Dokument:" : `Steht in ${dokumente.length} Dokumenten:`}</p>
              <ul className="space-y-0.5">
                {dokumente.map((p) => (
                  <li key={p} className="flex min-w-0 items-center gap-1.5" data-tooltip={p}>
                    <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">
                      <span className="text-foreground">{nameVon(p)}</span>
                      {ordnerVon(p) && <span className="font-mono text-muted-foreground"> — {ordnerVon(p)}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {vorschlag && (
            <label className="flex items-center gap-2 flex-wrap">
              <span className="text-muted-foreground">Datum vor dem Bestätigen anpassen:</span>
              <Input
                type="date"
                value={datum}
                min={heute || undefined}
                onChange={(ev) => onDatum(ev.target.value)}
                disabled={!!laeuft}
                className="h-7 w-[9rem] text-xs"
                aria-label="Datum der Frist"
              />
              {geaendert && <span className="text-blue-700 dark:text-blue-300">von dir geändert (KI: {fmtTag(f.datum)})</span>}
            </label>
          )}
        </div>
      )}
    </li>
  );
}
