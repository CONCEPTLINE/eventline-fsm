// Technik-Dashboard: Abschnitt «Kühlung» im Prozessor-Panel (VERTRAG §2.5, Mischa 2026-10-14).
// Das Rig steuert Luefter und Pumpe nach Temperatur; hier wird das Profil gewaehlt (Leise · Ausgewogen · Kuehl)
// und gezeigt, was das Rig meldet: Drehzahl je Luefter, Pumpe, Kuehlmittel, LEDs. Ob das Rig ein neues Profil
// uebernommen hat, folgt nur aus Serverdaten (Wunsch aus technik_steuerung, aktiv aus rig.kuehlung) und
// ueberlebt so einen Reload.

import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { LUEFTER_PROFILE, PROFIL_ANZEIGE, luefterName } from "@/lib/technik-dashboard/konstanten";
import type { LuefterProfil, SteuerungStand } from "@/lib/technik-dashboard/typen";
import { K, st } from "./farben";
import { BTN, Chip, Icon, Kommt, Meta, NUM, Note, Ov, Tile, TileWert, Tiles } from "./bausteine";
import { tausend, komma } from "./format";
import { ampel, anzeigeVon } from "./status";
import { kuehlungEingerichtet, uebernahme } from "./kuehlung";
import type { Sicht } from "./sicht";

const ERKLAERUNG: Readonly<Record<LuefterProfil, string>> = {
  leise: "Lüfter und Pumpe drehen erst bei mehr Wärme hoch: ruhiger, der Prozessor wird etwas wärmer.",
  ausgewogen: "Grundeinstellung: Lautstärke und Temperatur im Gleichgewicht.",
  kuehl: "Lüfter und Pumpe drehen früher und schneller: kühler, dafür hörbar lauter.",
};

const LED_WORT = { aus: "aus", an: "an", unbekannt: "unbekannt" } as const;

function ProfilKnopf({ p, gewaehlt, dreht, gesperrt, onWahl }: { p: LuefterProfil; gewaehlt: boolean; dreht: boolean; gesperrt: boolean; onWahl: (p: LuefterProfil) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-pressed={gewaehlt}
      disabled={gesperrt}
      onClick={() => onWahl(p)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...BTN, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, padding: "5px 8px", fontSize: 12, borderRadius: 7, ...NUM,
        cursor: gesperrt ? "not-allowed" : "pointer",
        // Gewaehlt: Flaeche aus stil.ts ([role=group] button[aria-pressed=true]); Hover nur auf den anderen
        ...(hover && !gewaehlt && !gesperrt ? { background: K.tile } : null),
      }}
    >
      {dreht ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
      <span>{PROFIL_ANZEIGE[p]}</span>
    </button>
  );
}

async function setzeProfil(p: LuefterProfil): Promise<SteuerungStand> {
  const r = await fetch("/api/technik/steuerung", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ luefter_profil: p }),
    cache: "no-store",
  }).catch(() => {
    throw new Error("Keine Verbindung zur App.");
  });
  const j = (await r.json().catch(() => null)) as { success?: boolean; error?: string; steuerung?: SteuerungStand } | null;
  if (!r.ok || !j?.success || !j.steuerung) {
    const m = j?.error || `Antwort der App: HTTP ${r.status}`;
    throw new Error(/[.!?]$/.test(m) ? m : `${m}.`);
  }
  return j.steuerung;
}

