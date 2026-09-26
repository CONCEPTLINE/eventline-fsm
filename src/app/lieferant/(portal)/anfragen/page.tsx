"use client";

// Lieferantenportal → Anfragen: alle Auftraege, fuer die EVENTLINE diese
// Firma als Techniklieferant eingeplant hat. Daten via
// /api/lieferant/anfragen (Whitelist — keine Preise/Kundendaten).

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipboardCheck, MapPin, Users, ChevronRight, AlertTriangle } from "lucide-react";
import { techTag } from "@/components/technik/technik-shared";

interface Anfrage {
  jobId: string;
  titel: string;
  jobNumber: number | null;
  startDate: string | null;
  endDate: string | null;
  gaeste: number | null;
  eventTyp: string | null;
  locationName: string | null;
  angefragtAt: string | null;
  positionen: number;
  bestaetigt: number;
  offenePunkte: number;
}

export default function LieferantAnfragenPage() {
  const [anfragen, setAnfragen] = useState<Anfrage[] | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/lieferant/anfragen");
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.success) {
          setFehler(json?.error ?? "Laden fehlgeschlagen");
          return;
        }
        setAnfragen(json.anfragen as Anfrage[]);
      } catch {
        setFehler("Netzwerkfehler");
      }
    })();
  }, []);

  return (
    <div className="max-w-3xl mx-auto page-enter space-y-4">
      <div>
        <h1 className="text-xl font-bold">Anfragen</h1>
        <p className="text-sm text-muted-foreground">
          Technik-Planungen von EVENTLINE — prüfe die Positionen, gib Empfehlungen ab und bestätige, was passt.
        </p>
      </div>

      {fehler && <p className="text-sm text-red-500">{fehler}</p>}

      {!anfragen && !fehler && (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
        </div>
      )}

      {anfragen && anfragen.length === 0 && (
        <EmptyState
          icon={ClipboardCheck}
          title="Keine Anfragen"
          description="Sobald EVENTLINE dich für die Technik eines Auftrags einplant, erscheint die Anfrage hier."
        />
      )}

      {anfragen && anfragen.map((a) => {
        const datum = a.startDate
          ? a.endDate && techTag(a.endDate) !== techTag(a.startDate)
            ? `${techTag(a.startDate)} – ${techTag(a.endDate)}`
            : techTag(a.startDate)
          : null;
        const offen = a.positionen - a.bestaetigt;
        return (
          <Link key={a.jobId} href={`/lieferant/anfragen/${a.jobId}`} className="block">
            <Card className="bg-card card-hover">
              <CardContent className="p-4 flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold text-sm truncate">{a.titel}</h3>
                    {a.eventTyp && <span className="text-xs text-muted-foreground">{a.eventTyp}</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
                    {datum && <span>{datum}</span>}
                    {a.locationName && (
                      <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{a.locationName}</span>
                    )}
                    {a.gaeste != null && (
                      <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{a.gaeste} Gäste</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${
                      offen === 0 && a.positionen > 0
                        ? "bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-300"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {a.bestaetigt} von {a.positionen} bestätigt
                    </span>
                    {a.offenePunkte > 0 && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3" />
                        {a.offenePunkte} {a.offenePunkte === 1 ? "offener Punkt" : "offene Punkte"}
                      </span>
                    )}
                    {a.angefragtAt && (
                      <span className="text-[11px] text-muted-foreground">Angefragt am {techTag(a.angefragtAt)}</span>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </CardContent>
            </Card>
          </Link>
        );
      })}
    </div>
  );
}
