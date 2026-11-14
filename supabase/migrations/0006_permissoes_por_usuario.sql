-- GRC + · Permissões por usuário.
-- O usuário mestre pode tudo. Para os demais, o mestre marca o que cada um pode fazer:
--   funil            ver o Funil
--   conversas        ver a lista de Conversas
--   mensagens        abrir conversas (ler as mensagens)
--   contatos         ver Contatos
--   editar_contatos  editar etiquetas e anotações
--   painel           ver o Painel
-- As regras valem no banco (RLS), não só na tela.

alter table public.usuarios add column permissoes jsonb not null default '{}'::jsonb;
grant update (permissoes) on public.usuarios to authenticated;  -- a política abaixo continua exigindo mestre

create function private.pode(p_permissao text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios
    where id = (select auth.uid()) and ativo
      and (papel = 'mestre' or coalesce((permissoes ->> p_permissao)::boolean, false))
  );
$$;
revoke all on function private.pode(text) from public, anon;
grant execute on function private.pode(text) to authenticated;

-- Contatos
drop policy "usuario ativo le contatos" on public.contatos;
drop policy "usuario ativo edita etiquetas e anotacoes" on public.contatos;
create policy "le contatos quem tem permissao" on public.contatos
  for select to authenticated using ((select private.pode('contatos')));
create policy "edita etiquetas e anotacoes quem tem permissao" on public.contatos
  for update to authenticated
  using ((select private.pode('editar_contatos'))) with check ((select private.pode('editar_contatos')));

-- Conversas e atendimentos: usados pelo Funil, por Conversas e pela ficha do contato
drop policy "usuario ativo le conversas" on public.conversas;
create policy "le conversas quem tem permissao" on public.conversas
  for select to authenticated
  using ((select private.pode('funil')) or (select private.pode('conversas')) or (select private.pode('contatos')));

drop policy "usuario ativo le atendimentos" on public.atendimentos;
create policy "le atendimentos quem tem permissao" on public.atendimentos
  for select to authenticated
  using ((select private.pode('funil')) or (select private.pode('conversas')) or (select private.pode('contatos')));

-- Mensagens: só quem pode abrir conversas
drop policy "usuario ativo le mensagens" on public.mensagens;
create policy "le mensagens quem tem permissao" on public.mensagens
  for select to authenticated using ((select private.pode('mensagens')));

-- Painel: passa a conferir a permissão "painel" e a ler os totais independentemente das outras permissões
create or replace function public.painel_indicadores(p_inicio timestamptz, p_fim timestamptz, p_fuso text default 'America/Sao_Paulo')
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with fila as (
    select conversa_id, protocolo, min(enviada_em) as em
    from public.mensagens
    where notificacao_tipo = 'TRANSFER_QUEUE' and enviada_em >= p_inicio and enviada_em < p_fim
    group by 1, 2
  ),
  assumiu as (
    select conversa_id, protocolo, min(enviada_em) as em
    from public.mensagens
    where notificacao_tipo = 'START_INTERACTION_HUMAN' and enviada_em >= p_inicio
    group by 1, 2
  )
  select case when private.pode('painel') then jsonb_build_object(
    'atendimentos', (select count(*) from public.atendimentos where iniciado_em >= p_inicio and iniciado_em < p_fim),
    'novos_contatos', (select count(*) from public.conversas where iniciada_em >= p_inicio and iniciada_em < p_fim),
    'transferidos', (select count(*) from public.atendimentos where transferido_em >= p_inicio and transferido_em < p_fim),
    'duracao_media_min', (select round(avg(extract(epoch from finalizado_em - iniciado_em)) / 60)
                          from public.atendimentos
                          where finalizado_em >= p_inicio and finalizado_em < p_fim and iniciado_em is not null),
    'espera_media_min', (select round(avg(extract(epoch from a.em - f.em)) / 60, 1)
                         from fila f join assumiu a using (conversa_id, protocolo) where a.em >= f.em),
    'esperas_medidas', (select count(*) from fila f join assumiu a using (conversa_id, protocolo) where a.em >= f.em),
    'bot_sem_resposta', case when private.eh_mestre() then
                          (select count(*) from public.eventos
                           where tipo = 'onLackKnowLedge' and recebido_em >= p_inicio and recebido_em < p_fim) end,
    'mensagens_cliente', (select count(*) from public.mensagens
                          where autor = 'cliente' and enviada_em >= p_inicio and enviada_em < p_fim),
    'por_dia', coalesce((select jsonb_agg(jsonb_build_object('dia', d, 'n', n) order by d)
                from (select (iniciado_em at time zone p_fuso)::date as d, count(*) as n
                      from public.atendimentos
                      where iniciado_em >= p_inicio and iniciado_em < p_fim group by 1) x), '[]'::jsonb),
    'por_hora', coalesce((select jsonb_agg(jsonb_build_object('hora', h, 'n', n) order by h)
                 from (select extract(hour from enviada_em at time zone p_fuso)::int as h, count(*) as n
                       from public.mensagens
                       where autor = 'cliente' and enviada_em >= p_inicio and enviada_em < p_fim group by 1) x), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.painel_indicadores(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.painel_indicadores(timestamptz, timestamptz, text) to authenticated;

-- Segurança: nunca ficar sem nenhum usuário mestre ativo (ao inativar, rebaixar ou excluir)
create function private.garantir_um_mestre()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.usuarios where papel = 'mestre' and ativo) then
    raise exception 'É preciso manter pelo menos um usuário mestre ativo.';
  end if;
  return null;
end;
$$;
revoke all on function private.garantir_um_mestre() from public, anon, authenticated;

create trigger usuarios_garantir_um_mestre
  after update or delete on public.usuarios
  for each statement execute function private.garantir_um_mestre();
