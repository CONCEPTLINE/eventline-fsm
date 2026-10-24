import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import {
  DIKTAT_TEXT_MAX,
  KI_ARTEN,
  KI_AUFRAEUMEN_ALLE_MS,
  KI_BUCKET,
  KI_DATEI_ARTEN,
  KI_HAENGT_NACH_MS,
  KI_MAX_VERSUCHE,
  KI_SIGNED_URL_S,
  KI_SYNC_BATCH,
} from "@/lib/ki/konstanten";
import { istKiOnline, istKiTmpPfad, raeumeKiAuf } from "@/lib/ki/queue";
import { rigAuthFehler } from "@/lib/ki/rig-auth";
import type { DiktatErgebnis, KiArt, KiSyncAuftrag, KiSyncErgebnis } from "@/lib/ki/typen";

// Abhol-Schnittstelle fuer den KI-Dienst auf dem Rig (SPEC 2.3) — im ERP nur
// noch fuer Diktat, Beleg- und Warenkorb-Erkennung (KI_ARTEN). Die Ablage-
// Arten bedient seit 24.10.2026 Trust one; das Rig spricht beide Backends
// an. Der Dienst POLLT alle 2 s — das Rig muss dafuer nicht aus dem
// Internet erreichbar sein, und Audio-/Bild-Inhalte gehen nur ueber den
// Uebergabe-Bucket (ki-tmp/, Transit) ins Buero.
//
//   GET  ?modell=&version=&gpu=<name|frei_mb>&warteschlange=
//        → Herzschlag in ki_status, dann EIN offener Auftrag (der Dienst
//          arbeitet seriell): Diktate zuerst, dann nach Prioritaet, sonst
//          FIFO (offen → laeuft, versuche+1), mit signierter Download-URL.
//          Weitere Parameter des Rigs (z. B. arten) werden ignoriert.
//   GET  ?nur_herzschlag=1 (+ dieselben Parameter)
//        → NUR der Herzschlag: das Rig sendet ihn alle 20 s aus einem
//          eigenen Thread, solange es an einem Auftrag arbeitet — keine
//          Abholung, kein Housekeeping, Antwort { auftraege: [] }.
//   POST { ergebnisse: [{ id, ok, ergebnis?, fehler? }] }
//        → fertig/fehler; die Tmp-Objekte werden danach geloescht.
//
// Auth: Bearer KI_SYNC_TOKEN (timing-safe, lib/ki/rig-auth). Ohne
// konfiguriertes Secret antwortet die Route 503 — faktisch abgeschaltet.

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Arten mit Datei im Uebergabe-Bucket (payload.storage_path = ki-tmp/<uuid>). */
function istDateiArt(art: string): boolean {
  return (KI_DATEI_ARTEN as readonly string[]).includes(art);
}

type Admin = ReturnType<typeof createAdminClient>;

/** Ergebnis-Objekt eines erfolgreichen Auftrags (sonst nichts zu bereinigen). */
function istErgebnisObjekt(e: KiSyncErgebnis): e is KiSyncErgebnis & { ergebnis: Record<string, unknown> } {
  return e.ok && !!e.ergebnis && typeof e.ergebnis === "object" && !Array.isArray(e.ergebnis);
}

/** Ein paar Kandidaten mehr als KI_SYNC_BATCH: schnappt ein paralleler
 *  Poll den ersten weg oder fehlt seine Datei, kommt der naechste noch
 *  im selben Poll dran statt erst 2 s spaeter. */
const KANDIDATEN = KI_SYNC_BATCH + 4;

/** Uebrige ERP-Arten nach den Diktaten. Zeilen anderer Arten (Altbestand der
 *  Ablage) gibt das ERP nie heraus — die bedient Trust one. */
const NICHT_DIKTAT_ARTEN = KI_ARTEN.filter((a) => a !== "diktat");

/** Abhol-Reihenfolge: Diktate zuerst — dort wartet jemand live am
 *  Mikrofon, und die Diktat-Route gibt nach 60 s auf —, danach nach
 *  Prioritaet, sonst FIFO. Die zwei Abfragen bleiben bewusst wie bisher
 *  (heisser Live-Pfad). */
