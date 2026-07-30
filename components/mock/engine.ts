/**
 * ⚠ TEMPORARY — Lane A local mock of the engine surface.
 *
 * At Sprint A1 there is no `lib/` on `main`: no v0 code, no adapters, no
 * contracts. Lane A may not create `lib/**` (BUILD_BRIEF §2.1), so the shapes
 * and demo-store fixtures the UI renders live here instead, behind functions
 * that look like the calls Lane B will eventually expose.
 *
 * When Lane B lands `lib/types.ts` + `StoreAdapter`, this file is **deleted**
 * and the page-level imports are repointed. Nothing else changes: pages import
 * from here and only here. The shapes Lane A guessed at are written up for Lane
 * B in `contracts/requests-lane-a.md` (REQ-A-003).
 *
 * Ground rules honoured here: money is integer cents, prices never vary by
 * visitor (a stage is a set of SKUs, never a share of traffic), confidence is
 * always carried alongside a forecast, and every price write has a journal row.
 */

export type Cents = number;

/** How much of the store's own price history stands behind a number. */
export type ConfidenceTier = "fitted" | "partial" | "assumption";

export type ProductKind = "standard" | "subscription" | "gift_card";
export type CogsSource = "shopify" | "manual";

export type Product = {
  id: string;
  title: string;
  variantTitle?: string;
  sku: string;
  priceCents: Cents;
  compareAtCents: Cents | null;
  /** `null` means unknown — never render a profit number for these (R3). */
  cogsCents: Cents | null;
  cogsSource: CogsSource | null;
  /** Subscriptions and gift cards are excluded from price changes in v1 (R22). */
  kind: ProductKind;
  /** Shopify's product type. Drives the catalog's type filter. */
  productType: string;
  units30d: number;
  /** True when this product currently holds a price Priceflag set. */
  inLiveRollout: boolean;
};

export type RolloutStatus =
  | "draft"
  | "scheduled"
  | "live"
  | "holding"
  | "paused_external"
  | "rolled_back"
  | "completed";

export type StageStatus = "completed" | "active" | "pending" | "skipped";

export type RolloutStage = {
  /** Share of the rollout's *selected SKUs*, never of traffic. */
  sharePct: number;
  holdDays: number;
  status: StageStatus;
  startedOn: string | null;
  completedOn: string | null;
  skuCount: number;
};

/** Stored as three fields so the UI can render one editable sentence (R10). */
export type Guardrail = {
  unitsDropPct: number;
  forDays: number;
  action: "revert_all";
};

export type ReadingVerdict = "within" | "below" | "above";

export type RolloutReading = {
  date: string;
  actualUnits: number;
  expectedUnits: number;
  expectedLow: number;
  expectedHigh: number;
  verdict: ReadingVerdict;
  confidence: ConfidenceTier;
};

export type RolloutEventKind =
  | "created"
  | "scheduled"
  | "started"
  | "advanced"
  | "held"
  | "warning"
  | "paused"
  | "rolled_back"
  | "completed";

export type RolloutEvent = {
  id: string;
  at: string;
  kind: RolloutEventKind;
  /** Merchant-facing, rendered verbatim. Plain language only (R25). */
  message: string;
  detail?: string;
};

export type ForecastSummary = {
  /** Always-true margin arithmetic, stated before any model output (R6). */
  breakevenUnitsDropPct: number;
  blendedMarginFraction: number;
  horizonDays: number;
  profitDeltaLowCents: Cents;
  profitDeltaHighCents: Cents;
  revenueDeltaLowCents: Cents;
  revenueDeltaHighCents: Cents;
  ordersDeltaLowFraction: number;
  ordersDeltaHighFraction: number;
  confidence: ConfidenceTier;
  /** One line, from the engine. Lane A renders it as-is when present. */
  explanation: string;
  modelVersion: string | null;
};

export type PriceChange = {
  kind: "percent" | "absolute";
  /** Percent points for `percent`, cents for `absolute`. Signed. */
  value: number;
};

export type Rollout = {
  id: string;
  name: string;
  status: RolloutStatus;
  change: PriceChange;
  productIds: string[];
  stages: RolloutStage[];
  currentStageIndex: number;
  guardrail: Guardrail;
  createdAt: string;
  startedAt: string | null;
  scheduledFor: string | null;
  endedAt: string | null;
  readings: RolloutReading[];
  events: RolloutEvent[];
  forecast: ForecastSummary;
  /** Present once a rollout finishes; the retention loop (R20) renders it in A6. */
  realizedProfitDeltaCents: Cents | null;
};

export type JournalActor = "priceflag" | "you" | "external";
export type JournalKind = "rollout" | "rollback" | "external" | "manual";

export type JournalEntry = {
  id: string;
  at: string;
  productId: string;
  productTitle: string;
  sku: string;
  fromCents: Cents;
  toCents: Cents;
  actor: JournalActor;
  kind: JournalKind;
  reason: string;
  rolloutId: string | null;
};

/**
 * Pinned so every render — server, client, build — agrees. The real app reads
 * the shop's timezone from Lane B.
 */
export const DEMO_TODAY = "2026-07-29";

