import { describe, expect, it, vi } from "vitest";
import { ordneMailZu, type AblaufBausteine } from "./ablauf";

/** Bausteine mit Standardwerten «nichts gefunden»; einzelne ueberschreibbar.
 *  `claim` simuliert die UNIQUE-Sperre auf resend_email_id. */
function bausteine(p: Partial<AblaufBausteine> = {}, claim = new Set<string>(), emailId = "mail-1") {
  const b: AblaufBausteine = {
    beanspruchen: vi.fn(async () => {
      if (claim.has(emailId)) return null;
      claim.add(emailId);
      return { id: "row-1" };
    }),
    freigeben: vi.fn(async () => {
      claim.delete(emailId);
    }),
    nummerJob: vi.fn(async () => null),
    verlauf: vi.fn(async () => ({ art: "keiner" as const })),
    kandidaten: vi.fn(async () => []),
    ki: vi.fn(async () => ({ jobId: null, vorschlaege: [] })),
    abgleich: vi.fn(() => []),
    ablegen: vi.fn(async () => ["item-1", "item-2"]),
    markiereZugeordnet: vi.fn(async () => undefined),
    speichereWartend: vi.fn(async () => undefined),
    meldeAbgelegt: vi.fn(async () => undefined),
    meldeWartet: vi.fn(async () => undefined),
    verarbeiten: vi.fn(async () => 2),
    ...p,
  };
  return b;
}

describe("ordneMailZu", () => {
  it("Nummer im Betreff → ablegen, markieren, melden, verarbeiten", async () => {
    const b = bausteine({ nummerJob: vi.fn(async () => "job-1") });
    const r = await ordneMailZu(b);
    expect(r).toEqual({ ergebnis: "zugeordnet", jobId: "job-1", via: "nummer", items: 2, verarbeitet: 2 });
    expect(b.verlauf).not.toHaveBeenCalled();
    expect(b.ki).not.toHaveBeenCalled();
    expect(b.markiereZugeordnet).toHaveBeenCalledWith("row-1", "job-1", "nummer");
    expect(b.meldeAbgelegt).toHaveBeenCalledTimes(1);
  });

  it("Folgemail im Verlauf → Auftrag des Verlaufs, ohne KI", async () => {
    const b = bausteine({ verlauf: vi.fn(async () => ({ art: "treffer" as const, jobId: "job-26327", grund: "header" as const })) });
    const r = await ordneMailZu(b);
    expect(r).toMatchObject({ ergebnis: "zugeordnet", jobId: "job-26327", via: "verlauf" });
    expect(b.ki).not.toHaveBeenCalled();
  });

  it("Verlauf widerspruechlich → nicht raten: wartet mit beiden Auftraegen, keine KI", async () => {
    const b = bausteine({ verlauf: vi.fn(async () => ({ art: "konflikt" as const, jobIds: ["job-1", "job-2"] })) });
    const r = await ordneMailZu(b);
    expect(r).toEqual({ ergebnis: "wartet", vorschlaege: 2 });
    expect(b.ki).not.toHaveBeenCalled();
    expect(b.ablegen).not.toHaveBeenCalled();
    expect(b.speichereWartend).toHaveBeenCalledWith("row-1", [
      { job_id: "job-1", grund: "Gleicher Mailverlauf", quelle: "verlauf" },
      { job_id: "job-2", grund: "Gleicher Mailverlauf", quelle: "verlauf" },
    ]);
  });

  it("KI eindeutig → zugeordnet via ki", async () => {
    const b = bausteine({ ki: vi.fn(async () => ({ jobId: "job-9", vorschlaege: [] })) });
    expect(await ordneMailZu(b)).toMatchObject({ ergebnis: "zugeordnet", jobId: "job-9", via: "ki" });
  });

  it("nicht zuordenbar → Mail wird ZUERST gesichert, dann gemeldet (mit Vorschlaegen)", async () => {
    const reihenfolge: string[] = [];
    const b = bausteine({
      ki: vi.fn(async () => ({ jobId: null, vorschlaege: [{ job_id: "job-5", grund: "Datum", quelle: "ki" as const }] })),
      abgleich: vi.fn(() => [{ job_id: "job-6", grund: "Location", quelle: "abgleich" as const }]),
      speichereWartend: vi.fn(async () => {
        reihenfolge.push("sichern");
      }),
      meldeWartet: vi.fn(async () => {
        reihenfolge.push("melden");
      }),
    });
    const r = await ordneMailZu(b);
    expect(r).toEqual({ ergebnis: "wartet", vorschlaege: 2 });
    expect(reihenfolge).toEqual(["sichern", "melden"]);
    expect(b.ablegen).not.toHaveBeenCalled();
    expect(b.meldeAbgelegt).not.toHaveBeenCalled();
  });

  it("Claude am Limit (KI liefert nichts) → wartet trotzdem, mit Abgleich-Vorschlag", async () => {
    const b = bausteine({ abgleich: vi.fn(() => [{ job_id: "job-6", grund: "Datum 18.12.2026", quelle: "abgleich" as const }]) });
    expect(await ordneMailZu(b)).toEqual({ ergebnis: "wartet", vorschlaege: 1 });
  });

  it("Mitteilung schlaegt fehl → Mail bleibt trotzdem gesichert, kein Fehler", async () => {
    const b = bausteine({ meldeWartet: vi.fn(async () => { throw new Error("push kaputt"); }) });
    expect(await ordneMailZu(b)).toEqual({ ergebnis: "wartet", vorschlaege: 0 });
    expect(b.speichereWartend).toHaveBeenCalledTimes(1);
  });

  it("Idempotenz: Webhook-Wiederholung derselben Mail tut nichts (keine zweite Mitteilung)", async () => {
    const claim = new Set<string>();
    const erst = bausteine({}, claim);
    const zweit = bausteine({}, claim);
    expect((await ordneMailZu(erst)).ergebnis).toBe("wartet");
    expect(await ordneMailZu(zweit)).toEqual({ ergebnis: "doppelt" });
    expect(zweit.meldeWartet).not.toHaveBeenCalled();
    expect(zweit.speichereWartend).not.toHaveBeenCalled();
    expect(zweit.nummerJob).not.toHaveBeenCalled();
  });

  it("Fehler beim Sichern → Sperre geloest, Fehler weitergereicht (Resend stellt neu zu)", async () => {
    const claim = new Set<string>();
    const b = bausteine({ speichereWartend: vi.fn(async () => { throw new Error("DB weg"); }) }, claim);
    await expect(ordneMailZu(b)).rejects.toThrow("DB weg");
    expect(b.freigeben).toHaveBeenCalledWith("row-1");
    // Wiederholung darf jetzt neu arbeiten:
    const nochmal = bausteine({}, claim);
    expect((await ordneMailZu(nochmal)).ergebnis).toBe("wartet");
  });
});

