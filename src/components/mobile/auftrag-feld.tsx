"use client";

/**
 * Auftrag-Detail am Handy (< md) — Feldansicht ohne Tabs (Konzept §3).
 * Gemountet von src/app/(app)/auftraege/[id]/page.tsx, wenn useIsMobile()
 * true ist; der Desktop-Baum bleibt unveraendert.
 *
 * Aufbau: Titel · Kunde · Status-Pille · «Termine» (alle, mit Person) · Primaerknopf als
 * Zustandsmaschine (Einstempeln → Ausstempeln → Rapport-PDF) · Route /
 * Anrufen · Rapport-Zeile → /auftraege/[id]/rapport · Wo & wann ·
 * Ansprechperson · KI-Zusammenfassung (eingeklappt, nur lesen) · Notiz
 * fuers Team (Autosave 800 ms in jobs.notes) · Dokumente (Vorschau).
 *
 * Keine Tabs, kein «…»-Menue (Freigeben/Stornieren/Verantwortlich bleiben
 * Desktop), kein Technik-Tab, keine KI-Vorschlaege, kein Bexio, kein Upload.
 * Daten: use-auftrag-data (wie Desktop). meId aus usePermissions().
 *
 * Offline: die Kernfelder (JobFeldCache) gehen online write-through in den
 * IndexedDB-Cache `job:<id>` — DERSELBE Eintrag, den rapport-mobil liest
 * und schreibt — und werden ohne Netz daraus gerendert («Stand von HH:MM ·
 * offline»). Notiz, Dokumente und KI-Zusammenfassung gibt es nur online. Die
 * HTML-Huellen dieser Seite und des Rapports meldet die Seite dem Service
 * Worker zum Vorladen (Soft-Navigation legt sie sonst nie ab).
 *
 * Ladefehler (use-auftrag-data `fehler`, z. B. Netz laut Browser da, aber
 * Abfrage gescheitert): Toast; mit Cache-Eintrag bleibt der Cache-Stand
 * stehen («Stand von HH:MM · nicht aktualisiert», antippen = neu laden),
 * ohne Eintrag der LadeFehler-Block mit «Erneut versuchen».
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, CloudOff, FileText, Loader2, Mail, MapPin, Navigation, Phone, Play, Square } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel, formatStempelDuration } from "@/lib/use-stempel";
import { useOnline } from "@/lib/offline/sync-trigger";
import { cacheLesen, cacheSchreiben, istIdbVerfuegbar, type CacheEintrag } from "@/lib/offline/db";
import { seitenVorladen } from "@/lib/offline/sw-vorladen";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import { useAuftragData, type ReportWithCreator } from "@/components/auftrag/tabs/use-auftrag-data";
import { KiZusammenfassung } from "@/components/auftrag/eingang/ki-zusammenfassung";
import { useLocationRateTiers } from "@/components/stempel/rate-tier-chooser";
import { oeffneStempelSheet } from "@/components/mobile/stempel-sheet";
import { LadeFehler } from "@/components/mobile/lade-fehler";
import type { JobInfo } from "@/components/mobile/rapport-mobil";
import { PdfPopup } from "@/components/pdf-popup";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { JOB_STATUS } from "@/lib/constants";
import { TOAST } from "@/lib/messages";
import { formatDate, formatTime } from "@/lib/format";
import { localDateIso, todayLocalIso, ZRH_TZ } from "@/lib/swiss-time";
import { formatJobNumber } from "@/lib/nummern-format";
import type { JobAppointment, JobDetailWithRelations } from "@/types";

const LABEL = "font-sans text-[12px] font-bold uppercase tracking-wider text-muted-foreground";

// ---------------------------------------------------------------------------
// Offline-Eintrag `job:<id>`
// ---------------------------------------------------------------------------

/** Termin fuer «Termine» (Teilmenge von JobAppointment) — eigene UND die
 *  der Kollegen, damit vor Ort sichtbar ist, wer wann am Auftrag ist. */
interface FeldTermin {
  id: string;
  start_time: string;
  end_time: string | null;
  zeit_modus: JobAppointment["zeit_modus"];
  title: string;
  /** Name der zugeteilten Person; null = nicht zugeteilt. */
  person: string | null;
  meiner: boolean;
}

