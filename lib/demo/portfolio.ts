/**
 * Six simulated stores, two per size, for the founder lab and the investor
 * numbers. Each is a catalog fed through the same demand model as the 14-product
 * demo store (`generator.ts`), so every row has a known true elasticity that the
 * rest of the product never sees.
 *
 * Deterministic from the preset's seed: the same preset always builds the same
 * store, so a number quoted from it can be reproduced.
 */

import { toGid } from '../shopify/gid';
import { generateDemoStore, mulberry32, type DemoProductSpec, type DemoStore } from './generator';

export type StoreSize = 'small' | 'medium' | 'large';

export interface StorePreset {
  id: string;
  name: string;
  domain: string;
  size: StoreSize;
  category: keyof typeof CATEGORIES;
  skuCount: number;
  seed: number;
  /** One line for the lab's store picker. */
  blurb: string;
}

export const STORE_PRESETS: readonly StorePreset[] = [
  {
    id: 'morning-root',
    name: 'Morning Root Botanicals',
    domain: 'morning-root-demo.myshopify.com',
    size: 'small',
    category: 'coffee_alternatives',
    skuCount: 14,
    seed: 101,
    blurb: 'Repeat-purchase grocery, a dozen SKUs, most volume in two heroes.',
  },
  {
    id: 'fenwick-leather',
    name: 'Fenwick Leather',
    domain: 'fenwick-leather-demo.myshopify.com',
    size: 'small',
    category: 'leather_goods',
    skuCount: 18,
    seed: 102,
    blurb: 'High ticket, low volume: the store where a quiet day proves nothing.',
  },
  {
    id: 'northline-apparel',
    name: 'Northline Apparel',
    domain: 'northline-apparel-demo.myshopify.com',
    size: 'medium',
    category: 'apparel',
    skuCount: 72,
    seed: 201,
    blurb: 'Size and colour variants, seasonal promos, steady mid-volume.',
  },
  {
    id: 'kilnworks-home',
    name: 'Kilnworks Home',
    domain: 'kilnworks-home-demo.myshopify.com',
    size: 'medium',
    category: 'home',
    skuCount: 64,
    seed: 202,
    blurb: 'Mugs to throws: mixed price points and a long tail of slow sellers.',
  },
  {
    id: 'ridgeline-supply',
    name: 'Ridgeline Supply Co.',
    domain: 'ridgeline-supply-demo.myshopify.com',
    size: 'large',
    category: 'outdoor',
    skuCount: 280,
    seed: 301,
    blurb: 'Hundreds of SKUs and a few hundred orders a day, with real portfolio structure.',
  },
  {
    id: 'atlas-beauty',
    name: 'Atlas Beauty',
    domain: 'atlas-beauty-demo.myshopify.com',
    size: 'large',
    category: 'beauty',
    skuCount: 320,
    seed: 302,
    blurb: 'Promo-heavy category, big catalog, lots of near-duplicates.',
  },
];

export function findPreset(id: string): StorePreset | null {
  return STORE_PRESETS.find((preset) => preset.id === id) ?? null;
}

interface CategorySpec {
  vendors: string[];
  types: string[];
  nouns: string[];
  adjectives: string[];
  variants: (string | null)[];
  /** Price range in dollars. */
  price: [number, number];
  /** Cost as a share of price. */
  costShare: [number, number];
  /** Category-typical elasticity: mean and spread. */
  elasticity: [number, number];
  subscription: boolean;
}