export const DEMO_STORE = {
  name: "Northwind Supply",
  domain: "northwind-supply.myshopify.com",
  currency: "USD",
  /** Demo data, clearly labelled. A5 adds the real demo ↔ live switcher. */
  mode: "demo" as const,
};

const PRODUCTS: Product[] = [
  {
    id: "p_ridge",
    title: "Ridgeline Rain Jacket",
    variantTitle: "Slate / M",
    sku: "RG-JKT-01",
    productType: "Outerwear",
    priceCents: 18900,
    compareAtCents: 21900,
    cogsCents: 7560,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 84,
    inLiveRollout: true,
  },
  {
    id: "p_trail",
    title: "Trailhead Daypack 22L",
    sku: "TH-BAG-22",
    productType: "Packs",
    priceCents: 12400,
    compareAtCents: null,
    cogsCents: 5580,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 131,
    inLiveRollout: false,
  },
  {
    id: "p_flask",
    title: "Summit Vacuum Flask",
    variantTitle: "750 ml",
    sku: "SM-FLS-75",
    productType: "Drinkware",
    priceCents: 3600,
    compareAtCents: null,
    cogsCents: 1280,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 402,
    inLiveRollout: true,
  },
  {
    id: "p_socks",
    title: "Merino Trail Socks",
    variantTitle: "3-pack",
    sku: "MR-SCK-03",
    productType: "Socks",
    priceCents: 2800,
    compareAtCents: null,
    cogsCents: 950,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 356,
    inLiveRollout: true,
  },
  {
    id: "p_lamp",
    title: "Basecamp Lantern",
    sku: "BC-LMP-01",
    productType: "Lighting",
    priceCents: 5900,
    compareAtCents: 6900,
    cogsCents: 2340,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 97,
    inLiveRollout: false,
  },
  {
    id: "p_stove",
    title: "Pocket Camp Stove",
    sku: "PK-STV-01",
    productType: "Cookware",
    priceCents: 8400,
    compareAtCents: null,
    cogsCents: 3990,
    cogsSource: "manual",
    kind: "standard",
    units30d: 62,
    inLiveRollout: false,
  },
  {
    id: "p_mat",
    title: "Cloudbed Sleep Mat",
    sku: "CB-MAT-01",
    productType: "Sleep",
    priceCents: 14900,
    compareAtCents: null,
    cogsCents: null,
    cogsSource: null,
    kind: "standard",
    units30d: 45,
    inLiveRollout: false,
  },
  {
    id: "p_chair",
    title: "Riverbank Folding Chair",
    sku: "RB-CHR-01",
    productType: "Camp furniture",
    priceCents: 7200,
    compareAtCents: null,
    cogsCents: null,
    cogsSource: null,
    kind: "standard",
    units30d: 58,
    inLiveRollout: false,
  },
  {
    id: "p_tent",
    title: "Foghorn Tent",
    variantTitle: "2-person",
    sku: "FG-TNT-02",
    productType: "Tents",
    priceCents: 32900,
    compareAtCents: 35900,
    cogsCents: 16400,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 21,
    inLiveRollout: false,
  },
  {
    id: "p_light",
    title: "Headlamp 400",
    sku: "HL-400",
    productType: "Lighting",
    priceCents: 4200,
    compareAtCents: null,
    cogsCents: 1610,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 210,
    inLiveRollout: false,
  },
  {
    id: "p_bottle",
    title: "Everyday Water Bottle",
    variantTitle: "1 L",
    sku: "EV-BTL-1L",
    productType: "Drinkware",
    priceCents: 2400,
    compareAtCents: null,
    cogsCents: 780,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 512,
    inLiveRollout: false,
  },
  {
    id: "p_pole",
    title: "Trekking Poles",
    variantTitle: "Pair",
    sku: "TP-PR-01",
    productType: "Tools",
    priceCents: 9900,
    compareAtCents: null,
    cogsCents: 4120,
    cogsSource: "shopify",
    kind: "standard",
    units30d: 39,
    inLiveRollout: false,
  },
  {
    id: "p_glove",
    title: "Windproof Gloves",
    sku: "WP-GLV-01",
    productType: "Accessories",
    // Someone edited this in Shopify mid-rollout, which is why ro_2039 is
    // paused: $49.70 (Priceflag) → $44.00 (external).
    priceCents: 4400,
    compareAtCents: null,
    cogsCents: 1720,
    cogsSource: "manual",
    kind: "standard",
    units30d: 74,
    inLiveRollout: false,
  },
  {
    id: "p_care",
    title: "Gear Care Kit",
    variantTitle: "Monthly subscription",
    sku: "GC-SUB-01",
    productType: "Subscriptions",
    priceCents: 1900,
    compareAtCents: null,
    cogsCents: 620,
    cogsSource: "shopify",
    kind: "subscription",
    units30d: 88,
    inLiveRollout: false,
  },
  {
    id: "p_gift",
    title: "Gift card",
    sku: "GIFT-CARD",
    productType: "Gift cards",
    priceCents: 5000,
    compareAtCents: null,
    cogsCents: null,
    cogsSource: null,
    kind: "gift_card",
    units30d: 34,
    inLiveRollout: false,
  },
];

