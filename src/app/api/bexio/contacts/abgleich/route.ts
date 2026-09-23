import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api-auth";

// Viele Bexio-Suchen in Serie (4er-Chunks) — ohne erhoehtes Limit
// wuerde Vercel die Route bei wachsender Kundenzahl abbrechen und das
// Banner bliebe still weg.
export const maxDuration = 120;
import {
  findMatchingContacts,
  getContactById,
  getConnection,
  bexioContactUrl,
} from "@/lib/bexio";

// POST {} | { customerId }
//
// Sammelt fuer alle aktiven, nicht archivierten Kunden was der gefuehrte
// Bexio-Abgleich (Banner + Modal auf /kunden) braucht:
//
//   (a) Kunden OHNE bexio_contact_id  -> Match-Kandidaten via findMatchingContacts
//   (b) Kunden MIT bexio_contact_id   -> Bexio-Kontakt laden + Feld-Diffs rechnen
//
// Feld-Mapping ist exakt invers zu dem, was /api/bexio/contacts/create beim
// Anlegen nach Bexio sendet:
//   name          <-> name_1/name_2 (Firma: name_1; Person: "Vorname Nachname")
//   email         <-> mail
//   phone         <-> phone_fixed
//   address_street<-> address   (via /2.0/address bzw. Kontakt-Detail)
//   address_zip   <-> postcode
//   address_city  <-> city
//
// Vergleich normalisiert (trim, leere Strings = null). Ein Diff zaehlt nur,
// wenn der Bexio-Wert nicht leer ist UND sich vom FSM-Wert unterscheidet —
// Bexio gilt als fuehrende Quelle, aber ein leeres Bexio-Feld soll nie ein
// gefuelltes FSM-Feld "wegdiffen".
//
// Nur LESENDE Bexio-Calls. Chunk-Parallelitaet 4 (Bexio-Rate-Limits), ein
// Fehler pro Kunde bricht nie den ganzen Lauf — er landet als error am Item.
//
// Mit { customerId } im Body wird nur dieser eine Kunde gerechnet — das nutzt
// das Abgleich-Modal direkt nach dem Verknuepfen, um die Diffs des frisch
// verknuepften Kontakts zu holen. In dem Modus kommt der Kunde auch dann als
// Item zurueck, wenn er verknuepft ist und KEINE Diffs hat (diffs: []) —
// der Client weiss dann: nichts zu tun, weiter.

const DIFF_FIELDS = [
  { key: "name", label: "Name" },
  { key: "email", label: "E-Mail" },
  { key: "phone", label: "Telefon" },
  { key: "address_street", label: "Strasse" },
  { key: "address_zip", label: "PLZ" },
  { key: "address_city", label: "Ort" },
] as const;

type DiffFieldKey = (typeof DIFF_FIELDS)[number]["key"];

interface CustomerRow {
  id: string;
  name: string;
  type: string;
  email: string | null;
  phone: string | null;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  bexio_contact_id: string | null;
  bexio_nr: string | null;
}

interface AbgleichMatch {
  id: number;
  nr: string | null;
  name: string;
  email: string | null;
  city: string | null;
  postcode: string | null;
  url: string;
  match?: "beide" | "name" | "email" | null;
  /** Name des FSM-Kunden, der diesen Bexio-Kontakt schon hat — die UI
   *  deaktiviert den Kandidaten dann (1 Kontakt = 1 Kunde). */
  bereitsVerknuepftMit?: string | null;
}

interface AbgleichDiff {
  field: DiffFieldKey;
  label: string;
  /** Aktueller FSM-Wert (null = leer). */
  fsm: string | null;
  /** Bexio-Wert — per Definition nicht leer. */
  bexio: string;
}

interface AbgleichItem {
  customerId: string;
  customerName: string;
  bexioNr: string | null;
  /** unlinked = Kunde ohne Bexio-Verknuepfung (matches relevant),
   *  diff = verknuepfter Kunde mit Abweichungen (diffs relevant). */
  kind: "unlinked" | "diff";
  matches: AbgleichMatch[];
  diffs: AbgleichDiff[];
  error: string | null;
}

/** trim; leere Strings -> null. */
function norm(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length > 0 ? t : null;
}

/** Chunk-Parallelitaet: max. `size` Kunden gleichzeitig gegen Bexio. */
async function inChunks<T, R>(arr: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < arr.length; i += size) {
    const part = await Promise.all(arr.slice(i, i + size).map(fn));
    out.push(...part);
  }
  return out;
}

