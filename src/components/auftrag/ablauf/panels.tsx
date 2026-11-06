"use client";

/** Inhalte rechts neben dem Strahl — je Schritt, was jetzt relevant ist. */

import { useState } from "react";
import { ArrowDownLeft, CheckCircle, Eye, EyeOff, FileText, Loader2, MapPin, Paperclip, RotateCcw, Users } from "lucide-react";
import { toast } from "sonner";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { SearchableSelect } from "@/components/searchable-select";
import type { AblaufFelder as Felder, AblaufPerson } from "@/lib/ablauf/typen";
import { KONDITIONEN, infoMail, vornameVon } from "@/lib/ablauf/eml";
import { usePermissions } from "@/lib/use-permissions";
import { ANHAENGE_VERTRAG, INVENTAR, SCHRITTE, UEBERGABE_LISTE, type Erledigt, type SchrittNr } from "./konstanten";
import { chf, datumLang, datumVoll, plusTage, zeitstempel } from "./format";
import { Chip, FeldZeile, GhostKnopf, HakenZeile, JaNeinChips, Karte, OutlookKnopf } from "./teile";
import { VertragFelder, VertragVorschau } from "./vertrag";
import type { MailEintrag } from "./mailverlauf";

export type DokRef = { id: string; name: string; storage_path: string };

export type PanelProps = {
  jobId: string;
  schritt: SchrittNr;
  aktuell: number;
  erledigt: Erledigt;
  f: Felder;
  setF: (p: Partial<Felder>) => void;
  /** Offene Feld-Änderungen speichern (vor Entwurf/Vertrag). */
  speichern: () => Promise<boolean>;
  fixiert: boolean;
  unterschrieben: boolean;
  unterschriebenAm: string | null;
  personal: AblaufPerson[];
  personId: string;
  setPersonId: (id: string) => void;
  von: string;
  bis: string;
  setVon: (v: string) => void;
  pollerFrei: boolean;
  setPollerFrei: (v: boolean) => void;
  haken: Record<string, boolean>;
  toggleHaken: (k: string) => void;
  /** Punkt, der gerade gespeichert wird («poller» bzw. «haken:<Punkt>»), sonst null. */
  arbeitLaedt: string | null;
  /** Keine Bearbeitung (fehlendes Recht oder Auftrag archiviert). */
  nurLesen: boolean;
  abgeschlossen: boolean;
  ortName: string;
  /** null = unbekannt (Abfrage fehlgeschlagen) */
  andereAuftraege: number | null;
  eingang: MailEintrag | null;
  vertragDok: DokRef | null;
  unterschriebenDok: DokRef | null;
  onDokAnsehen: (d: DokRef) => void;
  onVertragErzeugen: () => Promise<void>;
  onSchritt: (aktion: "erledigt" | "zurueck", n: SchrittNr) => Promise<boolean>;
  canFinish: boolean;
  finishBlockReason: string;
  onAbschliessen: () => void;
};

/**
 * Kopf des Schritt-Panels: Schritt-Titel + Status, rechts als dezenter
 * Ghost-Knopf «Ohne Mail als erledigt markieren» (nur am aktuellen Schritt)
 * bzw. «Wieder öffnen» bei erledigten Schritten.
 */
