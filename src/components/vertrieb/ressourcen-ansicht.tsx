"use client";

/**
 * Ressourcen › Planung (Leo 26.11.2026, Seite /vertrieb): das Stammteam je
 * Haus auf einen Blick — wer ist grundsätzlich wo Geschäftsleitung,
 * Betriebsleitung oder Personal, wo ist eine Stelle offen, wo steht erst eine
 * fiktive Person. Darstellung: ressourcen-brett.tsx.
 *
 * Gebaut für viele Häuser: Karten brechen um, Suche und Filter «Nur mit
 * Lücke» grenzen ein, «+ Location» legt ein Haus mit Name und Adresse an
 * (locations:create, wie auf /locations; Koordinaten über /api/geocode).
 *
 * Daten über den RLS-Client (locations:view): locations, standort_mitarbeiter
 * (mit funktion), planung_fiktives_personal, standort_planstellen, profiles,
 * jobs (offene Aufträge der nächsten 30 Tage). Schreiben über die Serverwege
 * /api/ressourcen/einteilung und /api/ressourcen/planung (locations:edit).
 * Fahrzeiten ab Büro: GET /api/ressourcen/fahrt (eine Anfrage für alle).
 *
 * `erweitert` = Migration 392 eingespielt (Funktionen, fiktives Personal,
 * offene Stellen). Ohne sie gibt es nur «Personal» mit echten Personen.
 * Vorgemerkte Häuser (src/lib/ressourcen/haeuser.ts) erscheinen gestrichelt,
 * bis sie als Location angelegt sind. Suche und Filter in localStorage (§10).
 * Laptop-Seite.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Search, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { fehlendeHaeuser, VORGEMERKT_PRAEFIX, type VorgemerktesHaus } from "@/lib/ressourcen/haeuser";
import { istFunktion, type Funktion } from "@/lib/ressourcen/funktionen";
import { TOAST } from "@/lib/messages";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { RessourcenBrett, stand, type Belegt, type BrettFahrt, type BrettPerson } from "@/components/vertrieb/ressourcen-brett";

type Ort = {
  id: string;
  name: string;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  capacity: number | null;
  latitude: number | null;
  longitude: number | null;
  /** Gesetzt, wenn das Haus noch keine Location ist (nur vorgemerkt). */
  vorgemerkt?: VorgemerktesHaus;
};

const ROT = "var(--status-red)";
const GELB = "var(--status-amber)";
const REIHENFOLGE = ["barakuba", "bau3", "trafohalle", "querfeld", "gemeinschaftsbank", "palazzo"];
const SUCHE_SPEICHER = "ressourcen-suche";
const FILTER_SPEICHER = "ressourcen-nur-luecke";
const NEU_LEER = { name: "", street: "", zip: "", city: "Basel" };

function gespeichert(key: string): string {
  try { return typeof window !== "undefined" ? localStorage.getItem(key) ?? "" : ""; } catch { return ""; }
}
function merke(key: string, wert: string) {
  try { localStorage.setItem(key, wert); } catch { /* privat-Modus */ }
}
/** Tabelle oder Spalte fehlt (Migration 392 nicht eingespielt). */
function fehltNoch(e: { code?: string } | null): boolean {
  return !!e && ["42703", "PGRST204", "PGRST205", "42P01"].includes(e.code ?? "");
}

