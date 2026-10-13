// Technik-Dashboard: kleine Bausteine nach dem Entwurf (gen-main.mjs: pill, quiet, ov, num, tile, limits, hint, kommt, bar, ring).
// Status nie nur ueber Farbe: immer Icon + Wort.

import type { CSSProperties, ReactNode } from "react";
import {
  Activity, Archive, Bell, Bot, ChevronRight, CircleCheck, CirclePause, Clock, Cpu, Gauge, HardDrive,
  HardDriveUpload, Info, Laptop, Link as Kette, List, Lock, MemoryStick, Moon, MousePointerClick, OctagonX, Package,
  RefreshCw, Search, Server, TriangleAlert, X,
} from "lucide-react";
import { k, st, type Ton } from "./farben";
import type { Anzeige, IconName } from "./status";

const ICONS = {
  "circle-check": CircleCheck, "triangle-alert": TriangleAlert, "octagon-x": OctagonX, info: Info, lock: Lock,
  "circle-pause": CirclePause, cpu: Cpu, gauge: Gauge, "memory-stick": MemoryStick, "hard-drive": HardDrive,
  package: Package, bot: Bot, archive: Archive, bell: Bell, link: Kette, "refresh-cw": RefreshCw, moon: Moon,
  laptop: Laptop, "hard-drive-upload": HardDriveUpload, "chevron-right": ChevronRight, x: X, search: Search,
  "mouse-pointer-click": MousePointerClick, list: List, clock: Clock, activity: Activity, server: Server,
} as const;
export type IconSchluessel = keyof typeof ICONS | IconName;

export function Icon({ n, s = 18, c = "currentColor", style }: { n: IconSchluessel; s?: number; c?: string; style?: CSSProperties }) {
  const C = ICONS[n as keyof typeof ICONS] ?? Info;
  return <C aria-hidden="true" width={s} height={s} color={c} strokeWidth={2} style={{ flex: "none", display: "block", ...style }} />;
}

export const NUM: CSSProperties = { fontVariantNumeric: "tabular-nums" };
export const FH: CSSProperties = { fontFamily: "var(--font-heading)" };

/** Warnung/Kritisch als gefuellte Pille. */
export function Pill({ ton, wort, icon }: { ton: Ton; wort: string; icon: IconSchluessel }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, borderRadius: 999, padding: "2px 9px", fontSize: 11.5, fontWeight: 700, lineHeight: 1.5, background: st(ton, "bg"), color: st(ton, "fg"), whiteSpace: "nowrap", flex: "none" }}>
      <Icon n={icon} s={12} c={st(ton, "fg")} />
      {wort}
    </span>
  );
}

/** Gut/neutral leise: nur das Icon farbig. */
export function Quiet({ ton, wort, icon }: { ton: Ton; wort: string; icon: IconSchluessel }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, lineHeight: 1.4, color: ton === "neutral" ? k("mute") : k("sub"), whiteSpace: "nowrap", flex: "none" }}>
      <Icon n={icon} s={12} c={st(ton, "ic")} />
      {wort}
    </span>
  );
}

export function Chip({ a, wort }: { a: Anzeige; wort?: string }) {
  const w = wort ?? a.wort;
  return a.ton === "warn" || a.ton === "krit" ? <Pill ton={a.ton} wort={w} icon={a.icon} /> : <Quiet ton={a.ton} wort={w} icon={a.icon} />;
}

/** Problem-Puls: drei ruhige Pulse, danach statischer Ring. */
export function Puls({ ton, children }: { ton: Ton; children: ReactNode }) {
  if (ton !== "warn" && ton !== "krit") return <>{children}</>;
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <span aria-hidden="true" style={{ position: "absolute", inset: -3, borderRadius: 999, boxShadow: `0 0 0 1.5px ${st(ton, "line")}`, opacity: 0.6 }} />
      <span aria-hidden="true" className="td-puls" style={{ position: "absolute", inset: -3, borderRadius: 999, boxShadow: `0 0 0 1.5px ${st(ton, "edge")}`, opacity: 0 }} />
      {children}
    </span>
  );
}

