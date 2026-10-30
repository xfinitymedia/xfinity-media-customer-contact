import {readIntakeForm,parseIntake} from './validation.ts';
const ORIGIN='https://xfinity-media-customer-contact.vercel.app';
const hex=(bytes:ArrayBuffer)=>Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
export function qrIntakeHandler(client:any,rateSecret:string) {
 return async(request:Request)=>{
  const origin=request.headers.get('origin') || '';
  const cors={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Headers':'apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'};
  const json=(status:number,value:unknown)=>new Response(JSON.stringify(value),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
  if(origin!==ORIGIN)return new Response('Forbidden',{status:403});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST')return json(405,{error:'Use the customer submission form.'});
  if(!request.headers.get('content-type')?.startsWith('multipart/form-data;'))return json(415,{error:'Use the customer submission form.'});
  let reserved:{id:string;token:string}|null=null;
  try {
   const form=await readIntakeForm(request);
   const {token,id,contact,files}=parseIntake(form);
   if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))return json(400,{error:'Refresh the form and try again.'});
   const notes=JSON.parse(String(form.get('file_notes') || '[]'));
   if(!Array.isArray(notes)||notes.length!==files.length||notes.some(n=>typeof n!=='string'||n.length>500))return json(400,{error:'Each file note must be 500 characters or less.'});
   const rateKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(rateSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
   // Supplemental network limit. Global quotas do not depend on this header.
   const ipHash=hex(await crypto.subtle.sign('HMAC',rateKey,new TextEncoder().encode(request.headers.get('cf-connecting-ip') || 'unknown')));
   const gate=await client.rpc('reserve_qr_intake',{p_submission_id:id,p_token:token,p_ip_hash:ipHash});
   if(gate.error){console.error('qr-intake reserve failed',gate.error.code);return json(503,{error:'We could not start your submission. Please try again shortly.'});}
   if(!gate.data?.allowed){
    const reason=gate.data?.reason;
    return json(reason==='busy'?409:reason==='limited'?429:403,{error:reason==='busy'?'Your submission is still processing. Please wait a moment before retrying.':reason==='limited'?'Too many attempts. Please try again later or contact Xfinity Media.':'This submission has expired. Refresh the form and try again.'});
   }
   if(gate.data.submitted)return json(200,{ok:true});
   reserved={id,token};
   const state=await client.rpc('customer_intake_link_state',{p_token:token,p_submission_id:id});
   if(state.error||!state.data?.valid)throw new Error('Could not start your submission. Please try again shortly.');
   if(state.data.submitted)return json(200,{ok:true});
   const entries=[];
   for(let i=0;i<files.length;i++){
    const file=files[i];const bytes=await file.arrayBuffer();
    const hash=hex(await crypto.subtle.digest('SHA-256',bytes));
    const path=`${id}/${hash.slice(0,32)}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const upload=await client.storage.from('customer-uploads').upload(path,bytes,{contentType:file.type || 'application/octet-stream',upsert:false});
    if(upload.error&&!['409','Duplicate'].includes(String(upload.error.statusCode||upload.error.error)))throw new Error('Could not upload a file. Your details have been kept on this page; please try again.');
    entries.push({storage_path:path,file_name:file.name,file_size:file.size,mime_type:file.type || 'application/octet-stream',notes:notes[i].trim()});
   }
   const saved=await client.rpc('commit_qr_intake',{p_token:token,p_submission_id:id,p_contact:contact,p_files:entries});
   if(saved.error){console.error('qr-intake commit failed',saved.error.code);throw new Error('Could not save your submission. Your details have been kept on this page; please try again.');}
   // Do not return customer data, staff credentials or portal capabilities.
   return json(200,{ok:true});
  } catch(error){return json(400,{error:error instanceof SyntaxError?'Invalid file notes.':error instanceof Error?error.message:'Could not accept this submission.'});}
  finally {
   if(reserved){try{await client.rpc('finish_qr_intake',{p_submission_id:reserved.id,p_token:reserved.token});}catch{console.error('qr-intake lease release failed');}}
  }
 };
}