export async function POST(request: NextRequest) {
  const auth = await requirePermission("kunden:edit");
  if (auth.error) return auth.error;

  try {
    const body = (await request.json().catch(() => ({}))) as { customerId?: string };
    const singleCustomerId = typeof body.customerId === "string" && body.customerId ? body.customerId : null;

    // Ohne Bexio-Verbindung gibt es nichts abzugleichen — Banner bleibt weg.
    const conn = await getConnection();
    if (!conn) {
      return NextResponse.json({ success: true, connected: false, items: [], nrOnlyCount: 0 });
    }

    const supabase = await createClient();
    let query = supabase
      .from("customers")
      .select("id, name, type, email, phone, address_street, address_zip, address_city, bexio_contact_id, bexio_nr")
      .eq("is_active", true)
      .is("archived_at", null)
      .order("name", { ascending: true });
    if (singleCustomerId) query = query.eq("id", singleCustomerId);

    const { data: rows, error } = await query;
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const customers = (rows ?? []) as CustomerRow[];

    const results = await inChunks(customers, 4, async (c): Promise<AbgleichItem | null> => {
      try {
        if (!c.bexio_contact_id) {
          // (a) Unverknuepft -> Kandidaten suchen. OHNE Treffer faellt der
          // Kunde aus Banner und Flow raus (Leo 2026-09-23: nur anzeigen,
          // wenn es wirklich etwas abzugleichen gibt) — ausser beim
          // gezielten Einzel-Abruf (singleCustomerId, Modal-Nachlauf).
          const matches = await findMatchingContacts({ email: c.email, name: c.name });
          if (matches.length === 0 && !singleCustomerId) return null;
          return {
            customerId: c.id,
            customerName: c.name,
            bexioNr: null,
            kind: "unlinked",
            matches: matches.map((m) => ({
              id: m.id,
              nr: m.nr ?? null,
              name: [m.name_2, m.name_1].filter(Boolean).join(" ").trim() || m.name_1,
              email: m.mail ?? null,
              city: m.city ?? null,
              postcode: m.postcode ?? null,
              url: bexioContactUrl(m.id),
              match: m.match ?? null,
            })),
            diffs: [],
            error: null,
          };
        }

        // (b) Verknuepft -> Kontakt laden + Diffs rechnen.
        const contactId = parseInt(String(c.bexio_contact_id), 10);
        if (!Number.isFinite(contactId)) {
          return {
            customerId: c.id, customerName: c.name, bexioNr: c.bexio_nr,
            kind: "diff", matches: [], diffs: [],
            error: "Ungültige Bexio-ID am Kunden",
          };
        }
        const contact = await getContactById(contactId);
        if (!contact) {
          return {
            customerId: c.id, customerName: c.name, bexioNr: c.bexio_nr,
            kind: "diff", matches: [], diffs: [],
            error: "Bexio-Kontakt nicht gefunden",
          };
        }

        // Invers zum create-Mapping: Person = "name_2 name_1" (Vor- + Nachname),
        // Firma = name_1 (name_2 ist dort leer).
        const bexioName = [contact.name_2, contact.name_1].filter(Boolean).join(" ").trim() || contact.name_1;
        const bexioValues: Record<DiffFieldKey, string | null> = {
          name: norm(bexioName),
          email: norm(contact.mail),
          phone: norm(contact.phone_fixed),
          address_street: norm(contact.address),
          address_zip: norm(contact.postcode),
          address_city: norm(contact.city),
        };

        const diffs: AbgleichDiff[] = [];
        for (const f of DIFF_FIELDS) {
          const bexioVal = bexioValues[f.key];
          const fsmVal = norm((c as unknown as Record<string, string | null>)[f.key]);
          // Diff nur wenn Bexio einen Wert HAT und der abweicht.
          if (bexioVal !== null && bexioVal !== fsmVal) {
            diffs.push({ field: f.key, label: f.label, fsm: fsmVal, bexio: bexioVal });
          }
        }

        // Im Sammel-Lauf interessieren nur verknuepfte Kunden MIT Abweichungen.
        // Im Einzel-Modus (nach frischem Verknuepfen) immer zurueckgeben,
        // damit der Client "keine Diffs -> weiter" entscheiden kann.
        if (diffs.length === 0 && !singleCustomerId) return null;

        return {
          customerId: c.id, customerName: c.name, bexioNr: c.bexio_nr,
          kind: "diff", matches: [], diffs, error: null,
        };
      } catch (e) {
        // Ein Kunde darf den Lauf nie kippen — Fehler ans Item haengen.
        return {
          customerId: c.id, customerName: c.name, bexioNr: c.bexio_nr,
          kind: c.bexio_contact_id ? "diff" : "unlinked",
          matches: [], diffs: [],
          error: e instanceof Error ? e.message : "Unbekannter Fehler",
        };
      }
    });

    const items = results.filter((r): r is AbgleichItem => r !== null);

    // Bereits vergebene Bexio-Kontakte kennzeichnen: ein Kontakt gehoert
    // zu genau EINEM Kunden. Taucht er trotzdem als Kandidat auf (z.B.
    // gleiche Kontaktperson bei Verein UND Privatperson — zwei Bexio-
    // Kontakte, aber die E-Mail-Suche findet beide), zeigt die UI, wo er
    // schon haengt, damit der ANDERE Kontakt gewaehlt wird.
    const kandidatenIds = [
      ...new Set(items.flatMap((i) => i.matches.map((m) => String(m.id)))),
    ];
    if (kandidatenIds.length > 0) {
      const { data: vergeben } = await supabase
        .from("customers")
        .select("name, bexio_contact_id")
        .in("bexio_contact_id", kandidatenIds);
      const vergebenMap = new Map(
        ((vergeben ?? []) as { name: string; bexio_contact_id: string }[]).map(
          (v) => [v.bexio_contact_id, v.name],
        ),
      );
      for (const item of items) {
        for (const m of item.matches) {
          m.bereitsVerknuepftMit = vergebenMap.get(String(m.id)) ?? null;
        }
      }
    }

    // Kunden deren EINZIGES Thema die fehlende Bexio-Kundennummer ist —
    // die braucht keinen Flow-Schritt, der sync-nrs-Backfill am Ende des
    // Flows erledigt sie. Zaehlt aber in den Banner-Count.
    const inItems = new Set(items.map((i) => i.customerId));
    const nrOnlyCount = customers.filter(
      (c) => c.bexio_contact_id && !c.bexio_nr && !inItems.has(c.id),
    ).length;

    return NextResponse.json({ success: true, connected: true, items, nrOnlyCount });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
