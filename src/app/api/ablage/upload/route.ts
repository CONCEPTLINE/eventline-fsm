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

import { baueAblageName, dokTyp } from "@/lib/ablage-doktypen";
import { ABLAGE_MAX_BYTES, ABLAGE_MIME_PREFIXES, KI_BUCKET } from "@/lib/ki/konstanten";
import { kiTmpPfad } from "@/lib/ki/queue";
import type { AblageAnalysePayload } from "@/lib/ki/typen";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Die abzulegende Datei, unabhaengig davon, ob sie im Request steckt
 *  oder schon im Uebergabe-Bucket liegt. */
interface Quelle {
  name: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

function heuteZurich(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" });
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

    if ((!file && !tmpId) || !betreff || !ordner) {
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
    const tmpPfad = tmpId ? kiTmpPfad(tmpId) : null;
    if (tmpPfad) {
      const { data: auftrag } = await admin
        .from("ki_auftraege")
        .select("payload")
        .eq("art", "ablage_analyse")
        .eq("payload->>storage_path", tmpPfad)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const p = (auftrag?.payload ?? null) as Partial<AblageAnalysePayload> | null;
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

    // Zielordner MUSS aus der gepflegten Struktur stammen — das ist die
    // Whitelist gegen Path-Traversal/erfundene Pfade. Deaktivierte
    // Ordner (aktiv=false) sind bewusst NICHT waehlbar.
    const { data: ordnerRow } = await admin
      .from("ablage_ordner")
      .select("pfad, aktiv")
      .eq("pfad", ordner)
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
    const abgelegtName = baueAblageName(
      { typKey, betreff, person: personEff, partei, nummer, dokDatum },
      quelle.name,
      heuteZurich(),
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
        if (aehnlichkeit(eigene, namensTokens(k.name)) >= 0.34) {
          funde.push({
            art: "aehnlich",
            text: `Gleich gross und ähnlich benannt: «${k.name}» in ${k.ordner_pfad || "(Hauptebene)"}`,
          });
          break;
        }
      }

      // c) Zielname existiert schon — wuerde als " (2)" daneben landen.
      const { data: nameDa } = await admin
        .from("ablage_datei_index")
        .select("id")
        .eq("ordner_pfad", ordnerRow.pfad)
        .eq("name", abgelegtName)
        .limit(1);
      if ((nameDa ?? []).length > 0) {
        funde.push({
          art: "zielname",
          text: `Im Zielordner liegt bereits eine Datei mit genau diesem Namen — die neue würde als « (2)» daneben abgelegt.`,
        });
      }

      if (funde.length > 0) {
        return NextResponse.json({ success: false, duplikat: true, funde: funde.slice(0, 3) }, { status: 409 });
      }
    }
    // Historie/Suche: der Beschrieb ist die menschenlesbare Kurzform.
    const beschrieb = [typ.key === "sonstiges" ? null : typ.label, betreff, personEff || null, partei || null, nummer || null]
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200);

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
    }).select("id").single();
    if (dbErr || !row) {
      logError("ablage.upload.db", dbErr, { userId: auth.effectiveUserId });
      return NextResponse.json({ success: false, error: "Ablage konnte nicht gespeichert werden" }, { status: 500 });
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

    return NextResponse.json({ success: true, abgelegt_name: abgelegtName, ordner: ordnerRow.pfad });
  } catch (e) {
    logError("ablage.upload.exception", e);
    return NextResponse.json({ success: false, error: "Upload fehlgeschlagen — Server-Fehler" }, { status: 500 });
  }
}
