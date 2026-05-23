"use client";

/**
 * Vertrieb-Liste — Sales-Cockpit + Filter + Lead-Cards.
 *
 * Detail/Edit eines Leads liegt auf /vertrieb/[id] (Detail-Page).
 * Hier:
 *  - StatCards (Aktive Pipeline / Events 30 Tage / Win-Rate)
 *  - Funnel (Stage-Verteilung mit Outcome-Footer)
 *  - Suche + Kategorie/Status/Priority-Filter + Sort-Dropdown
 *  - Archiv-Toggle (zeigt nur 'abgesagt')
 *  - "Neuer Lead"-Flow (CategoryPicker → LeadForm-Inline → Insert → redirect)
 *  - Lead-Cards (Klick navigiert zur Detail-Page)
 *
 * StatCards/Funnel sind im Archiv-Modus ausgeblendet — alle Karten
 * dort haben den gleichen Status, das Reporting waere sinnfrei.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { deleteRow } from "@/lib/db-mutations";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import type { VertriebContact, VertriebStatus, VertriebPriority, VertriebKategorie } from "@/types";
import { Plus, TrendingUp, Search, Archive, PartyPopper, Trophy } from "lucide-react";
import { toast } from "sonner";
import { STATUS_OPTIONS, PRIORITY_OPTIONS, KATEGORIE_OPTIONS, emptyForm } from "./constants";
import { LeadCard } from "@/components/vertrieb/lead-card";
import { LeadForm } from "@/components/vertrieb/lead-form";
import { CategoryPicker } from "@/components/vertrieb/category-picker";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";

type Counts = {
  total: number; offen: number; kontaktiert: number; gespraech: number;
  gewonnen: number; abgesagt: number; step_1: number; step_2: number;
  step_3: number; step_4: number;
};

export default function VertriebPage() {
  const router = useRouter();
  const supabase = createClient();
  const { can } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();

  // Daten
  const [contacts, setContacts] = useState<VertriebContact[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string; email: string | null; phone: string | null }[]>([]);
  // Sales-Mitarbeiter fuer den Assignee-Toggle. Hardcoded gefiltert auf
  // Leo+Mischa+Raul per Email — die anderen Admins (admin test, ggf. andere)
  // sind nicht im Sales-Workflow. Reihenfolge: alphabetisch nach Name.
  const [salesPeople, setSalesPeople] = useState<{ id: string; full_name: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // Suche/Filter
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<VertriebStatus | "all">("all");
  const [filterPriority, setFilterPriority] = useState<VertriebPriority | "all">("all");
  const [filterKategorie, setFilterKategorie] = useState<VertriebKategorie | "all">("all");
  // Sort-Kriterium: Standard ist nr (Reihenfolge der Anlage). Andere
  // Kriterien helfen dem Sales-Workflow:
  //  - event: naechstes Event zuerst (Planungsblick)
  //  - stale: aelteste datum_kontakt zuerst (= veraltet, nachhaken)
  //  - priority: top zuerst (was ist wichtig)
  type SortBy = "nr" | "event" | "stale" | "priority";
  const [sortBy, setSortBy] = useState<SortBy>("nr");

  // Archiv-Modus: zeigt ausschliesslich abgesagte Leads. Persistent damit
  // ein versehentlicher Reload den Modus nicht verliert. Pattern uebernommen
  // vom Operations-Archiv (auftraege/page.tsx).
  const [showArchive, setShowArchive] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("vertrieb-archive") === "true" : false,
  );
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("vertrieb-archive", String(showArchive));
  }, [showArchive]);

  // Add-Flow (Inline) — Lead-NEU bleibt hier weil's nur 3 State-Variablen sind.
  const [showForm, setShowForm] = useState(false);
  const [categoryPicked, setCategoryPicked] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [visibleBedarf, setVisibleBedarf] = useState<Set<string>>(new Set());
  const [kundenMode, setKundenMode] = useState<"neu" | "bestehend">("neu");
  const [selectedCustomerId, setSelectedCustomerId] = useState("");

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("realtime:vertrieb_contacts", handler);
    return () => window.removeEventListener("realtime:vertrieb_contacts", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    const [{ data }, custRes, countsRes, salesRes] = await Promise.all([
      supabase.from("vertrieb_contacts").select("*").order("nr").limit(2000),
      supabase.from("customers").select("id, name, email, phone").eq("is_active", true).order("name"),
      supabase.from("vertrieb_counts").select("*").single(),
      supabase
        .from("profiles")
        .select("id, full_name")
        .in("email", ["leo@eventline-basel.com", "mischa@eventline-basel.com", "raul@eventline-basel.com"])
        .eq("is_active", true)
        .order("full_name"),
    ]);
    if (data) setContacts(data as VertriebContact[]);
    if (custRes.data) setCustomers(custRes.data);
    if (countsRes.data) setCounts(countsRes.data);
    if (salesRes.data) setSalesPeople(salesRes.data);
    setLoading(false);
  }

  // Optimistic Assignee-Update — sofort lokal anzeigen, im Hintergrund
  // schreiben. Bei Fehler revert + Toast. Nicht blocking damit der User
  // sofort sieht dass der Toggle reagiert hat.
  async function assignLead(leadId: string, userId: string | null) {
    const before = contacts.find((c) => c.id === leadId)?.assigned_to;
    setContacts((prev) => prev.map((c) => c.id === leadId ? { ...c, assigned_to: userId } : c));
    const { error } = await supabase
      .from("vertrieb_contacts")
      .update({ assigned_to: userId })
      .eq("id", leadId);
    if (error) {
      // Revert
      setContacts((prev) => prev.map((c) => c.id === leadId ? { ...c, assigned_to: before ?? null } : c));
      TOAST.supabaseError(error, "Zuweisung konnte nicht gespeichert werden");
    }
  }

  function openNew() {
    setForm(emptyForm);
    setCategoryPicked(false);
    setKundenMode("neu");
    setSelectedCustomerId("");
    setVisibleBedarf(new Set());
    setShowForm(true);
  }

  function pickCategory(kategorie: VertriebKategorie) {
    setForm({ ...emptyForm, kategorie });
    setCategoryPicked(true);
  }

  function selectExistingCustomer(customerId: string) {
    setSelectedCustomerId(customerId);
    const c = customers.find((x) => x.id === customerId);
    if (c) setForm((f) => ({ ...f, firma: c.name, email: c.email || "", telefon: c.phone || "", create_customer: false }));
  }

  function closeForm() {
    setShowForm(false);
    setCategoryPicked(false);
  }

  /** Lead anlegen — Insert + ggf. Customer anlegen + Navigation zur Detail-Page. */
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);

    // Details JSON-encoden — wie bisher, aber nur fuer Insert (kein Update mehr).
    const details: Record<string, unknown> = {};
    if (form.event_start) details.event_start = form.event_start;
    if (form.event_end) details.event_end = form.event_end;
    if (form.kategorie === "verwaltung") {
      if (form.infrastruktur) details.infrastruktur = form.infrastruktur;
      if (form.ort) details.ort = form.ort;
      if (form.zielgruppe) details.zielgruppe = form.zielgruppe;
      if (form.programm) details.programm = form.programm;
      if (form.bedarf_vor_ort) details.bedarf_vor_ort = form.bedarf_vor_ort;
    } else {
      const filteredBedarf: Record<string, string> = {};
      Object.entries(form.bedarf).forEach(([k, v]) => { if (v?.trim()) filteredBedarf[k] = v; });
      if (Object.keys(filteredBedarf).length > 0) details.bedarf = filteredBedarf;
    }
    const notizenStored = (Object.keys(details).length > 0 || form.notizen)
      ? JSON.stringify({ _text: form.notizen, _details: details })
      : null;

    const payload = {
      firma: form.firma,
      branche: form.branche || null,
      ansprechperson: form.ansprechperson || null,
      position: form.position || null,
      email: form.email || null,
      telefon: form.telefon || null,
      event_typ: form.event_typ || null,
      status: form.status,
      datum_kontakt: form.datum_kontakt || null,
      notizen: notizenStored,
      prioritaet: form.prioritaet,
      kategorie: form.kategorie,
    };

    const { data: inserted, error } = await supabase.from("vertrieb_contacts").insert(payload).select("id").single();
    if (error || !inserted) { TOAST.supabaseError(error); setSaving(false); return; }

    if (form.create_customer && form.firma) {
      const { data: existing } = await supabase.from("customers").select("id").eq("name", form.firma).maybeSingle();
      if (!existing) {
        await supabase.from("customers").insert({
          name: form.firma, type: "company",
          email: form.email || null, phone: form.telefon || null,
          notes: form.ansprechperson ? `Ansprechperson: ${form.ansprechperson}${form.position ? ` (${form.position})` : ""}` : null,
        });
        toast.success("Eintrag erstellt · Kunde angelegt");
      } else {
        toast.success("Eintrag erstellt · Kunde existiert bereits");
      }
    } else {
      toast.success("Eintrag erstellt");
    }

    setShowForm(false);
    setCategoryPicked(false);
    setForm(emptyForm);
    setSaving(false);
    // Direkt zur Detail-Page des neuen Leads — User kann dort weiter editieren
    router.push(`/vertrieb/${inserted.id}`);
  }

  async function deleteContact(id: string) {
    const ok = await confirm({ title: "Lead löschen?", confirmLabel: "Löschen", variant: "red" });
    if (!ok) return;
    const result = await deleteRow("vertrieb_contacts", id);
    if (!result.ok) { toast.error("Löschen fehlgeschlagen: " + (result.error ?? "Unbekannt")); return; }
    toast.success("Eintrag gelöscht");
    load();
  }

  // No-op edit-handlers — LeadForm braucht alle Props auch im Add-Modus,
  // aber dort werden die advanceStep/lost/buchhaltung/etc-Buttons schon
  // aufgrund von editingId=null nicht gerendert.
  const noop = () => {};
  const noopAsync = async () => {};

  // event_start aus dem JSON-encodeten notizen-Feld pul len. Wird fuer
  // Event-Sort + Stat-Card "Events 30 Tage" gebraucht.
  function parseEventStart(c: VertriebContact): Date | null {
    try {
      const d = (JSON.parse(c.notizen || "{}") as { _details?: { event_start?: string } })?._details?.event_start;
      if (!d) return null;
      const dt = new Date(d);
      return Number.isNaN(dt.getTime()) ? null : dt;
    } catch { return null; }
  }

  const filtered = contacts
    // Archiv-Trennung: Standard-View blendet 'abgesagt' aus, Archiv-View
    // zeigt ausschliesslich 'abgesagt'.
    .filter((c) => showArchive ? c.status === "abgesagt" : c.status !== "abgesagt")
    .filter((c) => filterKategorie === "all" || c.kategorie === filterKategorie)
    .filter((c) => filterStatus === "all" || c.status === filterStatus)
    .filter((c) => filterPriority === "all" || c.prioritaet === filterPriority)
    .filter((c) => {
      const q = search.toLowerCase();
      return !q || c.firma.toLowerCase().includes(q) || (c.ansprechperson || "").toLowerCase().includes(q) || (c.branche || "").toLowerCase().includes(q);
    });

  // Sortierung — separat nach Filter, damit die Filter-Logik linear bleibt.
  const sorted = filtered.slice().sort((a, b) => {
    if (sortBy === "event") {
      const aE = parseEventStart(a);
      const bE = parseEventStart(b);
      if (!aE && !bE) return a.nr - b.nr;
      if (!aE) return 1;
      if (!bE) return -1;
      return aE.getTime() - bE.getTime();
    }
    if (sortBy === "stale") {
      // datum_kontakt aufsteigend = aelteste oben (= laengste nicht
      // angefasst). nulls landen unten.
      if (!a.datum_kontakt && !b.datum_kontakt) return a.nr - b.nr;
      if (!a.datum_kontakt) return 1;
      if (!b.datum_kontakt) return -1;
      return a.datum_kontakt.localeCompare(b.datum_kontakt);
    }
    if (sortBy === "priority") {
      const order: Record<VertriebPriority, number> = { top: 0, gut: 1, mittel: 2 };
      const cmp = order[a.prioritaet] - order[b.prioritaet];
      return cmp !== 0 ? cmp : a.nr - b.nr;
    }
    return a.nr - b.nr;
  });

  const statusCounts: Record<string, number> = counts ? {
    offen: counts.offen, kontaktiert: counts.kontaktiert, gespraech: counts.gespraech,
    gewonnen: counts.gewonnen, abgesagt: counts.abgesagt,
  } : {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{showArchive ? "Vertrieb Archiv" : "Vertrieb"}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {showArchive
              ? `${statusCounts.abgesagt || 0} abgesagte Leads`
              : `${(counts?.total ?? 0) - (statusCounts.abgesagt || 0)} aktive Kontakte · ${statusCounts.gewonnen || 0} gewonnen · ${statusCounts.offen || 0} offen`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              // Beim Wechsel den Status-Filter zuruecksetzen — sonst koennte
              // ein "abgesagt"-Filter aus alter Session ins Archiv mitgehen
              // und dort leere Resultate produzieren.
              setFilterStatus("all");
              setShowArchive(!showArchive);
            }}
            className={showArchive ? "kasten-active" : "kasten-toggle-off"}
          >
            <Archive className="h-3.5 w-3.5" />
            {showArchive ? "Aktive anzeigen" : `Archiv (${statusCounts.abgesagt || 0})`}
          </button>
          {!showArchive && can("vertrieb:create") && (
            <button type="button" onClick={openNew} className="kasten kasten-red">
              <Plus className="h-3.5 w-3.5" />Lead
            </button>
          )}
        </div>
      </div>

      {/* Pipeline-Stats + Funnel — im Archiv ausgeblendet, auf Mobile
          ebenfalls (zu viel vertikaler Platz; die Lead-Cards selbst
          zeigen Status + Priority pro Eintrag). */}
      {!showArchive && counts && counts.total > 0 && (
        <div className="hidden md:grid gap-3 md:grid-cols-3">
          <StatCards counts={counts} contacts={contacts} parseEventStart={parseEventStart} />
        </div>
      )}
      {!showArchive && counts && counts.total > 0 && (
        <div className="hidden md:block">
          <Funnel counts={counts} />
        </div>
      )}

      {/* Suche + Filter — Search volle Breite oben, Dropdowns als 2x2-Grid
          auf Mobile (sonst 5 Reihen stack), sm+ wieder inline. */}
      <div className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Firma, Person oder Branche..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-10 bg-card" />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-3">
        <div className="sm:w-44">
          <SearchableSelect
            value={filterKategorie} onChange={(v) => setFilterKategorie(v as VertriebKategorie | "all")}
            items={[{ id: "all", label: "Alle Kategorien" }, ...KATEGORIE_OPTIONS.map((k) => ({ id: k.value, label: k.label }))]}
            searchable={false} clearable={false} active={filterKategorie !== "all"}
          />
        </div>
        {!showArchive && (
          <div className="sm:w-44">
            <SearchableSelect
              value={filterStatus} onChange={(v) => setFilterStatus(v as VertriebStatus | "all")}
              items={[
                { id: "all", label: "Alle Status" },
                // 'abgesagt' raus — dafuer gibt's das Archiv.
                ...STATUS_OPTIONS.filter((s) => s.value !== "abgesagt").map((s) => ({ id: s.value, label: `${s.label} (${statusCounts[s.value] || 0})` })),
              ]}
              searchable={false} clearable={false} active={filterStatus !== "all"}
            />
          </div>
        )}
        <div className="sm:w-44">
          <SearchableSelect
            value={filterPriority} onChange={(v) => setFilterPriority(v as VertriebPriority | "all")}
            items={[{ id: "all", label: "Alle Prioritäten" }, ...PRIORITY_OPTIONS.map((p) => ({ id: p.value, label: p.label }))]}
            searchable={false} clearable={false} active={filterPriority !== "all"}
          />
        </div>
        <div className="sm:w-52">
          <SearchableSelect
            value={sortBy} onChange={(v) => setSortBy(v as SortBy)}
            items={[
              { id: "nr", label: "↕ Reihenfolge (Standard)" },
              { id: "event", label: "↑ Event-Datum (nächstes)" },
              { id: "stale", label: "↑ Letzter Kontakt (älteste)" },
              { id: "priority", label: "★ Priorität (Top zuerst)" },
            ]}
            searchable={false} clearable={false} active={sortBy !== "nr"}
          />
        </div>
        </div>
      </div>

      {/* Add-Flow inline (CategoryPicker → LeadForm). Edit lebt auf /vertrieb/[id]. */}
      {showForm && !categoryPicked && (
        <CategoryPicker onPick={pickCategory} onClose={() => { setShowForm(false); setCategoryPicked(false); }} />
      )}
      {showForm && categoryPicked && (
        <LeadForm
          editingId={null}
          editingStep={1}
          form={form}
          setForm={setForm}
          saving={saving}
          offertePdf={null}
          uploadingOfferte={false}
          sendingBestaetigung={false}
          visibleBedarf={visibleBedarf}
          setVisibleBedarf={setVisibleBedarf}
          kundenMode={kundenMode}
          setKundenMode={setKundenMode}
          selectedCustomerId={selectedCustomerId}
          setSelectedCustomerId={setSelectedCustomerId}
          customers={customers}
          contacts={contacts}
          onSubmit={save}
          onClose={closeForm}
          onAdvanceStep={noopAsync}
          onMarkRecontacted={noopAsync}
          onOpenLost={noop}
          onOpenBuchhaltung={noop}
          onOpenVerbesserung={noop}
          onOpenTermin={noop}
          onDeleteTermin={noopAsync}
          onUploadOfferte={noopAsync}
          onRemoveOfferte={noopAsync}
          onSendBestaetigung={noopAsync}
          onOpenAuftrag={noop}
          onSelectExistingCustomer={selectExistingCustomer}
          currentContactWithDetails={() => null}
        />
      )}

      {/* Liste */}
      {loading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4"><div className="h-5 bg-foreground/10 dark:bg-foreground/15 rounded w-1/3" /></CardContent></Card>)}</div>
      ) : sorted.length === 0 ? (
        <Card className="bg-card border-dashed">
          <CardContent className="py-16 text-center">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
              {showArchive ? <Archive className="h-7 w-7 text-gray-400" /> : <TrendingUp className="h-7 w-7 text-gray-400" />}
            </div>
            <h3 className="font-semibold text-lg">{showArchive ? "Keine abgesagten Leads" : "Keine Kontakte"}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {showArchive ? "Hier landen Leads sobald sie auf 'abgesagt' gesetzt werden." : "Erstelle deinen ersten Kontakt."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((c) => (
            <LeadCard
              key={c.id}
              contact={c}
              onClick={(c2) => router.push(`/vertrieb/${c2.id}`)}
              onDelete={deleteContact}
              canDelete={can("vertrieb:delete")}
              salesPeople={salesPeople}
              onAssign={assignLead}
            />
          ))}
        </div>
      )}
      {ConfirmModalElement}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * StatCards — drei kompakte Kennzahl-Karten als Sales-Cockpit:
 *   1. Aktive Pipeline   — alle Leads in nicht-terminalen Stages
 *   2. Events 30 Tage    — Leads mit event_start in den naechsten 30 Tagen
 *   3. Win-Rate          — gewonnen / (gewonnen + abgesagt)
 * -------------------------------------------------------------------------- */
