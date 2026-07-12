/**
 * Daily Marketing Automation — Underlytix & Tradolux
 * Generates and schedules brand-specific content across all Postiz channels.
 *
 * Setup:
 *   1. npm install node-fetch @anthropic-ai/sdk (run once in this folder)
 *   2. Set ANTHROPIC_API_KEY in environment or in the CONFIG block below
 *   3. Run: node underlytix-daily-post.js
 *
 * Schedule via Windows Task Scheduler (see schedule-task.ps1)
 */

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  postizApiKey: 'bbe88db0c6de8ba711e5a777abff5d5ea84dde5b3e4c23cc30da6ec2ad95e4f6',
  postizBaseUrl: 'https://api.postiz.com/public/v1',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY_HERE',
  postTime: '09:00', // Local time to schedule posts
  timezone: 'America/New_York',
};

// ─── BRAND DEFINITIONS ─────────────────────────────────────────────────────────
const BRANDS = {
  Underlytix: {
    name: 'Underlytix',
    description: 'real estate capital intelligence SaaS that pre-qualifies deals and matches lenders before underwriting',
    audience: 'realtors, real estate investors, and private lenders',
    website: 'underlytix.com',
    instagram: '@underlytix',
    facebook: 'facebook.com/profile.php?id=61590666091101',
    youtube: 'youtube.com/@Underlytix',
    hashtags: '#Underlytix #RealEstateInvesting #RealEstateTech #PropTech #LenderMatching',
  },
  Tradolux: {
    name: 'Tradolux',
    description: 'AI-powered trading intelligence platform',
    audience: 'traders, investors, and finance professionals',
    website: 'tradolux.com',
    hashtags: '#Tradolux #AITrading #StockAnalysis #TradingSignals #FinTech',
  },
};

// Detect brand from Postiz integration name
function detectBrand(integrationName) {
  if (integrationName.toLowerCase().includes('tradolux')) return BRANDS.Tradolux;
  return BRANDS.Underlytix;
}

// ─── MARKETING PILLARS (rotate by day of week, per brand) ──────────────────────
const PILLARS = {
  Underlytix: {
    0: { name: 'Community & Vision',    focus: 'Week-ahead mindset, real estate investing philosophy, community motivation' },
    1: { name: 'Capital Intelligence',  focus: 'Market data, interest rates, deal flow insights, capital availability trends' },
    2: { name: 'Education',             focus: 'How-to for realtors/investors, capital stack explained, deal structuring tips' },
    3: { name: 'Platform Feature',      focus: 'Underlytix product capabilities, AI insights, how the platform saves time and money' },
    4: { name: 'Thought Leadership',    focus: 'Real estate investment strategy, market cycles, expert perspective on capital markets' },
    5: { name: 'Market Intelligence',   focus: 'Weekly data roundup, deal trends, where smart capital is flowing' },
    6: { name: 'Success & Social Proof', focus: 'Deal wins, user outcomes, before/after using Underlytix, real results' },
  },
  Tradolux: {
    0: { name: 'Market Mindset',        focus: 'Week-ahead trading perspective, market psychology, investor community motivation' },
    1: { name: 'Market Intelligence',   focus: 'Market signals, price action, macro trends, where smart money is moving' },
    2: { name: 'Education',             focus: 'Trading concepts, risk management, position sizing, reading AI signals' },
    3: { name: 'Platform Feature',      focus: 'Tradolux AI capabilities, signal accuracy, how the platform edges the market' },
    4: { name: 'Thought Leadership',    focus: 'Trading philosophy, market cycles, long-term vs short-term strategy' },
    5: { name: 'Weekly Wrap',           focus: 'Market performance recap, key moves this week, what the data is saying' },
    6: { name: 'Success & Social Proof', focus: 'Trader wins, portfolio outcomes, results from using Tradolux AI signals' },
  },
};

