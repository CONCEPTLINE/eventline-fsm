-- Vertrieb: Counter wie oft ein Lead bereits "Erneut kontaktiert" wurde.
-- Wird beim Klick auf den Button im LeadEditor inkrementiert und gibt
-- der Vertriebs-Person eine schnelle Anhaltspunkt wie hartnaeckig hier
-- schon nachverfolgt wurde — "5x nachgefasst und nichts passiert" ist
-- ein anderes Signal als "1x angerufen".
--
-- Default 0, nullable=false damit Inserts ohne explizites Set sauber
-- aufgesetzt werden.

ALTER TABLE public.vertrieb_contacts
  ADD COLUMN IF NOT EXISTS recontact_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.vertrieb_contacts.recontact_count IS
  'Wie oft wurde "Erneut kontaktiert" geklickt seit Lead-Anlage.';
