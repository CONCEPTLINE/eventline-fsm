// Wer sieht den echten Abwesenheits-Typ einer anderen Person? (Migration 379)
//
// Entscheid (Owner, 2026-11-03): Kolleginnen und Kollegen sehen eine
// Krankheit nur als «abwesend», nie als «krank». Den echten Typ sehen nur
// die Person selbst, Admins, ferien:approve und tickets:manage — dieselbe
// Regel wie public.darf_abwesenheitsgrund_sehen() in der DB. Nie Namenslisten.
//
// Andere Typen (Ferien, Frei, Militär, Kompensation) bleiben sichtbar wie bisher.

import type { TimeOffType } from "@/types";

/** Rechte, die den echten Typ fremder Abwesenheiten zeigen (Admin immer). */
export const ABWESENHEITSGRUND_RECHTE = ["ferien:approve", "tickets:manage"] as const;

/** Typ, wie ihn eine betrachtende Person sehen darf. */
export type AbwesenheitAnzeigeTyp = TimeOffType | "abwesend";

/** Neutrales Label fuer maskierte Abwesenheiten. */
export const ABWESEND_LABEL = "Abwesend";

/** `hat(recht)` muss Admins durchlassen (hasPermission / has_permission tun das). */
export function darfAbwesenheitsgrundSehen(hat: (recht: string) => boolean): boolean {
  return ABWESENHEITSGRUND_RECHTE.some((r) => hat(r));
}

/** Echter Typ fuer die Person selbst und die berechtigte Gruppe, sonst
 *  «krank» → «abwesend». */
export function typFuerBetrachter(
  typ: AbwesenheitAnzeigeTyp,
  opts: { eigen: boolean; privilegiert: boolean },
): AbwesenheitAnzeigeTyp {
  if (opts.eigen || opts.privilegiert) return typ;
  return typ === "krank" ? "abwesend" : typ;
}