/* ------------------------------------------------------------------------- *
 * The rest of the catalog.
 *
 * The curated products above are the ones the rollout and journal fixtures
 * reference by id. Real pilot stores run 30–500 SKUs, and A2's accept criterion
 * is that a 500-row catalog stays fast and legible, so the remainder is
 * generated from a fixed seed — never `Math.random`, so server render, client
 * hydration and build output always agree.
 * ------------------------------------------------------------------------- */

const CATALOG_SIZE = 500;

function seededRandom(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) state += 2_147_483_646;
  return () => {
    state = (state * 16_807) % 2_147_483_647;
    return (state - 1) / 2_147_483_646;
  };
}

type ProductLine = {
  type: string;
  code: string;
  nouns: string[];
  variants: string[];
  low: Cents;
  high: Cents;
};

const LINES: ProductLine[] = [
  {
    type: "Outerwear",
    code: "OW",
    nouns: ["Rain Shell", "Down Vest", "Fleece Hoodie", "Wind Jacket", "Insulated Parka"],
    variants: ["S", "M", "L", "XL"],
    low: 6900,
    high: 24900,
  },
  {
    type: "Packs",
    code: "PK",
    nouns: ["Daypack 18L", "Hauler 40L", "Hip Pack", "Summit Pack 30L"],
    variants: ["Slate", "Moss", "Clay"],
    low: 4900,
    high: 19900,
  },
  {
    type: "Drinkware",
    code: "DW",
    nouns: ["Vacuum Flask", "Insulated Mug", "Water Bottle", "Growler"],
    variants: ["350 ml", "500 ml", "750 ml", "1 L"],
    low: 1900,
    high: 5900,
  },
  {
    type: "Socks",
    code: "SK",
    nouns: ["Trail Socks", "Liner Socks", "Crew Socks"],
    variants: ["2-pack", "3-pack"],
    low: 1400,
    high: 3400,
  },
  {
    type: "Lighting",
    code: "LT",
    nouns: ["Headlamp", "Camp Lantern", "Trail Beacon"],
    variants: ["Black", "Sand"],
    low: 1900,
    high: 7900,
  },
  {
    type: "Cookware",
    code: "CK",
    nouns: ["Camp Stove", "Nesting Pot Set", "Kettle", "Griddle"],
    variants: ["Compact", "Wide"],
    low: 3900,
    high: 12900,
  },
  {
    type: "Sleep",
    code: "SL",
    nouns: ["Sleep Mat", "Sleeping Bag", "Camp Pillow"],
    variants: ["Regular", "Long"],
    low: 4900,
    high: 29900,
  },
  {
    type: "Tents",
    code: "TN",
    nouns: ["2-Person Tent", "3-Person Tent", "Tarp Shelter"],
    variants: ["Green", "Grey"],
    low: 17900,
    high: 44900,
  },
  {
    type: "Tools",
    code: "TL",
    nouns: ["Trekking Poles", "Multi-tool", "Folding Saw", "Repair Kit"],
    variants: ["Standard", "Long"],
    low: 1900,
    high: 13900,
  },
  {
    type: "Camp furniture",
    code: "CF",
    nouns: ["Folding Chair", "Camp Table", "Camp Stool"],
    variants: ["Standard", "Tall"],
    low: 3900,
    high: 14900,
  },
  {
    type: "Accessories",
    code: "AC",
    nouns: ["Gloves", "Beanie", "Neck Gaiter", "Dry Bag"],
    variants: ["S/M", "L/XL"],
    low: 1400,
    high: 5900,
  },
];

const PREFIXES = [
  "Ridgeline",
  "Summit",
  "Basecamp",
  "Trailhead",
  "Foghorn",
  "Riverbank",
  "Cloudbed",
  "Northwind",
  "Pinecrest",
  "Backcountry",
  "Driftwood",
  "Stonefield",
];

/** Merchant-looking prices: nearest dollar, minus a cent. */
function toShelfPrice(cents: number): Cents {
  return Math.max(199, Math.round(cents / 100) * 100 - 1);
}

