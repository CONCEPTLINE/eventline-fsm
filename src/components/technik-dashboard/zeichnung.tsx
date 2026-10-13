// Technik-Dashboard: Zeichnung des Rigs (Seitenblick durch das Glas) und der NAS-Front.
// Port aus gen-main.mjs (scene(): Masssystem in Millimetern, skaliert per Container-Einheit).
// Nur Formen, keine Marken- oder Modellnamen. Was nicht gemessen wird, ist neutral gezeichnet.
// Farben kommen als CSS-Variablen (SVG: immer ueber style, Attribute koennen kein var()).

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { K } from "./farben";
import { CPU_TEMP } from "@/lib/technik-dashboard/konstanten";

// ---- CSS-Text -> React-Stil (zwischengespeichert), damit die Masse 1:1 aus dem Entwurf bleiben ----
const SX = new Map<string, CSSProperties>();
export function sx(s: string): CSSProperties {
  const hit = SX.get(s);
  if (hit) return hit;
  const out: Record<string, string> = {};
  let tiefe = 0;
  let start = 0;
  const teile: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") tiefe++;
    else if (c === ")") tiefe--;
    else if (c === ";" && tiefe === 0) {
      teile.push(s.slice(start, i));
      start = i + 1;
    }
  }
  teile.push(s.slice(start));
  for (const t of teile) {
    const j = t.indexOf(":");
    if (j < 0) continue;
    const name = t.slice(0, j).trim();
    if (!name) continue;
    const wert = t.slice(j + 1).trim();
    const key = name.startsWith("--") ? name : name.replace(/^-webkit-/, "Webkit-").replace(/-([a-z])/g, (_, b: string) => b.toUpperCase());
    out[key] = wert;
  }
  SX.set(s, out as CSSProperties);
  return out as CSSProperties;
}

// ---- Masssystem ----
const CW = 435, CH = 415; // Gehaeuse Seitenansicht (Tiefe x Hoehe, mm)
const DECKEL = 10, HECK = 8, SOCKEL = 12;
const BX = 16, BY = 70; // Platine
const ECKE = 324;
export const GPU_Y = BY + 169, GPU_H = 60;
const PX = BX + 128, PY = BY + 82; // Sockelmitte
const HOSE: Array<[number, number]> = [[PX - 62, PY - 6], [PX - 50, PY - 20]];
const RAD_X = 72, RAD_L = 285;
const mkq = (W: number) => (mm: number) => `${+((mm * 100) / W).toFixed(3)}cqw`;
const cq = mkq(CW);
const NW = 178;
const cn = mkq(NW);
const RKW = 324;
const rq = mkq(RKW);
type Q = (mm: number) => string;
const at = (q: Q, x: number, y: number, w: number, h: number) => `position:absolute;left:${q(x)};top:${q(y)};width:${q(w)};height:${q(h)}`;

const el = (q: Q, x: number, y: number, w: number, h: number, st = "", inner: ReactNode = null, extra?: { className?: string; key?: string | number }) => (
  <span key={extra?.key} className={extra?.className} style={sx(`${at(q, x, y, w, h)};display:block;${st}`)}>{inner}</span>
);
/** Liste statischer Teile mit festen Schluesseln (Reihenfolge = Ueberdeckung). */
const liste = (teile: ReactNode[]) => teile.map((t, i) => <Fragment key={i}>{t}</Fragment>);
const R = (x: number, y: number, w: number, h: number, st = "", inner: ReactNode = null) => el(cq, x, y, w, h, st, inner);
const B = (x: number, y: number, w: number, h: number, st = "", inner: ReactNode = null) => el(cq, BX + x, BY + y, w, h, st, inner);

const finsV = () => `background:repeating-linear-gradient(180deg,${K.sinkA} 0 2px,${K.sinkB} 2px 3.5px);box-shadow:inset 0 0 0 1px ${K.sinkEdge},0 2px 4px rgba(0,0,0,0.35)`;
const finsH = () => `background:repeating-linear-gradient(90deg,${K.sinkA} 0 2px,${K.sinkB} 2px 3.5px);box-shadow:inset 0 0 0 1px ${K.sinkEdge},0 2px 4px rgba(0,0,0,0.35)`;
const pins = (sx_: number, sy: number) => `background-color:${K.conn};background-image:radial-gradient(circle,${K.pin} 0 32%,rgba(0,0,0,0) 38%);background-size:${cq(sx_)} ${cq(sy)};box-shadow:inset 0 0 0 1px ${K.sinkEdge}`;
const slotSt = (armor: boolean) => `background:${K.slot};border-radius:1px;box-shadow:${armor ? `0 0 0 1px ${K.latch},` : ""}inset 0 1px 0 rgba(255,255,255,0.05)`;
const mesh = (dot: string, bg: string, s = 4) => `background-color:${bg};background-image:radial-gradient(circle,${dot} 0 0.8px,rgba(0,0,0,0) 1.15px);background-size:${s}px ${s}px`;
const BLATT = Array.from({ length: 7 }, (_, i) => (
  <path key={i} d="M30 30 C31 21 36 14 43 12 C42 20 37 26 30 30 Z" transform={`rotate(${((i * 360) / 7).toFixed(1)} 30 30)`} />
));

