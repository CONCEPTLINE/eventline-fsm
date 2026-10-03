import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { DOK_TYPEN, dokTyp } from "@/lib/ablage-doktypen";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { todayLocalIso } from "@/lib/swiss-time";
import {
  DIKTAT_TEXT_MAX,
  KI_AUFRAEUMEN_ALLE_MS,
  KI_BUCKET,
  KI_DATEI_ARTEN,
  KI_HAENGT_NACH_MS,
  KI_MAX_VERSUCHE,
  KI_SIGNED_URL_S,
  KI_SYNC_BATCH,
} from "@/lib/ki/konstanten";
import { istKiOnline, istKiTmpPfad, raeumeKiAuf } from "@/lib/ki/queue";
import type {
  AblageAnalyseErgebnis,
  AblageAnalyseKontext,
  DiktatErgebnis,
  KiArt,
  KiSyncAuftrag,
  KiSyncErgebnis,
} from "@/lib/ki/typen";

// Abhol-Schnittstelle fuer den KI-Dienst auf dem Rig (SPEC 2.3). Der
// Dienst POLLT alle 2 s — das Rig muss dafuer nicht aus dem Internet
// erreichbar sein, und Dokument-/Audio-Inhalte gehen nur ueber den
// Uebergabe-Bucket (Transit, wie bei der NAS-Ablage) ins Buero.
//
//   GET  ?modell=&version=&gpu=<name|frei_mb>&warteschlange=
//        → Herzschlag in ki_status, EIN offener Auftrag (der Dienst
//          arbeitet seriell): Diktate zuerst, sonst FIFO (offen → laeuft,
//          versuche+1), mit signierter Download-URL und — bei
//          ablage_analyse — dem Kontext (Ordner, Typen, Mitarbeiter,
//          heute), damit das Modell nur aus Bekanntem waehlt.
//   GET  ?nur_herzschlag=1 (+ dieselben Parameter)
//        → NUR der Herzschlag: das Rig sendet ihn alle 20 s aus einem
//          eigenen Thread, solange es an einem Auftrag arbeitet — keine
//          Abholung, kein Housekeeping, Antwort { auftraege: [] }.
//   POST { ergebnisse: [{ id, ok, ergebnis?, fehler? }] }
//        → fertig/fehler; Tmp-Objekte von Beleg-, Warenkorb- und
//          Diktat-Auftraegen werden geloescht (die Ablage-Datei wandert
//          spaeter per upload/tmp_id).
//
// Auth: Bearer KI_SYNC_TOKEN (timing-safe), Muster /api/ablage/sync. Ohne
// konfiguriertes Secret antwortet die Route 503 — faktisch abgeschaltet.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Arten mit Datei im Uebergabe-Bucket (payload.storage_path = ki-tmp/<uuid>). */
function istDateiArt(art: string): boolean {
  return (KI_DATEI_ARTEN as readonly string[]).includes(art);
}

