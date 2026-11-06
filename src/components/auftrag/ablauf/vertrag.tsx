"use client";

/**
 * Vertragsvorschau nach Basils Vorlage «Vertrag für Dein Fest im barakuba».
 * Wird live aus den Feldern gefüllt; links daneben die bearbeitbaren Felder.
 * Das «Papier» bleibt bewusst weiss (wie eine PDF-Vorschau), auch im Dunkelmodus.
 * Das verbindliche PDF erzeugt der Server (POST …/ablauf/vertrag).
 */

import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import type { AblaufFelder as Felder } from "@/lib/ablauf/typen";
import { KONDITIONEN } from "@/lib/ablauf/eml";
import { chf, datumLang, datumVoll, plusTage, tagZuerich } from "./format";

function Abschnitt({ titel, children }: { titel: string; children: ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="text-[12px] font-bold">{titel}</h3>
      <div className="mt-1 space-y-1">{children}</div>
    </section>
  );
}

function Zeile({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2">
      <span className="font-semibold">{k}</span>
      <span>{children}</span>
    </div>
  );
}

/** Live gefüllter Wert — leicht hinterlegt, damit man sieht, was aus den Feldern kommt. */
function W({ children }: { children: ReactNode }) {
  return <mark className="bg-amber-100/70 text-inherit rounded-sm px-0.5">{children}</mark>;
}

export function VertragVorschau({ f }: { f: Felder }) {
  const folgetag = plusTage(f.datum, 1);
  return (
    <div className="rounded-lg border border-border bg-white text-neutral-900 shadow-sm px-6 py-6 md:px-8 text-[11px] leading-relaxed max-h-[640px] overflow-y-auto">
      <p className="text-[10px] uppercase tracking-wider text-neutral-500">barakuba · Gundeldinger Feld · Dornacherstrasse 192 · 4053 Basel</p>
      <h2 className="mt-3 text-[15px] font-bold leading-snug">Vertrag für Dein Fest im barakuba im Gundeldinger Feld in Basel</h2>
      <p className="mt-2">
        Liebe:r <W>{f.mieter || "—"}</W> (<W>{f.adresse || "—"}</W>, <W>{f.telefon || "—"}</W>
        {f.email ? (
          <>
            , <W>{f.email}</W>
          </>
        ) : null}
        )
      </p>
      <p className="mt-1">
        Ich freue mich, dass Du Dein Fest im barakuba feierst. Mit diesem Vertrag vermiete ich Dir den Raum zu folgenden Bedingungen:
      </p>

      <Abschnitt titel="1. Allgemein">
        <Zeile k="Datum">
          <W>{datumLang(f.datum)}</W>
        </Zeile>
        <Zeile k="Raumübergabe">14h, Dauer ca. 1 Stunde</Zeile>
        <Zeile k="Raumrückgabe">
          <W>{datumLang(folgetag)}</W>, 12h
        </Zeile>
        <Zeile k="Zweck">
          <W>{f.anlass || "—"}</W> im privaten Rahmen / Beginn <W>{(f.beginn || "—").replace(":00", "")}h</W> / mit maximal <W>{f.gaeste || "—"}</W> Gästen
        </Zeile>
        <Zeile k="Inbegriffen">
          Raum mit Bar, Mobiliar, Gläser, Grundbeleuchtung, Tonanlage{f.djMischpult ? ", DJ-Mischpult" : ""}
          {f.buffettisch ? ", Buffettische" : ""}
        </Zeile>
        <Zeile k="Vorplatz">Nutzung nach Absprache, Feuerschale auf Anfrage</Zeile>
        <Zeile k="Aufräumen">Aufräumen und Reinigung durch die Mieter:in bis zur Rückgabe (Checkliste)</Zeile>
        <Zeile k="Zusatzaufwand">wird mit {chf(KONDITIONEN.zusatzaufwandProStunde)}/h verrechnet</Zeile>
      </Abschnitt>

      <Abschnitt titel="2. Kosten">
        <Zeile k="Raummiete">{chf(KONDITIONEN.raummiete)} pauschal</Zeile>
        {f.disco && (
          <Zeile k="Disco">
            <W>{chf(KONDITIONEN.disco)}</W>
          </Zeile>
        )}
        {f.buehneLicht && (
          <Zeile k="Bühne + Licht">
            <W>{chf(KONDITIONEN.buehneLicht)}</W>
          </Zeile>
        )}
        {f.komplettservice && (f.preisKomplettservice ?? "").trim() && (
          <Zeile k="Komplettservice">
            <W>CHF {(f.preisKomplettservice ?? "").trim()}</W>
          </Zeile>
        )}
        <Zeile k="Bier">{chf(KONDITIONEN.bierProFlasche)} pro Flasche, nach Konsum</Zeile>
        <Zeile k="Kaffee">{chf(KONDITIONEN.kaffeeProTab)} pro Tab</Zeile>
        <Zeile k="Glasbruch">{chf(KONDITIONEN.glas)} pro Glas</Zeile>
        <p className="pt-1">Die Rechnung folgt nach dem Anlass und ist innert 10 Tagen zahlbar.</p>
      </Abschnitt>

      <Abschnitt titel="3. Diverses">
        <ul className="list-disc pl-4 space-y-0.5">
          <li>Die Hoftür bleibt ab 23h geschlossen.</li>
          <li>Einfahrt über die Bruderholzstrasse, max. Fahrzeughöhe 2.30 m.</li>
          <li>
            Zufahrt nur mit Poller-Zugangsbewilligung (<W>{f.pollerName || "—"}</W>, <W>{f.pollerMobil || "—"}</W>), gemäss Poller-Merkblatt.
          </li>
          <li>Keine Autos auf dem Areal, nur Anlieferung.</li>
          <li>Im ganzen Gebäude gilt Nichtrauchen.</li>
          <li>Keine Foodtrucks.</li>
          <li>Dekoration und Zelte nur nach Absprache.</li>
          <li>Gerichtsstand ist Basel.</li>
        </ul>
      </Abschnitt>

      <div className="mt-8 grid grid-cols-2 gap-8">
        <div>
          <div className="border-t border-neutral-400 pt-1">Ort, Datum, Mieter:in</div>
          <div className="text-neutral-500">
            <W>{f.mieter || "—"}</W>
          </div>
        </div>
        <div>
          <div className="border-t border-neutral-400 pt-1">Ort, Datum, Vermieter</div>
          <div className="text-neutral-500">Basil Erny, barakuba</div>
        </div>
      </div>
      <p className="mt-6 text-[10px] text-neutral-500">Basel, {datumVoll(tagZuerich(new Date().toISOString()))}</p>
    </div>
  );
}

