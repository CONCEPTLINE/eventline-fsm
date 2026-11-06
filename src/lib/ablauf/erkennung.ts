// KI-Teil des Vermietungs-Ablaufs (Claude über structuredCall, strict-Tool):
//  1. erkenneAnfrage — ist eine NICHT zugeordnete Mail eine neue Privatvermietungs-Anfrage
//     (z. B. Basils «Vorbesprechung» als PDF) für eine Location mit Partner-Kalender?
//     Liest dabei die Felder aus Mail + Anhang (PDF/Bild).
//  2. ordneAblaufMailEin — Mail zu einem Auftrag MIT Ablauf: welche Art (Konditionen, Zusage,
//     Bestätigung, Vertrag, Unterschrift, Ergänzung, sonstiges) + ergänzbare Felder.
// Fällt Claude aus (Limit, Fehler, kein Schlüssel), kommt null zurück — der Aufrufer
// verhält sich dann wie ohne Ablauf (Mail wartet bzw. keine Wirkung).

import type Anthropic from "@anthropic-ai/sdk";
import { aiAvailable, structuredCall } from "@/lib/ai/anthropic";
import { logError } from "@/lib/log";
import { todayLocalIso } from "@/lib/swiss-time";
import { felderSauber, istEventlineAdresse, istEventlineDomain, nurAdresse } from "./schritte";
import { BOOL_FELDER, MAIL_ARTEN, TEXT_FELDER, type AblaufFelder, type MailArt, type SchrittNr } from "./typen";

export type ErkennungMail = {
  von: string;
  an: string[];
  cc: string[];
  betreff: string;
  text: string;
  anhangNamen: string[];
};

export type ErkennungAnhang = { name: string; mime: string; bin: ArrayBuffer };

// Adress-Regeln liegen (rein, getestet) in schritte.ts; hier weitergereicht für bestehende Aufrufer.
export { istEventlineAdresse, nurAdresse } from "./schritte";

/** Kennwort einer Location für den Text-Vorfilter («Barakuba Basel» → «barakuba»). */
function kennwoerter(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 5 && !["basel", "theater", "halle", "club", "location"].includes(w));
}

