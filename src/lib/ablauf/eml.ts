// Privatvermietung barakuba — Outlook-Entwürfe als .eml (RFC 5322 / MIME) und die Mail-Texte je Schritt.
//
// «In Outlook öffnen» lädt eine .eml mit `X-Unsent: 1`: Outlook öffnet sie als bearbeitbaren ENTWURF, es wird
// nie etwas aus der App verschickt. An = Kunde, CC = auftrag@in.eventline-basel.com (damit die Antwort- und
// Ausgangsmails im Auftrag landen und die Erkennung die Schritte setzt). Aufbau: multipart/mixed mit
// multipart/alternative (Text + HTML) und den Anhängen (base64, Zeilen ≤ 76). Betreff/Dateinamen UTF-8 nach
// RFC 2047 bzw. RFC 2231. Texte 1:1 aus der freigegebenen Skizze (eml.ts/panels.tsx), Signatur Tahoma 10pt.
// Rein (keine Server-Imports, kein Buffer) — nutzbar in Route und UI (Vorschau).
import { plusTage } from "@/lib/swiss-time";
import { AUFTRAG_MAIL, UEBERGABE_STANDARD, type AblaufFelder } from "./typen";

/** Konditionen Privatanlass barakuba (Basils Preisliste «2026 Das barakuba mieten», Vertragsvorlage). */
export const KONDITIONEN = {
  raummiete: 1200,
  disco: 200,
  buehneLicht: 300,
  bierProFlasche: 2.5,
  kaffeeProTab: 1.5,
  glas: 5,
  zusatzaufwandProStunde: 100,
} as const;

export type EmlArt = "konditionen" | "bestaetigung" | "vertrag" | "infomail";
export const EML_ARTEN: readonly EmlArt[] = ["konditionen", "bestaetigung", "vertrag", "infomail"];

export type EmlAnhang = { name: string; bytes: Uint8Array; typ?: string };

export type MailText = { betreff: string; html: string; dateiname: string };

export type Entwurf = MailText & { an: string; cc?: string[]; anhaenge?: EmlAnhang[] };

// ─── Kodierung ─────────────────────────────────────────────────────────

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
  let aus = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    aus += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    aus += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + "==";
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    aus += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + "=";
  }
  return aus;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** base64 in Zeilen zu 76 Zeichen (RFC 2045). */
function base64Zeilen(bytes: Uint8Array): string {
  const b = base64(bytes);
  const zeilen: string[] = [];
  for (let i = 0; i < b.length; i += 76) zeilen.push(b.slice(i, i + 76));
  return zeilen.join("\r\n");
}

const nurAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** Kopfzeilen-Wert nach RFC 2047 (B-Kodierung), in Stücke ≤ 75 Zeichen gefaltet; ASCII bleibt lesbar. */
function kopfWert(s: string): string {
  const sauber = s.replace(/[\r\n]+/g, " ");
  if (nurAscii(sauber)) return sauber;
  const stuecke: string[] = [];
  let aktuell = "";
  for (const ch of sauber) {
    // 39 Bytes → 52 base64-Zeichen + 12 Rahmen = 64; mit «Subject: » ≤ 76 je Zeile. Zeichen nie zerteilen
    if (utf8(aktuell + ch).length > 39) {
      stuecke.push(aktuell);
      aktuell = ch;
    } else aktuell += ch;
  }
  if (aktuell) stuecke.push(aktuell);
  return stuecke.map((t) => `=?UTF-8?B?${base64(utf8(t))}?=`).join("\r\n ");
}

/** Dateiname-Parameter: ASCII direkt; sonst RFC 2047 im Parameter (so schreibt es Outlook selbst) plus
 *  RFC 2231 (filename*) für strenge Programme. Umlaute bleiben so überall erhalten. */
