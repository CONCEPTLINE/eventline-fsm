"use client";

/**
 * DeleteUserConfirmModal — Impact-basierte Delete-Bestaetigung.
 *
 * Zeigt VOR dem Loeschen eines Users genau was passiert:
 *   1. Unwiderruflich mitgeloescht (destructive_cascades) — pro Eintrag
 *      count + purpose. Ist die Cascade "transferierbar" (Vertriebs-Ordner),
 *      erscheint ein "Übertragen an anderen User"-Button, der ein
 *      Sub-Modal oeffnet.
 *   2. Bleibt erhalten (set_null_preservation) — Zeilen deren FK auf NULL
 *      geht; der Full-Name wird per DB-Trigger vorher in <col>_name
 *      gespiegelt (Migration 222). Nur informational.
 *
 * "Endgueltig loeschen" ist erst enabled, wenn keine destructive_cascades
 * (mehr) offen sind — also entweder von Anfang an clean, oder alle
 * transferierbaren wurden umgezogen und die nicht-transferierbaren sind
 * leer.
 *
 * withDossier=true (Team-Tab, EVENTLINE-Mitarbeiter): erzeugt vor dem
 * Delete ein ZIP-Dossier via /api/admin/users/{id}/dossier und bietet
 * es im Success-Toast zum Download an. Partner-Tab uebergibt das nicht,
 * da Partner keinen Payroll-Kontext haben.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { SearchableSelect } from "@/components/searchable-select";
import { Loader2, AlertTriangle, ArrowRightLeft, ShieldAlert, FileText } from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import { istIntern } from "@/lib/roles";

interface DestructiveCascade {
  table: string;
  purpose: string;
  count: number;
  transfer_possible: boolean;
}

interface SetNullPreservation {
  table: string;
  column: string;
  count: number;
}

interface ImpactResponse {
  success: boolean;
  user?: { id: string; full_name: string; role: string; is_active: boolean };
  destructive_cascades?: DestructiveCascade[];
  set_null_preservation?: SetNullPreservation[];
  can_delete_directly?: boolean;
  error?: string;
}

export interface DeleteUserConfirmModalProps {
  open: boolean;
  onClose: () => void;
  user: { id: string; full_name: string; role: string } | null;
  onDeleted: () => void;
  /** Nur Team-Tab: vor dem Delete ein Dossier-ZIP bauen und im
   *  Success-Toast als Download anbieten. Partner-Tab uebergibt es
   *  nicht. */
  withDossier?: boolean;
}

