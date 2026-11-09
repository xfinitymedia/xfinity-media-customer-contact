import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {validateContact,failureStatus,keepOpenText} from '../app/intakeMessages.js';
import {test} from 'node:test';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../app/page.js',import.meta.url),'utf8');
const setup=source.slice(source.indexOf('const SUPABASE_URL'),source.indexOf('export default function Page'));
const handler=source.slice(source.indexOf('  async function handleSubmit'),source.indexOf('\n  return ('));
function fixture({fields={},files=[],fail=false,network=false,submitting=false}={}){
 const calls=[],statuses=[],resets=[],busy=[],submission={current:null};
 class TestFormData {
  constructor(form){this.values=new Map(Object.entries(form?{name:' Test Customer ',email:' TEST@example.invalid ',...fields}:{}));this.files=[];}
  get(key){return this.values.get(key);}
  append(key,value){if(key==='files')this.files.push(value);else this.values.set(key,value);}
 }
 const context=vm.createContext({validateContact,failureStatus,keepOpenText,files,fileNotes:Object.fromEntries(files.map(f=>[`${f.name}-${f.size}-${f.lastModified}`,' File note '])),submission,submitting,crypto:webcrypto,FormData:TestFormData,
 fetch:async(url,options)=>{calls.push({url,...options});if(network)throw new Error('Network failed');return {ok:!fail,json:async()=>fail?{error:'Please try again.'}:{ok:true}};},
 setStatus:v=>statuses.push(v),setSubmitting:v=>busy.push(v),setFiles:v=>resets.push(v),setFileNotes:v=>resets.push(v)});
 vm.runInContext(`${setup}\n${handler}\nglobalThis.submit=handleSubmit`,context);
 return {calls,statuses,resets,busy,submission,context,submit:()=>context.submit({preventDefault(){},currentTarget:{reset(){resets.push('form');}}})};
}
test('contact-only makes one protected request; no direct database or storage writes',async()=>{
 const f=fixture();await f.submit();assert.equal(f.calls.length,1);assert.match(f.calls[0].url,/functions\/v1\/qr-customer-intake$/);
 const body=f.calls[0].body;assert.equal(body.get('name'),'Test Customer');assert.equal(body.get('email'),'test@example.invalid');
 assert.match(body.get('access_token'),/^[a-f0-9]{64}$/);assert.match(body.get('submission_id'),/^[a-f0-9-]{36}$/);
 assert.equal(f.statuses.at(-1).ok,true);assert.equal(f.submission.current,null);
});
const file={name:'art.pdf',size:1200,type:'application/pdf',lastModified:10};
test('multiple files and notes travel together in the atomic request',async()=>{const f=fixture({files:[file,{...file,name:'logo.png'}]});await f.submit();assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.files.length,2);assert.deepEqual(JSON.parse(f.calls[0].body.get('file_notes')),['File note','File note']);assert.match(f.statuses.at(-1).message,/2 files/);});
for(const [label,opts] of [['server rejection',{fail:true}],['network loss',{network:true}]])test(label+' keeps fields and capability for a safe retry',async()=>{
 const f=fixture(opts);await f.submit();const first=f.calls[0].body;assert.equal(f.statuses.at(-1).ok,false);assert.equal(f.resets.length,0);await f.submit();
 assert.equal(f.calls[1].body.get('submission_id'),first.get('submission_id'));assert.equal(f.calls[1].body.get('access_token'),first.get('access_token'));assert.equal(f.busy.at(-1),false);
});
for(const [label,opts] of [
 ['name',{fields:{name:' '}}],['contact',{fields:{email:'',phone:''}}],['extension',{files:[{...file,name:'art.exe'}]}],['oversize',{files:[{...file,size:26*1024*1024}]}],
 ['too many files',{files:Array.from({length:11},()=>file)}],['combined size',{files:[{...file,size:14*1024*1024},{...file,size:14*1024*1024}]}],['empty file',{files:[{...file,size:0}]}],['long filename',{files:[{...file,name:'a'.repeat(181)+'.pdf'}]}]
])test(label+' validation prevents all requests',async()=>{const f=fixture(opts);await f.submit();assert.equal(f.calls.length,0);assert.equal(f.statuses.at(-1).ok,false);});
test('phone-only works',async()=>{const f=fixture({fields:{email:'',phone:'6045550100'}});await f.submit();assert.equal(f.statuses.at(-1).ok,true);});
test('busy submission prevents another request',async()=>{const f=fixture({submitting:true});await f.submit();assert.equal(f.calls.length,0);});

test('connection failure retains form, files and submission identity with clear guidance',async()=>{const f=fixture({network:true,files:[file]});await f.submit();assert.match(f.statuses.at(-1).message,/couldn’t confirm/);assert.equal(f.resets.length,0);assert.ok(f.submission.current);});
test('frontend renders errors at bottom and uses its own validation',()=>{assert.match(source,/<form onSubmit=\{handleSubmit\} noValidate>/);assert.match(source,/keepOpenText/);});