/**
 * Offline-Eintrag `job:<id>` im IndexedDB-Cache (je meId) — DERSELBE Eintrag
 * wie in rapport-mobil (JobInfo ist dessen Teil), damit beide Seiten einen
 * Cache teilen. Nur Kernfelder fuer den Techniker vor Ort: Titel/Nummer,
 * Zeiten, Ort/Adresse, Kontakt, Beschreibung, Zuteilung — kein Vollabbild
 * (keine Notiz, Dokumente, KI-Texte).
 */
export interface JobFeldCache extends JobInfo {
  priority: string;
  start_date: string | null;
  description: string | null;
  /** Standort- bzw. Raumname (location_name aus JobInfo ist nur der Standort). */
  ort: string | null;
  /** Strasse, PLZ Ort aus Standort/Raum, sonst externe Adresse. */
  adresse: string | null;
  /** Raumname als eigene Zeile, wenn Standort UND Raum gesetzt sind. */
  raum: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  termine: FeldTermin[];
  rapport: { status: string; updated_at: string; creator: string | null } | null;
}

/** Frischer Server-Stand → Kernfelder (Anzeige und Cache aus einer Quelle). */
function zuFeldDaten(
  job: JobDetailWithRelations,
  appointments: JobAppointment[],
  reports: ReportWithCreator[],
  meId: string | null,
): JobFeldCache {
  const location = job.location ?? null;
  const room = job.room ?? null;
  const q = location ?? room;
  const adresse = q
    ? [q.address_street, `${q.address_zip ?? ""} ${q.address_city ?? ""}`.trim()].filter(Boolean).join(", ") || null
    : job.external_address?.trim() || null;
  const rapport = reports[0] ?? null;
  return {
    id: job.id,
    job_number: job.job_number,
    title: job.title,
    end_date: job.end_date,
    status: job.status,
    location_id: job.location_id,
    customer_name: job.customer?.name ?? location?.customer?.name ?? null,
    location_name: location?.name ?? null,
    priority: job.priority,
    start_date: job.start_date,
    description: job.description,
    ort: location?.name ?? room?.name ?? null,
    adresse,
    raum: location && room ? room.name : null,
    contact_person: job.contact_person,
    contact_phone: job.contact_phone,
    contact_email: job.contact_email,
    // Ohne meId (Profil nicht geladen) gibt es kein «mein» — sonst wuerden
    // unzugeteilte Termine (assigned_to null) als eigene erscheinen.
    termine: [...appointments]
      .sort((x, y) => x.start_time.localeCompare(y.start_time))
      .map((a) => ({
        id: a.id,
        start_time: a.start_time,
        end_time: a.end_time,
        zeit_modus: a.zeit_modus,
        title: a.title,
        person: a.assigned_to ? (a.assignee?.full_name ?? "Kollege") : null,
        meiner: !!meId && a.assigned_to === meId,
      })),
    rapport: rapport ? { status: rapport.status, updated_at: rapport.updated_at, creator: rapport.creator?.full_name ?? null } : null,
  };
}

/** Cache-Eintrag → vollstaendige Kernfelder. Hat nur rapport-mobil geschrieben
 *  (JobInfo ohne Feld-Felder), fehlen die uebrigen — dann leer anzeigen. */
function ausCache(d: Partial<JobFeldCache> & JobInfo): JobFeldCache {
  return {
    ...d,
    priority: d.priority ?? "",
    start_date: d.start_date ?? null,
    description: d.description ?? null,
    ort: d.ort ?? d.location_name,
    adresse: d.adresse ?? null,
    raum: d.raum ?? null,
    contact_person: d.contact_person ?? null,
    contact_phone: d.contact_phone ?? null,
    contact_email: d.contact_email ?? null,
    termine: d.termine ?? [],
    rapport: d.rapport ?? null,
  };
}

/** «von 07:42» (heute, Zuerich) bzw. «vom Do 09.10. 17:05». */
function standText(iso: string): string {
  const heute = localDateIso(new Date(iso)) === todayLocalIso();
  return heute ? `von ${formatTime(iso)}` : `vom ${formatDate(iso)} ${formatTime(iso)}`;
}

/** «Mo» + «12» fuer die Datumskachel. */
function kachel(iso: string): { wochentag: string; tag: string } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "short", day: "2-digit" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { wochentag: get("weekday").replace(".", ""), tag: get("day") };
}

function datumsBereich(start: string | null, ende: string | null): string | null {
  if (!start) return null;
  const a = formatDate(start);
  if (!ende || ende === start) return a;
  const b = formatDate(ende);
  return a === b ? a : `${a} – ${b}`;
}

