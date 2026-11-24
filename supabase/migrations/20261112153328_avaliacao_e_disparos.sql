-- 1) Pedido de avaliação no Google quando o atendimento é encerrado.
-- 2) Disparo em massa (só gestor), dentro das regras da Meta e da LGPD.

-- ---------------------------------------------------------------- avaliação
insert into public.configuracoes (chave, valor) values ('avaliacao', jsonb_build_object(
  'ativa', true,
  'texto', E'Obrigado pelo contato com a LFG Imóveis! Se puder avaliar nosso atendimento. 🙂⭐⭐⭐⭐⭐\n\nhttps://g.page/r/CT35vbnoqX1fEAE/review',
  'modelo', 'avaliacao_atendimento',
  'intervalo_dias', 90,
  'motivos_sem_avaliacao', jsonb_build_array('Não é cliente (engano, robô ou spam)', 'Contato inválido')
)) on conflict (chave) do nothing;

-- Atendimento encerrado (Finalizar cliente, Fechado ou Perdido): registra o
-- pedido de avaliação, que a função "avisos" envia ao cliente.
create function interno.pedir_avaliacao() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_cfg jsonb := (select c.valor from public.configuracoes c where c.chave = 'avaliacao');
begin
  if v_cfg is null or not coalesce((v_cfg ->> 'ativa')::boolean, false) then
    return null;
  end if;
  if new.motivo_perda is not null and (v_cfg -> 'motivos_sem_avaliacao') ? new.motivo_perda then
    return null;
  end if;
  if exists (
    select 1 from public.mensagens m
    where m.lead_id = new.id and m.tipo = 'avaliacao'
      and m.criado_em > now() - make_interval(days => coalesce((v_cfg ->> 'intervalo_dias')::integer, 90))
  ) then
    return null;
  end if;
  insert into public.mensagens (lead_id, autor, tipo, conteudo, status_entrega)
  values (new.id, 'ia', 'avaliacao', v_cfg ->> 'texto', 'pendente');
  return null;
end;
$$;

create trigger leads_pedir_avaliacao
after update of status on public.leads
for each row when (new.status = 'encerrado' and old.status is distinct from 'encerrado')
execute function interno.pedir_avaliacao();

-- O mesmo gatilho que envia o aviso de fila passa a enviar a avaliação.
drop trigger mensagens_enviar_acompanhamento on public.mensagens;
create trigger mensagens_enviar_acompanhamento
after insert on public.mensagens
for each row when (new.tipo in ('acompanhamento', 'avaliacao'))
execute function interno.enviar_acompanhamento();

-- ---------------------------------------------------------------- disparos
insert into public.configuracoes (chave, valor)
values ('disparos', '{"limite_dia": 200, "por_minuto": 20, "custo_usd": 0.0625}'::jsonb)
on conflict (chave) do nothing;

-- Quem pediu para não receber mais (botão "Não quero receber", SAIR ou PARAR).
-- Fica para sempre, para a escolha ser respeitada.
create table public.descadastros (
  telefone text primary key,
  origem text not null default 'botao',
  criado_em timestamptz not null default now()
);

create table public.campanhas (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  modelo text not null,
  idioma text not null default 'pt_BR',
  texto text,
  usa_nome boolean not null default false,
  status text not null default 'rascunho' check (status in ('rascunho', 'enviando', 'pausada', 'concluida', 'cancelada')),
  motivo_pausa text,
  consentimento_confirmado boolean not null default false,
  criado_por uuid references public.corretores(id),
  criado_em timestamptz not null default now(),
  iniciada_em timestamptz,
  concluida_em timestamptz
);

create table public.campanha_destinatarios (
  id bigint generated always as identity primary key,
  campanha_id uuid not null references public.campanhas(id) on delete cascade,
  telefone text not null,
  nome text,
  status text not null default 'na_fila'
    check (status in ('na_fila', 'enviado', 'entregue', 'lido', 'respondeu', 'falhou', 'descadastrado', 'ignorado')),
  whatsapp_id text,
  erro text,
  enviado_em timestamptz,
  atualizado_em timestamptz not null default now(),
  anonimizado boolean not null default false,
  unique (campanha_id, telefone)
);
create index campanha_destinatarios_whatsapp_id on public.campanha_destinatarios (whatsapp_id) where whatsapp_id is not null;
create index campanha_destinatarios_fila on public.campanha_destinatarios (campanha_id, status);
create index campanha_destinatarios_telefone on public.campanha_destinatarios (telefone);

