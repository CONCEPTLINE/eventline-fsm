"use client";

// Lieferantenportal → Anfragen: alle Auftraege, fuer die EVENTLINE diese
// Firma als Techniklieferant angefragt hat. Aufbau exakt wie die Anfragen
// im Partnerportal (src/app/partner/(portal)/anfragen/page.tsx): Titel,
// Filterzeile im angehefteten Kopf, Karten mit Status-Pille, EmptyState in
// einer Karte. Filter «Aktuell | Vergangen» und Suche laufen serverseitig
// (/api/lieferant/anfragen) und stehen in der URL (Reload/Teilen, §10).
// Beim Zurueckkehren ins Fenster wird neu geladen.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { AlertTriangle, ClipboardCheck, History, MapPin, Search, Users, CalendarClock, Loader2 } from "lucide-react";
import type { AnfrageStatus } from "@/lib/technik";
import { AnfrageStatusBadge, anzahl, zeitraumText } from "@/components/technik/technik-shared";
import { formatDateFull } from "@/lib/format";

interface Anfrage {
  jobId: string;
  titel: string;
  jobNumber: number | null;
  status: string;
  anfrageStatus: AnfrageStatus;
  gesperrt: boolean;
  startDate: string | null;
  endDate: string | null;
  gaeste: number | null;
  eventTyp: string | null;
  ort: string | null;
  angefragtAt: string;
  runden: number;
  positionen: number;
  bestaetigt: number;
  offenePunkte: number;
}

type Zeit = "aktuell" | "vergangen";

const STATUS_HINWEIS: Record<AnfrageStatus, string> = {
  neu: "EVENTLINE wartet auf deine Rückmeldung",
  beantwortet: "Du hast seit der letzten Anfrage geantwortet",
  geaendert: "EVENTLINE hat seit der letzten Anfrage etwas geändert",
  storniert: "Der Auftrag wurde storniert",
  abgeschlossen: "Der Auftrag ist abgeschlossen",
};

export default function LieferantAnfragenPage() {
  return (
    <Suspense fallback={<ListeSkelett />}>
      <AnfragenListe />
    </Suspense>
  );
}

