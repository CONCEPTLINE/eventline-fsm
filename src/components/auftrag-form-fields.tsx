"use client";

/**
 * Gemeinsame Form-Felder für /auftraege/neu und /auftraege/[id]/bearbeiten.
 * Nur UI-Rendering — State, Validation und Submit bleiben in den Parent-Pages.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { SearchableSelect } from "@/components/searchable-select";
import { AlertCircle, User } from "lucide-react";

export type AuftragJobType = "location" | "extern";

export type AuftragFormState = {
  job_type: AuftragJobType;
  title: string;
  description: string;
  location_id: string;
  customer_id: string;
  external_address: string;
  /** Bei job_type='extern': optional ein bekannter Raum aus rooms-Tabelle.
   *  Wird gesetzt sobald der User aus den Adress-Vorschlaegen einen Raum
   *  pickt; wird wieder geleert sobald er die Adresse manuell aendert. */
  room_id: string;
  start_date: string;
  end_date: string;
  urgent: boolean;
  /** Veranstalter-Kontakt vor Ort. Person + Telefon Pflicht, Mail optional. */
  contact_person: string;
  contact_phone: string;
  contact_email: string;
};

export type Customer = {
  id: string;
  name: string;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
  email?: string | null;
  phone?: string | null;
};
export type Location = {
  id: string;
  name: string;
  address_street: string | null;
  address_zip: string | null;
  address_city: string | null;
};

function formatAddress(parts: { address_street: string | null; address_zip: string | null; address_city: string | null }): string {
  return [parts.address_street, parts.address_zip, parts.address_city].filter(Boolean).join(", ");
}
// Raeume haben dasselbe Adress-Shape wie Locations — Type-Alias macht das explizit.
export type Room = Location;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

// "YYYY-MM-DD" für die lokale Zeitzone — passt zu <input type="date">
export function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface ContactSuggestion {
  person: string;
  phone: string;
  email: string;
}

interface Props {
  form: AuftragFormState;
  onChange: (form: AuftragFormState) => void;
  customers: Customer[] | null;
  locations: Location[] | null;
  rooms: Room[] | null;
  /** Bei Edit-Page wollen wir nicht zwingend "Datum nicht in der Vergangenheit" enforcen. */
  enforceNoPastDates?: boolean;
  /** Wird beim Klick auf "Neuer Kunde" im Kunden-Dropdown aufgerufen. Parent kuemmert sich um Draft-Speichern + Navigation. */
  onCreateCustomer?: (query: string) => void;
  /** Auftrag entsteht aus einer Instandhaltungsarbeit — Titel und Location
   *  sind dort schon festgelegt und werden hier readonly angezeigt. Job-Type
   *  ist immer "location" und wird nicht als Toggle gerendert. */
  fromMaintenance?: boolean;
  /** Bekannte Ansprechpersonen aus frueheren Auftraegen (dedup by name).
   *  Wenn gesetzt, wird das Ansprechperson-Feld zur Autocomplete-Combobox —
   *  Auswahl fuellt Name + Telefon + E-Mail in einem Rutsch. */
  contactSuggestions?: ContactSuggestion[];
}

