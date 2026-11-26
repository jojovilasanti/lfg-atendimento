-- Módulo de Locação, Etapa 2: pessoas e imóveis administrados.
--
-- * pessoas: cadastro único de locadores, locatários, fiadores e procuradores,
--   com CPF/CNPJ único (é a checagem de duplicidade), dados bancários e PIX.
--   Liga-se ao proprietário do CRM (proprietario_id) e ao lead (lead_id) sem
--   duplicar. A tabela proprietarios continua como está (o captador vê); os
--   dados sensíveis ficam só aqui, fechados para o corretor.
-- * imoveis_locacao: dados de administração do imóvel (IPTU, matrícula,
--   garantias aceitas). Separado de imoveis porque os do Univen são só leitura.
-- * imovel_locadores: imóvel × pessoa × percentual (soma 100%), com o
--   favorecido do repasse.
-- * origem/origem_codigo: de onde veio o registro (painel ou importação do
--   Unilocweb), para a importação poder rodar de novo sem duplicar.
-- Tudo só para interno.acessa_locacao(); escrita só pelas funções, com auditoria.

-- CPF e CNPJ: só dígitos e dígitos verificadores certos.
create or replace function interno.documento_valido(p_documento text)
 returns boolean
 language plpgsql
 immutable
 set search_path to ''
as $$
declare
  d text := regexp_replace(coalesce(p_documento, ''), '\D', '', 'g');
  soma int;
  resto int;
  i int;
  pesos1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2];
  pesos2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
begin
  if length(d) = 11 then
    if d ~ '^(\d)\1{10}$' then return false; end if;
    soma := 0;
    for i in 1..9 loop soma := soma + substr(d, i, 1)::int * (11 - i); end loop;
    resto := (soma * 10) % 11; if resto = 10 then resto := 0; end if;
    if resto <> substr(d, 10, 1)::int then return false; end if;
    soma := 0;
    for i in 1..10 loop soma := soma + substr(d, i, 1)::int * (12 - i); end loop;
    resto := (soma * 10) % 11; if resto = 10 then resto := 0; end if;
    return resto = substr(d, 11, 1)::int;
  elsif length(d) = 14 then
    if d ~ '^(\d)\1{13}$' then return false; end if;
    soma := 0;
    for i in 1..12 loop soma := soma + substr(d, i, 1)::int * pesos1[i]; end loop;
    resto := soma % 11; resto := case when resto < 2 then 0 else 11 - resto end;
    if resto <> substr(d, 13, 1)::int then return false; end if;
    soma := 0;
    for i in 1..13 loop soma := soma + substr(d, i, 1)::int * pesos2[i]; end loop;
    resto := soma % 11; resto := case when resto < 2 then 0 else 11 - resto end;
    return resto = substr(d, 14, 1)::int;
  end if;
  return false;
end;
$$;

-- Pessoas -----------------------------------------------------------------------
create table if not exists public.pessoas (
  id uuid primary key default gen_random_uuid(),
  tipo text not null check (tipo in ('pf', 'pj')),
  nome text not null check (length(trim(nome)) between 2 and 160),
  nome_fantasia text,
  documento text not null unique check (documento ~ '^\d{11}$|^\d{14}$'),
  rg text,
  rg_orgao text,
  nascimento date,
  estado_civil text check (estado_civil is null or estado_civil in ('solteiro', 'casado', 'uniao_estavel', 'divorciado', 'separado', 'viuvo')),
  regime_bens text,
  nacionalidade text,
  profissao text,
  renda numeric(14,2) check (renda is null or renda >= 0),
  emails text[] not null default '{}',
  telefones text[] not null default '{}',
  cep text,
  logradouro text,
  numero text,
  complemento text,
  bairro text,
  cidade text,
  uf text,
  conjuge_nome text,
  conjuge_documento text,
  conjuge_rg text,
  banco text,
  agencia text,
  conta text,
  conta_tipo text check (conta_tipo is null or conta_tipo in ('corrente', 'poupanca')),
  pix_tipo text check (pix_tipo is null or pix_tipo in ('cpf_cnpj', 'telefone', 'email', 'aleatoria')),
  pix_chave text,
  papeis text[] not null default '{}' check (papeis <@ array['locador', 'locatario', 'fiador', 'procurador']::text[]),
  observacoes text,
  arquivada boolean not null default false,
  proprietario_id uuid references public.proprietarios (id) on delete set null,
  lead_id uuid references public.leads (id) on delete set null,
  origem text not null default 'painel' check (origem in ('painel', 'unilocweb')),
  origem_codigo text,
  criado_por uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  -- Completo: o que todo contrato precisa; o locador precisa também de banco ou PIX.
  cadastro_completo boolean generated always as (
    documento is not null and length(trim(nome)) >= 2
    and coalesce(cardinality(telefones), 0) + coalesce(cardinality(emails), 0) > 0
    and cep is not null and logradouro is not null and numero is not null and cidade is not null and uf is not null
    and (tipo = 'pj' or rg is not null)
    and (not ('locador' = any (papeis)) or pix_chave is not null or (banco is not null and agencia is not null and conta is not null))
  ) stored
);
create unique index if not exists pessoas_origem on public.pessoas (origem, origem_codigo) where origem_codigo is not null;
create index if not exists pessoas_nome on public.pessoas (lower(nome));
create index if not exists pessoas_proprietario on public.pessoas (proprietario_id) where proprietario_id is not null;
alter table public.pessoas enable row level security;
revoke all on public.pessoas from anon;
drop policy if exists "Gestão vê as pessoas da locação" on public.pessoas;
create policy "Gestão vê as pessoas da locação" on public.pessoas for select to authenticated
  using ((select interno.acessa_locacao()));
