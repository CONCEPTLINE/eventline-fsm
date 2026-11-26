"use client";

/**
 * Ressourcen › Planungsbrett (Leos Skizze, 26.11.2026): je Haus eine Spalte —
 * oben die Karte mit den Eckdaten, darunter das Feld «Leitung» und das Feld
 * «Personal». Unten der Kasten «Gesamtes Personal» mit allen Mitarbeitenden.
 *
 * Zuteilen: eine Person aus «Gesamtes Personal» in ein Feld ziehen, oder im
 * Feld über «+» auswählen. Zwischen Feldern und Häusern verschieben geht
 * ebenfalls durch Ziehen. Entfernen: × am Namen oder zurück in «Gesamtes
 * Personal» ziehen. Eine Person kann in mehreren Häusern stehen.
 * Gespeichert wird sofort (POST /api/ressourcen/einteilung, locations:edit).
 *
 * Warnung (rot, Farbe nur mit Bedeutung): «keine Leitung», sonst «keine
 * Stellvertretung», wenn im Haus weniger als zwei Personen stehen.
 * Vorgemerkte Häuser (noch keine Location) nehmen kein Personal auf.
 */

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { EntfernbarChip, HinzufuegenSelect } from "@/components/standort/zuteilung-chips";

export type Funktion = "leitung" | "personal";
export type Eintrag = { profileId: string; funktion: Funktion };
export type BrettHaus = { id: string; name: string; ort: string; capacity: number | null; vorgemerkt: boolean };
export type BrettPerson = { id: string; name: string };
export type BrettFahrt = { minuten: number; km: number };

