import { describe, expect, it } from "vitest";
import {
  auftragsNummernAus,
  betreffAussagekraeftig,
  entscheideVerlauf,
  konversationAusThreadIndex,
  mailIdsAusHeader,
  mailMerkmale,
  normalisiereBetreff,
  type BekannteMail,
  type MailMerkmale,
} from "./verlauf";

describe("normalisiereBetreff", () => {
  it("entfernt AW:/WG:/RE:/FW:/Fwd:-Ketten, gross/klein, Leerzeichen", () => {
    expect(normalisiereBetreff("WG: AW: AW: Semi-Circle in Bau3 - Samstag 31. Oktober")).toBe("semi-circle in bau3 - samstag 31. oktober");
    expect(normalisiereBetreff("WG: AW:  AW: AW: AW: Semi-Circle   in Bau3 - Samstag 31. Oktober")).toBe("semi-circle in bau3 - samstag 31. oktober");
    expect(normalisiereBetreff("Re: Fwd: FW: re: Offerte Sommerfest")).toBe("offerte sommerfest");
    expect(normalisiereBetreff("AW[2]: RE(3): Antw: Test-Anlass")).toBe("test-anlass");
    expect(normalisiereBetreff("[EXTERN] AW: Konzert im Stadtcasino")).toBe("konzert im stadtcasino");
    expect(normalisiereBetreff("TR : Wtr: Demande")).toBe("demande");
  });
  it("laesst Woerter, die nur mit re/aw beginnen, stehen", () => {
    expect(normalisiereBetreff("Rechnung Mai")).toBe("rechnung mai");
    expect(normalisiereBetreff("Awards Night")).toBe("awards night");
  });
  it("leer bleibt leer", () => {
    expect(normalisiereBetreff(null)).toBe("");
    expect(normalisiereBetreff("AW: ")).toBe("");
  });
});

describe("betreffAussagekraeftig", () => {
  it("generische Betreffs tragen keinen Verlauf", () => {
    expect(betreffAussagekraeftig(normalisiereBetreff("AW: AW: Angebot"))).toBe(false);
    expect(betreffAussagekraeftig("offerte anfrage")).toBe(false);
    expect(betreffAussagekraeftig("ihre anfrage")).toBe(false);
  });
  it("spezifische Betreffs schon", () => {
    expect(betreffAussagekraeftig("semi-circle in bau3 - samstag 31. oktober")).toBe(true);
    expect(betreffAussagekraeftig("konzert im stadtcasino basel am 18. dezember 2026")).toBe(true);
  });
});

describe("Header", () => {
  it("liest Message-IDs aus References/In-Reply-To (klein, ohne Doppelte)", () => {
    expect(mailIdsAusHeader("<A@x.com> <b@y.ch>\r\n <a@x.com>")).toEqual(["<a@x.com>", "<b@y.ch>"]);
    expect(mailIdsAusHeader(undefined)).toEqual([]);
  });
  it("Thread-Index → erste 22 Byte als Konversation", () => {
    const basis = Buffer.alloc(22, 7);
    const a = Buffer.concat([basis, Buffer.from([1, 2, 3, 4, 5])]).toString("base64");
    const b = Buffer.concat([basis, Buffer.from([9, 9, 9, 9, 9, 9, 9, 9, 9, 9])]).toString("base64");
    expect(konversationAusThreadIndex(a)).toBe(konversationAusThreadIndex(b));
    expect(konversationAusThreadIndex(a)).toHaveLength(44);
    expect(konversationAusThreadIndex("kurz")).toBeNull();
    expect(konversationAusThreadIndex(undefined)).toBeNull();
  });
  it("mailMerkmale nimmt Resend-Header case-insensitiv", () => {
    const m = mailMerkmale({
      subject: "AW: Semi-Circle in Bau3",
      message_id: "<NEU@mail.ch>",
      headers: { "In-Reply-To": "<alt@mail.ch>", references: "<ur@mail.ch> <alt@mail.ch>", "thread-index": Buffer.alloc(30, 3).toString("base64") },
    });
    expect(m.messageId).toBe("<neu@mail.ch>");
    expect(m.referenzen).toEqual(["<alt@mail.ch>", "<ur@mail.ch>"]);
    const viele = mailMerkmale({ subject: "x", headers: { references: Array.from({ length: 60 }, (_, i) => `<m${i}@x>`).join(" ") } });
    expect(viele.referenzen).toHaveLength(40);
    expect(viele.referenzen[0]).toBe("<m59@x>");
    expect(m.konversation).toBe("03".repeat(22));
    expect(m.betreffNorm).toBe("semi-circle in bau3");
  });
});

