"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CustomerType } from "@/types";
import { Save, Building2, User, Globe, ArrowLeftRight } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { AddressAutocomplete, type ParsedAddress } from "@/components/address-autocomplete";
import { Loading } from "@/components/ui/spinner";

// Land-Optionen — mehr als die Nachbarn macht aktuell keinen Sinn,
// 99% der Kunden sind Schweizer. Bei Bedarf erweitern.
const COUNTRY_OPTIONS = [
  { code: "CH", label: "Schweiz" },
  { code: "DE", label: "Deutschland" },
  { code: "AT", label: "Österreich" },
  { code: "FR", label: "Frankreich" },
  { code: "IT", label: "Italien" },
  { code: "LI", label: "Liechtenstein" },
];

// Erlaubte Return-Pfade — verhindert Open-Redirect via ?return=https://evil.example
const ALLOWED_RETURN_PREFIXES = ["/auftraege/"];

function isAllowedReturn(p: string | null | undefined): p is string {
  if (!p) return false;
  if (!p.startsWith("/")) return false;
  return ALLOWED_RETURN_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix));
}

function NeuerKundeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();
  const [saving, setSaving] = useState(false);

  const prefillName = searchParams.get("prefillName") ?? "";
  const returnPathRaw = searchParams.get("return");
  const returnPath = isAllowedReturn(returnPathRaw) ? returnPathRaw : null;

  const [form, setForm] = useState({
    name: prefillName,
    type: "company" as CustomerType,
    email: "",
    phone: "",
    address_street: "",
    address_zip: "",
    address_city: "",
    address_country: "CH",
    notes: "",
  });

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  // Wird gerufen wenn Google-Maps-Autocomplete eine Adresse aufgeloest hat —
  // alle Adressfelder auf einen Schlag aktualisieren (User muss nicht alles
  // manuell tippen). Land kommt als ISO-2, fallt zurueck auf bisheriges wenn leer.
  function applyPlace(p: ParsedAddress) {
    setForm((prev) => ({
      ...prev,
      address_street: p.street || prev.address_street,
      address_zip: p.postcode || prev.address_zip,
      address_city: p.city || prev.address_city,
      address_country: p.country || prev.address_country,
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Adresse-Strasse via AddressAutocomplete — der Pflichtfeld-Stern im
    // Label muss hier explizit validiert werden weil das Custom-Component
    // kein required-Attribut hat. Die anderen Pflicht-Inputs nutzen das
    // native required.
    if (!form.address_street?.trim()) {
      toast.error("Strasse ist Pflicht");
      return;
    }

    setSaving(true);

    const { data: inserted, error } = await supabase
      .from("customers")
      .insert({
        name: form.name,
        type: form.type,
        email: form.email || null,
        phone: form.phone || null,
        address_street: form.address_street || null,
        address_zip: form.address_zip || null,
        address_city: form.address_city || null,
        address_country: form.address_country || "CH",
        notes: form.notes || null,
      })
      .select("id")
      .single();

    if (error || !inserted) {
      TOAST.supabaseError(error, "Speichern fehlgeschlagen");
      setSaving(false);
      return;
    }

    toast.success("Kunde erfolgreich erstellt");

    if (returnPath) {
      // Zurueck zum urspruenglichen Formular — Draft wird dort aus sessionStorage
      // wiederhergestellt, customer_id auf den frisch erstellten Kunden gesetzt.
      const sep = returnPath.includes("?") ? "&" : "?";
      router.push(`${returnPath}${sep}customerId=${inserted.id}`);
    } else {
      router.push("/kunden");
    }
  }

  function cancel() {
    if (returnPath) {
      router.push(returnPath);
    } else {
      router.push("/kunden");
    }
  }

  const typeOptions: { value: CustomerType; label: string; icon: React.ReactNode }[] = [
    { value: "company", label: "Firma", icon: <Building2 className="h-4 w-4" /> },
    { value: "individual", label: "Privatperson", icon: <User className="h-4 w-4" /> },
    { value: "organization", label: "Organisation", icon: <Globe className="h-4 w-4" /> },
  ];

  return (
    <div className="max-w-2xl space-y-6 mx-auto">
      {/* Header */}
      <div className="flex items-center gap-4">
        <BackButton fallbackHref={returnPath || "/kunden"} />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Neuer Kunde</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Kundendaten erfassen
          </p>
        </div>
      </div>

      {returnPath && (
        <div className="flex items-start gap-2 p-3 rounded-xl border tinted-blue text-xs">
          <ArrowLeftRight className="h-4 w-4 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Du wirst nach dem Speichern zurückgeleitet.</p>
            <p className="opacity-80 mt-0.5">Dein vorheriges Formular ist zwischengespeichert und der neue Kunde wird automatisch ausgewählt.</p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Typ */}
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Kundentyp</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-3">
              {typeOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => update("type", opt.value)}
                  className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                    form.type === opt.value
                      ? "border-red-500 bg-red-50 text-red-700"
                      : "border-gray-100 bg-gray-50 text-gray-500 hover:border-gray-200"
                  }`}
                >
                  {opt.icon}
                  <span className="text-xs font-medium">{opt.label}</span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Kontaktdaten */}
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Kontaktdaten</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                placeholder={form.type === "company" ? "Firmenname" : "Vor- und Nachname"}
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                className="mt-1.5 bg-gray-50 border-gray-200"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="email">E-Mail *</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="mail@beispiel.ch"
                  value={form.email}
                  onChange={(e) => update("email", e.target.value)}
                  className="mt-1.5 bg-gray-50 border-gray-200"
                  required
                />
              </div>
              <div>
                <Label htmlFor="phone">Telefon *</Label>
                <Input
                  id="phone"
                  placeholder="+41 ..."
                  value={form.phone}
                  onChange={(e) => update("phone", e.target.value)}
                  className="mt-1.5 bg-gray-50 border-gray-200"
                  required
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Adresse */}
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Adresse</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="street">Strasse *</Label>
              <div className="mt-1.5">
                <AddressAutocomplete
                  id="street"
                  value={form.address_street}
                  onChange={(v) => update("address_street", v)}
                  onPlace={applyPlace}
                  localLocations={[]}
                  placeholder="Tippe um aus Google-Vorschlägen zu wählen — füllt PLZ, Ort und Land automatisch"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="zip">PLZ *</Label>
                <Input
                  id="zip"
                  placeholder="4052"
                  value={form.address_zip}
                  onChange={(e) => update("address_zip", e.target.value)}
                  className="mt-1.5 bg-gray-50 border-gray-200"
                  required
                />
              </div>
              <div className="col-span-2">
                <Label htmlFor="city">Ort *</Label>
                <Input
                  id="city"
                  placeholder="Basel"
                  value={form.address_city}
                  onChange={(e) => update("address_city", e.target.value)}
                  className="mt-1.5 bg-gray-50 border-gray-200"
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="country">Land</Label>
              <select
                id="country"
                value={form.address_country}
                onChange={(e) => update("address_country", e.target.value)}
                className="mt-1.5 w-full h-9 px-3 text-sm rounded-lg border border-gray-200 bg-gray-50 focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
              >
                {COUNTRY_OPTIONS.map((c) => (
                  <option key={c.code} value={c.code}>{c.label}</option>
                ))}
              </select>
            </div>
          </CardContent>
        </Card>

        {/* Notizen */}
        <Card className="bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Notizen</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              placeholder="Optionale Notizen zum Kunden..."
              value={form.notes}
              onChange={(e) => update("notes", e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 bg-gray-50 resize-none focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500"
              rows={3}
            />
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={cancel}
            className="kasten kasten-muted flex-1"
          >
            Abbrechen
          </button>
          <button
            type="submit"
            disabled={!form.name || saving}
            className="kasten kasten-red flex-1"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Speichern…" : "Kunde erstellen"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NeuerKundePage() {
  return (
    <Suspense fallback={<Loading className="py-20" label="Laden…" />}>
      <NeuerKundeContent />
    </Suspense>
  );
}
