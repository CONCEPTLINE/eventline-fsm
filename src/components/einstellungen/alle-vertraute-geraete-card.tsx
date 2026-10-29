"use client";

/**
 * Admin-Sicht: alle vertrauten Geraete aller User. Wird in Sicherheit
 * › Geräte gerendert. Admin kann jedes Geraet revoken (Security-
 * Audit-Pfad: wenn jemand seine Devices nicht selber aufraeumt).
 *
 * Lohn-Umbau Phase 1: Offene Anfragen anderer Personen hier direkt
 * freigeben/ablehnen (POST /api/trust/freigabe — der Server prueft, ob man
 * darf: anderer Admin oder Vertretung, vertrautes Geraet, < 24 h). Darueber
 * die Vertretung fuer Geraetefreigabe und Vier Augen
 * (/api/hr/lohn-einstellungen).
 *
 * Datenquelle: /api/trust/devices?all=true (Admin-only Endpoint).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, ShieldCheck, CheckCircle2, Clock, Trash2, Loader2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "@/components/ui/use-confirm";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchableSelect, type SelectItem } from "@/components/searchable-select";
import { createClient } from "@/lib/supabase/client";
import { istIntern } from "@/lib/roles";
import { formatDateFull, formatDateTimeFull } from "@/lib/format";
import { anfrageAbgelaufen, anfrageGueltigBis } from "@/lib/geraete-freigabe";
import { rechteAntraegeHref } from "@/lib/antraege-links";

type FreigabeArt = "mail_link" | "admin" | "vertretung" | "notweg";

interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  user_agent_hint: string | null;
  status: "pending" | "approved" | "revoked";
  requested_at: string;
  approved_at: string | null;
  approved_by_name: string | null;
  freigabe_art: FreigabeArt | null;
  anfrage_gueltig_bis: string | null;
  last_seen_at: string;
  expires_at: string;
  profiles: { full_name: string; email: string } | null;
  /** Client-seitig beim Laden berechnet: offene Anfrage älter als 24 h. */
  abgelaufen: boolean;
}

type Aktion = "freigeben" | "ablehnen";

const ART_LABEL: Record<FreigabeArt, string> = {
  admin: "Admin",
  vertretung: "Vertretung",
  notweg: "Notweg",
  mail_link: "alter Mail-Link",
};

/** «freigegeben von X (Admin) am 28.10.2026» — dezent unter dem Gerät. */
function freigabeText(d: DeviceRow): string | null {
  if (d.status !== "approved") return null;
  const teile = ["freigegeben"];
  if (d.approved_by_name) teile.push(`von ${d.approved_by_name}`);
  if (d.freigabe_art) teile.push(`(${ART_LABEL[d.freigabe_art]})`);
  if (d.approved_at) teile.push(`am ${formatDateFull(d.approved_at)}`);
  return teile.join(" ");
}

