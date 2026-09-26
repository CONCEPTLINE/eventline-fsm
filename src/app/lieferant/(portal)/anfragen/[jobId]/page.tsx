"use client";

// Lieferantenportal → Anfrage-Detail: das Technik-Review.
// Der Lieferant prueft die Planung von EVENTLINE Position fuer Position:
//   Passt (bestaetigen) · Empfehlung (mit Ein-Klick-Vorschlag) ·
//   Problem · Frage · Kommentar — plus "Position ergaenzen" und
//   allgemeine Punkte. Wenige Klicks, alles inline.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchableSelect } from "@/components/searchable-select";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import {
  ArrowLeft, Check, CheckCheck, Loader2, MapPin, Users, MessageSquare, Plus,
  Lightbulb, AlertTriangle, HelpCircle, ListChecks, Activity as ActivityIcon,
  FileUp, FileText, Download,
} from "lucide-react";
import type {
  TechnikAnforderung, TechnikAktivitaet, TechnikKommentar, TechnikPosition,
  TechnikReview, ReviewArt, ReviewVorschlag,
} from "@/lib/technik";
import { positionAmpel, REVIEW_ART_LABEL } from "@/lib/technik";
import { PlanViewer, type ViewerMaterial, type ViewerObjekt } from "@/components/technik/plan-viewer";
import {
  AmpelDot, BestaetigtHaken, KommentarThread, AktivitaetListe,
  ReviewArtChip, ReviewStatusChip, REVIEW_STYLES, Sektion, techDatum, techTag,
} from "@/components/technik/technik-shared";

interface Detail {
  job: {
    id: string; titel: string; jobNumber: number | null;
    startDate: string | null; endDate: string | null;
    gaeste: number | null; eventTyp: string | null; locationName: string | null;
  };
  angefragtAt: string | null;
  anforderungen: TechnikAnforderung[];
  positionen: TechnikPosition[];
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
  ppm?: number;
  objekte?: ViewerObjekt[];
  material?: ViewerMaterial[];
}

