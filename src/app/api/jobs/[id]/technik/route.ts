// POST /api/jobs/[id]/technik — alle Firmen-Mutationen der Technik-Planung
// als Aktions-Dispatcher (eine Route statt zehn Mini-Routen).
//
// { aktion: "...", ...felder } — Aktionen:
//   anfrage_senden          {}                                → Notification an die Portal-User
//                                                               des festen Techniklieferanten (genau
//                                                               EIN aktiver Lieferant vom Typ
//                                                               «technik»; die Zuweisung entsteht hier)
//   anforderung_neu         { titel, text? }          Positionsgruppe anlegen (Migration 352;
//                                                      Tabelle job_anforderungen, «Pos 01»)
//   anforderung_edit        { id, titel?, text? }     → manuell_geaendert_at: die Eingang-KI
//                                                      fasst die Gruppe danach nicht mehr an
//   anforderung_loeschen    { id }                    samt Einzelpositionen (CASCADE; der
//                                                      Dialog im Tab nennt die Verluste)
//   position_neu            { gruppeId, bezeichnung, menge, kategorie?, details?, artikelId? }
//   position_edit           { id, gruppeId?, bezeichnung?, menge?, kategorie?, artikelId?, details? }
//                             (Menge/Bezeichnung/Details geaendert → Bestaetigung des
//                              Lieferanten verfaellt, wie beim KI-Pfad)
//   position_loeschen       { id }
//   position_bestaetigen    { id, bestaetigt }
//   review_entscheiden      { id, entscheid: "uebernehmen" | "ablehnen" }  (Empfehlung)
//                           { id, entscheid: "erledigt" }                   (Problem schliessen)
//   kommentar_neu           { positionId?, reviewId?, body }  → Notification an Portal-User
//
// Storniert/abgeschlossene Auftraege: alles gesperrt (409).
// Lesen macht der Technik-Tab direkt per Client-Supabase (RLS).
// Jede fachliche Aenderung schreibt einen Aktivitaets-Eintrag.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import {
  logTechnik, actorName, lieferantPortalUserIds, festerTechnikLieferant, technikZuweisung,
  jobDatumText, freitext, technikGesperrt, sperrGrund, technikAenderungenSeit,
  weiterePositionenGruppe, gruppeDesAuftrags,
} from "@/lib/technik-server";
import { notifyLieferantTechnikAnfrage, notifyLieferantTechnikAntwort } from "@/lib/notification-service";
import { ganzeMenge, gruppeLabel, TECHNIK_BEZEICHNUNG_MAX, TECHNIK_TITEL_MAX, type ReviewVorschlag } from "@/lib/technik";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  aktion?: string;
  id?: string;
  gruppeId?: string;
  titel?: unknown;
  text?: unknown;
  bezeichnung?: unknown;
  menge?: unknown;
  kategorie?: unknown;
  details?: unknown;
  artikelId?: string;
  bestaetigt?: boolean;
  entscheid?: string;
  positionId?: string;
  reviewId?: string;
  body?: unknown;
};

const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