function tokenOk(request: NextRequest): boolean | null {
  const secret = process.env.KI_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null; // nicht konfiguriert
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type Admin = ReturnType<typeof createAdminClient>;

/** Kontext fuer ablage_analyse: aktive Ordner (inkl. vererbter Sperre, wie
 *  name-vorschlag), DOK_TYPEN, aktive interne Mitarbeiter, heute. */
async function ladeAblageKontext(admin: Admin): Promise<AblageAnalyseKontext> {
  const { data: alleOrdner } = await admin.from("ablage_ordner").select("pfad, aktiv").order("pfad").limit(2000);
  const inaktiv = (alleOrdner ?? []).filter((o) => !o.aktiv).map((o) => o.pfad as string);
  const ordner = (alleOrdner ?? [])
    .map((o) => o.pfad as string)
    .filter((p) => !inaktiv.some((i) => p === i || p.startsWith(i + "/")))
    .slice(0, 500);
  const { data: mas } = await admin
    .from("profiles")
    .select("full_name")
    .eq("is_active", true)
    .not("role", "in", PORTAL_ROLLEN_IN)
    .order("full_name");
  const mitarbeiter = (mas ?? []).map((m) => String(m.full_name ?? "").trim()).filter(Boolean);
  return {
    ordner,
    dok_typen: DOK_TYPEN.map((t) => ({ key: t.key, label: t.label, person: !!t.person })),
    mitarbeiter,
    heute: todayLocalIso(),
  };
}

/** Ein paar Kandidaten mehr als KI_SYNC_BATCH: schnappt ein paralleler
 *  Poll den ersten weg oder fehlt seine Datei, kommt der naechste noch
 *  im selben Poll dran statt erst 2 s spaeter. */
const KANDIDATEN = KI_SYNC_BATCH + 4;

/** Abhol-Reihenfolge: Diktate zuerst — dort wartet jemand live am
 *  Mikrofon, und die Diktat-Route gibt nach 60 s auf —, danach FIFO. */
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
    .neq("art", "diktat")
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
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Lokale KI nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

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

    // ── Haengende Auftraege ───────────────────────────────────────────
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

    // ── Abholung: EIN Auftrag, Diktate zuerst, sonst FIFO ─────────────
    const kandidaten = await ladeKandidaten(admin);

    const auftraege: KiSyncAuftrag[] = [];
    let kontext: AblageAnalyseKontext | null = null;
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
      const auftrag: KiSyncAuftrag = {
        id: beansprucht.id as string,
        art: beansprucht.art as KiArt,
        versuche: beansprucht.versuche as number,
        payload,
      };
      if (auftrag.art === "ablage_analyse") {
        kontext ??= await ladeAblageKontext(admin);
        auftrag.kontext = kontext;
      }
      auftraege.push(auftrag);
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

/** Server-seitige Absicherung des Ablage-Ergebnisses: nur bekannte Typen,
 *  nur Ordner aus der Liste, Person nur als voller Name aus der
 *  Mitarbeiterliste, Datumsfelder nur als YYYY-MM-DD — das Modell darf
 *  nichts erfinden, was danach als Dateiname auf dem NAS landet. */
function bereinigeAblageErgebnis(roh: Record<string, unknown>, kontext: AblageAnalyseKontext): AblageAnalyseErgebnis {
  const text = (k: string, max = 200) => String(roh[k] ?? "").trim().slice(0, max);
  const textOderNull = (k: string, max = 120) => text(k, max) || null;
  const datum = (k: string) => (DATUM_RE.test(text(k, 10)) ? text(k, 10) : null);

  const ordnerRoh = text("ordner", 300);
  const ordner = kontext.ordner.includes(ordnerRoh) ? ordnerRoh : null;

  // Neuer Ordner nur unter einem bestehenden aktiven Eltern-Pfad, Name nach
  // Hauskonvention, Pfad noch nicht vorhanden (wie name-vorschlag).
  let neuerOrdner: string | null = null;
  if (!ordner) {
    const nroh = text("neuer_ordner", 300);
    const i = nroh.lastIndexOf("/");
    if (i > 0) {
      const eltern = nroh.slice(0, i);
      const name = nroh.slice(i + 1);
      if (kontext.ordner.includes(eltern) && /^[A-Za-z0-9_]{2,80}$/.test(name) && !kontext.ordner.includes(nroh)) {
        neuerOrdner = nroh;
      }
    }
  }

  // Person: exakter Name (ohne Gross/Klein) oder eindeutiger Wortanfang-
  // Treffer; mehrdeutig/unbekannt -> null (der Nutzer waehlt dann selbst).
  let person: string | null = null;
  const personRoh = text("person", 120);
  if (personRoh) {
    const exakt = kontext.mitarbeiter.find((n) => n.toLowerCase() === personRoh.toLowerCase());
    if (exakt) {
      person = exakt;
    } else {
      const tokens = personRoh.toLowerCase().split(/\s+/).filter(Boolean);
      const treffer = kontext.mitarbeiter.filter((n) => {
        const woerter = n.toLowerCase().split(/\s+/);
        return tokens.every((t) => woerter.some((w) => w.startsWith(t)));
      });
      if (treffer.length === 1) person = treffer[0];
    }
  }

  const seiten = Number(roh.seiten);
  const dauer = Number(roh.dauer_ms);
  return {
    beschrieb: text("beschrieb", 200),
    typ: dokTyp(text("typ", 40)) ? text("typ", 40) : "sonstiges",
    betreff: text("betreff", 120),
    person,
    partei: textOderNull("partei"),
    nummer: textOderNull("nummer"),
    dok_datum: datum("dok_datum"),
    frist: datum("frist"),
    ordner,
    neuer_ordner: neuerOrdner,
    zusammenfassung: text("zusammenfassung", 2000),
    sha256: /^[0-9a-f]{64}$/i.test(text("sha256", 64)) ? text("sha256", 64).toLowerCase() : "",
    seiten: Number.isInteger(seiten) && seiten > 0 ? seiten : null,
    ocr: roh.ocr === true,
    modell: text("modell", 80),
    dauer_ms: Number.isFinite(dauer) && dauer >= 0 ? Math.round(dauer) : 0,
  };
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

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Lokale KI nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

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

    let kontext: AblageAnalyseKontext | null = null;
    let verarbeitet = 0;
    let letzterFehler: string | null = null;
    const tmpWeg: string[] = [];

    for (const e of ergebnisse) {
      const zeile = zeilen.get(e.id);
      // Nur laufende Auftraege nehmen ein Ergebnis an — ein zu spaet
      // kommendes Ergebnis eines schon als haengend zurueckgesetzten
      // Auftrags wuerde sonst den Neuversuch ueberschreiben.
      if (!zeile || zeile.status !== "laeuft") continue;
      const art = zeile.art as KiArt;

      let ergebnis: unknown = null;
      if (e.ok && e.ergebnis && typeof e.ergebnis === "object" && !Array.isArray(e.ergebnis)) {
        const roh = e.ergebnis as Record<string, unknown>;
        if (art === "ablage_analyse") {
          kontext ??= await ladeAblageKontext(admin);
          ergebnis = bereinigeAblageErgebnis(roh, kontext);
        } else if (art === "beleg_analyse" || art === "warenkorb_analyse") {
          ergebnis = bereinigeTicketErgebnis(roh);
        } else if (art === "diktat") {
          ergebnis = bereinigeDiktatErgebnis(roh);
        } else {
          ergebnis = roh;
        }
      }
      let update: Record<string, unknown>;
      if (ergebnis) {
        update = { status: "fertig", ergebnis, fehler: null, finished_at: new Date().toISOString() };
      } else {
        const fehler = e.ok ? "Lokale KI hat kein gültiges Ergebnis geliefert" : e.fehler || "Lokale KI meldet einen Fehler";
        update = { status: "fehler", fehler, finished_at: new Date().toISOString() };
        letzterFehler = `${art}: ${fehler}`.slice(0, 300);
      }
      const { error: updErr } = await admin.from("ki_auftraege").update(update).eq("id", e.id).eq("status", "laeuft");
      if (updErr) {
        logError("ki.sync.post.update", updErr, { id: e.id });
        continue;
      }
      verarbeitet++;

      // Beleg-/Warenkorb-Bilder und Diktat-Aufnahmen sind nach der
      // Rueckmeldung ueberfluessig; die Ablage-Datei bleibt liegen, bis
      // /api/ablage/upload sie per tmp_id nach items/<id> verschiebt (oder
      // der Abbruch der Karte bzw. das 24-h-Housekeeping sie raeumt).
      const pfad = (zeile.payload as Record<string, unknown> | null)?.storage_path;
      if (art !== "ablage_analyse" && istDateiArt(art) && istKiTmpPfad(pfad)) tmpWeg.push(pfad);
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