export function AuftragFormFields({
  form,
  onChange,
  customers,
  locations,
  rooms,
  enforceNoPastDates = true,
  onCreateCustomer,
  fromMaintenance = false,
  contactSuggestions,
}: Props) {
  function update<K extends keyof AuftragFormState>(field: K, value: AuftragFormState[K]) {
    onChange({ ...form, [field]: value });
  }

  function pickContact(c: ContactSuggestion) {
    onChange({ ...form, contact_person: c.person, contact_phone: c.phone, contact_email: c.email });
  }

  function setJobType(t: AuftragJobType) {
    onChange({
      ...form,
      job_type: t,
      location_id: t === "location" ? form.location_id : "",
      customer_id: t === "extern" ? form.customer_id : "",
      external_address: t === "extern" ? form.external_address : "",
      room_id: t === "extern" ? form.room_id : "",
    });
  }

  const selectedLocation = locations?.find((l) => l.id === form.location_id);
  const minDate = enforceNoPastDates ? todayLocalISO() : undefined;

  return (
    <>
      {/* Auftragstyp — dezent statt knallig: aktiver Toggle nur leicht abgesetzt.
       *  Aus Instandhaltung kommend ist der Typ immer "location" und der
       *  Toggle wird nicht angezeigt. */}
      {!fromMaintenance && (
        <div className="grid grid-cols-2 gap-3">
          {(["location", "extern"] as AuftragJobType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setJobType(t)}
              className={`px-3 py-2 rounded-xl border text-sm transition-all ${
                form.job_type === t
                  ? "bg-foreground/[0.08] border-foreground/40 font-semibold"
                  : "border-border text-muted-foreground hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.10] hover:text-foreground"
              }`}
            >
              {t === "location" ? "Location" : "Firma / Privat"}
            </button>
          ))}
        </div>
      )}

      {/* Was */}
      <div className="space-y-2">
        <SectionLabel>Titel *</SectionLabel>
        {fromMaintenance ? (
          <div className="h-9 flex items-center px-3 text-xs rounded-xl border border-dashed bg-muted/20 text-muted-foreground truncate">
            {form.title}
          </div>
        ) : (
          <Input
            id="title"
            placeholder="kurz, was zu tun ist (z.B. Lichtaufbau)"
            value={form.title}
            onChange={(e) => update("title", e.target.value)}
            aria-required
            autoFocus
          />
        )}
      </div>
      <div className="space-y-2">
        <SectionLabel>Beschreibung</SectionLabel>
        <textarea
          id="description"
          placeholder="Details zum Auftrag…"
          value={form.description}
          onChange={(e) => update("description", e.target.value)}
          rows={2}
          style={{ fieldSizing: "content" } as React.CSSProperties}
          className="w-full px-3 py-1.5 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
        />
      </div>

      <hr className="border-border/50" />

      {/* Wo */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <SectionLabel>Wo</SectionLabel>
          <button
            type="button"
            onClick={() => update("urgent", !form.urgent)}
            data-tooltip={form.urgent ? "Dringend markiert (klicken zum entfernen)" : "Als dringend markieren"}
            aria-pressed={form.urgent}
            aria-label="Dringend markieren"
            className={`inline-flex items-center justify-center h-7 w-7 rounded-md transition-all ${
              form.urgent
                ? "bg-red-500 text-white shadow-sm shadow-red-500/30"
                : "text-muted-foreground/60 hover:text-red-500 hover:bg-red-500/10"
            }`}
          >
            <AlertCircle className="h-4 w-4" strokeWidth={form.urgent ? 2.5 : 2} />
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {form.job_type === "location" ? (
            <>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Location *</p>
                {fromMaintenance ? (
                  <div className="h-9 flex items-center px-3 text-xs rounded-xl border border-dashed bg-muted/20 text-muted-foreground truncate">
                    {selectedLocation?.name ?? ""}
                  </div>
                ) : (
                  <SearchableSelect
                    value={form.location_id}
                    onChange={(id) => update("location_id", id)}
                    items={(locations ?? []).map((l) => ({
                      id: l.id,
                      label: l.name,
                      sub: [l.address_street, l.address_zip, l.address_city].filter(Boolean).join(", "),
                    }))}
                    placeholder="Location auswählen…"
                    required
                  />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Adresse</p>
                <div className="h-9 flex items-center px-3 text-xs rounded-xl border border-dashed bg-muted/20 text-muted-foreground truncate">
                  {selectedLocation
                    ? [selectedLocation.address_street, selectedLocation.address_zip, selectedLocation.address_city]
                        .filter(Boolean)
                        .join(", ") || "Keine Adresse hinterlegt"
                    : "Adresse erscheint nach Auswahl"}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Kunde *</p>
                <SearchableSelect
                  value={form.customer_id}
                  onChange={(id) => {
                    // Wenn der gewaehlte Kunde eine Adresse hinterlegt hat,
                    // automatisch ins Adress-Feld uebernehmen — bei Privat-
                    // /Firmen-Auftraegen ist die Kunden-Adresse meistens auch
                    // der Einsatzort. room_id leeren weil's kein bekannter
                    // Raum aus der rooms-Tabelle ist.
                    const c = customers?.find((c) => c.id === id);
                    const addr = c ? formatAddress(c) : "";
                    onChange({
                      ...form,
                      customer_id: id,
                      external_address: addr || form.external_address,
                      room_id: addr ? "" : form.room_id,
                    });
                  }}
                  items={(customers ?? []).map((c) => ({ id: c.id, label: c.name }))}
                  placeholder="Kunde tippen…"
                  required
                  onCreateNew={onCreateCustomer}
                  createNewLabel="Neuer Kunde"
                />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Ort *</p>
                <AddressAutocomplete
                  value={form.external_address}
                  onChange={(v) =>
                    // Beim Tippen room_id leeren — andernfalls "kleben" alte
                    // Raum-Picks an einer manuell veraenderten Adresse.
                    onChange({ ...form, external_address: v, room_id: "" })
                  }
                  onRoomPick={(roomId, addressText) =>
                    onChange({ ...form, external_address: addressText, room_id: roomId })
                  }
                  localLocations={locations ?? []}
                  localRooms={rooms ?? []}
                  placeholder="Raum auswählen oder Adresse tippen…"
                  required
                />
              </div>
            </>
          )}
        </div>
        {form.job_type === "location" && locations !== null && locations.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Noch keine Locations.{" "}
            <Link href="/standorte" className="underline">
              Jetzt anlegen
            </Link>
          </p>
        )}
        {form.job_type === "extern" && customers !== null && customers.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Noch keine Kunden.{" "}
            <Link href="/kunden/neu" className="underline">
              Jetzt anlegen
            </Link>
          </p>
        )}
      </div>

      {/* Veranstalter-Kontakt — nur bei job_type='location'. Bei Firma/Privat
          ist der Customer selbst der Ansprechpartner, da gibt's keinen
          separaten Event-Kontakt vor Ort. Pflicht: Person + Telefon.
          Bei Instandhaltung (fromMaintenance) faellt der Kontakt komplett
          weg — es geht um eine technische Arbeit am Standort, nicht um
          einen Event mit Ansprechperson. */}
      {form.job_type === "location" && !fromMaintenance && (
        <>
          <hr className="border-border/50" />
          <div className="space-y-2">
            <SectionLabel>Veranstalter-Kontakt</SectionLabel>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Ansprechperson *</p>
                <ContactPersonField
                  value={form.contact_person}
                  onChange={(v) => update("contact_person", v)}
                  onPick={pickContact}
                  suggestions={contactSuggestions ?? []}
                />
              </div>
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground/70 ml-1">Telefon *</p>
                <Input
                  id="contact_phone"
                  type="tel"
                  inputMode="tel"
                  placeholder="0041 55 556 62 61"
                  value={form.contact_phone}
                  onChange={(e) => update("contact_phone", e.target.value.replace(/[^0-9+ ]/g, ""))}
                  required
                />
              </div>
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">E-Mail</p>
              <Input
                type="email"
                placeholder="optional"
                value={form.contact_email}
                onChange={(e) => update("contact_email", e.target.value)}
              />
            </div>
          </div>
        </>
      )}

      <hr className="border-border/50" />

      {/* Wann */}
      <div className="space-y-2">
        <SectionLabel>Wann</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Start *</p>
            <Input
              id="start_date"
              type="date"
              min={minDate}
              value={form.start_date}
              onChange={(e) => update("start_date", e.target.value)}
              aria-label="Startdatum"
            />
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">Ende *</p>
            <Input
              id="end_date"
              type="date"
              min={form.start_date || minDate}
              value={form.end_date}
              onChange={(e) => update("end_date", e.target.value)}
              aria-label="Enddatum"
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** Ansprechperson-Input mit Autocomplete aus vergangenen Auftraegen.
 *  Beim Fokus + Tippen erscheint ein Dropdown mit gematchten Kontakten
 *  (case-insensitive Substring auf Namen). Klick fuellt Name + Phone + E-Mail
 *  in einem Rutsch. Freies Weitertippen bleibt erlaubt (neuer Kontakt). */
function ContactPersonField({
  value,
  onChange,
  onPick,
  suggestions,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (c: ContactSuggestion) => void;
  suggestions: ContactSuggestion[];
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!boxRef.current) return;
      if (!boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const q = value.trim().toLowerCase();
  // Wenn leer: Top 8 bekannte Kontakte (die neuesten). Sonst: Substring-Match.
  const filtered = (q
    ? suggestions.filter((s) => s.person.toLowerCase().includes(q))
    : suggestions
  ).slice(0, 8);
  // Exakter Match ausblenden — dann muss der User nicht sein eigenes Getipptes
  // aus dem Dropdown wieder anklicken.
  const showList = open && filtered.length > 0 && !(filtered.length === 1 && filtered[0].person.toLowerCase() === q);

  return (
    <div ref={boxRef} className="relative">
      <Input
        id="contact_person"
        placeholder="Vor- und Nachname"
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        autoComplete="off"
        required
      />
      {showList && (
        <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg border border-border bg-card shadow-lg max-h-64 overflow-y-auto">
          {filtered.map((c) => (
            <button
              key={c.person}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); onPick(c); setOpen(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50 transition-colors"
            >
              <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 min-w-0">
                <span className="block truncate font-medium">{c.person}</span>
                {(c.phone || c.email) && (
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {[c.phone, c.email].filter(Boolean).join(" · ")}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