// ---- Statische Teile (nur Formen, keine Messwerte) ----
function eckLuefter(y: number, drehDauer: string | null) {
  const pad = (cx: number, cy: number) => <ellipse key={`${cx}-${cy}`} cx={cx} cy={cy} rx="2.6" ry="3.6" style={{ fill: K.cfPad }} />;
  return R(ECKE + 4, y, 104, 120, "", (
    <svg viewBox="0 0 104 120" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} aria-hidden="true">
      <path d="M84 1 L103 6 L103 114 L84 119 Z" style={{ fill: K.cfSide }} />
      <path d="M6 7 Q1 7.4 1 12 L1 108 Q1 112.6 6 113 L80 119.4 Q85.5 119.8 85.5 114 L85.5 6 Q85.5 0.2 80 0.6 Z" style={{ fill: K.cfFrame, stroke: K.cfEdge, strokeWidth: 0.8 }} />
      {pad(7.5, 14)}{pad(79, 8.5)}{pad(7.5, 106)}{pad(79, 111.5)}
      <ellipse cx="44" cy="60" rx="39" ry="53.5" style={{ fill: K.cfHole }} />
      <ellipse cx="44" cy="60" rx="39" ry="53.5" style={{ fill: "none", stroke: K.cfRing, strokeWidth: 1.3 }} />
      <g transform="translate(44 60) scale(1.68 2.3) translate(-30 -30)" style={{ fill: K.cfBlade, stroke: K.cfLine, strokeWidth: 0.25 }}>
        <g className={drehDauer ? "td-eck-rotor" : undefined} style={drehDauer ? { transformOrigin: "30px 30px", transformBox: "view-box", ["--fan-d" as string]: drehDauer } : undefined}>{BLATT}</g>
        <circle cx="30" cy="30" r="7.6" style={{ fill: K.cfHub }} />
      </g>
    </svg>
  ));
}

const radLuefter = (x: number) => R(x + 1, DECKEL + 26, 118, 25, `border-radius:${cq(3)};background:linear-gradient(180deg,${K.cfFrame},${K.cfHole});box-shadow:inset 0 0 0 1px ${K.cfEdge}`, (
  <>
    <span style={sx(`position:absolute;left:${cq(14)};right:${cq(14)};top:50%;height:1px;background:${K.cfEdge};display:block`)} />
    {[3, 103].map((p) => <span key={p} style={sx(`position:absolute;left:${cq(p)};top:${cq(2)};width:${cq(12)};height:${cq(21)};border-radius:${cq(2)};background:${K.cfPad};display:block`)} />)}
  </>
));

function platine(): ReactNode[] {
  const D: ReactNode[] = [];
  D.push(R(ECKE, DECKEL, CW - ECKE, CH - DECKEL - SOCKEL, `${mesh(K.meshDot, K.meshBg)};box-shadow:inset 1px 0 0 ${K.trayEdge},inset 6px 0 10px -6px rgba(0,0,0,0.35)`));
  D.push(R(267, BY + 28, 11, 82, `border-radius:${cq(5.5)};background:${K.cut};box-shadow:inset 0 0 0 1px ${K.cutEdge}`));
  D.push(B(0, 0, 244, 305, `border-radius:${cq(2)};background-color:${K.pcb};background-image:repeating-linear-gradient(135deg,${K.pcbPat} 0 1px,rgba(0,0,0,0) 1px 7px);box-shadow:0 0 0 1px rgba(0,0,0,0.35),0 8px 18px rgba(0,0,0,0.28)`));
  ([[6.4, 10], [236, 10], [6.4, 165], [236, 165], [6.4, 282], [160, 282], [236, 282]] as const).forEach(([x, y]) => D.push(B(x - 2, y - 2, 4, 4, `border-radius:50%;box-shadow:inset 0 0 0 1px ${K.holeRing}`)));
  D.push(B(0, 6, 26, 146, `background:linear-gradient(90deg,${K.sinkB},${K.sinkA} 70%,${K.sinkB});clip-path:polygon(0 0,100% 0,100% 84%,55% 100%,0 100%);box-shadow:inset -1px 0 0 ${K.steel}`));
  D.push(B(21.6, 26, 1.6, 92, `border-radius:2px;background:${K.bar};opacity:.55;box-shadow:0 0 6px ${K.barGlow}`));
  D.push(B(27, 30, 17, 92, `border-radius:${cq(1.5)};${finsV()}`));
  D.push(B(46, 16, 112, 22, `border-radius:${cq(1.5)};${finsH()}`));
  D.push(B(33, 21, 15, 2.4, `border-radius:2px;background:${K.steel};opacity:.75`));
  D.push(B(33, 21, 2.4, 10, `border-radius:2px;background:${K.steel};opacity:.75`));
  const kabelHoch = (x: number, w: number) => B(x, -9, w, 10, `background:repeating-linear-gradient(90deg,${K.hose} 0 2px,${K.hoseHi} 2px 2.6px);-webkit-mask-image:linear-gradient(0deg,#000 40%,rgba(0,0,0,0));mask-image:linear-gradient(0deg,#000 40%,rgba(0,0,0,0))`);
  D.push(kabelHoch(30, 13), kabelHoch(45, 8));
  D.push(B(29, 1, 15, 9, pins(3.75, 4.5)));
  D.push(B(44.5, 1, 9, 9, pins(4.5, 4.5)));
  D.push(B(231, 37, 11, 67, pins(5.5, 5.6)));
  D.push(B(242, 40, 15, 61, `background:repeating-linear-gradient(180deg,${K.hose} 0 2px,${K.hoseHi} 2px 2.6px);-webkit-mask-image:linear-gradient(90deg,#000 45%,rgba(0,0,0,0));mask-image:linear-gradient(90deg,#000 45%,rgba(0,0,0,0))`));
  D.push(B(50, 153.5, 22, 5.5, slotSt(false)));
  D.push(B(50, 232, 97, 6, slotSt(true)));
  D.push(B(40, 244, 110, 18, `border-radius:${cq(1.6)};background:linear-gradient(180deg,${K.sinkA},${K.sinkB});box-shadow:inset 0 1px 0 ${K.sinkEdge},0 2px 4px rgba(0,0,0,0.3)`, (
    <>
      <span style={sx(`position:absolute;left:${cq(6)};right:${cq(6)};top:${cq(4)};height:1px;background:${K.steel};opacity:.55;display:block`)} />
      <span style={sx(`position:absolute;left:${cq(30)};right:${cq(30)};bottom:${cq(4)};height:1px;background:${K.steel};opacity:.3;display:block`)} />
    </>
  )));
  D.push(B(150, 245, 4, 16, `background:${K.conn}`));
  D.push(B(50, 270, 97, 5.5, slotSt(false)));
  [228, 242, 256].forEach((y) => D.push(B(233, y, 11, 12, `background:${K.conn};box-shadow:inset 0 0 0 1px ${K.sinkEdge}`, (
    <>
      <span style={sx(`position:absolute;left:18%;right:18%;top:28%;height:1px;background:${K.pin};display:block`)} />
      <span style={sx(`position:absolute;left:18%;right:18%;top:68%;height:1px;background:${K.pin};display:block`)} />
    </>
  ))));
  D.push(B(181, 240, 13, 13, `background:${K.conn};box-shadow:inset 0 0 0 1px ${K.sinkEdge}`));
  D.push(B(12, 250, 10, 10, `background:${K.conn};box-shadow:inset 0 0 0 1px ${K.sinkEdge}`));
  [20, 78, 96, 114, 196].forEach((x, i) => D.push(B(x, 291, i === 0 ? 14 : 12, 5, pins(2.5, 2.5))));
  [0, 1, 2, 3].forEach((i) => D.push(B(229 + i * 3.6, 296, 1.8, 1.8, `border-radius:50%;background:${K.ledOff}`)));
  return liste(D);
}

