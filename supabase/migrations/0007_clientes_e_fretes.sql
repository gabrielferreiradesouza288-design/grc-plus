-- GRC + · Clientes que fecharam frete (cadastro manual feito pela equipe) e os fretes de cada um.
-- Permissões novas: "clientes" (ver) e "editar_clientes" (cadastrar, alterar e excluir).

create table public.clientes (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null check (length(trim(nome)) > 0),
  documento     text,                          -- CPF ou CNPJ
  telefone      text,
  email         text,
  cidade        text,
  uf            text check (uf is null or uf ~ '^[A-Z]{2}$'),
  observacoes   text not null default '',
  contato_id    text references public.contatos (id) on delete set null,  -- contato do WhatsApp de origem, se houver
  criado_por    uuid default auth.uid() references public.usuarios (id) on delete set null,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index on public.clientes (lower(nome));

create table public.fretes (
  id              uuid primary key default gen_random_uuid(),
  cliente_id      uuid not null references public.clientes (id) on delete cascade,
  data_fechamento date not null default current_date,
  origem          text,
  destino         text,
  valor           numeric(12, 2) check (valor is null or valor >= 0),
  descricao       text not null default '',    -- tipo de carga, combinados etc.
  criado_por      uuid default auth.uid() references public.usuarios (id) on delete set null,
  criado_em       timestamptz not null default now()
);
create index on public.fretes (cliente_id, data_fechamento desc);

create trigger clientes_atualizado_em before update on public.clientes
  for each row execute function private.marcar_atualizacao();

alter table public.clientes enable row level security;
alter table public.fretes enable row level security;

revoke all on public.clientes, public.fretes from anon, authenticated;
grant select, insert, update, delete on public.clientes, public.fretes to authenticated;

create policy "ve clientes quem tem permissao" on public.clientes
  for select to authenticated using ((select private.pode('clientes')));
create policy "cadastra clientes quem tem permissao" on public.clientes
  for insert to authenticated with check ((select private.pode('editar_clientes')));
create policy "altera clientes quem tem permissao" on public.clientes
  for update to authenticated
  using ((select private.pode('editar_clientes'))) with check ((select private.pode('editar_clientes')));
create policy "exclui clientes quem tem permissao" on public.clientes
  for delete to authenticated using ((select private.pode('editar_clientes')));

create policy "ve fretes quem tem permissao" on public.fretes
  for select to authenticated using ((select private.pode('clientes')));
create policy "cadastra fretes quem tem permissao" on public.fretes
  for insert to authenticated with check ((select private.pode('editar_clientes')));
create policy "altera fretes quem tem permissao" on public.fretes
  for update to authenticated
  using ((select private.pode('editar_clientes'))) with check ((select private.pode('editar_clientes')));
create policy "exclui fretes quem tem permissao" on public.fretes
  for delete to authenticated using ((select private.pode('editar_clientes')));
