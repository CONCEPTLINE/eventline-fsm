// Getränke-Catering — Mailtext-Vorschlag an die Kundschaft (Antwort mit den zwei Varianten).
// Bewusst KEIN Versand aus dem FSM: Leo schickt Kundenmails von leo@ nach Prüfung des Textes (Mail-Regelwerk:
// Kunde im Zentrum, genau eine Ja/Nein-Frage, keine Aufzählungen, keine Ausrufezeichen). Der Text ist ein Vorschlag;
// Anrede wird von Hand gesetzt (Herr/Frau nie aus dem Vornamen raten), Grussformel und Signatur kommen vom Mailprogramm.

export interface MailtextDaten {
  anrede: string;
  /** z. B. «CD-Taufe». */
  anlass: string;
  /** z. B. «9. April 2027»; leer = ohne Datum. */
  datumText: string;
  gaeste: number;
  fixpreis: number;
  mindestumsatz: number;
  inbegriffen: number;
  getraenkeProGast: number;
  erwarteterUmsatz: number;
  du: boolean;
}

const chf = (n: number) => `CHF ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
const rund100 = (n: number) => Math.max(100, Math.round(n / 100) * 100);

export function mailtext(d: MailtextDaten): string {
  const am = d.datumText ? ` am ${d.datumText}` : "";
  const proGast = Math.max(1, Math.round(d.getraenkeProGast));
  const t = d.du
    ? {
        a: "übernimmst du die Getränke deiner Gäste selbst", b: "deine Gäste zahlen ihre Getränke selbst", c: "übernimmst du die Differenz, sonst zahlst du nichts",
        e: "Welche der beiden Varianten passt besser?", f: "Hier",
      }
    : {
        a: "übernehmen Sie die Getränke Ihrer Gäste selbst", b: "Ihre Gäste zahlen ihre Getränke selbst", c: "übernehmen Sie die Differenz, sonst zahlen Sie nichts",
        e: "Welche der beiden Varianten passt besser zu Ihrem Anlass?", f: "Hier",
      };
  return [
    d.anrede.trim() || "Guten Tag",
    "",
    `${t.f} die beiden Möglichkeiten für die Bar bei ${d.anlass}${am}, gerechnet mit ${d.gaeste} Gästen und einem Ausschank vor dem Programm, in der Pause und danach.`,
    "",
    `Bei Variante A ${t.a}. Dafür gilt ein Fixpreis von ${chf(d.fixpreis)}, in dem Getränke, Service und Ausschank enthalten sind. Eingerechnet sind ${d.inbegriffen} Getränke, das sind rund ${proGast} pro Gast, was darüber liegt, rechnen wir zu den Preisen der Karte ab.`,
    "",
    `Bei Variante B ${t.b}, zu den Preisen der beigelegten Getränkekarte. Wir müssen dabei mindestens ${chf(d.mindestumsatz)} Umsatz erreichen. Kommt weniger zusammen, ${t.c}. Bei normalem Konsum rechnen wir mit rund ${chf(rund100(d.erwarteterUmsatz))} Umsatz.`,
    "",
    `Die beiden Verträge und die Getränkekarte hängen als PDF an. ${t.e}`,
  ].join("\n");
}
