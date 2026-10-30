"use client";

// Zweite Ansicht des Buero-Bildschirms (Leo 2026-10-30): Stand der
// Vertriebs-Kampagnen. Gleiche Sprache wie das Firmen-Dashboard — links
// Pipeline, Kampagnen, Mails pro Woche; rechts die juengsten Antworten und
// was im Vertrieb Aufmerksamkeit braucht. Nur Zaehler und Firmennamen.

import { Check } from "lucide-react";
import type { BildschirmVertrieb, VertriebStatus } from "@/lib/bildschirm-typen";
import { ZRH } from "./format";

const STATUS_CHIP: Partial<Record<VertriebStatus, { label: string; ton: string }>> = {
  geantwortet: { label: "Antwort offen", ton: "amber" },
  anrufen: { label: "anrufen", ton: "amber" },
  termin: { label: "Termin", ton: "gruen" },
  offerte: { label: "Offerte", ton: "gruen" },
  auftrag: { label: "Auftrag", ton: "gruen" },
  kein_bedarf: { label: "kein Bedarf", ton: "grau" },
  unzustellbar: { label: "unzustellbar", ton: "rot" },
  gesendet: { label: "nachgefragt", ton: "grau" },
};

function tagMonat(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("de-CH", { timeZone: ZRH, day: "numeric", month: "numeric" });
}
function wann(iso: string, heuteIso: string): string {
  const d = new Date(iso);
  const tag = d.toLocaleDateString("sv-SE", { timeZone: ZRH });
  const zeit = d.toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" });
  if (tag === heuteIso) return zeit;
  return d.toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "short", day: "numeric", month: "numeric" }).replace(".,", ",");
}
function prozent(teil: number, ganz: number): string {
  if (ganz === 0) return "–";
  const p = (teil / ganz) * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)} %`;
}

export function VertriebAnsicht({ v, heuteIso, aktiv }: { v: BildschirmVertrieb | null; heuteIso: string; aktiv: boolean }) {
  const p = v?.pipeline;
  const stufen = p
    ? [
        { label: "Angeschrieben", n: p.angeschrieben, sub: p.geplant > 0 ? `+ ${p.geplant} geplant` : "Erstmails raus" },
        { label: "Antworten", n: p.antworten, sub: `Rücklauf ${prozent(p.antworten, p.angeschrieben)}` },
        { label: "Termin", n: p.termin, sub: "im Gespräch" },
        { label: "Offerte", n: p.offerte, sub: "offeriert" },
        { label: "Auftrag", n: p.auftrag, sub: "gewonnen", ziel: true },
      ]
    : [];
  const maxWoche = Math.max(1, ...(v?.wochen.map((w) => Math.max(w.gesendet, w.geplant)) ?? [1]));
  const maxKamp = Math.max(1, ...(v?.kampagnen.map((k) => k.kontakte) ?? [1]));
  const a = v?.achtung;
  const punkte = a
    ? [
        { key: "antworten", label: "Antworten warten auf uns", n: a.antworten_offen, ton: "rot" },
        { key: "anrufen", label: "Kontakte anrufen", n: a.anrufen, ton: "amber" },
        { key: "nachfassen", label: "Nachfassen fällig", n: a.nachfassen, ton: "amber" },
        { key: "unzustellbar", label: "Adressen unzustellbar", n: a.unzustellbar, ton: "blau" },
        {
          key: "geplant",
          label: a.geplant_ab
            ? `Mails geplant ab ${new Date(a.geplant_ab).toLocaleDateString("de-CH", { timeZone: ZRH, weekday: "short", day: "numeric", month: "numeric" })}`
            : "Mails geplant",
          n: a.geplant,
          ton: "blau",
        },
      ].filter((x) => x.n > 0)
    : [];
  return (
    <div className={`b-mitte b-ansicht${aktiv ? " an" : " aus"}`} aria-hidden={!aktiv}>
      <div className="b-links v-links">
        {/* Pipeline */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Vertrieb · vom Erstkontakt zum Auftrag</span>
            <b>{v ? `${v.kampagnen.reduce((n, k) => n + k.kontakte, 0)} Kontakte in ${v.kampagnen.length} Kampagnen` : ""}</b>
          </div>
          <div className="v-pipeline">
            {!v
              ? [0, 1, 2, 3, 4].map((x) => <div key={x} className="b-skel v-stufe-skel" />)
              : stufen.map((s, x) => (
                  <div key={s.label} className={`v-stufe${s.n > 0 ? " voll" : ""}${s.ziel ? " ziel" : ""}`}>
                    <span className="v-n">{s.n}</span>
                    <span className="v-l">{s.label}</span>
                    <span className="v-s">{s.sub}</span>
                    {x < stufen.length - 1 && <span className="v-pfeil" aria-hidden>›</span>}
                  </div>
                ))}
          </div>
        </section>

        {/* Kampagnen */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Kampagnen</span>
            <span className="v-legende">
              <i className="l-gespraech" />im Gespräch <i className="l-kein" />kein Bedarf <i className="l-raus" />angeschrieben <i className="l-geplant" />geplant
            </span>
          </div>
          <div className="v-kampagnen">
            {!v ? (
              [0, 1, 2].map((x) => <div key={x} className="b-skel" />)
            ) : v.kampagnen.length === 0 ? (
              <div className="b-leer">Keine laufenden Kampagnen.</div>
            ) : (
              v.kampagnen.map((k) => {
                const rest = Math.max(0, k.angeschrieben - k.im_gespraech - k.kein_bedarf - k.unzustellbar);
                const breite = (n: number) => `${(n / maxKamp) * 100}%`;
                return (
                  <div key={k.id} className="v-kampagne">
                    <div className="v-k-kopf">
                      <span className="v-k-name">{k.name}</span>
                      <span className="v-k-zahlen">
                        <b>{k.angeschrieben}</b> angeschrieben
                        {k.geplant > 0 && <> · <b>{k.geplant}</b> geplant</>}
                        {" · "}<b>{k.antworten}</b> {k.antworten === 1 ? "Antwort" : "Antworten"}
                        {k.angeschrieben > 0 && <span className="v-k-quote">{prozent(k.antworten, k.angeschrieben)}</span>}
                      </span>
                    </div>
                    <div className="v-balken">
                      {k.im_gespraech > 0 && <span className="s-gespraech" style={{ width: breite(k.im_gespraech) }} />}
                      {k.kein_bedarf > 0 && <span className="s-kein" style={{ width: breite(k.kein_bedarf) }} />}
                      {k.unzustellbar > 0 && <span className="s-unz" style={{ width: breite(k.unzustellbar) }} />}
                      {rest > 0 && <span className="s-raus" style={{ width: breite(rest) }} />}
                      {k.geplant > 0 && <span className="s-geplant" style={{ width: breite(k.geplant) }} />}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Mails pro Woche */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Mails pro Woche · ↩ = Antworten</span>
            <b>{v ? `${v.wochen.reduce((n, w) => n + w.gesendet, 0)} raus · ${v.wochen.reduce((n, w) => n + w.antworten, 0)} Antworten` : ""}</b>
          </div>
          <div className="b-wochen">
            {(v?.wochen ?? []).map((w) => {
              const aktuell = heuteIso >= w.start && heuteIso <= w.ende;
              const zukunft = w.start > heuteIso;
              const wert = zukunft ? w.geplant : w.gesendet;
              return (
                <div key={w.start} className={`b-woche${aktuell ? " aktuell" : ""}${zukunft ? " geplant" : ""}`}>
                  <div className={`b-v${wert === 0 ? " null" : ""}`}>
                    {wert > 0 ? wert : "·"}
                    {w.antworten > 0 && <small className="v-antw">· {w.antworten} ↩</small>}
                    {!zukunft && w.geplant > 0 && <small>+{w.geplant}</small>}
                  </div>
                  <div className="b-bararea">
                    <div className="b-bar" style={{ height: `${Math.round((wert / maxWoche) * 100)}%` }} />
                  </div>
                  <div className="b-d"><b>KW {w.kw}</b>{tagMonat(w.start)} – {tagMonat(w.ende)}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      <div className="b-spalte v-spalte">
        {/* Juengste Antworten */}
        <section className="b-panel">
          <div className="b-titel">
            <span>Neueste Antworten</span>
            <b>{v ? `${v.pipeline.antworten} total` : ""}</b>
          </div>
          <div className="v-antworten">
            {!v ? (
              [0, 1, 2, 3].map((x) => <div key={x} className="b-skel" />)
            ) : v.antworten.length === 0 ? (
              <div className="b-leer">Noch keine Antworten.</div>
            ) : (
              v.antworten.map((r) => {
                const chip = STATUS_CHIP[r.status];
                return (
                  <div key={r.id} className="v-antwort">
                    <span className="b-e-zeit">{wann(r.zeit, heuteIso)}</span>
                    <span className="v-a-text">
                      <span className="v-a-firma">{r.firma}</span>
                      <span className="v-a-kamp">{r.kampagne}</span>
                    </span>
                    {chip && <span className={`b-chip ${chip.ton}`}>{chip.label}</span>}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Aufmerksamkeit */}
        <section className="b-panel">
          <div className="b-titel"><span>Vertrieb · braucht Aufmerksamkeit</span></div>
          <div className="b-achtung">
            {!v ? (
              [0, 1].map((x) => <div key={x} className="b-skel" />)
            ) : punkte.length === 0 ? (
              <div className="b-ok"><Check strokeWidth={3} /> Alles beantwortet</div>
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
