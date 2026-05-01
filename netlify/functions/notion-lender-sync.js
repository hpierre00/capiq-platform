// Syncs lender events to Notion CRM
// Events: lender_signup, lender_interest, lender_closed
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
    const { event, lender, deal } = body;

    const N_VER = "2022-06-28";
    const LENDER_ACQ_DB = "363cda98-60ca-4dbb-b751-d70e2d06939f";
    const MATCH_QUEUE_DB = "d0ef4b74-9bae-4043-88f1-3915b9c65a25";

    const notion = (method, path, payload) => fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": N_VER, "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    }).then(r => r.json());

    // Find lender page by email
    const findLenderPage = async (email) => {
      if (!email) return null;
      const res = await notion("POST", `/databases/${LENDER_ACQ_DB}/query`, {
        filter: { property: "Email", email: { equals: email } }
      });
      return res.results?.[0] || null;
    };

    if (event === "lender_signup") {
      const existing = await findLenderPage(lender.email);
      if (existing) {
        await notion("PATCH", `/pages/${existing.id}`, {
          properties: {
            "Stage": { select: { name: "Interested" } },
            "Notes": { rich_text: [{ text: { content: `Self-signed up via Underlytix portal on ${new Date().toLocaleDateString()}. Trial active.` } }] },
            "date:Last Contact Date:start": new Date().toISOString().split("T")[0],
          }
        });
        return new Response(JSON.stringify({ success: true, action: "updated", pageId: existing.id }), { status: 200, headers: cors });
      }

      const lenderTypeMap = { hard_money: "Hard Money", dscr: "DSCR", bridge: "Bridge", non_qm: "Non-QM" };
      const props = {
        "Company Name": { title: [{ text: { content: lender.companyName || "Unknown" } }] },
        "Contact Name": { rich_text: [{ text: { content: lender.contactName || "" } }] },
        "Email": { email: lender.email || null },
        "Phone": { phone_number: lender.phone || null },
        "Stage": { select: { name: "Interested" } },
        "Tier": { select: { name: "Standard" } },
        "Notes": { rich_text: [{ text: { content: `Self-signed up via Underlytix portal on ${new Date().toLocaleDateString()}. Trial active.` } }] },
        "date:Last Contact Date:start": new Date().toISOString().split("T")[0],
      };
      if (lender.lenderType) props["Lender Type"] = { select: { name: lenderTypeMap[lender.lenderType] || "Hard Money" } };
      if (lender.states?.length) props["States"] = { rich_text: [{ text: { content: lender.states.join(", ") } }] };
      if (lender.minLoan) props["Min Loan"] = { number: parseFloat(lender.minLoan) };
      if (lender.maxLoan) props["Max Loan"] = { number: parseFloat(lender.maxLoan) };

      const page = await notion("POST", "/pages", { parent: { database_id: LENDER_ACQ_DB }, properties: props });
      return new Response(JSON.stringify({ success: true, action: "created", pageId: page.id }), { status: 200, headers: cors });
    }

    if (event === "lender_interest") {
      // Write to Match Queue with correct schema — Name is the title field
      const matchName = `${lender.name || "Lender"} → ${deal.address || deal.dealType || "Deal"}`;
      const props = {
        "Name": { title: [{ text: { content: matchName } }] },
        "Match Status": { select: { name: "Sent" } },
        "Lender Response": { select: { name: deal.interestLevel === "term_sheet_issued" ? "Interested" : "Interested" } },
        "Send Priority": { select: { name: "High" } },
        "Match Notes": { rich_text: [{ text: { content: `Lender: ${lender.name || "—"} | Deal: ${deal.address || "—"} | Score: ${deal.score || "—"} | Status: ${deal.interestLevel}` } }] },
        "date:Date Matched:start": new Date().toISOString().split("T")[0],
        "date:Date Sent:start": new Date().toISOString().split("T")[0],
      };
      if (deal.score) props["Match Score"] = { number: parseFloat(deal.score) };

      const page = await notion("POST", "/pages", { parent: { database_id: MATCH_QUEUE_DB }, properties: props });
      return new Response(JSON.stringify({ success: true, action: "match_logged", pageId: page.id }), { status: 200, headers: cors });
    }

    if (event === "lender_closed") {
      const existing = await findLenderPage(lender.email);
      if (!existing) return new Response(JSON.stringify({ success: false, error: "Lender not found in Notion" }), { status: 404, headers: cors });

      const planSold = lender.planAmount >= 1500 ? "$1500+" : lender.planAmount >= 1000 ? "$1000" : "$500";
      await notion("PATCH", `/pages/${existing.id}`, {
        properties: {
          "Stage": { select: { name: "Closed Won 💰" } },
          "Plan Sold": { select: { name: planSold } },
          "MRR Value": { number: lender.planAmount || 297 },
          "Tier": { select: { name: "Active Partner" } },
          "date:Close Date:start": new Date().toISOString().split("T")[0],
          "date:Last Contact Date:start": new Date().toISOString().split("T")[0],
        }
      });
      return new Response(JSON.stringify({ success: true, action: "closed_won" }), { status: 200, headers: cors });
    }

    return new Response(JSON.stringify({ error: "Unknown event" }), { status: 400, headers: cors });
  } catch (e) {
    console.error("notion-lender-sync error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
};

export const config = { path: "/.netlify/functions/notion-lender-sync" };
