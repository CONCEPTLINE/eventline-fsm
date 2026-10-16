import { createAdminClient } from "@/lib/supabase/admin";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { createHash } from "crypto";

export const maxDuration = 60;

// NAS-Ablage-Upload (Leo 2026-09-26): Datei + Pflicht-Kurzbeschrieb +
// Zielordner → privater Bucket 'nas-ablage', von dort holt das NAS die
// Dateien per Sync ab. Der Dateiinhalt geht NIE an einen KI-Anbieter —
// der Server fasst nur Dateiname, Beschrieb und Zielordner an. Admin-only
// (sensible Dokumente), Service-Role schreibt in den Bucket (keine
// storage-Policies fuer normale Sessions).
//
// Zwei Datei-Quellen (SPEC docs/lokale-ki 2.3):
//   `file`   — direkt hochgeladen (bisheriger Weg).
//   `tmp_id` — die Datei liegt schon unter ki-tmp/<tmp_id>, weil die lokale
//              KI im Buero sie gelesen hat (/api/ablage/ki-upload). Dann
//              wird NICHT nochmals hochgeladen: Hash/Groesse kommen aus dem
//              Objekt, und am Ende verschiebt ein Storage-Move die Datei
//              nach items/<id>; danach wird die KI-Auftragszeile geloescht.
//              Antwort in beiden Faellen gleich.
//
// `ki_vorschlag` (optional, JSON): Momentaufnahme dessen, was die KI auf der
// Karte vorgeschlagen hatte (lib/ki/ablage-ki-vorschlag). Gespeichert neben dem
// final gewaehlten Ziel (ablage_items.ki_*, Migration 339) — Trefferquote der
// KI fuer Ablagen aus der App; ungueltig = ohne Vorschlag ablegen, nie ein Fehler.
//
// `fassung_alt` (optional, NAS-Pfad, 16.10.2026): «Als neue Fassung ablegen» auf
// der Karte — die lokale KI hat die Datei als neuere Fassung dieser NAS-Datei
// erkannt (Ergebnis `doppel`). Wie in «Einsortieren» (lib/ki/fassung): die alte
// Fassung wandert in den Historie-Ordner daneben (nie geloescht), die neue kommt
// an ihren Platz — `ordner` wird dann ignoriert. Ein Namensgleichstand mit der
// alten Fassung ist kein Duplikat (sie zieht vorher um). Scheitert das Ablegen,
// wird der Umzug der alten zurueckgenommen. Antwort zusaetzlich `historie`.

import { baueAblageName, dokTyp } from "@/lib/ablage-doktypen";
import { kiVorschlagSpalten, leseKiVorschlag, leseSeiten } from "@/lib/ki/ablage-ki-vorschlag";
import type { IndexZeile } from "@/lib/ki/bereinigen";
import { leseDoppelPfad } from "@/lib/ki/doppel";
import { legeAlteFassungAb, nimmAlteFassungZurueck, planeFassung, type FassungPlan } from "@/lib/ki/fassung";
import { ladeIndexZeilenNfc } from "@/lib/ki/kontext";
import { ABLAGE_MAX_BYTES, ABLAGE_MIME_PREFIXES, KI_BUCKET } from "@/lib/ki/konstanten";
import { kiTmpPfad } from "@/lib/ki/queue";
import type { AblageAnalysePayload } from "@/lib/ki/typen";
import { todayLocalIso } from "@/lib/swiss-time";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Die abzulegende Datei, unabhaengig davon, ob sie im Request steckt
 *  oder schon im Uebergabe-Bucket liegt. */