function generateCatalog(count: number): Product[] {
  const random = seededRandom(20_260_729);
  const products: Product[] = [];
  const usedNames = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    // Re-draw a few times rather than emit three visually identical rows; a
    // catalog that looks copy-pasted reads as a rendering bug.
    let line = LINES[0];
    let prefix = PREFIXES[0];
    let noun = line.nouns[0];
    let variantTitle: string | undefined;
    let name = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      line = LINES[Math.floor(random() * LINES.length)];
      prefix = PREFIXES[Math.floor(random() * PREFIXES.length)];
      noun = line.nouns[Math.floor(random() * line.nouns.length)];
      variantTitle =
        line.variants.length > 0
          ? line.variants[Math.floor(random() * line.variants.length)]
          : undefined;
      name = `${prefix} ${noun} ${variantTitle ?? ""}`;
      if (!usedNames.has(name)) break;
    }
    if (usedNames.has(name)) {
      // Out of fresh combinations: a model number, the way a real catalog does it.
      noun = `${noun} ${200 + index}`;
      name = `${prefix} ${noun} ${variantTitle ?? ""}`;
    }
    usedNames.add(name);

    const priceCents = toShelfPrice(line.low + random() * (line.high - line.low));

    // ~7% of a real catalog has no cost filled in. That state is designed for.
    const hasCost = random() > 0.07;
    const marginTarget = 0.34 + random() * 0.3;
    const cogsCents = hasCost ? Math.round((priceCents * (1 - marginTarget)) / 10) * 10 : null;

    products.push({
      id: `p_gen_${index + 1}`,
      title: `${prefix} ${noun}`,
      variantTitle,
      sku: `${line.code}-${1000 + index}`,
      priceCents,
      compareAtCents: random() > 0.87 ? toShelfPrice(priceCents * 1.18) : null,
      cogsCents,
      cogsSource: cogsCents === null ? null : random() > 0.28 ? "shopify" : "manual",
      kind: "standard",
      productType: line.type,
      // Squared so most SKUs are slow movers and a few are the bestsellers.
      units30d: Math.round(1 + random() * random() * 380),
      inLiveRollout: false,
    });
  }

  return products;
}

const ALL_PRODUCTS: Product[] = [
  ...PRODUCTS,
  ...generateCatalog(Math.max(0, CATALOG_SIZE - PRODUCTS.length)),
];

const LIVE_ROLLOUT: Rollout = {
  id: "ro_2041",
  name: "Cost increase pass — outdoor core",
  status: "live",
  change: { kind: "percent", value: 6 },
  productIds: ["p_ridge", "p_trail", "p_flask", "p_socks", "p_lamp", "p_stove"],
  stages: [
    {
      sharePct: 25,
      holdDays: 3,
      status: "completed",
      startedOn: "2026-07-23",
      completedOn: "2026-07-26",
      skuCount: 2,
    },
    {
      sharePct: 50,
      holdDays: 4,
      status: "active",
      startedOn: "2026-07-26",
      completedOn: null,
      skuCount: 3,
    },
    {
      sharePct: 100,
      holdDays: 4,
      status: "pending",
      startedOn: null,
      completedOn: null,
      skuCount: 6,
    },
  ],
  currentStageIndex: 1,
  guardrail: { unitsDropPct: 30, forDays: 2, action: "revert_all" },
  createdAt: "2026-07-22T15:41:00Z",
  startedAt: "2026-07-23T06:00:00Z",
  scheduledFor: null,
  endedAt: null,
  readings: [
    {
      date: "2026-07-23",
      actualUnits: 268,
      expectedUnits: 274,
      expectedLow: 236,
      expectedHigh: 312,
      verdict: "within",
      confidence: "partial",
    },
    {
      date: "2026-07-24",
      actualUnits: 259,
      expectedUnits: 271,
      expectedLow: 233,
      expectedHigh: 309,
      verdict: "within",
      confidence: "partial",
    },
    {
      date: "2026-07-25",
      actualUnits: 198,
      expectedUnits: 268,
      expectedLow: 231,
      expectedHigh: 305,
      verdict: "below",
      confidence: "partial",
    },
    {
      date: "2026-07-26",
      actualUnits: 247,
      expectedUnits: 262,
      expectedLow: 226,
      expectedHigh: 298,
      verdict: "within",
      confidence: "partial",
    },
    {
      date: "2026-07-27",
      actualUnits: 281,
      expectedUnits: 259,
      expectedLow: 223,
      expectedHigh: 295,
      verdict: "within",
      confidence: "partial",
    },
    {
      date: "2026-07-28",
      actualUnits: 264,
      expectedUnits: 266,
      expectedLow: 229,
      expectedHigh: 303,
      verdict: "within",
      confidence: "partial",
    },
  ],
  events: [
    {
      id: "ev_1",
      at: "2026-07-22T15:41:00Z",
      kind: "created",
      message: "You set up this change: 6% higher on 6 products, in three steps.",
    },
    {
      id: "ev_2",
      at: "2026-07-23T06:00:00Z",
      kind: "started",
      message: "New prices went live on 2 of 6 products.",
      detail: "Summit Vacuum Flask, Merino Trail Socks",
    },
    {
      id: "ev_3",
      at: "2026-07-26T06:02:00Z",
      kind: "warning",
      message:
        "Orders on July 25 came in below the range we expected. Not far enough to undo the change.",
      detail:
        "198 orders against an expected 231–305. The automatic undo needs two days in a row more than 30% below expected.",
    },
    {
      id: "ev_4",
      at: "2026-07-26T06:03:00Z",
      kind: "advanced",
      message: "Moved on to 3 of 6 products. Orders in the first step stayed in the expected range.",
      detail: "Added Ridgeline Rain Jacket",
    },
    {
      id: "ev_5",
      at: "2026-07-29T06:04:00Z",
      kind: "held",
      message: "Holding at 3 of 6 products for one more day. Yesterday's orders were in range.",
    },
  ],
  forecast: {
    breakevenUnitsDropPct: 9.8,
    blendedMarginFraction: 0.552,
    horizonDays: 90,
    profitDeltaLowCents: 182_000,
    profitDeltaHighCents: 741_000,
    revenueDeltaLowCents: -124_000,
    revenueDeltaHighCents: 563_000,
    ordersDeltaLowFraction: -0.085,
    ordersDeltaHighFraction: -0.012,
    confidence: "partial",
    explanation:
      "Two of these six products have sold at more than one price before, so this range leans on limited history from your own store.",
    modelVersion: null,
  },
  realizedProfitDeltaCents: null,
};

