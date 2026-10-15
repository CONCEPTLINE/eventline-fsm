"use client";

// Auftrag → Tab «Technik & Plan» — gemeinsame technische Planung mit dem
// festen Techniklieferanten (Migration 263/264).
//
// Aufbau (kompakt, Mini-Labels statt Card-Inflation):
//   1. Kopf: Techniklieferant + Anfrage senden + Stand. Genau EIN aktiver
//      Lieferant vom Typ «technik» = fest, keine Auswahl; bei keinem oder
//      mehreren ein klarer Hinweis und «Anfrage senden» gesperrt (Leo
//      2026-10-15). Die Zuweisung entsteht erst beim Senden.
//   2. Links: Technikplan (Positionen nach Kategorie, Ampel, Rueckmeldungen
//      inline) + Aufbauplan
//   3. Rechts: Kundenwuensche, allgemeine Punkte, Angebote, Aktivitaet
//
// Alle Mutationen laufen ueber POST /api/jobs/[id]/technik (Aktivitaet,
// Benachrichtigungen, Sperre bei storniert/abgeschlossen zentral); Lesen
// direkt per Client-Supabase (RLS). Platzierungen und Plan-Objekte
// schreibt der Plan-Editor direkt — nur wer bearbeiten darf.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { SearchableSelect } from "@/components/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { PdfPopup } from "@/components/pdf-popup";
import { toast } from "sonner";
import {
  Loader2, Send, Plus, Trash2, Check, Wrench, ListChecks, Activity as ActivityIcon,
  MessageSquare, Sparkles, X, FileText, Map as MapIcon, MapPin, Lock, AlertTriangle, RotateCcw,
} from "lucide-react";
import type {
  LieferantRegel, TechnikAnforderung, TechnikAktivitaet, TechnikKommentar,
  TechnikPosition, TechnikReview,
} from "@/lib/technik";
import { AMPEL_LABEL, passendeRegeln, positionAmpel, technikStand } from "@/lib/technik";
import { PlanEditor, type EditorPosition } from "@/components/plan2d/plan-editor";
import type { PlanUnterlage, PlanPos, PlanObjekt } from "@/lib/plan2d";
import {
  AktivitaetListe, AmpelDot, BestaetigtHaken, KommentarThread, QuelleBadge,
  ReviewArtChip, ReviewStatusChip, REVIEW_STYLES, Sektion, StandChips, anzahl,
} from "@/components/technik/technik-shared";
import { formatDateFull, formatDateTimeFull } from "@/lib/format";

interface KatalogArtikel { id: string; name: string; hauptkategorie: string }
interface Angebot { id: string; name: string; storage_path: string; created_at: string }

/** Technik-Position mit den Plan-/KI-Feldern aus Migration 264. */
interface PositionVoll extends TechnikPosition {
  masse: { l: number | null; b: number | null; h: number | null } | null;
  position: (PlanPos | null)[] | null;
  created_via: "ki" | "manuell";
  quelle_item: { kind: string; content: string | null; file_name: string | null } | null;
}

type AktionsErgebnis = Record<string, unknown> | null;

interface Props {
  jobId: string;
  locationId: string | null;
  jobNumber: number | null;
  canEdit: boolean;
  /** Gesetzt bei storniert/abgeschlossen: alles nur noch lesen. */
  sperrHinweis: string | null;
}

/** Max. platzierbare Stueck je Position im Aufbauplan (Uebersicht). */
const PLAN_STUECK_MAX = 60;

