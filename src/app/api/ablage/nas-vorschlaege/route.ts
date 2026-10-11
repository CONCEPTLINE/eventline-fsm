import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ladeAktiveOrdner, ladeIndexZeilen } from "@/lib/ki/kontext";
import { nfcZuRoh } from "@/lib/ki/pfade";
import { leseEntscheideBody, leseZiel, pruefeZiel, type Entscheid, type EntscheidErgebnis } from "@/lib/ki/vorschlaege";

// POST /api/ablage/nas-vorschlaege — Admin entscheidet ueber Vorschlaege der
// Nachtarbeit (docs/lokale-ki/MASTERPLAN.md §3.8 MP-7; Rueckstau ZZ auf der
// NAS-Seite, src/components/nas/vorschlaege-gruppe.tsx).
//   Body { entscheide: [{ id, aktion: "annehmen"|"korrigieren"|"ablehnen", ordner? }] }
//   (1–50, korrigieren nur mit ordner)
//   Antwort { success, ergebnisse: [{ id, ok, status?, fehler?, code }] }
//     success = alle ok; HTTP 200, ausser ALLE Eintraege scheitern mit
//     demselben Code (dann dieser, z. B. 409 bei einem einzelnen
//     veralteten Vorschlag). 400 = Body formal falsch (nichts geschrieben).
//
// Je Eintrag atomar und idempotent:
//   - Status wechselt nur bedingt aus «offen» (update … where status =
//     'offen'). Doppelklick / zwei Admins gleichzeitig -> genau einer
//     gewinnt; der andere bekommt den End-Status zurueck (gleicher Status
//     = ok, bei uebernommen nur mit stehendem Verschiebe-Auftrag; sonst
//     409 «schon entschieden» bzw. «wird gerade bearbeitet»).
//   - annehmen/korrigieren: Ziel = ziel_ordner bzw. ordner; muss ein
//     aktiver Ordner sein, nie ZZ_*/99_System, kein «..», nicht absolut
//     (gleiche Regeln wie die Nachtarbeit). Verglichen in NFC, geschrieben
//     in der Schreibweise von ablage_ordner bzw. Datei-Index (lib/ki/pfade
//     — sonst Zwillingsordner auf dem NAS). Datei nicht mehr im Datei-Index ->
//     «veraltet», 409. Danach Verschiebe-Auftrag ablage_moves (pfad,
//     ziel_ordner) wie die Verschiebung auf der NAS-Seite; der NAS-Sync
//     fuehrt ihn aus und meldet zurueck (-> «erledigt», /api/ablage/sync).
//     Steht fuer die Datei schon ein Auftrag (pfad unique) -> Status zurueck
//     auf «offen», 409.
//   - ablehnen -> «abgelehnt»: das Rig schlaegt dasselbe Ziel 180 Tage
//     nicht erneut vor (Kontext/Nachtarbeit).
// Admin-Client (RLS der Tabellen ist ohnehin nur Admin). Logs nur mit
// Anzahlen — nie Pfade oder Ordner.

type Admin = ReturnType<typeof createAdminClient>;

interface VorschlagZeile {
  id: string;
  art: string;
  pfad: string;
  ordner_ist: string;
  ziel_ordner: string;
  status: string;
}

const STATUS_FUER: Record<Entscheid["aktion"], string> = {
  annehmen: "angenommen",
  korrigieren: "korrigiert",
  ablehnen: "abgelehnt",
};
const STATUS_TEXT: Record<string, string> = {
  angenommen: "übernommen",
  korrigiert: "übernommen (anderer Ordner)",
  abgelehnt: "abgelehnt",
  erledigt: "schon verschoben",
  veraltet: "veraltet",
};

/** Aktuellen Stand nachlesen, wenn der Vorschlag nicht (mehr) offen ist
 *  (jemand war schneller, Doppelklick, zweiter Tab). Derselbe Entscheid
 *  = idempotent ok: abgelehnt bei «ablehnen», bzw. uebernommen mit demselben
 *  Zielordner (Vergleich in NFC) bei «annehmen»/«korrigieren» — dann aber
 *  nur, wenn der Verschiebe-Auftrag wirklich steht (oder schon erledigt
 *  ist): der erste Admin setzt den Status sonst evtl. gleich wieder auf
 *  «offen» zurueck (Auftrag scheitert), und der zweite hielte ihn fuer
 *  erledigt. */