async function ladeKandidaten(admin: Admin) {
  const felder = "id, art, payload, versuche";
  const { data: diktate, error: diktatErr } = await admin
    .from("ki_auftraege")
    .select(felder)
    .eq("status", "offen")
    .eq("art", "diktat")
    .order("created_at", { ascending: true })
    .limit(KANDIDATEN);
  if (diktatErr) throw new Error(diktatErr.message);
  const liste = diktate ?? [];
  if (liste.length >= KANDIDATEN) return liste;
  const { data: rest, error: restErr } = await admin
    .from("ki_auftraege")
    .select(felder)
    .eq("status", "offen")
    .in("art", NICHT_DIKTAT_ARTEN)
    .order("prioritaet", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(KANDIDATEN - liste.length);
  if (restErr) throw new Error(restErr.message);
  return [...liste, ...(rest ?? [])];
}

// Housekeeping (lib/ki/queue raeumeKiAuf) hoechstens alle 15 min pro
// Instanz — der Dienst pollt alle 2 s, da waere ein Bucket-Listing pro
// Poll reine Verschwendung. Taeglich laeuft es zusaetzlich aus dem Cron
// /api/cron/db-retention (auch wenn das Rig laenger nicht pollt).
let letzteAufraeumung = 0;

export async function GET(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;

  try {
    const admin = createAdminClient();
    const jetzt = new Date();
    const q = request.nextUrl.searchParams;

    // ── Herzschlag ────────────────────────────────────────────────────
    // online_seit bleibt stehen, solange die Polls luckenlos kommen; war
    // die KI laenger als 90 s weg, beginnt eine neue Online-Phase.
    const { data: bisher } = await admin.from("ki_status").select("letzter_poll, online_seit").eq("id", 1).maybeSingle();
    const warOnline = istKiOnline(bisher?.letzter_poll as string | null, jetzt.getTime());
    const puls: Record<string, unknown> = {
      id: 1,
      letzter_poll: jetzt.toISOString(),
      online_seit: warOnline && bisher?.online_seit ? bisher.online_seit : jetzt.toISOString(),
    };
    const modell = (q.get("modell") ?? "").trim().slice(0, 80);
    const version = (q.get("version") ?? "").trim().slice(0, 40);
    const gpuRoh = (q.get("gpu") ?? "").trim().slice(0, 120);
    const warteschlange = parseInt(q.get("warteschlange") ?? "", 10);
    if (modell) puls.modell = modell;
    if (version) puls.version = version;
    if (gpuRoh) {
      const i = gpuRoh.lastIndexOf("|");
      const freiMb = i === -1 ? NaN : parseInt(gpuRoh.slice(i + 1), 10);
      puls.gpu = { name: (i === -1 ? gpuRoh : gpuRoh.slice(0, i)).trim(), frei_mb: Number.isFinite(freiMb) ? freiMb : null };
    }
    if (Number.isFinite(warteschlange) && warteschlange >= 0) puls.warteschlange = warteschlange;
    const { error: pulsErr } = await admin.from("ki_status").upsert(puls);
    if (pulsErr) throw new Error(pulsErr.message);

    // Nur Herzschlag (waehrend das Rig an einem langen Auftrag arbeitet):
    // nichts beanspruchen, nichts zuruecksetzen, nicht aufraeumen.
    if (q.get("nur_herzschlag") === "1") {
      return NextResponse.json({ success: true, auftraege: [] });
    }

    // ── Haengende Auftraege ─────────────────────────────────────────────
    // laeuft > 20 min ohne Rueckmeldung (Dienst abgestuerzt, Modell
    // haengt): zurueck auf offen; nach dem 2. Versuch endgueltig fehler.
    const haengtSeit = new Date(jetzt.getTime() - KI_HAENGT_NACH_MS).toISOString();
    await admin
      .from("ki_auftraege")
      .update({ status: "fehler", fehler: `Lokale KI hat den Auftrag ${KI_MAX_VERSUCHE}× nicht abgeschlossen`, finished_at: jetzt.toISOString() })
      .eq("status", "laeuft")
      .lt("started_at", haengtSeit)
      .gte("versuche", KI_MAX_VERSUCHE);
    await admin
      .from("ki_auftraege")
      .update({ status: "offen", started_at: null })
      .eq("status", "laeuft")
      .lt("started_at", haengtSeit)
      .lt("versuche", KI_MAX_VERSUCHE);

    // ── Abholung: EIN Auftrag, Diktate zuerst, dann Prioritaet/FIFO ───
    const kandidaten = await ladeKandidaten(admin);

    const auftraege: KiSyncAuftrag[] = [];
    for (const row of kandidaten) {
      if (auftraege.length >= KI_SYNC_BATCH) break;
      // Je Zeile atomar beanspruchen (where status='offen' + versuche) —
      // ein zweiter Poll, der dieselbe Zeile sieht, geht leer aus.
      const { data: beansprucht } = await admin
        .from("ki_auftraege")
        .update({ status: "laeuft", started_at: jetzt.toISOString(), versuche: (row.versuche as number) + 1 })
        .eq("id", row.id)
        .eq("status", "offen")
        .eq("versuche", row.versuche)
        .select("id, art, payload, versuche")
        .maybeSingle();
      if (!beansprucht) continue;

      const payload: KiSyncAuftrag["payload"] = { ...((beansprucht.payload as Record<string, unknown>) ?? {}) };
      if (istDateiArt(beansprucht.art as string)) {
        const { data: signed } = istKiTmpPfad(payload.storage_path)
          ? await admin.storage.from(KI_BUCKET).createSignedUrl(payload.storage_path, KI_SIGNED_URL_S)
          : { data: null };
        if (!signed?.signedUrl) {
          // Datei weg (Housekeeping, Abbruch, Wartende hat aufgegeben) —
          // ohne Datei gibt es nichts zu verarbeiten.
          await admin
            .from("ki_auftraege")
            .update({ status: "fehler", fehler: "Datei liegt nicht mehr im Übergabe-Bucket", finished_at: new Date().toISOString() })
            .eq("id", beansprucht.id);
          continue;
        }
        payload.url = signed.signedUrl;
      }
      auftraege.push({
        id: beansprucht.id as string,
        art: beansprucht.art as KiArt,
        versuche: beansprucht.versuche as number,
        payload,
      });
    }

    if (Date.now() - letzteAufraeumung >= KI_AUFRAEUMEN_ALLE_MS) {
      letzteAufraeumung = Date.now();
      await raeumeKiAuf();
    }

    return NextResponse.json({ success: true, auftraege });
  } catch (e) {
    logError("ki.sync.get", e);
    return NextResponse.json({ success: false, error: "Abholung fehlgeschlagen" }, { status: 500 });
  }
}

/** Beleg-/Warenkorb-Ergebnisse: Form wie bisher sicherstellen (ok, issues,
 *  extracted), Inhalt bleibt Sache des Modells. */
function bereinigeTicketErgebnis(roh: Record<string, unknown>): Record<string, unknown> {
  const issues = Array.isArray(roh.issues)
    ? (roh.issues as unknown[]).map((x) => String(x ?? "").trim().slice(0, 200)).filter(Boolean).slice(0, 20)
    : [];
  const extracted = roh.extracted && typeof roh.extracted === "object" ? (roh.extracted as Record<string, unknown>) : {};
  return { ...roh, ok: roh.ok === true, issues, extracted };
}

/** Diktat-Ergebnis: nur Text (getrimmt, hoechstens 20 000 Zeichen — leer
 *  = nichts erkannt) und Dauer. Kein Text-Feld = kein gueltiges Ergebnis. */
function bereinigeDiktatErgebnis(roh: Record<string, unknown>): DiktatErgebnis | null {
  if (typeof roh.text !== "string") return null;
  const dauer = Number(roh.dauer_ms);
  return {
    text: roh.text.trim().slice(0, DIKTAT_TEXT_MAX),
    dauer_ms: Number.isFinite(dauer) && dauer >= 0 ? Math.round(dauer) : 0,
  };
}

/** Ergebnis je Art bereinigen; eine fremde Art (gibt das ERP nie heraus) = kein gueltiges Ergebnis. */
function bereinigeErgebnis(art: string, roh: Record<string, unknown>): unknown {
  if (art === "beleg_analyse" || art === "warenkorb_analyse") return bereinigeTicketErgebnis(roh);
  if (art === "diktat") return bereinigeDiktatErgebnis(roh);
  return null;
}

export async function POST(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;

  try {
    const body = await request.json().catch(() => null);
    const ergebnisse: KiSyncErgebnis[] = Array.isArray(body?.ergebnisse)
      ? (body.ergebnisse as { id?: unknown; ok?: unknown; ergebnis?: unknown; fehler?: unknown }[])
          .map((e) => ({
            id: String(e?.id ?? ""),
            ok: e?.ok === true,
            ergebnis: e?.ergebnis,
            fehler: String(e?.fehler ?? "").trim().slice(0, 500),
          }))
          .filter((e) => UUID_RE.test(e.id))
          .slice(0, 50)
      : [];
    if (ergebnisse.length === 0) {
      return NextResponse.json({ success: false, error: "ergebnisse fehlt" }, { status: 400 });
    }

    const admin = createAdminClient();
    const { data: rows, error: rowsErr } = await admin
      .from("ki_auftraege")
      .select("id, art, status, payload")
      .in("id", ergebnisse.map((e) => e.id));
    if (rowsErr) throw new Error(rowsErr.message);
    const zeilen = new Map((rows ?? []).map((r) => [r.id as string, r]));

    let verarbeitet = 0;
    let letzterFehler: string | null = null;
    const tmpWeg: string[] = [];

    for (const e of ergebnisse) {
      const zeile = zeilen.get(e.id);
      // Nur laufende Auftraege nehmen ein Ergebnis an — ein zu spaet
      // kommendes Ergebnis eines schon als haengend zurueckgesetzten
      // Auftrags wuerde sonst den Neuversuch ueberschreiben.
      if (!zeile || zeile.status !== "laeuft") continue;
      const art = zeile.art as string;
      const ergebnis = istErgebnisObjekt(e) ? bereinigeErgebnis(art, e.ergebnis) : null;

      let update: Record<string, unknown>;
      if (ergebnis) {
        update = { status: "fertig", ergebnis, fehler: null, finished_at: new Date().toISOString() };
      } else {
        const fehler = e.ok ? "Lokale KI hat kein gültiges Ergebnis geliefert" : e.fehler || "Lokale KI meldet einen Fehler";
        update = { status: "fehler", fehler, finished_at: new Date().toISOString() };
        // ki_status ist fuer alle internen Mitarbeiter lesbar: nie den
        // Fehlertext des Rigs dorthin (koennte Dateinamen oder Inhalte
        // enthalten), nur die Art. Der volle Text steht in
        // ki_auftraege.fehler (eigener Auftrag / Admin).
        letzterFehler = `${art}: Lokale KI meldet einen Fehler`;
      }
      const { error: updErr } = await admin.from("ki_auftraege").update(update).eq("id", e.id).eq("status", "laeuft");
      if (updErr) {
        logError("ki.sync.post.update", updErr, { id: e.id });
        continue;
      }
      verarbeitet++;

      // Beleg-/Warenkorb-Bilder und Diktat-Aufnahmen sind nach der
      // Rueckmeldung ueberfluessig.
      const pfad = (zeile.payload as Record<string, unknown> | null)?.storage_path;
      if (istDateiArt(art) && istKiTmpPfad(pfad)) tmpWeg.push(pfad);
    }

    if (tmpWeg.length > 0) {
      const { error: remErr } = await admin.storage.from(KI_BUCKET).remove(tmpWeg);
      if (remErr) logError("ki.sync.post.cleanup", remErr, { anzahl: tmpWeg.length });
    }
    if (letzterFehler) {
      await admin.from("ki_status").update({ letzter_fehler: letzterFehler }).eq("id", 1);
    }

    return NextResponse.json({ success: true, verarbeitet });
  } catch (e) {
    logError("ki.sync.post", e);
    return NextResponse.json({ success: false, error: "Ergebnis-Übernahme fehlgeschlagen" }, { status: 500 });
  }
}