const RADIATOR = (
  <>
    {R(RAD_X, DECKEL, RAD_L, 26, `border-radius:${cq(2)};background-color:${K.radB};background-image:repeating-linear-gradient(90deg,${K.radA} 0 1.2px,rgba(0,0,0,0) 1.2px 3px),linear-gradient(180deg,rgba(255,255,255,0.05),rgba(0,0,0,0.15));box-shadow:inset 0 0 0 1px ${K.sinkEdge}`, (
      <>
        <span style={sx(`position:absolute;left:0;right:0;top:0;height:${cq(4)};background:${K.radB};box-shadow:0 1px 0 ${K.sinkEdge};display:block`)} />
        <span style={sx(`position:absolute;left:0;right:0;bottom:0;height:${cq(4)};background:${K.radB};box-shadow:0 -1px 0 ${K.sinkEdge};display:block`)} />
      </>
    ))}
    {R(RAD_X, DECKEL - 1, 31, 33, `border-radius:${cq(3)};background:linear-gradient(90deg,${K.tank},${K.tankHi} 45%,${K.tank});box-shadow:inset 0 0 0 1px ${K.sinkEdge},0 2px 4px rgba(0,0,0,0.3)`, liste(HOSE.map(([x]) => R(x - RAD_X - 5, 27, 10, 6, `border-radius:${cq(1.5)};background:${K.steel};opacity:.8`))))}
    {R(RAD_X + RAD_L - 15, DECKEL, 15, 28, `border-radius:${cq(3)};background:linear-gradient(90deg,${K.tank},${K.tankHi} 45%,${K.tank});box-shadow:inset 0 0 0 1px ${K.sinkEdge},0 2px 4px rgba(0,0,0,0.3)`)}
    {radLuefter(RAD_X + 31)}
    {radLuefter(RAD_X + 151)}
  </>
);

const fuss = (seite: "left" | "right") => <span key={seite} style={sx(`position:absolute;${seite}:${cq(26)};width:${cq(54)};bottom:0;height:${cq(4)};border-radius:${cq(2)} ${cq(2)} 0 0;background:${K.foot};display:block`)} />;
const RAHMEN = (
  <>
    {R(0, 0, CW, DECKEL, `${mesh(K.frameDot, K.frame, 3)};box-shadow:inset 0 -1px 0 ${K.frameEdge}`)}
    {R(0, 0, HECK, CH, `${mesh(K.frameDot, K.frame, 3)};box-shadow:inset -1px 0 0 ${K.frameEdge}`)}
    {R(1.8, BY + 8, 4.4, 142, `background:${K.cut};border-radius:1px`)}
    {liste(Array.from({ length: 7 }, (_, i) => R(0.8, BY + 154 + i * 20.32 - 1.5, 6.4, 3, `background:${K.frameHi};border-radius:1px`)))}
    {R(0, GPU_Y, HECK, GPU_H, `border-radius:1px;background-image:repeating-linear-gradient(180deg,rgba(0,0,0,0.35) 0 1.5px,rgba(0,0,0,0) 1.5px 4px),linear-gradient(90deg,${K.steel},${K.sinkA})`)}
    {R(0, CH - SOCKEL, CW, SOCKEL, `background:linear-gradient(180deg,${K.frame},${K.frameLo});box-shadow:inset 0 1px 0 ${K.frameEdge}`, <>{fuss("left")}{fuss("right")}</>)}
    {R(CW - 12, DECKEL, 12, CH - DECKEL - SOCKEL, `background:linear-gradient(90deg,rgba(255,255,255,0),${K.glassBand});pointer-events:none`)}
    {R(CW - 1.4, DECKEL, 1.4, CH - DECKEL - SOCKEL, `background:linear-gradient(180deg,${K.glassEdge},${K.glassEdgeMid} 50%,${K.glassEdge})`)}
    {R(0, 0, CW, CH, `background:linear-gradient(115deg,rgba(255,255,255,0) 38%,${K.sheen} 47%,rgba(255,255,255,0) 58%);pointer-events:none`)}
  </>
);

const PLATINE = <>{platine()}</>;