interface Quelle {
  name: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

/** Namens-Kern fuer den Aehnlichkeitsvergleich: klein, NFC, ohne Endung,
 *  in Wort-Tokens (>2 Zeichen) zerlegt. */
function namensTokens(name: string): Set<string> {
  return new Set(
    name
      .normalize("NFC")
      .toLowerCase()
      .replace(/\.[a-z0-9]{1,8}$/i, "")
      .split(/[^a-z0-9äöüéèà]+/i)
      .filter((t) => t.length > 2),
  );
}

/** Jaccard-Aehnlichkeit zweier Token-Mengen (0..1). */
function aehnlichkeit(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let schnitt = 0;
  for (const t of a) if (b.has(t)) schnitt++;
  return schnitt / (a.size + b.size - schnitt);
}

export async function POST(request: NextRequest) {
  // Wirft etwas, nachdem die alte Fassung eingetragen ist: im catch zuruecknehmen.
  let fassungNotfall: (() => Promise<void>) | null = null;
  try {
    const auth = await requireAdmin();
    if (auth.error) return auth.error;

    const formData = await request.formData();
    const fileRoh = formData.get("file");
    const file = fileRoh && typeof fileRoh !== "string" ? fileRoh : null;
    const ordner = (formData.get("ordner") as string | null) ?? "";
    const s = (k: string) => ((formData.get(k) as string | null) ?? "").trim().slice(0, 120);
    const tmpId = s("tmp_id");
    // Gefuehrtes Namensschema (lib/ablage-doktypen): Typ + Betreff sind
    // Pflicht; typ-abhaengige Zusatzfelder (Partei/Nummer) validiert der
    // Server nochmal — der finale Name wird HIER gebaut, nie vom Client.
    const typKey = s("typ") || "sonstiges";
    const betreff = s("betreff");
    const person = s("person");
    const partei = s("partei");
    const nummer = s("nummer");
    const dokDatum = s("dok_datum");
    const frist = s("frist");
    const fassungRoh = ((formData.get("fassung_alt") as string | null) ?? "").trim();
    const fassungAlt = fassungRoh ? leseDoppelPfad(fassungRoh) : null;
    if (fassungRoh && !fassungAlt) {
      return NextResponse.json({ success: false, error: "Pfad der älteren Fassung ungültig" }, { status: 400 });
    }

    if ((!file && !tmpId) || !betreff || (!ordner && !fassungAlt)) {
      return NextResponse.json({ success: false, error: "Datei, Betreff und Zielordner sind Pflicht" }, { status: 400 });
    }
    if (tmpId && !UUID_RE.test(tmpId)) {
      return NextResponse.json({ success: false, error: "Ungültige KI-Datei" }, { status: 400 });
    }
    const typ = dokTyp(typKey);
    if (!typ) {
      return NextResponse.json({ success: false, error: "Unbekannter Dokumenttyp" }, { status: 400 });
    }
    if (typ.partei?.pflicht && !partei) {
      return NextResponse.json({ success: false, error: `${typ.partei.label} ist bei «${typ.label}» Pflicht` }, { status: 400 });
    }
    if (typ.person?.pflicht && !person) {
      return NextResponse.json({ success: false, error: `${typ.person.label} ist bei «${typ.label}» Pflicht` }, { status: 400 });
    }
    if (dokDatum && !/^\d{4}-\d{2}-\d{2}$/.test(dokDatum)) {
      return NextResponse.json({ success: false, error: "Ungültiges Dokument-Datum" }, { status: 400 });
    }
    if (frist && !/^\d{4}-\d{2}-\d{2}$/.test(frist)) {
      return NextResponse.json({ success: false, error: "Ungültige Frist" }, { status: 400 });
    }

    const admin = createAdminClient();

    // Datei-Quelle aufloesen. Beim tmp_id-Weg sind Originalname und Mime
    // die Server-Wahrheit aus dem KI-Auftrag (nicht vom Client), die Bytes
    // kommen aus dem Uebergabe-Bucket — Hash und Duplikatpruefung laufen
    // danach identisch zum direkten Upload.
    let quelle: Quelle;
    /** Seitenzahl, wenn die lokale KI das Dokument gelesen hat (Ergebnis des Auftrags, nie vom Client). */
    let seiten: number | null = null;
    const tmpPfad = tmpId ? kiTmpPfad(tmpId) : null;
    if (tmpPfad) {
      const { data: auftrag } = await admin
        .from("ki_auftraege")
        .select("payload, ergebnis")
        .eq("art", "ablage_analyse")
        .eq("payload->>storage_path", tmpPfad)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const p = (auftrag?.payload ?? null) as Partial<AblageAnalysePayload> | null;
      seiten = leseSeiten(auftrag?.ergebnis);
      // 404 + tmp_fehlt: der Client haelt die Datei noch im Browser und laedt
      // sie dann genau einmal selbst hoch (Housekeeping raeumt ki-tmp nach 24 h).
      if (!p?.file_name) {
        return NextResponse.json({ success: false, tmp_fehlt: true, error: "KI-Datei nicht gefunden — bitte Datei erneut auswählen" }, { status: 404 });
      }
      const { data: blob, error: dlErr } = await admin.storage.from(KI_BUCKET).download(tmpPfad);
      if (dlErr || !blob) {
        return NextResponse.json({ success: false, tmp_fehlt: true, error: "KI-Datei ist nicht mehr vorhanden — bitte Datei erneut auswählen" }, { status: 404 });
      }
      quelle = {
        name: p.file_name,
        mime: p.mime || blob.type || "",
        size: blob.size,
        bytes: new Uint8Array(await blob.arrayBuffer()),
      };
    } else {
      quelle = {
        name: file!.name,
        mime: file!.type || "",
        size: file!.size,
        bytes: new Uint8Array(await file!.arrayBuffer()),
      };
    }
    if (!ABLAGE_MIME_PREFIXES.some((p) => quelle.mime.startsWith(p))) {
      return NextResponse.json({ success: false, error: `Dateityp nicht erlaubt: ${quelle.mime || "unbekannt"}` }, { status: 400 });
    }
    if (quelle.size > ABLAGE_MAX_BYTES) {
      return NextResponse.json({ success: false, error: `Datei zu gross (${Math.round(quelle.size / 1024 / 1024)}MB). Max 50MB.` }, { status: 400 });
    }

    // Als neue Fassung: Ziel ist der Platz der alten Fassung (lib/ki/fassung), nicht der gewaehlte Ordner.
    let fassung: { alt: IndexZeile; plan: FassungPlan } | null = null;
    if (fassungAlt) {
      const alt = (await ladeIndexZeilenNfc(admin, [fassungAlt])).get(fassungAlt);
      if (!alt) {
        return NextResponse.json({ success: false, error: "Die ältere Fassung liegt nicht mehr dort" }, { status: 409 });
      }
      const plan = await planeFassung(admin, alt);
      if (!plan.ok) return NextResponse.json({ success: false, error: plan.fehler }, { status: plan.status });
      fassung = { alt, plan: { zielRoh: plan.zielRoh, historie: plan.historie } };
    }

    // Zielordner MUSS aus der gepflegten Struktur stammen — das ist die
    // Whitelist gegen Path-Traversal/erfundene Pfade. Deaktivierte
    // Ordner (aktiv=false) sind bewusst NICHT waehlbar.
    const { data: ordnerRow } = await admin
      .from("ablage_ordner")
      .select("pfad, aktiv")
      .eq("pfad", fassung ? fassung.plan.zielRoh : ordner)
      .maybeSingle();
    if (!ordnerRow) {
      return NextResponse.json({ success: false, error: "Unbekannter Zielordner" }, { status: 400 });
    }
    if (!ordnerRow.aktiv) {
      return NextResponse.json({ success: false, error: "Dieser Ordner ist deaktiviert" }, { status: 400 });
    }
    // Deaktivierung vererbt sich auf den ganzen Zweig: ist irgendein
    // uebergeordneter Ordner deaktiviert, ist auch dieses Ziel gesperrt.
    const { data: inaktive } = await admin.from("ablage_ordner").select("pfad").eq("aktiv", false);
    if ((inaktive ?? []).some((r) => ordnerRow.pfad === r.pfad || ordnerRow.pfad.startsWith(r.pfad + "/"))) {
      return NextResponse.json({ success: false, error: "Ein übergeordneter Ordner ist deaktiviert" }, { status: 400 });
    }

    // Ablage-Name (so heisst die Datei am Ende auf dem NAS, Umlaute
    // erlaubt) — deterministisch aus dem Typ-Schema gebaut. Der Storage-
    // Key ist bewusst NICHT dieser Name — Supabase-Keys vertragen keine
    // Umlaute/Sonderzeichen. Datei liegt unter items/<id>; Pfad + Name
    // gehen ueber die Sync-API mit.
    // Person nur wenn der Typ sie kennt — nie versteckt in den Namen.
    const personEff = typ.person ? person : "";
    const heute = todayLocalIso();
    const abgelegtName = baueAblageName(
      { typKey, betreff, person: personEff, partei, nummer, dokDatum },
      quelle.name,
      heute,
    );

    const inhaltHash = createHash("sha256").update(quelle.bytes).digest("hex");

    // ── Duplikat-Warnung (Leo 2026-09-30) — nie blockierend ──────────
    // force=1 ("Trotzdem ablegen") ueberspringt die Pruefung.
    const force = s("force") === "1";
    if (!force) {
      const funde: { art: string; text: string }[] = [];
      const fmtDatum = (iso: string) =>
        new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });

      // a) Exakt gleicher Inhalt (sicher) — alles je via FSM Abgelegte.
      const { data: gleich } = await admin
        .from("ablage_items")
        .select("ordner_pfad, abgelegt_name, created_at")
        .eq("inhalt_hash", inhaltHash)
        .order("created_at", { ascending: false })
        .limit(1);
      if ((gleich ?? []).length > 0) {
        const g = gleich![0];
        funde.push({
          art: "inhalt",
          text: `Exakt dieselbe Datei wurde am ${fmtDatum(g.created_at)} schon abgelegt: «${g.abgelegt_name}» in ${g.ordner_pfad}`,
        });
      }

      // b) Gleiche Groesse + aehnlicher Name im NAS-Datei-Index
      //    (deckt auch den Alt-Bestand ab — dort nur "sieht aus wie").
      const { data: gleichGross } = await admin
        .from("ablage_datei_index")
        .select("pfad, ordner_pfad, name")
        .eq("groesse", quelle.size)
        .limit(200);
      const eigene = new Set([...namensTokens(quelle.name), ...namensTokens(abgelegtName)]);
      for (const k of gleichGross ?? []) {
        // Die ältere Fassung selbst ist kein Duplikat — sie zieht in die Historie.
        if (fassung && k.pfad === fassung.alt.pfad) continue;
        if (aehnlichkeit(eigene, namensTokens(k.name)) >= 0.34) {
          funde.push({
            art: "aehnlich",
            text: `Gleich gross und ähnlich benannt: «${k.name}» in ${k.ordner_pfad || "(Hauptebene)"}`,
          });
          break;
        }
      }

      // c) Zielname existiert schon — wuerde als " (2)" daneben landen. Ausser es ist
      //    die ältere Fassung: sie zieht vorher in die Historie (Sync: Verschiebungen vor neuen Dateien).
      const { data: nameDa } = await admin
        .from("ablage_datei_index")
        .select("id, pfad")
        .eq("ordner_pfad", ordnerRow.pfad)
        .eq("name", abgelegtName)
        .limit(2);
      if ((nameDa ?? []).some((z) => !(fassung && fassung.plan.historie && z.pfad === fassung.alt.pfad))) {
        funde.push({
          art: "zielname",
          text: `Im Zielordner liegt bereits eine Datei mit genau diesem Namen — die neue würde als « (2)» daneben abgelegt.`,
        });
      }

      if (funde.length > 0) {
        return NextResponse.json({ success: false, duplikat: true, funde: funde.slice(0, 3) }, { status: 409 });
      }
    }

