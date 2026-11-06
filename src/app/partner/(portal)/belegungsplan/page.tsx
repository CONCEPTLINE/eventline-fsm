import { redirect } from "next/navigation";

// Frueher «Belegungsplan» — heisst seit Etappe 1 (Barakuba) «Kalender».
// Alte Links/Lesezeichen und Benachrichtigungen leiten weiter, inkl.
// ?monat=YYYY-MM.

export default async function PartnerBelegungsplanWeiterleitung({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") qs.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => qs.append(k, x));
  }
  const q = qs.toString();
  redirect(`/partner/kalender${q ? `?${q}` : ""}`);
}
