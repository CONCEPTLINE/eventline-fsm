import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  endeGesperrtMeldung,
  istLang,
  LANG_STUNDEN,
  stempelFehlerArt,
  stempelFehlerText,
  stempelMeldung,
  stempelSpanne,
  ueberlappungAusDetails,
  ueberlappungsMeldung,
} from "./stempel-meldungen";
import { STEMPEL_LANG_STUNDEN } from "./lohn/stempel-pruefung";
import { TIME_ENTRY_LOCK_MESSAGE } from "./time-lock";

const JETZT = new Date("2026-10-29T10:00:00Z");

// Echte Meldungen der Datenbank (Migrationen 055, 214, 364, 367, 368, apply_ticket 215).
const UEBERLAPPUNG = {
  code: "23P01",
  message: 'conflicting key value violates exclusion constraint "time_entries_keine_ueberlappung"',
  details:
    "Key (user_id, tstzrange(clock_in, COALESCE(clock_out, 'infinity'::timestamp with time zone), '[)'::text))=(a0000000-0000-4000-8000-000000000017, [\"2026-10-01 09:00:00+00\",\"2026-10-01 10:00:00+00\")) conflicts with existing key (user_id, tstzrange(clock_in, COALESCE(clock_out, 'infinity'::timestamp with time zone), '[)'::text))=(a0000000-0000-4000-8000-000000000017, [\"2026-10-01 08:00:00+00\",\"2026-10-01 14:00:00+00\")).",
};
const UEBERLAPPUNG_OFFEN = {
  ...UEBERLAPPUNG,
  details:
    "Key (user_id, tstzrange(…))=(a0000000-0000-4000-8000-000000000012, [\"2026-10-29 07:00:00+00\",infinity)) conflicts with existing key (user_id, tstzrange(…))=(a0000000-0000-4000-8000-000000000012, [\"2027-01-29 07:00:00.5+00\",infinity)).",
};
const LANG = { code: "P0001", message: "time_entries: Stempel über 16 Stunden brauchen eine Begründung (Endzeit prüfen)" };
const ANTRAG = {
  code: "P0001",
  message: "time_entries: die Änderung betrifft abgerechnete Monate (ab 10.09.2026) — nur per Antrag mit Begründung, den eine zweite Person bestätigt (Vier Augen)",
};
const LOESCHEN = { code: "P0001", message: "time_entries: Stempel in abgerechneten Monaten sind nicht löschbar" };
const TICKET = { code: "P0001", message: "Ticket kann nicht angewendet werden: Zeitraum bereits abgerechnet." };
const RLS = { code: "42501", message: 'new row violates row-level security policy for table "time_entries"' };
const OFFEN = { code: "23505", message: 'duplicate key value violates unique constraint "time_entries_one_active_per_user"' };
const FELDER = { code: "P0001", message: "time_entries: «geprüft» und «Altfall» setzt nur die Lohnverwaltung" };
const KONTEXT = { code: "23514", message: 'new row for relation "time_entries" violates check constraint "time_entries_job_or_project_or_description"' };

describe("stempelFehlerArt", () => {
  it("erkennt alle Fälle", () => {
    expect(stempelFehlerArt(UEBERLAPPUNG)).toBe("ueberlappung");
    expect(stempelFehlerArt(LANG)).toBe("lang");
    expect(stempelFehlerArt(ANTRAG)).toBe("antrag");
    expect(stempelFehlerArt(LOESCHEN)).toBe("nicht_loeschbar");
    expect(stempelFehlerArt(TICKET)).toBe("ticket_gesperrt");
    expect(stempelFehlerArt(RLS)).toBe("gesperrt");
    expect(stempelFehlerArt(OFFEN)).toBe("doppelt_offen");
    expect(stempelFehlerArt(FELDER)).toBe("lohnfelder");
    expect(stempelFehlerArt(KONTEXT)).toBe("kontext_fehlt");
    expect(stempelFehlerArt({ code: "XX000", message: "irgendwas" })).toBe("unbekannt");
    expect(stempelFehlerArt(null)).toBe("unbekannt");
  });
  it("Überschneidung auch ohne Code (Meldung aus einer Route)", () => {
    expect(stempelFehlerArt({ message: UEBERLAPPUNG.message })).toBe("ueberlappung");
  });
});

describe("ueberlappungAusDetails", () => {
  it("liest den bestehenden Stempel", () => {
    expect(ueberlappungAusDetails(UEBERLAPPUNG.details)).toEqual({
      clock_in: "2026-10-01T08:00:00.000Z",
      clock_out: "2026-10-01T14:00:00.000Z",
    });
  });
  it("offen = bis unendlich, Nachkommastellen", () => {
    expect(ueberlappungAusDetails(UEBERLAPPUNG_OFFEN.details)).toEqual({ clock_in: "2027-01-29T07:00:00.500Z", clock_out: null });
  });
  it("ohne Details → null", () => {
    expect(ueberlappungAusDetails(null)).toBeNull();
    expect(ueberlappungAusDetails("irgendwas")).toBeNull();
  });
});

