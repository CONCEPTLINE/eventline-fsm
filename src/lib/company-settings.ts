// Firmen-Stammdaten (Singleton) — zentraler Loader fuer Server-Code.
// PDFs, Mail-Footer, sonstige aussenwirksame Ausgaben lesen von hier
// statt hardcoded Werte einzustreuen.

import type { SupabaseClient } from "@supabase/supabase-js";

export interface CompanySettings {
  name: string;
  street: string;
  zip: string;
  city: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  uid_number: string;
  iban: string;
}

// Fallback wenn DB-Row (aus welchem Grund auch immer) fehlt — sorgt
// dafuer dass PDFs nicht mit leerem Header rausgehen. Halbwegs sinnvolle
// Werte, aber die richtige Loesung ist der Admin fuellt sie im UI aus.
const FALLBACK: CompanySettings = {
  name: "EVENTLINE GmbH",
  street: "",
  zip: "",
  city: "",
  country: "Schweiz",
  phone: "",
  email: "",
  website: "",
  uid_number: "",
  iban: "",
};

export async function loadCompanySettings(client: SupabaseClient): Promise<CompanySettings> {
  const { data } = await client
    .from("company_settings")
    .select("name, street, zip, city, country, phone, email, website, uid_number, iban")
    .eq("id", "default")
    .maybeSingle();
  if (!data) return FALLBACK;
  return {
    name: (data.name as string) || FALLBACK.name,
    street: (data.street as string) ?? "",
    zip: (data.zip as string) ?? "",
    city: (data.city as string) ?? "",
    country: (data.country as string) || FALLBACK.country,
    phone: (data.phone as string) ?? "",
    email: (data.email as string) ?? "",
    website: (data.website as string) ?? "",
    uid_number: (data.uid_number as string) ?? "",
    iban: (data.iban as string) ?? "",
  };
}

/** "Strasse · PLZ Ort" — einzeiliger Adress-Header fuer PDF/Mail-Footer. */
export function formatAddressLine(c: CompanySettings): string {
  const parts: string[] = [];
  if (c.street) parts.push(c.street);
  const cityLine = [c.zip, c.city].filter(Boolean).join(" ").trim();
  if (cityLine) parts.push(cityLine);
  return parts.join(" · ");
}

/** "Name · Strasse · PLZ Ort" — Mail-Footer-Zeile (kompakt, ohne Tel/Web). */
export function formatMailFooter(c: CompanySettings): string {
  const parts: string[] = [];
  if (c.name) parts.push(c.name);
  if (c.street) parts.push(c.street);
  const cityLine = [c.zip, c.city].filter(Boolean).join(" ").trim();
  if (cityLine) parts.push(cityLine);
  return parts.join(" · ");
}

/** Voller Footer inkl. Tel + Website — fuer Rapport-PDF Fusszeile. */
export function formatFullFooter(c: CompanySettings): string {
  const parts: string[] = [formatMailFooter(c)].filter(Boolean);
  if (c.phone) parts.push(`Tel: ${c.phone}`);
  if (c.website) parts.push(c.website);
  return parts.join(" · ");
}

/** Absender-String fuer Resend-Mails: "Name <adresse>". Wenn kein Name
 *  gesetzt ist, fallt auf 'EVENTLINE' zurueck damit die Mail nicht ohne
 *  Absender-Anzeige verschickt wird. */
export function formatMailFrom(c: CompanySettings, address: string): string {
  const name = (c.name || "EVENTLINE").replace(/[<>]/g, "").trim();
  return `${name} <${address}>`;
}
