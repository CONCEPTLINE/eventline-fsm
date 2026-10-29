/**
 * Vertrieb: Text einer Antwort-Mail lesbar machen — HTML → reiner Text,
 * zitierte eigene Mail weglassen. Rein (ohne Netz), getestet in
 * antwort-text.test.ts. Der Text wird nur angezeigt, nie gespeichert.
 */

const ENTITAETEN: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ss",
  eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", laquo: "«", raquo: "»",
  ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
};

function entitaeten(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (ganz, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ganz;
    }
    return ENTITAETEN[e] ?? ENTITAETEN[e.toLowerCase()] ?? ganz;
  });
}

/** HTML einer Mail → reiner Text mit Absätzen. */
export function htmlZuText(html: string): string {
  const text = html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return aufraeumen(entitaeten(text));
}

function aufraeumen(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((z) => z.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ZITAT_BEGINN = [
  /^-{2,}\s*(original|ursprüngliche)\s+(message|nachricht)/i,
  /^_{10,}\s*$/,
  /^(am|on|le|il)\s.{4,200}(schrieb|wrote|a écrit|ha scritto)[^:]*:\s*$/i,
];
const KOPF_VON = /^\*?(von|from|de|da)\s*:\*?\s/i;
const KOPF_FOLGE = /^\*?(gesendet|sent|envoyé|inviato|datum|date|an|to|betreff|subject)\s*:/i;

/** Zitierte Vorgänger-Mail(s) abschneiden und «>»-Zeilen weglassen. */
export function ohneZitat(text: string): string {
  const zeilen = aufraeumen(text).split("\n");
  let ende = zeilen.length;
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i].trim();
    if (ZITAT_BEGINN.some((re) => re.test(z))) { ende = i; break; }
    // Outlook-Kopf: «Von: …» gefolgt von «Gesendet:/Sent:/An:/Betreff:» in den nächsten Zeilen.
    if (KOPF_VON.test(z) && zeilen.slice(i + 1, i + 4).some((n) => KOPF_FOLGE.test(n.trim()))) { ende = i; break; }
  }
  const ohne = zeilen.slice(0, ende).filter((z) => !/^\s*>/.test(z)).join("\n");
  const ergebnis = aufraeumen(ohne);
  // Bleibt nichts übrig (nur Zitat), lieber den ganzen Text zeigen.
  return ergebnis || aufraeumen(text);
}

/** Mail-Body von Graph (uniqueBody bevorzugt) → lesbarer Text. */
export function antwortText(
  uniqueBody: { contentType?: string; content?: string } | null | undefined,
  body: { contentType?: string; content?: string } | null | undefined,
): string {
  const quelle = uniqueBody?.content?.trim() ? uniqueBody : body;
  const roh = quelle?.content ?? "";
  const text = quelle?.contentType?.toLowerCase() === "html" ? htmlZuText(roh) : roh;
  return ohneZitat(text);
}