drop trigger if exists pessoas_auditoria on public.pessoas;
create trigger pessoas_auditoria after insert or update or delete on public.pessoas
  for each row execute function interno.auditar_locacao();

-- Cria ou altera uma pessoa. p_dados traz os campos do formulário (texto).
create or replace function public.salvar_pessoa(p_id uuid, p_dados jsonb)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_doc text := regexp_replace(coalesce(p_dados ->> 'documento', ''), '\D', '', 'g');
  v_tipo text;
  v_id uuid;
  v_outro uuid;
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  if not interno.documento_valido(v_doc) then
    raise exception 'CPF ou CNPJ inválido';
  end if;
  v_tipo := case when length(v_doc) = 11 then 'pf' else 'pj' end;
  select id into v_outro from public.pessoas where documento = v_doc and id is distinct from p_id;
  if v_outro is not null then
    raise exception 'Já existe uma pessoa com esse CPF/CNPJ';
  end if;
  if length(trim(coalesce(p_dados ->> 'nome', ''))) < 2 then
    raise exception 'Informe o nome';
  end if;
  if nullif(trim(p_dados ->> 'conjuge_documento'), '') is not null and not interno.documento_valido(p_dados ->> 'conjuge_documento') then
    raise exception 'CPF do cônjuge inválido';
  end if;

  if p_id is null then
    insert into public.pessoas (tipo, nome, documento, criado_por) values (v_tipo, trim(p_dados ->> 'nome'), v_doc, interno.meu_corretor_id())
    returning id into v_id;
  else
    select id into v_id from public.pessoas where id = p_id for update;
    if v_id is null then
      raise exception 'Pessoa não encontrada';
    end if;
  end if;

  update public.pessoas set
    tipo = v_tipo,
    documento = v_doc,
    nome = trim(p_dados ->> 'nome'),
    nome_fantasia = nullif(trim(p_dados ->> 'nome_fantasia'), ''),
    rg = nullif(trim(p_dados ->> 'rg'), ''),
    rg_orgao = nullif(trim(p_dados ->> 'rg_orgao'), ''),
    nascimento = nullif(p_dados ->> 'nascimento', '')::date,
    estado_civil = nullif(p_dados ->> 'estado_civil', ''),
    regime_bens = nullif(trim(p_dados ->> 'regime_bens'), ''),
    nacionalidade = nullif(trim(p_dados ->> 'nacionalidade'), ''),
    profissao = nullif(trim(p_dados ->> 'profissao'), ''),
    renda = nullif(p_dados ->> 'renda', '')::numeric,
    emails = coalesce((select array_agg(lower(trim(x))) from jsonb_array_elements_text(coalesce(p_dados -> 'emails', '[]')) x where trim(x) <> ''), '{}'),
    telefones = coalesce((select array_agg(trim(x)) from jsonb_array_elements_text(coalesce(p_dados -> 'telefones', '[]')) x where trim(x) <> ''), '{}'),
    cep = nullif(regexp_replace(coalesce(p_dados ->> 'cep', ''), '\D', '', 'g'), ''),
    logradouro = nullif(trim(p_dados ->> 'logradouro'), ''),
    numero = nullif(trim(p_dados ->> 'numero'), ''),
    complemento = nullif(trim(p_dados ->> 'complemento'), ''),
    bairro = nullif(trim(p_dados ->> 'bairro'), ''),
    cidade = nullif(trim(p_dados ->> 'cidade'), ''),
    uf = upper(nullif(trim(p_dados ->> 'uf'), '')),
    conjuge_nome = nullif(trim(p_dados ->> 'conjuge_nome'), ''),
    conjuge_documento = nullif(regexp_replace(coalesce(p_dados ->> 'conjuge_documento', ''), '\D', '', 'g'), ''),
    conjuge_rg = nullif(trim(p_dados ->> 'conjuge_rg'), ''),
    banco = nullif(trim(p_dados ->> 'banco'), ''),
    agencia = nullif(trim(p_dados ->> 'agencia'), ''),
    conta = nullif(trim(p_dados ->> 'conta'), ''),
    conta_tipo = nullif(p_dados ->> 'conta_tipo', ''),
    pix_tipo = nullif(p_dados ->> 'pix_tipo', ''),
    pix_chave = nullif(trim(p_dados ->> 'pix_chave'), ''),
    papeis = coalesce((select array_agg(distinct x) from jsonb_array_elements_text(coalesce(p_dados -> 'papeis', '[]')) x), '{}'),
    observacoes = nullif(trim(p_dados ->> 'observacoes'), ''),
    proprietario_id = coalesce(nullif(p_dados ->> 'proprietario_id', '')::uuid, proprietario_id),
    lead_id = coalesce(nullif(p_dados ->> 'lead_id', '')::uuid, lead_id),
    atualizado_em = now()
  where id = v_id;
  return v_id;
