// Kern der Auftrag-Eingang-Verarbeitung — von ZWEI Aufrufern genutzt:
//  - /api/ai/eingang (User legt Element in der App ab; Auth + Sichtbarkeit
//    prueft die Route vorher unter USER-RLS)
//  - /api/inbound/mail (weitergeleitete Mail via Resend-Webhook; kein User)
// Laeuft komplett auf dem Admin-Client. Wirft bei Fehlern (nachdem das
// Element auf ai_status='fehler' gesetzt wurde) — der Aufrufer entscheidet
// ueber die Antwort.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall } from "@/lib/ai/anthropic";
import { logTechnik } from "@/lib/technik-server";

// Supabase-Join kommt je nach Kardinalitaet als Objekt ODER Array zurueck.
function relName(v: unknown): string | null {
  const o = Array.isArray(v) ? v[0] : v;
  return o && typeof o === "object" && "name" in o ? String((o as { name: unknown }).name) : null;
}

export type DatumVorschlag = { start_datum: string; end_datum: string; grund: string };

export type TerminVorschlag = {
  aktion: "erstellen" | "aendern";
  termin_id: string | null;
  titel: string;
  start: string;
  ende: string | null;
  grund: string;
};

export type MaterialPosition = {
  aktion: "neu" | "aendern" | "entfernen";
  material_id: string | null;
  menge: number;
  bezeichnung: string;
  details: string | null;
  masse: { l: number | null; b: number | null; h: number | null } | null;
};

type Ergebnis = {
  zusammenfassung: string;
  neue_zusagen: { text: string; mit_wem: string | null }[];
  erledigte_zusagen_ids: string[];
  hinfaellige_zusagen_ids: string[];
  datum_aenderung: { start_datum: string; end_datum: string | null; grund: string } | null;
  inhalt_datum: string | null;
  termin_vorschlaege: TerminVorschlag[];
  material_positionen: MaterialPosition[];
};

const ERGEBNIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["zusammenfassung", "neue_zusagen", "erledigte_zusagen_ids", "hinfaellige_zusagen_ids", "datum_aenderung", "inhalt_datum", "termin_vorschlaege", "material_positionen"],
  properties: {
    zusammenfassung: {
      type: "string",
      description:
        "KURZFASSUNG im Telegrammstil — der Leser muss in ZWEI BLICKEN erfassen, was Sache ist. " +
        "ZWINGEND: Zeile '=== OPERATIV ===' (Durchführung), dann Zeile '=== ADMINISTRATIV ===' (Geschäftliches). " +
        "Pro Kachel MAXIMAL 6 Stichpunkte, jeder genau EINE Zeile im Format '- Schlagwort: Kernaussage'. " +
        "Das Schlagwort ist KURZ (1-3 Wörter, nie über 30 Zeichen), ohne Klammer-Zusätze und ohne Doppelpunkt — alle Details gehören in die Kernaussage. " +
        "Die Kernaussage ist ein KLARER, verständlicher Satz für jemanden, der den Vorgang nicht kennt — kurz, aber kein kryptisches Fragment. " +
        "Abkürzungen und Fachjargon aus Mails NIE unerklärt übernehmen: ausschreiben oder in Klammern erklären (z.B. 'Tech' → 'technische Probe', 'Get-in' → 'Zugang zur Location'). " +
        "Fremdsprachige Eingänge ins Deutsche übertragen. Zahlen und Fakten NUR, wenn sie wörtlich im Eingang stehen — nichts errechnen, nichts schätzen. " +
        "Wichtigstes zuoberst: aktueller Stand und was zu tun ist. Offene/zu klärende Punkte als '- OFFEN: …' — " +
        "IMMER als vollständiger, selbsterklärender Auftrag formuliert (was ist zu tun/zu klären, ggf. mit wem und bis wann), " +
        "z.B. '- OFFEN: Frau Pappenberger antworten, ob die Offerte für beide Lieferszenarien gilt' — NIE nur ein Stichwort. " +
        "Meldet das neue Element, dass ein offener Punkt erledigt/geklärt ist, ENTFERNE ihn aus OFFEN (nicht als erledigt stehen lassen). " +
        "TEAM-EINTRÄGE (intern vom EVENTLINE-Team erfasst, keine Mails): Das Team dokumentiert NACH dem Erledigen — was drinsteht, IST gemacht und die Kundschaft darüber bereits informiert. " +
        "Leite daraus NIEMALS neue Offen-Punkte ab (kein 'prüfen', 'mitteilen', 'anpassen', 'informieren') und ENTFERNE bestehende Offen-Punkte, die dadurch erledigt oder hinfällig sind. " +
        "Offen bleibt nur, was das Team AUSDRÜCKLICH als offene Frage oder noch zu erledigende Aufgabe formuliert. " +
        "Nennt ein neueres Element andere Zahlen, Namen oder Termine als bisher (z.B. 6 statt 9 Podeste), ERSETZE die alte Angabe ÜBERALL in der Zusammenfassung — auch in Offen-Punkten; die alte Zahl darf nirgends stehen bleiben. " +
        "ZEITLOGIK: Massgeblich ist das SENDEDATUM des Inhalts (bei Weiterleitungen die Sent:/Gesendet:-Daten im Verlauf), NICHT die Reihenfolge des Eintreffens. " +
        "Ordne das neue Element anhand der CHRONIK zeitlich ein: Ist es NEUER, ersetzt sein Stand die älteren Angaben. " +
        "Ist es ÄLTER als bereits Verarbeitetes, ergänze nur fehlende Hintergründe — den aktuellen Stand (geklärte Fragen, aktuelle Namen/Termine/Zusagen) darfst du damit NICHT zurückdrehen. " +
        "KEINE Abschnitts-Titel, KEINE Detail-Aufzählungen (Stückzahlen-Listen etc. bündeln — Details bleiben im Eingang abrufbar). " +
        "Deutsch, nichts erfinden. Leere Kachel: Marker-Zeile trotzdem schreiben.",
    },
    datum_aenderung: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["start_datum", "end_datum", "grund"],
      description:
        "NUR wenn der neue Eingang EINDEUTIG ein neues/verschobenes Event-Datum fuer DIESEN Auftrag nennt — sonst null.",
      properties: {
        start_datum: { type: "string", description: "Neues Event-Startdatum als YYYY-MM-DD." },
        end_datum: { type: ["string", "null"], description: "Neues Enddatum als YYYY-MM-DD, null = gleich wie Start." },
        grund: { type: "string", description: "Ein Satz: woraus sich das neue Datum ergibt." },
      },
    },
    neue_zusagen: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "mit_wem"],
        properties: {
          text: { type: "string", description: "Die verbindliche Zusage, ein praegnanter Satz." },
          mit_wem: { type: ["string", "null"], description: "Ansprechperson beim Kunden, falls erkennbar." },
        },
      },
    },
    erledigte_zusagen_ids: { type: "array", items: { type: "string" } },
    hinfaellige_zusagen_ids: { type: "array", items: { type: "string" } },
    inhalt_datum: {
      type: ["string", "null"],
      description:
        "SENDEDATUM des Inhalts als ISO (YYYY-MM-DD oder mit Zeit): bei weitergeleiteten Mails das NEUSTE Datum " +
        "im Verlauf (Sent:/Gesendet:-Zeilen), nicht das Weiterleitungsdatum; null wenn nicht erkennbar.",
    },
    material_positionen: {
      type: "array",
      description:
        "Gebuchtes/bestelltes MATERIAL fuer diesen Auftrag (Podeste, Scheinwerfer, Leinwand, Stative, Mobiliar, Technik …), " +
        "NUR was woertlich als gebucht/bestellt/gebraucht bestaetigt ist — keine blossen Anfragen, nichts erfinden. " +
        "Gegen BESTEHENDES MATERIAL abgleichen: gleiche Position schon erfasst = NICHT nochmal ('neu' nur fuer wirklich Neues); " +
        "nennt das Element andere Mengen/Details zu einer bestehenden Position (z.B. 6 statt 9 Podeste) = aktion 'aendern' mit deren material_id; " +
        "faellt eine Position weg = 'entfernen' mit material_id. Leer wenn kein Material erwaehnt.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aktion", "material_id", "menge", "bezeichnung", "details", "masse"],
        properties: {
          aktion: { type: "string", enum: ["neu", "aendern", "entfernen"] },
          material_id: { type: ["string", "null"], description: "Bei 'aendern'/'entfernen' die id aus BESTEHENDES MATERIAL, sonst null." },
          menge: { type: "number", description: "Stueckzahl/Menge." },
          bezeichnung: { type: "string", description: "Kurzbezeichnung, z.B. 'Buehnenpodest' oder 'Scheinwerfer warmes Licht'." },
          details: { type: ["string", "null"], description: "Woertliche Zusatzinfos (z.B. 'ueber Lichtpult regelbar'), sonst null." },
          masse: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["l", "b", "h"],
            description: "Masse in METERN, nur wenn woertlich genannt (z.B. Podest 2x1m, 20cm hoch => l:2, b:1, h:0.2); sonst null.",
            properties: {
              l: { type: ["number", "null"] },
              b: { type: ["number", "null"] },
              h: { type: ["number", "null"] },
            },
          },
        },
      },
    },
    termin_vorschlaege: {
      type: "array",
      description:
        "NUR wenn das neue Element konkrete Auftrags-Termine mit Datum UND Uhrzeit nennt (Aufbau, Abbau, Probe, Lieferung, Besprechung vor Ort). " +
        "Du legst NIE selbst Termine an — das Team wird gefragt. " +
        "Vergleiche mit BESTEHENDE TERMINE: existiert der Termin schon mit gleicher Zeit, NICHT vorschlagen; " +
        "existiert er mit anderer Zeit, aktion 'aendern' mit dessen termin_id; sonst aktion 'erstellen'. Leer wenn keine Termine genannt.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["aktion", "termin_id", "titel", "start", "ende", "grund"],
        properties: {
          aktion: { type: "string", enum: ["erstellen", "aendern"] },
          termin_id: { type: ["string", "null"], description: "Bei 'aendern' die id aus BESTEHENDE TERMINE, sonst null." },
          titel: { type: "string", description: "Kurzer Termin-Titel, z.B. 'Aufbau' oder 'Abbau'." },
          start: { type: "string", description: "Beginn als ISO 8601 MIT Schweizer Zeitzonen-Offset, z.B. 2026-09-22T13:30:00+02:00." },
          ende: { type: ["string", "null"], description: "Ende als ISO 8601 mit Offset, null wenn unbekannt." },
          grund: { type: "string", description: "Ein Satz: woraus sich der Termin ergibt." },
        },
      },
    },
  },
};