// Schlaeuche und Winkelanschluesse (Wasserkuehlung): statisch
const schlauch = (x: number, y: number) => R(x - 4.25, DECKEL + 29, 8.5, y - 9 - (DECKEL + 29) + 2, `border-radius:${cq(4)};background:linear-gradient(90deg,${K.hose},${K.hoseHi} 42%,${K.hose} 80%)`);
const winkel = (x: number, y: number) => {
  const rand = PX - Math.sqrt(40 * 40 - (y - PY) ** 2) + 3;
  return (
    <span key={`w${x}`}>
      {R(x, y - 3.6, rand - x, 7.2, `border-radius:0 ${cq(1.5)} ${cq(1.5)} 0;background:linear-gradient(180deg,${K.steel},${K.sinkA});box-shadow:inset 0 0 0 1px ${K.sinkEdge}`)}
      {R(x - 5.5, y - 9, 11, 13, `border-radius:${cq(2)} ${cq(2)} ${cq(5.5)} ${cq(5.5)};background:linear-gradient(90deg,${K.sinkB},${K.steel} 45%,${K.sinkB});box-shadow:inset 0 0 0 1px ${K.sinkEdge},0 1px 3px rgba(0,0,0,0.35)`)}
    </span>
  );
};
const KUEHLUNG = (
  <>
    {liste(HOSE.map(([x, y]) => schlauch(x, y)))}
    {HOSE.map(([x, y]) => winkel(x, y))}
    <svg viewBox="-55 -55 110 110" style={sx(`${at(cq, PX - 55, PY - 55, 110, 110)};display:block`)} aria-hidden="true">
      {([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).map(([a, b]) => (
        <g key={`${a}${b}`}>
          <line x1={a * 24} y1={b * 24} x2={a * 37.5} y2={b * 37.5} strokeWidth="7" strokeLinecap="round" style={{ stroke: K.sinkB }} />
          <circle cx={a * 37.5} cy={b * 37.5} r="3.2" style={{ fill: K.steel }} />
        </g>
      ))}
    </svg>
  </>
);

// ---- Pumpenkopf mit Rundinstrument (Temperatur aussen, Last innen) ----
const G_R = 44, G_r = 33;
const G_C1 = 2 * Math.PI * G_R, G_C2 = 2 * Math.PI * G_r;

function Pumpenkopf({ temp, last }: { temp: number | null; last: number | null }) {
  const a1 = G_C1 * 0.75, a2 = G_C2 * 0.75;
  const pt = (frac: number, rad: number) => {
    const ang = ((135 + 270 * frac) * Math.PI) / 180;
    return [50 + rad * Math.cos(ang), 50 + rad * Math.sin(ang)];
  };
  const fW = (CPU_TEMP.mittel_warnung - 20) / 80;
  const [w1x, w1y] = pt(fW, 39.5), [w2x, w2y] = pt(fW, 48.5);
  const fT = temp == null ? 0 : Math.max(0, Math.min(1, (temp - 20) / 80));
  const fL = last == null ? 0 : Math.max(0, Math.min(1, last / 100));
  const bogenT = G_C1 - G_C1 * 0.75 * fT;
  const bogenL = G_C2 - G_C2 * 0.75 * fL;
  return (
    <>
      <svg viewBox="0 0 100 100" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", overflow: "visible" }} aria-hidden="true">
        <defs>
          <radialGradient id="tdKappe" cx="40%" cy="32%" r="75%">
            <stop offset="0" style={{ stopColor: K.capHi }} />
            <stop offset="1" style={{ stopColor: K.cap }} />
          </radialGradient>
        </defs>
        <circle cx="50" cy="50" r="49.3" style={{ fill: K.pumpBody, stroke: K.pumpRim, strokeWidth: 1.3 }} />
        <circle cx="50" cy="50" r="38.6" style={{ fill: "none", stroke: K.mirror, strokeWidth: 0.8 }} />
        <circle cx="50" cy="50" r="28.6" style={{ fill: "none", stroke: K.mirror, strokeWidth: 0.6 }} />
        <circle cx="50" cy="50" r={G_R} strokeLinecap="round" strokeDasharray={`${a1.toFixed(1)} ${G_C1.toFixed(1)}`} transform="rotate(135 50 50)" style={{ fill: "none", stroke: K.gT, strokeWidth: 5.5 }} />
        {temp != null ? <circle className="td-bogen" cx="50" cy="50" r={G_R} strokeLinecap="round" strokeDasharray={`${G_C1.toFixed(2)} ${G_C1.toFixed(2)}`} transform="rotate(135 50 50)" style={{ fill: "none", stroke: K.gA, strokeWidth: 5.5, ["--td-voll" as string]: G_C1.toFixed(2), strokeDashoffset: bogenT.toFixed(2) }} /> : null}
        <circle cx="50" cy="50" r={G_r} strokeLinecap="round" strokeDasharray={`${a2.toFixed(1)} ${G_C2.toFixed(1)}`} transform="rotate(135 50 50)" style={{ fill: "none", stroke: K.gT, strokeWidth: 3.4 }} />
        {last != null ? <circle className="td-bogen" cx="50" cy="50" r={G_r} strokeLinecap="round" strokeDasharray={`${G_C2.toFixed(2)} ${G_C2.toFixed(2)}`} transform="rotate(135 50 50)" style={{ fill: "none", stroke: K.gB, strokeWidth: 3.4, ["--td-voll" as string]: G_C2.toFixed(2), strokeDashoffset: bogenL.toFixed(2) }} /> : null}
        <circle cx="50" cy="50" r="25.5" style={{ fill: "url(#tdKappe)", stroke: K.mirror, strokeWidth: 0.6 }} />
        <line x1={w1x.toFixed(1)} y1={w1y.toFixed(1)} x2={w2x.toFixed(1)} y2={w2y.toFixed(1)} strokeLinecap="round" style={{ stroke: "var(--st-warn-ic)", strokeWidth: 1.6 }} />
      </svg>
      <span style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: K.lcdText }}>
        <span data-anim="zahl" style={{ display: "inline-block", minWidth: "2ch", textAlign: "center", fontFamily: "var(--font-heading)", fontSize: "max(11px, 3.9cqw)", fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: "tabular-nums", color: K.lcdText }}>{temp == null ? "–" : Math.round(temp)}</span>
        <span style={{ fontSize: 10.5, lineHeight: 1, color: K.gB, marginTop: 1 }}>°C</span>
      </span>
    </>
  );
}

