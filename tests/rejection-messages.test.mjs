import assert from 'node:assert/strict';
import {test} from 'node:test';
import {qrIntakeHandler} from "../supabase/functions/qr-customer-intake/handler.ts";
import {saveProblem,publicError,messages} from "../supabase/functions/qr-customer-intake/errors.ts";
import {validateContact,failureStatus} from '../app/intakeMessages.js';
const origin='https://xfinity-media-customer-contact.vercel.app';
function request(fields={},files=[],notes=files.map(()=>'')){
 const body=new FormData();for(const [k,v] of Object.entries({name:'QA',email:'qa@example.invalid',submission_id:'12345678-1234-4567-8901-123456789012',access_token:'a'.repeat(64),file_notes:JSON.stringify(notes),...fields}))body.set(k,v);
 for(const f of files)body.append('files',f);
 return new Request('https://example.invalid',{method:'POST',headers:{origin},body});
}
function fixture({gate={allowed:true},commitError=null,uploadError=null,reserveError=null,throwError=false}={}){
 const calls=[];return {calls,handler:qrIntakeHandler({rpc:async(name,args)=>{calls.push(name);if(throwError)throw Error('SECRET SQL FAILURE');if(name==='reserve_qr_intake')return {data:gate,error:reserveError};if(name==='customer_intake_link_state')return {data:{valid:true}};if(name==='commit_qr_intake')return {error:commitError};return {data:true};},storage:{from:()=>({upload:async()=>({error:uploadError})})}},'test-secret')};
}
for(const [name,fields,files,code,fragment] of [
 ['missing name',{name:''},[],'NAME_REQUIRED','name or company name'],
 ['missing contact',{email:''},[],'CONTACT_REQUIRED','so we can contact you'],
 ['invalid email',{email:'bad'},[],'EMAIL_INVALID','name@example.com'],
 ['long address',{address:'x'.repeat(301)},[],'FIELD_LENGTH','300 characters'],
 ['too many files',{},Array.from({length:11},()=>new File(['x'],'a.jpg')),'FILE_COUNT','up to 10 files'],
 ['unsupported HEIC',{},[new File(['x'],'photo.heic')],'FILE_TYPE','photo.heic'],
 ['empty file',{},[new File([],'empty.jpg')],'FILE_EMPTY','appears to be empty'],
 ['long filename',{},[new File(['x'],'x'.repeat(181)+'.jpg')],'FILE_NAME','fewer than 181'],
 ['invalid session',{access_token:'invalid'},[],'SESSION_INVALID','Copy any details'],
 ['honeypot',{website:'spam'},[],'FORM_INVALID','official Xfinity Media form']
])test(name+' gives actionable public wording before writes',async()=>{const f=fixture(),r=await f.handler(request(fields,files));const b=await r.json();assert.equal(b.code,code);assert.ok(b.error.includes(fragment));assert.equal(f.calls.length,0);});
test('oversize upload gives size guidance',async()=>{const f=fixture(),r=await f.handler(new Request('https://example.invalid',{method:'POST',headers:{origin,'content-type':'multipart/form-data; boundary=x','content-length':String(29*1024*1024)},body:'x'}));assert.equal((await r.json()).code,'FILE_SIZE');assert.equal(f.calls.length,0);});
test('long file note names the attachment',async()=>{const f=fixture(),r=await f.handler(request({},[new File(['x'],'front.jpg')],['x'.repeat(501)]));const b=await r.json();assert.equal(b.code,'FILE_NOTES');assert.ok(b.error.includes('front.jpg'));assert.equal(f.calls.length,0);});
test('malformed note payload gets form-integrity guidance',async()=>{const f=fixture(),r=await f.handler(request({file_notes:'invalid'}));assert.equal((await r.json()).code,'FORM_INVALID');});
for(const [reason,limit_type,code] of [['busy',null,'PROCESSING'],['expired',null,'SESSION_INVALID'],['invalid',null,'SESSION_INVALID'],['limited','attempts','ATTEMPT_LIMIT'],['limited','capacity','SERVICE_LIMIT']])test(code+' maps to its own message',async()=>{const f=fixture({gate:{allowed:false,reason,limit_type}}),r=await f.handler(request());const b=await r.json();assert.equal(b.code,code);assert.equal(b.error,messages[code]);assert.equal(f.calls.length,1);});
test('upload failure identifies the failed file',async()=>{const f=fixture({uploadError:{statusCode:'500'}}),r=await f.handler(request({},[new File(['x'],'front.jpg')]));const b=await r.json();assert.equal(b.code,'UPLOAD_FAILED');assert.ok(b.error.includes('front.jpg'));assert.equal(f.calls.includes('commit_qr_intake'),false);});
for(const [error,code] of [[{code:'23505',message:'duplicate idx_customers_name_lower'},'CUSTOMER_CONFLICT'],[{code:'P0001',message:'Please try again later'},'SERVICE_LIMIT'],[{code:'TEST',message:'secret database detail'},'SAVE_FAILED']])test('save error '+code+' hides technical detail',async()=>{const f=fixture({commitError:error}),r=await f.handler(request());const b=await r.json();assert.equal(b.code,code);assert.equal(b.error,messages[code]);assert.equal(b.error.includes('secret'),false);});
test('unexpected backend exceptions do not leak internals',async()=>{const f=fixture({throwError:true}),r=await f.handler(request());assert.equal((await r.json()).error,messages.SAVE_FAILED);});
test('connection loss says unconfirmed, not rejected',()=>{assert.equal(failureStatus(null).message,messages.UNCONFIRMED);assert.equal(failureStatus(null).restart,false);});
test('expired sessions do not instruct the customer to avoid refreshing',()=>{assert.equal(failureStatus({code:'SESSION_INVALID',error:messages.SESSION_INVALID}).restart,true);});
test('frontend validation distinguishes file size, count, notes and fields',()=>{
 const p={name:'QA',email:'qa@example.invalid'};
 assert.ok(validateContact({...p,email:'bad'},[]).includes('name@example.com'));
 assert.ok(validateContact(p,[{name:'large.jpg',size:26*1024*1024}]).includes('25 MB total'));
 assert.ok(validateContact(p,[{name:'empty.jpg',size:0}]).includes('empty'));
 assert.ok(validateContact(p,[{name:'a.jpg',size:1,lastModified:1}],{'a.jpg-1-1':'x'.repeat(501)}).includes('a.jpg'));
 assert.equal(validateContact(p,[]),null);
});