const PAUSED_ROLLOUT: Rollout = {
  id: "ro_2039",
  name: "Margin fix — gloves and poles",
  status: "paused_external",
  change: { kind: "percent", value: 8 },
  productIds: ["p_glove", "p_pole"],
  stages: [
    {
      sharePct: 50,
      holdDays: 3,
      status: "active",
      startedOn: "2026-07-27",
      completedOn: null,
      skuCount: 1,
    },
    {
      sharePct: 100,
      holdDays: 3,
      status: "pending",
      startedOn: null,
      completedOn: null,
      skuCount: 2,
    },
  ],
  currentStageIndex: 0,
  guardrail: { unitsDropPct: 25, forDays: 2, action: "revert_all" },
  createdAt: "2026-07-26T09:12:00Z",
  startedAt: "2026-07-27T06:00:00Z",
  scheduledFor: null,
  endedAt: null,
  readings: [
    {
      date: "2026-07-27",
      actualUnits: 4,
      expectedUnits: 5,
      expectedLow: 1,
      expectedHigh: 10,
      verdict: "within",
      confidence: "assumption",
    },
    {
      date: "2026-07-28",
      actualUnits: 3,
      expectedUnits: 5,
      expectedLow: 1,
      expectedHigh: 10,
      verdict: "within",
      confidence: "assumption",
    },
  ],
  events: [
    {
      id: "ev_10",
      at: "2026-07-26T09:12:00Z",
      kind: "created",
      message: "You set up this change: 8% higher on 2 products, in two steps.",
    },
    {
      id: "ev_11",
      at: "2026-07-27T06:00:00Z",
      kind: "started",
      message: "New prices went live on 1 of 2 products.",
    },
    {
      id: "ev_12",
      at: "2026-07-28T14:22:00Z",
      kind: "paused",
      message:
        "Paused: someone changed the price of Windproof Gloves in Shopify, so we stopped rather than guess.",
      detail:
        "Price went from $49.70 to $44.00 outside Priceflag at 2:22 PM. Nothing else has been touched.",
    },
  ],
  forecast: {
    breakevenUnitsDropPct: 12.1,
    blendedMarginFraction: 0.591,
    horizonDays: 90,
    profitDeltaLowCents: -18_000,
    profitDeltaHighCents: 96_000,
    revenueDeltaLowCents: -74_000,
    revenueDeltaHighCents: 88_000,
    ordersDeltaLowFraction: -0.14,
    ordersDeltaHighFraction: 0.01,
    confidence: "assumption",
    explanation:
      "Neither of these products has ever sold at a different price, so this range comes from a general assumption, not from your store.",
    modelVersion: null,
  },
  realizedProfitDeltaCents: null,
};

const ROLLED_BACK_ROLLOUT: Rollout = {
  id: "ro_2036",
  name: "Flask price test",
  status: "rolled_back",
  change: { kind: "percent", value: 14 },
  productIds: ["p_flask"],
  stages: [
    {
      sharePct: 100,
      holdDays: 4,
      status: "completed",
      startedOn: "2026-07-06",
      completedOn: "2026-07-09",
      skuCount: 1,
    },
  ],
  currentStageIndex: 0,
  guardrail: { unitsDropPct: 30, forDays: 2, action: "revert_all" },
  createdAt: "2026-07-05T11:02:00Z",
  startedAt: "2026-07-06T06:00:00Z",
  scheduledFor: null,
  endedAt: "2026-07-09T06:07:00Z",
  readings: [
    {
      date: "2026-07-06",
      actualUnits: 9,
      expectedUnits: 13,
      expectedLow: 8,
      expectedHigh: 18,
      verdict: "within",
      confidence: "fitted",
    },
    {
      date: "2026-07-07",
      actualUnits: 4,
      expectedUnits: 13,
      expectedLow: 8,
      expectedHigh: 18,
      verdict: "below",
      confidence: "fitted",
    },
    {
      date: "2026-07-08",
      actualUnits: 3,
      expectedUnits: 12,
      expectedLow: 7,
      expectedHigh: 17,
      verdict: "below",
      confidence: "fitted",
    },
  ],
  events: [
    {
      id: "ev_20",
      at: "2026-07-05T11:02:00Z",
      kind: "created",
      message: "You set up this change: 14% higher on 1 product.",
    },
    {
      id: "ev_21",
      at: "2026-07-06T06:00:00Z",
      kind: "started",
      message: "New price went live: $36.00 → $41.00.",
    },
    {
      id: "ev_22",
      at: "2026-07-09T06:07:00Z",
      kind: "rolled_back",
      message: "Undone automatically. Orders were more than 30% below expected two days in a row.",
      detail: "Price back to $36.00 at 6:07 AM. 1 product restored.",
    },
  ],
  forecast: {
    breakevenUnitsDropPct: 18.3,
    blendedMarginFraction: 0.644,
    horizonDays: 90,
    profitDeltaLowCents: -42_000,
    profitDeltaHighCents: 214_000,
    revenueDeltaLowCents: -160_000,
    revenueDeltaHighCents: 190_000,
    ordersDeltaLowFraction: -0.24,
    ordersDeltaHighFraction: -0.04,
    confidence: "fitted",
    explanation:
      "This product has sold at three different prices in the last six months, so the range is fitted to your own sales.",
    modelVersion: "elasticity-v1",
  },
  realizedProfitDeltaCents: -21_400,
};

