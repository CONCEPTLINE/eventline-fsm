"use client";

/**
 * Standort-Detail — Sticky-Header + 3-Tab-Layout.
 *
 * Struktur:
 *  - Sticky-Header oben: BackButton, Name/Adresse, Kunde-Chip rechts,
 *    Rapport-Button (Admin), Tab-Nav (Uebersicht | Notizen & Dokumente |
 *    Einstellungen). → tabs/sticky-header.tsx
 *  - Body: EIN Tab sichtbar.
 *  - Einstellungen-Tab ist Admin-only und wird fuer Non-Admins nicht
 *    einmal in die Tab-Liste aufgenommen.
 *
 * Tab-State lebt in der URL (?tab=uebersicht|notizen|einstellungen), damit
 * ein Reload den gewuenschten Tab beibehaelt (§10 CLAUDE.md).
 *
 * Alle Datenladung + Mutationen leben in `use-standort-data.ts`, damit
 * page.tsx unter 100 LOC bleibt.
 */

import { useEffect, useMemo } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Info, StickyNote, Settings } from "lucide-react";
import { Loading } from "@/components/ui/spinner";
import { usePermissions } from "@/lib/use-permissions";

import { StandortStickyHeader, type StandortTabKey } from "@/components/standort/tabs/sticky-header";
import { OverviewTab } from "@/components/standort/tabs/overview-tab";
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
  const canEdit = can("locations:edit");

  const {
    location,
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
  const pinnedNotes = useMemo(
    () => notes
      .filter((n) => n.pinned)
      .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")),
    [notes],
  );

  // ─── Tab-Auswahl (URL-State + Rollen-Default) ──────────────────
  // Rollen-Default: alle User landen zunaechst auf "Uebersicht" (auch Admins).
  // Non-Admins sehen den "einstellungen"-Tab gar nicht — landet doch mal
  // jemand via manueller URL dort, fangen wir es unten ab.
  const urlTab = searchParams.get("tab") as StandortTabKey | null;
  const isValidTab =
    urlTab === "uebersicht" ||
    urlTab === "notizen" ||
    (urlTab === "einstellungen" && isAdmin);

  const activeTab: StandortTabKey = isValidTab ? (urlTab as StandortTabKey) : "uebersicht";

  useEffect(() => {
    if (!permsReady || isValidTab) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "uebersicht");
    router.replace(`/standorte/${locationId}?${params.toString()}`, { scroll: false });
  }, [permsReady, isValidTab, locationId, router, searchParams]);

  function selectTab(next: StandortTabKey) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`/standorte/${locationId}?${params.toString()}`, { scroll: false });
  }

  const tabs = useMemo(() => {
    const base: { key: StandortTabKey; label: string; icon: React.ReactNode }[] = [
      { key: "uebersicht", label: "Übersicht", icon: <Info className="h-4 w-4" /> },
      { key: "notizen", label: "Notizen & Dokumente", icon: <StickyNote className="h-4 w-4" /> },
    ];
    if (isAdmin) {
      base.push({ key: "einstellungen", label: "Einstellungen", icon: <Settings className="h-4 w-4" /> });
    }
    return base;
  }, [isAdmin]);

  if (!location) return <Loading className="py-20" label="Laden…" />;

  return (
    <div className="max-w-3xl mx-auto page-enter">
      <StandortStickyHeader
        location={location}
        linkedCustomer={linkedCustomer}
        isAdmin={isAdmin}
        tabs={tabs}
        activeTab={activeTab}
        onSelectTab={selectTab}
        onOpenCustomerLink={() => selectTab("einstellungen")}
      />

      {activeTab === "uebersicht" && (
        <OverviewTab
          contacts={contacts}
          pinnedNotes={pinnedNotes}
          canEdit={canEdit}
          onGoToNotesTab={() => selectTab("notizen")}
          onUnpinNote={togglePinNote}
          onCreateContact={createContact}
          onDeleteContact={deleteContact}
        />
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
      {activeTab === "einstellungen" && isAdmin && (
        <SettingsTab
          locationId={locationId}
          linkedCustomer={linkedCustomer}
          customers={customers}
          onLinkCustomer={linkCustomer}
        />
      )}
    </div>
  );
}
