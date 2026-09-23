import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createContact, createContactAddress, bexioContactUrl, findMatchingContacts } from "@/lib/bexio";
import { requirePermission } from "@/lib/api-auth";

// Body: { customerId, force?: boolean, linkOnly?: boolean }
//
// Ablauf:
// 1. Schon verknuepft -> URL der existierenden Kontakt-Seite zurueck.
// 2. Match-Suche in Bexio. Wenn Treffer und !force -> Match-Liste zurueck.
//    (Bewusst VOR dem Pflichtfeld-Check: Verknuepfen braucht keine Adresse.)
// 3. Pflichtfelder pruefen (Firma, Strasse, PLZ, Ort, Email, Telefon).
//    Fehlt was -> { success: false, missingFields: [...] }
// 4. Sonst: Kontakt anlegen (POST /2.0/contact) + Adresse anhaengen
//    (POST /2.0/address). bexio_contact_id auf Customer speichern.

const REQUIRED_FIELDS = [
  { key: "name", label: "Firma" },
  { key: "address_street", label: "Strasse + Haus-Nr." },
  { key: "address_zip", label: "PLZ" },
  { key: "address_city", label: "Ort" },
  { key: "email", label: "E-Mail" },
  { key: "phone", label: "Telefon" },
] as const;

export async function POST(request: NextRequest) {
  const auth = await requirePermission("bexio:use");
  if (auth.error) return auth.error;
  try {
    const { customerId, force } = await request.json();
    if (!customerId) {
      return NextResponse.json({ success: false, error: "customerId fehlt" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: customer, error } = await supabase
      .from("customers")
      .select("id, name, type, email, phone, address_street, address_zip, address_city, address_country, bexio_contact_id")
      .eq("id", customerId)
      .single();

    if (error || !customer) {
      return NextResponse.json({ success: false, error: "Kunde nicht gefunden" }, { status: 404 });
    }

    // Schon verknuepft -> URL zurueck.
    if (customer.bexio_contact_id) {
      const id = parseInt(customer.bexio_contact_id, 10);
      return NextResponse.json({
        success: true,
        alreadyLinked: true,
        bexioContactId: customer.bexio_contact_id,
        bexioContactUrl: bexioContactUrl(id),
      });
    }

    // Match-Suche ZUERST (nur wenn nicht force). Wichtig: VOR dem Pflichtfeld-
    // Check — zum Verknuepfen mit einem existierenden Bexio-Kontakt braucht es
    // keine Adresse/Telefon im FSM. Vorher blockte der Pflichtfeld-Check auch
    // Kunden, die in BEIDEN Systemen existieren (z.B. "Philharmonisches
    // Orchester Riehen" ohne Adresse im FSM) — die konnten nie verknuepft werden.
    if (!force) {
      const matches = await findMatchingContacts({
        email: customer.email,
        name: customer.name,
      });
      if (matches.length > 0) {
        return NextResponse.json({
          success: false,
          needsLinkConfirmation: true,
          matches: matches.map((m) => ({
            id: m.id,
            nr: m.nr ?? null,
            name: [m.name_2, m.name_1].filter(Boolean).join(" ").trim() || m.name_1,
            email: m.mail ?? null,
            city: m.city ?? null,
            postcode: m.postcode ?? null,
            url: bexioContactUrl(m.id),
          })),
        });
      }
    }

    // Pflichtfelder pruefen — nur noch fuers tatsaechliche NEU-Anlegen relevant.
    const missingFields = REQUIRED_FIELDS.filter((f) => {
      const v = (customer as Record<string, string | null>)[f.key];
      return !v || !v.toString().trim();
    }).map((f) => f.label);

    if (missingFields.length > 0) {
      return NextResponse.json({ success: false, missingFields });
    }

    // Anlegen
    const isCompany = customer.type === "company" || customer.type === "organization";
    let name1 = customer.name;
    let name2: string | null = null;
    if (!isCompany) {
      const lastSpace = customer.name.lastIndexOf(" ");
      if (lastSpace > 0) {
        name2 = customer.name.slice(0, lastSpace).trim();
        name1 = customer.name.slice(lastSpace + 1).trim();
      }
    }

    const result = await createContact({
      isCompany,
      name1,
      name2,
      email: customer.email,
      phone: customer.phone,
      countryCode: customer.address_country,
    });

    // Adresse separat — schlaegt das fehl, ist Kontakt trotzdem da.
    await createContactAddress(result.id, {
      street: customer.address_street,
      postcode: customer.address_zip,
      city: customer.address_city,
      countryCode: customer.address_country,
      name: customer.name,
    });

    // Bexio-ID + menschenlesbare nr am Kunden speichern (Service-Role).
    // nr ist die Kundennummer die in Bexio sichtbar ist (z.B. "21001") — wird
    // im FSM angezeigt, damit beide Systeme dieselbe Nummer fuehren.
    const admin = createAdminClient();
    await admin
      .from("customers")
      .update({
        bexio_contact_id: String(result.id),
        bexio_nr: result.nr ?? null,
      })
      .eq("id", customerId);

    return NextResponse.json({
      success: true,
      bexioContactId: String(result.id),
      bexioNr: result.nr ?? null,
      bexioContactUrl: bexioContactUrl(result.id),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
