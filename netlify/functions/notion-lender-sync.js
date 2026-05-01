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

    const NOTION_VERSION = "2022-06-28";
    const LENDER_ACQ_DB = "363cda98-60ca-4dbb-b751-d70e2d06939f";
    const MATCH_QUEUE_DB = "d0ef4b74-9bae-4043-88f1-3915b9c65a25";

    const notion = (method, path, payload) => fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: { "Authorization": `Bearer ${NOTION_API_KEY}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
    }).then(r => r.json());

    // Search for existing lender record by email
    const findLender = async (email) => {
      const res = await notion("POST", "/databases/" + LENDER_ACQ_DB + "/query", {
        filter: { property: "Email", email: { equals: email } }
      });
      return res.results?.[0] || null;
    };

    if (event === "lender_signup") {
      // New lender signed up via the portal — create record in Lender Acquisition Pipeline
      const existing = await findLender(lender.email);
      if (existing) {
        // Update existing record to reflect self-signup
        await notion("PATCH", "/pages/" + existing.id, {
          properties: {
            "Stage": { select: { name: "Interested" } },
            "Call Booked": { checkbox: false },
            "Notes": { rich_text: [{ text: { content: `Self-signed up via Underlytix portal on ${new Date().toLocaleDateString()}. Trial active.` } }] },
          }
        });
        return new Response(JSON.stringify({ success: true, action: "updated", pageId: existing.id }), { status: 200, headers: cors });
      }

      const lenderTypeMap = { hard_money: "Hard Money", dscr: "DSCR", bridge: "Bridge", non_qm: "Non-QM" };
      const page = await notion("POST", "/pages", {
        parent: { database_id: LENDER_ACQ_DB },
        properties: {
          "Company Name": { title: [{ text: { content: lender.companyName || "Unknown" } }] },
          "Contact Name": { rich_text: [{ text: { content: lender.contactName || "" } }] },
          "Email": { email: lender.email || null },
          "Phone": { phone_number: lender.phone || null },
          "Lender Type": lender.lenderType ? { select: { name: lenderTypeMap[lender.lenderType] || "Hard Money" } } : undefined,
          "Stage": { select: { name: "Interested" } },
          "Tier": { select: { name: "Standard" } },
          "States": { rich_text: [{ text: { content: (lender.states || []).join(", ") } }] },
          "Min Loan": lender.minLoan ? { number: parseFloat(lender.minLoan) } : undefined,
          "Max Loan": lender.maxLoan ? { number: parseFloat(lender.maxLoan) } : undefined,
          "Notes": { rich_text: [{ text: { content: `Self-signed up via Underlytix portal on ${new Date().toLocaleDateString()}. Trial active.` } }] },
          "date:Last Contact Date:start": { date: { start: new Date().toISOString().split("T")[0] } },
        }
      });

      // Clean undefined props
      Object.keys(page.properties || {}).forEach(k => { if (!page.properties[k]) delete page.properties[k]; });

      return new Response(JSON.stringify({ success: true, action: "created", pageId: page.id }), { status: 200, headers: cors });
    }

    if (event === "lender_interest") {
      // Lender marked interest/term_sheet on a deal — write to Match Queue
      const matchPage = await notion("POST", "/pages", {
        parent: { database_id: MATCH_QUEUE_DB },
        properties: {
          "Deal": { title: [{ text: { content: deal.address || deal.dealType || "Deal" } }] },
          "Lender": { rich_text: [{ text: { content: lender.name || "" } }] },
          "Status": { select: { name: deal.interestLevel === "term_sheet_issued" ? "Term Sheet" : "Interested" } },
          "Deal Type": deal.dealType ? { select: { name: deal.dealType } } : undefined,
          "Loan Amount": deal.loanAmount ? { number: parseFloat(deal.loanAmount) } : undefined,
          "Fundability Score": deal.score ? { number: parseFloat(deal.score) } : undefined,
          "State": { rich_text: [{ text: { content: deal.state || "" } }] },
          "Date": { date: { start: new Date().toISOString().split("T")[0] } },
        }
      });
      return new Response(JSON.stringify({ success: true, action: "match_logged", pageId: matchPage.id }), { status: 200, headers: cors });
    }

    if (event === "lender_closed") {
      // Lender paid via Stripe — update stage to Closed Won, set plan and MRR
      const existing = await findLender(lender.email);
      if (!existing) return new Response(JSON.stringify({ success: false, error: "Lender not found in Notion" }), { status: 404, headers: cors });

      const planToMRR = { "$500": 500, "$1000": 1000, "$1500+": 1500 };
      const planSold = lender.planAmount >= 1500 ? "$1500+" : lender.planAmount >= 1000 ? "$1000" : "$500";

      await notion("PATCH", "/pages/" + existing.id, {
        properties: {
          "Stage": { select: { name: "Closed Won 💰" } },
          "Plan Sold": { select: { name: planSold } },
          "MRR Value": { number: lender.planAmount || 297 },
          "Tier": { select: { name: "Active Partner" } },
          "date:Close Date:start": { date: { start: new Date().toISOString().split("T")[0] } },
          "date:Last Contact Date:start": { date: { start: new Date().toISOString().split("T")[0] } },
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
