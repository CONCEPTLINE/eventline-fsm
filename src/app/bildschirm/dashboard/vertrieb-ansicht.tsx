"use client";

// Zweite Ansicht des Buero-Bildschirms (Leo 2026-10-30): der Vertrieb im
// gleichen Aufbau und mit denselben Regeln wie das Firmen-Dashboard.
// Links «Offene Gespraeche» als Agenda (nach Status gegliedert, gemessen,
// «+n weitere») und darunter die Kampagnen; rechts «Zuletzt im Vertrieb»
// (fest 3 Zeilen), «Als Naechstes» (geplanter Versand, faelliges
// Nachfassen) und «Braucht Aufmerksamkeit». Farbe nur mit Bedeutung:
// Rot = dringend, Amber = wartet auf uns, Gruen = Antwort erhalten.

import { useRef, type ReactNode } from "react";
import { Check } from "lucide-react";
import type {
  BildschirmGespraech, BildschirmVertrieb, BildschirmVertriebArt, BildschirmVertriebEreignis, BildschirmVertriebSchritt,
} from "@/lib/bildschirm-typen";
import { plusTage } from "@/lib/swiss-time";
import { ZRH, kurzDatum, uhrzeit } from "./format";
import { useZeilenPassen } from "./zeilen-passen";

const FEED_MAX = 3;
/** Ab so vielen Tagen ohne unsere Reaktion ist eine Antwort «dringend». */
const DRINGEND_TAGE = 2;

const GRUPPE: Record<BildschirmGespraech["status"], { titel: string; einzahl: string; mehrzahl: string }> = {
  geantwortet: { titel: "Antwort offen", einzahl: "wartet auf uns", mehrzahl: "warten auf uns" },
  anrufen: { titel: "Anrufen", einzahl: "Kontakt", mehrzahl: "Kontakte" },
  termin: { titel: "Termin vereinbart", einzahl: "Gespräch", mehrzahl: "Gespräche" },
  offerte: { titel: "Offerte offen", einzahl: "Offerte", mehrzahl: "Offerten" },
};

/** Label je Art; gruen = Antwort erhalten, sonst neutral (wie «Zuletzt passiert»). */
const ART: Record<BildschirmVertriebArt, { label: string; gruen: boolean }> = {
  antwort: { label: "Antwort", gruen: true },
  kein_bedarf: { label: "Kein Bedarf", gruen: false },
  unzustellbar: { label: "Unzustellbar", gruen: false },
  versand: { label: "Versendet", gruen: false },
};

