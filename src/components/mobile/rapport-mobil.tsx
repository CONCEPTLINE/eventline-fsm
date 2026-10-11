"use client";

/**
 * Rapport am Handy (/auftraege/[id]/rapport) — eigene Seite statt Modal
 * (Konzept §3 Rapport). Jede Eingabe landet sofort in IndexedDB
 * (rapport_drafts, write-ahead), Fotos/Unterschriften als Blobs; der Sync
 * zum Server laeuft ueber src/lib/offline/rapport-outbox.ts (debounced
 * 1.5 s, Trigger online/sichtbar/Realtime, Backoff bei Netzfehler).
 *
 * Aufbau: Status-Zeile · Zeiten (Zeilen 72 px, Tipp → Sheet) · Was wurde
 * gemacht · Material & Probleme (eingeklappt) · Fotos (3 × 110, Loeschen
 * immer sichtbar, Upload-Ring) · Unterschriften · sticky Aktionsleiste
 * («Speichern» / «Auftrag abschliessen» bzw. offline «Abschluss vormerken»).
 *
 * meId/meName aus usePermissions() («Ansicht als»). Zeiten Europe/Zurich.
 * Rechte: Server-Stand gilt — RLS-Faelle (fremder Entwurf ohne Migration 306)
 * erscheinen als Status «fehler», nie still. Unter «Ansicht als» nur lesen:
 * keine Eingabe, kein Abgleich in IndexedDB, kein Sync, kein Abschluss.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  CloudOff,
  Eye,
  FileText,
  Image as ImageIcon,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { readImpersonationCookie } from "@/lib/impersonation";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import { useOnline, registriereSyncTrigger } from "@/lib/offline/sync-trigger";
import { seiteVorladen } from "@/lib/offline/sw-vorladen";
import { istNetzfehler } from "@/lib/offline/stempel-outbox";
import {
  cacheLesen,
  cacheSchreiben,
  istIdbVerfuegbar,
  ladeBlobs,
  ladeRapportDraft,
  loescheBlob,
  loescheRapportDraft,
  speichereRapportDraft,
  type RapportBlob,
  type RapportDraft,
  type RapportDraftForm,
  type RapportDraftTimeRange,
} from "@/lib/offline/db";
import {
  MAX_FOTOS,
  RAPPORT_OUTBOX_EVENT,
  SPEICHER_TOAST_ID,
  abgebrochenesSendenLoesen,
  abschlussNachholen,
  abschlussVormerken,
  bereiteFotoVor,
  dataUrlZuBlob,
  erneutVersuchen,
  fehlendePflichtfelder,
  konfliktMeineSenden,
  konfliktServerUebernehmen,
  ladeServerRapport,
  leeresFormular,
  loescheServerFoto,
  meineUnterschriftenAblegen,
  meldeRapportAenderung,
  mitRapportSperre,
  neuerDraft,
  rapportFortschritt,
  sendeAlsNachtrag,
  serverZuForm,
  speichereBlobSicher,
  speichereEingabe,
  syncRapport,
  zusammenfuehren,
  zusammengefuehrtMit,
  type ServerRapport,
} from "@/lib/offline/rapport-outbox";
import { berechneZeitVorschlaege } from "@/components/auftrag/rapport-form-modal";
import { SearchableSelect } from "@/components/searchable-select";
import { SignaturePad } from "@/components/signature-pad";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { PdfPopup } from "@/components/pdf-popup";
import { LadeFehler } from "@/components/mobile/lade-fehler";
import { useLocationRateTiers, iconForTier, colorForTier } from "@/components/stempel/rate-tier-chooser";
import { formatDate, formatTime } from "@/lib/format";
import { localDateIso, todayLocalIso } from "@/lib/swiss-time";
import { formatJobNumber } from "@/lib/nummern-format";

// ---------------------------------------------------------------------------
// Typen + Konstanten
// ---------------------------------------------------------------------------

/** Auftrags-Kern fuer den Rapport — zugleich der Offline-Eintrag `job:<id>`
 *  (IndexedDB cache, je meId), den sich diese Seite mit der Feldansicht
 *  teilt: auftrag-feld legt dort zusaetzliche Felder ab (JobFeldCache), beim
 *  Schreiben hier bleiben die erhalten. */
export interface JobInfo {
  id: string;
  job_number: number | null;
  title: string;
  end_date: string | null;
  status: string;
  location_id: string | null;
  customer_name: string | null;
  location_name: string | null;
}

interface ProfilOption {
  id: string;
  full_name: string;
}

interface ServerFoto {
  id: string;
  storage_path: string;
  url: string;
}

const PAUSE_PRESETS = [0, 15, 30, 45, 60];
const FELD = "h-12 w-full rounded-xl border border-border bg-background px-4 text-[16px] focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60";
const LABEL = "text-[12px] font-bold uppercase tracking-wider text-muted-foreground";
const SELECT_WRAP = "[&_input]:h-12 [&_input]:rounded-xl [&_input]:text-[16px] [&_input]:pl-4";
const ANSICHT_ALS_GESPERRT = "Rapport bearbeiten ist in «Ansicht als» nicht möglich";

/** Lie-Fi (Netz-Symbol, aber keine Antwort): Laden nach 10 s abbrechen — der
 *  Abbruch kommt als Netzfehler (status 0) und faellt auf den Geraete-Stand. */
const LADE_TIMEOUT_MS = 10_000;
function ladeSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(LADE_TIMEOUT_MS)
    : undefined;
}

/** Laufende Aktion — je Knopf eigen, damit der Spinner am getippten Knopf erscheint. */
type Aktion = "speichern" | "abschliessen" | "nachtrag" | "konflikt-server" | "konflikt-meine" | "retry" | "pdf";

type JobRow = {
  id: string; job_number: number | null; title: string; end_date: string | null; status: string; location_id: string | null;
  customer: { name: string } | { name: string }[] | null;
  location: { name: string; customer: { name: string } | { name: string }[] | null } | { name: string; customer: { name: string } | { name: string }[] | null }[] | null;
};

