"use client";

// «Zuletzt passiert» des Buero-Bildschirms (Leo/Mischa 2026-10-11, ersetzt
// Heute und Team): die 3 juengsten Ereignisse aus Auftraegen, Partner-Portal,
// Einsatzplanung, Rapporten, Todos und Abrechnung — zeigt, dass etwas laeuft.
// Fest 3 Zeilen (keine Diashow, keine Messung): das Fenster hat damit eine
// feste Hoehe, die Todos darunter bekommen den restlichen Platz. Der Zaehler
// im Kopf ist exakt (7 Zurich-Tage); was davon nicht sichtbar ist, steht als
// «+n weitere in 7 Tagen» darunter. Kein Rot, keine Avatar-Farben.

import type { BildschirmDaten, BildschirmEreignis, BildschirmEreignisArt } from "@/lib/bildschirm-typen";
import { initialen } from "@/components/ui/person-avatar";
import { plusTage } from "@/lib/swiss-time";
import { kurzDatum, uhrzeit, vorname } from "./format";

const FEED_MAX = 3;

/** Label je Art; gruen = etwas wurde erledigt, sonst neutral. */
const ART: Record<BildschirmEreignisArt, { label: string; gruen: boolean }> = {
  auftrag_neu: { label: "Neuer Auftrag", gruen: false },
  partner_anfrage: { label: "Partner-Anfrage", gruen: false },
  einsatz_geplant: { label: "Einsatz geplant", gruen: false },
  rapport: { label: "Rapport erfasst", gruen: true },
  todo_erledigt: { label: "Todo erledigt", gruen: true },
  abgerechnet: { label: "Abgerechnet", gruen: true },
};

function Ereignis({ e, heuteIso }: { e: BildschirmEreignis; heuteIso: string }) {
  const { label, gruen } = ART[e.art];
  const zeitText = e.tag === heuteIso ? uhrzeit(e.zeit) : heuteIso && e.tag === plusTage(heuteIso, -1) ? "gestern" : kurzDatum(e.tag);
  return (
    <div className="b-ereignis">
      <span className="b-e-zeit">{zeitText}</span>
      <span className={`b-e-art${gruen ? " gruen" : ""}`}>{label}</span>
      <span className="b-e-titel">{e.titel}</span>
      <span className="b-e-rechts">
        {e.person ? (
          <span className="b-pers"><span className="b-av">{initialen(e.person)}</span><span>{vorname(e.person)}</span></span>
        ) : e.ort ? (
          <span className="b-e-info">{e.ort}</span>
        ) : e.einsatz_tag ? (
          <span className="b-e-info">für {kurzDatum(e.einsatz_tag)}</span>
        ) : null}
      </span>
    </div>
  );
}

export function ZuletztPanel({ zuletzt, heuteIso }: { zuletzt: BildschirmDaten["zuletzt"] | null; heuteIso: string }) {
  const sichtbar = zuletzt ? zuletzt.liste.slice(0, FEED_MAX) : [];
  // Beide Zeiten sind toISOString → der Stringvergleich ist exakt.
  const rest = zuletzt ? Math.max(0, zuletzt.anzahl_7_tage - sichtbar.filter((e) => e.zeit >= zuletzt.seit_7_tage).length) : 0;
  return (
    <section className="b-panel">
      <div className="b-titel">
        <span>Zuletzt passiert</span>
        <b>{zuletzt ? `${zuletzt.anzahl_7_tage} in 7 Tagen` : ""}</b>
      </div>
      <div className="b-feed">
        {!zuletzt ? (
          [0, 1, 2].map((i) => <div key={i} className="b-skel" />)
        ) : zuletzt.liste.length === 0 ? (
          <div className="b-leer">Seit 30 Tagen nichts Neues.</div>
        ) : (
          sichtbar.map((e) => <Ereignis key={e.id} e={e} heuteIso={heuteIso} />)
        )}
        {zuletzt && rest > 0 && <div className="b-mehr">+{rest} weitere in 7 Tagen</div>}
      </div>
    </section>
  );
}
