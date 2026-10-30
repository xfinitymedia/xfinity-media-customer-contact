const MAX_BODY=28*1024*1024;
const MAX_FILES=25*1024*1024;
export async function readIntakeForm(request:Request) {
  const declared=Number(request.headers.get('content-length') || 0);
  if(declared>MAX_BODY) throw new Error('Total upload must be 25 MB or smaller.');
  const reader=request.body?.getReader();if(!reader) throw new Error('Submission is empty.');
  const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BODY){await reader.cancel();throw new Error('Total upload must be 25 MB or smaller.');}chunks.push(part.value);}
  const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return new Request('https://intake.invalid',{method:'POST',headers:{'Content-Type':request.headers.get('content-type') || ''},body}).formData();
}
export function parseIntake(form:FormData) {
  const field=(name:string,max:number)=>{const value=String(form.get(name)||'').trim();if(value.length>max)throw new Error(`${name.replace('_',' ')} is too long.`);return value;};
  const token=field('access_token',64),id=field('submission_id',36);
  if(!/^[a-f0-9]{64}$/.test(token)||!/^[a-f0-9-]{36}$/.test(id))throw new Error('Open a valid customer intake link.');
  if(field('website',200))throw new Error('Could not accept this submission.');
  const contact={name:field('name',150),contact_name:field('contact_name',150),email:field('email',200).toLowerCase(),phone:field('phone',60),address:field('address',300),notes:field('notes',2000)};
  if(!contact.name || (!contact.email && !contact.phone))throw new Error('Enter your name and either an email address or phone number.');
  if(contact.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email))throw new Error('Enter a valid email address.');
  const files=form.getAll('files').filter((value):value is File=>typeof value!=='string'&&value.size>0);
  if(files.length>10 || files.reduce((n,file)=>n+file.size,0)>MAX_FILES)throw new Error('Choose up to 10 files, totalling 25 MB or less.');
  for(const file of files) if(file.name.length>180 || !/\.(pdf|png|jpe?g|webp|svg|ai|eps|zip)$/i.test(file.name))throw new Error('Supported files: PDF, PNG, JPG, WEBP, SVG, AI, EPS and ZIP.');
  return {token,id,contact,files};
}

