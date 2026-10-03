"use client";

/**
 * Dashboard — feste Startseite (2026-10-02, Mischa: «Es soll sich
 * erleichternd anfuehlen, wenn man draufgeht, aber trotzdem alles Wichtige
 * zeigen»).
 *
 * Kein Baukasten mehr: kein Zahnrad, nichts zum Ausblenden, Verschieben oder
 * Verbreitern — also auch nichts zu speichern. Welche Bereiche jemand sieht,
 * entscheidet der Server (/api/dashboard) aus Rolle, Rechten und den
 * Rollen-Schaltern (src/lib/dashboard-bereiche.ts).
 *
 * Layout: festes Raster aus drei Reihen zu je zwei Plaetzen (links 58 %,
 * rechts 42 %) — siehe src/components/dashboard/dashboard-inhalt.tsx. Diese
 * Datei kuemmert sich nur ums Laden: Session-Cache, Fetch, Skelett, Fehler.
 *
 * Session-Cache (stale-while-revalidate): die letzte Antwort lebt im
 * Modul-Gedaechtnis (src/components/dashboard/session-cache.ts, zusammen mit
 * der Bereichs-Liste fuer das Skelett und dem Auftakt-Flag). Beim naechsten
 * Mount (Soft-Navigation zurueck aufs Dashboard) rendern wir SOFORT daraus
 * (kein Skelett) und revalidieren still im Hintergrund (der Fetch laeuft
 * immer, ersetzt die Anzeige bei Antwort). Logout/User-Wechsel leert alles.
 *
 * Auftakt: beim ersten echten Ladevorgang der Sitzung zaehlen die Zahlen hoch
 * und der Ruhe-Haken zeichnet sich (use-auftakt.ts, respektiert
 * reduced-motion). Ein Mount aus dem Cache zeigt sofort den Endstand.
 */

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertCircle } from "lucide-react";
import type { DashboardDaten } from "@/components/dashboard/typen";
import { DashboardInhalt } from "@/components/dashboard/dashboard-inhalt";
import { DashboardSkelett } from "@/components/dashboard/dashboard-skelett";
import { useAuftakt } from "@/components/dashboard/use-auftakt";
import {
  auftaktSchonGezeigt,
  cacheSchreiben,
  ensureCacheAuthWatcher,
  gecachteDaten,
  gemerkteBereiche,
} from "@/components/dashboard/session-cache";

export default function DashboardPage() {
  // Lazy-Init aus dem Session-Cache: auf dem Server und beim allerersten
  // Client-Besuch leer (-> Skelett, hydration-safe); bei Soft-Navigation
  // zurueck rendert der erste Frame sofort die Daten.
  const [data, setData] = useState<DashboardDaten | null>(() => gecachteDaten());
  const [error, setError] = useState<string | null>(null);
  // Auftakt nur beim ersten echten Ladevorgang der Sitzung: beim Mount
  // festlegen — lief er schon (Mount aus dem Cache), sofort der Endstand.
  // Gesetzt wird das Flag mit der ersten Antwort (cacheSchreiben).
  const [mitAuftakt] = useState(() => !auftaktSchonGezeigt());
  const auftakt = useAuftakt(data !== null, mitAuftakt);
  // Spiegel von `data` fuer den Fehlerpfad (Toast bei Stale-Daten vs.
  // Fehler-Anzeige), ohne data in die Effect-Deps zu ziehen.
  const dataRef = useRef<DashboardDaten | null>(data);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  // Stale-while-revalidate: bei JEDEM Mount frisch gegen den Server
  // (no-store) — gecachte Daten sind nur die Sofort-Anzeige.
  useEffect(() => {
    let cancelled = false;
    ensureCacheAuthWatcher();
    (async () => {
      try {
        const res = await fetch("/api/dashboard", { credentials: "include", cache: "no-store" });
        // Bei HTML-Fehlerseite wuerde res.json() mit unpassendem SyntaxError
        // fliegen — die Server-Meldung (JSON) aber trotzdem durchreichen.
        const json = (await res.json().catch(() => null)) as (Partial<DashboardDaten> & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !json || json.success !== true) {
          throw new Error(json?.error ?? (`${res.status} ${res.statusText}`.trim() || "Laden fehlgeschlagen"));
        }
        const fresh = json as DashboardDaten;
        setData(fresh);
        setError(null);
        cacheSchreiben(fresh);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Netzwerk-Fehler";
        if (dataRef.current) {
          // Stale-Daten stehen bereits — kein Fehler-Screen drueberlegen,
          // aber nie stiller Fehlschlag (§7): Toast.
          toast.error(`Dashboard konnte nicht aktualisiert werden: ${msg}`);
        } else {
          setError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!data) {
    // Ohne Cache ist auch die Bereichs-Liste meist unbekannt (volles Raster);
    // gleiche Quelle wie loading.tsx.
    if (!error) return <DashboardSkelett bereiche={gemerkteBereiche()} />;
    return (
      <div className="page-enter mx-auto flex max-w-[720px] flex-col gap-4">
        <h1 className="font-heading text-2xl font-semibold">Dashboard</h1>
        <div className="flex items-start gap-3 rounded-xl border bg-card p-4 text-sm">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
          <div>
            <p className="font-medium">Dashboard konnte nicht geladen werden</p>
            <p className="mt-1 text-muted-foreground">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return <DashboardInhalt daten={data} auftakt={auftakt} />;
}