export function RessourcenAnsicht() {
  const [orte, setOrte] = useState<Ort[] | null>(null);
  /** Namen ALLER Locations (auch archivierte) — gegen doppeltes Anlegen. */
  const [alleNamen, setAlleNamen] = useState<string[] | null>(null);
  const [belegung, setBelegung] = useState<Map<string, Belegt[]>>(new Map());
  /** Einteilung sicher geladen? Sonst kein Bearbeiten. */
  const [einteilungOk, setEinteilungOk] = useState(false);
  const [erweitert, setErweitert] = useState(true);
  const [personen, setPersonen] = useState<BrettPerson[]>([]);
  const [fiktive, setFiktive] = useState<BrettPerson[]>([]);
  const [anlaesse, setAnlaesse] = useState<Map<string, number> | null>(null);
  const [fahrten, setFahrten] = useState<Map<string, BrettFahrt>>(new Map());
  const [ladeStand, setLadeStand] = useState(0);
  const [legtAn, setLegtAn] = useState(false);
  const [suche, setSuche] = useState(() => gespeichert(SUCHE_SPEICHER));
  const [nurLuecke, setNurLuecke] = useState(() => gespeichert(FILTER_SPEICHER) === "1");
  const [neuOffen, setNeuOffen] = useState(false);
  const [neu, setNeu] = useState(NEU_LEER);
  const { can } = usePermissions();
  const darfAnlegen = can("locations:create");
  const darfAendern = can("locations:edit");
  const nachgezogen = useRef(new Set<string>());

  useEffect(() => { merke(SUCHE_SPEICHER, suche); }, [suche]);
  useEffect(() => { merke(FILTER_SPEICHER, nurLuecke ? "1" : "0"); }, [nurLuecke]);

  // ─── Laden ──────────────────────────────────────────────────────────
  useEffect(() => {
    let aktiv = true;
    const supabase = createClient();
    void (async () => {
      const in30 = new Date(Date.now() + 30 * 86400000).toISOString();
      const [loc, einMit, namen, prof, jobs, fik, stellen] = await Promise.all([
        supabase
          .from("locations")
          .select("id, name, address_street, address_zip, address_city, capacity, latitude, longitude")
          .eq("is_active", true)
          .is("archived_at", null)
          .order("name"),
        supabase.from("standort_mitarbeiter").select("location_id, profile_id, funktion"),
        supabase.from("locations").select("name"),
        supabase.from("profiles").select("id, full_name").not("role", "in", PORTAL_ROLLEN_IN).eq("is_active", true).order("full_name"),
        supabase
          .from("jobs")
          .select("location_id")
          .eq("status", "offen")
          .eq("is_deleted", false)
          .not("location_id", "is", null)
          .gte("start_date", new Date().toISOString())
          .lt("start_date", in30),
        supabase.from("planung_fiktives_personal").select("id, name").order("name"),
        supabase.from("standort_planstellen").select("id, location_id, funktion, fiktiv_id"),
      ]);
      // Spalte «funktion» fehlt noch (Migration 392) → ohne sie laden.
      const ohneFunktion = fehltNoch(einMit.error);
      const ein = ohneFunktion ? await supabase.from("standort_mitarbeiter").select("location_id, profile_id") : einMit;
      if (!aktiv) return;

      const voll = !ohneFunktion && !fehltNoch(fik.error) && !fehltNoch(stellen.error);
      setErweitert(voll);
      if (loc.error) toast.error(`Locations laden fehlgeschlagen: ${loc.error.message}`);
      if (ein.error) toast.error(`Einteilung laden fehlgeschlagen: ${ein.error.message}`);
      if (prof.error) toast.error(`Mitarbeitende laden fehlgeschlagen: ${prof.error.message}`);
      if (jobs.error) toast.error(`Aufträge laden fehlgeschlagen: ${jobs.error.message}`);
      if (voll && fik.error) toast.error(`Fiktives Personal laden fehlgeschlagen: ${fik.error.message}`);
      if (voll && stellen.error) toast.error(`Planstellen laden fehlgeschlagen: ${stellen.error.message}`);

      setOrte((loc.data ?? []) as Ort[]);
      // Namen unbekannt (Fehler) → keine vorgemerkten Häuser zeigen, sonst
      // könnte ein vorhandenes Haus doppelt angelegt werden.
      setAlleNamen(namen.error ? null : ((namen.data ?? []) as { name: string }[]).map((n) => n.name));

      const m = new Map<string, Belegt[]>();
      const dazu = (ort: string, b: Belegt) => m.set(ort, [...(m.get(ort) ?? []), b]);
      for (const z of (ein.data ?? []) as { location_id: string; profile_id: string; funktion?: string | null }[]) {
        dazu(z.location_id, { art: "person", id: z.profile_id, funktion: istFunktion(z.funktion) ? z.funktion : "personal" });
      }
      if (voll) {
        for (const z of (stellen.data ?? []) as { id: string; location_id: string; funktion: string; fiktiv_id: string | null }[]) {
          const funktion = istFunktion(z.funktion) ? z.funktion : "personal";
          dazu(z.location_id, z.fiktiv_id ? { art: "fiktiv", id: z.fiktiv_id, funktion } : { art: "offen", id: z.id, funktion });
        }
      }
      setBelegung(m);
      setEinteilungOk(!ein.error && (!voll || !stellen.error));
      setPersonen(((prof.data ?? []) as { id: string; full_name: string | null }[]).filter((x) => x.full_name?.trim()).map((x) => ({ id: x.id, name: x.full_name!.trim() })));
      setFiktive(voll ? ((fik.data ?? []) as BrettPerson[]) : []);
      const a = new Map<string, number>();
      for (const j of (jobs.data ?? []) as { location_id: string }[]) a.set(j.location_id, (a.get(j.location_id) ?? 0) + 1);
      setAnlaesse(a);
    })();
    void fetch("/api/ressourcen/fahrt", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { zeiten?: Record<string, BrettFahrt> }) => { if (aktiv && j.zeiten) setFahrten(new Map(Object.entries(j.zeiten))); })
      .catch(() => { /* Karten zeigen dann keine Fahrzeit */ });
    return () => { aktiv = false; };
  }, [ladeStand]);

  // Locations ohne Koordinaten einmal nachziehen (bestehender Geocoder,
  // schreibt latitude/longitude) — Grundlage der Fahrzeit. Nacheinander:
  // Nominatim erlaubt 1 Anfrage/s.
  useEffect(() => {
    if (!orte || !darfAendern) return;
    const offen = orte.filter((o) => (o.latitude == null || o.longitude == null) && o.address_city && !nachgezogen.current.has(o.id));
    if (offen.length === 0) return;
    let aktiv = true;
    void (async () => {
      for (const o of offen) {
        if (!aktiv) return;
        nachgezogen.current.add(o.id);
        try {
          await fetch("/api/geocode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ table: "locations", id: o.id }) });
        } catch { /* Fahrzeit fehlt dann bei diesem Haus */ }
        await new Promise((r) => setTimeout(r, 1100));
      }
    })();
    return () => { aktiv = false; };
  }, [orte, darfAendern]);

  /** Locations plus vorgemerkte Häuser, die noch keine Location sind. */
  const alle = useMemo<Ort[] | null>(() => {
    if (orte === null) return null;
    const vor: Ort[] = (alleNamen ? fehlendeHaeuser(alleNamen) : []).map((h) => ({
      id: `${VORGEMERKT_PRAEFIX}${h.schluessel}`,
      name: h.name,
      address_street: h.address_street,
      address_zip: h.address_zip,
      address_city: h.address_city,
      capacity: h.capacity,
      latitude: h.latitude,
      longitude: h.longitude,
      vorgemerkt: h,
    }));
    // Die sechs Häuser der Skizze zuerst, weitere danach nach Name.
    const rang = (n: string) => { const i = REIHENFOLGE.findIndex((m) => n.toLowerCase().includes(m)); return i < 0 ? REIHENFOLGE.length : i; };
    return [...orte, ...vor].sort((a, b) => rang(a.name) - rang(b.name) || a.name.localeCompare(b.name, "de-CH"));
  }, [orte, alleNamen]);

  // ─── Schreiben ──────────────────────────────────────────────────────
  async function sende(pfad: string, body: Record<string, unknown>): Promise<{ id?: string } | null> {
    try {
      const res = await fetch(pfad, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string; id?: string } | null;
      if (!res.ok || !j?.success) { TOAST.errorOr(j?.error, "Speichern fehlgeschlagen"); return null; }
      return j;
    } catch {
      toast.error("Speichern fehlgeschlagen");
      return null;
    }
  }
  const ohne = (liste: Belegt[], art: Belegt["art"], id: string) => liste.filter((x) => !(x.art === art && x.id === id));
  function setzeLokal(ort: string, art: "person" | "fiktiv", id: string, funktion: Funktion | null) {
    setBelegung((alt) => {
      const rest = ohne(alt.get(ort) ?? [], art, id);
      return new Map(alt).set(ort, funktion ? [...rest, { art, id, funktion }] : rest);
    });
  }

  async function onPerson(locationId: string, profileId: string, funktion: Funktion | null) {
    if (!(await sende("/api/ressourcen/einteilung", { locationId, profileId, funktion }))) return false;
    setzeLokal(locationId, "person", profileId, funktion);
    return true;
  }
  async function onFiktiv(locationId: string, fiktivId: string, funktion: Funktion | null) {
    if (!(await sende("/api/ressourcen/planung", { aktion: "fiktiv-setze", locationId, fiktivId, funktion }))) return false;
    setzeLokal(locationId, "fiktiv", fiktivId, funktion);
    return true;
  }
  async function onOffenNeu(locationId: string, funktion: Funktion) {
    const j = await sende("/api/ressourcen/planung", { aktion: "offen-neu", locationId, funktion });
    if (!j?.id) return false;
    const id = j.id;
    setBelegung((alt) => new Map(alt).set(locationId, [...(alt.get(locationId) ?? []), { art: "offen", id, funktion }]));
    return true;
  }
  async function onOffenWeg(locationId: string, stelleId: string) {
    if (!(await sende("/api/ressourcen/planung", { aktion: "offen-loeschen", id: stelleId }))) return false;
    setBelegung((alt) => new Map(alt).set(locationId, ohne(alt.get(locationId) ?? [], "offen", stelleId)));
    return true;
  }
  async function onFiktivNeu(name: string) {
    const j = await sende("/api/ressourcen/planung", { aktion: "fiktiv-neu", name });
    if (!j?.id) return false;
    const id = j.id;
    setFiktive((alt) => [...alt, { id, name }].sort((a, b) => a.name.localeCompare(b.name, "de-CH")));
    return true;
  }
  async function onFiktivLoeschen(id: string) {
    if (!(await sende("/api/ressourcen/planung", { aktion: "fiktiv-loeschen", id }))) return false;
    setFiktive((alt) => alt.filter((x) => x.id !== id));
    setBelegung((alt) => new Map([...alt].map(([ort, liste]) => [ort, ohne(liste, "fiktiv", id)])));
    return true;
  }

  // ─── Locations anlegen ──────────────────────────────────────────────
  async function vorgemerkteAnlegen(nur?: VorgemerktesHaus) {
    setLegtAn(true);
    try {
      const supabase = createClient();
      // Frische Namensprüfung, damit nichts doppelt entsteht.
      const { data: namen, error: nErr } = await supabase.from("locations").select("name");
      if (nErr) { TOAST.supabaseError(nErr, "Locations konnten nicht geprüft werden"); return; }
      const fehlen = fehlendeHaeuser(((namen ?? []) as { name: string }[]).map((n) => n.name)).filter((h) => !nur || h.schluessel === nur.schluessel);
      if (fehlen.length === 0) { toast.success("Bereits angelegt"); setLadeStand((s) => s + 1); return; }
      const { error } = await supabase.from("locations").insert(
        fehlen.map((h) => ({
          name: h.name,
          address_street: h.address_street,
          address_zip: h.address_zip,
          address_city: h.address_city,
          capacity: h.capacity,
          technical_details: h.technical_details,
          notes: h.notes,
          latitude: h.latitude,
          longitude: h.longitude,
        })),
      );
      if (error) { TOAST.supabaseError(error, "Anlegen fehlgeschlagen"); return; }
      toast.success(fehlen.length === 1 ? `${fehlen[0].name} ist als Location angelegt` : `${fehlen.length} Häuser als Locations angelegt`);
      setLadeStand((s) => s + 1);
    } finally {
      setLegtAn(false);
    }
  }

  async function neueLocation() {
    const name = neu.name.trim();
    if (!name) { toast.error("Bitte einen Namen angeben"); return; }
    if ((alleNamen ?? []).some((n) => n.trim().toLowerCase() === name.toLowerCase())) { toast.error("Eine Location mit diesem Namen gibt es schon"); return; }
    setLegtAn(true);
    try {
      const { data, error } = await createClient()
        .from("locations")
        .insert({ name, address_street: neu.street.trim() || null, address_zip: neu.zip.trim() || null, address_city: neu.city.trim() || null })
        .select("id")
        .single();
      if (error || !data?.id) { TOAST.supabaseError(error, "Location konnte nicht angelegt werden"); return; }
      // Koordinaten für die Fahrzeit; ohne Treffer bleibt die Location trotzdem angelegt.
      nachgezogen.current.add(data.id as string);
      await fetch("/api/geocode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ table: "locations", id: data.id }) }).catch(() => null);
      toast.success(`${name} ist angelegt`);
      setNeu(NEU_LEER);
      setLadeStand((s) => s + 1);
    } finally {
      setLegtAn(false);
    }
  }

  // ─── Ableitungen ────────────────────────────────────────────────────
  const vorgemerkte = (alle ?? []).filter((o) => o.vorgemerkt);
  const angelegte = (alle ?? []).filter((o) => !o.vorgemerkt);
  const eintraege = angelegte.flatMap((o) => belegung.get(o.id) ?? []);
  const offeneStellen = eintraege.filter((x) => x.art === "offen").length;
  const fiktivEintraege = eintraege.filter((x) => x.art === "fiktiv").length;
  const mitLuecke = angelegte.filter((o) => stand(belegung.get(o.id) ?? []).rot !== null);
  const anlaesseTotal = anlaesse ? angelegte.reduce((x, o) => x + (anlaesse.get(o.id) ?? 0), 0) : null;

  const q = suche.trim().toLowerCase();
  const gezeigt = (alle ?? []).filter((o) => {
    if (nurLuecke && (o.vorgemerkt || stand(belegung.get(o.id) ?? []).rot === null)) return false;
    if (!q) return true;
    return `${o.name} ${o.address_city ?? ""} ${o.address_zip ?? ""}`.toLowerCase().includes(q);
  });
  const brettHaus = (o: Ort) => ({ id: o.id, name: o.name, ort: [o.address_zip, o.address_city].filter(Boolean).join(" "), capacity: o.capacity, vorgemerkt: !!o.vorgemerkt });
  const feld = "h-9 bg-muted/40";

  return (
    <div className="flex flex-col gap-4">
      {/* Kennzahlen */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b pb-3 md:grid-cols-4">
        <Kennzahl wert={alle === null ? "…" : String(alle.length)} text={vorgemerkte.length ? `Häuser, davon ${vorgemerkte.length} noch nicht angelegt` : "Häuser"} />
        <Kennzahl wert={alle === null ? "…" : String(mitLuecke.length)} text={erweitert ? `Häuser mit Lücke, ${offeneStellen} offene ${offeneStellen === 1 ? "Stelle" : "Stellen"}` : "Häuser ohne Stellvertretung"} farbe={mitLuecke.length > 0 ? ROT : undefined} />
        <Kennzahl wert={alle === null ? "…" : erweitert ? String(fiktivEintraege) : "–"} text="Stellen fiktiv besetzt" farbe={fiktivEintraege > 0 ? GELB : undefined} />
        <Kennzahl wert={anlaesseTotal === null ? "…" : String(anlaesseTotal)} text="Anlässe in den nächsten 30 Tagen" />
      </div>

      {/* Suche, Filter, neue Location */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Haus oder Ort suchen …" className={`${feld} pl-8`} aria-label="Häuser suchen" />
        </div>
        <button type="button" className={`kasten ${nurLuecke ? "kasten-active" : "kasten-toggle-off"}`} aria-pressed={nurLuecke} onClick={() => setNurLuecke((v) => !v)}>
          Nur mit Lücke ({mitLuecke.length})
        </button>
        <span className="flex items-center gap-3 text-xs text-muted-foreground">
          <Legende farbe="color-mix(in srgb, currentColor 30%, transparent)" text="Person" />
          <Legende farbe={GELB} text="fiktiv" />
          <Legende farbe={ROT} text="offene Stelle" />
        </span>
        {darfAnlegen && (
          <button type="button" className="kasten kasten-red ml-auto" onClick={() => setNeuOffen((v) => !v)} aria-expanded={neuOffen}>
            {neuOffen ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {neuOffen ? "Schliessen" : "Location"}
          </button>
        )}
      </div>

      {neuOffen && darfAnlegen && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border px-3 py-2.5">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">Name
            <Input value={neu.name} onChange={(e) => setNeu({ ...neu, name: e.target.value })} placeholder="z. B. Kulturscheune Liestal" className={feld} autoFocus />
          </label>
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-muted-foreground">Strasse und Nummer
            <Input value={neu.street} onChange={(e) => setNeu({ ...neu, street: e.target.value })} className={feld} />
          </label>
          <label className="flex w-24 flex-col gap-1 text-xs text-muted-foreground">PLZ
            <Input value={neu.zip} onChange={(e) => setNeu({ ...neu, zip: e.target.value })} className={feld} inputMode="numeric" />
          </label>
          <label className="flex w-40 flex-col gap-1 text-xs text-muted-foreground">Ort
            <Input value={neu.city} onChange={(e) => setNeu({ ...neu, city: e.target.value })} className={feld} />
          </label>
          <button type="button" className="kasten kasten-red" disabled={legtAn || !neu.name.trim()} onClick={() => void neueLocation()}>
            {legtAn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {legtAn ? "Wird angelegt …" : "Anlegen"}
          </button>
        </div>
      )}

      {vorgemerkte.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2">
          <p className="text-sm">
            <span className="font-medium">{vorgemerkte.length} {vorgemerkte.length === 1 ? "Haus ist" : "Häuser sind"} noch nicht angelegt</span> (gestrichelt): {vorgemerkte.map((o) => o.name).join(", ")}.
          </p>
          {darfAnlegen && (
            <button type="button" className="kasten kasten-red" disabled={legtAn} onClick={() => void vorgemerkteAnlegen()}>
              {legtAn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {legtAn ? "Wird angelegt …" : vorgemerkte.length === 1 ? "Jetzt anlegen" : `Alle ${vorgemerkte.length} jetzt anlegen`}
            </button>
          )}
        </div>
      )}

      {!erweitert && alle !== null && (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm">
          Geschäftsleitung, Betriebsleitung, fiktives Personal und offene Stellen sind gesperrt, bis die Datenbank erweitert ist (Migration 392, Starter «Ressourcen einrichten»). Bis dahin gibt es nur «Personal».
        </p>
      )}

      {alle === null ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : gezeigt.length === 0 && alle.length > 0 ? (
        <EmptyState icon={Search} title="Kein Haus gefunden" description="Suche oder Filter «Nur mit Lücke» anpassen." />
      ) : (
        <RessourcenBrett
          haeuser={gezeigt.map(brettHaus)}
          alleHaeuser={alle.map(brettHaus)}
          personen={personen}
          fiktive={fiktive}
          belegung={belegung}
          anlaesse={anlaesse}
          fahrten={fahrten}
          darfBearbeiten={darfAendern && einteilungOk}
          darfAnlegen={darfAnlegen}
          legtAn={legtAn}
          erweitert={erweitert}
          onPerson={onPerson}
          onFiktiv={onFiktiv}
          onOffenNeu={onOffenNeu}
          onOffenWeg={onOffenWeg}
          onFiktivNeu={onFiktivNeu}
          onFiktivLoeschen={onFiktivLoeschen}
          onAnlegen={(id) => { const h = alle.find((o) => o.id === id)?.vorgemerkt; if (h) void vorgemerkteAnlegen(h); }}
        />
      )}
    </div>
  );
}

function Kennzahl({ wert, text, farbe }: { wert: string; text: string; farbe?: string }) {
  return (
    <div>
      <p className="text-2xl font-semibold leading-tight tracking-tight" style={farbe ? { color: farbe } : undefined}>{wert}</p>
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function Legende({ farbe, text }: { farbe: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2.5 w-2.5 rounded-full" style={{ background: farbe }} />
      {text}
    </span>
  );
}
