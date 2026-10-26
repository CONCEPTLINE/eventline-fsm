"use client";

// Auftrag → Tab «Technik» — gemeinsame technische Planung mit dem
// festen Techniklieferanten (Migration 263/264, Umbau 352 am 2026-10-25).
//
// Aufbau (kompakt, Mini-Labels statt Card-Inflation):
//   1. Kopfzeile: Techniklieferant · Runde/Stand · «Anfrage senden». Genau
//      EIN aktiver Lieferant vom Typ «technik» = fest, keine Auswahl; bei
//      keinem oder mehreren ein klarer Hinweis und «Anfrage senden» gesperrt
//      (Leo 2026-10-15). Die Zuweisung entsteht erst beim Senden.
//   2. Links: POSITIONEN — nummerierte Positionsgruppen («Pos 01 – Rahmen:
//      3 m hoch …», Tabelle job_anforderungen) mit ihren Einzelpositionen
//      (echtes Material, job_technik_positionen.gruppe_id; Ampel und
//      Rueckmeldungen des Lieferanten inline). Ohne Einzelpositionen waehlt
//      der Lieferant die Loesung. Jede Gruppe ist einklappbar (beim Betreten
//      alle zu, «Alle auf / Alle zu»); der Kopf zeigt Anzahl, Herkunft und
//      «N offen» (gleiche Definition wie die Zahl am Tab, Migration 336).
//      Aufgeklappt: Kurztext, Absatz «Zusammenhang» (Migration 354), dann
//      die Einzelpositionen. Ganz oben die berechnete «Pos 00 – Gesamtliste»
//      (alle Einzelpositionen zusammengezaehlt, nicht gespeichert).
//   3. Rechts: allgemeine Punkte, Angebote, Aktivitaet.
//   4. Darunter in voller Breite: die 3D-Ansicht (drei-d-ansicht.tsx).
//
// Alle Mutationen laufen ueber POST /api/jobs/[id]/technik (Aktivitaet,
// Benachrichtigungen, Sperre bei storniert/abgeschlossen zentral); Lesen
// direkt per Client-Supabase (RLS).

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
  MessageSquare, Sparkles, X, FileText, Lock, AlertTriangle, RotateCcw, Pencil, ChevronDown,
} from "lucide-react";
import type {
  GruppeOffen, LieferantRegel, TechnikAktivitaet, TechnikGruppe, TechnikKommentar, TechnikPosition, TechnikReview,
} from "@/lib/technik";
import {
  AMPEL_LABEL, TECHNIK_TITEL_MAX, gruppeBeschreibung, gruppeLabel, gruppeOffenePunkte, gruppeZusammenhang,
  passendeRegeln, positionAmpel, technikStand,
} from "@/lib/technik";
import {
  AktivitaetListe, AlleAufZuKnopf, AmpelDot, BestaetigtHaken, GesamtListe, GruppeKlappe, KommentarThread, OffenMarker,
  POS_00_ID, QuelleBadge, ReviewArtChip, ReviewStatusChip, REVIEW_STYLES, Sektion, StandChips, ZusammenhangAbsatz, anzahl,
  useGruppenAufklappen,
} from "@/components/technik/technik-shared";
import { DreiDAnsicht } from "@/components/auftrag/technik/drei-d-ansicht";
import { formatDateFull, formatDateTimeFull } from "@/lib/format";

interface KatalogArtikel { id: string; name: string; hauptkategorie: string }
interface Angebot { id: string; name: string; storage_path: string; created_at: string }

type QuelleItem = { kind: string; content: string | null; file_name: string | null; absender: string | null; created_at: string | null };

/** Positionsgruppe mit Herkunft (Eingang-KI oder von Hand). */
interface GruppeVoll extends TechnikGruppe {
  created_via: "ki" | "manuell";
  manuell_geaendert_at: string | null;
  quelle_item: QuelleItem | null;
}

/** Einzelposition mit Herkunft und Bestaetiger. */
interface PositionVoll extends TechnikPosition {
  created_via: "ki" | "manuell";
  manuell_geaendert_at: string | null;
  quelle_item: QuelleItem | null;
  /** Wer bestaetigt hat (Lieferant oder EVENTLINE). */
  bestaetiger: { full_name: string | null; lieferant_id: string | null } | null;
}

type AktionsErgebnis = Record<string, unknown> | null;
type OnAktion = (payload: Record<string, unknown>, busyKey: string | null, erfolg?: string) => Promise<boolean>;

interface Props {
  jobId: string;
  canEdit: boolean;
  /** Gesetzt bei storniert/abgeschlossen: alles nur noch lesen. */
  sperrHinweis: string | null;
  /** Nach jeder eigenen Aenderung (z.B. Zaehler am Tab neu holen). */
  onAenderung?: () => void;
}

/** Herkunft eines aus dem Eingang erkannten Eintrags, fuer den Tooltip. */
function quelleText(q: QuelleItem | null): string {
  if (!q) return "Aus dem Eingang erkannt";
  const wann = q.created_at ? ` vom ${formatDateFull(q.created_at)}` : "";
  if (q.absender) return `Aus dem Eingang erkannt: Mail von ${q.absender}${wann}`;
  if (q.kind === "datei") return `Aus dem Eingang erkannt: Datei «${q.file_name ?? "unbekannt"}»${wann}`;
  return `Aus dem Eingang erkannt: Notiz${wann}`;
}