async function nachlesen(admin: Admin, zeile: VorschlagZeile, ablehnen: boolean, zielNfc: string | null): Promise<EntscheidErgebnis> {
  const id = zeile.id;
  const { data, error } = await admin.from("nas_vorschlaege").select("status, gewaehlt_ordner").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { id, ok: false, code: 404, fehler: "Vorschlag nicht gefunden" };
  const status = data.status as string;
  const gewaehlt = (data.gewaehlt_ordner as string | null) ?? null;
  if (ablehnen ? status === "abgelehnt" : status === "erledigt" && gewaehlt !== null && gewaehlt.normalize("NFC") === zielNfc) {
    return { id, ok: true, status, code: 200 };
  }
  if (!ablehnen && (status === "angenommen" || status === "korrigiert") && gewaehlt !== null && gewaehlt.normalize("NFC") === zielNfc) {
    const { data: auftrag, error: auftragErr } = await admin
      .from("ablage_moves")
      .select("pfad")
      .eq("pfad", zeile.pfad)
      .eq("ziel_ordner", gewaehlt)
      .maybeSingle();
    if (auftragErr) throw new Error(auftragErr.message);
    if (auftrag) return { id, ok: true, status, code: 200 };
    return { id, ok: false, status, code: 409, fehler: "Wird gerade von jemand anderem bearbeitet" };
  }
  if (status === "veraltet") return { id, ok: false, status, code: 409, fehler: "Datei liegt nicht mehr dort" };
  return { id, ok: false, status, code: 409, fehler: `Schon entschieden (${STATUS_TEXT[status] ?? status})` };
}