// ─── PLATFORM PROMPT TEMPLATES ────────────────────────────────────────────────
const PLATFORM_PROMPTS = {

  facebook: (pillar, date, brand) => `
You are a social media expert for ${brand.name}, a ${brand.description}.

Write a Facebook post for today (${date}) focused on: ${pillar.name}
Topic focus: ${pillar.focus}
Target audience: ${brand.audience}

Requirements:
- 150–250 words
- Professional but approachable tone
- Start with a compelling hook (not "Are you...")
- End with a clear, engaging question to drive comments
- Include one clear value proposition for ${brand.name} (${brand.website})
- Do NOT use hashtags on Facebook
- Do NOT use emojis excessively (max 2)

Output ONLY the post text, nothing else.
`,

  instagram: (pillar, date, brand) => `
You are a social media expert for ${brand.name}, a ${brand.description}.

Write an Instagram caption for today (${date}) focused on: ${pillar.name}
Topic focus: ${pillar.focus}
Target audience: ${brand.audience}

Requirements:
- 100–150 words of caption text
- Start with a strong first line that stops the scroll
- Use line breaks for readability
- Emojis welcome (3–5 max)
- End with 12–15 highly relevant hashtags on a new line
- Hashtag mix: ${brand.hashtags} plus 7–10 niche tags relevant to the topic

Output ONLY the caption + hashtags, nothing else.
`,

  x: (pillar, date, brand) => `
You are a social media expert for ${brand.name}, a ${brand.description}.

Write a post for X (Twitter) for today (${date}) focused on: ${pillar.name}
Topic focus: ${pillar.focus}

Requirements:
- MAX 240 characters (hard limit — count carefully)
- Lead with the sharpest insight or stat — no warm-up
- No more than 2 hashtags
- Can include a call to action (${brand.website})
- Punchy, direct, professional

Output ONLY the post text, nothing else.
`,

  linkedin: (pillar, date, brand) => `
You are a social media expert for ${brand.name}, a ${brand.description}.

Write a LinkedIn post for today (${date}) focused on: ${pillar.name}
Topic focus: ${pillar.focus}
Target audience: ${brand.audience}

Requirements:
- 200–350 words
- Professional, insight-driven tone
- Open with a bold statement or surprising insight
- Use short paragraphs (2–3 sentences max) for mobile readability
- Include 3–5 relevant hashtags at the end
- One clear reference to ${brand.name}'s value (${brand.website})

Output ONLY the post text, nothing else.
`,
};

// ─── PLATFORM → POSTIZ IDENTIFIER MAPPING ──────────────────────────────────────
// prompt: key into PLATFORM_PROMPTS. null = skip.
// youtubeRequired: true = skip (needs video file, handled separately).
const IDENTIFIER_MAP = {
  facebook:  { prompt: 'facebook',  youtubeRequired: false },
  instagram: { prompt: 'instagram', youtubeRequired: false },
  twitter:   { prompt: 'x',        youtubeRequired: false },
  linkedin:  { prompt: 'linkedin',  youtubeRequired: false },
  reddit:    { prompt: null,        youtubeRequired: false }, // skip
  youtube:   { prompt: null,        youtubeRequired: true  }, // requires video file
};

