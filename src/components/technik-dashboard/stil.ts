// Technik-Dashboard: Layout- und Bewegungs-CSS aus dem Entwurf (gen-main.mjs: style(), motion()), auf
// `.technik-zwilling` begrenzt. Bewegung nur ueber transform / opacity / stroke-dashoffset, nie Layout.
// prefers-reduced-motion: alles still, Zustaende wechseln sofort.
//
// Takt: Messwerte-Paket und Ablage-Abgleich laufen in einer 60-s-Periode. Der Nullpunkt kommt aus den
// echten Zeitstempeln (Rig sendet / Ablage fragt ab); die Seite setzt beim Wechsel data-takt a<->b
// und die verstrichenen Millisekunden in --td-m / --td-a. Der Namenswechsel der Keyframes startet alle
// Takt-Animationen neu, die negative Verzoegerung legt sie auf den echten Zeitpunkt.

import { FARB_CSS } from "./farben";

export const PERIODE = 60_000;
/** Ab dieser Inhaltsbreite stehen die Details als Spalte neben der Szene, darunter als Schublade. */
export const SPALTE_AB_PX = 920;
// Zeitpunkte innerhalb der Periode (ms ab Nullpunkt), wie im Entwurf
export const T_MESS_START = 900;
export const T_MESS_LAUF = 1600;
export const T_MESS_AN = T_MESS_START + T_MESS_LAUF;
export const T_ABL_START = 0;
export const T_ABL_LAUF = 1400;
export const T_ABL_ZURUECK = T_ABL_START + T_ABL_LAUF + 1000;
export const T_SSD = T_ABL_ZURUECK + T_ABL_LAUF;

const IO = "cubic-bezier(.45,0,.55,1)";
const pz = (ms: number) => +((ms / PERIODE) * 100).toFixed(3);
const R = ".technik-zwilling";

const zug = (name: string, lauf: number, ein = 120, aus = 150) => {
  const a = pz(lauf), e = pz(ein), o = +(a - pz(aus)).toFixed(3);
  return `@keyframes ${name}{0%{transform:translateX(0);opacity:0;animation-timing-function:${IO}}${e}%{opacity:1}${o}%{opacity:1}${a}%{transform:translateX(100%);opacity:0}100%{transform:translateX(100%);opacity:0}}`;
};
/** Verzoegerung relativ zum Nullpunkt: calc(<offset>ms - var(--td-m) * 1ms). */
const dm = (off: number) => `calc(${off}ms - var(--td-m, 0) * 1ms)`;
const da = (off: number) => `calc(${off}ms - var(--td-a, 0) * 1ms)`;

const takt = (["a", "b"] as const)
  .map((s) => {
    const X = s.toUpperCase();
    const W = `${R}[data-takt="${s}"]`;
    return `${zug("tdMess" + X, T_MESS_LAUF)}
${zug("tdAblage" + X, T_ABL_LAUF)}
@keyframes tdBlitz${X}{0%{opacity:0}${pz(150)}%{opacity:.8}${pz(300)}%{opacity:0}100%{opacity:0}}
@keyframes tdLed${X}{0%{opacity:.3}${pz(90)}%{opacity:1}${pz(180)}%{opacity:.3}100%{opacity:.3}}
@keyframes tdDienst${X}{0%{opacity:1}${pz(180)}%{opacity:.35}${pz(420)}%{opacity:1}100%{opacity:1}}
@keyframes tdNetz${X}{0%{opacity:1}${pz(80)}%{opacity:.2}${pz(160)}%{opacity:1}${pz(240)}%{opacity:.2}${pz(320)}%{opacity:1}100%{opacity:1}}
${W} .td-wire[data-mess="an"] .td-paket[data-paket="messwerte"]{animation:tdMess${X} ${PERIODE}ms linear ${dm(T_MESS_START)} infinite}
${W} .td-wire[data-mess="an"] .td-blitz{animation:tdBlitz${X} ${PERIODE}ms linear ${dm(T_MESS_AN - 60)} infinite}
${W} .td-wire[data-fluss="an"] .td-paket[data-paket="ablage-hin"]{animation:tdAblage${X} ${PERIODE}ms linear ${da(T_ABL_START)} infinite}
${W} .td-wire[data-fluss="an"] .td-paket[data-paket="ablage-antwort"]{animation:tdAblage${X} ${PERIODE}ms linear ${da(T_ABL_ZURUECK)} infinite}
${W} .td-ssd-led[data-an="true"]{animation:tdLed${X} ${PERIODE}ms linear ${da(T_SSD)} infinite}
${W} .td-nas-lan[data-an="true"]{animation:tdNetz${X} ${PERIODE}ms linear ${da(T_ABL_START + T_ABL_LAUF)} infinite}
${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => `${W} .td-dienst[data-an="true"]:nth-child(${i + 1}){animation:tdDienst${X} ${PERIODE}ms linear ${dm(T_MESS_AN + i * 70)} infinite}`).join("\n")}
${W} .td-herz[data-an="true"]{animation:tdDienst${X} ${PERIODE}ms linear ${dm(T_MESS_AN)} infinite}`;
  })
  .join("\n");

