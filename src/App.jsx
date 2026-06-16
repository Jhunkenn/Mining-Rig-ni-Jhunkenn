import React, { useState, useMemo, useEffect, useRef } from "react";

// ====================================================================================
// Exclusion Library (Checker) — Phase 1: keyword + imprint only. READ-ONLY OVERLAY.
// Source of truth = a shared Google Sheet published as CSV. Nothing here touches the
// parser, the 16-cell output, Copy Row/Column, overrides, or the override safeguard.
// ====================================================================================
const EXCLUSION_LIBRARY_CSV_URL = "TODO_ADD_PUBLISHED_CSV_URL = https://docs.google.com/spreadsheets/d/e/2PACX-1vSkIYeA4UIOWgQeUYSqOUlujOuJEh_-N1WQPmX8Nj0DwYGfqdqxXIBZfiNRFRRbTKKWgkLryrXbLdH5/pub?gid=1923631834&single=true&output=csv"; // <- paste the published-CSV URL here to activate
const CHECKER_TTL_MS = 10 * 60 * 1000; // refresh window: 10 minutes
const CHECKER_CACHE_KEY = "mra_checker_library_v1";

// Minimal RFC-4180 CSV reader: handles quoted fields, embedded commas/newlines, and "" escapes.
// (split(",") is unsafe because Value/Notes can contain commas.)
function parseCSV(text) {
  const s = String(text || "").replace(/\r\n?/g, "\n");
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// Shared normalizer for BOTH sheet values and extracted values, so the two sides always match:
// straighten curly quotes -> trim -> collapse internal whitespace -> lowercase.
const normValue = (s) => (s == null ? "" : String(s))
  .replace(/[\u2018\u2019\u201B]/g, "'")
  .replace(/[\u201C\u201D]/g, '"')
  .trim().replace(/\s+/g, " ").toLowerCase();

// Build the in-memory library from parsed rows. Skips header/blank/empty-Value/inactive rows and
// unknown types. Imprints -> Map(normalized -> {value, notes}); keywords -> precompiled whole-word regexes.
function buildLibrary(rows) {
  const imprints = new Map();
  const keywords = [];
  const kwSeen = new Set();
  for (const r of (rows || [])) {
    if (!r) continue;
    const type = normValue(r[0]);
    if (!type || type === "type") continue;            // skip blanks + header row
    const value = (r[1] == null ? "" : String(r[1])).trim();
    if (!value) continue;                              // skip empty Value
    if (normValue(r[3]) === "false") continue;         // only literal FALSE disables; blank = active
    const notes = (r[2] == null ? "" : String(r[2])).trim();
    const key = normValue(value);
    if (type === "imprint") {
      if (!imprints.has(key)) imprints.set(key, { value, notes });
    } else if (type === "keyword") {
      if (kwSeen.has(key)) continue;
      kwSeen.add(key);
      const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      keywords.push({ re: new RegExp("(?<![a-z0-9])" + esc + "(?![a-z0-9])", "i"), value, notes });
    }
    // any other Type is ignored (Phase 1 supports only keyword + imprint)
  }
  return { imprints, keywords, entryCount: imprints.size + keywords.length };
}

// Pure matcher over the EFFECTIVE (post-override) record. Returns a list of matches.
//  - imprint: exact normalized match against the extracted Imprint field ONLY.
//  - keyword: case-insensitive whole-word/phrase match against Book Title + Imprint ONLY
//    (no raw text, no URLs/phones/emails/numeric fields).
function checkLibrary(erec, library) {
  const out = [];
  if (!erec || !library) return out;
  const impNorm = normValue(erec.imprint);
  if (impNorm && library.imprints.has(impNorm)) {
    const e = library.imprints.get(impNorm);
    out.push({ type: "imprint", value: e.value, notes: e.notes });
  }
  const hay = normValue([erec.bookTitle, erec.imprint].filter(Boolean).join("\n"));
  if (hay) for (const k of library.keywords) {
    if (k.re.test(hay)) out.push({ type: "keyword", value: k.value, notes: k.notes });
  }
  return out;
}

// ---- phone extraction + filtering rules ----
function extractPhones(text) {
  // strict: requires real phone formatting (parens or separators) so bare ISBN/ASIN digit runs don't match
  const strict = /(?<!\d)(?:\+?1[\s.\-]?)?(?:\(\d{3}\)[\s.\-]*|\d{3}[\s.\-])\d{3}[\s.\-]\d{4}(?!\d)/g;
  // loose: only used on lines that clearly mention a phone
  const loose = /(?<!\d)(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g;
  // E.164: a literal "+" then 10–15 digits (e.g. +14044734789). The required leading "+" keeps bare
  // digit runs (ISBN/ASIN/etc.) from matching; the existing 10-digit check below filters anything longer.
  const e164 = /(?<!\d)\+\d{10,15}(?!\d)/g;
  // numbers explicitly flagged inactive in nearby text are dropped (text-only; no validation/lookups)
  const dead = /\b(disconnected|inactive|invalid|no longer in service|not in service|retired number|dead number|disconnected line)\b/i;
  const T = text.replace(/\r\n?/g, "\n"); // normalize line endings so per-number windows use exact offsets
  const lines = T.split("\n");
  // PASS 1: collect number matches with absolute positions, honoring per-line strict/loose + ISBN skip.
  const cands = [];
  let pos = 0;
  for (const line of lines) {
    if (!/\b(isbn|asin|upc|ean|sku)\b/i.test(line)) { // ignore product identifiers
      const re = /\b(phone|tel|mobile|cell|fax|call)\b/i.test(line) ? loose : strict;
      for (const mm of [...line.matchAll(re), ...line.matchAll(e164)]) cands.push({ raw: mm[0], start: pos + mm.index });
    }
    pos += line.length + 1; // +1 for the "\n" removed by split
  }
  cands.sort((a, b) => a.start - b.start);
  const seen = new Set(), out = [];
  for (let i = 0; i < cands.length; i++) {
    let d = cands[i].raw.replace(/\D/g, "");
    if (d.length === 11 && d[0] === "1") d = d.slice(1);
    if (d.length !== 10 || seen.has(d)) continue; // dedupe by 10-digit number
    seen.add(d);
    // PER-NUMBER metadata window: from immediately after this number to the next number (or end of text),
    // truncated at the first blank-line block break. type + year are read from this window ONLY, so numbers
    // sharing a line/block no longer inherit a neighbour's type/year.
    const winStart = cands[i].start + cands[i].raw.length;
    const winEnd = i + 1 < cands.length ? cands[i + 1].start : T.length;
    const ctx = T.slice(winStart, winEnd).split(/\n\s*\n/)[0].toLowerCase();
    if (dead.test(ctx)) continue; // drop numbers explicitly marked inactive/disconnected nearby
    let type = "Unknown";
    if (/\b(wireless|mobile|cell|cellular)\b/.test(ctx)) type = "Mobile";
    else if (/\b(landline|land\s*line|home|residential|wire\s?line|wired)\b/.test(ctx)) type = "Landline";
    const ym = ctx.match(/\b(?:19|20)\d{2}\b/);
    out.push({ digits: d, display: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, type, year: ym ? parseInt(ym[0]) : null });
  }
  return out;
}
const prio = (a, b) => {
  const da = a.year ? Math.abs(2026 - a.year) : Infinity;
  const db = b.year ? Math.abs(2026 - b.year) : Infinity;
  return da !== db ? da - db : (b.year || 0) - (a.year || 0);
};
function buildPhones(nums) {
  if (!nums.length) return [];
  const pinned = nums[0];
  const sorted = nums.slice(1).sort(prio);
  const res = [pinned];
  const has = (t) => res.some((n) => n.type === t);
  for (const t of ["Landline", "Mobile"]) {
    if (!has(t) && res.length < 4) {
      const i = sorted.findIndex((n) => n.type === t);
      if (i >= 0) { res.push(sorted[i]); sorted.splice(i, 1); }
    }
  }
  for (const n of sorted) { if (res.length >= 4) break; res.push(n); }
  return [pinned, ...res.slice(1).sort(prio)];
}

// pulls an author name from retail pages via the "(Author)" tag or a guarded "by ..."
function authorName(text) {
  const company = /\b(llc|inc|ltd|co|corp|press|publishing|publications|publisher|books|media|group|house|company|imprint|amazon|services|kdp|ingram|llp|gmbh|sons|associates|enterprises|distribution|store)\b/i;
  const clean = (s) => s.replace(/^by\s+/i, "").replace(/\s+/g, " ").trim();
  const personOK = (s, min) => { const w = clean(s).replace(/[ \t]+(?:Jr|Sr|II|III|IV|PhD|MD|DDS|Esq)\.?$/i, "").split(/\s+/); return w.length >= min && w.length <= 3 && !company.test(s); };
  // 1) strongest signal: a name immediately before "(Author)"
  const tagged = text.match(/(["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\-]*(?:[ \t]+["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\-]*){0,2}(?:[ \t]+(?:Jr|Sr|II|III|IV|PhD|MD|DDS|Esq)\.?)?)[ \t]*\(\s*authors?\s*\)/i);
  if (tagged && !/^by$/i.test(clean(tagged[1])) && personOK(tagged[1], 1)) return clean(tagged[1]);
  // Lulu contributor format: "By (author): Name" — the name follows the "(author):" label
  const afterParen = text.match(/\(\s*authors?\s*\)\s*[:：]\s*(["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\-]*(?:[ \t]+["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\-]*){0,2}(?:[ \t]+(?:Jr|Sr|II|III|IV|PhD|MD|DDS|Esq)\.?)?)/i);
  if (afterParen && personOK(afterParen[1], 1)) return clean(afterParen[1]);
  // 2) "by NAME" — but not "sold by", "shipped by", "published by", etc.
  const badBefore = /(sold|ship|ships|shipped|fulfil|fulfill|fulfilled|dispatch|dispatched|publish|published|distribute|distributed|market|marketed|power|powered|deliver|delivered|import|imported|present|presented|narrate|narrated|illustrate|illustrated|edit|edited|translate|translated|produce|produced|gone|goes|known)$/i;
  // skip promotional/navigation phrases that happen to follow "by" (e.g. "Delivery by Father's Day") and keep scanning for a real byline
  const navReject = /\b(day|sale|deal|promotion|customer|service|guidelines|categories|best sellers|new releases|gift cards)\b/i;
  const re = /\bby[ \t]+(["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\-]*(?:[ \t]+["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\-]*){1,2}(?:[ \t]+(?:Jr|Sr|II|III|IV|PhD|MD|DDS|Esq)\.?)?)/gi;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const lastWord = (before.match(/([A-Za-z]+)[\s:>\-]*$/) || [, ""])[1];
    if (badBefore.test(lastWord)) continue;
    if (navReject.test(m[1])) continue;
    if (personOK(m[1], 2)) return clean(m[1]);
  }
  return "";
}

