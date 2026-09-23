// Backfill-Endpoint: geocoded alle locations + rooms die noch keine
// latitude/longitude haben. Throttled auf 1.1s pro Aufruf wegen Nominatim's
// 1-req/sec Policy.
//
// POST ohne Body. Antwort listet pro Tabelle ok/fail/skip-Counts.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { geocodeAddress } from "@/lib/geocode";

// 5 Minuten — Nominatim ist 1.1s/Request, also reichts fuer ~270 Adressen
// pro Lauf. Vercel-Default sind 10s, das hat den Backfill mittendrin
// gekilled.
export const maxDuration = 300;

const NOMINATIM_THROTTLE_MS = 1100;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function POST() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const result = {
    locations: { processed: 0, ok: 0, fail: 0 },
    rooms: { processed: 0, ok: 0, fail: 0 },
  };

  // Beide Row-Queries parallel laden (eine Welle statt zwei Roundtrips).
  // Die Geocode-Calls selbst bleiben BEWUSST sequentiell + throttled:
  // Nominatim erlaubt hart max 1 req/sec — Parallelisierung wuerde zu
  // Blocks/403 fuehren. Stattdessen laeuft der DB-Update parallel zum
  // ohnehin noetigen Throttle-Sleep (spart den Update-Roundtrip auf der
  // 300s-maxDuration-Uhr).
  type AddrRow = {
    id: string;
    address_street: string | null;
    address_zip: string | null;
    address_city: string | null;
  };
  const [locRes, roomRes] = await Promise.all([
    admin.from("locations").select("id, address_street, address_zip, address_city").is("latitude", null),
    admin.from("rooms").select("id, address_street, address_zip, address_city").is("latitude", null),
  ]);
  const rowsByTable = {
    locations: (locRes.data ?? []) as AddrRow[],
    rooms: (roomRes.data ?? []) as AddrRow[],
  };

  for (const table of ["locations", "rooms"] as const) {
    for (const row of rowsByTable[table]) {
      result[table].processed += 1;
      const coords = await geocodeAddress(row.address_street, row.address_zip, row.address_city);
      if (coords) {
        result[table].ok += 1;
        await Promise.all([
          admin
            .from(table)
            .update({ latitude: coords.lat, longitude: coords.lng })
            .eq("id", row.id),
          sleep(NOMINATIM_THROTTLE_MS),
        ]);
      } else {
        result[table].fail += 1;
        await sleep(NOMINATIM_THROTTLE_MS);
      }
    }
  }

  return NextResponse.json({ ok: true, result });
}
