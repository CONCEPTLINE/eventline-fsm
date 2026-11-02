// Getränke-Catering — Mailtext-Vorschlag an die Kundschaft (Antwort mit den zwei Varianten).
// Bewusst KEIN Versand aus dem FSM: Kundenmails gehen vom eigenen Postfach, nachdem der Text geprüft wurde
// (Kunde im Zentrum, genau eine Ja/Nein-Frage, keine Aufzählungen, keine Ausrufezeichen). Der Text ist ein Vorschlag;
// die Anrede wird von Hand gesetzt (Herr/Frau nie aus dem Vornamen raten), Grussformel und Signatur kommen vom Mailprogramm.
// Kosten, Gewinn und Marge gehören nie in den Text.

export interface MailtextDaten {
  anrede: string;
  /** z. B. «CD-Taufe» (steht in Klammern hinter dem Datum). */
  anlass: string;
  /** z. B. «9. April 2027»; leer = ohne Datum. */
  datumText: string;
  gaeste: number;
  /** Variante A: Richtwert gesamt (Getränke zu Kartenpreisen + Service). */
  richtpreisA: number;
  /** Variante A: Stundensatz je Servicekraft (CHF). */
  stundensatzA: number;
  mindestumsatz: number;
  /** Variante A: erwartete Bestellmenge. */
  bestellmengeA: number;
  kraefte: number;
  getraenkeProGast: number;
  erwarteterUmsatz: number;
  du: boolean;
}

const chf = (n: number) => `CHF ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, "'")}`;
/** «rund»: unter CHF 1'000 auf 10, darüber auf 100 gerundet (nie über das hinaus, was ehrlich ist). */
const rund = (n: number) => (n < 1000 ? Math.round(n / 10) * 10 : Math.round(n / 100) * 100);

export function mailtext(d: MailtextDaten): string {
  const wann = d.datumText ? ` am ${d.datumText}` : "";
  const wofuer = `${wann} (${d.anlass})`.trim();
  const proGast = d.getraenkeProGast.toFixed(1);
  const deine = d.du ? "deiner" : "Ihrer";
  const t = d.du
    ? {
        a: "sagst du uns, welche Getränke wir bestellen sollen. Wir bringen sie mit, sie gehören dir und du zahlst sie zu den Preisen der Karte", b: "deine Gäste zahlen ihre Getränke selbst",
        c: "übernimmst du die Differenz", d: "zahlst du den ganzen Betrag von", n: "dann zahlst du nichts", u: "dann zahlst du die Differenz, das wären etwa",
        e: "Welche der beiden Varianten passt besser?",
      }
    : {
        a: "nennen Sie uns, welche Getränke wir bestellen sollen. Wir bringen sie mit, sie gehören Ihnen und Sie zahlen sie zu den Preisen der Karte", b: "Ihre Gäste zahlen ihre Getränke selbst",
        c: "übernehmen Sie die Differenz", d: "zahlen Sie den ganzen Betrag von", n: "dann zahlen Sie nichts", u: "dann zahlen Sie die Differenz, das wären etwa",
        e: "Welche der beiden Varianten passt besser zu Ihrem Anlass?",
      };
  // Nur versprechen, dass nichts zu zahlen ist, wenn der erwartete Umsatz den Mindestumsatz auch erreicht.
  const normal =
    d.erwarteterUmsatz >= d.mindestumsatz
      ? `Bei normalem Konsum rechnen wir mit rund ${chf(rund(d.erwarteterUmsatz))} Umsatz, ${t.n}.`
      : `Bei normalem Konsum rechnen wir mit rund ${chf(rund(d.erwarteterUmsatz))} Umsatz, ${t.u} ${chf(rund(d.mindestumsatz - d.erwarteterUmsatz))}.`;
  return [
    d.anrede.trim() || "Guten Tag",
    "",
    `Hier die beiden Möglichkeiten für die Bar${wofuer ? ` ${wofuer}` : ""}, gerechnet mit ${d.gaeste} Gästen und einem Ausschank vor dem Programm, in der Pause und danach.`,
    "",
    `Bei Variante A ${t.a}. Dazu kommen unsere ${d.kraefte} Servicekräfte zu CHF ${d.stundensatzA} pro Stunde und Kraft, für die ganze Einsatzzeit von Aufbau bis Abbau. Bei rund ${d.bestellmengeA} Getränken (rund ${proGast} pro Gast) sind das etwa ${chf(d.richtpreisA)}. Das ist ein Richtwert, abgerechnet wird nach ${deine} Bestellung und den geleisteten Stunden.`,
    "",
    `Bei Variante B ${t.b}, zu den Preisen der beigelegten Getränkekarte. Der Mindestumsatz beträgt ${chf(d.mindestumsatz)}. Kommt weniger zusammen, ${t.c}. Kauft kein Gast etwas, ${t.d} ${chf(d.mindestumsatz)}. ${normal}`,
    "",
    `Die beiden Verträge und die Getränkekarte hängen als PDF an. ${t.e}`,
  ].join("\n");
}