/** Overline mit technischem Index. eng = einzeilig, bei Platzmangel mit «…» gekuerzt (Szene). */
export function Ov({ t, n, style, eng = false }: { t: ReactNode; n?: string; style?: CSSProperties; eng?: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 6, fontSize: 10.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: ".1em", lineHeight: 1.3, color: k("mute"), ...(eng ? { minWidth: 0 } : null), ...style }}>
      {n ? <span style={{ fontSize: 10, fontWeight: 400, letterSpacing: ".04em", color: k("idx"), ...NUM }}>{n}</span> : null}
      <span style={eng ? { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } : undefined}>{t}</span>
    </span>
  );
}

/** Zahl + Einheit (Einheit 60 %, Gewicht 500). */
export function Num({ v, u, size = 24, ch, style }: { v: ReactNode; u?: string; size?: number; ch?: number; style?: CSSProperties }) {
  return (
    <span data-anim="zahl" style={{ display: "inline-block", minWidth: ch ? `${ch}ch` : undefined, ...FH, fontSize: size, fontWeight: 700, lineHeight: 1.1, ...NUM, whiteSpace: "nowrap", ...style }}>
      {v}
      {u ? <span style={{ fontSize: ".6em", fontWeight: 500, color: k("sub"), marginLeft: ".2em" }}>{u}</span> : null}
    </span>
  );
}

export function Meta({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontSize: 11.5, lineHeight: 1.35, color: k("mute"), ...NUM, ...style }}>{children}</span>;
}

