// POST /api/admin/partner-users — Partner-User anlegen.
// Wie /api/admin/users, aber:
//   - Rolle fix 'partner'
//   - partner_location_id ist Pflicht
//   - Reset-Mail geht an /partner/login statt /login
//
// Duenner Wrapper um createPortalUser() (src/lib/portal-users.ts) —
// gemeinsame Logik mit /api/admin/lieferant-users, URL und Response-
// Format unveraendert.

import { createPortalUser } from "@/lib/portal-users";

export async function POST(request: Request) {
  return createPortalUser(request, {
    role: "partner",
    fkColumn: "partner_location_id",
    fkTable: "locations",
    fkRequiredError: "Location ist Pflicht",
    fkNotFoundError: "Location nicht gefunden",
    fkAssignError: "Location konnte nicht zugewiesen werden",
    logAssignKey: "admin.partner-users.location-update",
    logExceptionKey: "admin.partner-users.exception",
  });
}
