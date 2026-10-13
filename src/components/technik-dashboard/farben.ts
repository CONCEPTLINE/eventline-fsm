// Technik-Dashboard: Szenen-Farben aus dem freigegebenen Entwurf (gen-main.mjs, THEMES/STS).
// Sie werden als CSS-Variablen in einem auf `.technik-zwilling` begrenzten Block ausgeliefert:
// hell = Standard, dunkel = `.dark .technik-zwilling` (App-Theme ueber next-themes).
// Allgemeine Flaechen (Karten, Seite) kommen aus den App-Tokens (--card, --background).
// Bewusster Entscheid (Review 2026-10-12): Im Dunkeln gilt die App-Flaeche (fast schwarz) statt
// des warmgrauen Entwurfs-Hintergrunds (#1D1D1B / Karten #242422) — die Seite liegt in der App
// und soll aussehen wie jede andere Admin-Seite. Fuer Entwurfstreue hier bg/e1 in DUNKEL auf
// "#1D1D1B"/"#242422" setzen; die Material-Farben (Gehaeuse, Bauteile) bleiben unveraendert.
// Keine Marken- oder Modellnamen in diesem Modul.

const DUNKEL = {
  bg: "var(--background)", e1: "var(--card)", e3: "#30302E",
  hair: "rgba(255,255,255,0.07)", hiTop: "rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.08)",
  text: "#eeeeee", sub: "#c4c4c2", mute: "#a3a3a1", idx: "#9a9a98",
  tile: "rgba(255,255,255,0.045)", track: "rgba(238,238,238,0.12)",
  A: "#eeeeee", B: "#8e8e8c", grid: "rgba(255,255,255,0.07)", thr: "#6e6e6c", dash: "#4f4f4d", brand: "#F53C3A", sel: "#ffffff",
  areaOp: "0.12",
  caseBg: "linear-gradient(180deg,#2D2D2B 0%,#2A2A28 55%,#282826 100%)",
  caseFx: "inset 0 1px 0 rgba(255,255,255,0.07),inset 0 -1px 0 rgba(0,0,0,0.35),0 0 0 1px rgba(255,255,255,0.06),0 24px 48px rgba(0,0,0,0.35)",
  partFx: "inset 0 1px 0 rgba(255,255,255,0.07),0 0 0 1px rgba(255,255,255,0.06),0 4px 12px rgba(0,0,0,0.22)",
  liftFx: "0 14px 30px rgba(0,0,0,0.45)",
  heat: "rgba(255,240,225,1)",
  glass: "#1a1a18", glassIdle: "#171715", glassFx: "inset 0 1px 3px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.05)", glassSheen: "rgba(255,255,255,0.03)",
  wire: "#5e5e5c", port: "#141413", portFx: "inset 0 1px 2px rgba(0,0,0,0.8),0 0 0 1px rgba(255,255,255,0.08)", flow: "#eeeeee",
  led: "#3f9f7c",
  drawerFx: "0 0 0 1px rgba(255,255,255,0.07),0 28px 64px rgba(0,0,0,0.55)",
  caseIn: "#232321", pcb: "#141413", pcbPat: "rgba(255,255,255,0.03)", silk: "#7f7f7c", silkHi: "#a9a9a6", holeRing: "rgba(255,255,255,0.10)",
  sinkA: "#3b3b39", sinkB: "#262625", sinkEdge: "rgba(255,255,255,0.09)", steel: "#8f8f8b", slot: "#0a0a09", latch: "#5a5a58", conn: "#0c0c0b", pin: "rgba(255,255,255,0.16)",
  cors: "#1c1c1b", corsEdge: "#444442", bar: "#ecebe6", barGlow: "rgba(236,235,230,0.30)", sam: "#2c7149", samEdge: "#46a06d", chip: "#0b0b0b",
  pumpBody: "#121211", pumpRim: "#5a5a58", mirror: "rgba(255,255,255,0.08)", cap: "#1a1a19", capHi: "#2e2e2c", hose: "#0e0e0d", hoseHi: "rgba(255,255,255,0.13)",
  gA: "#eeeeee", gB: "#8e8e8c", gT: "rgba(238,238,238,0.13)",
  gpuA: "#383836", gpuB: "#1d1d1c", gpuLine: "rgba(255,255,255,0.20)", gpuUnder: "#0d0d0c", ringRgb: "rgba(236,235,230,0.30)", lcd: "#0a0b0b", lcdText: "#f2f2f0",
  ssdBody: "#121211", ghost: "#62625f",
  nasA: "#4b4c49", nasB: "#3d3e3b", nasEdge: "rgba(255,255,255,0.12)", doorA: "#2d2e2c", door: "#242523", doorHi: "rgba(255,255,255,0.07)", doorText: "#bdbdba",
  ledOn: "#ffffff", ledGlow: "rgba(255,255,255,0.55)", ledOff: "#1c1c1b", usb: "#121211",
  gfHole: "#111110", gfBlade: "#4b4b49", gfLine: "#62625f", gfHub: "#1d1d1c",
  frame: "#343432", frameLo: "#2c2c2a", frameDot: "rgba(0,0,0,0.55)", frameEdge: "rgba(255,255,255,0.07)", frameHi: "#4a4a48", foot: "#1a1a19",
  meshBg: "#1a1a19", meshDot: "rgba(255,255,255,0.07)", trayEdge: "rgba(255,255,255,0.06)", cut: "#121211", cutEdge: "rgba(255,255,255,0.06)",
  cfFrame: "#2b2b29", cfEdge: "rgba(255,255,255,0.09)", cfSide: "#1f1f1e", cfPad: "#3a3a38", cfHole: "#121211", cfRing: "rgba(236,235,230,0.22)", cfBlade: "#3f3f3d", cfLine: "#58585a", cfHub: "#262624",
  radA: "#3a3a38", radB: "#202020", tank: "#2a2a28", tankHi: "#3c3c3a", glassEdge: "rgba(255,255,255,0.30)", glassEdgeMid: "rgba(255,255,255,0.10)", glassBand: "rgba(255,255,255,0.035)", sheen: "rgba(255,255,255,0.025)",
  caseOuter: "inset 0 1px 3px rgba(0,0,0,0.45),inset 0 0 0 1px rgba(0,0,0,0.25),0 0 0 1px rgba(255,255,255,0.05)", rkEdge: "rgba(255,255,255,0.10)", rkLine: "#77777a", rkSsd: "#d6d6d3",
  // Fokus-Modus: gedimmte Teile (Deckkraft), halbe Aufhellung bei Hover, Schein in Zustandsfarbe (Anteil).
  // Dunkel kraeftiger als hell, sonst verschwimmt der Unterschied auf der fast schwarzen Flaeche.
  dimOp: "0.2", dimHov: "0.6", glowNah: "40%", glowFern: "60%",
};

