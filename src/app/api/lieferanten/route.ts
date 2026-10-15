// GET /api/lieferanten?q=… — Liste fuer die Seite /lieferanten.
// Recht lieferanten:view (Admins via has_permission). Suche serverseitig
// ueber Name, Ansprechperson, E-Mail, Telefon und Adresse.
// Pro Firma zusaetzlich: Katalog (PDF + Anzahl aktiver Artikel) und ob ein
// aktiver Portal-Zugang existiert. Die Profile der Portal-Konten sind fuer
// Nicht-Admins nicht lesbar — darum diese Angabe serverseitig (Admin-Client,
// nur ja/nein, keine Personendaten).

import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { escapeForIlike } from "@/lib/search-escape";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

type Zeile = {
  id: string;
  name: string;
  type: string;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  notes: string | null;
  katalog_path: string | null;
  katalog_name: string | null;
  katalog_updated_at: string | null;
  artikel: { count: number }[] | null;
};

export async function GET(req: NextRequest) {
  const auth = await requirePermission("lieferanten:view");
  if (auth.error) return auth.error;

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 100);
  const admin = createAdminClient();

  let abfrage = admin
    .from("lieferanten")
    .select(
      "id, name, type, contact_person, email, phone, website, address_street, address_zip, address_city, notes, " +
      "katalog_path, katalog_name, katalog_updated_at, artikel:lieferant_katalog_artikel(count)",
    )
    .eq("is_active", true)
    .eq("artikel.is_active", true);
  if (q) {
    const like = `%${escapeForIlike(q)}%`;
    abfrage = abfrage.or(
      [
        "name", "contact_person", "email", "phone", "address_street", "address_zip", "address_city",
      ].map((s) => `${s}.ilike.${like}`).join(","),
    );
  }
  const { data, error } = await abfrage.order("name");
  if (error) {
    logError("api.lieferanten", error, { q });
    return NextResponse.json({ success: false, error: "Lieferanten konnten nicht geladen werden" }, { status: 500 });
  }
  const zeilen = (data ?? []) as unknown as Zeile[];

  // Aktive Portal-Zugaenge je Firma (nur ja/nein).
  const ids = zeilen.map((z) => z.id);
  const mitZugang = new Set<string>();
  if (ids.length) {
    const { data: konten, error: kontenErr } = await admin
      .from("profiles")
      .select("lieferant_id")
      .eq("role", "lieferant")
      .eq("is_active", true)
      .in("lieferant_id", ids);
    if (kontenErr) {
      logError("api.lieferanten.zugaenge", kontenErr);
      return NextResponse.json({ success: false, error: "Lieferanten konnten nicht geladen werden" }, { status: 500 });
    }
    for (const k of (konten ?? []) as { lieferant_id: string | null }[]) if (k.lieferant_id) mitZugang.add(k.lieferant_id);
  }

  return NextResponse.json(
    {
      success: true,
      lieferanten: zeilen.map(({ artikel, ...z }) => ({
        ...z,
        artikel_anzahl: artikel?.[0]?.count ?? 0,
        portal_zugang: mitZugang.has(z.id),
      })),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