async function entscheide(
  admin: Admin,
  e: Entscheid,
  zeile: VorschlagZeile | undefined,
  aktiv: ReadonlyMap<string, string>,
  imIndex: ReadonlySet<string>,
  userId: string,
): Promise<EntscheidErgebnis> {
  if (!zeile) return { id: e.id, ok: false, code: 404, fehler: "Vorschlag nicht gefunden" };
  const gewollt = STATUS_FUER[e.aktion];
  const ablehnen = e.aktion === "ablehnen";
  // Ziel in NFC (Vergleich); geschrieben wird die Schreibweise der Ordnerliste.
  const zielNfc = ablehnen ? null : leseZiel(e.aktion === "korrigieren" ? (e.ordner ?? "") : zeile.ziel_ordner);
  if (zeile.status !== "offen") return nachlesen(admin, zeile, ablehnen, zielNfc);

  const jetzt = new Date().toISOString();
  const entschieden = { entschieden_von: userId, entschieden_am: jetzt, updated_at: jetzt };

  if (e.aktion === "ablehnen") {
    const { data, error } = await admin
      .from("nas_vorschlaege")
      .update({ status: gewollt, gewaehlt_ordner: null, ...entschieden })
      .eq("id", e.id)
      .eq("status", "offen")
      .select("id");
    if (error) throw new Error(error.message);
    if ((data ?? []).length === 0) return nachlesen(admin, zeile, true, null);
    return { id: e.id, ok: true, status: gewollt, code: 200 };
  }

  // annehmen / korrigieren — «korrigieren» auf genau den Vorschlag der KI
  // ist ein Annehmen.
  const geprueft = pruefeZiel(zielNfc, aktiv, zeile.ordner_ist);
  if (!("ziel" in geprueft)) return { id: e.id, ok: false, status: "offen", ...geprueft };
  const ziel = geprueft.ziel;
  const status = e.aktion === "korrigieren" && zielNfc === zeile.ziel_ordner.normalize("NFC") ? "angenommen" : gewollt;

  if (!imIndex.has(zeile.pfad)) {
    // Datei liegt nicht mehr dort (verschoben, geloescht) -> veraltet.
    const { data, error } = await admin
      .from("nas_vorschlaege")
      .update({ status: "veraltet", updated_at: jetzt })
      .eq("id", e.id)
      .eq("status", "offen")
      .select("id");
    if (error) throw new Error(error.message);
    if ((data ?? []).length === 0) return nachlesen(admin, zeile, false, zielNfc);
    return { id: e.id, ok: false, status: "veraltet", code: 409, fehler: "Datei liegt nicht mehr dort" };
  }

  const { data, error } = await admin
    .from("nas_vorschlaege")
    .update({ status, gewaehlt_ordner: ziel, ...entschieden })
    .eq("id", e.id)
    .eq("status", "offen")
    .select("id");
  if (error) throw new Error(error.message);
  if ((data ?? []).length === 0) return nachlesen(admin, zeile, false, zielNfc);

  const { error: moveErr } = await admin.from("ablage_moves").insert({ pfad: zeile.pfad, ziel_ordner: ziel });
  if (moveErr) {
    // Zurueck auf «offen» — bedingt auf den eben gesetzten Status, damit
    // nichts Fremdes ueberschrieben wird.
    const { error: zurueckErr } = await admin
      .from("nas_vorschlaege")
      .update({ status: "offen", gewaehlt_ordner: null, entschieden_von: null, entschieden_am: null, updated_at: new Date().toISOString() })
      .eq("id", e.id)
      .eq("status", status);
    if (zurueckErr) logError("ablage.nas-vorschlaege.zurueck", zurueckErr.message);
    if (moveErr.code === "23505") {
      return { id: e.id, ok: false, status: "offen", code: 409, fehler: "Für diese Datei steht schon eine Verschiebung aus" };
    }
    logError("ablage.nas-vorschlaege.move", moveErr.message);
    return { id: e.id, ok: false, status: "offen", code: 500, fehler: "Verschiebe-Auftrag konnte nicht angelegt werden" };
  }
  return { id: e.id, ok: true, status, code: 200 };
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const gelesen = leseEntscheideBody(await request.json().catch(() => null));
  if (!gelesen.ok) return NextResponse.json({ success: false, error: gelesen.fehler }, { status: 400 });
  const liste = gelesen.entscheide;

  try {
    const admin = createAdminClient();
    const { data: zeilen, error } = await admin
      .from("nas_vorschlaege")
      .select("id, art, pfad, ordner_ist, ziel_ordner, status")
      .in("id", liste.map((e) => e.id));
    if (error) throw new Error(error.message);
    const jeId = new Map(((zeilen ?? []) as VorschlagZeile[]).map((z) => [z.id.toLowerCase(), z]));

    // Ordnerliste und Datei-Index nur laden, wenn etwas verschoben werden soll.
    const verschieben = liste.filter((e) => e.aktion !== "ablehnen" && jeId.get(e.id)?.status === "offen");
    const aktiv = verschieben.length > 0 ? nfcZuRoh(await ladeAktiveOrdner(admin)) : new Map<string, string>();
    const index = verschieben.length > 0 ? await ladeIndexZeilen(admin, verschieben.map((e) => jeId.get(e.id)!.pfad)) : new Map();
    const imIndex = new Set<string>(index.keys());

    const ergebnisse: EntscheidErgebnis[] = [];
    for (const e of liste) {
      try {
        ergebnisse.push(await entscheide(admin, e, jeId.get(e.id), aktiv, imIndex, auth.user.id));
      } catch (err) {
        logError("ablage.nas-vorschlaege.eintrag", err);
        ergebnisse.push({ id: e.id, ok: false, code: 500, fehler: "Entscheid konnte nicht gespeichert werden" });
      }
    }

    const success = ergebnisse.every((x) => x.ok);
    const codes = new Set(ergebnisse.map((x) => x.code));
    const status = !ergebnisse.some((x) => x.ok) && codes.size === 1 ? [...codes][0] : 200;
    return NextResponse.json({ success, ergebnisse }, { status });
  } catch (e) {
    logError("ablage.nas-vorschlaege", e, { anzahl: liste.length });
    return NextResponse.json({ success: false, error: "Entscheide konnten nicht gespeichert werden" }, { status: 500 });
  }
}