type Thema = typeof DUNKEL;

// Hell: eigenes Material (satiniertes Aluminium, vertiefte Mulde), nicht invertiert.
const HELL: Thema = {
  bg: "var(--background)", e1: "var(--card)", e3: "#FFFFFF",
  hair: "rgba(0,0,0,0.08)", hiTop: "rgba(255,255,255,0.9)", line: "rgba(0,0,0,0.08)",
  text: "#0a0a0a", sub: "#3d3d3d", mute: "#5c5c5a", idx: "#646462",
  tile: "rgba(10,10,10,0.035)", track: "rgba(10,10,10,0.08)",
  A: "#1D1D1B", B: "#8e8e8c", grid: "rgba(0,0,0,0.07)", thr: "#8f8f8d", dash: "#bdbdbb", brand: "#F53C3A", sel: "#1D1D1B",
  areaOp: "0.07",
  caseBg: "linear-gradient(180deg,#F5F5F3 0%,#EEEEEC 46%,#E8E8E6 100%)",
  caseFx: "inset 0 1px 0 rgba(255,255,255,1),inset 0 -1px 0 rgba(0,0,0,0.07),0 0 0 1px rgba(29,29,27,0.10),0 1px 2px rgba(29,29,27,0.08),0 10px 22px -6px rgba(29,29,27,0.12),0 26px 48px -18px rgba(29,29,27,0.16)",
  partFx: "inset 0 1px 0 rgba(255,255,255,1),0 0 0 1px rgba(29,29,27,0.08),0 1px 1px rgba(29,29,27,0.06),0 3px 8px -2px rgba(29,29,27,0.08)",
  liftFx: "0 2px 4px rgba(29,29,27,0.06),0 16px 30px -8px rgba(29,29,27,0.20)",
  heat: "rgba(240,214,186,1)",
  glass: "#FBFBFA", glassIdle: "#EEF0EF", glassFx: "inset 0 1px 2px rgba(29,29,27,0.10),inset 0 0 0 1px rgba(29,29,27,0.07),0 1px 0 rgba(255,255,255,0.9)", glassSheen: "rgba(255,255,255,0.55)",
  wire: "#929290", port: "#CFCFCC", portFx: "inset 0 1px 2px rgba(29,29,27,0.30),0 0 0 1px rgba(29,29,27,0.12),0 1px 0 rgba(255,255,255,0.9)", flow: "#1D1D1B",
  led: "#00a86b",
  drawerFx: "0 0 0 1px rgba(29,29,27,0.08),0 1px 2px rgba(29,29,27,0.06),0 24px 56px rgba(29,29,27,0.16)",
  caseIn: "#E4E5E2", pcb: "#262725", pcbPat: "rgba(255,255,255,0.035)", silk: "#9d9e9a", silkHi: "#c4c5c1", holeRing: "rgba(255,255,255,0.16)",
  sinkA: "#5f605c", sinkB: "#434440", sinkEdge: "rgba(255,255,255,0.16)", steel: "#c3c4c0", slot: "#121312", latch: "#7c7d79", conn: "#141514", pin: "rgba(255,255,255,0.20)",
  cors: "#222321", corsEdge: "#5a5b58", bar: "#ffffff", barGlow: "rgba(255,255,255,0.45)", sam: "#2c7149", samEdge: "#4fae78", chip: "#0d0d0d",
  pumpBody: "#151615", pumpRim: "#7a7b77", mirror: "rgba(255,255,255,0.10)", cap: "#1d1e1c", capHi: "#353633", hose: "#141514", hoseHi: "rgba(255,255,255,0.20)",
  gA: "#f2f2f0", gB: "#9a9a97", gT: "rgba(242,242,240,0.15)",
  gpuA: "#454643", gpuB: "#252624", gpuLine: "rgba(255,255,255,0.26)", gpuUnder: "#111211", ringRgb: "rgba(255,255,255,0.38)", lcd: "#0b0c0c", lcdText: "#f4f4f2",
  ssdBody: "#1a1b1a", ghost: "#9a9a97",
  nasA: "#8d8e8a", nasB: "#7b7c78", nasEdge: "rgba(255,255,255,0.34)", doorA: "#5f605c", door: "#525350", doorHi: "rgba(255,255,255,0.12)", doorText: "#f2f2f0",
  ledOn: "#ffffff", ledGlow: "rgba(255,255,255,0.75)", ledOff: "#3f403d", usb: "#2b2c2a",
  gfHole: "#141514", gfBlade: "#565753", gfLine: "#71726e", gfHub: "#222321",
  frame: "#F1F1EF", frameLo: "#E9E9E7", frameDot: "rgba(29,29,27,0.20)", frameEdge: "rgba(29,29,27,0.10)", frameHi: "#C4C5C1", foot: "#CFCFCC",
  meshBg: "#D6D7D4", meshDot: "rgba(29,29,27,0.16)", trayEdge: "rgba(29,29,27,0.12)", cut: "#BDBEBA", cutEdge: "rgba(29,29,27,0.10)",
  cfFrame: "#3b3c39", cfEdge: "rgba(255,255,255,0.14)", cfSide: "#2c2d2b", cfPad: "#545552", cfHole: "#1b1c1b", cfRing: "rgba(255,255,255,0.40)", cfBlade: "#61625e", cfLine: "#7a7b77", cfHub: "#30312f",
  radA: "#555652", radB: "#2f302e", tank: "#363734", tankHi: "#4d4e4a", glassEdge: "rgba(255,255,255,1)", glassEdgeMid: "rgba(255,255,255,0.6)", glassBand: "rgba(255,255,255,0.35)", sheen: "rgba(255,255,255,0.16)",
  caseOuter: "inset 0 1px 2px rgba(29,29,27,0.10),0 0 0 1px rgba(29,29,27,0.14),0 2px 6px -2px rgba(29,29,27,0.12)", rkEdge: "rgba(29,29,27,0.16)", rkLine: "#8a8b87", rkSsd: "#3a3b38",
  dimOp: "0.3", dimHov: "0.7", glowNah: "26%", glowFern: "34%",
};

