-- Página pública de cada corretor: lfg.jojodigitals.com/corretor/<slug>.
-- O slug sai do nome (minúsculas, sem acento, espaços viram hífen) e é único;
-- repetido ganha -2, -3... O gestor (e o administrativo) podem ajustar.
-- As páginas são geradas na VPS pelo mesmo gerador do site (vps/site/gerar.py),
-- que lê public.site_dados: por isso o slug e o WhatsApp do corretor entram lá.
-- O administrativo não tem página (não atende cliente).

alter table public.corretores add column if not exists slug text;
alter table public.corretores drop constraint if exists corretores_slug_formato;
alter table public.corretores add constraint corretores_slug_formato
  check (slug is null or (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 3 and 60));
create unique index if not exists corretores_slug_unico on public.corretores (slug) where slug is not null;

create or replace function interno.slug_do_nome(p_nome text)
 returns text
 language sql
 stable
 set search_path to ''
as $$
  select nullif(left(trim(both '-' from regexp_replace(lower(interno.sem_acento(coalesce(p_nome, ''))), '[^a-z0-9]+', '-', 'g')), 50), '');
$$;

-- Primeiro slug livre a partir do nome: joao-goncalves, joao-goncalves-2...
create or replace function interno.slug_livre(p_nome text, p_id uuid)
 returns text
 language plpgsql
 stable
 set search_path to ''
as $$
declare
  v_base text := coalesce(interno.slug_do_nome(p_nome), 'corretor');
  v_tentativa text;
  v_n integer := 1;
begin
  if length(v_base) < 3 then
    v_base := v_base || '-lfg';
  end if;
  v_tentativa := v_base;
  while exists (select 1 from public.corretores c where c.slug = v_tentativa and c.id is distinct from p_id) loop
    v_n := v_n + 1;
    v_tentativa := v_base || '-' || v_n;
  end loop;
  return v_tentativa;
end;
$$;

create or replace function interno.corretor_ganha_slug()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $$
begin
  if new.slug is null and new.papel::text <> 'administrativo' then
    new.slug := interno.slug_livre(new.nome, new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists corretores_slug on public.corretores;
create trigger corretores_slug
  before insert or update of nome, papel, slug on public.corretores
  for each row execute function interno.corretor_ganha_slug();

-- Quem já está na equipe ganha o seu (gestores primeiro, depois por nome).
do $$
declare v_c record;
begin
  for v_c in
    select id, nome from public.corretores
    where slug is null and papel::text <> 'administrativo'
    order by (papel::text = 'gestor') desc, criado_em, nome
  loop
    update public.corretores set slug = interno.slug_livre(v_c.nome, v_c.id) where id = v_c.id;
  end loop;
end $$;

create or replace function public.definir_slug_corretor(p_corretor_id uuid, p_slug text)
 returns text
 language plpgsql
 security definer
 set search_path to ''
as $$
declare
  v_slug text := lower(trim(coalesce(p_slug, '')));
begin
  if not interno.sou_gestor() then
    raise exception 'Só o gestor ajusta o endereço da página';
  end if;
  if v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' or length(v_slug) not between 3 and 60 then
    raise exception 'Use de 3 a 60 letras minúsculas, números e hífens (ex.: joao-goncalves)';
  end if;
  if exists (select 1 from public.corretores c where c.slug = v_slug and c.id <> p_corretor_id) then
    raise exception 'Esse endereço já é de outra pessoa da equipe';
  end if;
  update public.corretores set slug = v_slug where id = p_corretor_id and papel::text <> 'administrativo';
  if not found then
    raise exception 'Pessoa não encontrada (o administrativo não tem página)';
  end if;
  return v_slug;
end;
$$;
revoke all on function public.definir_slug_corretor(uuid, text) from public, anon;
grant execute on function public.definir_slug_corretor(uuid, text) to authenticated;

-- Site: equipe com slug e WhatsApp (só de quem tem página) e o slug do corretor
-- de cada imóvel, para o gerador montar as páginas.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.site_dados'::regproc) into v_def;
  v_def := replace(v_def,
    $a$'nome', r.nome, 'papel', r.papel::text, 'creci', r.creci, 'foto_url', r.foto_url
      ) order by$a$,
    $a$'nome', r.nome, 'papel', r.papel::text, 'creci', r.creci, 'foto_url', r.foto_url,
        'slug', case when r.papel::text <> 'administrativo' then r.slug end,
        'whatsapp', case when r.papel::text <> 'administrativo' then r.whatsapp end
      ) order by$a$);
  v_def := replace(v_def,
    $a$select jsonb_build_object('nome', r.nome, 'creci', r.creci, 'foto_url', r.foto_url)$a$,
    $a$select jsonb_build_object('nome', r.nome, 'creci', r.creci, 'foto_url', r.foto_url, 'slug', r.slug)$a$);
  if v_def not like '%''whatsapp'', case when%' or v_def not like '%''foto_url'', r.foto_url, ''slug'', r.slug)%' then
    raise exception 'site_dados: trechos não encontrados';
  end if;
  execute v_def;
end $$;