function dateiParameter(name: string): { typ: string; disposition: string } {
  const sauber = name.replace(/["\\\r\n]/g, "_");
  if (nurAscii(sauber)) return { typ: `name="${sauber}"`, disposition: `filename="${sauber}"` };
  const kodiert = `=?UTF-8?B?${base64(utf8(sauber))}?=`;
  const prozent = encodeURIComponent(sauber).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    typ: `name="${kodiert}"`,
    disposition: `filename="${kodiert}";\r\n filename*=UTF-8''${prozent}`,
  };
}

function grenze(): string {
  let z = "";
  for (let i = 0; i < 24; i++) z += B64[Math.floor(Math.random() * 62)];
  return `----=_barakuba_${z}`;
}

/** HTML-Mailtext → schlichter Text-Teil (für Programme ohne HTML). */
export function htmlZuText(html: string): string {
  return html
    .replace(/\r?\n/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/(p|li|ul|div|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ganze .eml als Text (CRLF). `jetzt` nur für Tests. */
export function baueEml(e: Entwurf, jetzt: Date = new Date()): string {
  const mixed = grenze();
  const alt = grenze();
  const cc = e.cc ?? [AUFTRAG_MAIL];
  const body = `<!doctype html><html><head><meta charset="utf-8"></head><body style="font-family:Tahoma,Arial,sans-serif;font-size:10pt">${e.html}</body></html>`;

  const kopf = [
    e.an.trim() ? `To: ${e.an.trim()}` : null,
    cc.length > 0 ? `Cc: ${cc.join(", ")}` : null,
    `Subject: ${kopfWert(e.betreff)}`,
    `Date: ${jetzt.toUTCString()}`,
    "X-Unsent: 1",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed;
 boundary="${mixed}"`,
  ].filter((z): z is string => z !== null);

  const teile: string[] = [
    `--${mixed}`,
    `Content-Type: multipart/alternative;
 boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Zeilen(utf8(htmlZuText(e.html))),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Zeilen(utf8(body)),
    `--${alt}--`,
  ];
  for (const a of e.anhaenge ?? []) {
    const p = dateiParameter(a.name);
    teile.push(
      `--${mixed}`,
      `Content-Type: ${a.typ ?? "application/pdf"};\r\n ${p.typ}`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment;\r\n ${p.disposition}`,
      "",
      base64Zeilen(a.bytes),
    );
  }
  teile.push(`--${mixed}--`, "");
  return `${kopf.join("\r\n")}\r\n\r\n${teile.join("\r\n")}`;
}

// ─── Mail-Texte (Skizze, freigegeben) ──────────────────────────────────

const TZ = "Europe/Zurich";

function chf(n: number): string {
  const ganz = Number.isInteger(n);
  return `CHF ${new Intl.NumberFormat("de-CH", { minimumFractionDigits: ganz ? 0 : 2, maximumFractionDigits: 2 }).format(n)}`;
}

/** «Fr., 27.11.2026» (Wochentag kurz) wie die Skizze; Tag ohne Uhrzeit, Mittag gegen Zeitzonen-Sprünge. */
function datumLang(isoTag: string): string {
  const d = new Date(`${isoTag}T12:00:00Z`);
  if (!isoTag || Number.isNaN(d.getTime())) return "(Datum offen)";
  return new Intl.DateTimeFormat("de-CH", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
}

/** Nutzereingaben für HTML maskieren. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function vorname(f: AblaufFelder): string {
  const n = f.mieter.trim();
  return esc(n.split(/\s+/)[0] || n);
}

function gruss(absender: string): string {
  return `<p>Liebe Grüsse<br>${esc(absender.trim() || "EVENTLINE")}<br>EVENTLINE GmbH</p>`;
}

/** «Konditionen_barakuba_2026-11-27_Muster.eml» — nur ASCII. */
function emlName(art: string, f: AblaufFelder): string {
  const name = (f.mieter.trim().split(/\s+/).pop() ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9-]+/g, "");
  const tag = /^\d{4}-\d{2}-\d{2}$/.test(f.datum) ? `_${f.datum}` : "";
  return `${art}_barakuba${tag}${name ? `_${name}` : ""}.eml`;
}

export function konditionenMail(f: AblaufFelder, absender: string): MailText {
  const tag = datumLang(f.datum);
  return {
    betreff: `Dein Fest im barakuba am ${tag} – Konditionen`,
    dateiname: emlName("Konditionen", f),
    html: `<p>Liebe ${vorname(f)}</p>
<p>Vielen Dank für deine Anfrage – der ${tag} ist im barakuba noch frei. Gerne die Konditionen:</p>
<ul>
<li>Raummiete pauschal ${chf(KONDITIONEN.raummiete)} (ca. 14:00 bis Folgetag 12:00, max. 80 Gäste)</li>
<li>Disco ${chf(KONDITIONEN.disco)}</li>
<li>Bühne und Licht ${chf(KONDITIONEN.buehneLicht)}</li>
<li>Bier ${chf(KONDITIONEN.bierProFlasche)} pro Flasche, nach Konsum</li>
</ul>
<p>Passt das für dich? Dann bestätigen wir dir das Datum fix und schicken dir den Vertrag.</p>${gruss(absender)}`,
  };
}

export function bestaetigungMail(f: AblaufFelder, absender: string): MailText {
  const tag = datumLang(f.datum);
  return {
    betreff: `Bestätigung: Dein Fest im barakuba am ${tag}`,
    dateiname: emlName("Bestaetigung", f),
    html: `<p>Liebe ${vorname(f)}</p>
<p>Hiermit bestätigen wir dir den ${tag} fix für dein ${esc(f.anlass.trim() || "Fest")} im barakuba.</p>
<p>In den nächsten Tagen erhältst du den Vertrag zum Unterschreiben, zusammen mit dem Infoblatt, der Checkliste und dem Poller-Merkblatt.</p>${gruss(absender)}`,
  };
}

export function vertragMail(f: AblaufFelder, absender: string): MailText {
  const tag = datumLang(f.datum);
  const poller = f.pollerName.trim()
    ? `<p>Für die Zufahrt schalten wir die Mobilnummer von ${esc(f.pollerName.trim())}${f.pollerMobil.trim() ? ` (${esc(f.pollerMobil.trim())})` : ""} für den ${tag} frei.</p>`
    : "<p>Für die Zufahrt brauchen wir noch Name und Mobilnummer der Person, die am Poller einfährt – die Nummer schalten wir dann für den Tag frei.</p>";
  return {
    betreff: `Vertrag für Dein Fest im barakuba am ${tag}`,
    dateiname: emlName("Vertrag", f),
    html: `<p>Liebe ${vorname(f)}</p>
<p>Anbei der Vertrag für dein Fest am ${tag}. Bitte unterschreiben und an uns zurückschicken (Scan oder Foto genügt).</p>
<p>Ebenfalls angehängt: das Infoblatt «Informationen für Privatvermietungen», die Checkliste (Vertragsbestandteil) und das Poller-Merkblatt für die Zufahrt (Einfahrt Süd).</p>
${poller}${gruss(absender)}`,
  };
}

export type InfoPerson = { name: string; telefon: string | null };

/** Vorname aus dem vollen Profilnamen — so erscheinen Absender und Übergabe-Person in den Mails. */
export const vornameVon = (voll: string | null | undefined): string => (voll ?? "").trim().split(/\s+/)[0] ?? "";

/** Übergabe-Fenster «14:00»–«15:00» aus uebergabe_start (ISO) bzw. Standard 14:00, 1 h. */
export function uebergabeFenster(start: string | null | undefined): { von: string; bis: string } {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat("de-CH", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  const d = start ? new Date(start) : null;
  if (d && !Number.isNaN(d.getTime())) {
    return { von: fmt(d), bis: fmt(new Date(d.getTime() + UEBERGABE_STANDARD.dauerMin * 60_000)) };
  }
  const { stunde, minute, dauerMin } = UEBERGABE_STANDARD;
  const ende = stunde * 60 + minute + dauerMin;
  const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
  return { von: hhmm(stunde * 60 + minute), bis: hhmm(ende) };
}

export function infoMail(f: AblaufFelder, absender: string, person: InfoPerson | null, von: string, bis: string): MailText {
  const tag = datumLang(f.datum);
  const folgetag = f.datum ? datumLang(plusTage(f.datum, 1)) : "(Datum offen)";
  const wer = person ? `${esc(person.name)}${person.telefon ? ` (${esc(person.telefon)})` : ""}` : "jemandem von uns";
  const nummer = f.pollerMobil.trim() ? `Die Nummer ${esc(f.pollerMobil.trim())} ist` : "Die vereinbarte Mobilnummer ist";
  return {
    betreff: "In einer Woche ist es so weit – Infos zu deinem Fest im barakuba",
    dateiname: emlName("Infomail", f),
    html: `<p>Liebe ${vorname(f)}</p>
<p>In einer Woche ist es so weit – wir freuen uns sehr auf dein Fest im barakuba!</p>
<p><b>Übergabe:</b> ${tag}, ${esc(von)}–${esc(bis)} Uhr mit ${wer}.<br>
<b>Rückgabe:</b> ${folgetag}, 12:00 Uhr – den Schlüssel bitte in den Briefkasten beim Poller.</p>
<p><b>Zufahrt:</b> ${nummer} für den ${tag} freigeschaltet. Einfahrt Süd: von dieser Nummer +41 76 452 74 18 anrufen (Rufnummer muss angezeigt werden) oder über die App «PalGate». Die Ausfahrt öffnet automatisch. Bitte nur für Anlieferung, max. 15 Minuten pro Auto, Schritttempo, nicht parkieren.</p>
<p><b>Bitte mitbringen:</b> Geschirrtücher, Lappen, Bebbi-Säcke.</p>
<p><b>Wichtig:</b> drinnen nicht rauchen · bei Disco ab 23 Uhr Hoftür geschlossen halten · keine Autos und keine Foodtrucks auf dem Areal · Rücksicht auf die Kletterhalle.</p>
<p>Die Checkliste und das Infoblatt hängen wir dir nochmals an.</p>${gruss(absender)}`,
  };
}
