"use client";

// Lieferantenportal → Anfrage-Detail: das Technik-Review.
// Der Lieferant prueft die Planung von EVENTLINE Position fuer Position:
//   Passt (bestaetigen) · Empfehlung (mit Ein-Klick-Vorschlag) ·
//   Problem · Kommentar — plus "Position empfehlen" und allgemeine
//   Punkte. Wenige Klicks, alles inline. Storniert/abgeschlossen: nur lesen.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchableSelect } from "@/components/searchable-select";
import { useConfirm } from "@/components/ui/use-confirm";
import { PdfPopup } from "@/components/pdf-popup";
import { toast } from "sonner";
import {
  ArrowLeft, Check, CheckCheck, Loader2, MapPin, Users, MessageSquare, Plus,
  Lightbulb, AlertTriangle, ListChecks, Activity as ActivityIcon,
  FileUp, FileText, Lock, ShieldOff, CalendarClock, Building2, UserRound, RefreshCw,
} from "lucide-react";
import type {
  TechnikAnforderung, TechnikAktivitaet, TechnikKommentar, TechnikPosition,
  TechnikReview, ReviewArt, ReviewVorschlag,
} from "@/lib/technik";
import { AMPEL_LABEL, ganzeMenge, positionAmpel, positionMarker, REVIEW_ART_LABEL, technikStand } from "@/lib/technik";
import { PlanViewer, type ViewerPosition, type ViewerObjekt } from "@/components/technik/plan-viewer";
import {
  AmpelDot, AnfrageStatusBadge, BestaetigtHaken, KommentarThread, AktivitaetListe, MarkerChip, StandChips,
  ReviewArtChip, ReviewStatusChip, REVIEW_STYLES, Sektion, anzahl, zeitraumText,
} from "@/components/technik/technik-shared";
import { formatDateTimeFull } from "@/lib/format";

interface PortalPosition extends TechnikPosition {
  inhalt_geaendert_at: string | null;
  bestaetigt_von: { name: string | null; vonLieferant: boolean } | null;
}

interface Detail {
  job: {
    id: string; titel: string; jobNumber: number | null; status: string;
    startDate: string | null; endDate: string | null;
    gaeste: number | null; eventTyp: string | null;
    beschreibung: string | null; notizen: string | null; kunde: string | null;
    ort: { name: string | null; adresse: string | null };
    ansprechperson: { name: string | null; telefon: string | null; email: string | null } | null;
    termine: { id: string; title: string; start_time: string; end_time: string | null }[];
  };
  lieferant: string;
  gesperrt: boolean;
  angefragtAt: string | null;
  runden: number;
  aenderungsBasis: string | null;
  entferntSeitAnfrage: string[];
  anforderungen: TechnikAnforderung[];
  positionen: PortalPosition[];
  reviews: TechnikReview[];
  kommentare: TechnikKommentar[];
  aktivitaet: TechnikAktivitaet[];
  katalog: { id: string; name: string; hauptkategorie: string }[];
}

type FormZiel = { positionId: string | null; art: ReviewArt } | null;

interface Angebot { id: string; name: string; createdAt: string; url: string | null }

interface PlanDaten {
  hatPlan: boolean;
  unterlageUrl?: string;
  breitePx?: number;
  hoehePx?: number;
  ppm?: number | null;
  objekte?: ViewerObjekt[];
  positionen?: ViewerPosition[];
}

const MAX_ANGEBOT_BYTES = 20 * 1024 * 1024;