function eins<T>(v: T | T[] | null | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

/** Eigen-verwaltete Standorte: dort ist «Mieter vor Ort» Default (wie Desktop). */
function istEigenerStandort(locationName: string | null): boolean {
  const n = (locationName ?? "").toLowerCase();
  return ["scala", "bau3", "barakuba"].some((v) => n.includes(v));
}

function trMinuten(t: RapportDraftTimeRange): number {
  if (!t.start || !t.end) return 0;
  const [sh, sm] = t.start.split(":").map(Number);
  const [eh, em] = t.end.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return 0;
  let m = eh * 60 + em - (sh * 60 + sm);
  if (m < 0) m += 1440;
  m -= t.pause || 0;
  return m > 0 ? m : 0;
}

function dauerText(min: number): string {
  if (min <= 0) return "–";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/** «Mo 12.10.» aus YYYY-MM-DD (Mittag UTC = DST-sicher). */
function tagLabel(date: string): string {
  if (!date) return "Datum fehlt";
  const d = new Date(date + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  return formatDate(d.toISOString());
}

function hatZeit(t: RapportDraftTimeRange): boolean {
  return !!(t.date || t.start || t.end || t.technician_id);
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

export function RapportMobil({ jobId }: { jobId: string }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const online = useOnline();
  const { meId, profile, ready } = usePermissions();
  const meName = profile?.full_name ?? "Ich";
  const { confirm, ConfirmModalElement } = useConfirm();
  // «Ansicht als» (Admin sieht die App als Mitarbeiter): nur lesen. Die Seite
  // rendert nur im Browser (useIsMobile), das Cookie ist also lesbar.
  const [ansichtAls] = useState(() => !!readImpersonationCookie());

  const [job, setJob] = useState<JobInfo | null>(null);
  const [personenListe, setProfiles] = useState<ProfilOption[]>([]);
  const [draft, setDraft] = useState<RapportDraft | null>(null);
  const [form, setForm] = useState<RapportDraftForm | null>(null);
  const [server, setServer] = useState<ServerRapport | null>(null);
  const [serverFotos, setServerFotos] = useState<ServerFoto[]>([]);
  const [blobs, setBlobs] = useState<RapportBlob[]>([]);
  const [sigUrls, setSigUrls] = useState<{ tech: string | null; client: string | null }>({ tech: null, client: null });
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);
  const [geladen, setGeladen] = useState(false);
  const [ladeVersuch, setLadeVersuch] = useState(0);
  const [materialOffen, setMaterialOffen] = useState(false);
  const [zeileIdx, setZeileIdx] = useState<number | null>(null);
  const [fotoBusy, setFotoBusy] = useState(0);
  const [aktion, setAktion] = useState<Aktion | null>(null);
  const [pdf, setPdf] = useState<{ url: string; title: string } | null>(null);
  const [fortschritt, setFortschritt] = useState(() => rapportFortschritt(jobId));
  // In dieser Sitzung unterschriebene Pads bleiben Canvas (kein Sprung in die
  // Vorschau nach dem ersten Strich) — die Vorschau gilt erst nach Neuladen.
  const [sitzungSigniert, setSitzungSigniert] = useState<{ tech: boolean; client: boolean }>({ tech: false, client: false });

  const draftRef = useRef<RapportDraft | null>(null);
  const formRef = useRef<RapportDraftForm | null>(null);
  // Letzte Eingabe nicht auf dem Geraet gelandet (kein IndexedDB, Quota) —
  // «Speichern» versucht es dann nochmals, statt Erfolg zu melden.
  const ungesichert = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Zaehlt RAPPORT_OUTBOX_EVENTs dieses Auftrags — der nur lesende Abgleich
  // beim Laden erkennt daran, dass der Sync inzwischen geschrieben hat.
  const outboxStand = useRef(0);
  const kameraRef = useRef<HTMLInputElement>(null);
  const galerieRef = useRef<HTMLInputElement>(null);
  const blobUrls = useRef<Map<string, string>>(new Map());

  const { tiers, defaultId: defaultTierId } = useLocationRateTiers(job?.location_id ?? null);

  useBreadcrumbs([
    { label: "Aufträge", href: "/auftraege" },
    { label: formatJobNumber(job?.job_number), href: `/auftraege/${jobId}` },
    { label: "Rapport" },
  ]);

  // HTML-Huelle dieser Seite in den SW-Cache (Soft-Navigation legt sie nie
  // ab) — damit der Rapport offline auch nach App-Neustart aufgeht.
  useEffect(() => {
    if (online) seiteVorladen(`/auftraege/${jobId}/rapport`);
  }, [jobId, online]);

  // Blob-Vorschau-URLs je local_id (einmal erzeugen, beim Unmount freigeben).
  const blobUrl = useCallback((b: RapportBlob): string => {
    let u = blobUrls.current.get(b.local_id);
    if (!u) {
      u = URL.createObjectURL(b.blob);
      blobUrls.current.set(b.local_id, u);
    }
    return u;
  }, []);
  useEffect(() => {
    const map = blobUrls.current;
    return () => {
      for (const u of map.values()) URL.revokeObjectURL(u);
      map.clear();
    };
  }, []);

  // ── Helfer ────────────────────────────────────────────────────────────
  const setzeDraft = useCallback((d: RapportDraft | null) => {
    draftRef.current = d;
    setDraft(d);
  }, []);
  const setzeForm = useCallback((f: RapportDraftForm | null) => {
    formRef.current = f;
    setForm(f);
  }, []);

  const ladeServerFotos = useCallback(async (reportId: string) => {
    const { data } = await supabase
      .from("report_photos")
      .select("id, storage_path, sort_order")
      .eq("report_id", reportId)
      .order("sort_order");
    if (!data) return;
    const mitUrls = await Promise.all(
      (data as { id: string; storage_path: string }[]).map(async (p) => {
        const { data: s } = await supabase.storage.from("documents").createSignedUrl(p.storage_path, 3600);
        return { id: p.id, storage_path: p.storage_path, url: s?.signedUrl ?? "" };
      }),
    );
    setServerFotos(mitUrls);
  }, [supabase]);

  const ladeSigUrls = useCallback(async (f: RapportDraftForm) => {
    const hol = async (p: string | null) => {
      if (!p) return null;
      const { data } = await supabase.storage.from("documents").createSignedUrl(p, 3600);
      return data?.signedUrl ?? null;
    };
    const [tech, client] = await Promise.all([hol(f.technician_signature_url), hol(f.signature_url)]);
    setSigUrls({ tech, client });
  }, [supabase]);

  const ladeBlobsNeu = useCallback(async (reportId: string | null) => {
    if (!reportId || !istIdbVerfuegbar()) {
      setBlobs([]);
      return [] as RapportBlob[];
    }
    try {
      const b = await ladeBlobs(reportId);
      setBlobs(b);
      return b;
    } catch {
      return [] as RapportBlob[];
    }
  }, []);

  /** «Ansicht als» liest nur — jede Aenderung bricht mit Toast ab. */
  const gesperrt = useCallback((): boolean => {
    if (!ansichtAls) return false;
    toast.error(ANSICHT_ALS_GESPERRT, { id: "rapport-ansicht-als" });
    return true;
  }, [ansichtAls]);

  const syncJetzt = useCallback(() => {
    if (!meId || ansichtAls) return;
    if (syncTimer.current) {
      clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }
    void syncRapport(supabase, meId, meName, jobId);
  }, [supabase, meId, meName, jobId, ansichtAls]);

  const planeSync = useCallback(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncTimer.current = null;
      syncJetzt();
    }, 1500);
  }, [syncJetzt]);

  // ── Laden ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !meId) return;
    let cancelled = false;
    (async () => {
      try {
        const idb = istIdbVerfuegbar();
        // «Ansicht als» liest nur: kein Abgleich in IndexedDB, kein Sync.
        const schreiben = idb && !ansichtAls;

        // Auftrag + Personen: online frisch (und cachen), sonst aus dem Cache.
        // Lie-Fi (Netz-Symbol, aber keine Antwort) zaehlt wie offline: ein
        // Netzfehler oder der Abbruch nach LADE_TIMEOUT_MS faellt auf den
        // Geraete-Stand zurueck, den Rest holt der Sync nach. Nur echte
        // Server-Fehler landen im Ladefehler.
        let netz = online;
        let jobInfo: JobInfo | null = null;
        let personen: ProfilOption[] | null = null;
        if (netz) {
          const signal = ladeSignal();
          let jq = supabase
            .from("jobs")
            .select("id, job_number, title, end_date, status, location_id, customer:customers(name), location:locations(name, customer:customers(name))")
            .eq("id", jobId);
          let pq = supabase.rpc("get_assignable_users");
          if (signal) {
            jq = jq.abortSignal(signal);
            pq = pq.abortSignal(signal);
          }
          const [{ data: j, error: jErr, status: jStatus }, { data: p, error: pErr }] = await Promise.all([jq.maybeSingle(), pq]);
          if (jErr && istNetzfehler(jErr, jStatus)) {
            netz = false;
          } else if (jErr) {
            throw new Error(jErr.message);
          } else {
            if (j) {
              const row = j as unknown as JobRow;
              const loc = eins(row.location);
              jobInfo = {
                id: row.id,
                job_number: row.job_number,
                title: row.title,
                end_date: row.end_date,
                status: row.status,
                location_id: row.location_id,
                customer_name: eins(row.customer)?.name ?? eins(loc?.customer)?.name ?? null,
                location_name: loc?.name ?? null,
              };
            }
            if (!pErr) personen = ((p as { id: string; full_name: string }[] | null) ?? []).map((x) => ({ id: x.id, full_name: x.full_name }));
            if (idb) {
              if (jobInfo) {
                // Denselben Eintrag nutzt die Feldansicht mit mehr Feldern —
                // nur die eigenen ueberschreiben, die uebrigen behalten.
                const ji = jobInfo;
                void cacheLesen<JobInfo>(meId, `job:${jobId}`)
                  .catch(() => null)
                  .then((alt) => cacheSchreiben(meId, `job:${jobId}`, { ...alt?.data, ...ji }))
                  .catch(() => {});
              }
              if (personen?.length) void cacheSchreiben(meId, "assignable_users", personen).catch(() => {});
            }
          }
        }
        if (!netz && idb) {
          const cj = await cacheLesen<JobInfo>(meId, `job:${jobId}`).catch(() => null);
          jobInfo = cj?.data ?? null;
        }
        if (!personen) {
          const cp = idb ? await cacheLesen<ProfilOption[]>(meId, "assignable_users").catch(() => null) : null;
          personen = cp?.data ?? [];
        }
        if (cancelled) return;
        setJob(jobInfo);
        setProfiles(personen);

        const ich = personen.find((x) => x.id === meId);
        const eigener = istEigenerStandort(jobInfo?.location_name ?? null);
        const basis = leeresFormular({
          technician_id: meId,
          technician_name: ich?.full_name ?? meName,
          client_name: eigener ? "" : (jobInfo?.customer_name ?? ""),
          signer_type: eigener ? "mieter" : "kunde",
        });
        const fallbackTechniker = async () => meId;
        const vorschlaege = async (f: RapportDraftForm): Promise<RapportDraftForm> => {
          if (f.time_ranges.some(hatZeit)) return f;
          if (!netz) return { ...f, time_ranges: [{ date: todayLocalIso(), start: "", end: "", pause: 0, technician_id: meId }] };
          const r = await berechneZeitVorschlaege(supabase, jobId, fallbackTechniker);
          return { ...f, time_ranges: r };
        };

        // Server-Stand des Auftrags; Netzfehler (Lie-Fi) → Geraete-Stand.
        const holeServer = async (): Promise<ServerRapport | null> => {
          if (!netz) return null;
          const { row, error, status } = await ladeServerRapport(supabase, jobId, ladeSignal());
          if (error && istNetzfehler(error, status)) {
            netz = false;
            return null;
          }
          if (error) throw new Error(error.message);
          return row;
        };

        // Abgleich Geraet ↔ Server unter der Sperre des Auftrags (wie der
        // Sync): Entwurf lesen, Server-Stand holen, zurueckschreiben.
        const abgleich = async () => {
          let lokal: RapportDraft | null = idb ? await ladeRapportDraft(jobId, meId).catch(() => null) : null;
          if (lokal?.status === "sendet" && rapportFortschritt(jobId) === null) {
            const korrigiert = schreiben ? await abgebrochenesSendenLoesen(jobId, meId).catch(() => null) : null;
            lokal = korrigiert ?? { ...lokal, status: "lokal" };
          }
          let lokaleBlobs: RapportBlob[] = lokal && idb ? await ladeBlobs(lokal.report_id).catch(() => []) : [];

          const serverRow = await holeServer();
          if (cancelled) return null;

          let f: RapportDraftForm;
          if (serverRow?.status === "abgeschlossen") {
            setServer(serverRow);
            if (lokal && lokal.status !== "abgeschlossen" && lokal.status !== "bereits_abgeschlossen") {
              if (lokal.dirty || lokaleBlobs.length > 0) {
                // Eigene, ungesendete Eingaben → Nachtrag. Alte Fehler/Konflikte
                // betreffen den Entwurf nicht mehr.
                lokal = { ...lokal, status: "bereits_abgeschlossen", last_error: null, server_form: null };
                if (schreiben) await speichereRapportDraft(lokal);
              } else {
                if (schreiben) await loescheRapportDraft(jobId, meId, lokal.report_id);
                lokal = null;
                lokaleBlobs = [];
              }
            }
            // Nachtrag: die eigenen Eingaben zeigen (das geht ans Buero), sonst den Server-Stand.
            f = lokal?.status === "bereits_abgeschlossen" ? lokal.form : serverZuForm(serverRow, basis);
            void ladeServerFotos(serverRow.id);
          } else if (serverRow) {
            // Server-Entwurf vorhanden.
            if (!lokal) {
              // Eigene report_id (Client-UUID), nicht die Server-ID: so bleiben
              // die Blobs zweier Nutzer am selben Geraet getrennt.
              lokal = {
                ...neuerDraft(jobId, meId, serverZuForm(serverRow, basis)),
                server_id: serverRow.id,
                base_updated_at: serverRow.updated_at,
                status: "gesendet",
              };
              lokal.form = await vorschlaege(lokal.form);
              if (lokal.form.time_ranges.some((t) => t.quelle)) lokal.dirty = true;
              if (schreiben) await speichereRapportDraft(lokal).catch(() => {});
            } else if (lokal.server_id === serverRow.id) {
              if (lokal.status !== "konflikt" && lokal.status !== "fehler") {
                if (!lokal.dirty) {
                  lokal = { ...lokal, form: serverZuForm(serverRow, lokal.form), base_updated_at: serverRow.updated_at, status: "gesendet" };
                } else if (serverRow.updated_at !== lokal.base_updated_at) {
                  // Beide Seiten geaendert: Konflikt wie im Sync (Schritt 4) —
                  // der Nutzer waehlt, nichts wird still ueberschrieben.
                  lokal = {
                    ...lokal,
                    status: "konflikt",
                    server_form: serverZuForm(serverRow, lokal.form),
                    base_updated_at: serverRow.updated_at,
                    last_error: null,
                  };
                }
                if (schreiben) await speichereRapportDraft(lokal).catch(() => {});
              }
            } else if (!lokal.server_id && serverRow.id === lokal.report_id) {
              // Eigener Insert kam an, die Antwort ging verloren (wie im Sync):
              // Server-Zeile uebernehmen, der Entwurf bleibt massgebend.
              lokal = { ...lokal, server_id: serverRow.id, base_updated_at: serverRow.updated_at };
              if (schreiben) await speichereRapportDraft(lokal).catch(() => {});
            } else if (lokal.status !== "konflikt" && lokal.status !== "fehler") {
              // Offline angelegt (oder Server-Zeile gewechselt): der Entwurf
              // beruht nicht auf diesem Server-Entwurf → zusammenfuehren, auch
              // wenn der von mir ist (Computer, anderes Geraet) — sonst gingen
              // dessen Text und Zeiten still verloren.
              lokal = {
                ...lokal,
                form: zusammenfuehren(serverRow, lokal.form, meId, meName),
                server_id: serverRow.id,
                base_updated_at: serverRow.updated_at,
                dirty: true,
                merged_with: zusammengefuehrtMit(serverRow, meId),
                status: "lokal",
                local_updated_at: new Date().toISOString(),
              };
              if (schreiben) {
                // Gleiche Regel wie im Sync: hat der Server-Entwurf schon
                // Unterschriften, werden meine abgelegt statt sie zu ersetzen.
                const reportId = lokal.report_id;
                await meineUnterschriftenAblegen(reportId, serverRow).catch(() => {});
                lokaleBlobs = await ladeBlobs(reportId).catch(() => lokaleBlobs);
                await speichereRapportDraft(lokal).catch(() => {});
              }
            }
            f = lokal.form;
            void ladeServerFotos(serverRow.id);
          } else if (netz && lokal?.server_id && lokal.status !== "abgeschlossen" && lokal.status !== "bereits_abgeschlossen") {
            // Server-Zeile ist weg (geloescht) → beim naechsten Sync neu anlegen.
            lokal = { ...lokal, server_id: null, base_updated_at: null, dirty: true, status: "lokal" };
            if (schreiben) await speichereRapportDraft(lokal).catch(() => {});
            f = lokal.form;
          } else if (lokal) {
            f = lokal.form;
            if (lokal.status === "abgeschlossen" && lokal.server_id) void ladeServerFotos(lokal.server_id);
          } else {
            // Noch gar nichts: Vorschlaege zeigen, aber nichts speichern.
            f = await vorschlaege(basis);
          }
          return { lokal, lokaleBlobs, f };
        };

        // Laeuft fuer den Auftrag gerade ein Sync, haelt er die Sperre waehrend
        // Foto-/Unterschrifts-Uploads und Abschluss ohne Zeitlimit — darauf zu
        // warten liesse die Seite minutenlang im Ladegeruest. Dann nur
        // anzeigen: nichts in IndexedDB schreiben, keine Konflikt-Markierung;
        // den Endstand liefert der RAPPORT_OUTBOX_EVENT-Handler unten.
        // Entwurf und Blobs erst NACH der Server-Antwort lesen — was der Sync
        // inzwischen geschrieben hat, gilt und wird nicht zurueckgesetzt.
        // Schreibt der Sync waehrend des Lesens, wird neu gelesen (outboxStand).
        const anzeigen = async () => {
          const serverRow = await holeServer();
          let lokal: RapportDraft | null;
          let lokaleBlobs: RapportBlob[];
          let stand: number;
          do {
            stand = outboxStand.current;
            lokal = await ladeRapportDraft(jobId, meId).catch(() => null);
            lokaleBlobs = lokal ? await ladeBlobs(lokal.report_id).catch(() => []) : [];
          } while (stand !== outboxStand.current && !cancelled);
          if (cancelled) return null;
          if (serverRow?.status === "abgeschlossen") setServer(serverRow);
          if (serverRow) void ladeServerFotos(serverRow.id);
          // Bei «bereits abgeschlossen» — oder abgeschlossenem Server mit eigenen,
          // ungesendeten Eingaben (Nachtrag-Balken) — die eigenen Eingaben, wie im Abgleich.
          const nachtragLokal = !!lokal && lokal.status !== "abgeschlossen"
            && (lokal.status === "bereits_abgeschlossen" || lokal.dirty || lokaleBlobs.length > 0);
          const f = serverRow && (!lokal || (serverRow.status === "abgeschlossen" && !nachtragLokal))
            ? serverZuForm(serverRow, basis)
            : (lokal?.form ?? basis);
          return { lokal, lokaleBlobs, f };
        };

        const nurAnzeigen = schreiben && rapportFortschritt(jobId) !== null;
        const ergebnis = nurAnzeigen ? await anzeigen() : schreiben ? await mitRapportSperre(jobId, abgleich) : await abgleich();
        if (!ergebnis || cancelled) return;
        const { lokal, lokaleBlobs, f } = ergebnis;

        setzeDraft(lokal);
        setzeForm(f);
        setBlobs(lokaleBlobs);
        void ladeSigUrls(f);
        setLadeFehler(null);
        setGeladen(true);
        if (schreiben && !nurAnzeigen) {
          // Der Abgleich oben schreibt/loescht Entwuerfe direkt ueber db.ts —
          // OfflineStreifen/UebertragungenSheet den neuen Stand melden.
          meldeRapportAenderung(jobId);
          // Auch bei Lie-Fi anstossen: scheitert der Lauf am Netz, versucht ihn
          // der Backoff weiter, bis die Verbindung wirklich steht.
          if (lokal && online) void syncRapport(supabase, meId, meName, jobId);
        }
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Laden fehlgeschlagen";
        toast.error(`Rapport konnte nicht geladen werden: ${msg}`);
        setLadeFehler(msg);
        setGeladen(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Beim ersten Laden (meId bekannt) und bei «Erneut versuchen»; online-
    // Wechsel laufen ueber den Sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, meId, jobId, ladeVersuch]);

  // Ladefehler: «Erneut versuchen» und — sobald wieder Netz da ist — von selbst.
  const neuLaden = useCallback(() => {
    setGeladen(false);
    setLadeVersuch((v) => v + 1);
  }, []);
  useEffect(() => {
    if (!ladeFehler) return;
    window.addEventListener("online", neuLaden);
    return () => window.removeEventListener("online", neuLaden);
  }, [ladeFehler, neuLaden]);

  // ── Sync-Trigger + Aenderungen aus der Outbox ─────────────────────────
  useEffect(() => {
    if (!meId || !geladen || ansichtAls) return;
    return registriereSyncTrigger(() => {
      void syncRapport(supabase, meId, meName, jobId);
    });
  }, [supabase, meId, meName, jobId, geladen, ansichtAls]);

  useEffect(() => {
    if (!meId) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ jobId?: string }>).detail;
      if (detail?.jobId && detail.jobId !== jobId) return;
      outboxStand.current++;
      setFortschritt(rapportFortschritt(jobId));
      (async () => {
        const d = await ladeRapportDraft(jobId, meId).catch(() => null);
        const vorher = draftRef.current;
        setzeDraft(d);
        if (!d) return;
        // Formular nur uebernehmen, wenn die Aenderung nicht von uns kam
        // (Zusammenfuehrung, Konflikt-Entscheid, Unterschrifts-Pfade) — und
        // beim Wechsel auf «bereits abgeschlossen»: dann gelten die eigenen
        // Eingaben (Nachtrag), nicht ein angezeigter Server-Stand.
        if (!vorher || d.local_updated_at !== vorher.local_updated_at || d.form.signature_url !== vorher.form.signature_url
          || d.form.technician_signature_url !== vorher.form.technician_signature_url
          || (d.status === "bereits_abgeschlossen" && vorher.status !== "bereits_abgeschlossen")) {
          setzeForm(d.form);
          void ladeSigUrls(d.form);
        }
        const b = await ladeBlobsNeu(d.report_id);
        if (d.server_id && b.length < blobs.length) void ladeServerFotos(d.server_id);
        if (d.status === "abgeschlossen" && vorher?.status !== "abgeschlossen") {
          toast.success("Rapport abgeschlossen");
          if (d.server_id) void ladeServerFotos(d.server_id);
        }
      })();
    };
    window.addEventListener(RAPPORT_OUTBOX_EVENT, handler);
    return () => window.removeEventListener(RAPPORT_OUTBOX_EVENT, handler);
  }, [meId, jobId, blobs.length, setzeDraft, setzeForm, ladeBlobsNeu, ladeServerFotos, ladeSigUrls]);

  useEffect(() => () => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
  }, []);

  // ── Eingaben (write-ahead) ────────────────────────────────────────────
  const aendere = useCallback(async (patch: Partial<RapportDraftForm>) => {
    if (!meId || !formRef.current || gesperrt()) return;
    const neu = { ...formRef.current, ...patch };
    setzeForm(neu);
    if (!istIdbVerfuegbar()) {
      // Ein Toast (gleiche ID) statt einem je Tastendruck.
      ungesichert.current = true;
      toast.error("Kein Offline-Speicher auf diesem Gerät — Eingaben werden nicht gesichert", { id: SPEICHER_TOAST_ID });
      return;
    }
    const d = draftRef.current ?? neuerDraft(jobId, meId, neu);
    const gespeichert = await speichereEingabe(d, neu);
    if (!gespeichert) {
      ungesichert.current = true;
      return;
    }
    ungesichert.current = false;
    setzeDraft(gespeichert);
    if (online) planeSync();
  }, [meId, jobId, online, gesperrt, planeSync, setzeDraft, setzeForm]);

  // ── Fotos ─────────────────────────────────────────────────────────────
  async function fotosHinzufuegen(files: FileList | null) {
    if (!files || files.length === 0 || !meId || !formRef.current || gesperrt()) return;
    const vorhandene = serverFotos.length + blobs.filter((b) => b.kind === "photo").length;
    const frei = MAX_FOTOS - vorhandene;
    if (frei <= 0) {
      toast.error(`Höchstens ${MAX_FOTOS} Fotos pro Rapport`);
      return;
    }
    const liste = Array.from(files).slice(0, frei);
    if (liste.length < files.length) toast.error(`Höchstens ${MAX_FOTOS} Fotos pro Rapport — ${files.length - liste.length} nicht übernommen`);
    let d = draftRef.current;
    if (!d) {
      d = await speichereEingabe(neuerDraft(jobId, meId, formRef.current), formRef.current);
      if (!d) return;
      setzeDraft(d);
    }
    setFotoBusy(liste.length);
    let sort = vorhandene;
    for (const file of liste) {
      const r = await bereiteFotoVor(file);
      if ("fehler" in r) {
        toast.error(`${file.name}: ${r.fehler}`);
        setFotoBusy((n) => Math.max(0, n - 1));
        continue;
      }
      const ok = await speichereBlobSicher({
        local_id: crypto.randomUUID(),
        user_id: meId,
        report_id: d.report_id,
        kind: "photo",
        blob: r.blob,
        caption: null,
        sort: sort++,
        upload_status: "wartet",
      });
      setFotoBusy((n) => Math.max(0, n - 1));
      if (!ok) break;
    }
    await ladeBlobsNeu(d.report_id);
    // Foto ohne Text: Entwurf trotzdem als zu senden markieren.
    const neu = await speichereEingabe(d, formRef.current);
    if (neu) setzeDraft(neu);
    if (online) planeSync();
  }

  async function fotoEntfernen(lokal: RapportBlob | null, serverFoto: ServerFoto | null) {
    if (gesperrt()) return;
    const ok = await confirm({ title: "Foto entfernen?", message: "Das Foto wird aus dem Rapport gelöscht.", confirmLabel: "Löschen", variant: "red" });
    if (!ok) return;
    if (lokal) {
      await loescheBlob(lokal.local_id);
      const u = blobUrls.current.get(lokal.local_id);
      if (u) {
        URL.revokeObjectURL(u);
        blobUrls.current.delete(lokal.local_id);
      }
      await ladeBlobsNeu(draftRef.current?.report_id ?? null);
      // Direkt ueber db.ts geloescht — war es das letzte Wartende, muss der
      // Rapport aus «Übertragungen» verschwinden.
      meldeRapportAenderung(jobId);
      return;
    }
    if (serverFoto) {
      const fehler = await loescheServerFoto(supabase, serverFoto.id, serverFoto.storage_path);
      if (fehler) {
        toast.error(fehler);
        return;
      }
      setServerFotos((prev) => prev.filter((p) => p.id !== serverFoto.id));
    }
  }

  // ── Unterschriften ────────────────────────────────────────────────────
  async function unterschrift(kind: "sig_tech" | "sig_client", dataUrl: string) {
    if (!meId || !formRef.current || gesperrt()) return;
    let d = draftRef.current;
    if (!d) {
      d = await speichereEingabe(neuerDraft(jobId, meId, formRef.current), formRef.current);
      if (!d) return;
      setzeDraft(d);
    }
    const alte = blobs.filter((b) => b.kind === kind);
    for (const b of alte) {
      await loescheBlob(b.local_id);
      const u = blobUrls.current.get(b.local_id);
      if (u) {
        URL.revokeObjectURL(u);
        blobUrls.current.delete(b.local_id);
      }
    }
    if (dataUrl && dataUrl.startsWith("data:image")) {
      setSitzungSigniert((s) => (kind === "sig_tech" ? { ...s, tech: true } : { ...s, client: true }));
      const blob = await dataUrlZuBlob(dataUrl);
      const ok = await speichereBlobSicher({
        local_id: crypto.randomUUID(), user_id: meId, report_id: d.report_id, kind, blob, caption: null, sort: 0, upload_status: "wartet",
      });
      if (!ok) return;
      await ladeBlobsNeu(d.report_id);
      const neu = await speichereEingabe(d, formRef.current);
      if (neu) setzeDraft(neu);
      if (online) planeSync();
    } else {
      // Geloescht: Server-Pfad raus, Vorschau weg.
      await ladeBlobsNeu(d.report_id);
      setSigUrls((s) => (kind === "sig_tech" ? { ...s, tech: null } : { ...s, client: null }));
      await aendere(kind === "sig_tech" ? { technician_signature_url: null } : { signature_url: null });
    }
  }

  // ── Aktionen ──────────────────────────────────────────────────────────
  async function speichern() {
    if (!meId || gesperrt()) return;
    setAktion("speichern");
    try {
      // Letzte Eingabe nicht auf dem Geraet gelandet → jetzt nochmals
      // versuchen; scheitert es wieder, keine Erfolgsmeldung.
      if (ungesichert.current && formRef.current) {
        if (!istIdbVerfuegbar()) {
          toast.error("Kein Offline-Speicher auf diesem Gerät — Eingaben konnten nicht gesichert werden", { id: SPEICHER_TOAST_ID });
          return;
        }
        const neu = await speichereEingabe(draftRef.current ?? neuerDraft(jobId, meId, formRef.current), formRef.current);
        if (!neu) return;
        ungesichert.current = false;
        setzeDraft(neu);
      }
      if (!draftRef.current) {
        toast.success("Nichts zu speichern");
        return;
      }
      if (!online) {
        toast.success("Auf dem Gerät gespeichert — wird gesendet, sobald Netz da ist");
        return;
      }
      if (syncTimer.current) {
        clearTimeout(syncTimer.current);
        syncTimer.current = null;
      }
      await syncRapport(supabase, meId, meName, jobId);
      const d = await ladeRapportDraft(jobId, meId).catch(() => null);
      if (d?.status === "gesendet") toast.success("Rapport gespeichert");
      else if (d?.status === "lokal") toast.success("Auf dem Gerät gespeichert — Übertragung folgt");
    } finally {
      setAktion(null);
    }
  }

  async function abschliessen() {
    if (!form || !meId || gesperrt()) return;
    const fehlt = fehlendePflichtfelder(form);
    if (fehlt) {
      toast.error(`Rapport unvollständig: ${fehlt}`);
      return;
    }
    const ok = await confirm({
      title: "Bist du der letzte Techniker?",
      message:
        "Nach dem Abschliessen ist der Rapport endgültig — kein anderer Techniker kann mehr einen Rapport für diesen Auftrag erstellen oder bearbeiten.\n\nNur bestätigen, wenn KEINE weiteren Mitarbeiter an diesem Auftrag arbeiten.",
      confirmLabel: online ? "Ja, abschliessen" : "Ja, vormerken",
      cancelLabel: "Abbrechen",
      variant: "red",
      confirmDelaySec: 8,
    });
    if (!ok) return;
    setAktion("abschliessen");
    try {
      let d = draftRef.current;
      if (!d) {
        d = await speichereEingabe(neuerDraft(jobId, meId, form), form);
        if (!d) return;
        setzeDraft(d);
      }
      const neu = await abschlussVormerken(jobId, meId);
      if (neu) setzeDraft(neu);
      if (!online) {
        toast.success("Abschluss vorgemerkt — wird gesendet, sobald Netz da ist");
        return;
      }
      if (syncTimer.current) {
        clearTimeout(syncTimer.current);
        syncTimer.current = null;
      }
      await syncRapport(supabase, meId, meName, jobId);
    } finally {
      setAktion(null);
    }
  }

  async function konflikt(entscheid: "server" | "meine") {
    if (!meId || gesperrt()) return;
    setAktion(entscheid === "server" ? "konflikt-server" : "konflikt-meine");
    try {
      if (entscheid === "server") await konfliktServerUebernehmen(jobId, meId);
      else await konfliktMeineSenden(jobId, meId);
      await syncRapport(supabase, meId, meName, jobId);
    } finally {
      setAktion(null);
    }
  }

  async function nochmal() {
    if (!meId || gesperrt()) return;
    setAktion("retry");
    try {
      if (draftRef.current?.status === "abgeschlossen") {
        const fehler = await abschlussNachholen(jobId, meId);
        if (fehler) toast.error(fehler);
        else toast.success("Nachgeholt");
        return;
      }
      await erneutVersuchen(jobId, meId);
      await syncRapport(supabase, meId, meName, jobId);
    } finally {
      setAktion(null);
    }
  }

  async function nachtrag() {
    if (!meId || gesperrt()) return;
    setAktion("nachtrag");
    try {
      const namen = new Map(personenListe.map((p) => [p.id, p.full_name]));
      const fehler = await sendeAlsNachtrag(supabase, meId, jobId, job?.job_number ?? null, namen);
      if (fehler) {
        toast.error(fehler);
        return;
      }
      toast.success("Nachtrag ans Büro gesendet");
      router.replace(`/auftraege/${jobId}`);
    } finally {
      setAktion(null);
    }
  }

  async function pdfOeffnen() {
    const serverId = draftRef.current?.server_id ?? server?.id ?? null;
    const pfad = draftRef.current?.pdf_url ?? server?.pdf_url ?? null;
    setAktion("pdf");
    try {
      if (pfad) {
        const { data } = await supabase.storage.from("documents").createSignedUrl(pfad, 3600);
        if (data?.signedUrl) {
          setPdf({ url: data.signedUrl, title: `Einsatzrapport ${formatJobNumber(job?.job_number)}.pdf` });
          return;
        }
      }
      if (serverId) setPdf({ url: `/api/reports/${serverId}/pdf`, title: `Einsatzrapport ${formatJobNumber(job?.job_number)}.pdf` });
      else toast.error("Kein PDF vorhanden");
    } finally {
      setAktion(null);
    }
  }

  // ── Ableitungen ───────────────────────────────────────────────────────
  const status = draft?.status ?? null;
  const abgeschlossen = status === "abgeschlossen" || server?.status === "abgeschlossen";
  const readOnly = abgeschlossen || status === "bereits_abgeschlossen" || status === "konflikt" || ansichtAls;
  const endeIso = job?.end_date ? localDateIso(new Date(job.end_date)) : null;
  const endeErreicht = !endeIso || endeIso <= todayLocalIso();
  const fehlt = form ? fehlendePflichtfelder(form) : "Lädt…";
  const grund = !endeErreicht && job?.end_date
    ? `Abschliessen ab ${formatDate(job.end_date)} möglich`
    : fehlt;
  const abschlussMoeglich = !!form && endeErreicht && !fehlt && !readOnly;
  const personen = useMemo(() => personenListe.map((p) => ({ id: p.id, label: p.full_name })), [personenListe]);
  const fotoBlobs = blobs.filter((b) => b.kind === "photo");
  const techBlob = blobs.find((b) => b.kind === "sig_tech" && b.caption !== "ablage") ?? null;
  const clientBlob = blobs.find((b) => b.kind === "sig_client" && b.caption !== "ablage") ?? null;
  const totalMin = form ? form.time_ranges.reduce((s, t) => s + trMinuten(t), 0) : 0;

  if (ladeFehler && !form) {
    return (
      <div className="page-enter">
        <LadeFehler titel="Rapport konnte nicht geladen werden" fehler={ladeFehler} laedt={!geladen} onRetry={neuLaden} />
      </div>
    );
  }
  if (!geladen || !form) {
    return <RapportSkeleton />;
  }

  return (
    <div className="page-enter flex flex-col gap-5 pb-[96px]">
      {/* Status-Zeile */}
      <StatusZeile
        draft={draft}
        server={server}
        ungesendet={!!draft && (draft.dirty || blobs.length > 0)}
        ansichtAls={ansichtAls}
        online={online}
        fortschritt={fortschritt}
        busy={aktion}
        onKonflikt={konflikt}
        onNochmal={nochmal}
        onNachtrag={nachtrag}
        onPdf={pdfOeffnen}
      />

      {job && (
        <p className="text-[14px] text-muted-foreground">
          {formatJobNumber(job.job_number)} · <span className="text-foreground">{job.title}</span>
          {job.customer_name ? ` · ${job.customer_name}` : ""}
        </p>
      )}

      {/* Zeiten */}
      <Abschnitt titel="Zeiten" rechts={<span className="text-[13px] font-semibold text-red-600 dark:text-red-400">Total {dauerText(totalMin)}</span>}>
        {form.time_ranges.map((t, i) => (
          <button
            key={i}
            type="button"
            disabled={readOnly}
            onClick={() => setZeileIdx(i)}
            className="flex min-h-[72px] w-full items-center gap-3 border-t border-border px-4 py-2 text-left first:border-t-0 active:bg-foreground/10 disabled:active:bg-transparent"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[16px] font-bold leading-6">
                {tagLabel(t.date)}
                {t.quelle && <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-[12px] font-semibold text-sky-800 dark:bg-sky-500/25 dark:text-sky-200">Vorschlag</span>}
              </p>
              <p className="truncate text-[14px] leading-5 text-muted-foreground">
                {personenListe.find((p) => p.id === t.technician_id)?.full_name ?? (t.technician_id ? "Techniker" : "Techniker fehlt")}
                {tiers.length > 1 && (t.rate_tier_id || defaultTierId) ? ` · ${tiers.find((x) => x.id === (t.rate_tier_id ?? defaultTierId))?.label ?? ""}` : ""}
              </p>
            </div>
            <div className="shrink-0 text-right tabular-nums">
              <p className="text-[16px] font-semibold leading-6">{t.start || "–:–"} – {t.end || "–:–"}</p>
              <p className="text-[13px] leading-5 text-muted-foreground">
                {t.pause ? `Pause ${t.pause} · ` : ""}{dauerText(trMinuten(t))}
              </p>
            </div>
            {!readOnly && <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />}
          </button>
        ))}
        {!readOnly && (
          <button
            type="button"
            onClick={() => setZeileIdx(form.time_ranges.length)}
            className="flex h-12 w-full items-center justify-center gap-2 border-t border-border text-[15px] font-medium text-muted-foreground active:bg-foreground/10"
          >
            <Plus className="h-4 w-4" /> Weitere Zeit
          </button>
        )}
      </Abschnitt>

      {/* Arbeit */}
      <section className="flex flex-col gap-2">
        <label htmlFor="rapport-arbeit" className={LABEL}>Was wurde gemacht *</label>
        <textarea
          id="rapport-arbeit"
          value={form.work_description}
          onChange={(e) => void aendere({ work_description: e.target.value })}
          disabled={readOnly}
          rows={5}
          placeholder="Kurz und konkret — steht so im Rapport-PDF."
          className="w-full rounded-xl border border-border bg-background px-4 py-3 text-[16px] leading-6 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
        />
      </section>

      {/* Material & Probleme (eingeklappt) */}
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <button
          type="button"
          onClick={() => setMaterialOffen((o) => !o)}
          aria-expanded={materialOffen}
          className="flex h-12 w-full items-center justify-between px-4 text-left active:bg-foreground/10"
        >
          <span className="text-[16px] font-medium">Material &amp; Probleme</span>
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {!materialOffen && (form.equipment_used || form.issues) ? "ausgefüllt" : ""}
            <ChevronDown className={`h-5 w-5 transition-transform ${materialOffen ? "rotate-180" : ""}`} />
          </span>
        </button>
        {materialOffen && (
          <div className="flex flex-col gap-4 border-t border-border p-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="rapport-material" className={LABEL}>Eingesetztes Material</label>
              <textarea
                id="rapport-material"
                value={form.equipment_used}
                onChange={(e) => void aendere({ equipment_used: e.target.value })}
                disabled={readOnly}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-[16px] leading-6 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="rapport-probleme" className={LABEL}>Probleme / Bemerkungen</label>
              <textarea
                id="rapport-probleme"
                value={form.issues}
                onChange={(e) => void aendere({ issues: e.target.value })}
                disabled={readOnly}
                rows={3}
                className="w-full rounded-xl border border-border bg-background px-4 py-3 text-[16px] leading-6 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
              />
            </div>
          </div>
        )}
      </section>

      {/* Fotos */}
      <section className="flex flex-col gap-2">
        <div className="flex min-h-[28px] items-center justify-between px-1">
          <h2 className={LABEL}>Fotos</h2>
          <span className="text-[13px] text-muted-foreground">
            {serverFotos.length + fotoBlobs.length} / {MAX_FOTOS}{fotoBusy > 0 ? ` · ${fotoBusy} wird verkleinert…` : ""}
          </span>
        </div>
        {!readOnly && (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => kameraRef.current?.click()} disabled={fotoBusy > 0} className="kasten kasten-muted h-12 justify-center text-[15px]">
              {fotoBusy > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Kamera
            </button>
            <button type="button" onClick={() => galerieRef.current?.click()} disabled={fotoBusy > 0} className="kasten kasten-muted h-12 justify-center text-[15px]">
              <ImageIcon className="h-4 w-4" /> Galerie
            </button>
            <input ref={kameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { void fotosHinzufuegen(e.target.files); e.target.value = ""; }} />
            <input ref={galerieRef} type="file" accept="image/*,.heic,.heif" multiple className="hidden" onChange={(e) => { void fotosHinzufuegen(e.target.files); e.target.value = ""; }} />
          </div>
        )}
        {(serverFotos.length > 0 || fotoBlobs.length > 0) && (
          <div className="grid grid-cols-3 gap-2">
            {serverFotos.map((p) => (
              <FotoKachel key={p.id} url={p.url} readOnly={readOnly} onRemove={() => fotoEntfernen(null, p)} />
            ))}
            {fotoBlobs.map((b) => (
              <FotoKachel key={b.local_id} url={blobUrl(b)} status={b.upload_status} readOnly={readOnly} onRemove={() => fotoEntfernen(b, null)} />
            ))}
          </div>
        )}
      </section>

      {/* Unterschriften */}
      <section className="flex flex-col gap-4">
        <h2 className={`${LABEL} px-1`}>Unterschriften</h2>
        <div className="flex flex-col gap-2">
          <label className={LABEL}>Techniker</label>
          {readOnly ? (
            <div className={`${FELD} flex items-center opacity-60`}>{form.technician_name || "—"}</div>
          ) : (
            <div className={SELECT_WRAP}>
              <SearchableSelect
                value={form.technician_id}
                onChange={(id) => void aendere({ technician_id: id, technician_name: personenListe.find((p) => p.id === id)?.full_name ?? "" })}
                items={personen}
                placeholder="Techniker auswählen…"
              />
            </div>
          )}
          {readOnly ? (
            <UnterschriftLesen label="Unterschrift Techniker" url={techBlob ? blobUrl(techBlob) : sigUrls.tech} />
          ) : (
            <div style={{ touchAction: "none" }}>
              <SignaturePad
                label="Unterschrift Techniker"
                onSave={(u) => void unterschrift("sig_tech", u)}
                savedUrl={sitzungSigniert.tech ? null : techBlob ? blobUrl(techBlob) : sigUrls.tech}
              />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <div className="grid grid-cols-3 gap-2">
            <button type="button" disabled={readOnly} onClick={() => void aendere({ client_absent: false, signer_type: "kunde" })} aria-pressed={!form.client_absent && form.signer_type === "kunde"} className={`${!form.client_absent && form.signer_type === "kunde" ? "kasten-active" : "kasten-toggle-off"} h-[44px] justify-center px-2 text-[14px]`}>Kunde</button>
            <button type="button" disabled={readOnly} onClick={() => void aendere({ client_absent: false, signer_type: "mieter" })} aria-pressed={!form.client_absent && form.signer_type === "mieter"} className={`${!form.client_absent && form.signer_type === "mieter" ? "kasten-active" : "kasten-toggle-off"} h-[44px] justify-center px-2 text-[14px]`}>Mieter</button>
            <button type="button" disabled={readOnly} onClick={() => { void aendere({ client_absent: true, signature_url: null }); if (clientBlob) void unterschrift("sig_client", ""); }} aria-pressed={form.client_absent} className={`${form.client_absent ? "kasten-active" : "kasten-toggle-off"} h-[44px] justify-center px-2 text-[14px]`}>Nicht vor Ort</button>
          </div>
          {form.client_absent ? (
            <p className="rounded-xl bg-amber-50 px-4 py-3 text-[14px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
              Niemand vor Ort zum Unterschreiben — der Rapport wird ohne Kundenunterschrift abgeschlossen und im PDF so ausgewiesen.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <label htmlFor="rapport-kunde" className={LABEL}>{form.signer_type === "mieter" ? "Mieter / Person vor Ort" : "Kunde / Auftraggeber"}</label>
                <input
                  id="rapport-kunde"
                  value={form.client_name}
                  onChange={(e) => void aendere({ client_name: e.target.value })}
                  disabled={readOnly}
                  placeholder={form.signer_type === "mieter" ? "Name Mieter vor Ort" : "Name Kunde"}
                  className={FELD}
                />
              </div>
              {form.signer_type === "mieter" && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="rapport-rolle" className={LABEL}>Funktion / Rolle (optional)</label>
                  <input
                    id="rapport-rolle"
                    value={form.signer_role}
                    onChange={(e) => void aendere({ signer_role: e.target.value })}
                    disabled={readOnly}
                    placeholder="z. B. Veranstalter, Regie"
                    className={FELD}
                  />
                </div>
              )}
              {readOnly ? (
                <UnterschriftLesen
                  label={form.signer_type === "mieter" ? "Unterschrift Mieter vor Ort" : "Unterschrift Kunde"}
                  url={clientBlob ? blobUrl(clientBlob) : sigUrls.client}
                />
              ) : (
                <div style={{ touchAction: "none" }}>
                  <SignaturePad
                    label={form.signer_type === "mieter" ? "Unterschrift Mieter vor Ort" : "Unterschrift Kunde"}
                    onSave={(u) => void unterschrift("sig_client", u)}
                    savedUrl={sitzungSigniert.client ? null : clientBlob ? blobUrl(clientBlob) : sigUrls.client}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Sticky Aktionsleiste ueber der Nav («Ansicht als»: nur lesen, keine Aktionen) */}
      {!abgeschlossen && status !== "bereits_abgeschlossen" && !ansichtAls && (
        <div
          className="fixed left-0 right-0 z-30 border-t border-border bg-background/95 backdrop-blur md:hidden"
          style={{ bottom: "calc(var(--nav-h, 64px) + env(safe-area-inset-bottom, 0px))" }}
        >
          <div className="flex h-[72px] items-center gap-2 px-4">
            <button type="button" onClick={speichern} disabled={aktion !== null} className="kasten kasten-muted h-[52px] w-[120px] shrink-0 justify-center text-[15px]">
              {aktion === "speichern" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Speichern
            </button>
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={abschliessen}
                disabled={!abschlussMoeglich || aktion !== null}
                className="kasten kasten-red h-[52px] w-full justify-center text-[16px]"
              >
                {aktion === "abschliessen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {online ? "Auftrag abschliessen" : "Abschluss vormerken"}
              </button>
              {!abschlussMoeglich && grund && (
                <p className="mt-0.5 truncate text-center text-[12px] text-muted-foreground">{grund}</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Zeit-Sheet */}
      {zeileIdx !== null && (
        <ZeitSheet
          zeile={form.time_ranges[zeileIdx] ?? {
            ...(form.time_ranges[form.time_ranges.length - 1] ?? { date: todayLocalIso(), start: "", end: "", pause: 0 }),
            // Wie die erste Zeile: ich selbst als Techniker vorbelegt.
            technician_id: meId ?? "",
            quelle: undefined,
          }}
          neu={zeileIdx >= form.time_ranges.length}
          loeschbar={form.time_ranges.length > 1 && zeileIdx < form.time_ranges.length}
          personen={personen}
          tiers={tiers}
          defaultTierId={defaultTierId}
          onClose={() => setZeileIdx(null)}
          onSave={(t) => {
            const ranges = [...form.time_ranges];
            const kopie = { ...t };
            delete kopie.quelle;
            if (zeileIdx >= ranges.length) ranges.push(kopie);
            else ranges[zeileIdx] = kopie;
            void aendere({ time_ranges: ranges });
            setZeileIdx(null);
          }}
          onDelete={() => {
            void aendere({ time_ranges: form.time_ranges.filter((_, i) => i !== zeileIdx) });
            setZeileIdx(null);
          }}
        />
      )}

      {ConfirmModalElement}
      {pdf && <PdfPopup url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status-Zeile
// ---------------------------------------------------------------------------

function StatusZeile({
  draft, server, ungesendet, ansichtAls, online, fortschritt, busy, onKonflikt, onNochmal, onNachtrag, onPdf,
}: {
  draft: RapportDraft | null;
  server: ServerRapport | null;
  /** Auf dem Geraet liegen eigene, noch nicht gesendete Eingaben (Text/Zeit, Fotos, Unterschriften). */
  ungesendet: boolean;
  ansichtAls: boolean;
  online: boolean;
  fortschritt: { done: number; total: number } | null;
  busy: Aktion | null;
  onKonflikt: (e: "server" | "meine") => void;
  onNochmal: () => void;
  onNachtrag: () => void;
  onPdf: () => void;
}) {
  const ton = {
    gruen: { bg: "rgba(0,168,107,0.12)", cls: "text-green-800 dark:text-green-200" },
    blau: { bg: "rgba(37,99,235,0.12)", cls: "text-blue-800 dark:text-blue-200" },
    amber: { bg: "rgba(245,158,11,0.14)", cls: "text-amber-800 dark:text-amber-200" },
    rot: { bg: "rgba(220,38,38,0.12)", cls: "text-red-800 dark:text-red-200" },
  } as const;

  let farbe: keyof typeof ton = "gruen";
  let text: string;
  let icon = <Check className="h-4 w-4 shrink-0" />;
  let aktionen: React.ReactNode = null;
  const status = draft?.status ?? null;
  const pdfKnopf = (
    <button type="button" onClick={onPdf} disabled={busy !== null} className="kasten kasten-muted h-[44px] shrink-0 text-[14px]">
      {busy === "pdf" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} PDF
    </button>
  );
  const istAbgeschlossen = status === "abgeschlossen" || server?.status === "abgeschlossen";
  // Nachtrag vor «Abgeschlossen» pruefen: liegen eigene, ungesendete
  // Eingaben auf dem Geraet, muss der Knopf erscheinen — auch wenn der
  // Entwurf (waehrend eines Syncs geladen) noch nicht umgestellt ist.
  const nachtragOffen = status === "bereits_abgeschlossen"
    || (server?.status === "abgeschlossen" && ungesendet && status !== null && status !== "abgeschlossen" && status !== "sendet");

  if (ansichtAls) {
    // Nur lesen: keine Senden-/Konflikt-Aktionen, das PDF bleibt einsehbar.
    farbe = "amber";
    icon = <Eye className="h-4 w-4 shrink-0" />;
    text = "Ansicht als — nur lesen";
    if (istAbgeschlossen) aktionen = <div className="flex gap-2">{pdfKnopf}</div>;
  } else if (nachtragOffen) {
    farbe = "amber";
    icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
    text = "Am Server bereits abgeschlossen — deine Eingaben auf diesem Gerät als Nachtrag ans Büro senden.";
    aktionen = (
      <button type="button" disabled={busy !== null || !online} onClick={onNachtrag} className="kasten kasten-red h-[44px] w-full text-[14px]">
        {busy === "nachtrag" ? <Loader2 className="h-4 w-4 animate-spin" /> : online ? "Als Nachtrag ans Büro senden" : "Kein Netz"}
      </button>
    );
  } else if (istAbgeschlossen) {
    // Hinweis nur aus dem eigenen Abschluss (PDF/Stempel fehlen noch) — nie
    // ein alter Sende-Fehler eines Entwurfs, den der Server schon abgeschlossen hat.
    const nachholen = status === "abgeschlossen" ? draft?.last_error ?? null : null;
    text = nachholen ? `Abgeschlossen — ${nachholen}` : "Abgeschlossen";
    aktionen = (
      <div className="flex gap-2">
        {nachholen && (
          <button type="button" disabled={busy !== null} onClick={onNochmal} className="kasten kasten-red h-[44px] flex-1 text-[14px]">
            {busy === "retry" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Erneut versuchen"}
          </button>
        )}
        {pdfKnopf}
      </div>
    );
  } else if (!draft) {
    return null;
  } else if (status === "konflikt") {
    farbe = "rot";
    icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
    text = "Konflikt — der Rapport wurde inzwischen am Computer geändert. Welche Version gilt?";
    aktionen = (
      <div className="flex gap-2">
        <button type="button" disabled={busy !== null} onClick={() => onKonflikt("server")} className="kasten kasten-muted h-[44px] flex-1 text-[14px]">
          {busy === "konflikt-server" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Server-Version übernehmen"}
        </button>
        <button type="button" disabled={busy !== null || !online} onClick={() => onKonflikt("meine")} className="kasten kasten-red h-[44px] flex-1 text-[14px]">
          {busy === "konflikt-meine" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Meine senden"}
        </button>
      </div>
    );
  } else if (status === "fehler") {
    farbe = "rot";
    icon = <AlertTriangle className="h-4 w-4 shrink-0" />;
    text = draft.last_error ?? "Senden fehlgeschlagen";
    aktionen = (
      <button type="button" disabled={busy !== null || !online} onClick={onNochmal} className="kasten kasten-red h-[44px] w-full text-[14px]">
        {busy === "retry" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Erneut versuchen"}
      </button>
    );
  } else if (status === "sendet") {
    farbe = "blau";
    icon = <Loader2 className="h-4 w-4 shrink-0 animate-spin" />;
    text = fortschritt ? `Wird gesendet ${Math.min(fortschritt.done + 1, fortschritt.total)}/${fortschritt.total}` : "Wird gesendet…";
  } else if (draft.finalize_requested_at) {
    farbe = "amber";
    icon = online ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <CloudOff className="h-4 w-4 shrink-0" />;
    text = online ? "Abschluss vorgemerkt — wird gesendet" : "Abschluss vorgemerkt — wird gesendet, sobald Netz da ist";
  } else if (draft.merged_with) {
    farbe = "blau";
    text = `Mit ${draft.merged_with} zusammengeführt — kurz prüfen`;
  } else if (status === "gesendet" && !draft.dirty) {
    text = "Gesendet";
  } else {
    text = `Auf dem Gerät gespeichert ${formatTime(draft.local_updated_at)}${!online ? " · kein Netz" : ""}`;
    if (!online) icon = <CloudOff className="h-4 w-4 shrink-0" />;
  }

  return (
    <div
      className={`sticky z-20 -mx-4 flex flex-col gap-2 px-4 py-2 text-[14px] font-medium ${ton[farbe].cls}`}
      style={{ backgroundColor: ton[farbe].bg, top: "var(--kopf-h, 0px)" }}
    >
      <div className="flex min-h-[28px] items-center gap-2">
        {icon}
        <span className="min-w-0 flex-1">{text}</span>
      </div>
      {aktionen}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function Abschnitt({ titel, rechts, children }: { titel: string; rechts?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex min-h-[28px] items-center justify-between px-1">
        <h2 className={LABEL}>{titel}</h2>
        {rechts}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

function FotoKachel({ url, status, readOnly, onRemove }: { url: string; status?: RapportBlob["upload_status"]; readOnly: boolean; onRemove: () => void }) {
  return (
    <div className="relative aspect-square overflow-hidden rounded-xl border border-border bg-muted/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Foto" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      {!readOnly && (
        // Tastflaeche 44 px, sichtbar bleibt der 32-px-Kreis in der Ecke.
        <button
          type="button"
          onClick={onRemove}
          aria-label="Foto entfernen"
          className="absolute right-0 top-0 flex h-[44px] w-[44px] items-center justify-center"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white">
            <Trash2 className="h-4 w-4" />
          </span>
        </button>
      )}
      {status && (
        <span
          className={`absolute bottom-1.5 left-1.5 flex h-7 w-7 items-center justify-center rounded-full border-2 bg-black/50 text-white ${
            status === "fehler" ? "border-red-500" : status === "sendet" ? "border-blue-400" : "border-amber-400"
          }`}
          aria-label={status === "fehler" ? "Upload fehlgeschlagen" : status === "sendet" ? "Wird hochgeladen" : "Wartet auf Upload"}
        >
          {status === "sendet" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : status === "fehler" ? <AlertTriangle className="h-3.5 w-3.5" /> : <CloudOff className="h-3.5 w-3.5" />}
        </span>
      )}
    </div>
  );
}

/** Unterschrift nur lesen (abgeschlossen, Nachtrag, Konflikt, «Ansicht als»):
 *  Bild wie die Vorschau im SignaturePad, aber ohne «Löschen»/«Neu unterschreiben». */
function UnterschriftLesen({ label, url }: { label: string; url: string | null }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium">{label}</p>
      <div className="flex h-[150px] items-center justify-center overflow-hidden rounded-xl border-2 border-gray-200 bg-white">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="h-full w-full object-contain" />
        ) : (
          <span className="text-[14px] text-gray-500">Keine Unterschrift</span>
        )}
      </div>
    </div>
  );
}

function ZeitSheet({
  zeile, neu, loeschbar, personen, tiers, defaultTierId, onClose, onSave, onDelete,
}: {
  zeile: RapportDraftTimeRange;
  neu: boolean;
  loeschbar: boolean;
  personen: { id: string; label: string }[];
  tiers: ReturnType<typeof useLocationRateTiers>["tiers"];
  defaultTierId: string | null;
  onClose: () => void;
  onSave: (t: RapportDraftTimeRange) => void;
  onDelete: () => void;
}) {
  const [t, setT] = useState<RapportDraftTimeRange>(zeile);
  const vollstaendig = !!(t.date && t.start && t.end && t.technician_id);
  return (
    <Modal open onClose={onClose} sheet size="md" title={neu ? "Zeit hinzufügen" : "Zeit bearbeiten"} bodyClassName="p-4 space-y-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="zeit-datum" className={LABEL}>Datum</label>
        <input id="zeit-datum" type="date" value={t.date} onChange={(e) => setT({ ...t, date: e.target.value })} className={FELD} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <label htmlFor="zeit-von" className={LABEL}>Von</label>
          <input id="zeit-von" type="time" value={t.start} onChange={(e) => setT({ ...t, start: e.target.value })} className={FELD} />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="zeit-bis" className={LABEL}>Bis</label>
          <input id="zeit-bis" type="time" value={t.end} onChange={(e) => setT({ ...t, end: e.target.value })} className={FELD} />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className={LABEL}>Pause (Min)</span>
        <div className="flex flex-wrap gap-2">
          {PAUSE_PRESETS.map((min) => (
            <button
              key={min}
              type="button"
              onClick={() => setT({ ...t, pause: min })}
              aria-pressed={t.pause === min}
              className={`${t.pause === min ? "kasten-active" : "kasten-toggle-off"} h-[44px] min-w-[56px] justify-center px-3 text-[14px]`}
            >
              {min === 0 ? "keine" : min}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className={LABEL}>Techniker</span>
        <div className={SELECT_WRAP}>
          <SearchableSelect value={t.technician_id} onChange={(id) => setT({ ...t, technician_id: id })} items={personen} placeholder="Auswählen…" />
        </div>
      </div>
      {tiers.length > 1 && (
        <div className="flex flex-col gap-2">
          <span className={LABEL}>Modus</span>
          <div className="flex flex-wrap gap-2">
            {tiers.map((tier) => {
              const Icon = iconForTier(tier.key);
              const color = colorForTier(tier.key);
              const active = t.rate_tier_id === tier.id || (!t.rate_tier_id && tier.id === defaultTierId);
              return (
                <button
                  key={tier.id}
                  type="button"
                  onClick={() => setT({ ...t, rate_tier_id: tier.id })}
                  aria-pressed={active}
                  className="inline-flex h-[44px] items-center gap-1.5 rounded-full px-4 text-[14px] font-medium"
                  style={{
                    backgroundColor: active ? color.bgActive : color.bg,
                    color: active ? color.fgActive : color.fg,
                    border: `1.5px solid ${active ? color.borderActive : color.border}`,
                  }}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tier.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        {loeschbar && (
          <button type="button" onClick={onDelete} className="kasten kasten-muted h-12 w-12 shrink-0 justify-center" aria-label="Zeit entfernen">
            <Trash2 className="h-4 w-4" />
          </button>
        )}
        <button type="button" onClick={() => onSave(t)} className="kasten kasten-red h-12 flex-1 justify-center text-[16px]">
          {vollstaendig ? "Übernehmen" : "Übernehmen (unvollständig)"}
        </button>
      </div>
    </Modal>
  );
}

export function RapportSkeleton() {
  return (
    <div className="flex flex-col gap-5" aria-busy>
      <Skeleton className="h-10 rounded-none -mx-4" />
      <Skeleton className="h-4 w-56" />
      <div className="flex flex-col gap-1">
        <Skeleton className="h-3.5 w-16" />
        <Skeleton className="h-[72px] rounded-xl" />
        <Skeleton className="h-12 rounded-xl" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
      <Skeleton className="h-12 rounded-xl" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-14" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
