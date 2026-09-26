-- Nachschärfung zu 268 (Befund aus dem Funktions-Check): ein "Fertig
-- bis"-Termin hat per Definition KEINE Endzeit (start_time = Deadline).
-- Das UI und der RPC halten das ein — die DB soll es aber erzwingen,
-- damit auch ein roher Insert (Partner-Policy erlaubt Inserts direkt)
-- keinen widerspruechlichen Termin anlegen kann.

do $$ begin
  alter table public.job_appointments
    add constraint job_appointments_deadline_ohne_end_check
    check (zeit_modus <> 'deadline' or end_time is null);
exception when duplicate_object then null; end $$;