alter table public.descadastros enable row level security;
alter table public.campanhas enable row level security;
alter table public.campanha_destinatarios enable row level security;
create policy "Só o gestor vê descadastros" on public.descadastros for select to authenticated using ((select interno.sou_gestor()));
create policy "Só o gestor vê campanhas" on public.campanhas for select to authenticated using ((select interno.sou_gestor()));
create policy "Só o gestor vê destinatários" on public.campanha_destinatarios for select to authenticated using ((select interno.sou_gestor()));

-- Cria a campanha com a lista já limpa: número no formato certo, sem repetidos,
-- sem a equipe e sem quem pediu para sair. Devolve quantos ficaram de fora e por quê.
create function public.criar_campanha(
  p_nome text, p_modelo text, p_idioma text, p_texto text, p_usa_nome boolean, p_contatos jsonb, p_consentimento boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid;
  v_item jsonb;
  v_tel text;
  v_recebidos integer := 0; v_invalidos integer := 0; v_repetidos integer := 0; v_equipe integer := 0; v_saiu integer := 0; v_validos integer := 0;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor cria disparos';
  end if;
  if length(trim(coalesce(p_nome, ''))) < 3 then
    raise exception 'Dê um nome para o disparo';
  end if;
  if coalesce(trim(p_modelo), '') = '' then
    raise exception 'Escolha a mensagem aprovada pela Meta';
  end if;
  if not coalesce(p_consentimento, false) then
    raise exception 'Confirme que esses contatos autorizaram receber mensagens da LFG';
  end if;
  if jsonb_typeof(p_contatos) <> 'array' or jsonb_array_length(p_contatos) = 0 then
    raise exception 'A lista de contatos está vazia';
  end if;
  if jsonb_array_length(p_contatos) > 5000 then
    raise exception 'Envie no máximo 5.000 contatos por disparo';
  end if;

  insert into public.campanhas (nome, modelo, idioma, texto, usa_nome, consentimento_confirmado, criado_por)
  values (trim(p_nome), trim(p_modelo), coalesce(nullif(trim(p_idioma), ''), 'pt_BR'), p_texto, coalesce(p_usa_nome, false), true, interno.meu_corretor_id())
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_contatos) loop
    v_recebidos := v_recebidos + 1;
    v_tel := interno.normalizar_whatsapp(v_item ->> 'telefone');
    if v_tel is null then
      v_invalidos := v_invalidos + 1;
    elsif exists (select 1 from public.corretores c where c.whatsapp = any(interno.variantes_whatsapp(v_tel))) then
      v_equipe := v_equipe + 1;
    elsif exists (select 1 from public.descadastros d where d.telefone = any(interno.variantes_whatsapp(v_tel))) then
      v_saiu := v_saiu + 1;
    elsif exists (select 1 from public.campanha_destinatarios cd where cd.campanha_id = v_id and cd.telefone = any(interno.variantes_whatsapp(v_tel))) then
      v_repetidos := v_repetidos + 1;
    else
      insert into public.campanha_destinatarios (campanha_id, telefone, nome)
      values (v_id, v_tel, nullif(left(trim(coalesce(v_item ->> 'nome', '')), 80), ''));
      v_validos := v_validos + 1;
    end if;
  end loop;

  if v_validos = 0 then
    raise exception 'Nenhum contato válido na lista (inválidos: %, repetidos: %, equipe: %, saíram da lista: %)', v_invalidos, v_repetidos, v_equipe, v_saiu;
  end if;
  return jsonb_build_object('id', v_id, 'recebidos', v_recebidos, 'validos', v_validos, 'invalidos', v_invalidos,
    'repetidos', v_repetidos, 'equipe', v_equipe, 'descadastrados', v_saiu);
