"use client";

/**
 * Lieferantenportal-Tab in /einstellungen — admin-only.
 *
 * Listet alle Lieferanten-User (role='lieferant'), zeigt zugewiesene
 * Lieferanten-Firma pro Zeile, erlaubt Anlegen neuer Lieferanten-User via
 * Modal (Email + Name + Firma). Backend: /api/admin/lieferant-users. Setzt
 * role='lieferant' + lieferant_id + sendet Setup-Mail.
 *
 * 1:1-Spiegelung des Partner-Musters (partner-tab.tsx), nur mit
 * public.lieferanten statt locations.
 */

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { DeleteUserConfirmModal } from "@/components/einstellungen/delete-user-confirm-modal";
import { Plus, Truck, KeyRound, Pencil, UserX, UserCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";

// Typ-Labels der Lieferanten-Firmen (Sublabel im Firmen-Dropdown). Lokale
// Kopie der Labels aus lieferanten-view.tsx — dort ist LIEFERANT_TYPES nicht
// exportiert; unbekannte Slugs fallen auf den Roh-Slug zurueck.
const LIEFERANT_TYPE_LABELS: Record<string, string> = {
  catering: "Catering",
  technik: "Technik",
  av: "AV / Sound",
  mobiliar: "Mobiliar",
  reinigung: "Reinigung",
  security: "Security",
  logistik: "Logistik",
  sonstiges: "Sonstiges",
};

interface LieferantProfileRow {
  id: string;
  full_name: string;
  is_active: boolean;
  lieferant_id: string | null;
  lieferant_name: string | null;
}

interface LieferantOption {
  id: string;
  name: string;
  type: string | null;
}

type EditState = { id: string; full_name: string; lieferant_id: string } | null;

export function LieferantenPortalTab() {
  const supabase = createClient();
  const [profiles, setProfiles] = useState<LieferantProfileRow[]>([]);
  const [lieferanten, setLieferanten] = useState<LieferantOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm, setCreateForm] = useState({ email: "", full_name: "", lieferant_id: "" });
  const [edit, setEdit] = useState<EditState>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Aktiv im Delete-Modal — Impact-basierte Bestaetigung. */
  const [deletingUser, setDeletingUser] = useState<LieferantProfileRow | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  async function load() {
    setLoading(true);
    const [profRes, liefRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, is_active, lieferant_id, lieferant:lieferanten!profiles_lieferant_id_fkey(name)")
        .eq("role", "lieferant")
        .order("full_name"),
      supabase.from("lieferanten").select("id, name, type").eq("is_active", true).order("name"),
    ]);
    // Beide Queries defensiv pruefen — sonst laeuft load() bei RLS-Fehler
    // still ohne Toast weiter und zeigt leere Listen an (gleiches Learning
    // wie im Partner-Tab).
    if (profRes.error) {
      TOAST.supabaseError(profRes.error, "Lieferanten-Benutzer konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    if (liefRes.error) {
      TOAST.supabaseError(liefRes.error, "Lieferanten konnten nicht geladen werden");
      setLoading(false);
      return;
    }
    const rows: LieferantProfileRow[] = ((profRes.data as unknown as Array<{
      id: string; full_name: string; is_active: boolean; lieferant_id: string | null;
      lieferant: { name: string } | { name: string }[] | null;
    }>) ?? []).map((p) => ({
      id: p.id,
      full_name: p.full_name,
      is_active: p.is_active,
      lieferant_id: p.lieferant_id,
      lieferant_name: Array.isArray(p.lieferant) ? p.lieferant[0]?.name ?? null : p.lieferant?.name ?? null,
    }));
    setProfiles(rows);
    setLieferanten((liefRes.data as LieferantOption[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Firmen-Optionen fuer die SearchableSelect — Name + Typ als Sublabel. */
  const lieferantItems = lieferanten.map((l) => ({
    id: l.id,
    label: l.name,
    sub: l.type ? LIEFERANT_TYPE_LABELS[l.type] ?? l.type : undefined,
  }));

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!createForm.email.trim() || !createForm.full_name.trim() || !createForm.lieferant_id) {
      toast.error("Alle Felder sind Pflicht");
      return;
    }
    setCreating(true);
    const res = await fetch("/api/admin/lieferant-users", {
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
    toast.success("Lieferanten-User angelegt — Setup-Mail wurde versendet");
    setShowCreate(false);
    setCreateForm({ email: "", full_name: "", lieferant_id: "" });
    load();
  }

  async function toggleActive(p: LieferantProfileRow) {
    const ok = await confirm({
      title: p.is_active ? "Lieferant deaktivieren?" : "Lieferant reaktivieren?",
      message: p.is_active
        ? `${p.full_name} kann sich nicht mehr ins Lieferantenportal einloggen. Bestehende Daten bleiben sichtbar.`
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
    toast.success(p.is_active ? "Lieferant deaktiviert" : "Lieferant reaktiviert");
    load();
  }

  async function resetPassword(p: LieferantProfileRow) {
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
    if (!edit.full_name.trim() || !edit.lieferant_id) {
      toast.error("Name und Firma sind Pflicht");
      return;
    }
    setSavingEdit(true);
    // Name + Firma atomar updaten. Name via /api/admin/users (server-side
    // weil das auch im auth-User-Metadata gespiegelt wird), Firma direkt
    // via PATCH auf profiles (RLS erlaubt admin).
    const [userRes, liefRes] = await Promise.all([
      fetch(`/api/admin/users/${edit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: edit.full_name.trim() }),
      }),
      supabase.from("profiles").update({ lieferant_id: edit.lieferant_id }).eq("id", edit.id),
    ]);
    const userJson = await userRes.json();
    setSavingEdit(false);
    if (!userJson.success) {
      TOAST.errorOr(userJson.error);
      return;
    }
    if (liefRes.error) {
      TOAST.supabaseError(liefRes.error, "Firma konnte nicht aktualisiert werden");
      return;
    }
    toast.success("Gespeichert");
    setEdit(null);
    load();
  }

  // Delete-Flow lebt in <DeleteUserConfirmModal /> — der Trash2-Button
  // oeffnet nur das Modal via setDeletingUser(p). Kein Dossier fuer
  // Lieferanten (kein Payroll-Kontext).

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold">Lieferanten-Benutzer</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Lieferanten mit Zugang zum Lieferantenportal. Pro Benutzer eine Lieferanten-Firma.
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
        <Card className="bg-card border-dashed">
          <CardContent className="py-12 text-center">
            <Truck className="h-7 w-7 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Noch keine Lieferanten-Benutzer.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {profiles.map((p) => (
            <Card key={p.id} className={`bg-card ${!p.is_active ? "opacity-60" : ""}`}>
              <CardContent className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-sm">{p.full_name}</p>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Truck className="h-3 w-3 shrink-0" />
                    {p.lieferant_name ?? "Keine Firma zugewiesen"}
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
                    onClick={() => setEdit({ id: p.id, full_name: p.full_name, lieferant_id: p.lieferant_id ?? "" })}
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

      {/* Edit-Modal — Name + Firma anpassen. */}
      <Modal open={!!edit} onClose={() => !savingEdit && setEdit(null)} title="Lieferanten-Benutzer bearbeiten" size="md">
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
              <p className="text-[10px] text-muted-foreground/70 ml-1">Lieferanten-Firma *</p>
              <SearchableSelect
                value={edit.lieferant_id}
                onChange={(id) => setEdit({ ...edit, lieferant_id: id })}
                items={lieferantItems}
                placeholder="Firma auswählen…"
                required
                clearable={false}
              />
            </div>
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={() => setEdit(null)} disabled={savingEdit} className="kasten kasten-muted flex-1">Abbrechen</button>
              <button type="submit" disabled={savingEdit || !edit.full_name.trim() || !edit.lieferant_id} className="kasten kasten-red flex-1">
                {savingEdit ? "Speichert…" : "Speichern"}
              </button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Neuer Lieferanten-Benutzer" closable={!creating}>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="text-xs font-medium">E-Mail *</label>
            <Input
              type="email"
              value={createForm.email}
              onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })}
              placeholder="lieferant@firma.ch"
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
            <label className="text-xs font-medium">Lieferanten-Firma *</label>
            <div className="mt-1">
              <SearchableSelect
                value={createForm.lieferant_id}
                onChange={(id) => setCreateForm({ ...createForm, lieferant_id: id })}
                items={lieferantItems}
                placeholder="Firma auswählen…"
                required
                clearable={false}
              />
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              Der Benutzer sieht im Portal nur diese eine Lieferanten-Firma.
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

      {/* Delete-Flow — Impact-basierte Bestaetigung (ohne Dossier bei Lieferanten). */}
      <DeleteUserConfirmModal
        open={!!deletingUser}
        onClose={() => setDeletingUser(null)}
        user={deletingUser ? { id: deletingUser.id, full_name: deletingUser.full_name, role: "Lieferant" } : null}
        onDeleted={() => { setDeletingUser(null); load(); }}
      />

      {ConfirmModalElement}
    </div>
  );
}