/** Vorfilter ohne KI: nennt die Mail (Betreff/Text/Anhang-Namen) eine dieser Locations? */
export function erwaehnteLocations<T extends { id: string; name: string }>(mail: Pick<ErkennungMail, "betreff" | "text" | "anhangNamen">, locations: readonly T[]): T[] {
  const hay = `${mail.betreff}\n${mail.text}\n${mail.anhangNamen.join(" ")}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
  return locations.filter((l) => kennwoerter(l.name).some((w) => hay.includes(w)));
}

// ── Schema der Felder ────────────────────────────────────────────
// Bewusst OHNE nullable Typen: strict-Tools erlauben nur wenige Union-Parameter.
// Text: "" = nicht genannt. Ja/Nein: "ja" | "nein" | "offen" (offen = nicht genannt).

const FELD_BESCHREIBUNG: Partial<Record<keyof AblaufFelder, string>> = {
  datum: "Datum des Anlasses als YYYY-MM-DD (Jahr aus dem Kontext; ohne Jahr das nächste kommende)",
  mieter: "Name(n) der Mieterin/des Mieters (Privatperson), nicht der Location oder von EVENTLINE",
  telefon: "Telefon des Mieters (bei zweien beide, mit ' / ' getrennt)",
  adresse: "Postadresse des Mieters",
  email: "E-Mail des MIETERS — nie eine Adresse von EVENTLINE oder der Location/des Partners",
  anlass: "Art des Anlasses, kurz (z. B. 'Geburtstagsfest', 'Hochzeit')",
  beginn: "Beginn als HH:MM (24h)",
  gaeste: "maximale Anzahl Gäste als Zahl/Text (z. B. '70')",
  catering: "Catering-Angabe kurz",
  programm: "Programm kurz",
  stellwand: "Text für die Stellwand",
  pollerName: "Name der Person für den Poller (Zufahrt)",
  pollerMobil: "Mobilnummer der Poller-Person",
  preisKomplettservice: "nur wenn ausdrücklich ein Preis für den Komplettservice genannt ist",
  bemerkungen: "weitere wichtige Bemerkungen zum Anlass, kurz",
  bier: "Bier gewünscht",
  buffettisch: "Buffettisch gewünscht",
  vorhang: "Vorhang/Spiegel offen",
  tonanlage: "Tonanlage gewünscht",
  djMischpult: "DJ-Mischpult gewünscht",
  disco: "Disco gewünscht",
  buehneLicht: "Bühne/Licht gewünscht",
  komplettservice: "Komplettservice gewünscht (true) bzw. ausdrücklich KEIN Komplettservice (false)",
};

function felderSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const k of TEXT_FELDER) properties[k] = { type: "string", description: `${FELD_BESCHREIBUNG[k] ?? k}; "" wenn nicht genannt` };
  for (const k of BOOL_FELDER) properties[k] = { type: "string", enum: ["ja", "nein", "offen"], description: `${FELD_BESCHREIBUNG[k] ?? k}; offen = nicht genannt` };
  return {
    type: "object",
    additionalProperties: false,
    required: [...TEXT_FELDER, ...BOOL_FELDER],
    properties,
    description: "Nur ausdrücklich genannte Angaben. Nichts erfinden.",
  };
}

/** KI-Felder → saubere Teil-Felder; Adressen von EVENTLINE/Partner als Mieter-Mail verworfen. */
function felderAusKi(roh: Record<string, unknown> | null | undefined, gesperrteAdressen: readonly string[]): Partial<AblaufFelder> {
  const ohneNull: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(roh ?? {})) {
    if ((BOOL_FELDER as readonly string[]).includes(k)) {
      if (v === "ja" || v === true) ohneNull[k] = true;
      else if (v === "nein" || v === false) ohneNull[k] = false;
    } else if (typeof v === "string" && v.trim() !== "") ohneNull[k] = v;
  }
  const f = felderSauber(ohneNull);
  if (f.email && (istEventlineDomain(f.email) || gesperrteAdressen.some((a) => a && nurAdresse(a) === f.email))) delete f.email;
  return f;
}

function mailBlock(mail: ErkennungMail): string {
  return [
    `Von: ${mail.von}`,
    `An: ${mail.an.join(", ") || "-"}`,
    `CC: ${mail.cc.join(", ") || "-"}`,
    `Betreff: ${mail.betreff || "(kein Betreff)"}`,
    `Anhänge: ${mail.anhangNamen.join(", ") || "keine"}`,
    "",
    mail.text.slice(0, 6000),
  ].join("\n");
}

const VISION = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function anhangBloecke(anhaenge: readonly ErkennungAnhang[]): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const a of anhaenge.slice(0, 3)) {
    if (a.mime === "application/pdf" && a.bin.byteLength < 8_000_000) {
      out.push({ type: "text", text: `Anhang «${a.name}» (PDF):` });
      out.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from(a.bin).toString("base64") } });
    } else if (VISION.has(a.mime) && a.bin.byteLength < 4_500_000 && a.bin.byteLength > 10_000) {
      out.push({ type: "text", text: `Anhang «${a.name}» (Bild):` });
      out.push({
        type: "image",
        source: { type: "base64", media_type: a.mime as "image/jpeg", data: Buffer.from(a.bin).toString("base64") },
      });
    }
  }
  return out;
}

// ── 1. Neue Anfrage ──────────────────────────────────────────────

export type AnfrageErkennung = {
  neueAnfrage: boolean;
  sicherheit: "eindeutig" | "wahrscheinlich" | "unklar";
  locationId: string | null;
  felder: Partial<AblaufFelder>;
  grund: string;
};

type AnfrageKi = {
  art: "neue_anfrage" | "anderes";
  sicherheit: "eindeutig" | "wahrscheinlich" | "unklar";
  location_id: string | null;
  grund: string;
  felder: Record<string, unknown>;
};

export async function erkenneAnfrage(
  mail: ErkennungMail,
  opts: {
    locations: readonly { id: string; name: string }[];
    /** Location des Partner-Kontos, falls der Absender ein Partner ist */
    partnerLocationId: string | null;
    anhaenge: readonly ErkennungAnhang[];
    /** Adressen, die nie Mieter-Mail sein dürfen (Partner-Konten) */
    gesperrteAdressen: readonly string[];
  },
): Promise<AnfrageErkennung | null> {
  if (!aiAvailable() || opts.locations.length === 0) return null;
  const ids = new Set(opts.locations.map((l) => l.id));
  const liste = opts.locations.map((l) => `${l.id} | ${l.name}`).join("\n");
  const partner = opts.partnerLocationId ? opts.locations.find((l) => l.id === opts.partnerLocationId) : null;
  try {
    const erg = await structuredCall<AnfrageKi>({
      system:
        "Du prüfst eine E-Mail an den Auftrags-Eingang von EVENTLINE (Basel). EVENTLINE betreut für Partner-Locations deren " +
        "PRIVATVERMIETUNGEN (Privatpersonen mieten den Raum für Geburtstag, Hochzeit, Familienfest usw.). " +
        "art = 'neue_anfrage' NUR, wenn die Mail eine NEUE Mietanfrage für einen privaten Anlass an einer der gelisteten Locations " +
        "enthält — typisch: der Partner leitet ein ausgefülltes Formular «Vorbesprechung» (oft handschriftlich, als PDF) weiter, " +
        "oder eine Privatperson/ein EVENTLINE-Mitarbeiter leitet eine Anfrage für ein Datum weiter. " +
        "art = 'anderes' für alles andere: Antworten in einem bestehenden Verlauf, Angebote/Konditionen/Bestätigungen/Verträge von EVENTLINE, " +
        "Rechnungen, Programm/Veranstaltungen der Location selbst, Newsletter, Technik-Aufträge, Firmenanlässe ohne Vermietungsbezug. " +
        "sicherheit = 'eindeutig' NUR wenn klar eine neue private Mietanfrage, die Location eindeutig eine aus der Liste ist UND das Datum klar ist. " +
        "location_id = id aus der Liste oder ''. grund: kurz auf Deutsch (max. 100 Zeichen). " +
        "felder: aus Mail UND Anhang lesen (Formular-Felder: Datum & Mieter:innen, Telefon, Postadresse, Anlass, Beginn, Gäste, Catering, " +
        "Programm, Stellwand-Text, Kästchen Bier/Buffettisch/Vorhang offen/Tonanlage/DJ-Mischpult/Disco/Bühne-Licht, Poller Name/Mobil, " +
        "Komplettservice-Notiz, Bemerkungen). Angekreuzte Kästchen = 'ja', ausdrücklich nein = 'nein', sonst 'offen'; Text nicht genannt = ''. " +
        `Heute ist ${todayLocalIso()}.`,
      content: [
        {
          type: "text",
          text:
            `LOCATIONS (id | name):\n${liste}\n\n` +
            (partner ? `Der Absender ist das Partner-Konto der Location «${partner.name}» (${partner.id}).\n\n` : "") +
            `MAIL:\n${mailBlock(mail)}`,
        },
        ...anhangBloecke(opts.anhaenge),
      ],
      toolName: "anfrage_pruefen",
      toolDescription: "Meldet, ob die Mail eine neue Privatvermietungs-Anfrage ist, und liest die Felder.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["art", "sicherheit", "location_id", "grund", "felder"],
        properties: {
          art: { type: "string", enum: ["neue_anfrage", "anderes"] },
          sicherheit: { type: "string", enum: ["eindeutig", "wahrscheinlich", "unklar"] },
          location_id: { type: "string", description: "id aus der Liste oder \"\"" },
          grund: { type: "string" },
          felder: felderSchema(),
        },
      },
      maxTokens: 2000,
    });
    const locationId = erg.location_id && ids.has(erg.location_id) ? erg.location_id : null;
    return {
      neueAnfrage: erg.art === "neue_anfrage",
      sicherheit: erg.sicherheit,
      locationId,
      felder: felderAusKi(erg.felder, opts.gesperrteAdressen),
      grund: String(erg.grund ?? "").slice(0, 200),
    };
  } catch (e) {
    logError("ablauf.erkennung.anfrage", e);
    return null;
  }
}

// ── 2. Mail zu einem Auftrag mit Ablauf ──────────────────────────

export type MailEinordnung = { art: MailArt; grund: string; felder: Partial<AblaufFelder> };

type EinordnungKi = { art: MailArt; grund: string; felder: Record<string, unknown> };

export async function ordneAblaufMailEin(
  mail: ErkennungMail,
  kontext: {
    felder: AblaufFelder;
    erledigt: readonly SchrittNr[];
    fixiert: boolean;
    unterschrieben: boolean;
    location: string | null;
    gesperrteAdressen: readonly string[];
  },
): Promise<MailEinordnung | null> {
  if (!aiAvailable()) return null;
  const richtung = istEventlineAdresse(mail.von) ? "AUSGEHEND (von EVENTLINE an den Mieter o. a.)" : "EINGEHEND (an EVENTLINE)";
  const stand = [
    `Location: ${kontext.location ?? "?"}`,
    `Mieter: ${kontext.felder.mieter || "?"} · E-Mail: ${kontext.felder.email || "unbekannt"} · Datum: ${kontext.felder.datum || "?"}`,
    `Erledigte Schritte: ${kontext.erledigt.join(", ") || "keine"} (1 Konditionen, 2 Bestätigung, 3 Vertrag verschickt, 4 Vertrag unterschrieben, 5 Übergabe)`,
    `Datum fixiert (Zusage): ${kontext.fixiert ? "ja" : "nein"} · Vertrag unterschrieben: ${kontext.unterschrieben ? "ja" : "nein"}`,
  ].join("\n");
  try {
    const erg = await structuredCall<EinordnungKi>({
      system:
        "Du ordnest eine E-Mail zu einer Privatvermietung ein, die EVENTLINE (Basel) für eine Partner-Location betreut. " +
        "Ausgehende Mails von EVENTLINE (@eventline-basel.com) gehen in CC an den Auftrags-Eingang. " +
        "Massgebend ist NUR die NEUESTE Nachricht oben — zitierte frühere Mails darunter bestimmen die Art NICHT. Arten:\n" +
        "- konditionen_an_kunde: EVENTLINE schreibt dem Mieter Verfügbarkeit + Preise/Konditionen (Angebot).\n" +
        "- zusage_kunde: der Mieter sagt verbindlich zu / nimmt das Datum fix.\n" +
        "- bestaetigung_an_kunde: EVENTLINE bestätigt dem Mieter das Datum verbindlich (Vertrag folgt).\n" +
        "- vertrag_an_kunde: EVENTLINE schickt dem Mieter den Vertrag zum Unterschreiben (mit Anhängen).\n" +
        "- vertrag_unterschrieben: der Mieter schickt den unterschriebenen Vertrag zurück.\n" +
        "- felder_ergaenzung: jemand (Partner, Mieter, EVENTLINE) liefert Angaben zum Anlass nach (z. B. E-Mail, Gäste, Poller-Person), ohne eine der Arten oben.\n" +
        "- sonstiges: alles andere (Rückfragen, Infomail kurz vor dem Anlass, Rechnung, Dank, Organisatorisches).\n" +
        "Im Zweifel 'sonstiges' — eine falsche Einordnung ist schlimmer als keine. grund: kurz auf Deutsch (max. 100 Zeichen). " +
        "felder: nur Angaben zum Anlass, die in der NEUESTEN Nachricht ausdrücklich stehen (sonst '' bzw. 'offen'). Die E-Mail des Mieters " +
        "darfst du aus 'An' einer ausgehenden Mail an den Mieter nehmen, nie eine EVENTLINE- oder Location-Adresse. " +
        `Heute ist ${todayLocalIso()}.`,
      content: [{ type: "text", text: `STAND DES ABLAUFS:\n${stand}\n\nRICHTUNG: ${richtung}\n\nMAIL:\n${mailBlock(mail)}` }],
      toolName: "mail_einordnen",
      toolDescription: "Ordnet die Mail im Vermietungs-Ablauf ein und liest ergänzbare Felder.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["art", "grund", "felder"],
        properties: {
          art: { type: "string", enum: [...MAIL_ARTEN] },
          grund: { type: "string" },
          felder: felderSchema(),
        },
      },
      maxTokens: 1500,
    });
    const art: MailArt = MAIL_ARTEN.includes(erg.art) ? erg.art : "sonstiges";
    return { art, grund: String(erg.grund ?? "").slice(0, 200), felder: felderAusKi(erg.felder, kontext.gesperrteAdressen) };
  } catch (e) {
    logError("ablauf.erkennung.einordnung", e);
    return null;
  }
}
