// Syncs a analyzed deal to Notion Deal Pipeline
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

    // Safe accessor
    const safe = (val) => val || '';
    const safeNum = (val) => parseFloat(val) || null;

    // Map deal type to Notion's existing select options
    const dealTypeMap = {
      'Purchase': 'Fix & Flip',       // closest match - will add Purchase option separately
      'Fix & Flip': 'Fix & Flip',
      'Rental': 'Rental / DSCR',
      'Cash-Out': 'Cash-Out',
      'Bridge': 'Bridge',
      'New Construction': 'Fix & Flip', // closest match
    };

    // Map property type to Notion options
    const propTypeMap = {
      'SFR': 'SFR',
      'Condo': 'SFR',
      '2-4 Unit': '2-4 Unit',
      'Multifamily 5+': 'Commercial',
      'Commercial': 'Commercial',
      'Land': 'Commercial',
    };

    // Map experience to Notion options
    const expMap = {
      'First Deal': 'First Deal',
      '1-3 Deals': '1-3 Deals',
      '4-10 Deals': '4-10 Deals',
      '10-20 Deals': '10+ Deals',
      '20+ Deals': '10+ Deals',
    };

    const notionPage = {
      parent: { database_id: "13f04922-6d68-45f1-839c-9a572bf079ad" },
      properties: {
        "Deal Name": { title: [{ text: { content: d.location || 'Untitled Deal' } }] },
        "Investor Name": { rich_text: [{ text: { content: d.investorName || '' } }] },
        "Investor Email": { email: d.investorEmail || null },
        "Investor Phone": { rich_text: [{ text: { content: d.investorPhone || '' } }] },
        "Investor Experience": d.investorExperience ? { select: { name: expMap[d.investorExperience] || '1-3 Deals' } } : undefined,
        "Deal Type": d.dealType ? { select: { name: dealTypeMap[d.dealType] || 'Fix & Flip' } } : undefined,
        "Property Type": d.propertyType ? { select: { name: propTypeMap[d.propertyType] || 'SFR' } } : undefined,
        "Location": { rich_text: [{ text: { content: d.location || '' } }] },
        "State": { rich_text: [{ text: { content: d.state || '' } }] },
        "Loan Amount": d.loanAmount ? { number: d.loanAmount } : undefined,
        "Purchase Price": d.purchasePrice ? { number: d.purchasePrice } : undefined,
        "ARV": d.arv ? { number: d.arv } : undefined,
        "As-Is Value": d.asIsValue ? { number: d.asIsValue } : undefined,
        "Rehab Budget": d.rehabBudget ? { number: d.rehabBudget } : undefined,
        "Monthly Rent": d.monthlyRent ? { number: d.monthlyRent } : undefined,
        "LTV": d.ltv ? { number: d.ltv } : undefined,
        "DSCR": d.dscr ? { number: d.dscr } : undefined,
        "Credit Score": d.creditScore ? { number: d.creditScore } : undefined,
        "Notes": d.notes ? { rich_text: [{ text: { content: d.notes } }] } : undefined,
        "Fundability Score": a.fundabilityScore ? { number: a.fundabilityScore } : undefined,
        "Deal Score": a.dealScore ? { select: { name: a.dealScore } } : undefined,
        "Human Review Required": { checkbox: a.humanReviewRequired || false },
        "AI Analysis": { rich_text: [{ text: { content: [a.executiveSummary, a.strengthsAndRisks, a.structuringRecommendations, a.nextSteps].filter(Boolean).join('\n\n').slice(0, 2000) } }] },
        "Score Breakdown": { rich_text: [{ text: { content: (a.scoreBreakdown || '').slice(0, 2000) } }] },
        "Status": { select: { name: "New" } },
        "Intake Date": { date: { start: new Date().toISOString().split('T')[0] } },
      }
    };

    // Remove undefined properties
    Object.keys(notionPage.properties).forEach(k => {
      if (notionPage.properties[k] === undefined) delete notionPage.properties[k];
    });

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionKey}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(notionPage),
    });

    if (!res.ok) {
      const err = await res.json();
      return new Response(JSON.stringify({ error: "Notion API error", detail: err }), { status: 502, headers: cors });
    }

    const page = await res.json();
    return new Response(JSON.stringify({ success: true, notionPageId: page.id, notionUrl: page.url }), { status: 200, headers: cors });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Server error", message: err.message }), { status: 500, headers: cors });
  }
};
