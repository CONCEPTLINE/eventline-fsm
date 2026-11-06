// GET /api/jobs/[id]/ablauf/eml?art=konditionen|bestaetigung|vertrag|infomail — Outlook-Entwurf als .eml
// (`X-Unsent: 1`, An = Kunde, CC = auftrag@in.eventline-basel.com). Es wird NIE etwas verschickt.
//
//   konditionen / bestaetigung  → nur Text
//   vertrag                     → Vertrag (frisch aus den aktuellen Feldern erzeugt UND im Auftrag abgelegt,
//                                 wie POST …/vertrag — so liegt in «Dokumente» immer genau das, was an den Kunden
//                                 geht; braucht darum auftraege:edit) + Infoblatt + Checkliste + Poller-Merkblatt
//   infomail                    → Übergabe-Person/-Zeit aus dem Ablauf, Anhänge Checkliste + Infoblatt
//
// Rechte wie Aufträge (auftraege:view, bei vertrag auftraege:edit); auftrag_ablauf über den RLS-Client.
// Gruss = Vorname des angemeldeten Kontos.
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { auftragArchivSperre } from "@/lib/archiv-server";
import { logError } from "@/lib/log";
import {
  EML_ARTEN,
  baueEml,
  bestaetigungMail,
  infoMail,
  konditionenMail,
  uebergabeFenster,
  vertragMail,
  vornameVon,
  type EmlAnhang,
  type EmlArt,
  type MailText,
} from "@/lib/ablauf/eml";
import { fehlendeVertragsfelder, legeVertragAb, vertragDateiname, vertragPdf } from "@/lib/ablauf/vertrag-pdf";
import { felderAusDb } from "@/lib/ablauf/schritte";
import { ladeUnterlage } from "@/lib/ablauf/unterlagen";

export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const art = req.nextUrl.searchParams.get("art") as EmlArt | null;
  if (!art || !EML_ARTEN.includes(art)) return fehler("Unbekannte Art");
  const auth = await requirePermission(art === "vertrag" ? "auftraege:edit" : "auftraege:view");
  if (auth.error) return auth.error;
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");

  try {
    const supabase = await createClient();
    const { data: ablauf, error: aErr } = await supabase
      .from("auftrag_ablauf")
      .select("felder, uebergabe_person_id, uebergabe_start")
      .eq("job_id", jobId)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!ablauf) return fehler("Kein Vermietungs-Ablauf zu diesem Auftrag", 404);

    const admin = createAdminClient();
    const { felder } = felderAusDb(ablauf.felder);
    // Namen (und Telefon der Übergabe-Person) mit dem Admin-Client: Profil-Spalten sind per RLS teils gesperrt.
    const ids = [auth.user.id, ablauf.uebergabe_person_id as string | null].filter((x): x is string => !!x);
    const { data: profile, error: pErr } = await admin.from("profiles").select("id, full_name, phone").in("id", ids);
    if (pErr) throw pErr;
    const profil = (id: string | null) => (id ? (profile ?? []).find((p) => p.id === id) : undefined);
    const absender = vornameVon(profil(auth.user.id)?.full_name as string | undefined);

    let text: MailText;
    const anhaenge: EmlAnhang[] = [];
    if (art === "konditionen") {
      text = konditionenMail(felder, absender);
    } else if (art === "bestaetigung") {
      text = bestaetigungMail(felder, absender);
    } else if (art === "infomail") {
      const person = profil(ablauf.uebergabe_person_id as string | null);
      const { von, bis } = uebergabeFenster(ablauf.uebergabe_start as string | null);
      text = infoMail(
        felder,
        absender,
        person ? { name: vornameVon(person.full_name as string), telefon: (person.phone as string | null) ?? null } : null,
        von,
        bis,
      );
      anhaenge.push(await ladeUnterlage("checkliste"), await ladeUnterlage("infoblatt"));
    } else {
      const sperre = await auftragArchivSperre(admin, jobId);
      if (sperre) return sperre;
      const fehlt = fehlendeVertragsfelder(felder);
      if (fehlt.length > 0) {
        return NextResponse.json(
          { success: false, error: `Für den Vertrag fehlt noch: ${fehlt.join(", ")}`, fehlt },
          { status: 409 },
        );
      }
      const bytes = await vertragPdf(felder, { uebergabeStart: ablauf.uebergabe_start as string | null });
      const name = vertragDateiname(felder);
      await legeVertragAb(admin, {
        jobId,
        userId: auth.user.id,
        dateiname: name,
        bytes,
        setzeVerweis: async (id) => {
          const { error } = await supabase.from("auftrag_ablauf").update({ vertrag_dokument_id: id }).eq("job_id", jobId);
          if (error) throw error;
        },
      });
      text = vertragMail(felder, absender);
      anhaenge.push(
        { name, bytes },
        await ladeUnterlage("infoblatt"),
        await ladeUnterlage("checkliste"),
        await ladeUnterlage("poller"),
      );
    }

    const eml = baueEml({ ...text, an: felder.email.trim(), anhaenge });
    return new NextResponse(eml, {
      headers: {
        "Content-Type": "message/rfc822; charset=utf-8",
        "Content-Disposition": `attachment; filename="${text.dateiname}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    logError("api.jobs.ablauf.eml", e, { jobId, art });
    return fehler("Entwurf konnte nicht erstellt werden", 500);
  }
}