export type FarbName = keyof Thema;

/** CSS-Variable einer Szenen-Farbe: k("caseBg") -> "var(--k-caseBg)". */
export const k = (n: FarbName) => `var(--k-${n})`;

// Status-Farben (Pill = Icon + Wort, nie nur Farbe)
type TonFarben = { bg: string; fg: string; ic: string; soft: string; edge: string; line: string };
const ST_DUNKEL: Record<"gut" | "warn" | "krit" | "neutral", TonFarben> = {
  gut: { bg: "rgba(16,185,129,0.20)", fg: "#6ee7b7", ic: "#4fc79a", soft: "rgba(16,185,129,0.05)", edge: "#2fa57b", line: "rgba(16,185,129,0.5)" },
  warn: { bg: "rgba(245,158,11,0.24)", fg: "#fcd34d", ic: "#fbbf24", soft: "rgba(245,158,11,0.06)", edge: "#f59e0b", line: "rgba(245,158,11,0.55)" },
  krit: { bg: "rgba(239,68,68,0.22)", fg: "#fca5a5", ic: "#f87171", soft: "rgba(239,68,68,0.05)", edge: "#ef4444", line: "rgba(239,68,68,0.6)" },
  neutral: { bg: "rgba(238,238,238,0.10)", fg: "#b4b4b2", ic: "#a3a3a1", soft: "rgba(238,238,238,0.03)", edge: "#8e8e8c", line: "rgba(238,238,238,0.3)" },
};
const ST_HELL: typeof ST_DUNKEL = {
  gut: { bg: "rgba(16,185,129,0.10)", fg: "#047857", ic: "#059669", soft: "rgba(16,185,129,0.06)", edge: "#00a86b", line: "rgba(5,150,105,0.5)" },
  warn: { bg: "rgba(245,158,11,0.15)", fg: "#92400e", ic: "#b45309", soft: "rgba(245,158,11,0.07)", edge: "#d97706", line: "rgba(217,119,6,0.6)" },
  krit: { bg: "rgba(239,68,68,0.10)", fg: "#b91c1c", ic: "#dc2626", soft: "rgba(239,68,68,0.05)", edge: "#dc2626", line: "rgba(220,38,38,0.6)" },
  neutral: { bg: "rgba(10,10,10,0.06)", fg: "#525252", ic: "#5f5f5d", soft: "rgba(10,10,10,0.025)", edge: "#8e8e8c", line: "rgba(10,10,10,0.25)" },
};

export type Ton = keyof typeof ST_DUNKEL;
/** CSS-Variable einer Status-Farbe: st("warn","fg") -> "var(--st-warn-fg)". */
export const st = (t: Ton, n: keyof TonFarben) => `var(--st-${t}-${n})`;

function block(thema: Thema, status: typeof ST_DUNKEL): string {
  const a = Object.entries(thema).map(([n, v]) => `--k-${n}:${v};`);
  const b = Object.entries(status).flatMap(([t, f]) => Object.entries(f).map(([n, v]) => `--st-${t}-${n}:${v};`));
  return a.join("") + b.join("");
}

/** Variablen-Block: hell als Standard, dunkel ueber die App-Klasse `.dark`. */
export const FARB_CSS = `.technik-zwilling{${block(HELL, ST_HELL)}}.dark .technik-zwilling{${block(DUNKEL, ST_DUNKEL)}}`;

/** Alle Szenen-Farben als CSS-Variablen, Kurzform wie im Generator: K.caseBg -> "var(--k-caseBg)". */
export const K = Object.fromEntries(Object.keys(DUNKEL).map((n) => [n, `var(--k-${n})`])) as Record<FarbName, string>;