function ListeSkelett() {
  return (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <Card key={i} className="animate-pulse bg-card">
          <CardContent className="p-4">
            <div className="h-5 bg-foreground/10 dark:bg-foreground/15 rounded w-1/3" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function AnfragenListe() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const zeit: Zeit = params.get("zeit") === "vergangen" ? "vergangen" : "aktuell";
  const qUrl = params.get("q") ?? "";
  const [suche, setSuche] = useState(qUrl);
  const [anfragen, setAnfragen] = useState<Anfrage[] | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const anfrageNr = useRef(0);

  /** Filter in die URL (replace: kein neuer Verlaufseintrag pro Tastendruck). */
  const setzeUrl = useCallback((neu: { zeit?: Zeit; q?: string }) => {
    const p = new URLSearchParams(params.toString());
    const z = neu.zeit ?? zeit;
    const q = neu.q ?? qUrl;
    if (z === "vergangen") p.set("zeit", "vergangen"); else p.delete("zeit");
    if (q.trim()) p.set("q", q.trim()); else p.delete("q");
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router, zeit, qUrl]);

  // URL von aussen geaendert (Zurueck-Knopf, Link) → Suchfeld nachziehen.
  const geschrieben = useRef(qUrl);
  useEffect(() => {
    if (qUrl === geschrieben.current) return;
    geschrieben.current = qUrl;
    setSuche(qUrl);
  }, [qUrl]);

  // Tippen → nach kurzer Pause in die URL (die URL steuert das Laden).
  useEffect(() => {
    if (suche.trim() === qUrl.trim()) return;
    const t = setTimeout(() => {
      geschrieben.current = suche.trim();
      setzeUrl({ q: suche });
    }, 300);
    return () => clearTimeout(t);
  }, [suche, qUrl, setzeUrl]);

  const laden = useCallback(async () => {
    const nr = ++anfrageNr.current;
    setLaedt(true);
    try {
      const p = new URLSearchParams({ zeit });
      if (qUrl.trim()) p.set("q", qUrl.trim());
      const res = await fetch(`/api/lieferant/anfragen?${p.toString()}`);
      const json = await res.json().catch(() => null);
      if (nr !== anfrageNr.current) return; // ueberholt
      if (!res.ok || !json?.success) {
        setFehler(json?.error ?? "Laden fehlgeschlagen");
        return;
      }
      setFehler(null);
      setAnfragen(json.anfragen as Anfrage[]);
    } catch {
      if (nr === anfrageNr.current) setFehler("Netzwerkfehler");
    } finally {
      if (nr === anfrageNr.current) setLaedt(false);
    }
  }, [zeit, qUrl]);

  useEffect(() => { void laden(); }, [laden]);

  // Zurueck im Fenster → frisch laden (Aenderungen von EVENTLINE).
  useEffect(() => {
    let zuletzt = Date.now();
    const auffrischen = () => {
      if (document.visibilityState !== "visible" || Date.now() - zuletzt < 5000) return;
      zuletzt = Date.now();
      void laden();
    };
    window.addEventListener("focus", auffrischen);
    document.addEventListener("visibilitychange", auffrischen);
    return () => {
      window.removeEventListener("focus", auffrischen);
      document.removeEventListener("visibilitychange", auffrischen);
    };
  }, [laden]);

  const hatSuche = qUrl.trim().length > 0;

  return (
    <div className="space-y-4 page-enter">
      {/* Kompletter Kopf (Titel + Filter) bleibt beim Scrollen stehen —
          gleicher Rahmen und Titel wie die anderen Portal-Reiter. */}
      <StickyFilterBar offset="portal" className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Anfragen</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Technik-Planungen von EVENTLINE — prüfe die Positionen, gib Empfehlungen ab und bestätige, was passt.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setzeUrl({ zeit: "aktuell" })}
            className={zeit === "aktuell" ? "kasten-active" : "kasten-toggle-off"}
            aria-pressed={zeit === "aktuell"}
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Aktuell
          </button>
          <button
            type="button"
            onClick={() => setzeUrl({ zeit: "vergangen" })}
            className={zeit === "vergangen" ? "kasten-active" : "kasten-toggle-off"}
            aria-pressed={zeit === "vergangen"}
            data-tooltip="Anfragen, deren Anlass vorbei ist"
          >
            <History className="h-3.5 w-3.5" />
            Vergangen
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Titel oder Auftragsnummer suchen…"
            value={suche}
            onChange={(e) => setSuche(e.target.value)}
            maxLength={80}
            className="pl-9 h-9"
            aria-label="Suche"
          />
          {laedt && anfragen && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>
      </StickyFilterBar>

      {fehler ? (
        <Card className="bg-card border-dashed">
          <CardContent className="p-0">
            <EmptyState icon={AlertTriangle} title="Anfragen konnten nicht geladen werden" description={`${fehler} — bitte später erneut versuchen.`} />
          </CardContent>
        </Card>
      ) : !anfragen ? (
        <ListeSkelett />
      ) : anfragen.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="p-0">
            <EmptyState
              icon={ClipboardCheck}
              title={hatSuche ? "Keine Treffer" : zeit === "vergangen" ? "Keine vergangenen Anfragen" : "Keine aktuellen Anfragen"}
              description={hatSuche
                ? "Versuch einen anderen Suchbegriff."
                : zeit === "vergangen"
                  ? "Anfragen, deren Anlass vorbei ist, landen automatisch hier."
                  : "Sobald EVENTLINE dir eine Technik-Planung zur Prüfung sendet, erscheint die Anfrage hier."}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {anfragen.map((a) => {
            const zeitraum = zeitraumText(a.startDate, a.endDate);
            const offen = a.positionen - a.bestaetigt;
            return (
              <PrefetchLink key={a.jobId} href={`/lieferant/anfragen/${a.jobId}`} className="block">
                <Card className="card-hover relative bg-card cursor-pointer">
                  <div
                    className="grid px-4 py-2.5 items-center gap-x-3"
                    style={{ gridTemplateColumns: "minmax(110px, 130px) minmax(0, 1fr) minmax(150px, 230px) minmax(140px, 220px)" }}
                  >
                    {/* Col 1: Stand */}
                    <AnfrageStatusBadge status={a.anfrageStatus} titel={STATUS_HINWEIS[a.anfrageStatus]} />

                    {/* Col 2: Nummer + Titel + Ort/Gaeste */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        {a.jobNumber && (
                          <span className="text-[10px] font-mono text-muted-foreground bg-foreground/[0.05] dark:bg-foreground/10 px-1.5 py-0.5 rounded shrink-0">
                            INT-{a.jobNumber}
                          </span>
                        )}
                        <span className="font-medium text-sm truncate">{a.titel}</span>
                      </div>
                      <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground min-w-0">
                        {a.ort && <span className="inline-flex items-center gap-1 min-w-0 truncate"><MapPin className="h-3 w-3 shrink-0" />{a.ort}</span>}
                        {a.gaeste != null && <span className="inline-flex items-center gap-1 shrink-0"><Users className="h-3 w-3" />{a.gaeste} Gäste</span>}
                        {a.eventTyp && <span className="truncate">{a.eventTyp}</span>}
                      </div>
                    </div>

                    {/* Col 3: Datum/Zeit */}
                    <span className="text-xs text-muted-foreground whitespace-nowrap truncate" data-tooltip={zeitraum ?? undefined}>
                      {zeitraum ?? "—"}
                    </span>

                    {/* Col 4: Stand der Technik */}
                    <div className="flex flex-col items-end gap-1 min-w-0">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${
                        offen === 0 && a.positionen > 0
                          ? "bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-300"
                          : "bg-muted text-muted-foreground"
                      }`}>
                        {a.bestaetigt}/{a.positionen} bestätigt
                      </span>
                      <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                        {a.offenePunkte > 0
                          ? anzahl(a.offenePunkte, "offener Punkt", "offene Punkte")
                          : `${a.runden > 1 ? `Runde ${a.runden} · ` : ""}angefragt ${formatDateFull(a.angefragtAt)}`}
                      </span>
                    </div>
                  </div>
                </Card>
              </PrefetchLink>
            );
          })}
        </div>
      )}
    </div>
  );
}