// ---- Luefter der Grafikkarte ----
export type LuefterPhase = "steht" | "anlauf" | "laeuft" | "auslauf";
export interface LuefterZustand { phase: LuefterPhase; d: string; t: string; schnell: boolean }

function GpuLuefter({ x, gegen, l }: { x: number; gegen: boolean; l: LuefterZustand }) {
  const D = 84, H = 18;
  return el(cq, x - D / 2, 41, D, H, "", (
    <span
      className={`td-luefter${gegen ? " td-gegen" : ""}`}
      data-luefter={l.phase}
      data-luefter-schnell={l.schnell ? "true" : "false"}
      style={{ position: "absolute", left: 0, top: cq(-(D - H) / 2), width: cq(D), height: cq(D), display: "block", transform: `scaleY(${(H / D).toFixed(3)})`, ["--fan-d" as string]: l.d, ["--fan-t" as string]: l.t }}
    >
      <svg viewBox="0 0 60 60" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}>
        <circle cx="30" cy="30" r="29.4" style={{ fill: K.gpuUnder, stroke: K.ringRgb, strokeWidth: 1.1 }} />
        <circle cx="30" cy="30" r="27.2" style={{ fill: K.gfHole }} />
      </svg>
      <span className="td-rotor-a" style={{ position: "absolute", inset: 0, display: "block", transformOrigin: "50% 50%" }}>
        <svg className="td-rotor-b" viewBox="0 0 60 60" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", transformOrigin: "50% 50%" }}>
          <g transform={gegen ? "translate(60 0) scale(-1 1)" : undefined} style={{ fill: K.gfBlade, stroke: K.gfLine, strokeWidth: 0.5 }}>{BLATT}</g>
          <circle cx="30" cy="30" r="8" style={{ fill: K.gfHub, stroke: K.gfLine, strokeWidth: 0.8 }} />
        </svg>
      </span>
      <span className="td-scheibe" style={{ position: "absolute", inset: "6%", borderRadius: "50%", background: `radial-gradient(circle,${K.gfBlade} 20%,rgba(0,0,0,0) 72%)`, opacity: 0, pointerEvents: "none", display: "block" }} />
    </span>
  ));
}

function Grafikkarte({ temp, luefter }: { temp: number | null; luefter: LuefterZustand }) {
  const pwr = (x: number) => el(cq, x, -4, 21, 6.5, `${pins(2.6, 3.2)};border-radius:1px`, null, { key: `p${x}` });
  return (
    <>
      <svg viewBox="0 0 290 60" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} aria-hidden="true">
        <defs>
          <linearGradient id="tdKarte" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: K.gpuA }} />
            <stop offset="1" style={{ stopColor: K.gpuB }} />
          </linearGradient>
        </defs>
        <rect x="0" y="38" width="290" height="22" rx="4" style={{ fill: K.gpuUnder }} />
        <path d="M3 0 H287 A3 3 0 0 1 290 3 V40 H0 V3 A3 3 0 0 1 3 0 Z" style={{ fill: "url(#tdKarte)" }} />
        <path d="M0 30 H74 L84 35.5 H206 L216 30 H290" vectorEffect="non-scaling-stroke" style={{ fill: "none", stroke: K.gpuLine, strokeWidth: 0.8 }} />
        <path d="M84 35.5 L92 40 M206 35.5 L198 40 M96 9 H198 L206 15 M96 9 L90 15" vectorEffect="non-scaling-stroke" style={{ fill: "none", stroke: K.gpuLine, strokeWidth: 0.8 }} />
        <line x1="2" y1="0.8" x2="288" y2="0.8" vectorEffect="non-scaling-stroke" style={{ stroke: K.steel, strokeWidth: 1, opacity: 0.55 }} />
      </svg>
      <GpuLuefter x={52} gegen={false} l={luefter} />
      <GpuLuefter x={145} gegen l={luefter} />
      <GpuLuefter x={238} gegen={false} l={luefter} />
      {pwr(234)}
      {pwr(259)}
      <span style={sx(`${at(cq, 30, 9, 42, 18)};display:flex;align-items:center;justify-content:center;border-radius:2px;background:${K.lcd};box-shadow:inset 0 0 0 1px ${K.gpuLine}`)}>
        <span style={{ fontSize: 11, fontWeight: 700, lineHeight: 1, color: K.lcdText, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {temp == null ? "–" : Math.round(temp)}
          <span style={{ fontWeight: 500, opacity: 0.7 }}> °C</span>
        </span>
      </span>
    </>
  );
}

