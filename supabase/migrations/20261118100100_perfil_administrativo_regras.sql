-- Perfil administrativo: faz tudo o que o gestor faz, menos
--   * criar acessos (cadastrar gente nova na equipe);
--   * mexer no site (textos, cores, imagens);
--   * usar os disparos.
-- E não mexe na conta de um gestor nem promove ninguém a gestor.
--
-- interno.sou_gestor() passa a significar "sou da gestão" (gestor ou
-- administrativo): todas as regras que já usam ela valem para os dois.
-- As três exceções usam interno.sou_gestor_pleno(), só do gestor.

create or replace function interno.sou_gestor()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select exists (
    select 1 from public.corretores
    where usuario_id = (select auth.uid()) and ativo and papel in ('gestor', 'administrativo')
  );
$$;

create or replace function interno.sou_gestor_pleno()
 returns boolean
 language sql
 stable security definer
 set search_path to ''
as $$
  select exists (
    select 1 from public.corretores
    where usuario_id = (select auth.uid()) and ativo and papel = 'gestor'
  );
$$;
revoke all on function interno.sou_gestor_pleno() from public, anon;
grant execute on function interno.sou_gestor_pleno() to authenticated;

-- Disparos: só o gestor.
drop policy if exists "Só o gestor vê campanhas" on public.campanhas;
create policy "Só o gestor vê campanhas" on public.campanhas for select to authenticated
  using ((select interno.sou_gestor_pleno()));
drop policy if exists "Só o gestor vê destinatários" on public.campanha_destinatarios;
create policy "Só o gestor vê destinatários" on public.campanha_destinatarios for select to authenticated
  using ((select interno.sou_gestor_pleno()));
drop policy if exists "Só o gestor vê descadastros" on public.descadastros;
create policy "Só o gestor vê descadastros" on public.descadastros for select to authenticated
  using ((select interno.sou_gestor_pleno()));

-- Site: imagens (bucket "site") e configuração (chave "site") só o gestor.
drop policy if exists "Gestor envia imagens do site" on storage.objects;
create policy "Gestor envia imagens do site" on storage.objects for insert to authenticated
  with check (bucket_id = 'site' and (select interno.sou_gestor_pleno()));
drop policy if exists "Gestor troca imagens do site" on storage.objects;
create policy "Gestor troca imagens do site" on storage.objects for update to authenticated
  using (bucket_id = 'site' and (select interno.sou_gestor_pleno()));
drop policy if exists "Gestor apaga imagens do site" on storage.objects;
create policy "Gestor apaga imagens do site" on storage.objects for delete to authenticated
  using (bucket_id = 'site' and (select interno.sou_gestor_pleno()));

-- Configurações: o administrativo altera tudo, menos as do site e dos disparos.
drop policy if exists "Gestor altera as configurações" on public.configuracoes;
create policy "Gestor altera as configurações" on public.configuracoes for update to authenticated
  using ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos')))
  with check ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and chave not in ('site', 'disparos')));

-- Equipe: só o gestor cadastra; o administrativo altera quem não é gestor e não
-- transforma ninguém em gestor.
drop policy if exists "Gestor cadastra a equipe" on public.corretores;
create policy "Gestor cadastra a equipe" on public.corretores for insert to authenticated
  with check ((select interno.sou_gestor_pleno()));
drop policy if exists "Gestor altera a equipe" on public.corretores;
create policy "Gestor altera a equipe" on public.corretores for update to authenticated
  using ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and papel <> 'gestor'))
  with check ((select interno.sou_gestor_pleno()) or ((select interno.sou_gestor()) and papel <> 'gestor'));

-- Funções dos disparos: só o gestor.
do $$
declare v_def text;
begin
  for v_def in
    select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('criar_campanha', 'mudar_campanha')
  loop
    execute replace(v_def, 'interno.sou_gestor()', 'interno.sou_gestor_pleno()');
  end loop;
end $$;

-- Mudar alguém da equipe: o administrativo não mexe em gestor, não promove a
-- gestor e não muda o próprio perfil nem se desativa.
create or replace function public.gestor_atualizar_pessoa(p_id uuid, p_nome text, p_whatsapp text, p_creci text, p_papel text, p_ativo boolean, p_no_rodizio boolean)
 returns public.corretores
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_pleno boolean := interno.sou_gestor_pleno();
  v_atual public.corretores;
  v_nome text := regexp_replace(trim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_whatsapp text := interno.normalizar_whatsapp(p_whatsapp);
  v_pessoa public.corretores;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor ou o administrativo muda os acessos da equipe';
  end if;
  select * into v_atual from public.corretores where id = p_id for update;
  if not found then
    raise exception 'Pessoa não encontrada';
  end if;
  if p_papel not in ('gestor', 'corretor', 'administrativo') then
    raise exception 'Perfil inválido';
  end if;
  if not v_pleno then
    if v_atual.papel = 'gestor' then
      raise exception 'Só um gestor muda o cadastro de outro gestor';
    end if;
    if p_papel = 'gestor' then
      raise exception 'Só um gestor dá o perfil de gestor';
    end if;
    if p_id = v_eu and (p_papel <> v_atual.papel::text or not p_ativo) then
      raise exception 'Você não pode mudar o seu próprio perfil nem se desativar. Peça ao gestor';
    end if;
  end if;
  if length(v_nome) < 3 then
    raise exception 'Informe o nome';
  end if;
  if v_whatsapp is null then
    raise exception 'Informe o WhatsApp com DDD';
  end if;
  if exists (select 1 from public.corretores c where c.whatsapp = any(interno.variantes_whatsapp(v_whatsapp)) and c.id <> p_id) then
    raise exception 'Esse WhatsApp já é de outra pessoa da equipe';
  end if;
  if v_pleno and p_id = v_eu and (p_papel <> 'gestor' or not p_ativo) then
    raise exception 'Você não pode tirar o seu próprio acesso de gestor. Peça a outro gestor';
  end if;
  if v_atual.papel = 'gestor' and v_atual.ativo and (p_papel <> 'gestor' or not p_ativo)
     and not exists (select 1 from public.corretores c where c.papel = 'gestor' and c.ativo and c.id <> p_id) then
    raise exception 'A equipe precisa de pelo menos um gestor ativo';
  end if;
  update public.corretores c set
    nome = v_nome, whatsapp = v_whatsapp, creci = nullif(trim(coalesce(p_creci, '')), ''),
    papel = p_papel::public.equipe_papel, ativo = p_ativo,
    -- Administrativo não entra no rodízio de leads.
    no_rodizio = p_no_rodizio and p_papel <> 'administrativo',
    de_plantao = case when p_ativo and p_no_rodizio and p_papel <> 'administrativo' then c.de_plantao else false end
  where c.id = p_id
  returning * into v_pessoa;
  return v_pessoa;
end;
$function$;

-- Site: a seção "Nossa equipe" mostra corretores e gestores, não o administrativo.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.site_dados'::regproc) into v_def;
  v_def := replace(v_def, '      where r.ativo
    ), ''[]''::jsonb),
    ''imoveis''', '      where r.ativo and r.papel <> ''administrativo''
    ), ''[]''::jsonb),
    ''imoveis''');
  if v_def not like '%r.papel <> ''administrativo''%' then
    raise exception 'site_dados: trecho da equipe não encontrado';
  end if;
  execute v_def;
end $$;
