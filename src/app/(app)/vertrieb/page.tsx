"use client";

/**
 * /vertrieb — Location-Akquise.
 *
 * Suchmaschine für Kooperations-Kandidaten, schweizweit: Gebiet eingeben
 * (Ort, Gemeinde oder Kanton), die Websuche findet Häuser, die ihre Räume
 * vermieten, deren Websites werden gelesen, und `akquise-faktoren.ts`
 * rechnet daraus Modell, Rentabilität und Score.
 *
 * Layout in drei Zuständen:
 *   leer     — nur ein grosses Suchfeld in der Bildmitte, sonst nichts.
 *              Die Seite kann genau eine Sache, und die steht da.
 *   sucht    — dasselbe Feld, darunter der Fortschritt. Die Suche dauert
 *              zwei bis drei Minuten, das muss sichtbar bleiben.
 *   Ergebnis — Tabelle links, Karte gross in der Mitte, Detail rechts.
 *              Die Karte trägt den Überblick, die Tabelle die Auswahl,
 *              das Detail die Tiefe.
 *
 * Zustand über Reload (§10): Gebiet, Filter und Sortierung in localStorage,
 * die gewählte Location in der URL (?id=) — damit ist ein Treffer teilbar.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search, Loader2, Sparkles, Pin, Compass, Database, EyeOff } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { KOOPERATIONS_MODELLE } from "@/lib/akquise-faktoren";
import { TrefferZeile, TrefferKopf } from "@/components/akquise/treffer-zeile";
import { LocationDetail } from "@/components/akquise/location-detail";
import { SpaltenGriff } from "@/components/akquise/spalten-griff";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";

// Leaflet läuft nur im Browser — ohne ssr:false bricht der Build.
const Karte = dynamic(() => import("@/components/akquise/karte").then((m) => m.Karte), {
  ssr: false,
  loading: () => <div className="h-[22rem] w-full animate-pulse rounded-lg border border-border bg-muted" />,
});
import type { AkquiseLocation } from "@/types/akquise";

const LS_GEBIET = "akquise-gebiet";
const LS_MODELL = "akquise-modell";
const LS_NUR_PINS = "akquise-nur-pins";
const LS_SORT = "akquise-sort";
const LS_OHNE_BEDARF = "akquise-ohne-bedarf";
const LS_BREITE_LISTE = "akquise-breite-liste";
const LS_BREITE_DETAIL = "akquise-breite-detail";

/** Das schwere bedarfsanalyse/kooperationskonzept-JSONB bleibt draussen —
 *  das Detail lädt seine Zeile selbst nach. */
const LISTEN_SPALTEN =
  "id, nr, name, typ, strasse, plz, ort, kanton, lat, lng, website, email, telefon, " +
  "kapazitaet, flaeche_m2, eigene_vermarktung, personal_vor_ort, technik_vorhanden, " +
  "eigentuemer_typ, empfohlenes_modell, rentabilitaet_chf, score, bewertung, quelle, " +
  "osm_id, recherchiert_am, angepinnt_am, angepinnt_von, notizen, created_at, updated_at, " +
  "ansprechperson, position, kontakt_quelle, angereichert_am, vermietung_hinweis";