/** Supabase-Join kommt je nach Kardinalitaet als Objekt ODER Array. */
function eins<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export function TechnikTab({ jobId, canEdit, sperrHinweis, onAenderung }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();
  const darfBearbeiten = canEdit && !sperrHinweis;

  const [loading, setLoading] = useState(true);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [fest, setFest] = useState<{ id: string; name: string } | null>(null);
  const [festGrund, setFestGrund] = useState<"keiner" | "mehrere" | null>(null);
  const [zuweisung, setZuweisung] = useState<{ angefragtAt: string | null; runden: number } | null>(null);
  const [gruppen, setGruppen] = useState<GruppeVoll[]>([]);
  const [positionen, setPositionen] = useState<PositionVoll[]>([]);
  const [quelleModal, setQuelleModal] = useState<QuelleItem | null>(null);
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
  const [neueGruppe, setNeueGruppe] = useState(false);
  const [kommentarOffen, setKommentarOffen] = useState<string | null>(null); // position_id
  // Positionsgruppen auf/zu — beim Betreten alle zu, Neuladen behaelt den Stand.
  const aufklappen = useGruppenAufklappen();

  /** Laedt den ganzen Tab neu. Fehler werden gemeldet, nie verschluckt —
   *  bei einem Fehler bleibt der bisherige Stand stehen. */
  const laden = useCallback(async (): Promise<boolean> => {
    const [lief, zuw, grp, pos, rev, kom, akt, ang] = await Promise.all([
      supabase.from("lieferanten").select("id, name").eq("is_active", true).eq("type", "technik").order("name").limit(2),
      supabase.from("job_lieferanten").select("lieferant_id, angefragt_at, anfrage_runden").eq("job_id", jobId),
      supabase.from("job_anforderungen").select("id, nummer, titel, text, zusammenhang, created_at, inhalt_geaendert_at, created_via, manuell_geaendert_at, quelle_item:job_inbox_items(kind, content, file_name, absender, created_at)").eq("job_id", jobId).order("nummer"),
      supabase.from("job_technik_positionen").select("id, gruppe_id, artikel_id, kategorie, bezeichnung, details, menge, status, quelle, bestaetigt_at, created_at, created_via, manuell_geaendert_at, quelle_item:job_inbox_items(kind, content, file_name, absender, created_at), bestaetiger:profiles!bestaetigt_by(full_name, lieferant_id)").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_reviews").select("id, position_id, art, text, vorschlag, status, created_at, entschieden_at").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_kommentare").select("id, position_id, review_id, body, created_at, author:profiles(full_name, role)").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_aktivitaet").select("id, actor_name, aktion, beschreibung, created_at").eq("job_id", jobId).order("created_at", { ascending: false }).limit(100),
      // Nur Angebote, die der Lieferant im Portal hochgeladen hat (eigener
      // Ablage-Ordner) — Firmen-Uploads im Ordner «Angebote» gehoeren nicht hierher.
      supabase.from("documents").select("id, name, storage_path, created_at").eq("job_id", jobId).eq("folder", "Angebote").like("storage_path", `jobs/${jobId.toLowerCase()}/lieferant-%`).order("created_at", { ascending: false }),
    ]);
    const fehler = [lief, zuw, grp, pos, rev, kom, akt, ang].find((r) => r.error)?.error;
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
    setGruppen(((grp.data ?? []) as unknown as (Omit<GruppeVoll, "quelle_item"> & { quelle_item: QuelleItem | QuelleItem[] | null })[])
      .map((g) => ({ ...g, quelle_item: eins(g.quelle_item) })));
    setPositionen(((pos.data ?? []) as unknown as (Omit<PositionVoll, "quelle_item" | "bestaetiger"> & {
      quelle_item: QuelleItem | QuelleItem[] | null;
      bestaetiger: PositionVoll["bestaetiger"] | NonNullable<PositionVoll["bestaetiger"]>[];
    })[]).map((p) => ({ ...p, quelle_item: eins(p.quelle_item), bestaetiger: eins(p.bestaetiger) })));
    setAngebote((ang.data ?? []) as Angebot[]);
    setReviews((rev.data ?? []) as TechnikReview[]);
    setKommentare(((kom.data ?? []) as unknown as {
      id: string; position_id: string | null; review_id: string | null; body: string; created_at: string;
      author: { full_name: string | null; role: string | null } | { full_name: string | null; role: string | null }[] | null;
    }[]).map((k) => {
      const a = eins(k.author);
      return {
        id: k.id, position_id: k.position_id, review_id: k.review_id, body: k.body, created_at: k.created_at,
        author_name: a?.full_name ?? null, vom_lieferanten: a?.role === "lieferant",
      };
    }));
    setAktivitaet((akt.data ?? []) as TechnikAktivitaet[]);

    // Katalog + Regeln des festen Techniklieferanten — Einzelpositionen
    // lassen sich so schon vor der ersten Anfrage aus dessen Katalog
    // erfassen. Einmal je Lieferant, nicht bei jeder Aktion neu.
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
  }, [supabase, jobId]);

  const erstLaden = useCallback(async () => {
    setLoading(true);
    const ok = await laden();
    setLadeFehler(!ok);
    setLoading(false);
  }, [laden]);

  useEffect(() => {
    void erstLaden();
  }, [erstLaden]);

  // Live: die Auftrags-Seite meldet neue Aktivitaet (Realtime, z.B. eine
  // Antwort im Portal oder eine Mail, die die Eingang-KI verarbeitet hat) →
  // still nachladen. Eingaben bleiben stehen (eigene States).
  useEffect(() => {
    const neu = (e: Event) => {
      if ((e as CustomEvent<{ jobId?: string }>).detail?.jobId === jobId) void laden();
    };
    window.addEventListener("technik:aktualisieren", neu);
    return () => window.removeEventListener("technik:aktualisieren", neu);
  }, [jobId, laden]);

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
      onAenderung?.();
      if (erfolg) toast.success(erfolg);
      return json;
    } catch {
      toast.error("Netzwerkfehler");
      return null;
    } finally {
      if (busyKey) setBusy(null);
    }
  }
  const aktionOk: OnAktion = async (payload, busyKey, erfolg) => (await aktion(payload, busyKey, erfolg)) !== null;

  /** Paket des Lieferanten (Regel) in eine Gruppe uebernehmen. */
  async function paketUebernehmen(regel: LieferantRegel, gruppeId: string): Promise<boolean> {
    if (!regel.paket?.length) return false;
    setBusy(`paket_${regel.id}`);
    let fehler = 0;
    try {
      for (const p of regel.paket) {
        try {
          const res = await fetch(`/api/jobs/${jobId}/technik`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ aktion: "position_neu", gruppeId, bezeichnung: p.bezeichnung, menge: p.menge, kategorie: p.kategorie }),
          });
          const json = await res.json().catch(() => null);
          if (!res.ok || !json?.success) fehler++;
        } catch {
          fehler++;
        }
      }
      await laden();
      onAenderung?.();
      if (fehler === 0) {
        toast.success(`Paket übernommen (${anzahl(regel.paket.length, "Einzelposition", "Einzelpositionen")})`);
        return true;
      }
      toast.error(`${fehler} von ${regel.paket.length} Einzelpositionen konnten nicht übernommen werden`);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function anfrageSenden() {
    if (!fest) return;
    const ok = await confirm({
      title: zuweisung?.angefragtAt ? "Erneut anfragen?" : "Anfrage senden?",
      message: `«${fest.name}» wird benachrichtigt und sieht die Technik-Planung dieses Auftrags im Lieferantenportal ` +
        `(${anzahl(gruppen.length, "Position", "Positionen")}, ${anzahl(positionen.length, "Einzelposition", "Einzelpositionen")}).`,
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

  /** Was beim Loeschen vom Lieferanten mit verloren geht (Rueckmeldungen +
   *  Kommentare haengen an den Einzelpositionen). */
  function verlustText(positionIds: string[]): string {
    const ids = new Set(positionIds);
    const posReviews = reviews.filter((r) => r.position_id && ids.has(r.position_id));
    const reviewIds = new Set(posReviews.map((r) => r.id));
    const vomLieferanten = kommentare.filter((k) =>
      k.vom_lieferanten && ((k.position_id && ids.has(k.position_id)) || (k.review_id && reviewIds.has(k.review_id)))).length;
    const wer = fest?.name ?? "dem Lieferanten";
    const verlust = [
      posReviews.length ? anzahl(posReviews.length, "Rückmeldung", "Rückmeldungen") : null,
      vomLieferanten ? anzahl(vomLieferanten, "Kommentar", "Kommentare") : null,
    ].filter(Boolean).join(" und ");
    const verb = posReviews.length + vomLieferanten === 1 ? "wird" : "werden";
    return verlust ? `\n\nDabei ${verb} auch ${verlust} von ${wer} gelöscht.` : "";
  }

  async function positionLoeschen(pos: PositionVoll) {
    const ok = await confirm({
      title: "Einzelposition entfernen?",
      message: `${pos.menge}× ${pos.bezeichnung} wird entfernt.${verlustText([pos.id])}`,
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (ok) await aktionOk({ aktion: "position_loeschen", id: pos.id }, `pos_${pos.id}`);
  }

  async function gruppeLoeschen(g: GruppeVoll) {
    const eigene = positionen.filter((p) => p.gruppe_id === g.id);
    const ok = await confirm({
      title: "Position entfernen?",
      message: `${gruppeLabel(g)} wird entfernt` +
        (eigene.length ? ` — samt ${anzahl(eigene.length, "Einzelposition", "Einzelpositionen")} (${eigene.map((p) => `${p.menge}× ${p.bezeichnung}`).join(", ")}).` : ".") +
        verlustText(eigene.map((p) => p.id)),
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (ok) await aktionOk({ aktion: "anforderung_loeschen", id: g.id }, `grp_${g.id}`, "Position entfernt");
  }

  const stand = useMemo(() => technikStand(positionen, reviews), [positionen, reviews]);
  const gruppeItems = useMemo(() => gruppen.map((g) => ({ id: g.id, label: gruppeLabel(g) })), [gruppen]);
  const allgemeineReviews = reviews.filter((r) => r.position_id === null);
  const anfrageTooltip = !fest
    ? "Kein eindeutiger Techniklieferant hinterlegt"
    : gruppen.length === 0
      ? "Zuerst Positionen erfassen"
      : `${fest.name} benachrichtigen — prüft die Planung im Portal`;

  const positionProps = (pos: PositionVoll) => ({
    pos,
    reviews: reviews.filter((r) => r.position_id === pos.id),
    kommentare: kommentare.filter((k) => k.position_id === pos.id && !k.review_id),
    reviewKommentare: kommentare,
    canEdit: darfBearbeiten,
    busy,
    katalog,
    gruppeItems,
    lieferantName: fest?.name ?? null,
    kommentarOffen: kommentarOffen === pos.id,
    onKommentarToggle: () => setKommentarOffen(kommentarOffen === pos.id ? null : pos.id),
    onAktion: aktionOk,
    onKommentar: (body: string, reviewId?: string) =>
      aktionOk({ aktion: "kommentar_neu", positionId: pos.id, reviewId, body }, null),
    onQuelle: pos.created_via === "ki" && pos.quelle_item ? () => setQuelleModal(pos.quelle_item) : undefined,
    onConfirmDelete: () => void positionLoeschen(pos),
    // In eine andere Position verschoben → dort aufklappen, sonst verschwaende sie.
    onGruppeWechsel: aufklappen.oeffnen,
  });
  // «Pos 00» (Gesamtliste) klappt mit «Alle auf / Alle zu» mit, sobald es sie gibt.
  const gruppenIds = gruppen.map((g) => g.id);
  const mitGesamtliste = positionen.some((p) => gruppenIds.includes(p.gruppe_id));
  const klappIds = mitGesamtliste ? [POS_00_ID, ...gruppenIds] : gruppenIds;
  const alleGruppenOffen = aufklappen.alleOffen(klappIds);

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
    <div className="space-y-3">
      {sperrHinweis && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/50 dark:bg-muted px-3 py-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4 shrink-0" />
          {sperrHinweis}
        </div>
      )}

      {/* 1. Kopfzeile: Lieferant · Runde/Stand · Anfrage — EINE dünne Zeile. */}
      <div className="flex items-center gap-x-3 gap-y-1.5 flex-wrap rounded-xl border border-border bg-card px-3 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
          <Wrench className="h-3.5 w-3.5" /> Techniklieferant
        </span>
        {fest ? (
          <span
            className="text-sm font-medium"
            data-tooltip={zuweisung?.angefragtAt ? undefined : `${fest.name} sieht den Auftrag im Portal erst, wenn die Anfrage gesendet ist`}
          >
            {fest.name}
          </span>
        ) : (
          <span className="inline-flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300 min-w-0">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            {festGrund === "mehrere"
              ? "Kein eindeutiger Techniklieferant — mehrere aktive Lieferanten vom Typ «Technik». Unter Lieferanten bereinigen; bis dahin ist «Anfrage senden» gesperrt."
              : "Kein eindeutiger Techniklieferant — unter Lieferanten genau einen aktiven Lieferanten vom Typ «Technik» erfassen; bis dahin ist «Anfrage senden» gesperrt."}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {zuweisung?.angefragtAt
            ? `${zuweisung.runden > 1 ? `Runde ${zuweisung.runden} · ` : ""}angefragt ${formatDateTimeFull(zuweisung.angefragtAt)}`
            : fest ? "noch nicht angefragt" : null}
        </span>
        <StandChips stand={stand} />
        {darfBearbeiten && (
          <button
            type="button"
            onClick={() => void anfrageSenden()}
            disabled={busy !== null || !fest || gruppen.length === 0}
            className="kasten kasten-blue ml-auto"
            data-tooltip={anfrageTooltip}
          >
            {busy === "anfrage" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            {busy === "anfrage" ? "Wird gesendet…" : zuweisung?.angefragtAt ? "Erneut anfragen" : "Anfrage senden"}
          </button>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-3 items-start">
      {/* ── Linke Hauptspalte: Positionen + 3D-Ansicht ── */}
      <div className="space-y-3 lg:col-span-2 min-w-0">
      <Card className="bg-card py-0">
        <CardContent className="p-4 space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <MiniLabel icon={<ListChecks className="h-3.5 w-3.5" />}>Positionen</MiniLabel>
            <span className="text-xs text-muted-foreground mr-auto">
              {gruppen.length > 0 && `${gruppen.length} · ${anzahl(positionen.length, "Einzelposition", "Einzelpositionen")}`}
            </span>
            {klappIds.length > 1 && (
              <AlleAufZuKnopf
                alleOffen={alleGruppenOffen}
                onClick={() => aufklappen.alleSetzen(klappIds, !alleGruppenOffen)}
              />
            )}
            {darfBearbeiten && !neueGruppe && (
              <button type="button" onClick={() => setNeueGruppe(true)} disabled={busy !== null} className="kasten kasten-muted">
                <Plus className="h-3.5 w-3.5" /> Position
              </button>
            )}
          </div>

          {gruppen.length === 0 && !neueGruppe && (
            <EmptyState
              icon={ListChecks}
              title="Noch keine Positionen"
              description={darfBearbeiten
                ? "Was braucht der Kunde? Je Wunsch eine Position in Klartext — die Eingang-KI legt sie aus Mails auch selbst an."
                : "Für diesen Auftrag ist noch keine Technik geplant."}
            />
          )}

          <GesamtListe
            gruppen={gruppen}
            positionen={positionen}
            offen={aufklappen.istOffen(POS_00_ID)}
            onToggle={() => aufklappen.umschalten(POS_00_ID)}
            waehlt={`${fest?.name ?? "Der Techniklieferant"} wählt`}
          />

          {gruppen.map((g) => ({ g, eigene: positionen.filter((p) => p.gruppe_id === g.id) })).map(({ g, eigene }) => (
            <GruppeBlock
              key={g.id}
              gruppe={g}
              positionen={eigene}
              positionProps={positionProps}
              offen={aufklappen.istOffen(g.id)}
              onToggle={() => aufklappen.umschalten(g.id)}
              offenePunkte={gruppeOffenePunkte(eigene.map((p) => p.id), reviews, kommentare)}
              canEdit={darfBearbeiten}
              busy={busy}
              katalog={katalog}
              regeln={regeln}
              lieferantName={fest?.name ?? null}
              onAktion={aktionOk}
              onPaket={(r) => paketUebernehmen(r, g.id)}
              onQuelle={g.created_via === "ki" && g.quelle_item ? () => setQuelleModal(g.quelle_item) : undefined}
              onDelete={() => void gruppeLoeschen(g)}
            />
          ))}

          {neueGruppe && darfBearbeiten && (
            <GruppeForm
              busy={busy === "grp_neu"}
              onSave={async (titel, text, zusammenhang) => {
                const json = await aktion({ aktion: "anforderung_neu", titel, text, zusammenhang }, "grp_neu", "Position angelegt");
                if (!json) return false;
                // Neu angelegt = sofort aufgeklappt (Einzelpositionen erfassen).
                if (typeof json.id === "string") aufklappen.oeffnen(json.id);
                setNeueGruppe(false);
                return true;
              }}
              onCancel={() => setNeueGruppe(false)}
            />
          )}
        </CardContent>
      </Card>
      </div>

      {/* ── Rechte Seitenspalte: Randinfos ── */}
      <div className="space-y-3 min-w-0">
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

      {/* 3D-Ansicht volle Breite — das Modell braucht Platz fuer seine
          Bedienleiste (in der 2/3-Spalte war sie abgeschnitten). */}
      <DreiDAnsicht jobId={jobId} darfBearbeiten={darfBearbeiten} />

      {/* Quelle eines aus dem Eingang erkannten Eintrags */}
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

function MiniLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {icon}
      {children}
    </h4>
  );
}

/** Kleiner Text-Knopf («+ Einzelposition»), Hover state-driven (§3). */
function TextKnopf({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1 text-[11px] py-0.5"
      style={{ color: hover && !disabled ? "var(--foreground)" : "var(--muted-foreground)" }}
    >
      {children}
    </button>
  );
}

/** «2 erledigte Punkte» auf-/zuklappen (Hover state-driven). */
function ErledigtUmschalter({ offen, anzahl: n, onToggle }: { offen: boolean; anzahl: number; onToggle: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1 text-[11px]"
      style={{ color: hover ? "var(--foreground)" : "var(--muted-foreground)" }}
      aria-expanded={offen}
    >
      <ChevronDown className={`h-3 w-3 transition-transform ${offen ? "rotate-180" : ""}`} />
      {anzahl(n, "erledigter Punkt", "erledigte Punkte")} des Lieferanten
    </button>
  );
}

/** Positionsgruppe anlegen/aendern: Kurztitel + Klartext-Beschreibung +
 *  Absatz «Zusammenhang» (mehrzeilig). Enter = Tab (globaler Hook,
 *  Shift+Enter = neue Zeile), gespeichert wird nur per Knopf. */
function GruppeForm({ start, busy, hinweis, onSave, onCancel }: {
  start?: { titel: string; text: string; zusammenhang: string };
  busy: boolean;
  hinweis?: string;
  onSave: (titel: string, text: string, zusammenhang: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [titel, setTitel] = useState(start?.titel ?? "");
  const [text, setText] = useState(start?.text ?? "");
  const [zusammenhang, setZusammenhang] = useState(start?.zusammenhang ?? "");
  return (
    <div className="rounded-lg border border-border bg-muted/30 dark:bg-muted/50 px-2.5 py-2 space-y-1.5">
      <div className="flex items-start gap-1.5 flex-wrap">
        <input
          type="text"
          value={titel}
          onChange={(e) => setTitel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
          maxLength={TECHNIK_TITEL_MAX}
          autoFocus
          placeholder="Titel, z.B. Rahmen"
          aria-label="Titel"
          className="w-44 max-w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
          maxLength={4000}
          rows={2}
          placeholder="In Klartext, z.B. 3 m hoch, 4 m breit, um ein Tuch darin zu spannen"
          aria-label="Beschreibung"
          className="flex-1 min-w-[200px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />
      </div>
      <textarea
        value={zusammenhang}
        onChange={(e) => setZusammenhang(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onCancel(); } }}
        maxLength={4000}
        rows={3}
        placeholder="Zusammenhang für den Techniklieferanten (2–5 Sätze): wofür, wo und wann, wie es zusammenhängt, Rahmenbedingungen"
        aria-label="Zusammenhang"
        className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
      />
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          onClick={() => void onSave(titel.trim(), text.trim(), zusammenhang.trim())}
          disabled={busy || !titel.trim()}
          className="kasten kasten-blue"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {busy ? "Wird gespeichert…" : "Speichern"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="kasten kasten-muted">Abbrechen</button>
        {hinweis && <span className="text-[11px] text-muted-foreground">{hinweis}</span>}
      </div>
    </div>
  );
}

/** «1 offene Empfehlung · 1 unbeantworteter Kommentar von Herzog Tech» */
function offenTooltip(o: GruppeOffen, lieferantName: string | null): string {
  return [
    o.empfehlungen ? anzahl(o.empfehlungen, "offene Empfehlung", "offene Empfehlungen") : null,
    o.probleme ? anzahl(o.probleme, "offenes Problem", "offene Probleme") : null,
    o.unbeantwortet
      ? `${anzahl(o.unbeantwortet, "unbeantworteter Kommentar", "unbeantwortete Kommentare")} von ${lieferantName ?? "dem Lieferanten"}`
      : null,
  ].filter(Boolean).join(" · ");
}

/** Eine Positionsgruppe, einklappbar: Kopf «Pos 01  Rahmen · 3 Einzel-
 *  positionen», aufgeklappt darunter die Beschreibung und ihre Einzel-
 *  positionen (oder der Hinweis, dass der Lieferant die Loesung waehlt). */
function GruppeBlock({
  gruppe, positionen, positionProps, offen, onToggle, offenePunkte, canEdit, busy, katalog, regeln, lieferantName,
  onAktion, onPaket, onQuelle, onDelete,
}: {
  gruppe: GruppeVoll;
  positionen: PositionVoll[];
  positionProps: (p: PositionVoll) => PositionZeileProps;
  offen: boolean;
  onToggle: () => void;
  offenePunkte: GruppeOffen;
  canEdit: boolean;
  busy: string | null;
  katalog: KatalogArtikel[];
  regeln: LieferantRegel[];
  lieferantName: string | null;
  onAktion: OnAktion;
  onPaket: (r: LieferantRegel) => Promise<boolean>;
  onQuelle?: () => void;
  onDelete: () => void;
}) {
  const [bearbeiten, setBearbeiten] = useState(false);
  const [neuOffen, setNeuOffen] = useState(false);
  const gBusy = busy === `grp_${gruppe.id}`;
  const beschreibung = gruppeBeschreibung(gruppe);
  const ki = gruppe.created_via === "ki";

  return (
    <GruppeKlappe
      nummer={gruppe.nummer}
      titel={gruppe.titel}
      offen={offen}
      onToggle={onToggle}
      info={positionen.length > 0
        ? anzahl(positionen.length, "Einzelposition", "Einzelpositionen")
        : `${lieferantName ?? "Lieferant"} wählt`}
      marker={<OffenMarker anzahl={offenePunkte.total} tooltip={offenTooltip(offenePunkte, lieferantName)} />}
      // Reihenfolge wie bei den Einzelpositionen: Quelle · Etikett · Knoepfe.
      aktionen={onQuelle || ki || canEdit ? (hover) => (
        <>
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
          {ki && (
            <QuelleBadge
              quelle="kunde"
              tooltip={`${quelleText(gruppe.quelle_item)}${gruppe.manuell_geaendert_at ? " · von Hand angepasst (die KI ändert sie nicht mehr)" : ""}`}
            />
          )}
          {canEdit && (
            <span className="flex items-center gap-0.5 shrink-0" style={{ visibility: hover ? "visible" : "hidden" }}>
              <button
                type="button"
                onClick={() => setBearbeiten(true)}
                disabled={gBusy}
                className="icon-btn icon-btn-muted"
                data-tooltip="Titel, Beschreibung und Zusammenhang ändern"
                aria-label="Titel, Beschreibung und Zusammenhang ändern"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={onDelete}
                disabled={gBusy}
                className="icon-btn icon-btn-red text-red-500"
                data-tooltip="Position entfernen"
                aria-label="Position entfernen"
              >
                {gBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            </span>
          )}
        </>
      ) : undefined}
      kopfErsatz={bearbeiten ? (
        <div className="p-1.5">
          <GruppeForm
            start={{ titel: gruppe.titel, text: gruppe.text.trim(), zusammenhang: (gruppe.zusammenhang ?? "").trim() }}
            busy={gBusy}
            hinweis={ki && !gruppe.manuell_geaendert_at ? "Von Hand angepasst — die Eingang-KI ändert diese Position danach nicht mehr." : undefined}
            onSave={async (titel, text, zusammenhang) => {
              const ok = await onAktion({ aktion: "anforderung_edit", id: gruppe.id, titel, text, zusammenhang }, `grp_${gruppe.id}`, "Gespeichert");
              if (ok) setBearbeiten(false);
              return ok;
            }}
            onCancel={() => setBearbeiten(false)}
          />
        </div>
      ) : undefined}
    >
      {beschreibung && !bearbeiten && (
        <p className="text-sm text-foreground/80 break-words whitespace-pre-wrap">{beschreibung}</p>
      )}
      {!bearbeiten && <ZusammenhangAbsatz text={gruppeZusammenhang(gruppe)} />}
      {positionen.map((pos) => <PositionZeile key={pos.id} {...positionProps(pos)} />)}
      {canEdit && neuOffen ? (
        <PositionNeu
          gruppeId={gruppe.id}
          katalog={katalog}
          regeln={regeln}
          busy={busy}
          lieferantName={lieferantName}
          onAktion={onAktion}
          onPaket={onPaket}
          onClose={() => setNeuOffen(false)}
        />
      ) : (positionen.length === 0 || canEdit) && (
        // Eine Zeile: Hinweis (ohne Einzelpositionen) + «+ Einzelposition».
        <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap">
          {positionen.length === 0 && (
            <p className="text-xs italic text-muted-foreground">
              Keine Einzelpositionen — {lieferantName ?? "der Techniklieferant"} wählt die passende Lösung.
            </p>
          )}
          {canEdit && (
            <TextKnopf onClick={() => setNeuOffen(true)} disabled={busy !== null}>
              <Plus className="h-3 w-3" /> Einzelposition
            </TextKnopf>
          )}
        </div>
      )}
    </GruppeKlappe>
  );
}

/** Einzelposition erfassen: Katalog des festen Lieferanten als Vorschlag,
 *  freie Bezeichnung per «Neu» (SearchableSelect mit Neuanlage) + Menge.
 *  Regeln des Lieferanten (Pakete/Hinweise) erscheinen darunter. */
function PositionNeu({ gruppeId, katalog, regeln, busy, lieferantName, onAktion, onPaket, onClose }: {
  gruppeId: string;
  katalog: KatalogArtikel[];
  regeln: LieferantRegel[];
  busy: string | null;
  lieferantName: string | null;
  onAktion: OnAktion;
  onPaket: (r: LieferantRegel) => Promise<boolean>;
  onClose: () => void;
}) {
  const [artikelId, setArtikelId] = useState("");
  const [bezeichnung, setBezeichnung] = useState("");
  const [kategorie, setKategorie] = useState("");
  const [menge, setMenge] = useState("1");
  const [hinweise, setHinweise] = useState<LieferantRegel[]>([]);
  const key = `pos_neu_${gruppeId}`;

  function artikelGewaehlt(id: string) {
    setArtikelId(id);
    const a = katalog.find((k) => k.id === id);
    if (a) {
      setBezeichnung(a.name);
      setKategorie(a.hauptkategorie);
      setHinweise(passendeRegeln(regeln, a.name, a.hauptkategorie));
    } else {
      setBezeichnung("");
      setKategorie("");
    }
  }

  async function hinzufuegen() {
    const b = bezeichnung.trim();
    const m = Number(menge);
    if (!b || !Number.isInteger(m) || m < 1) {
      toast.error("Bezeichnung und ganze Menge ab 1 angeben");
      return;
    }
    const ok = await onAktion({
      aktion: "position_neu",
      gruppeId,
      bezeichnung: b,
      menge: m,
      kategorie: kategorie || undefined,
      artikelId: artikelId || undefined,
    }, key);
    if (ok) {
      setHinweise(passendeRegeln(regeln, b, kategorie));
      setArtikelId("");
      setBezeichnung("");
      setKategorie("");
      setMenge("1");
    }
  }

  return (
    <div className="space-y-1.5 pt-0.5">
      <div className="flex items-center gap-1.5 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <SearchableSelect
            value={artikelId}
            onChange={artikelGewaehlt}
            items={katalog.map((a) => ({ id: a.id, label: a.name, sub: a.hauptkategorie }))}
            placeholder={katalog.length ? "Aus Katalog wählen oder neu eingeben…" : "Bezeichnung eingeben…"}
            onCreateNew={(q) => {
              const t = q.trim().slice(0, 200);
              setArtikelId("");
              setBezeichnung(t);
              setKategorie("");
              setHinweise(passendeRegeln(regeln, t));
            }}
            createNewLabel="Neu"
            commitFreeTextOnBlur
            freeTextDisplay={!artikelId && bezeichnung ? bezeichnung : undefined}
          />
        </div>
        <input
          type="number"
          min={1}
          step={1}
          value={menge}
          onChange={(e) => setMenge(e.target.value)}
          aria-label="Menge"
          className="w-16 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />
        <button
          type="button"
          onClick={() => void hinzufuegen()}
          disabled={busy !== null || !bezeichnung.trim()}
          className="kasten kasten-blue"
        >
          {busy === key ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Hinzufügen
        </button>
        <button type="button" onClick={onClose} className="icon-btn icon-btn-muted" data-tooltip="Schliessen" aria-label="Schliessen">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {/* Regel-Hinweise des Lieferanten */}
      {hinweise.map((r) => (
        <div key={r.id} className="flex items-center gap-2 flex-wrap rounded-lg border border-blue-200/70 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-500/10 px-2.5 py-1.5">
          <Sparkles className="h-3.5 w-3.5 text-blue-600 dark:text-blue-300 shrink-0" />
          <p className="text-xs text-blue-900 dark:text-blue-100 flex-1 min-w-0">
            {r.art === "hinweis"
              ? <>{lieferantName ?? "Lieferant"}: {r.hinweis}</>
              : <>Dazu gehört laut {lieferantName ?? "Lieferant"}: {r.paket?.map((p) => `${p.menge}× ${p.bezeichnung}`).join(", ")}</>}
          </p>
          {r.art === "paket" && (
            <button
              type="button"
              onClick={() => void onPaket(r).then((ok) => { if (ok) setHinweise((prev) => prev.filter((x) => x.id !== r.id)); })}
              disabled={busy !== null}
              className="kasten kasten-blue shrink-0"
            >
              {busy === `paket_${r.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              Paket übernehmen
            </button>
          )}
          <button
            type="button"
            onClick={() => setHinweise((prev) => prev.filter((x) => x.id !== r.id))}
            className="icon-btn icon-btn-muted shrink-0"
            data-tooltip="Hinweis ausblenden"
            aria-label="Hinweis ausblenden"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

interface PositionZeileProps {
  pos: PositionVoll;
  reviews: TechnikReview[];
  kommentare: TechnikKommentar[];
  reviewKommentare: TechnikKommentar[];
  canEdit: boolean;
  busy: string | null;
  katalog: KatalogArtikel[];
  gruppeItems: { id: string; label: string }[];
  lieferantName: string | null;
  kommentarOffen: boolean;
  onKommentarToggle: () => void;
  onAktion: OnAktion;
  onKommentar: (body: string, reviewId?: string) => Promise<boolean>;
  onConfirmDelete: () => void;
  onQuelle?: () => void;
  /** Nach dem Verschieben in eine andere Positionsgruppe (deren ID). */
  onGruppeWechsel: (gruppeId: string) => void;
}

function PositionZeile({
  pos, reviews, kommentare, reviewKommentare, canEdit, busy, katalog, gruppeItems, lieferantName, kommentarOffen,
  onKommentarToggle, onAktion, onKommentar, onConfirmDelete, onQuelle, onGruppeWechsel,
}: PositionZeileProps) {
  const [hover, setHover] = useState(false);
  const [mengeEdit, setMengeEdit] = useState(false);
  const [menge, setMenge] = useState(String(pos.menge));
  // Bezeichnung + Zuordnung bearbeiten (eigene Zeile, explizit Speichern)
  const [bearbeiten, setBearbeiten] = useState(false);
  const [bez, setBez] = useState(pos.bezeichnung);
  const [artikelId, setArtikelId] = useState(pos.artikel_id ?? "");
  const [kat, setKat] = useState(pos.kategorie);
  const [gruppeId, setGruppeId] = useState(pos.gruppe_id);
  const [erledigteOffen, setErledigteOffen] = useState(false);
  const ampel = positionAmpel(pos, reviews);
  const offeneReviews = reviews.filter((r) => r.status === "offen");
  const entschiedeneReviews = reviews.filter((r) => r.status !== "offen");
  const posBusy = busy === `pos_${pos.id}`;

  function bearbeitenStart() {
    setBez(pos.bezeichnung);
    setArtikelId(pos.artikel_id ?? "");
    setKat(pos.kategorie);
    setGruppeId(pos.gruppe_id);
    setBearbeiten(true);
  }

  async function bearbeitenSpeichern() {
    const b = bez.trim();
    if (!b) { toast.error("Bezeichnung darf nicht leer sein"); return; }
    const patch: Record<string, unknown> = { aktion: "position_edit", id: pos.id };
    if (b !== pos.bezeichnung) {
      patch.bezeichnung = b;
      patch.artikelId = artikelId || null;
      patch.kategorie = kat;
    }
    if (gruppeId !== pos.gruppe_id) patch.gruppeId = gruppeId;
    if (Object.keys(patch).length === 2) { setBearbeiten(false); return; }
    if (await onAktion(patch, `pos_${pos.id}`, b !== pos.bezeichnung && pos.status === "bestaetigt" ? "Gespeichert — Bestätigung zurückgesetzt" : "Gespeichert")) {
      setBearbeiten(false);
      if (patch.gruppeId) onGruppeWechsel(gruppeId);
    }
  }

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
        className="flex items-center gap-2 px-2.5 py-1"
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
        <span className="text-sm flex-1 min-w-0 truncate" data-tooltip={pos.details ? `${pos.bezeichnung} — ${pos.details}` : undefined}>
          {pos.bezeichnung}
          {pos.details && <span className="text-xs text-muted-foreground"> — {pos.details}</span>}
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
        <QuelleBadge
          quelle={pos.quelle}
          tooltip={pos.quelle === "kunde"
            ? `${quelleText(pos.quelle_item)}${pos.manuell_geaendert_at ? " · von Hand angepasst" : ""}`
            : pos.quelle === "lieferant" ? "Vom Lieferanten empfohlen und übernommen" : undefined}
        />
        {pos.status === "bestaetigt" && (
          <BestaetigtHaken
            von={pos.bestaetiger ? { name: pos.bestaetiger.full_name, vonLieferant: !!pos.bestaetiger.lieferant_id } : null}
            am={pos.bestaetigt_at}
            lieferantName={lieferantName}
          />
        )}
        {canEdit && (hover || kommentarOffen) && !bearbeiten && (
          <span className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={bearbeitenStart}
              disabled={posBusy}
              className="icon-btn icon-btn-muted"
              data-tooltip="Bezeichnung oder Position ändern"
              aria-label="Bezeichnung oder Position ändern"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
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
              data-tooltip="Einzelposition entfernen"
              aria-label="Einzelposition entfernen"
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

      {bearbeiten && (
        <div className="border-t border-border/60 px-2.5 py-2 flex items-center gap-1.5 flex-wrap">
          <div className="flex-1 min-w-[180px]">
            <SearchableSelect
              value={artikelId && bez === (katalog.find((k) => k.id === artikelId)?.name ?? "") ? artikelId : ""}
              onChange={(id) => {
                const a = katalog.find((k) => k.id === id);
                setArtikelId(id);
                if (a) { setBez(a.name); setKat(a.hauptkategorie); }
              }}
              items={katalog.map((a) => ({ id: a.id, label: a.name, sub: a.hauptkategorie }))}
              placeholder="Bezeichnung"
              onCreateNew={(q) => { setArtikelId(""); setBez(q.trim().slice(0, 200)); setKat("Sonstiges"); }}
              createNewLabel="Neu"
              commitFreeTextOnBlur
              freeTextDisplay={bez}
            />
          </div>
          {gruppeItems.length > 1 ? (
            <div className="w-56 max-w-full">
              <SearchableSelect
                value={gruppeId}
                onChange={setGruppeId}
                items={gruppeItems}
                clearable={false}
                placeholder="Position wählen"
              />
            </div>
          ) : null}
          <button type="button" onClick={() => void bearbeitenSpeichern()} disabled={posBusy || !bez.trim()} className="kasten kasten-blue">
            {posBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {posBusy ? "Wird gespeichert…" : "Speichern"}
          </button>
          <button type="button" onClick={() => setBearbeiten(false)} disabled={posBusy} className="kasten kasten-muted">Abbrechen</button>
          {pos.status === "bestaetigt" && (
            <span className="basis-full text-[11px] text-muted-foreground">Eine neue Bezeichnung setzt die Bestätigung zurück — der Lieferant prüft die Einzelposition erneut.</span>
          )}
        </div>
      )}

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
          {/* Erledigte Punkte des Lieferanten eingeklappt (Nachschlagen). */}
          {entschiedeneReviews.length > 0 && (
            <ErledigtUmschalter
              offen={erledigteOffen}
              anzahl={entschiedeneReviews.length}
              onToggle={() => setErledigteOffen(!erledigteOffen)}
            />
          )}
          {erledigteOffen && entschiedeneReviews.map((r) => {
            const verlauf = reviewKommentare.filter((k) => k.review_id === r.id);
            return (
              <div key={r.id} className="space-y-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ReviewArtChip art={r.art} />
                  <span className="flex-1 min-w-0 truncate" data-tooltip={r.text}>{r.text}</span>
                  <ReviewStatusChip status={r.status} />
                </div>
                {/* Verlauf zum Nachschlagen, ohne Antwortfeld (Punkt ist entschieden). */}
                {verlauf.length > 0 && (
                  <div className="pl-5">
                    <KommentarThread kommentare={verlauf} onSend={async () => false} nurLesen />
                  </div>
                )}
              </div>
            );
          })}
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
  onAktion: OnAktion;
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
                data-tooltip={review.vorschlag ? "Vorschlag wird direkt in die Planung übernommen" : "Als übernommen markieren"}
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
          // Entschiedene Punkte: Verlauf lesbar, keine Antwort mehr.
          nurLesen={!canEdit || !offen}
        />
      )}
      {!offen && <ReviewStatusChip status={review.status} />}
    </div>
  );
}
