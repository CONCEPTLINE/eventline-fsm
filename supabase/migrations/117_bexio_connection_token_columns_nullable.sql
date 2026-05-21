-- Hotfix: bexio_connection.access_token + refresh_token nullable machen.
--
-- Hintergrund: Migration 110 hat die Tokens in supabase_vault ausgelagert
-- (siehe access_token_secret_id / refresh_token_secret_id Spalten und die
-- RPCs bexio_token_get/set). Die plain-Text-Spalten waren ursprunglich
-- als Single-Source-of-Truth NOT NULL angelegt — bleiben jetzt zwar fuer
-- Backward-Compat-Reads noch da, sind aber bei Neu-Verbindungen NULL,
-- weil saveConnection() den Token nur in den Vault schreibt.
--
-- Ohne den Patch crasht der OAuth-Callback ("null value in column
-- access_token violates not-null constraint") und der User kann keinen
-- accounting-Scope freischalten.

alter table public.bexio_connection
  alter column access_token drop not null,
  alter column refresh_token drop not null;
