"use client";

/**
 * Lieferanten-Liste (/lieferanten) — View-Component. Den Titel bringt die
 * Seite mit, der Anlegen-Button sitzt in der Such-Zeile.
 *
 * Daten ueber /api/lieferanten: Suche serverseitig (?q= in der URL, ueberlebt
 * einen Reload — §4/§10), je Firma die Katalog-Kennzahlen und ob ein
 * Portal-Zugang besteht. Anlegen/Bearbeiten/Loeschen direkt per RLS
 * (lieferanten:create/edit/delete; Loeschen = is_active false).
 *
 * Karte: Kontakt + Adresse, darunter die Infozeilen «Katalog · N Artikel»
 * (nur wenn vorhanden; mit lieferanten:edit oeffnet ein Klick das
 * Katalog-Fenster) und «Portal-Zugang» (Link nach Einstellungen ›
 * Lieferantenportal › Zugaenge fuer Admins — nur sie oeffnen diese
 * Einstellungen —, sonst nur Text). Der Portal-Zugang selbst wird in den
 * Einstellungen verwaltet, der Katalog hier.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StickyFilterBar } from "@/components/ui/sticky-filter-bar";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { KatalogFenster } from "@/components/lieferanten/katalog-fenster";
import { LIEFERANT_TYPES, type LieferantType } from "@/components/lieferanten/lieferant-typen";
import { usePermissions } from "@/lib/use-permissions";
import { TOAST } from "@/lib/messages";
import { toast } from "sonner";
import {
  AlertTriangle, BookOpen, Globe, KeyRound, Loader2, Mail, MapPin, Pencil, Phone, Plus, RotateCw, Search, Trash2, Truck,
} from "lucide-react";

type Lieferant = {
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
  artikel_anzahl: number;
  portal_zugang: boolean;
};

type Formular = {
  name: string;
  type: LieferantType;
  contact_person: string;
  email: string;
  phone: string;
  website: string;
  address_street: string;
  address_zip: string;
  address_city: string;
  notes: string;
};

const LEERES_FORMULAR: Formular = {
  name: "", type: "catering", contact_person: "", email: "", phone: "", website: "",
  address_street: "", address_zip: "", address_city: "", notes: "",
};

type Laden = "laedt" | "fehler" | "ok";

/** Website als Link: ohne Schema wuerde «www.firma.ch» relativ aufgeloest. */
function websiteHref(w: string): string {
  return /^https?:\/\//i.test(w) ? w : `https://${w}`;
}

function adresse(p: Lieferant): string {
  const ort = [p.address_zip, p.address_city].filter(Boolean).join(" ");
  return [p.address_street, ort].filter(Boolean).join(", ");
}

