/* Splitrock Mining Co. — Ore Appraisal Terminal
   Pricing: for each ore we take the mid-price = (highest buy + lowest sell) / 2 in
   The Forge, for both the raw and the compressed type. In the current compression
   system 1 compressed unit == 1 raw unit, so the two mids are compared directly and
   the LOWER one is the per-unit value. Line value = per-unit value x quantity.
   Market data: Fuzzwork aggregates (CORS-enabled, sourced from ESI). */

(function () {
  "use strict";

  const REGION_THE_FORGE = 10000002;
  const FUZZWORK = "https://market.fuzzwork.co.uk/aggregates/";

  // ---- lookups ------------------------------------------------------------
  const byName = new Map();     // lowercased name -> ore; both "x" and "compressed x" map here
  for (const o of ORES) {
    byName.set(o.name.toLowerCase(), o);
    byName.set(("compressed " + o.name).toLowerCase(), o);
  }

  // ---- state --------------------------------------------------------------
  // haul: Map rawTypeId -> { ore, qty }   (qty always in RAW units)
  const haul = new Map();
  let lastAppraisal = null; // { rows:[...], totalIsk, totalVol, at:Date }

  // ---- elements -----------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const els = {
    oreInput: $("ore-input"), qtyInput: $("qty-input"), addForm: $("add-form"),
    acMenu: $("ac-menu"),
    pasteInput: $("paste-input"), pasteImport: $("paste-import"), pasteStatus: $("paste-status"),
    table: $("haul-table"), body: $("haul-body"), empty: $("empty-state"),
    count: $("manifest-count"),
    appraiseBtn: $("appraise-btn"), clearBtn: $("clear-btn"),
    totals: $("totals"), totalVol: $("total-vol"), totalIsk: $("total-isk"),
    resultActions: $("result-actions"), copyBtn: $("copy-btn"),
    actionStatus: $("action-status"), pricedAt: $("priced-at"),
    toast: $("toast"),
  };

  // ---- formatting ---------------------------------------------------------
  const fmtIsk = (n) =>
    n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const fmtIntIsk = (n) =>
    n == null ? "—" : Math.round(n).toLocaleString("en-US");
  const fmtQty = (n) => n.toLocaleString("en-US");
  const fmtVol = (n) =>
    n.toLocaleString("en-US", { maximumFractionDigits: 1 });

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
  function addToHaul(ore, qty) {
    if (!ore || !(qty > 0)) return false;
    const cur = haul.get(ore.raw);
    if (cur) cur.qty += qty;
    else haul.set(ore.raw, { ore, qty });
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

    for (const { ore, qty } of haul.values()) {
      const tr = document.createElement("tr");
      const r = appr ? appr.get(ore.raw) : null;

      // ore name
      const tdName = document.createElement("td");
      tdName.className = "c-ore";
      tdName.innerHTML =
        `<span class="ore-name">${ore.name}</span><span class="ore-cat">${ore.cat}</span>`;
      tr.appendChild(tdName);

      // qty (editable)
      const tdQty = document.createElement("td");
      tdQty.className = "num";
      const qi = document.createElement("input");
      qi.className = "qty-edit"; qi.type = "text"; qi.value = fmtQty(qty);
      qi.addEventListener("change", () => {
        const v = parseQty(qi.value);
        if (Number.isFinite(v)) { setQty(ore.raw, v); lastAppraisal = null; afterChange(); }
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
      rm.addEventListener("click", () => { removeFromHaul(ore.raw); lastAppraisal = null; afterChange(); });
      tdAct.appendChild(rm);
      tr.appendChild(tdAct);

      els.body.appendChild(tr);
    }

    els.table.classList.toggle("appraised", !!appr);
  }

  function afterChange() {
    render();
    if (!lastAppraisal) {
      els.totals.classList.add("hidden");
      els.resultActions.classList.add("hidden");
    }
  }

  // ---- pricing ------------------------------------------------------------
  // mid = average of highest buy and lowest sell; if only one side exists use it.
  function midFrom(agg) {
    if (!agg) return null;
    const sellMin = parseFloat(agg.sell && agg.sell.min) || 0;
    const buyMax = parseFloat(agg.buy && agg.buy.max) || 0;
    if (sellMin > 0 && buyMax > 0) return (sellMin + buyMax) / 2;
    if (sellMin > 0) return sellMin;
    if (buyMax > 0) return buyMax;
    return null;
  }

  async function fetchAggregates(typeIds) {
    const url = `${FUZZWORK}?region=${REGION_THE_FORGE}&types=${typeIds.join(",")}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("market request failed (" + res.status + ")");
    return res.json();
  }

  async function appraise() {
    if (haul.size === 0) return;
    setBtnLoading(els.appraiseBtn, true);
    els.actionStatus.textContent = "";
    try {
      // unique set of every raw + compressed type in the haul
      const ids = new Set();
      for (const { ore } of haul.values()) { ids.add(ore.raw); ids.add(ore.comp); }
      const data = await fetchAggregates([...ids]);

      const rows = [];
      let totalIsk = 0, totalVol = 0;
      for (const { ore, qty } of haul.values()) {
        const rawMid = midFrom(data[ore.raw]);
        const compMid = midFrom(data[ore.comp]);

        let basis = null, unit = null;
        if (rawMid != null && compMid != null) {
          if (compMid <= rawMid) { basis = "compressed"; unit = compMid; }
          else { basis = "uncompressed"; unit = rawMid; }
        } else if (rawMid != null) { basis = "uncompressed"; unit = rawMid; }
        else if (compMid != null) { basis = "compressed"; unit = compMid; }

        const unavailable = unit == null;
        const lineValue = unavailable ? 0 : unit * qty;
        const vol = qty * (ore.vol || 0);
        if (!unavailable) totalIsk += lineValue;
        totalVol += vol;

        rows.push({
          rawId: ore.raw, name: ore.name, qty, rawMid, compMid,
          basis, unit, lineValue, unavailable, vol,
        });
      }

      lastAppraisal = { rows, totalIsk, totalVol, at: new Date() };
      render();
      els.totalVol.textContent = fmtVol(totalVol) + " m³";
      els.totalIsk.textContent = fmtIntIsk(totalIsk) + " ISK";
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

      const existed = haul.has(ore.raw);
      addToHaul(ore, parsed.qty);
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
    L.push("Basis: lower of compressed / uncompressed mid-price");
    L.push("".padEnd(44, "-"));
    for (const r of lastAppraisal.rows) {
      const name = r.name.padEnd(26).slice(0, 26);
      if (r.unavailable) { L.push(name + "  " + fmtQty(r.qty).padStart(12) + "   (no market)"); continue; }
      L.push(name + "  " + fmtQty(r.qty).padStart(12) + "   " +
        fmtIntIsk(r.lineValue).padStart(16) + " ISK  [" + r.basis.slice(0, 6) + "]");
    }
    L.push("".padEnd(44, "-"));
    L.push("TOTAL VOLUME: " + fmtVol(lastAppraisal.totalVol) + " m3");
    L.push("TOTAL VALUE : " + fmtIntIsk(lastAppraisal.totalIsk) + " ISK");
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
    addToHaul(ore, qty);
    lastAppraisal = null;
    afterChange();
    els.oreInput.value = ""; els.qtyInput.value = ""; els.oreInput.focus();
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
  render();
  els.oreInput.focus();
})();
