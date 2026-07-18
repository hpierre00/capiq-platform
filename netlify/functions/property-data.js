// Underlytix property-data function.
// Returns an AVM sale value estimate, comparable SALES, and county tax/zoning records
// for an address from a licensed property-data provider. Provider is swappable; the
// output shape below is normalized so the frontend never depends on the provider.
//
// Current provider: RentCast (https://developers.rentcast.io). Set RENTCAST_API_KEY in
// Netlify env. Without a key it returns { configured:false } and the report falls back
// to the honest county-appraiser link-out (no fabricated data).
//
// NOTE ON SOURCING: this replaces client-side scraping of Redfin/Zillow (blocked by CORS
// and against their terms). RentCast carries the same MLS closings and public records
// those sites display, returned through a licensed API.

// redeploy marker: 2026-07-17 activate RENTCAST_API_KEY
const RENTCAST_BASE = "https://api.rentcast.io/v1";

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  try {
    const key = process.env.RENTCAST_API_KEY;
    const body = JSON.parse(event.body || "{}");
    const address = String(body.address || "").trim();
    if (!address) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ success: false, error: "address required" }) };
    }
    if (!key) {
      return {
        statusCode: 200, headers: cors,
        body: JSON.stringify({
          success: false, configured: false,
          error: "Property-data provider not configured. Add RENTCAST_API_KEY to enable live value and comps; report falls back to the county appraiser link.",
        }),
      };
    }

    const h = { "X-Api-Key": key, "Accept": "application/json" };
    const q = encodeURIComponent(address);

    // 1) AVM sale value estimate + comparable sales used
    let value = null;
    try {
      const r = await fetch(`${RENTCAST_BASE}/avm/value?address=${q}&compCount=5`, { headers: h });
      if (r.ok) value = await r.json();
    } catch (e) { /* provider soft-fail */ }

    // 2) Property record: last sale, tax assessments, property taxes, zoning
    let prop = null;
    try {
      const r = await fetch(`${RENTCAST_BASE}/properties?address=${q}`, { headers: h });
      if (r.ok) {
        const arr = await r.json();
        prop = Array.isArray(arr) ? arr[0] : arr;
      }
    } catch (e) { /* provider soft-fail */ }

    const comps = (value && Array.isArray(value.comparables) ? value.comparables : [])
      .slice(0, 5)
      .map(function (c) {
        return {
          address: c.formattedAddress || "",
          price: c.price != null ? c.price : null,
          soldDate: c.lastSeenDate || c.removedDate || c.listedDate || null,
          squareFootage: c.squareFootage || null,
          ppsf: (c.price && c.squareFootage) ? Math.round(c.price / c.squareFootage) : null,
          beds: c.bedrooms != null ? c.bedrooms : null,
          baths: c.bathrooms != null ? c.bathrooms : null,
          distanceMi: c.distance != null ? Math.round(c.distance * 100) / 100 : null,
          correlation: c.correlation != null ? c.correlation : null,
        };
      });

    let taxYear = null, taxAmount = null, assessedValue = null, zoning = null, lastSalePrice = null, lastSaleDate = null;
    if (prop) {
      zoning = prop.zoning || null;
      lastSalePrice = prop.lastSalePrice != null ? prop.lastSalePrice : null;
      lastSaleDate = prop.lastSaleDate || null;
      const taxes = prop.propertyTaxes || {};
      const tKeys = Object.keys(taxes).sort();
      if (tKeys.length) {
        taxYear = tKeys[tKeys.length - 1];
        taxAmount = (taxes[taxYear] && taxes[taxYear].total) || null;
      }
      const asmts = prop.taxAssessments || {};
      const aKeys = Object.keys(asmts).sort();
      if (aKeys.length) {
        const a = asmts[aKeys[aKeys.length - 1]];
        assessedValue = (a && a.value) || null;
      }
    }

    return {
      statusCode: 200, headers: cors,
      body: JSON.stringify({
        success: true, configured: true, source: "RentCast",
        value: value ? (value.price != null ? value.price : null) : null,
        valueLow: value ? (value.priceRangeLow != null ? value.priceRangeLow : null) : null,
        valueHigh: value ? (value.priceRangeHigh != null ? value.priceRangeHigh : null) : null,
        comps: comps,
        assessedValue: assessedValue,
        taxYear: taxYear,
        taxAmount: taxAmount,
        zoning: zoning,
        lastSalePrice: lastSalePrice,
        lastSaleDate: lastSaleDate,
      }),
    };
  } catch (e) {
    return { statusCode: 200, headers: cors, body: JSON.stringify({ success: false, error: String((e && e.message) || e) }) };
  }
};