    // Als neue Fassung: zuerst die alte in die Historie eintragen (vor der neuen Datei, siehe lib/ki/fassung) —
    // scheitert danach etwas, wird das zurueckgenommen.
    let altEingetragen = false;
    if (fassung) {
      const abgelegt = await legeAlteFassungAb(admin, fassung.alt.pfad, fassung.plan.historie);
      if (!abgelegt.ok) return NextResponse.json({ success: false, error: abgelegt.fehler }, { status: abgelegt.status });
      altEingetragen = abgelegt.eingetragen;
    }
    const fassungZurueck = async () => {
      if (fassung && altEingetragen) await nimmAlteFassungZurueck(admin, fassung.alt.pfad, fassung.plan.historie);
    };
    fassungNotfall = fassungZurueck;

    // Historie/Suche: der Beschrieb ist die menschenlesbare Kurzform.
    const beschrieb = [typ.key === "sonstiges" ? null : typ.label, betreff, personEff || null, partei || null, nummer || null]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200);

    // KI-Vorschlag neben dem final gewaehlten Ziel (Migration 339): der Name nach
    // demselben Schema und Tag wie abgelegtName, damit «unveraendert» ehrlich ist.
    const kiVorschlag = leseKiVorschlag(formData.get("ki_vorschlag"));
    const kiSpalten = kiVorschlag ? kiVorschlagSpalten(kiVorschlag, quelle.name, heute) : null;

    const { data: row, error: dbErr } = await admin.from("ablage_items").insert({
      ordner_pfad: ordnerRow.pfad,
      beschrieb,
      original_name: quelle.name,
      abgelegt_name: abgelegtName,
      storage_path: "",
      file_size: quelle.size,
      mime_type: quelle.mime || null,
      inhalt_hash: inhaltHash,
      frist: frist || null,
      created_by: auth.effectiveUserId,
      seiten,
      ...(kiSpalten ?? {}),
    }).select("id").single();
    if (dbErr || !row) {
      logError("ablage.upload.db", dbErr, { userId: auth.effectiveUserId });
      await fassungZurueck();
      return NextResponse.json({ success: false, error: "Ablage konnte nicht gespeichert werden" }, { status: 500 });
    }

    // Frist in die eine Quelle aller Fristen (ablage_fristen, MASTERPLAN
    // E3.4): Erinnerungs-Cron, Dashboard und Gruppe «Fristen» lesen dort.
    // ablage_items.frist bleibt bis zur Aufraeum-Migration mitgeschrieben.
    if (frist) {
      const { error: fristErr } = await admin.from("ablage_fristen").insert({
        ablage_item_id: row.id,
        pfad: `${ordnerRow.pfad}/${abgelegtName}`,
        sha256: inhaltHash,
        art: "sonstige",
        datum: frist,
        bezeichnung: abgelegtName.slice(0, 120),
        quelle: "ablage",
        status: "aktiv",
      });
      if (fristErr) {
        // Ohne Frist keine Erinnerung — dann lieber gar nicht ablegen
        // (der Eintrag geht mit, ablage_fristen haengt per cascade daran).
        await admin.from("ablage_items").delete().eq("id", row.id);
        logError("ablage.upload.frist", fristErr, { userId: auth.effectiveUserId });
        await fassungZurueck();
        return NextResponse.json({ success: false, error: "Frist konnte nicht gespeichert werden" }, { status: 500 });
      }
    }

    const storagePath = `items/${row.id}`;
    // tmp_id-Weg: die Datei liegt schon im Bucket — nur verschieben.
    const { error: upErr } = tmpPfad
      ? await admin.storage.from(KI_BUCKET).move(tmpPfad, storagePath)
      : await admin.storage.from("nas-ablage").upload(storagePath, quelle.bytes, {
          contentType: quelle.mime || "application/octet-stream",
          upsert: false,
        });
    if (upErr) {
      // Historie-Row nicht liegen lassen wenn die Datei fehlt.
      await admin.from("ablage_items").delete().eq("id", row.id);
      logError("ablage.upload.storage", upErr, { userId: auth.effectiveUserId });
      await fassungZurueck();
      return NextResponse.json({ success: false, error: "Upload fehlgeschlagen" }, { status: 500 });
    }
    await admin.from("ablage_items").update({ storage_path: storagePath }).eq("id", row.id);

    // tmp_id-Weg: der KI-Auftrag hat seinen Zweck erfuellt — sein Ergebnis
    // (Inhalte aus dem Dokument) bleibt nicht liegen. Bei 409/Fehler oben
    // bleibt die Zeile, weil der Nutzer erneut (oder «trotzdem») ablegt.
    if (tmpPfad) {
      const { error: kiErr } = await admin
        .from("ki_auftraege")
        .delete()
        .eq("art", "ablage_analyse")
        .eq("payload->>storage_path", tmpPfad);
      if (kiErr) logError("ablage.upload.ki-auftrag", kiErr, { tmpId });
    }

    return NextResponse.json({
      success: true,
      abgelegt_name: abgelegtName,
      ordner: ordnerRow.pfad,
      ...(fassung ? { historie: fassung.plan.historie?.pfad ?? null } : {}),
    });
  } catch (e) {
    logError("ablage.upload.exception", e);
    if (fassungNotfall) await fassungNotfall().catch(() => {});
    return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
  }
}
