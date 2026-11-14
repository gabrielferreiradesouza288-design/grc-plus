-- GRC + · Indicadores do Painel, calculados no banco em uma única chamada.
-- Roda com as permissões de quem chama (RLS vale): só usuário ativo recebe números.
create function public.painel_indicadores(p_inicio timestamptz, p_fim timestamptz, p_fuso text default 'America/Sao_Paulo')
returns jsonb
language sql stable security invoker set search_path = ''
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
  select jsonb_build_object(
    'atendimentos', (select count(*) from public.atendimentos where iniciado_em >= p_inicio and iniciado_em < p_fim),
    'novos_contatos', (select count(*) from public.conversas where iniciada_em >= p_inicio and iniciada_em < p_fim),
    'transferidos', (select count(*) from public.atendimentos where transferido_em >= p_inicio and transferido_em < p_fim),
    'duracao_media_min', (select round(avg(extract(epoch from finalizado_em - iniciado_em)) / 60)
                          from public.atendimentos
                          where finalizado_em >= p_inicio and finalizado_em < p_fim and iniciado_em is not null),
    'espera_media_min', (select round(avg(extract(epoch from a.em - f.em)) / 60, 1)
                         from fila f join assumiu a using (conversa_id, protocolo) where a.em >= f.em),
    'esperas_medidas', (select count(*) from fila f join assumiu a using (conversa_id, protocolo) where a.em >= f.em),
    -- eventos só são visíveis ao mestre; para os demais vem null (e não um zero enganoso)
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
  );
$$;

revoke all on function public.painel_indicadores(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.painel_indicadores(timestamptz, timestamptz, text) to authenticated;
