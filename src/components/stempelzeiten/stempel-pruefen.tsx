"use client";

/**
 * Stempelzeiten › Prüfen — Stunden des Teams vor der Lohnabrechnung in Trust flow
 * (früher Lohn › Monatsstunden, jetzt ohne Beträge).
 *
 * Je Person: gestempelte Stunden, was zu prüfen ist (offene Stempel, Stempel über
 * 16 h ohne «geprüft», offene Anträge), lange Schichten. «Prüfen» öffnet die
 * Stempel der Person: «Stempel ist korrekt» (/api/hr/stempel-pruefen) bzw. «Ende
 * setzen» — im gesperrten Monat als Antrag (Vier Augen, /api/hr/stempel-antrag).
 *
 * Daten: GET /api/hr/stempel-pruefung?monat=YYYY-MM (lohn:manage + vertrautes Gerät).
 * Monat in der URL (?monat=, überlebt Reload; Alarm-Mail und Glocke verlinken dorthin).
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Loader2, Lock, Users } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { formatDate, toLocalIsoString } from "@/lib/format";
import { localDateIso, localTimeHM } from "@/lib/swiss-time";

interface StempelProblem {
  id: string;
  art: "offen" | "lang";
  clockIn: string;
  clockOut: string | null;
  dauerMinuten: number;
  langBegruendung: string | null;
}

interface Person {
  profile_id: string;
  name: string;
  is_active: boolean;
  minuten: number;
  probleme: StempelProblem[];
  lange: { anzahl: number; mit_begruendung: number; geprueft: number };
  antraege_offen: number;
}

interface Stand {
  monat: string;
  gesperrt: boolean;
  sperrt_ab: string;
  personen: Person[];
}

const MONATE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
const GRID = "minmax(0, 1fr) 110px 170px 170px 120px";
const BEGRUENDUNG_MIN = 10;

type Periode = { jahr: number; monat: number };

function heutePeriode(): Periode {
  const t = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit" }).format(new Date());
  return { jahr: Number(t.slice(0, 4)), monat: Number(t.slice(5, 7)) };
}
function ausUrl(wert: string | null): Periode {
  const t = wert ? /^(\d{4})-(0[1-9]|1[0-2])$/.exec(wert) : null;
  return t ? { jahr: Number(t[1]), monat: Number(t[2]) } : heutePeriode();
}
const schluessel = (p: Periode) => `${p.jahr}-${String(p.monat).padStart(2, "0")}`;
const verschiebe = (p: Periode, d: number): Periode => {
  const i = p.jahr * 12 + (p.monat - 1) + d;
  return { jahr: Math.floor(i / 12), monat: (i % 12) + 1 };
};
const stunden = (min: number) => `${(Math.round(min / 6) / 10).toFixed(1)} h`;
/** «05.11.» aus YYYY-MM-DD (reines Kalenderdatum, keine Zeitzone nötig). */
const tagMonat = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;
const DAUER = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} h`;
const ZEIT = (iso: string) => localTimeHM(new Date(iso));

function PfeilKnopf({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="kasten kasten-muted px-2" aria-label={label}>
      {children}
    </button>
  );
}

export function StempelPruefen() {
  const searchParams = useSearchParams();
  const [periode, setPeriodeState] = useState<Periode>(() => ausUrl(searchParams.get("monat")));
  const [stand, setStand] = useState<Stand | null>(null);
  const [version, setVersion] = useState(0);
  const [offenFuer, setOffenFuer] = useState<string | null>(null);
  const neuLaden = useCallback(() => setVersion((v) => v + 1), []);

  function setPeriode(neu: Periode) {
    setPeriodeState(neu);
    const url = new URL(window.location.href);
    url.searchParams.set("monat", schluessel(neu));
    window.history.replaceState(window.history.state, "", url.toString());
  }

  useEffect(() => {
    let aktiv = true;
    fetch(`/api/hr/stempel-pruefung?monat=${schluessel(periode)}`, { cache: "no-store" })
      .then((r) => r.json().catch(() => ({})))
      .then((j) => {
        if (!aktiv) return;
        if (!j.success) {
          toast.error(j.error === "device_not_trusted" ? j.message : j.error || j.message || "Stunden konnten nicht geladen werden");
          setStand({ monat: schluessel(periode), gesperrt: false, sperrt_ab: "", personen: [] });
          return;
        }
        setStand(j as Stand);
      })
      .catch((e) => {
        if (!aktiv) return;
        toast.error(`Stunden konnten nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => { aktiv = false; };
  }, [periode, version]);

  const aktuell = stand && stand.monat === schluessel(periode) ? stand : null;
  const person = aktuell?.personen.find((p) => p.profile_id === offenFuer) ?? null;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Stunden des Teams vor der Lohnabrechnung in Trust flow.</p>
      <div className="flex flex-wrap items-center gap-3">
        <PfeilKnopf onClick={() => setPeriode(verschiebe(periode, -1))} label="Vorheriger Monat"><ChevronLeft className="h-4 w-4" /></PfeilKnopf>
        <strong className="min-w-[130px] text-center text-sm tabular-nums">{MONATE[periode.monat - 1]} {periode.jahr}</strong>
        <PfeilKnopf onClick={() => setPeriode(verschiebe(periode, 1))} label="Nächster Monat"><ChevronRight className="h-4 w-4" /></PfeilKnopf>
        {aktuell?.gesperrt && (
          <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[13px] bg-foreground/[0.06] dark:bg-foreground/[0.12] text-foreground/80">
            <Lock className="h-3.5 w-3.5" />
            gesperrt seit {tagMonat(aktuell.sperrt_ab)} – Änderungen nur per Antrag
          </span>
        )}
      </div>

      <div className="border border-border bg-card">
        <div className="grid px-5 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground border-b border-border" style={{ gridTemplateColumns: GRID }}>
          <div>Person</div>
          <div>Stunden</div>
          <div>Zu prüfen</div>
          <div>Lange Schichten</div>
          <div />
        </div>
        {!aktuell ? (
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="px-5 py-3.5 border-b border-border last:border-b-0 flex gap-6">
              <Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-14" /><Skeleton className="h-4 w-24" />
            </div>
          ))
        ) : aktuell.personen.length === 0 ? (
          <EmptyState icon={Users} title="Keine Personen" description="In diesem Monat hat niemand gestempelt." />
        ) : (
          aktuell.personen.map((p) => <PersonZeile key={p.profile_id} p={p} onPruefen={() => setOffenFuer(p.profile_id)} />)
        )}
      </div>
      <p className="text-[13px] text-muted-foreground">Trust flow holt diese Stunden über die Schnittstelle.</p>

      <PruefDialog
        person={person}
        monatText={`${MONATE[periode.monat - 1]} ${periode.jahr}`}
        gesperrt={aktuell?.gesperrt ?? false}
        onClose={() => setOffenFuer(null)}
        onGeaendert={neuLaden}
      />
    </div>
  );
}

