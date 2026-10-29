// Lohn-Zugriffsregeln (Phase 1 «Gefahren und Sicherheit»), nur Server.
//
//   ladeLohnEinstellungen()   Vertretung + «Lauf ab» (Tabelle lohn_einstellungen)
//   pruefeLohnAenderung()     Vier Augen: eigener Lohn nur durch den anderen
//                             Admin oder die Vertretung
//   pruefeGeraetFreigabe()    Gerätefreigabe nur durch den anderen Admin oder
//                             die Vertretung (nie durch die Person selbst)
//
// Alle Funktionen nehmen den Admin-Client (service_role) und WERFEN bei
// Ladefehlern — eine Rechteprüfung, die nicht laden kann, sagt nie «ja».

import type { SupabaseClient } from "@supabase/supabase-js";
import { monatVon, type LohnMonat } from "./monate";

export const LOHN_RECHT = "lohn:manage";

export interface LohnEinstellungen {
  vertretungProfileId: string | null;
  vertretungName: string | null;
  laufAb: LohnMonat;
}

export async function ladeLohnEinstellungen(admin: SupabaseClient): Promise<LohnEinstellungen> {
  const { data, error } = await admin
    .from("lohn_einstellungen")
    .select("vertretung_profile_id, vertretung_name, lauf_ab")
    .eq("id", "default")
    .maybeSingle();
  if (error) throw new Error(`Lohn-Einstellungen konnten nicht geladen werden: ${error.message}`);
  if (!data) throw new Error("Lohn-Einstellungen fehlen (Migration 360 nicht eingespielt?)");
  return {
    vertretungProfileId: (data.vertretung_profile_id as string | null) ?? null,
    vertretungName: (data.vertretung_name as string | null) ?? null,
    laufAb: monatVon(String(data.lauf_ab)),
  };
}

interface PersonRecht {
  id: string;
  name: string | null;
  istAdmin: boolean;
  hatLohnRecht: boolean;
  aktiv: boolean;
}

/** Rolle + Lohnrecht einer beliebigen Person (has_permission() kennt nur
 *  auth.uid(); hier dieselbe Regel: aktiv UND (Admin ODER Recht in der Rolle)). */
export async function ladePersonRecht(admin: SupabaseClient, profileId: string): Promise<PersonRecht | null> {
  const { data: p, error } = await admin
    .from("profiles")
    .select("id, full_name, role, is_active")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw new Error(`Profil konnte nicht geladen werden: ${error.message}`);
  if (!p) return null;
  const istAdmin = p.role === "admin";
  let hatRecht = istAdmin;
  if (!istAdmin && p.role) {
    const { data: r, error: rErr } = await admin.from("roles").select("permissions").eq("slug", p.role).maybeSingle();
    if (rErr) throw new Error(`Rolle konnte nicht geladen werden: ${rErr.message}`);
    hatRecht = Array.isArray(r?.permissions) && (r!.permissions as unknown[]).includes(LOHN_RECHT);
  }
  const aktiv = p.is_active === true;
  return {
    id: p.id as string,
    name: (p.full_name as string | null) ?? null,
    istAdmin: istAdmin && aktiv,
    hatLohnRecht: hatRecht && aktiv,
    aktiv,
  };
}

/** Vier Augen beim Lohn. null = erlaubt, sonst Begründung (403).
 *  - Niemand ändert den eigenen Lohn.
 *  - Den Lohn einer Person MIT Lohnrecht (Admins, Lohn-Verwalter) ändert nur
 *    ein (anderer) Admin oder die Vertretung.
 *  - Übrige Personen: wer Lohnrecht + vertrautes Gerät hat (prüft die Route). */
export function lohnAenderungVerboten(args: {
  actorId: string;
  targetId: string;
  actorIstAdmin: boolean;
  targetHatLohnRecht: boolean;
  vertretungProfileId: string | null;
}): string | null {
  if (args.actorId === args.targetId) {
    return "Den eigenen Lohn ändert der andere Admin oder die Vertretung (Vier-Augen-Prinzip).";
  }
  if (args.targetHatLohnRecht && !args.actorIstAdmin && args.actorId !== args.vertretungProfileId) {
    return "Den Lohn einer Person mit Lohnrecht ändert nur ein Admin oder die Vertretung.";
  }
  return null;
}

export async function pruefeLohnAenderung(admin: SupabaseClient, actorId: string, targetId: string): Promise<string | null> {
  if (actorId === targetId) {
    return lohnAenderungVerboten({ actorId, targetId, actorIstAdmin: false, targetHatLohnRecht: false, vertretungProfileId: null });
  }
  const [actor, target, einst] = await Promise.all([
    ladePersonRecht(admin, actorId),
    ladePersonRecht(admin, targetId),
    ladeLohnEinstellungen(admin),
  ]);
  if (!actor) return "Konto nicht gefunden.";
  return lohnAenderungVerboten({
    actorId,
    targetId,
    actorIstAdmin: actor.istAdmin,
    targetHatLohnRecht: target?.hatLohnRecht === true,
    vertretungProfileId: einst.vertretungProfileId,
  });
}

/** Darf `freigeberId` ein Gerät von `besitzerId` freigeben? null = ja. */
export function geraetFreigabeVerboten(args: {
  freigeberId: string;
  besitzerId: string;
  freigeberIstAdmin: boolean;
  vertretungProfileId: string | null;
}): string | null {
  if (args.freigeberId === args.besitzerId) {
    return "Das eigene Gerät gibt der andere Admin oder die Vertretung frei.";
  }
  if (!args.freigeberIstAdmin && args.freigeberId !== args.vertretungProfileId) {
    return "Geräte geben nur Admins oder die Vertretung frei.";
  }
  return null;
}

export async function pruefeGeraetFreigabe(admin: SupabaseClient, freigeberId: string, besitzerId: string): Promise<{ verboten: string | null; freigeber: PersonRecht | null; vertretung: boolean }> {
  const [freigeber, einst] = await Promise.all([ladePersonRecht(admin, freigeberId), ladeLohnEinstellungen(admin)]);
  const verboten = geraetFreigabeVerboten({
    freigeberId,
    besitzerId,
    freigeberIstAdmin: freigeber?.istAdmin === true,
    vertretungProfileId: einst.vertretungProfileId,
  });
  return { verboten, freigeber, vertretung: !freigeber?.istAdmin && freigeberId === einst.vertretungProfileId };
}
