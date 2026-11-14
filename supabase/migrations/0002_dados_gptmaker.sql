-- GRC + · Etapa 2 do banco: dados vindos do GPT Maker
-- Os IDs são os mesmos do GPT Maker (texto), para que importar duas vezes nunca duplique nada.

-- ---------------------------------------------------------------------------
-- Contatos
-- ---------------------------------------------------------------------------
create table public.contatos (
  id            text primary key,              -- contactId do GPT Maker
  nome          text not null default '',
  telefone      text,
  email         text,
  foto_url      text,
  etiquetas     text[] not null default '{}',  -- editado no CRM
  anotacoes     text not null default '',      -- editado no CRM
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Conversas (um chat por contato/canal no GPT Maker) = card do funil
-- ---------------------------------------------------------------------------
create table public.conversas (
  id                 text primary key,         -- chat id do GPT Maker
  contato_id         text references public.contatos (id) on delete set null,
  agente_id          text,
  agente_nome        text,
  canal_id           text,
  canal_tipo         text,
  nome               text not null default '',
  telefone           text,
  foto_url           text,
  etapa              text not null default 'bot_atendendo'
                     check (etapa in ('novo_lead', 'bot_atendendo', 'aguardando_humano', 'humano_atendendo', 'finalizado')),
  humano             boolean not null default false,
  finalizado         boolean not null default false,
  bot_sem_resposta   boolean not null default false,
  nao_lidas          int not null default 0,
  ultima_mensagem    text,
  ultima_mensagem_em timestamptz,
  iniciada_em        timestamptz,
  sincronizada_em    timestamptz,              -- até quando as mensagens foram importadas
  atualizado_em      timestamptz not null default now()
);
create index on public.conversas (etapa, ultima_mensagem_em desc);
create index on public.conversas (contato_id);

-- ---------------------------------------------------------------------------
-- Atendimentos (cada protocolo aberto dentro de uma conversa)
-- ---------------------------------------------------------------------------
create table public.atendimentos (
  id             text primary key,             -- interaction id do GPT Maker
  conversa_id    text not null references public.conversas (id) on delete cascade,
  contato_id     text references public.contatos (id) on delete set null,
  protocolo      text,
  status_origem  text,                         -- status como vem do GPT Maker (WAITING, RESOLVED...)
  etapa          text not null default 'bot_atendendo'
                 check (etapa in ('novo_lead', 'bot_atendendo', 'aguardando_humano', 'humano_atendendo', 'finalizado')),
  atendente_id   text,
  atendente_nome text,
  iniciado_em    timestamptz,
  transferido_em timestamptz,
  finalizado_em  timestamptz,
  atualizado_em  timestamptz not null default now()
);
create index on public.atendimentos (conversa_id, iniciado_em desc);
create index on public.atendimentos (iniciado_em desc);

-- ---------------------------------------------------------------------------
-- Mensagens
-- ---------------------------------------------------------------------------
create table public.mensagens (
  id               text primary key,           -- message id do GPT Maker
  conversa_id      text not null references public.conversas (id) on delete cascade,
  autor            text not null check (autor in ('cliente', 'bot', 'equipe', 'sistema')),
  autor_nome       text,
  tipo             text not null default 'TEXT',
  notificacao_tipo text,                       -- TRANSFER_QUEUE, START_INTERACTION_HUMAN...
  protocolo        text,
  texto            text,
  audio_url        text,
  imagem_url       text,
  video_url        text,
  documento_url    text,
  arquivo_nome     text,
  sequencia        int,
  enviada_em       timestamptz not null
);
create index on public.mensagens (conversa_id, enviada_em);

-- ---------------------------------------------------------------------------
-- Eventos (registro bruto de cada webhook recebido)
-- ---------------------------------------------------------------------------
create table public.eventos (
  id          bigint generated always as identity primary key,
  tipo        text,
  payload     jsonb not null,
  processado  boolean not null default false,
  erro        text,
  recebido_em timestamptz not null default now()
);
create index on public.eventos (recebido_em desc);

-- ---------------------------------------------------------------------------
-- Histórico das sincronizações com a API
-- ---------------------------------------------------------------------------
create table public.sincronizacoes (
  id           bigint generated always as identity primary key,
  iniciada_em  timestamptz not null default now(),
  concluida_em timestamptz,
  sucesso      boolean,
  resumo       jsonb,
  erro         text
);

-- atualizado_em automático
create trigger contatos_atualizado_em before update on public.contatos
  for each row execute function private.marcar_atualizacao();
create trigger conversas_atualizado_em before update on public.conversas
  for each row execute function private.marcar_atualizacao();
create trigger atendimentos_atualizado_em before update on public.atendimentos
  for each row execute function private.marcar_atualizacao();

-- ---------------------------------------------------------------------------
-- Regras de acesso: só usuário logado e ATIVO lê. Quem grava é a integração
-- (Edge Function com chave de serviço), nunca o site.
-- ---------------------------------------------------------------------------
alter table public.contatos       enable row level security;
alter table public.conversas      enable row level security;
alter table public.atendimentos   enable row level security;
alter table public.mensagens      enable row level security;
alter table public.eventos        enable row level security;
alter table public.sincronizacoes enable row level security;

revoke all on public.contatos, public.conversas, public.atendimentos,
              public.mensagens, public.eventos, public.sincronizacoes
  from anon, authenticated;

grant select on public.contatos, public.conversas, public.atendimentos, public.mensagens
  to authenticated;
grant update (etiquetas, anotacoes) on public.contatos to authenticated;
grant select on public.eventos, public.sincronizacoes to authenticated;

create policy "usuario ativo le contatos" on public.contatos
  for select to authenticated using ((select private.usuario_ativo()));
create policy "usuario ativo edita etiquetas e anotacoes" on public.contatos
  for update to authenticated
  using ((select private.usuario_ativo())) with check ((select private.usuario_ativo()));
create policy "usuario ativo le conversas" on public.conversas
  for select to authenticated using ((select private.usuario_ativo()));
create policy "usuario ativo le atendimentos" on public.atendimentos
  for select to authenticated using ((select private.usuario_ativo()));
create policy "usuario ativo le mensagens" on public.mensagens
  for select to authenticated using ((select private.usuario_ativo()));
create policy "mestre le eventos" on public.eventos
  for select to authenticated using ((select private.eh_mestre()));
create policy "mestre le sincronizacoes" on public.sincronizacoes
  for select to authenticated using ((select private.eh_mestre()));

-- Tela atualiza sozinha (Realtime)
alter publication supabase_realtime add table public.conversas, public.mensagens, public.atendimentos;

-- ---------------------------------------------------------------------------
-- Segredos: o token do GPT Maker fica no Vault (criptografado), fora do código.
-- Só a chave de serviço (usada pela Edge Function) consegue ler.
-- ---------------------------------------------------------------------------
create function public.obter_segredo(nome text)
returns text
language sql stable security definer set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = nome limit 1;
$$;
revoke all on function public.obter_segredo(text) from public, anon, authenticated;
grant execute on function public.obter_segredo(text) to service_role;

-- ---------------------------------------------------------------------------
-- Disparar a sincronização de dentro do banco (o segredo nunca sai daqui).
--   select private.sincronizar_gptmaker();          -- só o que mudou
--   select private.sincronizar_gptmaker(true);      -- reimporta tudo
-- ---------------------------------------------------------------------------
create extension if not exists pg_net with schema extensions;

create function private.sincronizar_gptmaker(completo boolean default false)
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
    url := 'https://agzlflvvpqgtcrajtpnw.supabase.co/functions/v1/gptmaker-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-sync-token', v_segredo),
    body := jsonb_build_object('completo', completo),
    timeout_milliseconds := 120000
  ) into v_id;
  return v_id;
end;
$$;
revoke all on function private.sincronizar_gptmaker(boolean) from public, anon, authenticated;
