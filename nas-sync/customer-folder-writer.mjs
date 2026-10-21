import {open,lstat,link,unlink,readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';

export async function checkedFolder(root,customerFolder,subfolder='') {
 const parts=[customerFolder,subfolder].filter(Boolean).join('/').split('/');
 if(parts.some(p=>!p||p==='.'||p==='..'||/[\\\x00-\x1f]/.test(p))||path.isAbsolute(customerFolder)||path.isAbsolute(subfolder))throw Error('Invalid customer folder');
 let current=path.resolve(root);
 for(const part of ['',...parts]) {
  if(part)current=path.join(current,part);
  const info=await lstat(current);
  if(info.isSymbolicLink()||!info.isDirectory())throw Error('NAS folder must be an existing directory without symlinks');
 }
 return current;
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function publishNewFile(directory,name,bytes,expectedHash) {
 if(!name||name!==path.basename(name)||/[\\\x00-\x1f]/.test(name))throw Error('Invalid filename');
 const data=Buffer.from(bytes);if(digest(data)!==expectedHash)throw Error('Uploaded file checksum does not match');
 const target=path.join(directory,name),temp=path.join(directory,`.${randomUUID()}.uploading`);
 const parent=await lstat(directory);if(parent.isSymbolicLink()||!parent.isDirectory())throw Error('Unsafe destination');
 const handle=await open(temp,'wx',0o600);
 try {
  await handle.writeFile(data);const info=await handle.stat();
  if(info.uid!==parent.uid||info.gid!==parent.gid)await handle.chown(parent.uid,parent.gid);
  await handle.chmod(parent.mode&0o666);await handle.sync();await handle.close();
  try {await link(temp,target);}catch(error){
   if(error.code!=='EEXIST')throw error;
   const existing=await lstat(target);
   if(existing.isSymbolicLink()||!existing.isFile()||existing.size!==data.length||digest(await readFile(target))!==expectedHash)throw Error('Destination already exists. Existing file was preserved.');
  }
  return {size:data.length,sha256:expectedHash,path:target};
 } finally {await handle.close().catch(()=>{});await unlink(temp).catch(()=>{});}
}

export async function pollCustomerNasUploads(db,root) {
 const now=new Date().toISOString();
 const {data:jobs,error}=await db.from('customer_nas_uploads').select('id').or(`status.eq.pending,and(status.eq.syncing,lease_until.lt.${now})`).order('created_at').limit(5);
 if(error)throw error;
 for(const candidate of jobs||[]) {
  const {data:job,error:claimError}=await db.rpc('claim_customer_nas_upload',{p_id:candidate.id});
  if(claimError)throw claimError;if(!job)continue;
  try {
   const directory=await checkedFolder(root,job.customer_folder,job.subfolder);
   const {data:blob,error:downloadError}=await db.storage.from('customer-nas-uploads').download(job.object_path);
   if(downloadError)throw downloadError;
   const bytes=Buffer.from(await blob.arrayBuffer());if(bytes.length!==Number(job.file_size))throw Error('Uploaded file size does not match');
   const result=await publishNewFile(directory,job.saved_name,bytes,job.sha256);
   const {error:finishError}=await db.from('customer_nas_uploads').update({status:'synced',nas_path:path.relative(root,result.path),lease:null,lease_until:null,error_message:null}).eq('id',job.id).eq('lease',job.lease);
   if(finishError)throw finishError;
  } catch(error) {
   await db.from('customer_nas_uploads').update({status:'error',error_message:String(error.message||error).slice(0,500),lease:null,lease_until:null}).eq('id',job.id).eq('lease',job.lease);
  }
 }
}
