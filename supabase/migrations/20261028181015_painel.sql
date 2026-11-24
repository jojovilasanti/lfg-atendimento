-- Painel da equipe: prévia da última mensagem, tempo real e ações de
-- corretor e gestor. As regras de acesso (RLS) continuam valendo.

-- Prévia da última mensagem para a lista de leads -----------------------------

alter table public.leads
  add column ultima_mensagem text,
  add column ultima_mensagem_autor public.mensagem_autor,
  add column ultima_mensagem_em timestamptz;

create function interno.registrar_ultima_mensagem() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.autor <> 'sistema' then
    update public.leads
    set ultima_mensagem = left(new.conteudo, 160),
        ultima_mensagem_autor = new.autor,
        ultima_mensagem_em = new.criado_em
    where id = new.lead_id;
  end if;
  return new;
end;
$$;

create trigger mensagens_ultima_do_lead
  after insert on public.mensagens
  for each row execute function interno.registrar_ultima_mensagem();

update public.leads l
set ultima_mensagem = left(m.conteudo, 160), ultima_mensagem_autor = m.autor, ultima_mensagem_em = m.criado_em
from (
  select distinct on (lead_id) lead_id, conteudo, autor, criado_em
  from public.mensagens where autor <> 'sistema'
  order by lead_id, id desc
) m
where m.lead_id = l.id;

create index leads_ultima_mensagem_idx on public.leads (ultima_mensagem_em desc nulls last);

-- Tempo real: o painel atualiza sozinho quando chega mensagem ou muda o rodízio.
alter publication supabase_realtime add table public.leads, public.mensagens, public.atribuicoes, public.corretores;

-- Ações -----------------------------------------------------------------------

-- O corretor liga ou desliga o próprio plantão (o gestor muda o de qualquer um
-- direto na tabela, pela regra "Gestor altera a equipe").
create function public.definir_meu_plantao(p_de_plantao boolean) returns public.corretores
language sql security definer set search_path = ''
as $$
  update public.corretores set de_plantao = p_de_plantao
  where id = interno.meu_corretor_id()
  returning *;
$$;

-- Liga ou pausa a IA num lead: o corretor dono do lead ou o gestor.
create function public.definir_ia_do_lead(p_lead_id uuid, p_ativa boolean) returns public.leads
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead public.leads;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not (interno.sou_gestor() or v_lead.corretor_id = interno.meu_corretor_id()) then
    raise exception 'Só o corretor do lead ou o gestor podem mudar a IA deste lead';
  end if;
  update public.leads set ia_ativa = p_ativa where id = p_lead_id returning * into v_lead;
  return v_lead;
end;
$$;

-- Números do mês para a tela inicial. Roda com as regras de acesso de quem
-- pede: o gestor vê a imobiliária toda, o corretor vê os leads dele.
create function public.painel_resumo(p_desde timestamptz) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with leads_periodo as (
    select * from public.leads where criado_em >= p_desde and whatsapp not like 'sim-%'
  ),
  respostas as (
    select extract(epoch from (ia.criado_em - cli.criado_em)) as segundos
    from public.mensagens ia
    join lateral (
      select c.criado_em from public.mensagens c
      where c.lead_id = ia.lead_id and c.autor = 'cliente' and c.id < ia.id
      order by c.id desc limit 1
    ) cli on true
    join leads_periodo l on l.id = ia.lead_id
    where ia.autor = 'ia'
  ),
  assumidas as (
    select extract(epoch from (a.respondida_em - a.oferecida_em)) as segundos
    from public.atribuicoes a
    join leads_periodo l on l.id = a.lead_id
    where a.status = 'aceita'
  )
  select jsonb_build_object(
    'leads', (select count(*) from leads_periodo),
    'qualificados', (select count(*) from leads_periodo where interesse is not null and ficha ? 'regiao' and (ficha ? 'orcamento_max' or ficha ? 'orcamento_min')),
    'passados', (select count(distinct a.lead_id) from public.atribuicoes a join leads_periodo l on l.id = a.lead_id),
    'assumidos', (select count(*) from leads_periodo where status = 'com_corretor'),
    'aguardando', (select count(*) from public.leads where status = 'aguardando_corretor' and whatsapp not like 'sim-%'),
    'prazos_vencidos', (select count(*) from public.atribuicoes a join leads_periodo l on l.id = a.lead_id where a.status = 'expirada'),
    'quentes', (select count(*) from leads_periodo where temperatura = 'quente'),
    'resposta_ia_segundos', (select round(avg(segundos)::numeric, 1) from respostas),
    'assumir_segundos', (select round(avg(segundos)::numeric, 0) from assumidas)
  );
$$;

revoke execute on function public.definir_meu_plantao(boolean) from public, anon;
revoke execute on function public.definir_ia_do_lead(uuid, boolean) from public, anon;
revoke execute on function public.painel_resumo(timestamptz) from public, anon;
grant execute on function public.definir_meu_plantao(boolean) to authenticated;
grant execute on function public.definir_ia_do_lead(uuid, boolean) to authenticated;
grant execute on function public.painel_resumo(timestamptz) to authenticated;
