import React, { useState, useMemo } from "react";

// ---- phone extraction + filtering rules ----
function extractPhones(text) {
  // strict: requires real phone formatting (parens or separators) so bare ISBN/ASIN digit runs don't match
  const strict = /(?<!\d)(?:\+?1[\s.\-]?)?(?:\(\d{3}\)[\s.\-]*|\d{3}[\s.\-])\d{3}[\s.\-]\d{4}(?!\d)/g;
  // loose: only used on lines that clearly mention a phone
  const loose = /(?<!\d)(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g;
  // E.164: a literal "+" then 10–15 digits (e.g. +14044734789). The required leading "+" keeps bare
  // digit runs (ISBN/ASIN/etc.) from matching; the existing 10-digit check below filters anything longer.
  const e164 = /(?<!\d)\+\d{10,15}(?!\d)/g;
  const lines = text.split(/\r?\n/);
  const seen = new Set(), out = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/\b(isbn|asin|upc|ean|sku)\b/i.test(line)) continue; // ignore product identifiers
    const re = /\b(phone|tel|mobile|cell|fax|call)\b/i.test(line) ? loose : strict;
    for (const m of [...(line.match(re) || []), ...(line.match(e164) || [])]) {
      let d = m.replace(/\D/g, "");
      if (d.length === 11 && d[0] === "1") d = d.slice(1);
      if (d.length !== 10 || seen.has(d)) continue; // dedupe by 10-digit number
      seen.add(d);
      // auto-detect type + year from this line, borrowing the next line only if it isn't another number
      const nextL = lines[li + 1] || "";
      const nextHasPhone = /(?<!\d)\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/.test(nextL);
      const ctx = (line + (nextHasPhone ? "" : " " + nextL)).toLowerCase();
      let type = "Unknown";
      if (/\b(wireless|mobile|cell|cellular)\b/.test(ctx)) type = "Mobile";
      else if (/\b(landline|land\s*line|home|residential|wire\s?line|wired)\b/.test(ctx)) type = "Landline";
      const ym = ctx.match(/\b(?:19|20)\d{2}\b/);
      out.push({ digits: d, display: `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`, type, year: ym ? parseInt(ym[0]) : null });
    }
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
  const personOK = (s, min) => { const w = clean(s).split(/\s+/); return w.length >= min && w.length <= 3 && !company.test(s); };
  // 1) strongest signal: a name immediately before "(Author)"
  const tagged = text.match(/([A-Z][A-Za-z'’.\-]*(?:[ \t]+[A-Z][A-Za-z'’.\-]*){0,2})[ \t]*\(\s*authors?\s*\)/i);
  if (tagged && personOK(tagged[1], 1)) return clean(tagged[1]);
  // 2) "by NAME" — but not "sold by", "shipped by", "published by", etc.
  const badBefore = /(sold|ship|ships|shipped|fulfil|fulfill|fulfilled|dispatch|dispatched|publish|published|distribute|distributed|market|marketed|power|powered|deliver|delivered|import|imported|present|presented|narrate|narrated|illustrate|illustrated|edit|edited|translate|translated|produce|produced|gone|goes|known)$/i;
  const re = /\bby[ \t]+([A-Z][A-Za-z'’.\-]*(?:[ \t]+[A-Z][A-Za-z'’.\-]*){1,2})/gi;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const lastWord = (before.match(/([A-Za-z]+)[\s:>\-]*$/) || [, ""])[1];
    if (badBefore.test(lastWord)) continue;
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
    if (/\(\s*authors?\s*\)/i.test(l) || /^by[ \t]+[A-Z]/.test(l)) {
      for (let j = i - 1; j >= 0 && j >= i - 3; j--) { if (lines[j] && !isJunk(lines[j])) { push(lines[j], 75); break; } }
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
  const linkedin = urls.find((u) => /linkedin\.com/i.test(u)) || "";
  const amazon = urls.find((u) => /amazon\./i.test(u)) || urls.find((u) => /(goodreads|barnesandnoble)/i.test(u)) || "";
  const website = urls.find((u) => !/linkedin\.com|amazon\.|goodreads|barnesandnoble/i.test(u)) || "";

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

  // Imprint / Publisher / Published by / Publishing — strip any trailing "(date)" so it stays just the imprint
  let imprint = labeled(/^(imprint|publisher|publishing|published\s*by|published)\b/i);
  imprint = imprint.replace(/\s*\([^)]*\b(?:19|20)\d{2}\b[^)]*\)\s*$/, "").trim();
  if (!imprint) imprint = find(/independently published/i);

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

  const DISQUALIFY = /\b(fair credit|skip to (?:the )?main content|join prime)\b/i;
  const nameL = find(/^name\s*:/i);
  let name = nameL ? after(nameL) : "";
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
  if (!name) {
    const junk = /@|\d|http|phone|address|property|book|publish|imprint|amazon|value|email|street|linkedin|website|skip|sign|cart|account|menu|search|deliver|return|order|deal|customer|review|department|hello|select|content|main|home|gift|prime|wish|follow|share|\bbuy\b|price|stock|seller|ship|format|edition|paperback|hardcover|kindle|audible|rating|star|barnes|noble|\bby\b/i;
    const nameRe = /^[A-Z][A-Za-z'’.\-]*(?:\s+[A-Z][A-Za-z'’.\-]*){1,2}$/;
    name = lines.slice(0, leadEnd).find((l) => nameRe.test(l) && !junk.test(l) && !DISQUALIFY.test(l)) || "";
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
  if (/truepeoplesearch/i.test(t)) return "TruePeopleSearch";
  if (/whitepages/i.test(t)) return "WhitePages";
  if (/canada\s?411/i.test(t)) return "Canada411";
  if (/goodreads/i.test(t)) return "Goodreads";
  if (/barnes\s*&?\s*noble|barnesandnoble/i.test(t)) return "Barnes & Noble";
  if (/amazon\.[a-z]|\bASIN\b|\(\s*authors?\s*\)|kindle\s+direct\s+publishing/i.test(t)) return "Amazon Author Page";
  return "";
}

