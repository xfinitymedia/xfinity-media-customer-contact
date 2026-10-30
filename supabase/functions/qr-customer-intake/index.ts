import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.95.3';
import {qrIntakeHandler} from './handler.ts';
const url=Deno.env.get('SUPABASE_URL') || '';
if(url!=='https://tewiyvnftjowcplnhdce.supabase.co')throw new Error('Production database required');
const secret=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
if(!secret)throw new Error('Server configuration required');
const client=createClient(url,secret,{auth:{persistSession:false,autoRefreshToken:false}});
// Public form: per-submission capability, service-only RPCs and durable quotas.
Deno.serve(qrIntakeHandler(client,secret));
