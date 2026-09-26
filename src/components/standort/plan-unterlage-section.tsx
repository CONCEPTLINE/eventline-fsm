"use client";

/**
 * Location-Details: Section "Plan" — der echte Grundriss der Location als
 * massstaebliche Unterlage (Basis fuer die 2D-Planung im Auftrag).
 *
 * Massstab: automatisch (KI liest Massstabsleiste/Bemassung, Server
 * rechnet) oder manuell (2 Punkte + Distanz). Viewer: Rad = Zoom um die
 * Maus (nativer non-passiver Wheel-Listener — Reacts onWheel ist passiv),
 * Ziehen = Pan.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchableSelect } from "@/components/searchable-select";
import { Loader2, Map as MapIcon, RotateCcw, Ruler, Sparkles, Upload, X } from "lucide-react";
import { type PlanUnterlage } from "@/lib/plan2d";

/** PDF-Seite 1 im Browser zu einem PNG-Blob rendern (lange Kante ~2600px). */
async function pdfZuPng(daten: ArrayBuffer): Promise<{ blob: Blob; breite: number; hoehe: number }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(daten) }).promise;
  const page = await doc.getPage(1);
  const basis = page.getViewport({ scale: 1 });
  const scale = 2600 / Math.max(basis.width, basis.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
  const blob = await new Promise<Blob>((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG-Erzeugung fehlgeschlagen"))), "image/png"),
  );
  return { blob, breite: canvas.width, hoehe: canvas.height };
}

async function bildMasse(blob: Blob): Promise<{ breite: number; hoehe: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("Bild nicht lesbar")); img.src = url; });
    return { breite: img.naturalWidth, hoehe: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function PlanUnterlageSection({ locationId, canEdit }: { locationId: string; canEdit: boolean }) {
  const supabase = useMemo(() => createClient(), []);

  const [unterlage, setUnterlage] = useState<PlanUnterlage | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [geladen, setGeladen] = useState(false);
  const [docs, setDocs] = useState<{ pfad: string; name: string }[]>([]);
  const [gewaehlt, setGewaehlt] = useState("");
  const [arbeitet, setArbeitet] = useState(false);
  const [autoKalibriert, setAutoKalibriert] = useState(false);
  const [kalibrierPunkte, setKalibrierPunkte] = useState<{ x: number; y: number }[] | null>(null);
  const [meter, setMeter] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  // Zoom/Pan
  const [view, setView] = useState({ zoom: 1, pan: { x: 0, y: 0 } });
  const { zoom, pan } = view;
  const viewRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; bewegt: boolean } | null>(null);

  const lade = useCallback(async () => {
    const { data } = await supabase.from("locations").select("plan_unterlage").eq("id", locationId).maybeSingle();
    const u = (data?.plan_unterlage as PlanUnterlage | null) ?? null;
    setUnterlage(u);
    if (u?.path) {
      const { data: signed } = await supabase.storage.from("documents").createSignedUrl(u.path, 3600);
      setUrl(signed?.signedUrl ?? null);
    } else {
      setUrl(null);
    }
    setGeladen(true);
  }, [supabase, locationId]);

  useEffect(() => {
    lade();
    (async () => {
      const { data: files } = await supabase.storage.from("documents").list(`standorte/${locationId}`, { limit: 60 });
      setDocs(
        (files ?? [])
          .filter((f) => /\.(pdf|jpe?g|png|webp)$/i.test(f.name))
          .map((f) => ({ pfad: `standorte/${locationId}/${f.name}`, name: f.name.replace(/^\d+_/, "") })),
      );
    })();
  }, [supabase, locationId, lade]);

  // ── Koordinaten-Mathe ─────────────────────────────────────────
  /** Klick (Client-Koordinaten) -> Pixel des angezeigten Bilds (contain + Transform). */
  function planPunkt(clientX: number, clientY: number) {
    if (!imgRef.current || !unterlage) return null;
    const r = imgRef.current.getBoundingClientRect();
    const s = Math.min(r.width / unterlage.breite_px, r.height / unterlage.hoehe_px);
    const bx = r.left + (r.width - unterlage.breite_px * s) / 2;
    const by = r.top + (r.height - unterlage.hoehe_px * s) / 2;
    const x = (clientX - bx) / s;
    const y = (clientY - by) / s;
    if (x < 0 || y < 0 || x > unterlage.breite_px || y > unterlage.hoehe_px) return null;
    return { x, y };
  }

  /** Layout-Geometrie der contain-Bildbox (untransformiert, im Wrapper). */
  function containBox() {
    const img = imgRef.current;
    if (!img || !unterlage) return null;
    const s = Math.min(img.offsetWidth / unterlage.breite_px, img.offsetHeight / unterlage.hoehe_px);
    return {
      s,
      bx: img.offsetLeft + (img.offsetWidth - unterlage.breite_px * s) / 2,
      by: img.offsetTop + (img.offsetHeight - unterlage.hoehe_px * s) / 2,
    };
  }

  // ── Zoom (nativ, non-passive) ─────────────────────────────────
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = v.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      const faktor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      setView((prev) => {
        const neu = Math.min(12, Math.max(1, prev.zoom * faktor));
        return {
          zoom: neu,
          pan: {
            x: mx - ((mx - prev.pan.x) / prev.zoom) * neu,
            y: my - ((my - prev.pan.y) / prev.zoom) * neu,
          },
        };
      });
    };
    v.addEventListener("wheel", h, { passive: false });
    return () => v.removeEventListener("wheel", h);
  }, [geladen, url]);

  // ── Pointer: Pan / Klick (Kalibrieren) ────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y, bewegt: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 5) d.bewegt = true;
    if (d.bewegt) setView((prev) => ({ ...prev, pan: { x: d.ox + dx, y: d.oy + dy } }));
  }
  function onPointerUp(e: React.PointerEvent) {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.bewegt || !kalibrierPunkte) return;
    const p = planPunkt(e.clientX, e.clientY);
    if (!p) return;
    setKalibrierPunkte(kalibrierPunkte.length >= 2 ? [p] : [...kalibrierPunkte, p]);
  }

  // ── Basis-Unterlage setzen ────────────────────────────────────
  async function setzeUnterlage(daten: ArrayBuffer, istPdf: boolean, quelle: string) {
    setArbeitet(true);
    try {
      let blob: Blob, breite: number, hoehe: number;
      let pdfPfad: string | null = null;
      if (istPdf) {
        // Kopie VOR dem Rendern: pdfjs transferiert das ArrayBuffer an den
        // Worker (detached) — ohne Kopie laedt der Upload danach 0 Bytes hoch.
        const pdfKopie = daten.slice(0);
        ({ blob, breite, hoehe } = await pdfZuPng(daten));
        pdfPfad = `locations/${locationId}/plan/unterlage_${Date.now()}.pdf`;
        const { error } = await supabase.storage
          .from("documents")
          .upload(pdfPfad, new Blob([pdfKopie], { type: "application/pdf" }), { contentType: "application/pdf" });
        if (error) pdfPfad = null;
      } else {
        blob = new Blob([daten]);
        ({ breite, hoehe } = await bildMasse(blob));
      }
      const pngPfad = `locations/${locationId}/plan/unterlage_${Date.now()}.png`;
      const { error: upErr } = await supabase.storage.from("documents").upload(pngPfad, blob, { contentType: "image/png" });
      if (upErr) throw new Error(upErr.message);

      const alt = [unterlage?.path, unterlage?.quelle_pdf_path].filter((p): p is string => !!p);
      const neu: PlanUnterlage = {
        path: pngPfad, breite_px: breite, hoehe_px: hoehe, px_pro_meter: null,
        quelle, quelle_pdf_path: pdfPfad,
      };
      const { error } = await supabase.from("locations").update({ plan_unterlage: neu }).eq("id", locationId);
      if (error) throw new Error(error.message);
      if (alt.length) await supabase.storage.from("documents").remove(alt);
      await lade();
      toast.success("Unterlage gesetzt — Massstab wird automatisch gelesen…");
      const ok = await autoKalibrieren();
      if (!ok) setKalibrierPunkte([]);
    } catch (e) {
      toast.error("Unterlage fehlgeschlagen: " + (e instanceof Error ? e.message : ""));
    } finally {
      setArbeitet(false);
    }
  }

  async function docDaten(pfad: string): Promise<ArrayBuffer> {
    const { data: blob, error } = await supabase.storage.from("documents").download(pfad);
    if (error || !blob) throw new Error(error?.message ?? "Download fehlgeschlagen");
    return blob.arrayBuffer();
  }

  // ── Kalibrierung ──────────────────────────────────────────────
  async function autoKalibrieren(): Promise<boolean> {
    if (autoKalibriert) return false;
    setAutoKalibriert(true);
    try {
      const res = await fetch("/api/ai/plan-kalibrierung", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId }),
      });
      const j = await res.json();
      if (!res.ok || !j.success) {
        toast.info(j.error ?? "Automatische Kalibrierung nicht möglich — bitte manuell.");
        return false;
      }
      toast.success(`Massstab automatisch gesetzt (${j.beschreibung}) — bitte kurz prüfen`);
      await lade();
      return true;
    } catch {
      toast.info("Automatische Kalibrierung nicht möglich — bitte manuell.");
      return false;
    } finally {
      setAutoKalibriert(false);
    }
  }

  async function kalibrierungSpeichern() {
    if (!unterlage || kalibrierPunkte?.length !== 2) return;
    const m = parseFloat(meter.replace(",", "."));
    if (!Number.isFinite(m) || m <= 0) { toast.error("Bitte die echte Distanz in Metern angeben"); return; }
    const [p1, p2] = kalibrierPunkte;
    const distPx = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (distPx < 10) { toast.error("Die zwei Punkte liegen zu nah beieinander"); return; }
    const neu: PlanUnterlage = { ...unterlage, px_pro_meter: distPx / m };
    const { error } = await supabase.from("locations").update({ plan_unterlage: neu }).eq("id", locationId);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    setUnterlage(neu);
    setKalibrierPunkte(null); setMeter("");
    toast.success(`Massstab gesetzt: ${(distPx / m).toFixed(1)} px/m`);
  }

  if (!geladen) return null;

  const box = containBox();

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <MapIcon className="h-4 w-4" /> Plan
          <span className="text-[11px] font-normal text-muted-foreground/70">
            — der Grundriss als massstäbliche Unterlage
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* ── Basis-Zeile ── */}
        {canEdit && (
          <div className="flex gap-1.5 items-center flex-wrap">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">Grundriss</span>
            <div className="w-64">
              <SearchableSelect
                value={gewaehlt}
                onChange={async (pfad) => {
                  setGewaehlt(pfad);
                  const d = docs.find((x) => x.pfad === pfad);
                  if (!d) return;
                  try { await setzeUnterlage(await docDaten(pfad), /\.pdf$/i.test(pfad), d.name); }
                  catch (e) { toast.error(e instanceof Error ? e.message : "Fehler"); }
                }}
                items={docs.map((d) => ({ id: d.pfad, label: d.name }))}
                placeholder="Grundriss aus Dokumenten…"
              />
            </div>
            <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await setzeUnterlage(await f.arrayBuffer(), f.type === "application/pdf" || /\.pdf$/i.test(f.name), f.name);
              if (fileRef.current) fileRef.current.value = "";
            }} />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={arbeitet} className="kasten kasten-muted">
              {arbeitet ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Hochladen
            </button>
            {unterlage && !kalibrierPunkte && (
              <>
                <button type="button" onClick={autoKalibrieren} disabled={autoKalibriert} className="kasten kasten-muted">
                  {autoKalibriert ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  Massstab automatisch
                </button>
                <button type="button" onClick={() => setKalibrierPunkte([])} className="kasten kasten-muted">
                  <Ruler className="h-3.5 w-3.5" /> Manuell kalibrieren
                </button>
              </>
            )}
          </div>
        )}

        {!unterlage ? (
          <p className="text-sm text-muted-foreground">
            Noch keine Unterlage. {canEdit ? "Wähle den Grundriss aus den Standort-Dokumenten oder lade ihn hoch." : ""}
          </p>
        ) : (
          <>
            <p className="text-[12px] text-muted-foreground">
              {unterlage.quelle ? `Basis: ${unterlage.quelle} · ` : ""}
              {unterlage.px_pro_meter
                ? `Massstab: ${unterlage.px_pro_meter.toFixed(1)} px/m`
                : "⚠︎ Noch nicht kalibriert"}
            </p>

            {/* ── Kalibrier-Banner ── */}
            {kalibrierPunkte && (
              <div className="rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 text-[13px] text-amber-900 dark:text-amber-200 flex items-center gap-2 flex-wrap">
                <Ruler className="h-4 w-4 shrink-0" />
                <span className="flex-1 min-w-[200px]">
                  ZWEI Punkte mit bekannter Distanz anklicken (z.B. Bemassungs-Pfeilspitzen) — {kalibrierPunkte.length}/2. Heranzoomen für Genauigkeit!
                </span>
                <input
                  value={meter}
                  onChange={(e) => setMeter(e.target.value)}
                  placeholder="Distanz in m, z.B. 11.65"
                  className="w-40 text-sm rounded-lg border border-amber-300 dark:border-amber-700 bg-background px-2 py-1 focus:outline-none"
                />
                <button type="button" onClick={kalibrierungSpeichern} disabled={kalibrierPunkte.length !== 2} className="kasten kasten-red">
                  Übernehmen
                </button>
                <button type="button" onClick={() => { setKalibrierPunkte(null); setMeter(""); }} className="kasten kasten-muted"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {/* ── Viewer ── */}
            {url && (
              <>
                <div
                  ref={viewRef}
                  className="relative rounded-xl border border-border overflow-hidden bg-white touch-none select-none"
                  style={{ height: 620, cursor: kalibrierPunkte ? "crosshair" : zoom > 1 ? "grab" : "default" }}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                >
                  <div
                    className="absolute inset-0"
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: "0 0" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img ref={imgRef} src={url} alt="Plan" className="w-full h-full object-contain" draggable={false} />

                    {/* Punkt-Marker (Kalibrieren) */}
                    {box && (kalibrierPunkte ?? []).map((p, i) => (
                      <div
                        key={i}
                        className="absolute rounded-full bg-red-500 border border-white pointer-events-none"
                        style={{
                          left: box.bx + p.x * box.s, top: box.by + p.y * box.s,
                          width: 10 / zoom, height: 10 / zoom,
                          transform: "translate(-50%, -50%)",
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-[11px] text-muted-foreground flex-1 min-w-[200px]">
                    Rad = zoomen (bis 12×) · ziehen = verschieben
                  </p>
                  {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
                    <button type="button" onClick={() => setView({ zoom: 1, pan: { x: 0, y: 0 } })} className="kasten kasten-muted">
                      <RotateCcw className="h-3.5 w-3.5" /> Ansicht zurücksetzen
                    </button>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