export default function LieferantAnfrageDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const { confirm, ConfirmModalElement } = useConfirm();

  const [detail, setDetail] = useState<Detail | null>(null);
  const [plan, setPlan] = useState<PlanDaten | null>(null);
  const [angebote, setAngebote] = useState<Angebot[] | null>(null);
  const [angebotBusy, setAngebotBusy] = useState(false);
  const angebotFileRef = useRef<HTMLInputElement>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Inline-Review-Formular
  const [form, setForm] = useState<FormZiel>(null);
  const [formText, setFormText] = useState("");
  const [formVorschlagTyp, setFormVorschlagTyp] = useState<"keiner" | "menge" | "ersatz">("keiner");
  const [formMenge, setFormMenge] = useState("");
  const [formErsatz, setFormErsatz] = useState("");
  const [kommentarOffen, setKommentarOffen] = useState<string | null>(null);

  // "Position ergaenzen"
  const [ergBezeichnung, setErgBezeichnung] = useState("");
  const [ergMenge, setErgMenge] = useState("1");
  const [ergText, setErgText] = useState("");
  const [ergArtikelId, setErgArtikelId] = useState("");

  const laden = useCallback(async () => {
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}`);
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setFehler(json?.error ?? "Laden fehlgeschlagen");
        return;
      }
      setDetail(json as Detail);
    } catch {
      setFehler("Netzwerkfehler");
    }
  }, [jobId]);

  useEffect(() => { void laden(); }, [laden]);

  // Plan separat laden — er ist optional und soll das Review nie blockieren.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/lieferant/anfragen/${jobId}/plan`);
        const json = await res.json().catch(() => null);
        if (json?.success) setPlan(json as PlanDaten);
      } catch {
        // Plan ist Zusatz — still.
      }
    })();
  }, [jobId]);

  const angeboteLaden = useCallback(async () => {
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}/angebot`);
      const json = await res.json().catch(() => null);
      if (json?.success) setAngebote(json.angebote as Angebot[]);
    } catch {
      // Zusatz — still.
    }
  }, [jobId]);
  useEffect(() => { void angeboteLaden(); }, [angeboteLaden]);

  async function angebotHochladen(files: FileList | null) {
    const file = files?.[0];
    if (!file || angebotBusy) return;
    setAngebotBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/lieferant/anfragen/${jobId}/angebot`, { method: "POST", body: form });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Upload fehlgeschlagen");
        return;
      }
      toast.success("Angebot übermittelt — EVENTLINE wurde benachrichtigt");
      await angeboteLaden();
    } catch {
      toast.error("Netzwerkfehler");
    } finally {
      setAngebotBusy(false);
      if (angebotFileRef.current) angebotFileRef.current.value = "";
    }
  }

  async function post(payload: Record<string, unknown>, busyKey: string, erfolg?: string): Promise<boolean> {
    setBusy(busyKey);
    try {
      const res = await fetch(`/api/lieferant/anfragen/${jobId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Speichern fehlgeschlagen");
        return false;
      }
      await laden();
      if (erfolg) toast.success(erfolg);
      return true;
    } catch {
      toast.error("Netzwerkfehler");
      return false;
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
      if (formVorschlagTyp === "menge" && Number(formMenge) > 0) {
        vorschlag = { typ: "menge", menge: Number(formMenge) };
      } else if (formVorschlagTyp === "ersatz" && formErsatz.trim()) {
        vorschlag = { typ: "ersatz", bezeichnung: formErsatz.trim(), menge: Number(formMenge) > 0 ? Number(formMenge) : undefined };
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
    const menge = Number(ergMenge);
    if (!bez || !Number.isInteger(menge) || menge < 1) {
      toast.error("Bezeichnung und Menge angeben");
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

  const kategorien = useMemo(() => {
    const set = new Set<string>();
    detail?.positionen.forEach((p) => set.add(p.kategorie));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
  }, [detail?.positionen]);

  if (fehler) {
    return (
      <div className="max-w-3xl mx-auto page-enter">
        <p className="text-sm text-red-500">{fehler}</p>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="max-w-3xl mx-auto page-enter space-y-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  const { job, positionen, reviews, kommentare } = detail;
  const offenePositionen = positionen.filter((p) => p.status !== "bestaetigt");
  const datum = job.startDate
    ? job.endDate && techTag(job.endDate) !== techTag(job.startDate)
      ? `${techTag(job.startDate)} – ${techTag(job.endDate)}`
      : techTag(job.startDate)
    : null;
  const allgemeineReviews = reviews.filter((r) => r.position_id === null);

  return (
    <div className="max-w-3xl mx-auto page-enter space-y-4">
      <button type="button" onClick={() => router.push("/lieferant/anfragen")} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Alle Anfragen
      </button>

      {/* Kopf */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div>
            <h1 className="text-lg font-bold">{job.titel}</h1>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
              {job.eventTyp && <span>{job.eventTyp}</span>}
              {datum && <span>{datum}</span>}
              {job.locationName && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{job.locationName}</span>}
              {job.gaeste != null && <span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{job.gaeste} Gäste</span>}
            </div>
          </div>
          {detail.anforderungen.length > 0 && (
            <div>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                <ListChecks className="h-3.5 w-3.5" /> Kundenwünsche
              </p>
              <ul className="space-y-0.5">
                {detail.anforderungen.map((a) => (
                  <li key={a.id} className="text-sm flex gap-2"><span className="text-muted-foreground">•</span>{a.text}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Technikplan */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Technikplan prüfen</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {positionen.length - offenePositionen.length} von {positionen.length} bestätigt
              </span>
              {offenePositionen.length > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Alle Positionen bestätigen?",
                      message: `${offenePositionen.length} offene ${offenePositionen.length === 1 ? "Position wird" : "Positionen werden"} als «passt so» bestätigt — EVENTLINE verlässt sich darauf.`,
                      confirmLabel: "Alle bestätigen",
                    });
                    if (!ok) return;
                    setBusy("alle");
                    try {
                      for (const p of offenePositionen) {
                        await fetch(`/api/lieferant/anfragen/${jobId}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ aktion: "bestaetigen", positionId: p.id }),
                        });
                      }
                      await laden();
                      toast.success("Alle Positionen bestätigt");
                    } finally {
                      setBusy(null);
                    }
                  }}
                  disabled={busy !== null}
                  className="kasten kasten-green"
                  data-tooltip="Alle noch offenen Positionen als «passt so» bestätigen"
                >
                  {busy === "alle" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                  Alle bestätigen
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
                return (
                  <div key={pos.id} className="rounded-lg border border-border/60">
                    <div className="flex items-center gap-2 px-2.5 py-2 flex-wrap">
                      <AmpelDot ampel={ampel} />
                      <span className="text-sm font-semibold tabular-nums">{pos.menge}×</span>
                      <span className="text-sm flex-1 min-w-0">
                        {pos.bezeichnung}
                        {pos.details && <span className="text-xs text-muted-foreground"> — {pos.details}</span>}
                      </span>
                      {pos.status === "bestaetigt" ? (
                        <BestaetigtHaken />
                      ) : (
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
                      <span className="flex items-center gap-0.5 shrink-0">
                        <button type="button" onClick={() => formOeffnen(pos.id, "empfehlung")} className="p-1.5 rounded-lg hover:bg-amber-500/10 text-amber-600 dark:text-amber-400" data-tooltip="Empfehlung abgeben">
                          <Lightbulb className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => formOeffnen(pos.id, "problem")} className="p-1.5 rounded-lg hover:bg-red-500/10 text-red-500" data-tooltip="Problem melden">
                          <AlertTriangle className="h-4 w-4" />
                        </button>
                        <button type="button" onClick={() => formOeffnen(pos.id, "frage")} className="p-1.5 rounded-lg hover:bg-blue-500/10 text-blue-500" data-tooltip="Frage stellen">
                          <HelpCircle className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setKommentarOffen(kommentarOffen === pos.id ? null : pos.id)}
                          className={`p-1.5 rounded-lg hover:bg-foreground/10 ${posKommentare.length > 0 ? "text-blue-500" : "text-muted-foreground"}`}
                          data-tooltip="Kommentar"
                        >
                          <MessageSquare className="h-4 w-4" />
                        </button>
                      </span>
                    </div>

                    {formHier && form && (
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
                            onReply={(body) => post({ aktion: "kommentar", reviewId: r.id, positionId: pos.id, body }, `kom_${r.id}`)}
                          />
                        ))}
                        {kommentarOffen === pos.id && (
                          <KommentarThread
                            kommentare={posKommentare}
                            onSend={async (body) => { await post({ aktion: "kommentar", positionId: pos.id, body }, `kom_${pos.id}`); }}
                            placeholder="Kommentar an EVENTLINE…"
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Position ergaenzen */}
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
                    items={detail.katalog.map((a) => ({ id: a.id, label: a.name, sublabel: a.hauptkategorie }))}
                    placeholder="Aus meinem Katalog…"
                  />
                </div>
              )}
              <input
                type="text"
                value={ergBezeichnung}
                onChange={(e) => { setErgBezeichnung(e.target.value); setErgArtikelId(""); }}
                placeholder="Bezeichnung"
                className="flex-1 min-w-[140px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <input
                type="number"
                min={1}
                value={ergMenge}
                onChange={(e) => setErgMenge(e.target.value)}
                className="w-16 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
            </div>
            <input
              type="text"
              value={ergText}
              onChange={(e) => setErgText(e.target.value)}
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
        </CardContent>
      </Card>

      {/* Raumplan (read-only) — OFFEN wenn vorhanden: die Skizze ist fuer
          den Lieferanten das Wichtigste ("darauf kann ich die noetigen
          Schluesse ziehen", Philippe-Mail 2026-09-24). */}
      {plan?.hatPlan && plan.unterlageUrl && (
        <Sektion icon={<MapPin className="h-3.5 w-3.5" />} titel="Raumplan" zusatz="Anmerkungen dazu als allgemeinen Punkt melden" defaultOffen>
          <PlanViewer
            unterlageUrl={plan.unterlageUrl}
            breitePx={plan.breitePx!}
            hoehePx={plan.hoehePx!}
            ppm={plan.ppm ?? 40}
            objekte={plan.objekte ?? []}
            material={plan.material ?? []}
          />
        </Sektion>
      )}

      {/* Allgemeine Punkte */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Allgemeine Punkte</p>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => formOeffnen(null, "empfehlung")} className="kasten kasten-muted"><Lightbulb className="h-3.5 w-3.5" />Empfehlung</button>
              <button type="button" onClick={() => formOeffnen(null, "problem")} className="kasten kasten-muted"><AlertTriangle className="h-3.5 w-3.5" />Problem</button>
              <button type="button" onClick={() => formOeffnen(null, "frage")} className="kasten kasten-muted"><HelpCircle className="h-3.5 w-3.5" />Frage</button>
            </div>
          </div>
          {form && form.positionId === null && (
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
              onReply={(body) => post({ aktion: "kommentar", reviewId: r.id, body }, `kom_${r.id}`)}
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
            <button
              type="button"
              onClick={() => angebotFileRef.current?.click()}
              disabled={angebotBusy}
              className="kasten kasten-blue"
              data-tooltip="Dein Angebot als PDF — landet direkt bei EVENTLINE am Auftrag"
            >
              {angebotBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
              Angebot hochladen (PDF)
            </button>
            <input
              ref={angebotFileRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => void angebotHochladen(e.target.files)}
            />
          </div>
          {(angebote?.length ?? 0) === 0 ? (
            <p className="text-xs text-muted-foreground italic">
              Noch kein Angebot übermittelt — sobald die Planung für dich steht, lade dein Angebot hier hoch.
            </p>
          ) : (
            <div className="space-y-1">
              {angebote!.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-sm">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{a.name}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{techDatum(a.createdAt)}</span>
                  {a.url && (
                    <a href={a.url} target="_blank" rel="noreferrer" className="kasten kasten-muted shrink-0" data-tooltip="Herunterladen">
                      <Download className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Aktivitaet — immer eingeklappt beim Betreten. */}
      <Sektion
        icon={<ActivityIcon className="h-3.5 w-3.5" />}
        titel="Aktivität"
        zusatz={detail.aktivitaet.length > 0 ? `${detail.aktivitaet.length} Einträge · zuletzt ${techDatum(detail.aktivitaet[0].created_at)}` : "noch keine"}
      >
        <AktivitaetListe items={detail.aktivitaet} />
      </Sektion>
      {ConfirmModalElement}
    </div>
  );
}

// ===========================================================================

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
        placeholder={
          art === "empfehlung" ? "Was empfiehlst du, und warum?"
          : art === "problem" ? "Was funktioniert so nicht?"
          : "Was brauchst du von EVENTLINE?"
        }
        rows={2}
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
              value={menge}
              onChange={(e) => setMenge(e.target.value)}
              placeholder={`statt ${aktuelleMenge}`}
              className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
            />
          )}
          {vorschlagTyp === "ersatz" && (
            <>
              <input
                type="text"
                value={ersatz}
                onChange={(e) => setErsatz(e.target.value)}
                placeholder="Alternative Bezeichnung"
                className="flex-1 min-w-[140px] rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
              <input
                type="number"
                min={1}
                value={menge}
                onChange={(e) => setMenge(e.target.value)}
                placeholder="Menge"
                className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm"
              />
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button type="button" onClick={onSenden} disabled={busy || !text.trim()} className="kasten kasten-blue">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Senden
        </button>
        <button type="button" onClick={onAbbrechen} disabled={busy} className="kasten kasten-muted">Abbrechen</button>
      </div>
    </div>
  );
}

function PortalReviewAnzeige({
  review, kommentare, onReply,
}: {
  review: TechnikReview;
  kommentare: TechnikKommentar[];
  onReply: (body: string) => Promise<boolean>;
}) {
  const [antworten, setAntworten] = useState(false);
  const s = REVIEW_STYLES[review.art];
  return (
    <div className={`rounded-lg border px-2.5 py-2 space-y-1.5 ${s.box}`}>
      <div className="flex items-start gap-2 flex-wrap">
        <ReviewArtChip art={review.art} />
        <p className={`text-xs flex-1 min-w-0 whitespace-pre-wrap ${s.text}`}>{review.text}</p>
        <ReviewStatusChip status={review.status} />
      </div>
      {(kommentare.length > 0 || antworten) ? (
        <KommentarThread kommentare={kommentare} onSend={async (b) => { await onReply(b); setAntworten(false); }} />
      ) : (
        <button type="button" onClick={() => setAntworten(true)} className="text-[11px] text-muted-foreground hover:text-foreground underline">
          Antworten
        </button>
      )}
    </div>
  );
}