const ENTSCHEID_LABEL = { uebernommen: "Übernommen", abgelehnt: "Abgelehnt", erledigt: "Erledigt" } as const;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id: jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");

  const b = ((await request.json().catch(() => null)) ?? {}) as Body;
  const admin = createAdminClient();

  const { data: job, error: jobErr } = await admin
    .from("jobs")
    .select("id, title, job_number, start_date, end_date, status, is_deleted")
    .eq("id", jobId)
    .maybeSingle();
  if (jobErr) {
    logError("api.jobs.technik.job", jobErr, { jobId });
    return fehler("Laden fehlgeschlagen", 500);
  }
  if (!job || job.is_deleted) return fehler("Auftrag nicht gefunden", 404);
  // Storniert/abgeschlossen: keine Bearbeitung und keine Anfrage mehr.
  if (technikGesperrt(job.status)) return fehler(sperrGrund(job.status), 409);

  const actor = { id: auth.user.id, name: await actorName(admin, auth.user.id) };
  const dann = (aktion: string, beschreibung: string, meta?: Record<string, unknown>) =>
    logTechnik(admin, jobId, actor, aktion, beschreibung, meta);

  try {
    switch (b.aktion) {
      case "anfrage_senden": {
        // Positionsgruppen genuegen — eine Gruppe ohne Einzelpositionen
        // heisst «der Lieferant waehlt die passende Loesung».
        const [gRes, pRes] = await Promise.all([
          admin.from("job_anforderungen").select("id", { count: "exact", head: true }).eq("job_id", jobId),
          admin.from("job_technik_positionen").select("id", { count: "exact", head: true }).eq("job_id", jobId),
        ]);
        if (gRes.error) throw gRes.error;
        if (pRes.error) throw pRes.error;
        const count = gRes.count ?? 0;
        const einzel = pRes.count ?? 0;
        if (!count) return fehler("Noch keine Positionen erfasst");
        // Fester Techniklieferant — bei keinem/mehreren gibt es keine
        // Auswahl, sondern einen klaren Fehler (Hinweis steht im Tab).
        const fest = await festerTechnikLieferant(admin);
        if (!fest.ok) {
          if (fest.grund === "fehler") return fehler("Laden fehlgeschlagen", 500);
          return fehler("Kein eindeutiger Techniklieferant hinterlegt — Anfrage nicht möglich", 409);
        }
        const lieferant = fest.lieferant;
        let zuw = await technikZuweisung(admin, jobId, lieferant.id);
        if (!zuw) {
          // Zuweisung entsteht erst beim Senden — der Lieferant sieht den
          // Auftrag im Portal damit erst ab der ersten Anfrage.
          const { error: zErr } = await admin.from("job_lieferanten").insert({
            job_id: jobId,
            lieferant_id: lieferant.id,
            created_by: auth.user.id,
          });
          // 23505 = parallel schon angelegt (unique job_id+lieferant_id) — weiter.
          if (zErr && zErr.code !== "23505") throw zErr;
          zuw = await technikZuweisung(admin, jobId, lieferant.id);
          if (!zuw) return fehler("Zuweisung fehlgeschlagen", 500);
        }
        const runde = zuw.runden + 1;
        // Ab Runde 2: was hat sich seit der vorherigen Anfrage geaendert?
        // (Mail nennt es, das Portal markiert Neu/Geaendert gegen diesen Bezug.)
        const vorige = zuw.angefragtAt;
        const aenderungen = vorige ? await technikAenderungenSeit(admin, jobId, vorige) : null;
        const { error: uErr } = await admin
          .from("job_lieferanten")
          .update({
            angefragt_at: new Date().toISOString(),
            angefragt_by: auth.user.id,
            anfrage_runden: runde,
            vorige_angefragt_at: vorige,
          })
          .eq("id", zuw.id);
        if (uErr) throw uErr;
        const empfaenger = await lieferantPortalUserIds(admin, lieferant.id);
        await notifyLieferantTechnikAnfrage(admin, {
          recipients: empfaenger,
          jobId,
          jobTitle: job.title,
          dateText: jobDatumText(job.start_date, job.end_date),
          anzahlPositionen: count,
          anzahlEinzelpositionen: einzel,
          runde,
          aenderungen,
        });
        await dann(
          "anfrage_gesendet",
          `Anfrage an «${lieferant.name}» gesendet — Runde ${runde} (${count} ${count === 1 ? "Position" : "Positionen"}, ` +
            `${einzel} ${einzel === 1 ? "Einzelposition" : "Einzelpositionen"})` +
            (empfaenger.length === 0 ? " · niemand benachrichtigt (kein aktives Portal-Konto)" : ""),
        );
        return NextResponse.json({ success: true, empfaenger: empfaenger.length, lieferant: lieferant.name, runde });
      }

      case "anforderung_neu": {
        const ti = freitext(b.titel, { feld: "Titel", pflicht: true, max: TECHNIK_TITEL_MAX });
        if (ti.fehler || !ti.wert) return fehler(ti.fehler ?? "Titel fehlt");
        const t = freitext(b.text, { feld: "Beschreibung" });
        if (t.fehler) return fehler(t.fehler);
        // nummer vergibt der Trigger (je Auftrag fortlaufend, Migration 352).
        const { data, error } = await admin
          .from("job_anforderungen")
          .insert({ job_id: jobId, titel: ti.wert, text: t.wert ?? "", created_by: auth.user.id })
          .select("id, nummer, titel, text")
          .single();
        if (error) throw error;
        await dann("gruppe_neu", `Position angelegt: ${gruppeLabel(data)}`, { gruppe_id: data.id });
        return NextResponse.json({ success: true, id: data.id });
      }

      case "anforderung_edit": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const alt = await gruppeDesAuftrags(admin, jobId, b.id);
        if (!alt) return fehler("Position nicht gefunden", 404);
        const patch: Record<string, unknown> = {};
        if (b.titel !== undefined) {
          const ti = freitext(b.titel, { feld: "Titel", pflicht: true, max: TECHNIK_TITEL_MAX });
          if (ti.fehler || !ti.wert) return fehler(ti.fehler ?? "Titel darf nicht leer sein");
          if (ti.wert !== alt.titel) patch.titel = ti.wert;
        }
        if (b.text !== undefined) {
          const t = freitext(b.text, { feld: "Beschreibung" });
          if (t.fehler) return fehler(t.fehler);
          if ((t.wert ?? "") !== alt.text) patch.text = t.wert ?? "";
        }
        if (Object.keys(patch).length === 0) return NextResponse.json({ success: true, unveraendert: true });
        // Von Hand angepasst: die Eingang-KI aendert/loescht die Gruppe nie mehr.
        patch.manuell_geaendert_at = new Date().toISOString();
        const { error } = await admin.from("job_anforderungen").update(patch).eq("id", b.id).eq("job_id", jobId);
        if (error) throw error;
        const neu = { nummer: alt.nummer, titel: (patch.titel as string | undefined) ?? alt.titel, text: (patch.text as string | undefined) ?? alt.text };
        await dann("gruppe_geaendert", `Position angepasst: ${gruppeLabel(neu)}${"text" in patch ? " (Beschreibung)" : ""}`, { gruppe_id: b.id });
        return NextResponse.json({ success: true });
      }

      case "anforderung_loeschen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        // Einzelpositionen gehen per CASCADE mit (samt Rueckmeldungen und
        // Kommentaren — der Dialog im Tab nennt das vorher). Jede einzeln
        // protokollieren: Portal und Anfrage-Mail zeigen sie als «entfernt».
        const { data: posAlt, error: pErr } = await admin
          .from("job_technik_positionen")
          .select("id, menge, bezeichnung, created_at")
          .eq("gruppe_id", b.id)
          .eq("job_id", jobId);
        if (pErr) throw pErr;
        const { data, error } = await admin
          .from("job_anforderungen")
          .delete()
          .eq("id", b.id)
          .eq("job_id", jobId)
          .select("nummer, titel, text, created_at");
        if (error) throw error;
        if (!data?.length) return fehler("Position nicht gefunden", 404);
        for (const p of (posAlt ?? []) as { id: string; menge: number; bezeichnung: string; created_at: string }[]) {
          await dann("position_geloescht", `Einzelposition entfernt: ${p.menge}× ${p.bezeichnung}`, {
            position_id: p.id,
            position_angelegt_at: p.created_at,
          });
        }
        await dann("gruppe_geloescht", `Position entfernt: ${gruppeLabel(data[0])}`, {
          gruppe_id: b.id,
          angelegt_at: data[0].created_at,
        });
        return NextResponse.json({ success: true });
      }

      case "position_neu": {
        if (!b.gruppeId || !UUID_RE.test(b.gruppeId)) return fehler("Position (Gruppe) nötig");
        const gruppe = await gruppeDesAuftrags(admin, jobId, b.gruppeId);
        if (!gruppe) return fehler("Position nicht gefunden", 404);
        const bez = freitext(b.bezeichnung, { feld: "Bezeichnung", pflicht: true, max: TECHNIK_BEZEICHNUNG_MAX });
        if (bez.fehler || !bez.wert) return fehler(bez.fehler ?? "Bezeichnung fehlt");
        const menge = ganzeMenge(b.menge);
        if (!menge) return fehler("Menge muss eine ganze Zahl ab 1 sein");
        const kat = freitext(b.kategorie, { feld: "Kategorie", max: TECHNIK_BEZEICHNUNG_MAX });
        if (kat.fehler) return fehler(kat.fehler);
        const det = freitext(b.details, { feld: "Details" });
        if (det.fehler) return fehler(det.fehler);
        const { data, error } = await admin
          .from("job_technik_positionen")
          .insert({
            job_id: jobId,
            gruppe_id: gruppe.id,
            bezeichnung: bez.wert,
            menge,
            kategorie: kat.wert ?? "Sonstiges",
            details: det.wert,
            artikel_id: b.artikelId && UUID_RE.test(b.artikelId) ? b.artikelId : null,
            quelle: "eventfirma",
            created_by: auth.user.id,
          })
          .select("id")
          .single();
        if (error) throw error;
        await dann("position_neu", `Einzelposition erfasst (${gruppeLabel(gruppe)}): ${menge}× ${bez.wert}`, { position_id: data.id });
        return NextResponse.json({ success: true, id: data.id });
      }

      case "position_edit": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { data: alt, error: aErr } = await admin
          .from("job_technik_positionen")
          .select("bezeichnung, menge, kategorie, details, status, gruppe_id, artikel_id")
          .eq("id", b.id)
          .eq("job_id", jobId)
          .maybeSingle();
        if (aErr) throw aErr;
        if (!alt) return fehler("Einzelposition nicht gefunden", 404);
        const patch: Record<string, unknown> = {};
        let neueGruppe: Awaited<ReturnType<typeof gruppeDesAuftrags>> = null;
        if (b.gruppeId !== undefined && b.gruppeId !== alt.gruppe_id) {
          if (!b.gruppeId || !UUID_RE.test(b.gruppeId)) return fehler("Ungültige Position (Gruppe)");
          neueGruppe = await gruppeDesAuftrags(admin, jobId, b.gruppeId);
          if (!neueGruppe) return fehler("Position nicht gefunden", 404);
          patch.gruppe_id = neueGruppe.id;
        }
        if (b.artikelId !== undefined) {
          const art = b.artikelId && UUID_RE.test(b.artikelId) ? b.artikelId : null;
          if (art !== (alt.artikel_id ?? null)) patch.artikel_id = art;
        }
        if (b.bezeichnung !== undefined) {
          const v = freitext(b.bezeichnung, { feld: "Bezeichnung", pflicht: true, max: TECHNIK_BEZEICHNUNG_MAX });
          if (v.fehler || !v.wert) return fehler(v.fehler ?? "Bezeichnung darf nicht leer sein");
          if (v.wert !== alt.bezeichnung) patch.bezeichnung = v.wert;
        }
        if (b.menge !== undefined) {
          const m = ganzeMenge(b.menge);
          if (!m) return fehler("Menge muss eine ganze Zahl ab 1 sein");
          if (m !== alt.menge) patch.menge = m;
        }
        if (b.kategorie !== undefined) {
          const v = freitext(b.kategorie, { feld: "Kategorie", max: TECHNIK_BEZEICHNUNG_MAX });
          if (v.fehler) return fehler(v.fehler);
          const kat = v.wert ?? "Sonstiges";
          if (kat !== alt.kategorie) patch.kategorie = kat;
        }
        if (b.details !== undefined) {
          const v = freitext(b.details, { feld: "Details" });
          if (v.fehler) return fehler(v.fehler);
          if (v.wert !== (alt.details ?? null)) patch.details = v.wert;
        }
        if (Object.keys(patch).length === 0) return NextResponse.json({ success: true, unveraendert: true });
        // Inhaltliche Aenderung (wie beim KI-Pfad): eine bestehende
        // Bestaetigung des Lieferanten gilt nicht mehr.
        const inhaltlich = "bezeichnung" in patch || "menge" in patch || "details" in patch;
        if (inhaltlich) Object.assign(patch, { status: "geplant", bestaetigt_by: null, bestaetigt_at: null });
        // Von Hand angepasst: die Eingang-KI fasst die Position nicht mehr an.
        patch.manuell_geaendert_at = new Date().toISOString();
        const { error } = await admin.from("job_technik_positionen").update(patch).eq("id", b.id).eq("job_id", jobId);
        if (error) throw error;
        const vorher = `${alt.menge}× ${alt.bezeichnung}`;
        const nachher = `${(patch.menge as number | undefined) ?? alt.menge}× ${(patch.bezeichnung as string | undefined) ?? alt.bezeichnung}`;
        const teile: string[] = [];
        if (vorher !== nachher) teile.push(`${vorher} → ${nachher}`);
        else teile.push(vorher);
        if ("details" in patch) teile.push(`Details ${patch.details ? "angepasst" : "entfernt"}`);
        if (neueGruppe) teile.push(`verschoben nach ${gruppeLabel(neueGruppe)}`);
        await dann(
          "position_geaendert",
          `Einzelposition angepasst: ${teile.join(" · ")}${inhaltlich && alt.status === "bestaetigt" ? " — Bestätigung zurückgesetzt" : ""}`,
          { position_id: b.id },
        );
        return NextResponse.json({ success: true, bestaetigungZurueckgesetzt: inhaltlich && alt.status === "bestaetigt" });
      }

      case "position_loeschen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { data, error } = await admin
          .from("job_technik_positionen")
          .delete()
          .eq("id", b.id)
          .eq("job_id", jobId)
          .select("bezeichnung, menge, created_at");
        if (error) throw error;
        if (!data?.length) return fehler("Position nicht gefunden", 404);
        // position_angelegt_at: «nie gesehen = nie entfernt» (lib/technik
        // entfernungGesehen) — zwischen zwei Runden angelegt und geloescht
        // erscheint im Portal und in der Anfrage-Mail nicht als «entfernt».
        await dann("position_geloescht", `Einzelposition entfernt: ${data[0].menge}× ${data[0].bezeichnung}`, {
          position_id: b.id,
          position_angelegt_at: data[0].created_at,
        });
        return NextResponse.json({ success: true });
      }

      case "position_bestaetigen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const bestaetigt = b.bestaetigt !== false;
        const { data, error } = await admin
          .from("job_technik_positionen")
          .update(
            bestaetigt
              ? { status: "bestaetigt", bestaetigt_by: auth.user.id, bestaetigt_at: new Date().toISOString() }
              : { status: "geplant", bestaetigt_by: null, bestaetigt_at: null },
          )
          .eq("id", b.id)
          .eq("job_id", jobId)
          .select("bezeichnung, menge");
        if (error) throw error;
        if (!data?.length) return fehler("Position nicht gefunden", 404);
        await dann(
          bestaetigt ? "position_bestaetigt_firma" : "position_bestaetigung_entfernt",
          `${bestaetigt ? "Als bestätigt markiert" : "Bestätigung entfernt"}: ${data[0].menge}× ${data[0].bezeichnung}`,
          { position_id: b.id },
        );
        return NextResponse.json({ success: true });
      }

      case "review_entscheiden": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { data: review, error: rErr } = await admin
          .from("job_technik_reviews")
          .select("id, position_id, art, text, vorschlag, status")
          .eq("id", b.id)
          .eq("job_id", jobId)
          .maybeSingle();
        if (rErr) throw rErr;
        if (!review) return fehler("Rückmeldung nicht gefunden", 404);
        if (review.status !== "offen") return fehler("Punkt ist bereits entschieden", 409);
        // Empfehlung: uebernehmen/ablehnen. Problem: als erledigt schliessen.
        const erlaubt = review.art === "empfehlung" ? ["uebernehmen", "ablehnen"] : ["erledigt"];
        if (!b.entscheid || !erlaubt.includes(b.entscheid)) return fehler("Ungültiger Entscheid");
        const neuerStatus = b.entscheid === "uebernehmen" ? "uebernommen" : b.entscheid === "ablehnen" ? "abgelehnt" : "erledigt";

        // Erst den Punkt «beanspruchen» (nur wenn noch offen) — zwei
        // gleichzeitige Klicks uebernehmen einen Vorschlag sonst doppelt.
        const jetzt = new Date().toISOString();
        const { data: beansprucht, error: cErr } = await admin
          .from("job_technik_reviews")
          .update({ status: neuerStatus, entschieden_by: auth.user.id, entschieden_at: jetzt })
          .eq("id", review.id)
          .eq("status", "offen")
          .select("id");
        if (cErr) throw cErr;
        if (!beansprucht?.length) return fehler("Punkt ist bereits entschieden", 409);

        if (neuerStatus === "uebernommen" && review.vorschlag) {
          const ergebnis = await vorschlagAnwenden(admin, jobId, review.position_id, review.vorschlag as ReviewVorschlag, auth.user.id);
          if (ergebnis !== true) {
            await admin
              .from("job_technik_reviews")
              .update({ status: "offen", entschieden_by: null, entschieden_at: null })
              .eq("id", review.id);
            return fehler(ergebnis, ergebnis.startsWith("Speichern") ? 500 : 400);
          }
        }

        const label = ENTSCHEID_LABEL[neuerStatus];
        await dann(`review_${neuerStatus}`, `${label}: «${String(review.text).slice(0, 80)}»`, { review_id: review.id });

        // Lieferant informieren — eigener Typ «Antwort von EVENTLINE»
        // (Mail standardmaessig an, im Portal-Konto abschaltbar).
        const fest = await festerTechnikLieferant(admin);
        if (fest.ok) {
          await notifyLieferantTechnikAntwort(admin, {
            recipients: await lieferantPortalUserIds(admin, fest.lieferant.id),
            jobId,
            jobTitle: job.title,
            dateText: jobDatumText(job.start_date, job.end_date),
            text: `${label}: «${String(review.text).slice(0, 300)}»`,
          });
        }
        return NextResponse.json({ success: true });
      }

      case "kommentar_neu": {
        const t = freitext(b.body, { feld: "Kommentar", pflicht: true });
        if (t.fehler || !t.wert) return fehler(t.fehler ?? "Kommentar fehlt");
        // Ziel-IDs muessen zu DIESEM Auftrag gehoeren (sonst unsichtbarer
        // Datenmuell an fremden Positionen/Reviews). Ohne Ziel zeigt keine
        // Oberflaeche den Kommentar an.
        if (!b.positionId && !b.reviewId) return fehler("Kommentar braucht eine Position oder Rückmeldung");
        let positionId: string | null = null;
        if (b.positionId) {
          if (!UUID_RE.test(b.positionId)) return fehler("Ungültige positionId");
          const { data: pos, error } = await admin
            .from("job_technik_positionen").select("id").eq("id", b.positionId).eq("job_id", jobId).maybeSingle();
          if (error) throw error;
          if (!pos) return fehler("Position nicht gefunden", 404);
          positionId = b.positionId;
        }
        let reviewId: string | null = null;
        if (b.reviewId) {
          if (!UUID_RE.test(b.reviewId)) return fehler("Ungültige reviewId");
          const { data: rev, error } = await admin
            .from("job_technik_reviews").select("id, status").eq("id", b.reviewId).eq("job_id", jobId).maybeSingle();
          if (error) throw error;
          if (!rev) return fehler("Rückmeldung nicht gefunden", 404);
          if (rev.status !== "offen") return fehler("Dieser Punkt ist bereits entschieden", 409);
          reviewId = b.reviewId;
        }
        const { error } = await admin.from("job_technik_kommentare").insert({
          job_id: jobId,
          position_id: positionId,
          review_id: reviewId,
          author_id: auth.user.id,
          body: t.wert,
        });
        if (error) throw error;
        await dann("kommentar", `Kommentar: «${t.wert.slice(0, 80)}»`);
        const fest = await festerTechnikLieferant(admin);
        const zuw = fest.ok ? await technikZuweisung(admin, jobId, fest.lieferant.id) : null;
        if (fest.ok && zuw?.angefragtAt) {
          await notifyLieferantTechnikAntwort(admin, {
            recipients: await lieferantPortalUserIds(admin, fest.lieferant.id),
            jobId,
            jobTitle: job.title,
            dateText: jobDatumText(job.start_date, job.end_date),
            text: t.wert,
          });
        }
        return NextResponse.json({ success: true });
      }

      default:
        return fehler("Unbekannte Aktion");
    }
  } catch (e) {
    logError("api.jobs.technik", e, { jobId, aktion: b.aktion });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}