// Fokus-Modus (sicht.ts: fokusVon/geraetGedimmt/teilGedimmt): gedimmte Teile tragen data-dim="true", die
// Hover-Vorschau data-vorschau="true" (state-driven aus der Szene, kein :hover). Gewaehltes Bauteil: Ring in
// Auswahlfarbe plus Schein in seiner Zustandsfarbe (--td-ton am Bauteil). Dauer ~220 ms, ohne Bewegung sofort.
const GLOW = `0 0 0 3px color-mix(in srgb,var(--td-ton,var(--k-sel)) var(--k-glowNah),transparent),0 0 22px 2px color-mix(in srgb,var(--td-ton,var(--k-sel)) var(--k-glowFern),transparent)`;
const FOKUS = `${R} [data-dim]{transition:opacity var(--d-klein) var(--ease-std),filter var(--d-klein) var(--ease-std),transform var(--d-klein) var(--ease-std),background var(--d-klein) var(--ease-std)}
${R} [data-dim="true"]{opacity:var(--k-dimOp);filter:grayscale(1)}
${R} [data-dim="true"][data-vorschau="true"]{opacity:var(--k-dimHov);filter:grayscale(.5)}
${R} .td-part[aria-pressed="true"] .td-sel-ring,${R} .td-hw[data-sel="true"] .td-hw-ring{box-shadow:${GLOW}}
${R} .td-part[aria-pressed="false"][data-vorschau="true"] .td-sel-schatten{opacity:.45;transition-duration:var(--d-mikro)}
${R} .td-part[aria-pressed="false"][data-vorschau="true"] .td-sel-ring{opacity:.35;transform:none;transition-duration:var(--d-mikro)}
${R} .td-hw[data-sel="false"][data-vorschau="true"] .td-hw-ring{opacity:.45;transform:none;transition-duration:var(--d-mikro)}
${R} .td-leit[data-sel="false"][data-vorschau="true"]{background:var(--k-sel)}`;

