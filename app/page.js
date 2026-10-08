'use client';

import { useState } from 'react';

const SUPABASE_URL = 'https://tewiyvnftjowcplnhdce.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6TK07QQyLZWGGj1ZZpbkvg_mTXGheF2';
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['pdf','png','jpg','jpeg','webp','svg','ai','eps','zip'];

function safeFileName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
}

function fileKey(file) {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

export default function Page() {
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [files, setFiles] = useState([]);
  const [fileNotes, setFileNotes] = useState({});

  function addFiles(selectedFiles) {
    const incoming = Array.from(selectedFiles || []);
    setFiles((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...incoming.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function removeFile(key) {
    setFiles((current) => current.filter((file) => fileKey(file) !== key));
    setFileNotes((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function updateFileNote(key, value) {
    setFileNotes((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const payload = {
      id: crypto.randomUUID(),
      name: String(data.get('name') || '').trim(),
      contact_name: String(data.get('contact_name') || '').trim() || null,
      email: String(data.get('email') || '').trim().toLowerCase() || null,
      phone: String(data.get('phone') || '').trim() || null,
      address: String(data.get('address') || '').trim() || null,
      website: String(data.get('website') || '')
    };

    if (!payload.name) return setStatus({ ok:false, message:'Please enter your name or business name.' });
    if (!payload.email && !payload.phone) return setStatus({ ok:false, message:'Please provide an email address or phone number.' });

    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (!ALLOWED_EXTENSIONS.includes(ext)) return setStatus({ ok:false, message:`${file.name}: unsupported file type.` });
      if (file.size > MAX_FILE_SIZE) return setStatus({ ok:false, message:`${file.name}: files must be 25 MB or smaller.` });
    }

    setSubmitting(true);
    try {
      const headers = { apikey: SUPABASE_PUBLISHABLE_KEY };
      const response = await fetch(`${SUPABASE_URL}/rest/v1/customer_contact_submissions`, {
        method:'POST',
        headers:{ ...headers, 'Content-Type':'application/json', Prefer:'return=minimal' },
        body:JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('Contact submission failed');

      for (const file of files) {
        const key = fileKey(file);
        const path = `${payload.id}/${crypto.randomUUID()}-${safeFileName(file.name)}`;
        const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/customer-uploads/${encodeURIComponent(path).replace(/%2F/g,'/')}`, {
          method:'POST',
          headers:{ ...headers, 'Content-Type':file.type || 'application/octet-stream', 'x-upsert':'false' },
          body:file
        });
        if (!upload.ok) throw new Error(`Could not upload ${file.name}`);

        const meta = await fetch(`${SUPABASE_URL}/rest/v1/customer_uploads`, {
          method:'POST',
          headers:{ ...headers, 'Content-Type':'application/json', Prefer:'return=minimal' },
          body:JSON.stringify({
            submission_id:payload.id,
            storage_path:path,
            file_name:file.name,
            file_size:file.size,
            mime_type:file.type || null,
            notes:String(fileNotes[key] || '').trim() || null,
            category:'Customer Uploads',
            sync_status:'pending'
          })
        });
        if (!meta.ok) throw new Error(`Could not register ${file.name}`);
      }

      form.reset();
      const uploadedCount = files.length;
      setFiles([]);
      setFileNotes({});
      setStatus({ ok:true, message:uploadedCount ? `Thank you — your contact details and ${uploadedCount} file${uploadedCount === 1 ? '' : 's'} have been submitted.` : 'Thank you — your contact details have been submitted.' });
    } catch {
      setStatus({ ok:false, message:'We could not complete your submission. Please try again or contact Xfinity Media.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="wrap">
      <div className="brand"><div className="mark" aria-hidden="true"/><div className="brandtext">Xfinity Media</div></div>
      <section className="card">
        <h1>Share your contact details</h1>
        <p>Fill this out once and our team will have your information ready for quotes, orders and invoices. You can also send us artwork or other order files.</p>
        <form onSubmit={handleSubmit}>
          <div className="grid">
            <div className="full"><label htmlFor="name">Customer / Company Name *</label><input id="name" name="name" maxLength="150" required autoComplete="organization" placeholder="Your name or business name" /></div>
            <div><label htmlFor="contact_name">Contact Name</label><input id="contact_name" name="contact_name" maxLength="150" autoComplete="name" placeholder="Main contact" /></div>
            <div><label htmlFor="phone">Phone</label><input id="phone" name="phone" maxLength="60" autoComplete="tel" inputMode="tel" placeholder="604-555-0123" /></div>
            <div className="full"><label htmlFor="email">Email</label><input id="email" name="email" maxLength="200" type="email" autoComplete="email" placeholder="name@company.ca" /><div className="hint">Please provide at least an email address or phone number.</div></div>
            <div className="full"><label htmlFor="address">Address</label><textarea id="address" name="address" maxLength="300" autoComplete="street-address" placeholder="Street, city, province, postal code" /></div>
            <div className="full upload-field">
              <label htmlFor="files">Upload Artwork / Files</label>
              <input id="files" name="files" type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.svg,.ai,.eps,.zip" onChange={(e)=>{ addFiles(e.target.files); e.target.value=''; }} />
              <div className="hint">Optional. Select multiple files at once, or choose files again to add more. PDF, PNG, JPG, SVG, AI, EPS or ZIP. Maximum 25 MB per file.</div>
              {files.length > 0 && (
                <div className="selected-files">
                  <div className="selected-files-header">{files.length} file{files.length === 1 ? '' : 's'} selected</div>
                  <div className="file-list">
                    {files.map((file)=>{
                      const key = fileKey(file);
                      return (
                        <div key={key} className="file-row">
                          <div className="file-row-top">
                            <div className="file-info"><strong>{file.name}</strong><span>{(file.size/1024/1024).toFixed(1)} MB</span></div>
                            <button type="button" className="remove-file" onClick={()=>removeFile(key)}>Remove</button>
                          </div>
                          <div className="file-note-wrap">
                            <label htmlFor={`note-${key}`}>Notes for this file</label>
                            <textarea id={`note-${key}`} className="file-note" maxLength="500" value={fileNotes[key] || ''} onChange={(e)=>updateFileNote(key, e.target.value)} placeholder="Optional — add any instructions or details about this attachment" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
            <div className="hidden" aria-hidden="true"><label htmlFor="website">Website</label><input id="website" name="website" tabIndex="-1" autoComplete="off" /></div>
          </div>
          <button type="submit" disabled={submitting}>{submitting ? 'Submitting…' : files.length ? `Submit Contact Details & ${files.length} File${files.length === 1 ? '' : 's'}` : 'Submit Contact Details'}</button>
          {status && <div className={`status ${status.ok ? 'ok' : 'err'}`} role="status" aria-live="polite">{status.message}</div>}
        </form>
      </section>
      <div className="fine">Your information and uploaded files are sent securely to Xfinity Media and are not displayed publicly.</div>
    </main>
  );
}
