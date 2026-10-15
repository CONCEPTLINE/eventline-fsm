"use client";

/**
 * Katalog-Fenster je Lieferant (/lieferanten) — die Katalog-Verwaltung,
 * frueher eine Liste in Einstellungen › Lieferantenportal (dort bleiben nur
 * die Portal-Zugaenge). Recht lieferanten:edit (Admins automatisch); der
 * Aufrufer blendet den Einstieg sonst aus.
 *
 *   PDF:     ansehen (PdfPopup), hochladen/ersetzen, entfernen; Stand + Datei.
 *   Artikel: Anzahl, ansehen (gleiches KatalogRaster wie im Portal), mit KI
 *            einlesen bzw. neu einlesen. Neu einlesen AKTUALISIERT (Migration
 *            332): bestehende Artikel behalten Bild und Verknuepfungen, neue
 *            kommen dazu, nicht mehr enthaltene werden ausgeblendet.
 *
 * PDF-Ablage wie bisher direkt im documents-Bucket (interne Konten duerfen
 * dort schreiben); die Lieferanten-Zeile aendert die RLS nur mit
 * lieferanten:edit — ein still verworfenes Update gilt als Fehler.
 */

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { PdfPopup } from "@/components/pdf-popup";
import { KatalogRaster, artikelPasst, type KatalogArtikel } from "@/components/lieferanten/katalog-raster";
import { formatDateFull } from "@/lib/format";
import { validateFileSize, MAX_UPLOAD_SIZE_MB } from "@/lib/file-upload";
import { TOAST } from "@/lib/messages";
import { toast } from "sonner";
import { AlertTriangle, ArrowLeft, BookOpen, Eye, FileText, LayoutGrid, Loader2, RotateCw, Search, Sparkles, Trash2, Upload } from "lucide-react";

export type KatalogLieferant = {
  id: string;
  name: string;
  katalog_path: string | null;
  katalog_name: string | null;
  katalog_updated_at: string | null;
  artikel_anzahl: number;
};

type Busy = null | "upload" | "entfernen" | "pdf" | "import";
type ArtikelLaden =
  | { status: "laedt" }
  | { status: "fehler" }
  | { status: "ok"; artikel: KatalogArtikel[]; bilder: Record<string, string> };

/** Abschnitt-Antwort von /api/ai/katalog-import. */
type ImportAntwort = {
  success?: boolean; error?: string; done?: boolean; lauf?: string;
  neu?: number; aktualisiert?: number; deaktiviert?: number; parallel?: boolean;
  total_pages?: number; next_page?: number | null; letzte_kategorie?: string | null;
};

const SEITEN_PRO_ABSCHNITT = 8;