const CATEGORIES = {
  coffee_alternatives: {
    vendors: ['Morning Root', 'Ridgeline Roasters'],
    types: ['Grocery', 'Grocery', 'Drinkware'],
    nouns: ['Cacao Blend', 'Chai Blend', 'Dandelion Roast', 'Mushroom Latte', 'Matcha', 'Rooibos Chai', 'Chicory Brew', 'Golden Milk', 'Tumbler', 'Frother'],
    adjectives: ['Original', 'Bold', 'Calm', 'Focus', 'Decaf', 'Spiced', 'Unsweetened'],
    variants: ['8oz bag', '16oz bag', 'Sample tin', '3-pack', null],
    price: [14, 58],
    costShare: [0.3, 0.5],
    elasticity: [-1.6, 0.4],
    subscription: true,
  },
  leather_goods: {
    vendors: ['Fenwick'],
    types: ['Accessories', 'Bags', 'Small goods'],
    nouns: ['Belt', 'Bifold Wallet', 'Card Holder', 'Weekender', 'Tote', 'Watch Strap', 'Key Fob', 'Passport Cover', 'Dopp Kit', 'Briefcase'],
    adjectives: ['Bridle', 'Horween', 'Waxed', 'Heritage', 'Slim', 'Classic'],
    variants: ['Tan', 'Black', 'Oxblood', 'Natural', '32', '34', '36', null],
    price: [45, 420],
    costShare: [0.28, 0.45],
    elasticity: [-1.0, 0.35],
    subscription: false,
  },
  apparel: {
    vendors: ['Northline', 'Harbor & Vale', 'Kestrel'],
    types: ['Apparel', 'Apparel', 'Apparel', 'Accessories'],
    nouns: ['Everyday Tee', 'Merino Crew', 'Oxford Shirt', 'Chino', 'Hoodie', 'Rain Shell', 'Field Jacket', 'Linen Short', 'Wool Sock', 'Beanie', 'Tank', 'Cardigan'],
    adjectives: ['Essential', 'Heavyweight', 'Lightweight', 'Organic', 'Relaxed', 'Slim', 'Garment-dyed'],
    variants: ['S / Black', 'M / Black', 'L / Black', 'XL / Black', 'S / Oat', 'M / Oat', 'L / Oat', 'M / Navy', 'L / Navy', 'One size'],
    price: [22, 220],
    costShare: [0.3, 0.5],
    elasticity: [-1.5, 0.45],
    subscription: false,
  },
  home: {
    vendors: ['Kilnworks', 'Loom & Ash', 'Stillwater'],
    types: ['Home', 'Kitchen', 'Textiles', 'Decor'],
    nouns: ['Ceramic Mug', 'Linen Throw', 'Pour-Over Kettle', 'Stoneware Bowl', 'Candle', 'Cutting Board', 'Serving Platter', 'Napkin Set', 'Vase', 'Tea Towel', 'Salt Cellar', 'Dinner Plate'],
    adjectives: ['Sand', 'Indigo', 'Charcoal', 'Speckled', 'Matte', 'Glazed', 'Hand-thrown'],
    variants: ['Small', 'Large', 'Set of 2', 'Set of 4', null, null],
    price: [18, 260],
    costShare: [0.32, 0.55],
    elasticity: [-1.3, 0.4],
    subscription: false,
  },
  outdoor: {
    vendors: ['Ridgeline', 'Cairn Supply', 'Northline', 'Fenwick'],
    types: ['Outdoor', 'Consumables', 'Apparel', 'Gear', 'Accessories'],
    nouns: ['Trail Bar', 'Electrolyte Mix', 'Headlamp', 'Dry Bag', 'Trekking Pole', 'Insulated Bottle', 'Camp Mug', 'Merino Base Layer', 'Rain Cover', 'First Aid Kit', 'Stove Fuel', 'Trail Sock', 'Map Case', 'Tent Stake Set', 'Bear Canister', 'Sun Hoodie'],
    adjectives: ['Ultralight', 'Summit', 'Basecamp', 'Alpine', 'Ridge', 'Trail', 'Everyday', 'Pro'],
    variants: ['1L', '750ml', 'S', 'M', 'L', 'XL', '12-pack', 'Single', null, null],
    price: [6, 240],
    costShare: [0.35, 0.6],
    elasticity: [-1.7, 0.5],
    subscription: true,
  },
  beauty: {
    vendors: ['Atlas', 'Meridian Skin', 'Solstice Labs', 'Atlas'],
    types: ['Skincare', 'Skincare', 'Body', 'Hair', 'Sets'],
    nouns: ['Vitamin C Serum', 'Retinol Night Cream', 'Hyaluronic Toner', 'Cleansing Balm', 'SPF 50 Daily', 'Eye Cream', 'Clay Mask', 'Body Oil', 'Hand Cream', 'Lip Treatment', 'Scalp Serum', 'Repair Shampoo', 'Glow Set', 'Travel Kit'],
    adjectives: ['Daily', 'Intensive', 'Gentle', 'Brightening', 'Barrier', 'Overnight', 'Sensitive', 'Advanced'],
    variants: ['30ml', '50ml', '100ml', 'Refill', 'Mini', null, null],
    price: [12, 145],
    costShare: [0.18, 0.4],
    elasticity: [-1.4, 0.45],
    subscription: true,
  },
} satisfies Record<string, CategorySpec>;