function StatCards({
  counts,
  contacts,
  parseEventStart,
}: {
  counts: Counts;
  contacts: VertriebContact[];
  parseEventStart: (c: VertriebContact) => Date | null;
}) {
  const aktive = counts.step_1 + counts.step_2 + counts.step_3 + counts.step_4;

  // Events 30 Tage: nur nicht-terminale Leads mit event_start in [today, today+30].
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const in30 = new Date(today); in30.setDate(today.getDate() + 30);
  const events30 = contacts.filter((c) => {
    if (c.status === "abgesagt" || c.status === "gewonnen") return false;
    const ed = parseEventStart(c);
    return !!ed && ed >= today && ed <= in30;
  }).length;

  // Win-Rate: Sample-Groesse mitanzeigen damit der Wert einordbar ist.
  const closed = counts.gewonnen + counts.abgesagt;
  const winRate = closed > 0 ? Math.round((counts.gewonnen / closed) * 100) : null;

  return (
    <>
      <Card className="bg-card">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
              <TrendingUp className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Aktive Pipeline</p>
              <p className="text-2xl font-bold leading-none mt-1.5 tabular-nums">{aktive}</p>
              <p className="text-[11px] text-muted-foreground mt-1">Leads in Bearbeitung</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card className="bg-card">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-400 flex items-center justify-center shrink-0">
              <PartyPopper className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Events nächste 30 Tage</p>
              <p className="text-2xl font-bold leading-none mt-1.5 tabular-nums">{events30}</p>
              <p className="text-[11px] text-muted-foreground mt-1">anstehend</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card className="bg-card">
        <CardContent className="p-4">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-400 flex items-center justify-center shrink-0">
              <Trophy className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Win-Rate</p>
              <p className="text-2xl font-bold leading-none mt-1.5 tabular-nums">{winRate !== null ? `${winRate}%` : "—"}</p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {closed > 0 ? `${counts.gewonnen} von ${closed} abgeschlossen` : "noch keine abgeschlossen"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/* --------------------------------------------------------------------------
 * Funnel — Sales-Pipeline als horizontale Bar-Liste.
 *
 * Snapshot, kein Flow: jede Stage zeigt wie viele Leads aktuell DORT
 * stehen, nicht wie viele die Stage passiert haben (Status-Change-Historie
 * fehlt). Trotzdem aussagekraeftiger als der Donut weil Stages in Reihenfolge
 * stehen und die Bar-Breiten relativ zur staerksten Stage skalieren — der
 * "Funnel-Effekt" wird visuell sichtbar.
 * -------------------------------------------------------------------------- */
function Funnel({ counts }: { counts: Counts }) {
  // Style: tinted Background + 2px solid Border in der Stage-Farbe — gleiche
  // Optik wie der TrendChart auf /abrechnung. RGB-Werte stammen aus den
  // --status-X CSS-Variablen; rgba(...)-Klassen muessen statisch im Code
  // stehen damit Tailwind-JIT sie picken kann.
  const stages = [
    { nr: 1, label: "Offen",         count: counts.step_1, color: "var(--status-gray)",    tint: "bg-[rgba(100,116,139,0.12)] dark:bg-[rgba(100,116,139,0.18)]" },
    { nr: 2, label: "Kontaktiert",   count: counts.step_2, color: "var(--status-blue)",    tint: "bg-[rgba(37,99,235,0.12)] dark:bg-[rgba(37,99,235,0.18)]" },
    { nr: 3, label: "Finalisierung", count: counts.step_3, color: "var(--status-green)",   tint: "bg-[rgba(0,168,107,0.12)] dark:bg-[rgba(0,168,107,0.18)]" },
    { nr: 4, label: "Operations",    count: counts.step_4, color: "var(--status-emerald)", tint: "bg-[rgba(4,120,87,0.12)] dark:bg-[rgba(4,120,87,0.18)]" },
  ];
  const maxCount = Math.max(1, ...stages.map((s) => s.count));

  return (
    <Card className="bg-card">
      <CardContent className="p-4 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Pipeline</p>
        <div className="space-y-2">
          {stages.map((s) => {
            const pct = (s.count / maxCount) * 100;
            return (
              <div key={s.nr} className="flex items-center gap-3">
                <span className="w-32 sm:w-40 text-xs font-medium shrink-0 truncate">{s.nr}. {s.label}</span>
                <div className="flex-1 h-7 flex items-center">
                  {s.count > 0 && (
                    <div
                      className={`h-7 rounded-md border-2 border-solid transition-all ${s.tint}`}
                      style={{
                        width: `${pct}%`,
                        borderColor: s.color,
                        minWidth: "10px",
                      }}
                    />
                  )}
                </div>
                <span className="w-8 text-right text-sm font-mono tabular-nums font-semibold shrink-0">{s.count}</span>
              </div>
            );
          })}
        </div>
        {/* Outcomes — getrennt unter dem Funnel weil sie kein "current state"
            sind sondern abgeschlossene Faelle. */}
        <div className="border-t border-border pt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--status-green)" }} />
            <span className="text-muted-foreground">Gewonnen</span>
            <strong className="tabular-nums">{counts.gewonnen}</strong>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: "var(--status-red)" }} />
            <span className="text-muted-foreground">Verloren</span>
            <strong className="tabular-nums">{counts.abgesagt}</strong>
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
