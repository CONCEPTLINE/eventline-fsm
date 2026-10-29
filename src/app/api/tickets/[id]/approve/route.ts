import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pruefeVertrautesGeraet, requirePermission } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { isUuid } from "@/lib/search-escape";
import { ladePersonRecht } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { aendereLohndaten, ANTRAG_HINWEIS_LOHN, type Operation } from "@/lib/lohn/aenderungen";
import { istLangerStempel } from "@/lib/lohn/stempel-pruefung";
import {
  findeUeberlappung,
  istStempelGesperrt,
  stempelFehlerArt,
  stempelFehlerText,
  ueberlappungsMeldung,
} from "@/lib/stempel-meldungen";
import { formatTicketNumber } from "@/lib/nummern-format";
import type { TicketDataStempelAenderung } from "@/types";

// POST /api/tickets/{id}/approve — Ein-Klick-Genehmigen fuer
// Stempel-Aenderung-Tickets.
//
// Wrapper um die apply_ticket-RPC, damit der neue Ein-Klick-Flow
// (Icon-Button in Liste + Detail) keinen Confirm-Dialog braucht und
// idempotent aufgerufen werden kann (Undo-Toast → Zweit-Klick liefert
// deterministisch 200 statt 4xx).
//
// Scope bewusst schmal: NUR type='stempel_aenderung'. Belege haben ihre
// eigene Route (mark-filed / reject-beleg), IT- und Material-Tickets
// werden nicht via Ein-Klick approved (koennten aber trivial erweitert
// werden).
//
// Optional Body: { corrected_job_id?, resolution_note?, als_antrag?, begruendung? }
//   - corrected_job_id: analog SearchableSelect im Detail — UUID oder
//     "ANDERE_ARBEIT". NULL/omitted → apply_ticket nutzt data.job_id.
//   - resolution_note: optionale Notiz an den Ersteller.
//   - als_antrag + begruendung: Monat abgerechnet → Lohn-Antrag (s. u.).
//
// Permission: tickets:manage (Admin passt via has_permission durch).
// Die apply_ticket-RPC prueft SELBST nochmal — der Wrapper hier ist die
// erste Verteidigungslinie, damit wir vor dem RPC-Roundtrip abbrechen.
//
// Lohn-Umbau Phase 4 — vor apply_ticket prueft der Server:
//   * Ueberschneidung mit einem anderen Stempel der Person → 409 Klartext
//     (gilt auch vor Migration 368).
//   * Monat abgerechnet (Sperre 5. des Folgemonats bzw. Lohnabrechnung
//     erstellt) → nie direkt aendern. Hat die genehmigende Person Lohnrecht
//     + vertrautes Geraet: 423 code «antrag_noetig» → mit { als_antrag,
//     begruendung } (Begruendung = Ticket-Grund, ergaenzbar) wird ein
//     Lohn-Antrag gestellt (Vier Augen, aendereLohndaten), das Ticket ist
//     erledigt (data.lohn_antrag_id). Sonst 423 code «gesperrt»: «Monat
//     abgerechnet — nur die Lohnverwaltung per Antrag.»
//   * Ergebnis ueber 16 h: apply_ticket setzt keine lang_begruendung → der
//     Stempel geht ueber die Aenderungsstelle (direkt) mit dem Ticket-Grund
//     als Begruendung.
//   * Fehler von apply_ticket → Klartext (src/lib/stempel-meldungen.ts).

interface Body {
  corrected_job_id?: unknown;
  resolution_note?: unknown;
  als_antrag?: unknown;
  begruendung?: unknown;
}

interface AltStempel {
  id: string;
  user_id: string | null;
  clock_in: string;
  clock_out: string | null;
  job_id: string | null;
  project_id: string | null;
  notes: string | null;
}

type Daten = TicketDataStempelAenderung & { project_id?: string; beschreibung?: string; grund?: string; lohn_antrag_id?: string };

const GESPERRT = "Monat abgerechnet — nur die Lohnverwaltung per Antrag.";

const ZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const zeit = (iso: string | null) => (iso ? ZEIT.format(new Date(iso)) : "offen");

/** Operationen wie apply_ticket (Migration 213/215), fuer den Weg ueber die
 *  Aenderungsstelle (Antrag bzw. > 16 h). */
function baueOperation(
  ticketId: string,
  ticketUser: string,
  d: Daten,
  alt: AltStempel | null,
  korrigierterAuftrag: string | null,
  langBegruendung: string | null,
): Operation {
  const jobKorrektur = korrigierterAuftrag === null ? undefined : korrigierterAuftrag === "ANDERE_ARBEIT" ? null : korrigierterAuftrag;
  if (alt) {
    const werte: Record<string, unknown> = {
      notes: [alt.notes, `[Korrektur via Ticket #${ticketId}]`].filter(Boolean).join("\n"),
    };
    if (d.neu_start) werte.clock_in = d.neu_start;
    if (d.neu_end) werte.clock_out = d.neu_end;
    if (jobKorrektur !== undefined) werte.job_id = jobKorrektur;
    if (langBegruendung) werte.lang_begruendung = langBegruendung;
    return { op: "update", tabelle: "time_entries", id: alt.id, werte };
  }
  const werte: Record<string, unknown> = {
    user_id: ticketUser,
    job_id: jobKorrektur !== undefined ? jobKorrektur : d.context === "projekt" || d.context === "andere_arbeit" ? null : (d.job_id || null),
    project_id: d.context === "projekt" ? (d.project_id || null) : null,
    clock_in: d.neu_start,
    clock_out: d.neu_end ?? null,
    description: d.beschreibung ?? null,
    notes: `[Nachtraeglich erfasst via Ticket #${ticketId}]`,
  };
  if (langBegruendung) werte.lang_begruendung = langBegruendung;
  return { op: "insert", tabelle: "time_entries", werte };
}

