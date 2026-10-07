'use client';

import { useState } from 'react';

const SUPABASE_URL = 'https://tewiyvnftjowcplnhdce.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6TK07QQyLZWGGj1ZZpbkvg_mTXGheF2';

export default function Page() {
  const [status, setStatus] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setStatus(null);
    const data = new FormData(event.currentTarget);
    const payload = {
      name: String(data.get('name') || '').trim(),
      contact_name: String(data.get('contact_name') || '').trim() || null,
      email: String(data.get('email') || '').trim().toLowerCase() || null,
      phone: String(data.get('phone') || '').trim() || null,
      address: String(data.get('address') || '').trim() || null,
      website: String(data.get('website') || '')
    };

    if (!payload.name) {
      setStatus({ ok: false, message: 'Please enter your name or business name.' });
      return;
    }
    if (!payload.email && !payload.phone) {
      setStatus({ ok: false, message: 'Please provide an email address or phone number.' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/customer_contact_submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Prefer: 'return=minimal'
        },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('Submission failed');
      event.currentTarget.reset();
      setStatus({ ok: true, message: 'Thank you — your contact details have been submitted.' });
    } catch {
      setStatus({ ok: false, message: 'We could not submit your details. Please try again or contact Xfinity Media.' });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="wrap">
      <div className="brand"><div className="mark" aria-hidden="true"/><div className="brandtext">Xfinity Media</div></div>
      <section className="card">
        <h1>Share your contact details</h1>
        <p>Fill this out once and our team will have your information ready for quotes, orders and invoices.</p>
        <form onSubmit={handleSubmit}>
          <div className="grid">
            <div className="full"><label htmlFor="name">Customer / Company Name *</label><input id="name" name="name" maxLength="150" required autoComplete="organization" placeholder="Your name or business name" /></div>
            <div><label htmlFor="contact_name">Contact Name</label><input id="contact_name" name="contact_name" maxLength="150" autoComplete="name" placeholder="Main contact" /></div>
            <div><label htmlFor="phone">Phone</label><input id="phone" name="phone" maxLength="60" autoComplete="tel" inputMode="tel" placeholder="604-555-0123" /></div>
            <div className="full"><label htmlFor="email">Email</label><input id="email" name="email" maxLength="200" type="email" autoComplete="email" placeholder="name@company.ca" /><div className="hint">Please provide at least an email address or phone number.</div></div>
            <div className="full"><label htmlFor="address">Address</label><textarea id="address" name="address" maxLength="300" autoComplete="street-address" placeholder="Street, city, province, postal code" /></div>
            <div className="hidden" aria-hidden="true"><label htmlFor="website">Website</label><input id="website" name="website" tabIndex="-1" autoComplete="off" /></div>
          </div>
          <button type="submit" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit Contact Details'}</button>
          {status && <div className={`status ${status.ok ? 'ok' : 'err'}`} role="status" aria-live="polite">{status.message}</div>}
        </form>
      </section>
      <div className="fine">Your information is sent securely to Xfinity Media and is not displayed publicly.</div>
    </main>
  );
}