// ---- Arbeitsspeicher: 4 Steckplaetze, Riegel nach ram.module ----
// Ab 16 GB mit Kuehlblech und Lichtleiste, kleinere Riegel als blanke Platine mit Chips (wie im Rig).
function Riegelbank({ module }: { module: Array<{ platz: number; groesse_gb: number }> | null }) {
  const slotX = [4.5, 13, 21.5, 30];
  const teile: ReactNode[] = [];
  slotX.forEach((cx, i) => {
    teile.push(el(cq, cx - 2.6, 1, 5.2, 151, `background:${K.slot};box-shadow:inset 1px 0 0 ${K.steel},inset -1px 0 0 ${K.steel}`, null, { key: `s${i}` }));
    teile.push(el(cq, cx - 2.6, 0, 5.2, 4, `background:${K.latch};border-radius:1px`, null, { key: `l${i}` }));
    teile.push(el(cq, cx - 2.6, 148, 5.2, 4, `background:${K.latch};border-radius:1px`, null, { key: `u${i}` }));
    const m = module?.find((x) => x.platz === i + 1);
    if (!m) return;
    if (m.groesse_gb >= 16) {
      teile.push(el(cq, cx - 3.8, 6, 7.6, 140, `border-radius:1.5px;background:linear-gradient(90deg,${K.corsEdge},${K.cors} 30%,${K.cors} 70%,${K.corsEdge});box-shadow:0 2px 5px rgba(0,0,0,0.35)`, (
        <>
          {el(cq, 2.1, 6, 3.4, 128, `border-radius:2px;background:${K.bar};box-shadow:0 0 5px ${K.barGlow}`, null, { key: "b" })}
          {el(cq, 0.6, 0, 6.4, 5, `background:${K.latch};border-radius:1px`, null, { key: "o" })}
          {el(cq, 0.6, 135, 6.4, 5, `background:${K.latch};border-radius:1px`, null, { key: "u" })}
        </>
      ), { key: `m${i}` }));
    } else {
      teile.push(el(cq, cx - 1.2, 8, 2.4, 133, `background:linear-gradient(90deg,${K.samEdge},${K.sam});border-radius:0.6px`, (
        <>{Array.from({ length: 8 }, (_, c) => el(cq, 2.4, 6 + c * 16.2, 1.5, 10.5, `background:${K.chip};border-radius:0.5px`, null, { key: c }))}</>
      ), { key: `m${i}` }));
    }
  });
  return <>{teile}</>;
}

// ---- Rueckkammer: Netzteil (Modell unbekannt -> gestrichelt) und Laufwerkskaefig mit der SSD ----
export function Rueckkammer({ breite = 70 }: { breite?: number }) {
  const RK = (x: number, y: number, w: number, h: number, st: string, inner: ReactNode = null) => el(rq, x, y, w, h, st, inner);
  return (
    <span aria-hidden="true" style={{ position: "relative", flex: "none", display: "block", width: breite, aspectRatio: `${RKW} / ${CH}`, containerType: "inline-size", borderRadius: breite < 50 ? 4 : 6, background: K.caseIn, boxShadow: `inset 0 0 0 1px ${K.rkEdge}`, overflow: "hidden" }}>
      {RK(0, 0, RKW, DECKEL + 4, mesh(K.frameDot, K.frame, 3))}
      {RK(0, CH - SOCKEL - 4, RKW, SOCKEL + 4, `background:${K.frame}`)}
      {RK(12, 20, 164, 150, `border:1.5px dashed ${K.rkLine};border-radius:${rq(8)}`, <span style={sx(`position:absolute;left:${rq(24)};top:${rq(16)};width:${rq(112)};height:${rq(112)};border-radius:50%;box-shadow:inset 0 0 0 1.5px ${K.rkLine};display:block`)} />)}
      {RK(12, 186, 154, 124, `border:1.5px solid ${K.rkLine};border-top-width:0;border-radius:0 0 ${rq(6)} ${rq(6)}`)}
      <span style={sx(`${at(rq, 30, 220, 100, 70)};display:block;border-radius:${rq(6)};background:${K.ssdBody};box-shadow:0 0 0 1.5px ${K.rkSsd}`)}>
        <span style={sx(`position:absolute;left:12%;right:12%;top:20%;bottom:20%;border-radius:${rq(4)};background:${K.rkSsd};opacity:.55;display:block`)} />
        <span style={sx(`position:absolute;left:-${rq(5)};top:30%;width:${rq(6)};height:40%;background:${K.conn};display:block`)} />
      </span>
      {RK(RKW - 2, DECKEL + 4, 2, CH - DECKEL - SOCKEL - 8, `background:${K.rkEdge}`)}
    </span>
  );
}

// ---- Haarlinien Fahne -> Bauteil ----
const LUECKE = 8;
const ja = (b: boolean) => (b ? "true" : "false");
interface LeitZustand { sel: boolean; dim: boolean; vorschau: boolean }
const leitPunkt = ({ sel, dim, vorschau }: LeitZustand, x: number, y: number, d: number) => (
  <span className="td-leit-punkt" data-sel={ja(sel)} data-dim={ja(dim)} data-vorschau={ja(vorschau)} style={sx(`position:absolute;left:${cq(x)};top:${cq(y)};width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:${K.pcb};box-shadow:0 0 0 1.25px ${K.thr};display:block;animation-delay:${d}ms`)} />
);
function LeitOben({ z, x, y, d }: { z: LeitZustand; x: number; y: number; d: number }) {
  return (
    <>
      <span className="td-leit td-leit-y" data-sel={ja(z.sel)} data-dim={ja(z.dim)} data-vorschau={ja(z.vorschau)} style={sx(`position:absolute;left:${cq(x)};top:-${LUECKE}px;width:1px;margin-left:-0.5px;height:calc(${cq(y)} + ${LUECKE}px);transform-origin:center top;display:block;animation-delay:${d}ms`)} />
      {leitPunkt(z, x, y, d + 60)}
    </>
  );
}
function LeitUnten({ z, x, y, d }: { z: LeitZustand; x: number; y: number; d: number }) {
  return (
    <>
      <span className="td-leit td-leit-y" data-sel={ja(z.sel)} data-dim={ja(z.dim)} data-vorschau={ja(z.vorschau)} style={sx(`position:absolute;left:${cq(x)};top:${cq(y)};width:1px;margin-left:-0.5px;height:calc(${cq(CH - y)} + ${LUECKE}px);transform-origin:center bottom;display:block;animation-delay:${d}ms`)} />
      {leitPunkt(z, x, y, d + 60)}
    </>
  );
}