export function AuftragFeld({ jobId }: { jobId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const { meId, role, ready: permsReady } = usePermissions();
  const isAdmin = role === "admin";
  const online = useOnline();
  const { active, clockIn, clockOut } = useStempel();
  const { job, appointments, documents, reports, notesText, setNotesSaved, fehler, loadAll } = useAuftragData(jobId, { isAdmin, permsReady });

  // ── Offline-Cache `job:<id>` ──────────────────────────────────────────
  // undefined = noch nicht gelesen, null = kein Eintrag auf diesem Geraet.
  const [cache, setCache] = useState<CacheEintrag<JobFeldCache> | null | undefined>(undefined);
  useEffect(() => {
    if (!meId) return;
    let cancelled = false;
    (async () => {
      const c = await (istIdbVerfuegbar()
        ? cacheLesen<Partial<JobFeldCache> & JobInfo>(meId, `job:${jobId}`).catch(() => null)
        : Promise.resolve(null));
      if (cancelled) return;
      setCache(c ? { ...c, data: ausCache(c.data) } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [meId, jobId]);

  // Frischer Stand → Anzeige und write-through in den Cache (eine Quelle).
  const frisch = useMemo(() => (job ? zuFeldDaten(job, appointments, reports, meId) : null), [job, appointments, reports, meId]);
  useEffect(() => {
    if (!frisch || !meId || !istIdbVerfuegbar()) return;
    void cacheSchreiben(meId, `job:${jobId}`, frisch).catch(() => {});
  }, [frisch, meId, jobId]);

  // Seite ohne Netz geoeffnet (Cache-Stand) → sobald Netz da ist, frisch
  // laden; der Hook selbst laedt nur beim Mount und bei Rapport-Realtime.
  const warOffline = useRef(false);
  useEffect(() => {
    if (!online) {
      warOffline.current = true;
      return;
    }
    if (!warOffline.current || job || !permsReady) return;
    warOffline.current = false;
    void loadAll();
  }, [online, job, permsReady, loadAll]);

  // HTML-Huellen dieser Seite und des Rapports in den SW-Cache (Soft-
  // Navigation legt sie nie ab) — damit beide offline aufgehen.
  useEffect(() => {
    if (online) seitenVorladen([`/auftraege/${jobId}`, `/auftraege/${jobId}/rapport`]);
  }, [jobId, online]);

  // Ladefehler → Toast (wie Heute-Screen); der Hook selbst meldet nichts,
  // weil der Desktop ihn teilt. Ohne Netz sagt es der Offline-Streifen, und
  // derselbe Fehler wird nicht nochmals gemeldet, wenn nur das Netz zurueckkommt.
  const gemeldeterFehler = useRef<string | null>(null);
  useEffect(() => {
    if (!fehler) {
      gemeldeterFehler.current = null;
      return;
    }
    if (!online || gemeldeterFehler.current === fehler) return;
    gemeldeterFehler.current = fehler;
    toast.error(`Auftrag konnte nicht geladen werden: ${fehler}`);
  }, [fehler, online]);

  // «Erneut versuchen» (LadeFehler-Block bzw. Stand-Zeile) — Spinner solange laeuft.
  const [erneutLaedt, setErneutLaedt] = useState(false);
  async function erneutLaden() {
    setErneutLaedt(true);
    await loadAll();
    setErneutLaedt(false);
  }

  // Anzeige: frisch geladen, sonst der Cache-Stand (ohne Netz dauerhaft,
  // online nur bis die frischen Daten da sind — oder dauerhaft, wenn das
  // Laden gescheitert ist).
  const daten = frisch ?? cache?.data ?? null;
  const cacheStand = !frisch && cache ? cache.stand_at : null;

  useBreadcrumbs([
    { label: "Aufträge", href: "/auftraege" },
    { label: formatJobNumber(daten?.job_number) },
  ]);

  const { tiers, defaultId: defaultTierId, loading: tiersLaden } = useLocationRateTiers(daten?.location_id ?? null);
  const [stempelBusy, setStempelBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [kiOffen, setKiOffen] = useState(false);
  const [pdf, setPdf] = useState<{ url: string; title: string } | null>(null);
  const [pdfLaedt, setPdfLaedt] = useState(false);

  // ── Notiz fuers Team: eigener Autosave (800 ms) mit «Gespeichert HH:MM».
  //    `quelle` = Serverstand (notesText), auf dem die Eingabe aufsetzt; ein
  //    anderer notesText (Fremdaenderung via loadAll) gewinnt. Nach dem
  //    Speichern zieht setNotesSaved den Hook-Stand mit (ohne dessen eigenen
  //    Autosave auszuloesen) und die Eingabe setzt auf den neuen Stand auf —
  //    so loescht ein Realtime-loadAll mit demselben Serverstand keine
  //    inzwischen weitergetippten Zeichen.
  const [notiz, setNotiz] = useState<{ text: string; quelle: string } | null>(null);
  const [notizGespeichert, setNotizGespeichert] = useState<string | null>(null);
  const notizText = notiz && notiz.quelle === notesText ? notiz.text : notesText;
  useEffect(() => {
    if (!job || notiz === null || notiz.quelle !== notesText || notiz.text === notesText) return;
    const text = notiz.text;
    const t = setTimeout(async () => {
      const { error } = await supabase.from("jobs").update({ notes: text || null }).eq("id", jobId);
      if (error) {
        TOAST.supabaseError(error, "Notiz konnte nicht gespeichert werden");
        return;
      }
      setNotesSaved(text);
      setNotiz((n) => (n ? { ...n, quelle: text } : n));
      setNotizGespeichert(new Date().toISOString());
    }, 800);
    return () => clearTimeout(t);
  }, [notiz, notesText, job, jobId, supabase, setNotesSaved]);

  // Sekunden-Tick fuer die Dauer, nur solange auf diesen Auftrag gestempelt.
  const aufDiesem = !!active && active.job_id === jobId;
  useEffect(() => {
    if (!aufDiesem) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [aufDiesem]);

  if (!daten) {
    // Cache noch nicht gelesen (ohne meId gibt es keinen Schluessel, also
    // auch keinen Eintrag) → der Hook bzw. der Cache laedt noch.
    const cacheGeprueft = cache !== undefined || (permsReady && !meId);
    if (!cacheGeprueft) return <FeldSkeleton />;
    // Ohne Netz und ohne Eintrag gibt es nichts zu zeigen.
    if (!online) {
      return (
        <div className="page-enter">
          <EmptyState
            icon={CloudOff}
            title="Kein Netz"
            description="Dieser Auftrag wurde auf diesem Gerät noch nicht geöffnet. Sobald du wieder online bist, wird er geladen."
          />
        </div>
      );
    }
    // Netz laut Browser da, Laden gescheitert → Fehlerblock statt Dauer-Skeleton.
    if (fehler) {
      return (
        <div className="page-enter">
          <LadeFehler titel="Auftrag konnte nicht geladen werden" fehler={fehler} onRetry={erneutLaden} laedt={erneutLaedt} />
        </div>
      );
    }
    return <FeldSkeleton />;
  }

  // ── Ableitungen ───────────────────────────────────────────────────────
  const nummer = formatJobNumber(daten.job_number);
  const routeZiel = daten.adresse ?? daten.ort;
  const routeUrl = routeZiel ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(routeZiel)}` : null;
  const telefon = daten.contact_phone?.replace(/\s+/g, "") || null;
  const rapport = daten.rapport;
  const abgeschlossen = daten.status === "abgeschlossen";
  const statusInfo = (JOB_STATUS as Record<string, { label: string; color: string } | undefined>)[daten.status];
  const statusLabel = statusInfo?.label ?? daten.status;
  const statusFarbe = statusInfo?.color ?? "";
  const rapportZeile = rapport
    ? rapport.status === "abgeschlossen"
      ? `Abgeschlossen am ${formatDate(rapport.updated_at)}`
      : `Entwurf vom ${formatDate(rapport.updated_at)} ${formatTime(rapport.updated_at)}${rapport.creator ? ` · ${rapport.creator}` : ""}`
    : "Noch nicht begonnen";

  // ── Aktionen ──────────────────────────────────────────────────────────
  async function einstempeln() {
    if (tiersLaden || tiers.length > 1) {
      oeffneStempelSheet();
      return;
    }
    setStempelBusy(true);
    const res = await clockIn({ jobId, rateTierId: defaultTierId ?? null });
    setStempelBusy(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    toast.success(res.wartet ? "Eingestempelt — wird gesendet, sobald Netz da ist" : `Eingestempelt auf ${nummer}`);
  }

  async function ausstempeln() {
    setStempelBusy(true);
    const res = await clockOut();
    setStempelBusy(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Ausstempeln fehlgeschlagen");
      return;
    }
    toast.success(res.wartet ? "Ausgestempelt — wird gesendet, sobald Netz da ist" : "Ausgestempelt");
  }

  async function dokumentOeffnen(storagePath: string, name: string) {
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) {
      toast.error("Datei nicht verfügbar");
      return;
    }
    setPdf({ url: data.signedUrl, title: name });
  }

  async function rapportPdf() {
    if (!job) {
      // Cache-Stand: die Rapport-Zeile ist bekannt, das PDF braucht Netz.
      toast.error(online ? "Rapport wird noch geladen" : "Rapport-PDF braucht Netz");
      return;
    }
    const fertig = reports.find((r) => r.status === "abgeschlossen") ?? reports[0] ?? null;
    if (!fertig) {
      toast.error("Kein Rapport vorhanden");
      return;
    }
    setPdfLaedt(true);
    try {
      const titel = `Einsatzrapport ${nummer}.pdf`;
      if (fertig.pdf_url) {
        const { data } = await supabase.storage.from("documents").createSignedUrl(fertig.pdf_url, 3600);
        if (data?.signedUrl) {
          setPdf({ url: data.signedUrl, title: titel });
          return;
        }
      }
      setPdf({ url: `/api/reports/${fertig.id}/pdf`, title: titel });
    } finally {
      setPdfLaedt(false);
    }
  }

  // ── Primaerknopf (Zustandsmaschine) ───────────────────────────────────
  let primaer: React.ReactNode = null;
  let grund: string | null = null;
  if (abgeschlossen) {
    primaer = (
      <button type="button" onClick={rapportPdf} disabled={pdfLaedt} className="kasten kasten-muted h-[42px] w-full justify-center text-[15px]">
        {pdfLaedt ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />} Rapport-PDF
      </button>
    );
  } else if (daten.status === "offen") {
    if (aufDiesem && active) {
      primaer = (
        <StempelKnopf busy={stempelBusy} onClick={ausstempeln} icon={<Square className="h-4 w-4" fill="currentColor" />}>
          {stempelBusy ? "Wird ausgestempelt…" : `Ausstempeln · ${formatStempelDuration(active.clock_in, now)}`}
        </StempelKnopf>
      );
    } else {
      const anderswo = !!active;
      primaer = (
        <StempelKnopf busy={stempelBusy} disabled={anderswo} onClick={einstempeln} icon={<Play className="h-4 w-4" fill="currentColor" />}>
          {stempelBusy ? "Wird eingestempelt…" : "Auf Auftrag einstempeln"}
        </StempelKnopf>
      );
      if (anderswo && active) grund = `Zuerst ausstempeln — du bist seit ${formatTime(active.clock_in)} anderswo eingestempelt`;
    }
  }

  return (
    <div className="page-enter flex flex-col gap-5">
      {/* Titel */}
      <header className="flex flex-col gap-1.5">
        <h1 className="line-clamp-2 text-[22px] font-bold leading-7 tracking-tight">{daten.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
          {daten.customer_name && <span className="min-w-0 truncate">{daten.customer_name}</span>}
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold ring-1 ring-inset ring-foreground/10 ${statusFarbe}`}>{statusLabel}</span>
          {daten.priority === "dringend" && (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-[12px] font-semibold text-red-700 dark:bg-red-500/20 dark:text-red-300">Dringend</span>
          )}
        </div>
        {cacheStand && (fehler && online ? (
          // Laden gescheitert: Cache-Stand bleibt, die Zeile ist die Tastflaeche
          // zum Neuladen (34 px; Spinner solange laeuft).
          <button
            type="button"
            onClick={erneutLaden}
            disabled={erneutLaedt}
            className="-my-1.5 flex min-h-[34px] items-center gap-1.5 text-left text-[13px] text-muted-foreground disabled:opacity-60"
          >
            {erneutLaedt ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
            Stand {standText(cacheStand)} · {erneutLaedt ? "wird geladen…" : "nicht aktualisiert — erneut versuchen"}
          </button>
        ) : (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {online ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <CloudOff className="h-3.5 w-3.5 shrink-0" />}
            Stand {standText(cacheStand)} · {online ? "wird aktualisiert…" : "offline"}
          </p>
        ))}
      </header>

      {/* Termine — alle, mit Person */}
      {daten.termine.length > 0 && (
        <Abschnitt titel="Termine">
          {daten.termine.map((a) => <EinsatzZeile key={a.id} a={a} />)}
        </Abschnitt>
      )}

      {/* Knoepfe */}
      {(primaer || routeUrl || telefon) && (
        <section className="flex flex-col gap-2">
          {primaer}
          {grund && <p className="px-1 text-[13px] text-muted-foreground">{grund}</p>}
          {(routeUrl || telefon) && (
            <div className="flex gap-2">
              {routeUrl && (
                <a href={routeUrl} target="_blank" rel="noopener noreferrer" className="kasten kasten-muted h-[36px] flex-1 justify-center text-[13px]">
                  <Navigation className="h-4 w-4" /> Route
                </a>
              )}
              {telefon && (
                <a href={`tel:${telefon}`} className="kasten kasten-muted h-[36px] flex-1 justify-center text-[13px]">
                  <Phone className="h-4 w-4" /> Anrufen
                </a>
              )}
            </div>
          )}
        </section>
      )}

      {/* Rapport */}
      {daten.status !== "storniert" && (
        <Link
          href={`/auftraege/${jobId}/rapport`}
          className="flex min-h-[48px] items-center gap-3 rounded-xl border border-border bg-card px-4 py-2 active:bg-foreground/10"
        >
          <FileText className={`h-5 w-5 shrink-0 ${rapport?.status === "abgeschlossen" ? "text-green-700 dark:text-green-300" : rapport ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`} />
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold leading-6">Rapport</p>
            <p className="truncate text-[13px] leading-5 text-muted-foreground">{rapportZeile}</p>
          </div>
          <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
        </Link>
      )}

      {/* Wo & wann */}
      <Abschnitt titel="Wo & wann">
        {daten.ort || daten.adresse ? (
          <Zeile icon={<MapPin className="h-5 w-5 text-muted-foreground" />}>
            {daten.ort && <p className="text-[14px] leading-6">{daten.ort}</p>}
            {daten.adresse && <p className="text-[12px] leading-5 text-muted-foreground">{daten.adresse}</p>}
          </Zeile>
        ) : (
          <Zeile icon={<MapPin className="h-5 w-5 text-muted-foreground" />}>
            <p className="text-[14px] leading-6 text-muted-foreground">Kein Ort hinterlegt</p>
          </Zeile>
        )}
        {daten.raum && (
          <Zeile>
            <p className={LABEL}>Raum</p>
            <p className="text-[14px] leading-6">{daten.raum}</p>
          </Zeile>
        )}
        {datumsBereich(daten.start_date, daten.end_date) && (
          <Zeile>
            <p className={LABEL}>Zeitraum</p>
            <p className="text-[14px] leading-6 tabular-nums">{datumsBereich(daten.start_date, daten.end_date)}</p>
          </Zeile>
        )}
        {daten.description && (
          <Zeile>
            <p className="whitespace-pre-wrap text-[13px] leading-6">{daten.description}</p>
          </Zeile>
        )}
      </Abschnitt>

      {/* Ansprechperson */}
      {(daten.contact_person || telefon || daten.contact_email) && (
        <Abschnitt titel="Ansprechperson">
          {daten.contact_person && (
            <Zeile>
              <p className="text-[14px] leading-6">{daten.contact_person}</p>
              <p className="text-[13px] leading-5 text-muted-foreground">Veranstalter-Kontakt</p>
            </Zeile>
          )}
          {telefon && (
            <a href={`tel:${telefon}`} className="flex h-[36px] items-center gap-3 border-t border-border px-4 active:bg-foreground/10">
              <Phone className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[14px] tabular-nums">{daten.contact_phone}</span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            </a>
          )}
          {daten.contact_email && (
            <a href={`mailto:${daten.contact_email}`} className="flex h-[36px] items-center gap-3 border-t border-border px-4 active:bg-foreground/10">
              <Mail className="h-5 w-5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[14px]">{daten.contact_email}</span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            </a>
          )}
        </Abschnitt>
      )}

      {/* KI-Zusammenfassung (nur lesen, eingeklappt) — nur mit frischem Stand */}
      {job?.ai_summary && (
        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setKiOffen((o) => !o)}
            aria-expanded={kiOffen}
            className="flex h-[36px] w-full items-center justify-between px-4 text-left active:bg-foreground/10"
          >
            <span className="text-[14px] font-medium">Zusammenfassung</span>
            <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${kiOffen ? "rotate-180" : ""}`} />
          </button>
          {kiOffen && (
            <div className="border-t border-border p-2">
              <KiZusammenfassung jobId={jobId} canEdit={false} summary={job.ai_summary} />
            </div>
          )}
        </section>
      )}

      {/* Notiz fuers Team — nur mit frischem Stand (Autosave braucht Netz) */}
      {job && (
        <section className="flex flex-col gap-2">
          <div className="flex min-h-[28px] items-center justify-between px-1">
            <label htmlFor="feld-notiz" className={LABEL}>Notiz fürs Team</label>
            {notizGespeichert && <span className="text-[13px] text-muted-foreground">Gespeichert {formatTime(notizGespeichert)}</span>}
          </div>
          <textarea
            id="feld-notiz"
            value={notizText}
            onChange={(e) => setNotiz({ text: e.target.value, quelle: notesText })}
            placeholder="Reinschreiben — wird automatisch gespeichert."
            rows={3}
            className="w-full rounded-xl border border-border bg-background px-4 py-[7px] text-[16px] leading-6 focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </section>
      )}

      {/* Dokumente — nur mit frischem Stand (Vorschau braucht Netz) */}
      {job && documents.length > 0 && (
        <Abschnitt titel="Dokumente">
          {documents.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => dokumentOeffnen(d.storage_path, d.name)}
              className="flex min-h-[42px] w-full items-center gap-3 border-t border-border px-4 py-2 text-left first:border-t-0 active:bg-foreground/10"
            >
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] leading-6">{d.name}</p>
                <p className="text-[13px] leading-5 text-muted-foreground">{formatDate(d.created_at)}</p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            </button>
          ))}
        </Abschnitt>
      )}

      {pdf && <PdfPopup url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function Abschnitt({ titel, children }: { titel: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex min-h-[28px] items-center px-1">
        <h2 className={LABEL}>{titel}</h2>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

function Zeile({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[36px] items-center gap-3 border-t border-border px-4 py-2.5 first:border-t-0">
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Termin: Datumskachel 40 px + Datum/Zeit + Person (eigene = «Du»). */
function EinsatzZeile({ a }: { a: FeldTermin }) {
  const person = a.meiner ? "Du" : (a.person ?? "Nicht zugeteilt");
  const k = kachel(a.start_time);
  const deadline = a.zeit_modus === "deadline";
  const zeit = deadline
    ? `bis ${formatTime(a.start_time)}`
    : a.end_time
      ? `${formatTime(a.start_time)} – ${formatTime(a.end_time)}`
      : formatTime(a.start_time);
  return (
    <div className="flex min-h-[42px] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0">
      <div className="flex h-[40px] w-[40px] shrink-0 flex-col items-center justify-center rounded-xl bg-muted/60 tabular-nums">
        <span className="text-[12px] font-bold uppercase leading-4 text-muted-foreground">{k.wochentag}</span>
        <span className="text-[17px] font-bold leading-6">{k.tag}</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold leading-6">{formatDate(a.start_time)} · {zeit}</p>
        <p className="truncate text-[12px] leading-5 text-muted-foreground">
          <span className={a.meiner ? "font-semibold text-foreground" : undefined}>{person}</span>
          {a.title && ` · ${a.title}`}
        </p>
      </div>
    </div>
  );
}

/** Primaerknopf Stempeln — teal, 42 px, Spinner solange laeuft (wie Heute-Screen). */
function StempelKnopf({ busy, disabled, onClick, icon, children }: {
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="flex h-[42px] w-full items-center justify-center gap-2 rounded-xl text-[15px] font-bold tabular-nums text-teal-700 disabled:opacity-60 dark:text-teal-300"
      style={{ border: "2px solid var(--stempel-color, #14b8a6)", backgroundColor: "rgba(20,184,166,0.16)" }}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

function FeldSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-4/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <Skeleton className="h-[56px] rounded-xl" />
      <Skeleton className="h-[42px] rounded-xl" />
      <div className="grid grid-cols-2 gap-2">
        <Skeleton className="h-[36px] rounded-xl" />
        <Skeleton className="h-[36px] rounded-xl" />
      </div>
      <Skeleton className="h-[48px] rounded-xl" />
      <Skeleton className="h-[80px] rounded-xl" />
    </div>
  );
}