function zuPruefenText(p: Person): { text: string; warn: boolean } {
  const teile: string[] = [];
  if (p.probleme.length > 0) teile.push(`${p.probleme.length} Stempel`);
  if (p.antraege_offen > 0) teile.push(p.antraege_offen === 1 ? "1 Antrag offen" : `${p.antraege_offen} Anträge offen`);
  return teile.length > 0 ? { text: teile.join(" · "), warn: true } : { text: "alles geprüft", warn: false };
}

function langeText(l: Person["lange"]): string {
  if (l.anzahl === 0) return "–";
  if (l.geprueft === l.anzahl) return `${l.anzahl} · geprüft`;
  if (l.mit_begruendung === l.anzahl) return `${l.anzahl} · Begründung da`;
  return `${l.anzahl} · ohne Begründung`;
}

function PersonZeile({ p, onPruefen }: { p: Person; onPruefen: () => void }) {
  const z = zuPruefenText(p);
  return (
    <div className={`row-hover grid items-center px-5 py-3 text-sm border-b border-border last:border-b-0 ${p.is_active ? "" : "opacity-60"}`} style={{ gridTemplateColumns: GRID }}>
      <div className="min-w-0 truncate font-medium">{p.name}</div>
      <div className="tabular-nums">{p.minuten > 0 ? stunden(p.minuten) : <span className="text-muted-foreground">–</span>}</div>
      <div className={z.warn ? "font-semibold text-red-700 dark:text-red-300" : "text-muted-foreground inline-flex items-center gap-1"}>
        {!z.warn && <CheckCircle2 className="h-3.5 w-3.5" />}
        {z.text}
      </div>
      <div className={p.lange.anzahl === 0 ? "text-muted-foreground" : ""}>{langeText(p.lange)}</div>
      <div className="flex justify-end">
        {p.probleme.length > 0 ? (
          <button type="button" onClick={onPruefen} className="kasten kasten-blue">Prüfen</button>
        ) : p.antraege_offen > 0 ? (
          <PrefetchLink href="/antraege" className="kasten kasten-muted">Freigaben</PrefetchLink>
        ) : (
          <PrefetchLink href={`/stempelzeiten?user=${p.profile_id}`} className="kasten kasten-muted">Ansehen</PrefetchLink>
        )}
      </div>
    </div>
  );
}

