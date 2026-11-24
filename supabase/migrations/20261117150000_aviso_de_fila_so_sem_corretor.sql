-- Aviso de fila ("sigo de olho no seu atendimento...") só para quem ainda
-- espera um corretor. Depois que o corretor mandou alguma mensagem na conversa,
-- o lead não está mais na fila: o aviso não sai, mesmo que o cliente escreva
-- algo como "Entendi" e fique sem resposta.
create or replace function interno.registrar_acompanhamentos()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
        -- Corretor assumiu e ainda não escreveu nada ao cliente.
        when l.status = 'com_corretor' and l.ultima_mensagem_cliente_em > l.status_desde
          and not exists (
            select 1 from public.mensagens c
            where c.lead_id = l.id and c.autor = 'corretor' and c.criado_em > l.status_desde
          )
          then l.ultima_mensagem_cliente_em
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
$function$;
