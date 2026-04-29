// Tally form webhook → Notion Deal Pipeline
// Receives submissions from https://tally.so/r/D4DrpX and creates Notion records
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
    const NOTION_API_KEY = Netlify.env.get("NOTION_API_KEY");
    if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY not configured");

    const body = await req.json();
    // Tally sends data in fields array format
    const fields = body.data?.fields || [];
    const getField = (label) => {
      const f = fields.find(f => f.label?.toLowerCase().includes(label.toLowerCase()));
      return f?.value || "";
    };

    // Extract fields from Tally form — adjust labels to match your actual Tally form
    const investorName = getField("name") || getField("investor name") || "";
    const investorEmail = getField("email") || "";
    const investorPhone = getField("phone") || "";
    const dealType = getField("deal type") || getField("type") || "";
    const propertyType = getField("property type") || getField("asset") || "";
    const state = getField("state") || "";
    const location = getField("address") || getField("location") || "";
    const loanAmount = parseFloat(getField("loan amount") || getField("loan") || "0");
    const creditScore = parseInt(getField("credit score") || getField("fico") || "0");
    const notes = getField("notes") || getField("message") || getField("additional") || "";

    const DEAL_PIPELINE_DB = "13f04922-6d68-45f1-839c-9a572bf079ad";

    const notionBody = {
      parent: { database_id: DEAL_PIPELINE_DB },
      properties: {
        "Deal Name": { title: [{ text: { content: `${dealType} – ${state} – ${investorName}` } }] },
        "Investor Name": { rich_text: [{ text: { content: investorName } }] },
        "Investor Email": { email: investorEmail || null },
        "Investor Phone": { rich_text: [{ text: { content: investorPhone } }] },
        "Deal Type": dealType ? { select: { name: dealType } } : undefined,
        "Property Type": propertyType ? { select: { name: propertyType } } : undefined,
        "State": state ? { rich_text: [{ text: { content: state } }] } : undefined,
        "Location": location ? { rich_text: [{ text: { content: location } }] } : undefined,
        "Loan Amount": loanAmount ? { number: loanAmount } : undefined,
        "Credit Score": creditScore ? { number: creditScore } : undefined,
        "Notes": notes ? { rich_text: [{ text: { content: notes } }] } : undefined,
        "Status": { select: { name: "New" } },
        "Source": { select: { name: "Tally Form" } },
        "Intake Date": { date: { start: new Date().toISOString().split("T")[0] } },
      },
    };

    // Remove undefined properties
    Object.keys(notionBody.properties).forEach(k => {
      if (notionBody.properties[k] === undefined) delete notionBody.properties[k];
    });

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_API_KEY}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(notionBody),
    });

    const result = await res.json();
    if (!res.ok) throw new Error(result.message || "Notion API error");

    console.log("Tally → Notion: created page", result.id);
    return new Response(JSON.stringify({ success: true, pageId: result.id }), { status: 200, headers: cors });
  } catch (e) {
    console.error("tally-webhook error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/tally-webhook" };
