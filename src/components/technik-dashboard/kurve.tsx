// Technik-Dashboard: Kurven (Entwurf chartOne/spark) aus den echten Reihen von GET /api/technik/stand?reihen=1.
// x = Zeit, y in viewBox 0..120. Luecken (fehlende Messungen, Neustart) bleiben offen und schraffiert.

import type { Bereich, Reihen } from "@/lib/technik-dashboard/typen";
import { k } from "./farben";
import { NUM } from "./bausteine";
import { stundeZurich, uhr, wochentag } from "./format";

export type Punkt = [number, number | null, number | null];
const VB_W = 600;

export const BEREICH_TEXT: Record<Bereich, string> = { "6h": "6 h", "24h": "24 h", "7d": "7 Tage" };
export const SCHRITT_TEXT: Record<Bereich, string> = { "6h": "Ø je 1 min", "24h": "Ø je 5 min", "7d": "Ø je Stunde" };

interface Geom {
  linie: string;
  flaeche: string;
  luecken: Array<[number, number]>;
  letzter: [number, number] | null;
  letzterWert: number | null;
  Y: (v: number) => number;
}

/** Geometrie einer Reihe. wert: 1 = Mittel, 2 = Spitze. */
export function geom(punkte: Punkt[] | undefined, von: number, bis: number, schrittS: number, ymin: number, ymax: number, wert: 1 | 2 = 1): Geom {
  const span = Math.max(1, bis - von);
  const X = (t: number) => Math.max(0, Math.min(VB_W, ((t - von) / span) * VB_W));
  const Y = (v: number) => 112 - ((Math.max(ymin, Math.min(ymax, v)) - ymin) / (ymax - ymin)) * 100;
  const maxAbstand = schrittS * 1000 * 1.6;
  const segs: Array<Array<[number, number]>> = [];
  const luecken: Array<[number, number]> = [];
  let cur: Array<[number, number]> = [];
  let letzteT: number | null = null;
  let letzterWert: number | null = null;
  const pts = (punkte ?? []).filter((p) => p[0] >= von - schrittS * 1000 && p[0] <= bis + 1000).sort((a, b) => a[0] - b[0]);
  for (const p of pts) {
    const v = p[wert] ?? (wert === 2 ? p[1] : null);
    if (v == null || !Number.isFinite(v)) continue;
    if (letzteT == null) {
      if (p[0] - von > maxAbstand) luecken.push([0, X(p[0])]);
    } else if (p[0] - letzteT > maxAbstand) {
      if (cur.length) segs.push(cur);
      cur = [];
      luecken.push([X(letzteT), X(p[0])]);
    }
    cur.push([X(p[0]), Y(v)]);
    letzteT = p[0];
    letzterWert = v;
  }
  if (cur.length) segs.push(cur);
  if (letzteT == null) luecken.push([0, VB_W]);
  else if (bis - letzteT > maxAbstand) luecken.push([X(letzteT), VB_W]);
  const f = (n: number) => n.toFixed(1);
  const linie = segs.map((s) => (s.length === 1 ? `M${f(s[0][0])} ${f(s[0][1])} L${f(s[0][0] + 0.6)} ${f(s[0][1])}` : "M" + s.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L"))).join(" ");
  const flaeche = segs.filter((s) => s.length > 1).map((s) => `M${f(s[0][0])} 112 L` + s.map(([x, y]) => `${f(x)} ${f(y)}`).join(" L") + ` L${f(s[s.length - 1][0])} 112 Z`).join(" ");
  const last = segs.length ? segs[segs.length - 1][segs[segs.length - 1].length - 1] : null;
  return { linie, flaeche, luecken, letzter: last, letzterWert, Y };
}

const pc = (y: number) => ((y / 120) * 100).toFixed(2);
const px = (x: number) => ((x / VB_W) * 100).toFixed(2);

/** Zeilenhoehe einer Grenz-Beschriftung (px). */
export const GRENZ_LH = 13;

/**
 * Lage (top, px) der Grenz-Beschriftungen: je Linie oberhalb (bzw. bei «unten» unterhalb), sonst auf der
 * anderen Seite, sonst der freie Platz, der der Linie am naechsten liegt — nie ueber den Rand, nie uebereinander.
 * yPx = Lage der Linie in px ab oben, h = Hoehe der Zeichenflaeche.
 */
export function grenzTops(linien: Array<{ yPx: number; unten?: boolean }>, h: number): number[] {
  const belegt: number[] = [];
  const tops = new Array<number>(linien.length).fill(0);
  const frei = (top: number) => top >= 0 && top + GRENZ_LH <= h && belegt.every((p) => top + GRENZ_LH + 1 <= p || top >= p + GRENZ_LH + 1);
  const reihenfolge = linien.map((l, i) => ({ ...l, i })).sort((a, b) => a.yPx - b.yPx);
  for (const l of reihenfolge) {
    const ober = l.yPx - GRENZ_LH - 2;
    const unter = l.yPx + 2;
    let top = (l.unten ? [unter, ober] : [ober, unter]).find(frei);
    if (top == null) {
      let best: number | null = null;
      for (let c = 0; c + GRENZ_LH <= h; c++) if (frei(c) && (best == null || Math.abs(c - ober) < Math.abs(best - ober))) best = c;
      top = best ?? Math.max(0, Math.min(h - GRENZ_LH, ober));
    }
    belegt.push(top);
    tops[l.i] = top;
  }
  return tops;
}

/** Achsen-Marken in Zuerich-Zeit: 6 h alle 2 h, 24 h alle 6 h, 7 Tage je Mitternacht. */
export function ticks(bereich: Bereich, von: number, bis: number): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  const span = bis - von;
  const start = Math.ceil(von / 3_600_000) * 3_600_000;
  for (let t = start; t <= bis; t += 3_600_000) {
    const h = stundeZurich(t);
    const ok = bereich === "6h" ? h % 2 === 0 : bereich === "24h" ? h % 6 === 0 : h === 0;
    if (!ok) continue;
    const x = (t - von) / span;
    if (x < 0.04 || x > 0.93) continue;
    // 7 Tage: nur der Wochentag («Di») — Datum dazu passt in der schmalen Spalte nicht nebeneinander
    out.push([x, bereich === "7d" ? wochentag(t) : uhr(t)]);
  }
  return out;
}

export interface Serie {
  schluessel: string;
  name?: string;
  farbe?: string;
  flaeche?: boolean;
  /** Spitze (Maximum je Schritt) als feine zweite Linie. */
  spitze?: boolean;
}

export function Kurve(props: {
  id: string;
  titel: string;
  rechts?: string;
  reihen: Reihen | null;
  serien: Serie[];
  ymin: number;
  ymax: number;
  yt?: Array<[number, string]>;
  grenzen?: Array<{ v: number; label: string; unten?: boolean }>;
  h?: number;
  format: (v: number) => string;
  lueckeText?: string;
}) {
  const { id, titel, rechts, reihen, serien, ymin, ymax, yt = [], grenzen = [], h = 88, format, lueckeText = "keine Messwerte" } = props;
  const kopf = (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span style={{ fontWeight: 700, whiteSpace: "nowrap" }}>{titel}{reihen ? ` · ${BEREICH_TEXT[reihen.bereich]}` : ""}</span>
      <span style={{ color: k("mute"), ...NUM, whiteSpace: "nowrap" }}>{rechts ?? (reihen ? SCHRITT_TEXT[reihen.bereich] : "")}</span>
    </div>
  );
  if (!reihen) {
    return (
      <div className="td-kurve" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {kopf}
        <div className="shimmer rounded-md" style={{ height: h }} />
      </div>
    );
  }
  const von = Date.parse(reihen.von);
  const bis = Date.parse(reihen.bis);
  const G = serien.map((s) => ({ ...s, g: geom(reihen.werte[s.schluessel], von, bis, reihen.schritt_s, ymin, ymax, 1), gs: s.spitze ? geom(reihen.werte[s.schluessel], von, bis, reihen.schritt_s, ymin, ymax, 2) : null }));
  const g0 = G[0].g;
  const leer = g0.letzter == null;
  const schraffur = `repeating-linear-gradient(135deg,${k("track")} 0 1.5px,rgba(0,0,0,0) 1.5px 6px)`;
  const breiteLuecke = g0.luecken.find(([a, b]) => b - a > 120);
  const SVG = { viewBox: "0 0 600 120", preserveAspectRatio: "none", "aria-hidden": true, style: { position: "absolute" as const, inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" } };
  const neustarts = reihen.neustarts.map((n) => Date.parse(n)).filter((t) => t >= von && t <= bis);
  const [lx, ly] = g0.letzter ?? [600, 60];
  // Beschriftungen ohne Kollision: Grenz-Labels stehen links; liegt der letzte Wert in der linken Haelfte
  // (Daten enden frueh), wandern sie nach rechts. Der Wert selbst steht links vom Punkt, am linken Rand rechts davon.
  const zuPx = (y: number) => (y / 120) * h;
  const grenzSichtbar = grenzen.filter((t) => t.v <= ymax && t.v >= ymin && t.label);
  const grenzTop = grenzTops(grenzSichtbar.map((t) => ({ yPx: zuPx(g0.Y(t.v)), unten: t.unten })), h);
  const grenzRechts = lx < VB_W / 2;
  const lyPx = zuPx(ly);
  const wertTop = Math.max(0, Math.min(h - 14, lyPx - 18 >= 0 ? lyPx - 18 : lyPx + 4));
  const wertRechtsVomPunkt = lx < VB_W * 0.2;
  return (
    <div data-anim="kurve" className="td-kurve" data-kurve={`${id}-${reihen.bereich}`} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {kopf}
      {serien.length > 1 || serien.some((s) => s.spitze) ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11.5, color: k("sub"), ...NUM }}>
          {serien.map((s) => (
            <span key={s.schluessel} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 2, borderRadius: 1, background: s.farbe ?? k("A") }} />
              {s.name ?? "Mittel"}
            </span>
          ))}
          {serien.some((s) => s.spitze) ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 12, height: 0, borderTop: `1.5px dashed ${k("B")}` }} />
              Spitze
            </span>
          ) : null}
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 34px", gap: 6 }}>
        <div style={{ position: "relative", height: h, overflow: "hidden" }}>
          {g0.luecken.map(([a, b], i) => (
            <span key={i} aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: `${px(a)}%`, width: `${Math.max(0.6, (b - a) / 6).toFixed(2)}%`, backgroundImage: schraffur, borderRadius: 2 }} />
          ))}
          <svg {...SVG}>
            {yt.map(([v]) => (
              <line key={`y${v}`} x1="0" y1={g0.Y(v).toFixed(1)} x2="600" y2={g0.Y(v).toFixed(1)} stroke={k("grid")} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {grenzen.filter((t) => t.v <= ymax && t.v >= ymin).map((t) => (
              <line key={`g${t.v}`} x1="0" y1={g0.Y(t.v).toFixed(1)} x2="600" y2={g0.Y(t.v).toFixed(1)} stroke={k("thr")} strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
            ))}
            {neustarts.map((t) => {
              const x = (((t - von) / (bis - von)) * VB_W).toFixed(1);
              return <line key={`n${t}`} x1={x} y1="0" x2={x} y2="120" stroke={k("mute")} strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />;
            })}
          </svg>
          <span className="td-flaeche" style={{ position: "absolute", inset: 0, display: "block" }}>
            <svg {...SVG}>
              {G.map((s, i) => (s.flaeche !== false ? <path key={s.schluessel} d={s.g.flaeche} fill={s.farbe ?? k("A")} style={{ fillOpacity: `calc(${k("areaOp")} * ${i === 0 ? 1 : 0.6})` }} /> : null))}
            </svg>
          </span>
          <span className="td-wisch" style={{ position: "absolute", inset: 0, display: "block", overflow: "hidden" }}>
            <span className="td-wisch-in" style={{ position: "absolute", inset: 0, display: "block" }}>
              <svg {...SVG}>
                {G.map((s) => (s.gs ? <path key={`${s.schluessel}-s`} d={s.gs.linie} fill="none" stroke={k("B")} strokeWidth={1.25} strokeDasharray="3 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null))}
                {G.map((s) => <path key={s.schluessel} d={s.g.linie} fill="none" stroke={s.farbe ?? k("A")} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
              </svg>
            </span>
          </span>
          {leer ? (
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11.5, color: k("mute") }}>
              <span style={{ background: k("e1"), padding: "1px 6px", borderRadius: 4 }}>Noch keine Werte in diesem Zeitraum</span>
            </span>
          ) : breiteLuecke ? (
            <span style={{ position: "absolute", left: `${px(breiteLuecke[0])}%`, width: `${((breiteLuecke[1] - breiteLuecke[0]) / 6).toFixed(2)}%`, top: "50%", transform: "translateY(-50%)", textAlign: "center", fontSize: 10.5, lineHeight: "13px", color: k("mute") }}>
              <span style={{ background: k("e1"), padding: "1px 5px", borderRadius: 4 }}>{lueckeText}</span>
            </span>
          ) : null}
          {grenzSichtbar.map((t, i) => (
            <span key={`gl${t.v}`} style={{ position: "absolute", ...(grenzRechts ? { right: 6 } : { left: 6 }), top: grenzTop[i], fontSize: 10.5, lineHeight: `${GRENZ_LH}px`, color: k("mute"), whiteSpace: "nowrap", background: k("e1"), padding: "0 3px", borderRadius: 3 }}>{t.label}</span>
          ))}
          {G.map((s, i) => {
            if (!s.g.letzter) return null;
            const [x, y] = s.g.letzter;
            const sz = i === 0 ? 6 : 5;
            return <span key={s.schluessel} className="td-endpunkt" style={{ position: "absolute", left: `${px(x)}%`, top: `${pc(y)}%`, width: sz, height: sz, margin: `-${sz / 2}px 0 0 -${sz / 2}px`, borderRadius: "50%", background: s.farbe ?? k("A"), boxShadow: `0 0 0 2px ${k("e1")}` }} />;
          })}
          {g0.letzterWert != null ? (
            <span className="td-endwert" style={{ position: "absolute", ...(wertRechtsVomPunkt ? { left: `calc(${px(lx)}% + 8px)` } : { right: `calc(${(100 - Number(px(lx))).toFixed(2)}% + 8px)` }), top: wertTop, zIndex: 1, fontSize: 12, fontWeight: 700, lineHeight: "14px", ...NUM, whiteSpace: "nowrap", background: k("e1"), padding: "0 3px", borderRadius: 3 }}>
              {format(g0.letzterWert)}
            </span>
          ) : null}
        </div>
        <div style={{ position: "relative", height: h }}>
          {yt.map(([v, l]) => (
            <span key={v} style={{ position: "absolute", right: 0, top: `calc(${pc(g0.Y(v))}% - 7px)`, fontSize: 10.5, lineHeight: "14px", color: k("mute"), ...NUM, whiteSpace: "nowrap" }}>{l}</span>
          ))}
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 34px", gap: 6 }}>
        <div style={{ position: "relative", height: 14, fontSize: 10.5, color: k("mute"), ...NUM }}>
          {ticks(reihen.bereich, von, bis).map(([x, t]) => (
            <span key={t + x} style={{ position: "absolute", left: `${(x * 100).toFixed(2)}%`, transform: "translateX(-50%)", whiteSpace: "nowrap" }}>{t}</span>
          ))}
        </div>
        <span style={{ fontSize: 10.5, color: k("mute"), textAlign: "right" }}>jetzt</span>
      </div>
    </div>
  );
}

/** Mini-Verlauf (Fahne, 24-h-Streifen): echte Reihe, Luecken offen. */
export function Spark({ punkte, von, bis, schrittS, ymin, ymax, h, laden = true }: { punkte: Punkt[] | undefined; von: number; bis: number; schrittS: number; ymin: number; ymax: number; h: number; laden?: boolean }) {
  const g = geom(punkte, von, bis, schrittS, ymin, ymax);
  return (
    <span className={laden ? "td-wisch td-wisch-laden" : undefined} style={{ position: "relative", display: "block", height: h, overflow: "hidden" }}>
      <span className="td-wisch-in" style={{ position: "absolute", inset: 0, display: "block" }}>
        <svg viewBox="0 0 600 120" preserveAspectRatio="none" style={{ width: "100%", height: h, display: "block" }} aria-hidden="true">
          <path d={g.flaeche} fill={k("A")} style={{ fillOpacity: k("areaOp") }} />
          <path d={g.linie} fill="none" stroke={k("A")} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      </span>
    </span>
  );
}
