-- GRC + · Backup semanal automático.
-- As cópias ficam em um armazenamento privado (sem regras de acesso: só a chave de serviço lê).
insert into storage.buckets (id, name, public)
values ('backups', 'backups', false)
on conflict (id) do nothing;

create function private.fazer_backup()
returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  v_segredo text;
  v_id bigint;
begin
  select decrypted_secret into v_segredo from vault.decrypted_secrets where name = 'sync_token';
  if v_segredo is null then
    raise exception 'Segredo sync_token não encontrado no Vault.';
  end if;

  select net.http_post(
    url := 'https://agzlflvvpqgtcrajtpnw.supabase.co/functions/v1/backup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-token', v_segredo),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into v_id;
  return v_id;
end;
$$;
revoke all on function private.fazer_backup() from public, anon, authenticated;

-- Todo domingo às 06:00 UTC (03:00 em Brasília)
select cron.schedule('backup-semanal', '0 6 * * 0', $$select private.fazer_backup()$$);
