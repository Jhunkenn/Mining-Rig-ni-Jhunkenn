import React, { useState, useMemo } from "react";

// ---- phone extraction + filtering rules ----
function extractPhones(text) {
  // strict: requires real phone formatting (parens or separators) so bare ISBN/ASIN digit runs don't match
  const strict = /(?<!\d)(?:\+?1[\s.\-]?)?(?:\(\d{3}\)[\s.\-]*|\d{3}[\s.\-])\d{3}[\s.\-]\d{4}(?!\d)/g;
  // loose: only used on lines that clearly mention a phone
  const loose = /(?<!\d)(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g;
  const lines = text.split(/\r?\n/);
  const seen = new Set(), out = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/\b(isbn|asin|upc|ean|sku)\b/i.test(line)) continue; // ignore product identifiers
    const re = /\b(phone|tel|mobile|cell|fax|call)\b/i.test(line) ? loose : strict;
    for (const m of line.match(re) || []) {
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
  const tagged = text.match(/([A-Z][A-Za-z'’.\-]+(?:[ \t]+[A-Z][A-Za-z'’.\-]+){0,2})[ \t]*\(\s*authors?\s*\)/i);
  if (tagged && personOK(tagged[1], 1)) return clean(tagged[1]);
  // 2) "by NAME" — but not "sold by", "shipped by", "published by", etc.
  const badBefore = /(sold|ship|ships|shipped|fulfil|fulfill|fulfilled|dispatch|dispatched|publish|published|distribute|distributed|market|marketed|power|powered|deliver|delivered|import|imported|present|presented|narrate|narrated|illustrate|illustrated|edit|edited|translate|translated|produce|produced)$/i;
  const re = /\bby[ \t]+([A-Z][A-Za-z'’.\-]+(?:[ \t]+[A-Z][A-Za-z'’.\-]+){1,2})/gi;
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
      cands.push({ e, score });
    }
  }
  if (!cands.length) return "";
  cands.sort((a, b) => b.score - a.score);
  return cands[0].score >= 20 ? cands[0].e : ""; // below threshold -> blank, never guess
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
  const looksAddr = (l) => !!l && !notAddr.test(l) && (/^\d{1,6}\s+\w/.test(l) || zip.test(l) || /,\s*[A-Z]{2}\b/.test(l) || streetWords.test(l));
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
      if (!zip.test(lines[idx]) && looksAddr(next) && (zip.test(next || "") || /,\s*[A-Z]{2}\b/.test(next || ""))) parts.push(next);
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
    const psName = /^([A-Z][A-Za-z'’.\-]+(?:\s+[A-Z][A-Za-z'’.\-]+){1,2})$/;
    const psInline = /^([A-Z][A-Za-z'’.\-]+(?:\s+[A-Z][A-Za-z'’.\-]+){1,2})\s+(?:age|address|born|dob|date\s+of\s+birth)\b/i;
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

