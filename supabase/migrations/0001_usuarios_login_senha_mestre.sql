-- GRC + · Etapa 1 do banco: usuários, login e senha mestre
-- O login (e-mail + senha) é feito pelo Supabase Auth (tabela auth.users).
-- Aqui ficam o perfil de cada usuário, o papel (mestre ou usuário) e a senha mestre.

-- Schema "private": não é exposto pela API, só o banco enxerga.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Perfis da equipe
-- ---------------------------------------------------------------------------
create table public.usuarios (
  id            uuid primary key references auth.users (id) on delete cascade,
  email         text not null,
  nome          text not null default '',
  papel         text not null default 'usuario' check (papel in ('mestre', 'usuario')),
  ativo         boolean not null default false,  -- novo cadastro fica pendente até um mestre liberar
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table public.usuarios is 'Perfis da equipe do GRC +, vinculados ao login do Supabase Auth.';

-- ---------------------------------------------------------------------------
-- Senha mestre (guardada só como hash bcrypt) e registro de tentativas
-- ---------------------------------------------------------------------------
create table private.configuracao (
  chave         text primary key,
  valor         text not null,
  atualizado_em timestamptz not null default now()
);

create table private.tentativas_senha_mestre (
  id         bigint generated always as identity primary key,
  usuario_id uuid not null,
  sucesso    boolean not null,
  criado_em  timestamptz not null default now()
);
create index on private.tentativas_senha_mestre (usuario_id, criado_em desc);

alter table private.configuracao enable row level security;
alter table private.tentativas_senha_mestre enable row level security;

-- ---------------------------------------------------------------------------
-- Funções auxiliares (usadas nas regras de acesso)
-- ---------------------------------------------------------------------------
create function private.eh_mestre()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios
    where id = (select auth.uid()) and papel = 'mestre' and ativo
  );
$$;

create function private.usuario_ativo()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.usuarios
    where id = (select auth.uid()) and ativo
  );
$$;

revoke all on function private.eh_mestre() from public, anon;
revoke all on function private.usuario_ativo() from public, anon;
grant execute on function private.eh_mestre() to authenticated;
grant execute on function private.usuario_ativo() to authenticated;

-- ---------------------------------------------------------------------------
-- Cria o perfil automaticamente quando alguém se cadastra no Auth
-- ---------------------------------------------------------------------------
create function private.criar_perfil_usuario()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.usuarios (id, email, nome)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'nome', ''));
  return new;
end;
$$;
revoke all on function private.criar_perfil_usuario() from public, anon, authenticated;

create trigger ao_criar_usuario_auth
  after insert on auth.users
  for each row execute function private.criar_perfil_usuario();

create function private.marcar_atualizacao()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

create trigger usuarios_atualizado_em
  before update on public.usuarios
  for each row execute function private.marcar_atualizacao();

-- ---------------------------------------------------------------------------
-- Definir / trocar a senha mestre
-- Só roda pelo SQL Editor do Supabase (administrador). A API não tem acesso.
--   select private.definir_senha_mestre('sua-senha-aqui');
-- ---------------------------------------------------------------------------
create function private.definir_senha_mestre(nova_senha text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if nova_senha is null or length(nova_senha) < 8 then
    raise exception 'A senha mestre precisa ter pelo menos 8 caracteres.';
  end if;

  insert into private.configuracao (chave, valor)
  values ('senha_mestre_hash', extensions.crypt(nova_senha, extensions.gen_salt('bf', 10)))
  on conflict (chave) do update
    set valor = excluded.valor, atualizado_em = now();
end;
$$;
revoke all on function private.definir_senha_mestre(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tornar-se usuário mestre: o usuário logado informa a senha mestre.
-- Retorna true se virou mestre, false se a senha estiver errada.
-- Bloqueia após 5 erros em 15 minutos.
-- ---------------------------------------------------------------------------
create function public.tornar_mestre(senha_mestre text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_hash  text;
  v_erros int;
  v_ok    boolean;
begin
  if v_uid is null then
    raise exception 'É preciso estar logado.';
  end if;

  select valor into v_hash from private.configuracao where chave = 'senha_mestre_hash';
  if v_hash is null then
    raise exception 'A senha mestre ainda não foi definida.';
  end if;

  select count(*) into v_erros
  from private.tentativas_senha_mestre
  where usuario_id = v_uid and not sucesso and criado_em > now() - interval '15 minutes';
  if v_erros >= 5 then
    raise exception 'Muitas tentativas erradas. Aguarde 15 minutos.';
  end if;

  v_ok := senha_mestre is not null and extensions.crypt(senha_mestre, v_hash) = v_hash;

  insert into private.tentativas_senha_mestre (usuario_id, sucesso) values (v_uid, v_ok);

  if v_ok then
    update public.usuarios set papel = 'mestre', ativo = true where id = v_uid;
  end if;

  return v_ok;
end;
$$;
revoke all on function public.tornar_mestre(text) from public, anon;
grant execute on function public.tornar_mestre(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Regras de acesso (RLS)
-- ---------------------------------------------------------------------------
alter table public.usuarios enable row level security;

revoke all on public.usuarios from anon, authenticated;
grant select on public.usuarios to authenticated;
grant update (nome, papel, ativo) on public.usuarios to authenticated;

-- Cada um vê o próprio perfil; o mestre vê todos.
create policy "ver proprio perfil ou todos se mestre"
  on public.usuarios for select to authenticated
  using (id = (select auth.uid()) or (select private.eh_mestre()));

-- Só o mestre altera perfis (liberar acesso, mudar papel, corrigir nome).
create policy "mestre gerencia usuarios"
  on public.usuarios for update to authenticated
  using ((select private.eh_mestre()))
  with check ((select private.eh_mestre()));
