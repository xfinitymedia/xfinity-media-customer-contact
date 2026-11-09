export const keepOpenText='Your entered details remain on this page. Please don’t refresh or close it.';
export const unconfirmedText='We couldn’t confirm whether your submission was received. Keep this page open and try again so we can check its status.';
export const saveFailedText='We couldn’t save your submission because of a system problem. Keep this page open and try again. If it happens again, please contact Xfinity Media.';
const allowed=['pdf','png','jpg','jpeg','webp','svg','ai','eps','zip'];
export function validateContact(payload,files,fileNotes={}){
 if(!payload.name)return 'Please enter your name or company name.';
 if(!payload.email&&!payload.phone)return 'Please provide an email address or phone number so we can contact you.';
 const fields=[['name','customer or company name',150],['contact_name','contact name',150],['email','email address',200],['phone','phone number',60],['address','address',300]];
 for(const [key,label,limit] of fields)if(String(payload[key]||'').length>limit)return `Your ${label} is too long. Please shorten it to ${limit} characters.`;
 if(payload.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email))return 'Please check your email address. It should look like name@example.com.';
 if(files.length>10)return 'You can attach up to 10 files. Please remove some files and try again.';
 if(files.reduce((total,file)=>total+file.size,0)>25*1024*1024)return 'Your attachments exceed the 25 MB total limit. Please reduce their size or remove some files.';
 for(const file of files){
  if(!file.size)return `${file.name} appears to be empty. Please remove it or select another copy.`;
  if(file.name.length>180)return `The name of ${file.name} is too long. Please rename the file using fewer than 181 characters and select it again.`;
  if(!allowed.includes(file.name.split('.').pop()?.toLowerCase()))return `We can’t accept ${file.name}. Please use PDF, PNG, JPG, WEBP, SVG, AI, EPS or ZIP.`;
  const key=`${file.name}-${file.size}-${file.lastModified}`;
  if(String(fileNotes[key]||'').trim().length>500)return `The note for ${file.name} is too long. Please shorten it to 500 characters.`;
 }
 return null;
}
export function failureStatus(result){
 if(!result)return {ok:false,message:unconfirmedText,restart:false};
 return {ok:false,message:result.code&&typeof result.error==='string'?result.error:saveFailedText,restart:result.code==='SESSION_INVALID'||result.code==='FORM_INVALID'};
}
