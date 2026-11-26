"use client";

/**
 * Ressourcen › Karte (Leo 26.11.2026, Seite /vertrieb): Karte mit allen Locations. Ein
 * Klick auf eine Location (Karte oder Liste) zeigt zuoberst, wer von uns dort
 * eingeteilt ist — mit Auswahl aus dem eigenen Personal (dieselbe Karte wie in
 * der Location, Bearbeiten mit locations:edit) —, dann die schnellste
 * Autostrecke ab Büro, Kapazität, Technik und Kontaktpersonen.
 *
 * Daten: locations (aktiv, nicht archiviert), standort_mitarbeiter,
 * location_contacts — über den RLS-Client (locations:view). Einteilung:
 * StandortMitarbeiterCard (PUT /api/standorte/[id]/mitarbeiter). Alles andere
 * wird in der Location gepflegt (/standorte/[id]). Strecke: GET
 * /api/ressourcen/fahrt.
 *
 * Die sechs Häuser erscheinen in jedem Fall: was noch keine Location ist,
 * kommt aus src/lib/ressourcen/haeuser.ts als «noch nicht angelegt» und wird
 * per Knopf als Location angelegt (locations:create, wie auf /locations).
 * Locations ohne gespeicherte Koordinaten werden einmal nachgezogen
 * (POST /api/geocode, locations:edit).
 *
 * Aufbau nach Leos Skizze (26.11.2026): oben Kennzahlen (Lücken rot), dann
 * das Planungsbrett (ressourcen-brett.tsx) — je Haus eine Spalte mit Karte,
 * Feld «Leitung» und Feld «Personal», darunter «Gesamtes Personal» —, zuletzt
 * Karte und Detailfeld. Die Funktion (Leitung/Personal) steht in
 * standort_mitarbeiter.funktion (Migration 392); fehlt die Spalte noch,
 * gelten alle als Personal.
 *
 * Karte: Leaflet mit OpenStreetMap-Kacheln (in der CSP bereits freigegeben).
 * Zustand in der URL (§10): ?ort=<location-id>. Laptop-Seite.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Car, ExternalLink, Loader2, MapPin, Phone, Mail, Plus, Wrench } from "lucide-react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import "leaflet/dist/leaflet.css";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { StandortMitarbeiterCard } from "@/components/standort/standort-mitarbeiter-card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import type { LocationContact } from "@/types";
import { fehlendeHaeuser, VORGEMERKT_PRAEFIX, type VorgemerktesHaus } from "@/lib/ressourcen/haeuser";
import { TOAST } from "@/lib/messages";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { luecke, RessourcenBrett, type BrettFahrt, type BrettPerson, type Eintrag, type Funktion } from "@/components/vertrieb/ressourcen-brett";

type Ort = {
  id: string;
  name: string;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  capacity: number | null;
  technical_details: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Gesetzt, wenn das Haus noch keine Location ist (nur vorgemerkt). */
  vorgemerkt?: VorgemerktesHaus;
};
type Punkt = { lat: number; lng: number };
type Buero = Punkt & { adresse: string };
type Fahrt = { km: number; minuten: number; linie: [number, number][] };
type FahrtAntwort = { ziel: Punkt | null; fahrt: Fahrt | null; maps: string | null };
type LeafletModul = typeof import("leaflet");

const ROT = "#dc2626";
const DUNKEL = "#1f2937";
const BASEL: [number, number] = [47.5596, 7.5886];
const ZAHL = new Intl.NumberFormat("de-CH");
const REIHENFOLGE = ["barakuba", "bau3", "trafohalle", "querfeld", "gemeinschaftsbank", "palazzo"];