export default function LieferantAnfrageDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [plan, setPlan] = useState<PlanDaten | null>(null);
  const [angebote, setAngebote] = useState<Angebot[] | null>(null);
  const [angebotBusy, setAngebotBusy] = useState(false);
  const [angebotOffen, setAngebotOffen] = useState<{ url: string; name: string } | null>(null);
  const angebotFileRef = useRef<HTMLInputElement>(null);
  const [fehler, setFehler] = useState<{ status: number; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Inline-Review-Formular
  const [form, setForm] = useState<FormZiel>(null);
  const [formText, setFormText] = useState("");
  const [formVorschlagTyp, setFormVorschlagTyp] = useState<"keiner" | "menge" | "ersatz">("keiner");
  const [formMenge, setFormMenge] = useState("");
  const [formErsatz, setFormErsatz] = useState("");
  const [kommentarOffen, setKommentarOffen] = useState<string | null>(null);

  // "Position empfehlen"
  const [ergBezeichnung, setErgBezeichnung] = useState("");
  const [ergMenge, setErgMenge] = useState("1");
  const [ergText, setErgText] = useState("");
  const [ergArtikelId, setErgArtikelId] = useState("");

  const hatDetail = useRef(false);
  const laden = useCallback(async () => {
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        const text = json?.error ?? "Laden fehlgeschlagen";
        // Schon angezeigt: Stand bleibt stehen, Fehler als Toast (nie still).
        if (hatDetail.current) toast.error(`Aktualisieren fehlgeschlagen: ${text}`);
        setFehler({ status: res.status, text });
        return;
      }
      setFehler(null);
      hatDetail.current = true;
      setDetail(json as Detail);
    } catch {
      if (hatDetail.current) toast.error("Aktualisieren fehlgeschlagen: Netzwerkfehler");
      setFehler({ status: 0, text: "Netzwerkfehler" });
    }
  }, [jobId]);

  useEffect(() => { void laden(); }, [laden]);

  // Plan separat laden — er ist optional und soll das Review nie blockieren.
  const planLaden = useCallback(async () => {
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}/plan`);
      const json = await res.json().catch(() => null);
      if (json?.success) setPlan(json as PlanDaten);
    } catch {
      // Plan ist Zusatz — fehlt er, fehlt nur die Sektion.
    }
  }, [jobId]);
  useEffect(() => { void planLaden(); }, [planLaden]);

  const angeboteLaden = useCallback(async () => {
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}/angebot`);
      const json = await res.json().catch(() => null);
      if (json?.success) setAngebote(json.angebote as Angebot[]);
    } catch {
      // Zusatz — die Sektion zeigt dann «noch kein Angebot».
    }
  }, [jobId]);
  useEffect(() => { void angeboteLaden(); }, [angeboteLaden]);

  // Zurueck im Fenster → frisch laden (Antworten/Aenderungen von EVENTLINE).
  // Laufende Eingaben bleiben stehen (eigene States), nur die Daten wechseln.
  useEffect(() => {
    let zuletzt = Date.now();
    const auffrischen = () => {
      if (document.visibilityState !== "visible" || Date.now() - zuletzt < 5000) return;
      zuletzt = Date.now();
      void laden();
      void angeboteLaden();
      void planLaden();
    };
    window.addEventListener("focus", auffrischen);
    document.addEventListener("visibilitychange", auffrischen);
    return () => {
      window.removeEventListener("focus", auffrischen);
      document.removeEventListener("visibilitychange", auffrischen);
    };
  }, [laden, angeboteLaden, planLaden]);

  async function postAngebot(payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const res = await fetch(`/api/lieferant/anfragen/${jobId}/angebot`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json?.success) {
      toast.error((json?.error as string | undefined) ?? "Upload fehlgeschlagen");
      return null;
    }
    return json;
  }

  /** Angebot hochladen: Direkt-Upload in den Storage (signierte URL vom
   *  Server — an Vercel vorbei, grosse PDFs gehen so durch), danach prueft
   *  der Server die Datei und legt sie am Auftrag ab. */
  async function angebotHochladen(files: FileList | null) {
    const file = files?.[0];
    if (!file || angebotBusy) return;
    const name = /\.pdf$/i.test(file.name) ? file.name : `${file.name}.pdf`;
    if (file.type && file.type !== "application/pdf") { toast.error("Bitte ein PDF hochladen"); return; }
    if (file.size === 0) { toast.error("Die Datei ist leer"); return; }
    if (file.size > MAX_ANGEBOT_BYTES) { toast.error("Datei zu gross (max. 20 MB)"); return; }
    setAngebotBusy(true);
    try {
      const start = await postAngebot({ schritt: "start", name, groesse: file.size });
      if (!start) return;
      const { error: upErr } = await supabase.storage
        .from("documents")
        .uploadToSignedUrl(String(start.pfad), String(start.token), file, { contentType: "application/pdf" });
      if (upErr) {
        toast.error(`Upload fehlgeschlagen: ${upErr.message}`);
        return;
      }
      const fertig = await postAngebot({ schritt: "fertig", pfad: start.pfad, name });
      if (!fertig) return;
      toast.success("Angebot übermittelt — EVENTLINE wurde benachrichtigt");
      await angeboteLaden();
    } catch {
      toast.error("Netzwerkfehler beim Upload");
    } finally {
      setAngebotBusy(false);
      if (angebotFileRef.current) angebotFileRef.current.value = "";
    }
  }

  async function post(payload: Record<string, unknown>, busyKey: string, erfolg?: string): Promise<Record<string, unknown> | null> {
    setBusy(busyKey);
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Speichern fehlgeschlagen");
        return null;
      }
      await laden();
      if (erfolg) toast.success(erfolg);
      return json;
    } catch {
      toast.error("Netzwerkfehler");
      return null;
    } finally {
      setBusy(null);
    }
  }

  function formOeffnen(positionId: string | null, art: ReviewArt) {
    setForm({ positionId, art });
    setFormText("");
    setFormVorschlagTyp("keiner");
    setFormMenge("");
    setFormErsatz("");
  }

  async function formSenden() {
    if (!form || !formText.trim()) return;
    let vorschlag: ReviewVorschlag | undefined;
    if (form.art === "empfehlung" && form.positionId) {
      if (formVorschlagTyp === "menge") {
        const menge = ganzeMenge(formMenge);
        if (!menge) { toast.error("Menge muss eine ganze Zahl ab 1 sein"); return; }
        vorschlag = { typ: "menge", menge };
      } else if (formVorschlagTyp === "ersatz") {
        if (!formErsatz.trim()) { toast.error("Alternative Bezeichnung angeben"); return; }
        let menge: number | undefined;
        if (formMenge.trim()) {
          const m = ganzeMenge(formMenge);
          if (!m) { toast.error("Menge muss eine ganze Zahl ab 1 sein"); return; }
          menge = m;
        }
        vorschlag = { typ: "ersatz", bezeichnung: formErsatz.trim(), menge };
      }
    }
    const ok = await post(
      { aktion: "review", positionId: form.positionId ?? undefined, art: form.art, text: formText.trim(), vorschlag },
      "form",
      `${REVIEW_ART_LABEL[form.art]} gesendet`,
    );
    if (ok) setForm(null);
  }

  async function positionErgaenzen() {
    const bez = ergBezeichnung.trim();
    const menge = ganzeMenge(ergMenge);
    if (!bez || !menge) {
      toast.error("Bezeichnung und ganze Menge ab 1 angeben");
      return;
    }
    const artikel = detail?.katalog.find((k) => k.id === ergArtikelId);
    const ok = await post({
      aktion: "review",
      art: "empfehlung",
      text: ergText.trim() || `Ich empfehle zusätzlich: ${menge}× ${bez}`,
      vorschlag: {
        typ: "neue_position",
        bezeichnung: bez,
        menge,
        kategorie: artikel?.hauptkategorie,
        artikel_id: ergArtikelId || undefined,
      },
    }, "ergaenzen", "Empfehlung gesendet");
    if (ok) {
      setErgBezeichnung("");
      setErgMenge("1");
      setErgText("");
      setErgArtikelId("");
    }
  }

  async function alleBestaetigen(offen: number) {
    const ok = await confirm({
      title: "Alle Positionen bestätigen?",
      message: `${offen} offene ${offen === 1 ? "Position wird" : "Positionen werden"} als «passt so» bestätigt — EVENTLINE verlässt sich darauf.`,
      confirmLabel: "Alle bestätigen",
      variant: "blue",
    });
    if (!ok) return;
    const json = await post({ aktion: "alle_bestaetigen" }, "alle");
    if (json) {
      const n = Number(json.anzahl ?? 0);
      toast.success(n === 0 ? "Es war schon alles bestätigt" : `${anzahl(n, "Position", "Positionen")} bestätigt`);
    }
  }

  const kategorien = useMemo(() => {
    const set = new Set<string>();
    detail?.positionen.forEach((p) => set.add(p.kategorie));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
  }, [detail?.positionen]);

  if (fehler && !detail) {
    const keinZugriff = fehler.status === 403 || fehler.status === 404;
    return (
      <div className="space-y-4 page-enter">
        <Card className="bg-card border-dashed">
          <CardContent className="p-0">
            <EmptyState
              icon={keinZugriff ? ShieldOff : AlertTriangle}
              title={keinZugriff ? "Keine Anfrage für dich" : "Anfrage konnte nicht geladen werden"}
              description={keinZugriff
                ? "Diese Anfrage gibt es nicht (mehr) oder EVENTLINE hat sie dir noch nicht gesendet. Sobald eine Anfrage für dich bereitsteht, erscheint sie unter «Anfragen»."
                : `${fehler.text} — bitte später erneut versuchen.`}
              action={
                <button type="button" onClick={() => router.push("/lieferant/anfragen")} className="kasten kasten-muted">
                  <ArrowLeft className="h-3.5 w-3.5" /> Zu den Anfragen
                </button>
              }
            />
          </CardContent>
        </Card>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="space-y-4 page-enter">
        <div className="h-8 w-40 rounded bg-foreground/10 dark:bg-foreground/15 animate-pulse" />
        <Skeleton className="h-40 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const { job, positionen, reviews, kommentare } = detail;
  const nurLesen = detail.gesperrt;
  const offenePositionen = positionen.filter((p) => p.status !== "bestaetigt");
  const allgemeineReviews = reviews.filter((r) => r.position_id === null);
  const stand = technikStand(positionen, reviews);
  const zeitraum = zeitraumText(job.startDate, job.endDate);
  const markiert = positionen.filter((p) => positionMarker(p, detail.aenderungsBasis)).length;

  return (
    <div className="space-y-4 page-enter">
      {/* Kopf: Zurueck, Nummer, Titel — Rahmen und Titelgroesse wie die
          anderen Portal-Seiten (keine eigene max-w, nichts springt). */}
      <div className="flex items-center gap-3">
        <ZurueckKnopf onClick={() => router.push("/lieferant/anfragen")} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {job.jobNumber && (
              <span className="text-[10px] font-mono text-muted-foreground bg-foreground/[0.05] dark:bg-foreground/10 px-1.5 py-0.5 rounded">
                INT-{job.jobNumber}
              </span>
            )}
            {nurLesen && <AnfrageStatusBadge status={job.status === "storniert" ? "storniert" : "abgeschlossen"} />}
            {detail.runden > 1 && <span className="text-[11px] text-muted-foreground">Runde {detail.runden}</span>}
          </div>
          <h1 className="mt-1 min-w-0 text-2xl font-bold tracking-tight truncate">{job.titel}</h1>
        </div>
      </div>

      {nurLesen && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/50 dark:bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {job.status === "storniert"
            ? "Dieser Auftrag ist storniert — Rückmeldungen sind nicht mehr möglich."
            : "Dieser Auftrag ist abgeschlossen — Rückmeldungen sind nicht mehr möglich."}
        </div>
      )}

      {/* Alles zum Auftrag (ohne Preise) — fuer die Einschaetzung der Technik */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
            <InfoFeld label="Datum & Zeit" icon={<CalendarClock className="h-3.5 w-3.5" />}>{zeitraum ?? "—"}</InfoFeld>
            <InfoFeld label="Ort" icon={<MapPin className="h-3.5 w-3.5" />}>
              {job.ort.name || job.ort.adresse
                ? <>{job.ort.name && <span className="block">{job.ort.name}</span>}{job.ort.adresse && <span className="block text-muted-foreground">{job.ort.adresse}</span>}</>
                : "—"}
            </InfoFeld>
            <InfoFeld label="Kunde" icon={<Building2 className="h-3.5 w-3.5" />}>{job.kunde ?? "—"}</InfoFeld>
            <InfoFeld label="Anlass" icon={<Users className="h-3.5 w-3.5" />}>
              {[job.eventTyp, job.gaeste != null ? `${job.gaeste} Gäste` : null].filter(Boolean).join(" · ") || "—"}
            </InfoFeld>
            <InfoFeld label="Ansprechperson EVENTLINE" icon={<UserRound className="h-3.5 w-3.5" />}>
              {job.ansprechperson ? (
                <>
                  <span className="block">{job.ansprechperson.name ?? "—"}</span>
                  {job.ansprechperson.telefon && (
                    <a href={`tel:${job.ansprechperson.telefon.replace(/\s+/g, "")}`} className="block w-fit text-blue-600 dark:text-blue-400 underline underline-offset-2">{job.ansprechperson.telefon}</a>
                  )}
                  {job.ansprechperson.email && (
                    <a href={`mailto:${job.ansprechperson.email}`} className="block w-fit max-w-full text-blue-600 dark:text-blue-400 underline underline-offset-2 truncate">{job.ansprechperson.email}</a>
                  )}
                </>
              ) : "—"}
            </InfoFeld>
            {job.termine.length > 0 && (
              <InfoFeld label="Termine" icon={<CalendarClock className="h-3.5 w-3.5" />}>
                <ul className="space-y-0.5">
                  {job.termine.map((t) => (
                    <li key={t.id}><span className="font-medium">{t.title}</span>{zeitraumText(t.start_time, t.end_time) ? <span className="text-muted-foreground"> · {zeitraumText(t.start_time, t.end_time)}</span> : null}</li>
                  ))}
                </ul>
              </InfoFeld>
            )}
          </div>
          {(job.beschreibung || job.notizen) && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2.5 text-sm pt-2 border-t border-border/60">
              {job.beschreibung && <InfoFeld label="Beschreibung"><span className="whitespace-pre-wrap break-words">{job.beschreibung}</span></InfoFeld>}
              {job.notizen && <InfoFeld label="Notizen"><span className="whitespace-pre-wrap break-words">{job.notizen}</span></InfoFeld>}
            </div>
          )}
          {detail.anforderungen.length > 0 && (
            <div className="pt-2 border-t border-border/60">
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                <ListChecks className="h-3.5 w-3.5" /> Kundenwünsche
              </p>
              <ul className="space-y-0.5">
                {detail.anforderungen.map((a) => (
                  <li key={a.id} className="text-sm flex gap-2"><span className="text-muted-foreground">•</span><span className="break-words min-w-0">{a.text}</span></li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {(markiert > 0 || detail.entferntSeitAnfrage.length > 0) && !nurLesen && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          <RefreshCw className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Seit der {detail.runden > 1 ? "letzten" : "ersten"} Anfrage geändert:{" "}
            {markiert > 0 && <>{anzahl(markiert, "Position ist", "Positionen sind")} als «Neu» oder «Geändert» markiert</>}
            {markiert > 0 && detail.entferntSeitAnfrage.length > 0 && "; "}
            {detail.entferntSeitAnfrage.length > 0 && <>entfernt: {detail.entferntSeitAnfrage.join(", ")}</>}
            .
          </span>
        </div>
      )}

      {/* Technikplan */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Technikplan prüfen</p>
            <div className="flex items-center gap-2 flex-wrap">
              <StandChips stand={stand} />
              {!nurLesen && offenePositionen.length > 0 && (
                <button
                  type="button"
                  onClick={() => void alleBestaetigen(offenePositionen.length)}
                  disabled={busy !== null}
                  className="kasten kasten-green"
                  data-tooltip="Alle noch offenen Positionen als «passt so» bestätigen"
                >
                  {busy === "alle" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                  {busy === "alle" ? "Wird bestätigt…" : "Alle bestätigen"}
                </button>
              )}
            </div>
          </div>

          {positionen.length === 0 && (
            <p className="text-xs text-muted-foreground italic">EVENTLINE hat noch keine Positionen erfasst.</p>
          )}

          {kategorien.map((kat) => (
            <div key={kat} className="space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{kat}</p>
              {positionen.filter((p) => p.kategorie === kat).map((pos) => {
                const posReviews = reviews.filter((r) => r.position_id === pos.id);
                const posKommentare = kommentare.filter((k) => k.position_id === pos.id && !k.review_id);
                const ampel = positionAmpel(pos, posReviews);
                const pBusy = busy === `pos_${pos.id}`;
                const formHier = form?.positionId === pos.id;
                const marker = positionMarker(pos, detail.aenderungsBasis);
                return (
                  <div key={pos.id} className="rounded-lg border border-border/60">
                    <div className="flex items-center gap-2 px-2.5 py-2 flex-wrap">
                      <AmpelDot ampel={ampel} title={AMPEL_LABEL[ampel]} />
                      <span className="text-sm font-semibold tabular-nums">{pos.menge}×</span>
                      <span className="text-sm flex-1 min-w-0 break-words">
                        {pos.bezeichnung}
                        {pos.details && <span className="text-xs text-muted-foreground"> — {pos.details}</span>}
                      </span>
                      {marker && <MarkerChip marker={marker} />}
                      {pos.status === "bestaetigt" ? (
                        <BestaetigtHaken von={pos.bestaetigt_von} am={pos.bestaetigt_at} lieferantName={detail.lieferant} />
                      ) : !nurLesen && (
                        <button
                          type="button"
                          onClick={() => void post({ aktion: "bestaetigen", positionId: pos.id }, `pos_${pos.id}`)}
                          disabled={busy !== null}
                          className="kasten kasten-green"
                          data-tooltip="Passt so — bestätigen"
                        >
                          {pBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          Passt
                        </button>
                      )}
                      {!nurLesen && (
                        <span className="flex items-center gap-0.5 shrink-0">
                          <button type="button" onClick={() => formOeffnen(pos.id, "empfehlung")} className="icon-btn icon-btn-muted text-amber-600 dark:text-amber-400" data-tooltip="Empfehlung abgeben" aria-label="Empfehlung abgeben">
                            <Lightbulb className="h-4 w-4" />
                          </button>
                          <button type="button" onClick={() => formOeffnen(pos.id, "problem")} className="icon-btn icon-btn-red text-red-500" data-tooltip="Problem melden" aria-label="Problem melden">
                            <AlertTriangle className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setKommentarOffen(kommentarOffen === pos.id ? null : pos.id)}
                            className={`icon-btn icon-btn-blue ${posKommentare.length > 0 ? "text-blue-500" : ""}`}
                            data-tooltip="Kommentar oder Frage"
                            aria-label="Kommentar oder Frage"
                          >
                            <MessageSquare className="h-4 w-4" />
                          </button>
                        </span>
                      )}
                      {nurLesen && posKommentare.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setKommentarOffen(kommentarOffen === pos.id ? null : pos.id)}
                          className="icon-btn icon-btn-blue text-blue-500"
                          data-tooltip="Kommentare"
                          aria-label="Kommentare"
                        >
                          <MessageSquare className="h-4 w-4" />
                        </button>
                      )}
                    </div>

                    {formHier && form && !nurLesen && (
                      <ReviewForm
                        art={form.art}
                        text={formText}
                        setText={setFormText}
                        vorschlagTyp={formVorschlagTyp}
                        setVorschlagTyp={setFormVorschlagTyp}
                        menge={formMenge}
                        setMenge={setFormMenge}
                        ersatz={formErsatz}
                        setErsatz={setFormErsatz}
                        aktuelleMenge={pos.menge}
                        busy={busy === "form"}
                        onSenden={() => void formSenden()}
                        onAbbrechen={() => setForm(null)}
                      />
                    )}

                    {(posReviews.length > 0 || kommentarOffen === pos.id) && (
                      <div className="border-t border-border/60 px-2.5 py-2 space-y-2">
                        {posReviews.map((r) => (
                          <PortalReviewAnzeige
                            key={r.id}
                            review={r}
                            kommentare={kommentare.filter((k) => k.review_id === r.id)}
                            nurLesen={nurLesen}
                            onReply={async (body) => (await post({ aktion: "kommentar", reviewId: r.id, positionId: pos.id, body }, `kom_${r.id}`)) !== null}
                          />
                        ))}
                        {kommentarOffen === pos.id && (
                          <KommentarThread
                            kommentare={posKommentare}
                            onSend={async (body) => (await post({ aktion: "kommentar", positionId: pos.id, body }, `kom_${pos.id}`)) !== null}
                            placeholder="Kommentar oder Frage an EVENTLINE…"
                            nurLesen={nurLesen}
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Position empfehlen */}
          {!nurLesen && (
            <div className="pt-2 border-t border-border/60 space-y-1.5">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Fehlt etwas? Position empfehlen</p>
              <div className="flex items-end gap-1.5 flex-wrap">
                {detail.katalog.length > 0 && (
                  <div className="w-56 max-w-full">
                    <SearchableSelect
                      value={ergArtikelId}
                      onChange={(id) => {
                        setErgArtikelId(id);
                        const a = detail.katalog.find((k) => k.id === id);
                        if (a) setErgBezeichnung(a.name);
                      }}
                      items={detail.katalog.map((a) => ({ id: a.id, label: a.name, sub: a.hauptkategorie }))}
                      placeholder="Aus meinem Katalog…"
                    />
                  </div>
                )}
                <input
                  type="text"
                  value={ergBezeichnung}
                  onChange={(e) => { setErgBezeichnung(e.target.value); setErgArtikelId(""); }}
                  maxLength={200}
                  placeholder="Bezeichnung"
                  className="flex-1 min-w-[140px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
                />
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={ergMenge}
                  onChange={(e) => setErgMenge(e.target.value)}
                  aria-label="Menge"
                  className="w-16 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
                />
              </div>
              <input
                type="text"
                value={ergText}
                onChange={(e) => setErgText(e.target.value)}
                maxLength={4000}
                placeholder="Warum? (z.B. «ohne Subwoofer trägt der Bass bei 500 Gästen nicht»)"
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <button
                type="button"
                onClick={() => void positionErgaenzen()}
                disabled={busy !== null || !ergBezeichnung.trim()}
                className="kasten kasten-blue"
              >
                {busy === "ergaenzen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Als Empfehlung senden
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Raumplan (read-only) — OFFEN wenn vorhanden: die Skizze ist fuer
          den Lieferanten das Wichtigste ("darauf kann ich die noetigen
          Schluesse ziehen", Philippe-Mail 2026-09-24). */}
      {plan?.hatPlan && plan.unterlageUrl && plan.breitePx && plan.hoehePx && (
        <Sektion
          icon={<MapPin className="h-3.5 w-3.5" />}
          titel="Raumplan"
          zusatz={plan.ppm ? "Anmerkungen dazu als allgemeinen Punkt melden" : "ohne Massstab — Messen nicht möglich"}
          defaultOffen
        >
          <PlanViewer
            unterlageUrl={plan.unterlageUrl}
            breitePx={plan.breitePx}
            hoehePx={plan.hoehePx}
            ppm={plan.ppm ?? null}
            objekte={plan.objekte ?? []}
            positionen={plan.positionen ?? []}
          />
        </Sektion>
      )}

      {/* Allgemeine Punkte */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Allgemeine Punkte</p>
            {!nurLesen && (
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => formOeffnen(null, "empfehlung")} className="kasten kasten-muted"><Lightbulb className="h-3.5 w-3.5" />Empfehlung</button>
                <button type="button" onClick={() => formOeffnen(null, "problem")} className="kasten kasten-muted"><AlertTriangle className="h-3.5 w-3.5" />Problem</button>
              </div>
            )}
          </div>
          {form && form.positionId === null && !nurLesen && (
            <ReviewForm
              art={form.art}
              text={formText}
              setText={setFormText}
              vorschlagTyp="keiner"
              setVorschlagTyp={() => {}}
              menge=""
              setMenge={() => {}}
              ersatz=""
              setErsatz={() => {}}
              aktuelleMenge={null}
              busy={busy === "form"}
              onSenden={() => void formSenden()}
              onAbbrechen={() => setForm(null)}
            />
          )}
          {allgemeineReviews.length === 0 && !form && (
            <p className="text-xs text-muted-foreground italic">Nichts Allgemeines gemeldet — z.B. Strom, Rigging, Anlieferung, Zeitplan.</p>
          )}
          {allgemeineReviews.map((r) => (
            <PortalReviewAnzeige
              key={r.id}
              review={r}
              kommentare={kommentare.filter((k) => k.review_id === r.id)}
              nurLesen={nurLesen}
              onReply={async (body) => (await post({ aktion: "kommentar", reviewId: r.id, body }, `kom_${r.id}`)) !== null}
            />
          ))}
        </CardContent>
      </Card>

      {/* Angebot — PDF-Upload (Philippe: "ich sende Euch das Angebot"). */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <FileText className="h-3.5 w-3.5" /> Angebot
            </p>
            {!nurLesen && (
              <>
                <button
                  type="button"
                  onClick={() => angebotFileRef.current?.click()}
                  disabled={angebotBusy}
                  className="kasten kasten-blue"
                  data-tooltip="Dein Angebot als PDF (max. 20 MB) — landet direkt bei EVENTLINE am Auftrag"
                >
                  {angebotBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
                  {angebotBusy ? "Wird hochgeladen…" : "Angebot hochladen (PDF)"}
                </button>
                <input
                  ref={angebotFileRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => void angebotHochladen(e.target.files)}
                />
              </>
            )}
          </div>
          {(angebote?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              {nurLesen ? "Kein Angebot übermittelt." : "Noch kein Angebot übermittelt — sobald die Planung für dich steht, lade dein Angebot hier hoch."}
            </p>
          ) : (
            <div className="space-y-1">
              {angebote!.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => a.url && setAngebotOffen({ url: a.url, name: a.name })}
                  disabled={!a.url}
                  className="row-hover w-full flex items-center gap-2 text-sm rounded-lg px-1.5 py-1 text-left"
                  data-tooltip="Angebot ansehen"
                >
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{a.name}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{formatDateTimeFull(a.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Aktivitaet — immer eingeklappt beim Betreten. */}
      <Sektion
        icon={<ActivityIcon className="h-3.5 w-3.5" />}
        titel="Aktivität"
        zusatz={detail.aktivitaet.length > 0
          ? `${anzahl(detail.aktivitaet.length, "Eintrag", "Einträge")} · zuletzt ${formatDateTimeFull(detail.aktivitaet[0].created_at)}`
          : "noch keine"}
      >
        <AktivitaetListe items={detail.aktivitaet} />
      </Sektion>
      {angebotOffen && (
        <PdfPopup url={angebotOffen.url} title={angebotOffen.name} onClose={() => setAngebotOffen(null)} />
      )}
      {ConfirmModalElement}
    </div>
  );
}

// ===========================================================================

/** Zurueck-Knopf wie im Partnerportal-Kopf (Icon), Hover state-driven (§3). */
function ZurueckKnopf({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="p-2 rounded-lg transition-colors shrink-0"
      style={{ backgroundColor: hover ? "color-mix(in oklab, var(--foreground) 8%, transparent)" : undefined }}
      aria-label="Zurück zu den Anfragen"
      data-tooltip="Zurück zu den Anfragen"
    >
      <ArrowLeft className="h-5 w-5" />
    </button>
  );
}

function InfoFeld({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {label}
      </p>
      <div className="mt-0.5 min-w-0 break-words">{children}</div>
    </div>
  );
}

function ReviewForm({
  art, text, setText, vorschlagTyp, setVorschlagTyp, menge, setMenge, ersatz, setErsatz,
  aktuelleMenge, busy, onSenden, onAbbrechen,
}: {
  art: ReviewArt;
  text: string;
  setText: (v: string) => void;
  vorschlagTyp: "keiner" | "menge" | "ersatz";
  setVorschlagTyp: (v: "keiner" | "menge" | "ersatz") => void;
  menge: string;
  setMenge: (v: string) => void;
  ersatz: string;
  setErsatz: (v: string) => void;
  aktuelleMenge: number | null;
  busy: boolean;
  onSenden: () => void;
  onAbbrechen: () => void;
}) {
  const s = REVIEW_STYLES[art];
  return (
    <div className={`border-t border-border/60 px-2.5 py-2 space-y-1.5 ${s.box}`}>
      <ReviewArtChip art={art} />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={art === "empfehlung" ? "Was empfiehlst du, und warum?" : "Was funktioniert so nicht?"}
        rows={2}
        maxLength={4000}
        autoFocus
        className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
      />
      {art === "empfehlung" && aktuelleMenge !== null && (
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="text-muted-foreground">Konkreter Vorschlag (übernehmbar mit einem Klick):</span>
          {(["keiner", "menge", "ersatz"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setVorschlagTyp(t)}
              className={`kasten ${vorschlagTyp === t ? "kasten-active" : "kasten-muted"}`}
            >
              {t === "keiner" ? "Nur Text" : t === "menge" ? "Menge ändern" : "Alternative"}
            </button>
          ))}
          {vorschlagTyp === "menge" && (
            <input
              type="number"
              min={1}
              step={1}
              value={menge}
              onChange={(e) => setMenge(e.target.value)}
              placeholder={`statt ${aktuelleMenge}`}
              aria-label="Neue Menge"
              className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
            />
          )}
          {vorschlagTyp === "ersatz" && (
            <>
              <input
                type="text"
                value={ersatz}
                onChange={(e) => setErsatz(e.target.value)}
                maxLength={200}
                placeholder="Alternative Bezeichnung"
                className="flex-1 min-w-[140px] rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
              <input
                type="number"
                min={1}
                step={1}
                value={menge}
                onChange={(e) => setMenge(e.target.value)}
                placeholder="Menge"
                aria-label="Menge der Alternative"
                className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onSenden} disabled={busy || !text.trim()} className="kasten kasten-blue">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {busy ? "Wird gesendet…" : "Senden"}
        </button>
        <button type="button" onClick={onAbbrechen} disabled={busy} className="kasten kasten-muted">Abbrechen</button>
      </div>
    </div>
  );
}

function PortalReviewAnzeige({
  review, kommentare, nurLesen, onReply,
}: {
  review: TechnikReview;
  kommentare: TechnikKommentar[];
  nurLesen: boolean;
  onReply: (body: string) => Promise<boolean>;
}) {
  const [antworten, setAntworten] = useState(false);
  const s = REVIEW_STYLES[review.art];
  // Entschiedene Punkte sind abgeschlossen: Verlauf lesbar, keine Antwort
  // mehr (wie im Technik-Tab der Firma; Weiteres als Kommentar an der Position).
  const offen = review.status === "offen";
  return (
    <div className={`rounded-lg border px-2.5 py-2 space-y-1.5 ${s.box}`}>
      <div className="flex items-start gap-2 flex-wrap">
        <ReviewArtChip art={review.art} />
        <p className={`text-xs flex-1 min-w-0 whitespace-pre-wrap break-words ${s.text}`}>{review.text}</p>
        <ReviewStatusChip status={review.status} />
      </div>
      {(kommentare.length > 0 || antworten) ? (
        <KommentarThread
          kommentare={kommentare}
          onSend={async (b) => {
            const ok = await onReply(b);
            if (ok) setAntworten(false);
            return ok;
          }}
          nurLesen={nurLesen || !offen}
        />
      ) : !nurLesen && offen && (
        <button type="button" onClick={() => setAntworten(true)} className="kasten kasten-muted">
          <MessageSquare className="h-3.5 w-3.5" />
          Antworten
        </button>
      )}
    </div>
  );
}
