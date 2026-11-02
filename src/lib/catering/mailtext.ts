// Getränke-Catering — Mailtext-Vorschlag an die Kundschaft (Antwort mit den zwei Varianten).
// Bewusst KEIN Versand aus dem FSM: Leo schickt Kundenmails von leo@ nach Prüfung des Textes (Mail-Regelwerk:
// Kunde im Zentrum, genau eine Ja/Nein-Frage, keine Aufzählungen, keine Ausrufezeichen). Der Text ist ein Vorschlag;
// Anrede wird von Hand gesetzt (Herr/Frau nie aus dem Vornamen raten), Grussformel und Signatur kommen vom Mailprogramm.

export interface MailtextDaten {
  anrede: string;
  /** z. B. «CD-Taufe» (steht in Klammern hinter dem Datum). */
  anlass: string;
  /** z. B. «9. April 2027»; leer = ohne Datum. */
  datumText: string;
  gaeste: number;
  /** Variante A: Richtwert gesamt (Getränke zu Kartenpreisen + Service). */
  richtpreisA: number;
  mindestumsatz: number;
  /** Variante A: erwartete Bestellmenge. */
  bestellmengeA: number;
  kraefte: number;
  getraenkeProGast: number;
  erwarteterUmsatz: number;
  du: boolean;
}

import { STUNDENSATZ_A } from "./rechnen";

const chf = (n: number) => `CHF ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
const rund100 = (n: number) => Math.max(100, Math.round(n / 100) * 100);

export function mailtext(d: MailtextDaten): string {
  const wann = d.datumText ? ` am ${d.datumText}` : "";
  const wofuer = `${wann} (${d.anlass})`.trim();
  const proGast = Math.max(1, Math.round(d.getraenkeProGast));
  const t = d.du
    ? {
        a: "sagst du uns, welche Getränke wir bestellen sollen. Wir bringen sie mit, sie gehören dir und du zahlst sie zu den Preisen der Karte", b: "deine Gäste zahlen ihre Getränke selbst", c: "übernimmst du die Differenz", d: "zahlst du den ganzen Betrag von", n: "dann zahlst du nichts",
        e: "Welche der beiden Varianten passt besser?", f: "Hier",
      }
    : {
        a: "nennen Sie uns, welche Getränke wir bestellen sollen. Wir bringen sie mit, sie gehören Ihnen und Sie zahlen sie zu den Preisen der Karte", b: "Ihre Gäste zahlen ihre Getränke selbst", c: "übernehmen Sie die Differenz", d: "zahlen Sie den ganzen Betrag von", n: "dann zahlen Sie nichts",
        e: "Welche der beiden Varianten passt besser zu Ihrem Anlass?", f: "Hier",
      };
  return [
    d.anrede.trim() || "Guten Tag",
    "",
    `${t.f} die beiden Möglichkeiten für die Bar ${wofuer}, gerechnet mit ${d.gaeste} Gästen und einem Ausschank vor dem Programm, in der Pause und danach.`,
    "",
    `Bei Variante A ${t.a}. Dazu kommen unsere ${d.kraefte} Servicekräfte zu CHF ${STUNDENSATZ_A} pro Stunde und Kraft, für die ganze Einsatzzeit von Aufbau bis Abbau. Bei rund ${d.bestellmengeA} Getränken (rund ${proGast} pro Gast) sind das etwa ${chf(d.richtpreisA)}.`,
    "",
    `Bei Variante B ${t.b}, zu den Preisen der beigelegten Getränkekarte. Wir müssen dabei mindestens ${chf(d.mindestumsatz)} Umsatz erreichen. Kommt weniger zusammen, ${t.c}. Kauft kein Gast etwas, ${t.d} ${chf(d.mindestumsatz)}. Bei normalem Konsum rechnen wir mit rund ${chf(rund100(d.erwarteterUmsatz))} Umsatz, ${t.n}.`,
    "",
    `Die beiden Verträge und die Getränkekarte hängen als PDF an. ${t.e}`,
  ].join("\n");
}