export function Klein({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <span style={{ fontSize: 11, lineHeight: 1.3, color: k("mute"), ...NUM, ...style }}>{children}</span>;
}

export function Balken({ pct, h = 6, farbe, style }: { pct: number; h?: number; farbe?: string; style?: CSSProperties }) {
  const p = Math.max(0, Math.min(100, pct));
  return (
    <span aria-hidden="true" style={{ display: "block", height: h, borderRadius: 999, background: k("track"), overflow: "hidden", ...style }}>
      <span data-anim="balken" style={{ display: "block", height: "100%", width: `${p}%`, minWidth: 3, background: farbe ?? k("A"), borderRadius: 999, transformOrigin: "left center" }} />
    </span>
  );
}

export function Kommt({ text, icon = "lock" }: { text: string; icon?: IconSchluessel }) {
  return (
    <div style={{ border: `1px dashed ${k("dash")}`, borderRadius: 10, padding: "9px 12px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: k("mute") }}>
      <Icon n={icon} s={14} c={k("mute")} />
      <span>{text}</span>
    </div>
  );
}

export function Tile({ label, wert, sub, tooltip }: { label: ReactNode; wert: ReactNode; sub?: ReactNode; tooltip?: string }) {
  return (
    <div data-anim="kachel" data-tooltip={tooltip} style={{ borderRadius: 10, padding: "10px 12px", background: k("tile"), display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, minHeight: 17, fontSize: 11.5, color: k("mute") }}>{label}</span>
      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis" }}>{wert}</span>
      {sub != null && sub !== "" ? <span style={{ fontSize: 11.5, lineHeight: 1.35, color: k("mute"), ...NUM }}>{sub}</span> : null}
    </div>
  );
}

export function Tiles({ children }: { children: ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8 }}>{children}</div>;
}

export const TileWert = ({ v, u, ch }: { v: ReactNode; u?: string; ch?: number }) => <Num v={v} u={u} size={20} ch={ch} />;

export type GrenzZeile = { ton: "gut" | "warn" | "krit"; text: string };
const GRENZ_WORT = { gut: "Gut", warn: "Warnung", krit: "Kritisch" } as const;
const GRENZ_ICON = { gut: "circle-check", warn: "triangle-alert", krit: "octagon-x" } as const;

/** Grenzen-Tabelle; aktiv = Zeile der aktuellen Stufe (hervorgehoben). */
export function Limits({ titel, zeilen, aktiv }: { titel: string; zeilen: GrenzZeile[]; aktiv?: Ton | null }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Ov t={titel} />
      {zeilen.map((z) => {
        const an = aktiv != null && aktiv !== "gut" && aktiv === z.ton;
        return (
          <div key={z.ton} style={{ display: "grid", gridTemplateColumns: "92px minmax(0,1fr)", gap: 8, alignItems: "center", fontSize: 12, ...NUM, ...(an ? { margin: "-2px -8px", padding: "2px 8px", borderRadius: 8, background: k("tile") } : null) }}>
            <span>{z.ton === "gut" ? <Quiet ton="gut" wort={GRENZ_WORT.gut} icon={GRENZ_ICON.gut} /> : <Pill ton={z.ton} wort={GRENZ_WORT[z.ton]} icon={GRENZ_ICON[z.ton]} />}</span>
            <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 8px" }}>
              {an ? <><b>{z.text}</b><span style={{ fontSize: 11, color: k("mute") }}>liegt gerade hier</span></> : z.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <p style={{ margin: 0, fontSize: 12, lineHeight: 1.45, color: k("mute"), ...NUM }}>{children}</p>;
}

export function Hint({ children, ton = "neutral" }: { children: ReactNode; ton?: Ton }) {
  const icon: IconSchluessel = ton === "krit" ? "octagon-x" : ton === "warn" ? "triangle-alert" : ton === "gut" ? "circle-check" : "info";
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 12.5, lineHeight: 1.45, padding: "9px 11px", borderRadius: 10, background: ton === "neutral" || ton === "gut" ? k("tile") : st(ton, "soft"), boxShadow: ton === "warn" || ton === "krit" ? `inset 0 0 0 1px ${st(ton, "line")}` : undefined }}>
      <Icon n={icon} s={14} c={st(ton, "ic")} style={{ marginTop: 2 }} />
      <span style={NUM}>{children}</span>
    </div>
  );
}

/** Kopf eines Detail-Panels. */
export function Kopf({ icon, titel, sub, chip }: { icon: IconSchluessel; titel: string; sub?: ReactNode; chip?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "6px 10px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <Icon n={icon} s={18} c={k("sub")} />
          <h2 tabIndex={-1} className="td-panel-titel" style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", margin: 0 }}>{titel}</h2>
        </div>
        {chip}
      </div>
      {sub ? <span style={{ fontSize: 12, color: k("mute"), ...NUM }}>{sub}</span> : null}
    </div>
  );
}

/** Auswahl-Markierung (Schatten, 1,5-px-Ring, rote Kerbe), per aria-pressed eingeblendet. */
export function Ring({ r = 13, inset = -4, kerbe = true }: { r?: number; inset?: number; kerbe?: boolean }) {
  return (
    <>
      <span aria-hidden="true" className="td-sel-schatten" style={{ position: "absolute", inset: 0, borderRadius: r, boxShadow: k("liftFx"), pointerEvents: "none", zIndex: 0 }} />
      <span aria-hidden="true" className="td-sel-ring" style={{ position: "absolute", inset, border: `1.5px solid ${k("sel")}`, borderRadius: r - inset, pointerEvents: "none", zIndex: 3 }} />
      {kerbe ? <span aria-hidden="true" className="td-sel-kerbe" style={{ position: "absolute", left: Math.max(r - 2, 8), top: inset - 1, width: 14, height: 2, borderRadius: 1, background: k("brand"), pointerEvents: "none", zIndex: 4 }} /> : null}
    </>
  );
}

export function EinAus({ label, an }: { label: string; an: boolean | undefined }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", ...(an ? { background: k("led") } : { boxShadow: `inset 0 0 0 1.5px ${k("mute")}` }) }} />
      {label} <span style={{ color: k("mute") }}>{an == null ? "unbekannt" : an ? "ein" : "aus"}</span>
    </span>
  );
}

export const BTN: CSSProperties = { background: "none", border: 0, margin: 0, padding: 0, textAlign: "left", color: "inherit", font: "inherit", cursor: "pointer" };