/** Vorschlag einer uebernommenen Empfehlung in den Plan schreiben.
 *  true = ok, sonst Fehlertext (Vorschlag ungueltig / Speichern fehlgeschlagen). */
async function vorschlagAnwenden(
  admin: ReturnType<typeof createAdminClient>,
  jobId: string,
  positionId: string | null,
  v: ReviewVorschlag,
  userId: string,
): Promise<true | string> {
  const jetzt = new Date().toISOString();
  const bestaetigt = { status: "bestaetigt", bestaetigt_by: userId, bestaetigt_at: jetzt };
  if (v.typ === "menge") {
    if (!positionId) return "Vorschlag ohne Position";
    const menge = ganzeMenge(v.menge);
    if (!menge) return "Vorschlag ungültig: Menge muss eine ganze Zahl ab 1 sein";
    const { data, error } = await admin
      .from("job_technik_positionen")
      .update({ menge, ...bestaetigt })
      .eq("id", positionId)
      .eq("job_id", jobId)
      .select("id");
    if (error) { logError("api.jobs.technik.vorschlag", error, { jobId }); return "Speichern fehlgeschlagen"; }
    if (!data?.length) return "Position existiert nicht mehr";
    return true;
  }
  if (v.typ === "neue_position") {
    const menge = ganzeMenge(v.menge);
    const bezeichnung = typeof v.bezeichnung === "string" ? v.bezeichnung.trim().slice(0, TECHNIK_BEZEICHNUNG_MAX) : "";
    if (!menge || !bezeichnung) return "Vorschlag ungültig: Bezeichnung und ganze Menge nötig";
    // In die Positionsgruppe, zu der der Lieferant empfohlen hat — gibt es
    // sie nicht (mehr) oder nannte er keine: Sammelgruppe «Weitere Positionen».
    let gruppeId: string;
    try {
      const gewaehlt = typeof v.gruppe_id === "string" && UUID_RE.test(v.gruppe_id)
        ? await gruppeDesAuftrags(admin, jobId, v.gruppe_id)
        : null;
      gruppeId = gewaehlt?.id ?? (await weiterePositionenGruppe(admin, jobId, userId));
    } catch (e) {
      logError("api.jobs.technik.vorschlag", e, { jobId });
      return "Speichern fehlgeschlagen";
    }
    const { error } = await admin.from("job_technik_positionen").insert({
      job_id: jobId,
      gruppe_id: gruppeId,
      bezeichnung,
      menge,
      kategorie: (typeof v.kategorie === "string" && v.kategorie.trim().slice(0, TECHNIK_BEZEICHNUNG_MAX)) || "Sonstiges",
      details: (typeof v.details === "string" && v.details.trim()) || null,
      artikel_id: typeof v.artikel_id === "string" && UUID_RE.test(v.artikel_id) ? v.artikel_id : null,
      quelle: "lieferant",
      ...bestaetigt,
      created_by: userId,
    });
    if (error) { logError("api.jobs.technik.vorschlag", error, { jobId }); return "Speichern fehlgeschlagen"; }
    return true;
  }
  if (v.typ === "ersatz") {
    if (!positionId) return "Vorschlag ohne Position";
    const bezeichnung = typeof v.bezeichnung === "string" ? v.bezeichnung.trim().slice(0, TECHNIK_BEZEICHNUNG_MAX) : "";
    if (!bezeichnung) return "Vorschlag ungültig: Bezeichnung fehlt";
    const patch: Record<string, unknown> = { bezeichnung, quelle: "lieferant", ...bestaetigt };
    const rohMenge: unknown = v.menge;
    if (rohMenge !== undefined && rohMenge !== null) {
      const menge = ganzeMenge(rohMenge);
      if (!menge) return "Vorschlag ungültig: Menge muss eine ganze Zahl ab 1 sein";
      patch.menge = menge;
    }
    if (v.details !== undefined) patch.details = (typeof v.details === "string" && v.details.trim()) || null;
    if (v.artikel_id !== undefined) patch.artikel_id = typeof v.artikel_id === "string" && UUID_RE.test(v.artikel_id) ? v.artikel_id : null;
    const { data, error } = await admin
      .from("job_technik_positionen")
      .update(patch)
      .eq("id", positionId)
      .eq("job_id", jobId)
      .select("id");
    if (error) { logError("api.jobs.technik.vorschlag", error, { jobId }); return "Speichern fehlgeschlagen"; }
    if (!data?.length) return "Position existiert nicht mehr";
    return true;
  }
  return "Vorschlag ungültig";
}