end;
$$;

-- Iniciar, pausar, retomar ou cancelar (só o gestor).
create function public.mudar_campanha(p_id uuid, p_acao text) returns public.campanhas
language plpgsql security definer set search_path = ''
as $$
declare
  v public.campanhas;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor controla os disparos';
  end if;
  select * into v from public.campanhas where id = p_id for update;
  if not found then
    raise exception 'Disparo não encontrado';
  end if;
  if p_acao in ('iniciar', 'retomar') then
    if v.status not in ('rascunho', 'pausada') then raise exception 'Este disparo não pode ser iniciado agora'; end if;
    update public.campanhas set status = 'enviando', motivo_pausa = null, iniciada_em = coalesce(iniciada_em, now()) where id = p_id returning * into v;
  elsif p_acao = 'pausar' then
    if v.status <> 'enviando' then raise exception 'Só dá para pausar um disparo que está enviando'; end if;
    update public.campanhas set status = 'pausada', motivo_pausa = 'Pausado pelo gestor' where id = p_id returning * into v;
  elsif p_acao = 'cancelar' then
    if v.status in ('concluida', 'cancelada') then raise exception 'Este disparo já terminou'; end if;
    update public.campanha_destinatarios set status = 'ignorado', atualizado_em = now() where campanha_id = p_id and status = 'na_fila';
    update public.campanhas set status = 'cancelada', concluida_em = now() where id = p_id returning * into v;
  else
    raise exception 'Ação inválida';
  end if;
  return v;
end;
$$;

-- Quem saiu da lista (usado pelo WhatsApp quando a pessoa pede para não receber).
create function public.registrar_descadastro(p_telefone text, p_origem text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tel text := interno.normalizar_whatsapp(p_telefone);
begin
  if v_tel is null then return; end if;
  insert into public.descadastros (telefone, origem) values (v_tel, coalesce(p_origem, 'botao')) on conflict (telefone) do nothing;
  update public.campanha_destinatarios set status = 'descadastrado', atualizado_em = now()
  where telefone = any(interno.variantes_whatsapp(v_tel)) and status in ('na_fila', 'enviado', 'entregue', 'lido', 'respondeu');
end;
$$;

-- LGPD: 90 dias depois do fim do disparo, apaga nome e telefone de quem não
-- respondeu nem saiu da lista; ficam só os números do resultado.
create function interno.anonimizar_disparos() returns integer
language sql security definer set search_path = ''
as $$
  with feitos as (
    update public.campanha_destinatarios d
    set nome = null, telefone = 'anon-' || d.id, whatsapp_id = null, anonimizado = true
    from public.campanhas c
    where c.id = d.campanha_id and not d.anonimizado
      and coalesce(c.concluida_em, c.criado_em) < now() - interval '90 days'
      and d.status not in ('respondeu', 'descadastrado')
    returning 1
  )
  select count(*)::integer from feitos;
$$;

-- Envio aos poucos: a cada minuto o banco chama a função "disparos".
create function interno.processar_disparos() returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.campanhas where status = 'enviando') then
    return;
  end if;
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/disparos',
    body := jsonb_build_object('acao', 'enviar_lote'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 55000
  );
end;
$$;

select cron.schedule('enviar-disparos', '* * * * *', 'select interno.processar_disparos()');
select cron.schedule('anonimizar-disparos', '17 4 * * *', 'select interno.anonimizar_disparos()');

revoke all on function interno.pedir_avaliacao(), interno.anonimizar_disparos(), interno.processar_disparos() from public, anon, authenticated;
revoke all on function public.criar_campanha(text, text, text, text, boolean, jsonb, boolean), public.mudar_campanha(uuid, text), public.registrar_descadastro(text, text) from public, anon;
grant execute on function public.criar_campanha(text, text, text, text, boolean, jsonb, boolean), public.mudar_campanha(uuid, text) to authenticated;
revoke all on function public.registrar_descadastro(text, text) from authenticated;
grant execute on function public.registrar_descadastro(text, text) to service_role;