/** Bauteil in der Zeichnung: Klick waehlt es bzw. schliesst es wieder (Tastatur ueber die Fahne). */
function Hw({ z, ton, onClick, onZeige, x, y, w, h, rr = "3px", ringR, verz, children }: {
  z: LeitZustand; ton: string; onClick: () => void; onZeige: (an: boolean) => void; x: number; y: number; w: number; h: number; rr?: string; ringR?: string; verz: number; children: ReactNode;
}) {
  return (
    <span
      className="td-hw td-lade-hw"
      data-sel={ja(z.sel)}
      data-dim={ja(z.dim)}
      data-vorschau={ja(z.vorschau)}
      onClick={onClick}
      onMouseEnter={() => onZeige(true)}
      onMouseLeave={() => onZeige(false)}
      style={{ ...sx(`${at(cq, x, y, w, h)};display:block;border-radius:${rr};animation-delay:${verz}ms`), ["--td-ton" as string]: ton }}
    >
      {children}
      <span className="td-hw-ring" style={{ position: "absolute", inset: -4, borderRadius: ringR || `calc(${rr} + 4px)`, border: `1.5px solid ${K.sel}`, pointerEvents: "none", display: "block" }} />
    </span>
  );
}

/** Statische Lage der Zeichnung (gedimmt als Ganzes, damit Ueberdeckungen nicht durchscheinen). */
const Lage = ({ dim, children }: { dim: boolean; children: ReactNode }) => (
  <span data-dim={ja(dim)} style={{ position: "absolute", inset: 0, display: "block", pointerEvents: "none" }}>{children}</span>
);

type HwTeil = "cpu" | "gpu" | "ram";

export interface GehaeuseProps {
  sel: string;
  waehle: (teil: HwTeil) => void;
  /** Fokus-Modus: Bauteil des Rigs im Fokus (null = keiner oder Fokus ausserhalb des Rigs). */
  fokus: string | null;
  /** Hover-Vorschau (state-driven aus der Szene). */
  vorschau: string | null;
  zeige: (teil: HwTeil | null) => void;
  /** Zustandsfarbe je Bauteil (CSS-Farbe) fuer den Schein im Fokus. */
  toene: Record<HwTeil, string>;
  cpuTemp: number | null;
  cpuLast: number | null;
  gpuTemp: number | null;
  luefter: LuefterZustand;
  module: Array<{ platz: number; groesse_gb: number }> | null;
  /** Drehdauer je Front-Luefter (oben -> unten), null = steht; nur aus gemessenen Drehzahlen. */
  eckDreh: ReadonlyArray<string | null>;
  /** Das Rig meldet alle LEDs aus: Lichtleisten und Luefterringe unbeleuchtet zeichnen (stil.ts). */
  ledsAus: boolean;
}

export function Gehaeuse({ sel, waehle, fokus, vorschau, zeige, toene, cpuTemp, cpuLast, gpuTemp, luefter, module, eckDreh, ledsAus }: GehaeuseProps) {
  const waerme = cpuTemp == null ? 0 : Math.max(0, Math.min(1, (cpuTemp - 40) / 60)) * 0.22;
  const xCpu = 180, yCpu = PY - Math.sqrt(40 * 40 - (xCpu - PX) * (xCpu - PX));
  // Fokus auf einem Rig-Bauteil: Platine und Rahmen dimmen immer; die Kuehlung (Schlaeuche, Radiator, Front-
  // Luefter, Waermeschein) gehoert zum Prozessor-Panel «Prozessor und Kuehlung» und bleibt mit ihm hell.
  const z = (t: HwTeil): LeitZustand => ({ sel: sel === t, dim: fokus != null && fokus !== t, vorschau: vorschau === t });
  const hover = (t: HwTeil) => (an: boolean) => zeige(an ? t : null);
  return (
    <div className="td-gehaeuse" data-leds={ledsAus ? "aus" : undefined} style={{ position: "relative", width: "100%", aspectRatio: `${CW} / ${CH}`, containerType: "inline-size", borderRadius: 12, background: K.caseIn, boxShadow: K.caseOuter }}>
      <div aria-hidden="true" className="td-zeichnung" style={{ position: "absolute", inset: 0, borderRadius: 12, overflow: "hidden" }}>
        <Lage dim={fokus != null}>{PLATINE}</Lage>
        <Lage dim={z("cpu").dim}>
          {[23.5, 146.5, 269.5].map((y, i) => <span key={y}>{eckLuefter(y, eckDreh[i] ?? null)}</span>)}
        </Lage>
        <Hw z={z("ram")} ton={toene.ram} onClick={() => waehle("ram")} onZeige={hover("ram")} x={BX + 180} y={BY + 3} w={34} h={152} rr="2px" ringR="5px" verz={150}>
          <Riegelbank module={module} />
        </Hw>
        <Hw z={z("gpu")} ton={toene.gpu} onClick={() => waehle("gpu")} onZeige={hover("gpu")} x={8} y={GPU_Y} w={290} h={GPU_H} rr={cq(3)} verz={125}>
          <Grafikkarte temp={gpuTemp} luefter={luefter} />
        </Hw>
        <Lage dim={z("cpu").dim}>
          <span className="td-waerme" aria-hidden="true" style={sx(`${at(cq, PX - 78, PY - 78, 156, 156)};display:block;border-radius:50%;background:radial-gradient(circle,${K.heat} 0%,rgba(0,0,0,0) 62%);pointer-events:none;opacity:${waerme.toFixed(3)}`)} />
          {KUEHLUNG}
        </Lage>
        <Hw z={z("cpu")} ton={toene.cpu} onClick={() => waehle("cpu")} onZeige={hover("cpu")} x={PX - 40} y={PY - 40} w={80} h={80} rr="50%" ringR="50%" verz={100}>
          <Pumpenkopf temp={cpuTemp} last={cpuLast} />
        </Hw>
        <Lage dim={z("cpu").dim}>
          <span style={sx(`${at(cq, PX - 52, PY + 44, 92, 10)};display:flex;align-items:center;justify-content:center;gap:9px`)}>
            {(["Temp.", "Last"] as const).map((t, i) => (
              <span key={t} className="td-gauge-leg" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10.5, lineHeight: 1.2, letterSpacing: ".06em", color: K.silk, whiteSpace: "nowrap" }}>
                <span style={{ display: "inline-block", width: 9, height: 2, borderRadius: 1, background: i === 0 ? K.gA : K.gB, marginRight: 3 }} />
                {t}
              </span>
            ))}
          </span>
          {RADIATOR}
        </Lage>
        <Lage dim={fokus != null}>{RAHMEN}</Lage>
      </div>
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}>
        <LeitOben z={z("cpu")} x={xCpu} y={yCpu} d={380} />
        <LeitOben z={z("ram")} x={BX + 210} y={BY + 3} d={400} />
        <LeitUnten z={z("gpu")} x={180} y={GPU_Y + GPU_H} d={420} />
      </div>
    </div>
  );
}

