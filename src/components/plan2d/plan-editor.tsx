"use client";

/**
 * 2D-Aufbauplan-Editor.
 *
 * Der ECHTE Saalplan der Location liegt als massstaebliche Unterlage im
 * Hintergrund; darauf werden das gebuchte Material des Auftrags und freie
 * Objekte (PA, Stageboxen, Stative, Beschriftungen) platziert — alles in
 * echten Metern (px_pro_meter aus der Kalibrierung der Location).
 *
 * Bedienung:
 *  - Mausrad = zoomen (um den Mauszeiger), Hintergrund ziehen = verschieben
 *  - Palette links: Klick platziert die naechste Instanz in der Bildmitte
 *  - Objekt ziehen = verschieben, Doppelklick = 45 Grad drehen,
 *    Entf/Backspace = geloescht (Material geht zurueck "ins Lager")
 *  - Alles wird debounced automatisch gespeichert
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Download, MousePointer2, RotateCcw, Ruler } from "lucide-react";
import {
  type PlanUnterlage, type PlanPos, type PlanObjekt,
  OBJEKT_BIBLIOTHEK, materialForm, materialMasse,
} from "@/lib/plan2d";
import { MessOverlay } from "@/components/plan2d/mess-overlay";

export type EditorMaterial = {
  id: string;
  bezeichnung: string;
  menge: number;
  masse: { l: number | null; b: number | null; h: number | null } | null;
  positionen: (PlanPos | null)[];
};

type Auswahl =
  | { art: "material"; id: string; index: number }
  | { art: "objekt"; id: string }
  | null;

type Props = {
  unterlageUrl: string;
  unterlage: PlanUnterlage;
  material: EditorMaterial[];
  objekte: PlanObjekt[];
  editierbar: boolean;
  hoehe?: number;
  onMaterialPositionen: (materialId: string, positionen: (PlanPos | null)[]) => void;
  onObjektNeu: (o: Omit<PlanObjekt, "id">) => Promise<PlanObjekt | null>;
  onObjektUpdate: (id: string, patch: Partial<PlanObjekt>) => void;
  onObjektLoeschen: (id: string) => void;
  /** Dateiname fuer den Export. */
  exportName?: string;
};

const FARBE_MATERIAL = "#2f6fb0";
const FARBE_OBJEKT = "#6b21a8";
const FARBE_AKTIV = "#f53c3a";

