/**
 * lender-prequal-extract.js
 * POST  /.netlify/functions/lender-prequal-extract
 * Body: { text?: string, image?: string }   (image = base64 data URL)
 *
 * SECURITY: OPENAI_API_KEY is read from process.env — set it in the
 * Netlify dashboard → Site configuration → Environment variables.
 * This key must NEVER appear in any source file or git history.
 */

exports.handler = async function (event) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY is not set in Netlify environment variables');
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'OpenAI key not configured — set OPENAI_API_KEY in Netlify environment variables' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { text, image } = body;
  if (!text && !image) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Provide text or image in request body' }) };
  }

  const systemPrompt =
    'You are a commercial and residential real estate loan underwriting assistant. ' +
    'Extract structured deal information from the provided document. ' +
    'Return ONLY valid JSON — no markdown code fences, no explanation, no prose.';

  const schema = JSON.stringify({
    address: 'full property address or folio number, or null',
    loanType: 'DSCR – Rental Income Based | Bridge Loan | Fix & Flip | Ground-Up Construction | Land Loan | Commercial / Mixed-Use | Private Money / Hard Money | null',
    borrowerName: 'borrower legal name or entity, or null',
    clientName: 'referring broker or originating client, or null',
    purchasePrice: 'integer or null',
    loanAmount: 'integer or null',
    downPayment: 'integer or null',
    creditScore: 'Below 580 | 580–619 | 620–659 | 660–699 | 700–739 | 740+ | null',
    monthlyRent: 'integer or null',
    arv: 'integer or null',
    asIsValue: 'integer or null',
    exitStrategy: 'string or null',
    constructionBudget: 'integer or null',
    loanTerm: 'e.g. 12 Months or null',
    permitStatus: 'string or null',
    confidence: { address: 'high|medium|low', loanType: 'high|medium|low', purchasePrice: 'high|medium|low', loanAmount: 'high|medium|low', borrowerName: 'high|medium|low' },
    questions: ['list of 1-3 critical questions about missing or unclear underwriting info — empty array if none']
  }, null, 2);

  let messages;
  if (image) {
    // Vision model for image uploads
    messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: 'Extract all deal fields from this image and return a JSON object matching this exact schema:\n' + schema }
        ]
      }
    ];
  } else {
    messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: 'Extract all deal fields from the document below and return a JSON object matching this schema:\n' + schema + '\n\nDocument:\n' + (text || '').slice(0, 10500)
      }
    ];
  }

  const model = image ? 'gpt-4o' : 'gpt-4o-mini';
  const reqBody = {
    model,
    messages,
    max_tokens: 1100,
    temperature: 0.1
  };
  if (!image) reqBody.response_format = { type: 'json_object' };

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(reqBody)
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('OpenAI error:', errText.slice(0, 400));
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'OpenAI API error: ' + errText.slice(0, 200) }) };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content || '';

    let fields;
    try {
      fields = JSON.parse(content);
    } catch (e) {
      // Vision model may wrap JSON in markdown code fences
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (match) {
        fields = JSON.parse(match[1]);
      } else {
        throw new Error('Could not parse JSON from model response: ' + content.slice(0, 120));
      }
    }

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    };
  } catch (e) {
    console.error('lender-prequal-extract error:', e.message);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Extraction failed: ' + e.message }) };
  }
};
