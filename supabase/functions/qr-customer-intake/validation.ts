import {problem} from './errors.ts';
const MAX_BODY=28*1024*1024;
const MAX_FILES=25*1024*1024;
export async function readIntakeForm(request:Request) {
 const declared=Number(request.headers.get('content-length') || 0);
 if(declared>MAX_BODY)throw problem('FILE_SIZE');
 const reader=request.body?.getReader();if(!reader)throw problem('FORM_INVALID');
 const chunks:Uint8Array[]=[];let bytes=0;
 for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BODY){await reader.cancel();throw problem('FILE_SIZE');}chunks.push(part.value);}
 const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
 try{return await new Request('https://intake.invalid',{method:'POST',headers:{'Content-Type':request.headers.get('content-type') || ''},body}).formData();}
 catch{throw problem('FORM_INVALID');}
}
export function parseIntake(form:FormData) {
 const labels:Record<string,string>={name:'customer or company name',contact_name:'contact name',email:'email address',phone:'phone number',address:'address',notes:'notes'};
 const field=(name:string,max:number)=>{const value=String(form.get(name)||'').trim();if(value.length>max)throw problem('FIELD_LENGTH',`Your ${labels[name] || 'form field'} is too long. Please shorten it to ${max} characters.`);return value;};
 const token=field('access_token',64),id=field('submission_id',36);
 if(!/^[a-f0-9]{64}$/.test(token)||!/^[a-f0-9-]{36}$/.test(id))throw problem('SESSION_INVALID');
 if(field('website',200))throw problem('FORM_INVALID');
 const contact={name:field('name',150),contact_name:field('contact_name',150),email:field('email',200).toLowerCase(),phone:field('phone',60),address:field('address',300),notes:field('notes',2000)};
 if(!contact.name)throw problem('NAME_REQUIRED','Please enter your name or company name.');
 if(!contact.email&&!contact.phone)throw problem('CONTACT_REQUIRED','Please provide an email address or phone number so we can contact you.');
 if(contact.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))throw problem('EMAIL_INVALID','Please check your email address. It should look like name@example.com.');
 const files=form.getAll('files').filter((value):value is File=>typeof value!=='string'&&(value.size>0||value.name!==''));
 if(files.length>10)throw problem('FILE_COUNT');
 if(files.reduce((n,file)=>n+file.size,0)>MAX_FILES)throw problem('FILE_SIZE');
 for(const file of files){
  if(!file.size)throw problem('FILE_EMPTY',`${file.name} appears to be empty. Please remove it or select another copy.`);
  if(file.name.length>180)throw problem('FILE_NAME',`The name of ${file.name} is too long. Please rename the file using fewer than 181 characters and select it again.`);
  if(!/\.(pdf|png|jpe?g|webp|svg|ai|eps|zip)$/i.test(file.name))throw problem('FILE_TYPE',`We can’t accept ${file.name}. Please use PDF, PNG, JPG, WEBP, SVG, AI, EPS or ZIP.`);
 }
 return {token,id,contact,files};
}