// Book Title extraction: confidence-scored. Prioritizes explicit metadata, uses Amazon/B&N URLs
// (including the title slug in the URL) as signals, and rejects navigation / UI / category text.
function pickBookTitle(lines) {
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  const NAV = /^(skip to(?: main content)?|home|books?|menu|reviews?|ratings?|search|cart|account|sign ?in|sign ?up|log ?in|departments?|all|today'?s deals|deals|customer service|registry|gift ?cards?|gifts?|sell|wish ?list|browse|categor(?:y|ies)|new releases?|best ?sellers?|advanced search|kindle(?: store| edition)?|audible|audiobook|library|store|shop(?: now)?|buy(?: now)?|add to cart|add to list|see all|view|learn more|follow|share|prime|returns?|orders?|language|formats?|editions?|hello|select|overview|description|details|specifications?|product details|paperback|hardcover|hardback|ebook|mass market paperback)$/i;
  const CATEGORY = /^(fiction|nonfiction|non-fiction|literature(?: ?& ?fiction)?|fiction ?& ?literature|mystery|thriller|romance|fantasy|sci-?fi|science fiction|biography|memoir|history|children'?s books?|kids|young adult|self-?help|cookbooks?|cooking|poetry|comics?|manga|graphic novels?|textbooks?|reference|religion|spirituality|business|health|travel|art|music|teen|juvenile|literary fiction)$/i;
  const PHRASE = /\b(visit the|customer reviews|product details|about the author|add to|buy now|shop now|sign in|sign up|skip to|see all)\b/i;
  const isJunk = (s) => {
    const t = (s || "").replace(/\s+/g, " ").trim();
    if (t.length < 5) return true;                 // reject titles shorter than 5 chars
    if (!/[A-Za-z]/.test(t)) return true;           // must contain letters
    if (NAV.test(t) || CATEGORY.test(t) || PHRASE.test(t)) return true;
    if (/^(club|clubs|series|contents?|index|summary|about|more|less)$/i.test(t)) return true;
    return false;
  };
  const cands = [];
  const push = (text, score) => { const t = (text || "").replace(/\s+/g, " ").trim(); if (t && !isJunk(t)) cands.push({ t, score }); };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]; let m;
    // explicit metadata (strongest)
    if ((m = l.match(/^book\s*title\s*[:：]\s*(.+)/i))) push(m[1], 100);
    else if (/^book\s*title\s*$/i.test(l)) push(lines[i + 1], 95);
    if ((m = l.match(/^(?:book|title)\s*[:：]\s*(.+)/i))) push(m[1], 90);
    else if (/^(?:book|title)\s*$/i.test(l)) push(lines[i + 1], 80);
    // the title usually sits just above a "by Author" / "(Author)" byline
    {
      const luluByline = /^[Bb]y\[[A-Z]/.test(l) || (/^[Bb]y$/.test(l) && /^[A-Z]/.test(lines[i + 1] || ""));
      if (/\(\s*authors?\s*\)/i.test(l) || /^[Bb]y[ \t]+[A-Z]/.test(l) || luluByline) {
        if (luluByline) {
          // Lulu splits a title across multiple lines above the byline: collect the run of non-junk lines (deduped), join
          const parts = [];
          for (let j = i - 1; j >= 0 && j >= i - 3; j--) { if (!lines[j] || isJunk(lines[j])) break; if (!parts.includes(lines[j])) parts.unshift(lines[j]); }
          if (parts.length) push(parts.join(" "), 75);
        } else {
          for (let j = i - 1; j >= 0 && j >= i - 3; j--) { if (lines[j] && !isJunk(lines[j])) { push(lines[j], 75); break; } }
        }
      }
    }
    // Amazon / Barnes & Noble URLs are strong signals that book info exists
    const um = l.match(/https?:\/\/[^\s)]+/);
    if (um && /amazon\.|barnesandnoble\.|goodreads\./i.test(um[0])) {
      push(l.replace(um[0], "").replace(/^[\s:>|\-–—]+/, ""), 35); // text on the same line
      push(lines[i - 1], 50);                                       // nearby text
      push(lines[i + 1], 45);
      const az = um[0].match(/amazon\.[^\/]+\/([^\/]+)\/(?:dp|gp\/product)\//i); // Amazon title slug
      if (az) push(dec(az[1]).replace(/[-_]+/g, " "), 60);
      const bn = um[0].match(/barnesandnoble\.com\/w\/([^\/?#]+)/i);             // B&N title slug
      if (bn) push(dec(bn[1]).replace(/[-_]+/g, " ").replace(/\b\d{4,}\b/g, " "), 60);
    }
  }
  if (!cands.length) return "";
  cands.sort((a, b) => b.score - a.score);
  return cands[0].t;
}

// Email extraction: collect all candidates, score by context, reject platform/role addresses,
// and return "" unless a candidate clears the confidence threshold (blank is better than wrong).
function pickEmail(lines) {
  const HARD_REJECT = [/^info@atticus/i, /^support@truepeoplesearch\.com$/i]; // explicitly disqualified addresses
  const BLACKLIST = /(?:^|\.)(?:truepeoplesearch|amazon|barnesandnoble|goodreads|linkedin|facebook|instagram|twitter|x)\.com$/i;
  const REJECT_LOCAL = /^(support|help|helpdesk|privacy|no-?reply|do-?not-?reply|donotreply|admin|webmaster|contact|postmaster|mailer-daemon|abuse)$/i;
  const ROLE_LOCAL = /^(info|sales|hello|team|careers?|jobs|press|media|billing|marketing|newsletter|notifications?|office|mail|inquir(?:y|ies)|enquir(?:y|ies)|orders?|service)$/i;
  const EMAIL = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
  const emailLabel = /\b(e-?mail)\b/i;
  const phoneRe = /(?:\(\d{3}\)|\d{3})[\s.\-]\d{3}[\s.\-]\d{4}/;
  const addrRe = /\b\d{5}(-\d{4})?\b|\b(st|street|ave|avenue|dr|drive|rd|road|ln|lane|blvd|ct|court|way|pl|place)\b/i;
  const contactHdr = /^contact(?:\s+(?:info(?:rmation)?|details?))?\s*$/i;
  const legal = /terms|privacy|policy|copyright|©|all rights reserved|unsubscribe|do not sell|cookie|customer service|help cent(?:er|re)|contact us|about us|our team/i;
  const nameish = /^[A-Z][A-Za-z'’.\-]+(?:\s+[A-Z][A-Za-z'’.\-]+){1,2}$/; // a person-name-shaped line

  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    const found = lines[i].match(EMAIL);
    if (!found) continue;
    for (const raw of found) {
      const e = raw.trim();
      const at = e.lastIndexOf("@");
      const local = e.slice(0, at);
      const domain = e.slice(at + 1).toLowerCase();
      if (HARD_REJECT.some((re) => re.test(e))) continue; // disqualified outright
      if (BLACKLIST.test(domain) || REJECT_LOCAL.test(local)) continue; // hard reject platform/support addresses
      let score = 12;
      const lo = Math.max(0, i - 2), hi = Math.min(lines.length - 1, i + 2);
      let nearLabel = false, nearPhone = false, nearAddr = false, nearContact = false, nearLegal = false, nearName = false;
      for (let k = lo; k <= hi; k++) {
        if (emailLabel.test(lines[k])) nearLabel = true;
        if (phoneRe.test(lines[k])) nearPhone = true;
        if (addrRe.test(lines[k])) nearAddr = true;
        if (contactHdr.test(lines[k])) nearContact = true;
        if (legal.test(lines[k])) nearLegal = true;
        if (k !== i && nameish.test(lines[k])) nearName = true;
      }
      if (nearLabel) score += 40;          // "Email:" label
      if (nearPhone) score += 25;          // near a phone number
      if (nearAddr) score += 20;           // near the address
      if (nearName) score += 20;           // near a person-name line (the lead)
      if (nearContact) score += 20;        // under a Contact section
      if (i < 4) score += 5;               // lead data tends to sit near the top (weak signal)
      if (ROLE_LOCAL.test(local)) score -= 25; // generic role account, deprioritize
      if (nearLegal) score -= 50;          // footer / ToS / privacy context
      cands.push({ e, score, personal: !ROLE_LOCAL.test(local) && !nearLegal });
    }
  }
  if (!cands.length) return "";
  cands.sort((a, b) => b.score - a.score);
  if (cands[0].score >= 20) return cands[0].e; // existing confidence threshold (unchanged)
  // Minimal survival path: a clearly valid standalone personal address — one that passed every rejection
  // filter, is not a role account, and is not in a legal/footer context — is returned even without
  // corroborating context. Does not lower the threshold or alter any score.
  const standalone = cands.find((c) => c.personal);
  return standalone ? standalone.e : ""; // otherwise blank, never guess
}

// Splits a full name into First (given + middle, plus any leading title like "Dr.") and
// Last (surname + trailing suffixes like "Jr." / "PhD"). A title only moves to First when it leads.
function splitName(full) {
  const toks = (full || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!toks.length) return { firstName: "", lastName: "" };
  const PREFIX = /^(dr|mr|mrs|ms|miss|mx|prof|professor|rev|reverend|fr|hon|sir|dame|capt|captain|col|maj|lt|sgt|gen|gov|sen|rep|judge|atty|pastor|rabbi|imam|sister|brother)\.?$/i;
  const SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|md|dds|dvm|esq|esquire|cpa|rn|np|mba|jd|do|pe|psyd|edd|llm)\.?,?$/i;
  const lead = [];
  while (toks.length > 1 && PREFIX.test(toks[0])) lead.push(toks.shift());
  const trail = [];
  while (toks.length > 1 && SUFFIX.test(toks[toks.length - 1])) trail.unshift(toks.pop());
  let core = "", last = "";
  if (toks.length <= 1) { core = toks[0] || ""; }
  else { last = toks.pop(); core = toks.join(" "); }
  const firstName = [lead.join(" "), core].filter(Boolean).join(" ").trim();
  const lastName = [last, trail.join(" ")].filter(Boolean).join(" ").trim();
  return { firstName, lastName };
}

// ---- full record parser ----
function parse(text, meta = {}) {
  const T = text.replace(/[\u200e\u200f\u202a-\u202e]/g, "");
  const lines = T.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const after = (l) => { const i = l.search(/[:：]/); return i >= 0 ? l.slice(i + 1).trim() : ""; };
  const find = (re) => lines.find((l) => re.test(l)) || "";
  const labelish = (l) => /^[A-Za-z][\w .\/&'-]{0,28}\s*[:：]/.test(l) || /\b(isbn|asin|upc|ean|language|paperback|hardcover|hardback|dimensions|weight|pages|reading age|lexile|grade|best sellers|rank|format|edition|item)\b/i.test(l);
  const nextVal = (idx) => { const nx = lines[idx + 1] || ""; return nx && !labelish(nx) ? nx.trim() : ""; };
  const labeled = (labelRe, strict) => {
    for (let idx = 0; idx < lines.length; idx++) {
      if (!labelRe.test(lines[idx])) continue;
      const line = lines[idx];
      let v = "";
      if (/[:：]/.test(line)) v = after(line) || nextVal(idx);
      else {
        const rest = line.replace(labelRe, "").replace(/^[\s:：.\-–—]+/, "").trim();
        v = rest === "" ? nextVal(idx) : (strict ? "" : rest);
      }
      if (v) return v;
    }
    return "";
  };

  const email = pickEmail(lines);

  const urls = T.match(/https?:\/\/[^\s)]+/g) || [];
  // Known book-retailer / storefront hosts that should fill the retail ("Amazon Sites") slot alongside Amazon.
  // Host-anchored ([./] before the brand, "." after) so brands can't match inside unrelated hostnames (e.g. "lulu" in "honolulu.com").
  const BOOK_RETAIL = /[\/.](?:goodreads|barnesandnoble|kobo|books\.apple|bookshop|booksamillion|audible|thriftbooks|abebooks|powells|waterstones|blackwells|lulu|ingramspark|smashwords|books2read|bookbaby|blurb|ebooks|indigo|indiebound)\./i;
  const linkedin = urls.find((u) => /linkedin\.com/i.test(u)) || "";
  const amazon = urls.find((u) => /amazon\./i.test(u)) || urls.find((u) => BOOK_RETAIL.test(u)) || "";
  const website = urls.find((u) => !/linkedin\.com|amazon\./i.test(u) && !BOOK_RETAIL.test(u)) || "";

  // Property Value — Property Value / Estimated Value / Estimated Equity, whichever appears first
  const valLabel = /(property\s*value|estimated\s*value|estimated\s*equity)/i;
  let propertyValue = "";
  for (let i = 0; i < lines.length; i++) {
    if (!valLabel.test(lines[i])) continue;
    let v = after(lines[i]);                                                   // value after a colon
    if (!v) { const m = lines[i].match(/\$\s?[\d,]+(?:\.\d{2})?/); if (m) v = m[0]; }  // $amount on the same line
    if (!v) { const nx = (lines[i + 1] || "").trim(); if (/^\$?\s?[\d,]{3,}(?:\.\d{2})?$/.test(nx)) v = nx; } // value on next line
    if (v) { propertyValue = v; break; }
  }
  propertyValue = propertyValue.replace(/\$/g, "").replace(/\s+/g, " ").trim();

  // Date Published — from a date label, else a date inside the publisher/published line (often in parens)
  const MON = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
  const DATE = new RegExp("((?:" + MON + ")\\.?\\s+\\d{1,2},?\\s*\\d{4}|\\d{1,2}\\s+(?:" + MON + ")\\.?\\s+\\d{4}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|\\b(?:19|20)\\d{2}\\b)", "i");
  let datePublished = "";
  const dateLabel = /(date\s*published|publication\s*date|pub\.?\s*date|release\s*date|first\s*published|date\s*of\s*publication)/i;
  for (let i = 0; i < lines.length; i++) {
    if (dateLabel.test(lines[i])) {
      const m = lines[i].match(DATE) || (lines[i + 1] || "").match(DATE);
      if (m) { datePublished = m[1]; break; }
    }
  }
  if (!datePublished) for (const l of lines) {
    if (/(publisher|publish(?:ed|ing)?|imprint)/i.test(l)) { const m = l.match(DATE); if (m) { datePublished = m[1]; break; } }
  }

  // Book Title — confidence-scored across explicit labels, byline position, and Amazon/B&N URL signals
  let bookTitle = pickBookTitle(lines);
  // strip a known retail format marker only when it is the exact trailing parenthetical (leaves series/edition/subtitle text intact)
  bookTitle = bookTitle.replace(/\s*\((?:hardback|paperback|hardcover|ebook|kindle edition|audiobook|audio cd|mass market paperback)\)\s*$/i, "").trim();

  // Imprint / Publisher / Published by / Publishing — strip any trailing "(date)" so it stays just the imprint
  let imprint = labeled(/^(imprint|publisher|publishing|published\s*by)\b/i, true);
  imprint = imprint.replace(/\s*\([^)]*\b(?:19|20)\d{2}\b[^)]*\)\s*$/, "").trim();
  if (!imprint) imprint = find(/independently published/i);
  // reject navigation/promotional labels mistaken for a publisher/imprint (prefer blank over wrong)
  if (/\bguidelines\b|\bcustomer\s+service\b|\bbest\s+sellers\b|\bnew\s+releases\b|\bgift\s+cards\b|\bfather'?s\s+day\b/i.test(imprint) || /^(home|books|categories|sale|deal|promotion|new releases|best sellers)$/i.test(imprint.trim())) imprint = "";

  const zip = /\b\d{5}(-\d{4})?\b/;
  const streetWords = /\b(st|street|ave|avenue|dr|drive|rd|road|ln|lane|blvd|boulevard|ct|court|way|pl|place|cir|circle|ter|terrace|hwy|highway|pkwy|parkway|trl|trail|loop|sq|square|run|pike|row|apt|unit|ste|suite|box)\b/i;
  const notAddr = /@|http|phone|property|book|publish|imprint|amazon|email|linkedin|website|date/i;
  // review / rating / book-format text from retail pages must never count as an address
  const addrReject = /\b(customer\s+reviews?|out of \d|global ratings?|\d+\s+ratings?|paperback|hardcover|hardback|mass\s*market|kindle|audiobook|audible|ebook|best\s*sellers?\s*rank|add to (?:cart|list)|in stock)\b/i;
  const looksAddr = (l) => !!l && !notAddr.test(l) && !addrReject.test(l) && (/^\d{1,6}\s+\w/.test(l) || zip.test(l) || /,\s*[A-Z]{2}\b/.test(l) || streetWords.test(l));
  let address = "";
  // labeled address: value may be inline after the label OR on the following line(s).
  // Skip UI controls like "Address Lookup" / "Address Search", and only accept inline text that looks like an address.
  const addrLabel = /^(address|primary\s*street|street|residence|mailing)\b/i;
  const addrLabelUI = /\b(lookup|search|finder|reverse|directory|history|verification|autocomplete|results?|tools?|report|book)\b/i;
  const addrIdx = lines.findIndex((l) => addrLabel.test(l) && !addrLabelUI.test(l));
  if (addrIdx >= 0) {
    const inline = lines[addrIdx].replace(/^(address|primary\s*street|street|residence|mailing)\s*:?\s*/i, "").trim();
    const parts = (inline && looksAddr(inline)) ? [inline] : [];
    for (let i = addrIdx + 1; i < lines.length && parts.length < 3; i++) {
      if (!looksAddr(lines[i])) break;
      parts.push(lines[i]);
      if (zip.test(lines[i])) break;
    }
    address = parts.join(", ");
  }
  // no label: locate the address by shape, joining a city/state/zip continuation line
  if (!address) {
    const idx = lines.findIndex((l) => /^\d{1,6}\s+\w/.test(l) && (zip.test(l) || streetWords.test(l)));
    if (idx >= 0) {
      const parts = [lines[idx]];
      const next = lines[idx + 1];
      // Only skip the city/state/zip continuation if the street line ALREADY carries a real ZIP. Strip the
      // leading house number first so a 5-digit house number (e.g. "11267") isn't mistaken for a ZIP code.
      if (!zip.test(lines[idx].replace(/^\d{1,6}\b/, "")) && looksAddr(next) && (zip.test(next || "") || /,\s*[A-Z]{2}\b/.test(next || ""))) parts.push(next);
      address = parts.join(", ");
    }
  }
  // last resort: the address sitting next to a "Get Directions" link (common on people-search pages)
  if (!address) {
    const gi = lines.findIndex((l) => /get\s*directions/i.test(l));
    if (gi >= 0) {
      const inline = lines[gi].replace(/get\s*directions/i, "").replace(/[•|·–—\-]+\s*$/, "").trim();
      let cand = looksAddr(inline) ? inline : "";
      if (!cand && gi > 0 && looksAddr(lines[gi - 1])) cand = lines[gi - 1];
      if (!cand && looksAddr(lines[gi + 1])) cand = lines[gi + 1];
      address = cand || "";
    }
  }
  address = address.replace(/\s*(?:[•|·–—-]\s*)?get\s*directions\s*$/i, "").replace(/\s{2,}/g, " ").trim();
  // Canada411 fallback (isolated; runs ONLY if every method above produced nothing): an unlabeled address
  // often sits on the line directly above a phone number and carries a Canadian postal code (A1A 1A1).
  if (!address) {
    const caPostal = /[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d/;                  // Canadian postal code, space optional
    const phoneLineRe = /(?:\(\d{3}\)|\d{3})[\s.\-]?\d{3}[\s.\-]?\d{4}/;   // a line that contains a phone number
    const stripNav = (s) => s.replace(/\s*(?:[•|·–—\-]\s*)?(?:get\s*directions|directions|map|view\s*map)\s*$/i, "").replace(/\s{2,}/g, " ").trim();
    const caAddr = (l) => {
      const t = stripNav(l || "");                                        // a trailing "Get Directions"/"Map" must not block a valid address
      if (!t || notAddr.test(t) || addrReject.test(t)) return false;
      return /^\d{1,6}\s+\w/.test(t) && (caPostal.test(t) || zip.test(t) || /,/.test(t) || streetWords.test(t));
    };
    for (let i = 1; i < lines.length; i++) {
      if (phoneLineRe.test(lines[i]) && caAddr(lines[i - 1])) { address = stripNav(lines[i - 1]); break; }
    }
  }
  // final safety: never return bare navigation/placeholder text as the address itself
  if (/^(lookup|get\s*directions|directions|map|view\s*map)$/i.test(address.trim()) || addrReject.test(address)) address = "";

  const DISQUALIFY = /\b(fair credit|skip to (?:the )?main content|join prime|day|sale|deal|promotion|customer|service|books|categories|guidelines|home|best sellers|new releases|gift cards)\b/i;
  const nameL = find(/^name\s*:/i);
  let name = nameL ? after(nameL) : "";
  // FastBackgroundCheck: capture the record's own identity FIRST — ahead of authorName (whose "by …"
  // rule otherwise matches footer text like "by the Fair Credit Reporting Act", a non-empty value that
  // would skip this block, get disqualified, and let the people-search fallback grab a sidebar heading
  // like "Quick Links") and ahead of the generic age-anchor heuristic
  // (which otherwise mis-selects sidebar headings like "Quick Links"). PRIMARY: the record title
  // "<Name> in <City>, <State>". FALLBACK: the "Full Name <value>" field, label-bounded so it cannot
  // absorb adjacent profile data (Born/Age/etc.). The atom mirrors authorName (accent- and
  // quoted-nickname-aware); the captured string flows through the same splitName pipeline as every
  // other source. Scoped to this source only — no other source reaches this block.
  if (!name && detectSource(T) === "FastBackgroundCheck") {
    const atom = `["“]?[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’"“”.\\-]*`;
    const NM = atom + `(?:\\s+` + atom + `){0,3}`;
    const titleRe = new RegExp(`^(${NM})\\s+in\\s+[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ .'’\\-]+,`);
    const fullRe = new RegExp(`\\bFull\\s+Name\\b[\\s:]+(${atom}(?:\\s+${atom}){0,3}?)(?=\\s+(?:Born|Age|Zodiac|DOB|Date\\s+of\\s+Birth|Address|Current|Marital)\\b|\\s*$)`, "m");
    for (const l of lines) { const m = l.match(titleRe); if (m) { name = m[1]; break; } }
    if (!name) { const m = T.match(fullRe); if (m) name = m[1].trim(); }
  }
  if (!name) name = authorName(T);
  // Never read names out of relative / background sections — those list family, not the lead.
  const RELATIVES = /(background\s+profile|public\s+records?\s+report|possible\s+relatives?|^relatives?\b|associated\s+(?:persons?|names?)|known\s+associates?)/i;
  const relIdx = lines.findIndex((l) => RELATIVES.test(l));
  const leadEnd = relIdx < 0 ? lines.length : relIdx;       // only consider lines above the first such section
  // people-search records: a person-name directly followed by Age / Address / Born / DOB / Date of Birth,
  // either on the next line or inline right after the name (e.g. "Amber Shoebridge Age 52, Born May 1974").
  // Runs before the generic fallback, scanning only the lead region above any relatives/background section.
  if (!name) {
    const psName = /^([A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){1,2})$/;
    const psInline = /^([A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){1,2})\s+(?:age|address|born|dob|date\s+of\s+birth)\b/i;
    const psMarker = /^(?:age|address|born|dob|date\s+of\s+birth)\b/i;
    for (let i = 0; i < leadEnd; i++) {
      let cand = "";
      const inl = lines[i].match(psInline);
      if (inl) cand = inl[1];
      else if (psName.test(lines[i]) && psMarker.test(lines[i + 1] || "")) cand = lines[i].match(psName)[1];
      if (cand && !DISQUALIFY.test(cand)) { name = cand; break; }
    }
  }
  if (!name && lines.length === 1) {
    // Strict single-line gate: the bare-name fallback may only fire when the entire
    // paste is one lone, name-shaped line that is not publisher/imprint/marketing text.
    const junk = /@|\d|http|phone|address|property|book|publish|imprint|amazon|value|email|street|linkedin|website|skip|sign|cart|account|menu|search|deliver|return|order|deal|customer|review|department|hello|select|content|main|home|gift|prime|wish|follow|share|\bbuy\b|price|stock|seller|ship|format|edition|paperback|hardcover|kindle|audible|rating|star|barnes|noble|\bby\b/i;
    const notPerson = /\b(press|media|publishing|publications|publisher|imprint|editions?|books?|studios?|productions?|group|company|enterprises|collective|author|sellers?|selling|bestseller|rated|featured|sponsored)\b/i;
    const nameRe = /^[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’.\-]*(?:\s+[A-ZÀ-ÖØ-öø-ÿĀ-ſ][A-Za-zÀ-ÖØ-öø-ÿĀ-ſ'’.\-]*){1,2}(?:\s+(?:Jr|Sr|II|III|IV|PhD|MD|DDS|Esq)\.?)?$/;
    const one = lines[0];
    if (nameRe.test(one) && !junk.test(one) && !notPerson.test(one) && !DISQUALIFY.test(one)) name = one;
  }
  name = name.replace(/\s+/g, " ").trim();
  if (DISQUALIFY.test(name)) name = "";
  name = name.replace(/\b(?:and|&)\b/gi, " ").replace(/\s+/g, " ").trim(); // disqualify the connector "and"/"&" anywhere in the name
  // People-search fallback (isolated; runs ONLY if no valid name remains after every method above —
  // including when an existing method returned a value that was just disqualified/blanked, e.g. a footer
  // line like "...as defined by the Fair Credit Reporting Act"). On TruePeopleSearch the lead's name sits
  // on or directly above an "Age / Born / DOB / Date of Birth" line; the required birth marker keeps this
  // people-search-only (Amazon/book pages never match). First birth-anchored name is the lead, not a relative.
  if (!name) {
    const psN = /^([A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){1,3})$/;
    const psI = /^([A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){1,3})\s+(?:age|born|dob|date\s+of\s+birth)\b/i;
    const psM = /^(?:age\b|born\b|dob\b|date\s+of\s+birth\b)/i;
    for (let i = 0; i < lines.length; i++) {
      let cand = "";
      const inl = lines[i].match(psI);
      if (inl) cand = inl[1];                                                 // "William Avalos Age 46, Born ..."
      else if (i > 0 && psM.test(lines[i]) && psN.test(lines[i - 1])) cand = lines[i - 1].match(psN)[1]; // name on the line above an "Age ..." line
      if (cand && !DISQUALIFY.test(cand)) { name = cand.replace(/\s+/g, " ").trim(); break; }
    }
  }
  const { firstName, lastName } = splitName(name);

  const mainLines = lines.filter((l) => /main\s*phone/i.test(l)).join(" ");
  const phones = extractPhones(mainLines + "\n" + T).map((n) => ({
    ...n,
    type: meta[n.digits]?.type || n.type || "Unknown",
    year: meta[n.digits]?.year || n.year || null,
  }));

  return { firstName, lastName, email, phones, address, propertyValue, datePublished, bookTitle, imprint, amazon, website, linkedin };
}

// the spreadsheet cell sequence, blanks preserved in position
const SLOTS = [
  { label: "First Name", key: "firstName" },
  { blank: true },
  { label: "Last Name", key: "lastName" },
  { label: "Date Published", key: "datePublished" },
  { blank: true },
  { label: "Email", key: "email" },
  { label: "Phone", key: "phone" },
  { label: "Address", key: "address" },
  { label: "Property Value", key: "propertyValue" },
  { blank: true },
  { label: "Other Phone", key: "otherPhone" },
  { label: "Book Title", key: "bookTitle" },
  { label: "Imprint", key: "imprint" },
  { label: "Amazon Sites", key: "amazon" },
  { label: "Website", key: "website" },
  { label: "LinkedIn URL", key: "linkedin" },
];

// ---- clipboard: rich HTML (clean cells) -> plain text -> legacy ----
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const q = (v) => (/[\t\n"]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
async function clip(plain, html) {
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new window.ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      return true;
    }
  } catch {}
  try { await navigator.clipboard.writeText(plain); return true; } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = plain; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta);
    return true;
  } catch { return false; }
}

const THEMES = [
  { name: "Ember", vars: { "--bone": "#EDE8DD", "--paper": "#F7F4EC", "--ink": "#1B1A16", "--ink-soft": "#6B665B", "--line": "#D9D2C3", "--accent": "#FF5436", "--accent-deep": "#D23A1E", "--field": "#FFFFFF", "--focus": "rgba(255,84,54,.18)", "--note": "#FBE7A0", "--note-line": "#E6CD72", "--note-ink": "#3A310F", "--note-label": "#8A7220", "--note-link": "#9A3A12", "--note-muted": "#B39A4A" } },
  { name: "Tide", vars: { "--bone": "#E6EAEF", "--paper": "#F1F4F8", "--ink": "#15191F", "--ink-soft": "#586475", "--line": "#C9D2DD", "--accent": "#2C6BE6", "--accent-deep": "#1C4FB5", "--field": "#FFFFFF", "--focus": "rgba(44,107,230,.18)", "--note": "#DBE7F8", "--note-line": "#B6CBEC", "--note-ink": "#152844", "--note-label": "#3E618F", "--note-link": "#1C4FB5", "--note-muted": "#97AECF" } },
  { name: "Grove", vars: { "--bone": "#E7EAE1", "--paper": "#F1F4EB", "--ink": "#172019", "--ink-soft": "#586556", "--line": "#CDD5C4", "--accent": "#2F9159", "--accent-deep": "#1E6B3F", "--field": "#FFFFFF", "--focus": "rgba(47,145,89,.18)", "--note": "#DDEFC8", "--note-line": "#BBD79A", "--note-ink": "#1C3422", "--note-label": "#487231", "--note-link": "#1E6B3F", "--note-muted": "#A4C087" } },
  { name: "Bloom", vars: { "--bone": "#F0E6E9", "--paper": "#F9F0F3", "--ink": "#211519", "--ink-soft": "#6E5560", "--line": "#E0CBD3", "--accent": "#E0457E", "--accent-deep": "#B62C61", "--field": "#FFFFFF", "--focus": "rgba(224,69,126,.18)", "--note": "#FBD9E7", "--note-line": "#F0B6CE", "--note-ink": "#3A1623", "--note-label": "#9A3A66", "--note-link": "#B62C61", "--note-muted": "#CC93AC" } },
  { name: "Noir", vars: { "--bone": "#191A1F", "--paper": "#24262D", "--ink": "#EFEDE8", "--ink-soft": "#9FA0A9", "--line": "#373A43", "--accent": "#FF6A3D", "--accent-deep": "#E0512A", "--field": "#2A2D35", "--focus": "rgba(255,106,61,.22)", "--note": "#2C2F38", "--note-line": "#444856", "--note-ink": "#F0EEE9", "--note-label": "#D2A45C", "--note-link": "#FF9269", "--note-muted": "#6B6E7A" } },
  { name: "Slate", vars: { "--bone": "#1A1D21", "--paper": "#23272D", "--ink": "#E8EAED", "--ink-soft": "#969BA3", "--line": "#353A42", "--accent": "#57A6D4", "--accent-deep": "#3D87B8", "--field": "#2A2F36", "--focus": "rgba(87,166,212,.22)", "--note": "#2B3038", "--note-line": "#434A55", "--note-ink": "#ECEEF1", "--note-label": "#7FB4D6", "--note-link": "#9CC8E6", "--note-muted": "#6A7079" } },
  { name: "Midnight", vars: { "--bone": "#131A2A", "--paper": "#1C2538", "--ink": "#E7EBF2", "--ink-soft": "#8E99AE", "--line": "#2C3850", "--accent": "#5B8DEF", "--accent-deep": "#3E6BD0", "--field": "#232E45", "--focus": "rgba(91,141,239,.24)", "--note": "#222C42", "--note-line": "#3A4763", "--note-ink": "#EAEEF6", "--note-label": "#8FA9E0", "--note-link": "#A8BCEC", "--note-muted": "#6E7896" } },
  { name: "Sand", vars: { "--bone": "#E7DECB", "--paper": "#F3ECDA", "--ink": "#2A2419", "--ink-soft": "#786E59", "--line": "#D8CDB4", "--accent": "#C0892E", "--accent-deep": "#9A6A1C", "--field": "#FBF6EA", "--focus": "rgba(192,137,46,.20)", "--note": "#F4E3B8", "--note-line": "#E2C98A", "--note-ink": "#3A2E12", "--note-label": "#8A6E26", "--note-link": "#8A5A1C", "--note-muted": "#B6A064" } },
];

// ---- minimalist inline icons (no dependencies) ----
function Icon({ name, size = 14, style }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" };
  const shapes = {
    user: <g {...p}><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.5 3-5.6 7-5.6s7 2.1 7 5.6" /></g>,
    mail: <g {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 5.5L20 7" /></g>,
    phone: <g {...p}><path d="M6 3h3l1.5 4-2 1.3a12 12 0 0 0 5.2 5.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4 5.2 2 2 0 0 1 6 3z" /></g>,
    pin: <g {...p}><path d="M20 10c0 6-8 11-8 11s-8-5-8-11a8 8 0 0 1 16 0z" /><circle cx="12" cy="10" r="2.5" /></g>,
    dollar: <g {...p}><path d="M12 3v18" /><path d="M16.5 6.5H10a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H7" /></g>,
    home: <g {...p}><path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19z" /><path d="M9.5 20.5V13h5v7.5" /></g>,
    book: <g {...p}><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15.5H6.5A1.5 1.5 0 0 0 5 20z" /><path d="M5 18.5A1.5 1.5 0 0 1 6.5 17H19" /></g>,
    tag: <g {...p}><path d="M19 20.5l-7-4.8-7 4.8V5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5z" /></g>,
    cal: <g {...p}><rect x="4" y="5" width="16" height="16" rx="2.5" /><path d="M4 10h16M8 3v4M16 3v4" /></g>,
    cart: <g {...p}><circle cx="9.5" cy="20" r="1.3" /><circle cx="18" cy="20" r="1.3" /><path d="M3 4h2l2.2 11a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.2L21 7H6" /></g>,
    globe: <g {...p}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 3.8 5.7 3.8 9S14.5 18.5 12 21c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z" /></g>,
    linkedin: <g {...p}><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M7 10.5V17M7 7.2v.01M11 17v-3.6a2 2 0 0 1 4 0V17" /></g>,
    check: <g {...p}><path d="M5 12.5 10 17.5 19 7" /></g>,
    rows: <g {...p}><rect x="3" y="4.5" width="18" height="5.5" rx="1.5" /><rect x="3" y="14" width="18" height="5.5" rx="1.5" /></g>,
    cols: <g {...p}><rect x="4.5" y="3" width="5.5" height="18" rx="1.5" /><rect x="14" y="3" width="5.5" height="18" rx="1.5" /></g>,
    inbox: <g {...p}><path d="M3 13h5l1.5 2.5h5L16 13h5" /><path d="M6 5.5 3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5L18 5.5A2 2 0 0 0 16.2 4.5H7.8A2 2 0 0 0 6 5.5z" /></g>,
    spark: <g {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10z" /></g>,
    layers: <g {...p}><path d="M12 3 3 7.5 12 12l9-4.5L12 3z" /><path d="M3 12l9 4.5L21 12M3 16.5 12 21l9-4.5" /></g>,
    link: <g {...p}><path d="M9.5 14.5 14.5 9.5" /><path d="M8 12 6 14a3.5 3.5 0 0 0 5 5l2-2" /><path d="M16 12l2-2a3.5 3.5 0 0 0-5-5l-2 2" /></g>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" style={{ flexShrink: 0, display: "block", ...style }}>{shapes[name] || null}</svg>;
}

// display grouping for the lead profile (independent of the 16-cell copy order in SLOTS)
const SECTIONS = [
  { title: "Contact Information", icon: "mail", fields: [
    { key: "email", label: "Email", icon: "mail" },
    { key: "phone", label: "Phone", icon: "phone" },
    { key: "otherPhone", label: "Other Phone", icon: "phone" },
    { key: "address", label: "Address", icon: "pin" },
  ] },
  { title: "Property Information", icon: "home", fields: [
    { key: "propertyValue", label: "Property Value", icon: "dollar" },
  ] },
  { title: "Book Information", icon: "book", fields: [
    { key: "bookTitle", label: "Book Title", icon: "book" },
    { key: "imprint", label: "Imprint", icon: "tag" },
    { key: "datePublished", label: "Date Published", icon: "cal" },
  ] },
  { title: "Online Presence", icon: "globe", fields: [
    { key: "amazon", label: "Amazon", icon: "cart", link: true },
    { key: "website", label: "Website", icon: "globe", link: true },
    { key: "linkedin", label: "LinkedIn", icon: "linkedin", link: true },
  ] },
];
const FIELDS = ["firstName", "lastName", "email", "phone", "otherPhone", "address", "propertyValue", "bookTitle", "imprint", "datePublished", "amazon", "website", "linkedin"];
const SOURCES = ["Amazon", "TruePeopleSearch", "Canada411", "WhitePages", "Barnes & Noble", "Goodreads"];
const VERSION = "0.9.0"; // display only — bump this string as you release; not tied to any logic
// Read-only source classifier for UI feedback. Sniffs the raw paste for site signals to show a
// "Detected Source" badge. It does NOT feed parse()/extraction in any way — purely a confidence cue.
function detectSource(text) {
  const t = text || "";
  if (/fastbackgroundcheck/i.test(t)) return "FastBackgroundCheck";
  if (/truepeoplesearch/i.test(t)) return "TruePeopleSearch";
  if (/whitepages/i.test(t)) return "WhitePages";
  if (/canada\s?411/i.test(t)) return "Canada411";
  if (/goodreads/i.test(t)) return "Goodreads";
  if (/barnes\s*&?\s*noble|barnesandnoble/i.test(t)) return "Barnes & Noble";
  if (/amazon\.[a-z]|\bASIN\b|\(\s*authors?\s*\)|kindle\s+direct\s+publishing/i.test(t)) return "Amazon Author Page";
  return "";
}

// ---- URL normalization (fully isolated; independent of parse()/extraction) ----
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term",
  "fbclid", "gclid", "msclkid", "mc_eid", "ref", "ref_src",
  "tag", "crid", "qid", "keywords", "dib", "dib_tag", "sprefix", "sr", "psc", "linkcode",
  "ascsubtag", "th", "colid", "coliid", "smid", "_encoding", "pf_rd_r", "pf_rd_p", "pd_rd_r", "pd_rd_w", "pd_rd_wg", "content-id",
]);
const isAmazonHost = (h) => /(^|\.)amazon\.[a-z.]+$/i.test(h) || /(^|\.)amzn\.[a-z.]+$/i.test(h);
function extractAsin(u) {
  const seg = u.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|product|o\/ASIN)\/([A-Z0-9]{10})(?=[/?]|$)/i);
  if (seg) return seg[1].toUpperCase();
  const qa = u.searchParams.get("asin") || u.searchParams.get("ASIN");
  if (qa && /^[A-Z0-9]{10}$/i.test(qa)) return qa.toUpperCase();
  const any = u.pathname.match(/\/([A-Z0-9]{10})(?=[/?]|$)/i);
  return any ? any[1].toUpperCase() : null;
}
// Returns { kind:"amazon"|"generic"|"invalid", original, clean, warning }
function cleanUrl(input) {
  const original = (input || "").trim();
  let u;
  try { u = new URL(/^https?:\/\//i.test(original) ? original : "https://" + original); }
  catch { return { kind: "invalid", original, clean: original, warning: "Not a valid URL." }; }
  if (isAmazonHost(u.hostname)) {
    const asin = extractAsin(u);
    if (asin) return { kind: "amazon", original, clean: `https://${u.hostname}/dp/${asin}`, warning: "" };
    return { kind: "amazon", original, clean: original, warning: "Amazon product identifier not detected." };
  }
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  return { kind: "generic", original, clean: u.toString().replace(/\?$/, ""), warning: "" };
}

// ---- Date Published display normalization (post-extraction only; extraction logic unchanged) ----
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function normalizeDate(v) {
  const s = (v || "").trim();
  if (!s) return s;
  let mo = null, yr = null, m;
  if ((m = s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/))) { mo = +m[1]; yr = +m[3]; }            // M/D/YYYY (US)
  else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { yr = +m[1]; mo = +m[2]; }               // YYYY-MM-DD
  else {
    const mn = s.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i);
    const yn = s.match(/\b(\d{4})\b/);
    if (mn) { const i = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(mn[1].slice(0, 3).toLowerCase()); if (i >= 0) mo = i + 1; }
    if (yn) yr = +yn[1];
  }
  if (yr && yr >= 1000 && yr <= 9999) return mo && mo >= 1 && mo <= 12 ? `${MONTHS[mo - 1]} ${yr}` : String(yr);
  return s; // cannot confidently parse → leave original unchanged
}