function PanelKopf({ p }: { p: PanelProps }) {
  const [laedt, setLaedt] = useState(false);
  const e = p.erledigt[p.schritt];
  const titel = SCHRITTE[p.schritt - 1].titel;
  const status = e
    ? `erledigt${e.zeit ? ` ${zeitstempel(e.zeit)}` : ""}${e.quelle ? ` · ${e.quelle}` : ""} — nur lesen`
    : p.schritt > p.aktuell
      ? "noch nicht erreicht — Vorschau"
      : "jetzt dran";
  const manuell = !p.nurLesen && !e && p.schritt === p.aktuell && p.schritt !== 5;
  const zurueck = !p.nurLesen && !!e;

  async function ausfuehren(aktion: "erledigt" | "zurueck") {
    setLaedt(true);
    try {
      await p.onSchritt(aktion, p.schritt);
    } finally {
      setLaedt(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
      <div className="flex items-baseline gap-2 min-w-0">
        <p className="text-sm font-semibold">
          {p.schritt}. {titel}
        </p>
        <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
          {e && <CheckCircle className="h-3 w-3 self-center" style={{ color: "var(--status-green)" }} />}
          {status}
        </span>
      </div>
      {manuell && (
        <GhostKnopf onClick={() => ausfuehren("erledigt")} disabled={laedt} tooltip="Falls die Mail nicht über auftrag@ lief">
          {laedt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
          {laedt ? "Wird gespeichert…" : "Ohne Mail als erledigt markieren"}
        </GhostKnopf>
      )}
      {zurueck && (
        <GhostKnopf onClick={() => ausfuehren("zurueck")} disabled={laedt} tooltip="Schritt wieder öffnen">
          {laedt ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          {laedt ? "Wird geöffnet…" : "Wieder öffnen"}
        </GhostKnopf>
      )}
    </div>
  );
}

// ─── Schritt 1 ───────────────────────────────────────────────────────

function Schritt1({ p }: { p: PanelProps }) {
  const { f } = p;
  const frei = p.personal.filter((m) => m.frei);
  return (
    <>
      <Karte titel="Eingang" rechts={p.eingang ? <Chip ton="neutral">aus Mail erkannt</Chip> : undefined}>
        {p.eingang && (
          <div className="rounded-lg border border-border px-3 py-2 text-sm mb-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ArrowDownLeft className="h-3.5 w-3.5" />
              <span className="truncate">
                {p.eingang.von} → auftrag@ · {zeitstempel(p.eingang.zeit)}
              </span>
            </div>
            <p className="font-medium mt-0.5">{p.eingang.betreff}</p>
            {p.eingang.auszug && <p className="text-xs text-muted-foreground mt-0.5">«{p.eingang.auszug}»</p>}
          </div>
        )}
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Aus der Vorbesprechung</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6">
          <div>
            <FeldZeile label="Anlass">{f.anlass || "—"}</FeldZeile>
            <FeldZeile label="Beginn">{f.beginn ? `${f.beginn} Uhr` : "—"}</FeldZeile>
            <FeldZeile label="Catering">{f.catering || "—"}</FeldZeile>
            <FeldZeile label="Programm">{f.programm || "—"}</FeldZeile>
          </div>
          <div>
            <FeldZeile label="Stellwandtext">{f.stellwand ? `«${f.stellwand}»` : "—"}</FeldZeile>
            <FeldZeile label="Poller-Person">{[f.pollerName, f.pollerMobil].filter(Boolean).join(", ") || "—"}</FeldZeile>
            <FeldZeile label="Bemerkungen">{f.bemerkungen || "—"}</FeldZeile>
          </div>
        </div>
        <div className="mt-2">
          <JaNeinChips
            werte={[
              ["Bier", f.bier],
              ["Buffettisch", f.buffettisch],
              ["Vorhang", f.vorhang],
              ["Tonanlage", f.tonanlage],
              ["DJ-Mischpult", f.djMischpult],
              ["Komplettservice", f.komplettservice],
            ]}
          />
        </div>
      </Karte>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        <Karte titel="Verfügbarkeit">
          <div className="space-y-2 text-sm">
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{p.ortName || "—"}</span>
                  {p.andereAuftraege === 0 && <Chip ton="ok">frei</Chip>}
                  {p.andereAuftraege !== null && p.andereAuftraege > 0 && <Chip ton="warn">belegt</Chip>}
                </div>
                <p className="text-xs text-muted-foreground">
                  {p.andereAuftraege === null
                    ? `Belegung am ${datumLang(f.datum)} nicht prüfbar`
                    : p.andereAuftraege === 0
                      ? `Kein anderer Auftrag am ${datumLang(f.datum)}`
                      : `${p.andereAuftraege} anderer Auftrag am ${datumLang(f.datum)}`}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-2 pt-2 border-t">
              <Users className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">Personal {p.ortName}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {frei.length} von {p.personal.length} frei
                  </span>
                </div>
                {p.personal.length === 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">Noch niemand zugeteilt — unter Standorte zuteilen.</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {p.personal.map((m) => (
                      <li key={m.id} className="flex items-center gap-2 text-xs">
                        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: m.frei ? "var(--status-green)" : "var(--muted-foreground)" }} />
                        <span className={m.frei ? "font-medium" : "text-muted-foreground"}>{m.name}</span>
                        <span className="text-muted-foreground">{m.frei ? "ganzer Tag frei" : m.grund ?? "nicht frei"}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {frei.length === 1 && (
                  <div className="mt-2">
                    <Chip ton="warn">knapp: nur 1 Person frei ({frei[0].name})</Chip>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Karte>

        <Karte titel="Konditionen">
          <ul className="text-sm space-y-1">
            <li className="flex justify-between gap-3">
              <span>
                Raummiete pauschal<span className="block text-xs text-muted-foreground">ca. 14:00 bis Folgetag 12:00, max. 80 Gäste</span>
              </span>
              <span className="tabular-nums shrink-0">{chf(KONDITIONEN.raummiete)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span>Disco</span>
              <span className="tabular-nums">{chf(KONDITIONEN.disco)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span>Bühne + Licht</span>
              <span className="tabular-nums">{chf(KONDITIONEN.buehneLicht)}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span>Bier, nach Konsum</span>
              <span className="tabular-nums">{chf(KONDITIONEN.bierProFlasche)}/Fl.</span>
            </li>
            <li className="flex justify-between gap-3 text-muted-foreground">
              <span>Komplettservice</span>
              <span>Preis individuell</span>
            </li>
          </ul>
          {!p.nurLesen && (
            <div className="mt-3">
              <OutlookKnopf jobId={p.jobId} art="konditionen" label="Konditionen-Mail in Outlook öffnen" emailFehlt={!f.email} vorher={p.speichern} />
            </div>
          )}
        </Karte>
      </div>
    </>
  );
}

// ─── Schritt 2 ───────────────────────────────────────────────────────

function Schritt2({ p }: { p: PanelProps }) {
  const fix = p.fixiert || !!p.erledigt[2];
  return (
    <Karte titel="Datum">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-lg font-semibold tabular-nums">{datumLang(p.f.datum)}</span>
        {fix ? <Chip ton="ok">fixiert</Chip> : <Chip ton="neutral">wartet auf Zusage der Mieterin</Chip>}
      </div>
      <p className="text-xs text-muted-foreground mt-1">
        Übergabe {p.von} · Rückgabe {datumLang(plusTage(p.f.datum, 1))}, 12:00{p.f.gaeste ? ` · max. ${p.f.gaeste} Gäste` : ""}
      </p>
      {fix && !p.unterschrieben && (
        <p className="text-sm mt-3 flex items-center gap-2">
          <EyeOff className="h-4 w-4 text-muted-foreground" />
          Im Kalender eingetragen — für Basil noch verborgen
          <span className="text-xs text-muted-foreground">(sichtbar ab Unterschrift)</span>
        </p>
      )}
      {!p.nurLesen && (
        <div className="mt-3">
          <OutlookKnopf jobId={p.jobId} art="bestaetigung" label="Bestätigungs-Mail in Outlook öffnen" emailFehlt={!p.f.email} vorher={p.speichern} />
        </div>
      )}
    </Karte>
  );
}

// ─── Schritt 3 ───────────────────────────────────────────────────────

function VertragKnoepfe({ p }: { p: PanelProps }) {
  const [laedt, setLaedt] = useState(false);
  async function erzeugen() {
    setLaedt(true);
    try {
      await p.onVertragErzeugen();
    } finally {
      setLaedt(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {p.vertragDok && (
        <button type="button" onClick={() => p.onDokAnsehen(p.vertragDok!)} className="kasten kasten-muted" data-tooltip={p.vertragDok.name}>
          <Eye className="h-4 w-4" />
          Vertrag ansehen
        </button>
      )}
      {!p.nurLesen && (
        <button type="button" onClick={erzeugen} disabled={laedt} className="kasten kasten-blue" data-tooltip="PDF im Namen von Basil erzeugen und unter Dokumente ablegen">
          {laedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {laedt ? "Wird erzeugt…" : p.vertragDok ? "Vertrag neu erzeugen" : "Vertrag erzeugen"}
        </button>
      )}
    </div>
  );
}

function Schritt3({ p }: { p: PanelProps }) {
  const nurLesen = p.nurLesen || !!p.erledigt[3];
  return (
    <>
      <Karte titel="Vertrag" rechts={<Chip ton="neutral">im Namen von Basil Erny (Vorlage)</Chip>}>
        <div className="grid grid-cols-1 lg:grid-cols-[230px_1fr] gap-4 items-start">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Felder</p>
            <VertragFelder f={p.f} setF={p.setF} nurLesen={nurLesen} />
            <div className="mt-3">
              <VertragKnoepfe p={p} />
            </div>
          </div>
          <VertragVorschau f={p.f} />
        </div>
      </Karte>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
        <Karte titel="Anhänge">
          <ul className="space-y-1 text-sm">
            {ANHAENGE_VERTRAG.map((a) => (
              <li key={a} className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                <span>{a}</span>
              </li>
            ))}
          </ul>
          {!p.nurLesen && (
            <div className="mt-3">
              <OutlookKnopf jobId={p.jobId} art="vertrag" label="Vertrags-Mail in Outlook öffnen" emailFehlt={!p.f.email} vorher={p.speichern} />
            </div>
          )}
        </Karte>
        <Karte titel="Zufahrt (Poller)">
          <HakenZeile an={p.pollerFrei} onToggle={() => p.setPollerFrei(!p.pollerFrei)} nurLesen={p.nurLesen} speichert={p.arbeitLaedt === "poller"}>
            Poller-Nummer {p.f.pollerMobil || "—"}
            {p.f.pollerName ? ` (${p.f.pollerName})` : ""} für {datumVoll(p.f.datum).slice(0, 6)} freischalten lassen (Kantensprung)
          </HakenZeile>
          <p className="text-xs text-muted-foreground mt-2 pl-2">
            Einfahrt Süd: von der freigeschalteten Nummer +41 76 452 74 18 anrufen oder App «PalGate»; Ausfahrt automatisch. Anlieferung Mo–Fr
            07:00–11:00 über Nordeingang, max. 15 Min. pro Auto, Schritttempo, nicht parkieren.
          </p>
        </Karte>
      </div>
    </>
  );
}

// ─── Schritt 4 ───────────────────────────────────────────────────────

/**
 * Vorschau der Infomail — derselbe Text wie der Outlook-Entwurf (infoMail aus
 * @/lib/ablauf/eml, wie in /api/jobs/[id]/ablauf/eml): Übergabe-Person und
 * Absender mit Vornamen. Das HTML ist sicher: eml.ts maskiert alle Eingaben.
 */
function InfomailText({ html }: { html: string }) {
  return <div className="text-sm mt-2 space-y-2 [&_b]:font-semibold" dangerouslySetInnerHTML={{ __html: html }} />;
}

function Schritt4({ p }: { p: PanelProps }) {
  const nurLesen = p.nurLesen || !!p.erledigt[4];
  const person = p.personal.find((m) => m.id === p.personId);
  const bereitAb = plusTage(p.f.datum, -7);
  const { profile } = usePermissions();
  const infomail = infoMail(
    p.f,
    vornameVon(profile?.full_name),
    person ? { name: vornameVon(person.name), telefon: person.telefon } : null,
    p.von,
    p.bis,
  );

  if (!p.unterschrieben && !p.erledigt[4]) {
    return (
      <Karte titel="Unterschrift">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          Wartet auf den unterschriebenen Vertrag — wird aus der Antwort-Mail erkannt.
        </div>
        <p className="text-xs text-muted-foreground mt-1">Danach erscheint der Anlass in Basils Kalender, und die Infomail wird vorbereitet.</p>
      </Karte>
    );
  }

  const personItems = p.personal.map((m) => ({ id: m.id, label: m.name, sub: m.frei ? "frei" : m.grund ?? "nicht frei" }));
  // Eine bereits gewählte Person, die nicht (mehr) zugeteilt ist, trotzdem anzeigen.
  if (p.personId && !personItems.some((i) => i.id === p.personId)) {
    personItems.push({ id: p.personId, label: "Nicht mehr zugeteilt", sub: "bitte neu wählen" });
  }

  return (
    <>
      <Karte titel="Vertrag" rechts={<Chip ton="ok">Unterschriebener Vertrag erkannt</Chip>}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {p.unterschriebenDok ? (
              <button type="button" onClick={() => p.onDokAnsehen(p.unterschriebenDok!)} className="underline underline-offset-2 decoration-foreground/30" data-tooltip="Vorschau öffnen">
                {p.unterschriebenDok.name}
              </button>
            ) : (
              "Unterschriebener Vertrag"
            )}
            {p.unterschriebenAm && <span className="text-xs text-muted-foreground">· aus Mail vom {zeitstempel(p.unterschriebenAm)}</span>}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Eye className="h-4 w-4 text-muted-foreground" />
            Jetzt in Basils Kalender sichtbar
          </span>
        </div>
      </Karte>

      <Karte titel="Übergabe">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <span className="text-[11px] text-muted-foreground">Datum</span>
            <div className="h-8 flex items-center text-sm font-medium tabular-nums">{datumLang(p.f.datum)}</div>
          </div>
          <label className="block w-20">
            <span className="text-[11px] text-muted-foreground">Von</span>
            <ZeitFeld value={p.von} onChange={p.setVon} schrittMin={15} disabled={nurLesen} className="h-8" />
          </label>
          <label className="block w-20" data-tooltip="Übergabe dauert 1 Stunde">
            <span className="text-[11px] text-muted-foreground">Bis</span>
            <ZeitFeld value={p.bis} onChange={() => undefined} disabled className="h-8" />
          </label>
          <div className="w-64 max-w-full">
            <span className="text-[11px] text-muted-foreground">Übergabeperson</span>
            {nurLesen ? (
              <div className="h-8 flex items-center text-sm font-medium">{person?.name ?? "—"}</div>
            ) : (
              <SearchableSelect
                value={p.personId}
                onChange={(id) => {
                  const m = p.personal.find((x) => x.id === id);
                  if (m && !m.frei) toast.warning(`${m.name} ist an diesem Tag nicht frei`, { description: m.grund ?? undefined });
                  p.setPersonId(id);
                }}
                items={personItems}
                searchable={false}
                clearable={false}
                placeholder={p.personal.length === 0 ? "Niemand zugeteilt" : "Person wählen…"}
              />
            )}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground mt-1.5">Nur Personal, das {p.ortName || "der Location"} zugeteilt ist · Dauer 1 Stunde geplant</p>
      </Karte>

      <Karte titel="Infomail (7 Tage vorher)" rechts={<Chip ton="neutral">bereit ab {datumLang(bereitAb)} (7 Tage vorher)</Chip>}>
        <div className="rounded-lg border border-border px-3 py-2">
          <p className="text-xs text-muted-foreground">An {p.f.email || "—"} · CC auftrag@</p>
          <p className="text-sm font-medium mt-0.5">{infomail.betreff}</p>
          <InfomailText html={infomail.html} />
          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1.5">
            <Paperclip className="h-3 w-3" />
            Checkliste · Informationen für Privatvermietungen
          </p>
        </div>
        {!p.nurLesen && (
          <div className="mt-3">
            <OutlookKnopf jobId={p.jobId} art="infomail" label="Infomail in Outlook öffnen" emailFehlt={!p.f.email} vorher={p.speichern} />
          </div>
        )}
      </Karte>
    </>
  );
}

// ─── Schritt 5 ───────────────────────────────────────────────────────

function Schritt5({ p }: { p: PanelProps }) {
  const fertig = !!p.erledigt[5];
  const [laedt, setLaedt] = useState(false);
  const alle = UEBERGABE_LISTE.every((k) => p.haken[k]);
  const anzahl = UEBERGABE_LISTE.filter((k) => p.haken[k]).length;
  const rueckgabe = plusTage(p.f.datum, 1);
  const gesperrt = fertig || p.nurLesen;

  async function uebergabe() {
    if (!alle) {
      toast.error("Übergabe-Liste noch nicht vollständig", { description: `${anzahl} von ${UEBERGABE_LISTE.length} abgehakt` });
      return;
    }
    setLaedt(true);
    try {
      await p.onSchritt("erledigt", 5);
    } finally {
      setLaedt(false);
    }
  }

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_260px] gap-3 items-start">
        <Karte
          titel="Übergabe-Liste"
          rechts={
            <span className="text-xs text-muted-foreground tabular-nums">
              {anzahl}/{UEBERGABE_LISTE.length}
            </span>
          }
        >
          <div className="-mx-2">
            {UEBERGABE_LISTE.map((k) => (
              <HakenZeile key={k} an={!!p.haken[k]} onToggle={() => p.toggleHaken(k)} nurLesen={gesperrt} speichert={p.arbeitLaedt === `haken:${k}`}>
                {k}
              </HakenZeile>
            ))}
          </div>
        </Karte>
        <Karte titel="Inventar (kurz)">
          <div className="-mx-2">
            {INVENTAR.map((k) => (
              <HakenZeile
                key={k}
                an={!!p.haken[`inv:${k}`]}
                onToggle={() => p.toggleHaken(`inv:${k}`)}
                nurLesen={gesperrt}
                speichert={p.arbeitLaedt === `haken:inv:${k}`}
              >
                <span className="text-xs">{k}</span>
              </HakenZeile>
            ))}
          </div>
        </Karte>
      </div>

      {!fertig ? (
        !p.nurLesen && (
          <div className="flex justify-end">
            <button type="button" disabled={laedt} onClick={uebergabe} className="kasten kasten-green">
              {laedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
              {laedt ? "Wird gespeichert…" : "Übergabe erfolgt"}
            </button>
          </div>
        )
      ) : (
        <Karte titel="Bis zum Abschluss">
          <p className="text-sm">
            Auftrag bleibt aktiv bis <span className="font-medium tabular-nums">{datumVoll(rueckgabe).slice(0, 6)} 12:00</span>, dann Abrechnung.
          </p>
          <p className="text-xs text-muted-foreground mt-1">Rechnung an Barakuba / Basil Erny — Provision Raummiete</p>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={p.onAbschliessen}
              disabled={p.abgeschlossen || p.nurLesen || !p.canFinish}
              className="kasten kasten-green"
              data-tooltip={!p.abgeschlossen && !p.canFinish ? p.finishBlockReason : undefined}
            >
              <CheckCircle className="h-4 w-4" />
              {p.abgeschlossen ? "Abgeschlossen" : "Abschliessen"}
            </button>
            {p.abgeschlossen && <span className="text-xs text-muted-foreground">→ weiter in der normalen Abrechnung</span>}
          </div>
        </Karte>
      )}
    </>
  );
}

export function SchrittPanel(p: PanelProps) {
  return (
    <div className="space-y-3">
      <PanelKopf p={p} />
      {p.schritt === 1 && <Schritt1 p={p} />}
      {p.schritt === 2 && <Schritt2 p={p} />}
      {p.schritt === 3 && <Schritt3 p={p} />}
      {p.schritt === 4 && <Schritt4 p={p} />}
      {p.schritt === 5 && <Schritt5 p={p} />}
    </div>
  );
}