async function ticketErledigt(admin: SupabaseClient, id: string, von: string, notiz: string | null, data: Daten) {
  const { error } = await admin
    .from("tickets")
    .update({ status: "erledigt", resolved_at: new Date().toISOString(), resolved_by: von, resolution_note: notiz, data })
    .eq("id", id)
    .eq("status", "offen");
  if (error) throw new Error(`Ticket-Status konnte nicht gesetzt werden: ${error.message}`);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePermission("tickets:manage");
  if (auth.error) return auth.error;
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as Body | null;
  const correctedJobId =
    typeof body?.corrected_job_id === "string" && body.corrected_job_id.trim() !== ""
      ? body.corrected_job_id.trim()
      : null;
  const resolutionNote =
    typeof body?.resolution_note === "string" && body.resolution_note.trim() !== ""
      ? body.resolution_note.trim()
      : null;
  if (correctedJobId && correctedJobId !== "ANDERE_ARBEIT" && !isUuid(correctedJobId)) {
    return NextResponse.json({ success: false, error: "Auftrag ungültig" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Ticket laden — Typ + Status pruefen ohne Row zu locken (das macht die
  // RPC selbst nochmal via SELECT ... FOR UPDATE).
  const { data: existing } = await admin
    .from("tickets")
    .select("id, type, status, ticket_number, data, created_by")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ success: false, error: "Ticket nicht gefunden" }, { status: 404 });
  }
  if (existing.type !== "stempel_aenderung") {
    return NextResponse.json(
      { success: false, error: "Auto-Approve nur für Stempeltickets" },
      { status: 400 },
    );
  }
  // Idempotenz: bereits erledigt/abgelehnt → 200 no-op. Der Undo-Toast
  // kann so gefahrlos doppelt gefeuert werden, und ein Reload+Zweit-Klick
  // erzeugt keinen verwirrenden Fehler.
  if (existing.status === "erledigt") {
    return NextResponse.json({
      success: true,
      already: true,
      ticket_number: existing.ticket_number,
    });
  }
  if (existing.status === "abgelehnt") {
    return NextResponse.json(
      { success: false, error: "Ticket ist bereits abgelehnt" },
      { status: 409 },
    );
  }

  // --- Phase 4: Ziel bestimmen, vorab pruefen -------------------------------
  const d = ((existing.data ?? {}) as Daten);
  let alt: AltStempel | null = null;
  if (d.time_entry_id) {
    const { data: te, error: teErr } = await admin
      .from("time_entries")
      .select("id, user_id, clock_in, clock_out, job_id, project_id, notes")
      .eq("id", d.time_entry_id)
      .maybeSingle();
    if (teErr) return NextResponse.json({ success: false, error: teErr.message }, { status: 500 });
    if (!te) return NextResponse.json({ success: false, error: "Der Stempel des Tickets existiert nicht mehr." }, { status: 404 });
    alt = te as AltStempel;
  }
  const personId = alt?.user_id ?? (existing.created_by as string);
  const neuVon = d.neu_start ?? alt?.clock_in ?? null;
  const neuBis = d.neu_end ?? alt?.clock_out ?? null;
  if (!neuVon) return NextResponse.json({ success: false, error: "Ticket ohne Startzeit" }, { status: 400 });
  const person = (await ladeName(admin, personId)) ?? "der Person";

  let gesperrt: boolean;
  try {
    gesperrt = await istStempelGesperrt(admin, [alt?.clock_in, neuVon]);
  } catch (e) {
    logError("api.tickets.approve.sperre", e, { ticketId: id });
    return NextResponse.json({ success: false, error: "Sperr-Prüfung fehlgeschlagen — bitte später nochmals." }, { status: 500 });
  }

  const ueb = await findeUeberlappung(admin, { userId: personId, von: neuVon, bis: neuBis, ohneId: alt?.id ?? null });
  if (ueb) {
    return NextResponse.json(
      { success: false, code: "ueberlappung", error: ueberlappungsMeldung(ueb, { person }) },
      { status: 409 },
    );
  }

  const grund = (d.grund ?? "").trim();
  const ticketNr = formatTicketNumber(existing.ticket_number as number);
  const lang = istLangerStempel(neuVon, neuBis);

  // --- Monat abgerechnet: nur per Antrag ------------------------------------
  if (gesperrt) {
    const [recht, geraet] = await Promise.all([
      ladePersonRecht(admin, auth.user.id).catch(() => null),
      pruefeVertrautesGeraet(auth.user.id),
    ]);
    if (!recht?.hatLohnRecht) {
      return NextResponse.json({ success: false, code: "gesperrt", antrag_moeglich: false, error: GESPERRT }, { status: 423 });
    }
    if (geraet !== "vertraut" || auth.isImpersonating) {
      return NextResponse.json(
        { success: false, code: "gesperrt", antrag_moeglich: false, error: `${GESPERRT} Anträge nur auf einem vertrauten Gerät.` },
        { status: 423 },
      );
    }
    if (body?.als_antrag !== true) {
      return NextResponse.json(
        { success: false, code: "antrag_noetig", antrag_moeglich: true, error: "Monat abgerechnet — Genehmigen geht nur noch als Lohn-Antrag.", begruendung: grund },
        { status: 423 },
      );
    }
    const begruendung = typeof body?.begruendung === "string" && body.begruendung.trim() ? body.begruendung.trim() : grund;
    const akteurName = await ladeName(admin, auth.user.id);
    const operation = baueOperation(id, existing.created_by as string, d, alt, correctedJobId, lang ? `Ticket ${ticketNr}: ${grund}` : null);
    try {
      const r = await aendereLohndaten(admin, {
        operationen: [operation],
        bereich: "stempel",
        profileId: personId,
        zielName: person,
        beschreibung: `Ticket ${ticketNr} «Stempel-Änderung» (${person}): ${alt ? `Korrektur ${zeit(alt.clock_in)} – ${zeit(alt.clock_out)} → ` : "Nachtrag "}${zeit(neuVon)} – ${zeit(neuBis)}`,
        begruendung,
        akteurId: auth.user.id,
        akteurName,
      });
      if (r.modus === "begruendung_noetig") {
        return NextResponse.json(
          { success: false, code: "begruendung_noetig", antrag_moeglich: true, error: "Begründung fehlt (mindestens 10 Zeichen) — dann wird ein Antrag gestellt.", begruendung: grund },
          { status: 409 },
        );
      }
      const notiz = r.modus === "antrag"
        ? [resolutionNote, "Als Lohn-Antrag gestellt — die Änderung wird wirksam, sobald eine zweite Person (anderer Admin oder Vertretung) bestätigt."].filter(Boolean).join("\n")
        : resolutionNote;
      await ticketErledigt(admin, id, auth.user.id, notiz, r.modus === "antrag" ? { ...d, lohn_antrag_id: r.antragId } : d);
      return NextResponse.json({
        success: true,
        mode: r.modus,
        ticket_number: existing.ticket_number,
        meldung: r.modus === "antrag" ? ANTRAG_HINWEIS_LOHN : undefined,
      });
    } catch (e) {
      logError("api.tickets.approve.antrag", e, { userId: auth.user.id, ticketId: id });
      const m = e instanceof Error ? e.message : String(e);
      return NextResponse.json({ success: false, error: await stempelFehlerText(admin, { message: m }, { person, sonst: m }) }, { status: 400 });
    }
  }

  // --- Ueber 16 h: mit Ticket-Grund als Begruendung (apply_ticket kennt sie nicht)
  if (lang) {
    try {
      const r = await aendereLohndaten(admin, {
        operationen: [baueOperation(id, existing.created_by as string, d, alt, correctedJobId, `Ticket ${ticketNr}: ${grund || "ohne Grund"}`)],
        bereich: "stempel",
        profileId: personId,
        zielName: person,
        beschreibung: `Ticket ${ticketNr} «Stempel-Änderung» (${person})`,
        begruendung: null,
        akteurId: auth.user.id,
        akteurName: await ladeName(admin, auth.user.id),
      });
      if (r.modus !== "direkt") {
        return NextResponse.json({ success: false, code: "gesperrt", error: GESPERRT }, { status: 423 });
      }
      await ticketErledigt(admin, id, auth.user.id, resolutionNote, d);
      return NextResponse.json({ success: true, ticket_number: existing.ticket_number });
    } catch (e) {
      logError("api.tickets.approve.lang", e, { userId: auth.user.id, ticketId: id });
      const m = e instanceof Error ? e.message : String(e);
      return NextResponse.json(
        { success: false, error: await stempelFehlerText(admin, { message: m }, { userId: personId, von: neuVon, bis: neuBis, ohneId: alt?.id ?? null, person, sonst: "Genehmigen fehlgeschlagen" }) },
        { status: 409 },
      );
    }
  }

  // RPC-Aufruf ueber den User-Client, damit auth.uid() innerhalb der
  // SECURITY-DEFINER-Function den echten resolver liefert. Das ist wichtig
  // fuer resolved_by und fuer den has_permission-Check innerhalb der RPC.
  const supabase = await createClient();
  const rpcArgs: Record<string, unknown> = {
    p_ticket_id: id,
    p_new_status: "erledigt",
    p_resolution_note: resolutionNote,
  };
  if (correctedJobId) rpcArgs.p_corrected_job_id = correctedJobId;

  const { error } = await supabase.rpc("apply_ticket", rpcArgs);
  if (error) {
    logError("api.tickets.approve", error, {
      userId: auth.user.id,
      ticketId: id,
      correctedJobId,
    });
    const art = stempelFehlerArt(error);
    const klartext = art === "unbekannt"
      ? "Genehmigen fehlgeschlagen"
      : await stempelFehlerText(admin, error, { userId: personId, von: neuVon, bis: neuBis, ohneId: alt?.id ?? null, person });
    const status = art === "ticket_gesperrt" || art === "antrag" ? 423 : art === "unbekannt" ? 500 : 409;
    return NextResponse.json({ success: false, error: klartext }, { status });
  }

  return NextResponse.json({
    success: true,
    ticket_number: existing.ticket_number,
  });
}