const BEWEGUNG = `${R}{--ease-out:cubic-bezier(.16,1,.3,1);--ease-std:cubic-bezier(.4,0,.2,1);--d-mikro:140ms;--d-klein:220ms;--d-mittel:360ms}
${R} .td-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@keyframes tdAuf{from{opacity:0;transform:translateY(8px)}}
@keyframes tdAufKlein{from{opacity:0;transform:translateY(6px)}}
@keyframes tdZahlAuf{from{opacity:0;transform:translateY(4px)}}
@keyframes tdBlende{from{opacity:0}}
@keyframes tdLinieX{from{transform:scaleX(0)}}
@keyframes tdLinieY{from{transform:scaleY(0)}}
@keyframes tdWachsX{from{transform:scaleX(0)}}
@keyframes tdBogen{from{stroke-dashoffset:var(--td-voll)}}
@keyframes tdWisch{from{transform:translateX(-100%)}}
@keyframes tdWischIn{from{transform:translateX(100%)}}
@keyframes tdPop{from{opacity:0;transform:scale(.6)}}
@keyframes tdPuls{from{opacity:.35;transform:scale(1)}to{opacity:0;transform:scale(1.12,1.6)}}
@keyframes tdSchubladeAuf{from{opacity:0;transform:translateX(24px)}}
@keyframes tdSchubladeZu{to{opacity:0;transform:translateX(24px)}}
@keyframes tdDreh{to{transform:rotate(360deg)}}
@keyframes tdDrehR{to{transform:rotate(-360deg)}}
@keyframes tdAnlauf{from{transform:rotate(0deg)}to{transform:rotate(154.286deg)}}
@keyframes tdAnlaufR{from{transform:rotate(0deg)}to{transform:rotate(-154.286deg)}}
@keyframes tdArbeit{from{transform:translateX(-100%)}to{transform:translateX(360%)}}
@keyframes tdAbfrage{0%{transform:translateX(0);opacity:0;animation-timing-function:${IO}}5%{opacity:.5}30%{opacity:.5}35%{transform:translateX(100%);opacity:0}100%{transform:translateX(100%);opacity:0}}
${takt}
${R} .td-wire[data-fluss="an"] .td-paket[data-paket="abfrage"]{animation:tdAbfrage 2s linear infinite}
${R} .td-wire[data-auftrag="an"] .td-paket[data-paket="auftrag"]{animation:tdAuftrag 6s linear 1300ms infinite}
${R} .td-wire[data-auftrag="an"] .td-paket[data-paket="ergebnis"]{animation:tdErgebnis 6s linear 1300ms infinite}
@keyframes tdAuftrag{0%{transform:translateX(0);opacity:0;animation-timing-function:${IO}}2%{opacity:1}13%{opacity:1}15%{transform:translateX(100%);opacity:0}100%{transform:translateX(100%);opacity:0}}
@keyframes tdErgebnis{0%{transform:translateX(0);opacity:0}60%{transform:translateX(0);opacity:0;animation-timing-function:${IO}}62%{opacity:1}73%{opacity:1}75%{transform:translateX(100%);opacity:0}100%{transform:translateX(100%);opacity:0}}
${R} .td-lade-banner{animation:tdBlende var(--d-mittel) var(--ease-out) backwards}
${R} .td-scene{animation:tdBlende var(--d-mittel) var(--ease-out) 20ms backwards}
${R} .td-lade-geraet{animation:tdAuf var(--d-mittel) var(--ease-out) backwards}
${R} .td-lade{animation:tdAufKlein var(--d-mittel) var(--ease-out) backwards}
${R} .td-linie{animation:tdLinieX 400ms var(--ease-out) backwards}
${R} .td-linie-v{animation:tdLinieY 400ms var(--ease-out) backwards}
${R} .td-etikett{animation:tdBlende var(--d-klein) var(--ease-out) backwards}
${R} .td-scene [data-anim="balken"]{animation:tdWachsX 520ms var(--ease-out) 300ms backwards}
${R} .td-lade-hw{animation:tdAufKlein var(--d-mittel) var(--ease-out) backwards}
${R} .td-leit-y{animation:tdLinieY 280ms var(--ease-out) backwards}
${R} .td-leit-punkt{animation:tdPop 160ms var(--ease-out) backwards}
${R} .td-bogen{animation:tdBogen 560ms var(--ease-out) 240ms backwards;transition:stroke-dashoffset 1200ms var(--ease-std)}
${R} .td-scene [data-anim="zahl"]{animation:tdZahlAuf var(--d-mittel) var(--ease-out) 260ms backwards}
${R} .td-wisch-laden{animation:tdWisch 540ms var(--ease-out) 300ms backwards}
${R} .td-wisch-laden>.td-wisch-in{animation:tdWischIn 540ms var(--ease-out) 300ms backwards}
${R} .td-lade-streifen{animation:tdBlende var(--d-mittel) var(--ease-out) 120ms backwards}
${R} .td-balken.td-folgt{transition:transform 1200ms var(--ease-std)}
${R} .td-waerme{transition:opacity 1200ms var(--ease-std)}
${R} .td-part{transition:transform var(--d-klein) var(--ease-std)}
${R} .td-part[aria-pressed="true"]{transform:translateY(-2px)}
${R} .td-sel-schatten{opacity:0;transition:opacity var(--d-klein) var(--ease-std)}
${R} .td-sel-ring{opacity:0;transform:scale(.985);transition:opacity var(--d-klein) var(--ease-std),transform var(--d-klein) var(--ease-out),box-shadow var(--d-klein) var(--ease-std)}
${R} .td-sel-kerbe{opacity:0;transform:scaleX(0);transform-origin:left center;transition:opacity var(--d-mikro) var(--ease-std),transform var(--d-klein) var(--ease-out) 60ms}
${R} .td-part[aria-pressed="true"] .td-sel-schatten,${R} .td-part[aria-pressed="true"] .td-sel-ring,${R} .td-part[aria-pressed="true"] .td-sel-kerbe{opacity:1;transform:none}
${R} .td-hw{cursor:pointer;transition:transform var(--d-klein) var(--ease-std)}
${R} .td-hw[data-sel="true"]{transform:translateY(-2px)}
${R} .td-hw-ring{opacity:0;transform:scale(.985);transition:opacity var(--d-klein) var(--ease-std),transform var(--d-klein) var(--ease-out),box-shadow var(--d-klein) var(--ease-std)}
${R} .td-hw[data-sel="true"] .td-hw-ring{opacity:1;transform:none}
${R} .td-leit{background:var(--k-thr);transition:background var(--d-klein) var(--ease-std)}
${R} .td-leit[data-sel="true"]{background:var(--k-sel)}
${R} .td-leit-punkt[data-sel="true"]{box-shadow:0 0 0 1.5px var(--k-sel) !important}
${FOKUS}
${R} .td-aside[data-phase="raus"] .td-panelwrap,${R} .td-aside[data-phase="zu"] .td-panelwrap{opacity:0;transition:opacity 120ms var(--ease-std)}
${R} .td-panel{animation:tdAufKlein 260ms var(--ease-out) backwards}
${R} .td-panel [data-anim="kachel"]{animation:tdAufKlein 260ms var(--ease-out) backwards}
${[1, 2, 3, 4, 5, 6].map((i) => `${R} .td-panel [data-anim="kachel"]:nth-child(${i}){animation-delay:${i * 30}ms}`).join(" ")}
${R} .td-panel .td-wisch{animation:tdWisch 560ms var(--ease-out) 120ms backwards}
${R} .td-panel .td-wisch-in{animation:tdWischIn 560ms var(--ease-out) 120ms backwards}
${R} .td-panel .td-flaeche{animation:tdBlende 180ms var(--ease-std) 600ms backwards}
${R} .td-panel .td-endpunkt{animation:tdPop 160ms var(--ease-out) 640ms backwards}
${R} .td-panel .td-endwert{animation:tdBlende 180ms var(--ease-std) 660ms backwards}
${R} .td-aside[data-wechsel="bereich"] .td-wisch,${R} .td-aside[data-wechsel="bereich"] .td-wisch-in,${R} .td-aside[data-wechsel="bereich"] .td-flaeche,${R} .td-aside[data-wechsel="bereich"] .td-endpunkt,${R} .td-aside[data-wechsel="bereich"] .td-endwert{animation:none}
${R} .td-aside[data-wechsel="bereich"] .td-kurve{animation:tdBlende var(--d-klein) var(--ease-std) backwards}
${R} .td-glas-an{transition:opacity 600ms var(--ease-std)}
${R} .td-arbeit{animation:tdArbeit 2.4s ${IO} infinite}
${R} .td-rotor-b{animation:tdDreh var(--fan-d,2s) linear infinite;animation-play-state:paused}
${R} .td-luefter[data-luefter="laeuft"] .td-rotor-b{animation-play-state:running}
${R} .td-luefter[data-luefter="anlauf"] .td-rotor-a{animation:tdAnlauf var(--fan-t,1.7s) cubic-bezier(.333,0,.667,.333) both}
${R} .td-luefter[data-luefter="auslauf"] .td-rotor-a{animation:tdAnlauf var(--fan-t,1.7s) cubic-bezier(.333,.667,.667,1) both}
${R} .td-gegen .td-rotor-b{animation-name:tdDrehR}
${R} .td-luefter.td-gegen[data-luefter="anlauf"] .td-rotor-a,${R} .td-luefter.td-gegen[data-luefter="auslauf"] .td-rotor-a{animation-name:tdAnlaufR}
${R} .td-scheibe{transition:opacity 600ms var(--ease-std)}
${R} .td-luefter[data-luefter-schnell="true"] .td-scheibe{opacity:.4 !important}
${R} .td-eck-rotor{animation:tdDreh var(--fan-d,2s) linear infinite}
${R} .td-puls{animation:tdPuls 2.4s var(--ease-out) 600ms 3}
@media (prefers-reduced-motion: reduce){${R} *,${R} *::before,${R} *::after{animation:none !important;transition:none !important}}`;

