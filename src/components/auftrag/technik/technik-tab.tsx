"use client";

// Auftrag → Tab "Technik" — gemeinsame technische Planung mit dem
// Techniklieferanten (Migration 263).
//
// Aufbau (kompakt, Mini-Labels statt Card-Inflation):
//   1. Kopf: Lieferant zuweisen + Anfrage senden + Zusammenfassung
//   2. Kundenwünsche (Anforderungs-Ebene, getrennt von der Technik)
//   3. Technikplan: Positionen nach Kategorie, Ampel, Review-Punkte inline
//   4. Allgemeine Punkte des Lieferanten (ohne Positions-Bezug)
//   5. Aktivität
//
// Alle Mutationen laufen ueber POST /api/jobs/[id]/technik (Aktivitaet +
// Benachrichtigungen zentral); Lesen direkt per Client-Supabase (staff-RLS).

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { SearchableSelect } from "@/components/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import {
  Loader2, Send, Plus, Trash2, Check, Wrench, ListChecks, Activity as ActivityIcon,
  MessageSquare, Sparkles, X, FileText, Map as MapIcon, MapPin,
} from "lucide-react";
import type {
  LieferantRegel, TechnikAnforderung, TechnikAktivitaet, TechnikKommentar,
  TechnikPosition, TechnikReview,
} from "@/lib/technik";
import { PlanEditor, type EditorMaterial } from "@/components/plan2d/plan-editor";
import type { PlanUnterlage, PlanPos, PlanObjekt } from "@/lib/plan2d";
import { passendeRegeln, positionAmpel } from "@/lib/technik";
import {
  AktivitaetListe, AmpelDot, BestaetigtHaken, KommentarThread, QuelleBadge,
  ReviewArtChip, ReviewStatusChip, REVIEW_STYLES, Sektion, techDatum, techTag,
} from "@/components/technik/technik-shared";

interface LieferantOption { id: string; name: string; type: string | null }
interface KatalogArtikel { id: string; name: string; hauptkategorie: string }

/** Technik-Position mit den Plan-/KI-Feldern aus Migration 264. */
interface PositionVoll extends TechnikPosition {
  masse: { l: number | null; b: number | null; h: number | null } | null;
  position: (PlanPos | null)[] | null;
  created_via: "ki" | "manuell";
  quelle: TechnikPosition["quelle"];
  quelle_item: { kind: string; content: string | null; file_name: string | null } | null;
}

interface Props {
  jobId: string;
  locationId: string | null;
  jobNumber: number | null;
  canEdit: boolean;
}