/** Abschnitt Kuehlung: Kopf mit Zustand, Profil-Umschalter, Messwerte je Luefter, Pumpe, Kuehlmittel, LEDs. */
export function KuehlungTeil({ s }: { s: Sicht }) {
  const { stand, jetzt } = s;
  const k = stand.rig?.kuehlung;
  const eingerichtet = kuehlungEingerichtet(k);
  const ue = uebernahme(stand, jetzt);
  const steuerbar = eingerichtet && ue.wunsch != null;
  const [sendet, setSendet] = useState<LuefterProfil | null>(null);
  const a = ampel(stand.ampeln, "kuehlung");

  const wahl = async (p: LuefterProfil) => {
    if (sendet || !steuerbar || p === ue.wunsch) return;
    setSendet(p);
    try {
      await setzeProfil(p);
      await s.aktualisiere();
    } catch (e) {
      toast.error("Lüfter-Profil konnte nicht gesetzt werden", { description: `${e instanceof Error ? `${e.message} ` : ""}Die bisherige Einstellung bleibt.` });
    } finally {
      setSendet(null);
    }
  };

  // Was das Rig zum Wunsch meldet (eine Zeile, ruhig, fuer Vorleser angesagt). Je nur ein Spinner: waehrend
  // des Speicherns im Knopf, danach (Rig hat bis zu 2 min Zeit) hier in der Zeile.
  const aktivWort = ue.aktiv ? `«${PROFIL_ANZEIGE[ue.aktiv]}»` : "noch kein Profil";
  const zeile = (icon: ReactNode, fett: string, rest?: string) => (
    <span style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, lineHeight: 1.4, color: K.sub, ...NUM }}>
      {icon ? <span style={{ display: "inline-flex", flex: "none", paddingTop: 2 }}>{icon}</span> : null}
      <span><b style={{ fontWeight: 600 }}>{fett}</b>{rest ? <span style={{ color: K.mute }}> · {rest}</span> : null}</span>
    </span>
  );
  const meldung = !eingerichtet ? null
    : !steuerbar ? zeile(<Icon n="info" s={12} c={st("neutral", "ic")} />, "Gewünschtes Profil gerade nicht lesbar")
    : sendet != null ? zeile(null, "Wird übernommen …")
    : ue.art === "laeuft" ? zeile(<Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />, "Wird übernommen …", `Rig meldet noch ${aktivWort}`)
    : ue.art === "offen" ? zeile(<Icon n="info" s={12} c={st("neutral", "ic")} />, "Rig hat noch nicht übernommen", `meldet ${aktivWort}`)
    : zeile(<Icon n="circle-check" s={12} c={st("gut", "ic")} />, `Rig meldet ${aktivWort}`);

  const luefter = (k?.luefter ?? []).slice().sort((x, y) => x.nr - y.nr);
  const gridSpalten = "minmax(0,1fr) 88px 44px";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <Ov t="Kühlung" />
        {a ? <Chip a={anzeigeVon(a)} /> : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div role="group" aria-label="Lüfter-Profil" style={{ display: "grid", gridTemplateColumns: `repeat(${LUEFTER_PROFILE.length},minmax(0,1fr))`, gap: 2, padding: 2, boxShadow: `inset 0 0 0 1px ${K.line}`, borderRadius: 9, opacity: steuerbar ? 1 : 0.55 }}>
          {LUEFTER_PROFILE.map((p) => (
            <ProfilKnopf
              key={p}
              p={p}
              gewaehlt={(sendet ?? ue.wunsch) === p}
              dreht={sendet === p}
              gesperrt={!steuerbar || sendet != null}
              onWahl={wahl}
            />
          ))}
        </div>
        {meldung ? <div role="status" aria-live="polite" style={{ minHeight: 17, display: "flex", alignItems: "center" }}>{meldung}</div> : null}
      </div>
      {!eingerichtet ? <Kommt text="Kühlungs-Steuerung noch nicht eingerichtet" /> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {LUEFTER_PROFILE.map((p) => (
          <Meta key={p}>
            <b style={{ fontWeight: 600, color: ue.wunsch === p ? K.text : K.sub }}>{PROFIL_ANZEIGE[p]}:</b> {ERKLAERUNG[p]}
          </Meta>
        ))}
      </div>
      {eingerichtet ? (
        <>
          <Tiles>
            <Tile label="Pumpe" wert={<TileWert v={k.pumpe_rpm != null ? tausend(k.pumpe_rpm) : "–"} u="U/min" />} sub={k.pumpe_prozent != null ? `${Math.round(k.pumpe_prozent)} % Leistung` : undefined} />
            <Tile label="Kühlmittel" wert={<TileWert v={k.kuehlmittel_c != null ? komma(k.kuehlmittel_c) : "–"} u="°C" />} sub="Wasser im Kreislauf" />
          </Tiles>
          {luefter.length ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "grid", gridTemplateColumns: gridSpalten, gap: 10, padding: "0 0 6px", fontSize: 11, color: K.mute }}>
                <span>Lüfter</span><span style={{ textAlign: "right" }}>Drehzahl</span><span style={{ textAlign: "right" }}>Leistung</span>
              </div>
              {luefter.map((l) => {
                const steht = l.rpm === 0 && l.prozent !== 0;
                const ruht = l.rpm === 0 && l.prozent === 0;
                return (
                  <div key={l.nr} data-tooltip={steht ? `${luefterName(l)} steht, obwohl er laufen sollte.` : ruht ? "Steht gewollt, das Profil braucht ihn gerade nicht." : undefined} style={{ display: "grid", gridTemplateColumns: gridSpalten, gap: 10, alignItems: "center", padding: "7px 0", borderTop: `1px solid ${K.line}`, fontSize: 13, ...NUM }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      {steht ? <Icon n="triangle-alert" s={12} c={st("warn", "ic")} /> : <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", flex: "none", ...(l.rpm ? { background: K.led } : { boxShadow: `inset 0 0 0 1.5px ${K.mute}` }) }} />}
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{luefterName(l)}</span>
                      {steht ? <span style={{ fontSize: 11, color: st("warn", "fg") }}>steht</span> : ruht ? <span style={{ fontSize: 11, color: K.mute }}>ruht</span> : null}
                    </span>
                    <span style={{ textAlign: "right", whiteSpace: "nowrap" }}>{l.rpm != null ? `${tausend(l.rpm)} U/min` : "–"}</span>
                    <span style={{ textAlign: "right", color: K.mute, whiteSpace: "nowrap" }}>{l.prozent != null ? `${Math.round(l.prozent)} %` : "–"}</span>
                  </div>
                );
              })}
            </div>
          ) : <Kommt text="Lüfter: keine Drehzahl gemeldet" icon="info" />}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "7px 0 0", borderTop: `1px solid ${K.line}`, fontSize: 13 }}>
            <span>LEDs</span>
            <span style={{ fontWeight: 600, ...NUM }}>{k.leds ? LED_WORT[k.leds] : "unbekannt"}</span>
          </div>
        </>
      ) : stand.rig?.cpu?.luefter_rpm?.length ? (
        <Note>Lüfter-Drehzahl am Radiator: {stand.rig.cpu.luefter_rpm.map((r) => tausend(r)).join(" · ")} U/min</Note>
      ) : null}
    </div>
  );
}
