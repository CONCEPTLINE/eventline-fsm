"use client";

/**
 * /vertrieb — Location-Akquise.
 *
 * Suchmaschine für Kooperations-Kandidaten: Gebiet eingeben (Stadt, Gemeinde
 * oder Kanton), OpenStreetMap liefert die echten Locations, die KI schätzt
 * die vier Faktoren, und `akquise-faktoren.ts` rechnet daraus Modell,
 * Rentabilität und Score.
 *
 * Layout: Die Suche steht oben und gross — sie ist der Einstieg, nicht eine
 * Nebenfunktion. Darunter Kennzahlen, dann die Trefferliste über die volle
 * Breite. Das Detail blendet sich rechts ein, sobald ein Treffer gewählt ist,
 * und gibt den Platz wieder frei, wenn nicht (§14: inhalt-getrieben).
 *
 * Zustand über Reload (§10): Gebiet, Filter und Sortierung in localStorage,
 * die gewählte Location in der URL (?id=) — damit ist ein Treffer teilbar.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search, Loader2, Sparkles, Pin, Compass, Database, EyeOff, UserSearch } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { KOOPERATIONS_MODELLE, chf } from "@/lib/akquise-faktoren";
import { TrefferZeile, TrefferKopf } from "@/components/akquise/treffer-zeile";
import { LocationDetail } from "@/components/akquise/location-detail";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import type { AkquiseLocation } from "@/types/akquise";

const LS_GEBIET = "akquise-gebiet";
const LS_MODELL = "akquise-modell";
const LS_NUR_PINS = "akquise-nur-pins";
const LS_SORT = "akquise-sort";
const LS_OHNE_BEDARF = "akquise-ohne-bedarf";

/** Das schwere bedarfsanalyse/kooperationskonzept-JSONB bleibt draussen —
 *  das Detail lädt seine Zeile selbst nach. */
const LISTEN_SPALTEN =
  "id, nr, name, typ, strasse, plz, ort, kanton, lat, lng, website, email, telefon, " +
  "kapazitaet, flaeche_m2, eigene_vermarktung, personal_vor_ort, technik_vorhanden, " +
  "eigentuemer_typ, empfohlenes_modell, rentabilitaet_chf, score, bewertung, quelle, " +
  "osm_id, recherchiert_am, angepinnt_am, angepinnt_von, notizen, created_at, updated_at, " +
  "ansprechperson, position, kontakt_quelle, angereichert_am, vermietung_hinweis";

function Kennzahl({ wert, label, ton }: { wert: string; label: string; ton?: string }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <p className={`text-xl font-semibold tabular-nums ${ton ?? ""}`}>{wert}</p>
      <p className="text-[11px] text-muted-foreground">{label}</p>
    </div>
  );
}

