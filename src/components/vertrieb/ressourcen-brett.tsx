"use client";

/**
 * Ressourcen › Planungsbrett (Leos Skizze, 26.11.2026): je Haus eine Spalte —
 * oben das Haus mit den Eckdaten, darunter «Leitung», darunter «Personal».
 * Unten der Kasten «Gesamtes Personal» mit allen Mitarbeitenden.
 *
 * Zuteilen: einen Namen aus «Gesamtes Personal» in «Leitung» oder «Personal»
 * ziehen, oder im Abschnitt auf «+» klicken und auswählen. Verschieben
 * zwischen Abschnitten und Häusern geht ebenfalls durch Ziehen. Entfernen:
 * × am Namen oder zurück in «Gesamtes Personal» ziehen. Eine Person kann in
 * mehreren Häusern stehen. Gespeichert wird sofort
 * (POST /api/ressourcen/einteilung, locations:edit).
 *
 * Eine Spalte ist EINE Karte mit drei Abschnitten (ein Rand statt drei
 * Kästen), damit sechs Häuser nebeneinander ruhig bleiben. Rot nur für
 * Lücken (Farbe nur mit Bedeutung): «keine Leitung», sonst «keine
 * Stellvertretung» bei weniger als zwei Personen.
 * Vorgemerkte Häuser (noch keine Location) sind gestrichelt und nehmen kein
 * Personal auf, bis sie angelegt sind.
 */

import { useState } from "react";
import { Check, Loader2, Lock, Plus, X } from "lucide-react";
import { EntfernbarChip, HinzufuegenSelect } from "@/components/standort/zuteilung-chips";

export type Funktion = "leitung" | "personal";
export type Eintrag = { profileId: string; funktion: Funktion };
export type BrettHaus = { id: string; name: string; ort: string; capacity: number | null; vorgemerkt: boolean };
export type BrettPerson = { id: string; name: string };
export type BrettFahrt = { minuten: number; km: number };

const ZAHL = new Intl.NumberFormat("de-CH");
const ROT = "#dc2626";
const RAND = "color-mix(in srgb, currentColor 14%, transparent)";
const ZIEH_TYP = "application/x-ressourcen-person";

function dauer(minuten: number): string {
  if (minuten < 60) return `${minuten} Min.`;
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return m ? `${h} Std. ${m} Min.` : `${h} Std.`;
}

/** Lücke eines Hauses in Worten, oder null wenn besetzt. */
export function luecke(eintraege: readonly Eintrag[], funktionBekannt: boolean): string | null {
  if (eintraege.length === 0) return "niemand eingeteilt";
  if (funktionBekannt && !eintraege.some((e) => e.funktion === "leitung")) return "keine Leitung";
  if (eintraege.length < 2) return "keine Stellvertretung";
  return null;
}

type Zug = { profileId: string; von: string | null };

