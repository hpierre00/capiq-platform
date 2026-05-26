export default async (req) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });
  try {
    const { text } = await req.json();
    if (!text || text.length > 2000) return new Response(JSON.stringify({ error: 'Invalid text' }), { status: 400 });
    const ELEVEN_KEY = Netlify.env.get('ELEVENLABS_API_KEY') || '';
    if (!ELEVEN_KEY) return new Response(JSON.stringify({ error: 'TTS not configured' }), { status: 503 });
    const VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'; // Sarah — professional, clear
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': ELEVEN_KEY,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1.05 }
      })
    });
    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: 'TTS failed', detail: err }), { status: 502 });
    }
    const audioBuffer = await res.arrayBuffer();
    return new Response(audioBuffer, {
      status: 200,
      headers: { ...cors, 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
};
