-- Auto-Lohnabrechnung: pro MA-Toggle. Wenn true (Default), erstellt der
-- Cron 7 Tage nach Monatsende automatisch die PDF-Lohnabrechnung fuer
-- den abgeschlossenen Monat. Idempotent (skippt wenn schon vorhanden).
--
-- Default true, weil die grosse Mehrheit der aktiv angestellten MA
-- monatlich abgerechnet wird. Admin kann pro MA aus (z.B. Aushilfen
-- die nur unregelmaessig arbeiten und nicht ins monatliche Muster passen).
--
-- Bei wage_exempt=true ist der Toggle sinnlos (kein Lohn -> keine
-- Abrechnung); die Cron-Route filtert das ohnehin raus, das UI blendet
-- den Toggle in dem Fall aus.

alter table public.employee_compensation
  add column if not exists auto_lohnabrechnung boolean not null default true;

comment on column public.employee_compensation.auto_lohnabrechnung is
  'true = Cron erstellt 7 Tage nach Monatsende automatisch eine Lohnabrechnung. Default true.';
