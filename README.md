# Splitrock Mining Co. — Ore Appraisal Terminal

A static, single-page ore appraisal tool for **Splitrock Mining Company**. Miners build a
haul, hit **Appraise**, and get a value based on **The Forge** market — using the **lower of
the compressed vs. uncompressed** mid-price for every ore.

## How the price is calculated

For each ore in the haul:

1. Look up the **highest buy order** and **lowest sell order** in The Forge (region `10000002`)
   for both the raw type *and* its compressed type.
2. `mid = (highest buy + lowest sell) / 2` for each.
3. In the current (Equinox) compression system **1 compressed unit == 1 raw unit** — compression
   only shrinks volume, not unit count or reprocessing yield — so the raw and compressed mids are
   compared **directly**.
4. The **lower** of the two is the per-unit value. `line value = per-unit value × quantity`.

If only one side of the book exists (e.g. no buy orders), that side is used as the mid. If a
type has no market at all it is flagged `no market` and contributes 0.

## Data source

The browser cannot read EVE Tycoon's API directly — it doesn't send CORS headers, so a page on
GitHub Pages is blocked from reading the response. We use the **Fuzzwork aggregates** endpoint
instead, which is CORS-enabled and returns the same ESI-sourced order-book data in a single
batched request:

```
https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=<id1>,<id2>,...
```

`buy.max` = highest buy, `sell.min` = lowest sell — exactly the figures the manual process used.

## Files

| File         | Purpose                                                            |
|--------------|-------------------------------------------------------------------|
| `index.html` | Page structure                                                    |
| `styles.css` | Industrial theme (gunmetal + hazard yellow)                       |
| `app.js`     | Haul state, autocomplete, paste import, pricing                   |
| `ores.js`    | 187 ore→compressed type mappings (asteroid/moon/ice)              |
| `favicon.svg`| Corp emblem                                                       |

## Searching for ore

The **ORE TYPE** box has a type-ahead dropdown. Grade shorthand is accepted, so any of
`Scordite III-Grade`, `Scordite iii`, or `Scordite 3` resolve to the same ore. Use the arrow
keys + Enter (or click) to pick a suggestion, then enter a quantity.

## Output

**Copy Appraisal Text** produces a plain-text summary (per-line values, basis used, totals) for
pasting into EVE chat or a contract description.

> Pastebin-style short links for sharing an appraisal would need a storage backend and are not
> implemented.

## Deploy to GitHub Pages

1. Push these files to a repo (e.g. `srkmc-appraisal`).
2. **Settings → Pages → Build and deployment → Source: Deploy from a branch**, pick `main` / `root`.
3. Site goes live at `https://<user>.github.io/srkmc-appraisal/`.

No build step — it's plain HTML/CSS/JS.

## Regenerating the ore list

`ores.js` is generated from EVE Tycoon's market groups (pairing each ore with its `Compressed X`
sibling, excluding the deprecated `Batch Compressed` types). Re-run the generation if CCP adds new ores.

---

Unofficial tool. Not affiliated with CCP Games. EVE Online is a trademark of CCP hf.
