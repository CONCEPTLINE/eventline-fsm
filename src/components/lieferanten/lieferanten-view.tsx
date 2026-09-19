"use client";

/**
 * Lieferanten-Liste — View-Component.
 *
 * Wird gerendert von /lieferanten (Deep-Link-Alias) und /kontakte?tab=lieferanten.
 *
 * "embedded"-Prop: unterdrueckt den eigenen Header (h1+Subtitle+Anlegen-Button)
 * wenn im Kontakte-Hub eingebettet. Der Anlegen-Button wandert dann in die
 * Filter-Zeile.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/modal";
import {
  Plus,
  Search,
  Mail,
  Phone,
  Globe,
  MapPin,
  Trash2,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { Truck } from "lucide-react";
import { SearchableSelect } from "@/components/searchable-select";

// Color-Konvention: lila ist app-weit IT-Tickets, gruen ist Stempel.
const LIEFERANT_TYPES = {
  catering: { label: "Catering", color: "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300" },
  technik: { label: "Technik", color: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300" },
  av: { label: "AV / Sound", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300" },
  mobiliar: { label: "Mobiliar", color: "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/15 dark:text-yellow-300" },
  reinigung: { label: "Reinigung", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300" },
  security: { label: "Security", color: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300" },
  logistik: { label: "Logistik", color: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300" },
  sonstiges: { label: "Sonstiges", color: "bg-zinc-100 text-zinc-700 dark:bg-zinc-500/15 dark:text-zinc-300" },
} as const;

type LieferantType = keyof typeof LIEFERANT_TYPES;

type Lieferant = {
  id: string;
  name: string;
  type: LieferantType;
  contact_person: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  address_city: string | null;
  notes: string | null;
  is_active: boolean;
};

const EMPTY_FORM: Omit<Lieferant, "id" | "is_active"> = {
  name: "",
  type: "catering",
  contact_person: "",
  email: "",
  phone: "",
  website: "",
  address_city: "",
  notes: "",
};

interface Props {
  /** Wenn true, wird der Header (h1 + Subtitle + Neuer-Lieferant-Button) weggelassen. */
  embedded?: boolean;
}

