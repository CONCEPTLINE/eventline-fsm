import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requirePermission } from "@/lib/api-auth";

// POST { customerId, felder }
//
// Uebernimmt Bexio-Werte in die FSM-Stammdaten eines Kunden — der
// "Übernehmen"-Schritt des gefuehrten Bexio-Abgleichs. Schreibt NUR die
// uebergebenen Felder (die abweichenden), nie den ganzen Datensatz.
//
// Whitelist = exakt die Felder, die der Abgleich diff-t (invers zum
// create-Mapping). Alles andere im Body wird ignoriert.
//
// Update laeuft ueber den User-Client — RLS entscheidet, ob dieser User
// Kunden bearbeiten darf. requirePermission("kunden:edit") gate't zusaetzlich
// vor dem ersten DB-Touch. Kein Bexio-Call, kein Admin-Client.

const ALLOWED_FIELDS = new Set([
  "name",
  "email",
  "phone",
  "address_street",
  "address_zip",
  "address_city",
]);

export async function POST(request: NextRequest) {
  const auth = await requirePermission("kunden:edit");
  if (auth.error) return auth.error;

  try {
    const { customerId, felder } = (await request.json()) as {
      customerId?: string;
      felder?: Record<string, unknown>;
    };
    if (!customerId || typeof customerId !== "string") {
      return NextResponse.json({ success: false, error: "customerId fehlt" }, { status: 400 });
    }
    if (!felder || typeof felder !== "object" || Array.isArray(felder)) {
      return NextResponse.json({ success: false, error: "felder fehlt" }, { status: 400 });
    }

    const update: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(felder)) {
      if (!ALLOWED_FIELDS.has(key)) continue;
      if (typeof value !== "string" && value !== null) continue;
      const normalized = typeof value === "string" ? value.trim() || null : null;
      // name ist NOT NULL — ein leerer Name wird nie uebernommen.
      if (key === "name" && normalized === null) continue;
      update[key] = normalized;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ success: false, error: "Keine gültigen Felder übergeben" }, { status: 400 });
    }

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("customers")
      .update(update)
      .eq("id", customerId)
      .select("id");

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
    // RLS-blockierte Updates schlagen nicht fehl — sie treffen 0 Zeilen.
    // Das explizit als Fehler melden statt still "success" zu sagen.
    if (!data || data.length === 0) {
      return NextResponse.json(
        { success: false, error: "Kunde nicht gefunden oder keine Berechtigung" },
        { status: 404 },
      );
    }

    // Spiegel-Konsistenz zu den Mehrfach-Kontakten (Migration 273):
    // email/phone entsprechen dem ERSTEN Listen-Eintrag — zieht Bexio
    // den Primaerwert nach, muss der Listen-Kopf mitziehen.
    if (update.email !== undefined || update.phone !== undefined) {
      const { data: kRow } = await supabase
        .from("customers")
        .select("emails, phones")
        .eq("id", customerId)
        .maybeSingle();
      if (kRow) {
        const patch: Record<string, unknown> = {};
        for (const [feld, liste] of [["email", "emails"], ["phone", "phones"]] as const) {
          const neu = update[feld];
          if (neu === undefined) continue;
          const arr = Array.isArray(kRow[liste]) ? [...(kRow[liste] as { label: string; wert: string }[])] : [];
          if (neu === null) continue; // Primaerwert wird nie geleert (name-Guard analog)
          if (arr.length === 0) patch[liste] = [{ label: "Primär", wert: neu }];
          else { arr[0] = { ...arr[0], wert: neu }; patch[liste] = arr; }
        }
        if (Object.keys(patch).length > 0) {
          await supabase.from("customers").update(patch).eq("id", customerId);
        }
      }
    }

    return NextResponse.json({ success: true, updatedFields: Object.keys(update) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
