// POST /api/admin/lieferant-users — Lieferanten-User anlegen.
// Wie /api/admin/users, aber:
//   - Rolle fix 'lieferant'
//   - lieferant_id ist Pflicht
//   - Reset-Mail geht an /lieferant/login statt /login
//
// Duenner Wrapper um createPortalUser() (src/lib/portal-users.ts) —
// gemeinsame Logik mit /api/admin/partner-users, URL und Response-
// Format unveraendert.

import { createPortalUser } from "@/lib/portal-users";

export async function POST(request: Request) {
  return createPortalUser(request, {
    role: "lieferant",
    fkColumn: "lieferant_id",
    fkTable: "lieferanten",
    fkRequiredError: "Lieferanten-Firma ist Pflicht",
    fkNotFoundError: "Lieferant nicht gefunden",
    fkAssignError: "Lieferanten-Firma konnte nicht zugewiesen werden",
    logAssignKey: "admin.lieferant-users.lieferant-update",
    logExceptionKey: "admin.lieferant-users.exception",
  });
}