export default function App() {
  const [raw, setRaw] = useState("");
  const [copied, setCopied] = useState("");

  const rec = useMemo(() => parse(raw), [raw]);
  const built = useMemo(() => buildPhones(rec.phones), [rec.phones]);

  const valueOf = (slot) => {
    if (slot.blank) return "";
    if (slot.key === "phone") return built[0]?.display || "";
    if (slot.key === "otherPhone") return built.slice(1).map((n) => n.display).join(", ");
    return rec[slot.key] || "";
  };
  const cells = useMemo(() => SLOTS.map(valueOf), [rec, built]);

  const copyRow = async () => {
    const plain = cells.map(q).join("\t");
    const html = `<table><tr>${cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr></table>`;
    if (await clip(plain, html)) flash("row");
  };
  const copyCol = async () => {
    const plain = cells.map(q).join("\n");
    const html = `<table>${cells.map((c) => `<tr><td>${esc(c)}</td></tr>`).join("")}</table>`;
    if (await clip(plain, html)) flash("col");
  };
  const flash = (k) => { setCopied(k); setTimeout(() => setCopied(""), 1600); };

  const [theme, setTheme] = useState(0);
  const vars = THEMES[theme].vars;
  const css = `
    @import url('https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');
    .lx * { box-sizing: border-box; }
    .lx { font-family: 'Hanken Grotesk', sans-serif; color: var(--ink); }
    .mono { font-family: 'JetBrains Mono', monospace; }
    .lx textarea, .lx select, .lx input, .lx button { font-family: inherit; outline: none; }
    .lx textarea:focus, .lx input:focus, .lx select:focus { border-color: var(--accent) !important; box-shadow: 0 0 0 3px var(--focus); }
    .btn { cursor: pointer; border: none; transition: background .15s, transform .08s; }
    .btn:active { transform: translateY(1px); }
    .pri { background: var(--accent); color: #fff; font-weight: 700; }
    .pri:hover { background: var(--accent-deep); }
    .gho { background: var(--field); color: var(--ink); border: 1px solid var(--line); font-weight: 600; }
    .gho:hover { border-color: var(--ink); }
    .lbl { font-family: 'JetBrains Mono', monospace; font-size: 9.5px; letter-spacing: 1.2px; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; }
  `;

  return (
    <div className="lx" style={{ ...vars, background: "var(--bone)", minHeight: 600, padding: "clamp(16px,3vw,32px)" }}>
      <style>{css}</style>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 2, color: "var(--accent)", fontWeight: 700, textTransform: "uppercase" }}>Lead Tools</div>
          <h1 style={{ margin: "4px 0 0", fontSize: "clamp(24px,4vw,34px)", fontWeight: 800, letterSpacing: -1 }}>Jhunkenn's Mining Rig</h1>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {THEMES.map((t, i) => (
            <button key={t.name} onClick={() => setTheme(i)} title={t.name} className="btn"
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 8,
                background: theme === i ? "var(--ink)" : "var(--field)", color: theme === i ? "var(--bone)" : "var(--ink)",
                border: `1px solid ${theme === i ? "var(--ink)" : "var(--line)"}`,
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 600 }}>
              <span style={{ width: 11, height: 11, borderRadius: "50%", background: t.vars["--accent"], boxShadow: `inset 0 0 0 2px ${t.vars["--note"]}` }} />
              {t.name}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(310px,1fr))", gap: 22, alignItems: "start" }}>
        {/* input */}
        <div style={{ minWidth: 0 }}>
          <div className="lbl" style={{ marginBottom: 6 }}>Paste everything from your search tool</div>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={22}
            placeholder="Paste your copied search results here…"
            style={{ width: "100%", fontSize: 13, padding: 14, border: "1px solid var(--line)", borderRadius: 10, background: "var(--field)", color: "var(--ink)", resize: "vertical", lineHeight: 1.55 }} />
        </div>

        {/* output: sticky note + copy controls */}
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 16 }}>
            <button className="btn pri" style={{ fontSize: 12.5, padding: "10px 16px", borderRadius: 9 }} onClick={copyRow}>{copied === "row" ? "Copied ✓" : "Copy → row"}</button>
            <button className="btn gho" style={{ fontSize: 12.5, padding: "10px 16px", borderRadius: 9 }} onClick={copyCol}>{copied === "col" ? "Copied ✓" : "Copy ↓ column"}</button>
          </div>

          <div style={{ position: "relative", paddingTop: 10 }}>
            <div style={{ position: "absolute", top: 0, left: "50%", transform: "translateX(-50%) rotate(-2deg)", width: 96, height: 26, background: "rgba(255,255,255,.55)", border: "1px solid rgba(0,0,0,.05)", borderRadius: 2, zIndex: 2 }} />
            <div style={{ transform: "rotate(-.6deg)", background: "var(--note)", borderRadius: 4, padding: "24px 22px 20px", boxShadow: "0 14px 30px -10px rgba(40,33,10,.4), 0 2px 6px rgba(40,33,10,.15)" }}>
              {SLOTS.map((slot, idx) => {
                if (slot.blank) {
                  return <div key={idx} style={{ height: 14, borderBottom: "1px dashed var(--note-line)", opacity: .5 }} />;
                }
                const v = valueOf(slot);
                const isLink = ["amazon", "website", "linkedin"].includes(slot.key);
                return (
                  <div key={idx} style={{ padding: "8px 0", borderBottom: idx < SLOTS.length - 1 ? "1px dashed var(--note-line)" : "none" }}>
                    <div className="lbl" style={{ color: "var(--note-label)", marginBottom: 2 }}>{slot.label}</div>
                    {v ? (
                      isLink ? (
                        <a href={v} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: 11.5, color: "var(--note-link)", wordBreak: "break-all", textDecoration: "none" }}>{v}</a>
                      ) : (
                        <div className={slot.key === "phone" || slot.key === "otherPhone" ? "mono" : ""} style={{ fontSize: slot.key.includes("hone") ? 13 : 14.5, fontWeight: (slot.key === "firstName" || slot.key === "lastName") ? 700 : 500, whiteSpace: "pre-wrap", lineHeight: 1.45, wordBreak: "break-word", color: "var(--note-ink)" }}>{v}</div>
                      )
                    ) : (
                      <div style={{ fontSize: 13, color: "var(--note-muted)" }}>—</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mono" style={{ fontSize: 10.5, color: "var(--ink-soft)", marginTop: 14, lineHeight: 1.6 }}>
            16 cells in your exact order · blanks kept in position so columns never shift · row → fills across · column → fills down
          </div>
        </div>
      </div>
    </div>
  );
}
