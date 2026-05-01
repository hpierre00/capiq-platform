// Tally form webhook → Notion Deal Pipeline
export default async (req) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: cors });

  try {
    const KEY = Netlify.env.get("NOTION_API_KEY");
    if (!KEY) throw new Error("NOTION_API_KEY not configured");

    const body = await req.json();
    const fields = body.data?.fields || [];
    const get = (label) => fields.find(f => f.label?.toLowerCase().includes(label.toLowerCase()))?.value || "";

    const investorName = get("name") || get("investor");
    const investorEmail = get("email");
    const state = get("state");
    const dealType = get("deal type") || get("type");
    const propertyType = get("property type") || get("asset");
    const loanAmount = parseFloat(get("loan amount") || get("loan") || "0") || null;
    const creditScore = parseInt(get("credit score") || get("fico") || "0") || null;
    const notes = get("notes") || get("message") || get("additional");
    const today = new Date().toISOString().split("T")[0];

    const dealTypeMap = { 'Fix & Flip': 'Fix & Flip', 'Rental': 'Rental / DSCR', 'DSCR': 'Rental / DSCR', 'Cash-Out': 'Cash-Out', 'Bridge': 'Bridge' };

    const props = {
      "Deal Name": { title: [{ text: { content: `${dealType || "Intake"} — ${state || "—"} — ${investorName || "Unknown"}` } }] },
      "Status": { select: { name: "New" } },
      "Intake Date": { date: { start: today } },
    };
    if (investorName) props["Investor Name"] = { rich_text: [{ text: { content: investorName } }] };
    if (investorEmail) props["Investor Email"] = { email: investorEmail };
    if (state) props["State"] = { rich_text: [{ text: { content: state } }] };
    if (dealType && dealTypeMap[dealType]) props["Deal Type"] = { select: { name: dealTypeMap[dealType] } };
    if (propertyType) props["Property Type"] = { select: { name: propertyType === 'SFR' ? 'SFR' : propertyType === '2-4 Unit' ? '2-4 Unit' : 'Commercial' } };
    if (loanAmount) props["Loan Amount"] = { number: loanAmount };
    if (creditScore) props["Credit Score"] = { number: creditScore };
    if (notes) props["Notes"] = { rich_text: [{ text: { content: notes.slice(0, 2000) } }] };

    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" },
      body: JSON.stringify({ parent: { database_id: "13f04922-6d68-45f1-839c-9a572bf079ad" }, properties: props }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.message || "Notion API error");
    return new Response(JSON.stringify({ success: true, pageId: result.id }), { status: 200, headers: cors });

  } catch (e) {
    console.error("tally-webhook error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/tally-webhook" };
