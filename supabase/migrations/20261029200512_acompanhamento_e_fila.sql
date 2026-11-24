-- A Thais volta na conversa quando o cliente fica sem resposta do corretor:
-- 10 minutos depois da passagem (ou da última mensagem do cliente), sem
-- mensagem do corretor no painel, sai um aviso curto de fila pelo WhatsApp.
-- Depois que o corretor assume, só volta se o cliente escrever e ficar sem
-- resposta. E o lead que ficou sem ninguém de plantão vai para quem ligar o
-- plantão, o mais antigo primeiro.

-- Desde quando o lead está na situação atual (aguardando ou com corretor).
alter table public.leads add column status_desde timestamptz;
comment on column public.leads.status_desde is 'Quando o lead entrou na situação atual; conta o tempo de espera pelo corretor.';

update public.leads l
set status_desde = coalesce(
  (select max(m.criado_em) from public.mensagens m
   where m.lead_id = l.id and m.autor = 'sistema' and m.conteudo like 'IA passou o atendimento%'),
  l.atualizado_em
);

create function interno.marcar_status_desde() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    new.status_desde := now();
  end if;
  return new;
end;
$$;

create trigger leads_status_desde
before insert or update of status on public.leads
for each row execute function interno.marcar_status_desde();

insert into public.configuracoes (chave, valor, descricao) values
  ('acompanhamento_minutos', '10', 'Minutos sem resposta do corretor até a assistente mandar um aviso de fila ao cliente.'),
  ('horario_escritorio', '{"dias": [1, 2, 3, 4, 5], "faixas": [["08:00", "11:00"], ["13:00", "17:00"]]}',
   'Horário do escritório (dias de 1 = segunda a 7 = domingo; faixas em horário de Campo Grande).');

create function interno.no_horario_do_escritorio(p_quando timestamptz) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.configuracoes c
    cross join lateral jsonb_array_elements(c.valor -> 'faixas') f
    where c.chave = 'horario_escritorio'
      and c.valor -> 'dias' @> to_jsonb(extract(isodow from p_quando at time zone 'America/Campo_Grande')::int)
      and (p_quando at time zone 'America/Campo_Grande')::time >= (f ->> 0)::time
      and (p_quando at time zone 'America/Campo_Grande')::time < (f ->> 1)::time
  );
$$;

-- Roda a cada minuto. Grava o aviso como mensagem da assistente (tipo
-- acompanhamento); o gatilho abaixo manda pelo WhatsApp.
create function interno.registrar_acompanhamentos() returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_minutos integer;
  v_lead record;
  v_nome text;
  v_texto text;
  v_total integer := 0;
begin
  select (valor #>> '{}')::integer into v_minutos from public.configuracoes where chave = 'acompanhamento_minutos';
  if v_minutos is null or v_minutos <= 0 then
    return 0;
  end if;

  for v_lead in
    select l.id, l.nome, e.desde,
      (select count(*) from public.mensagens m
       where m.lead_id = l.id and m.tipo = 'acompanhamento' and m.criado_em > now() - interval '24 hours') as anteriores
    from public.leads l
    cross join lateral (
      select case
        when l.status = 'aguardando_corretor' then greatest(l.status_desde, l.ultima_mensagem_cliente_em)
        when l.status = 'com_corretor' and l.ultima_mensagem_cliente_em > l.status_desde then l.ultima_mensagem_cliente_em
      end as desde
    ) e
    where l.status in ('aguardando_corretor', 'com_corretor')
      and e.desde < now() - make_interval(mins => v_minutos)
      -- Mensagem livre só vale até 24 horas depois da última do cliente.
      and l.ultima_mensagem_cliente_em > now() - interval '23 hours'
      and not exists (
        select 1 from public.mensagens m
        where m.lead_id = l.id and m.criado_em > e.desde and (m.autor = 'corretor' or m.tipo = 'acompanhamento')
      )
  loop
    continue when v_lead.anteriores >= 3;

    v_nome := split_part(trim(coalesce(v_lead.nome, '')), ' ', 1);
    if v_nome !~ '^[[:alpha:]]{2,}$' then
      v_nome := null;
    end if;

    if not interno.no_horario_do_escritorio(now()) then
      v_texto := 'nossa equipe atende de segunda a sexta, das 8h às 11h e das 13h às 17h. Você já está na nossa fila e será um dos primeiros a ser atendido. Obrigada por aguardar! 😊';
    elsif v_lead.anteriores = 0 then
      v_texto := 'nossa fila de atendimento está cheia no momento, mas você é o próximo a ser atendido. Obrigada por aguardar! 😊';
    else
      v_texto := 'sigo de olho no seu atendimento: você continua na frente da fila e logo um corretor fala com você. Obrigada pela paciência!';
    end if;
    v_texto := case when v_nome is null then upper(left(v_texto, 1)) || substr(v_texto, 2) else v_nome || ', ' || v_texto end;

    insert into public.mensagens (lead_id, autor, tipo, conteudo, status_entrega)
    values (v_lead.id, 'ia', 'acompanhamento', v_texto, 'pendente');
    v_total := v_total + 1;
  end loop;
  return v_total;
end;
$$;

-- Mesmo caminho do aviso ao corretor: o banco chama a função "avisos", que
-- manda o texto pelo WhatsApp depois do commit.
create function interno.enviar_acompanhamento() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  perform net.http_post(
    url := 'https://nlbonjxmzmwsyuirxnzu.supabase.co/functions/v1/avisos',
    body := jsonb_build_object('mensagem_id', new.id),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-avisos-chave', (select decrypted_secret from vault.decrypted_secrets where name = 'avisos_chave')
    ),
    timeout_milliseconds := 15000
  );
  return new;
end;
$$;

create trigger mensagens_enviar_acompanhamento
after insert on public.mensagens
for each row when (new.tipo = 'acompanhamento')
execute function interno.enviar_acompanhamento();

select cron.schedule('acompanhar-esperas', '* * * * *', $$select interno.registrar_acompanhamentos()$$);

-- Fila do plantão: quem liga o plantão recebe os leads que estavam sem
-- corretor, o mais antigo primeiro (o captador do imóvel ainda tem a vez dele,
-- se não foi oferecido).
create function interno.oferecer_fila_ao_plantao() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_lead record;
  v_oferta jsonb;
begin
  for v_lead in
    select l.id from public.leads l
    where l.status = 'aguardando_corretor'
      and l.whatsapp not like 'sim-%'
      and l.ultima_mensagem_cliente_em > now() - interval '7 days'
      and not exists (select 1 from public.atribuicoes a where a.lead_id = l.id and a.status = 'pendente')
    order by l.status_desde nulls first
  loop
    v_oferta := public.oferecer_lead(v_lead.id);
    if v_oferta ->> 'situacao' = 'oferecido' then
      insert into public.mensagens (lead_id, autor, conteudo)
      values (v_lead.id, 'sistema', 'Lead da fila oferecido para ' || (v_oferta ->> 'corretor_nome') || ', que ligou o plantão');
    end if;
  end loop;
  return null;
end;
$$;

create trigger corretores_plantao_oferece_fila
after update of de_plantao on public.corretores
for each row when (new.de_plantao and not old.de_plantao and new.ativo and new.no_rodizio)
execute function interno.oferecer_fila_ao_plantao();