const COMPLETED_ROLLOUT: Rollout = {
  id: "ro_2030",
  name: "Last-season clearance",
  status: "completed",
  change: { kind: "percent", value: -12 },
  productIds: ["p_tent", "p_chair", "p_mat", "p_light"],
  stages: [
    {
      sharePct: 25,
      holdDays: 3,
      status: "completed",
      startedOn: "2026-06-08",
      completedOn: "2026-06-11",
      skuCount: 1,
    },
    {
      sharePct: 50,
      holdDays: 3,
      status: "completed",
      startedOn: "2026-06-11",
      completedOn: "2026-06-14",
      skuCount: 2,
    },
    {
      sharePct: 100,
      holdDays: 4,
      status: "completed",
      startedOn: "2026-06-14",
      completedOn: "2026-06-18",
      skuCount: 4,
    },
  ],
  currentStageIndex: 2,
  guardrail: { unitsDropPct: 35, forDays: 2, action: "revert_all" },
  createdAt: "2026-06-07T10:20:00Z",
  startedAt: "2026-06-08T06:00:00Z",
  scheduledFor: null,
  endedAt: "2026-06-18T06:00:00Z",
  readings: [],
  events: [
    {
      id: "ev_30",
      at: "2026-06-08T06:00:00Z",
      kind: "started",
      message: "New prices went live on 1 of 4 products.",
    },
    {
      id: "ev_31",
      at: "2026-06-18T06:00:00Z",
      kind: "completed",
      message: "Finished. All 4 products are on the new price and monitoring has stopped.",
    },
  ],
  forecast: {
    breakevenUnitsDropPct: -21.4,
    blendedMarginFraction: 0.48,
    horizonDays: 90,
    profitDeltaLowCents: -96_000,
    profitDeltaHighCents: 388_000,
    revenueDeltaLowCents: 120_000,
    revenueDeltaHighCents: 940_000,
    ordersDeltaLowFraction: 0.08,
    ordersDeltaHighFraction: 0.31,
    confidence: "partial",
    explanation:
      "Three of these four products have been discounted before, so the range leans on limited history from your own store.",
    modelVersion: null,
  },
  realizedProfitDeltaCents: 254_800,
};

const SCHEDULED_ROLLOUT: Rollout = {
  id: "ro_2042",
  name: "Tent price correction",
  status: "scheduled",
  change: { kind: "absolute", value: 2000 },
  productIds: ["p_tent"],
  stages: [
    {
      sharePct: 100,
      holdDays: 4,
      status: "pending",
      startedOn: null,
      completedOn: null,
      skuCount: 1,
    },
  ],
  currentStageIndex: 0,
  guardrail: { unitsDropPct: 30, forDays: 2, action: "revert_all" },
  createdAt: "2026-07-28T16:30:00Z",
  startedAt: null,
  scheduledFor: "2026-08-03T06:00:00Z",
  endedAt: null,
  readings: [],
  events: [
    {
      id: "ev_40",
      at: "2026-07-28T16:30:00Z",
      kind: "scheduled",
      message: "Set to start on Monday, August 3 at 6:00 AM in your store's time.",
    },
  ],
  forecast: {
    breakevenUnitsDropPct: 11.2,
    blendedMarginFraction: 0.501,
    horizonDays: 90,
    profitDeltaLowCents: -8_000,
    profitDeltaHighCents: 132_000,
    revenueDeltaLowCents: -22_000,
    revenueDeltaHighCents: 148_000,
    ordersDeltaLowFraction: -0.11,
    ordersDeltaHighFraction: 0.0,
    confidence: "partial",
    explanation:
      "This tent has sold at two prices in the last year, so the range leans on limited history from your own store.",
    modelVersion: null,
  },
  realizedProfitDeltaCents: null,
};