function tagIso(iso: string): string {
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: ZRH });
}
function tageSeit(iso: string, heuteIso: string): number {
  return Math.round((Date.parse(`${heuteIso}T12:00:00Z`) - Date.parse(`${tagIso(iso)}T12:00:00Z`)) / 86_400_000);
}
function seitText(iso: string, heuteIso: string): string {
  const n = tageSeit(iso, heuteIso);
  if (n <= 0) return "heute";
  if (n === 1) return "gestern";
  if (n < 14) return `seit ${n} Tagen`;
  return `seit ${Math.round(n / 7)} Wo.`;
}
function prozent(teil: number, ganz: number): string {
  if (ganz === 0) return "–";
  const p = (teil / ganz) * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)} %`;
}

export function VertriebAnsicht({ v, heuteIso, aktiv }: { v: BildschirmVertrieb | null; heuteIso: string; aktiv: boolean }) {
  const listeRef = useRef<HTMLDivElement>(null);
  const max = useZeilenPassen(listeRef, v?.jetzt ?? "", 1.9);

  const gespraeche = v?.gespraeche ?? [];
  const sichtbar = max === null ? gespraeche : gespraeche.slice(0, max);
  const rest = gespraeche.length - sichtbar.length;
  const zeilen: ReactNode[] = [];
  let letzte = "";
  for (const g of sichtbar) {
    if (g.status !== letzte) {
      letzte = g.status;
      const n = gespraeche.filter((x) => x.status === g.status).length;
      const gr = GRUPPE[g.status];
      zeilen.push(
        <div key={`g-${g.status}`} className="b-monat">
          <span>{gr.titel}</span>
          <span>{n} {n === 1 ? gr.einzahl : gr.mehrzahl}</span>
        </div>,
      );
    }
    zeilen.push(<GespraechZeile key={g.id} g={g} heuteIso={heuteIso} />);
  }

  const angeschrieben = v?.kampagnen.reduce((s, k) => s + k.angeschrieben, 0) ?? 0;
  const antworten = v?.kampagnen.reduce((s, k) => s + k.antworten, 0) ?? 0;
  const geplant = v?.kampagnen.reduce((s, k) => s + k.geplant, 0) ?? 0;
  const feed = v ? v.zuletzt.liste.slice(0, FEED_MAX) : [];
  const feedRest = v ? Math.max(0, v.zuletzt.anzahl_7_tage - feed.filter((e) => e.zeit >= v.zuletzt.seit_7_tage).length) : 0;
  const a = v?.achtung;
  const punkte = a
    ? [
        { key: "antworten", label: "Antworten warten auf uns", n: a.antworten_offen, ton: "rot" },
        { key: "anrufen", label: "Kontakte anrufen", n: a.anrufen, ton: "amber" },
        { key: "nachfassen", label: "Nachfassen fällig", n: a.nachfassen, ton: "amber" },
        { key: "unzustellbar", label: "Adressen unzustellbar", n: a.unzustellbar, ton: "blau" },
      ].filter((x) => x.n > 0)
    : [];

  return (
    <div className={`b-mitte b-ansicht${aktiv ? " an" : " aus"}`} aria-hidden={!aktiv}>
      <div className="b-links">
        {/* Offene Gespraeche */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Offene Gespräche</span>
            <b>{v ? `${gespraeche.length} im Gespräch` : ""}</b>
          </div>
          <div className="b-agenda" ref={listeRef}>
            {!v ? (
              [0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="b-skel" />)
            ) : gespraeche.length === 0 ? (
              <div className="b-leer">Gerade keine offenen Gespräche.</div>
            ) : (
              zeilen
            )}
            {v && rest > 0 && <div className="b-mehr">+{rest} weitere</div>}
          </div>
        </section>

        {/* Kampagnen */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Kampagnen</span>
            <b>{v ? `${angeschrieben} angeschrieben · ${antworten} Antworten${geplant > 0 ? ` · ${geplant} geplant` : ""}` : ""}</b>
          </div>
          <div className="v-kampagnen" style={{ gridTemplateColumns: `repeat(${Math.max(1, v?.kampagnen.length ?? 3)}, minmax(0, 1fr))` }}>
            {(v?.kampagnen ?? []).map((k) => {
              const raus = k.kontakte > 0 ? (k.angeschrieben / k.kontakte) * 100 : 0;
              const plan = k.kontakte > 0 ? (k.geplant / k.kontakte) * 100 : 0;
              return (
                <div key={k.id} className="b-woche v-kampagne">
                  <div className="b-v">
                    {k.angeschrieben}
                    <small>von {k.kontakte}{k.geplant > 0 ? ` · ${k.geplant} geplant` : ""}</small>
                  </div>
                  <div className="v-fort">
                    <span className="raus" style={{ width: `${raus}%` }} />
                    {plan > 0 && <span className="plan" style={{ width: `${plan}%` }} />}
                  </div>
                  <div className="b-d">
                    <b>{k.name}</b>
                    {k.angeschrieben > 0 ? `${k.antworten} ${k.antworten === 1 ? "Antwort" : "Antworten"} · ${prozent(k.antworten, k.angeschrieben)}` : "noch nicht versendet"}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <div className="b-spalte">
        {/* Zuletzt im Vertrieb */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Zuletzt im Vertrieb</span>
            <b>{v ? `${v.zuletzt.anzahl_7_tage} in 7 Tagen` : ""}</b>
          </div>
          <div className="b-feed">
            {!v ? (
              [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
            ) : v.zuletzt.liste.length === 0 ? (
              <div className="b-leer">Seit 30 Tagen nichts Neues.</div>
            ) : (
              feed.map((e) => <Ereignis key={e.id} e={e} heuteIso={heuteIso} />)
            )}
            {v && feedRest > 0 && <div className="b-mehr">+{feedRest} weitere in 7 Tagen</div>}
          </div>
        </section>

        {/* Als Naechstes */}
        <section className="b-panel b-todos">
          <div className="b-titel">
            <span>Als Nächstes</span>
            <b>{v && geplant > 0 ? `${geplant} Mails geplant` : ""}</b>
          </div>
          <div className="v-naechstes">
            {!v ? (
              [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
            ) : v.naechstes.length === 0 ? (
              <div className="b-ok"><Check strokeWidth={3} /> Nichts geplant</div>
            ) : (
              v.naechstes.map((s) => <Schritt key={s.id} s={s} heuteIso={heuteIso} />)
            )}
          </div>
        </section>

        {/* Aufmerksamkeit */}
        <section className="b-panel">
          <div className="b-titel"><span>Braucht Aufmerksamkeit</span></div>
          <div className="b-achtung">
            {!v ? (
              [0, 1].map((i) => <div key={i} className="b-skel" />)
            ) : punkte.length === 0 ? (
              <div className="b-ok"><Check strokeWidth={3} /> Alles im grünen Bereich</div>
            ) : (
              punkte.map((x) => (
                <div key={x.key} className={`b-punkt ${x.ton}`}>
                  <span>{x.label}</span>
                  <span className="b-n">{x.n}</span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function GespraechZeile({ g, heuteIso }: { g: BildschirmGespraech; heuteIso: string }) {
  const tage = tageSeit(g.seit, heuteIso);
  const dringend = g.status === "geantwortet" && tage >= DRINGEND_TAGE;
  const d = new Date(g.seit);
  return (
    <div className={`b-auftrag b-fit${dringend ? " laeuft" : ""}`}>
      <div className="b-tagbox">
        <span className="b-tagnr">{d.toLocaleDateString("de-CH", { timeZone: ZRH, day: "2-digit" })}</span>
        <span className="b-tagwt">{d.toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "short" }).replace(".", "")}</span>
      </div>
      <div>
        <div className="b-a-titel">{g.firma}</div>
        <div className="b-a-sub">{[g.kampagne, g.ort].filter(Boolean).join(" · ")}</div>
      </div>
      <div className="b-a-rechts">
        {dringend && <span className="b-chip rot">dringend</span>}
        {g.status === "geantwortet" && !dringend && <span className="b-chip amber">Antwort offen</span>}
        {g.status === "anrufen" && <span className="b-chip amber">anrufen</span>}
        <span className="b-rel">{seitText(g.seit, heuteIso)}</span>
      </div>
    </div>
  );
}

function Ereignis({ e, heuteIso }: { e: BildschirmVertriebEreignis; heuteIso: string }) {
  const { label, gruen } = ART[e.art];
  const zeitText = e.tag === heuteIso ? uhrzeit(e.zeit) : heuteIso && e.tag === plusTage(heuteIso, -1) ? "gestern" : kurzDatum(e.tag);
  return (
    <div className="b-ereignis">
      <span className="b-e-zeit">{zeitText}</span>
      <span className={`b-e-art${gruen ? " gruen" : ""}`}>{label}</span>
      <span className="b-e-titel">{e.titel}</span>
      <span className="b-e-rechts"><span className="b-e-info">{e.kampagne}</span></span>
    </div>
  );
}

function Schritt({ s, heuteIso }: { s: BildschirmVertriebSchritt; heuteIso: string }) {
  const heute = s.tag === heuteIso;
  const morgen = !!heuteIso && s.tag === plusTage(heuteIso, 1);
  return (
    <div className="b-todo">
      <span className={`b-faellig${heute ? " amber" : ""}`}>{heute ? "heute" : morgen ? "morgen" : kurzDatum(s.tag)}</span>
      <span className="b-todo-titel">
        {s.art === "versand" ? `${s.anzahl} ${s.anzahl === 1 ? "Mail" : "Mails"} versenden` : `Nachfassen · ${s.anzahl} ${s.anzahl === 1 ? "Kontakt" : "Kontakte"}`}
      </span>
      <span className="b-e-info">{s.kampagne}{s.zeit ? ` · ${uhrzeit(s.zeit)}` : ""}</span>
    </div>
  );
}