describe("stempelSpanne (Zürich)", () => {
  it("gleicher Tag", () => {
    expect(stempelSpanne({ clock_in: "2026-10-01T08:00:00Z", clock_out: "2026-10-01T14:00:00Z" }, JETZT)).toBe("vom 01.10. 10:00–16:00");
  });
  it("über Mitternacht", () => {
    expect(stempelSpanne({ clock_in: "2026-10-01T20:00:00Z", clock_out: "2026-10-02T02:00:00Z" }, JETZT)).toBe("vom 01.10. 22:00 bis 02.10. 04:00");
  });
  it("offen und anderes Jahr", () => {
    expect(stempelSpanne({ clock_in: "2027-01-29T07:00:00Z", clock_out: null }, JETZT)).toBe("seit 29.01.2027 08:00 (noch offen)");
  });
});

describe("stempelMeldung", () => {
  it("Überschneidung mit dem eigenen Stempel (Wortlaut)", () => {
    const s = stempelMeldung(UEBERLAPPUNG, { ueberlappung: ueberlappungAusDetails(UEBERLAPPUNG.details), jetzt: JETZT });
    expect(s).toBe(
      "Diese Zeit überschneidet sich mit deinem Stempel vom 01.10. 10:00–16:00. Zwei Stempel gleichzeitig gehen nicht — bitte Zeiten prüfen oder Ticket «Stempel-Änderung».",
    );
  });
  it("Überschneidung mit offenem Stempel einer anderen Person (ohne Ticket-Hinweis)", () => {
    const s = ueberlappungsMeldung({ clock_in: "2027-01-29T07:00:00Z", clock_out: null }, { person: "Noah Brunner", jetzt: JETZT });
    expect(s).toBe(
      "Diese Zeit überschneidet sich mit dem offenen Stempel von Noah Brunner seit 29.01.2027 08:00. Zwei Stempel gleichzeitig gehen nicht — bitte Zeiten prüfen.",
    );
  });
  it("Überschneidung ohne bekannten Stempel", () => {
    expect(stempelMeldung({ code: "23P01", message: "x" })).toContain("mit einem anderen Stempel von dir");
  });
  it("lang, Antrag, löschen, Ticket", () => {
    expect(stempelMeldung(LANG)).toBe(`Dieser Stempel dauert über ${LANG_STUNDEN} Stunden — bitte die Endzeit prüfen. Stimmt sie, braucht es eine Begründung.`);
    expect(stempelMeldung(ANTRAG)).toBe(
      "Der Monat ist schon abgerechnet (ab 10.09.2026) — Stempel ändern geht nur noch per Antrag über die Lohnverwaltung. Bitte Ticket «Stempel-Änderung» erfassen.",
    );
    expect(stempelMeldung(ANTRAG, { person: "Lara Steiner" })).not.toContain("Ticket");
    expect(stempelMeldung(LOESCHEN)).toContain("nur die Lohnverwaltung per Antrag");
    expect(stempelMeldung(TICKET)).toBe("Monat abgerechnet — nur die Lohnverwaltung per Antrag.");
  });
  it("RLS: gesperrt nur, wenn der Zeitpunkt gesperrt ist", () => {
    expect(stempelMeldung(RLS, { zeitpunkt: "2026-01-10T08:00:00Z" })).toContain(TIME_ENTRY_LOCK_MESSAGE);
    expect(stempelMeldung(RLS, { zeitpunkt: "2099-01-10T08:00:00Z" })).toBe("Keine Berechtigung — vom Server abgelehnt.");
  });
  it("zwei offene Stempel, Kontext, Unbekanntes", () => {
    expect(stempelMeldung(OFFEN)).toContain("Du bist schon eingestempelt");
    expect(stempelMeldung(OFFEN, { person: "Lara Steiner" })).toBe("Lara Steiner hat schon einen offenen Stempel — zwei offene Stempel gehen nicht.");
    expect(stempelMeldung(KONTEXT)).toBe("Auftrag, Projekt oder Beschreibung fehlt.");
    expect(stempelMeldung({ message: "Netz weg" })).toBe("Netz weg");
    expect(stempelMeldung({ message: "" }, { sonst: "Speichern fehlgeschlagen" })).toBe("Speichern fehlgeschlagen");
  });
  it("Ende in gesperrtem Monat", () => {
    expect(endeGesperrtMeldung("2026-09-28T05:30:00Z", JETZT)).toBe(
      "Monat abgerechnet — dein Stempel seit 28.09. 07:30 lässt sich nicht mehr ausstempeln. Das Ende setzt die Lohnverwaltung per Antrag: bitte Ticket «Stempel-Änderung» mit der Endzeit erfassen.",
    );
  });
});