describe("ordneMailZu — Vermietungs-Ablauf", () => {
  it("keine Zuordnung → neuerAuftrag legt an, wird abgelegt + verarbeitet, keine Ablauf-Wirkung auf die eigene Mail", async () => {
    const nach = vi.fn(async () => undefined);
    const b = bausteine({ neuerAuftrag: vi.fn(async () => ({ jobId: "job-neu", via: "ablauf" as const })), nachZuordnung: nach });
    const r = await ordneMailZu(b);
    expect(r).toMatchObject({ ergebnis: "zugeordnet", jobId: "job-neu", via: "ablauf" });
    expect(b.neuerAuftrag).toHaveBeenCalledWith("row-1");
    expect(b.speichereWartend).not.toHaveBeenCalled();
    expect(nach).toHaveBeenCalledWith("job-neu", "row-1", "ablauf");
  });

  it("neuerAuftrag wirft → Mail wartet wie bisher", async () => {
    const b = bausteine({ neuerAuftrag: vi.fn(async () => { throw new Error("kaputt"); }) });
    const r = await ordneMailZu(b);
    expect(r).toEqual({ ergebnis: "wartet", vorschlaege: 0 });
    expect(b.speichereWartend).toHaveBeenCalledTimes(1);
  });

  it("Verlauf-Konflikt → kein neuer Auftrag", async () => {
    const b = bausteine({
      verlauf: vi.fn(async () => ({ art: "konflikt" as const, jobIds: ["job-1", "job-2"] })),
      neuerAuftrag: vi.fn(async () => ({ jobId: "job-neu", via: "ablauf" as const })),
    });
    await ordneMailZu(b);
    expect(b.neuerAuftrag).not.toHaveBeenCalled();
  });

  it("Nummer gefunden → kein neuer Auftrag; nachZuordnung vor der Verarbeitung, Fehler darin verschluckt", async () => {
    const reihenfolge: string[] = [];
    const b = bausteine({
      nummerJob: vi.fn(async () => "job-1"),
      neuerAuftrag: vi.fn(async () => null),
      nachZuordnung: vi.fn(async () => { reihenfolge.push("nach"); throw new Error("KI weg"); }),
      verarbeiten: vi.fn(async () => { reihenfolge.push("verarbeiten"); return 2; }),
    });
    const r = await ordneMailZu(b);
    expect(r).toMatchObject({ ergebnis: "zugeordnet", via: "nummer" });
    expect(b.neuerAuftrag).not.toHaveBeenCalled();
    expect(reihenfolge).toEqual(["nach", "verarbeiten"]);
  });
});

describe("ordneMailZu — Ablegen scheitert (L12)", () => {
  it("nach Neuanlage (via 'ablauf') wird der neue Auftrag verworfen, Sperre freigegeben, Fehler weitergereicht", async () => {
    const verwerfe = vi.fn(async () => undefined);
    const b = bausteine({
      neuerAuftrag: vi.fn(async () => ({ jobId: "job-neu", via: "ablauf" as const })),
      ablegen: vi.fn(async () => {
        throw new Error("Eingang-Insert fehlgeschlagen");
      }),
      verwerfeNeuenAuftrag: verwerfe,
    });
    await expect(ordneMailZu(b)).rejects.toThrow("Eingang-Insert");
    expect(verwerfe).toHaveBeenCalledWith("job-neu");
    expect(b.freigeben).toHaveBeenCalledWith("row-1");
    expect(b.markiereZugeordnet).not.toHaveBeenCalled();
  });

  it("bei bestehendem Auftrag (via 'ki') wird nichts verworfen", async () => {
    const verwerfe = vi.fn(async () => undefined);
    const b = bausteine({
      neuerAuftrag: vi.fn(async () => ({ jobId: "job-alt", via: "ki" as const })),
      ablegen: vi.fn(async () => {
        throw new Error("kaputt");
      }),
      verwerfeNeuenAuftrag: verwerfe,
    });
    await expect(ordneMailZu(b)).rejects.toThrow("kaputt");
    expect(verwerfe).not.toHaveBeenCalled();
    expect(b.freigeben).toHaveBeenCalledWith("row-1");
  });
});
