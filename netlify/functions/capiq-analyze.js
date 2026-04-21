export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  try {
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 500, headers: cors });

    const body = await req.json();
    const d = body.dealData || body;

    const prompt = `You are an expert real estate underwriter for CapIQ. Analyze this deal and return ONLY a JSON object with no markdown.

Deal: ${d.dealType} | ${d.propertyType} | ${d.state} | ${d.location}
Loan: $${d.loanAmount} | Purchase: $${d.purchasePrice} | ARV: $${d.arv}
As-Is Value: $${d.asIsValue} | Rehab: $${d.rehabBudget} | Rent: $${d.monthlyRent}/mo
LTV: ${d.ltv}% | DSCR: ${d.dscr} | Credit: ${d.creditScore} | Exp: ${d.investorExperience}
Notes: ${d.notes || "None"}

Return exactly this JSON:
{"fundabilityScore":0,"dealScore":"Pass","humanReviewRequired":false,"executiveSummary":"","strengthsAndRisks":"","lenderMatchingProfile":"","structuringRecommendations":"","marketContext":"","scoreBreakdown":"","nextSteps":""}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: "Anthropic error", detail: err }), { status: 502, headers: cors });
    }

    const data = await res.json();
    const raw = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const analysis = JSON.parse(cleaned);
    return new Response(JSON.stringify({ success: true, analysis }), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error", message: err.message }), { status: 500, headers: cors });
  }
};

// NO config path - function responds on native /.netlify/functions/capiq-analyze
