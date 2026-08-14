"use client";

/**
 * Firma-Tab in /einstellungen — admin-only. Pflegt die zentralen Firmen-
 * Stammdaten (Name, Adresse, Kontakt, UID, IBAN) die in Lohnabrechnungs-
 * PDFs, Rapport-PDFs und Mail-Footern erscheinen.
 *
 * Singleton in DB (company_settings id='default'). Non-Admin sieht das
 * Formular readonly (fuer Transparenz), speichern kann nur Admin.
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Loading } from "@/components/ui/spinner";
import { Building2, Save } from "lucide-react";

interface Settings {
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

const EMPTY: Settings = {
  name: "", street: "", zip: "", city: "", country: "Schweiz",
  phone: "", email: "", website: "", uid_number: "", iban: "",
};

export function FirmaTab({ isAdmin }: { isAdmin: boolean }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<Settings>(EMPTY);

  useEffect(() => {
    (async () => {
      const res = await fetch("/api/company-settings");
      const j = await res.json();
      if (j.success) setForm(j.settings as Settings);
      setLoading(false);
    })();
  }, []);

  function set<K extends keyof Settings>(k: K, v: Settings[K]) {
    setForm((s) => ({ ...s, [k]: v }));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    const res = await fetch("/api/company-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const j = await res.json();
    setSaving(false);
    if (!res.ok || !j.success) {
      TOAST.errorOr(j.error);
      return;
    }
    setForm(j.settings as Settings);
    setDirty(false);
    toast.success("Firmen-Stammdaten gespeichert");
  }

  if (loading) return <Loading />;

  const disabled = !isAdmin || saving;

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Building2 className="h-4 w-4" />
        Diese Angaben erscheinen in Lohnabrechnungs-PDFs, Rapport-PDFs und Mail-Footern.
        {!isAdmin && <span className="ml-auto text-[11px] italic">Nur Admins können ändern.</span>}
      </div>

      <Card className="bg-card">
        <CardContent className="p-4 space-y-4">
          <Section label="Firma">
            <Field label="Name" value={form.name} onChange={(v) => set("name", v)} disabled={disabled} placeholder="EVENTLINE GmbH" />
          </Section>

          <Section label="Adresse">
            <Field label="Strasse" value={form.street} onChange={(v) => set("street", v)} disabled={disabled} placeholder="St. Jakobs-Strasse 200" />
            <div className="grid grid-cols-[110px_1fr] gap-2">
              <Field label="PLZ" value={form.zip} onChange={(v) => set("zip", v)} disabled={disabled} placeholder="4052" />
              <Field label="Ort" value={form.city} onChange={(v) => set("city", v)} disabled={disabled} placeholder="Basel" />
            </div>
            <Field label="Land" value={form.country} onChange={(v) => set("country", v)} disabled={disabled} placeholder="Schweiz" />
          </Section>

          <Section label="Kontakt">
            <Field label="Telefon" value={form.phone} onChange={(v) => set("phone", v)} disabled={disabled} placeholder="055 556 62 61" />
            <Field label="E-Mail" value={form.email} onChange={(v) => set("email", v)} disabled={disabled} placeholder="info@eventline-basel.com" />
            <Field label="Website" value={form.website} onChange={(v) => set("website", v)} disabled={disabled} placeholder="www.eventline-basel.com" />
          </Section>

          <Section label="MWST / Bank">
            <Field label="UID-/MWST-Nr." value={form.uid_number} onChange={(v) => set("uid_number", v)} disabled={disabled} placeholder="CHE-123.456.789 MWST" />
            <Field label="IBAN" value={form.iban} onChange={(v) => set("iban", v)} disabled={disabled} placeholder="CH00 0000 0000 0000 0000 0" />
          </Section>
        </CardContent>
      </Card>

      {isAdmin && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className="kasten kasten-red"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Speichert…" : "Speichern"}
          </button>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">{label}</p>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, value, onChange, disabled, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="text-[10px] text-muted-foreground/70 ml-1">{label}</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="mt-0.5"
      />
    </div>
  );
}