export function TechnikTab({ jobId, locationId, jobNumber, canEdit, sperrHinweis }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();
  const darfBearbeiten = canEdit && !sperrHinweis;

  const [loading, setLoading] = useState(true);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [fest, setFest] = useState<{ id: string; name: string } | null>(null);
  const [festGrund, setFestGrund] = useState<"keiner" | "mehrere" | null>(null);
  const [zuweisung, setZuweisung] = useState<{ angefragtAt: string | null; runden: number } | null>(null);
  const [anforderungen, setAnforderungen] = useState<TechnikAnforderung[]>([]);
  const [positionen, setPositionen] = useState<PositionVoll[]>([]);
  // Aufbauplan (aus dem frueheren "Material & Plan"-Tab uebernommen)
  const [unterlage, setUnterlage] = useState<PlanUnterlage | null>(null);
  const [unterlageUrl, setUnterlageUrl] = useState<string | null>(null);
  const unterlageCache = useRef<{ path: string; url: string; bis: number } | null>(null);
  const [locationName, setLocationName] = useState<string | null>(null);
  const [planObjekte, setPlanObjekte] = useState<PlanObjekt[]>([]);
  const [quelleModal, setQuelleModal] = useState<PositionVoll["quelle_item"] | null>(null);
  const [reviews, setReviews] = useState<TechnikReview[]>([]);
  const [kommentare, setKommentare] = useState<TechnikKommentar[]>([]);
  const [aktivitaet, setAktivitaet] = useState<TechnikAktivitaet[]>([]);
  const [katalog, setKatalog] = useState<KatalogArtikel[]>([]);
  const [regeln, setRegeln] = useState<LieferantRegel[]>([]);
  const katalogVon = useRef<string | null>(null);
  const [angebote, setAngebote] = useState<Angebot[]>([]);
  const [angebotOffen, setAngebotOffen] = useState<{ url: string; name: string } | null>(null);
  const [angebotBusy, setAngebotBusy] = useState<string | null>(null);

  // Eingabe-States
  const [neuerWunsch, setNeuerWunsch] = useState("");
  const [neuBezeichnung, setNeuBezeichnung] = useState("");
  const [neuMenge, setNeuMenge] = useState("1");
  const [neuKategorie, setNeuKategorie] = useState("");
  const [neuArtikelId, setNeuArtikelId] = useState("");
  const [kommentarOffen, setKommentarOffen] = useState<string | null>(null); // position_id
  const [regelHinweise, setRegelHinweise] = useState<LieferantRegel[]>([]);

  /** Laedt den ganzen Tab neu. Fehler werden gemeldet, nie verschluckt —
   *  bei einem Fehler bleibt der bisherige Stand stehen. */
  const laden = useCallback(async (): Promise<boolean> => {
    const [lief, zuw, anf, pos, rev, kom, akt, loc, obj, ang] = await Promise.all([
      supabase.from("lieferanten").select("id, name").eq("is_active", true).eq("type", "technik").order("name").limit(2),
      supabase.from("job_lieferanten").select("lieferant_id, angefragt_at, anfrage_runden").eq("job_id", jobId),
      supabase.from("job_anforderungen").select("id, text, sort").eq("job_id", jobId).order("sort").order("created_at"),
      supabase.from("job_technik_positionen").select("id, artikel_id, kategorie, bezeichnung, details, menge, status, quelle, bestaetigt_at, created_at, masse, position, created_via, quelle_item:job_inbox_items(kind, content, file_name)").eq("job_id", jobId).order("kategorie").order("created_at"),
      supabase.from("job_technik_reviews").select("id, position_id, art, text, vorschlag, status, created_at, entschieden_at").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_kommentare").select("id, position_id, review_id, body, created_at, author:profiles(full_name, role)").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_aktivitaet").select("id, actor_name, aktion, beschreibung, created_at").eq("job_id", jobId).order("created_at", { ascending: false }).limit(100),
      locationId
        ? supabase.from("locations").select("name, plan_unterlage").eq("id", locationId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from("job_plan_objekte").select("id, typ, label, x, y, rot, breite, tiefe").eq("job_id", jobId),
      // Nur Angebote, die der Lieferant im Portal hochgeladen hat (eigener
      // Ablage-Ordner) — Firmen-Uploads im Ordner «Angebote» gehoeren nicht hierher.
      supabase.from("documents").select("id, name, storage_path, created_at").eq("job_id", jobId).eq("folder", "Angebote").like("storage_path", `jobs/${jobId.toLowerCase()}/lieferant-%`).order("created_at", { ascending: false }),
    ]);
    const fehler = [lief, zuw, anf, pos, rev, kom, akt, loc, obj, ang].find((r) => r.error)?.error;
    if (fehler) {
      toast.error(`Technik-Planung konnte nicht geladen werden: ${fehler.message}`);
      return false;
    }

    const technik = (lief.data ?? []) as { id: string; name: string }[];
    const festNeu = technik.length === 1 ? technik[0] : null;
    setFest(festNeu);
    setFestGrund(festNeu ? null : technik.length === 0 ? "keiner" : "mehrere");
    const z = festNeu
      ? ((zuw.data ?? []) as { lieferant_id: string; angefragt_at: string | null; anfrage_runden: number | null }[])
          .find((r) => r.lieferant_id === festNeu.id) ?? null
      : null;
    setZuweisung(z ? { angefragtAt: z.angefragt_at, runden: z.anfrage_runden ?? 0 } : null);
    setAnforderungen((anf.data ?? []) as TechnikAnforderung[]);
    setPositionen(((pos.data ?? []) as unknown as (Omit<PositionVoll, "quelle_item"> & {
      quelle_item: PositionVoll["quelle_item"] | PositionVoll["quelle_item"][] | null;
    })[]).map((p) => ({
      ...p,
      quelle_item: Array.isArray(p.quelle_item) ? (p.quelle_item[0] ?? null) : p.quelle_item,
    })));
    setPlanObjekte((obj.data ?? []) as unknown as PlanObjekt[]);
    setAngebote((ang.data ?? []) as Angebot[]);
    setReviews((rev.data ?? []) as TechnikReview[]);
    setKommentare(((kom.data ?? []) as unknown as {
      id: string; position_id: string | null; review_id: string | null; body: string; created_at: string;
      author: { full_name: string | null; role: string | null } | { full_name: string | null; role: string | null }[] | null;
    }[]).map((k) => {
      const a = Array.isArray(k.author) ? k.author[0] : k.author;
      return {
        id: k.id, position_id: k.position_id, review_id: k.review_id, body: k.body, created_at: k.created_at,
        author_name: a?.full_name ?? null, vom_lieferanten: a?.role === "lieferant",
      };
    }));
    setAktivitaet((akt.data ?? []) as TechnikAktivitaet[]);

    const locRow = loc.data as { name?: string; plan_unterlage?: PlanUnterlage | null } | null;
    setLocationName(locRow?.name ?? null);
    const u = locRow?.plan_unterlage ?? null;
    setUnterlage(u);
    // Saalplan-URL nur neu signieren, wenn die Unterlage wechselt oder die
    // alte bald ablaeuft — nicht bei jeder Aktion (Bild laedt sonst neu).
    if (u?.path) {
      const c = unterlageCache.current;
      if (c && c.path === u.path && c.bis > Date.now()) {
        setUnterlageUrl(c.url);
      } else {
        const { data: s, error: sErr } = await supabase.storage.from("documents").createSignedUrl(u.path, 3600);
        if (sErr || !s?.signedUrl) {
          toast.error("Saalplan konnte nicht geladen werden");
          setUnterlageUrl(null);
        } else {
          unterlageCache.current = { path: u.path, url: s.signedUrl, bis: Date.now() + 50 * 60_000 };
          setUnterlageUrl(s.signedUrl);
        }
      }
    } else {
      setUnterlageUrl(null);
    }

    // Katalog + Regeln des festen Techniklieferanten — Positionen lassen
    // sich so schon vor der ersten Anfrage aus dessen Katalog erfassen.
    // Einmal je Lieferant, nicht bei jeder Aktion neu.
    if ((festNeu?.id ?? null) !== katalogVon.current) {
      if (festNeu) {
        const [kat, reg] = await Promise.all([
          supabase.from("lieferant_katalog_artikel").select("id, name, hauptkategorie").eq("lieferant_id", festNeu.id).eq("is_active", true).order("hauptkategorie").order("name"),
          supabase.from("lieferant_regeln").select("id, art, trigger_text, hinweis, paket, is_active").eq("lieferant_id", festNeu.id),
        ]);
        if (kat.error || reg.error) {
          toast.error("Katalog des Lieferanten konnte nicht geladen werden");
        } else {
          setKatalog((kat.data ?? []) as KatalogArtikel[]);
          setRegeln((reg.data ?? []) as LieferantRegel[]);
          katalogVon.current = festNeu.id;
        }
      } else {
        setKatalog([]);
        setRegeln([]);
        katalogVon.current = null;
      }
    }
    return true;
  }, [supabase, jobId, locationId]);

  const erstLaden = useCallback(async () => {
    setLoading(true);
    const ok = await laden();
    setLadeFehler(!ok);
    setLoading(false);
  }, [laden]);

  useEffect(() => {
    void erstLaden();
  }, [erstLaden]);

  /** Firmen-Aktion ausfuehren; liefert die Antwort oder null (Toast kommt hier). */
  async function aktion(payload: Record<string, unknown>, busyKey: string | null, erfolg?: string): Promise<AktionsErgebnis> {
    if (busyKey) setBusy(busyKey);
    try {
      const res = await fetch(`/api/jobs/${jobId}/technik`, {
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
      if (busyKey) setBusy(null);
    }
  }
  const aktionOk = async (payload: Record<string, unknown>, busyKey: string | null, erfolg?: string) =>
    (await aktion(payload, busyKey, erfolg)) !== null;

  // --- Position hinzufuegen (mit Regel-Check) -----------------------------
  function artikelGewaehlt(id: string) {
    setNeuArtikelId(id);
    const a = katalog.find((k) => k.id === id);
    if (a) {
      setNeuBezeichnung(a.name);
      setNeuKategorie(a.hauptkategorie);
      setRegelHinweise(passendeRegeln(regeln, a.name, a.hauptkategorie));
    }
  }

  async function positionHinzufuegen() {
    const bezeichnung = neuBezeichnung.trim();
    const menge = Number(neuMenge);
    if (!bezeichnung || !Number.isInteger(menge) || menge < 1) {
      toast.error("Bezeichnung und ganze Menge ab 1 angeben");
      return;
    }
    const ok = await aktionOk({
      aktion: "position_neu",
      bezeichnung,
      menge,
      kategorie: neuKategorie.trim() || undefined,
      artikelId: neuArtikelId || undefined,
    }, "pos_neu");
    if (ok) {
      setNeuBezeichnung("");
      setNeuMenge("1");
      setNeuArtikelId("");
      setRegelHinweise(passendeRegeln(regeln, bezeichnung, neuKategorie));
    }
  }

  async function paketUebernehmen(regel: LieferantRegel) {
    if (!regel.paket?.length) return;
    setBusy(`paket_${regel.id}`);
    let fehler = 0;
    try {
      for (const p of regel.paket) {
        try {
          const res = await fetch(`/api/jobs/${jobId}/technik`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ aktion: "position_neu", bezeichnung: p.bezeichnung, menge: p.menge, kategorie: p.kategorie }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.success) fehler++;
        } catch {
          fehler++;
        }
      }
      await laden();
      if (fehler === 0) {
        toast.success(`Paket übernommen (${anzahl(regel.paket.length, "Position", "Positionen")})`);
        setRegelHinweise((prev) => prev.filter((r) => r.id !== regel.id));
      } else {
        toast.error(`${fehler} von ${regel.paket.length} Positionen konnten nicht übernommen werden`);
      }
    } finally {
      setBusy(null);
    }
  }

  async function anfrageSenden() {
    if (!fest) return;
    const ok = await confirm({
      title: zuweisung?.angefragtAt ? "Erneut anfragen?" : "Anfrage senden?",
      message: `«${fest.name}» wird benachrichtigt und sieht die Technik-Planung dieses Auftrags im Lieferantenportal (${anzahl(positionen.length, "Position", "Positionen")}).`,
      confirmLabel: "Anfrage senden",
      variant: "blue",
    });
    if (!ok) return;
    const json = await aktion({ aktion: "anfrage_senden" }, "anfrage");
    if (!json) return;
    if (json.empfaenger === 0) {
      toast.warning(`Anfrage gespeichert — «${fest.name}» hat aber kein aktives Portal-Konto, niemand wurde benachrichtigt.`);
    } else {
      toast.success(`Anfrage an «${fest.name}» gesendet`);
    }
  }

  // --- Aufbauplan (Plan-Editor mit Technik-Positionen) --------------------
  // Stabil: nur neu, wenn sich die Positionen wirklich aendern (laden() oder
  // eine gespeicherte Platzierung) — nicht bei jedem Render (Tippen in einem
  // Feld setzte den Editor sonst auf den alten Stand zurueck).
  const editorPositionen = useMemo<EditorPosition[]>(() => positionen.map((p) => ({
    id: p.id,
    bezeichnung: p.bezeichnung,
    menge: Math.min(Math.max(1, Math.round(p.menge)), PLAN_STUECK_MAX),
    masse: p.masse,
    platzierungen: p.position ?? [],
  })), [positionen]);

  const onPlatzierungen = useCallback(async (positionId: string, platzierungen: (PlanPos | null)[]): Promise<boolean> => {
    const { data, error } = await supabase
      .from("job_technik_positionen")
      .update({ position: platzierungen })
      .eq("id", positionId)
      .eq("job_id", jobId)
      .select("id");
    if (error || !data?.length) {
      toast.error("Platzierung konnte nicht gespeichert werden");
      return false;
    }
    // Eigenen Stand nachfuehren — sonst stuende der Editor-Input weiter auf
    // dem alten DB-Stand.
    setPositionen((prev) => prev.map((p) => (p.id === positionId ? { ...p, position: platzierungen } : p)));
    return true;
  }, [supabase, jobId]);

  const onObjektNeu = useCallback(async (o: Omit<PlanObjekt, "id">): Promise<PlanObjekt | null> => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("job_plan_objekte")
      .insert({ job_id: jobId, ...o, created_by: user?.id ?? null })
      .select("id, typ, label, x, y, rot, breite, tiefe")
      .single();
    if (error || !data) { toast.error("Objekt konnte nicht angelegt werden"); return null; }
    const neu = data as unknown as PlanObjekt;
    setPlanObjekte((prev) => (prev.some((x) => x.id === neu.id) ? prev : [...prev, neu]));
    return neu;
  }, [supabase, jobId]);

  const onObjektUpdate = useCallback(async (id: string, patch: Partial<PlanObjekt>): Promise<boolean> => {
    const { data, error } = await supabase.from("job_plan_objekte").update(patch).eq("id", id).eq("job_id", jobId).select("id");
    if (error || !data?.length) { toast.error("Objekt konnte nicht gespeichert werden"); return false; }
    setPlanObjekte((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    return true;
  }, [supabase, jobId]);

  const onObjektLoeschen = useCallback(async (id: string): Promise<boolean> => {
    try {
      const res = await fetch(`/api/jobs/${jobId}/technik`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aktion: "plan_objekt_loeschen", id }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error ?? "Objekt konnte nicht gelöscht werden");
        return false;
      }
      setPlanObjekte((prev) => prev.filter((x) => x.id !== id));
      return true;
    } catch {
      toast.error("Netzwerkfehler");
      return false;
    }
  }, [jobId]);

  async function angebotOeffnen(a: Angebot) {
    setAngebotBusy(a.id);
    try {
      const { data, error } = await supabase.storage.from("documents").createSignedUrl(a.storage_path, 3600);
      if (error || !data?.signedUrl) { toast.error("Angebot konnte nicht geöffnet werden"); return; }
      setAngebotOffen({ url: data.signedUrl, name: a.name });
    } finally {
      setAngebotBusy(null);
    }
  }

  // --- Gruppierung --------------------------------------------------------
  const kategorien = useMemo(() => {
    const set = new Set<string>();
    positionen.forEach((p) => set.add(p.kategorie));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
  }, [positionen]);

  const stand = useMemo(() => technikStand(positionen, reviews), [positionen, reviews]);
  const allgemeineReviews = reviews.filter((r) => r.position_id === null);
  const platziert = positionen.reduce((n, p) => n + (p.position ?? []).slice(0, PLAN_STUECK_MAX).filter(Boolean).length, 0);
  const anfrageTooltip = !fest
    ? "Kein eindeutiger Techniklieferant hinterlegt"
    : positionen.length === 0
      ? "Zuerst Positionen erfassen"
      : `${fest.name} benachrichtigen — prüft die Planung im Portal`;

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Technik-Planung wird geladen…
      </div>
    );
  }

  if (ladeFehler) {
    return (
      <Card className="bg-card">
        <CardContent className="p-0">
          <EmptyState
            icon={AlertTriangle}
            title="Technik-Planung konnte nicht geladen werden"
            description="Bitte erneut versuchen. Bleibt der Fehler, die Seite neu laden."
            action={
              <button type="button" onClick={() => void erstLaden()} className="kasten kasten-muted">
                <RotateCcw className="h-3.5 w-3.5" /> Erneut laden
              </button>
            }
          />
        </CardContent>
      </Card>
    );
  }

  return (
    // Raster statt Einspalter (Leo 2026-09-24): links die Arbeit
    // (Technikplan + Aufbauplan), rechts die Randinfos (Wuensche, Punkte,
    // Aktivitaet). items-start: Spalten sizen nach Inhalt (§14, kein
    // Zwang-Fuellen); unter lg stapelt alles wieder untereinander.
    <div className="space-y-3">
      {sperrHinweis && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/50 dark:bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {sperrHinweis}
        </div>
      )}

      {/* 1. Kopf: Lieferant + Anfrage + Stand */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <MiniLabel icon={<Wrench className="h-3.5 w-3.5" />}>Techniklieferant</MiniLabel>
            <StandChips stand={stand} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {fest ? (
              <span
                className="inline-flex items-center h-9 px-3 rounded-xl border border-border bg-muted/30 text-sm font-medium"
                data-tooltip={zuweisung?.angefragtAt ? undefined : `${fest.name} sieht den Auftrag im Portal erst, wenn die Anfrage gesendet ist`}
              >
                {fest.name}
              </span>
            ) : (
              <span className="inline-flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300 max-w-xl">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                {festGrund === "mehrere"
                  ? "Kein eindeutiger Techniklieferant hinterlegt — es sind mehrere aktive Lieferanten vom Typ «Technik» erfasst. Bitte unter Lieferanten bereinigen; bis dahin ist «Anfrage senden» gesperrt."
                  : "Kein eindeutiger Techniklieferant hinterlegt — unter Lieferanten genau einen aktiven Lieferanten vom Typ «Technik» erfassen; bis dahin ist «Anfrage senden» gesperrt."}
              </span>
            )}
            {darfBearbeiten && (
              <button
                type="button"
                onClick={() => void anfrageSenden()}
                disabled={busy !== null || !fest || positionen.length === 0}
                className="kasten kasten-blue"
                data-tooltip={anfrageTooltip}
              >
                {busy === "anfrage" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {busy === "anfrage" ? "Wird gesendet…" : zuweisung?.angefragtAt ? "Erneut anfragen" : "Anfrage senden"}
              </button>
            )}
            {zuweisung?.angefragtAt && (
              <span className="text-xs text-muted-foreground">
                {zuweisung.runden > 1 ? `Runde ${zuweisung.runden} · angefragt` : "Angefragt"} am {formatDateTimeFull(zuweisung.angefragtAt)}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-3 items-start">
      {/* ── Linke Hauptspalte: die Arbeit ── */}
      <div className="space-y-3 lg:col-span-2 min-w-0">
      {/* Technikplan */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <MiniLabel icon={<Wrench className="h-3.5 w-3.5" />}>Technikplan</MiniLabel>

          {positionen.length === 0 && (
            <p className="text-xs text-muted-foreground italic">
              Noch keine Positionen. Aus dem Katalog wählen oder frei erfassen — der Lieferant prüft danach alles im Portal.
            </p>
          )}

          {kategorien.map((kat) => (
            <div key={kat} className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{kat}</p>
              {positionen.filter((p) => p.kategorie === kat).map((pos) => (
                <PositionZeile
                  key={pos.id}
                  pos={pos}
                  reviews={reviews.filter((r) => r.position_id === pos.id)}
                  kommentare={kommentare.filter((k) => k.position_id === pos.id && !k.review_id)}
                  reviewKommentare={kommentare}
                  canEdit={darfBearbeiten}
                  busy={busy}
                  kommentarOffen={kommentarOffen === pos.id}
                  onKommentarToggle={() => setKommentarOffen(kommentarOffen === pos.id ? null : pos.id)}
                  onAktion={aktionOk}
                  onKommentar={(body, reviewId) =>
                    aktionOk({ aktion: "kommentar_neu", positionId: pos.id, reviewId, body }, null)}
                  onQuelle={pos.created_via === "ki" && pos.quelle_item ? () => setQuelleModal(pos.quelle_item) : undefined}
                  onConfirmDelete={async () => {
                    const ok = await confirm({
                      title: "Position entfernen?",
                      message: `${pos.menge}× ${pos.bezeichnung} wird aus dem Technikplan entfernt.`,
                      confirmLabel: "Entfernen",
                      variant: "red",
                    });
                    if (ok) void aktionOk({ aktion: "position_loeschen", id: pos.id }, `pos_${pos.id}`);
                  }}
                />
              ))}
            </div>
          ))}

          {/* Regel-Hinweise des Lieferanten (Etappe 3) */}
          {regelHinweise.length > 0 && (
            <div className="space-y-1.5">
              {regelHinweise.map((r) => (
                <div key={r.id} className="flex items-center gap-2 flex-wrap rounded-lg border border-blue-200/70 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-500/10 px-2.5 py-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-blue-600 dark:text-blue-300 shrink-0" />
                  <p className="text-xs text-blue-900 dark:text-blue-100 flex-1 min-w-0">
                    {r.art === "hinweis"
                      ? <>{fest?.name ?? "Lieferant"}: {r.hinweis}</>
                      : <>Dazu gehört laut {fest?.name ?? "Lieferant"}: {r.paket?.map((p) => `${p.menge}× ${p.bezeichnung}`).join(", ")}</>}
                  </p>
                  {r.art === "paket" && darfBearbeiten && (
                    <button
                      type="button"
                      onClick={() => void paketUebernehmen(r)}
                      disabled={busy !== null}
                      className="kasten kasten-blue shrink-0"
                    >
                      {busy === `paket_${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                      Paket übernehmen
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setRegelHinweise((prev) => prev.filter((x) => x.id !== r.id))}
                    className="icon-btn icon-btn-muted shrink-0"
                    data-tooltip="Hinweis ausblenden"
                    aria-label="Hinweis ausblenden"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Hinzufuegen — eine ruhige Zeile, Placeholder statt Labels. */}
          {darfBearbeiten && (
            <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-border/60">
              {katalog.length > 0 && (
                <div className="w-56 max-w-full">
                  <SearchableSelect
                    value={neuArtikelId}
                    onChange={artikelGewaehlt}
                    items={katalog.map((a) => ({ id: a.id, label: a.name, sub: a.hauptkategorie }))}
                    placeholder="Aus Katalog…"
                  />
                </div>
              )}
              <input
                type="text"
                value={neuBezeichnung}
                onChange={(e) => {
                  setNeuBezeichnung(e.target.value);
                  setNeuArtikelId("");
                  setRegelHinweise(passendeRegeln(regeln, e.target.value, neuKategorie));
                }}
                maxLength={200}
                placeholder="Bezeichnung, z.B. Funkmikrofon"
                className="flex-1 min-w-[160px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <input
                type="number"
                min={1}
                step={1}
                value={neuMenge}
                onChange={(e) => setNeuMenge(e.target.value)}
                aria-label="Menge"
                className="w-16 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <input
                type="text"
                value={neuKategorie}
                onChange={(e) => setNeuKategorie(e.target.value)}
                maxLength={200}
                placeholder="Kategorie"
                list="technik-kategorien"
                className="w-36 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <datalist id="technik-kategorien">
                {Array.from(new Set([...katalog.map((k) => k.hauptkategorie), ...kategorien])).map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              <button
                type="button"
                onClick={() => void positionHinzufuegen()}
                disabled={busy !== null || !neuBezeichnung.trim()}
                className="kasten kasten-blue"
              >
                {busy === "pos_neu" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Hinzufügen
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Aufbauplan — schwergewichtig, darum standardmaessig zu. */}
      <Sektion
        icon={<MapIcon className="h-3.5 w-3.5" />}
        titel="Aufbauplan"
        zusatz={[
          locationName,
          unterlage?.px_pro_meter
            ? (platziert > 0 ? `${platziert} platziert` : "noch nichts platziert")
            : "keine kalibrierte Unterlage",
        ].filter(Boolean).join(" · ")}
      >
          {!locationId ? (
            <EmptyState
              icon={MapPin}
              title="Kein Standort hinterlegt"
              description="Dieser Auftrag hat keinen Standort — der Aufbauplan braucht den Saalplan einer Location."
            />
          ) : !unterlage || !unterlageUrl ? (
            <EmptyState
              icon={MapIcon}
              title="Noch keine Plan-Unterlage für diese Location"
              description="Lege in den Location-Details (Abschnitt «Plan-Unterlage») den Saalplan fest und kalibriere den Massstab."
            />
          ) : !unterlage.px_pro_meter ? (
            <EmptyState
              icon={MapIcon}
              title="Massstab fehlt noch"
              description="Die Unterlage ist gesetzt, aber noch nicht kalibriert — in den Location-Details zwei Punkte mit bekannter Distanz anklicken."
            />
          ) : (
            <PlanEditor
              unterlageUrl={unterlageUrl}
              unterlage={unterlage}
              positionen={editorPositionen}
              objekte={planObjekte}
              editierbar={darfBearbeiten}
              hoehe={580}
              onPlatzierungen={onPlatzierungen}
              onObjektNeu={onObjektNeu}
              onObjektUpdate={onObjektUpdate}
              onObjektLoeschen={onObjektLoeschen}
              exportName={`aufbauplan${jobNumber ? `_INT-${jobNumber}` : ""}`}
            />
          )}
      </Sektion>
      </div>

      {/* ── Rechte Seitenspalte: Randinfos ── */}
      <div className="space-y-3 min-w-0">
      <Sektion
        icon={<ListChecks className="h-3.5 w-3.5" />}
        titel="Kundenwünsche"
        zusatz={anforderungen.length > 0 ? `${anforderungen.length}` : "noch keine erfasst"}
        defaultOffen
      >
          {anforderungen.length === 0 && (
            <p className="text-xs text-muted-foreground italic">Noch keine Wünsche erfasst — was hat der Kunde bestellt?</p>
          )}
          <div className="space-y-1">
            {anforderungen.map((a) => (
              <WunschZeile
                key={a.id}
                wunsch={a}
                canEdit={darfBearbeiten}
                onSave={(text) => aktionOk({ aktion: "anforderung_edit", id: a.id, text }, `anf_${a.id}`)}
                onDelete={async () => {
                  const ok = await confirm({
                    title: "Wunsch entfernen?",
                    message: `«${a.text}» wird aus den Kundenwünschen entfernt.`,
                    confirmLabel: "Entfernen",
                    variant: "red",
                  });
                  if (ok) await aktionOk({ aktion: "anforderung_loeschen", id: a.id }, `anf_${a.id}`);
                }}
                busy={busy === `anf_${a.id}`}
              />
            ))}
          </div>
          {darfBearbeiten && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={neuerWunsch}
                onChange={(e) => setNeuerWunsch(e.target.value)}
                maxLength={4000}
                placeholder="Wunsch erfassen…"
                className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <button
                type="button"
                onClick={() => {
                  if (!neuerWunsch.trim()) return;
                  void aktionOk({ aktion: "anforderung_neu", text: neuerWunsch.trim() }, "anf_neu").then((ok) => {
                    if (ok) setNeuerWunsch("");
                  });
                }}
                disabled={busy !== null || !neuerWunsch.trim()}
                className="kasten kasten-muted shrink-0"
                data-tooltip="Wunsch hinzufügen"
                aria-label="Wunsch hinzufügen"
              >
                {busy === "anf_neu" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              </button>
            </div>
          )}
      </Sektion>

      {/* Allgemeine Punkte des Lieferanten — offen nur solange etwas
             Offenes drin liegt. */}
      {allgemeineReviews.length > 0 && (
        <Sektion
          icon={<MessageSquare className="h-3.5 w-3.5" />}
          titel="Allgemeine Punkte des Lieferanten"
          zusatz={`${allgemeineReviews.filter((r) => r.status === "offen").length} offen · ${allgemeineReviews.length} total`}
          defaultOffen={allgemeineReviews.some((r) => r.status === "offen")}
        >
            {allgemeineReviews.map((r) => (
              <ReviewBlock
                key={r.id}
                review={r}
                kommentare={kommentare.filter((k) => k.review_id === r.id)}
                canEdit={darfBearbeiten}
                busy={busy}
                onAktion={aktionOk}
                onKommentar={(body) => aktionOk({ aktion: "kommentar_neu", reviewId: r.id, body }, null)}
              />
            ))}
        </Sektion>
      )}

      {/* Angebote, die der Lieferant im Portal hochgeladen hat — auch hier
             sichtbar, nicht nur im Dokumente-Tab. */}
      {angebote.length > 0 && (
        <Sektion
          icon={<FileText className="h-3.5 w-3.5" />}
          titel="Lieferanten-Angebote"
          zusatz={`${angebote.length} · zuletzt ${formatDateFull(angebote[0].created_at)}`}
          defaultOffen
        >
          <div className="space-y-1">
            {angebote.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => void angebotOeffnen(a)}
                disabled={angebotBusy === a.id}
                className="row-hover w-full flex items-center gap-2 text-sm rounded-lg px-1.5 py-1 text-left"
                data-tooltip="Angebot ansehen"
              >
                {angebotBusy === a.id
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                  : <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                <span className="flex-1 min-w-0 truncate">{a.name}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">{formatDateFull(a.created_at)}</span>
              </button>
            ))}
          </div>
        </Sektion>
      )}

      {/* Aktivitaet — Nachschlage-Sektion, immer zu beim Betreten. */}
      <Sektion
        icon={<ActivityIcon className="h-3.5 w-3.5" />}
        titel="Aktivität"
        zusatz={aktivitaet.length > 0
          ? `${anzahl(aktivitaet.length, "Eintrag", "Einträge")} · zuletzt ${formatDateTimeFull(aktivitaet[0].created_at)}`
          : "noch keine"}
      >
        <AktivitaetListe items={aktivitaet} />
      </Sektion>
      </div>
      </div>

      {/* KI-Quelle (aus dem Eingang extrahierte Positionen) */}
      {quelleModal && (
        <Modal open onClose={() => setQuelleModal(null)} title="Quelle" icon={<FileText className="h-5 w-5" />} size="md">
          {quelleModal.kind === "text" ? (
            <p className="text-sm whitespace-pre-wrap max-h-[50vh] overflow-y-auto">{quelleModal.content}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Datei: {quelleModal.file_name ?? "unbekannt"} — auf der Übersicht unter «Verlauf» einsehbar.</p>
          )}
        </Modal>
      )}
      {angebotOffen && (
        <PdfPopup url={angebotOffen.url} title={angebotOffen.name} onClose={() => setAngebotOffen(null)} />
      )}
      {ConfirmModalElement}
    </div>
  );
}

// ===========================================================================

function masseText(m: { l: number | null; b: number | null; h: number | null } | null): string | null {
  if (!m || (m.l === null && m.b === null && m.h === null)) return null;
  return [m.l, m.b, m.h].map((v) => (v === null ? "?" : String(v))).join("×") + " m";
}

function MiniLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </h4>
  );
}

function WunschZeile({
  wunsch, canEdit, onSave, onDelete, busy,
}: {
  wunsch: TechnikAnforderung;
  canEdit: boolean;
  onSave: (text: string) => Promise<boolean>;
  onDelete: () => Promise<void>;
  busy: boolean;
}) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(wunsch.text);
  const [hover, setHover] = useState(false);

  if (edit) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter = Tab (globaler Hook → Haken-Knopf); nur Esc bricht ab.
            if (e.key === "Escape") { e.preventDefault(); setText(wunsch.text); setEdit(false); }
          }}
          maxLength={4000}
          autoFocus
          className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />
        <button
          type="button"
          onClick={() => void onSave(text.trim()).then((ok) => { if (ok) setEdit(false); })}
          disabled={busy || !text.trim()}
          className="kasten kasten-muted shrink-0"
          aria-label="Speichern"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2 py-1 -mx-2"
      style={hover ? { background: "color-mix(in srgb, currentColor 6%, transparent)" } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="text-muted-foreground select-none">•</span>
      <button
        type="button"
        onClick={() => {
          if (!canEdit) return;
          // Aktuellen Stand uebernehmen (nicht den vom ersten Rendern).
          setText(wunsch.text);
          setEdit(true);
        }}
        className="text-sm flex-1 min-w-0 text-left break-words"
        data-tooltip={canEdit ? "Klicken zum Bearbeiten" : undefined}
      >
        {wunsch.text}
      </button>
      {canEdit && hover && (
        <button
          type="button"
          onClick={() => void onDelete()}
          disabled={busy}
          className="icon-btn icon-btn-red text-red-500 shrink-0"
          data-tooltip="Wunsch entfernen"
          aria-label="Wunsch entfernen"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        </button>
      )}
    </div>
  );
}

function PositionZeile({
  pos, reviews, kommentare, reviewKommentare, canEdit, busy, kommentarOffen,
  onKommentarToggle, onAktion, onKommentar, onConfirmDelete, onQuelle,
}: {
  pos: PositionVoll;
  reviews: TechnikReview[];
  kommentare: TechnikKommentar[];
  reviewKommentare: TechnikKommentar[];
  canEdit: boolean;
  busy: string | null;
  kommentarOffen: boolean;
  onKommentarToggle: () => void;
  onAktion: (payload: Record<string, unknown>, busyKey: string | null, erfolg?: string) => Promise<boolean>;
  onKommentar: (body: string, reviewId?: string) => Promise<boolean>;
  onConfirmDelete: () => void;
  onQuelle?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [mengeEdit, setMengeEdit] = useState(false);
  const [menge, setMenge] = useState(String(pos.menge));
  const ampel = positionAmpel(pos, reviews);
  const offeneReviews = reviews.filter((r) => r.status === "offen");
  const entschiedeneReviews = reviews.filter((r) => r.status !== "offen");
  const posBusy = busy === `pos_${pos.id}`;

  function mengeSpeichern() {
    setMengeEdit(false);
    const m = Number(menge);
    if (Number.isInteger(m) && m > 0 && m !== pos.menge) {
      void onAktion({ aktion: "position_edit", id: pos.id, menge: m }, `pos_${pos.id}`);
    } else {
      setMenge(String(pos.menge));
    }
  }

  return (
    <div className="rounded-lg border border-border/60">
      <div
        className="flex items-center gap-2 px-2.5 py-1.5"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <AmpelDot ampel={ampel} title={AMPEL_LABEL[ampel]} />
        {mengeEdit ? (
          <input
            type="number"
            min={1}
            step={1}
            value={menge}
            autoFocus
            onChange={(e) => setMenge(e.target.value)}
            // Enter = Tab (globaler Hook) → Fokus wandert weiter → Blur speichert.
            onBlur={mengeSpeichern}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); setMenge(String(pos.menge)); setMengeEdit(false); }
            }}
            aria-label="Menge"
            className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-sm tabular-nums"
          />
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!canEdit) return;
              // Aktuellen Wert uebernehmen — sonst schriebe der Blur den
              // Wert vom ersten Rendern zurueck (z.B. nach «Übernehmen»).
              setMenge(String(pos.menge));
              setMengeEdit(true);
            }}
            className="text-sm font-semibold tabular-nums shrink-0"
            data-tooltip={canEdit ? "Menge ändern" : undefined}
          >
            {posBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin inline" /> : `${pos.menge}×`}
          </button>
        )}
        <span className="text-sm flex-1 min-w-0 truncate">
          {pos.bezeichnung}
          {(pos.details || masseText(pos.masse)) && (
            <span className="text-xs text-muted-foreground"> — {[masseText(pos.masse), pos.details].filter(Boolean).join(" · ")}</span>
          )}
        </span>
        {onQuelle && (
          <button
            type="button"
            onClick={onQuelle}
            className="icon-btn icon-btn-muted shrink-0"
            data-tooltip="Aus dem Eingang erkannt — Quelle ansehen"
            aria-label="Quelle ansehen"
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
        <QuelleBadge quelle={pos.quelle} />
        {pos.status === "bestaetigt" && <BestaetigtHaken />}
        {canEdit && (hover || kommentarOffen) && (
          <span className="flex items-center gap-0.5 shrink-0">
            {pos.status !== "bestaetigt" && (
              <button
                type="button"
                onClick={() => void onAktion({ aktion: "position_bestaetigen", id: pos.id, bestaetigt: true }, `pos_${pos.id}`)}
                disabled={posBusy}
                className="icon-btn icon-btn-green text-green-600 dark:text-green-400"
                data-tooltip="Als bestätigt markieren"
                aria-label="Als bestätigt markieren"
              >
                {posBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={onKommentarToggle}
              className={`icon-btn icon-btn-blue ${kommentare.length > 0 ? "text-blue-500" : ""}`}
              data-tooltip="Kommentare"
              aria-label="Kommentare"
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={posBusy}
              className="icon-btn icon-btn-red text-red-500"
              data-tooltip="Position entfernen"
              aria-label="Position entfernen"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        {!canEdit && kommentare.length > 0 && (
          <button type="button" onClick={onKommentarToggle} className="icon-btn icon-btn-blue text-blue-500" data-tooltip="Kommentare" aria-label="Kommentare">
            <MessageSquare className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {(offeneReviews.length > 0 || entschiedeneReviews.length > 0 || kommentarOffen) && (
        <div className="border-t border-border/60 px-2.5 py-2 space-y-2">
          {offeneReviews.map((r) => (
            <ReviewBlock
              key={r.id}
              review={r}
              kommentare={reviewKommentare.filter((k) => k.review_id === r.id)}
              canEdit={canEdit}
              busy={busy}
              onAktion={onAktion}
              onKommentar={(body) => onKommentar(body, r.id)}
            />
          ))}
          {entschiedeneReviews.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <ReviewArtChip art={r.art} />
              <span className="flex-1 min-w-0 truncate">{r.text}</span>
              <ReviewStatusChip status={r.status} />
            </div>
          ))}
          {kommentarOffen && (
            <KommentarThread
              kommentare={kommentare}
              onSend={(body) => onKommentar(body)}
              placeholder="Kommentar an den Lieferanten…"
              nurLesen={!canEdit}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ReviewBlock({
  review, kommentare, canEdit, busy, onAktion, onKommentar,
}: {
  review: TechnikReview;
  kommentare: TechnikKommentar[];
  canEdit: boolean;
  busy: string | null;
  onAktion: (payload: Record<string, unknown>, busyKey: string | null, erfolg?: string) => Promise<boolean>;
  onKommentar: (body: string) => Promise<boolean>;
}) {
  const [antworten, setAntworten] = useState(false);
  const s = REVIEW_STYLES[review.art];
  const rBusy = busy === `rev_${review.id}`;
  const offen = review.status === "offen";

  return (
    <div className={`rounded-lg border px-2.5 py-2 space-y-1.5 ${s.box}`}>
      <div className="flex items-start gap-2 flex-wrap">
        <ReviewArtChip art={review.art} />
        <p className={`text-xs flex-1 min-w-0 whitespace-pre-wrap break-words ${s.text}`}>{review.text}</p>
        <span className="text-[10px] text-muted-foreground shrink-0">{formatDateTimeFull(review.created_at)}</span>
      </div>
      {offen && canEdit && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {review.art === "empfehlung" ? (
            <>
              <button
                type="button"
                onClick={() => void onAktion({ aktion: "review_entscheiden", id: review.id, entscheid: "uebernehmen" }, `rev_${review.id}`, "Empfehlung übernommen")}
                disabled={rBusy}
                className="kasten kasten-green"
                data-tooltip={review.vorschlag ? "Vorschlag wird direkt in den Plan übernommen" : "Als übernommen markieren"}
              >
                {rBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Übernehmen
              </button>
              <button
                type="button"
                onClick={() => void onAktion({ aktion: "review_entscheiden", id: review.id, entscheid: "ablehnen" }, `rev_${review.id}`, "Empfehlung abgelehnt")}
                disabled={rBusy}
                className="kasten kasten-muted"
                data-tooltip="Empfehlung ablehnen"
              >
                {rBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                Ablehnen
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void onAktion({ aktion: "review_entscheiden", id: review.id, entscheid: "erledigt" }, `rev_${review.id}`, "Problem als erledigt geschlossen")}
              disabled={rBusy}
              className="kasten kasten-muted"
              data-tooltip="Problem als erledigt schliessen"
            >
              {rBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Erledigt
            </button>
          )}
          {/* Nur zeigen solange das Antwort-Feld nicht ohnehin sichtbar ist
              (bei vorhandenen Antworten ist der Thread permanent offen). */}
          {kommentare.length === 0 && !antworten && (
            <button type="button" onClick={() => setAntworten(true)} className="kasten kasten-muted">
              <MessageSquare className="h-3.5 w-3.5" />
              Antworten
            </button>
          )}
        </div>
      )}
      {(kommentare.length > 0 || antworten) && (
        <KommentarThread
          kommentare={kommentare}
          onSend={async (b) => {
            const ok = await onKommentar(b);
            if (ok) setAntworten(false);
            return ok;
          }}
          nurLesen={!canEdit}
        />
      )}
      {!offen && <ReviewStatusChip status={review.status} />}
    </div>
  );
}