/** Text-Link in der Karte: Unterstrich beim Hover, state-driven (§3). */
function KartenLink({ href, extern, children }: { href: string; extern?: boolean; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      target={extern ? "_blank" : undefined}
      rel={extern ? "noreferrer noopener" : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-1.5 text-foreground min-w-0"
      style={{ textDecoration: hover ? "underline" : undefined }}
    >
      {children}
    </a>
  );
}

/** Feld mit Mini-Label (Form-Layout-Referenz). */
function Feld({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground mb-1 block">{label}</label>
      {children}
    </div>
  );
}

export function LieferantenView() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const { can, role } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [lieferanten, setLieferanten] = useState<Lieferant[]>([]);
  const [laden, setLaden] = useState<Laden>("laedt");
  const [suche, setSuche] = useState(() => searchParams.get("q") ?? "");
  const [editing, setEditing] = useState<Lieferant | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<Formular>(LEERES_FORMULAR);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [katalogId, setKatalogId] = useState<string | null>(null);
  const abfrageNr = useRef(0);

  const darfKatalog = can("lieferanten:edit");
  // Einstellungen › Lieferantenportal › Zugaenge oeffnen nur Admins.
  const istAdmin = role === "admin";

  // Setzt nur Ergebnis/Fehler (laedt setzt der Aufrufer). Spaete Antworten
  // einer aelteren Suche werden verworfen.
  const listeLaden = useCallback(async (q: string) => {
    const nr = ++abfrageNr.current;
    try {
      const res = await fetch(`/api/lieferanten${q ? `?q=${encodeURIComponent(q)}` : ""}`, { cache: "no-store" });
      const j = await res.json().catch(() => null);
      if (nr !== abfrageNr.current) return;
      if (!res.ok || !j?.success) throw new Error(j?.error ?? "Lieferanten konnten nicht geladen werden");
      setLieferanten(j.lieferanten as Lieferant[]);
      setLaden("ok");
    } catch (e) {
      if (nr !== abfrageNr.current) return;
      setLaden("fehler");
      toast.error(e instanceof Error ? e.message : "Lieferanten konnten nicht geladen werden");
    }
  }, []);

  // Suche: 250 ms entprellt (erster Aufruf sofort), Begriff in der URL
  // (?q=), serverseitig gefiltert.
  const ersterLauf = useRef(true);
  useEffect(() => {
    const q = suche.trim();
    const verzoegerung = ersterLauf.current ? 0 : 250;
    ersterLauf.current = false;
    const t = setTimeout(() => {
      const url = new URL(window.location.href);
      if (q) url.searchParams.set("q", q); else url.searchParams.delete("q");
      window.history.replaceState({}, "", url.toString());
      void listeLaden(q);
    }, verzoegerung);
    return () => clearTimeout(t);
  }, [suche, listeLaden]);

  /** Liste mit dem aktuellen Suchbegriff neu laden (Promise: das Katalog-
   *  Fenster wartet darauf, bevor es Erfolg meldet). */
  const neuLaden = () => listeLaden(suche.trim());

  function openNew() {
    setEditing(null);
    setForm(LEERES_FORMULAR);
    setShowForm(true);
  }

  function openEdit(p: Lieferant) {
    setEditing(p);
    setForm({
      name: p.name,
      type: (p.type in LIEFERANT_TYPES ? p.type : "sonstiges") as LieferantType,
      contact_person: p.contact_person ?? "",
      email: p.email ?? "",
      phone: p.phone ?? "",
      website: p.website ?? "",
      address_street: p.address_street ?? "",
      address_zip: p.address_zip ?? "",
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
    const leer = (v: string) => v.trim() || null;
    const payload = {
      name: form.name.trim(),
      type: form.type,
      contact_person: leer(form.contact_person),
      email: leer(form.email),
      phone: leer(form.phone),
      website: leer(form.website),
      address_street: leer(form.address_street),
      address_zip: leer(form.address_zip),
      address_city: leer(form.address_city),
      notes: leer(form.notes),
    };
    setSaving(true);
    try {
      if (editing) {
        const { data, error } = await supabase.from("lieferanten").update(payload).eq("id", editing.id).select("id");
        if (error || !data?.length) { TOAST.supabaseError(error ?? { code: "42501" }, "Speichern fehlgeschlagen"); return; }
        toast.success("Gespeichert");
      } else {
        const { error } = await supabase.from("lieferanten").insert(payload);
        if (error) { TOAST.supabaseError(error, "Speichern fehlgeschlagen"); return; }
        toast.success("Lieferant angelegt");
      }
      setShowForm(false);
      void neuLaden();
    } catch {
      toast.error("Keine Verbindung — bitte nochmals versuchen");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(p: Lieferant) {
    const ok = await confirm({
      title: "Lieferant löschen?",
      message: `«${p.name}» wird entfernt.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      const { data, error } = await supabase.from("lieferanten").update({ is_active: false }).eq("id", p.id).select("id");
      if (error || !data?.length) { TOAST.supabaseError(error ?? { code: "42501" }, "Löschen fehlgeschlagen"); return; }
      toast.success("Gelöscht");
      void neuLaden();
    } catch {
      toast.error("Keine Verbindung — bitte nochmals versuchen");
    } finally {
      setBusyId(null);
    }
  }

  const katalogLieferant = katalogId ? lieferanten.find((l) => l.id === katalogId) ?? null : null;
  const sucht = suche.trim().length > 0;

  return (
    <div className="space-y-6">
      {/* Such-Zeile (Suche + Anlegen) bleibt beim Scrollen stehen. */}
      <StickyFilterBar className="space-y-4">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Name, Ort oder Kontakt suchen…"
              value={suche}
              onChange={(e) => setSuche(e.target.value)}
              className="pl-9"
              aria-label="Lieferanten suchen"
            />
          </div>
          {can("lieferanten:create") && (
            <button type="button" onClick={openNew} className="kasten kasten-red shrink-0">
              <Plus className="h-3.5 w-3.5" />
              Neuer Lieferant
            </button>
          )}
        </div>
      </StickyFilterBar>

      {laden === "laedt" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : laden === "fehler" ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={AlertTriangle}
            title="Lieferanten konnten nicht geladen werden"
            action={
              <button type="button" onClick={() => { setLaden("laedt"); void neuLaden(); }} className="kasten kasten-muted">
                <RotateCw className="h-3.5 w-3.5" /> Erneut laden
              </button>
            }
          />
        </div>
      ) : lieferanten.length === 0 ? (
        <div className="rounded-xl border border-dashed">
          <EmptyState
            icon={Truck}
            title={sucht ? "Keine Treffer" : "Noch keine Lieferanten"}
            description={
              sucht
                ? "Anderen Suchbegriff versuchen."
                : "Lege den ersten Lieferanten an, um Kontakte, Kataloge und Portal-Zugänge zentral zu verwalten."
            }
            action={
              sucht ? (
                <button type="button" onClick={() => setSuche("")} className="kasten kasten-muted">
                  Suche zurücksetzen
                </button>
              ) : can("lieferanten:create") ? (
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
          {lieferanten.map((p) => {
            const typ = LIEFERANT_TYPES[p.type as LieferantType] ?? LIEFERANT_TYPES.sonstiges;
            const adr = adresse(p);
            const hatKatalog = !!p.katalog_path || p.artikel_anzahl > 0;
            const katalogText = p.artikel_anzahl > 0
              ? `Katalog · ${p.artikel_anzahl} Artikel`
              : "Katalog · noch nicht eingelesen";
            return (
              <Card key={p.id}>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="font-semibold truncate">{p.name}</h3>
                      <span className={`inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-medium ${typ.color}`}>
                        {typ.label}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      {darfKatalog && (
                        <button
                          type="button"
                          onClick={() => setKatalogId(p.id)}
                          className="icon-btn icon-btn-blue"
                          data-tooltip="Katalog"
                          aria-label="Katalog"
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {can("lieferanten:edit") && (
                        <button
                          type="button"
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
                          type="button"
                          onClick={() => void handleDelete(p)}
                          disabled={busyId === p.id}
                          className="icon-btn icon-btn-red"
                          data-tooltip="Löschen"
                          aria-label="Löschen"
                        >
                          {busyId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 space-y-1 text-xs">
                    {p.contact_person && <div className="text-muted-foreground">{p.contact_person}</div>}
                    {p.email && (
                      <KartenLink href={`mailto:${p.email}`}>
                        <Mail className="h-3 w-3 shrink-0" />
                        <span className="truncate">{p.email}</span>
                      </KartenLink>
                    )}
                    {p.phone && (
                      <KartenLink href={`tel:${p.phone}`}>
                        <Phone className="h-3 w-3 shrink-0" />
                        <span>{p.phone}</span>
                      </KartenLink>
                    )}
                    {p.website && (
                      <KartenLink href={websiteHref(p.website)} extern>
                        <Globe className="h-3 w-3 shrink-0" />
                        <span className="truncate">{p.website.replace(/^https?:\/\//i, "")}</span>
                      </KartenLink>
                    )}
                    {adr && (
                      <div className="flex items-center gap-1.5 text-muted-foreground min-w-0">
                        <MapPin className="h-3 w-3 shrink-0" />
                        <span className="truncate">{adr}</span>
                      </div>
                    )}
                  </div>

                  {(hatKatalog || p.portal_zugang) && (
                    <div className="mt-3 pt-3 border-t space-y-1 text-xs">
                      {hatKatalog && (
                        darfKatalog ? (
                          <InfoKnopf onClick={() => setKatalogId(p.id)}>
                            <BookOpen className="h-3 w-3 shrink-0" />
                            {katalogText}
                          </InfoKnopf>
                        ) : (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <BookOpen className="h-3 w-3 shrink-0" />
                            {katalogText}
                          </div>
                        )
                      )}
                      {p.portal_zugang && (
                        istAdmin ? (
                          <InfoLink href={`/einstellungen?tab=lieferant&lieferant=${p.id}`}>
                            <KeyRound className="h-3 w-3 shrink-0" />
                            Portal-Zugang
                          </InfoLink>
                        ) : (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <KeyRound className="h-3 w-3 shrink-0" />
                            Portal-Zugang aktiv
                          </div>
                        )
                      )}
                    </div>
                  )}

                  {p.notes && (
                    <p className="mt-3 pt-3 border-t text-xs text-muted-foreground line-clamp-3">
                      {p.notes}
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editing ? "Lieferant bearbeiten" : "Neuer Lieferant"}
        size="lg"
        closable={!saving}
      >
        {/* Ein Raster mit zwei gleich breiten Spalten: alle rechten Felder
            beginnen auf derselben Linie (Form-Layout-Referenz). */}
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Feld label="Name *" htmlFor="lieferant-name">
              <Input id="lieferant-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Feld>
            <Feld label="Kategorie" htmlFor="lieferant-typ">
              <SearchableSelect
                id="lieferant-typ"
                value={form.type}
                onChange={(v) => setForm({ ...form, type: v as LieferantType })}
                items={(Object.keys(LIEFERANT_TYPES) as LieferantType[]).map((t) => ({ id: t, label: LIEFERANT_TYPES[t].label }))}
                clearable={false}
              />
            </Feld>
            <Feld label="Ansprechperson" htmlFor="lieferant-kontakt">
              <Input id="lieferant-kontakt" value={form.contact_person} onChange={(e) => setForm({ ...form, contact_person: e.target.value })} />
            </Feld>
            <Feld label="Telefon" htmlFor="lieferant-telefon">
              <Input id="lieferant-telefon" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Feld>
            <Feld label="E-Mail" htmlFor="lieferant-email">
              <Input id="lieferant-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Feld>
            <Feld label="Website" htmlFor="lieferant-website">
              <Input id="lieferant-website" placeholder="https://…" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            </Feld>
            <Feld label="Strasse" htmlFor="lieferant-strasse">
              <Input id="lieferant-strasse" value={form.address_street} onChange={(e) => setForm({ ...form, address_street: e.target.value })} />
            </Feld>
            <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
              <Feld label="PLZ" htmlFor="lieferant-plz">
                <Input id="lieferant-plz" inputMode="numeric" value={form.address_zip} onChange={(e) => setForm({ ...form, address_zip: e.target.value })} />
              </Feld>
              <Feld label="Ort" htmlFor="lieferant-ort">
                <Input id="lieferant-ort" value={form.address_city} onChange={(e) => setForm({ ...form, address_city: e.target.value })} />
              </Feld>
            </div>
            <div className="sm:col-span-2">
              <Feld label="Notizen" htmlFor="lieferant-notizen">
                <textarea
                  id="lieferant-notizen"
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full rounded-xl border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
                />
              </Feld>
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={() => setShowForm(false)} disabled={saving} className="kasten kasten-muted flex-1">
              Abbrechen
            </button>
            <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? "Wird gespeichert…" : editing ? "Speichern" : "Anlegen"}
            </button>
          </div>
        </form>
      </Modal>

      {katalogLieferant && darfKatalog && (
        <KatalogFenster
          lieferant={katalogLieferant}
          onClose={() => setKatalogId(null)}
          onGeaendert={neuLaden}
        />
      )}
      {ConfirmModalElement}
    </div>
  );
}

/** Infozeile als Knopf (Katalog oeffnen) — Hover state-driven (§3). */
function InfoKnopf({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-1.5 text-left transition-colors"
      style={{ color: hover ? "var(--foreground)" : "var(--muted-foreground)", textDecoration: hover ? "underline" : undefined }}
    >
      {children}
    </button>
  );
}

/** Infozeile als Link (Portal-Zugang in den Einstellungen) — Hover state-driven. */
function InfoLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <PrefetchLink
      href={href}
      onMouseOver={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-1.5 w-fit transition-colors"
      style={{ color: hover ? "var(--foreground)" : "var(--muted-foreground)", textDecoration: hover ? "underline" : undefined }}
    >
      {children}
    </PrefetchLink>
  );
}
