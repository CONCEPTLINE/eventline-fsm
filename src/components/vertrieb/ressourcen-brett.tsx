"use client";

/**
 * Ressourcen › Planungsbrett (Leos Skizze, 26.11.2026; Ausbau gleichentags):
 * je Haus eine Karte — oben das Haus mit den Eckdaten, darunter die
 * Abschnitte «Geschäftsleitung», «Betriebsleitung» und «Personal». Die Karten
 * brechen in Zeilen um, damit auch 50 Häuser lesbar bleiben; «Gesamtes
 * Personal» klebt am unteren Rand, damit Ziehen aus jeder Zeile geht.
 *
 * Drei Arten von Einträgen (Farbe nur mit Bedeutung):
 *   neutral = echte Person (Konto im FSM)
 *   gelb    = fiktive Person (geplant, gibt es noch nicht)
 *   rot     = offene Stelle (niemand vorgesehen)
 *
 * Zuteilen: Namen aus «Gesamtes Personal» in einen Abschnitt ziehen, oder im
 * Abschnitt auf «+» klicken (dort auch «Offene Stelle»). Verschieben zwischen
 * Abschnitten und Häusern durch Ziehen. Entfernen: × am Eintrag oder zurück
 * in «Gesamtes Personal» ziehen. Eine Person kann in mehreren Häusern stehen.
 * Gespeichert wird sofort über die Handler der Ansicht (locations:edit).
 *
 * `erweitert` = Migration 392 eingespielt. Ohne sie gibt es nur «Personal»
 * mit echten Personen.
 */

import { useState } from "react";
import { Check, Loader2, Plus, Trash2, X } from "lucide-react";
import { HinzufuegenSelect } from "@/components/standort/zuteilung-chips";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { FUNKTIONEN, FUNKTION_LABEL, type Funktion } from "@/lib/ressourcen/funktionen";

export type Belegt = { art: "person" | "fiktiv" | "offen"; id: string; funktion: Funktion };
export type BrettHaus = { id: string; name: string; ort: string; capacity: number | null; vorgemerkt: boolean };
export type BrettPerson = { id: string; name: string };
export type BrettFahrt = { minuten: number; km: number };

const ZAHL = new Intl.NumberFormat("de-CH");
const ROT = "var(--status-red)";
const GELB = "var(--status-amber)";
const RAND = "color-mix(in srgb, currentColor 14%, transparent)";
const ZIEH_TYP = "application/x-ressourcen-person";