// Presentation-only: abbreviate a recognized "FullMonth YYYY" to 3-letter "Mon YYYY" for all
// user-facing output (display + copy/export). Internal rec.datePublished is left untouched.
function abbrevMonthYear(s) {
  const m = (s || "").match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (!m) return s;
  const i = MONTHS.indexOf(m[1]);
  return i >= 0 ? `${MONTHS[i].slice(0, 3)} ${m[2]}` : s;
}

export default function App() {
  const [raw, setRaw] = useState("");
  const [copied, setCopied] = useState("");
  const [theme, setTheme] = useState(0);
  const [themeOpen, setThemeOpen] = useState(false);
  const [installEvt, setInstallEvt] = useState(null);
  const [rowMode, setRowMode] = useState(() => { try { return localStorage.getItem("mr_rowMode") === "full" ? "full" : "separate"; } catch { return "separate"; } });
  const [rowMenuOpen, setRowMenuOpen] = useState(false);
  const [modeMsg, setModeMsg] = useState("");
  const [stats, setStats] = useState({ leads: 0, fields: 0, ready: 0 });
  const [leftPct, setLeftPct] = useState(50); // input panel width %, session-only
  const wsRef = useRef(null);
  const taRef = useRef(null);
  const modeMsgTimer = useRef(null);
  const dragRef = useRef(false);
  const actionRef = useRef({});

  const rec = useMemo(() => parse(raw), [raw]);
  // Override layer (correction tool): a filled field wins outright; blank falls back to extraction.
  // Extraction (parse/rec) is never modified — this only overlays final values.
  const [ovFirst, setOvFirst] = useState("");
  const [ovLast, setOvLast] = useState("");
  const [ovBookTitle, setOvBookTitle] = useState("");
  const [ovImprint, setOvImprint] = useState("");
  const erec = useMemo(() => ({
    ...rec,
    firstName: ovFirst.trim() || rec.firstName,
    lastName: ovLast.trim() || rec.lastName,
    bookTitle: ovBookTitle.trim() || rec.bookTitle,
    imprint: ovImprint.trim() || rec.imprint,
  }), [rec, ovFirst, ovLast, ovBookTitle, ovImprint]);
  const [ovOpen, setOvOpen] = useState(false); // overrides collapsed by default
  const ovActive = !!(ovFirst.trim() || ovLast.trim() || ovBookTitle.trim() || ovImprint.trim());
  const built = useMemo(() => buildPhones(rec.phones), [rec.phones]);
  const source = useMemo(() => detectSource(raw), [raw]);
  const trimmedRaw = raw.trim();
  const urlMode = trimmedRaw.length > 0 && !/\s/.test(trimmedRaw) && /^(https?:\/\/)?[\w.-]+\.[a-z]{2,}([/?#]|$)/i.test(trimmedRaw);
  const link = useMemo(() => (urlMode ? cleanUrl(trimmedRaw) : null), [urlMode, trimmedRaw]);

  // normalize the extracted Amazon URL for both display and copy (uses the existing cleanUrl)
  const cleanAmazon = (v) => { if (!v) return ""; const r = cleanUrl(v); return r.kind === "amazon" && !r.warning ? r.clean : v; };

  // ---- copy: UNCHANGED 16-cell SLOTS order + clipboard payload ----
  const valueOf = (slot) => {
    if (slot.blank) return "";
    if (slot.key === "phone") return built[0]?.display || "";
    if (slot.key === "otherPhone") return built.slice(1).map((n) => n.display).join(", ");
    if (slot.key === "amazon") return cleanAmazon(rec.amazon);
    if (slot.key === "datePublished") return abbrevMonthYear(normalizeDate(rec.datePublished));
    return erec[slot.key] || "";
  };
  const cells = useMemo(() => SLOTS.map(valueOf), [erec, built]);

  // value for a single field key (for the grouped display only)
  const fieldVal = (key) => {
    if (key === "phone") return built[0]?.display || "";
    if (key === "otherPhone") return built.slice(1).map((n) => n.display).join(", ");
    if (key === "amazon") return cleanAmazon(rec.amazon);
    if (key === "datePublished") return abbrevMonthYear(normalizeDate(rec.datePublished));
    return erec[key] || "";
  };

  const populated = FIELDS.filter((k) => fieldVal(k)).length;
  const completeness = Math.round((populated / FIELDS.length) * 100);
  const hasData = populated > 0;
  const tier = completeness >= 90 ? "Comprehensive" : completeness >= 70 ? "Detailed" : completeness >= 40 ? "Moderate" : "Limited";
  const fullName = [erec.firstName, erec.lastName].filter(Boolean).join(" ").trim();
  const initials = ((rec.firstName?.[0] || "") + (rec.lastName?.[0] || "")).toUpperCase() || "—";

  // ---- Exclusion Library (Checker): read-only overlay state ----
  const checkerConfigured = !!EXCLUSION_LIBRARY_CSV_URL && EXCLUSION_LIBRARY_CSV_URL !== "TODO_ADD_PUBLISHED_CSV_URL";
  const [libRows, setLibRows] = useState(null);          // cached parsed CSV rows
  const [libFetchedAt, setLibFetchedAt] = useState(0);   // for the freshness label
  const [libStatus, setLibStatus] = useState(checkerConfigured ? "idle" : "unconfigured"); // idle|loading|fresh|stale|unavailable|unconfigured
  const libFetchedRef = useRef(0);                        // age/presence source of truth (closure-safe)
  const library = useMemo(() => buildLibrary(libRows), [libRows]);
  const matches = useMemo(() => (checkerConfigured && hasData ? checkLibrary(erec, library) : []), [checkerConfigured, hasData, erec, library]);
  const imprintFlagged = matches.some((m) => m.type === "imprint");
  const fetchLibrary = () => {
    if (!checkerConfigured) return;
    if (libFetchedRef.current === 0) setLibStatus("loading");
    // fetch the published CSV URL as-is — no cache-buster param (Google's /pub endpoint 404s on an
    // unknown trailing query param). cache:"no-store" already prevents browser HTTP caching.
    fetch(EXCLUSION_LIBRARY_CSV_URL, { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
      .then((text) => {
        const rows = parseCSV(text); const now = Date.now();
        setLibRows(rows); setLibFetchedAt(now); libFetchedRef.current = now; setLibStatus("fresh");
        try { localStorage.setItem(CHECKER_CACHE_KEY, JSON.stringify({ fetchedAt: now, rows })); } catch {}
      })
      .catch(() => { setLibStatus(libFetchedRef.current ? "stale" : "unavailable"); });
  };
  useEffect(() => {
    if (!checkerConfigured) return;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(CHECKER_CACHE_KEY) || "null"); } catch {}
    if (cached && Array.isArray(cached.rows)) {
      const at = cached.fetchedAt || 0;
      setLibRows(cached.rows); setLibFetchedAt(at); libFetchedRef.current = at;
      setLibStatus(Date.now() - at < CHECKER_TTL_MS ? "fresh" : "stale");
    }
    if (!(cached && Date.now() - (cached.fetchedAt || 0) < CHECKER_TTL_MS)) fetchLibrary();
    const id = setInterval(() => { if (Date.now() - libFetchedRef.current >= CHECKER_TTL_MS) fetchLibrary(); }, 60 * 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const libAgeMin = libFetchedAt ? Math.max(0, Math.round((Date.now() - libFetchedAt) / 60000)) : null;
  const checkerLabel = !checkerConfigured ? "Checker: off"
    : libStatus === "loading" ? "Checker: loading…"
    : libStatus === "unavailable" ? "Checker: unavailable"
    : "Checker: " + library.entryCount + (library.entryCount === 1 ? " entry" : " entries")
      + (libStatus === "stale" ? " · stale" : libAgeMin != null ? " · " + (libAgeMin === 0 ? "just now" : libAgeMin + "m ago") : "");

  const fmt = (n) => n.toLocaleString();
  const successRate = stats.leads ? Math.round((stats.ready / stats.leads) * 100) : null;

  const flash = (k) => { setCopied(k); setTimeout(() => setCopied(""), 1600); };
  const tally = () => setStats((s) => ({ leads: s.leads + 1, fields: s.fields + populated, ready: s.ready + (completeness >= 70 ? 1 : 0) }));
  const copyRow = async () => {
    // Export-format only: "full" places the combined name in the First Name cell and blanks the Last Name cell.
    // Same 16-cell length/order; "separate" is byte-identical to the previous behavior.
    const rowCells = rowMode === "full"
      ? SLOTS.map((slot, i) => (slot.key === "firstName" ? fullName : slot.key === "lastName" ? "" : cells[i]))
      : cells;
    const plain = rowCells.map(q).join("\t");
    const html = `<table><tr>${rowCells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr></table>`;
    if (await clip(plain, html)) { flash("row"); tally(); }
  };
  const copyCol = async () => {
    // Copy Column only: combine name components into one line and skip blank/empty values
    const colVals = [];
    if (fullName) colVals.push(fullName);
    SLOTS.forEach((slot, i) => {
      if (slot.blank || slot.key === "firstName" || slot.key === "lastName") return;
      if (cells[i]) colVals.push(cells[i]);
    });
    const plain = colVals.map(q).join("\n");
    const html = `<table>${colVals.map((c) => `<tr><td>${esc(c)}</td></tr>`).join("")}</table>`;
    if (await clip(plain, html)) { flash("col"); tally(); }
  };

  const copyClean = async () => {
    if (link && !link.warning && (await clip(link.clean, link.clean))) flash("link");
  };

  // Clear: empties the Raw Input (which clears all derived output/results/status messages),
  // clears the transient copy indicator, and returns focus to the textarea. No file state exists (paste-only).
  const canClear = raw.length > 0 || hasData;
  const clearAll = () => { setRaw(""); setCopied(""); setOvFirst(""); setOvLast(""); setOvBookTitle(""); setOvImprint(""); taRef.current?.focus(); };
  // ---- override cross-lead-contamination safeguard (Approach 2) ----
  // Overrides belong to the lead currently in Raw. A *whole-lead* replace/remove must clear them so they
  // can't carry into the next lead; a partial edit must NOT. Two event-based triggers, no empty-state check:
  const resetOverrides = () => { setOvFirst(""); setOvLast(""); setOvBookTitle(""); setOvImprint(""); };
  const onRawChange = (e) => {
    const next = e.target.value;
    // (a) deleting ALL raw text: non-empty -> empty transition (handles Ctrl+A then Delete/Backspace).
    if (raw !== "" && next === "") resetOverrides();
    setRaw(next);
  };
  const onRawPaste = (e) => {
    // (b) pasting over a full selection replaces the whole lead (handles Ctrl+A then Paste). onPaste fires
    // before the value changes, so selectionStart/End still describe what is about to be replaced.
    const el = e.currentTarget;
    if (el.value.length > 0 && el.selectionStart === 0 && el.selectionEnd === el.value.length) resetOverrides();
    // the pasted text still flows through onRawChange normally; no preventDefault.
  };
  const ovStyle = { width: "100%", fontSize: 12, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--field)", color: "var(--ink)", boxSizing: "border-box" };

  // Row export mode preference (export-format only; does not copy). Persists for the session, optionally across refresh.
  const chooseRowMode = (mode) => {
    setRowMode(mode);
    setRowMenuOpen(false);
    try { localStorage.setItem("mr_rowMode", mode); } catch {}
    setModeMsg(mode === "full" ? "Row mode: Full Name" : "Row mode: Separate Name");
    if (modeMsgTimer.current) clearTimeout(modeMsgTimer.current);
    modeMsgTimer.current = setTimeout(() => setModeMsg(""), 2600);
  };

  const vars = THEMES[theme].vars;

  // keyboard shortcuts (non-colliding): Ctrl/Cmd+Enter = copy row, +Shift = copy column. Parsing is live,
  // so there is no "parse" shortcut. actionRef keeps the latest handlers/flags to avoid stale closures.
  actionRef.current = { copyRow, copyCol, hasData };
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.key !== "Enter") return;
      const a = actionRef.current;
      if (!a.hasData) return;
      e.preventDefault();
      (e.shiftKey ? a.copyCol : a.copyRow)();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // PWA install: capture the browser's install prompt so we can offer an in-app button (only fires on supported browsers when installable)
  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setInstallEvt(e); };
    const onInstalled = () => setInstallEvt(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  // resizable input/output divider (desktop). Clamped 28–72%; session-only; stacks via CSS under 760px.
  const startDrag = (e) => {
    e.preventDefault();
    dragRef.current = true;
    document.body.style.userSelect = "none";
    const move = (ev) => {
      if (!dragRef.current || !wsRef.current) return;
      const r = wsRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - r.left) / r.width) * 100;
      setLeftPct(Math.max(28, Math.min(72, pct)));
    };
    const up = () => {
      dragRef.current = false;
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const statCards = [
    { label: "Records", value: fmt(stats.leads), icon: "inbox" },
    { label: "Fields Found", value: fmt(stats.fields), icon: "check" },
    { label: "Extracted", value: successRate == null ? "—" : successRate + "%", icon: "spark" },
  ];

  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
    .lx * { box-sizing: border-box; }
    .lx { font-family: 'Hanken Grotesk', sans-serif; color: var(--ink); -webkit-font-smoothing: antialiased; transition: background-color .45s ease, color .45s ease; }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .lx textarea, .lx button { font-family: inherit; outline: none; }
    .lx textarea { transition: border-color .18s, box-shadow .18s, background-color .45s ease; }
    .lx textarea:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 3px var(--focus); }
    .lbl { font-family: 'JetBrains Mono', monospace; font-size: 9.5px; letter-spacing: 1.2px; text-transform: uppercase; font-weight: 600; }
    .btn { cursor: pointer; border: none; display: inline-flex; align-items: center; gap: 7px; transition: background .18s, transform .1s, box-shadow .18s, border-color .18s, color .18s, opacity .18s; }
    .btn:active:not(:disabled) { transform: translateY(1px) scale(.99); }
    .btn:disabled { opacity: .4; cursor: not-allowed; }
    .pri { background: var(--accent); color: #fff; font-weight: 700; box-shadow: 0 5px 16px -6px var(--focus); }
    .pri:hover:not(:disabled) { background: var(--accent-deep); transform: translateY(-1px); box-shadow: 0 8px 20px -6px var(--focus); }
    .gho { background: var(--field); color: var(--ink); border: 1px solid var(--line); font-weight: 600; }
    .gho:hover:not(:disabled) { border-color: var(--ink); transform: translateY(-1px); }
    .pop { animation: pop .4s ease; }
    @keyframes pop { 0%{transform:scale(.92)} 45%{transform:scale(1.07)} 100%{transform:scale(1)} }
    .swatch { cursor:pointer; display:flex; align-items:center; gap:7px; padding:6px 11px 6px 8px; border-radius:9px; font-family:'JetBrains Mono',monospace; font-size:10.5px; font-weight:600; transition: background .2s, color .2s, border-color .2s, transform .14s, box-shadow .2s; }
    .swatch:hover { transform: translateY(-1px); }
    .dot { width:13px; height:13px; border-radius:50%; transition: transform .2s; }
    .swatch:hover .dot { transform: scale(1.18); }
    .stat { background: var(--field); border:1px solid var(--line); border-radius:12px; padding:8px 13px; display:flex; align-items:center; gap:9px; min-width:112px; flex:0 1 auto; transition: transform .2s, box-shadow .2s, border-color .2s, background-color .45s ease; }
    .stat:hover { transform: translateY(-2px); box-shadow: 0 12px 24px -16px rgba(0,0,0,.45); }
    .stat-ico { width:26px; height:26px; border-radius:8px; display:flex; align-items:center; justify-content:center; color: var(--accent); background: var(--focus); flex-shrink:0; }
    .stat .lbl { font-size: 9px; }
    .sheet-wrap { position: relative; transition: transform .25s ease; }
    .sheet-wrap::before, .sheet-wrap::after { content:''; position:absolute; inset:0; border-radius:7px; background: var(--note); box-shadow: 0 12px 26px -14px rgba(20,16,4,.4); transition: background-color .45s ease; }
    .sheet-wrap::before { transform: rotate(-1.5deg) translate(-6px,4px); opacity:.5; }
    .sheet-wrap::after { transform: rotate(1.1deg) translate(6px,6px); opacity:.32; }
    .sheet { position: relative; z-index:1; background: var(--note); border-radius:7px; padding: 24px 20px 18px; overflow:hidden; box-shadow: 0 1px 0 rgba(255,255,255,.45) inset, 0 26px 54px -18px rgba(20,16,4,.6), 0 6px 14px rgba(20,16,4,.2); transition: transform .25s ease, box-shadow .25s ease, background-color .45s ease; }
    .sheet::before { content:''; position:absolute; inset:0; pointer-events:none; opacity:.05; mix-blend-mode:multiply; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
    .sheet-wrap:hover { transform: translateY(-3px); }
    .sheet-wrap:hover .sheet { box-shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 36px 64px -18px rgba(20,16,4,.62), 0 8px 18px rgba(20,16,4,.24); }
    .tape { position:absolute; top:-12px; left:50%; width:122px; height:30px; transform: translateX(-50%) rotate(-2.2deg); background: linear-gradient(135deg, rgba(255,255,255,.55), rgba(255,255,255,.12) 55%, rgba(255,255,255,.32)); border:1px solid rgba(255,255,255,.35); border-radius:2px; box-shadow: 0 3px 8px rgba(0,0,0,.10); z-index:3; }
    .tape::after { content:''; position:absolute; left:16%; top:0; bottom:0; width:1px; background: rgba(255,255,255,.45); }
    .avatar { width:46px; height:46px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:16px; color:#fff; background: linear-gradient(135deg, var(--accent), var(--accent-deep)); box-shadow: 0 5px 14px -5px var(--focus); flex-shrink:0; }
    .pbar { height:8px; border-radius:99px; background: color-mix(in srgb, var(--note-line) 55%, transparent); overflow:hidden; }
    .pfill { height:100%; border-radius:99px; background: linear-gradient(90deg, var(--note-link), var(--accent)); transition: width .55s cubic-bezier(.4,0,.2,1); }
    .frow { display:flex; align-items:flex-start; gap:8px; padding:6px 8px; border-radius:8px; transition: background .15s; }
    .frow:hover { background: color-mix(in srgb, var(--note-line) 26%, transparent); }
    .fico { color: var(--note-label); margin-top:1px; }
    .chip { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:99px; font-size:11px; font-weight:700; }
    .srcchip { font-family:'JetBrains Mono',monospace; font-size:10.5px; font-weight:600; padding:5px 10px; border-radius:99px; border:1px solid var(--note-line); color:var(--note-ink); background: color-mix(in srgb, var(--note-line) 18%, transparent); transition: transform .15s; }
    .srcchip:hover { transform: translateY(-1px); }
    .divline { flex:1; height:1px; background: var(--note-line); opacity:.6; margin-left:4px; }
    .ws-divider { flex:0 0 auto; width:11px; align-self:stretch; cursor:col-resize; position:relative; touch-action:none; }
    .ws-divider::before { content:""; position:absolute; top:6px; bottom:6px; left:4px; right:4px; border-radius:6px; background: var(--line); opacity:.55; transition: opacity .15s, background-color .15s; }
    .ws-divider:hover::before, .ws-divider:active::before { opacity:1; background: var(--accent); }
    .statpill { display:inline-flex; align-items:center; gap:7px; font-size:11.5px; font-weight:600; padding:6px 11px; border-radius:99px; border:1px solid var(--line); background:var(--field); color:var(--ink-soft); white-space:nowrap; }
    .statpill.live { color:var(--ink); border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
    .statdot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
    .ovsug { align-self:flex-start; background:transparent; border:0; padding:1px 3px; margin:0; font-size:11px; line-height:1.3; color:var(--ink-soft); opacity:.7; cursor:pointer; }
    .ovsug:hover { opacity:1; text-decoration:underline; }
    @media (max-width: 760px) {
      .ws { flex-direction: column; }
      .ws .ws-pane { flex: 1 1 auto !important; width: 100%; }
      .ws-divider { display: none; }
      .ws textarea { height: 220px; }
    }
    @media (max-width: 600px) {
      .lx { padding: 14px !important; }
      .sheet { padding: 24px 16px 18px; }
      .swatch-label { display: none; }
      .swatch { gap: 0; padding: 7px; }
      .stat { min-width: 0; flex: 1 1 0; }
    }
    @keyframes fadeUp { from { opacity:0; transform: translateY(10px); } to { opacity:1; transform:none; } }
    @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
    @keyframes drawCheck { from { stroke-dashoffset: 30; } to { stroke-dashoffset: 0; } }
    .rise { animation: fadeUp .42s cubic-bezier(.2,.7,.3,1) both; }
    .fin { animation: fadeIn .42s ease both; }
    .ck path { stroke-dasharray: 30; animation: drawCheck .5s ease forwards; }
    @media (prefers-reduced-motion: reduce) { .lx *, .lx *::before, .lx *::after { animation: none !important; transition: none !important; } }
  `;

  return (
    <div className="lx" style={{ ...vars, background: "var(--bone)", minHeight: 600, padding: "clamp(16px,3vw,34px)" }}>
      <style>{css}</style>

      {/* header */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: 2, color: "var(--accent)", fontWeight: 700, textTransform: "uppercase" }}>Lead Extraction Workbench</div>
          <h1 style={{ margin: "2px 0 3px", fontSize: "clamp(24px,4vw,34px)", fontWeight: 800, letterSpacing: -1 }}><span style={{ color: "var(--accent)", marginRight: 6 }}>⛏</span>Jhunkenn's Mining Rig</h1>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-soft)" }}>Parse search results into structured lead data.</p>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {installEvt && (
            <button className="swatch" title="Install as desktop app"
              onClick={async () => { installEvt.prompt(); await installEvt.userChoice; setInstallEvt(null); }}
              style={{ background: "var(--accent)", color: "#fff", border: "1px solid var(--accent)" }}>
              <span style={{ fontSize: 11 }}>⤓</span><span className="swatch-label">Install App</span>
            </button>
          )}
          <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-soft)", padding: "5px 9px", borderRadius: 99, border: "1px solid var(--line)", background: "var(--field)" }}>v{VERSION}</span>
          <div style={{ position: "relative" }}>
            <button onClick={() => setThemeOpen((o) => !o)} title="Theme" aria-haspopup="listbox" aria-expanded={themeOpen} className="swatch"
              style={{ background: "var(--field)", color: "var(--ink)", border: "1px solid var(--line)" }}>
              <span className="dot" style={{ background: THEMES[theme].vars["--accent"], boxShadow: `inset 0 0 0 2px ${THEMES[theme].vars["--note"]}, 0 0 0 1px rgba(0,0,0,.08)` }} />
              <span className="swatch-label">{THEMES[theme].name}</span>
              <span style={{ fontSize: 9, opacity: .65, marginLeft: 1 }}>▾</span>
            </button>
            {themeOpen && (<>
              <div onClick={() => setThemeOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
              <div role="listbox" style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 41, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 10, padding: 5, minWidth: 152, boxShadow: "0 14px 32px -12px rgba(0,0,0,.4)" }}>
                {THEMES.map((t, i) => {
                  const active = theme === i;
                  return (
                    <button key={t.name} role="option" aria-selected={active} onClick={() => { setTheme(i); setThemeOpen(false); }}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", cursor: "pointer", border: "none", borderRadius: 7, padding: "7px 9px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, fontWeight: 600, background: active ? "var(--focus)" : "transparent", color: "var(--ink)" }}>
                      <span className="dot" style={{ background: t.vars["--accent"], boxShadow: `inset 0 0 0 2px ${t.vars["--note"]}, 0 0 0 1px rgba(0,0,0,.08)` }} />
                      <span style={{ flex: 1 }}>{t.name}</span>
                      {active && <span style={{ fontSize: 10, color: "var(--accent)" }}>✓</span>}
                    </button>
                  );
                })}
              </div>
            </>)}
          </div>
        </div>
      </div>

      {/* workspace */}
      <div ref={wsRef} className="ws" style={{ display: "flex", alignItems: "flex-start", gap: 18 }}>
        {/* input */}
        <div className="ws-pane" style={{ flex: `0 0 ${leftPct}%`, minWidth: 0 }}>
          <div className="lbl" style={{ color: "var(--ink-soft)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Paste Raw Search Data</span>
            <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ opacity: .65 }}>{raw ? raw.length.toLocaleString() + " chars" : ""}</span>
              <span title="Exclusion Library status" style={{ fontSize: 10.5, display: "inline-flex", alignItems: "center", gap: 4, color: (libStatus === "stale" || libStatus === "unavailable") ? "var(--accent)" : "var(--ink-soft)", opacity: .8 }}>
                {checkerLabel}
                {checkerConfigured && <button className="btn gho" style={{ fontSize: 10, padding: "2px 6px", borderRadius: 7, lineHeight: 1 }} onClick={fetchLibrary} disabled={libStatus === "loading"} title="Refresh Checker Library">⟳</button>}
              </span>
              <button className="btn gho" style={{ fontSize: 11.5, padding: "5px 12px", borderRadius: 9 }} onClick={clearAll} disabled={!canClear}>Clear</button>
              <button className="btn gho" style={{ fontSize: 11.5, padding: "5px 12px", borderRadius: 9, display: "inline-flex", alignItems: "center", gap: 5 }} onClick={() => setOvOpen((v) => !v)} aria-expanded={ovOpen} title="Manual override fields">
                Overrides
                {ovActive && <span aria-hidden="true" title="Overrides active" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", display: "inline-block" }} />}
                <span style={{ fontSize: 9, opacity: .7 }}>{ovOpen ? "▲" : "▼"}</span>
              </button>
            </span>
          </div>
          {ovOpen && (
            <div style={{ marginBottom: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "start" }}>
              <input value={ovFirst} onChange={(e) => setOvFirst(e.target.value)} placeholder="First Name" style={ovStyle} />
              <input value={ovLast} onChange={(e) => setOvLast(e.target.value)} placeholder="Last Name" style={ovStyle} />
              <input value={ovBookTitle} onChange={(e) => setOvBookTitle(e.target.value)} placeholder="Book Title" style={ovStyle} />
              <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <input value={ovImprint} onChange={(e) => setOvImprint(e.target.value)} placeholder="Imprint" style={ovStyle} />
                {!ovImprint.trim() && (
                  <button type="button" className="ovsug" onClick={() => setOvImprint("Independently Published")} title="Click to fill: Independently Published">↳ Independently Published</button>
                )}
              </div>
            </div>
          )}
          <textarea ref={taRef} value={raw} onChange={onRawChange} onPaste={onRawPaste} rows={24}
            placeholder="Paste a copied profile or book page here — Amazon, TruePeopleSearch, WhitePages, and more…"
            style={{ width: "100%", fontSize: 13, padding: 15, border: "1px solid var(--line)", borderRadius: 12, background: "var(--field)", color: "var(--ink)", resize: "vertical", lineHeight: 1.55 }} />
        </div>

        <div className="ws-divider" onPointerDown={startDrag} title="Drag to resize panels" />

        {/* output */}
        <div className="ws-pane" style={{ flex: "1 1 0", minWidth: 0 }}>
          {link && (
            <div style={{ marginBottom: urlMode ? 0 : 16, border: "1px solid var(--line)", borderRadius: 12, background: "var(--field)", padding: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                <span className="lbl" style={{ color: "var(--ink-soft)", display: "flex", alignItems: "center", gap: 7 }}>
                  <Icon name="link" size={13} />{link.kind === "amazon" ? "Amazon Link Cleaner" : "Link Cleaner"}
                </span>
                <button className={"btn pri" + (copied === "link" ? " pop" : "")} style={{ fontSize: 11.5, padding: "7px 12px", borderRadius: 9 }} onClick={copyClean} disabled={!!link.warning}>
                  <Icon name={copied === "link" ? "check" : "rows"} size={13} />{copied === "link" ? "Copied" : "Copy Clean Link"}
                </button>
              </div>
              {link.warning && <div style={{ fontSize: 11.5, color: "var(--accent)", fontWeight: 600, marginBottom: 10 }}>⚠ {link.warning}</div>}
              <div style={{ marginBottom: 8 }}>
                <div className="lbl" style={{ color: "var(--ink-soft)", fontSize: 8.5, marginBottom: 3 }}>Original</div>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-soft)", wordBreak: "break-all", lineHeight: 1.4 }}>{link.original}</div>
              </div>
              <div>
                <div className="lbl" style={{ color: "var(--ink-soft)", fontSize: 8.5, marginBottom: 3 }}>Clean</div>
                <div className="mono" style={{ fontSize: 12.5, color: "var(--ink)", fontWeight: 600, wordBreak: "break-all", lineHeight: 1.4 }}>{link.clean}</div>
              </div>
            </div>
          )}
          {!urlMode && (<>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 16 }}>
            <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
              <button className={"btn pri" + (copied === "row" ? " pop" : "")} style={{ fontSize: 12.5, padding: "10px 14px", borderRadius: "10px 0 0 10px" }} onClick={copyRow} disabled={!hasData} title="Copy Row Format">
                {copied === "row" ? <><Icon name="check" size={15} />Copied</> : "⧉ Row"}
              </button>
              <button className="btn pri" style={{ fontSize: 10, padding: "10px 9px", borderRadius: "0 10px 10px 0", borderLeft: "1px solid var(--line)" }} onClick={() => setRowMenuOpen((o) => !o)} title="Row name format" aria-haspopup="listbox" aria-expanded={rowMenuOpen}>▼</button>
              {rowMenuOpen && (<>
                <div onClick={() => setRowMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                <div role="listbox" style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41, background: "var(--paper)", border: "1px solid var(--line)", borderRadius: 10, padding: 5, minWidth: 188, boxShadow: "0 14px 32px -12px rgba(0,0,0,.4)" }}>
                  {[["separate", "Separate Name (Default)"], ["full", "Full Name"]].map(([val, label]) => {
                    const active = rowMode === val;
                    return (
                      <button key={val} role="option" aria-selected={active} onClick={() => chooseRowMode(val)}
                        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", cursor: "pointer", border: "none", borderRadius: 7, padding: "7px 9px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, fontWeight: 600, background: active ? "var(--focus)" : "transparent", color: "var(--ink)" }}>
                        <span style={{ flex: 1 }}>{label}</span>
                        {active && <span style={{ fontSize: 10, color: "var(--accent)" }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </>)}
            </div>
            <button className={"btn gho" + (copied === "col" ? " pop" : "")} style={{ fontSize: 12.5, padding: "10px 16px", borderRadius: 10 }} onClick={copyCol} disabled={!hasData} title="Copy Column Format">
              {copied === "col" ? <><Icon name="check" size={15} />Copied</> : "⧉ Column"}
            </button>
            {modeMsg && <span aria-live="polite" style={{ fontSize: 11, color: "var(--ink-soft)", opacity: .85 }}>{modeMsg}</span>}
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <span className={"statpill" + (hasData ? " live" : "")}>
                {hasData
                  ? <><span style={{ color: "var(--accent)", display: "inline-flex" }}><Icon name="check" size={12} /></span>{source || "Lead parsed"}</>
                  : <><span className="statdot" style={{ background: "#1faa6b" }} />Ready for Extraction</>}
              </span>
            </div>
          </div>


          {matches.length > 0 && (
            <div role="status" aria-live="polite" style={{ marginBottom: 12, border: "1px solid var(--accent)", background: "color-mix(in srgb, var(--accent) 10%, transparent)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)", marginBottom: 6, letterSpacing: .2 }}>⚠ Flagged by Checker Library</div>
              {matches.map((m, i) => (
                <div key={i} style={{ fontSize: 11.5, color: "var(--ink)", lineHeight: 1.5 }}>
                  Banned {m.type}: <strong>"{m.value}"</strong>{m.notes ? " — " + m.notes : ""}
                </div>
              ))}
            </div>
          )}
          <div style={{ color: "var(--ink-soft)", fontSize: 11, marginBottom: 12, lineHeight: 1.5 }}>
            Spreadsheet Tip: Paste copied rows starting in Column B (Name column) to maintain proper alignment.
          </div>

          <div className="sheet-wrap">
            <div className="tape" />
            <div className={"sheet " + (hasData ? "rise" : "fin")} key={hasData ? "data" : "empty"}>
              {hasData ? (
                <>
                  {/* name header + status */}
                  <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 15 }}>
                    <div className="avatar">{initials}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--note-ink)", lineHeight: 1.12, letterSpacing: -.3, wordBreak: "break-word" }}>{fullName || "Unnamed Lead"}</div>
                      <div style={{ marginTop: 7 }}>
                        <div key={populated} className="chip fin" style={{ color: "var(--note-link)", background: "color-mix(in srgb, var(--note-link) 14%, transparent)" }}>
                          <Icon name="check" size={12} className="ck" />
                          {completeness >= 70 ? `Lead Ready · ${populated} fields` : `${populated} field${populated === 1 ? "" : "s"} extracted`}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* lead quality */}
                  <div style={{ marginBottom: 18 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                      <span className="lbl" style={{ color: "var(--note-label)" }}>Extraction Coverage</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--note-ink)" }}>{completeness}% · {tier}</span>
                    </div>
                    <div className="pbar"><div className="pfill" style={{ width: completeness + "%" }} /></div>
                  </div>

                  {/* grouped sections */}
                  {SECTIONS.map((sec) => (
                    <div key={sec.title} style={{ marginBottom: 13 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ color: "var(--note-label)" }}><Icon name={sec.icon} size={13} /></span>
                        <span className="lbl" style={{ color: "var(--note-label)" }}>{sec.title}</span>
                        <span className="divline" />
                      </div>
                      {sec.fields.map((f) => {
                        const v = fieldVal(f.key);
                        const isPhone = f.key === "phone" || f.key === "otherPhone";
                        const flagged = f.key === "imprint" && imprintFlagged;
                        return (
                          <div className="frow" key={f.key} style={flagged ? { background: "color-mix(in srgb, var(--accent) 9%, transparent)", borderRadius: 8 } : undefined}>
                            <span className="fico"><Icon name={f.icon} size={14} /></span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div className="lbl" style={{ color: "var(--note-label)", marginBottom: 1, fontSize: 8.5, opacity: .85 }}>{f.label}</div>
                              {v ? (
                                f.link ? (
                                  <a href={v} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, color: "var(--note-link)", wordBreak: "break-all", textDecoration: "none" }}>{v}</a>
                                ) : (
                                  <div className={isPhone ? "mono" : ""} style={{ fontSize: isPhone ? 12.5 : 13.5, color: flagged ? "var(--accent)" : "var(--note-ink)", fontWeight: flagged ? 700 : 500, whiteSpace: "pre-wrap", lineHeight: 1.4, wordBreak: "break-word" }}>{v}</div>
                                )
                              ) : (
                                <div style={{ fontSize: 12.5, color: "var(--note-muted)" }}>—</div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}

                  <div className="mono" style={{ fontSize: 10, color: "var(--note-muted)", marginTop: 6, paddingTop: 10, borderTop: "1px dashed var(--note-line)", lineHeight: 1.6 }}>
                    Copy row → fills across · Copy column → fills down · 16 cells, blanks preserved
                  </div>
                </>
              ) : (
                /* empty state */
                <div style={{ textAlign: "center", padding: "30px 12px 24px" }}>
                  <div style={{ width: 56, height: 56, margin: "0 auto 16px", borderRadius: 15, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--note-label)", background: "color-mix(in srgb, var(--note-line) 32%, transparent)" }}>
                    <Icon name="inbox" size={27} />
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--note-ink)", marginBottom: 6 }}>Paste search results to begin</div>
                  <div style={{ fontSize: 12.5, color: "var(--note-muted)", marginBottom: 18, lineHeight: 1.5, maxWidth: 280, marginLeft: "auto", marginRight: "auto" }}>
                    Drop a copied profile or book page into the box on the left and the lead fields fill in automatically.
                  </div>
                  <div className="lbl" style={{ color: "var(--note-label)", marginBottom: 9 }}>Supported Sources</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
                    {SOURCES.map((s) => <span key={s} className="srcchip">{s}</span>)}
                  </div>
                </div>
              )}
            </div>
          </div>
          {hasData && (
            <div style={{ position: "sticky", bottom: 12, zIndex: 5, display: "flex", justifyContent: "flex-end", marginTop: 14, pointerEvents: "none" }}>
              <div style={{ display: "flex", gap: 8, padding: 7, borderRadius: 12, background: "var(--paper)", border: "1px solid var(--line)", boxShadow: "0 10px 28px -10px rgba(0,0,0,.35)", pointerEvents: "auto" }}>
                <button className={"btn gho" + (copied === "row" ? " pop" : "")} style={{ fontSize: 12, padding: "8px 14px", borderRadius: 9 }} onClick={copyRow} disabled={!hasData} title="Copy Row Format">
                  {copied === "row" ? <><Icon name="check" size={14} />Copied</> : "⧉ Row"}
                </button>
                <button className={"btn gho" + (copied === "col" ? " pop" : "")} style={{ fontSize: 12, padding: "8px 14px", borderRadius: 9 }} onClick={copyCol} disabled={!hasData} title="Copy Column Format">
                  {copied === "col" ? <><Icon name="check" size={14} />Copied</> : "⧉ Column"}
                </button>
                <button className="btn gho" style={{ fontSize: 12, padding: "8px 14px", borderRadius: 9 }} onClick={clearAll} disabled={!canClear} title="Clear Input and Results">Clear</button>
              </div>
            </div>
          )}
          </>)}
        </div>
      </div>
    </div>
  );
}
