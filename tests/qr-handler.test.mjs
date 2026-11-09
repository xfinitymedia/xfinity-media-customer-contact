import {test} from 'node:test';
import assert from 'node:assert/strict';
import {qrIntakeHandler} from '../supabase/functions/qr-customer-intake/handler.ts';
const origin='https://xfinity-media-customer-contact.vercel.app';
const id='12345678-1234-4567-8901-123456789012',token='a'.repeat(64);
function fixture({gate={allowed:true,submitted:false},fail='',duplicate=false}={}){
 const calls=[];
 const client={rpc:async(name,args)=>{calls.push({name,args});if(name===fail)return {error:{code:'TEST'}};return {data:name==='reserve_qr_intake'?gate:name==='customer_intake_link_state'?{valid:true}:id};},storage:{from(bucket){return {upload:async(path,bytes,options)=>{calls.push({name:'upload',bucket,path,bytes,options});return {error:fail==='upload'?{statusCode:'500'}:duplicate?{statusCode:'409'}:null};}}}}};
 return {calls,handler:qrIntakeHandler(client,'test-only-rate-secret')};
}
function request({fields={},files=[],method='POST',site=origin,type,declared}={}){
 const body=new FormData();
 for(const [key,value] of Object.entries({name:'Test QR Customer',email:'test@example.invalid',access_token:token,submission_id:id,file_notes:JSON.stringify(files.map(()=>'File note')),...fields}))body.set(key,value);
 for(const file of files)body.append('files',file);
 const headers={origin:site,'cf-connecting-ip':'192.0.2.1'};if(type)headers['content-type']=type;if(declared)headers['content-length']=declared;
 return new Request('https://api.invalid/qr-customer-intake',{method,headers,...(method==='POST'?{body}:{})});
}
test('contact-only uses existing reservation + atomic commit and returns no private data',async()=>{
 const f=fixture(),r=await f.handler(request());assert.equal(r.status,200);assert.equal(JSON.stringify(await r.json()),JSON.stringify({ok:true}));
 assert.deepEqual(f.calls.map(c=>c.name),['reserve_qr_intake','customer_intake_link_state','commit_qr_intake','finish_qr_intake']);
 assert.equal(f.calls[0].args.p_ip_hash.length,64);assert.notEqual(f.calls[0].args.p_ip_hash,'192.0.2.1');
 assert.equal(f.calls[2].args.p_files.length,0);
});
test('phone-only remains supported',async()=>{const f=fixture();assert.equal((await f.handler(request({fields:{email:'',phone:'6045550100'}}))).status,200);});
test('multiple files retain private paths, notes and a single atomic commit',async()=>{
 const f=fixture(),files=[new File(['%PDF-fixture'],'design.pdf',{type:'application/pdf'}),new File(['png'],'logo.png',{type:'image/png'})];
 assert.equal((await f.handler(request({files}))).status,200);
 assert.equal(f.calls.filter(c=>c.name==='upload').length,2);
 const saved=f.calls.find(c=>c.name==='commit_qr_intake');assert.equal(saved.args.p_files.length,2);
 assert.equal(saved.args.p_files[0].notes,'File note');assert.ok(saved.args.p_files.every(x=>x.storage_path.startsWith(id+'/')));
 assert.ok(f.calls.filter(c=>c.name==='upload').every(x=>x.options.upsert===false&&x.bucket==='customer-uploads'));
});
test('successful replay returns success without upload or repeat commit',async()=>{const f=fixture({gate:{allowed:true,submitted:true}});assert.equal((await f.handler(request())).status,200);assert.equal(f.calls.length,1);});
for(const [reason,status] of [['busy',409],['limited',429],['invalid',403],['expired',403]])test(reason+' gate stops all writes',async()=>{const f=fixture({gate:{allowed:false,reason}});assert.equal((await f.handler(request())).status,status);assert.equal(f.calls.length,1);});
for(const [label,options] of [
 ['foreign origin',{site:'https://evil.invalid'}],['missing origin',{site:''}],['wrong method',{method:'GET'}],['wrong content type',{type:'application/json'}],
 ['honeypot',{fields:{website:'spam'}}],['invalid email',{fields:{email:'bad'}}],['missing name',{fields:{name:''}}],['missing contact',{fields:{email:''}}],
 ['bad uuid',{fields:{submission_id:'-'.repeat(36)}}],['bad token',{fields:{access_token:'x'.repeat(64)}}],['oversize declared body',{declared:String(29*1024*1024)}],
 ['unsupported file',{files:[new File(['bad'],'bad.exe')]}],['bad note type',{fields:{file_notes:'{}'}}],['too many files',{files:Array.from({length:11},()=>new File(['x'],'art.png'))}],
 ['long notes',{files:[new File(['x'],'art.png')],fields:{file_notes:JSON.stringify(['x'.repeat(501)])}}]
])test(label+' rejected before reservation or upload',async()=>{const f=fixture();assert.ok((await f.handler(request(options))).status>=400);assert.equal(f.calls.length,0);});
for(const fail of ['customer_intake_link_state','upload','commit_qr_intake'])test(fail+' failure never reports success and releases lease',async()=>{const f=fixture({fail});const r=await f.handler(request({files:[new File(['x'],'art.png')]}));assert.equal(r.status,400);assert.notEqual((await r.json()).ok,true);assert.equal(f.calls.at(-1).name,'finish_qr_intake');});
test('identical file retry reuses digest path safely',async()=>{const f=fixture({duplicate:true});assert.equal((await f.handler(request({files:[new File(['x'],'art.png')]}))).status,200);});
test('OPTIONS only allows the printed QR origin',async()=>{const f=fixture();const r=await f.handler(request({method:'OPTIONS'}));assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal(f.calls.length,0);});
test('same photo selected twice commits once and uploads once',async()=>{
 const f=fixture(),photo=new File(['photo-bytes'],'20261109_121858.jpg',{type:'image/jpeg'});
 assert.equal((await f.handler(request({files:[photo,photo]}))).status,200);
 assert.equal(f.calls.filter(c=>c.name==='upload').length,1);
 const entries=f.calls.find(c=>c.name==='commit_qr_intake').args.p_files;
 assert.equal(entries.length,1);assert.equal(entries[0].file_name,photo.name);
});
test('ten repeated photos commit once',async()=>{
 const f=fixture(),photo=new File(['photo'],'art.jpg');
 assert.equal((await f.handler(request({files:Array(10).fill(photo)}))).status,200);
 assert.equal(f.calls.find(c=>c.name==='commit_qr_intake').args.p_files.length,1);
});
test('same photo with distinct notes preserves every note with unique paths',async()=>{
 const f=fixture(),photo=new File(['photo'],'art.jpg');
 assert.equal((await f.handler(request({files:[photo,photo,photo],fields:{file_notes:JSON.stringify(['front','back','front'])}}))).status,200);
 const entries=f.calls.find(c=>c.name==='commit_qr_intake').args.p_files;
 assert.deepEqual(entries.map(e=>e.notes),['front','back']);assert.equal(new Set(entries.map(e=>e.storage_path)).size,2);
});
test('same filename with different photo bytes keeps both',async()=>{
 const f=fixture();assert.equal((await f.handler(request({files:[new File(['a'],'art.jpg'),new File(['b'],'art.jpg')]}))).status,200);
 const entries=f.calls.find(c=>c.name==='commit_qr_intake').args.p_files;assert.equal(entries.length,2);assert.notEqual(entries[0].storage_path,entries[1].storage_path);
});
test('sanitized filename collisions keep unique paths and original names',async()=>{
 const f=fixture();assert.equal((await f.handler(request({files:[new File(['a'],'art?.jpg'),new File(['a'],'art*.jpg')]}))).status,200);
 const entries=f.calls.find(c=>c.name==='commit_qr_intake').args.p_files;assert.equal(entries.length,2);assert.equal(new Set(entries.map(e=>e.storage_path)).size,2);assert.deepEqual(entries.map(e=>e.file_name),['art?.jpg','art*.jpg']);
});
test('duplicates retry safely against already uploaded objects',async()=>{
 const f=fixture({duplicate:true}),photo=new File(['photo'],'art.jpg');
 for(let i=0;i<2;i++)assert.equal((await f.handler(request({files:[photo,photo]}))).status,200);
 const commits=f.calls.filter(c=>c.name==='commit_qr_intake');assert.equal(commits.length,2);assert.deepEqual(commits[0].args.p_files,commits[1].args.p_files);assert.equal(commits[0].args.p_files.length,1);
});
