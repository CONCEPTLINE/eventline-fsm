import { describe, expect, it } from "vitest";
import type { AuftragFormState } from "@/components/auftrag-form-fields";
import { toDbDate } from "@/lib/format";
import { bearbeitenPayload } from "./auftrag-bearbeiten";

// Aus einem Entwurf umgewandelter «Firma/Privat»-Auftrag: hat location_id und
// Veranstalter-Kontakt, die das Formular bei Firma/Privat gar nicht zeigt.
const umgewandelt: AuftragFormState = {
  job_type: "extern",
  title: "Weihnachtsfeier ",
  description: "  Apéro und DJ ",
  location_id: "loc-1",
  customer_id: "kunde-1",
  external_address: "Hauptstrasse 1, Basel",
  room_id: "",
  start_date: "2026-12-12",
  end_date: "2026-12-12",
  urgent: false,
  contact_person: "Anna Muster",
  contact_phone: "061 000 00 00",
  contact_email: "anna@example.ch",
  project_lead_id: "p-1",
};

const locationAuftrag: AuftragFormState = {
  ...umgewandelt,
  job_type: "location",
  customer_id: "",
  external_address: "",
  room_id: "raum-1", // Altbestand: room_id bei Location-Auftrag
};

describe("bearbeitenPayload", () => {
  it("ohne Änderung → leer (kein Update)", () => {
    expect(bearbeitenPayload(umgewandelt, umgewandelt)).toEqual({});
    expect(bearbeitenPayload(locationAuftrag, locationAuftrag)).toEqual({});
  });

  it("nur Titel geändert → nur der Titel, nichts sonst wird geleert/getrimmt/umdatiert", () => {
    const p = bearbeitenPayload({ ...umgewandelt, title: "Weihnachtsfeier 2026" }, umgewandelt);
    expect(p).toEqual({ title: "Weihnachtsfeier 2026" });
  });

  it("Location-Auftrag: room_id bleibt unangetastet", () => {
    const p = bearbeitenPayload({ ...locationAuftrag, contact_phone: "079 111 11 11" }, locationAuftrag);
    expect(p).toEqual({ contact_phone: "079 111 11 11" });
  });

  it("Datum nur, wenn geändert — dann als Zürich-Mitternacht", () => {
    const p = bearbeitenPayload({ ...umgewandelt, end_date: "2026-12-13" }, umgewandelt);
    expect(p).toEqual({ end_date: toDbDate("2026-12-13") });
  });

  it("Texte: geänderte werden getrimmt, leere zu null", () => {
    const p = bearbeitenPayload({ ...umgewandelt, description: "   " }, umgewandelt);
    expect(p).toEqual({ description: null });
  });

  it("Wechsel Location → Firma/Privat leert Location und Veranstalter-Kontakt", () => {
    const form: AuftragFormState = {
      ...locationAuftrag,
      job_type: "extern",
      location_id: "",
      customer_id: "kunde-2",
      external_address: " Neuer Ort ",
      room_id: "",
    };
    expect(bearbeitenPayload(form, locationAuftrag)).toEqual({
      job_type: "extern",
      location_id: null,
      contact_person: null,
      contact_phone: null,
      contact_email: null,
      customer_id: "kunde-2",
      external_address: "Neuer Ort",
      room_id: null,
    });
  });

  it("Wechsel Firma/Privat → Location leert Kunde/Ort/Raum, übernimmt Location + Kontakt", () => {
    const form: AuftragFormState = { ...umgewandelt, job_type: "location", customer_id: "", external_address: "", room_id: "" };
    expect(bearbeitenPayload(form, umgewandelt)).toEqual({
      job_type: "location",
      customer_id: null,
      room_id: null,
      external_address: null,
      location_id: "loc-1",
      contact_person: "Anna Muster",
      contact_phone: "061 000 00 00",
      contact_email: "anna@example.ch",
    });
  });

  it("Dringend und Verantwortlich nur bei Änderung", () => {
    const p = bearbeitenPayload({ ...umgewandelt, urgent: true, project_lead_id: "p-2" }, umgewandelt);
    expect(p).toEqual({ priority: "dringend", project_lead_id: "p-2" });
  });
});
