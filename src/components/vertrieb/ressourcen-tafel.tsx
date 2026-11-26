"use client";

/**
 * Ressourcen › Planungstafel: eine Spalte je Haus, oben die Kennwerte
 * (Anlässe der nächsten 30 Tage, Fahrt ab Büro, Plätze, Besetzung), darunter
 * eine Zeile je Mitarbeiter:in mit einem Feld je Haus. Ein Klick auf ein Feld
 * teilt die Person dort ein oder nimmt sie weg (locations:edit, wie in der
 * Location); gespeichert wird sofort über PUT /api/standorte/[id]/mitarbeiter.
 *
 * Besetzung: 0 = «niemand», 1 = «keine Stellvertretung» (beides rot, weil
 * ein Haus eine Betriebsleitung und eine Stellvertretung braucht), ab 2 =
 * «besetzt». Rot nur für Lücken (Farbe nur mit Bedeutung).
 * Rechts je Person die Belastung: Anzahl Häuser und die Summe der Anlässe
 * dieser Häuser in den nächsten 30 Tagen (wer in vielen vollen Häusern
 * steht, ist stärker gebunden).
 * Vorgemerkte Häuser (noch keine Location) haben keine Felder.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
import { TOAST } from "@/lib/messages";

export type TafelHaus = { id: string; name: string; capacity: number | null; vorgemerkt: boolean };
export type TafelPerson = { id: string; name: string };
export type TafelFahrt = { minuten: number; km: number };

const ZAHL = new Intl.NumberFormat("de-CH");
const ROT = "#dc2626";

function dauer(minuten: number): string {
  if (minuten < 60) return `${minuten} Min.`;
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

export function besetzung(anzahl: number): { text: string; luecke: boolean } {
  if (anzahl === 0) return { text: "niemand", luecke: true };
  if (anzahl === 1) return { text: "keine Stellvertretung", luecke: true };
  return { text: "besetzt", luecke: false };
}

export function RessourcenTafel({
  haeuser,
  personen,
  einteilung,
  anlaesse,
  fahrten,
  darfBearbeiten,
  ortId,
  onOrt,
  onGeaendert,
}: {
  haeuser: TafelHaus[];
  personen: TafelPerson[];
  /** location_id → profile_ids. */
  einteilung: Map<string, string[]>;
  /** location_id → Anzahl offener Aufträge der nächsten 30 Tage; null = lädt. */
  anlaesse: Map<string, number> | null;
  /** haus-id → Fahrt ab Büro (fehlt, solange nicht berechnet). */
  fahrten: Map<string, TafelFahrt>;
  darfBearbeiten: boolean;
  ortId: string | null;
  onOrt: (id: string | null) => void;
  onGeaendert: (locationId: string, profileIds: string[]) => void;
}) {
  /** "<haus>:<person>" des Feldes, das gerade speichert. */
  const [speichert, setSpeichert] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  async function umschalten(haus: TafelHaus, person: TafelPerson) {
    const bisher = einteilung.get(haus.id) ?? [];
    const drin = bisher.includes(person.id);
    const neu = drin ? bisher.filter((x) => x !== person.id) : [...bisher, person.id];
    setSpeichert(`${haus.id}:${person.id}`);
    try {
      const res = await fetch(`/api/standorte/${haus.id}/mitarbeiter`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileIds: neu }),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string; profileIds?: string[] } | null;
      if (!res.ok || json?.success === false) { TOAST.errorOr(json?.error, "Speichern fehlgeschlagen"); return; }
      onGeaendert(haus.id, Array.isArray(json?.profileIds) ? json.profileIds : neu);
      toast.success(drin ? `${person.name} bei ${haus.name} entfernt` : `${person.name} bei ${haus.name} eingeteilt`);
    } catch {
      toast.error("Speichern fehlgeschlagen");
    } finally {
      setSpeichert(null);
    }
  }

  const kopf = "px-2 py-1.5 text-center align-bottom";
  const zelle = "px-2 py-1.5 text-center";
  const links = "sticky left-0 z-[1] bg-card px-2 py-1.5 text-left";

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full min-w-[44rem] border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className={`${links} text-xs font-medium uppercase tracking-wide text-muted-foreground`}>Planung je Haus</th>
            {haeuser.map((h) => {
              const aktiv = h.id === ortId;
              return (
                <th key={h.id} className={kopf} style={{ minWidth: "7.5rem" }}>
                  <button
                    type="button"
                    onClick={() => onOrt(aktiv ? null : h.id)}
                    aria-pressed={aktiv}
                    data-tooltip="Auf der Karte öffnen"
                    className="w-full rounded-md px-1 py-1 text-sm font-semibold leading-tight"
                    onMouseEnter={() => setHover(`kopf:${h.id}`)}
                    onMouseLeave={() => setHover(null)}
                    style={{
                      borderBottom: `2px solid ${aktiv ? ROT : "transparent"}`,
                      background: hover === `kopf:${h.id}` ? "color-mix(in srgb, currentColor 8%, transparent)" : undefined,
                    }}
                  >
                    {h.name}
                  </button>
                </th>
              );
            })}
            <th className={`${kopf} text-xs font-medium uppercase tracking-wide text-muted-foreground`}>Häuser</th>
            <th className={`${kopf} text-xs font-medium uppercase tracking-wide text-muted-foreground`} data-tooltip="Anlässe der nächsten 30 Tage in den Häusern dieser Person">Anlässe</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b">
            <td className={`${links} text-muted-foreground`}>Anlässe, nächste 30 Tage</td>
            {haeuser.map((h) => (
              <td key={h.id} className={zelle}>
                {h.vorgemerkt ? <span className="text-muted-foreground">–</span> : anlaesse === null ? <span className="text-muted-foreground">…</span> : <span className="font-semibold">{anlaesse.get(h.id) ?? 0}</span>}
              </td>
            ))}
            <td className={zelle} />
            <td className={`${zelle} font-semibold`}>{anlaesse === null ? "…" : haeuser.reduce((a, h) => a + (anlaesse.get(h.id) ?? 0), 0)}</td>
          </tr>
          <tr className="border-b">
            <td className={`${links} text-muted-foreground`}>Fahrt ab Büro</td>
            {haeuser.map((h) => {
              const f = fahrten.get(h.id);
              return (
                <td key={h.id} className={zelle}>
                  {f ? <>{dauer(f.minuten)}<span className="block text-xs text-muted-foreground">{ZAHL.format(f.km)} km</span></> : <span className="text-muted-foreground">…</span>}
                </td>
              );
            })}
            <td className={zelle} colSpan={2} />
          </tr>
          <tr className="border-b">
            <td className={`${links} text-muted-foreground`}>Plätze</td>
            {haeuser.map((h) => (
              <td key={h.id} className={zelle}>{h.capacity ? ZAHL.format(h.capacity) : <span className="text-muted-foreground">–</span>}</td>
            ))}
            <td className={zelle} colSpan={2} />
          </tr>
          <tr className="border-b-2">
            <td className={`${links} font-medium`}>Besetzung</td>
            {haeuser.map((h) => {
              if (h.vorgemerkt) return <td key={h.id} className={`${zelle} text-xs text-muted-foreground`}>noch nicht angelegt</td>;
              const n = (einteilung.get(h.id) ?? []).length;
              const b = besetzung(n);
              return (
                <td key={h.id} className={zelle}>
                  <span className="font-semibold">{n}</span>
                  <span className="block text-xs" style={b.luecke ? { color: ROT, fontWeight: 600 } : undefined}>{b.text}</span>
                </td>
              );
            })}
            <td className={zelle} colSpan={2} />
          </tr>
          {personen.length === 0 ? (
            <tr><td className="px-2 py-4 text-muted-foreground" colSpan={haeuser.length + 3}>Keine aktiven Mitarbeitenden gefunden.</td></tr>
          ) : personen.map((p) => {
            const eigene = haeuser.filter((h) => (einteilung.get(h.id) ?? []).includes(p.id));
            const anzahl = eigene.length;
            const last = anlaesse ? eigene.reduce((a, h) => a + (anlaesse.get(h.id) ?? 0), 0) : null;
            return (
              <tr key={p.id} className="border-b last:border-b-0">
                <td className={`${links} whitespace-nowrap`}>{p.name}</td>
                {haeuser.map((h) => {
                  if (h.vorgemerkt) return <td key={h.id} className={zelle} />;
                  const drin = (einteilung.get(h.id) ?? []).includes(p.id);
                  const key = `${h.id}:${p.id}`;
                  const laeuft = speichert === key;
                  const feld = (
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md"
                      style={{
                        border: `2px solid ${drin ? "currentColor" : "color-mix(in srgb, currentColor 25%, transparent)"}`,
                        background: drin ? "currentColor" : hover === key ? "color-mix(in srgb, currentColor 12%, transparent)" : "transparent",
                      }}
                    >
                      {laeuft ? <Loader2 className="h-3.5 w-3.5 animate-spin" style={{ color: drin ? "var(--card)" : undefined }} /> : drin ? <Check className="h-4 w-4" style={{ color: "var(--card)" }} /> : null}
                    </span>
                  );
                  return (
                    <td key={h.id} className={zelle}>
                      {darfBearbeiten ? (
                        <button
                          type="button"
                          aria-pressed={drin}
                          aria-label={`${p.name} bei ${h.name} ${drin ? "entfernen" : "einteilen"}`}
                          data-tooltip={drin ? "Entfernen" : "Einteilen"}
                          disabled={speichert !== null}
                          onClick={() => void umschalten(h, p)}
                          onMouseEnter={() => setHover(key)}
                          onMouseLeave={() => setHover(null)}
                          className="inline-flex p-1"
                        >
                          {feld}
                        </button>
                      ) : (
                        drin ? feld : null
                      )}
                    </td>
                  );
                })}
                <td className={`${zelle} text-muted-foreground`}>{anzahl || "–"}</td>
                <td className={`${zelle} text-muted-foreground`}>{last === null ? "…" : anzahl ? last : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