describe("entscheideVerlauf", () => {
  const jetzt = new Date("2026-10-22T12:00:00Z");
  const neu = (p: Partial<MailMerkmale>): MailMerkmale => ({ messageId: "<neu@x>", referenzen: [], konversation: null, betreffNorm: "", ...p });
  const bekannt = (p: Partial<BekannteMail>): BekannteMail => ({
    id: Math.random().toString(36),
    job_id: "job-1",
    message_id: null,
    referenzen: [],
    konversation: null,
    betreff_norm: null,
    empfangen_am: "2026-10-20T08:00:00Z",
    ...p,
  });

  it("References auf eine zugeordnete Mail → deren Auftrag", () => {
    const r = entscheideVerlauf(neu({ referenzen: ["<alt@x>"] }), [bekannt({ message_id: "<alt@x>" })], jetzt);
    expect(r).toEqual({ art: "treffer", jobId: "job-1", grund: "header" });
  });
  it("auch rueckwaerts: eine zugeordnete Mail verweist auf die neue", () => {
    const r = entscheideVerlauf(neu({}), [bekannt({ referenzen: ["<neu@x>"] })], jetzt);
    expect(r).toMatchObject({ art: "treffer", jobId: "job-1" });
  });
  it("gleiche Outlook-Konversation → Treffer", () => {
    const r = entscheideVerlauf(neu({ konversation: "abc" }), [bekannt({ konversation: "abc", job_id: "job-7" })], jetzt);
    expect(r).toMatchObject({ art: "treffer", jobId: "job-7" });
  });
  it("Header zeigen auf zwei Auftraege → Konflikt, nicht raten", () => {
    const r = entscheideVerlauf(
      neu({ referenzen: ["<a@x>", "<b@x>"] }),
      [bekannt({ message_id: "<a@x>", job_id: "job-1" }), bekannt({ message_id: "<b@x>", job_id: "job-2" })],
      jetzt,
    );
    expect(r.art).toBe("konflikt");
    if (r.art === "konflikt") expect(r.jobIds.sort()).toEqual(["job-1", "job-2"]);
  });
  it("Header schlagen den Betreff", () => {
    const r = entscheideVerlauf(
      neu({ referenzen: ["<a@x>"], betreffNorm: "semi-circle in bau3" }),
      [bekannt({ message_id: "<a@x>", job_id: "job-1" }), bekannt({ betreff_norm: "semi-circle in bau3", job_id: "job-2" })],
      jetzt,
    );
    expect(r).toMatchObject({ art: "treffer", jobId: "job-1", grund: "header" });
  });
  it("aussagekraeftiger Betreff im Zeitfenster → Treffer", () => {
    const r = entscheideVerlauf(neu({ betreffNorm: "semi-circle in bau3" }), [bekannt({ betreff_norm: "semi-circle in bau3" })], jetzt);
    expect(r).toEqual({ art: "treffer", jobId: "job-1", grund: "betreff" });
  });
  it("Betreff ausserhalb des Fensters oder generisch → keiner", () => {
    expect(
      entscheideVerlauf(neu({ betreffNorm: "semi-circle in bau3" }), [bekannt({ betreff_norm: "semi-circle in bau3", empfangen_am: "2026-05-01T08:00:00Z" })], jetzt),
    ).toEqual({ art: "keiner" });
    expect(entscheideVerlauf(neu({ betreffNorm: "angebot" }), [bekannt({ betreff_norm: "angebot" })], jetzt)).toEqual({ art: "keiner" });
  });
  it("gleicher Betreff in zwei Auftraegen → Konflikt", () => {
    const r = entscheideVerlauf(
      neu({ betreffNorm: "semi-circle in bau3" }),
      [bekannt({ betreff_norm: "semi-circle in bau3", job_id: "job-1" }), bekannt({ betreff_norm: "semi-circle in bau3", job_id: "job-2" })],
      jetzt,
    );
    expect(r.art).toBe("konflikt");
  });
  it("nicht zugeordnete (wartende) Mails zaehlen nicht", () => {
    expect(entscheideVerlauf(neu({ referenzen: ["<a@x>"] }), [bekannt({ message_id: "<a@x>", job_id: null })], jetzt)).toEqual({ art: "keiner" });
  });
});

describe("auftragsNummernAus", () => {
  it("nur 26xxx, Reihenfolge des Auftretens", () => {
    expect(auftragsNummernAus("INT-26327 und 26101, nicht 25013")).toEqual([26327, 26101]);
    expect(auftragsNummernAus("int 26327")).toEqual([26327]);
  });
});