export function DeleteUserConfirmModal({
  open,
  onClose,
  user,
  onDeleted,
  withDossier = false,
}: DeleteUserConfirmModalProps) {
  const [loading, setLoading] = useState(false);
  const [impact, setImpact] = useState<ImpactResponse | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [transferFor, setTransferFor] = useState<DestructiveCascade | null>(null);
  const [transferredTables, setTransferredTables] = useState<Set<string>>(new Set());
  // Reviewer C3: Race-Guard. Wenn Admin schnell zwischen Users hin- und
  // her-oeffnet, kann eine stale Impact-Response vom vorherigen User die
  // Anzeige fuer den neuen ueberschreiben → falscher Impact-Bildschirm mit
  // aktivem Loeschen-Button. Wir tracken den currentUserId + AbortController
  // und ignorieren stale responses.
  const requestUserIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refetchImpact = useCallback(async () => {
    if (!user) return;
    // vorherige Anfrage abbrechen + neuen Kontext markieren
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const forUserId = user.id;
    requestUserIdRef.current = forUserId;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users/${user.id}/impact`, {
        cache: "no-store",
        signal: ctrl.signal,
      });
      const json: ImpactResponse = await res.json();
      // Stale-Check: falls Admin mid-fetch auf anderen User gewechselt hat,
      // die alte Response verwerfen.
      if (requestUserIdRef.current !== forUserId) return;
      if (!json.success) {
        TOAST.errorOr(json.error, "Impact-Analyse fehlgeschlagen");
        setImpact(null);
        return;
      }
      setImpact(json);
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      if (requestUserIdRef.current !== forUserId) return;
      toast.error("Impact-Analyse: " + (err instanceof Error ? err.message : "Netzwerkfehler"));
      setImpact(null);
    } finally {
      if (requestUserIdRef.current === forUserId) setLoading(false);
    }
  }, [user]);

  // Beim Oeffnen impact frisch laden. Bei jedem Neu-Oeffnen wird der
  // transferredTables-Guard resettet, sonst waere er stale, wenn der
  // Admin das Modal fuer einen anderen User oeffnet.
  useEffect(() => {
    if (open && user) {
      setTransferredTables(new Set());
      setImpact(null);
      refetchImpact();
    }
    return () => {
      // Beim Close: Impact-Fetch abbrechen, sonst rennt er noch weiter
      // und ueberschreibt evtl. den State fuer ein spaeteres Open.
      if (abortRef.current) abortRef.current.abort();
    };
  }, [open, user, refetchImpact]);

  // Ableitung: nach lokalen Transfers zeigen wir count aus dem letzten
  // /impact-Refetch — d.h. transferredTables ist eigentlich obsolete
  // sobald refetchImpact durchlief. Trotzdem als Sicherheitsnetz
  // (Race: refetch waehrend UI schon interaktiv) fuers Enable/Disable.
  const openDestructive = useMemo<DestructiveCascade[]>(() => {
    if (!impact?.destructive_cascades) return [];
    return impact.destructive_cascades.filter((c) => c.count > 0);
  }, [impact]);

  const canDelete = openDestructive.length === 0;

  async function handleDelete() {
    if (!user) return;
    if (!canDelete) return;
    // Reviewer C4: disabled greift erst nach Re-Render. Doppelklick im
    // selben Tick wuerde zweimal DELETE feuern → wir gaten hart auf
    // deleting-Flag.
    if (deleting) return;
    setDeleting(true);

    // Team-Tab-Pfad: Dossier VOR Delete. Failed die Dossier-Erstellung,
    // wird NICHT geloescht — sonst waere die einzige Kopie der Daten weg
    // ohne Backup.
    let dossierUrl: string | null = null;
    if (withDossier) {
      try {
        const dossierRes = await fetch(`/api/admin/users/${user.id}/dossier`, { method: "POST" });
        const dossierJson = await dossierRes.json();
        if (!dossierJson.success) {
          setDeleting(false);
          TOAST.errorOr(
            dossierJson.error,
            "Dossier konnte nicht erstellt werden — Benutzer NICHT gelöscht",
          );
          return;
        }
        dossierUrl = dossierJson.download_url ?? null;
      } catch (err) {
        setDeleting(false);
        toast.error(
          "Dossier-Fehler: " +
            (err instanceof Error ? err.message : "Netzwerk") +
            " — Benutzer NICHT gelöscht",
        );
        return;
      }
    }

    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) {
        setDeleting(false);
        TOAST.errorOr(json.error);
        return;
      }
    } catch (err) {
      setDeleting(false);
      toast.error("Delete-Fehler: " + (err instanceof Error ? err.message : "Netzwerk"));
      return;
    }

    setDeleting(false);

    if (dossierUrl) {
      toast.success(`${user.full_name} gelöscht — Dossier verfügbar`, {
        action: {
          label: "Download",
          onClick: () => {
            const a = document.createElement("a");
            a.href = dossierUrl!;
            a.download = `dossier_${user.full_name}.zip`;
            a.target = "_blank";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
          },
        },
        duration: 60000,
      });
    } else {
      toast.success(`${user.full_name} endgültig gelöscht`);
    }

    onDeleted();
    onClose();
  }

  return (
    <>
      <Modal
        open={open && !transferFor}
        onClose={() => {
          if (!deleting && !loading) onClose();
        }}
        title="Benutzer endgültig löschen"
        icon={<ShieldAlert className="h-5 w-5 text-red-500" />}
        size="lg"
        closable={!deleting}
      >
        {user && (
          <div className="space-y-4">
            {/* User-Kopf */}
            <div className="rounded-xl border border-border bg-card px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-sm font-bold shrink-0">
                  {user.full_name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-sm truncate">{user.full_name}</p>
                  <p className="text-[11px] text-muted-foreground">Rolle: {user.role}</p>
                </div>
              </div>
            </div>

            {loading && !impact ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Auswirkungen werden analysiert…
              </div>
            ) : !impact ? (
              <div className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
                Impact konnte nicht geladen werden.
              </div>
            ) : (
              <>
                {/* Section 1: Unwiderruflich */}
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-red-500 shrink-0" />
                    <h3 className="text-sm font-semibold">
                      Wird UNWIDERRUFLICH gelöscht
                    </h3>
                  </div>
                  {openDestructive.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border bg-card px-3 py-2.5 text-[12px] text-muted-foreground">
                      Nichts. Der User hat keine cascadierenden Daten (oder alle
                      wurden übertragen).
                    </div>
                  ) : (
                    <ul className="rounded-xl border border-red-200 dark:border-red-500/30 bg-red-50/50 dark:bg-red-500/[0.06] divide-y divide-red-200/60 dark:divide-red-500/20 overflow-hidden">
                      {openDestructive.map((c) => (
                        <li key={c.table} className="px-3 py-2.5 flex items-start gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="inline-flex items-center rounded-full bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300 text-[10px] font-semibold px-2 py-0.5 shrink-0">
                                {c.count} ×
                              </span>
                              <span className="text-[11px] font-mono text-muted-foreground shrink-0">
                                {c.table}
                              </span>
                            </div>
                            <p className="text-[12px] text-foreground/80 mt-1 leading-snug">
                              {c.purpose}
                            </p>
                          </div>
                          {c.transfer_possible && (
                            <button
                              type="button"
                              onClick={() => setTransferFor(c)}
                              disabled={deleting}
                              className="kasten kasten-blue shrink-0"
                              data-tooltip="An anderen User übertragen (verhindert Datenverlust)"
                            >
                              <ArrowRightLeft className="h-3.5 w-3.5" />
                              Übertragen
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Section 2: Bleibt erhalten (SET NULL, name preserved) */}
                <section className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-amber-500 shrink-0" />
                    <h3 className="text-sm font-semibold">
                      Bleibt erhalten (Name wird zu Freitext)
                    </h3>
                  </div>
                  {(impact.set_null_preservation ?? []).length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border bg-card px-3 py-2.5 text-[12px] text-muted-foreground">
                      Keine referenzierten Datensätze.
                    </div>
                  ) : (
                    <div className="rounded-xl border border-border bg-card overflow-hidden">
                      <ul className="max-h-48 overflow-y-auto divide-y divide-border/60">
                        {(impact.set_null_preservation ?? []).map((s) => (
                          <li
                            key={`${s.table}.${s.column}`}
                            className="px-3 py-1.5 flex items-center gap-3"
                          >
                            <span className="inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 text-[10px] font-semibold px-2 py-0.5 shrink-0">
                              {s.count} ×
                            </span>
                            <span className="text-[11px] font-mono text-muted-foreground truncate flex-1">
                              {s.table}
                              <span className="text-foreground/40">.{s.column}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="px-3 py-1.5 border-t border-border bg-foreground/[0.02] dark:bg-foreground/[0.05] text-[10.5px] text-muted-foreground leading-snug">
                        Der Name „{user.full_name}" wird vor dem Delete in die jeweilige
                        <span className="font-mono"> _name</span>-Spalte gespiegelt und
                        bleibt in der Historie sichtbar.
                      </div>
                    </div>
                  )}
                </section>
              </>
            )}

            {/* Bottom-Bar */}
            <div className="flex gap-2 pt-2 border-t border-border">
              <button
                type="button"
                onClick={onClose}
                disabled={deleting}
                className="kasten kasten-muted flex-1"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting || loading || !impact || !canDelete}
                className="kasten kasten-red flex-1"
                data-tooltip={
                  !canDelete
                    ? "Zuerst alle unwiderruflichen Cascades klären (übertragen oder akzeptieren)"
                    : undefined
                }
              >
                {deleting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {withDossier ? "Dossier + löschen…" : "Wird gelöscht…"}
                  </>
                ) : (
                  <>Endgültig löschen</>
                )}
              </button>
            </div>
            {!canDelete && !loading && impact && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-snug -mt-1">
                {(() => {
                  const notTransferable = openDestructive.filter((c) => !c.transfer_possible);
                  if (notTransferable.length > 0) {
                    return (
                      <>
                        Es gibt {notTransferable.length} nicht-übertragbare Cascade(s)
                        ({notTransferable.map((c) => c.table).join(", ")}). Diese Daten
                        gehen zwangsläufig verloren — falls das ok ist, kann der User
                        nicht direkt gelöscht werden, ohne diese Daten vorher manuell zu
                        bereinigen.
                      </>
                    );
                  }
                  return (
                    <>
                      Bitte alle übertragbaren Ordner an einen anderen User übertragen,
                      dann wird „Endgültig löschen" freigeschaltet.
                    </>
                  );
                })()}
              </p>
            )}
          </div>
        )}
      </Modal>

      {/* Sub-Modal: Transfer */}
      <TransferSubModal
        open={!!transferFor}
        onClose={() => setTransferFor(null)}
        userId={user?.id ?? null}
        cascade={transferFor}
        onTransferred={async (table) => {
          setTransferredTables((prev) => new Set(prev).add(table));
          setTransferFor(null);
          // Nach dem Transfer /impact neu fetchen, damit die Counts und
          // damit auch canDelete wieder stimmen.
          await refetchImpact();
        }}
      />
    </>
  );
}

// -----------------------------------------------------------------------------
// Sub-Modal: Transfer der Owner-Bindung an einen anderen aktiven User.
// -----------------------------------------------------------------------------

interface TransferSubModalProps {
  open: boolean;
  onClose: () => void;
  userId: string | null;
  cascade: DestructiveCascade | null;
  onTransferred: (table: string) => void | Promise<void>;
}

function TransferSubModal({ open, onClose, userId, cascade, onTransferred }: TransferSubModalProps) {
  const supabase = createClient();
  const [candidates, setCandidates] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(false);
  const [newOwnerId, setNewOwnerId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open || !userId) return;
    setNewOwnerId("");
    setLoading(true);
    (async () => {
      try {
        // Alle aktiven Profiles (ausser dem zu loeschenden). Nutzt die
        // admin-RPC damit RLS nicht die Sicht limitiert.
        const { data, error } = await supabase.rpc("get_all_profiles_admin");
        if (error) {
          TOAST.supabaseError(error, "Kandidaten konnten nicht geladen werden");
          setCandidates([]);
          return;
        }
        const all = (data as Profile[]) ?? [];
        setCandidates(
          all.filter((p) => p.is_active && p.id !== userId && istIntern(p.role)),
        );
      } finally {
        setLoading(false);
      }
    })();
  }, [open, userId, supabase]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!userId || !cascade || !newOwnerId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/users/${userId}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transfers: [{ table: cascade.table, new_owner_id: newOwnerId }],
        }),
      });
      const json = await res.json();
      if (!json.success) {
        TOAST.errorOr(json.error, "Transfer fehlgeschlagen");
        return;
      }
      const moved = (json.transferred ?? []).reduce(
        (acc: number, t: { count?: number }) => acc + (t.count ?? 0),
        0,
      );
      toast.success(`Übertragen: ${moved} Eintrag / Einträge (${cascade.table})`);
      await onTransferred(cascade.table);
    } catch (err) {
      toast.error("Transfer-Fehler: " + (err instanceof Error ? err.message : "Netzwerk"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!submitting) onClose();
      }}
      title="An anderen User übertragen"
      icon={<ArrowRightLeft className="h-5 w-5 text-blue-500" />}
      size="md"
      closable={!submitting}
    >
      {cascade && (
        <form onSubmit={submit} className="space-y-4">
          <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-[12px] text-foreground/80 leading-snug">
            <p>
              <span className="inline-flex items-center rounded-full bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-300 text-[10px] font-semibold px-2 py-0.5 mr-2">
                {cascade.count} ×
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {cascade.table}
              </span>
            </p>
            <p className="mt-1.5 text-[11.5px] text-muted-foreground">{cascade.purpose}</p>
          </div>

          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground/70 ml-1">
              Neuer Owner *
            </p>
            {loading ? (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Kandidaten werden geladen…
              </div>
            ) : (
              <SearchableSelect
                value={newOwnerId}
                onChange={setNewOwnerId}
                items={candidates.map((c) => ({
                  id: c.id,
                  label: c.full_name,
                  sub: c.role,
                }))}
                placeholder={
                  candidates.length === 0
                    ? "Keine aktiven Kandidaten verfügbar"
                    : "User wählen…"
                }
                required
                clearable={false}
              />
            )}
            <p className="text-[10px] text-muted-foreground/70 ml-1 mt-1">
              Nur aktive Mitarbeiter (ohne Partner). Deaktivierte User können nicht
              Owner werden.
            </p>
          </div>

          <div className="flex gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="kasten kasten-muted flex-1"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={submitting || loading || !newOwnerId}
              className="kasten kasten-green flex-1"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Übertragen…
                </>
              ) : (
                <>
                  <ArrowRightLeft className="h-3.5 w-3.5" />
                  Übertragen
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