export function RessourcenBrett({
  haeuser,
  personen,
  einteilung,
  anlaesse,
  fahrten,
  darfBearbeiten,
  darfAnlegen,
  legtAn,
  funktionBekannt,
  ortId,
  onOrt,
  onSetze,
  onAnlegen,
}: {
  haeuser: BrettHaus[];
  personen: BrettPerson[];
  /** location_id → Einträge. */
  einteilung: Map<string, Eintrag[]>;
  /** location_id → offene Aufträge der nächsten 30 Tage; null = lädt. */
  anlaesse: Map<string, number> | null;
  fahrten: Map<string, BrettFahrt>;
  darfBearbeiten: boolean;
  darfAnlegen: boolean;
  legtAn: boolean;
  /** false = Spalte «funktion» fehlt noch (Migration 392): alles gilt als Personal. */
  funktionBekannt: boolean;
  ortId: string | null;
  onOrt: (id: string | null) => void;
  /** Speichert eine Einteilung; funktion null = entfernen. true = gespeichert. */
  onSetze: (locationId: string, profileId: string, funktion: Funktion | null) => Promise<boolean>;
  /** Legt ein vorgemerktes Haus als Location an. */
  onAnlegen: (hausId: string) => void;
}) {
  const [zug, setZug] = useState<Zug | null>(null);
  /** Abschnitt, über dem gerade gezogen wird: "<haus>:<funktion>" oder "pool". */
  const [ueber, setUeber] = useState<string | null>(null);
  const [speichert, setSpeichert] = useState<string | null>(null);
  /** Abschnitt, dessen Auswahl («+») offen ist. */
  const [offen, setOffen] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const nameVon = new Map(personen.map((p) => [p.id, p.name]));

  async function setze(locationId: string, profileId: string, funktion: Funktion | null, feld: string) {
    if (speichert) return;
    setSpeichert(feld);
    try {
      await onSetze(locationId, profileId, funktion);
    } finally {
      setSpeichert(null);
    }
  }

  async function fallenLassen(e: React.DragEvent, haus: BrettHaus, funktion: Funktion) {
    e.preventDefault();
    setUeber(null);
    const z = zug;
    setZug(null);
    if (!z || !darfBearbeiten || haus.vorgemerkt || speichert) return;
    const feld = `${haus.id}:${funktion}`;
    const schonDort = (einteilung.get(haus.id) ?? []).find((x) => x.profileId === z.profileId);
    if (schonDort?.funktion === funktion && z.von === haus.id) return;
    setSpeichert(feld);
    try {
      const ok = await onSetze(haus.id, z.profileId, funktion);
      // Aus einem anderen Haus herübergezogen = verschieben.
      if (ok && z.von && z.von !== haus.id) await onSetze(z.von, z.profileId, null);
    } finally {
      setSpeichert(null);
    }
  }

  async function inPool(e: React.DragEvent) {
    e.preventDefault();
    setUeber(null);
    const z = zug;
    setZug(null);
    if (!z?.von || !darfBearbeiten) return;
    await setze(z.von, z.profileId, null, "pool");
  }

  function ziehbar(profileId: string, von: string | null) {
    if (!darfBearbeiten) return {};
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData(ZIEH_TYP, profileId);
        e.dataTransfer.setData("text/plain", nameVon.get(profileId) ?? "");
        e.dataTransfer.effectAllowed = "move";
        setZug({ profileId, von });
      },
      onDragEnd: () => { setZug(null); setUeber(null); },
    };
  }

  // Bewusst eine Funktion, keine Komponente: so bleibt der Zustand der
  // Auswahlfelder über Neuzeichnungen erhalten.
  function abschnitt(haus: BrettHaus, funktion: Funktion, titel: string) {
    const feld = `${haus.id}:${funktion}`;
    const alle = einteilung.get(haus.id) ?? [];
    const hier = alle
      .filter((x) => x.funktion === funktion)
      .sort((a, b) => (nameVon.get(a.profileId) ?? "").localeCompare(nameVon.get(b.profileId) ?? "", "de-CH"));
    const kandidaten = personen.filter((p) => !alle.some((x) => x.profileId === p.id && x.funktion === funktion));
    const gesperrt = funktion === "leitung" && !funktionBekannt;
    const annehmbar = !!zug && darfBearbeiten && !gesperrt;
    const ziel = ueber === feld && annehmbar;
    const auswahlOffen = offen === feld;
    return (
      <div
        key={feld}
        className="flex min-h-[5.25rem] flex-col gap-1.5 px-3 py-2.5"
        onDragOver={(e) => { if (annehmbar) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (ueber !== feld) setUeber(feld); } }}
        onDragLeave={() => { if (ueber === feld) setUeber(null); }}
        onDrop={(e) => { if (!gesperrt) void fallenLassen(e, haus, funktion); }}
        style={{
          borderTop: `1px solid ${RAND}`,
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
          ) : gesperrt ? (
            <span data-tooltip="Wird mit der Datenbank-Erweiterung freigeschaltet"><Lock className="h-3.5 w-3.5 text-muted-foreground" /></span>
          ) : darfBearbeiten ? (
            <button
              type="button"
              aria-label={auswahlOffen ? "Auswahl schliessen" : `Person zu ${titel} ${haus.name} hinzufügen`}
              data-tooltip={auswahlOffen ? "Schliessen" : "Person hinzufügen"}
              disabled={speichert !== null}
              onClick={() => setOffen(auswahlOffen ? null : feld)}
              onMouseEnter={() => setHover(`plus:${feld}`)}
              onMouseLeave={() => setHover(null)}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full"
              style={{
                border: `1px solid ${RAND}`,
                background: hover === `plus:${feld}` || auswahlOffen ? "color-mix(in srgb, currentColor 10%, transparent)" : undefined,
              }}
            >
              {auswahlOffen ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>

        {gesperrt ? (
          <p className="text-xs text-muted-foreground">Noch nicht freigeschaltet.</p>
        ) : (
          <>
            {hier.length === 0 && !auswahlOffen && (
              <p className="text-xs text-muted-foreground">{darfBearbeiten ? "Namen hierher ziehen oder +" : "niemand"}</p>
            )}
            {hier.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {hier.map((x) => {
                  const name = nameVon.get(x.profileId) ?? "Unbekannt";
                  return (
                    <span key={x.profileId} {...ziehbar(x.profileId, haus.id)} style={darfBearbeiten ? { cursor: "grab" } : undefined}>
                      <EntfernbarChip
                        label={name}
                        disabled={speichert !== null}
                        entfernenText={`${name} bei ${haus.name} entfernen`}
                        onEntfernen={darfBearbeiten ? () => void setze(haus.id, x.profileId, null, feld) : undefined}
                      />
                    </span>
                  );
                })}
              </div>
            )}
            {auswahlOffen && darfBearbeiten && (
              <div style={speichert ? { pointerEvents: "none", opacity: 0.6 } : undefined}>
                <HinzufuegenSelect
                  items={kandidaten.map((p) => ({ id: p.id, label: p.name }))}
                  placeholder="Person wählen …"
                  onWahl={(id) => { setOffen(null); void setze(haus.id, id, funktion, feld); }}
                />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const poolZiel = ueber === "pool" && !!zug?.von && darfBearbeiten;
  const hausZahl = (id: string) => haeuser.filter((h) => (einteilung.get(h.id) ?? []).some((x) => x.profileId === id)).length;
  const frei = personen.filter((p) => hausZahl(p.id) === 0);
  const vergeben = personen.filter((p) => hausZahl(p.id) > 0);

  function poolChip(p: BrettPerson) {
    const anzahl = hausZahl(p.id);
    return (
      <span
        key={p.id}
        {...ziehbar(p.id, null)}
        onMouseEnter={() => setHover(`pool:${p.id}`)}
        onMouseLeave={() => setHover(null)}
        className="inline-flex items-center gap-2 rounded-full bg-card px-3 py-1 text-sm"
        style={{
          cursor: darfBearbeiten ? "grab" : undefined,
          border: `1px solid ${hover === `pool:${p.id}` && darfBearbeiten ? "color-mix(in srgb, currentColor 45%, transparent)" : RAND}`,
        }}
      >
        {p.name}
        {anzahl > 0 && (
          <span className="text-xs text-muted-foreground" data-tooltip={`In ${anzahl} ${anzahl === 1 ? "Haus" : "Häusern"} eingeteilt`}>{anzahl}</span>
        )}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Häuser</h2>
        <div className="overflow-x-auto pb-1">
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(haeuser.length, 1)}, minmax(12rem, 1fr))` }}>
            {haeuser.map((h) => {
              const eintraege = einteilung.get(h.id) ?? [];
              const fehlt = h.vorgemerkt ? null : luecke(eintraege, funktionBekannt);
              const aktiv = h.id === ortId;
              const f = fahrten.get(h.id);
              const tage = h.vorgemerkt ? null : anlaesse === null ? "…" : String(anlaesse.get(h.id) ?? 0);
              return (
                <div
                  key={h.id}
                  className="flex flex-col overflow-hidden rounded-xl bg-card"
                  style={{ border: `2px ${h.vorgemerkt ? "dashed" : "solid"} ${aktiv ? ROT : RAND}` }}
                >
                  {/* Haus */}
                  <button
                    type="button"
                    onClick={() => onOrt(aktiv ? null : h.id)}
                    aria-pressed={aktiv}
                    data-tooltip="Auf der Karte zeigen"
                    onMouseEnter={() => setHover(`haus:${h.id}`)}
                    onMouseLeave={() => setHover(null)}
                    className="flex min-h-[7rem] flex-col gap-1 px-3 py-3 text-left"
                    style={{ background: hover === `haus:${h.id}` ? "color-mix(in srgb, currentColor 5%, transparent)" : undefined }}
                  >
                    <span className="text-[0.9375rem] font-semibold leading-tight">{h.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {[h.ort, f ? `${dauer(f.minuten)} ab Büro` : null].filter(Boolean).join(" · ") || "Ort nicht erfasst"}
                    </span>
                    <span className="mt-auto flex gap-3 pt-2 text-xs text-muted-foreground">
                      {tage !== null && <span><span className="text-sm font-semibold text-foreground">{tage}</span> Anlässe</span>}
                      {h.capacity ? <span><span className="text-sm font-semibold text-foreground">{ZAHL.format(h.capacity)}</span> Plätze</span> : null}
                    </span>
                  </button>

                  {/* Stand */}
                  <div
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold"
                    style={{ borderTop: `1px solid ${RAND}`, ...(fehlt ? { color: ROT, background: "rgba(220, 38, 38, 0.08)" } : {}) }}
                  >
                    {h.vorgemerkt ? (
                      <span className="font-normal text-muted-foreground">Noch nicht angelegt</span>
                    ) : fehlt ? (
                      <span>{fehlt.charAt(0).toUpperCase() + fehlt.slice(1)}</span>
                    ) : (
                      <span className="inline-flex items-center gap-1 font-normal text-muted-foreground"><Check className="h-3.5 w-3.5" />Besetzt</span>
                    )}
                  </div>

                  {h.vorgemerkt ? (
                    <div className="flex flex-1 flex-col items-start gap-2 px-3 py-3" style={{ borderTop: `1px solid ${RAND}` }}>
                      <p className="text-xs text-muted-foreground">Leitung und Personal lassen sich zuteilen, sobald das Haus als Location angelegt ist.</p>
                      {darfAnlegen && (
                        <button type="button" className="kasten kasten-red" disabled={legtAn} onClick={() => onAnlegen(h.id)}>
                          {legtAn ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                          Anlegen
                        </button>
                      )}
                    </div>
                  ) : (
                    <>
                      {abschnitt(h, "leitung", "Leitung")}
                      {abschnitt(h, "personal", "Personal")}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Gesamtes Personal */}
      <section
        className="flex flex-col gap-3 rounded-xl bg-card p-4"
        onDragOver={(e) => { if (zug?.von && darfBearbeiten) { e.preventDefault(); if (ueber !== "pool") setUeber("pool"); } }}
        onDragLeave={() => { if (ueber === "pool") setUeber(null); }}
        onDrop={(e) => void inPool(e)}
        style={{
          border: `2px ${zug?.von && darfBearbeiten ? "dashed" : "solid"} ${poolZiel ? ROT : RAND}`,
          background: poolZiel ? "rgba(220, 38, 38, 0.06)" : undefined,
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold">Gesamtes Personal <span className="font-normal text-muted-foreground">{personen.length}</span></h2>
          <p className="text-xs text-muted-foreground">
            {!darfBearbeiten
              ? "Einteilen kann, wer Locations bearbeiten darf."
              : zug?.von
                ? "Hier loslassen, um die Person aus dem Haus zu nehmen."
                : "Namen nach oben in «Leitung» oder «Personal» ziehen."}
          </p>
        </div>
        {personen.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine aktiven Mitarbeitenden gefunden.</p>
        ) : (
          <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">Noch keinem Haus zugeteilt <span className="font-normal">{frei.length}</span></p>
              {frei.length === 0 ? <p className="text-xs text-muted-foreground">Alle sind mindestens einem Haus zugeteilt.</p> : <div className="flex flex-wrap gap-1.5">{frei.map(poolChip)}</div>}
            </div>
            <div className="flex flex-col gap-1.5">
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">Bereits eingeteilt <span className="font-normal">{vergeben.length}</span></p>
              {vergeben.length === 0 ? <p className="text-xs text-muted-foreground">Noch niemand eingeteilt.</p> : <div className="flex flex-wrap gap-1.5">{vergeben.map(poolChip)}</div>}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
