export default async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  try {
    const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");

    if (!apiKey || !apiKey.trim()) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured", code: "MISSING_KEY" }), { status: 500, headers: cors });
    }

    let body;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: cors });
    }

    const d = body.dealData || body;

    const prompt = `You are an expert real estate underwriter for CapIQ, a capital intelligence platform for independent real estate investors.

Analyze this deal comprehensively and return a Deal Intelligence Report as a single JSON object.

DEAL DATA:
Deal Type: ${d.dealType || d.deal_type || "N/A"}
Property Type: ${d.propertyType || d.property_type || "N/A"}
State: ${d.state || "N/A"}
Location: ${d.location || "N/A"}
Loan Amount: $${d.loanAmount || d.loan_amount || 0}
Purchase Price: $${d.purchasePrice || d.purchase_price || 0}
ARV: $${d.arv || 0}
As-Is Value: $${d.asIsValue || d.as_is_value || 0}
Rehab Budget: $${d.rehabBudget || d.rehab_budget || 0}
Monthly Rent: $${d.monthlyRent || d.monthly_rent || 0}
LTV: ${d.ltv || 0}%
DSCR: ${d.dscr || "N/A"}
Credit Score: ${d.creditScore || d.credit_score || 0}
Investor Experience: ${d.investorExperience || d.investor_experience || "N/A"}
Notes: ${d.notes || "None"}

Return ONLY this JSON object, no markdown, no explanation:
{
  "fundabilityScore": <integer 0-100>,
  "dealScore": "<Pass|Review|Reject>",
  "humanReviewRequired": <true|false>,
  "executiveSummary": "<3-4 sentence deal overview with key metrics>",
  "strengthsAndRisks": "<Detailed analysis of deal strengths and risks>",
  "lenderMatchingProfile": "<Description of ideal lender profile>",
  "structuringRecommendations": "<Specific actionable recommendations to improve fundability>",
  "marketContext": "<Market context for this property type, location, and current rate environment>",
  "scoreBreakdown": "<Explanation of how LTV, DSCR, credit, and experience contributed to the score>",
  "nextSteps": "<3-5 concrete next steps in priority order>"
}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.text();
      return new Response(JSON.stringify({ error: "Anthropic API error", status: res.status, details: err }), { status: 502, headers: cors });
    }

    const data = await res.json();
    const raw = data.content?.filter(b => b.type === "text")?.map(b => b.text)?.join("") || "";
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    let analysis;
    try { analysis = JSON.parse(cleaned); }
    catch (e) {
      return new Response(JSON.stringify({ error: "Parse error", raw: raw.substring(0, 500) }), { status: 500, headers: cors });
    }

    return new Response(JSON.stringify({ success: true, analysis }), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error", message: err.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/capiq/analyze" };