const LAYOUT = `${R}{container:technik / inline-size;color:var(--k-text)}
${R} button:focus-visible{outline:2px solid var(--k-sel);outline-offset:3px}
${R} .td-panel-titel:focus{outline:none}
${R} .td-panel-titel:focus-visible{outline:2px solid var(--k-sel);outline-offset:3px;border-radius:4px}
${R} [role="group"] button[aria-pressed="true"]{background:var(--k-track);font-weight:700}
${R} [data-tooltip]:focus-visible{outline:2px solid var(--k-sel);outline-offset:2px;border-radius:4px}
${R} .td-split{--td-split-h:max(460px,calc(100dvh - var(--td-oben,190px) - var(--td-unten,32px)));position:relative;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;align-items:start}
${R} .td-split>*{grid-area:1 / 1}
${R} .td-aside{position:sticky;top:12px;justify-self:end;align-self:start;width:372px;max-width:calc(100% - 16px);max-height:calc(100vh - 24px);margin:10px 10px 0 0;z-index:20;box-shadow:var(--k-drawerFx) !important}
${R} .td-aside[data-open="false"]{display:none !important}
${R} .td-aside[data-open="true"]{animation:tdSchubladeAuf 280ms var(--ease-out) backwards}
${R} .td-aside[data-phase="zu"]{animation:tdSchubladeZu 180ms var(--ease-std) forwards}
${R} .td-aside[data-phase="zu"] .td-panelwrap{opacity:1}
${R} .td-streifen-panel{display:none}
${R} .td-scene{container:szene / inline-size}
${R} .td-grid{display:grid;grid-template-columns:minmax(0,1fr) 104px clamp(208px,30%,252px);grid-template-rows:auto minmax(0,1fr) auto}
@container szene (max-width: 600px){${R} .td-grid{grid-template-columns:minmax(0,1fr) 92px 200px}}
${R} .td-geraet{width:min(100%,max(240px,calc((var(--td-split-h) - var(--td-rest,300px)) * ${(435 / 415).toFixed(4)})));margin:0 auto}
@container technik (min-width: ${SPALTE_AB_PX}px){
${R} .td-split{grid-template-columns:minmax(0,1fr) clamp(300px,31%,360px);align-items:stretch}
${R} .td-split>*{grid-area:auto}
${R} .td-aside{position:relative;top:auto;justify-self:stretch;align-self:stretch;width:auto;max-width:none;max-height:none;min-height:min(520px,var(--td-split-h));contain:size;margin:0;z-index:auto;box-shadow:0 0 0 1px var(--k-hair),inset 0 1px 0 var(--k-hiTop) !important}
${R} .td-aside[data-open="false"]{display:flex !important}
${R} .td-aside[data-open="true"],${R} .td-aside[data-phase="zu"]{animation:none}
${R} .td-streifen-panel{display:flex}
${R} .td-streifen-unten{display:none}
}
@container (max-width:420px){${R} .td-gauge-leg{display:none !important}}`;

export const TECHNIK_CSS = `${FARB_CSS}\n${LAYOUT}\n${BEWEGUNG}`;
