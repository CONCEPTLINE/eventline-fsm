"use client";

/**
 * /vertrieb — Location-Akquise.
 *
 * Suchmaschine für Kooperations-Kandidaten: Gebiet eingeben (Stadt, Gemeinde
 * oder Kanton), OpenStreetMap liefert die echten Locations, die KI schätzt
 * die vier Faktoren, und `akquise-faktoren.ts` rechnet daraus Modell,
 * Rentabilität und Score. Links die Treffer, rechts die Entscheidung.
 *
 * Zustand über Reload (§10): Gebiet und Filter in localStorage, die
 * ausgewählte Location in der URL (?id=) — damit ist ein Treffer teilbar.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search, Loader2, Sparkles, Pin, Compass } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchableSelect } from "@/components/searchable-select";
import { KOOPERATIONS_MODELLE } from "@/lib/akquise-faktoren";
import { TrefferZeile } from "@/components/akquise/treffer-zeile";
import { LocationDetail } from "@/components/akquise/location-detail";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import type { AkquiseLocation } from "@/types/akquise";

const LS_GEBIET = "akquise-gebiet";
const LS_MODELL = "akquise-modell";
const LS_NUR_PINS = "akquise-nur-pins";

/** Spalten für die Liste — das schwere `bedarfsanalyse`/`kooperationskonzept`
 *  JSONB bleibt draussen; das Detail lädt seine Zeile selbst nach. */
