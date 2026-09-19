# Priceflag, explained to its founders

Written 2026-09-18 for Kabir. Plain language first, the real mechanism second, sources at the end. Part 1 is the problem and the solution. Parts 2 onward (the math, the code, Shopify, the two repos, pricing, market) follow in later sections of this file.

---

## Part 1 — Problem and solution

### What we are, in one breath

Priceflag is software a store installs that lets the owner change the price of some products **safely**: it predicts what the change will do before it goes live, puts the new price on a few products first instead of all of them, watches real orders every day against that prediction, pauses and emails the owner if sales fall off, and can put every price back with one click. It also keeps a log of every price change, which Shopify itself does not do.

The one-line pitch on the site: **"Change prices like you have a data team."** The one-line differentiator: **every customer sees the same price.** We never test by showing different shoppers different prices.

### The problem, concretely

A store owner with 40 to 400 products changes prices a few at a time. A supplier raised costs, a competitor moved, a product is not selling, or they simply have not touched prices in two years. When they do it, this is what they have:

- **No forecast.** They do not know whether a 10% increase on six products will make them more money or less. They guess.
- **No small-scale try.** They change the price on all six, or on none.
- **No watching.** They look at orders for a couple of days, feel nervous or forget, and never learn what happened.
- **No undo.** Putting it back means finding the old prices by memory.
- **No history.** Shopify stores the current price only. Once you change it, the old one is gone. Ask a merchant "what was this priced at in March?" and they cannot answer.

So most merchants leave prices alone for years and quietly lose margin as costs rise. That is the real problem: **not that people change prices badly, but that they are afraid to change them at all.**

### Do store owners actually care?

Yes, and there is evidence beyond our own opinion:

- Shopify's own blog runs guides on "how to increase prices without losing customers" and "price elasticity testing," which only exist because merchants ask. Their advice is exactly our product done by hand: raise 5–7%, watch volume for 2–4 weeks. ([Shopify: increase prices](https://www.shopify.com/blog/how-to-increase-prices), [Shopify: elasticity testing](https://www.shopify.com/blog/price-elasticity-testing))
- The fear is real and specific: "after working hard to build a loyal customer base, the last thing merchants want is to upset or lose them." That fear is why prices go untouched. ([Icestore Group on Shopify price increases](https://icestoregroup.com/blogs/our-blog/increase-shopify-prices-strategy))
- The money is real: McKinsey's classic finding is that a 1% price improvement lifts operating profit by roughly 8–11% at constant volume. Price is the strongest lever a business has. ([Forbes on the McKinsey study](https://www.forbes.com/2010/03/25/profit-gain-value-mckinsey-sears-whirlpool-cmo-network-rafi-mohammed.html))
- Strong DTC brands typically lose only 4–9% of volume on a 15% price increase while gaining 3–6 points of margin. Most merchants never find out because they never try. ([Eightx DTC price-increase playbook](https://eightx.co/blog/price-increase-playbook-dtc))
- A whole app category exists for this on the Shopify App Store ("pricing optimization"), and Shopify built its own app for it in 2025–26. Companies do not build categories nobody wants.

What merchants do **not** say is "I need price elasticity estimation." They say "I want to raise prices but I'm scared it'll kill sales." Our job is to answer that sentence.

### Who else is in this space, and what they do

| Who | What they do | Where it falls short |
|---|---|---|
| **Intelligems** (the leader in Shopify price testing) | A/B tests prices: different visitors see different prices, measured as profit per visitor. Priced by order volume, roughly $79 to $1,279/month. | Two people can see two prices for the same product on the same day. That breaks Google Shopping feeds, gets screenshotted, and makes merchants uncomfortable. It needs weeks of traffic, so small stores cannot use it. ([Intelligems](https://www.intelligems.io/pricing-product), [pricing breakdown](https://eevy.ai/blog/intelligems-pricing)) |
| **Shopify Smart Pricing** (Shopify's own app) | Machine-learning "price tips": a suggested markup or markdown per product, refreshed weekly, based on sales and inventory. Merchant applies it by hand. | A number with nothing around it. No staged rollout, no monitoring against an expectation, no undo, no journal. And it now also offers A/B experiments, so it inherits the same two-prices problem. ([Shopify help](https://help.shopify.com/en/manual/products/details/product-pricing/smart-pricing/overview)) |
| **Prisync, Pricefy, and other "dynamic pricing" apps** | Watch competitors' prices and auto-adjust yours by rules. From about $99/month. | Solves a different problem: matching the market. They do not predict what a change does to *your* profit, and they change prices constantly, which is the opposite of a careful, reversible change. ([Prisync on the App Store](https://apps.shopify.com/prisync-ai-dynamic-pricing)) |
| **A spreadsheet and nerve** | What almost everyone actually uses. | Everything above. |

### What we do differently

1. **We stage by product and time, never by visitor.** New price on 25% of the chosen products for a few days, then 50%, then all. Every shopper sees the same price the whole time. The evidence comes from *which products* changed and *when*, not from splitting people. This is the thing that makes merchants willing to let software near their prices.
2. **We forecast before anything happens, and we show a range, not a number.** "Expect −11% units, somewhere between −18% and −4%, and here is the break-even: you can lose up to 14% of orders and still make the same profit." We also label how confident we are (fitted / partial / assumption). A single number that is quietly wrong is the one thing this product must never produce.
3. **We watch, and we have a written rule for stopping.** Every day, real orders are compared with the expected range. The merchant writes the rule in plain words before launch ("if daily units fall more than 35% below expected for 2 days in a row, pause and email me"). During the beta a tripped rule pauses and alerts; it never reverts automatically.
4. **Everything is reversible and everything is logged.** Every price write records the price it replaced. One click restores every product and re-reads Shopify to prove it. The journal is the only price history the merchant has, and it grows with every rollout, which is also our moat: each staged change adds clean price data the store never had, so the next forecast is better.

### About the "+11%" on the website

The homepage has an animated comparison where "Priceflag" ends 11% above "never changing price" and a spreadsheet ends +2.6%. Those numbers are **hard-coded constants** in `sections/pf-compare.js` (`LIFT_PF = 0.11`). They are an illustration, not a measurement. Do not quote them to anyone as a result. If someone asks, the honest answer is: "That's a sketch of the shape; our measured numbers are from simulated stores and live in the deck."

### The numbers we can honestly quote today

From 150 full rollouts run through the real engine on six simulated stores whose true price sensitivity is known and hidden from the model (`docs/SIMULATION_RESULTS.md`):

- 93% of healthy rollouts landed inside the forecast range.
- 100% of prices restored and verified after undo.
- 0% false alarms on medium and large stores; 7% overall (small stores are noisier).
- Demand shocks caught 82% of the time, median day 6.

Say "simulated" every time. We have no merchant results yet. Getting the first merchants is the whole job right now.

---

*Part 2 (how the prediction actually works, the math, and what "elasticity" means) continues below when written.*