export default function App() {
  const [raw, setRaw] = useState("");
  const [copied, setCopied] = useState("");
  const [theme, setTheme] = useState(0);
  const [stats, setStats] = useState({ leads: 0, fields: 0, ready: 0 });

  const rec = useMemo(() => parse(raw), [raw]);
  const built = useMemo(() => buildPhones(rec.phones), [rec.phones]);
  const source = useMemo(() => detectSource(raw), [raw]);

  // ---- copy: UNCHANGED 16-cell SLOTS order + clipboard payload ----
  const valueOf = (slot) => {
    if (slot.blank) return "";
    if (slot.key === "phone") return built[0]?.display || "";
    if (slot.key === "otherPhone") return built.slice(1).map((n) => n.display).join(", ");
    return rec[slot.key] || "";
  };
  const cells = useMemo(() => SLOTS.map(valueOf), [rec, built]);

  // value for a single field key (for the grouped display only)
  const fieldVal = (key) => {
    if (key === "phone") return built[0]?.display || "";
    if (key === "otherPhone") return built.slice(1).map((n) => n.display).join(", ");
    return rec[key] || "";
  };

  const populated = FIELDS.filter((k) => fieldVal(k)).length;
  const completeness = Math.round((populated / FIELDS.length) * 100);
  const hasData = populated > 0;
  const tier = completeness >= 90 ? "Complete" : completeness >= 70 ? "Strong" : completeness >= 40 ? "Good" : "Sparse";
  const fullName = [rec.firstName, rec.lastName].filter(Boolean).join(" ").trim();
  const initials = ((rec.firstName?.[0] || "") + (rec.lastName?.[0] || "")).toUpperCase() || "—";
  const fmt = (n) => n.toLocaleString();
  const successRate = stats.leads ? Math.round((stats.ready / stats.leads) * 100) : null;

  const flash = (k) => { setCopied(k); setTimeout(() => setCopied(""), 1600); };
  const tally = () => setStats((s) => ({ leads: s.leads + 1, fields: s.fields + populated, ready: s.ready + (completeness >= 70 ? 1 : 0) }));
  const copyRow = async () => {
    const plain = cells.map(q).join("\t");
    const html = `<table><tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr></table>`;
    if (await clip(plain, html)) { flash("row"); tally(); }
  };
  const copyCol = async () => {
    const plain = cells.map(q).join("\n");
    const html = `<table>${cells.map((c) => `<tr><td>${esc(c)}</td></tr>`).join("")}</table>`;
    if (await clip(plain, html)) { flash("col"); tally(); }
  };

  const vars = THEMES[theme].vars;
  const statCards = [
    { label: "Leads Processed", value: fmt(stats.leads), icon: "inbox" },
    { label: "Fields Extracted", value: fmt(stats.fields), icon: "check" },
    { label: "Success Rate", value: successRate == null ? "—" : successRate + "%", icon: "spark" },
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
    .stat { background: var(--field); border:1px solid var(--line); border-radius:12px; padding:9px 15px; display:flex; align-items:center; gap:11px; min-width:128px; flex:0 1 auto; transition: transform .2s, box-shadow .2s, border-color .2s, background-color .45s ease; }
    .stat:hover { transform: translateY(-2px); box-shadow: 0 12px 24px -16px rgba(0,0,0,.45); }
    .stat-ico { width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center; color: var(--accent); background: var(--focus); flex-shrink:0; }
    .sheet-wrap { position: relative; transition: transform .25s ease; }
    .sheet-wrap::before, .sheet-wrap::after { content:''; position:absolute; inset:0; border-radius:7px; background: var(--note); box-shadow: 0 12px 26px -14px rgba(20,16,4,.4); transition: background-color .45s ease; }
    .sheet-wrap::before { transform: rotate(-1.5deg) translate(-6px,4px); opacity:.5; }
    .sheet-wrap::after { transform: rotate(1.1deg) translate(6px,6px); opacity:.32; }
    .sheet { position: relative; z-index:1; background: var(--note); border-radius:7px; padding: 30px 24px 22px; overflow:hidden; box-shadow: 0 1px 0 rgba(255,255,255,.45) inset, 0 26px 54px -18px rgba(20,16,4,.6), 0 6px 14px rgba(20,16,4,.2); transition: transform .25s ease, box-shadow .25s ease, background-color .45s ease; }
    .sheet::before { content:''; position:absolute; inset:0; pointer-events:none; opacity:.05; mix-blend-mode:multiply; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"); }
    .sheet-wrap:hover { transform: translateY(-3px); }
    .sheet-wrap:hover .sheet { box-shadow: 0 1px 0 rgba(255,255,255,.6) inset, 0 36px 64px -18px rgba(20,16,4,.62), 0 8px 18px rgba(20,16,4,.24); }
    .tape { position:absolute; top:-12px; left:50%; width:122px; height:30px; transform: translateX(-50%) rotate(-2.2deg); background: linear-gradient(135deg, rgba(255,255,255,.55), rgba(255,255,255,.12) 55%, rgba(255,255,255,.32)); border:1px solid rgba(255,255,255,.35); border-radius:2px; box-shadow: 0 3px 8px rgba(0,0,0,.10); z-index:3; }
    .tape::after { content:''; position:absolute; left:16%; top:0; bottom:0; width:1px; background: rgba(255,255,255,.45); }
    .avatar { width:46px; height:46px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:16px; color:#fff; background: linear-gradient(135deg, var(--accent), var(--accent-deep)); box-shadow: 0 5px 14px -5px var(--focus); flex-shrink:0; }
    .pbar { height:8px; border-radius:99px; background: color-mix(in srgb, var(--note-line) 55%, transparent); overflow:hidden; }
    .pfill { height:100%; border-radius:99px; background: linear-gradient(90deg, var(--note-link), var(--accent)); transition: width .55s cubic-bezier(.4,0,.2,1); }
    .frow { display:flex; align-items:flex-start; gap:10px; padding:7px 8px; border-radius:8px; transition: background .15s; }
    .frow:hover { background: color-mix(in srgb, var(--note-line) 26%, transparent); }
    .fico { color: var(--note-label); margin-top:1px; }
    .chip { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:99px; font-size:11px; font-weight:700; }
    .srcchip { font-family:'JetBrains Mono',monospace; font-size:10.5px; font-weight:600; padding:5px 10px; border-radius:99px; border:1px solid var(--note-line); color:var(--note-ink); background: color-mix(in srgb, var(--note-line) 18%, transparent); transition: transform .15s; }
    .srcchip:hover { transform: translateY(-1px); }
    .divline { flex:1; height:1px; background: var(--note-line); opacity:.6; margin-left:4px; }
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
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: 2, color: "var(--accent)", fontWeight: 700, textTransform: "uppercase" }}>Lead Extraction Workbench</div>
          <h1 style={{ margin: "5px 0 4px", fontSize: "clamp(24px,4vw,34px)", fontWeight: 800, letterSpacing: -1 }}><span style={{ color: "var(--accent)", marginRight: 6 }}>⛏</span>Jhunkenn's Mining Rig</h1>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-soft)" }}>Parse search results into structured lead data.</p>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 10, fontWeight: 600, color: "var(--ink-soft)", padding: "5px 9px", borderRadius: 99, border: "1px solid var(--line)", background: "var(--field)" }}>v{VERSION}</span>
          {THEMES.map((t, i) => {
            const active = theme === i;
            return (
              <button key={t.name} onClick={() => setTheme(i)} title={t.name} className="swatch"
                style={{ background: active ? "var(--ink)" : "var(--field)", color: active ? "var(--bone)" : "var(--ink)",
                  border: `1px solid ${active ? "var(--ink)" : "var(--line)"}`, boxShadow: active ? "0 6px 16px -6px var(--focus)" : "none" }}>
                <span className="dot" style={{ background: t.vars["--accent"], boxShadow: `inset 0 0 0 2px ${t.vars["--note"]}, 0 0 0 1px rgba(0,0,0,.08)` }} />
                {t.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* session statistics */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 24 }}>
        {statCards.map((s) => (
          <div key={s.label} className="stat">
            <span className="stat-ico"><Icon name={s.icon} size={16} /></span>
            <div>
              <div className="lbl" style={{ color: "var(--ink-soft)" }}>{s.label}</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 700, marginTop: 1 }}>{s.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* workspace */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 24, alignItems: "start" }}>
        {/* input */}
        <div style={{ minWidth: 0 }}>
          <div className="lbl" style={{ color: "var(--ink-soft)", marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>Paste Search Results</span>
            <span style={{ opacity: .65 }}>{raw ? raw.length.toLocaleString() + " chars" : ""}</span>
          </div>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={24}
            placeholder="Paste a copied profile or book page here — Amazon, TruePeopleSearch, WhitePages, and more…"
            style={{ width: "100%", fontSize: 13, padding: 15, border: "1px solid var(--line)", borderRadius: 12, background: "var(--field)", color: "var(--ink)", resize: "vertical", lineHeight: 1.55 }} />
        </div>

        {/* output */}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 16 }}>
            <button className={"btn pri" + (copied === "row" ? " pop" : "")} style={{ fontSize: 12.5, padding: "10px 16px", borderRadius: 10 }} onClick={copyRow} disabled={!hasData}>
              <Icon name={copied === "row" ? "check" : "rows"} size={15} />{copied === "row" ? "Copied" : "Copy row"}
            </button>
            <button className={"btn gho" + (copied === "col" ? " pop" : "")} style={{ fontSize: 12.5, padding: "10px 16px", borderRadius: 10 }} onClick={copyCol} disabled={!hasData}>
              <Icon name={copied === "col" ? "check" : "cols"} size={15} />{copied === "col" ? "Copied" : "Copy column"}
            </button>
          </div>

          <div className="sheet-wrap">
            <div className="tape" />
            <div className={"sheet " + (hasData ? "rise" : "fin")} key={hasData ? "data" : "empty"}>
              {hasData ? (
                <>
                  {/* name header + status */}
                  <div style={{ display: "flex", alignItems: "center", gap: 13, marginBottom: 18 }}>
                    <div className="avatar">{initials}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: "var(--note-ink)", lineHeight: 1.12, letterSpacing: -.3, wordBreak: "break-word" }}>{fullName || "Unnamed Lead"}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 7 }}>
                        <div key={populated} className="chip fin" style={{ color: "var(--note-link)", background: "color-mix(in srgb, var(--note-link) 14%, transparent)" }}>
                          <Icon name="check" size={12} className="ck" />
                          {completeness >= 70 ? `Lead Ready · ${populated} fields` : `${populated} field${populated === 1 ? "" : "s"} extracted`}
                        </div>
                        {source && (
                          <div className="chip fin" style={{ fontWeight: 600, color: "var(--note-label)", background: "color-mix(in srgb, var(--note-line) 22%, transparent)" }}>
                            <Icon name="check" size={11} /> {source}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* lead quality */}
                  <div style={{ marginBottom: 22 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <span className="lbl" style={{ color: "var(--note-label)" }}>Lead Quality</span>
                      <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--note-ink)" }}>{completeness}% · {tier}</span>
                    </div>
                    <div className="pbar"><div className="pfill" style={{ width: completeness + "%" }} /></div>
                  </div>

                  {/* grouped sections */}
                  {SECTIONS.map((sec) => (
                    <div key={sec.title} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                        <span style={{ color: "var(--note-label)" }}><Icon name={sec.icon} size={13} /></span>
                        <span className="lbl" style={{ color: "var(--note-label)" }}>{sec.title}</span>
                        <span className="divline" />
                      </div>
                      {sec.fields.map((f) => {
                        const v = fieldVal(f.key);
                        const isPhone = f.key === "phone" || f.key === "otherPhone";
                        return (
                          <div className="frow" key={f.key}>
                            <span className="fico"><Icon name={f.icon} size={14} /></span>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div className="lbl" style={{ color: "var(--note-label)", marginBottom: 1, fontSize: 8.5, opacity: .85 }}>{f.label}</div>
                              {v ? (
                                f.link ? (
                                  <a href={v} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, color: "var(--note-link)", wordBreak: "break-all", textDecoration: "none" }}>{v}</a>
                                ) : (
                                  <div className={isPhone ? "mono" : ""} style={{ fontSize: isPhone ? 12.5 : 13.5, color: "var(--note-ink)", fontWeight: 500, whiteSpace: "pre-wrap", lineHeight: 1.4, wordBreak: "break-word" }}>{v}</div>
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

                  <div className="mono" style={{ fontSize: 10, color: "var(--note-muted)", marginTop: 8, paddingTop: 12, borderTop: "1px dashed var(--note-line)", lineHeight: 1.6 }}>
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
        </div>
      </div>
    </div>
  );
}
