-- GRC + · Leads convertidos.
-- Quando a equipe cadastra um cliente ligado a um contato do WhatsApp, as conversas desse contato
-- ficam marcadas como "convertido" e o Funil as mostra na coluna Leads convertidos.

alter table public.conversas add column convertido boolean not null default false;

-- Só os números do telefone, sem o 55 do Brasil na frente (para comparar cadastro manual com o WhatsApp)
create function private.telefone_base(p text)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when length(d) >= 12 and left(d, 2) = '55' then substr(d, 3)
    else d
  end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x;
$$;

-- Cliente cadastrado à mão, sem vínculo: tenta achar o contato do WhatsApp pelo telefone
create function private.vincular_cliente_ao_contato()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.contato_id is null and length(private.telefone_base(new.telefone)) >= 10 then
    select c.id into new.contato_id
    from public.contatos c
    where private.telefone_base(c.telefone) = private.telefone_base(new.telefone)
    limit 1;
  end if;
  return new;
end;
$$;

create trigger clientes_vincular_contato
  before insert or update of telefone, contato_id on public.clientes
  for each row execute function private.vincular_cliente_ao_contato();

-- Mantém conversas.convertido em dia quando um cliente é criado, alterado ou excluído
create function private.atualizar_convertido()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_contatos text[];
begin
  v_contatos := array_remove(array[
    case when tg_op <> 'INSERT' then old.contato_id end,
    case when tg_op <> 'DELETE' then new.contato_id end
  ], null);

  update public.conversas cv
  set convertido = exists (select 1 from public.clientes cl where cl.contato_id = cv.contato_id)
  where cv.contato_id = any (v_contatos)
    and cv.convertido is distinct from exists (select 1 from public.clientes cl where cl.contato_id = cv.contato_id);
  return null;
end;
$$;

create trigger clientes_atualizar_convertido
  after insert or delete or update of contato_id on public.clientes
  for each row execute function private.atualizar_convertido();

-- Conversa nova de quem já é cliente já nasce marcada
create function private.marcar_conversa_de_cliente()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.convertido := new.contato_id is not null
    and exists (select 1 from public.clientes cl where cl.contato_id = new.contato_id);
  return new;
end;
$$;

create trigger conversas_marcar_convertido
  before insert on public.conversas
  for each row execute function private.marcar_conversa_de_cliente();

-- Clientes que já estavam cadastrados: vincula pelo telefone e marca as conversas
update public.clientes set contato_id = contato_id where contato_id is null;
update public.conversas cv set convertido = true
where exists (select 1 from public.clientes cl where cl.contato_id = cv.contato_id);

revoke all on function private.telefone_base(text) from public, anon, authenticated;
revoke all on function private.vincular_cliente_ao_contato() from public, anon, authenticated;
revoke all on function private.atualizar_convertido() from public, anon, authenticated;
revoke all on function private.marcar_conversa_de_cliente() from public, anon, authenticated;
