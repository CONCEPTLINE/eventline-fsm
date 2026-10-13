// Technik-Dashboard: Gesamt-Banner oben (Entwurf banner()). Gesamt = schlechteste nicht-neutrale Stufe (Server).

import type { Bauteil } from "@/lib/technik-dashboard/typen";
import { K, st, type Ton } from "./farben";
import { Icon, NUM, type IconSchluessel } from "./bausteine";
import { anzeigeVon, tonVon } from "./status";
import { uhr } from "./format";
import type { Sicht, TeilKey } from "./sicht";

const ZIEL: Record<Bauteil, string> = {
  cpu: "Zum Prozessor", gpu: "Zur Grafikkarte", ram: "Zum Arbeitsspeicher", platten: "Zu den Platten", dienste: "Zu den Diensten",
  ki: "Zur KI", app: "Zur Verbindung", ablage: "Zum Abgleich", nas: "Zum NAS", index: "Zum Datei-Index", hardware: "Zur NAS-Hardware", backup: "Zur Sicherung",
};

function Zaehler({ ton, n, wort, icon }: { ton: Ton; n: number; wort: string; icon: IconSchluessel }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <Icon n={icon} s={13} c={ton === "neutral" ? K.mute : st(ton, "ic")} />
      <b style={NUM}>{n}</b>
      <span style={{ color: K.sub }}>{wort}</span>
    </span>
  );
}

function Knopf({ teil, text, s }: { teil: TeilKey; text: string; s: Sicht }) {
  return (
    <button type="button" className="kasten kasten-muted" onClick={() => s.waehle(teil)} aria-label={`${text}: Details öffnen`} style={{ flex: "none" }}>
      {text}
      <Icon n="chevron-right" s={14} c={K.mute} />
    </button>
  );
}

export function Banner({ s }: { s: Sicht }) {
  const { stand } = s;
  const A = stand.ampeln;
  const ton = tonVon(stand.gesamt.stufe);
  const pr = stand.gesamt.probleme;
  const gut = A.filter((a) => a.stufe === "gut").length;
  const neutral = (art: string) => A.filter((a) => a.stufe === "neutral" && a.neutral === art).length;
  const ruht = neutral("ruht");
  const kommt = neutral("kommt");
  const veraltet = neutral("veraltet");
  const offen = neutral("soll_offen") + neutral("nie_gemeldet") + neutral("nicht_lesbar");
  const zaehler = (
    <>
      <Zaehler ton="gut" n={gut} wort="gut" icon="circle-check" />
      {ruht ? <Zaehler ton="neutral" n={ruht} wort="ruht" icon="circle-pause" /> : null}
      {kommt ? <Zaehler ton="neutral" n={kommt} wort="kommt" icon="lock" /> : null}
      {veraltet ? <Zaehler ton="neutral" n={veraltet} wort="veraltet" icon="clock" /> : null}
      {offen ? <Zaehler ton="neutral" n={offen} wort="offen" icon="info" /> : null}
      {s.abrufFehler ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: st("warn", "fg") }}>
          <Icon n="clock" s={13} c={st("warn", "ic")} />
          Werte vom Stand {uhr(s.jetzt)}, die App antwortet gerade nicht
        </span>
      ) : null}
    </>
  );
  const erst = pr[0] ?? null;
  const an = erst ? anzeigeVon(erst) : null;
  const icon: IconSchluessel = ton === "krit" ? "octagon-x" : ton === "warn" ? "triangle-alert" : ton === "gut" ? "circle-check" : "info";
  // Eine Zeile (Mischa 2026-10-14): Zustand + erstes Problem (ganzer Text im Tooltip, falls gekuerzt),
  // dann die Zaehler; bricht nur bei wenig Platz in eine zweite Zeile um.
  const weitere = pr.length > 1 ? `Dazu ${pr.length - 1} weitere${pr.length - 1 === 1 ? "s Problem" : " Probleme"}` : null;
  return (
    <div className="td-lade-banner">
      <section role="status" data-status={ton} style={{ position: "relative", display: "flex", alignItems: "center", gap: "6px 14px", borderRadius: 12, padding: "7px 10px 7px 16px", background: `linear-gradient(0deg,${st(ton, "soft")},${st(ton, "soft")}),${K.e1}`, boxShadow: `0 0 0 1px ${K.hair},inset 0 1px 0 ${K.hiTop}`, overflow: "hidden", flexWrap: "wrap" }}>
        <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: st(ton, "edge") }} />
        <p data-tooltip={erst?.text || undefined} style={{ flex: "1 1 260px", minWidth: 0, margin: 0, display: "flex", alignItems: "center", gap: 9, fontSize: 14.5, lineHeight: 1.35 }}>
          <Icon n={icon} s={18} c={st(ton, "ic")} />
          {erst && an ? (
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              <b style={{ color: st(an.ton, "fg") }}>{an.wort}</b> · {erst.text}
            </span>
          ) : (
            <b>{ton === "gut" ? "Alles läuft" : "Keine Bewertung möglich"}</b>
          )}
        </p>
        <p style={{ margin: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", fontSize: 12.5, ...NUM }}>
          {weitere ? <span style={{ color: K.sub }}>{weitere}.</span> : null}
          {zaehler}
        </p>
        {erst ? (pr.length > 1 ? <Knopf teil="uebersicht" text="Alle Probleme" s={s} /> : <Knopf teil={erst.bauteil} text={ZIEL[erst.bauteil]} s={s} />) : <Knopf teil="uebersicht" text="Auf einen Blick" s={s} />}
      </section>
    </div>
  );
}
