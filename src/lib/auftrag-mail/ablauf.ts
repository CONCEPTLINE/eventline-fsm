// Ablauf einer Mail an auftrag@in.eventline-basel.com — als Funktion mit
// eingespeisten Bausteinen, damit Idempotenz und «nie verlieren» ohne
// echte DB/Resend/KI getestet werden koennen (ablauf.test.ts). Die echten
// Bausteine verdrahtet /api/inbound/mail.
//
// Reihenfolge der Zuordnung (erste sichere gewinnt):
//  1. Auftragsnummer im Betreff/Text
//  2. Verlauf (Header, sonst aussagekraeftiger Betreff) — bei Widerspruch
//     NICHT raten → warten mit den Auftraegen des Verlaufs als Vorschlag
//  3. KI, nur «eindeutig»
//  4. sonst: Mail wartet (Inhalt + Anhaenge bleiben) mit Vorschlaegen
//     aus KI + deterministischem Abgleich, Mitteilung mit Link zur Liste.

import type { VerlaufErgebnis } from "./verlauf";
import { vorschlaegeZusammen, type Vorschlag, type VorschlagKandidat } from "./vorschlaege";

export type Zuordnung = "nummer" | "verlauf" | "ki";

export type AblaufBausteine = {
  /** Mail fuer diesen Lauf sperren (UNIQUE resend_email_id). null = schon
   *  bekannt/in Arbeit → nichts tun (Webhook-Wiederholung). */
  beanspruchen(): Promise<{ id: string } | null>;
  /** Sperre loesen, wenn der Lauf scheitert (damit Resend neu zustellt). */
  freigeben(id: string): Promise<void>;
  nummerJob(): Promise<string | null>;
  verlauf(): Promise<VerlaufErgebnis>;
  kandidaten(): Promise<VorschlagKandidat[]>;
  ki(kandidaten: VorschlagKandidat[]): Promise<{ jobId: string | null; vorschlaege: Vorschlag[] }>;
  abgleich(kandidaten: VorschlagKandidat[]): Vorschlag[];
  /** Text + Anhaenge im Eingang ablegen → Element-IDs. */
  ablegen(jobId: string): Promise<string[]>;
  markiereZugeordnet(id: string, jobId: string, via: Zuordnung): Promise<void>;
  speichereWartend(id: string, vorschlaege: Vorschlag[]): Promise<void>;
  meldeAbgelegt(jobId: string, via: Zuordnung): Promise<void>;
  meldeWartet(vorschlaege: Vorschlag[]): Promise<void>;
  verarbeiten(jobId: string, itemIds: string[]): Promise<number>;
};

export type AblaufErgebnis =
  | { ergebnis: "doppelt" }
  | { ergebnis: "zugeordnet"; jobId: string; via: Zuordnung; items: number; verarbeitet: number }
  | { ergebnis: "wartet"; vorschlaege: number };

export async function ordneMailZu(b: AblaufBausteine): Promise<AblaufErgebnis> {
  const sperre = await b.beanspruchen();
  if (!sperre) return { ergebnis: "doppelt" };

  try {
    let jobId: string | null = await b.nummerJob();
    let via: Zuordnung | null = jobId ? "nummer" : null;
    let vorschlaege: Vorschlag[] = [];

    if (!jobId) {
      const v = await b.verlauf();
      if (v.art === "treffer") {
        jobId = v.jobId;
        via = "verlauf";
      } else {
        const kandidaten = await b.kandidaten().catch(() => [] as VorschlagKandidat[]);
        const verlaufVorschlaege: Vorschlag[] =
          v.art === "konflikt" ? v.jobIds.map((id) => ({ job_id: id, grund: "Gleicher Mailverlauf", quelle: "verlauf" as const })) : [];
        let kiVorschlaege: Vorschlag[] = [];
        if (v.art !== "konflikt") {
          const ki = await b.ki(kandidaten);
          if (ki.jobId) {
            jobId = ki.jobId;
            via = "ki";
          }
          kiVorschlaege = ki.vorschlaege;
        }
        if (!jobId) vorschlaege = vorschlaegeZusammen([verlaufVorschlaege, kiVorschlaege, b.abgleich(kandidaten)]);
      }
    }

    if (!jobId || !via) {
      // Zuerst sichern, dann melden — die Mail darf nie verloren gehen.
      await b.speichereWartend(sperre.id, vorschlaege);
      await b.meldeWartet(vorschlaege).catch(() => undefined);
      return { ergebnis: "wartet", vorschlaege: vorschlaege.length };
    }

    const itemIds = await b.ablegen(jobId);
    await b.markiereZugeordnet(sperre.id, jobId, via);
    await b.meldeAbgelegt(jobId, via).catch(() => undefined);
    const verarbeitet = await b.verarbeiten(jobId, itemIds);
    return { ergebnis: "zugeordnet", jobId, via, items: itemIds.length, verarbeitet };
  } catch (e) {
    await b.freigeben(sperre.id).catch(() => undefined);
    throw e;
  }
}
