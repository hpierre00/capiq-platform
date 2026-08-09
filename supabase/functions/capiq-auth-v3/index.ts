// capiq-auth-v3 — Supabase Auth, backward-compatible with v2 legacy tokens
import{serve}from'https://deno.land/std@0.168.0/http/server.ts';import{createClient}from'https://esm.sh/@supabase/supabase-js@2';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json'};
const LEGACY_SALT='capiq-salt-2026';const TTL=7*24*60*60*1000;
let _hmacKey:CryptoKey|null=null;
async function hmacKey():Promise<CryptoKey>{
  if(_hmacKey)return _hmacKey;
  const root=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const rk=await crypto.subtle.importKey('raw',new TextEncoder().encode(root),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const derived=await crypto.subtle.sign('HMAC',rk,new TextEncoder().encode('capiq-investor-legacy-token-v1'));
  _hmacKey=await crypto.subtle.importKey('raw',derived,{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
  return _hmacKey;
}
serve(async(req)=>{
  if(req.method==='OPTIONS')return new Response(null,{status:200,headers:cors});
  const URL_=Deno.env.get('SUPABASE_URL')!;const SK=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;const AK=Deno.env.get('SUPABASE_ANON_KEY')!;
  const sb=createClient(URL_,SK,{auth:{autoRefreshToken:false,persistSession:false}});
  const sbA=createClient(URL_,AK,{auth:{autoRefreshToken:false,persistSession:false}});
  try{
    const b=await req.json();const{action,email,password,token,name}=b;
    if(action==='signup'){
      if(!email||!password||password.length<8)return err(password?.length<8?'Password must be at least 8 characters.':'Email and password required.');
      const{data:ex}=await sb.from('investors').select('id').eq('email',email).maybeSingle();
      if(ex)return err('Account already exists.',409);
      const{data:au,error:ae}=await sb.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{role:'investor',name:name||''}});
      if(ae)return err(ae.message);
      const{data:inv,error:ce}=await sb.from('investors').insert({email,name:name||'',plan:'starter',analyses_this_month:0,supabase_uid:au.user.id}).select('*').single();
      if(ce){await sb.auth.admin.deleteUser(au.user.id);return err(ce.message);}
      const{data:sess}=await sbA.auth.signInWithPassword({email,password});
      if(sess?.session)return ok({token:sess.session.access_token,refresh_token:sess.session.refresh_token,investor:sf(inv)});
      return ok({token:await gtL(inv.id,inv.email,inv.plan),investor:sf(inv)});
    }
    if(action==='login'){
      const{data:inv}=await sb.from('investors').select('*').eq('email',email).maybeSingle();
      if(!inv)return err('No account found with this email.',401);
      const{data:exists}=await sb.rpc('auth_user_exists',{p_email:email});
      if(exists){
        const{data:sess,error:se}=await sbA.auth.signInWithPassword({email,password});
        if(se||!sess?.session)return err('Incorrect password.',401);
        if(!inv.supabase_uid)await sb.from('investors').update({supabase_uid:sess.session.user.id}).eq('id',inv.id);
        return ok({token:sess.session.access_token,refresh_token:sess.session.refresh_token,investor:sf(inv)});
      }
      if(inv.password_hash!==await hp(password))return err('Incorrect password.',401);
      const{data:au,error:ae}=await sb.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{role:'investor',name:inv.name}});
      if(!ae&&au?.user){
        await sb.from('investors').update({supabase_uid:au.user.id}).eq('id',inv.id);
        const{data:sess}=await sbA.auth.signInWithPassword({email,password});
        if(sess?.session)return ok({token:sess.session.access_token,refresh_token:sess.session.refresh_token,investor:sf(inv)});
      }
      return ok({token:await gtL(inv.id,inv.email,inv.plan),investor:sf(inv)});
    }
    if(action==='verify'){
      if(!token)return new Response(JSON.stringify({valid:false}),{status:200,headers:cors});
      if(token.split('.').length===3){
        const{data:{user}}=await sbA.auth.getUser(token);
        if(user){const{data:inv}=await sb.from('investors').select('*').eq('email',user.email).maybeSingle();if(inv)return new Response(JSON.stringify({valid:true,investor:sf(inv)}),{status:200,headers:cors});}
      }else{
        const p=await vtL(token);if(p){const{data:inv}=await sb.from('investors').select('*').eq('id',p.id).maybeSingle();if(inv)return new Response(JSON.stringify({valid:true,investor:sf(inv)}),{status:200,headers:cors});}
      }
      return new Response(JSON.stringify({valid:false}),{status:200,headers:cors});
    }
    if(action==='refresh'){
      const{refresh_token:rt}=b;if(!rt)return err('refresh_token required.');
      const{data:{session},error}=await sbA.auth.refreshSession({refresh_token:rt});
      if(error||!session)return err('Session expired. Please sign in again.',401);
      const{data:inv}=await sb.from('investors').select('*').eq('email',session.user.email).maybeSingle();
      return ok({token:session.access_token,refresh_token:session.refresh_token,investor:sf(inv)});
    }
    if(action==='reset_request'){
      const rt=crypto.randomUUID();
      await sb.from('investors').update({reset_token:rt,reset_token_expires:new Date(Date.now()+3600000).toISOString()}).eq('email',email);
      return ok({message:'Reset link sent.',resetToken:rt});
    }
    if(action==='reset_confirm'){
      const{resetToken:rt,newPassword:np}=b;if(!rt||!np||np.length<8)return err('Invalid reset request.');
      const{data:inv}=await sb.from('investors').select('*').eq('reset_token',rt).gt('reset_token_expires',new Date().toISOString()).maybeSingle();
      if(!inv)return err('Invalid or expired reset link.',400);
      await sb.from('investors').update({password_hash:await hp(np),reset_token:null,reset_token_expires:null}).eq('id',inv.id);
      if(inv.supabase_uid)await sb.auth.admin.updateUserById(inv.supabase_uid,{password:np});
      const{data:sess}=await sbA.auth.signInWithPassword({email:inv.email,password:np});
      if(sess?.session)return ok({token:sess.session.access_token,refresh_token:sess.session.refresh_token,investor:sf(inv)});
      return ok({token:await gtL(inv.id,inv.email,inv.plan),investor:sf(inv)});
    }
    if(action==='increment_usage'){
      let investorEmail:string|null=null;let investorId:string|null=null;
      if(token?.split('.').length===3){const{data:{user}}=await sbA.auth.getUser(token);if(user)investorEmail=user.email||null;}
      else{const p=await vtL(token);if(p)investorId=p.id;}
      const{data:inv}=investorEmail?await sb.from('investors').select('*').eq('email',investorEmail).maybeSingle():investorId?await sb.from('investors').select('*').eq('id',investorId).maybeSingle():{data:null};
      if(!inv)return err('Invalid session.',401);
      const now=new Date();const ra=new Date(inv.usage_reset_at||new Date(now.getFullYear(),now.getMonth()+1,1));
      if(now>=ra){await sb.from('investors').update({analyses_this_month:1,usage_reset_at:new Date(now.getFullYear(),now.getMonth()+1,1).toISOString()}).eq('id',inv.id);return ok({analyses_this_month:1});}
      await sb.from('investors').update({analyses_this_month:(inv.analyses_this_month||0)+1}).eq('id',inv.id);
      return ok({analyses_this_month:(inv.analyses_this_month||0)+1});
    }
    return err('Unknown action.');
  }catch(e:any){return new Response(JSON.stringify({error:'Server error',message:e.message}),{status:500,headers:cors});}
});
async function hp(pw:string){const d=new TextEncoder().encode(pw+LEGACY_SALT);const h=await crypto.subtle.digest('SHA-256',d);return Array.from(new Uint8Array(h)).map(b=>b.toString(16).padStart(2,'0')).join('');}
async function gtL(id:string,email:string,plan:string){const p={id,email,plan,iat:Date.now(),exp:Date.now()+TTL};const d=btoa(JSON.stringify(p));return d+'.'+await hmL(d);}
async function vtL(t:string):Promise<any>{try{const[d,s]=t.split('.');if(await hmL(d)!==s)return null;const p=JSON.parse(atob(d));return p.exp<Date.now()?null:p;}catch{return null;}}
async function hmL(d:string):Promise<string>{const key=await hmacKey();const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(d));return Array.from(new Uint8Array(sig)).map(b=>b.toString(16).padStart(2,'0')).join('');}
function sf(inv:any){return{id:inv.id,email:inv.email,name:inv.name,plan:inv.plan,analyses_this_month:inv.analyses_this_month,stripe_customer_id:inv.stripe_customer_id,created_at:inv.created_at};}
function ok(data:any){return new Response(JSON.stringify({success:true,...data}),{status:200,headers:cors});}
function err(msg:string,s=400){return new Response(JSON.stringify({error:msg}),{status:s,headers:cors});}