/** Mean daily units per SKU by volume tier; drawn per SKU, heavy on the long tail. */
const VOLUME_TIERS: Record<StoreSize, { means: number[]; weights: number[] }> = {
  small: { means: [6, 2.5, 0.9, 0.3], weights: [0.2, 0.3, 0.3, 0.2] },
  medium: { means: [9, 3.5, 1.2, 0.35], weights: [0.15, 0.3, 0.35, 0.2] },
  large: { means: [14, 5, 1.6, 0.5, 0.15], weights: [0.1, 0.2, 0.3, 0.25, 0.15] },
};

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)] as T;
}

function weighted(rng: () => number, weights: readonly number[]): number {
  let roll = rng();
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i] as number;
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

function normal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function between(rng: () => number, low: number, high: number): number {
  return low + rng() * (high - low);
}

/** A deterministic catalog for a preset: titles, prices, costs, volume, and hidden elasticity. */
export function buildCatalog(preset: StorePreset): DemoProductSpec[] {
  const rng = mulberry32(preset.seed);
  const category = CATEGORIES[preset.category] as CategorySpec;
  const tiers = VOLUME_TIERS[preset.size];
  const specs: DemoProductSpec[] = [];
  const seenHandles = new Set<string>();

  for (let index = 0; index < preset.skuCount; index += 1) {
    const noun = pick(rng, category.nouns);
    const adjective = pick(rng, category.adjectives);
    const title = `${adjective} ${noun}`;
    const variantTitle = pick(rng, category.variants);
    const base = `${title}${variantTitle ? ` ${variantTitle}` : ''}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    let handle = base;
    let suffix = 2;
    while (seenHandles.has(handle)) handle = `${base}-${suffix++}`;
    seenHandles.add(handle);

    // Log-uniform prices so the catalog has a real spread, then .00/.99 endings
    // like a merchant would type.
    const [low, high] = category.price;
    const rawPrice = Math.exp(between(rng, Math.log(low), Math.log(high)));
    const dollars = Math.max(1, Math.round(rawPrice));
    const price = rng() < 0.6 ? `${dollars - 1}.99` : `${dollars}.00`;
    const priceCents = Math.round(Number(price) * 100);
    const missingCost = rng() < 0.12;
    const costShare = between(rng, category.costShare[0], category.costShare[1]);
    const cost = missingCost ? null : (Math.round(priceCents * costShare) / 100).toFixed(2);
    const compareAt = rng() < 0.12 ? (Math.round(priceCents * between(rng, 1.15, 1.35)) / 100).toFixed(2) : null;

    const tier = weighted(rng, tiers.weights);
    const baseUnitsPerDay = Number(
      ((tiers.means[tier] as number) * Math.exp(0.45 * normal(rng))).toFixed(2),
    );

    const [elasticityMean, elasticitySd] = category.elasticity;
    const trueElasticity = Number(
      Math.min(-0.4, Math.max(-3.2, elasticityMean + elasticitySd * normal(rng))).toFixed(2),
    );

    // Price history: most SKUs have moved once or not at all, a few twice.
    const changeCount = weighted(rng, [0.38, 0.42, 0.2]);
    const priceChanges: { atDayOffset: number; pct: number }[] = [];
    let cursor = 25 + Math.floor(rng() * 40);
    for (let change = 0; change < changeCount; change += 1) {
      const magnitude = 4 + Math.floor(rng() * 9);
      priceChanges.push({ atDayOffset: cursor, pct: rng() < 0.65 ? magnitude : -magnitude });
      cursor += 40 + Math.floor(rng() * 60);
      if (cursor > 150) break;
    }

    specs.push({
      handle,
      title,
      variantTitle,
      productType: pick(rng, category.types),
      vendor: pick(rng, category.vendors),
      price,
      compareAt,
      cost,
      baseUnitsPerDay,
      trueElasticity,
      priceChanges,
    });
  }

  // Every real store has one of each; both are excluded from repricing (R22).
  specs.push({
    handle: 'gift-card',
    title: 'Gift Card',
    variantTitle: '$50',
    productType: 'Gift Cards',
    vendor: category.vendors[0] as string,
    price: '50.00',
    compareAt: null,
    cost: null,
    baseUnitsPerDay: preset.size === 'large' ? 4 : preset.size === 'medium' ? 1.2 : 0.4,
    trueElasticity: -0.2,
    priceChanges: [],
    isGiftCard: true,
  });
  if (category.subscription) {
    specs.push({
      handle: 'subscription',
      title: `${pick(rng, category.adjectives)} ${pick(rng, category.nouns)} Subscription`,
      variantTitle: 'Monthly',
      productType: category.types[0] as string,
      vendor: category.vendors[0] as string,
      price: (Math.round(between(rng, category.price[0], category.price[0] * 2.5))).toFixed(2),
      compareAt: null,
      cost: null,
      baseUnitsPerDay: preset.size === 'large' ? 6 : preset.size === 'medium' ? 2 : 0.8,
      trueElasticity: -0.7,
      priceChanges: [],
      hasSellingPlan: true,
    });
  }

  return specs;
}

/** Variant gids per preset live in their own range so no store collides with the demo's. */
export function presetGidBase(preset: StorePreset): number {
  const index = STORE_PRESETS.findIndex((candidate) => candidate.id === preset.id);
  return 47_000_000_000 + Math.max(0, index) * 1_000_000;
}

export interface PortfolioStoreOptions {
  /** Last day of history. Defaults to the generator's "yesterday". */
  endDay?: string;
  now?: Date;
  historyDays?: number;
}

/** The generated store for a preset: same generator, same demand model, different catalog. */
export function generatePortfolioStore(preset: StorePreset, options: PortfolioStoreOptions = {}): DemoStore {
  const store = generateDemoStore({
    seed: preset.seed,
    catalog: buildCatalog(preset),
    shopDomain: preset.domain,
    shopName: `${preset.name} (simulated)`,
    endDay: options.endDay,
    now: options.now,
    historyDays: options.historyDays,
  });
  // Re-key the gids away from the demo store's range.
  const base = presetGidBase(preset);
  const remap = new Map<string, { product: string; variant: string; inventory: string }>();
  store.products.forEach((product, index) => {
    remap.set(product.variant_gid, {
      product: toGid('Product', base + index * 3),
      variant: toGid('ProductVariant', base + index * 3 + 1),
      inventory: toGid('InventoryItem', base + index * 3 + 2),
    });
  });
  const variantOf = (gid: string): string => remap.get(gid)?.variant ?? gid;
  const productOf = (gid: string): string => remap.get(gid)?.product ?? gid;
  for (const product of store.products) {
    const ids = remap.get(product.variant_gid);
    if (!ids) continue;
    product.product_gid = ids.product;
    product.variant_gid = ids.variant;
    product.inventory_item_gid = ids.inventory;
  }
  for (const row of store.orderDays) {
    row.product_gid = productOf(row.product_gid ?? '');
    row.variant_gid = variantOf(row.variant_gid);
  }
  for (const row of store.priceHistory) {
    row.product_gid = productOf(row.product_gid);
    row.variant_gid = variantOf(row.variant_gid);
  }
  for (const row of store.truth) row.variant_gid = variantOf(row.variant_gid);
  return store;
}

/** Rough daily order volume, for the store picker. */
export function estimatedUnitsPerDay(store: DemoStore): number {
  const days = Math.max(1, store.window.days);
  return store.orderDays.reduce((sum, row) => sum + row.units, 0) / days;
}
