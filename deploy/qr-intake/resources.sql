-- Additive server-only adapter for the existing permanent printed QR form.
-- Never restore anonymous order_intakes writes or change existing invitation links.
create table xm_private.qr_intake_sessions (
 submission_id uuid primary key, token_hash text not null unique,
 link_id uuid not null references xm_private.customer_intake_links(id),
 ip_hash text not null, created_at timestamptz not null default now(),
 attempts integer not null default 1, lease_until timestamptz not null default now()+interval '2 minutes'
);
create index qr_intake_sessions_created_idx on xm_private.qr_intake_sessions(created_at);
create index qr_intake_sessions_ip_idx on xm_private.qr_intake_sessions(ip_hash,created_at);
alter table xm_private.qr_intake_sessions enable row level security;
revoke all on xm_private.qr_intake_sessions from public,anon,authenticated;
grant select,insert,update on xm_private.qr_intake_sessions to service_role;
-- The server creates short-lived invitation capabilities; browsers cannot mint them.
grant insert on xm_private.customer_intake_links to service_role;

create function public.reserve_qr_intake(p_submission_id uuid,p_token text,p_ip_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare s xm_private.qr_intake_sessions; owner_id uuid; new_link uuid; token_digest text;
begin
 if p_submission_id is null or p_token is null or p_token !~ '^[a-f0-9]{64}$' or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid request'; end if;
 token_digest:=encode(extensions.digest(p_token,'sha256'),'hex');
 perform pg_advisory_xact_lock(814205,98302);
 select * into s from xm_private.qr_intake_sessions where submission_id=p_submission_id for update;
 if found then
  if s.token_hash<>token_digest then return '{"allowed":false,"reason":"invalid"}'::jsonb; end if;
  if not exists(select 1 from xm_private.customer_intake_links where id=s.link_id and expires_at>now()) then return '{"allowed":false,"reason":"expired"}'::jsonb; end if;
  if exists(select 1 from xm_private.customer_intake_receipts where submission_id=p_submission_id and link_id=s.link_id and submitted) then return '{"allowed":true,"submitted":true}'::jsonb; end if;
  if s.lease_until>now() then return '{"allowed":false,"reason":"busy"}'::jsonb; end if;
  if s.attempts>=8 then return '{"allowed":false,"reason":"limited"}'::jsonb; end if;
  update xm_private.qr_intake_sessions set attempts=attempts+1,lease_until=now()+interval '2 minutes' where submission_id=p_submission_id;
  return '{"allowed":true,"submitted":false}'::jsonb;
 end if;
 -- Independent global limits still apply even if a caller spoofs network headers.
 if (select count(*) from xm_private.qr_intake_sessions where created_at>now()-interval '1 hour')>=100
 or (select count(*) from xm_private.qr_intake_sessions where created_at>now()-interval '24 hours')>=500
 or (select count(*) from xm_private.qr_intake_sessions where ip_hash=p_ip_hash and created_at>now()-interval '1 hour')>=30 then
  return '{"allowed":false,"reason":"limited"}'::jsonb;
 end if;
 if exists(select 1 from public.customer_contact_submissions where id=p_submission_id)
 or exists(select 1 from xm_private.customer_intake_receipts where submission_id=p_submission_id) then return '{"allowed":false,"reason":"invalid"}'::jsonb; end if;
 -- Same staff attribution used by existing service-created portal links; no roles change.
 select user_id into owner_id from public.user_roles where role='admin' order by user_id limit 1;
 if owner_id is null then raise exception 'Intake owner unavailable'; end if;
 insert into xm_private.customer_intake_links(token_hash,created_by,expires_at)
 values(token_digest,owner_id,now()+interval '2 hours') returning id into new_link;
 insert into xm_private.qr_intake_sessions(submission_id,token_hash,link_id,ip_hash) values(p_submission_id,token_digest,new_link,p_ip_hash);
 return '{"allowed":true,"submitted":false}'::jsonb;
end $$;
revoke all on function public.reserve_qr_intake(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_qr_intake(uuid,text,text) to service_role;

create function public.finish_qr_intake(p_submission_id uuid,p_token text)
returns void language sql security invoker set search_path='' as $$
 update xm_private.qr_intake_sessions set lease_until=now() where submission_id=p_submission_id and token_hash=encode(extensions.digest(p_token,'sha256'),'hex');
$$;
revoke all on function public.finish_qr_intake(uuid,text) from public,anon,authenticated;
grant execute on function public.finish_qr_intake(uuid,text) to service_role;

create function public.commit_qr_intake(p_token text,p_submission_id uuid,p_contact jsonb,p_files jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare result uuid; f jsonb;
begin
 perform 1 from xm_private.qr_intake_sessions where submission_id=p_submission_id and token_hash=encode(extensions.digest(p_token,'sha256'),'hex') for update;
 if not found then raise exception 'Invalid QR submission'; end if;
 if exists(select 1 from xm_private.customer_intake_receipts where submission_id=p_submission_id and submitted) then return p_submission_id; end if;
 if jsonb_typeof(p_files) is distinct from 'array' then raise exception 'Invalid files'; end if;
 for f in select value from jsonb_array_elements(p_files) loop
  if length(coalesce(f->>'notes',''))>500 then raise exception 'File notes are too long'; end if;
 end loop;
 -- Reuse the deployed atomic contact/customer/intake/file/portal workflow unchanged.
 result:=public.commit_customer_intake(p_token,p_submission_id,p_contact,p_files);
 for f in select value from jsonb_array_elements(p_files) loop
  update public.customer_uploads set notes=nullif(btrim(f->>'notes'),'') where submission_id=p_submission_id and storage_path=f->>'storage_path';
 end loop;
 update xm_private.qr_intake_sessions set lease_until=now() where submission_id=p_submission_id;
 return result;
end $$;
revoke all on function public.commit_qr_intake(text,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.commit_qr_intake(text,uuid,jsonb,jsonb) to service_role;
