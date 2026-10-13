"use client";

/**
 * Partner-Tab in /einstellungen — admin-only. Einstellungen › Partnerportal ›
 * Zugänge (/einstellungen?tab=partner).
 *
 * Listet alle Partner-User (role='partner'), zeigt zugewiesene Location
 * pro Zeile, erlaubt Anlegen neuer Partner via Modal (Email + Name +
 * Location). Backend: /api/admin/partner-users. Setzt role='partner' +
 * partner_location_id + sendet Setup-Mail.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchableSelect } from "@/components/searchable-select";
import { DeleteUserConfirmModal } from "@/components/einstellungen/delete-user-confirm-modal";
import { Plus, Building2, KeyRound, Pencil, UserX, UserCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

interface PartnerProfileRow {
  id: string;
  full_name: string;
  is_active: boolean;
  partner_location_id: string | null;
  location_name: string | null;
}

interface LocationOption {
  id: string;
  name: string;
}

type EditState = { id: string; full_name: string; partner_location_id: string } | null;

export function PartnerTab() {
  const supabase = createClient();
  const [profiles, setProfiles] = useState<PartnerProfileRow[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", full_name: "", partner_location_id: "" });
  const [edit, setEdit] = useState<EditState>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Aktiv im Delete-Modal — Impact-basierte Bestaetigung. */
  const [deletingUser, setDeletingUser] = useState<PartnerProfileRow | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  async function load() {
    setLoading(true);
    const [profRes, locRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, is_active, partner_location_id, location:locations!profiles_partner_location_id_fkey(name)")
        .eq("role", "partner")
        .order("full_name"),
      supabase.from("locations").select("id, name").eq("is_active", true).order("name"),
    ]);
    // Beide Queries defensiv pruefen — vorher lief load() bei RLS-Fehler
    // still ohne Toast weiter und zeigte leere Listen an.
    if (profRes.error) {
      TOAST.supabaseError(profRes.error, "Partner-Zugänge konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    if (locRes.error) {
      TOAST.supabaseError(locRes.error, "Locations konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    const rows: PartnerProfileRow[] = ((profRes.data as unknown as Array<{
      id: string; full_name: string; is_active: boolean; partner_location_id: string | null;
      location: { name: string } | { name: string }[] | null;
    }>) ?? []).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      is_active: p.is_active,
      partner_location_id: p.partner_location_id,
      location_name: Array.isArray(p.location) ? p.location[0]?.name ?? null : p.location?.name ?? null,
    }));
    setProfiles(rows);
    setLocations((locRes.data as LocationOption[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.email.trim() || !createForm.full_name.trim() || !createForm.partner_location_id) {
      toast.error("Alle Felder sind Pflicht");
      return;
    }
    setCreating(true);
    const res = await fetch("/api/admin/partner-users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });
    const json = await res.json();
    setCreating(false);
    if (!json.success) {
      toast.error(json.error ?? "Anlegen fehlgeschlagen");
      return;
    }
    toast.success("Partner-User angelegt — Setup-Mail wurde versendet");
    setShowCreate(false);
    setCreateForm({ email: "", full_name: "", partner_location_id: "" });
    load();
  }

  async function toggleActive(p: PartnerProfileRow) {
    const ok = await confirm({
      title: p.is_active ? "Partner deaktivieren?" : "Partner reaktivieren?",
      message: p.is_active
        ? `${p.full_name} kann sich nicht mehr ins Partnerportal einloggen. Bestehende Anfragen bleiben sichtbar.`
        : `${p.full_name} kann sich wieder einloggen.`,
      confirmLabel: p.is_active ? "Deaktivieren" : "Reaktivieren",
      variant: p.is_active ? "red" : "blue",
    });
    if (!ok) return;
    setBusyId(p.id);
    const res = await fetch(`/api/admin/users/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_active: !p.is_active }),
    });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) {
      toast.error(json.error ?? "Status-Wechsel fehlgeschlagen");
      return;
    }
    toast.success(p.is_active ? "Partner deaktiviert" : "Partner reaktiviert");
    load();
  }

  async function resetPassword(p: PartnerProfileRow) {
    const ok = await confirm({
      title: "Passwort zurücksetzen?",
      message: `${p.full_name} bekommt einen Link um sich selbst ein neues Passwort zu setzen.`,
      confirmLabel: "Mail senden",
      variant: "red",
    });
    if (!ok) return;
    setBusyId(p.id);
    const res = await fetch(`/api/admin/users/${p.id}/reset-password`, {
      method: "POST",
    });
    const json = await res.json();
    setBusyId(null);
    if (!json.success) {
      toast.error(json.error ?? "Reset-Mail fehlgeschlagen");
      return;
    }
    toast.success("Reset-Mail versendet");
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    if (!edit.full_name.trim() || !edit.partner_location_id) {
      toast.error("Name und Location sind Pflicht");
      return;
    }
    setSavingEdit(true);
    // Name + Location atomar updaten. Name via /api/admin/users (server-
    // side weil das auch im auth-User-Metadata gespiegelt wird), Location
    // direkt via PATCH auf profiles (RLS erlaubt admin).
    const [userRes, locRes] = await Promise.all([
      fetch(`/api/admin/users/${edit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: edit.full_name.trim() }),
      }),
      supabase.from("profiles").update({ partner_location_id: edit.partner_location_id }).eq("id", edit.id),
    ]);
    const userJson = await userRes.json();
    setSavingEdit(false);
    if (!userJson.success) {
      TOAST.errorOr(userJson.error);
      return;
    }
    if (locRes.error) {
      TOAST.supabaseError(locRes.error, "Location konnte nicht aktualisiert werden");
      return;
    }
    toast.success("Gespeichert");
    setEdit(null);
    load();
  }

  // Delete-Flow lebt jetzt in <DeleteUserConfirmModal /> — der Trash2-Button
  // oeffnet nur noch das Modal via setDeletingUser(p). Kein Dossier fuer
  // Partner (kein Payroll-Kontext).

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Partner-Zugänge</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Location-Partner mit Zugang zum Partnerportal. Pro Partner eine Location.
          </p>
        </div>
        <button type="button" onClick={() => setShowCreate(true)} className="kasten kasten-red">
          <Plus className="h-3.5 w-3.5" />
          Neuer Benutzer
        </button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => <Card key={i} className="animate-pulse bg-card"><CardContent className="p-4 h-14" /></Card>)}
        </div>
      ) : profiles.length === 0 ? (
        <EmptyState icon={Building2} title="Noch keine Partner-Zugänge" />
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => (
            <Card key={p.id} className={`bg-card ${!p.is_active ? "opacity-60" : ""}`}>
              <CardContent className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm">{p.full_name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Building2 className="h-3 w-3 shrink-0" />
                    {p.location_name ?? "Keine Location zugewiesen"}
                    {!p.is_active && <span className="ml-2 text-red-600">· deaktiviert</span>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => resetPassword(p)}
                    disabled={busyId === p.id || !p.is_active}
                    className="kasten kasten-muted"
                    data-tooltip="Passwort zurücksetzen"
                    aria-label="Passwort zurücksetzen"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Reset
                  </button>
                  <button
                    type="button"
                    onClick={() => setEdit({ id: p.id, full_name: p.full_name, partner_location_id: p.partner_location_id ?? "" })}
                    className="kasten kasten-purple"
                    data-tooltip="Bearbeiten"
                    aria-label="Bearbeiten"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleActive(p)}
                    disabled={busyId === p.id}
                    className={p.is_active ? "kasten kasten-muted" : "kasten kasten-green"}
                    data-tooltip={p.is_active ? "Deaktivieren" : "Reaktivieren"}
                    aria-label={p.is_active ? "Deaktivieren" : "Reaktivieren"}
                  >
                    {p.is_active ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                  </button>
                  {!p.is_active && (
                    <button
                      type="button"
                      onClick={() => setDeletingUser(p)}
                      disabled={busyId === p.id}
                      className="kasten kasten-red"
                      data-tooltip="Endgültig löschen"
                      aria-label="Endgültig löschen"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Edit-Modal — Name + Location anpassen. */}
      <Modal open={!!edit} onClose={() => !savingEdit && setEdit(null)} title="Partner-Benutzer bearbeiten" size="md">
        {edit && (
          <form onSubmit={saveEdit} className="space-y-4">
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Name *</p>
              <Input
                value={edit.full_name}
                onChange={(e) => setEdit({ ...edit, full_name: e.target.value })}
                required
                autoFocus
              />
            </div>
            <div className="space-y-1">
              <p className="text-[10px] text-muted-foreground/70 ml-1">Location *</p>
              <SearchableSelect
                value={edit.partner_location_id}
                onChange={(id) => setEdit({ ...edit, partner_location_id: id })}
                items={locations.map((l) => ({ id: l.id, label: l.name }))}
                placeholder="Location auswählen…"
                required
                clearable={false}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setEdit(null)} disabled={savingEdit} className="kasten kasten-muted flex-1">Abbrechen</button>
              <button type="submit" disabled={savingEdit || !edit.full_name.trim() || !edit.partner_location_id} className="kasten kasten-red flex-1">
                {savingEdit ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Neuer Partner-Benutzer" closable={!creating}>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="text-xs font-medium">E-Mail *</label>
            <Input
              type="email"
              value={createForm.email}
              onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              placeholder="partner@firma.ch"
              className="mt-1"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium">Voller Name *</label>
            <Input
              value={createForm.full_name}
              onChange={(e) => setCreateForm({ ...createForm, full_name: e.target.value })}
              placeholder="Vorname Nachname"
              className="mt-1"
              required
            />
          </div>
          <div>
            <label className="text-xs font-medium">Location *</label>
            <div className="mt-1">
              <SearchableSelect
                value={createForm.partner_location_id}
                onChange={(id) => setCreateForm({ ...createForm, partner_location_id: id })}
                items={locations.map((l) => ({ id: l.id, label: l.name }))}
                placeholder="Location auswählen…"
                required
                clearable={false}
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Der Partner sieht im Portal nur diese eine Location.
            </p>
          </div>
          <div className="flex gap-2 pt-2 border-t border-border">
            <button type="button" onClick={() => setShowCreate(false)} disabled={creating} className="kasten kasten-muted flex-1">
              Abbrechen
            </button>
            <button type="submit" disabled={creating} className="kasten kasten-red flex-1">
              {creating ? "Speichere…" : "Anlegen + Setup-Mail"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete-Flow — Impact-basierte Bestaetigung (ohne Dossier bei Partnern). */}
      <DeleteUserConfirmModal
        open={!!deletingUser}
        onClose={() => setDeletingUser(null)}
        user={deletingUser ? { id: deletingUser.id, full_name: deletingUser.full_name, role: "Partner" } : null}
        onDeleted={() => { setDeletingUser(null); load(); }}
      />

      {ConfirmModalElement}
    </div>
  );
}