const DRAFT_ROLLOUT: Rollout = {
  id: "ro_2043",
  name: "Autumn cost pass",
  status: "draft",
  change: { kind: "percent", value: 4 },
  productIds: ["p_bottle", "p_light", "p_glove"],
  stages: [
    {
      sharePct: 25,
      holdDays: 3,
      status: "pending",
      startedOn: null,
      completedOn: null,
      skuCount: 1,
    },
    {
      sharePct: 50,
      holdDays: 3,
      status: "pending",
      startedOn: null,
      completedOn: null,
      skuCount: 2,
    },
    {
      sharePct: 100,
      holdDays: 4,
      status: "pending",
      startedOn: null,
      completedOn: null,
      skuCount: 3,
    },
  ],
  currentStageIndex: 0,
  guardrail: { unitsDropPct: 30, forDays: 2, action: "revert_all" },
  createdAt: "2026-07-29T08:15:00Z",
  startedAt: null,
  scheduledFor: null,
  endedAt: null,
  readings: [],
  events: [
    {
      id: "ev_50",
      at: "2026-07-29T08:15:00Z",
      kind: "created",
      message: "Draft saved. Nothing has changed on your storefront.",
    },
  ],
  forecast: {
    breakevenUnitsDropPct: 6.4,
    blendedMarginFraction: 0.629,
    horizonDays: 90,
    profitDeltaLowCents: 44_000,
    profitDeltaHighCents: 268_000,
    revenueDeltaLowCents: -12_000,
    revenueDeltaHighCents: 214_000,
    ordersDeltaLowFraction: -0.06,
    ordersDeltaHighFraction: 0.0,
    confidence: "partial",
    explanation:
      "Two of these three products have sold at more than one price, so the range leans on limited history from your own store.",
    modelVersion: null,
  },
  realizedProfitDeltaCents: null,
};

const ROLLOUTS: Rollout[] = [
  LIVE_ROLLOUT,
  PAUSED_ROLLOUT,
  SCHEDULED_ROLLOUT,
  DRAFT_ROLLOUT,
  ROLLED_BACK_ROLLOUT,
  COMPLETED_ROLLOUT,
];

const JOURNAL: JournalEntry[] = [
  {
    id: "j_120",
    at: "2026-07-28T14:22:00Z",
    productId: "p_glove",
    productTitle: "Windproof Gloves",
    sku: "WP-GLV-01",
    fromCents: 4970,
    toCents: 4400,
    actor: "external",
    kind: "external",
    reason: "Changed in Shopify, outside Priceflag",
    rolloutId: "ro_2039",
  },
  {
    id: "j_119",
    at: "2026-07-27T06:00:00Z",
    productId: "p_glove",
    productTitle: "Windproof Gloves",
    sku: "WP-GLV-01",
    fromCents: 4600,
    toCents: 4970,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 1 of “Margin fix — gloves and poles”",
    rolloutId: "ro_2039",
  },
  {
    id: "j_118",
    at: "2026-07-26T06:03:00Z",
    productId: "p_ridge",
    productTitle: "Ridgeline Rain Jacket",
    sku: "RG-JKT-01",
    fromCents: 17800,
    toCents: 18900,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 2 of “Cost increase pass — outdoor core”",
    rolloutId: "ro_2041",
  },
  {
    id: "j_117",
    at: "2026-07-23T06:00:00Z",
    productId: "p_socks",
    productTitle: "Merino Trail Socks",
    sku: "MR-SCK-03",
    fromCents: 2640,
    toCents: 2800,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 1 of “Cost increase pass — outdoor core”",
    rolloutId: "ro_2041",
  },
  {
    id: "j_116",
    at: "2026-07-23T06:00:00Z",
    productId: "p_flask",
    productTitle: "Summit Vacuum Flask",
    sku: "SM-FLS-75",
    fromCents: 3400,
    toCents: 3600,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 1 of “Cost increase pass — outdoor core”",
    rolloutId: "ro_2041",
  },
  {
    id: "j_115",
    at: "2026-07-14T09:41:00Z",
    productId: "p_bottle",
    productTitle: "Everyday Water Bottle",
    sku: "EV-BTL-1L",
    fromCents: 2200,
    toCents: 2400,
    actor: "you",
    kind: "manual",
    reason: "Set by you in Priceflag, no rollout",
    rolloutId: null,
  },
  {
    id: "j_114",
    at: "2026-07-09T06:07:00Z",
    productId: "p_flask",
    productTitle: "Summit Vacuum Flask",
    sku: "SM-FLS-75",
    fromCents: 4100,
    toCents: 3400,
    actor: "priceflag",
    kind: "rollback",
    reason: "Undone automatically — orders below expected two days running",
    rolloutId: "ro_2036",
  },
  {
    id: "j_113",
    at: "2026-07-06T06:00:00Z",
    productId: "p_flask",
    productTitle: "Summit Vacuum Flask",
    sku: "SM-FLS-75",
    fromCents: 3400,
    toCents: 4100,
    actor: "priceflag",
    kind: "rollout",
    reason: "“Flask price test”",
    rolloutId: "ro_2036",
  },
  {
    id: "j_112",
    at: "2026-06-18T06:00:00Z",
    productId: "p_light",
    productTitle: "Headlamp 400",
    sku: "HL-400",
    fromCents: 4770,
    toCents: 4200,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 3 of “Last-season clearance”",
    rolloutId: "ro_2030",
  },
  {
    id: "j_111",
    at: "2026-06-18T06:00:00Z",
    productId: "p_mat",
    productTitle: "Cloudbed Sleep Mat",
    sku: "CB-MAT-01",
    fromCents: 16900,
    toCents: 14900,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 3 of “Last-season clearance”",
    rolloutId: "ro_2030",
  },
  {
    id: "j_110",
    at: "2026-06-14T06:00:00Z",
    productId: "p_chair",
    productTitle: "Riverbank Folding Chair",
    sku: "RB-CHR-01",
    fromCents: 8200,
    toCents: 7200,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 2 of “Last-season clearance”",
    rolloutId: "ro_2030",
  },
  {
    id: "j_109",
    at: "2026-06-08T06:00:00Z",
    productId: "p_tent",
    productTitle: "Foghorn Tent",
    sku: "FG-TNT-02",
    fromCents: 37400,
    toCents: 32900,
    actor: "priceflag",
    kind: "rollout",
    reason: "Step 1 of “Last-season clearance”",
    rolloutId: "ro_2030",
  },
];

