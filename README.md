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

## Buyback rate

The **BUYBACK** slider (50–100%, default 100%) sets the percentage of appraised value the buyer
actually pays. It rescales every line value, the total, and the copied appraisal text live — no
re-fetch needed — and the total is annotated `@ N% BUYBACK` when below 100%. Volume is unaffected.

## Alerts (`!`)

After an appraisal, a `!` flag appears next to any ore where a buy order beats the conservative
appraised value. Hovering it shows why. Two cases, **purely informational — they never change the
appraisal**:

1. **Form divergence** — a buy order for the *other* form (e.g. uncompressed when the appraisal
   used compressed) is paying ≥ 1.25× the appraised value. Common when uncompressed temporarily
   trades well above compressed; you may prefer to sell that form yourself.
2. **Non-Jita order** — the best buy order in The Forge is ≥ 1.05× the Jita 4-4 price, i.e. the
   top order is parked at another station/system in the region rather than Jita.

Thresholds are the `ALERT_FORM_RATIO` / `ALERT_NONJITA_RATIO` constants at the top of `app.js`.

## Data source

The browser cannot read EVE Tycoon's API directly — it doesn't send CORS headers, so a page on
GitHub Pages is blocked from reading the response. We use the **Fuzzwork aggregates** endpoint
instead, which is CORS-enabled and returns the same ESI-sourced order-book data in a single
batched request:

```
https://market.fuzzwork.co.uk/aggregates/?region=10000002&types=<id1>,<id2>,...
```

`buy.max` = highest buy, `sell.min` = lowest sell — exactly the figures the manual process used.
Each appraisal makes two batched calls in parallel: `region=10000002` (drives the appraisal) and
`station=60003760` (Jita 4-4, used only for the non-Jita alert).

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

## Sorting

Click the **ORE**, **QTY**, or **VALUE** column headers to sort the manifest (alphabetical,
quantity, or appraised value). Click again to reverse; an arrow marks the active column. Sorting
by value is available once the haul has been appraised. Removing a line after an appraisal updates
the total in place — no need to re-appraise.

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