export function LieferantenView({ embedded = false }: Props = {}) {
  const supabase = createClient();
  const [lieferanten, setLieferanten] = useState<Lieferant[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Lieferant | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<typeof EMPTY_FORM>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();
  const { can } = usePermissions();

  useEffect(() => {
    load();
  }, []);

  async function load() {
    const { data } = await supabase
      .from("lieferanten")
      .select("*")
      .eq("is_active", true)
      .order("name");
    setLieferanten((data as Lieferant[]) ?? []);
    setLoading(false);
  }

  function openNew() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
  }

  function openEdit(p: Lieferant) {
    setEditing(p);
    setForm({
      name: p.name,
      type: p.type,
      contact_person: p.contact_person ?? "",
      email: p.email ?? "",
      phone: p.phone ?? "",
      website: p.website ?? "",
      address_city: p.address_city ?? "",
      notes: p.notes ?? "",
    });
    setShowForm(true);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Name ist Pflichtfeld");
      return;
    }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      type: form.type,
      contact_person: form.contact_person?.trim() || null,
      email: form.email?.trim() || null,
      phone: form.phone?.trim() || null,
      website: form.website?.trim() || null,
      address_city: form.address_city?.trim() || null,
      notes: form.notes?.trim() || null,
    };
    if (editing) {
      const { error } = await supabase
        .from("lieferanten")
        .update(payload)
        .eq("id", editing.id);
      if (error) {
        TOAST.supabaseError(error, "Speichern fehlgeschlagen");
        setSaving(false);
        return;
      }
      toast.success("Aktualisiert");
    } else {
      const { error } = await supabase.from("lieferanten").insert(payload);
      if (error) {
        TOAST.supabaseError(error, "Speichern fehlgeschlagen");
        setSaving(false);
        return;
      }
      toast.success("Lieferant angelegt");
    }
    setShowForm(false);
    setSaving(false);
    load();
  }

  async function handleDelete(p: Lieferant) {
    const ok = await confirm({
      title: "Lieferant löschen?",
      message: `"${p.name}" wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("lieferanten")
      .update({ is_active: false })
      .eq("id", p.id);
    if (error) {
      TOAST.supabaseError(error, "Löschen fehlgeschlagen");
      return;
    }
    toast.success("Gelöscht");
    load();
  }

  const filtered = lieferanten.filter((p) => {
    if (search) {
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.contact_person?.toLowerCase().includes(q) ||
        p.email?.toLowerCase().includes(q) ||
        p.address_city?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Kompletter Kopf (Titel + Aktionen + Filter) bleibt beim Scrollen stehen. */}
      <StickyFilterBar className="space-y-4">
      {!embedded && (
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Lieferanten</h1>
            {/* Leerer Subtitle-Platzhalter — Header-Hoehe identisch zu /kunden. */}
            <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
          </div>
          {can("lieferanten:create") && (
            <button
              type="button"
              onClick={openNew}
              className="kasten kasten-red"
            >
              <Plus className="h-3.5 w-3.5" />
              Neuer Lieferant
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Suchen…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {embedded && can("lieferanten:create") && (
          <button
            type="button"
            onClick={openNew}
            className="kasten kasten-red shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            Neuer Lieferant
          </button>
        )}
      </div>
      </StickyFilterBar>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-44 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Truck}
            title={lieferanten.length === 0 ? "Noch keine Lieferanten" : "Keine Treffer"}
            description={
              lieferanten.length === 0
                ? "Lege deinen ersten Lieferanten an, um Rechnungen und Kontakte zentral zu verwalten."
                : "Andere Suche oder Filter zurücksetzen."
            }
            action={
              lieferanten.length === 0 && can("lieferanten:create") ? (
                <button type="button" onClick={openNew} className="kasten kasten-red inline-flex items-center gap-1.5">
                  <Plus className="h-3.5 w-3.5" />
                  Ersten Lieferanten anlegen
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map((p) => (
            <Card key={p.id}>
              <CardContent className="pt-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="font-semibold truncate">{p.name}</h3>
                    <span
                      className={`inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-medium ${
                        LIEFERANT_TYPES[p.type].color
                      }`}
                    >
                      {LIEFERANT_TYPES[p.type].label}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    {can("lieferanten:edit") && (
                      <button
                        onClick={() => openEdit(p)}
                        className="icon-btn icon-btn-purple"
                        data-tooltip="Bearbeiten"
                        aria-label="Bearbeiten"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {can("lieferanten:delete") && (
                      <button
                        onClick={() => handleDelete(p)}
                        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
                        data-tooltip="Löschen"
                        aria-label="Löschen"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>



                <div className="mt-3 space-y-1 text-xs">
                  {p.contact_person && (
                    <div className="text-muted-foreground">{p.contact_person}</div>
                  )}
                  {p.email && (
                    <a
                      href={`mailto:${p.email}`}
                      className="flex items-center gap-1.5 text-foreground hover:underline truncate"
                    >
                      <Mail className="h-3 w-3 shrink-0" />
                      <span className="truncate">{p.email}</span>
                    </a>
                  )}
                  {p.phone && (
                    <a
                      href={`tel:${p.phone}`}
                      className="flex items-center gap-1.5 text-foreground hover:underline"
                    >
                      <Phone className="h-3 w-3 shrink-0" />
                      <span>{p.phone}</span>
                    </a>
                  )}
                  {p.website && (
                    <a
                      href={p.website}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex items-center gap-1.5 text-foreground hover:underline truncate"
                    >
                      <Globe className="h-3 w-3 shrink-0" />
                      <span className="truncate">
                        {p.website.replace(/^https?:\/\//, "")}
                      </span>
                    </a>
                  )}
                  {p.address_city && (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" />
                      <span>{p.address_city}</span>
                    </div>
                  )}
                </div>

                {p.notes && (
                  <p className="mt-3 pt-3 border-t text-xs text-muted-foreground line-clamp-3">
                    {p.notes}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? "Lieferant bearbeiten" : "Neuer Lieferant"}
        size="lg"
        closable={!saving}
      >
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-3">
            <div>
              <Label htmlFor="name">Name *</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="mt-1.5"
                required
              />
            </div>
            <div>
              <Label htmlFor="type">Kategorie</Label>
              <div className="mt-1.5">
                <SearchableSelect
                  id="type"
                  value={form.type}
                  onChange={(v) => setForm({ ...form, type: v as LieferantType })}
                  items={(Object.keys(LIEFERANT_TYPES) as LieferantType[]).map((t) => ({
                    id: t,
                    label: LIEFERANT_TYPES[t].label,
                  }))}
                  clearable={false}
                />
              </div>
            </div>
          </div>

          <div>
            <Label htmlFor="contact_person">Ansprechperson</Label>
            <Input
              id="contact_person"
              value={form.contact_person ?? ""}
              onChange={(e) =>
                setForm({ ...form, contact_person: e.target.value })
              }
              className="mt-1.5"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="email">E-Mail</Label>
              <Input
                id="email"
                type="email"
                value={form.email ?? ""}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="phone">Telefon</Label>
              <Input
                id="phone"
                value={form.phone ?? ""}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className="mt-1.5"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-3">
            <div>
              <Label htmlFor="website">Website</Label>
              <Input
                id="website"
                placeholder="https://…"
                value={form.website ?? ""}
                onChange={(e) => setForm({ ...form, website: e.target.value })}
                className="mt-1.5"
              />
            </div>
            <div>
              <Label htmlFor="city">Ort</Label>
              <Input
                id="city"
                value={form.address_city ?? ""}
                onChange={(e) =>
                  setForm({ ...form, address_city: e.target.value })
                }
                className="mt-1.5"
              />
            </div>
          </div>

          <div>
            <Label htmlFor="notes">Notizen</Label>
            <textarea
              id="notes"
              rows={3}
              value={form.notes ?? ""}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="mt-1.5 w-full rounded-xl border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />
          </div>

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              disabled={saving}
              className="kasten kasten-muted flex-1"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={saving}
              className="kasten kasten-red flex-1"
            >
              {saving ? "Speichert…" : editing ? "Speichern" : "Anlegen"}
            </button>
          </div>
        </form>
      </Modal>
      {ConfirmModalElement}
    </div>
  );
}