/* ------------------------------------------------------------------------- *
 * Reads. These are the calls Lane B will replace, one for one.
 * ------------------------------------------------------------------------- */

export function getProducts(): Product[] {
  return ALL_PRODUCTS;
}

export function getProduct(id: string): Product | undefined {
  return ALL_PRODUCTS.find((product) => product.id === id);
}

/** Product types present in the catalog, for the catalog's type filter. */
export function getProductTypes(): string[] {
  const types = new Set(ALL_PRODUCTS.map((product) => product.productType));
  return [...types].sort((a, b) => a.localeCompare(b));
}

/**
 * Mocked cost write. Lane B's real server action is requested in
 * contracts/requests-lane-a.md (REQ-A-004); the UI already treats it as async
 * and fallible, so swapping it in is a one-line change.
 */
export async function saveProductCost(
  productId: string,
  cogsCents: Cents | null,
): Promise<{ ok: true; cogsCents: Cents | null } | { ok: false; message: string }> {
  await new Promise((resolve) => setTimeout(resolve, 350));
  if (cogsCents !== null && (!Number.isFinite(cogsCents) || cogsCents < 0)) {
    return { ok: false, message: "A cost can't be negative." };
  }
  void productId;
  return { ok: true, cogsCents };
}

export function getRollouts(): Rollout[] {
  return ROLLOUTS;
}

export function getRollout(id: string): Rollout | undefined {
  return ROLLOUTS.find((rollout) => rollout.id === id);
}

export function getJournal(): JournalEntry[] {
  return JOURNAL;
}

export type LiveHealth = "on_track" | "watch" | "breach";

/**
 * The one read the overview is built around: what is live right now, and is it
 * behaving? Requested from Lane B as a single engine call (REQ-A-003).
 */
export type LiveSummary = {
  rollout: Rollout | null;
  /** Products currently sitting on a price Priceflag set. */
  skusChanged: number;
  skusSelected: number;
  health: LiveHealth;
  /** Rendered verbatim, so the sentence has to be true and plain. */
  healthSentence: string;
  latestReading: RolloutReading | null;
  pausedRollouts: Rollout[];
  productsMissingCost: number;
};

export function getLiveSummary(): LiveSummary {
  const live = ROLLOUTS.find((rollout) => rollout.status === "live" || rollout.status === "holding");
  const readings = live?.readings ?? [];
  const latestReading = readings.length > 0 ? readings[readings.length - 1] : null;
  const consecutiveBelow = countTrailingBelow(readings);

  let health: LiveHealth = "on_track";
  let healthSentence = "Orders are inside the range we expected.";
  if (live && consecutiveBelow >= (live.guardrail.forDays ?? 2)) {
    health = "breach";
    healthSentence = "Orders have been below expected long enough to undo the change.";
  } else if (live && consecutiveBelow > 0) {
    health = "watch";
    healthSentence = "Yesterday's orders came in below the range we expected.";
  } else if (live && readings.some((reading) => reading.verdict === "below")) {
    health = "on_track";
    healthSentence =
      "Orders are inside the range we expected. One earlier day came in low and recovered.";
  }

  return {
    rollout: live ?? null,
    skusChanged: ALL_PRODUCTS.filter((product) => product.inLiveRollout).length,
    skusSelected: live?.productIds.length ?? 0,
    health,
    healthSentence,
    latestReading,
    pausedRollouts: ROLLOUTS.filter((rollout) => rollout.status === "paused_external"),
    productsMissingCost: ALL_PRODUCTS.filter(
      (product) => product.kind === "standard" && product.cogsCents === null,
    ).length,
  };
}

function countTrailingBelow(readings: RolloutReading[]): number {
  let count = 0;
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    if (readings[index].verdict !== "below") break;
    count += 1;
  }
  return count;
}

/** Products a rollout touches, in catalog order. */
export function getRolloutProducts(rollout: Rollout): Product[] {
  return ALL_PRODUCTS.filter((product) => rollout.productIds.includes(product.id));
}

/** Journal rows tied to one rollout, newest first. */
export function getJournalForRollout(rolloutId: string): JournalEntry[] {
  return JOURNAL.filter((entry) => entry.rolloutId === rolloutId);
}

/** The price a product would move to under a rollout's change. */
export function priceAfterChange(product: Product, change: PriceChange): Cents {
  if (change.kind === "absolute") return Math.max(0, product.priceCents + change.value);
  return Math.max(0, Math.round(product.priceCents * (1 + change.value / 100)));
}