// ---- NAS-Front mit 4 senkrechten, nummerierten Schaechten (externe USB-Platten stecken in keinem) ----
export interface Schacht { schacht: number; temp_c?: number; gesundheit?: "ok" | "warnung" | "fehler"; extern?: boolean }

export function NasFront({ netzBlinkt, schaechte }: { netzBlinkt: boolean; schaechte: Schacht[] | null }) {
  const NN = (x: number, y: number, w: number, h: number, st: string, inner: ReactNode = null, extra?: { className?: string; key?: string | number }) => el(cn, x, y, w, h, st, inner, extra);
  const DOOR_W = (160 - 3 * 2.5) / 4;
  const lamp = (x: number, an: boolean, extra?: { className?: string; key?: string | number; dataAn?: boolean }) => (
    <span
      key={extra?.key ?? `lamp${x}`}
      className={extra?.className}
      data-an={extra?.dataAn ? "true" : "false"}
      style={sx(`${at(cn, x - 1.6, 156.4, 3.2, 3.2)};display:block;border-radius:50%;${an ? `background:${K.ledOn};box-shadow:0 0 5px ${K.ledGlow}` : `background:${K.ledOff};box-shadow:inset 0 0 0 1px ${K.nasEdge}`}`)}
    />
  );
  return (
    <span aria-hidden="true" style={{ position: "relative", display: "block", width: "100%", aspectRatio: "1", containerType: "inline-size", borderRadius: cn(9), background: `linear-gradient(180deg,${K.nasA},${K.nasB})`, boxShadow: `inset 0 1px 0 ${K.nasEdge},inset 0 -1px 0 rgba(0,0,0,0.25),0 0 0 1px rgba(0,0,0,0.18),0 6px 14px rgba(0,0,0,0.18)` }}>
      {[0, 1, 2, 3].map((i) => {
        const s = schaechte?.find((x) => x.schacht === i + 1 && !x.extern) ?? null;
        const ton = s?.gesundheit === "fehler" ? "krit" : s?.gesundheit === "warnung" ? "warn" : s ? "gut" : null;
        return NN(9 + i * (DOOR_W + 2.5), 9, DOOR_W, 133, `border-radius:${cn(2.6)};background:linear-gradient(180deg,${K.doorA},${K.door});box-shadow:inset 0 1px 0 ${K.doorHi},inset 0 0 0 1px rgba(0,0,0,0.25)`, (
          <>
            <span style={{ position: "absolute", left: cn(5), top: cn(5), fontSize: 10.5, fontWeight: 700, lineHeight: 1, letterSpacing: ".04em", color: K.doorText, fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-heading)" }}>0{i + 1}</span>
            {NN(5, 20, DOOR_W - 10, 1.2, `background:${K.doorHi};border-radius:1px`, null, { key: "r" })}
            {s && s.temp_c != null ? (
              // Schrift waechst mit der Front, bleibt aber in der schmalen Tuer (sonst deckt die Nachbartuer das «°» ab)
              <span style={{ position: "absolute", left: 0, right: 0, top: cn(60), textAlign: "center", fontSize: "min(10.5px, 11.5cqw)", fontWeight: 700, color: K.doorText, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{Math.round(s.temp_c)}°</span>
            ) : null}
            {ton ? <span style={sx(`position:absolute;left:50%;top:${cn(100)};width:6px;height:6px;margin-left:-3px;border-radius:50%;background:var(--st-${ton}-ic);display:block`)} /> : null}
            {NN(DOOR_W / 2 - 3, 119, 6, 6, `border-radius:50%;background:${K.door};box-shadow:inset 0 0 0 1px ${K.nasEdge},inset 0 1px 1px rgba(0,0,0,0.5)`, NN(2.6, 1.2, 0.8, 3.6, `background:${K.nasEdge}`, null, { key: "k" }), { key: "g" })}
          </>
        ), { key: `t${i}` });
      })}
      {NN(11, 152, 11, 11, `border-radius:50%;background:${K.door};box-shadow:0 0 0 1.4px ${K.ledOn},0 0 6px ${K.ledGlow}`, null, { key: "ein" })}
      {lamp(31, true, { className: "td-nas-lan", dataAn: netzBlinkt, key: "lan" })}
      {lamp(39, false)}
      {lamp(46, false)}
      {lamp(53, false)}
      {lamp(60, false)}
      {NN(102, 157, 24, 1.8, `border-radius:1px;background:${K.usb}`, null, { key: "u1" })}
      {NN(133, 155.6, 11, 4.6, `border-radius:${cn(2.3)};background:${K.usb}`, null, { key: "u2" })}
      {NN(150, 155, 15, 5.6, `border-radius:1px;background:${K.usb}`, NN(2.2, 2.6, 10.6, 1.6, `background:${K.nasEdge}`, null, { key: "i" }), { key: "u3" })}
    </span>
  );
}