function dauer(minuten: number): string {
  if (minuten < 60) return `${minuten} Min.`;
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

/** Stand eines Hauses: rot = Lücke, gelb = fiktiv besetzt, beides null = besetzt. */
export function stand(belegt: readonly Belegt[]): { rot: string | null; gelb: string | null } {
  const offen = belegt.filter((b) => b.art === "offen").length;
  const fiktiv = belegt.filter((b) => b.art === "fiktiv").length;
  const besetzt = belegt.length - offen;
  const rot = offen > 0
    ? `${offen} offene ${offen === 1 ? "Stelle" : "Stellen"}`
    : besetzt === 0 ? "Niemand eingeteilt" : besetzt < 2 ? "Keine Stellvertretung" : null;
  return { rot, gelb: fiktiv > 0 ? `${fiktiv} fiktiv` : null };
}

type Zug = { art: "person" | "fiktiv"; id: string; von: string | null };

function Eintrag({
  label,
  ton,
  onEntfernen,
  entfernenText,
  disabled,
}: {
  label: string;
  ton: "neutral" | "gelb" | "rot";
  onEntfernen?: () => void;
  entfernenText: string;
  disabled: boolean;
}) {
  const [hover, setHover] = useState(false);
  const farbe = ton === "gelb" ? GELB : ton === "rot" ? ROT : null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full ${onEntfernen ? "pl-2 pr-0.5" : "px-2"} py-0.5 text-[12px] font-medium`}
      style={{
        border: `1px solid ${farbe ?? RAND}`,
        background: ton === "gelb" ? "rgba(245, 158, 11, 0.20)" : ton === "rot" ? "rgba(220, 38, 38, 0.13)" : "color-mix(in srgb, currentColor 5%, transparent)",
        color: ton === "rot" ? ROT : undefined,
      }}
    >
      {label}
      {onEntfernen && (
        <button
          type="button"
          onClick={onEntfernen}
          disabled={disabled}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-label={entfernenText}
          data-tooltip={entfernenText}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-50"
          style={{ backgroundColor: hover && !disabled ? "color-mix(in srgb, currentColor 16%, transparent)" : "transparent" }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

export function RessourcenBrett({
  haeuser,
  alleHaeuser,
  personen,
  fiktive,
  belegung,
  anlaesse,
  fahrten,
  darfBearbeiten,
  darfAnlegen,
  legtAn,
  erweitert,
  onPerson,
  onFiktiv,
  onOffenNeu,
  onOffenWeg,
  onFiktivNeu,
  onFiktivLoeschen,
  onAnlegen,
}: {
  /** Gezeigte Häuser (nach Suche/Filter). */
  haeuser: BrettHaus[];
  /** Alle Häuser — für die Zählung im Personal, unabhängig vom Filter. */
  alleHaeuser: BrettHaus[];
  personen: BrettPerson[];
  fiktive: BrettPerson[];
  /** haus-id → Einträge. */
  belegung: Map<string, Belegt[]>;
  /** location_id → offene Aufträge der nächsten 30 Tage; null = lädt. */
  anlaesse: Map<string, number> | null;
  fahrten: Map<string, BrettFahrt>;
  darfBearbeiten: boolean;
  darfAnlegen: boolean;
  legtAn: boolean;
  erweitert: boolean;
  /** Alle Handler: true = gespeichert. funktion null = aus dem Haus nehmen. */
  onPerson: (locationId: string, profileId: string, funktion: Funktion | null) => Promise<boolean>;
  onFiktiv: (locationId: string, fiktivId: string, funktion: Funktion | null) => Promise<boolean>;
  onOffenNeu: (locationId: string, funktion: Funktion) => Promise<boolean>;
  onOffenWeg: (locationId: string, stelleId: string) => Promise<boolean>;
  onFiktivNeu: (name: string) => Promise<boolean>;
  onFiktivLoeschen: (id: string) => Promise<boolean>;
  onAnlegen: (hausId: string) => void;
}) {
  const [zug, setZug] = useState<Zug | null>(null);
  /** Abschnitt, über dem gerade gezogen wird: "<haus>:<funktion>" oder "pool". */
  const [ueber, setUeber] = useState<string | null>(null);
  const [speichert, setSpeichert] = useState<string | null>(null);
  /** Abschnitt, dessen Auswahl («+») offen ist. */
  const [offen, setOffen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [neuerName, setNeuerName] = useState("");
  const [alsListe, setAlsListe] = useState<boolean>(() => {
    try { return typeof window !== "undefined" && localStorage.getItem("ressourcen-personal-liste") === "1"; } catch { return false; }
  });

  const nameVon = new Map([...personen, ...fiktive].map((p) => [p.id, p.name]));
  const funktionen: readonly Funktion[] = erweitert ? FUNKTIONEN : ["personal"];

  async function mit(feld: string, tun: () => Promise<unknown>) {
    if (speichert) return;
    setSpeichert(feld);
    try { await tun(); } finally { setSpeichert(null); }
  }
  const setze = (art: "person" | "fiktiv", locationId: string, id: string, funktion: Funktion | null) =>
    art === "person" ? onPerson(locationId, id, funktion) : onFiktiv(locationId, id, funktion);

  async function fallenLassen(e: React.DragEvent, haus: BrettHaus, funktion: Funktion) {
    e.preventDefault();
    setUeber(null);
    const z = zug;
    setZug(null);
    if (!z || !darfBearbeiten || haus.vorgemerkt) return;
    const schonDort = (belegung.get(haus.id) ?? []).find((x) => x.art === z.art && x.id === z.id);
    if (schonDort?.funktion === funktion && z.von === haus.id) return;
    await mit(`${haus.id}:${funktion}`, async () => {
      const ok = await setze(z.art, haus.id, z.id, funktion);
      // Aus einem anderen Haus herübergezogen = verschieben.
      if (ok && z.von && z.von !== haus.id) await setze(z.art, z.von, z.id, null);
    });
  }

  async function inPool(e: React.DragEvent) {
    e.preventDefault();
    setUeber(null);
    const z = zug;
    setZug(null);
    if (!z?.von || !darfBearbeiten) return;
    const von = z.von;
    await mit("pool", () => setze(z.art, von, z.id, null));
  }

  function ziehbar(art: "person" | "fiktiv", id: string, von: string | null) {
    if (!darfBearbeiten) return {};
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(ZIEH_TYP, id);
        e.dataTransfer.setData("text/plain", nameVon.get(id) ?? "");
        e.dataTransfer.effectAllowed = "move";
        setZug({ art, id, von });
      },
      onDragEnd: () => { setZug(null); setUeber(null); },
    };
  }

  // Bewusst eine Funktion, keine Komponente: so bleibt der Zustand der
  // Auswahlfelder über Neuzeichnungen erhalten.
  function abschnitt(haus: BrettHaus, funktion: Funktion) {
    const feld = `${haus.id}:${funktion}`;
    const titel = FUNKTION_LABEL[funktion];
    const alle = belegung.get(haus.id) ?? [];
    const reihenfolge = { person: 0, fiktiv: 1, offen: 2 } as const;
    const hier = alle
      .filter((x) => x.funktion === funktion)
      .sort((a, b) => reihenfolge[a.art] - reihenfolge[b.art] || (nameVon.get(a.id) ?? "").localeCompare(nameVon.get(b.id) ?? "", "de-CH"));
    const imHaus = (art: "person" | "fiktiv", id: string) => alle.some((x) => x.art === art && x.id === id && x.funktion === funktion);
    const auswahl = [
      ...(erweitert ? [{ id: "offen", label: "Offene Stelle", sub: "niemand vorgesehen" }] : []),
      ...personen.filter((p) => !imHaus("person", p.id)).map((p) => ({ id: `p:${p.id}`, label: p.name })),
      ...fiktive.filter((p) => !imHaus("fiktiv", p.id)).map((p) => ({ id: `f:${p.id}`, label: p.name, sub: "fiktiv" })),
    ];
    const annehmbar = !!zug && darfBearbeiten;
    const ziel = ueber === feld && annehmbar;
    const auswahlOffen = offen === feld;
    return (
      <div
        key={feld}
        className="flex flex-col gap-1 px-3 py-2"
        onDragOver={(e) => { if (annehmbar) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (ueber !== feld) setUeber(feld); } }}
        onDragLeave={() => { if (ueber === feld) setUeber(null); }}
        onDrop={(e) => void fallenLassen(e, haus, funktion)}
        style={{
          borderTop: `1px solid ${RAND}`,
          minHeight: funktion === "personal" ? "4.25rem" : "3.25rem",
          background: ziel ? "rgba(220, 38, 38, 0.10)" : annehmbar ? "color-mix(in srgb, currentColor 4%, transparent)" : undefined,
          boxShadow: ziel ? `inset 0 0 0 2px ${ROT}` : undefined,
          transition: "background-color 120ms",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">
            {titel}
            {hier.length > 0 && <span className="ml-1 font-normal">{hier.length}</span>}
          </span>
          {speichert === feld ? (
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Speichert…" />
          ) : darfBearbeiten ? (
            <button
              type="button"
              aria-label={auswahlOffen ? "Auswahl schliessen" : `Zu ${titel} ${haus.name} hinzufügen`}
              data-tooltip={auswahlOffen ? "Schliessen" : "Hinzufügen"}
              disabled={speichert !== null}
              onClick={() => setOffen(auswahlOffen ? null : feld)}
              onMouseEnter={() => setHover(`plus:${feld}`)}
              onMouseLeave={() => setHover(null)}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full"
              style={{
                border: `1px solid ${RAND}`,
                background: hover === `plus:${feld}` || auswahlOffen ? "color-mix(in srgb, currentColor 10%, transparent)" : undefined,
              }}
            >
              {auswahlOffen ? <X className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            </button>
          ) : null}
        </div>

        {hier.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {hier.map((x) => {
              if (x.art === "offen") {
                return (
                  <Eintrag
                    key={`o:${x.id}`}
                    label="Offene Stelle"
                    ton="rot"
                    disabled={speichert !== null}
                    entfernenText="Offene Stelle entfernen"
                    onEntfernen={darfBearbeiten ? () => void mit(feld, () => onOffenWeg(haus.id, x.id)) : undefined}
                  />
                );
              }
              const name = nameVon.get(x.id) ?? "Unbekannt";
              const art = x.art;
              return (
                <span key={`${art}:${x.id}`} {...ziehbar(art, x.id, haus.id)} style={darfBearbeiten ? { cursor: "grab" } : undefined}>
                  <Eintrag
                    label={name}
                    ton={art === "fiktiv" ? "gelb" : "neutral"}
                    disabled={speichert !== null}
                    entfernenText={`${name} bei ${haus.name} entfernen`}
                    onEntfernen={darfBearbeiten ? () => void mit(feld, () => setze(art, haus.id, x.id, null)) : undefined}
                  />
                </span>
              );
            })}
          </div>
        )}
        {auswahlOffen && darfBearbeiten && (
          <div style={speichert ? { pointerEvents: "none", opacity: 0.6 } : undefined}>
            <HinzufuegenSelect
              items={auswahl}
              placeholder="Wählen …"
              onWahl={(wahl) => {
                setOffen(null);
                if (wahl === "offen") void mit(feld, () => onOffenNeu(haus.id, funktion));
                else void mit(feld, () => setze(wahl.startsWith("f:") ? "fiktiv" : "person", haus.id, wahl.slice(2), funktion));
              }}
            />
          </div>
        )}
      </div>
    );
  }

  // ─── Personal unten: wer steht wie oft wo ───────────────────────────
  const hausName = new Map(alleHaeuser.map((h) => [h.id, h.name]));
  function einsaetze(art: "person" | "fiktiv", id: string): { haus: string; funktion: Funktion }[] {
    const out: { haus: string; funktion: Funktion }[] = [];
    for (const [hausId, liste] of belegung) {
      const name = hausName.get(hausId);
      if (!name) continue;
      for (const x of liste) if (x.art === art && x.id === id) out.push({ haus: name, funktion: x.funktion });
    }
    return out.sort((a, b) => a.haus.localeCompare(b.haus, "de-CH"));
  }
  const woText = (e: { haus: string; funktion: Funktion }[]) =>
    e.length === 0 ? "Noch keinem Haus zugeteilt" : e.map((x) => `${x.haus} (${FUNKTION_LABEL[x.funktion]})`).join(" · ");

  function poolChip(art: "person" | "fiktiv", p: BrettPerson) {
    const e = einsaetze(art, p.id);
    const key = `pool:${art}:${p.id}`;
    return (
      <span
        key={key}
        {...ziehbar(art, p.id, null)}
        onMouseEnter={() => setHover(key)}
        onMouseLeave={() => setHover(null)}
        data-tooltip={woText(e)}
        className="inline-flex items-center gap-1.5 rounded-full py-1 pl-3 text-sm"
        style={{
          paddingRight: art === "fiktiv" && darfBearbeiten ? "0.25rem" : "0.75rem",
          cursor: darfBearbeiten ? "grab" : undefined,
          background: art === "fiktiv" ? "rgba(245, 158, 11, 0.20)" : "var(--card)",
          border: `1px solid ${art === "fiktiv" ? GELB : hover === key && darfBearbeiten ? "color-mix(in srgb, currentColor 45%, transparent)" : RAND}`,
          fontWeight: e.length === 0 ? 600 : 400,
        }}
      >
        {p.name}
        <span className="text-xs" style={{ opacity: 0.7 }}>{e.length}×</span>
        {art === "fiktiv" && darfBearbeiten && (
          <button
            type="button"
            aria-label={`${p.name} löschen`}
            data-tooltip="Fiktive Person löschen"
            disabled={speichert !== null}
            onClick={() => void mit("pool", () => onFiktivLoeschen(p.id))}
            className="inline-flex h-5 w-5 items-center justify-center rounded-full disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </span>
    );
  }

  async function fiktivAnlegen() {
    const name = neuerName.trim();
    if (!name) return;
    await mit("pool", async () => { if (await onFiktivNeu(name)) setNeuerName(""); });
  }

  function listeUmschalten() {
    const neu = !alsListe;
    setAlsListe(neu);
    try { localStorage.setItem("ressourcen-personal-liste", neu ? "1" : "0"); } catch { /* privat-Modus */ }
  }

  const poolZiel = ueber === "pool" && !!zug?.von && darfBearbeiten;
  const nachAnzahl = (art: "person" | "fiktiv") => (a: BrettPerson, b: BrettPerson) =>
    einsaetze(art, a.id).length - einsaetze(art, b.id).length || a.name.localeCompare(b.name, "de-CH");
  const personenSortiert = [...personen].sort(nachAnzahl("person"));
  const fiktiveSortiert = [...fiktive].sort(nachAnzahl("fiktiv"));

  return (
    <div className="flex flex-col gap-4">
      {/* Häuser */}
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))" }}>
        {haeuser.map((h) => {
          const s = h.vorgemerkt ? { rot: null, gelb: null } : stand(belegung.get(h.id) ?? []);
          const f = fahrten.get(h.id);
          const tage = h.vorgemerkt ? null : anlaesse === null ? "…" : String(anlaesse.get(h.id) ?? 0);
          const kopf = (
            <>
              <span className="text-[0.9375rem] font-semibold leading-tight">{h.name}</span>
              <span className="text-xs text-muted-foreground">
                {[h.ort, f ? `${dauer(f.minuten)} ab Büro` : null].filter(Boolean).join(" · ") || "Ort nicht erfasst"}
              </span>
              <span className="mt-1 flex gap-3 text-xs text-muted-foreground">
                {tage !== null && <span><span className="text-sm font-semibold text-foreground">{tage}</span> Anlässe</span>}
                {h.capacity ? <span><span className="text-sm font-semibold text-foreground">{ZAHL.format(h.capacity)}</span> Plätze</span> : null}
              </span>
            </>
          );
          return (
            <div
              key={h.id}
              className="flex flex-col overflow-hidden rounded-xl bg-card"
              style={{ border: `2px ${h.vorgemerkt ? "dashed" : "solid"} ${RAND}` }}
            >
              {h.vorgemerkt ? (
                <div className="flex flex-col gap-0.5 px-3 py-2.5">{kopf}</div>
              ) : (
                <PrefetchLink
                  href={`/standorte/${h.id}`}
                  data-tooltip="Location öffnen"
                  className="row-hover flex flex-col gap-0.5 px-3 py-2.5 [--row-hover-radius:0] [--row-hover-x:0rem]"
                >
                  {kopf}
                </PrefetchLink>
              )}

              {/* Stand */}
              <div
                className="flex items-center justify-between gap-2 px-3 py-1 text-xs font-semibold"
                style={{ borderTop: `1px solid ${RAND}`, background: s.rot ? "rgba(220, 38, 38, 0.08)" : s.gelb ? "rgba(245, 158, 11, 0.12)" : undefined }}
              >
                {h.vorgemerkt ? (
                  <span className="font-normal text-muted-foreground">Noch nicht angelegt</span>
                ) : s.rot ? (
                  <span style={{ color: ROT }}>{s.rot}</span>
                ) : s.gelb ? (
                  <span>Besetzt, davon fiktiv</span>
                ) : (
                  <span className="inline-flex items-center gap-1 font-normal text-muted-foreground"><Check className="h-3.5 w-3.5" />Besetzt</span>
                )}
                {s.gelb && <span className="font-normal">{s.gelb}</span>}
              </div>

              {h.vorgemerkt ? (
                <div className="flex flex-1 flex-col items-start gap-2 px-3 py-2.5" style={{ borderTop: `1px solid ${RAND}` }}>
                  <p className="text-xs text-muted-foreground">Zuteilen geht, sobald das Haus als Location angelegt ist.</p>
                  {darfAnlegen && (
                    <button type="button" className="kasten kasten-red" disabled={legtAn} onClick={() => onAnlegen(h.id)}>
                      {legtAn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                      Anlegen
                    </button>
                  )}
                </div>
              ) : (
                funktionen.map((fn) => abschnitt(h, fn))
              )}
            </div>
          );
        })}
      </div>

      {/* Gesamtes Personal — klebt unten, damit Ziehen aus jeder Zeile geht */}
      <section
        className="sticky bottom-0 z-10 flex max-h-[42vh] flex-col gap-2 overflow-y-auto rounded-xl bg-card p-3"
        onDragOver={(e) => { if (zug?.von && darfBearbeiten) { e.preventDefault(); if (ueber !== "pool") setUeber("pool"); } }}
        onDragLeave={() => { if (ueber === "pool") setUeber(null); }}
        onDrop={(e) => void inPool(e)}
        style={{
          border: `2px ${zug?.von && darfBearbeiten ? "dashed" : "solid"} ${poolZiel ? ROT : RAND}`,
          boxShadow: "0 -6px 16px -8px rgba(0, 0, 0, 0.25)",
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">
            Gesamtes Personal <span className="font-normal text-muted-foreground">{personen.length}{fiktive.length > 0 ? ` + ${fiktive.length} fiktiv` : ""}</span>
            {speichert === "pool" && <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin" aria-label="Speichert…" />}
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-xs text-muted-foreground">
              {!darfBearbeiten
                ? "Einteilen kann, wer Locations bearbeiten darf."
                : zug?.von
                  ? "Hier loslassen, um den Eintrag aus dem Haus zu nehmen."
                  : "Namen in einen Abschnitt ziehen. Die Zahl zeigt, in wie vielen Häusern jemand steht."}
            </p>
            <button type="button" className={`kasten ${alsListe ? "kasten-active" : "kasten-toggle-off"}`} onClick={listeUmschalten} aria-pressed={alsListe}>
              Wer ist wo
            </button>
          </div>
        </div>

        {alsListe ? (
          <table className="w-full text-sm">
            <tbody>
              {/* Liste: wer am meisten eingeteilt ist, steht oben. */}
              {[...[...personenSortiert].reverse().map((p) => ({ p, art: "person" as const })), ...[...fiktiveSortiert].reverse().map((p) => ({ p, art: "fiktiv" as const }))].map(({ p, art }) => {
                const e = einsaetze(art, p.id);
                return (
                  <tr key={`${art}:${p.id}`} style={{ borderTop: `1px solid ${RAND}` }}>
                    <td className="whitespace-nowrap py-1 pr-3 align-top">
                      <span className="rounded px-1" style={art === "fiktiv" ? { background: "rgba(245, 158, 11, 0.25)" } : undefined}>{p.name}</span>
                    </td>
                    <td className="w-10 py-1 pr-3 text-right align-top font-semibold">{e.length}×</td>
                    <td className="py-1 align-top text-muted-foreground">{woText(e)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <>
            {personen.length === 0 ? (
              <p className="text-sm text-muted-foreground">Keine aktiven Mitarbeitenden gefunden.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">{personenSortiert.map((p) => poolChip("person", p))}</div>
            )}
            {erweitert && (
              <div className="flex flex-wrap items-center gap-1.5 pt-1" style={{ borderTop: `1px solid ${RAND}` }}>
                <span className="mr-1 text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">Fiktiv</span>
                {fiktiveSortiert.map((p) => poolChip("fiktiv", p))}
                {darfBearbeiten && (
                  <span className="inline-flex items-center gap-1">
                    <input
                      value={neuerName}
                      onChange={(e) => setNeuerName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void fiktivAnlegen(); } }}
                      placeholder="Fiktive Person, z. B. Techniker 1"
                      maxLength={80}
                      aria-label="Name der fiktiven Person"
                      className="h-7 w-56 rounded-full bg-transparent px-3 text-sm outline-none"
                      style={{ border: `1px dashed ${GELB}` }}
                    />
                    <button type="button" className="kasten kasten-amber" disabled={!neuerName.trim() || speichert !== null} onClick={() => void fiktivAnlegen()}>
                      <Plus className="h-4 w-4" />Hinzufügen
                    </button>
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
