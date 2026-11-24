-- Campanhas da Thais: base de conhecimento por campanha de anúncio (o primeiro é
-- o loteamento Atmosphere, da Plaenge). O gestor edita no painel, em
-- Configurações → Campanhas da Thais, sem mexer no código.
--   * O lead é marcado quando o texto do anúncio ou a mensagem do cliente traz uma
--     das palavras da campanha (atendimento.ts); a origem aparece na ficha e
--     dá para filtrar na lista de leads.
--   * A Thais recebe a base, as perguntas, o que não pode e o exemplo da campanha
--     junto com a conversa (agente.ts).

create table if not exists public.campanhas_ia (
  id uuid primary key default gen_random_uuid(),
  nome text not null check (length(trim(nome)) between 2 and 80),
  origem text not null check (length(trim(origem)) between 2 and 80),
  palavras text[] not null default '{}',
  base text not null default '' check (length(base) <= 8000),
  perguntas text[] not null default '{}',
  proibido text not null default '' check (length(proibido) <= 3000),
  exemplo text not null default '' check (length(exemplo) <= 1500),
  ativo boolean not null default true,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.corretores (id) on delete set null
);
alter table public.campanhas_ia enable row level security;
drop policy if exists "Equipe vê as campanhas" on public.campanhas_ia;
create policy "Equipe vê as campanhas" on public.campanhas_ia for select to authenticated
  using (interno.meu_corretor_id() is not null);

alter table public.leads add column if not exists campanha_ia_id uuid references public.campanhas_ia (id) on delete set null;
create index if not exists leads_campanha_ia on public.leads (campanha_ia_id) where campanha_ia_id is not null;

-- Criar ou salvar (gestor e administrativo).
create or replace function public.salvar_campanha_ia(
  p_id uuid, p_nome text, p_origem text, p_palavras text[], p_base text, p_perguntas text[], p_proibido text, p_exemplo text, p_ativo boolean
)
 returns uuid
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_id uuid := p_id;
  v_palavras text[] := (select coalesce(array_agg(distinct lower(trim(p))), '{}') from unnest(coalesce(p_palavras, '{}')) p where length(trim(p)) >= 3);
  v_perguntas text[] := (select coalesce(array_agg(trim(p) order by n), '{}') from unnest(coalesce(p_perguntas, '{}')) with ordinality as x(p, n) where trim(p) <> '');
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor e o administrativo mudam as campanhas da Thais';
  end if;
  if cardinality(v_palavras) = 0 then
    raise exception 'Informe pelo menos uma palavra (com 3 letras ou mais) para reconhecer a campanha';
  end if;
  if v_id is null then
    insert into public.campanhas_ia (nome, origem, palavras, base, perguntas, proibido, exemplo, ativo, atualizado_por)
    values (trim(p_nome), trim(p_origem), v_palavras, coalesce(p_base, ''), v_perguntas, coalesce(p_proibido, ''), coalesce(p_exemplo, ''), coalesce(p_ativo, true), interno.meu_corretor_id())
    returning id into v_id;
  else
    update public.campanhas_ia set
      nome = trim(p_nome), origem = trim(p_origem), palavras = v_palavras, base = coalesce(p_base, ''),
      perguntas = v_perguntas, proibido = coalesce(p_proibido, ''), exemplo = coalesce(p_exemplo, ''),
      ativo = coalesce(p_ativo, true), atualizado_em = now(), atualizado_por = interno.meu_corretor_id()
    where id = v_id;
    if not found then
      raise exception 'Campanha não encontrada';
    end if;
  end if;
  return v_id;
end;
$$;
revoke all on function public.salvar_campanha_ia(uuid, text, text, text[], text, text[], text, text, boolean) from public, anon;
grant execute on function public.salvar_campanha_ia(uuid, text, text, text[], text, text[], text, text, boolean) to authenticated;

-- Atmosphere (Plaenge), com o texto passado pela gestão em 2026-11-24.
insert into public.campanhas_ia (nome, origem, palavras, base, perguntas, proibido, exemplo)
select 'Atmosphere (Plaenge)', 'Facebook Ads – Atmosphere',
  array['atmosphere', 'plaenge', 'chácara dos poderes', 'chacara dos poderes', 'loteamento boutique', 'ide abdul ahad'],
  $base$Atmosphere, da Plaenge: o primeiro loteamento boutique de Campo Grande.
Endereço: Rua Ide Abdul Ahad, Jardim Veraneio / Chácara dos Poderes, Campo Grande/MS.
Lotes residenciais de 250 m² a 450 m².
É possível financiar o lote junto com a construção da casa.
Liberação para início das obras das casas prevista para o início de 2027.
A LFG apresenta projetos prontos de casas térreas modernas e sobrados contemporâneos.
Arquitetura do LW Design Group. Paisagismo da CONDE Urban Design.
Rede elétrica subterrânea, vias pavimentadas e amplas áreas verdes.
Lazer: Club House Sports, piscina adulto e infantil, fitness e outdoor fitness, quadras de beach tennis, padel e poliesportiva, pista de caminhada, sports grill, lounge de festas, kids play, playground, games, empório e lobby com porte-cochère.
Região: perto do Shopping Bosque dos Ipês e da Leroy Merlin, vizinho de condomínios de alto padrão como Lieu Unique e Riviera Home Club. Área em valorização.
Telefone da LFG: (67) 3381-6057.
Site oficial: https://www.plaenge.com.br/campo-grande/atmosphere$base$,
  array[
    'Quer o lote para morar ou para investir?',
    'Pensa em construir logo ou só garantir o lote agora?',
    'Tem interesse em financiar o lote junto com a construção?',
    'Que tamanho de lote imagina: mais perto de 250 m² ou de 450 m²?',
    'Forma de pagamento: à vista, financiamento ou entrada + parcelas?'
  ],
  $proib$Não informe preço, valor de parcela, condição de pagamento, taxa nem quais lotes estão disponíveis: se perguntarem, diga que o corretor passa a tabela atualizada e as condições, e siga com a qualificação.
Não prometa valorização garantida nem prazo de obra diferente do início de 2027.$proib$,
  'Oi, [nome]! Que bom que você se interessou pelo Atmosphere, o loteamento boutique da Plaenge na Chácara dos Poderes. Os lotes vão de 250 a 450 m², e dá pra financiar o lote junto com a construção da casa. Você está pensando em construir para morar ou como investimento?'
where not exists (select 1 from public.campanhas_ia where nome = 'Atmosphere (Plaenge)');