const ZAHL = new Intl.NumberFormat("de-CH");
const ROT = "#dc2626";
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
  funktionBekannt,
  ortId,
  onOrt,
  onSetze,
}: {
  haeuser: BrettHaus[];
  personen: BrettPerson[];
  /** location_id → Einträge. */
  einteilung: Map<string, Eintrag[]>;
  /** location_id → offene Aufträge der nächsten 30 Tage; null = lädt. */
  anlaesse: Map<string, number> | null;
  fahrten: Map<string, BrettFahrt>;
  darfBearbeiten: boolean;
  /** false = Spalte «funktion» fehlt noch (Migration 392): alles gilt als Personal. */
  funktionBekannt: boolean;
  ortId: string | null;
  onOrt: (id: string | null) => void;
  /** Speichert eine Einteilung; funktion null = entfernen. true = gespeichert. */
  onSetze: (locationId: string, profileId: string, funktion: Funktion | null) => Promise<boolean>;
}) {
  const [zug, setZug] = useState<Zug | null>(null);
  /** Feld, über dem gerade gezogen wird: "<haus>:<funktion>" oder "pool". */
  const [ueber, setUeber] = useState<string | null>(null);
  const [speichert, setSpeichert] = useState<string | null>(null);
  const [hoverKopf, setHoverKopf] = useState<string | null>(null);

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
    if (!z || !darfBearbeiten || haus.vorgemerkt) return;
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
      style: { cursor: "grab" } as React.CSSProperties,
    };
  }

  // Bewusst eine Funktion, keine Komponente: so bleibt der Zustand der
  // Auswahlfelder über Neuzeichnungen erhalten.
  function feldAnzeige(haus: BrettHaus, funktion: Funktion, titel: string) {
    const feld = `${haus.id}:${funktion}`;
    const alle = einteilung.get(haus.id) ?? [];
    const hier = alle.filter((x) => x.funktion === funktion).sort((a, b) => (nameVon.get(a.profileId) ?? "").localeCompare(nameVon.get(b.profileId) ?? "", "de-CH"));
    const kandidaten = personen.filter((p) => !alle.some((x) => x.profileId === p.id && x.funktion === funktion));
    const gesperrt = haus.vorgemerkt || (funktion === "leitung" && !funktionBekannt);
    const ziel = ueber === feld && !!zug && darfBearbeiten && !gesperrt;
    return (
      <div
        key={feld}
        className="flex min-h-[5.5rem] flex-col gap-1.5 rounded-lg border p-2"
        onDragOver={(e) => { if (zug && darfBearbeiten && !gesperrt) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (ueber !== feld) setUeber(feld); } }}
        onDragLeave={() => { if (ueber === feld) setUeber(null); }}
        onDrop={(e) => { if (!gesperrt) void fallenLassen(e, haus, funktion); }}
        style={{
          borderStyle: zug && darfBearbeiten && !gesperrt ? "dashed" : "solid",
          borderColor: ziel ? ROT : undefined,
          background: ziel ? "rgba(220, 38, 38, 0.06)" : undefined,
        }}
      >
        <p className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span>{titel}{hier.length > 0 && <span className="font-normal"> ({hier.length})</span>}</span>
          {speichert === feld && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="Speichert…" />}
        </p>
        {haus.vorgemerkt ? (
          <p className="text-xs text-muted-foreground">Erst als Location anlegen.</p>
        ) : gesperrt ? (
          <p className="text-xs text-muted-foreground">Braucht die Datenbank-Migration 392.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {hier.length === 0 && <span className="text-xs text-muted-foreground">{darfBearbeiten ? "Person hierher ziehen" : "niemand"}</span>}
              {hier.map((x) => {
                const name = nameVon.get(x.profileId) ?? "Unbekannt";
                return (
                  <span key={x.profileId} {...ziehbar(x.profileId, haus.id)}>
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
            {darfBearbeiten && (
              <div className="mt-auto" style={speichert ? { pointerEvents: "none", opacity: 0.6 } : undefined}>
                <HinzufuegenSelect
                  items={kandidaten.map((p) => ({ id: p.id, label: p.name }))}
                  placeholder="+ Person"
                  onWahl={(id) => void setze(haus.id, id, funktion, feld)}
                />
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  const poolZiel = ueber === "pool" && !!zug?.von && darfBearbeiten;

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-x-auto pb-1">
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.max(haeuser.length, 1)}, minmax(11.5rem, 1fr))` }}>
          {haeuser.map((h) => {
            const eintraege = einteilung.get(h.id) ?? [];
            const fehlt = h.vorgemerkt ? null : luecke(eintraege, funktionBekannt);
            const aktiv = h.id === ortId;
            const f = fahrten.get(h.id);
            return (
              <div key={h.id} className="flex flex-col gap-2">
                {/* Karte des Hauses */}
                <button
                  type="button"
                  onClick={() => onOrt(aktiv ? null : h.id)}
                  aria-pressed={aktiv}
                  data-tooltip="Auf der Karte zeigen"
                  onMouseEnter={() => setHoverKopf(h.id)}
                  onMouseLeave={() => setHoverKopf(null)}
                  className="flex min-h-[8.5rem] flex-col gap-1 rounded-lg border-2 bg-card p-3 text-left"
                  style={{
                    borderColor: aktiv ? ROT : hoverKopf === h.id ? "color-mix(in srgb, currentColor 40%, transparent)" : undefined,
                    borderStyle: h.vorgemerkt ? "dashed" : "solid",
                  }}
                >
                  <span className="text-base font-semibold leading-tight">{h.name}</span>
                  <span className="text-xs text-muted-foreground">{h.ort || "Ort nicht erfasst"}</span>
                  <span className="mt-1 flex flex-col gap-0.5 text-xs">
                    <Zeile label="Anlässe, 30 Tage" wert={h.vorgemerkt ? "–" : anlaesse === null ? "…" : String(anlaesse.get(h.id) ?? 0)} />
                    <Zeile label="Fahrt ab Büro" wert={f ? `${dauer(f.minuten)} · ${ZAHL.format(f.km)} km` : "…"} />
                    <Zeile label="Plätze" wert={h.capacity ? ZAHL.format(h.capacity) : "–"} />
                  </span>
                  <span className="mt-auto pt-1 text-xs font-semibold" style={{ color: fehlt ? ROT : undefined }}>
                    {h.vorgemerkt ? "noch nicht angelegt" : fehlt ?? "besetzt"}
                  </span>
                </button>
                {feldAnzeige(h, "leitung", "Leitung")}
                {feldAnzeige(h, "personal", "Personal")}
              </div>
            );
          })}
        </div>
      </div>

      {/* Gesamtes Personal */}
      <div
        className="rounded-xl border-2 bg-card p-3"
        onDragOver={(e) => { if (zug?.von && darfBearbeiten) { e.preventDefault(); if (ueber !== "pool") setUeber("pool"); } }}
        onDragLeave={() => { if (ueber === "pool") setUeber(null); }}
        onDrop={(e) => void inPool(e)}
        style={{ borderStyle: zug?.von && darfBearbeiten ? "dashed" : "solid", borderColor: poolZiel ? ROT : undefined, background: poolZiel ? "rgba(220, 38, 38, 0.06)" : undefined }}
      >
        <p className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm font-semibold">Gesamtes Personal <span className="font-normal text-muted-foreground">({personen.length})</span></span>
          <span className="text-xs text-muted-foreground">
            {darfBearbeiten
              ? zug?.von ? "Hier loslassen, um die Person aus dem Haus zu nehmen." : "Namen in ein Feld «Leitung» oder «Personal» ziehen. Die Zahl zeigt, in wie vielen Häusern jemand steht."
              : "Einteilen kann, wer Locations bearbeiten darf."}
          </span>
        </p>
        {personen.length === 0 ? (
          <p className="text-sm text-muted-foreground">Keine aktiven Mitarbeitenden gefunden.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {personen.map((p) => {
              const anzahl = haeuser.filter((h) => (einteilung.get(h.id) ?? []).some((x) => x.profileId === p.id)).length;
              return (
                <span
                  key={p.id}
                  {...ziehbar(p.id, null)}
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm"
                  style={{ ...(darfBearbeiten ? { cursor: "grab" } : {}), opacity: anzahl === 0 ? 1 : 0.75, fontWeight: anzahl === 0 ? 600 : 400 }}
                  data-tooltip={anzahl === 0 ? "Noch keinem Haus zugeteilt" : `In ${anzahl} ${anzahl === 1 ? "Haus" : "Häusern"}`}
                >
                  {p.name}
                  <span className="text-xs text-muted-foreground">{anzahl}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Zeile({ label, wert }: { label: string; wert: string }) {
  return (
    <span className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{wert}</span>
    </span>
  );
}
