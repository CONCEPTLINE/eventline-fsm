import { NextResponse } from "next/server";
import { BUILD_INFO } from "@/lib/build-info";

// Gibt die SHA des aktuell deployten Builds zurück. Offene Tabs vergleichen
// das mit ihrer eigenen (eingebauten) SHA und laden bei Unterschied neu.
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ sha: BUILD_INFO.sha }, { headers: { "Cache-Control": "no-store" } });
}