export function KatalogFenster({
  lieferant,
  onClose,
  onGeaendert,
}: {
  lieferant: KatalogLieferant;
  onClose: () => void;
  /** Nach jeder Aenderung — Liste (Stand, Anzahl) neu laden. Wird
   *  abgewartet, damit das Fenster beim Erfolgs-Toast schon den neuen
   *  Stand zeigt (der Spinner laeuft bis dahin weiter). */
  onGeaendert: () => Promise<void>;
}) {
  const supabase = createClient();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [busy, setBusy] = useState<Busy>(null);
  const [importText, setImportText] = useState("");
  const [ansicht, setAnsicht] = useState<"verwaltung" | "artikel">("verwaltung");
  const [artikel, setArtikel] = useState<ArtikelLaden>({ status: "laedt" });
  const [suche, setSuche] = useState("");
  const [pdf, setPdf] = useState<{ url: string; title: string } | null>(null);
  const dateiRef = useRef<HTMLInputElement | null>(null);

  const hatPdf = !!lieferant.katalog_path;
  const n = lieferant.artikel_anzahl;

  async function hochladen(file: File) {
    if (file.type !== "application/pdf") { toast.error("Bitte ein PDF wählen"); return; }
    if (!validateFileSize(file)) return;
    setBusy("upload");
    const path = `lieferanten/${lieferant.id}/katalog_${Date.now()}.pdf`;
    try {
      const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { contentType: "application/pdf" });
      if (upErr) { TOAST.supabaseError(upErr, "Upload fehlgeschlagen"); return; }
      const { data, error: dbErr } = await supabase
        .from("lieferanten")
        .update({ katalog_path: path, katalog_name: file.name, katalog_updated_at: new Date().toISOString() })
        .eq("id", lieferant.id)
        .select("id");
      if (dbErr || !data?.length) {
        // DB scheiterte (oder RLS verwarf still) — hochgeladene Datei wieder weg.
        await supabase.storage.from("documents").remove([path]);
        TOAST.supabaseError(dbErr ?? { code: "42501" }, "Katalog konnte nicht gespeichert werden");
        return;
      }
      // Alte Datei erst nach erfolgreichem Umhaengen loeschen.
      if (lieferant.katalog_path) await supabase.storage.from("documents").remove([lieferant.katalog_path]);
      await onGeaendert();
      toast.success(`Katalog für ${lieferant.name} hinterlegt`);
    } catch {
      toast.error("Upload fehlgeschlagen — bitte nochmals versuchen");
    } finally {
      setBusy(null);
    }
  }

  async function entfernen() {
    if (!lieferant.katalog_path) return;
    const ok = await confirm({
      title: "Katalog-PDF entfernen?",
      message: `Das PDF von ${lieferant.name} wird entfernt. Die eingelesenen Artikel bleiben im Portal sichtbar.`,
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok) return;
    setBusy("entfernen");
    try {
      const { data, error } = await supabase
        .from("lieferanten")
        .update({ katalog_path: null, katalog_name: null, katalog_updated_at: null })
        .eq("id", lieferant.id)
        .select("id");
      if (error || !data?.length) { TOAST.supabaseError(error ?? { code: "42501" }, "Entfernen fehlgeschlagen"); return; }
      await supabase.storage.from("documents").remove([lieferant.katalog_path]);
      await onGeaendert();
      toast.success("Katalog-PDF entfernt");
    } catch {
      toast.error("Entfernen fehlgeschlagen — bitte nochmals versuchen");
    } finally {
      setBusy(null);
    }
  }

  async function pdfAnsehen() {
    if (!lieferant.katalog_path) return;
    setBusy("pdf");
    const { data, error } = await supabase.storage.from("documents").createSignedUrl(lieferant.katalog_path, 3600);
    setBusy(null);
    if (error || !data?.signedUrl) { TOAST.supabaseError(error, "Vorschau nicht verfügbar"); return; }
    setPdf({ url: data.signedUrl, title: lieferant.katalog_name ?? "Katalog.pdf" });
  }

  /** Abschnittsweise einlesen (je 8 Seiten pro KI-Aufruf), Fortschritt live. */
  async function einlesen() {
    const ok = await confirm({
      title: n > 0 ? "Katalog neu einlesen?" : "Katalog mit KI einlesen?",
      message:
        `Die KI liest das PDF von ${lieferant.name} Seite für Seite und ` +
        (n > 0
          ? "aktualisiert die Artikel: bestehende behalten Bild und Verknüpfungen, neue kommen dazu, nicht mehr enthaltene werden ausgeblendet."
          : "baut daraus die Artikel-Liste.") +
        " Das dauert einige Minuten.",
      confirmLabel: "Einlesen",
      variant: "blue",
    });
    if (!ok) return;
    setBusy("import");
    setImportText("Startet…");
    let von = 1;
    let lauf: string | null = null;
    let letzteKategorie: string | null = null;
    let neu = 0;
    let aktualisiert = 0;
    try {
      for (let schutz = 0; schutz < 60; schutz++) {
        const res = await fetch("/api/ai/katalog-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lieferant_id: lieferant.id, from_page: von, to_page: von + SEITEN_PRO_ABSCHNITT - 1,
            letzte_kategorie: letzteKategorie, lauf,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as ImportAntwort;
        if (!res.ok || !j.success) throw new Error(j.error ?? "Einlesen fehlgeschlagen");
        lauf = j.lauf ?? lauf;
        neu += j.neu ?? 0;
        aktualisiert += j.aktualisiert ?? 0;
        if (j.done) {
          const teile = [`${neu + aktualisiert} Artikel erkannt`];
          if (neu) teile.push(`${neu} neu`);
          if (j.deaktiviert) teile.push(`${j.deaktiviert} nicht mehr im Katalog (ausgeblendet)`);
          setImportText("Liste wird aktualisiert…");
          await onGeaendert();
          toast.success(`Katalog eingelesen: ${teile.join(" · ")}`);
          if (j.parallel) {
            toast.warning("Gleichzeitig lief ein zweiter Import dieser Firma — fehlende Artikel wurden darum nicht ausgeblendet. Bitte später nochmals einlesen.");
          }
          return;
        }
        letzteKategorie = j.letzte_kategorie ?? letzteKategorie;
        if (typeof j.next_page !== "number") throw new Error("Unerwartete Antwort vom Import");
        von = j.next_page;
        const total = j.total_pages ?? von;
        setImportText(`Seite ${von}–${Math.min(von + SEITEN_PRO_ABSCHNITT - 1, total)} von ${total} · bisher ${neu + aktualisiert} Artikel`);
      }
      throw new Error("Einlesen abgebrochen — zu viele Abschnitte");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Einlesen fehlgeschlagen");
      // Teilweise eingelesene Abschnitte sind gespeichert — Stand anzeigen.
      await onGeaendert();
    } finally {
      setBusy(null);
      setImportText("");
    }
  }

  // Setzt nur Ergebnis/Fehler; den Lade-Zustand setzt der Aufrufer.
  async function artikelLaden() {
    try {
      const res = await fetch(`/api/lieferant/katalog?lieferant_id=${lieferant.id}`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Artikel konnten nicht geladen werden");
      setArtikel({ status: "ok", artikel: (j.artikel ?? []) as KatalogArtikel[], bilder: j.bilder ?? {} });
    } catch (e) {
      setArtikel({ status: "fehler" });
      toast.error(e instanceof Error ? e.message : "Artikel konnten nicht geladen werden");
    }
  }

  function artikelZeigen() {
    setAnsicht("artikel");
    setSuche("");
    setArtikel({ status: "laedt" });
    void artikelLaden();
  }

  const sichtbar = artikel.status === "ok" ? artikel.artikel.filter((a) => artikelPasst(a, suche)) : [];

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={`Katalog — ${lieferant.name}`}
        icon={<BookOpen className="h-5 w-5 text-muted-foreground" />}
        size={ansicht === "artikel" ? "4xl" : "lg"}
        closable={busy === null}
      >
        {ansicht === "verwaltung" ? (
          <div className="space-y-4">
            {/* PDF */}
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Katalog-PDF</p>
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <p className="text-sm min-w-0 truncate">
                  {hatPdf ? (
                    <>
                      <span className="font-medium">{lieferant.katalog_name ?? "Katalog.pdf"}</span>
                      {lieferant.katalog_updated_at && (
                        <span className="text-muted-foreground"> · Stand {formatDateFull(lieferant.katalog_updated_at)}</span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Noch kein PDF hinterlegt</span>
                  )}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {hatPdf && (
                  <button type="button" onClick={() => void pdfAnsehen()} disabled={busy !== null} className="kasten kasten-muted">
                    {busy === "pdf" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                    Ansehen
                  </button>
                )}
                <button type="button" onClick={() => dateiRef.current?.click()} disabled={busy !== null} className="kasten kasten-muted">
                  {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  {busy === "upload" ? "Wird hochgeladen…" : hatPdf ? "Ersetzen" : "PDF hochladen"}
                </button>
                <input
                  ref={dateiRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  disabled={busy !== null}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void hochladen(f); e.target.value = ""; }}
                />
                {hatPdf && (
                  <button
                    type="button"
                    onClick={() => void entfernen()}
                    disabled={busy !== null}
                    className="icon-btn icon-btn-red"
                    data-tooltip="PDF entfernen"
                    aria-label="PDF entfernen"
                  >
                    {busy === "entfernen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                PDF bis {MAX_UPLOAD_SIZE_MB} MB. Erscheint im Lieferantenportal unter «Katalog».
              </p>
            </div>

            {/* Artikel */}
            <div className="space-y-2 pt-3 border-t">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Artikel</p>
              <p className="text-sm flex items-center gap-1.5">
                {busy === "import" ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" /> KI liest ein — {importText}</>
                ) : n > 0 ? (
                  <><span className="font-medium tabular-nums">{n}</span> Artikel im System</>
                ) : (
                  <span className="text-muted-foreground">Noch keine Artikel eingelesen</span>
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {n > 0 && (
                  <button type="button" onClick={artikelZeigen} disabled={busy !== null} className="kasten kasten-muted">
                    <LayoutGrid className="h-3.5 w-3.5" /> Artikel ansehen
                  </button>
                )}
                {hatPdf && (
                  <button
                    type="button"
                    onClick={() => void einlesen()}
                    disabled={busy !== null}
                    className="kasten kasten-blue"
                    data-tooltip="PDF mit KI in Artikel-Daten umwandeln"
                  >
                    {busy === "import" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    {busy === "import" ? "Wird eingelesen…" : n > 0 ? "Neu einlesen" : "Mit KI einlesen"}
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Neu einlesen aktualisiert die Artikel: Bilder und Verknüpfungen bleiben, neue Artikel kommen dazu,
                nicht mehr enthaltene werden ausgeblendet.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setAnsicht("verwaltung")} className="kasten kasten-muted">
                <ArrowLeft className="h-3.5 w-3.5" /> Zurück
              </button>
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input value={suche} onChange={(e) => setSuche(e.target.value)} placeholder="Artikel suchen…" className="pl-9 h-9" aria-label="Artikel suchen" />
              </div>
              {artikel.status === "ok" && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {sichtbar.length === artikel.artikel.length ? `${artikel.artikel.length} Artikel` : `${sichtbar.length} von ${artikel.artikel.length}`}
                </p>
              )}
            </div>
            {artikel.status === "laedt" ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-56 rounded-2xl" />)}
              </div>
            ) : artikel.status === "fehler" ? (
              <EmptyState
                icon={AlertTriangle}
                title="Artikel konnten nicht geladen werden"
                action={
                  <button type="button" onClick={() => { setArtikel({ status: "laedt" }); void artikelLaden(); }} className="kasten kasten-muted">
                    <RotateCw className="h-3.5 w-3.5" /> Erneut laden
                  </button>
                }
              />
            ) : sichtbar.length === 0 ? (
              <EmptyState icon={Search} title="Keine Artikel gefunden" description="Andere Suche wählen." />
            ) : (
              <KatalogRaster artikel={sichtbar} bilder={artikel.bilder} rasterKlasse="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" />
            )}
          </div>
        )}
      </Modal>
      {pdf && <PdfPopup url={pdf.url} title={pdf.title} onClose={() => setPdf(null)} />}
      {ConfirmModalElement}
    </>
  );
}