const LABEL = "text-[11px] text-muted-foreground";

type TextFeld = "mieter" | "adresse" | "telefon" | "email" | "anlass" | "gaeste" | "pollerName" | "pollerMobil";

export function VertragFelder({ f, setF, nurLesen }: { f: Felder; setF: (p: Partial<Felder>) => void; nurLesen: boolean }) {
  const feld = (k: TextFeld, label: string, ph?: string) => (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <Input
        value={String(f[k] ?? "")}
        onChange={(e) => setF({ [k]: e.target.value } as Partial<Felder>)}
        placeholder={ph}
        disabled={nurLesen}
        className="h-8"
      />
    </label>
  );
  const schalter = (k: "disco" | "buehneLicht" | "komplettservice", label: string) => (
    <button
      type="button"
      disabled={nurLesen}
      onClick={() => setF({ [k]: !f[k] } as Partial<Felder>)}
      className={`kasten ${f[k] ? "kasten-active" : "kasten-toggle-off"}`}
    >
      {label}
    </button>
  );
  return (
    <div className="space-y-2">
      {feld("mieter", "Mieter:in")}
      {feld("adresse", "Adresse")}
      <div className="grid grid-cols-2 gap-2">
        {feld("telefon", "Telefon")}
        {feld("email", "E-Mail", "fehlt")}
      </div>
      {feld("anlass", "Anlass / Zweck")}
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className={LABEL}>Beginn</span>
          <ZeitFeld value={f.beginn ?? ""} onChange={(v) => setF({ beginn: v })} disabled={nurLesen} className="h-8" />
        </label>
        {feld("gaeste", "max. Gäste")}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {feld("pollerName", "Poller-Person")}
        {feld("pollerMobil", "Poller-Mobil")}
      </div>
      <div>
        <span className={LABEL}>Zusätze</span>
        <div className="flex flex-wrap gap-1.5 mt-0.5">
          {schalter("disco", `Disco ${chf(KONDITIONEN.disco)}`)}
          {schalter("buehneLicht", `Bühne+Licht ${chf(KONDITIONEN.buehneLicht)}`)}
          {schalter("komplettservice", "Komplettservice")}
        </div>
      </div>
      {f.komplettservice && (
        <label className="block">
          <span className={LABEL}>Preis Komplettservice (CHF) · optional, individuell</span>
          <Input
            value={f.preisKomplettservice ?? ""}
            onChange={(e) => setF({ preisKomplettservice: e.target.value })}
            placeholder="leer = keine Kosten-Zeile"
            inputMode="decimal"
            disabled={nurLesen}
            className="h-8 tabular-nums"
          />
        </label>
      )}
    </div>
  );
}