export function PlanEditor({
  unterlageUrl, unterlage, material, objekte, editierbar, hoehe = 560,
  onMaterialPositionen, onObjektNeu, onObjektUpdate, onObjektLoeschen, exportName = "aufbauplan",
}: Props) {
  const ppm = unterlage.px_pro_meter ?? 40;
  const W = unterlage.breite_px;
  const H = unterlage.hoehe_px;

  // View-Transform (Zoom/Pan) — viewBox bleibt fix, transform auf <g>.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const svgRef = useRef<SVGSVGElement>(null);

  // Lokale Arbeitskopien (fluessiges Draggen ohne Parent-Re-Render).
  const [matPos, setMatPos] = useState<Map<string, (PlanPos | null)[]>>(new Map());
  const [objs, setObjs] = useState<PlanObjekt[]>(objekte);
  useEffect(() => {
    setMatPos(new Map(material.map((m) => [m.id, Array.from({ length: m.menge }, (_, i) => m.positionen[i] ?? null)])));
  }, [material]);
  useEffect(() => { setObjs(objekte); }, [objekte]);

  const [auswahl, setAuswahl] = useState<Auswahl>(null);
  const dragRef = useRef<{ auswahl: Auswahl; startX: number; startY: number; orig: { x: number; y: number } } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; orig: { x: number; y: number } } | null>(null);

  // ── Mess-Werkzeug: zwei Klicks -> Distanz in Metern (kalibriert via
  //    px_pro_meter). Fuer Kabellaengen & Co. — Philippe-Mail 2026-09-24:
  //    "Laengen muesst Ihr noch pruefen". Ein dritter Klick startet neu.
  const [messModus, setMessModus] = useState(false);
  const [messPunkte, setMessPunkte] = useState<{ x: number; y: number }[]>([]);
  const messKlick = (clientX: number, clientY: number) => {
    const p = planPunkt(clientX, clientY);
    setMessPunkte((prev) => (prev.length >= 2 ? [p] : [...prev, p]));
  };
  const messToggle = () => {
    setMessModus((m) => {
      if (m) setMessPunkte([]);
      return !m;
    });
  };

  // Bildschirm-Pixel -> Plan-Pixel
  const planPunkt = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    const scale = Math.min(r.width / W, r.height / H);
    // SVG zentriert die viewBox (preserveAspectRatio default)
    const offX = (r.width - W * scale) / 2;
    const offY = (r.height - H * scale) / 2;
    const px = (clientX - r.left - offX) / scale;
    const py = (clientY - r.top - offY) / scale;
    return { x: (px - pan.x) / zoom, y: (py - pan.y) / zoom };
  }, [W, H, pan, zoom]);

  // ── Speichern (debounced) ──────────────────────────────────────
  const saveTimer = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const speichereMaterial = useCallback((id: string, arr: (PlanPos | null)[]) => {
    const t = saveTimer.current.get("m" + id);
    if (t) clearTimeout(t);
    saveTimer.current.set("m" + id, setTimeout(() => onMaterialPositionen(id, arr), 600));
  }, [onMaterialPositionen]);
  const speichereObjekt = useCallback((id: string, patch: Partial<PlanObjekt>) => {
    const t = saveTimer.current.get("o" + id);
    if (t) clearTimeout(t);
    saveTimer.current.set("o" + id, setTimeout(() => onObjektUpdate(id, patch), 600));
  }, [onObjektUpdate]);

  // ── Interaktion ────────────────────────────────────────────────
  // Wheel-Zoom NATIV non-passive: Reacts onWheel ist passiv, preventDefault
  // wirkt dort nicht — die Seite scrollte beim Zoomen mit (Zoom "versetzt").
  const planPunktRef = useRef(planPunkt);
  planPunktRef.current = planPunkt;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const p = planPunktRef.current(e.clientX, e.clientY);
      const alt = zoomRef.current;
      const faktor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const neu = Math.min(8, Math.max(0.4, alt * faktor));
      // Zoom um den Mauspunkt: Punkt bleibt unter dem Cursor
      setPan((prev) => ({
        x: prev.x + p.x * (alt - neu),
        y: prev.y + p.y * (alt - neu),
      }));
      setZoom(neu);
    };
    svg.addEventListener("wheel", h, { passive: false });
    return () => svg.removeEventListener("wheel", h);
  }, []);

  const startDrag = (e: React.PointerEvent, a: Auswahl) => {
    if (messModus) {
      e.stopPropagation();
      messKlick(e.clientX, e.clientY);
      return;
    }
    if (!editierbar || !a) return;
    e.stopPropagation();
    setAuswahl(a);
    const p = planPunkt(e.clientX, e.clientY);
    let orig = { x: 0, y: 0 };
    if (a.art === "material") {
      const pos = matPos.get(a.id)?.[a.index];
      if (!pos) return;
      orig = { x: pos.x, y: pos.y };
    } else {
      const o = objs.find((x) => x.id === a.id);
      if (!o) return;
      orig = { x: o.x, y: o.y };
    }
    dragRef.current = { auswahl: a, startX: p.x, startY: p.y, orig };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = planPunkt(e.clientX, e.clientY);
    if (dragRef.current) {
      const d = dragRef.current;
      const nx = d.orig.x + (p.x - d.startX);
      const ny = d.orig.y + (p.y - d.startY);
      if (d.auswahl?.art === "material") {
        setMatPos((prev) => {
          const kopie = new Map(prev);
          const arr = [...(kopie.get(d.auswahl!.id) ?? [])];
          const alt = arr[(d.auswahl as { index: number }).index];
          arr[(d.auswahl as { index: number }).index] = { x: nx, y: ny, rot: alt?.rot ?? 0 };
          kopie.set(d.auswahl!.id, arr);
          speichereMaterial(d.auswahl!.id, arr);
          return kopie;
        });
      } else if (d.auswahl?.art === "objekt") {
        setObjs((prev) => prev.map((o) => (o.id === d.auswahl!.id ? { ...o, x: nx, y: ny } : o)));
        speichereObjekt(d.auswahl.id, { x: nx, y: ny });
      }
      return;
    }
    if (panRef.current) {
      const pr = panRef.current;
      setPan({ x: pr.orig.x + (e.clientX - pr.startX), y: pr.orig.y + (e.clientY - pr.startY) });
    }
  };

  const endeDrag = () => { dragRef.current = null; panRef.current = null; };

  const drehe = (a: Auswahl) => {
    if (!editierbar || !a) return;
    if (a.art === "material") {
      setMatPos((prev) => {
        const kopie = new Map(prev);
        const arr = [...(kopie.get(a.id) ?? [])];
        const alt = arr[a.index];
        if (alt) {
          arr[a.index] = { ...alt, rot: (alt.rot + 45) % 360 };
          kopie.set(a.id, arr);
          speichereMaterial(a.id, arr);
        }
        return kopie;
      });
    } else {
      const o = objs.find((x) => x.id === a.id);
      if (!o) return;
      const rot = (o.rot + 45) % 360;
      setObjs((prev) => prev.map((x) => (x.id === a.id ? { ...x, rot } : x)));
      speichereObjekt(a.id, { rot });
    }
  };

  const loesche = useCallback(() => {
    if (!editierbar || !auswahl) return;
    if (auswahl.art === "material") {
      setMatPos((prev) => {
        const kopie = new Map(prev);
        const arr = [...(kopie.get(auswahl.id) ?? [])];
        arr[auswahl.index] = null;
        kopie.set(auswahl.id, arr);
        speichereMaterial(auswahl.id, arr);
        return kopie;
      });
    } else {
      setObjs((prev) => prev.filter((o) => o.id !== auswahl.id));
      onObjektLoeschen(auswahl.id);
    }
    setAuswahl(null);
  }, [editierbar, auswahl, speichereMaterial, onObjektLoeschen]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMessModus(false);
        setMessPunkte([]);
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const ziel = e.target as HTMLElement;
        if (ziel.tagName === "INPUT" || ziel.tagName === "TEXTAREA") return;
        loesche();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [loesche]);

  // ── Platzieren aus den Paletten ────────────────────────────────
  const mitte = () => ({ x: (W / 2 - pan.x) / zoom, y: (H / 2 - pan.y) / zoom });

  const platziereMaterial = (m: EditorMaterial) => {
    const arr = [...(matPos.get(m.id) ?? [])];
    const idx = arr.findIndex((p) => p === null);
    if (idx === -1) { toast.info("Alle Stück sind bereits platziert"); return; }
    const c = mitte();
    arr[idx] = { x: c.x, y: c.y, rot: 0 };
    setMatPos((prev) => new Map(prev).set(m.id, arr));
    speichereMaterial(m.id, arr);
    setAuswahl({ art: "material", id: m.id, index: idx });
  };

  const platziereObjekt = async (b: (typeof OBJEKT_BIBLIOTHEK)[number]) => {
    const c = mitte();
    const neu = await onObjektNeu({
      typ: b.typ,
      label: b.typ === "text" ? "Text" : b.label,
      x: c.x, y: c.y, rot: 0,
      breite: b.breite, tiefe: b.tiefe,
    });
    if (neu) {
      setObjs((prev) => [...prev, neu]);
      setAuswahl({ art: "objekt", id: neu.id });
    }
  };

  // ── Export als PNG (Unterlage + Objekte via Canvas) ────────────
  const [exportiert, setExportiert] = useState(false);
  const exportiere = async () => {
    if (exportiert) return;
    setExportiert(true);
    try {
      const svg = svgRef.current;
      if (!svg) return;
      const klon = svg.cloneNode(true) as SVGSVGElement;
      klon.setAttribute("width", String(W));
      klon.setAttribute("height", String(H));
      // Export zeigt IMMER den ganzen Plan (Zoom/Pan zuruecksetzen)
      const g = klon.querySelector("g[data-welt]");
      g?.setAttribute("transform", "");
      const bild = new Image();
      bild.crossOrigin = "anonymous";
      await new Promise<void>((res, rej) => {
        bild.onload = () => res();
        bild.onerror = () => rej(new Error("Unterlage nicht ladbar"));
        bild.src = unterlageUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(bild, 0, 0, W, H);
      // SVG ohne <image> (schon gezeichnet) rasterisieren
      klon.querySelector("image")?.remove();
      const svgText = new XMLSerializer().serializeToString(klon);
      const svgBild = new Image();
      await new Promise<void>((res, rej) => {
        svgBild.onload = () => res();
        svgBild.onerror = () => rej(new Error("Plan nicht renderbar"));
        svgBild.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
      });
      ctx.drawImage(svgBild, 0, 0, W, H);
      const a = document.createElement("a");
      a.download = `${exportName}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
    } catch (e) {
      toast.error("Export fehlgeschlagen: " + (e instanceof Error ? e.message : ""));
    } finally {
      setExportiert(false);
    }
  };

  // ── Rendering-Helfer ───────────────────────────────────────────
  const istAktiv = (a: Auswahl) =>
    !!auswahl && !!a &&
    ((a.art === "material" && auswahl.art === "material" && a.id === auswahl.id && a.index === auswahl.index) ||
      (a.art === "objekt" && auswahl.art === "objekt" && a.id === auswahl.id));

  const materialSymbol = (m: EditorMaterial, index: number, pos: PlanPos) => {
    const form = materialForm(m.bezeichnung);
    const masse = materialMasse(form, m.masse);
    const w = masse.l * ppm;
    const h = masse.b * ppm;
    const aktiv = istAktiv({ art: "material", id: m.id, index });
    const farbe = aktiv ? FARBE_AKTIV : FARBE_MATERIAL;
    return (
      <g
        key={`${m.id}-${index}`}
        transform={`translate(${pos.x} ${pos.y}) rotate(${pos.rot})`}
        onPointerDown={(e) => startDrag(e, { art: "material", id: m.id, index })}
        onDoubleClick={(e) => { e.stopPropagation(); drehe({ art: "material", id: m.id, index }); }}
        style={{ cursor: editierbar ? "move" : "default" }}
      >
        {form === "licht" ? (
          <>
            <circle r={Math.max(w / 2, 5)} fill={farbe} fillOpacity={0.75} stroke={farbe} strokeWidth={1.5} />
            <line x1={0} y1={0} x2={0} y2={-Math.max(w, 10)} stroke={farbe} strokeWidth={2} />
          </>
        ) : (
          <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={farbe} fillOpacity={0.55} stroke={farbe} strokeWidth={1.5} rx={2} />
        )}
        <text y={h / 2 + 12} textAnchor="middle" fontSize={11} fill={farbe} style={{ userSelect: "none" }}>
          {m.bezeichnung.slice(0, 18)}{index + 1 > 1 || m.menge > 1 ? ` ${index + 1}` : ""}
        </text>
      </g>
    );
  };

  const objektSymbol = (o: PlanObjekt) => {
    const aktiv = istAktiv({ art: "objekt", id: o.id });
    const farbe = aktiv ? FARBE_AKTIV : FARBE_OBJEKT;
    const w = (o.breite ?? 0.5) * ppm;
    const h = (o.tiefe ?? 0.5) * ppm;
    return (
      <g
        key={o.id}
        transform={`translate(${o.x} ${o.y}) rotate(${o.rot})`}
        onPointerDown={(e) => startDrag(e, { art: "objekt", id: o.id })}
        onDoubleClick={(e) => { e.stopPropagation(); drehe({ art: "objekt", id: o.id }); }}
        style={{ cursor: editierbar ? "move" : "default" }}
      >
        {o.typ === "text" ? (
          <text textAnchor="middle" fontSize={14} fontWeight={600} fill={farbe} style={{ userSelect: "none" }}>
            {o.label ?? "Text"}
          </text>
        ) : (
          <>
            <rect x={-w / 2} y={-h / 2} width={w} height={h} fill={farbe} fillOpacity={0.45} stroke={farbe} strokeWidth={1.5} rx={2} />
            <text textAnchor="middle" dominantBaseline="middle" fontSize={Math.min(12, h * 0.6)} fontWeight={600} fill="#fff" style={{ userSelect: "none" }}>
              {(o.label ?? o.typ).slice(0, 10)}
            </text>
          </>
        )}
      </g>
    );
  };

  const offenesMaterial = material
    .map((m) => ({ m, offen: (matPos.get(m.id) ?? []).filter((p) => p === null).length }))
    .filter((x) => x.offen > 0);

  return (
    <div className="flex gap-3 items-stretch flex-col lg:flex-row">
      {/* Palette */}
      {editierbar && (
        <div className="lg:w-52 shrink-0 space-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Material platzieren</p>
            {offenesMaterial.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">Alles platziert.</p>
            ) : (
              <div className="space-y-1">
                {offenesMaterial.map(({ m, offen }) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => platziereMaterial(m)}
                    className="w-full text-left text-[12px] rounded-lg border border-border bg-card px-2 py-1.5 hover:border-foreground/40"
                  >
                    <span className="font-medium">{m.bezeichnung}</span>
                    <span className="text-muted-foreground"> · noch {offen}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Objekte</p>
            <div className="flex flex-wrap gap-1">
              {OBJEKT_BIBLIOTHEK.map((b) => (
                <button
                  key={b.typ}
                  type="button"
                  onClick={() => platziereObjekt(b)}
                  className="text-[12px] rounded-lg border border-border bg-card px-2 py-1 hover:border-foreground/40"
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            <MousePointer2 className="h-3 w-3 inline mr-1" />
            Rad = Zoom · Hintergrund ziehen = verschieben · Objekt ziehen = bewegen · Doppelklick = drehen · Entf = löschen
          </p>
          <button
            type="button"
            onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}
            className="kasten kasten-muted w-full"
            data-tooltip="Zoom und Verschiebung zurücksetzen — ganzer Plan sichtbar"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Ansicht zurücksetzen
          </button>
          <button type="button" onClick={exportiere} disabled={exportiert} className="kasten kasten-muted w-full">
            <Download className="h-3.5 w-3.5" /> Als Bild exportieren
          </button>
        </div>
      )}

      {/* Plan */}
      <div className="relative flex-1 min-w-0 rounded-xl border border-border overflow-hidden bg-white" style={{ height: hoehe }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-full touch-none select-none"
          style={messModus ? { cursor: "crosshair" } : undefined}
          onPointerDown={(e) => {
            if (messModus) {
              messKlick(e.clientX, e.clientY);
              return;
            }
            setAuswahl(null);
            panRef.current = { startX: e.clientX, startY: e.clientY, orig: { ...pan } };
          }}
          onPointerMove={onPointerMove}
          onPointerUp={endeDrag}
          onPointerLeave={endeDrag}
        >
          <g data-welt="1" transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <image href={unterlageUrl} x={0} y={0} width={W} height={H} />
            {objs.map(objektSymbol)}
            {material.map((m) =>
              (matPos.get(m.id) ?? []).map((pos, i) => (pos ? materialSymbol(m, i, pos) : null)),
            )}
            <MessOverlay punkte={messPunkte} ppm={ppm} planBreite={W} zoom={zoom} />
          </g>
        </svg>
        {/* Mess-Werkzeug: fuer Kabellaengen & Abstaende — nutzt die
            Kalibrierung des Plans. Immer verfuegbar, auch read-only. */}
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          {messModus && (
            <span className="text-[11px] bg-card/95 border border-border rounded-lg px-2 py-1 text-muted-foreground">
              {messPunkte.length === 0 ? "Ersten Punkt anklicken" : messPunkte.length === 1 ? "Zweiten Punkt anklicken" : "Neuer Klick = neue Messung · Esc = fertig"}
            </span>
          )}
          <button
            type="button"
            onClick={messToggle}
            className={`kasten ${messModus ? "kasten-active" : "kasten-muted"}`}
            data-tooltip="Distanz messen (z.B. Kabellänge) — zwei Punkte anklicken"
            data-tooltip-align="end"
          >
            <Ruler className="h-3.5 w-3.5" />
            Messen
          </button>
        </div>
      </div>
    </div>
  );
}