export default function AkquisePage() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  useBreadcrumbs([{ label: "Akquise" }]);

  const [locations, setLocations] = useState<AkquiseLocation[]>([]);
  const [laden, setLaden] = useState(true);
  const [sucht, setSucht] = useState(false);
  const [bewertet, setBewertet] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(searchParams.get("id"));
  const [detail, setDetail] = useState<AkquiseLocation | null>(null);
  const [umfeldLaeuft, setUmfeldLaeuft] = useState(false);
  /** Wie viele Websites noch gelesen werden müssen. null = läuft nicht. */
  const [offeneDetails, setOffeneDetails] = useState<number | null>(null);

  // Spaltenbreiten in Pixel — verstellbar und gemerkt (§10).
  const [breiteListe, setBreiteListe] = useState(() => {
    if (typeof window === "undefined") return 352;
    return Number(localStorage.getItem(LS_BREITE_LISTE)) || 352;
  });
  const [breiteDetail, setBreiteDetail] = useState(() => {
    if (typeof window === "undefined") return 448;
    return Number(localStorage.getItem(LS_BREITE_DETAIL)) || 448;
  });
  useEffect(() => { localStorage.setItem(LS_BREITE_LISTE, String(breiteListe)); }, [breiteListe]);
  useEffect(() => { localStorage.setItem(LS_BREITE_DETAIL, String(breiteDetail)); }, [breiteDetail]);
  /** Gesetzt, wenn die Tabelle fehlt (Migration nicht eingespielt) — dann
   *  ist "keine Treffer" die falsche Erklärung und würde in die Irre führen. */
  const [tabelleFehlt, setTabelleFehlt] = useState(false);

  // Lazy-Init aus dem Storage (§10) — immer mit typeof-window-Guard (SSR).
  const [gebiet, setGebiet] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_GEBIET) ?? "" : "");
  const [suche, setSuche] = useState("");
  const [modellFilter, setModellFilter] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_MODELL) ?? "all" : "all");
  const [nurPins, setNurPins] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_NUR_PINS) === "1" : false);
  const [sortierung, setSortierung] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_SORT) ?? "score" : "score");
  /** Locations ohne Bedarf (Eigennutzer) sind standardmässig ausgeblendet —
   *  gesucht ist die Liste, die zu Aufträgen führt, nicht die vollständige. */
  const [zeigeOhneBedarf, setZeigeOhneBedarf] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_OHNE_BEDARF) === "1" : false);

  useEffect(() => { localStorage.setItem(LS_GEBIET, gebiet); }, [gebiet]);
  useEffect(() => { localStorage.setItem(LS_MODELL, modellFilter); }, [modellFilter]);
  useEffect(() => { localStorage.setItem(LS_NUR_PINS, nurPins ? "1" : "0"); }, [nurPins]);
  useEffect(() => { localStorage.setItem(LS_SORT, sortierung); }, [sortierung]);
  useEffect(() => { localStorage.setItem(LS_OHNE_BEDARF, zeigeOhneBedarf ? "1" : "0"); }, [zeigeOhneBedarf]);

  const neuLaden = useCallback(async () => {
    const { data, error } = await supabase
      .from("akquise_locations")
      .select(LISTEN_SPALTEN)
      .order("score", { ascending: false, nullsFirst: false })
      .order("nr")
      .limit(1000);
    if (error) {
      // PGRST205 = Tabelle existiert nicht. Das ist kein Ladefehler, sondern
      // eine fehlende Migration — der Unterschied entscheidet, was der
      // Nutzer als Nächstes tun muss.
      if (error.code === "PGRST205") {
        setTabelleFehlt(true);
      } else {
        // Query-Fehler nie verschlucken (§15/§7).
        toast.error(`Laden fehlgeschlagen: ${error.message}`);
      }
    } else if (data) {
      setTabelleFehlt(false);
      setLocations(data as unknown as AkquiseLocation[]);
    }
    setLaden(false);
  }, [supabase]);

  useEffect(() => { void neuLaden(); }, [neuLaden]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (gewaehlt) url.searchParams.set("id", gewaehlt);
    else url.searchParams.delete("id");
    window.history.replaceState({}, "", url.toString());
  }, [gewaehlt]);

  // Detail separat laden — nur hier brauchen wir Analyse und Konzept.
  useEffect(() => {
    if (!gewaehlt) { setDetail(null); return; }
    let aktuell = true;
    (async () => {
      const { data } = await supabase
        .from("akquise_locations").select("*").eq("id", gewaehlt).single();
      // Nach einem schnellen Klick-Wechsel nicht die alte Antwort setzen.
      if (!aktuell || !data) return;
      const l = data as AkquiseLocation;
      setDetail(l);

      // Umfeld nachladen, wenn es noch fehlt — ohne Knopf. Das dauert
      // gut zwei Minuten und läuft deshalb nicht im Suchlauf mit,
      // sondern erst, wenn jemand dieses Haus wirklich anschaut.
      if (l.recherche?.umfeld || !l.website) return;
      setUmfeldLaeuft(true);
      try {
        const res = await fetch("/api/akquise/umfeld", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: l.id }),
        });
        const json = await res.json();
        if (!aktuell) return;
        if (json.success && json.umfeld) {
          setDetail((d) => d && d.id === l.id
            ? { ...d, recherche: { ...(d.recherche ?? {}), umfeld: json.umfeld } as typeof d.recherche }
            : d);
        } else if (json.error) {
          toast.error(json.error);
        }
      } catch {
        if (aktuell) toast.error("Umfeld-Recherche fehlgeschlagen");
      } finally {
        if (aktuell) setUmfeldLaeuft(false);
      }
    })();
    return () => { aktuell = false; };
  }, [gewaehlt, supabase]);

  /**
   * Liest die Websites der gefundenen Locations nach — in Häppchen zu
   * fünf, weil ein Durchgang über zwanzig die Zeitgrenze der Route
   * sprengen würde. Zwischen den Häppchen wird die Liste aktualisiert,
   * damit man sieht, wie sie sich füllt.
   */
  const detailsNachladen = useCallback(async () => {
    for (let runde = 0; runde < 12; runde++) {
      let json: { success?: boolean; offen?: number; fertig?: boolean; error?: string };
      try {
        const res = await fetch("/api/akquise/anreichern", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ limit: 5 }),
        });
        json = await res.json();
      } catch {
        setOffeneDetails(null);
        toast.error("Details konnten nicht geladen werden");
        return;
      }
      if (!json.success) {
        setOffeneDetails(null);
        if (json.error) toast.error(json.error);
        return;
      }
      await neuLaden();
      setOffeneDetails(json.offen ?? 0);
      if (json.fertig || (json.offen ?? 0) === 0) break;
    }
    setOffeneDetails(null);
  }, [neuLaden]);

  async function gebietSuchen() {
    const g = gebiet.trim();
    if (!g) { toast.error("Stadt oder Kanton eingeben"); return; }
    setSucht(true);
    try {
      const res = await fetch("/api/akquise/suchen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gebiet: g }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error ?? "Suche fehlgeschlagen");
        return;
      }
      if (json.gefunden === 0) {
        toast.warning(json.hinweis ?? "Keine Locations gefunden");
        return;
      }
      toast.success(`${g}: ${json.neu} Locations gefunden`, {
        description: "Die Details werden jetzt nachgeladen.",
      });
      await neuLaden();
      // Treffer stehen — jetzt die Websites lesen, sichtbar im Hintergrund.
      setOffeneDetails(json.neu ?? 0);
      void detailsNachladen();
    } catch {
      toast.error("Suche fehlgeschlagen");
    } finally {
      setSucht(false);
    }
  }

  async function alleBewerten() {
    setBewertet(true);
    try {
      const res = await fetch("/api/akquise/bewerten", { method: "POST" });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error ?? "Bewertung fehlgeschlagen");
        return;
      }
      if (json.bewertet === 0) toast.info(json.hinweis ?? "Nichts zu bewerten");
      else toast.success(`${json.bewertet} Locations bewertet`);
      if (json.fehler?.length) toast.warning(json.fehler.join(" · "));
      await neuLaden();
    } catch {
      toast.error("Bewertung fehlgeschlagen");
    } finally {
      setBewertet(false);
    }
  }

  async function pinUmschalten(l: AkquiseLocation) {
    const neu = l.angepinnt_am === null ? new Date().toISOString() : null;
    const { error } = await supabase
      .from("akquise_locations").update({ angepinnt_am: neu }).eq("id", l.id);
    if (error) { toast.error("Anpinnen fehlgeschlagen"); return; }
    setLocations((prev) => prev.map((x) => (x.id === l.id ? { ...x, angepinnt_am: neu } : x)));
    setDetail((d) => (d && d.id === l.id ? { ...d, angepinnt_am: neu } : d));
  }

  const detailAendern = useCallback(async (patch: Partial<AkquiseLocation>) => {
    if (!detail) return;
    const { error } = await supabase
      .from("akquise_locations").update(patch).eq("id", detail.id);
    if (error) throw new Error(error.message);
    setDetail((d) => (d ? { ...d, ...patch } : d));
    setLocations((prev) => prev.map((x) => (x.id === detail.id ? { ...x, ...patch } : x)));
  }, [detail, supabase]);

  /** Anzahl je Modell — füttert die Filter-Chips, damit man sieht, wo etwas liegt. */
  const proModell = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of locations) {
      if (l.empfohlenes_modell) m.set(l.empfohlenes_modell, (m.get(l.empfohlenes_modell) ?? 0) + 1);
    }
    return m;
  }, [locations]);

  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase();
    const liste = locations.filter((l) => {
      // Eigennutzer vermieten ihre Fläche nicht — für EVENTLINE kein Ansatz.
      if (!zeigeOhneBedarf && l.flaeche === "eigennutzung" && l.angepinnt_am === null) return false;
      if (nurPins && l.angepinnt_am === null) return false;
      if (modellFilter !== "all" && l.empfohlenes_modell !== modellFilter) return false;
      if (q && !l.name.toLowerCase().includes(q) && !l.ort.toLowerCase().includes(q)) return false;
      return true;
    });
    const zahl = (v: number | null) => v ?? -1;
    return [...liste].sort((a, b) => {
      switch (sortierung) {
        case "name": return a.name.localeCompare(b.name, "de-CH");
        case "ort": return a.ort.localeCompare(b.ort, "de-CH") || a.name.localeCompare(b.name, "de-CH");
        case "kapazitaet": return zahl(b.kapazitaet) - zahl(a.kapazitaet);
        case "rentabilitaet": return zahl(b.rentabilitaet_chf) - zahl(a.rentabilitaet_chf);
        default: return zahl(b.score) - zahl(a.score);
      }
    });
  }, [locations, suche, modellFilter, nurPins, sortierung, zeigeOhneBedarf]);

  const unbewertet = locations.filter((l) => l.score === null).length;
  const ohneBedarf = locations.filter((l) => l.flaeche === "eigennutzung").length;
  const pins = locations.filter((l) => l.angepinnt_am !== null).length;

  // --- Zustand 1: noch nichts gesucht ----------------------------------
  // Eine Seite, eine Aufgabe: das Suchfeld steht allein in der Mitte.
  if (!laden && locations.length === 0 && !tabelleFehlt) {
    return (
      <div className="page-enter flex min-h-[calc(100vh-12rem)] flex-col items-center justify-center px-4">
        <div className="w-full max-w-xl text-center">
          <Compass className="mx-auto h-10 w-10 text-foreground/30" />
          <h1 className="mt-4 text-3xl font-bold tracking-tight">Akquise</h1>
          <p className="mt-2 text-sm text-foreground/65">
            Ort, Gemeinde oder Kanton eingeben — schweizweit. Gesucht werden Häuser,
            die ihre Räume vermieten.
          </p>

          <div className="mt-6 flex gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-foreground/40" />
              <Input
                value={gebiet}
                onChange={(e) => setGebiet(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void gebietSuchen(); } }}
                placeholder="z. B. Basel, Thun, Kanton Aargau"
                autoFocus
                disabled={sucht}
                className="h-14 pl-12 text-base"
              />
            </div>
            <button type="button" onClick={gebietSuchen} disabled={sucht}
                    className="kasten kasten-blue h-14 px-6 text-base">
              {sucht
                ? <Loader2 className="h-5 w-5 animate-spin" />
                : <><Search className="h-5 w-5" />Suchen</>}
            </button>
          </div>

          {sucht && (
            <div className="mt-10 space-y-3">
              <Loader2 className="mx-auto h-8 w-8 animate-spin text-blue-600 dark:text-blue-400" />
              <p className="text-base font-medium text-foreground">
                Sucht Locations in {gebiet}…
              </p>
              <p className="text-sm text-foreground/65">
                Das Netz wird nach Häusern durchsucht, die ihre Räume vermieten.
                Danach wird jede Website gelesen. Rechne mit zwei bis drei Minuten.
              </p>
              {/* Unbestimmter Balken: .progress-shine ist die app-weite
                  Klasse dafür (globals.css). Die Dauer lässt sich nicht
                  vorhersagen, aber Stillstand wäre das falsche Signal. */}
              <div className="mx-auto h-1.5 w-56 overflow-hidden rounded-full bg-muted">
                <div className="progress-shine relative h-full w-full overflow-hidden rounded-full bg-blue-600/70 dark:bg-blue-400/70" />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Zustand 2+3: Ergebnis --------------------------------------------
  return (
    <div className="page-enter flex h-[calc(100dvh-280px)] flex-col gap-3 md:h-[calc(100vh-64px)]">
      {/* Kopfzeile: Suche bleibt erreichbar, aber kompakt */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground/40" />
          <Input
            value={gebiet}
            onChange={(e) => setGebiet(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void gebietSuchen(); } }}
            placeholder="Neue Stadt suchen…"
            disabled={sucht}
            className="h-10 pl-9 text-sm"
          />
        </div>
        <button type="button" onClick={gebietSuchen} disabled={sucht}
                className="kasten kasten-blue h-10 px-4 text-sm">
          {sucht
            ? <><Loader2 className="h-4 w-4 animate-spin" />Sucht…</>
            : <><Search className="h-4 w-4" />Suchen</>}
        </button>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setModellFilter("all")}
                  className={`kasten text-xs ${modellFilter === "all" ? "kasten-blue" : "kasten-muted"}`}>
            Alle {locations.length - ohneBedarf}
          </button>
          {KOOPERATIONS_MODELLE.filter((m) => (proModell.get(m.key) ?? 0) > 0 && m.key !== "keins").map((m) => (
            <button key={m.key} type="button" onClick={() => setModellFilter(m.key)}
                    data-tooltip={m.kurz}
                    className={`kasten text-xs ${modellFilter === m.key ? "kasten-blue" : "kasten-muted"}`}>
              {m.label} {proModell.get(m.key)}
            </button>
          ))}
          <button type="button" onClick={() => setNurPins((v) => !v)}
                  className={`kasten text-xs ${nurPins ? "kasten-amber" : "kasten-muted"}`}>
            <Pin className="h-3 w-3" style={{ fill: nurPins ? "currentColor" : "none" }} />
            {pins}
          </button>
          {unbewertet > 0 && (
            <button type="button" onClick={alleBewerten} disabled={bewertet}
                    className="kasten kasten-purple text-xs">
              {bewertet
                ? <><Loader2 className="h-3 w-3 animate-spin" />…</>
                : <><Sparkles className="h-3 w-3" />{unbewertet}</>}
            </button>
          )}
        </div>
      </div>

      {/* Fortschritt, solange Websites nachgelesen werden. Die Treffer
          stehen bereits — hier füllen sich nur noch ihre Details. */}
      {offeneDetails !== null && offeneDetails > 0 && (
        <div className="flex shrink-0 items-center gap-2.5 rounded-lg border border-blue-300/60 bg-blue-50 px-3 py-2 text-sm dark:border-blue-500/40 dark:bg-blue-500/10">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-700 dark:text-blue-300" />
          <span className="text-foreground">
            Liest Websites — noch {offeneDetails}. Ansprechpartner, Räume und Team
            erscheinen nach und nach.
          </span>
        </div>
      )}

      {/* Drei Spalten: Tabelle · Karte · Detail */}
      <div className={`flex min-h-0 flex-1 gap-3 transition-opacity ${sucht ? "pointer-events-none opacity-50" : ""}`}>
        {/* Links: Trefferliste */}
        <div className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
             style={{ width: breiteListe }}>
          <div className="shrink-0 border-b border-border p-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground/40" />
              <Input value={suche} onChange={(e) => setSuche(e.target.value)}
                     placeholder="Name oder Ort…" className="h-8 pl-7 text-xs" />
            </div>
          </div>
          {tabelleFehlt ? (
            <EmptyState
              icon={Database}
              title="Datenbank-Tabelle fehlt"
              description="Migration 295–299 noch nicht eingespielt. Im Supabase-SQL-Editor nachholen."
            />
          ) : gefiltert.length === 0 ? (
            <EmptyState icon={Search} title="Keine Treffer"
                        description="Für diesen Filter gibt es nichts." />
          ) : (
            <>
              <TrefferKopf sortierung={sortierung} onSortieren={setSortierung} />
              <div className="min-h-0 flex-1 overflow-y-auto p-1">
                {gefiltert.map((l) => (
                  <TrefferZeile
                    key={l.id} location={l}
                    ausgewaehlt={gewaehlt === l.id}
                    onClick={() => setGewaehlt(l.id)}
                    onPin={() => void pinUmschalten(l)}
                  />
                ))}
              </div>
              <div className="shrink-0 border-t border-border px-2.5 py-1.5 text-[12px] text-foreground/65">
                {gefiltert.length} von {locations.length}
                {ohneBedarf > 0 && (
                  <button type="button" onClick={() => setZeigeOhneBedarf((v) => !v)}
                          className="ml-2 inline-flex items-center gap-1 hover:text-foreground">
                    <EyeOff className="h-3 w-3" />
                    {zeigeOhneBedarf ? "ohne Bedarf ausblenden" : `${ohneBedarf} ohne Bedarf`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <SpaltenGriff breite={breiteListe} onBreite={setBreiteListe} min={260} max={640} />

        {/* Mitte: Karte */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border">
          <Karte locations={gefiltert} gewaehlt={gewaehlt} onWaehlen={setGewaehlt} fuellend />
        </div>

        {/* Rechts: Detail, nur wenn gewählt */}
        {detail && (
          <SpaltenGriff breite={breiteDetail} onBreite={setBreiteDetail}
                        min={320} max={760} invertiert />
        )}
        {detail && (
          <div className="shrink-0" style={{ width: breiteDetail }}>
            <LocationDetail
              location={detail}
              onAendern={detailAendern}
              onPin={() => void pinUmschalten(detail)}
              onSchliessen={() => setGewaehlt(null)}
              umfeldLaeuft={umfeldLaeuft}
            />
          </div>
        )}
      </div>
    </div>
  );
}