function koordinaten(o: Ort): Punkt | null {
  const lat = Number(o.latitude);
  const lng = Number(o.longitude);
  return o.latitude != null && o.longitude != null && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function adresse(o: Ort): string {
  const ort = [o.address_zip, o.address_city].filter(Boolean).join(" ");
  return [o.address_street, ort].filter(Boolean).join(", ");
}

function dauer(minuten: number): string {
  if (minuten < 60) return `${minuten} Min.`;
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

export function RessourcenAnsicht({ ortId, onOrt }: { ortId: string | null; onOrt: (id: string | null) => void }) {
  const [orte, setOrte] = useState<Ort[] | null>(null);
  /** location_id → profile_ids der eingeteilten Mitarbeitenden. */
  const [einteilung, setEinteilung] = useState<Map<string, Eintrag[]>>(new Map());
  /** Spalte «funktion» vorhanden (Migration 392)? */
  const [funktionBekannt, setFunktionBekannt] = useState(true);
  /** Namen ALLER Locations (auch archivierte) — gegen doppeltes Anlegen. */
  const [alleNamen, setAlleNamen] = useState<string[] | null>(null);
  const [stand, setStand] = useState(0);
  /** Einteilung sicher geladen? Sonst kein Bearbeiten (PUT ersetzt die ganze Liste). */
  const [einteilungOk, setEinteilungOk] = useState(false);
  const [personen, setPersonen] = useState<BrettPerson[]>([]);
  const [anlaesse, setAnlaesse] = useState<Map<string, number> | null>(null);
  const [fahrten, setFahrten] = useState<Map<string, BrettFahrt>>(new Map());
  const fahrtGefragt = useRef(new Set<string>());
  const [legtAn, setLegtAn] = useState(false);
  const { can } = usePermissions();
  const darfAnlegen = can("locations:create");
  const darfAendern = can("locations:edit");
  const nachgezogen = useRef(new Set<string>());
  const [buero, setBuero] = useState<Buero | null>(null);
  // Antworten tragen die Location-ID: so gilt eine Antwort nie für eine
  // inzwischen andere Auswahl, und es braucht kein Zurücksetzen im Effekt.
  const [kontakteZu, setKontakteZu] = useState<{ id: string; liste: LocationContact[] } | null>(null);
  const [fahrtZu, setFahrtZu] = useState<{ id: string; antwort: FahrtAntwort } | null>(null);
  const kontakte = ortId && kontakteZu?.id === ortId ? kontakteZu.liste : null;
  const fahrt = ortId && fahrtZu?.id === ortId ? fahrtZu.antwort : null;
  const fahrtLaedt = !!ortId && fahrtZu?.id !== ortId;

  const kartenEl = useRef<HTMLDivElement | null>(null);
  const karte = useRef<LeafletMap | null>(null);
  const leaflet = useRef<LeafletModul | null>(null);
  const punkteEbene = useRef<LayerGroup | null>(null);
  const streckeEbene = useRef<LayerGroup | null>(null);
  const [karteBereit, setKarteBereit] = useState(false);
  const onOrtRef = useRef(onOrt);
  useEffect(() => { onOrtRef.current = onOrt; }, [onOrt]);

  // ─── Stammdaten: Locations, Einteilung, Namen, Büro ─────────────────
  useEffect(() => {
    let aktiv = true;
    const supabase = createClient();
    void (async () => {
      const in30 = new Date(Date.now() + 30 * 86400000).toISOString();
      const [loc, einMit, namen, prof, jobs] = await Promise.all([
        supabase
          .from("locations")
          .select("id, name, address_street, address_zip, address_city, capacity, technical_details, latitude, longitude")
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
      ]);
      // Spalte «funktion» fehlt noch (Migration 392) → ohne sie laden.
      const ohneFunktion = !!einMit.error && (einMit.error.code === "42703" || einMit.error.code === "PGRST204");
      const ein = ohneFunktion ? await supabase.from("standort_mitarbeiter").select("location_id, profile_id") : einMit;
      if (!aktiv) return;
      setFunktionBekannt(!ohneFunktion);
      if (loc.error) toast.error(`Locations laden fehlgeschlagen: ${loc.error.message}`);
      if (ein.error) toast.error(`Einteilung laden fehlgeschlagen: ${ein.error.message}`);
      setOrte((loc.data ?? []) as Ort[]);
      // Namen unbekannt (Fehler) → keine vorgemerkten Häuser zeigen, sonst
      // könnte ein vorhandenes Haus doppelt angelegt werden.
      setAlleNamen(namen.error ? null : ((namen.data ?? []) as { name: string }[]).map((n) => n.name));
      const m = new Map<string, Eintrag[]>();
      for (const z of (ein.data ?? []) as { location_id: string; profile_id: string; funktion?: string | null }[]) {
        m.set(z.location_id, [...(m.get(z.location_id) ?? []), { profileId: z.profile_id, funktion: z.funktion === "leitung" ? "leitung" : "personal" }]);
      }
      setEinteilung(m);
      setEinteilungOk(!ein.error);
      if (prof.error) toast.error(`Mitarbeitende laden fehlgeschlagen: ${prof.error.message}`);
      setPersonen(((prof.data ?? []) as { id: string; full_name: string | null }[]).filter((x) => x.full_name?.trim()).map((x) => ({ id: x.id, name: x.full_name!.trim() })));
      if (jobs.error) toast.error(`Aufträge laden fehlgeschlagen: ${jobs.error.message}`);
      const a = new Map<string, number>();
      for (const j of (jobs.data ?? []) as { location_id: string }[]) a.set(j.location_id, (a.get(j.location_id) ?? 0) + 1);
      setAnlaesse(a);
    })();
    void fetch("/api/ressourcen/fahrt", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { buero?: Buero | null }) => { if (aktiv) setBuero(j.buero ?? null); })
      .catch(() => { /* Karte funktioniert auch ohne Büro-Punkt */ });
    return () => { aktiv = false; };
  }, [stand]);

  // Locations ohne Koordinaten einmal nachziehen (bestehender Geocoder,
  // schreibt latitude/longitude). Nacheinander: Nominatim erlaubt 1 Anfrage/s.
  useEffect(() => {
    if (!orte || !darfAendern) return;
    const offen = orte.filter((o) => !koordinaten(o) && o.address_city && !nachgezogen.current.has(o.id));
    if (offen.length === 0) return;
    let aktiv = true;
    void (async () => {
      for (const o of offen) {
        if (!aktiv) return;
        nachgezogen.current.add(o.id);
        try {
          const res = await fetch("/api/geocode", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ table: "locations", id: o.id }),
          });
          const j = (await res.json().catch(() => null)) as { ok?: boolean; coords?: Punkt } | null;
          if (aktiv && j?.ok && j.coords) {
            const c = j.coords;
            setOrte((alt) => alt?.map((x) => (x.id === o.id ? { ...x, latitude: c.lat, longitude: c.lng } : x)) ?? alt);
          }
        } catch { /* bleibt in der Liste «nicht auf der Karte» */ }
        await new Promise((r) => setTimeout(r, 1100));
      }
    })();
    return () => { aktiv = false; };
  }, [orte, darfAendern]);

  /** Locations plus vorgemerkte Häuser, die noch keine Location sind. */
  const alle = useMemo<Ort[] | null>(() => {
    if (orte === null) return null;
    const neu: Ort[] = (alleNamen ? fehlendeHaeuser(alleNamen) : []).map((h) => ({
      id: `${VORGEMERKT_PRAEFIX}${h.schluessel}`,
      name: h.name,
      address_street: h.address_street,
      address_zip: h.address_zip,
      address_city: h.address_city,
      capacity: h.capacity,
      technical_details: h.technical_details,
      latitude: h.latitude,
      longitude: h.longitude,
      vorgemerkt: h,
    }));
    // Reihenfolge wie auf Leos Skizze, weitere Locations danach nach Name.
    const rang = (n: string) => { const i = REIHENFOLGE.findIndex((m) => n.toLowerCase().includes(m)); return i < 0 ? REIHENFOLGE.length : i; };
    return [...orte, ...neu].sort((a, b) => rang(a.name) - rang(b.name) || a.name.localeCompare(b.name, "de-CH"));
  }, [orte, alleNamen]);

  const gewaehlt = useMemo(() => alle?.find((o) => o.id === ortId) ?? null, [alle, ortId]);
  const gewaehltLat = gewaehlt?.vorgemerkt?.latitude ?? null;
  const gewaehltLng = gewaehlt?.vorgemerkt?.longitude ?? null;

  // Fahrt ab Büro für jedes Haus (Planungsbrett). Nacheinander, serverseitig gecacht.
  useEffect(() => {
    if (!alle) return;
    const offen = alle.filter((o) => !fahrtGefragt.current.has(o.id) && (o.vorgemerkt || koordinaten(o) || o.address_city));
    if (offen.length === 0) return;
    let aktiv = true;
    void (async () => {
      for (const o of offen) {
        if (!aktiv) return;
        fahrtGefragt.current.add(o.id);
        const frage = o.vorgemerkt ? `lat=${o.vorgemerkt.latitude}&lng=${o.vorgemerkt.longitude}` : `id=${encodeURIComponent(o.id)}`;
        try {
          const r = await fetch(`/api/ressourcen/fahrt?${frage}`, { cache: "no-store" });
          const j = (await r.json().catch(() => null)) as { fahrt?: { minuten: number; km: number } | null } | null;
          const f = j?.fahrt;
          if (aktiv && f) setFahrten((alt) => new Map(alt).set(o.id, { minuten: f.minuten, km: f.km }));
        } catch { /* Brett zeigt «…» */ }
      }
    })();
    return () => { aktiv = false; };
  }, [alle]);

  /** Alle vorgemerkten Häuser auf einmal anlegen (frische Namensprüfung davor). */
  async function alleAnlegen() {
    setLegtAn(true);
    try {
      const supabase = createClient();
      const { data: namen, error: nErr } = await supabase.from("locations").select("name");
      if (nErr) { TOAST.supabaseError(nErr, "Locations konnten nicht geprüft werden"); return; }
      const fehlen = fehlendeHaeuser(((namen ?? []) as { name: string }[]).map((n) => n.name));
      if (fehlen.length === 0) { toast.success("Alle Häuser sind bereits angelegt"); setStand((s) => s + 1); return; }
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
      if (error) { TOAST.supabaseError(error, "Die Häuser konnten nicht angelegt werden"); return; }
      toast.success(`${fehlen.length} ${fehlen.length === 1 ? "Haus" : "Häuser"} als Location angelegt`);
      if (ortId?.startsWith(VORGEMERKT_PRAEFIX)) onOrt(null);
      fahrtGefragt.current = new Set();
      setStand((s) => s + 1);
    } finally {
      setLegtAn(false);
    }
  }

  async function anlegen(h: VorgemerktesHaus) {
    setLegtAn(true);
    try {
      const { data, error } = await createClient()
        .from("locations")
        .insert({
          name: h.name,
          address_street: h.address_street,
          address_zip: h.address_zip,
          address_city: h.address_city,
          capacity: h.capacity,
          technical_details: h.technical_details,
          notes: h.notes,
          latitude: h.latitude,
          longitude: h.longitude,
        })
        .select("id")
        .single();
      if (error || !data?.id) {
        TOAST.supabaseError(error, `${h.name} konnte nicht angelegt werden`);
        return;
      }
      toast.success(`${h.name} ist als Location angelegt`);
      onOrt(data.id as string);
      setStand((s) => s + 1);
    } finally {
      setLegtAn(false);
    }
  }

  // ─── Auswahl: Kontakte und Strecke laden ────────────────────────────
  useEffect(() => {
    if (!ortId) return;
    const vorgemerkt = ortId.startsWith(VORGEMERKT_PRAEFIX);
    // Vorgemerktes Haus: erst abfragen, wenn seine Koordinaten bekannt sind.
    if (vorgemerkt && (gewaehltLat == null || gewaehltLng == null)) return;
    let aktiv = true;
    const leer: FahrtAntwort = { ziel: null, fahrt: null, maps: null };
    if (!vorgemerkt) {
      void createClient()
        .from("location_contacts")
        .select("id, location_id, name, role, email, phone, notes, created_at")
        .eq("location_id", ortId)
        .order("name")
        .then(({ data, error }) => {
          if (!aktiv) return;
          if (error) toast.error(`Kontakte laden fehlgeschlagen: ${error.message}`);
          setKontakteZu({ id: ortId, liste: (data ?? []) as LocationContact[] });
        });
    }
    const frage = vorgemerkt ? `lat=${gewaehltLat}&lng=${gewaehltLng}` : `id=${encodeURIComponent(ortId)}`;
    void fetch(`/api/ressourcen/fahrt?${frage}`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, j: (await r.json().catch(() => null)) as (FahrtAntwort & { error?: string }) | null }))
      .then(({ ok, j }) => {
        if (!aktiv) return;
        if (!ok || !j) {
          toast.error(j?.error ?? "Die Strecke konnte nicht berechnet werden");
          setFahrtZu({ id: ortId, antwort: leer });
        } else {
          setFahrtZu({ id: ortId, antwort: { ziel: j.ziel ?? null, fahrt: j.fahrt ?? null, maps: j.maps ?? null } });
        }
      })
      .catch(() => {
        if (!aktiv) return;
        toast.error("Die Strecke konnte nicht berechnet werden");
        setFahrtZu({ id: ortId, antwort: leer });
      });
    return () => { aktiv = false; };
  }, [ortId, gewaehltLat, gewaehltLng]);

  // ─── Karte aufbauen (einmal) ────────────────────────────────────────
  useEffect(() => {
    let weg = false;
    void (async () => {
      const mod = await import("leaflet");
      const L = ((mod as unknown as { default?: LeafletModul }).default ?? mod) as LeafletModul;
      if (weg || !kartenEl.current) return;
      const m = L.map(kartenEl.current, { zoomControl: true, attributionControl: true }).setView(BASEL, 11);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
      }).addTo(m);
      streckeEbene.current = L.layerGroup().addTo(m);
      punkteEbene.current = L.layerGroup().addTo(m);
      karte.current = m;
      leaflet.current = L;
      setKarteBereit(true);
    })();
    return () => {
      weg = true;
      karte.current?.remove();
      karte.current = null;
      punkteEbene.current = null;
      streckeEbene.current = null;
      setKarteBereit(false);
    };
  }, []);

  // ─── Punkte zeichnen ────────────────────────────────────────────────
  useEffect(() => {
    const L = leaflet.current;
    const ebene = punkteEbene.current;
    if (!karteBereit || !L || !ebene) return;
    ebene.clearLayers();
    if (buero) {
      L.marker([buero.lat, buero.lng], {
        interactive: true,
        keyboard: false,
        icon: L.divIcon({
          className: "",
          iconSize: [16, 16],
          iconAnchor: [8, 8],
          html: `<div style="width:16px;height:16px;background:${DUNKEL};border:2px solid #fff;border-radius:3px;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>`,
        }),
      }).bindTooltip("EVENTLINE Büro", { direction: "top", offset: [0, -8] }).addTo(ebene);
    }
    for (const o of alle ?? []) {
      const p = koordinaten(o);
      if (!p) continue;
      const aktiv = o.id === ortId;
      L.circleMarker([p.lat, p.lng], {
        radius: aktiv ? 11 : 8,
        weight: o.vorgemerkt ? 3 : 2,
        // Noch nicht angelegt: heller Punkt mit rotem Rand.
        ...(o.vorgemerkt
          ? { color: ROT, fillColor: "#fff", fillOpacity: 1 }
          : { color: "#fff", fillColor: ROT, fillOpacity: aktiv ? 1 : 0.75 }),
      })
        .bindTooltip(o.vorgemerkt ? `${o.name} (noch nicht angelegt)` : o.name, { direction: "top", offset: [0, -8], permanent: aktiv })
        .on("click", () => onOrtRef.current(o.id))
        .addTo(ebene);
    }
  }, [karteBereit, alle, buero, ortId]);

  // ─── Ausschnitt: alle Locations, solange nichts gewählt ist ─────────
  useEffect(() => {
    const L = leaflet.current;
    const m = karte.current;
    if (!karteBereit || !L || !m || ortId) return;
    streckeEbene.current?.clearLayers();
    const punkte: [number, number][] = (alle ?? []).map(koordinaten).filter((p): p is Punkt => !!p).map((p) => [p.lat, p.lng]);
    if (buero) punkte.push([buero.lat, buero.lng]);
    if (punkte.length > 1) m.fitBounds(L.latLngBounds(punkte), { padding: [40, 40], maxZoom: 14 });
    else if (punkte.length === 1) m.setView(punkte[0], 13);
  }, [karteBereit, alle, buero, ortId]);

  // ─── Strecke zeichnen, wenn eine Location gewählt ist ───────────────
  useEffect(() => {
    const L = leaflet.current;
    const m = karte.current;
    const ebene = streckeEbene.current;
    if (!karteBereit || !L || !m || !ebene || !ortId) return;
    ebene.clearLayers();
    const ziel = fahrt?.ziel ?? (gewaehlt ? koordinaten(gewaehlt) : null);
    if (fahrt?.fahrt && fahrt.fahrt.linie.length > 1) {
      const linie = L.polyline(fahrt.fahrt.linie, { color: DUNKEL, weight: 5, opacity: 0.85 }).addTo(ebene);
      m.fitBounds(linie.getBounds(), { padding: [50, 50], maxZoom: 15 });
    } else if (ziel && buero) {
      // Solange (oder falls) keine Strecke da ist: gestrichelte Luftlinie.
      L.polyline([[buero.lat, buero.lng], [ziel.lat, ziel.lng]], { color: DUNKEL, weight: 2, opacity: 0.5, dashArray: "6 8" }).addTo(ebene);
      m.fitBounds(L.latLngBounds([[buero.lat, buero.lng], [ziel.lat, ziel.lng]]), { padding: [50, 50], maxZoom: 15 });
    } else if (ziel) {
      m.setView([ziel.lat, ziel.lng], 14);
    }
  }, [karteBereit, ortId, fahrt, buero, gewaehlt]);

  const ohnePunkt = (alle ?? []).filter((o) => !koordinaten(o));

  const vorgemerkte = (alle ?? []).filter((o) => o.vorgemerkt);
  const angelegte = (alle ?? []).filter((o) => !o.vorgemerkt);
  const luecken = angelegte.filter((o) => luecke(einteilung.get(o.id) ?? [], funktionBekannt) !== null).length;
  const zugeteilt = new Set(angelegte.flatMap((o) => (einteilung.get(o.id) ?? []).map((x) => x.profileId)));
  const eingeteiltePersonen = personen.filter((x) => zugeteilt.has(x.id)).length;

  /** Eine Einteilung speichern (funktion null = entfernen) und lokal nachführen. */
  async function setzeEinteilung(locationId: string, profileId: string, funktion: Funktion | null): Promise<boolean> {
    try {
      const res = await fetch("/api/ressourcen/einteilung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locationId, profileId, funktion }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) { TOAST.errorOr(j?.error, "Speichern fehlgeschlagen"); return false; }
      setEinteilung((alt) => {
        const rest = (alt.get(locationId) ?? []).filter((x) => x.profileId !== profileId);
        return new Map(alt).set(locationId, funktion ? [...rest, { profileId, funktion }] : rest);
      });
      return true;
    } catch {
      toast.error("Speichern fehlgeschlagen");
      return false;
    }
  }
  const anlaesseTotal = anlaesse ? angelegte.reduce((x, o) => x + (anlaesse.get(o.id) ?? 0), 0) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Kennzahlen */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-b pb-3 md:grid-cols-4">
        <Kennzahl wert={alle === null ? "…" : String(alle.length)} text={vorgemerkte.length ? `Häuser, davon ${vorgemerkte.length} noch nicht angelegt` : "Häuser"} />
        <Kennzahl wert={alle === null ? "…" : String(luecken)} text="Häuser ohne Leitung oder Stellvertretung" rot={luecken > 0} />
        <Kennzahl wert={alle === null ? "…" : String(eingeteiltePersonen)} text={`von ${personen.length} Mitarbeitenden eingeteilt`} />
        <Kennzahl wert={anlaesseTotal === null ? "…" : String(anlaesseTotal)} text="Anlässe in den nächsten 30 Tagen" />
      </div>

      {vorgemerkte.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed px-3 py-2">
          <p className="text-sm">
            Noch nicht als Location angelegt: <span className="font-medium">{vorgemerkte.map((o) => o.name).join(", ")}</span>. Erst danach lässt sich dort Personal einteilen.
          </p>
          {darfAnlegen && (
            <button type="button" className="kasten kasten-red" disabled={legtAn} onClick={() => void alleAnlegen()}>
              {legtAn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {legtAn ? "Wird angelegt …" : "Alle anlegen"}
            </button>
          )}
        </div>
      )}

      {alle === null ? (
        <Skeleton className="h-80 w-full rounded-xl" />
      ) : (
        <RessourcenBrett
          haeuser={alle.map((o) => ({ id: o.id, name: o.name, ort: [o.address_zip, o.address_city].filter(Boolean).join(" "), capacity: o.capacity, vorgemerkt: !!o.vorgemerkt }))}
          personen={personen}
          einteilung={einteilung}
          anlaesse={anlaesse}
          fahrten={fahrten}
          darfBearbeiten={darfAendern && einteilungOk}
          funktionBekannt={funktionBekannt}
          ortId={ortId}
          onOrt={onOrt}
          onSetze={setzeEinteilung}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,25rem)]">
      {/* Karte */}
      <div className="relative overflow-hidden rounded-xl border" style={{ isolation: "isolate" }}>
        <div ref={kartenEl} className="h-[24rem] w-full lg:h-[30rem]" aria-label="Karte der Locations" />
        {!karteBereit && <Skeleton className="absolute inset-0 rounded-none" />}
        {ohnePunkt.length > 0 && (
          <p className="border-t bg-card px-3 py-1.5 text-xs text-muted-foreground">
            Nicht auf der Karte, weil die Adresse fehlt oder nicht gefunden wurde: {ohnePunkt.map((o) => o.name).join(", ")}.
          </p>
        )}
      </div>

      {/* Ressourcen vor Ort */}
      <div className="rounded-xl border bg-card p-4 lg:max-h-[30rem] lg:overflow-y-auto">
        {!gewaehlt ? (
          <EmptyState icon={MapPin} title="Location wählen" description="Klick auf einen Punkt der Karte oder auf die Karte eines Hauses im Planungsbrett zeigt Personal, Fahrt ab Büro, Technik und Kontakt." />
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold leading-tight">{gewaehlt.name}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{adresse(gewaehlt) || "Keine Adresse erfasst"}</p>
            </div>

            {/* Personal zuoberst: wer von uns ist hier, und wer kommt dazu. */}
            {gewaehlt.vorgemerkt ? (
              <div className="flex flex-col gap-2 rounded-lg border border-dashed p-3">
                <p className="text-sm">
                  Dieses Haus ist noch nicht als Location angelegt. Personal lässt sich erst danach einteilen.
                </p>
                {darfAnlegen ? (
                  <button
                    type="button"
                    className="kasten kasten-red self-start"
                    disabled={legtAn}
                    onClick={() => gewaehlt.vorgemerkt && void anlegen(gewaehlt.vorgemerkt)}
                  >
                    {legtAn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                    {legtAn ? "Wird angelegt …" : "Als Location anlegen"}
                  </button>
                ) : (
                  <p className="text-xs text-muted-foreground">Anlegen kann, wer Locations erfassen darf.</p>
                )}
              </div>
            ) : (
              <StandortMitarbeiterCard
                key={`${gewaehlt.id}:${(einteilung.get(gewaehlt.id) ?? []).map((x) => x.profileId).join(",")}`}
                locationId={gewaehlt.id}
                locationName={gewaehlt.name}
                canEdit={darfAendern && einteilungOk}
                kalenderAn={false}
                onGeaendert={(ids) => setEinteilung((alt) => {
                  // Funktion bestehender Einträge behalten, neue gelten als Personal.
                  const bisher = new Map((alt.get(gewaehlt.id) ?? []).map((x) => [x.profileId, x.funktion]));
                  return new Map(alt).set(gewaehlt.id, ids.map((id) => ({ profileId: id, funktion: bisher.get(id) ?? "personal" })));
                })}
              />
            )}

            <Abschnitt icon={<Car className="h-4 w-4" />} titel="Fahrt ab Büro">
              {fahrtLaedt ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Strecke wird berechnet …</p>
              ) : fahrt?.fahrt ? (
                <>
                  <p className="text-2xl font-semibold tracking-tight">{dauer(fahrt.fahrt.minuten)}<span className="ml-2 text-base font-normal text-muted-foreground">{ZAHL.format(fahrt.fahrt.km)} km</span></p>
                  <p className="text-xs text-muted-foreground">Schnellste Strecke mit dem Auto, ohne aktuelle Verkehrslage{buero ? `. Start: ${buero.adresse}` : ""}.</p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">Die Strecke ist im Moment nicht verfügbar.</p>
              )}
              {fahrt?.maps && (
                <a href={fahrt.maps} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-sm underline underline-offset-2">
                  In Google Maps mit Verkehrslage öffnen<ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </Abschnitt>

            <Abschnitt icon={<Wrench className="h-4 w-4" />} titel="Raum und Technik">
              <p className="text-sm">{gewaehlt.capacity ? `Kapazität: ${ZAHL.format(gewaehlt.capacity)} Personen` : "Kapazität nicht erfasst"}</p>
              <p className="whitespace-pre-line text-sm text-muted-foreground">{gewaehlt.technical_details?.trim() || "Keine Technik erfasst."}</p>
            </Abschnitt>

            {!gewaehlt.vorgemerkt && (<>
            <Abschnitt icon={<Phone className="h-4 w-4" />} titel="Kontakt im Haus">
              {kontakte === null ? (
                <Skeleton className="h-8 w-full" />
              ) : kontakte.length === 0 ? (
                <p className="text-sm text-muted-foreground">Kein Kontakt erfasst.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {kontakte.map((k) => (
                    <li key={k.id}>
                      <span className="font-medium">{k.name}</span>
                      {k.role && <span className="text-muted-foreground"> · {k.role}</span>}
                      <span className="flex flex-wrap gap-x-3 text-muted-foreground">
                        {k.phone && <a href={`tel:${k.phone}`} className="inline-flex items-center gap-1 underline underline-offset-2"><Phone className="h-3 w-3" />{k.phone}</a>}
                        {k.email && <a href={`mailto:${k.email}`} className="inline-flex items-center gap-1 underline underline-offset-2"><Mail className="h-3 w-3" />{k.email}</a>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Abschnitt>

            <PrefetchLink href={`/standorte/${gewaehlt.id}`} className="text-sm underline underline-offset-2">
              Location öffnen (Technik, Kontakte, Notizen bearbeiten)
            </PrefetchLink>
            </>)}
          </div>
        )}
      </div>
      </div>

    </div>
  );
}

function Kennzahl({ wert, text, rot }: { wert: string; text: string; rot?: boolean }) {
  return (
    <div>
      <p className="text-2xl font-semibold leading-tight tracking-tight" style={rot ? { color: ROT } : undefined}>{wert}</p>
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function Abschnitt({ icon, titel, children }: { icon: React.ReactNode; titel: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1 border-t pt-3">
      <h3 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{icon}{titel}</h3>
      {children}
    </section>
  );
}
