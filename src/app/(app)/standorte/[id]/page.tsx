"use client";

/**
 * Location-Detail (Typ Verwaltung) — Sticky-Header + 3-Tab-Layout.
 * Route /standorte/[id] bleibt; im UI heisst es «Location» (Oberbegriff).
 *
 * Struktur:
 *  - Sticky-Header oben: BackButton, Name/Adresse, Kunde-Chip rechts,
 *    Rentabilitaet-Button (Admin), Tab-Nav (Uebersicht | Notizen & Dokumente |
 *    Verrechnung & Kunde). → tabs/sticky-header.tsx
 *  - Body: EIN Tab sichtbar.
 *  - Tab «Verrechnung & Kunde» (Verrechnungssaetze + Kunden-Verknuepfung) ist
 *    Admin-only und wird fuer Non-Admins nicht einmal in die Tab-Liste
 *    aufgenommen.
 *
 * Tab-State lebt in der URL (?tab=uebersicht|notizen|verrechnung), damit
 * ein Reload den gewuenschten Tab beibehaelt (§10 CLAUDE.md). Alter
 * Schluessel ?tab=einstellungen wird weiter angenommen.
 *
 * Alle Datenladung + Mutationen leben in `use-standort-data.ts`, damit
 * page.tsx unter 100 LOC bleibt.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Info, StickyNote, Settings } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Loading } from "@/components/ui/spinner";
import { Modal } from "@/components/ui/modal";
import { useConfirm } from "@/components/ui/use-confirm";
import { usePermissions } from "@/lib/use-permissions";
import { useIsMobile } from "@/lib/use-is-mobile";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import { TOAST } from "@/lib/messages";
import { standortArchiviert } from "@/lib/archiv";
import { formatDateFull } from "@/lib/format";
import { ArchivHinweis } from "@/components/ui/archiv-hinweis";

import { StandortStickyHeader, type StandortTabKey } from "@/components/standort/tabs/sticky-header";
import { OverviewTab } from "@/components/standort/tabs/overview-tab";
import { PlanUnterlageSection } from "@/components/standort/plan-unterlage-section";
import { NotesDocsTab } from "@/components/standort/tabs/notes-docs-tab";
import { SettingsTab } from "@/components/standort/tabs/settings-tab";
import { useStandortData } from "@/components/standort/tabs/use-standort-data";

export default function StandortDetailPage() {
  const { id } = useParams();
  const locationId = id as string;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, profile, ready: permsReady } = usePermissions();
  const isAdmin = profile?.role === "admin";
  const canArchive = can("locations:archive");
  const supabase = useMemo(() => createClient(), []);
  const { confirm, ConfirmModalElement } = useConfirm();

  // Archiv-Flow — gleiches Prinzip wie das Auftrag-Stornieren:
  // Phase 'confirm' -> 'reason' (Pflicht-Grund), reversibel.
  const [archivePhase, setArchivePhase] = useState<"closed" | "confirm" | "reason">("closed");
  const [archiveReason, setArchiveReason] = useState("");
  const [archiveSaving, setArchiveSaving] = useState(false);

  const {
    location,
    loadAll,
    contacts,
    docs,
    notes,
    customers,
    linkedCustomer,
    addNote,
    deleteNote,
    togglePinNote,
    updateNote,
    uploadDoc,
    deleteDoc,
    moveDoc,
    getDocSignedUrl,
    createContact,
    deleteContact,
    linkCustomer,
  } = useStandortData(locationId);

  // Gepinnte Notizen fuer den Uebersichts-Tab. Sortierung: nach
  // Erstell-Datum absteigend, damit die aktuellsten zuerst kommen.
  // Mobiler Kopf zeigt den Namen der Location statt «Locations» (er liest den
  // letzten Crumb). Nur am Handy setzen: am Desktop wuerden die Crumbs sonst
  // als zusaetzliche Breadcrumb-Zeile ueber der Seite erscheinen.
  const istHandy = useIsMobile();
  useBreadcrumbs(
    istHandy && location
      ? [{ label: "Locations", href: "/locations" }, { label: location.name }]
      : [],
  );

  const pinnedNotes = useMemo(
    () => notes
      .filter((n) => n.pinned)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    [notes],
  );

  // ─── Tab-Auswahl (URL-State + Rollen-Default) ──────────────────
  // Rollen-Default: alle User landen zunaechst auf "Uebersicht" (auch Admins).
  // Non-Admins sehen den "verrechnung"-Tab gar nicht — landet doch mal
  // jemand via manueller URL dort, fangen wir es unten ab.
  // Alias: ?tab=einstellungen (Name vor der Umbenennung) → verrechnung.
  const rawTab = searchParams.get("tab");
  const urlTab = (rawTab === "einstellungen" ? "verrechnung" : rawTab) as StandortTabKey | null;
  const isValidTab =
    urlTab === "uebersicht" ||
    urlTab === "notizen" ||
    (urlTab === "verrechnung" && isAdmin);

  const activeTab: StandortTabKey = isValidTab ? (urlTab as StandortTabKey) : "uebersicht";

  useEffect(() => {
    if (!permsReady || isValidTab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "uebersicht");
    router.replace(`/standorte/${locationId}?${params.toString()}`, { scroll: false });
  }, [permsReady, isValidTab, locationId, router, searchParams]);

  async function confirmArchive() {
    if (!archiveReason.trim()) {
      toast.error("Bitte einen Grund angeben");
      return;
    }
    setArchiveSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    // is_active=false spiegeln: alle Auswahllisten der App filtern darauf
    // — die Location verschwindet damit app-weit aus den Dropdowns.
    const { error } = await supabase
      .from("locations")
      .update({
        archived_at: new Date().toISOString(),
        archived_by: user?.id ?? null,
        archived_reason: archiveReason.trim(),
        is_active: false,
      })
      .eq("id", locationId);
    setArchiveSaving(false);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    setArchivePhase("closed");
    setArchiveReason("");
    toast.success("Location archiviert");
    loadAll();
  }

  async function reactivate() {
    const ok = await confirm({
      title: "Location reaktivieren?",
      message: `«${location?.name}» wird wieder aktiv und erscheint erneut in allen Listen.`,
      confirmLabel: "Reaktivieren",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("locations")
      .update({ archived_at: null, archived_by: null, archived_reason: null, is_active: true })
      .eq("id", locationId);
    if (error) {
      TOAST.supabaseError(error);
      return;
    }
    toast.success("Location reaktiviert");
    loadAll();
  }

  function selectTab(next: StandortTabKey) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/standorte/${locationId}?${params.toString()}`, { scroll: false });
  }

  const tabs = useMemo(() => {
    const base: { key: StandortTabKey; label: string; icon: React.ReactNode }[] = [
      { key: "uebersicht", label: "Übersicht", icon: <Info className="h-4 w-4 max-md:hidden" /> },
      { key: "notizen", label: "Notizen & Dokumente", icon: <StickyNote className="h-4 w-4 max-md:hidden" /> },
    ];
    if (isAdmin) {
      base.push({ key: "verrechnung", label: "Verrechnung & Kunde", icon: <Settings className="h-4 w-4 max-md:hidden" /> });
    }
    return base;
  }, [isAdmin]);

  if (!location) return <Loading className="py-20" label="Laden…" />;

  // Archiv = nur lesen (src/lib/archiv.ts): archivierte Locations zeigen alles,
  // aber kein Reiter bietet Bearbeiten an — einziger Weg: «Reaktivieren» im
  // Kopf (locations:archive). Die DB sperrt zusaetzlich (Migration 342).
  const nurLesen = standortArchiviert(location);
  const canEdit = can("locations:edit") && !nurLesen;

  return (
    <div className="max-w-5xl mx-auto page-enter">
      <StandortStickyHeader
        location={location}
        linkedCustomer={linkedCustomer}
        isAdmin={isAdmin}
        canArchive={canArchive}
        onArchive={() => setArchivePhase("confirm")}
        onReactivate={reactivate}
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={selectTab}
        onOpenCustomerLink={() => selectTab("verrechnung")}
      />

      {nurLesen && (
        <ArchivHinweis
          className="-mt-4 mb-4 max-md:mt-0"
          vermerk={location.archived_at ? `seit ${formatDateFull(location.archived_at)}` : null}
          begruendung={location.archived_reason}
        />
      )}

      {activeTab === "uebersicht" && (
        <>
          <OverviewTab
            contacts={contacts}
            pinnedNotes={pinnedNotes}
            canEdit={canEdit}
            onGoToNotesTab={() => selectTab("notizen")}
            onUnpinNote={togglePinNote}
            onCreateContact={createContact}
            onDeleteContact={deleteContact}
          />
          {/* Plan-Unterlage (massstaeblicher Saalplan fuer die 2D-Planung
              im Auftrag-Tab "Material & Plan") — lokal, noch nicht gepusht */}
          <div className="mt-4">
            <PlanUnterlageSection locationId={locationId} canEdit={canEdit} />
          </div>
        </>
      )}
      {activeTab === "notizen" && (
        <NotesDocsTab
          notes={notes}
          docs={docs}
          canEdit={canEdit}
          onAddNote={addNote}
          onDeleteNote={deleteNote}
          onTogglePinNote={togglePinNote}
          onUpdateNote={updateNote}
          onUploadDoc={uploadDoc}
          onDeleteDoc={deleteDoc}
          onMoveDoc={moveDoc}
          onGetDocSignedUrl={getDocSignedUrl}
        />
      )}
      {activeTab === "verrechnung" && isAdmin && (
        <SettingsTab
          locationId={locationId}
          linkedCustomer={linkedCustomer}
          customers={customers}
          onLinkCustomer={linkCustomer}
          nurLesen={nurLesen}
        />
      )}

      {/* Archivieren-Flow: Phase 'confirm' -> 'reason' (wie Auftrag-Storno) */}
      <Modal
        open={archivePhase !== "closed"}
        onClose={() => { if (!archiveSaving) { setArchivePhase("closed"); setArchiveReason(""); } }}
        title={archivePhase === "confirm" ? "Location archivieren?" : "Grund angeben"}
        closable={!archiveSaving}
      >
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">&quot;{location.name}&quot;</span>
        </p>
        {archivePhase === "confirm" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Die Location wird ins Archiv verschoben und verschwindet aus allen Auswahllisten.
              Aufträge und Dokumente bleiben erhalten; sie kann jederzeit reaktiviert werden.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setArchivePhase("closed")}
                className="kasten kasten-muted flex-1"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={() => setArchivePhase("reason")}
                className="kasten kasten-archive flex-1"
              >
                Archivieren
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Bitte gib einen Grund an, warum diese Location archiviert wird.
            </p>
            <textarea
              placeholder="z.B. Zusammenarbeit beendet, Location geschlossen…"
              value={archiveReason}
              onChange={(e) => setArchiveReason(e.target.value)}
              rows={3}
              autoFocus
              className="w-full px-3 py-2 text-sm rounded-xl border bg-background resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setArchivePhase("confirm")}
                disabled={archiveSaving}
                className="kasten kasten-muted flex-1"
              >
                Zurück
              </button>
              <button
                type="button"
                onClick={confirmArchive}
                disabled={archiveSaving || !archiveReason.trim()}
                className="kasten kasten-archive flex-1"
              >
                {archiveSaving ? "Archiviere…" : "Bestätigen"}
              </button>
            </div>
          </>
        )}
      </Modal>
      {ConfirmModalElement}
    </div>
  );
}