export default function AkquisePage() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  useBreadcrumbs([{ label: "Akquise" }]);

  const [locations, setLocations] = useState<AkquiseLocation[]>([]);
  const [laden, setLaden] = useState(true);
  const [sucht, setSucht] = useState(false);
  const [bewertet, setBewertet] = useState(false);
  const [reichertAn, setReichertAn] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(searchParams.get("id"));
  const [detail, setDetail] = useState<AkquiseLocation | null>(null);
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
      if (aktuell && data) setDetail(data as AkquiseLocation);
    })();
    return () => { aktuell = false; };
  }, [gewaehlt, supabase]);

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
      toast.success(
        `${g}: ${json.behalten} Kandidaten`,
        {
          description:
            `${json.gefunden} Locations geprüft` +
            (json.bewertet ? ` · ${json.bewertet} bewertet` : "") +
            (json.verworfen ? ` · ${json.verworfen} aussortiert` : "") +
            (json.andere_gebiete ? ` · ${json.andere_gebiete} aus anderen Orten entfernt` : ""),
        },
      );
      if (json.fehler?.length) toast.warning(json.fehler.join(" · "));
      await neuLaden();
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

  async function kontakteHolen() {
    setReichertAn(true);
    try {
      const res = await fetch("/api/akquise/anreichern", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 20 }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error ?? "Kontaktsuche fehlgeschlagen");
        return;
      }
      if (json.angereichert === 0) toast.info(json.hinweis ?? "Nichts anzureichern");
      else toast.success(`${json.angereichert} Kontakte aus den Websites geholt` +
        (json.ohne_befund ? ` · ${json.ohne_befund} ohne Befund` : ""));
      await neuLaden();
    } catch {
      toast.error("Kontaktsuche fehlgeschlagen");
    } finally {
      setReichertAn(false);
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
  const ohneKontakt = locations.filter(
    (l) => l.flaeche !== "eigennutzung" && l.angereichert_am === null && l.website).length;
  const mitKontakt = locations.filter((l) => l.ansprechperson).length;
  const pins = locations.filter((l) => l.angepinnt_am !== null).length;
  // Potenzial der ANGEZEIGTEN Treffer — passt sich dem Filter an, damit die
  // Zahl zu dem gehört, was man gerade sieht.
  const potenzial = gefiltert.reduce((s, l) => s + (l.rentabilitaet_chf ?? 0), 0);

  return (
    <div className="page-enter space-y-4">
      {/* Kopf mit der Suche — der Einstieg der Seite */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Akquise</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Locations finden, bewerten und ansprechen
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={gebiet}
              onChange={(e) => setGebiet(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void gebietSuchen(); } }}
              placeholder="Stadt, Gemeinde oder Kanton — z. B. Basel"
              className="h-11 pl-9 text-sm"
            />
          </div>
          <button type="button" onClick={gebietSuchen} disabled={sucht}
                  className="kasten kasten-blue h-11 px-4 text-sm">
            {sucht
              ? <><Loader2 className="h-4 w-4 animate-spin" />Wird gesucht…</>
              : <><Search className="h-4 w-4" />Suchen</>}
          </button>
          {unbewertet > 0 && (
            <button type="button" onClick={alleBewerten} disabled={bewertet}
                    className="kasten kasten-purple h-11 px-4 text-sm">
              {bewertet
                ? <><Loader2 className="h-4 w-4 animate-spin" />Wird bewertet…</>
                : <><Sparkles className="h-4 w-4" />{unbewertet} bewerten</>}
            </button>
          )}
          {ohneKontakt > 0 && (
            <button type="button" onClick={kontakteHolen} disabled={reichertAn}
                    data-tooltip="Liest die Websites und holt Ansprechperson, E-Mail und Telefon"
                    className="kasten kasten-green h-11 px-4 text-sm">
              {reichertAn
                ? <><Loader2 className="h-4 w-4 animate-spin" />Websites werden gelesen…</>
                : <><UserSearch className="h-4 w-4" />{ohneKontakt} Kontakte holen</>}
            </button>
          )}
        </div>
      </div>

      {/* Kennzahlen */}
      {locations.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kennzahl wert={String(locations.length - ohneBedarf)} label="Mit Bedarf"
                    ton="text-green-600 dark:text-green-400" />
          <Kennzahl wert={String(pins)} label="Angepinnt"
                    ton={pins > 0 ? "text-amber-600 dark:text-amber-400" : undefined} />
          <Kennzahl wert={`${chf(potenzial)}`} label="CHF/Jahr Potenzial (gefiltert)" />
          <Kennzahl wert={String(mitKontakt)} label="Mit Ansprechpartner"
                    ton={mitKontakt > 0 ? "text-green-600 dark:text-green-400" : undefined} />
        </div>
      )}

      {/* Filter */}
      {locations.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setModellFilter("all")}
                  className={`kasten text-xs ${modellFilter === "all" ? "kasten-blue" : "kasten-muted"}`}>
            Alle {locations.length}
          </button>
          {KOOPERATIONS_MODELLE.filter((m) => (proModell.get(m.key) ?? 0) > 0).map((m) => (
            <button key={m.key} type="button" onClick={() => setModellFilter(m.key)}
                    data-tooltip={m.kurz}
                    className={`kasten text-xs ${modellFilter === m.key ? "kasten-blue" : "kasten-muted"}`}>
              {m.label} {proModell.get(m.key)}
            </button>
          ))}
          <button type="button" onClick={() => setNurPins((v) => !v)}
                  className={`kasten text-xs ${nurPins ? "kasten-amber" : "kasten-muted"}`}>
            <Pin className="h-3 w-3" style={{ fill: nurPins ? "currentColor" : "none" }} />
            Angepinnt
          </button>
          {ohneBedarf > 0 && (
            <button type="button" onClick={() => setZeigeOhneBedarf((v) => !v)}
                    data-tooltip="Locations, die ihre Fläche selbst nutzen und nicht vermieten"
                    className={`kasten text-xs ${zeigeOhneBedarf ? "kasten-muted" : "kasten-muted opacity-60"}`}>
              <EyeOff className="h-3 w-3" />
              {zeigeOhneBedarf ? "Ohne Bedarf: sichtbar" : `${ohneBedarf} ohne Bedarf`}
            </button>
          )}
          <div className="relative ml-auto w-48">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={suche} onChange={(e) => setSuche(e.target.value)}
                   placeholder="Name oder Ort…" className="h-8 pl-7 text-xs" />
          </div>
        </div>
      )}

      {/* Treffer + Detail. Das Detail nimmt nur Platz, wenn etwas gewählt ist. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card">
          {laden ? (
            <p className="py-12 text-center text-xs text-muted-foreground">Lade…</p>
          ) : tabelleFehlt ? (
            <EmptyState
              icon={Database}
              title="Datenbank-Tabelle fehlt"
              description="Die Migration 295_akquise_locations.sql ist noch nicht eingespielt. Bis dahin kann die Akquise keine Daten laden. Einspielen im Supabase-SQL-Editor (Projekt uxtotpniwbwyoznwkygd)."
            />
          ) : locations.length === 0 ? (
            <EmptyState
              icon={Compass}
              title="Noch keine Locations"
              description="Gib oben eine Stadt, Gemeinde oder einen Kanton ein. EVENTLINE holt die Locations aus OpenStreetMap und schätzt ein, welches Kooperationsmodell passt."
            />
          ) : gefiltert.length === 0 ? (
            <EmptyState icon={Search} title="Keine Treffer"
                        description="Für diesen Filter gibt es nichts. Setz den Filter zurück oder such ein anderes Gebiet." />
          ) : (
            <>
              <TrefferKopf sortierung={sortierung} onSortieren={setSortierung} />
              <div className="max-h-[calc(100vh-22rem)] overflow-y-auto p-1">
                {gefiltert.map((l) => (
                  <TrefferZeile
                    key={l.id} location={l}
                    ausgewaehlt={gewaehlt === l.id}
                    onClick={() => setGewaehlt(l.id)}
                    onPin={() => void pinUmschalten(l)}
                  />
                ))}
              </div>
              <div className="border-t border-border px-2.5 py-1.5 text-[11px] text-muted-foreground">
                {gefiltert.length} von {locations.length} Locations
              </div>
            </>
          )}
        </div>

        {detail && (
          <div className="w-full shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:w-[30rem]">
            <LocationDetail
              location={detail}
              onAendern={detailAendern}
              onPin={() => void pinUmschalten(detail)}
              onSchliessen={() => setGewaehlt(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