export function TechnikTab({ jobId, locationId, jobNumber, canEdit }: Props) {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [lieferanten, setLieferanten] = useState<LieferantOption[]>([]);
  const [zuweisung, setZuweisung] = useState<{ lieferantId: string; name: string; angefragtAt: string | null; runden: number } | null>(null);
  const [anforderungen, setAnforderungen] = useState<TechnikAnforderung[]>([]);
  const [positionen, setPositionen] = useState<PositionVoll[]>([]);
  // Aufbauplan (aus dem frueheren "Material & Plan"-Tab uebernommen)
  const [unterlage, setUnterlage] = useState<PlanUnterlage | null>(null);
  const [unterlageUrl, setUnterlageUrl] = useState<string | null>(null);
  const [locationName, setLocationName] = useState<string | null>(null);
  const [planObjekte, setPlanObjekte] = useState<PlanObjekt[]>([]);
  const [quelleModal, setQuelleModal] = useState<PositionVoll["quelle_item"] | null>(null);
  const [reviews, setReviews] = useState<TechnikReview[]>([]);
  const [kommentare, setKommentare] = useState<TechnikKommentar[]>([]);
  const [aktivitaet, setAktivitaet] = useState<TechnikAktivitaet[]>([]);
  const [katalog, setKatalog] = useState<KatalogArtikel[]>([]);
  const [regeln, setRegeln] = useState<LieferantRegel[]>([]);
  const [angebote, setAngebote] = useState<{ id: string; name: string; storage_path: string; created_at: string }[]>([]);

  // Eingabe-States
  const [neuerWunsch, setNeuerWunsch] = useState("");
  const [neuBezeichnung, setNeuBezeichnung] = useState("");
  const [neuMenge, setNeuMenge] = useState("1");
  const [neuKategorie, setNeuKategorie] = useState("");
  const [neuArtikelId, setNeuArtikelId] = useState("");
  const [kommentarOffen, setKommentarOffen] = useState<string | null>(null); // position_id
  const [regelHinweise, setRegelHinweise] = useState<LieferantRegel[]>([]);

  const laden = useCallback(async () => {
    const [lief, zuw, anf, pos, rev, kom, akt, loc, obj, ang] = await Promise.all([
      supabase.from("lieferanten").select("id, name, type").eq("is_active", true).order("name"),
      supabase.from("job_lieferanten").select("lieferant_id, angefragt_at, anfrage_runden, lieferant:lieferanten(name)").eq("job_id", jobId).maybeSingle(),
      supabase.from("job_anforderungen").select("id, text, sort").eq("job_id", jobId).order("sort").order("created_at"),
      supabase.from("job_technik_positionen").select("id, anforderung_id, artikel_id, kategorie, bezeichnung, details, menge, status, quelle, bestaetigt_at, sort, created_at, masse, position, created_via, quelle_item:job_inbox_items(kind, content, file_name)").eq("job_id", jobId).order("kategorie").order("created_at"),
      supabase.from("job_technik_reviews").select("id, position_id, art, text, vorschlag, status, created_at, entschieden_at").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_kommentare").select("id, position_id, review_id, body, created_at, author:profiles(full_name, role)").eq("job_id", jobId).order("created_at"),
      supabase.from("job_technik_aktivitaet").select("id, actor_name, aktion, beschreibung, created_at").eq("job_id", jobId).order("created_at", { ascending: false }).limit(60),
      locationId
        ? supabase.from("locations").select("name, plan_unterlage").eq("id", locationId).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("job_plan_objekte").select("id, typ, label, x, y, rot, breite, tiefe").eq("job_id", jobId),
      supabase.from("documents").select("id, name, storage_path, created_at").eq("job_id", jobId).eq("folder", "Angebote").order("created_at", { ascending: false }),
    ]);
    setLieferanten((lief.data ?? []) as LieferantOption[]);
    const z = zuw.data as { lieferant_id: string; angefragt_at: string | null; anfrage_runden: number | null; lieferant: { name: string } | { name: string }[] | null } | null;
    const zLief = z ? (Array.isArray(z.lieferant) ? z.lieferant[0] : z.lieferant) : null;
    setZuweisung(z ? { lieferantId: z.lieferant_id, name: zLief?.name ?? "Lieferant", angefragtAt: z.angefragt_at, runden: z.anfrage_runden ?? 0 } : null);
    setAnforderungen((anf.data ?? []) as TechnikAnforderung[]);
    setPositionen(((pos.data ?? []) as unknown as (Omit<PositionVoll, "quelle_item"> & {
      quelle_item: PositionVoll["quelle_item"] | PositionVoll["quelle_item"][] | null;
    })[]).map((p) => ({
      ...p,
      quelle_item: Array.isArray(p.quelle_item) ? (p.quelle_item[0] ?? null) : p.quelle_item,
    })));
    setPlanObjekte((obj.data ?? []) as unknown as PlanObjekt[]);
    setAngebote((ang.data ?? []) as { id: string; name: string; storage_path: string; created_at: string }[]);
    setLocationName((loc.data as { name?: string } | null)?.name ?? null);
    const u = ((loc.data as { plan_unterlage?: PlanUnterlage | null } | null)?.plan_unterlage) ?? null;
    setUnterlage(u);
    if (u?.path) {
      const { data: s } = await supabase.storage.from("documents").createSignedUrl(u.path, 3600);
      setUnterlageUrl(s?.signedUrl ?? null);
    } else {
      setUnterlageUrl(null);
    }
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

    if (z?.lieferant_id) {
      const [kat, reg] = await Promise.all([
        supabase.from("lieferant_katalog_artikel").select("id, name, hauptkategorie").eq("lieferant_id", z.lieferant_id).eq("is_active", true).order("hauptkategorie").order("name"),
        supabase.from("lieferant_regeln").select("id, art, trigger_text, hinweis, paket, is_active").eq("lieferant_id", z.lieferant_id),
      ]);
      setKatalog((kat.data ?? []) as KatalogArtikel[]);
      setRegeln((reg.data ?? []) as LieferantRegel[]);
    } else {
      setKatalog([]);
      setRegeln([]);
    }
  }, [supabase, jobId, locationId]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await laden();
      } finally {
        setLoading(false);
      }
    })();
  }, [laden]);

  async function aktion(payload: Record<string, unknown>, busyKey: string, erfolg?: string): Promise<boolean> {
    setBusy(busyKey);
    try {
      const res = await fetch(`/api/jobs/${jobId}/technik`, {
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
      toast.error("Bezeichnung und Menge angeben");
      return;
    }
    const ok = await aktion({
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
    try {
      for (const p of regel.paket) {
        await fetch(`/api/jobs/${jobId}/technik`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aktion: "position_neu", bezeichnung: p.bezeichnung, menge: p.menge, kategorie: p.kategorie }),
        });
      }
      await laden();
      toast.success(`Paket übernommen (${regel.paket.length} Positionen)`);
      setRegelHinweise((prev) => prev.filter((r) => r.id !== regel.id));
    } finally {
      setBusy(null);
    }
  }

  // --- Aufbauplan (Plan-Editor mit Technik-Positionen) --------------------
  const onMaterialPositionen = useCallback(async (positionId: string, positionen: (PlanPos | null)[]) => {
    const { error } = await supabase.from("job_technik_positionen").update({ position: positionen }).eq("id", positionId);
    if (error) toast.error("Platzierung konnte nicht gespeichert werden");
  }, [supabase]);

  const onObjektNeu = useCallback(async (o: Omit<PlanObjekt, "id">): Promise<PlanObjekt | null> => {
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("job_plan_objekte")
      .insert({ job_id: jobId, ...o, created_by: user?.id ?? null })
      .select("id, typ, label, x, y, rot, breite, tiefe")
      .single();
    if (error || !data) { toast.error("Objekt konnte nicht angelegt werden"); return null; }
    return data as unknown as PlanObjekt;
  }, [supabase, jobId]);

  const onObjektUpdate = useCallback(async (id: string, patch: Partial<PlanObjekt>) => {
    const { error } = await supabase.from("job_plan_objekte").update(patch).eq("id", id);
    if (error) toast.error("Objekt konnte nicht gespeichert werden");
  }, [supabase]);

  const onObjektLoeschen = useCallback(async (id: string) => {
    const { error } = await supabase.from("job_plan_objekte").delete().eq("id", id);
    if (error) toast.error("Objekt konnte nicht gelöscht werden");
  }, [supabase]);

  const editorMaterial: EditorMaterial[] = positionen.map((p) => ({
    id: p.id,
    bezeichnung: p.bezeichnung,
    menge: Math.min(Math.max(1, Math.round(p.menge)), 60),
    masse: p.masse,
    positionen: p.position ?? [],
  }));

  // --- Gruppierung --------------------------------------------------------
  const kategorien = useMemo(() => {
    const set = new Set<string>();
    positionen.forEach((p) => set.add(p.kategorie));
    return Array.from(set).sort((a, b) => a.localeCompare(b, "de"));
  }, [positionen]);

  const allgemeineReviews = reviews.filter((r) => r.position_id === null);
  const offeneReviews = reviews.filter((r) => r.status === "offen");
  const bestaetigtZahl = positionen.filter((p) => p.status === "bestaetigt").length;
  const platziert = positionen.reduce((n, p) => n + (p.position ?? []).filter(Boolean).length, 0);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
        <Loader2 className="h-4 w-4 animate-spin" /> Technik-Planung wird geladen…
      </div>
    );
  }

  return (
    // Raster statt Einspalter (Leo 2026-09-24): links die Arbeit
    // (Technikplan + Aufbauplan), rechts die Randinfos (Wuensche, Punkte,
    // Aktivitaet). items-start: Spalten sizen nach Inhalt (§14, kein
    // Zwang-Fuellen); unter lg stapelt alles wieder untereinander.
    <div className="space-y-3">
      {/* 1. Kopf: Lieferant + Anfrage + Status-Chips */}
      <Card className="bg-card">
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <MiniLabel icon={<Wrench className="h-3.5 w-3.5" />}>Techniklieferant</MiniLabel>
            <span className="flex items-center gap-1.5 flex-wrap">
              {positionen.length > 0 && (
                <StatusChip
                  cls={bestaetigtZahl === positionen.length
                    ? "bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-300"
                    : "bg-muted text-muted-foreground"}
                  text={`${bestaetigtZahl}/${positionen.length} bestätigt`}
                />
              )}
              {(["empfehlung", "problem", "frage"] as const).map((art) => {
                const n = offeneReviews.filter((r) => r.art === art).length;
                if (!n) return null;
                const cls = art === "empfehlung"
                  ? "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300"
                  : art === "problem"
                    ? "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-300"
                    : "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300";
                const label = art === "empfehlung"
                  ? (n === 1 ? "Empfehlung" : "Empfehlungen")
                  : art === "problem" ? (n === 1 ? "Problem" : "Probleme") : (n === 1 ? "Frage" : "Fragen");
                return <StatusChip key={art} cls={cls} text={`${n} ${label}`} />;
              })}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="w-72 max-w-full">
              <SearchableSelect
                value={zuweisung?.lieferantId ?? ""}
                onChange={(id) => {
                  if (!canEdit) return;
                  void aktion({ aktion: "lieferant_setzen", lieferantId: id || null }, "lieferant",
                    id ? "Lieferant zugewiesen" : "Lieferant entfernt");
                }}
                items={lieferanten.map((l) => ({ id: l.id, label: l.name, sublabel: l.type ?? undefined }))}
                placeholder="— Lieferant wählen —"
              />
            </div>
            {busy === "lieferant" && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            {zuweisung && canEdit && (
              <button
                type="button"
                onClick={async () => {
                  const ok = await confirm({
                    title: "Anfrage senden?",
                    message: `«${zuweisung.name}» wird benachrichtigt und sieht die Technik-Planung dieses Auftrags im Lieferantenportal (${positionen.length} Positionen).`,
                    confirmLabel: "Anfrage senden",
                  });
                  if (!ok) return;
                  void aktion({ aktion: "anfrage_senden" }, "anfrage", "Anfrage gesendet");
                }}
                disabled={busy !== null || positionen.length === 0}
                className="kasten kasten-blue"
                data-tooltip={positionen.length === 0 ? "Zuerst Positionen erfassen" : "Lieferant benachrichtigen — er prüft die Planung im Portal"}
              >
                {busy === "anfrage" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                {zuweisung.angefragtAt ? "Erneut anfragen" : "Anfrage senden"}
              </button>
            )}
            {zuweisung?.angefragtAt && (
              <span className="text-xs text-muted-foreground">
                {zuweisung.runden > 1 ? `Runde ${zuweisung.runden} · angefragt` : "Angefragt"} am {techDatum(zuweisung.angefragtAt)}
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
                  canEdit={canEdit}
                  busy={busy}
                  kommentarOffen={kommentarOffen === pos.id}
                  onKommentarToggle={() => setKommentarOffen(kommentarOffen === pos.id ? null : pos.id)}
                  onAktion={aktion}
                  onKommentar={(body, reviewId) =>
                    aktion({ aktion: "kommentar_neu", positionId: pos.id, reviewId, body }, `kom_${pos.id}`)}
                  onQuelle={pos.created_via === "ki" && pos.quelle_item ? () => setQuelleModal(pos.quelle_item) : undefined}
                  onConfirmDelete={async () => {
                    const ok = await confirm({
                      title: "Position entfernen?",
                      message: `${pos.menge}× ${pos.bezeichnung} wird aus dem Technikplan entfernt.`,
                      confirmLabel: "Entfernen",
                      variant: "red",
                    });
                    if (ok) void aktion({ aktion: "position_loeschen", id: pos.id }, `pos_${pos.id}`);
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
                      ? <>{zuweisung?.name ?? "Lieferant"}: {r.hinweis}</>
                      : <>Dazu gehört laut {zuweisung?.name ?? "Lieferant"}: {r.paket?.map((p) => `${p.menge}× ${p.bezeichnung}`).join(", ")}</>}
                  </p>
                  {r.art === "paket" && canEdit && (
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
                    className="p-1 rounded hover:bg-foreground/10 shrink-0"
                    data-tooltip="Hinweis ausblenden"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Hinzufuegen — eine ruhige Zeile, Placeholder statt Labels. */}
          {canEdit && (
            <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t border-border/60">
              {katalog.length > 0 && (
                <div className="w-56 max-w-full">
                  <SearchableSelect
                    value={neuArtikelId}
                    onChange={artikelGewaehlt}
                    items={katalog.map((a) => ({ id: a.id, label: a.name, sublabel: a.hauptkategorie }))}
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
                placeholder="Bezeichnung, z.B. Funkmikrofon"
                className="flex-1 min-w-[160px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <input
                type="number"
                min={1}
                value={neuMenge}
                onChange={(e) => setNeuMenge(e.target.value)}
                aria-label="Menge"
                className="w-16 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <input
                type="text"
                value={neuKategorie}
                onChange={(e) => setNeuKategorie(e.target.value)}
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

      {/* 4. Aufbauplan — schwergewichtig, darum standardmaessig zu. */}
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
              material={editorMaterial}
              objekte={planObjekte}
              editierbar={canEdit}
              hoehe={580}
              onMaterialPositionen={onMaterialPositionen}
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
                canEdit={canEdit}
                onSave={(text) => aktion({ aktion: "anforderung_edit", id: a.id, text }, `anf_${a.id}`)}
                onDelete={() => aktion({ aktion: "anforderung_loeschen", id: a.id }, `anf_${a.id}`)}
                busy={busy === `anf_${a.id}`}
              />
            ))}
          </div>
          {canEdit && (
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={neuerWunsch}
                onChange={(e) => setNeuerWunsch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (neuerWunsch.trim()) {
                      void aktion({ aktion: "anforderung_neu", text: neuerWunsch.trim() }, "anf_neu").then((ok) => {
                        if (ok) setNeuerWunsch("");
                      });
                    }
                  }
                }}
                placeholder="Wunsch erfassen…"
                className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
              />
              <button
                type="button"
                onClick={() => {
                  if (!neuerWunsch.trim()) return;
                  void aktion({ aktion: "anforderung_neu", text: neuerWunsch.trim() }, "anf_neu").then((ok) => {
                    if (ok) setNeuerWunsch("");
                  });
                }}
                disabled={busy !== null || !neuerWunsch.trim()}
                className="kasten kasten-muted shrink-0"
                data-tooltip="Wunsch hinzufügen"
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
                canEdit={canEdit}
                busy={busy}
                onAktion={aktion}
                onKommentar={(body) => aktion({ aktion: "kommentar_neu", reviewId: r.id, body }, `kom_rev_${r.id}`)}
              />
            ))}
        </Sektion>
      )}

      {/* Angebote des Lieferanten (Upload im Portal) — auch hier sichtbar,
             nicht nur im Dokumente-Tab. */}
      {angebote.length > 0 && (
        <Sektion
          icon={<FileText className="h-3.5 w-3.5" />}
          titel="Angebote"
          zusatz={`${angebote.length} · zuletzt ${techTag(angebote[0].created_at)}`}
          defaultOffen
        >
          <div className="space-y-1">
            {angebote.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={async () => {
                  const { data, error } = await supabase.storage.from("documents").createSignedUrl(a.storage_path, 3600);
                  if (error || !data?.signedUrl) { toast.error("Angebot konnte nicht geöffnet werden"); return; }
                  window.open(data.signedUrl, "_blank", "noopener");
                }}
                className="w-full flex items-center gap-2 text-sm rounded-lg px-1.5 py-1 hover:bg-foreground/[0.05] dark:hover:bg-foreground/[0.12] text-left"
                data-tooltip="Angebot öffnen"
              >
                <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0 truncate">{a.name}</span>
                <span className="text-[11px] text-muted-foreground shrink-0">{techTag(a.created_at)}</span>
              </button>
            ))}
          </div>
        </Sektion>
      )}

      {/* 6. Aktivitaet — Nachschlage-Sektion, immer zu beim Betreten. */}
      <Sektion
        icon={<ActivityIcon className="h-3.5 w-3.5" />}
        titel="Aktivität"
        zusatz={aktivitaet.length > 0 ? `${aktivitaet.length} Einträge · zuletzt ${techDatum(aktivitaet[0].created_at)}` : "noch keine"}
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
            <p className="text-sm text-muted-foreground">Datei: {quelleModal.file_name ?? "unbekannt"} — im Eingang-Tab einsehbar.</p>
          )}
        </Modal>
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