export function AlleVertrauteGeraeteCard() {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [laeuft, setLaeuft] = useState<{ id: string; aktion: Aktion | "entfernen" } | null>(null);
  const { confirm, ConfirmModalElement } = useConfirm();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/trust/devices?all=true", { cache: "no-store" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) throw new Error((json?.error as string | undefined) ?? `HTTP ${res.status}`);
      const jetzt = new Date();
      setDevices(
        (json.devices as Omit<DeviceRow, "abgelaufen">[]).map((d) => ({
          ...d,
          abgelaufen: d.status === "pending" && anfrageAbgelaufen(d, jetzt),
        })),
      );
      setMe((json.me as string | undefined) ?? null);
    } catch (e) {
      toast.error(`Geräte konnten nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleRevoke(d: DeviceRow) {
    const owner = d.profiles?.full_name ?? "Unbekannt";
    const ok = await confirm({
      title: `Gerät «${d.device_name}» von ${owner} entfernen?`,
      message: "Dieses Gerät verliert sofort den Zugriff auf Finanzen und Löhne. Für ein neues Gerät braucht es wieder eine Freigabe durch den anderen Admin oder die Vertretung.",
      confirmLabel: "Entfernen",
      variant: "red",
    });
    if (!ok) return;
    setLaeuft({ id: d.id, aktion: "entfernen" });
    try {
      const res = await fetch(`/api/trust/devices?id=${d.id}`, { method: "DELETE" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Entfernen fehlgeschlagen");
        return;
      }
      toast.success("Gerät entfernt");
      await load();
    } catch (e) {
      toast.error(`Entfernen fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaeuft(null);
    }
  }

  async function handleEntscheid(d: DeviceRow, aktion: Aktion) {
    const owner = d.profiles?.full_name ?? "Unbekannt";
    if (aktion === "ablehnen") {
      const ok = await confirm({
        title: `Anfrage «${d.device_name}» von ${owner} ablehnen?`,
        message: "Das Gerät bekommt keinen Zugriff auf Finanzen und Löhne. Für einen neuen Versuch braucht es eine neue Anfrage.",
        confirmLabel: "Ablehnen",
        variant: "red",
      });
      if (!ok) return;
    }
    setLaeuft({ id: d.id, aktion });
    try {
      const res = await fetch("/api/trust/freigabe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, aktion }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error((json?.error as string | undefined) ?? "Entscheid fehlgeschlagen");
      } else {
        toast.success(aktion === "freigeben" ? `Gerät «${d.device_name}» freigegeben` : `Anfrage «${d.device_name}» abgelehnt`);
      }
      // Immer neu laden — zeigt den aktuellen Stand, auch bei 409/410.
      await load();
    } catch (e) {
      toast.error(`Entscheid fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLaeuft(null);
    }
  }

  // Pro User gruppieren — bessere Lesbarkeit als flache Liste.
  const grouped = useMemo(() => {
    const map = new Map<string, { userId: string; name: string; email: string; devices: DeviceRow[] }>();
    for (const d of devices) {
      const key = d.user_id;
      if (!map.has(key)) {
        map.set(key, {
          userId: key,
          name: d.profiles?.full_name ?? "Unbekannt",
          email: d.profiles?.email ?? "—",
          devices: [],
        });
      }
      map.get(key)!.devices.push(d);
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [devices]);

  return (
    <Card className="bg-card">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Shield className="h-4 w-4" />
          Vertraute Geräte — alle User
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-xs text-muted-foreground">
          Alle Geräte mit Zugriff auf Finanzen und Löhne. Ein neues Gerät gibt nur der andere Admin oder die
          Vertretung frei — angemeldet, per Knopf, innerhalb von 24 Stunden, selbst auf einem vertrauten Gerät.
          Bestehende Freigaben bleiben gültig. Notweg über Mischa (Skript, protokolliert).
        </p>
        <VertretungZeile />
        {loading ? (
          <p className="text-xs text-muted-foreground italic">Lade…</p>
        ) : grouped.length === 0 ? (
          <EmptyState icon={Shield} title="Keine Geräte registriert" />
        ) : (
          <div className="space-y-3">
            {grouped.map((g) => (
              <div key={g.userId} className="border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-muted/40 border-b">
                  <p className="text-xs font-semibold">{g.name}</p>
                  <p className="text-[10px] text-muted-foreground">{g.email}</p>
                </div>
                <ul className="divide-y">
                  {g.devices.map((d) => {
                    const eigenes = d.user_id === me;
                    const entscheidbar = d.status === "pending" && !d.abgelaufen && !eigenes;
                    const gueltigBis = anfrageGueltigBis(d);
                    const freigabe = freigabeText(d);
                    const busy = laeuft?.id === d.id;
                    return (
                      <li key={d.id} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium truncate">{d.device_name}</span>
                            {d.status === "approved" ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                                <CheckCircle2 className="h-2.5 w-2.5" />
                                Aktiv
                              </span>
                            ) : d.status === "pending" && d.abgelaufen ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-muted text-muted-foreground dark:bg-foreground/15">
                                <Clock className="h-2.5 w-2.5" />
                                Abgelaufen
                              </span>
                            ) : d.status === "pending" ? (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                                <Clock className="h-2.5 w-2.5" />
                                Wartet
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">{d.user_agent_hint ?? "—"}</div>
                          {d.status === "pending" ? (
                            <div className="text-[11px] text-muted-foreground">
                              Angefragt {formatDateTimeFull(d.requested_at)}
                              {d.abgelaufen
                                ? " · älter als 24 h, neu anfragen lassen"
                                : gueltigBis
                                  ? ` · gültig bis ${formatDateTimeFull(gueltigBis.toISOString())}`
                                  : ""}
                              {eigenes && !d.abgelaufen && " · eigenes Gerät, gibt der andere Admin oder die Vertretung frei"}
                            </div>
                          ) : (
                            <div className="text-[11px] text-muted-foreground">
                              Zuletzt gesehen: {formatDateTimeFull(d.last_seen_at)}
                              {freigabe && <span className="text-muted-foreground/80"> · {freigabe}</span>}
                            </div>
                          )}
                        </div>
                        {entscheidbar ? (
                          <div className="flex shrink-0 gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleEntscheid(d, "freigeben")}
                              disabled={laeuft !== null}
                              className="kasten kasten-green"
                            >
                              {busy && laeuft?.aktion === "freigeben"
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <ShieldCheck className="h-3.5 w-3.5" />}
                              Freigeben
                            </button>
                            <button
                              type="button"
                              onClick={() => handleEntscheid(d, "ablehnen")}
                              disabled={laeuft !== null}
                              className="kasten kasten-red"
                            >
                              {busy && laeuft?.aktion === "ablehnen"
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <XCircle className="h-3.5 w-3.5" />}
                              Ablehnen
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleRevoke(d)}
                            disabled={laeuft !== null}
                            className="p-1.5 rounded hover:bg-foreground/10 text-muted-foreground hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50"
                            data-tooltip="Gerät entfernen"
                            data-tooltip-align="end"
                          >
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      {ConfirmModalElement}
    </Card>
  );
}

/**
 * Kompakte Zeile «Vertretung für Gerätefreigabe und Vier Augen». Die
 * Vertretung darf wie der andere Admin neue Geräte freigeben und Löhne
 * ändern (nie den eigenen). Speichern nur als Admin auf vertrautem Gerät.
 */
function VertretungZeile() {
  const [wert, setWert] = useState("");
  const [name, setName] = useState<string | null>(null);
  const [personen, setPersonen] = useState<SelectItem[]>([]);
  const [geladen, setGeladen] = useState(false);
  const [speichert, setSpeichert] = useState(false);

  useEffect(() => {
    let aktiv = true;
    (async () => {
      try {
        const [einstRes, profile] = await Promise.all([
          fetch("/api/hr/lohn-einstellungen", { cache: "no-store" }),
          createClient().rpc("get_all_profiles_admin"),
        ]);
        const einst = await einstRes.json().catch(() => null);
        if (!aktiv) return;
        if (!einstRes.ok || !einst?.success) {
          toast.error(`Vertretung konnte nicht geladen werden: ${(einst?.error as string | undefined) ?? `HTTP ${einstRes.status}`}`);
        } else {
          setWert((einst.vertretung_profile_id as string | null) ?? "");
          setName((einst.vertretung_name as string | null) ?? null);
        }
        if (profile.error) {
          toast.error(`Mitarbeiterliste konnte nicht geladen werden: ${profile.error.message}`);
        } else {
          setPersonen(
            ((profile.data ?? []) as { id: string; full_name: string; role: string; is_active: boolean }[])
              .filter((u) => istIntern(u.role) && u.is_active)
              .sort((a, b) => a.full_name.localeCompare(b.full_name))
              .map((u) => ({ id: u.id, label: u.full_name, sub: u.role })),
          );
        }
      } catch (e) {
        if (aktiv) toast.error(`Vertretung konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (aktiv) setGeladen(true);
      }
    })();
    return () => { aktiv = false; };
  }, []);

  async function speichern(neu: string) {
    if (!geladen || speichert || neu === wert) return;
    const vorher = wert;
    setWert(neu);
    setSpeichert(true);
    try {
      const res = await fetch("/api/hr/lohn-einstellungen", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vertretung_profile_id: neu || null }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        setWert(vorher);
        toast.error(
          json?.error === "device_not_trusted"
            ? "Vertretung ändern geht nur auf einem vertrauten Gerät."
            : (json?.error as string | undefined) ?? "Vertretung speichern fehlgeschlagen",
        );
        return;
      }
      // Vier Augen (Migration 361): die Vertretung wird nur beantragt — bis zur
      // Bestaetigung durch den anderen Admin bleibt die bisherige.
      setWert(vorher);
      toast.success((json.hinweis as string | undefined) ?? "Beantragt", { action: { label: "Anträge", onClick: () => window.location.assign(rechteAntraegeHref()) } });
    } catch (e) {
      setWert(vorher);
      toast.error(`Vertretung speichern fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSpeichert(false);
    }
  }

  // Inaktive/fehlende Vertretung steht nicht in der Liste → Namen trotzdem zeigen.
  const ausserhalbListe = !!wert && !personen.some((p) => p.id === wert);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pb-3 border-b">
      <span className="text-xs font-medium text-muted-foreground">Vertretung für Gerätefreigabe und Vier Augen:</span>
      <div className="w-64 max-w-full">
        <SearchableSelect
          value={wert}
          onChange={speichern}
          items={personen}
          placeholder={geladen ? "— keine Vertretung —" : "Lade …"}
          freeTextDisplay={ausserhalbListe ? name ?? undefined : undefined}
        />
      </div>
      {speichert && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}