export async function verarbeiteEingangItem(opts: {
  admin: SupabaseClient;
  jobId: string;
  itemId: string;
  /** App-User der das Element abgelegt hat; null bei Mail-Eingang. */
  actorUserId: string | null;
}): Promise<{ neueZusagen: number; datumVorschlag: DatumVorschlag | null; terminVorschlaege: number }> {
  const { admin, jobId, itemId, actorUserId } = opts;

  const { data: job } = await admin
    .from("jobs")
    .select("id, title, job_number, start_date, end_date, description, ai_summary, customer:customers(name), location:locations(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) throw new Error("Auftrag nicht gefunden");

  const { data: item } = await admin
    .from("job_inbox_items")
    .select("id, job_id, kind, content, file_path, file_name, mime_type, absender")
    .eq("id", itemId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (!item) throw new Error("Eingang-Element nicht gefunden");

  const { data: zusagen } = await admin
    .from("job_zusagen")
    .select("id, text, status, mit_wem")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  // Bestehende Technik-Positionen (die EINE Materialliste des Auftrags,
  // Migration 264) — damit die KI 'aendern' statt Duplikat liefert.
  const { data: material } = await admin
    .from("job_technik_positionen")
    .select("id, status, menge, bezeichnung, details")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  // Bestehende Termine — damit die KI 'aendern' statt Duplikat vorschlaegt.
  const { data: termine } = await admin
    .from("job_appointments")
    .select("id, title, start_time, end_time")
    .eq("job_id", jobId)
    .order("start_time");

  // Chronik der bereits verarbeiteten Elemente — damit die KI einordnen
  // kann, ob das NEUE Element zeitlich VOR oder NACH dem bisherigen Wissen
  // liegt (Mails treffen in beliebiger Reihenfolge ein).
  const { data: chronikRows } = await admin
    .from("job_inbox_items")
    .select("kind, absender, content, file_name, created_at, inhalt_datum")
    .eq("job_id", jobId)
    .eq("ai_status", "verarbeitet")
    .neq("id", itemId)
    .order("created_at", { ascending: true })
    .limit(20);
  const chronik = (chronikRows ?? [])
    .map((c) => {
      const wann = (c.inhalt_datum ?? c.created_at ?? "").slice(0, 16).replace("T", " ");
      const was = c.kind === "text" ? (c.content ?? "").replace(/\s+/g, " ").slice(0, 90) : `Datei ${c.file_name}`;
      return `${wann} | ${c.absender ?? "App"} | ${was}`;
    })
    .join("\n");

  // ── KI-Kontext bauen ─────────────────────────────────────────
  const content: Anthropic.ContentBlockParam[] = [];
  const kontext = [
    `AUFTRAG ${job.job_number ?? ""}: ${job.title}`,
    relName(job.customer) ? `Kunde: ${relName(job.customer)}` : null,
    relName(job.location) ? `Ort: ${relName(job.location)}` : null,
    job.start_date ? `Zeitraum: ${job.start_date} bis ${job.end_date ?? "?"}` : null,
    job.description ? `Beschreibung: ${job.description}` : null,
    job.ai_summary ? `\nBISHERIGE ZUSAMMENFASSUNG:\n${job.ai_summary}` : null,
    chronik ? `\nCHRONIK bereits verarbeiteter Elemente (Sendedatum | von | Inhalt):\n${chronik}` : null,
    termine?.length
      ? `\nBESTEHENDE TERMINE (id | start | ende | titel):\n` +
        termine.map((t) => `${t.id} | ${t.start_time} | ${t.end_time ?? "-"} | ${t.title}`).join("\n")
      : "\nBisher keine Termine auf dem Auftrag.",
    material?.length
      ? `\nBESTEHENDES MATERIAL (id | status | menge | bezeichnung):\n` +
        material.map((m) => `${m.id} | ${m.status} | ${m.menge}x | ${m.bezeichnung}${m.details ? ` (${m.details})` : ""}`).join("\n")
      : "\nBisher kein Material erfasst.",
    zusagen?.length
      ? `\nBESTEHENDE ZUSAGEN (id | status | text):\n` +
        zusagen.map((z) => `${z.id} | ${z.status} | ${z.text}${z.mit_wem ? ` (mit ${z.mit_wem})` : ""}`).join("\n")
      : "\nBisher keine Zusagen erfasst.",
  ].filter(Boolean).join("\n");
  content.push({ type: "text", text: kontext });

  const herkunft = item.absender ? ` (per Mail von ${item.absender})` : " (intern vom EVENTLINE-Team erfasst)";
  if (item.kind === "text" && item.content) {
    content.push({ type: "text", text: `\nNEUER EINGANG (Text${herkunft}):\n${item.content}` });
  } else if (item.kind === "datei" && item.file_path) {
    const { data: signed } = await admin.storage.from("documents").createSignedUrl(item.file_path, 600);
    const mime = item.mime_type ?? "";
    if (signed?.signedUrl && mime.startsWith("image/")) {
      content.push({ type: "text", text: `\nNEUER EINGANG (Bild "${item.file_name}"${herkunft}):` });
      content.push({ type: "image", source: { type: "url", url: signed.signedUrl } });
    } else if (signed?.signedUrl && mime === "application/pdf") {
      content.push({ type: "text", text: `\nNEUER EINGANG (PDF "${item.file_name}"${herkunft}):` });
      content.push({ type: "document", source: { type: "url", url: signed.signedUrl } });
    } else {
      content.push({ type: "text", text: `\nNEUER EINGANG: Datei "${item.file_name}" (${mime || "unbekannter Typ"}) — Inhalt nicht lesbar, nur zur Kenntnis.` });
    }
  }

  try {
    const ergebnis = await structuredCall<Ergebnis>({
      system:
        "Du bist das Gedächtnis eines Veranstaltungstechnik-Auftrags der Firma EVENTLINE (Basel). " +
        "Du erhältst den Auftragskontext, die bisherige Zusammenfassung, die bestehenden Zusagen und EIN neues Eingang-Element " +
        "(diktierte Notiz, weitergeleitete Kunden-Mail, Screenshot, Foto oder PDF). " +
        "Aufgaben: (1) Zusammenfassung aktualisieren — strukturiert nach Schema-Vorgabe (Abschnitte in GROSSBUCHSTABEN + '- '-Stichpunkte), sachlich, nichts erfinden. " +
        "(2) NEUE verbindliche Zusagen an den Kunden extrahieren (nur echte Abmachungen, keine Vermutungen; keine Duplikate zu bestehenden — auch Formulierungs-Varianten derselben Sache sind Duplikate). " +
        "(3) Bestehende Zusagen, die laut neuem Eingang erfüllt sind, als erledigt melden; widerrufene/ersetzte als hinfällig. " +
        "(4) Schlage in datum_aenderung ein neues Event-Datum vor, wenn (a) der Eingang eine Verschiebung DIESES Auftrags nennt, ODER " +
        "(b) das bisherige Event-Datum wegfällt (Absage, Eigenregie, keine Unterstützung nötig) UND ein konkreter nächster Termin genannt wird, " +
        "auf den der Auftrag sinnvoll weiterlaufen könnte — der grund muss die Lage ehrlich beschreiben (z.B. 'bisheriges Datum entfällt; nächstes Konzert am …'). " +
        "Das Team wird IMMER GEFRAGT, bevor umdatiert wird — im Zweifel also vorschlagen. Nur bei beiläufiger Terminerwähnung ohne Bezug: null. " +
        "(5) Nennt das Element konkrete Auftrags-Termine (Aufbau, Abbau, Probe, Lieferung, Besprechung), schlage sie in termin_vorschlaege vor — " +
        "NIE selbst anlegen, das Team entscheidet per Nachfrage. Gegen BESTEHENDE TERMINE abgleichen (gleich = nichts, andere Zeit = 'aendern'). " +
        "(6) Pflege in material_positionen das gebuchte Material: Neues erfassen, geaenderte Mengen/Details auf bestehenden Positionen als 'aendern', " +
        "Weggefallenes als 'entfernen' — die Materialliste beschreibt IMMER den aktuellen Stand (Zeitlogik gilt auch hier). " +
        "IDs exakt aus der Liste übernehmen. Im Zweifel lieber weniger ändern.",
      content,
      toolName: "ergebnis_speichern",
      toolDescription: "Speichert Zusammenfassung und Zusagen-Änderungen für den Auftrag.",
      schema: ERGEBNIS_SCHEMA,
      // Zusammenfassung + Zusagen + Material + Termine koennen das
      // 4096er-Default sprengen — das Modell wuerde dann still die
      // groesste Liste opfern (Lektion aus dem Raum-Modell).
      maxTokens: 8000,
    });

    const bekannteIds = new Set((zusagen ?? []).map((z) => z.id));
    const now = new Date().toISOString();

    await admin.from("jobs").update({ ai_summary: ergebnis.zusammenfassung }).eq("id", jobId);
    // Idempotente WIEDERverarbeitung: offene KI-Zusagen aus DIESEM Element
    // ersetzen statt ergaenzen (sonst Duplikat-Varianten bei jedem Retry).
    await admin
      .from("job_zusagen")
      .delete()
      .eq("job_id", jobId)
      .eq("quelle_item_id", itemId)
      .eq("created_via", "ki")
      .eq("status", "offen");
    if (ergebnis.neue_zusagen.length) {
      await admin.from("job_zusagen").insert(
        ergebnis.neue_zusagen.map((z) => ({
          job_id: jobId,
          text: z.text,
          mit_wem: z.mit_wem,
          quelle_item_id: itemId,
          created_via: "ki",
          created_by: actorUserId,
        })),
      );
    }
    for (const [ids, status] of [
      [ergebnis.erledigte_zusagen_ids, "erledigt"],
      [ergebnis.hinfaellige_zusagen_ids, "hinfaellig"],
    ] as const) {
      const valid = ids.filter((id) => bekannteIds.has(id));
      if (valid.length) {
        await admin.from("job_zusagen").update({ status, updated_at: now }).in("id", valid).eq("job_id", jobId);
      }
    }

    // Neues Event-Datum wird NIE direkt gesetzt — nur als persistenter
    // Vorschlag am Auftrag (Banner auf der Uebersicht, bis Entscheidung).
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const v = ergebnis.datum_aenderung;
    const datumVorschlag: DatumVorschlag | null = v && DATE_RE.test(v.start_datum)
      ? {
          start_datum: v.start_datum,
          end_datum: v.end_datum && DATE_RE.test(v.end_datum) ? v.end_datum : v.start_datum,
          grund: v.grund,
        }
      : null;
    if (datumVorschlag) {
      await admin
        .from("jobs")
        .update({ ai_datum_vorschlag: { ...datumVorschlag, item_id: itemId, created_at: new Date().toISOString() } })
        .eq("id", jobId);
    }

    // Material → Technik-Positionen anwenden (Migration 264: eine Liste).
    // Idempotente Wiederverarbeitung: die von DIESEM Element erzeugten
    // Neu-Positionen ersetzen statt ergaenzen. Nachvollziehbarkeit laeuft
    // ueber job_technik_aktivitaet (statt frueherem 'storniert'-Status).
    const materialIds = new Set((material ?? []).map((m) => m.id));
    const matPositionen = ergebnis.material_positionen ?? [];
    await admin
      .from("job_technik_positionen")
      .delete()
      .eq("job_id", jobId)
      .eq("quelle_item_id", itemId)
      .eq("created_via", "ki");
    const neueMat = matPositionen.filter((m) => m.aktion === "neu" && m.bezeichnung && m.menge > 0);
    if (neueMat.length) {
      await admin.from("job_technik_positionen").insert(
        neueMat.map((m) => ({
          job_id: jobId,
          menge: m.menge,
          bezeichnung: m.bezeichnung,
          details: m.details,
          masse: m.masse && (m.masse.l ?? m.masse.b ?? m.masse.h) !== null ? m.masse : null,
          quelle: "kunde",
          created_via: "ki",
          quelle_item_id: itemId,
          created_by: actorUserId,
        })),
      );
      await logTechnik(admin, jobId, { id: actorUserId, name: "Eingang-KI" }, "ki_positionen",
        `Aus dem Eingang erfasst: ${neueMat.map((m) => `${m.menge}× ${m.bezeichnung}`).join(", ")}`);
    }
    for (const m of matPositionen) {
      if (!m.material_id || !materialIds.has(m.material_id)) continue;
      if (m.aktion === "aendern") {
        // Aenderung durch neue Kunden-Info -> eine bestehende Bestaetigung
        // gilt nicht mehr, Position faellt auf 'geplant' zurueck.
        await admin
          .from("job_technik_positionen")
          .update({
            menge: m.menge,
            bezeichnung: m.bezeichnung,
            details: m.details,
            ...(m.masse && (m.masse.l ?? m.masse.b ?? m.masse.h) !== null ? { masse: m.masse } : {}),
            status: "geplant",
            bestaetigt_by: null,
            bestaetigt_at: null,
          })
          .eq("id", m.material_id)
          .eq("job_id", jobId);
        await logTechnik(admin, jobId, { id: actorUserId, name: "Eingang-KI" }, "ki_geaendert",
          `Aus dem Eingang angepasst: ${m.menge}× ${m.bezeichnung}`);
      } else if (m.aktion === "entfernen") {
        const alt = (material ?? []).find((x) => x.id === m.material_id);
        await admin.from("job_technik_positionen").delete().eq("id", m.material_id).eq("job_id", jobId);
        await logTechnik(admin, jobId, { id: actorUserId, name: "Eingang-KI" }, "ki_entfernt",
          `Aus dem Eingang entfernt: ${alt ? `${alt.menge}× ${alt.bezeichnung}` : "Position"}`);
      }
    }

    // Termin-Vorschlaege: NIE direkt anlegen — persistenter Vorschlag am
    // Auftrag (Banner in der Uebersicht), das Team entscheidet.
    const terminIds = new Set((termine ?? []).map((t) => t.id));
    const terminVorschlaege = (ergebnis.termin_vorschlaege ?? []).filter((t) => {
      if (!t.titel || !t.start || Number.isNaN(Date.parse(t.start))) return false;
      if (t.ende && Number.isNaN(Date.parse(t.ende))) return false;
      if (t.aktion === "aendern" && (!t.termin_id || !terminIds.has(t.termin_id))) return false;
      return true;
    });
    if (terminVorschlaege.length) {
      await admin
        .from("jobs")
        .update({ ai_termin_vorschlaege: { vorschlaege: terminVorschlaege, item_id: itemId, created_at: new Date().toISOString() } })
        .eq("id", jobId);
    }

    // inhalt_datum nur uebernehmen, wenn es ein valides Datum ist.
    const inhaltDatum =
      ergebnis.inhalt_datum && !Number.isNaN(Date.parse(ergebnis.inhalt_datum)) ? ergebnis.inhalt_datum : null;
    await admin
      .from("job_inbox_items")
      .update({ ai_status: "verarbeitet", ai_error: null, inhalt_datum: inhaltDatum })
      .eq("id", itemId);

    return { neueZusagen: ergebnis.neue_zusagen.length, datumVorschlag, terminVorschlaege: terminVorschlaege.length };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Verarbeitung fehlgeschlagen";
    await admin.from("job_inbox_items").update({ ai_status: "fehler", ai_error: msg }).eq("id", itemId);
    throw new Error(msg);
  }
}