function StatusChip({ cls, text }: { cls: string; text: string }) {
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>{text}</span>;
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
  onDelete: () => Promise<boolean>;
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
            if (e.key === "Enter") {
              e.preventDefault();
              void onSave(text.trim()).then((ok) => { if (ok) setEdit(false); });
            }
            if (e.key === "Escape") { setText(wunsch.text); setEdit(false); }
          }}
          autoFocus
          className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />
        <button type="button" onClick={() => void onSave(text.trim()).then((ok) => { if (ok) setEdit(false); })} disabled={busy || !text.trim()} className="kasten kasten-muted shrink-0">
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
        </button>
      </div>
    );
  }
  return (
    <div
      className="flex items-center gap-2 rounded-lg px-2 py-1 -mx-2"
      style={hover ? { background: "color-mix(in srgb, currentColor 5%, transparent)" } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="text-muted-foreground select-none">•</span>
      <button
        type="button"
        onClick={() => canEdit && setEdit(true)}
        className="text-sm flex-1 min-w-0 text-left"
        data-tooltip={canEdit ? "Klicken zum Bearbeiten" : undefined}
      >
        {wunsch.text}
      </button>
      {canEdit && hover && (
        <button type="button" onClick={() => void onDelete()} disabled={busy} className="p-1 rounded hover:bg-red-500/10 text-red-500 shrink-0" data-tooltip="Wunsch entfernen">
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
  onAktion: (payload: Record<string, unknown>, busyKey: string, erfolg?: string) => Promise<boolean>;
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

  return (
    <div className="rounded-lg border border-border/60">
      <div
        className="flex items-center gap-2 px-2.5 py-1.5"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        <AmpelDot ampel={ampel} title={
          ampel === "gruen" ? "Bestätigt" : ampel === "rot" ? "Problem offen" : ampel === "blau" ? "Frage offen" : ampel === "gelb" ? "Empfehlung offen" : "Geplant"
        } />
        {mengeEdit ? (
          <input
            type="number"
            min={1}
            value={menge}
            autoFocus
            onChange={(e) => setMenge(e.target.value)}
            onBlur={() => {
              setMengeEdit(false);
              const m = Number(menge);
              if (Number.isInteger(m) && m > 0 && m !== pos.menge) {
                void onAktion({ aktion: "position_edit", id: pos.id, menge: m }, `pos_${pos.id}`);
              } else setMenge(String(pos.menge));
            }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
            className="w-14 rounded border border-border bg-background px-1.5 py-0.5 text-sm tabular-nums"
          />
        ) : (
          <button
            type="button"
            onClick={() => canEdit && setMengeEdit(true)}
            className="text-sm font-semibold tabular-nums shrink-0"
            data-tooltip={canEdit ? "Menge ändern" : undefined}
          >
            {pos.menge}×
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
            className="p-1 rounded text-muted-foreground/60 hover:text-foreground shrink-0"
            data-tooltip="Aus dem Eingang erkannt — Quelle ansehen"
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
                className="p-1 rounded hover:bg-green-500/10 text-green-600"
                data-tooltip="Als bestätigt markieren"
              >
                {posBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              </button>
            )}
            <button
              type="button"
              onClick={onKommentarToggle}
              className={`p-1 rounded hover:bg-foreground/10 ${kommentare.length > 0 ? "text-blue-500" : "text-muted-foreground"}`}
              data-tooltip="Kommentare"
            >
              <MessageSquare className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={posBusy}
              className="p-1 rounded hover:bg-red-500/10 text-red-500"
              data-tooltip="Position entfernen"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        {!canEdit && kommentare.length > 0 && (
          <button type="button" onClick={onKommentarToggle} className="p-1 rounded text-blue-500" data-tooltip="Kommentare">
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
            <KommentarThread kommentare={kommentare} onSend={async (body) => { await onKommentar(body); }} placeholder="Kommentar an den Lieferanten…" />
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
  onAktion: (payload: Record<string, unknown>, busyKey: string, erfolg?: string) => Promise<boolean>;
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
        <p className={`text-xs flex-1 min-w-0 whitespace-pre-wrap ${s.text}`}>{review.text}</p>
        <span className="text-[10px] text-muted-foreground shrink-0">{techDatum(review.created_at)}</span>
      </div>
      {offen && canEdit && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {review.art === "empfehlung" && (
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
          )}
          <button
            type="button"
            onClick={() => void onAktion({ aktion: "review_entscheiden", id: review.id, entscheid: "ablehnen" }, `rev_${review.id}`, undefined)}
            disabled={rBusy}
            className="kasten kasten-muted"
            data-tooltip={review.art === "empfehlung" ? "Empfehlung ablehnen" : "Punkt als erledigt/abgelehnt schliessen"}
          >
            {rBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
            {review.art === "empfehlung" ? "Ablehnen" : "Schliessen"}
          </button>
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
        <KommentarThread kommentare={kommentare} onSend={async (b) => { await onKommentar(b); setAntworten(false); }} />
      )}
      {!offen && <ReviewStatusChip status={review.status} />}
    </div>
  );
}