describe("stempelFehlerText", () => {
  it("lädt den überschneidenden Stempel über stempel_ueberlappung", async () => {
    let args: unknown = null;
    const sb = {
      rpc: async (_name: string, a: unknown) => {
        args = a;
        return { data: [{ id: "x", clock_in: "2026-10-20T05:00:00Z", clock_out: "2026-10-20T08:00:00Z" }], error: null };
      },
    } as unknown as SupabaseClient;
    const s = await stempelFehlerText(sb, { code: "23P01", message: "x" }, { userId: "u", von: "2026-10-20T06:00:00Z", bis: null, ohneId: "e", jetzt: JETZT });
    expect(args).toEqual({ p_user: "u", p_von: "2026-10-20T06:00:00Z", p_bis: null, p_ohne: "e" });
    expect(s).toContain("mit deinem Stempel vom 20.10. 07:00–10:00");
  });
  it("Abfrage scheitert → Details", async () => {
    const sb = { rpc: async () => { throw new Error("offline"); } } as unknown as SupabaseClient;
    const s = await stempelFehlerText(sb, UEBERLAPPUNG, { userId: "u", von: "2026-10-01T09:00:00Z", jetzt: JETZT });
    expect(s).toContain("vom 01.10. 10:00–16:00");
  });
});

describe("Grenze 16 h", () => {
  it("gleich wie im Lohn-Kern", () => {
    expect(LANG_STUNDEN).toBe(STEMPEL_LANG_STUNDEN);
  });
  it("istLang: offen bis jetzt, genau 16 h ist nicht lang", () => {
    expect(istLang("2026-10-28T10:00:00Z", "2026-10-29T02:00:00Z")).toBe(false);
    expect(istLang("2026-10-28T10:00:00Z", "2026-10-29T02:00:01Z")).toBe(true);
    expect(istLang("2026-10-28T17:00:00Z", null, JETZT.getTime())).toBe(true);
  });
});

describe("Zürcher Wandzeit", () => {
  it("Sommer- und Winterzeit, unabhängig vom Gerät", async () => {
    const { zuerichZuIso, isoZuZuerich } = await import("./stempel-meldungen");
    expect(zuerichZuIso("2026-10-24", "17:30")).toBe("2026-10-24T15:30:00.000Z");
    expect(zuerichZuIso("2026-10-26", "17:30")).toBe("2026-10-26T16:30:00.000Z");
    expect(zuerichZuIso("2026-10-26", "25:00")).toBeNull();
    expect(isoZuZuerich("2026-10-26T16:30:00.000Z")).toEqual({ datum: "2026-10-26", zeit: "17:30" });
  });
});

describe("Zürcher Wandzeit an den Umstellungstagen", () => {
  it("Winterzeit 25.10.2026: 01:30 eindeutig (MESZ), 02:30 doppelt → erste (Sommerzeit), 03:30 MEZ", async () => {
    const { zuerichZuIso, isoZuZuerich } = await import("./stempel-meldungen");
    expect(zuerichZuIso("2026-10-25", "01:30")).toBe("2026-10-24T23:30:00.000Z");
    expect(zuerichZuIso("2026-10-25", "02:30")).toBe("2026-10-25T00:30:00.000Z");
    expect(zuerichZuIso("2026-10-25", "03:30")).toBe("2026-10-25T02:30:00.000Z");
    for (const z of ["01:30", "02:30", "03:30"]) expect(isoZuZuerich(zuerichZuIso("2026-10-25", z)!).zeit).toBe(z);
  });
  it("Sommerzeit 29.03.2026: 01:30 MEZ, 02:30 gibt es nicht → abgelehnt, 03:30 MESZ", async () => {
    const { zuerichZuIso, zeitEingabeFehler } = await import("./stempel-meldungen");
    expect(zuerichZuIso("2026-03-29", "01:30")).toBe("2026-03-29T00:30:00.000Z");
    expect(zuerichZuIso("2026-03-29", "02:30")).toBeNull();
    expect(zuerichZuIso("2026-03-29", "03:30")).toBe("2026-03-29T01:30:00.000Z");
    expect(zeitEingabeFehler("2026-03-29", "02:30")).toContain("gibt es am 29.03. nicht");
    expect(zeitEingabeFehler("2026-03-29", "03:30")).toBeNull();
  });
  it("ungültiges Datum", async () => {
    const { zuerichZuIso } = await import("./stempel-meldungen");
    expect(zuerichZuIso("2026-02-30", "08:00")).toBeNull();
  });
});
