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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { DeleteUserConfirmModal } from "@/components/einstellungen/delete-user-confirm-modal";
import { Plus, Truck, KeyRound, Pencil, UserX, UserCheck, Trash2, BookOpen, Eye, Upload, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { validateFileSize, MAX_UPLOAD_SIZE_MB } from "@/lib/file-upload";

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

      <KatalogeCard />

      {ConfirmModalElement}
    </div>
  );
}

/* ============================================================
   KATALOGE — Mietkatalog-PDF pro Lieferanten-Firma. Der Lieferant
   sieht seinen Katalog im Portal-Tab "Katalog" (signed URL via
   /api/lieferant/katalog). Hochladen/Ersetzen/Entfernen: Admin.
   ============================================================ */

type KatalogRow = {
  id: string;
  name: string;
  katalog_path: string | null;
  katalog_name: string | null;
  katalog_updated_at: string | null;
};

function KatalogeCard() {
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement: KatalogConfirmElement } = useConfirm();
  const [rows, setRows] = useState<KatalogRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [artikelCount, setArtikelCount] = useState<Record<string, number>>({});
  /** Laufender KI-Import: Firma-ID + Fortschrittstext (Seiten x–y von n). */
  const [importId, setImportId] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadKataloge = useCallback(async () => {
    const [liefRes, artRes] = await Promise.all([
      supabase
        .from("lieferanten")
        .select("id, name, katalog_path, katalog_name, katalog_updated_at")
        .eq("is_active", true)
        .order("name"),
      supabase.from("lieferant_katalog_artikel").select("lieferant_id").eq("is_active", true),
    ]);
    if (liefRes.error) {
      TOAST.supabaseError(liefRes.error, "Kataloge konnten nicht geladen werden");
      setRows([]);
      return;
    }
    const counts: Record<string, number> = {};
    for (const a of (artRes.data ?? []) as { lieferant_id: string }[]) {
      counts[a.lieferant_id] = (counts[a.lieferant_id] ?? 0) + 1;
    }
    setArtikelCount(counts);
    setRows((liefRes.data ?? []) as KatalogRow[]);
  }, [supabase]);

  /** Chunk-Schleife: 8 Seiten pro KI-Aufruf, Fortschritt live, erster
   *  Chunk ersetzt die bisherigen KI-Artikel (Route macht das). */
  async function kiImport(row: KatalogRow) {
    const ok = await confirm({
      title: "Katalog mit KI einlesen?",
      message: `Die KI liest das PDF von ${row.name} Seite für Seite ein und baut daraus die Artikel-Liste. Bestehende KI-Artikel werden ersetzt. Das dauert einige Minuten.`,
      confirmLabel: "Einlesen",
      variant: "red",
    });
    if (!ok) return;
    setImportId(row.id);
    setImportText("Startet…");
    const CHUNK = 8;
    let from = 1;
    let letzteKategorie: string | null = null;
    let inserted = 0;
    try {
      type ImportChunkResponse = {
        success?: boolean; error?: string; done?: boolean; inserted?: number;
        total_pages?: number; next_page?: number | null; letzte_kategorie?: string | null;
      };
      for (let guard = 0; guard < 60; guard++) {
        const res: Response = await fetch("/api/ai/katalog-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lieferant_id: row.id, from_page: from, to_page: from + CHUNK - 1, letzte_kategorie: letzteKategorie }),
        });
        const j: ImportChunkResponse = await res.json();
        if (!res.ok || !j.success) throw new Error(j.error ?? "Import fehlgeschlagen");
        inserted += j.inserted ?? 0;
        if (j.done) {
          toast.success(`Katalog eingelesen: ${inserted} Artikel`);
          break;
        }
        letzteKategorie = j.letzte_kategorie ?? letzteKategorie;
        if (typeof j.next_page !== "number") throw new Error("Unerwartete Antwort vom Import");
        from = j.next_page;
        const totalPages = j.total_pages ?? from;
        setImportText(`Seite ${from}–${Math.min(from + CHUNK - 1, totalPages)} von ${totalPages} · bisher ${inserted} Artikel`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import fehlgeschlagen");
    } finally {
      setImportId(null);
      setImportText("");
      loadKataloge();
    }
  }

  useEffect(() => { loadKataloge(); }, [loadKataloge]);

  async function upload(row: KatalogRow, file: File) {
    if (file.type !== "application/pdf") { toast.error("Bitte ein PDF wählen"); return; }
    if (!validateFileSize(file)) return;
    setBusyId(row.id);
    const path = `lieferanten/${row.id}/katalog_${Date.now()}.pdf`;
    const { error: upErr } = await supabase.storage
      .from("documents")
      .upload(path, file, { contentType: "application/pdf" });
    if (upErr) {
      setBusyId(null);
      TOAST.supabaseError(upErr, "Upload fehlgeschlagen");
      return;
    }
    const { error: dbErr } = await supabase
      .from("lieferanten")
      .update({ katalog_path: path, katalog_name: file.name, katalog_updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (dbErr) {
      // DB scheiterte — hochgeladene Datei wieder aufraeumen.
      await supabase.storage.from("documents").remove([path]);
      setBusyId(null);
      TOAST.supabaseError(dbErr, "Katalog konnte nicht gespeichert werden");
      return;
    }
    // Alte Datei ersetzen: erst nach erfolgreichem Umhaengen loeschen.
    if (row.katalog_path) await supabase.storage.from("documents").remove([row.katalog_path]);
    setBusyId(null);
    toast.success(`Katalog für ${row.name} hinterlegt`);
    loadKataloge();
  }

  async function entfernen(row: KatalogRow) {
    const ok = await confirm({
      title: "Katalog entfernen?",
      message: `Der Katalog von ${row.name} wird aus dem Portal entfernt.`,
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok || !row.katalog_path) return;
    setBusyId(row.id);
    const { error } = await supabase
      .from("lieferanten")
      .update({ katalog_path: null, katalog_name: null, katalog_updated_at: null })
      .eq("id", row.id);
    if (error) {
      setBusyId(null);
      TOAST.supabaseError(error, "Entfernen fehlgeschlagen");
      return;
    }
    await supabase.storage.from("documents").remove([row.katalog_path]);
    setBusyId(null);
    toast.success("Katalog entfernt");
    loadKataloge();
  }

  async function vorschau(row: KatalogRow) {
    const res = await fetch(`/api/lieferant/katalog?lieferant_id=${row.id}`);
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.success || !j.url) { toast.error("Vorschau nicht verfügbar"); return; }
    window.open(j.url, "_blank", "noopener");
  }

  return (
    <Card className="bg-card">
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-1">
          <BookOpen className="h-4 w-4 text-muted-foreground" /> Kataloge
        </h3>
        <p className="text-[11px] text-muted-foreground mb-3">
          Mietkatalog-PDF pro Firma — erscheint im Lieferantenportal unter «Katalog» (max. {MAX_UPLOAD_SIZE_MB} MB).
        </p>
        {rows === null ? (
          <div className="py-4 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Laden…</div>
        ) : rows.length === 0 ? (
          <p className="py-3 text-center text-sm text-muted-foreground">Keine aktiven Lieferanten.</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="py-2 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{r.name}</p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {importId === r.id
                      ? `KI liest ein — ${importText}`
                      : r.katalog_path
                        ? `${r.katalog_name ?? "Katalog.pdf"}${r.katalog_updated_at ? " · Stand " + new Date(r.katalog_updated_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" }) : ""} · ${artikelCount[r.id] ?? 0} Artikel im System`
                        : "Kein Katalog hinterlegt"}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {busyId === r.id || importId === r.id ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <>
                      {r.katalog_path && (
                        <button type="button" onClick={() => vorschau(r)} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]" data-tooltip="Ansehen">
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button type="button" onClick={() => fileRefs.current[r.id]?.click()} className="kasten kasten-muted">
                        <Upload className="h-3.5 w-3.5" /> {r.katalog_path ? "Ersetzen" : "Hochladen"}
                      </button>
                      {r.katalog_path && (
                        <button type="button" onClick={() => kiImport(r)} disabled={importId !== null} className="kasten kasten-red" data-tooltip="PDF mit KI in Artikel-Daten umwandeln" data-tooltip-side="bottom">
                          <Sparkles className="h-3.5 w-3.5" /> Mit KI einlesen
                        </button>
                      )}
                      {r.katalog_path && (
                        <button type="button" onClick={() => entfernen(r)} className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-500/10" data-tooltip="Entfernen">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </>
                  )}
                  <input
                    ref={(el) => { fileRefs.current[r.id] = el; }}
                    type="file"
                    accept="application/pdf"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(r, f); e.target.value = ""; }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      {KatalogConfirmElement}
    </Card>
  );
}
