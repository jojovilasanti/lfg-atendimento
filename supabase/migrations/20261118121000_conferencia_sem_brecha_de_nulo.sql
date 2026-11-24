-- Brecha antiga: "if not (gestor or dono = eu)" deixava passar quando o lead
-- (ou o imóvel) ainda não tinha dono, porque a comparação com vazio dá
-- "desconhecido" e o "if" não dispara. Com coalesce, sem dono é "não pode".
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.definir_ia_do_lead'::regproc) into v_def;
  v_def := replace(v_def,
    'not (interno.sou_gestor_pleno() or v_lead.corretor_id = interno.meu_corretor_id())',
    'not coalesce(interno.sou_gestor_pleno() or v_lead.corretor_id = interno.meu_corretor_id(), false)');
  if v_def not like '%not coalesce(interno.sou_gestor_pleno()%' then raise exception 'definir_ia_do_lead: trecho não encontrado'; end if;
  execute v_def;

  select pg_get_functiondef('public.apagar_rascunho'::regproc) into v_def;
  v_def := replace(v_def,
    'not (interno.sou_gestor() or interno.corretor_do_captador(v_imovel.captador) = interno.meu_corretor_id())',
    'not coalesce(interno.sou_gestor() or interno.corretor_do_captador(v_imovel.captador) = interno.meu_corretor_id(), false)');
  if v_def not like '%not coalesce(interno.sou_gestor()%' then raise exception 'apagar_rascunho: trecho não encontrado'; end if;
  execute v_def;
end $$;
