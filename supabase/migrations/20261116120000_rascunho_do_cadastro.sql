-- Rascunho automático do cadastro de imóvel: um por pessoa, só ela lê.
-- Guarda tudo o que foi preenchido (desde a 1ª etapa, antes de o imóvel existir)
-- e a etapa em que a pessoa parou. Quando o imóvel já foi criado como rascunho,
-- `codigo` aponta para ele (fotos e proprietário ficam ligados ao imóvel).
create table public.rascunhos_imovel (
  corretor_id uuid primary key references public.corretores (id) on delete cascade,
  codigo text references public.imoveis (codigo) on delete set null,
  campos jsonb not null default '{}'::jsonb,
  etapa integer not null default 0 check (etapa between 0 and 20),
  atualizado_em timestamptz not null default now()
);

alter table public.rascunhos_imovel enable row level security;

create policy "Cada um mexe só no seu rascunho" on public.rascunhos_imovel
  for all to authenticated
  using (corretor_id = (select interno.meu_corretor_id()))
  with check (corretor_id = (select interno.meu_corretor_id()));

grant select, insert, update, delete on public.rascunhos_imovel to authenticated;

-- Quem começou o imóvel. Rascunho só aparece para essa pessoa.
alter table public.imoveis add column rascunho_de uuid references public.corretores (id) on delete set null;

-- Os rascunhos que já existem ficam com o captador deles.
update public.imoveis i
set rascunho_de = c.id
from public.corretores c
where i.origem = 'proprio' and i.situacao = 'rascunho' and i.rascunho_de is null
  and lower(coalesce(c.nome_no_univen, c.nome)) = lower(i.captador);

drop policy "Equipe vê o estoque" on public.imoveis;
create policy "Equipe vê o estoque" on public.imoveis
  for select to authenticated
  using (
    (select interno.meu_corretor_id()) is not null
    and (situacao is distinct from 'rascunho' or rascunho_de = (select interno.meu_corretor_id()))
  );

-- salvar_imovel passa a anotar quem criou o imóvel.
do $$
declare
  d text := pg_get_functiondef('public.salvar_imovel'::regproc);
  antes text := d;
begin
  d := replace(d, 'insert into public.imoveis (codigo, referencia, origem, situacao, tipo, captador)',
                  'insert into public.imoveis (codigo, referencia, origem, situacao, tipo, captador, rascunho_de)');
  d := replace(d, $x$values (v_codigo, v_referencia, 'proprio', 'rascunho', v_tipo, v_captador);$x$,
                  $x$values (v_codigo, v_referencia, 'proprio', 'rascunho', v_tipo, v_captador, v_eu);$x$);
  if d = antes or position('v_captador, v_eu)' in d) = 0 then
    raise exception 'salvar_imovel mudou: ajuste esta migração';
  end if;
  execute d;
end $$;