const LISTEN_SPALTEN =
  "id, nr, name, typ, strasse, plz, ort, kanton, lat, lng, website, email, telefon, " +
  "kapazitaet, flaeche_m2, eigene_vermarktung, personal_vor_ort, technik_vorhanden, " +
  "eigentuemer_typ, empfohlenes_modell, rentabilitaet_chf, score, bewertung, quelle, " +
  "osm_id, recherchiert_am, angepinnt_am, angepinnt_von, notizen, created_at, updated_at";

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

  // Lazy-Init aus dem Storage (§10) — immer mit typeof-window-Guard (SSR).
  const [gebiet, setGebiet] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_GEBIET) ?? "" : "");
  const [suche, setSuche] = useState("");
  const [modellFilter, setModellFilter] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_MODELL) ?? "all" : "all");
  const [nurPins, setNurPins] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem(LS_NUR_PINS) === "1" : false);

  useEffect(() => { localStorage.setItem(LS_GEBIET, gebiet); }, [gebiet]);
  useEffect(() => { localStorage.setItem(LS_MODELL, modellFilter); }, [modellFilter]);
  useEffect(() => { localStorage.setItem(LS_NUR_PINS, nurPins ? "1" : "0"); }, [nurPins]);

  const laden_ = useCallback(async () => {
    const { data, error } = await supabase
      .from("akquise_locations")
      .select(LISTEN_SPALTEN)
      .order("score", { ascending: false, nullsFirst: false })
      .order("nr")
      .limit(1000);
    if (error) {
      // Query-Fehler nie verschlucken (§15/§7).
      toast.error(`Laden fehlgeschlagen: ${error.message}`);
    } else if (data) {
      setLocations(data as unknown as AkquiseLocation[]);
    }
    setLaden(false);
  }, [supabase]);

  useEffect(() => { void laden_(); }, [laden_]);

  // Auswahl in die URL spiegeln — überlebt Reload und ist teilbar.
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
        json.neu > 0
          ? `${json.neu} neue Locations in ${g}` +
            (json.bereits_bekannt > 0 ? ` (${json.bereits_bekannt} schon bekannt)` : "")
          : `Keine neuen — alle ${json.gefunden} Locations in ${g} sind schon erfasst`,
      );
      await laden_();
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
      if (json.bewertet === 0) {
        toast.info(json.hinweis ?? "Nichts zu bewerten");
      } else {
        toast.success(`${json.bewertet} Locations bewertet`);
      }
      if (json.fehler?.length) toast.warning(json.fehler.join(" · "));
      await laden_();
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

  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase();
    return locations.filter((l) => {
      if (nurPins && l.angepinnt_am === null) return false;
      if (modellFilter !== "all" && l.empfohlenes_modell !== modellFilter) return false;
      if (q && !l.name.toLowerCase().includes(q) && !l.ort.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [locations, suche, modellFilter, nurPins]);

  const unbewertet = locations.filter((l) => l.score === null).length;
  const pins = locations.filter((l) => l.angepinnt_am !== null).length;

  return (
    <div className="page-enter flex flex-col gap-3 sm:gap-4 h-[calc(100dvh-290px)] md:h-[calc(100vh-72px)]">
      {/* Kopf: Gebietssuche */}
      <div className="shrink-0 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Akquise</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {locations.length} Locations · {pins} angepinnt
              {unbewertet > 0 && ` · ${unbewertet} unbewertet`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={gebiet}
              onChange={(e) => setGebiet(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void gebietSuchen(); } }}
              placeholder="Stadt oder Kanton — z. B. Basel"
              className="h-9 w-56 text-sm"
            />
            <button type="button" onClick={gebietSuchen} disabled={sucht} className="kasten kasten-blue text-xs">
              {sucht
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird gesucht…</>
                : <><Search className="h-3.5 w-3.5" />Suchen</>}
            </button>
            {unbewertet > 0 && (
              <button type="button" onClick={alleBewerten} disabled={bewertet} className="kasten kasten-purple text-xs">
                {bewertet
                  ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Wird bewertet…</>
                  : <><Sparkles className="h-3.5 w-3.5" />{unbewertet} bewerten</>}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Liste + Detail */}
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="flex w-80 shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          <div className="shrink-0 space-y-1.5 border-b border-border p-2">
            <div className="flex items-center justify-between">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Treffer · {gefiltert.length}
              </p>
              <button
                type="button" onClick={() => setNurPins((v) => !v)}
                className={`kasten text-[11px] ${nurPins ? "kasten-amber" : "kasten-muted"}`}
              >
                <Pin className="h-3 w-3" style={{ fill: nurPins ? "currentColor" : "none" }} />
                Pins
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={suche} onChange={(e) => setSuche(e.target.value)}
                placeholder="Name oder Ort…" className="h-8 pl-7 text-xs"
              />
            </div>
            <SearchableSelect
              value={modellFilter}
              onChange={setModellFilter}
              clearable={false}
              active={modellFilter !== "all"}
              items={[
                { id: "all", label: "Alle Modelle" },
                ...KOOPERATIONS_MODELLE.map((m) => ({ id: m.key, label: m.label, sub: m.kurz })),
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
            {laden ? (
              <p className="py-8 text-center text-xs text-muted-foreground">Lade…</p>
            ) : gefiltert.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {locations.length === 0 ? "Noch keine Locations." : "Keine Treffer für diesen Filter."}
              </p>
            ) : (
              gefiltert.map((l) => (
                <TrefferZeile
                  key={l.id} location={l}
                  ausgewaehlt={gewaehlt === l.id}
                  onClick={() => setGewaehlt(l.id)}
                  onPin={() => void pinUmschalten(l)}
                />
              ))
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {detail ? (
            <LocationDetail
              location={detail}
              onAendern={detailAendern}
              onPin={() => void pinUmschalten(detail)}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-border bg-card">
              <EmptyState
                icon={Compass}
                title={locations.length === 0 ? "Noch keine Locations" : "Keine Location gewählt"}
                description={
                  locations.length === 0
                    ? "Gib oben eine Stadt oder einen Kanton ein. EVENTLINE holt dann die Locations aus OpenStreetMap und schätzt ein, welches Kooperationsmodell passt."
                    : "Wähle links einen Treffer, um Bewertung, Bedarfsanalyse und Kooperationskonzept zu sehen."
                }
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
