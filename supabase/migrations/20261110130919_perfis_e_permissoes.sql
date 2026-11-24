-- Perfis: o corretor cuida só do próprio perfil; equipe, regras, site e integrações
-- são do gestor, também no banco.

alter table public.corretores add column if not exists foto_url text;

-- Configurações: o corretor só lê as duas que as telas dele usam.
drop policy if exists "Equipe vê as configurações" on public.configuracoes;
create policy "Gestor vê as configurações; corretor só as do dia a dia" on public.configuracoes
  for select to authenticated using (
    (select interno.sou_gestor()) or chave in ('motivos_perda', 'prazo_rodizio_minutos')
  );

-- Fotos de perfil: cada um grava na própria pasta (id do corretor).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('perfis', 'perfis', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
create policy "Cada um envia a própria foto de perfil" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'perfis' and (storage.foldername(name))[1] = (select interno.meu_corretor_id())::text
  );
create policy "Cada um apaga a própria foto de perfil" on storage.objects
  for delete to authenticated using (
    bucket_id = 'perfis' and (storage.foldername(name))[1] = (select interno.meu_corretor_id())::text
  );

-- Meu perfil: nome, WhatsApp e foto. Papel, situação e rodízio ficam com o gestor.
create function public.atualizar_meu_perfil(p_nome text, p_whatsapp text, p_foto_url text default null)
returns public.corretores
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_nome text := regexp_replace(trim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_whatsapp text := interno.normalizar_whatsapp(p_whatsapp);
  v_foto text := nullif(trim(coalesce(p_foto_url, '')), '');
  v_pessoa public.corretores;
begin
  if v_eu is null then
    raise exception 'Entre no painel para mudar o perfil';
  end if;
  if length(v_nome) < 3 then
    raise exception 'Informe o seu nome';
  end if;
  if v_whatsapp is null then
    raise exception 'Informe o WhatsApp com DDD, por exemplo (67) 99999-9999';
  end if;
  if v_foto is not null and v_foto not like '%/storage/v1/object/public/perfis/' || v_eu::text || '/%' then
    raise exception 'Foto inválida';
  end if;
  if exists (select 1 from public.corretores c where c.whatsapp = any(interno.variantes_whatsapp(v_whatsapp)) and c.id <> v_eu) then
    raise exception 'Esse WhatsApp já é de outra pessoa da equipe';
  end if;
  update public.corretores c set nome = v_nome, whatsapp = v_whatsapp, foto_url = v_foto
  where c.id = v_eu
  returning * into v_pessoa;
  return v_pessoa;
end;
$$;

-- Gestão de usuários: só o gestor. A equipe nunca fica sem um gestor ativo, e o
-- gestor não tira o próprio acesso (outro gestor faz isso).
-- (O cast de p_papel para equipe_papel vem na migração seguinte.)
create function public.gestor_atualizar_pessoa(
  p_id uuid, p_nome text, p_whatsapp text, p_creci text, p_papel text, p_ativo boolean, p_no_rodizio boolean
) returns public.corretores
language plpgsql security definer set search_path = ''
as $$
declare
  v_eu uuid := interno.meu_corretor_id();
  v_atual public.corretores;
  v_nome text := regexp_replace(trim(coalesce(p_nome, '')), '\s+', ' ', 'g');
  v_whatsapp text := interno.normalizar_whatsapp(p_whatsapp);
  v_pessoa public.corretores;
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor muda os acessos da equipe';
  end if;
  select * into v_atual from public.corretores where id = p_id for update;
  if not found then
    raise exception 'Pessoa não encontrada';
  end if;
  if p_papel not in ('gestor', 'corretor') then
    raise exception 'Perfil inválido';
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
  if p_id = v_eu and (p_papel <> 'gestor' or not p_ativo) then
    raise exception 'Você não pode tirar o seu próprio acesso de gestor. Peça a outro gestor';
  end if;
  if v_atual.papel = 'gestor' and v_atual.ativo and (p_papel <> 'gestor' or not p_ativo)
     and not exists (select 1 from public.corretores c where c.papel = 'gestor' and c.ativo and c.id <> p_id) then
    raise exception 'A equipe precisa de pelo menos um gestor ativo';
  end if;
  update public.corretores c set
    nome = v_nome, whatsapp = v_whatsapp, creci = nullif(trim(coalesce(p_creci, '')), ''),
    papel = p_papel, ativo = p_ativo, no_rodizio = p_no_rodizio,
    de_plantao = case when p_ativo and p_no_rodizio then c.de_plantao else false end
  where c.id = p_id
  returning * into v_pessoa;
  return v_pessoa;
end;
$$;

revoke all on function public.atualizar_meu_perfil(text, text, text), public.gestor_atualizar_pessoa(uuid, text, text, text, text, boolean, boolean) from public, anon;
grant execute on function public.atualizar_meu_perfil(text, text, text), public.gestor_atualizar_pessoa(uuid, text, text, text, text, boolean, boolean) to authenticated;
