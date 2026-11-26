"use client";

/**
 * Ressourcen › Karte (Leo 26.11.2026, Seite /vertrieb): Karte mit allen Locations. Ein
 * Klick auf eine Location (Karte oder Liste) zeigt, was dort vor Ort zur
 * Verfügung steht — eingeteilte Mitarbeitende, Kapazität, Technik,
 * Kontaktpersonen — und die schnellste Autostrecke ab Büro.
 *
 * Daten: locations (aktiv, nicht archiviert), standort_mitarbeiter,
 * location_contacts, profiles — alles über den RLS-Client (locations:view).
 * Die Seite pflegt nichts selbst: geändert wird in der Location
 * (/standorte/[id]). Strecke: GET /api/ressourcen/fahrt.
 *
 * Karte: Leaflet mit OpenStreetMap-Kacheln (in der CSP bereits freigegeben).
 * Zustand in der URL (§10): ?ort=<location-id>. Laptop-Seite.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Car, ExternalLink, Loader2, MapPin, Phone, Mail, Users, Wrench } from "lucide-react";
import type { Map as LeafletMap, LayerGroup } from "leaflet";
import "leaflet/dist/leaflet.css";
import { createClient } from "@/lib/supabase/client";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import type { LocationContact } from "@/types";

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
  const [einteilung, setEinteilung] = useState<Map<string, string[]>>(new Map());
  const [namen, setNamen] = useState<Map<string, string>>(new Map());
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
      const [loc, ein, prof] = await Promise.all([
        supabase
          .from("locations")
          .select("id, name, address_street, address_zip, address_city, capacity, technical_details, latitude, longitude")
          .eq("is_active", true)
          .is("archived_at", null)
          .order("name"),
        supabase.from("standort_mitarbeiter").select("location_id, profile_id"),
        supabase.from("profiles").select("id, full_name").not("role", "in", PORTAL_ROLLEN_IN).eq("is_active", true),
      ]);
      if (!aktiv) return;
      if (loc.error) toast.error(`Locations laden fehlgeschlagen: ${loc.error.message}`);
      if (ein.error) toast.error(`Einteilung laden fehlgeschlagen: ${ein.error.message}`);
      if (prof.error) toast.error(`Mitarbeitende laden fehlgeschlagen: ${prof.error.message}`);
      setOrte((loc.data ?? []) as Ort[]);
      const m = new Map<string, string[]>();
      for (const z of (ein.data ?? []) as { location_id: string; profile_id: string }[]) {
        m.set(z.location_id, [...(m.get(z.location_id) ?? []), z.profile_id]);
      }
      setEinteilung(m);
      setNamen(new Map(((prof.data ?? []) as { id: string; full_name: string | null }[]).map((p) => [p.id, p.full_name?.trim() || "Ohne Namen"])));
    })();
    void fetch("/api/ressourcen/fahrt", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: { buero?: Buero | null }) => { if (aktiv) setBuero(j.buero ?? null); })
      .catch(() => { /* Karte funktioniert auch ohne Büro-Punkt */ });
    return () => { aktiv = false; };
  }, []);

  const gewaehlt = useMemo(() => orte?.find((o) => o.id === ortId) ?? null, [orte, ortId]);

  // ─── Auswahl: Kontakte und Strecke laden ────────────────────────────
  useEffect(() => {
    if (!ortId) return;
    let aktiv = true;
    const leer: FahrtAntwort = { ziel: null, fahrt: null, maps: null };
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
    void fetch(`/api/ressourcen/fahrt?id=${encodeURIComponent(ortId)}`, { cache: "no-store" })
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
  }, [ortId]);

  // ─── Karte aufbauen (einmal) ────────────────────────────────────────
  useEffect(() => {
    let weg = false;
    void (async () => {
      const mod = await import("leaflet");
      const L = ((mod as unknown as { default?: LeafletModul }).default ?? mod) as LeafletModul;
      if (weg || !kartenEl.current) return;
      const m = L.map(kartenEl.current, { zoomControl: true, attributionControl: true }).setView(BASEL, 11);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
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
    for (const o of orte ?? []) {
      const p = koordinaten(o);
      if (!p) continue;
      const aktiv = o.id === ortId;
      L.circleMarker([p.lat, p.lng], {
        radius: aktiv ? 11 : 8,
        color: "#fff",
        weight: 2,
        fillColor: ROT,
        fillOpacity: aktiv ? 1 : 0.75,
      })
        .bindTooltip(o.name, { direction: "top", offset: [0, -8], permanent: aktiv })
        .on("click", () => onOrtRef.current(o.id))
        .addTo(ebene);
    }
  }, [karteBereit, orte, buero, ortId]);

  // ─── Ausschnitt: alle Locations, solange nichts gewählt ist ─────────
  useEffect(() => {
    const L = leaflet.current;
    const m = karte.current;
    if (!karteBereit || !L || !m || ortId) return;
    streckeEbene.current?.clearLayers();
    const punkte: [number, number][] = (orte ?? []).map(koordinaten).filter((p): p is Punkt => !!p).map((p) => [p.lat, p.lng]);
    if (buero) punkte.push([buero.lat, buero.lng]);
    if (punkte.length > 1) m.fitBounds(L.latLngBounds(punkte), { padding: [40, 40], maxZoom: 14 });
    else if (punkte.length === 1) m.setView(punkte[0], 13);
  }, [karteBereit, orte, buero, ortId]);

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

  const ohnePunkt = (orte ?? []).filter((o) => !koordinaten(o));
  const personen = gewaehlt ? (einteilung.get(gewaehlt.id) ?? []).map((id) => namen.get(id)).filter((n): n is string => !!n).sort((a, b) => a.localeCompare(b, "de-CH")) : [];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,21rem)]">
      {/* Liste */}
      <div className="rounded-xl border bg-card p-3 lg:max-h-[36rem] lg:overflow-y-auto">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Locations</p>
        {orte === null ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : orte.length === 0 ? (
          <p className="text-sm text-muted-foreground">Noch keine Locations erfasst.</p>
        ) : (
          <ul className="flex flex-col">
            {orte.map((o) => {
              const aktiv = o.id === ortId;
              const anzahl = (einteilung.get(o.id) ?? []).length;
              return (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => onOrt(aktiv ? null : o.id)}
                    aria-pressed={aktiv}
                    className="row-hover flex w-full items-center justify-between gap-2 px-2 py-2 text-left text-sm [--row-hover-x:0rem]"
                    style={aktiv ? { fontWeight: 600 } : undefined}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: ROT, opacity: aktiv ? 1 : 0.45 }} />
                      <span className="truncate">{o.name}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" data-tooltip="Eingeteilte Mitarbeitende">
                      <Users className="h-3.5 w-3.5" />{anzahl}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {ohnePunkt.length > 0 && (
          <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
            Nicht auf der Karte, weil die Adresse fehlt oder nicht gefunden wurde: {ohnePunkt.map((o) => o.name).join(", ")}.
          </p>
        )}
      </div>

      {/* Karte */}
      <div className="relative overflow-hidden rounded-xl border" style={{ isolation: "isolate" }}>
        <div ref={kartenEl} className="h-[26rem] w-full lg:h-[36rem]" aria-label="Karte der Locations" />
        {!karteBereit && <Skeleton className="absolute inset-0 rounded-none" />}
      </div>

      {/* Ressourcen vor Ort */}
      <div className="rounded-xl border bg-card p-4 lg:max-h-[36rem] lg:overflow-y-auto">
        {!gewaehlt ? (
          <EmptyState icon={MapPin} title="Location wählen" description="Klick auf einen Punkt der Karte oder auf einen Namen in der Liste zeigt die Ressourcen vor Ort und die Fahrt ab Büro." />
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-semibold leading-tight">{gewaehlt.name}</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">{adresse(gewaehlt) || "Keine Adresse erfasst"}</p>
            </div>

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

            <Abschnitt icon={<Users className="h-4 w-4" />} titel={`Personal vor Ort (${personen.length})`}>
              {personen.length === 0 ? (
                <p className="text-sm text-muted-foreground">Niemand eingeteilt.</p>
              ) : (
                <ul className="flex flex-col gap-0.5 text-sm">{personen.map((n) => <li key={n}>{n}</li>)}</ul>
              )}
            </Abschnitt>

            <Abschnitt icon={<Wrench className="h-4 w-4" />} titel="Raum und Technik">
              <p className="text-sm">{gewaehlt.capacity ? `Kapazität: ${ZAHL.format(gewaehlt.capacity)} Personen` : "Kapazität nicht erfasst"}</p>
              <p className="whitespace-pre-line text-sm text-muted-foreground">{gewaehlt.technical_details?.trim() || "Keine Technik erfasst."}</p>
            </Abschnitt>

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
              Location öffnen und Ressourcen bearbeiten
            </PrefetchLink>
          </div>
        )}
      </div>
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
