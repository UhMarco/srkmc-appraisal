/* Splitrock Mining Co. — Ore Appraisal Terminal
   Pricing: for each ore we take the mid-price = (highest buy + lowest sell) / 2 in
   The Forge, for both the raw and the compressed type. In the current compression
   system 1 compressed unit == 1 raw unit, so the two mids are compared directly and
   the LOWER one is the per-unit value. Line value = per-unit value x quantity.
   Market data: Fuzzwork aggregates (CORS-enabled, sourced from ESI). */

(function () {
  "use strict";

  const REGION_THE_FORGE = 10000002;
  const JITA_4_4_STATION = 60003760;
  const FUZZWORK = "https://market.fuzzwork.co.uk/aggregates/";

  // alert threshold (see buildAlerts) — easy to tune
  const ALERT_NONJITA_RATIO = 1.05;  // best regional buy >= this x the Jita 4-4 buy

  // ---- lookups ------------------------------------------------------------
  const byName = new Map();     // lowercased name -> ore; both "x" and "compressed x" map here
  for (const o of ORES) {
    byName.set(o.name.toLowerCase(), o);
    byName.set(("compressed " + o.name).toLowerCase(), o);
  }

  // ---- state --------------------------------------------------------------
  // haul: Map rawTypeId -> { ore, qty }   (qty always in RAW units)
  const haul = new Map();
  let lastAppraisal = null; // { rows:[...], totalIsk, at:Date }
  let buybackPct = 100;     // buyback rate the client pays, % of appraised value
  let buybackRate = 1;      // buybackPct / 100
  let sortKey = null;       // null | 'name' | 'qty' | 'value'
  let sortDir = 1;          // 1 = ascending, -1 = descending

  // ---- elements -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    oreInput: $("ore-input"), qtyInput: $("qty-input"), addForm: $("add-form"),
    acMenu: $("ac-menu"),
    pasteInput: $("paste-input"), pasteImport: $("paste-import"), pasteStatus: $("paste-status"),
    table: $("haul-table"), body: $("haul-body"), empty: $("empty-state"),
    count: $("manifest-count"),
    appraiseBtn: $("appraise-btn"), clearBtn: $("clear-btn"),
    buybackRange: $("buyback-range"), buybackVal: $("buyback-val"), totalLabel: $("total-label"),
    totals: $("totals"), totalIsk: $("total-isk"),
    resultActions: $("result-actions"), copyBtn: $("copy-btn"),
    actionStatus: $("action-status"), pricedAt: $("priced-at"),
    toast: $("toast"), alertTip: $("alert-tip"),
  };

  // ---- formatting ---------------------------------------------------------
  const fmtIsk = (n) =>
    n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtIntIsk = (n) =>
    n == null ? "—" : Math.round(n).toLocaleString("en-US");
  const fmtQty = (n) => n.toLocaleString("en-US");

  // parse a quantity string: strips spaces, commas, and NBSP thousands separators
  function parseQty(str) {
    if (str == null) return NaN;
    const cleaned = String(str).replace(/[\s,  .]/g, (m) => (m === "." ? "." : ""));
    // remove all grouping separators incl thousands "." used by some locales; keep digits only
    const digits = cleaned.replace(/[^0-9]/g, "");
    return digits === "" ? NaN : parseInt(digits, 10);
  }

  // ---- search / matching --------------------------------------------------
  // Grade shorthand: "iii" or "3" both resolve to the III-Grade token, etc. There is
  // no I-Grade in EVE (base ore is unsuffixed), so "1"/"i" are intentionally unmapped.
  const GRADE = { "0": "g0", "ii": "g2", "2": "g2", "iii": "g3", "3": "g3",
                  "iv": "g4", "4": "g4", "x": "gx", "10": "gx" };

  // turn a name or query into canonical tokens, e.g. "Veldspar III-Grade" -> ["veldspar","g3"]
  function tokenize(str) {
    return str
      .toLowerCase()
      .replace(/grade/g, " ")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((t) => GRADE[t] || t);
  }

  // precompute tokens once
  for (const o of ORES) o._tok = tokenize(o.name);

  // every query token must prefix-match some ore token
  function matchesTokens(qTokens, oTokens) {
    return qTokens.every((q) => oTokens.some((t) => t.startsWith(q)));
  }

  const CAT_ORDER = { asteroid: 0, moon: 1, ice: 2 };

  // ranked list of ores matching the typed value
  function searchOres(value, limit) {
    const qTokens = tokenize(value);
    if (!qTokens.length) return [];
    const out = [];
    for (const o of ORES) {
      if (matchesTokens(qTokens, o._tok)) out.push(o);
    }
    out.sort((a, b) =>
      a._tok.length - b._tok.length ||
      CAT_ORDER[a.cat] - CAT_ORDER[b.cat] ||
      a.name.localeCompare(b.name));
    return limit ? out.slice(0, limit) : out;
  }

  // resolve a typed value to a single ore (exact name wins, else best match)
  function resolveOreInput(value) {
    const v = value.trim().toLowerCase();
    if (!v) return null;
    if (byName.has(v)) return byName.get(v);
    const m = searchOres(value, 1);
    return m.length ? m[0] : null;
  }

  // ---- haul mutation ------------------------------------------------------
  // form: 'raw' or 'comp' — the variant the line was entered as (used by per-line pricing)
  function addToHaul(ore, qty, form) {
    if (!ore || !(qty > 0)) return false;
    const cur = haul.get(ore.raw);
    if (cur) cur.qty += qty;                       // merge by ore; keep the first form seen
    else haul.set(ore.raw, { ore, qty, form: form || "raw" });
    return true;
  }
  function setQty(rawId, qty) {
    const cur = haul.get(rawId);
    if (!cur) return;
    if (qty > 0) cur.qty = qty;
    else haul.delete(rawId);
  }
  function removeFromHaul(rawId) { haul.delete(rawId); }

  // ---- rendering ----------------------------------------------------------
  function render() {
    els.body.innerHTML = "";
    const has = haul.size > 0;
    els.empty.classList.toggle("hidden", has);
    els.appraiseBtn.disabled = !has;
    els.clearBtn.disabled = !has;
    els.count.textContent = haul.size + (haul.size === 1 ? " LINE" : " LINES");

    const appr = lastAppraisal ? new Map(lastAppraisal.rows.map((r) => [r.rawId, r])) : null;

    for (const { ore, qty } of sortedHaul(appr)) {
      const tr = document.createElement("tr");
      const r = appr ? appr.get(ore.raw) : null;

      // ore name (+ alert flag if the appraisal found a notable off-book buy order)
      const tdName = document.createElement("td");
      tdName.className = "c-ore";
      tdName.innerHTML =
        `<span class="ore-name">${ore.name}</span><span class="ore-cat">${ore.cat}</span>`;
      if (r && r.alerts && r.alerts.length) tdName.appendChild(makeAlertFlag(r.alerts));
      tr.appendChild(tdName);

      // qty (editable)
      const tdQty = document.createElement("td");
      tdQty.className = "num";
      const qi = document.createElement("input");
      qi.className = "qty-edit"; qi.type = "text"; qi.value = fmtQty(qty);
      qi.addEventListener("change", () => {
        const v = parseQty(qi.value);
        if (Number.isFinite(v)) { setQty(ore.raw, v); refreshAfterEdit(); }
        else qi.value = fmtQty(qty);
      });
      tdQty.appendChild(qi);
      tr.appendChild(tdQty);

      // appraisal columns
      const tdUn = document.createElement("td"); tdUn.className = "num col-appr";
      const tdCo = document.createElement("td"); tdCo.className = "num col-appr";
      const tdBa = document.createElement("td"); tdBa.className = "c-basis col-appr";
      const tdVa = document.createElement("td"); tdVa.className = "num col-appr val-cell";

      if (r) {
        if (r.unavailable) {
          tr.classList.add("row-unavailable");
          tdUn.innerHTML = '<span class="cell-dim">—</span>';
          tdCo.innerHTML = '<span class="cell-dim">—</span>';
          tdBa.innerHTML = '<span class="note-unavail">no market</span>';
          tdVa.textContent = "—";
        } else {
          tdUn.innerHTML = r.rawMid != null ? fmtIsk(r.rawMid) : '<span class="cell-dim">—</span>';
          tdCo.innerHTML = r.compMid != null ? fmtIsk(r.compMid) : '<span class="cell-dim">—</span>';
          const cls = r.basis === "compressed" ? "comp" : "uncomp";
          tdBa.innerHTML = `<span class="basis-pill ${cls}">${r.basis}</span>`;
          tdVa.textContent = fmtIntIsk(r.lineValue);
        }
      }
      tr.appendChild(tdUn); tr.appendChild(tdCo); tr.appendChild(tdBa); tr.appendChild(tdVa);

      // remove
      const tdAct = document.createElement("td");
      tdAct.className = "c-act";
      const rm = document.createElement("button");
      rm.className = "row-remove"; rm.textContent = "✕"; rm.title = "Remove";
      rm.addEventListener("click", () => removeRow(ore.raw));
      tdAct.appendChild(rm);
      tr.appendChild(tdAct);

      els.body.appendChild(tr);
    }

    els.table.classList.toggle("appraised", !!appr);
    updateSortIndicators();
  }

  // ordered copy of the haul for display, per the active sort
  function sortedHaul(appr) {
    const entries = [...haul.values()];
    if (!sortKey) return entries;
    const keyOf = (e) => {
      if (sortKey === "name") return e.ore.name;
      if (sortKey === "qty") return e.qty;
      const r = appr ? appr.get(e.ore.raw) : null;        // value
      return r && !r.unavailable ? r.lineValue : -Infinity;
    };
    return entries.sort((a, b) => {
      const va = keyOf(a), vb = keyOf(b);
      const cmp = sortKey === "name" ? va.localeCompare(vb) : va - vb;
      return cmp * sortDir;
    });
  }

  function removeRow(rawId) { removeFromHaul(rawId); refreshAfterEdit(); }

  // After a row is removed or a quantity edited, re-price from the stored market snapshot
  // (no re-fetch) so the user never has to press Appraise again for those edits.
  function refreshAfterEdit() {
    if (lastAppraisal && haul.size > 0) {
      computeRows(); render(); renderTotals();
    } else {
      lastAppraisal = null;
      render();
      els.totals.classList.add("hidden");
      els.resultActions.classList.add("hidden");
    }
  }

  // ---- sorting ------------------------------------------------------------
  const sortableThs = Array.from(document.querySelectorAll("#haul-table th[data-sort]"));

  function onSortClick(key) {
    if (sortKey === key) sortDir = -sortDir;
    else { sortKey = key; sortDir = key === "name" ? 1 : -1; } // names A→Z, numbers high→low
    render();
  }
  function updateSortIndicators() {
    for (const th of sortableThs) {
      const active = th.dataset.sort === sortKey;
      th.classList.toggle("sorted", active);
      const ind = th.querySelector(".sort-ind");
      if (ind) ind.textContent = active ? (sortDir > 0 ? " ▲" : " ▼") : "";
    }
  }

  function afterChange() {
    render();
    if (!lastAppraisal) {
      els.totals.classList.add("hidden");
      els.resultActions.classList.add("hidden");
    }
  }

  // The grid keeps gross appraised values; the buyback only adjusts the headline total.
  // Below 100% the yellow number is the net payout and the label above it shows the
  // pre-buyback value and how much is being subtracted.
  function renderTotals() {
    if (!lastAppraisal) return;
    const gross = lastAppraisal.totalIsk;
    const net = gross * buybackRate;
    els.totalIsk.textContent = fmtIntIsk(net) + " ISK";
    els.totalLabel.innerHTML = buybackPct < 100
      ? `BEFORE BUYBACK ${fmtIntIsk(gross)} ISK`
      : "APPRAISED VALUE";
  }

  // ---- alert flag + tooltip ----------------------------------------------
  function makeAlertFlag(messages) {
    const flag = document.createElement("span");
    flag.className = "alert-flag";
    flag.textContent = "!";
    flag.tabIndex = 0;
    flag.setAttribute("role", "button");
    flag.setAttribute("aria-label", messages.join("  •  "));
    flag.addEventListener("mouseenter", () => showTip(flag, messages));
    flag.addEventListener("mouseleave", hideTip);
    flag.addEventListener("focus", () => showTip(flag, messages));
    flag.addEventListener("blur", hideTip);
    return flag;
  }
  function showTip(anchor, messages) {
    els.alertTip.innerHTML = messages.map((m) => `<div class="tip-line">${m}</div>`).join("");
    els.alertTip.classList.remove("hidden");
    const a = anchor.getBoundingClientRect();
    const t = els.alertTip.getBoundingClientRect();
    const maxLeft = window.scrollX + document.documentElement.clientWidth - t.width - 8;
    const left = Math.min(Math.max(8, window.scrollX + a.left + a.width / 2 - t.width / 2), maxLeft);
    els.alertTip.style.left = left + "px";
    els.alertTip.style.top = (window.scrollY + a.bottom + 8) + "px";
  }
  function hideTip() { els.alertTip.classList.add("hidden"); }

  async function fetchAggregates(typeIds, scopeParam) {
    const url = `${FUZZWORK}?${scopeParam}&types=${typeIds.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("market request failed (" + res.status + ")");
    return res.json();
  }

  const buyMaxOf = (agg) => {
    const v = agg && agg.buy ? parseFloat(agg.buy.max) : 0;
    return v > 0 ? v : 0;
  };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  // Informational flag (never affects the appraisal): if the best buy order for this ore in
  // The Forge is parked at a station other than Jita 4-4, surface it so the user can decide to
  // sell it there instead.
  function buildAlerts(ore, regData, jitaData) {
    const out = [];
    const forms = [
      { name: "uncompressed", id: ore.raw },
      { name: "compressed", id: ore.comp },
    ];
    forms.sort((a, b) => buyMaxOf(regData[b.id]) - buyMaxOf(regData[a.id]));
    const best = forms[0];
    const bestBuy = buyMaxOf(regData[best.id]);
    const jitaBuy = buyMaxOf(jitaData[best.id]);
    if (bestBuy > 0 && bestBuy > jitaBuy && bestBuy >= jitaBuy * ALERT_NONJITA_RATIO) {
      out.push(jitaBuy > 0
        ? `Top ${best.name} buy is off-Jita: ${fmtIsk(bestBuy)} vs ${fmtIsk(jitaBuy)} at Jita 4-4.`
        : `${cap(best.name)} buy ${fmtIsk(bestBuy)} ISK/u in region — none at Jita 4-4.`);
    }
    return out;
  }

  // ---- pricing ------------------------------------------------------------
  // Instant Jita sell: value each line at the highest Jita 4-4 buy order for the form it is
  // actually in (raw line -> raw buy, compressed line -> compressed buy). pUn/pCo are the two
  // per-form buy prices shown in the grid; falls back to the other form only if the held form
  // has no buy order at all.
  const METHOD_LABEL = "instant Jita sell — Jita 4-4 buy order for the form held";
  const orNull = (n) => (n > 0 ? n : null);

  function priceOre(ore, form, jita) {
    const pUn = orNull(buyMaxOf(jita[ore.raw]));
    const pCo = orNull(buyMaxOf(jita[ore.comp]));
    let unit = null, basis = null;
    const setU = () => { unit = pUn; basis = "uncompressed"; };
    const setC = () => { unit = pCo; basis = "compressed"; };
    if (form === "comp") { if (pCo != null) setC(); else if (pUn != null) setU(); }
    else { if (pUn != null) setU(); else if (pCo != null) setC(); }
    return { pUn, pCo, unit, basis, unavailable: unit == null };
  }

  // Rebuild priced rows from the stored market snapshot for the current haul/method/forms.
  // No network — runs after appraise and on every method, quantity or remove change.
  function computeRows() {
    if (!lastAppraisal) return;
    const { data, jita } = lastAppraisal;
    const rows = [];
    let totalIsk = 0;
    for (const { ore, qty, form } of haul.values()) {
      if (!data[ore.raw] && !data[ore.comp]) continue;   // added after snapshot: leave unpriced
      const p = priceOre(ore, form, jita);
      const lineValue = p.unavailable ? 0 : p.unit * qty;
      if (!p.unavailable) totalIsk += lineValue;
      const alerts = p.unavailable ? [] : buildAlerts(ore, data, jita);
      rows.push({
        rawId: ore.raw, name: ore.name, qty, form,
        rawMid: p.pUn, compMid: p.pCo, basis: p.basis,
        unit: p.unit, lineValue, unavailable: p.unavailable, alerts,
      });
    }
    lastAppraisal.rows = rows;
    lastAppraisal.totalIsk = totalIsk;
  }

  async function appraise() {
    if (haul.size === 0) return;
    setBtnLoading(els.appraiseBtn, true);
    els.actionStatus.textContent = "";
    try {
      // unique set of every raw + compressed type in the haul
      const ids = new Set();
      for (const { ore } of haul.values()) { ids.add(ore.raw); ids.add(ore.comp); }
      const idList = [...ids];
      // region drives the appraisal; Jita 4-4 is fetched alongside for the alerts
      const [data, jita] = await Promise.all([
        fetchAggregates(idList, `region=${REGION_THE_FORGE}`),
        fetchAggregates(idList, `station=${JITA_4_4_STATION}`),
      ]);

      lastAppraisal = { data, jita, rows: [], totalIsk: 0, at: new Date() };
      computeRows();
      render();
      renderTotals();
      els.totals.classList.remove("hidden");
      els.resultActions.classList.remove("hidden");
      els.pricedAt.textContent = "PRICED " + lastAppraisal.at.toLocaleString();
    } catch (err) {
      toast("Appraisal failed: " + err.message);
    } finally {
      setBtnLoading(els.appraiseBtn, false);
    }
  }

  // ---- paste import -------------------------------------------------------
  // Handles both the in-game inventory copy ("Name<tab>Qty<tab>Group<tab>...") and the
  // contract-contents copy ("Name<tab>Qty<tab>Type<tab>Category"). The name is the first
  // column; the quantity is the first numeric column after it; trailing columns are ignored.
  function parsePasteLine(line) {
    const cols = line.split(/\t+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (cols.length >= 2) {
      for (let i = 1; i < cols.length; i++) {
        if (/^[\d.,\s]+$/.test(cols[i])) {
          const q = parseQty(cols[i]);
          if (Number.isFinite(q) && q > 0) return { name: cols[0], qty: q };
        }
      }
    }
    // fallback: single-space "Name 1234" (hand-typed, no tabs/columns)
    const m = line.match(/^(.+?)\s+([\d.,]+)$/);
    if (m) {
      const q = parseQty(m[2]);
      if (Number.isFinite(q) && q > 0) return { name: m[1].trim(), qty: q };
    }
    return null;
  }

  function importPaste() {
    const text = els.pasteInput.value;
    if (!text.trim()) { els.pasteStatus.textContent = "nothing to import"; return; }
    const lines = text.split(/\r?\n/);
    let added = 0, merged = 0;
    const unmatched = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const parsed = parsePasteLine(line);
      const ore = parsed ? byName.get(parsed.name.toLowerCase()) : null;
      if (!ore) { unmatched.push(line); continue; }

      const isComp = /^\s*compressed\b/i.test(parsed.name);
      const existed = haul.has(ore.raw);
      addToHaul(ore, parsed.qty, isComp ? "comp" : "raw");
      if (existed) merged++; else added++;
    }

    lastAppraisal = null;
    afterChange();

    const bits = [];
    if (added) bits.push(added + " added");
    if (merged) bits.push(merged + " merged");
    if (unmatched.length) bits.push(unmatched.length + " unrecognised");
    els.pasteStatus.textContent = bits.length ? bits.join(" · ") : "no ore recognised";
    if (added || merged) els.pasteInput.value = "";
  }

  // ---- copy appraisal text ------------------------------------------------
  function buildAppraisalText() {
    if (!lastAppraisal) return "";
    const L = [];
    L.push("SPLITROCK MINING CO. — ORE APPRAISAL");
    L.push("Market: The Forge · " + lastAppraisal.at.toLocaleString());
    L.push("Method: " + METHOD_LABEL);
    L.push("".padEnd(44, "-"));
    for (const r of lastAppraisal.rows) {
      const name = r.name.padEnd(26).slice(0, 26);
      if (r.unavailable) { L.push(name + "  " + fmtQty(r.qty).padStart(12) + "   (no market)"); continue; }
      const flag = r.alerts && r.alerts.length ? "  (!)" : "";
      L.push(name + "  " + fmtQty(r.qty).padStart(12) + "   " +
        fmtIntIsk(r.lineValue).padStart(16) + " ISK  [" + r.basis.slice(0, 6) + "]" + flag);
    }
    L.push("".padEnd(44, "-"));
    const gross = lastAppraisal.totalIsk;
    if (buybackPct < 100) {
      L.push("APPRAISED   : " + fmtIntIsk(gross) + " ISK");
      L.push("BUYBACK " + (buybackPct + "%").padEnd(4) + ": -" + fmtIntIsk(gross - gross * buybackRate) + " ISK");
      L.push("PAYOUT      : " + fmtIntIsk(gross * buybackRate) + " ISK");
    } else {
      L.push("TOTAL VALUE : " + fmtIntIsk(gross) + " ISK");
    }
    return L.join("\n");
  }

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch (e) {
      // fallback
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast(okMsg); }
      catch (_) { toast("Copy failed — select manually"); }
      document.body.removeChild(ta);
    }
  }

  // ---- ui helpers ---------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 2600);
  }
  function setBtnLoading(btn, on) {
    btn.classList.toggle("btn-loading", on);
    btn.disabled = on;
  }

  // ---- autocomplete -------------------------------------------------------
  const ac = { matches: [], active: -1, open: false };

  function acRender() {
    if (!ac.matches.length) { acClose(); return; }
    els.acMenu.innerHTML = "";
    ac.matches.forEach((o, i) => {
      const item = document.createElement("div");
      item.className = "ac-item" + (i === ac.active ? " active" : "");
      item.setAttribute("role", "option");
      item.innerHTML = `<span class="ac-name">${o.name}</span><span class="ac-cat">${o.cat}</span>`;
      item.addEventListener("mousedown", (e) => { e.preventDefault(); acChoose(o); });
      els.acMenu.appendChild(item);
    });
    els.acMenu.classList.remove("hidden");
    ac.open = true;
  }
  function acClose() { els.acMenu.classList.add("hidden"); ac.open = false; ac.active = -1; }
  function acUpdate() {
    ac.matches = searchOres(els.oreInput.value, 8);
    ac.active = ac.matches.length ? 0 : -1;
    acRender();
  }
  function acChoose(o) {
    els.oreInput.value = o.name;
    acClose();
    els.qtyInput.focus();
    els.qtyInput.select();
  }
  function acMove(d) {
    if (!ac.matches.length) return;
    ac.active = (ac.active + d + ac.matches.length) % ac.matches.length;
    acRender();
  }

  els.oreInput.addEventListener("input", acUpdate);
  els.oreInput.addEventListener("focus", () => { if (els.oreInput.value.trim()) acUpdate(); });
  els.oreInput.addEventListener("blur", () => setTimeout(acClose, 120));
  els.oreInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); ac.open ? acMove(1) : acUpdate(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acMove(-1); }
    else if (e.key === "Enter" && ac.open && ac.active >= 0) { e.preventDefault(); acChoose(ac.matches[ac.active]); }
    else if (e.key === "Escape") { acClose(); }
  });

  // ---- events -------------------------------------------------------------
  els.addForm.addEventListener("submit", (e) => {
    e.preventDefault();
    acClose();
    const ore = resolveOreInput(els.oreInput.value);
    if (!ore) { toast("Unknown ore — pick one from the list"); els.oreInput.focus(); return; }
    const qty = parseQty(els.qtyInput.value);
    if (!Number.isFinite(qty) || qty <= 0) { toast("Enter a quantity"); els.qtyInput.focus(); return; }
    const isComp = /^\s*compressed\b/i.test(els.oreInput.value);
    addToHaul(ore, qty, isComp ? "comp" : "raw");
    lastAppraisal = null;
    afterChange();
    els.oreInput.value = ""; els.qtyInput.value = ""; els.oreInput.focus();
  });

  els.buybackRange.addEventListener("input", () => {
    buybackPct = parseInt(els.buybackRange.value, 10);
    buybackRate = buybackPct / 100;
    els.buybackVal.textContent = buybackPct + "%";
    if (lastAppraisal) renderTotals();
  });

  els.pasteImport.addEventListener("click", importPaste);
  els.appraiseBtn.addEventListener("click", appraise);
  els.clearBtn.addEventListener("click", () => {
    haul.clear(); lastAppraisal = null; afterChange();
  });
  els.copyBtn.addEventListener("click", () => {
    const t = buildAppraisalText();
    if (t) copyText(t, "Appraisal text copied");
  });

  // ---- init ---------------------------------------------------------------
  sortableThs.forEach((th) => th.addEventListener("click", () => onSortClick(th.dataset.sort)));
  render();
  els.oreInput.focus();
})();
