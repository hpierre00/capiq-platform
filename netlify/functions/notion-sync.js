// Syncs an analyzed deal to Notion Deal Pipeline
// Called after successful AI analysis
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
    const notionKey = Netlify.env.get("NOTION_API_KEY");
    if (!notionKey) return new Response(JSON.stringify({ error: "NOTION_API_KEY not configured" }), { status: 500, headers: cors });

    const body = await req.json();
    const d = body.dealData || body.d || {};
    const a = body.analysis || body.a || {};

    // Deal Pipeline schema exact field mapping
    const dealTypeMap = {
      'Purchase': 'Fix & Flip',
      'Fix & Flip': 'Fix & Flip',
      'Rental': 'Rental / DSCR',
      'Rental/DSCR': 'Rental / DSCR',
      'Cash-Out': 'Cash-Out',
      'Cash-Out Refi': 'Cash-Out',
      'Bridge': 'Bridge',
      'New Construction': 'Fix & Flip',
    };

    const propTypeMap = {
      'SFR': 'SFR',
      'Condo': 'SFR',
      '2-4 Unit': '2-4 Unit',
      'Multifamily 5+': 'Commercial',
      'Commercial': 'Commercial',
      'Land': 'Commercial',
    };

    const expMap = {
      'First Deal': 'First Deal',
      '1-3 Deals': '1-3 Deals',
      '4-10 Deals': '4-10 Deals',
      '10-20 Deals': '10+ Deals',
      '20+ Deals': '10+ Deals',
    };

    // Deal Score: Pass/Review/Reject
    const scoreToGrade = (score) => {
      if (!score) return 'Review';
      if (score >= 70) return 'Pass';
      if (score >= 45) return 'Review';
      return 'Reject';
    };

    const dealName = d.location || d.fullAddress || `${d.dealType || 'Deal'} — ${d.state || ''}`;

    const props = {
      "Deal Name": { title: [{ text: { content: dealName } }] },
      "Investor Name": { rich_text: [{ text: { content: d.investorName || '' } }] },
      "Investor Email": { email: d.investorEmail || null },
      "Investor Phone": { rich_text: [{ text: { content: d.investorPhone || '' } }] },
      "Status": { select: { name: "Matched" } },
      "Human Review Required": { checkbox: a.humanReviewRequired || false },
      "date:Intake Date:start": new Date().toISOString().split("T")[0],
    };

    if (d.investorExperience) props["Investor Experience"] = { select: { name: expMap[d.investorExperience] || '1-3 Deals' } };
    if (d.dealType) props["Deal Type"] = { select: { name: dealTypeMap[d.dealType] || 'Fix & Flip' } };
    if (d.propertyType) props["Property Type"] = { select: { name: propTypeMap[d.propertyType] || 'SFR' } };
    if (d.location) props["Location"] = { rich_text: [{ text: { content: d.location } }] };
    if (d.state) props["State"] = { rich_text: [{ text: { content: d.state } }] };
    if (d.loanAmount) props["Loan Amount"] = { number: parseFloat(d.loanAmount) };
    if (d.purchasePrice) props["Purchase Price"] = { number: parseFloat(d.purchasePrice) };
    if (d.arv) props["ARV"] = { number: parseFloat(d.arv) };
    if (d.asIsValue) props["As-Is Value"] = { number: parseFloat(d.asIsValue) };
    if (d.rehabBudget) props["Rehab Budget"] = { number: parseFloat(d.rehabBudget) };
    if (d.monthlyRent) props["Monthly Rent"] = { number: parseFloat(d.monthlyRent) };
    if (d.ltv) props["LTV"] = { number: parseFloat(d.ltv) };
    if (d.dscr) props["DSCR"] = { number: parseFloat(d.dscr) };
    if (d.creditScore) props["Credit Score"] = { number: parseFloat(d.creditScore) };
    if (d.notes) props["Notes"] = { rich_text: [{ text: { content: d.notes.slice(0, 2000) } }] };
    if (a.fundabilityScore) {
      props["Fundability Score"] = { number: a.fundabilityScore };
      props["Deal Score"] = { select: { name: scoreToGrade(a.fundabilityScore) } };
    }
    const aiText = [a.executiveSummary, a.strengthsAndRisks, a.structuringRecommendations, a.nextSteps].filter(Boolean).join('\n\n').slice(0, 2000);
    if (aiText) props["AI Analysis"] = { rich_text: [{ text: { content: aiText } }] };
    if (a.scoreBreakdown) props["Score Breakdown"] = { rich_text: [{ text: { content: a.scoreBreakdown.slice(0, 2000) } }] };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { "Authorization": `Bearer ${notionKey}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { database_id: "13f04922-6d68-45f1-839c-9a572bf079ad" }, properties: props }),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("Notion API error:", JSON.stringify(err));
      return new Response(JSON.stringify({ error: "Notion API error", detail: err }), { status: 502, headers: cors });
    }

    const page = await res.json();
    return new Response(JSON.stringify({ success: true, notionPageId: page.id, notionUrl: page.url }), { status: 200, headers: cors });

  } catch (err) {
    console.error("notion-sync error:", err.message);
    return new Response(JSON.stringify({ error: "Server error", message: err.message }), { status: 500, headers: cors });
  }
};