end;
$$;
revoke all on function public.salvar_pessoa(uuid, jsonb) from public, anon;
grant execute on function public.salvar_pessoa(uuid, jsonb) to authenticated;

create or replace function public.arquivar_pessoa(p_id uuid, p_arquivada boolean)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  update public.pessoas set arquivada = coalesce(p_arquivada, true), atualizado_em = now() where id = p_id;
  if not found then
    raise exception 'Pessoa não encontrada';
  end if;
end;
$$;
revoke all on function public.arquivar_pessoa(uuid, boolean) from public, anon;
grant execute on function public.arquivar_pessoa(uuid, boolean) to authenticated;

-- Imóveis administrados ---------------------------------------------------------
create table if not exists public.imoveis_locacao (
  imovel_codigo text primary key references public.imoveis (codigo) on update cascade,
  iptu_inscricao text,
  iptu_valor numeric(14,2) check (iptu_valor is null or iptu_valor >= 0),
  iptu_forma text check (iptu_forma is null or iptu_forma in ('a_vista', 'parcelado', 'isento')),
  iptu_responsavel text check (iptu_responsavel is null or iptu_responsavel in ('locatario', 'locador', 'imobiliaria')),
  matricula text,
  cartorio text,
  condominio_administradora text,
  condominio_valor numeric(14,2) check (condominio_valor is null or condominio_valor >= 0),
  garantias_aceitas text[] not null default '{}' check (garantias_aceitas <@ array['fiador', 'seguro_fianca_vista', 'seguro_fianca_parcelado', 'deposito', 'caucao', 'cartao_credito', 'titulo_capitalizacao', 'carta_fianca']::text[]),
  observacoes text,
  origem text not null default 'painel' check (origem in ('painel', 'unilocweb')),
  origem_codigo text,
  criado_por uuid references public.corretores (id) on delete set null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
alter table public.imoveis_locacao enable row level security;
revoke all on public.imoveis_locacao from anon;
drop policy if exists "Gestão vê os imóveis administrados" on public.imoveis_locacao;
create policy "Gestão vê os imóveis administrados" on public.imoveis_locacao for select to authenticated
  using ((select interno.acessa_locacao()));
drop trigger if exists imoveis_locacao_auditoria on public.imoveis_locacao;
create trigger imoveis_locacao_auditoria after insert or update or delete on public.imoveis_locacao
  for each row execute function interno.auditar_locacao();

create table if not exists public.imovel_locadores (
  id uuid primary key default gen_random_uuid(),
  imovel_codigo text not null references public.imoveis_locacao (imovel_codigo) on delete cascade on update cascade,
  pessoa_id uuid not null references public.pessoas (id),
  percentual numeric(7,4) not null check (percentual > 0 and percentual <= 100),
  favorecido_id uuid references public.pessoas (id),
  criado_em timestamptz not null default now(),
  unique (imovel_codigo, pessoa_id)
);
create index if not exists imovel_locadores_pessoa on public.imovel_locadores (pessoa_id);
alter table public.imovel_locadores enable row level security;
revoke all on public.imovel_locadores from anon;
drop policy if exists "Gestão vê os locadores" on public.imovel_locadores;
create policy "Gestão vê os locadores" on public.imovel_locadores for select to authenticated
  using ((select interno.acessa_locacao()));
drop trigger if exists imovel_locadores_auditoria on public.imovel_locadores;
create trigger imovel_locadores_auditoria after insert or update or delete on public.imovel_locadores
  for each row execute function interno.auditar_locacao();

-- Salva os dados de administração e a lista inteira de locadores do imóvel.
-- p_locadores: [{pessoa_id, percentual, favorecido_id}]; a soma tem que dar 100.
create or replace function public.salvar_imovel_locacao(p_codigo text, p_dados jsonb, p_locadores jsonb)
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_soma numeric;
  v_qtd int;
begin
  if not interno.acessa_locacao() then
    raise exception 'Sem acesso à Locação';
  end if;
  if not exists (select 1 from public.imoveis where codigo = p_codigo) then
    raise exception 'Imóvel não encontrado';
  end if;
  if jsonb_typeof(coalesce(p_locadores, '[]')) <> 'array' then
    raise exception 'Lista de locadores inválida';
  end if;
  select coalesce(sum((x ->> 'percentual')::numeric), 0), count(*) into v_soma, v_qtd from jsonb_array_elements(coalesce(p_locadores, '[]')) x;
  if v_qtd > 0 and v_soma <> 100 then
    raise exception 'A soma dos percentuais dos locadores tem que dar 100 (está em %)', v_soma;
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_locadores, '[]')) x
             where not exists (select 1 from public.pessoas p where p.id = (x ->> 'pessoa_id')::uuid)
                or (nullif(x ->> 'favorecido_id', '') is not null and not exists (select 1 from public.pessoas p where p.id = (x ->> 'favorecido_id')::uuid))) then
    raise exception 'Locador ou favorecido não encontrado';
  end if;
  if (select count(distinct x ->> 'pessoa_id') from jsonb_array_elements(coalesce(p_locadores, '[]')) x) <> v_qtd then
    raise exception 'A mesma pessoa aparece duas vezes nos locadores';
  end if;

  insert into public.imoveis_locacao (imovel_codigo, criado_por) values (p_codigo, interno.meu_corretor_id())
  on conflict (imovel_codigo) do nothing;
  update public.imoveis_locacao set
    iptu_inscricao = nullif(trim(p_dados ->> 'iptu_inscricao'), ''),
    iptu_valor = nullif(p_dados ->> 'iptu_valor', '')::numeric,
    iptu_forma = nullif(p_dados ->> 'iptu_forma', ''),
    iptu_responsavel = nullif(p_dados ->> 'iptu_responsavel', ''),
    matricula = nullif(trim(p_dados ->> 'matricula'), ''),
    cartorio = nullif(trim(p_dados ->> 'cartorio'), ''),
    condominio_administradora = nullif(trim(p_dados ->> 'condominio_administradora'), ''),
    condominio_valor = nullif(p_dados ->> 'condominio_valor', '')::numeric,
    garantias_aceitas = coalesce((select array_agg(distinct g) from jsonb_array_elements_text(coalesce(p_dados -> 'garantias_aceitas', '[]')) g), '{}'),
    observacoes = nullif(trim(p_dados ->> 'observacoes'), ''),
    atualizado_em = now()
  where imovel_codigo = p_codigo;

  -- Troca a lista de locadores pela nova (só o que mudou gera auditoria).
  delete from public.imovel_locadores l
  where l.imovel_codigo = p_codigo
    and not exists (select 1 from jsonb_array_elements(coalesce(p_locadores, '[]')) x where (x ->> 'pessoa_id')::uuid = l.pessoa_id);
  insert into public.imovel_locadores (imovel_codigo, pessoa_id, percentual, favorecido_id)
  select p_codigo, (x ->> 'pessoa_id')::uuid, (x ->> 'percentual')::numeric, nullif(x ->> 'favorecido_id', '')::uuid
  from jsonb_array_elements(coalesce(p_locadores, '[]')) x
  on conflict (imovel_codigo, pessoa_id) do update set
    percentual = excluded.percentual, favorecido_id = excluded.favorecido_id
  where imovel_locadores.percentual is distinct from excluded.percentual or imovel_locadores.favorecido_id is distinct from excluded.favorecido_id;

  -- Quem é locador de um imóvel ganha o papel de locador.
  update public.pessoas p set papeis = array_append(p.papeis, 'locador'), atualizado_em = now()
  where p.id in (select (x ->> 'pessoa_id')::uuid from jsonb_array_elements(coalesce(p_locadores, '[]')) x)
    and not ('locador' = any (p.papeis));
end;
$$;
revoke all on function public.salvar_imovel_locacao(text, jsonb, jsonb) from public, anon;
grant execute on function public.salvar_imovel_locacao(text, jsonb, jsonb) to authenticated;
