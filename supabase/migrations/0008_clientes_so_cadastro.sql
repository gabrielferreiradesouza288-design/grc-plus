-- GRC + · Clientes passa a ser só o cadastro de quem fechou frete (sem registro de cada frete).
-- Campos: nome, CNPJ, endereço, contato (telefone e e-mail) e pessoa de contato.
drop table public.fretes;

alter table public.clientes
  add column endereco text,
  add column pessoa_contato text,
  drop column cidade,
  drop column uf;
