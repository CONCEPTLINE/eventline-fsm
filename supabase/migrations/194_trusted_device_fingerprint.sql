-- Trusted-Device: Fingerprint-Column um Safari-Version-Bumps zu ignorieren.
-- Bisher landete jedes Safari-Update in einem "neuen Geraet" weil der
-- Cookie nach dem Update verloren ging und der User erneut Approval
-- braucht. Fix: normalisierter User-Agent-Hash (Ziffern raus) + user_id
-- ergibt einen stabilen Fingerprint. Beim erneuten Register-Attempt
-- wird ein bereits approved-Row mit demselben Fingerprint wiederverwendet
-- (neuer Cookie, gleicher approved-Status) — kein neuer Approval-Loop.

ALTER TABLE public.trusted_devices
  ADD COLUMN IF NOT EXISTS device_fingerprint text;

CREATE INDEX IF NOT EXISTS trusted_devices_fingerprint_idx
  ON public.trusted_devices(user_id, device_fingerprint)
  WHERE device_fingerprint IS NOT NULL;

COMMENT ON COLUMN public.trusted_devices.device_fingerprint IS
  'SHA-256(normalisierter user_agent + user_id). Normalisiert = alle Ziffern-Sequenzen entfernt, damit Safari-Version-Updates den Fingerprint nicht invalidieren.';
