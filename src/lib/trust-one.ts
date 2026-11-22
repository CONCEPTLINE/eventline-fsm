// Adressen von LINERA one und LINERA flow (LINERA GROUP), die das ERP kennt. Die Ablage der EVENTLINE GmbH (NAS,
// Fristen, Mail-Eingang ablage@) lebt seit 01.11.2026 in LINERA flow (Firma «eventline»), vorher ab 24.10.2026 in
// LINERA one (Bereich «eventline-gmbh»). Kein Geheimnis — darf in den Browser (Links). Die Server-Aufrufe der
// Fremd-API stehen in lib/trust-one-ablage.

/** Basis-Adresse von LINERA one (Server-Aufrufe koennen sie per env LINERA_ONE_URL, Rueckfall TRUST_ONE_URL,
 *  ueberschreiben). */
export const TRUST_ONE_URL_STANDARD = "https://one.linera-group.ch";

/** Basis-Adresse von LINERA flow (Links im Browser; Server-Aufrufe per env LINERA_FLOW_URL, Rueckfall TRUST_FLOW_URL). */
export const LINERA_FLOW_URL_STANDARD = "https://flow.linera-group.ch";

/** Firma der EVENTLINE GmbH in LINERA flow (= FLOW_FIRMA in lib/flow/ausweis, hier ohne server-only-Import). */
export const LINERA_FLOW_FIRMA = "eventline";

/** Ablage der EVENTLINE GmbH in LINERA flow — Ziel der alten Links /ablage und /nas (next.config). */
export const LINERA_FLOW_ABLAGE_LINK = `${LINERA_FLOW_URL_STANDARD}/${LINERA_FLOW_FIRMA}/ablage`;

/** Bereich (Slug) der EVENTLINE GmbH in der frueheren Ablage von LINERA one (Rueckweg ABLAGE_ZIEL=trust-one). */
export const TRUST_ONE_ABLAGE_BEREICH = "eventline-gmbh";

/** Fristen der Ablage in LINERA flow — Ziel der Zeile «Fristen in 30 Tagen» im Dashboard, wenn der Server keinen
 *  Link mitgibt. */
export const TRUST_ONE_FRISTEN_LINK = `${LINERA_FLOW_URL_STANDARD}/${LINERA_FLOW_FIRMA}/fristen`;

/** Fristen-Ansicht der frueheren Ablage in LINERA one (nur noch Rueckweg ABLAGE_ZIEL=trust-one). */
export const LINERA_ONE_FRISTEN_LINK_ALT = `${TRUST_ONE_URL_STANDARD}/geschaeft/ablage/${TRUST_ONE_ABLAGE_BEREICH}?ansicht=fristen`;
