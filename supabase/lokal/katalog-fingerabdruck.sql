-- Katalog-Fingerabdruck (nur lesend): eine Zeile je Schema-Objekt, Spalten k (Schlüssel) + v (Wert/md5).
-- Wird gegen Live (read-only Endpoint) und lokal ausgeführt; abgleich.mjs vergleicht beide Listen.
-- Zeilenenden (CR) werden vor dem md5 entfernt: Windows-Checkouts (autocrlf) sollen keine Scheinunterschiede erzeugen.
with sch as (select oid, nspname from pg_namespace where nspname in ('public','finanzen'))
select k, v from (
  -- Tabellen/Views + RLS-Schalter
  select 'rel|'||n.nspname||'.'||c.relname as k,
         c.relkind::text||' rls='||c.relrowsecurity||' force='||c.relforcerowsecurity as v
  from pg_class c join sch n on n.oid=c.relnamespace
  where c.relkind in ('r','p','v','m','f')
  union all
  -- Spalten
  select 'col|'||n.nspname||'.'||c.relname||'.'||a.attname,
         format_type(a.atttypid,a.atttypmod)||' nn='||a.attnotnull||' def='||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||' gen='||a.attgenerated::text||' id='||a.attidentity::text
  from pg_attribute a join pg_class c on c.oid=a.attrelid join sch n on n.oid=c.relnamespace
  left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
  where c.relkind in ('r','p','v','m','f') and a.attnum>0 and not a.attisdropped
  union all
  -- View-Definitionen
  select 'view|'||n.nspname||'.'||c.relname, md5(replace(pg_get_viewdef(c.oid),chr(13),''))
  from pg_class c join sch n on n.oid=c.relnamespace where c.relkind in ('v','m')
  union all
  -- Funktionen (Definition per md5, plus Eigentümer/Security/Config)
  select 'fn|'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         md5(replace(pg_get_functiondef(p.oid),chr(13),''))||' owner='||pg_get_userbyid(p.proowner)||' secdef='||p.prosecdef||' cfg='||coalesce(array_to_string(p.proconfig,','),'')
  from pg_proc p join sch n on n.oid=p.pronamespace where p.prokind in ('f','p','w')
    and not exists (select 1 from pg_depend dep where dep.objid=p.oid and dep.deptype='e')
  union all
  -- Funktions-Rechte (EXECUTE) für die API-Rollen
  select 'fnacl|'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',
         coalesce((select string_agg(case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end, ',' order by 1)
                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
                   where x.privilege_type='EXECUTE' and (x.grantee=0 or pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role'))),'')
  from pg_proc p join sch n on n.oid=p.pronamespace where p.prokind in ('f','p','w')
    and not exists (select 1 from pg_depend dep where dep.objid=p.oid and dep.deptype='e')
  union all
  -- Tabellen-Rechte für die API-Rollen
  select 'acl|'||n.nspname||'.'||c.relname||'|'||r.rolname,
         coalesce((select string_agg(x.privilege_type, ',' order by x.privilege_type)
                   from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where x.grantee=r.oid),'')
  from pg_class c join sch n on n.oid=c.relnamespace
  cross join (select oid, rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  where c.relkind in ('r','p','v','m')
  union all
  -- Spalten-Rechte (nur wo gesetzt) für die API-Rollen
  select 'colacl|'||n.nspname||'.'||c.relname||'.'||a.attname||'|'||pg_get_userbyid(x.grantee),
         string_agg(x.privilege_type, ',' order by x.privilege_type)
  from pg_attribute a join pg_class c on c.oid=a.attrelid join sch n on n.oid=c.relnamespace
  cross join lateral aclexplode(a.attacl) x
  where a.attacl is not null and pg_get_userbyid(x.grantee) in ('anon','authenticated','service_role')
  group by 1
  union all
  -- Schema-Rechte (USAGE/CREATE) der API-Rollen
  select 'schemaacl|'||n.nspname||'|'||r.rolname,
         has_schema_privilege(r.oid, n.oid, 'USAGE')::text||','||has_schema_privilege(r.oid, n.oid, 'CREATE')::text
  from sch n cross join (select oid, rolname from pg_roles where rolname in ('anon','authenticated','service_role')) r
  union all
  -- Policies (public, finanzen, storage)
  select 'pol|'||schemaname||'.'||tablename||'|'||policyname,
         permissive||' '||cmd||' roles='||array_to_string(roles,',')||' q='||md5(replace(coalesce(qual,''),chr(13),''))||' c='||md5(replace(coalesce(with_check,''),chr(13),''))
  from pg_policies where schemaname in ('public','finanzen','storage')
  union all
  -- Trigger (inkl. auth/storage-Tabellen, die eigene Trigger tragen)
  select 'trg|'||n.nspname||'.'||c.relname||'|'||t.tgname, md5(replace(pg_get_triggerdef(t.oid),chr(13),''))||' en='||t.tgenabled::text
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  where not t.tgisinternal and (n.nspname in ('public','finanzen') or exists (
    select 1 from pg_proc tp join pg_namespace tn on tn.oid=tp.pronamespace where tp.oid=t.tgfoid and tn.nspname in ('public','finanzen')))
  union all
  -- Indizes
  select 'idx|'||n.nspname||'.'||ic.relname, md5(replace(pg_get_indexdef(i.indexrelid),chr(13),''))
  from pg_index i join pg_class ic on ic.oid=i.indexrelid join sch n on n.oid=ic.relnamespace
  union all
  -- Constraints
  select 'con|'||n.nspname||'.'||cl.relname||'|'||co.conname, co.contype::text||' '||md5(replace(pg_get_constraintdef(co.oid),chr(13),''))
  from pg_constraint co join pg_class cl on cl.oid=co.conrelid join sch n on n.oid=cl.relnamespace
  union all
  -- Enums / Typen
  select 'enum|'||n.nspname||'.'||t.typname, (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid)
  from pg_type t join sch n on n.oid=t.typnamespace where t.typtype='e'
  union all
  -- Sequenzen
  select 'seq|'||n.nspname||'.'||c.relname, 'seq' from pg_class c join sch n on n.oid=c.relnamespace where c.relkind='S'
  union all
  -- Storage-Buckets (Konfiguration, keine Dateien)
  select 'bucket|'||b.id, 'public='||b.public||' limit='||coalesce(b.file_size_limit::text,'')||' mime='||coalesce(array_to_string(b.allowed_mime_types,','),'')
  from storage.buckets b
  union all
  -- Realtime-Publikation
  select 'pub|'||pt.pubname||'|'||pt.schemaname||'.'||pt.tablename, 'x' from pg_publication_tables pt where pt.schemaname in ('public','finanzen')
  union all
  -- Erweiterungen
  select 'ext|'||e.extname, n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace
  union all
  -- Rollen ausserhalb des Supabase-Standards (nur Name + Login-Flag)
  select 'role|'||r.rolname, 'login='||r.rolcanlogin from pg_roles r
  where r.rolname not like 'pg\_%' and r.rolname not like 'supabase%' and r.rolname not in
    ('postgres','anon','authenticated','service_role','authenticator','dashboard_user','pgbouncer','pgsodium_keyholder','pgsodium_keyiduser','pgsodium_keymaker','cli_login_postgres','pgtle_admin','supabase_etl_admin')
) z
order by k;
