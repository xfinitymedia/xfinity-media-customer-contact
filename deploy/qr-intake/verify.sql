begin;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
set local role service_role;
do $$
declare sid uuid; token text; gate jsonb; files jsonb; path text; n integer;
begin
 for n in 0..1 loop
  sid:=gen_random_uuid(); token:=encode(extensions.gen_random_bytes(32),'hex');
  gate:=public.reserve_qr_intake(sid,token,repeat('b',64));
  if not (gate->>'allowed')::boolean then raise exception 'Valid QR form rejected'; end if;
  if (public.reserve_qr_intake(sid,repeat('0',64),repeat('b',64))->>'allowed')::boolean then raise exception 'Wrong capability accepted'; end if;
  if public.reserve_qr_intake(sid,token,repeat('b',64))->>'reason'<>'busy' then raise exception 'Concurrent submission accepted'; end if;
  if not (public.customer_intake_link_state(token,sid)->>'valid')::boolean then raise exception 'Server invitation invalid'; end if;
  files:='[]'::jsonb;
  if n=1 then
   path:=sid::text||'/qr-rollback.pdf';
   insert into storage.objects(bucket_id,name,metadata) values('customer-uploads',path,'{"size":11,"mimetype":"application/pdf"}');
   files:=jsonb_build_array(jsonb_build_object('storage_path',path,'file_name','qr-rollback.pdf','file_size',11,'mime_type','application/pdf','notes','Keep QR file note'));
  end if;
  perform public.commit_qr_intake(token,sid,'{"name":"QR rollback verification","email":"qr-rollback@example.invalid"}',files);
  perform public.commit_qr_intake(token,sid,'{"name":"Retry must not replace","email":"qr-rollback@example.invalid"}',files);
  if (select count(*) from public.order_intakes where submission_id=sid)<>1 then raise exception 'Missing or duplicate intake'; end if;
  if (select count(*) from public.customer_uploads where submission_id=sid)<>n then raise exception 'Wrong attachment count'; end if;
  if n=1 and not exists(select 1 from public.customer_uploads where submission_id=sid and notes='Keep QR file note') then raise exception 'File notes missing'; end if;
  if not (public.reserve_qr_intake(sid,token,repeat('b',64))->>'submitted')::boolean then raise exception 'Retry receipt missing'; end if;
 end loop;
end $$;
reset role;
rollback;
select 'PASS: real production workflow, contact-only, file metadata, notes, capability denial, concurrency and retry; all fixtures rolled back' as result;
