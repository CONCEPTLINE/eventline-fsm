"use client";

/**
 * /entwuerfe/neu — Neuen Auftrags-Entwurf anlegen.
 *
 * Bewusst schlanker als /auftraege/neu — ein Entwurf lebt vom "wenig ist mehr":
 * Titel ist einziges Pflichtfeld, Kunde optional (Freitext-Fallback), Datum
 * darf komplett offen sein (viele Anfragen sind erst "irgendwann 2027").
 * Alle Details werden auf der Detail-Page angereichert — hier nur die
 * Grundinfo damit der Draft schnell entsteht.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Save, ClipboardEdit } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { createClient } from "@/lib/supabase/client";
import { kundenAuswahl } from "@/lib/kunden-auswahl";
import { toast } from "sonner";

interface Customer {
  id: string;
  name: string;
}
interface Location {
  id: string;
  name: string;
  address_street?: string | null;
  address_zip?: string | null;
  address_city?: string | null;
}
interface OwnerOption {
  id: string;
  full_name: string;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

export default function EntwurfNeuPage() {
  const router = useRouter();
  const supabase = createClient();

  const [saving, setSaving] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [owners, setOwners] = useState<OwnerOption[]>([]);

  const [form, setForm] = useState({
    title: "",
    customer_id: "",
    // Freitext-Fallback wenn kein Kunde in der DB: wir speichern den
    // Namen und die Kontaktdaten am Draft direkt.
    customer_name: "",
    contact_person: "",
    contact_email: "",
    contact_phone: "",
    location_id: "",
    // Freitext-Fallback fuer Location — analog customer_name. Kein
    // locations-Record wird erzeugt, auch nicht bei Konversion.
    location_name: "",
    expected_start_date: "",
    expected_end_date: "",
    guest_count: "",
    owner_id: "",
    general_notes: "",
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      const [c, l, o] = await Promise.all([
        kundenAuswahl<Customer>(supabase, "id, name"),
        supabase
          .from("locations")
          .select("id, name, address_street, address_zip, address_city")
          .eq("is_active", true)
          .order("name"),
        supabase.rpc("get_assignable_users"),
      ]);
      if (!alive) return;
      setCustomers((c.data as Customer[]) ?? []);
      setLocations((l.data as Location[]) ?? []);
      setOwners((o.data as OwnerOption[]) ?? []);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update<K extends keyof typeof form>(field: K, value: (typeof form)[K]) {
    setForm((p) => ({ ...p, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) {
      toast.error("Titel ist Pflicht");
      return;
    }
    if (
      form.expected_start_date &&
      form.expected_end_date &&
      form.expected_end_date < form.expected_start_date
    ) {
      toast.error("Enddatum darf nicht vor dem Startdatum liegen");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/entwuerfe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title,
          customer_id: form.customer_id || null,
          // customer_name nur setzen wenn KEIN customer_id — sonst
          // haetten wir zwei Quellen und die UI muesste raten.
          customer_name: form.customer_id ? null : form.customer_name || null,
          contact_person: form.contact_person || null,
          contact_email: form.contact_email || null,
          contact_phone: form.contact_phone || null,
          location_id: form.location_id || null,
          location_name: form.location_id ? null : form.location_name || null,
          expected_start_date: form.expected_start_date || null,
          expected_end_date: form.expected_end_date || null,
          guest_count: form.guest_count ? parseInt(form.guest_count, 10) : null,
          owner_id: form.owner_id || null,
          general_notes: form.general_notes || null,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        toast.error(json.error ?? "Konnte Entwurf nicht anlegen");
        return;
      }
      toast.success(`Entwurf ENT-${json.draft.draft_number} angelegt`);
      router.push(`/entwuerfe/${json.draft.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Netzwerk-Fehler");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto page-enter">
      <div className="flex items-center gap-3 mb-4">
        <BackButton fallbackHref="/entwuerfe" size="sm" />
        <div className="flex items-center gap-2">
          <ClipboardEdit className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold">Neuer Entwurf</h1>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="rounded-xl border bg-card p-5 space-y-5">
        {/* Titel */}
        <div className="space-y-2">
          <SectionLabel>Titel *</SectionLabel>
          <Input
            placeholder="z.B. Hochzeit Müller, Anfrage Konzertreihe 2027"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            required
            autoFocus
          />
        </div>

        <hr className="border-border/50" />

        {/* Kunde — EIN Feld: Dropdown mit Freitext-Fallback im gleichen
            Trigger. "Neu anlegen: X" legt den Namen als Freitext ab
            (customer_name), der Text bleibt via freeTextDisplay im Trigger
            sichtbar. Kein zweites "Firma / Kundenname"-Feld daneben — das
            hat User verwirrt, wenn der getippte Text nach Enter aus dem
            Dropdown ins Freitext-Feld hopste (Leo 2026-09-06). */}
        <div className="space-y-2">
          <SectionLabel>Kunde</SectionLabel>
          <SearchableSelect
            value={form.customer_id}
            onChange={(id) =>
              // Bei jeder Auswahl-Aenderung (Item picken ODER X-Button):
              // Freitext raeumen. Sonst haetten wir wieder zwei Wahrheiten
              // in einem Feld.
              setForm((p) => ({ ...p, customer_id: id, customer_name: "" }))
            }
            items={customers.map((c) => ({ id: c.id, label: c.name }))}
            placeholder="Bestehenden Kunden wählen oder eintippen…"
            clearable
            freeTextDisplay={form.customer_name}
            onCreateNew={(q) => {
              setForm((p) => ({ ...p, customer_id: "", customer_name: q }));
            }}
            createNewLabel="Neuer Kunde"
            commitFreeTextOnBlur
          />
          {!form.customer_id && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Ansprechperson</p>
                <Input
                  placeholder="Vor- & Nachname"
                  value={form.contact_person}
                  onChange={(e) => update("contact_person", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">E-Mail</p>
                <Input
                  type="email"
                  placeholder="kunde@beispiel.ch"
                  value={form.contact_email}
                  onChange={(e) => update("contact_email", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Telefon</p>
                <Input
                  type="tel"
                  placeholder="+41 …"
                  value={form.contact_phone}
                  onChange={(e) => update("contact_phone", e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <hr className="border-border/50" />

        {/* Location — EIN Feld (analog Kunde): Dropdown mit Freitext-
            Fallback im gleichen Trigger. "Neu anlegen: X" legt den Namen
            als Freitext ab; bei Umwandlung landet der Text in
            jobs.external_address — es wird KEINE locations-Row angelegt
            (Leo 2026-09-06). Text bleibt via freeTextDisplay sichtbar. */}
        <div className="space-y-2">
          <SectionLabel>Location</SectionLabel>
          <SearchableSelect
            value={form.location_id}
            onChange={(id) =>
              setForm((p) => ({ ...p, location_id: id, location_name: "" }))
            }
            items={locations.map((l) => ({
              id: l.id,
              label: l.name,
              sub: [l.address_street, l.address_zip, l.address_city].filter(Boolean).join(", "),
            }))}
            placeholder="Location wählen oder eintippen…"
            clearable
            freeTextDisplay={form.location_name}
            onCreateNew={(q) => {
              setForm((p) => ({ ...p, location_id: "", location_name: q }));
            }}
            createNewLabel="Externer Ort"
            commitFreeTextOnBlur
          />
        </div>

        <hr className="border-border/50" />

        {/* Datum — beide Felder optional (Anfragen sind oft noch datumslos) */}
        <div className="space-y-2">
          <SectionLabel>Erwartetes Datum</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Start</p>
              <Input
                type="date"
                value={form.expected_start_date}
                onChange={(e) => update("expected_start_date", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Ende</p>
              <Input
                type="date"
                value={form.expected_end_date}
                onChange={(e) => update("expected_end_date", e.target.value)}
                min={form.expected_start_date || undefined}
              />
            </div>
          </div>
        </div>

        {/* Gäste */}
        <div className="space-y-2">
          <SectionLabel>Gäste (geplant)</SectionLabel>
          <Input
            type="number"
            placeholder="z.B. 80"
            value={form.guest_count}
            onChange={(e) => update("guest_count", e.target.value)}
            min={1}
          />
        </div>

        <hr className="border-border/50" />

        {/* Owner */}
        <div className="space-y-2">
          <SectionLabel>Verantwortlich</SectionLabel>
          <SearchableSelect
            value={form.owner_id}
            onChange={(id) => update("owner_id", id)}
            items={owners.map((o) => ({ id: o.id, label: o.full_name }))}
            placeholder="Wer kümmert sich?"
            searchable={owners.length > 8}
            clearable
          />
        </div>

        {/* Freitext-Notizen */}
        <div className="space-y-2">
          <SectionLabel>Notizen / Rahmenbedingungen</SectionLabel>
          <textarea
            placeholder="z.B. Budget-Rahmen, Sonderwuensche, was der Kunde beim ersten Anruf gesagt hat…"
            value={form.general_notes}
            onChange={(e) => update("general_notes", e.target.value)}
            rows={3}
            style={{ fieldSizing: "content" } as React.CSSProperties}
            className="w-full px-3 py-1.5 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
          />
        </div>

        {/* Buttons */}
        <div className="flex gap-3 pt-2">
          <Link href="/entwuerfe" className="kasten kasten-muted flex-1">
            Abbrechen
          </Link>
          <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
            <Save className="h-3.5 w-3.5" />
            {saving ? "Anlegen…" : "Entwurf anlegen"}
          </button>
        </div>
      </form>
    </div>
  );
}
