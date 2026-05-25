export default async (req) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const body = await req.json();
    const { userType, ...data } = body;
    const webhooks = {
      realtor: 'https://hook.us2.make.com/7f3lfj2en6v8jgs0kxfjkjdeijixutri',
      investor: 'https://hook.us2.make.com/g84gu45p9uehhit5knvdy44cgph8xdq0',
      lender: 'https://hook.us2.make.com/gvwvkvvla4icv0wxiv9x68bx83hnpgsq',
    };
    const url = webhooks[userType];
    if (!url) return new Response(JSON.stringify({ error: 'Unknown userType' }), { status: 400, headers: cors });
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    return new Response(JSON.stringify({ success: true }), { status: 200, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};