// ─── MAIN ───────────────────────────────────────────────────────────────────────
async function main() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: CONFIG.anthropicApiKey });

  const now = new Date();
  const dayOfWeek = now.getDay();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Target post time for today
  const [hour, minute] = CONFIG.postTime.split(':').map(Number);
  const postDate = new Date(now);
  postDate.setHours(hour, minute, 0, 0);
  // If past the post time, schedule for next day
  if (postDate <= now) postDate.setDate(postDate.getDate() + 1);

  console.log(`\n🚀 Daily Marketing Automation — ${dateStr}`);
  console.log(`📅 Scheduling for: ${postDate.toLocaleString()}\n`);

  // 1. Fetch connected integrations from Postiz
  const intResp = await fetch(`${CONFIG.postizBaseUrl}/integrations`, {
    headers: { 'Authorization': CONFIG.postizApiKey, 'Content-Type': 'application/json' }
  });

  if (!intResp.ok) {
    const err = await intResp.text();
    throw new Error(`Postiz integrations fetch failed: ${intResp.status} ${err}`);
  }

  const integrations = await intResp.json();
  console.log(`✅ Found ${integrations.length} connected channel(s):`);
  integrations.forEach(i => console.log(`   • ${i.identifier} — ${i.name} (${i.id})`));

  const results = [];

  for (const integration of integrations) {
    const platformConfig = IDENTIFIER_MAP[integration.identifier];

    if (!platformConfig || platformConfig.youtubeRequired) {
      console.log(`\n⏭  Skipping ${integration.identifier} (${integration.name}) — requires video or unsupported`);
      continue;
    }

    if (!platformConfig.prompt) {
      console.log(`\n⏭  Skipping ${integration.identifier} (${integration.name}) — no content template`);
      continue;
    }

    const promptFn = PLATFORM_PROMPTS[platformConfig.prompt];
    if (!promptFn) {
      console.log(`\n⏭  Skipping ${integration.identifier} (no prompt template)`);
      continue;
    }

    // Detect brand from integration name
    const brand = detectBrand(integration.name);
    const pillar = PILLARS[brand.name][dayOfWeek];

    console.log(`\n✍️  [${brand.name}] Generating ${integration.identifier} content for "${integration.name}"...`);
    console.log(`   Pillar: ${pillar.name} — ${pillar.focus}`);

    // 2. Generate content via Claude
    const message = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: promptFn(pillar, dateStr, brand) }],
    });

    const content = message.content[0].text.trim();
    console.log(`   Generated (${content.length} chars)`);

    // 3. Post to Postiz
    const postBody = {
      posts: [{
        integration: { id: integration.id },
        value: [{ content, id: '1' }],
        date: postDate.toISOString(),
        type: 'schedule',
      }]
    };

    const postResp = await fetch(`${CONFIG.postizBaseUrl}/posts`, {
      method: 'POST',
      headers: { 'Authorization': CONFIG.postizApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(postBody),
    });

    const postResult = await postResp.text();

    if (postResp.ok) {
      console.log(`   ✅ Scheduled successfully`);
      results.push({ platform: integration.identifier, name: integration.name, brand: brand.name, status: 'scheduled', content });
    } else {
      console.log(`   ❌ Failed: ${postResult}`);
      results.push({ platform: integration.identifier, name: integration.name, brand: brand.name, status: 'error', error: postResult, content });
    }
  }

  // 4. Daily Summary
  console.log('\n' + '─'.repeat(60));
  console.log('📊 DAILY MARKETING SUMMARY');
  console.log('─'.repeat(60));
  console.log(`Date: ${dateStr}`);
  console.log('');

  // Group by brand
  const byBrand = {};
  results.forEach(r => {
    if (!byBrand[r.brand]) byBrand[r.brand] = [];
    byBrand[r.brand].push(r);
  });

  for (const [brandName, posts] of Object.entries(byBrand)) {
    const pillar = PILLARS[brandName]?.[new Date().getDay()];
    console.log(`\n── ${brandName.toUpperCase()} ──`);
    if (pillar) console.log(`Pillar: ${pillar.name} — ${pillar.focus}`);
    posts.forEach(r => {
      const icon = r.status === 'scheduled' ? '✅' : '❌';
      console.log(`${icon} ${r.platform.toUpperCase()} (${r.name}): ${r.status.toUpperCase()}`);
      if (r.status === 'scheduled') {
        console.log(`   Preview: ${r.content.substring(0, 120)}...`);
      } else {
        console.log(`   Error: ${r.error?.substring(0, 120)}`);
      }
    });
  }

  console.log('\n✅ Done.\n');
}

main().catch(err => {
  console.error('❌ Automation failed:', err.message);
  process.exit(1);
});