/** Stempel einer Person prüfen: «Stempel ist korrekt» bzw. Ende setzen (gesperrt: Antrag). Ohne Beträge. */
function PruefDialog({ person, monatText, gesperrt, onClose, onGeaendert }: {
  person: Person | null;
  monatText: string;
  gesperrt: boolean;
  onClose: () => void;
  onGeaendert: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [endeFuer, setEndeFuer] = useState<string | null>(null);
  const [endeDatum, setEndeDatum] = useState("");
  const [endeZeit, setEndeZeit] = useState("");
  const [begruendung, setBegruendung] = useState("");
  const [langBegruendung, setLangBegruendung] = useState("");
  const [meldung, setMeldung] = useState<string | null>(null);

  // Andere Person → Eingaben zurücksetzen (beim Rendern, kein Effekt).
  const [fuer, setFuer] = useState<string | null>(null);
  const id = person?.profile_id ?? null;
  if (id !== fuer) {
    setFuer(id);
    setEndeFuer(null);
    setMeldung(null);
  }

  async function senden(key: string, url: string, body: unknown): Promise<Record<string, unknown> | null> {
    setBusy(key);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return (await res.json().catch(() => ({}))) as Record<string, unknown>;
    } catch (e) {
      toast.error(`Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }
  const fehlerText = (j: Record<string, unknown>, sonst: string) => String(j.error === "device_not_trusted" ? j.message : j.error ?? j.meldung ?? j.message ?? sonst);

  async function pruefen(p: StempelProblem) {
    const j = await senden(`pruefen-${p.id}`, "/api/hr/stempel-pruefen", { id: p.id });
    if (!j) return;
    if (!j.success) { toast.error(fehlerText(j, "Prüfen fehlgeschlagen")); return; }
    toast.success("Stempel als korrekt bestätigt");
    onGeaendert();
  }

  function endeOeffnen(p: StempelProblem) {
    setEndeFuer(p.id);
    setEndeDatum(p.clockOut ? localDateIso(new Date(p.clockOut)) : localDateIso(new Date(p.clockIn)));
    setEndeZeit(p.clockOut ? localTimeHM(new Date(p.clockOut)) : "");
    setBegruendung("");
    setLangBegruendung(p.langBegruendung ?? "");
    setMeldung(null);
  }

  async function endeSetzen(p: StempelProblem) {
    if (!endeDatum || !endeZeit) { toast.error("Datum und Uhrzeit des Endes eingeben"); return; }
    const clockOut = toLocalIsoString(endeDatum, endeZeit);
    const dauerMs = new Date(clockOut).getTime() - new Date(p.clockIn).getTime();
    if (!(dauerMs > 0)) { toast.error("Das Ende muss nach dem Beginn liegen"); return; }
    if (gesperrt && begruendung.trim().length < BEGRUENDUNG_MIN) { toast.error(`Begründung: mindestens ${BEGRUENDUNG_MIN} Zeichen`); return; }
    if (dauerMs > 16 * 3600_000 && !langBegruendung.trim()) { toast.error("Über 16 Stunden: Begründung der Dauer nötig"); return; }
    const j = await senden(`ende-${p.id}`, "/api/hr/stempel-antrag", {
      op: "update",
      id: p.id,
      clock_out: clockOut,
      lang_begruendung: langBegruendung.trim() || null,
      begruendung: begruendung.trim() || null,
    });
    if (!j) return;
    if (j.mode === "begruendung_noetig") { setMeldung(String(j.meldung ?? "Begründung nötig")); return; }
    if (!j.success) { toast.error(fehlerText(j, "Ende konnte nicht gesetzt werden")); return; }
    toast.success(j.mode === "antrag" ? String(j.meldung ?? "Antrag gestellt — die zweite Person bestätigt ihn unter Freigaben") : "Ende gesetzt");
    setEndeFuer(null);
    onGeaendert();
  }

  const p = person;
  return (
    <Modal open={!!p} onClose={() => { if (!busy) onClose(); }} closable={!busy} title={p ? `${p.name} · ${monatText}` : ""} size="md">
      {p && (
        <div className="space-y-3 text-sm">
          {p.probleme.length === 0 ? (
            <p className="text-muted-foreground inline-flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Alle Stempel sind geprüft.</p>
          ) : (
            <ul className="space-y-1.5">
              {p.probleme.map((s) => (
                <li key={s.id} className="rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/[0.08] px-2 py-1.5 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    <span className="font-medium tabular-nums">
                      {formatDate(s.clockIn)} {ZEIT(s.clockIn)} – {s.clockOut ? `${formatDate(s.clockOut) === formatDate(s.clockIn) ? "" : `${formatDate(s.clockOut)} `}${ZEIT(s.clockOut)}` : "offen"}
                    </span>
                    <span className="text-muted-foreground tabular-nums">{s.art === "offen" ? `läuft seit ${DAUER(s.dauerMinuten)}` : `${DAUER(s.dauerMinuten)} · über 16 h, ungeprüft`}</span>
                  </div>
                  {s.langBegruendung && <p className="text-[11px] text-muted-foreground">Begründung: {s.langBegruendung}</p>}
                  {endeFuer === s.id ? (
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Input type="date" value={endeDatum} onChange={(e) => setEndeDatum(e.target.value)} className="h-8 w-[150px] text-xs" disabled={!!busy} />
                        <ZeitFeld value={endeZeit} onChange={setEndeZeit} className="h-8 w-[80px] text-xs" disabled={!!busy} />
                        <span className="text-[11px] text-muted-foreground">Ende</span>
                      </div>
                      <Input value={begruendung} onChange={(e) => setBegruendung(e.target.value)} placeholder={gesperrt ? "Begründung des Antrags (Pflicht, z. B. «laut Einsatzplan bis 23:00»)" : "Begründung (optional)"} maxLength={500} className="h-8 text-xs" disabled={!!busy} />
                      {endeDatum && endeZeit && new Date(toLocalIsoString(endeDatum, endeZeit)).getTime() - new Date(s.clockIn).getTime() > 16 * 3600_000 && (
                        <Input value={langBegruendung} onChange={(e) => setLangBegruendung(e.target.value)} placeholder="Warum über 16 Stunden? (Pflicht)" maxLength={500} className="h-8 text-xs" disabled={!!busy} />
                      )}
                      {meldung && <p className="text-[11px] text-amber-700 dark:text-amber-300">{meldung}</p>}
                      <div className="flex gap-1.5">
                        <button type="button" onClick={() => setEndeFuer(null)} disabled={!!busy} className="kasten kasten-muted text-xs">Abbrechen</button>
                        <button type="button" onClick={() => void endeSetzen(s)} disabled={!!busy} className="kasten kasten-blue text-xs">
                          {busy === `ende-${s.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                          {gesperrt ? "Antrag stellen" : "Ende speichern"}
                        </button>
                      </div>
                      {gesperrt && <p className="text-[10px] text-muted-foreground">Der Monat ist gesperrt — die Änderung bestätigt eine zweite Person unter Freigaben (Vier Augen).</p>}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {s.art === "lang" && (
                        <button type="button" onClick={() => void pruefen(s)} disabled={!!busy} className="kasten kasten-green text-xs" data-tooltip="Die lange Dauer stimmt — der Stempel gilt als geprüft">
                          {busy === `pruefen-${s.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Stempel ist korrekt
                        </button>
                      )}
                      <button type="button" onClick={() => endeOeffnen(s)} disabled={!!busy} className="kasten kasten-muted text-xs">
                        {gesperrt ? "Ende per Antrag setzen" : "Ende setzen"}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {p.antraege_offen > 0 && (
            <p className="text-xs text-muted-foreground">
              {p.antraege_offen === 1 ? "1 Antrag" : `${p.antraege_offen} Anträge`} offen —{" "}
              <PrefetchLink href="/antraege" className="underline underline-offset-2">unter Freigaben entscheiden</PrefetchLink>.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
