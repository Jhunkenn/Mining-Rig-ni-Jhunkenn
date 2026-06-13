#!/usr/bin/env node
/* eslint-disable */
/**
 * Author-name extraction — permanent regression suite.
 * ----------------------------------------------------
 * Runs the real authorName() + splitName() from src/App.jsx against the corpus
 * of bylines validated during development (standard / middle / initials /
 * suffixes / quoted nicknames / accented / hyphenated / apostrophes / corporate
 * / title-bleed guards / spacing / cross-source rules).
 *
 *   Run:  npm test           (from the mining-rig-app/ folder)
 *   or:   node test/authorName.test.cjs
 *
 * No dependencies. Exits 0 if every case passes, 1 on any failure (CI-friendly).
 *
 * The two functions are pure JS but live inside a .jsx file we can't `require`
 * directly, so we read them out of the source by brace-matching. If extraction
 * ever fails the suite errors loudly — that is intentional, it means the source
 * structure changed and the suite needs a glance.
 *
 * Adding a case: drop a { line, author, first?, last? } object into the right
 * group below. `author` is the expected authorName() output; first/last are
 * optional and, when present, also assert splitName() of that output.
 */

const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src", "App.jsx");
const src = fs.readFileSync(SRC, "utf8");

// --- pull a top-level `function NAME(...) { ... }` out of the source text ---
function grab(name) {
  const sig = "function " + name + "(";
  const i = src.indexOf(sig);
  if (i === -1) throw new Error("Could not find function " + name + " in " + SRC);
  // skip the parameter list (paren-match) so default-param braces don't fool us
  let k = i + sig.length - 1, pd = 0;
  for (; k < src.length; k++) {
    if (src[k] === "(") pd++;
    else if (src[k] === ")") { pd--; if (pd === 0) { k++; break; } }
  }
  // now brace-match the body (regex quantifiers like {0,2} are balanced, so safe)
  let b = src.indexOf("{", k), d = 0, j = b;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) { j++; break; } }
  }
  return src.slice(i, j);
}

eval([grab("authorName"), grab("splitName")].join("\n\n"));

// --- test corpus, grouped ---------------------------------------------------
const GROUPS = {
  "Standard names": [
    { line: "by Jane Smith (Author)", author: "Jane Smith", first: "Jane", last: "Smith" },
    { line: "by Michael Johnson (Author)", author: "Michael Johnson" },
    { line: "Sarah Connor (Author)", author: "Sarah Connor" },
  ],
  "Middle names": [
    { line: "by John Michael Smith (Author)", author: "John Michael Smith", first: "John Michael", last: "Smith" },
    { line: "by Mary Anne Wilson (Author)", author: "Mary Anne Wilson" },
  ],
  "Initials": [
    { line: "by A.G. Riddle (Author)", author: "A.G. Riddle", first: "A.G.", last: "Riddle" },
    { line: "by D. Anthony Miles (Author)", author: "D. Anthony Miles" },
    { line: "by J. K. Rowling (Author)", author: "J. K. Rowling" },
    { line: "Arlinda L Hanna (Author)", author: "Arlinda L Hanna" },
    { line: "by J.R.R. Tolkien (Author)", author: "J.R.R. Tolkien" },
  ],
  "Suffixes (3-token)": [
    { line: "by John Smith Jr. (Author)", author: "John Smith Jr.", first: "John", last: "Smith Jr." },
    { line: "by William Carter III (Author)", author: "William Carter III" },
    { line: "by Jane Doe PhD (Author)", author: "Jane Doe PhD" },
    { line: "by Robert Downey Jr (Author)", author: "Robert Downey Jr" },
  ],
  "Suffixes (4-token, Tier-4 fix)": [
    { line: "by Clarence E. Stowers Jr. (Author)", author: "Clarence E. Stowers Jr.", first: "Clarence E.", last: "Stowers Jr." },
    { line: "by Robert Lee Frost Jr. (Author)", author: "Robert Lee Frost Jr." },
    { line: "by John A. Smith III (Author)", author: "John A. Smith III" },
    { line: "by Mary Anne Wilson Sr. (Author)", author: "Mary Anne Wilson Sr." },
    { line: "by John Smith MD (Author)", author: "John Smith MD" },
    { line: "by William Carter IV (Author)", author: "William Carter IV" },
  ],
  "Quoted nicknames": [
    { line: 'by John "Jack" Smith (Author)', author: 'John "Jack" Smith', first: 'John "Jack"', last: "Smith" },
    { line: 'by Kelecia "Kai" Patterson (Author)', author: 'Kelecia "Kai" Patterson', first: 'Kelecia "Kai"', last: "Patterson" },
    { line: 'by William "Bill" Gates (Author)', author: 'William "Bill" Gates' },
    { line: "by Edward \u201CTeddy\u201D Roosevelt (Author)", author: "Edward \u201CTeddy\u201D Roosevelt" }, // curly quotes
    { line: 'by J. "Jay" Adams (Author)', author: 'J. "Jay" Adams' },
    { line: 'by Robert "Bob" Johnson Jr. (Author)', author: 'Robert "Bob" Johnson Jr.', first: 'Robert "Bob"', last: "Johnson Jr." }, // quoted + suffix
  ],
  "Accented / diacritic": [
    { line: "by José Saramago (Author)", author: "José Saramago", first: "José", last: "Saramago" },
    { line: "by Gabriel García Márquez (Author)", author: "Gabriel García Márquez", first: "Gabriel García", last: "Márquez" },
    { line: "by Elena Núñez (Author)", author: "Elena Núñez" },
    { line: "by Renée Ahdieh (Author)", author: "Renée Ahdieh" },
    { line: "by Søren Kierkegaard (Author)", author: "Søren Kierkegaard" },
    { line: "by Charlotte Brontë (Author)", author: "Charlotte Brontë" },
    { line: "by Anaïs Nin (Author)", author: "Anaïs Nin" },
    { line: "by Åsne Seierstad (Author)", author: "Åsne Seierstad" },
    { line: "by Émile Zola (Author)", author: "Émile Zola" }, // accented first letter
    { line: "by Karel Čapek (Author)", author: "Karel Čapek" }, // Latin Extended-A
    { line: "by Czesław Miłosz (Author)", author: "Czesław Miłosz" },
  ],
  "Hyphenated": [
    { line: "by Mary-Kate Olsen (Author)", author: "Mary-Kate Olsen" },
    { line: "by Jean-Luc Picard (Author)", author: "Jean-Luc Picard" },
  ],
  "Apostrophes": [
    { line: "by Flannery O'Connor (Author)", author: "Flannery O'Connor" },
    { line: "by Conan O'Brien (Author)", author: "Conan O'Brien" },
  ],
  "Corporate (must blank)": [
    { line: "by Dorrance Publishing Co. (Author)", author: "" },
    { line: "by Penguin Random House (Author)", author: "" },
    { line: "by Legion Books (Author)", author: "" },
    { line: "Lieferung über Amazon (Author)", author: "" }, // accented + company guard
  ],
  "Title-bleed guards (name only, no title words)": [
    { line: "Winter World by A.G. Riddle (Author)", author: "A.G. Riddle" },
    { line: "Kindle Edition by John Smith (Author)", author: "John Smith" },
    { line: "Hardcover Edition by Jane Smith (Author)", author: "Jane Smith" },
    { line: "New Release by Jane Smith (Author)", author: "Jane Smith" },
    { line: "Best Seller by Mark Twain (Author)", author: "Mark Twain" },
    { line: "The Great Gatsby by F. Scott Fitzgerald (Author)", author: "F. Scott Fitzgerald" },
  ],
  "Case & spacing": [
    { line: "BY JANE SMITH (AUTHOR)", author: "JANE SMITH" },
    { line: "by Jane Smith ( Author )", author: "Jane Smith" },
    { line: "by  Jane   Smith  (Author)", author: "Jane Smith" },
  ],
  "Cross-source rules (after-paren / by-loop)": [
    { line: "(Author): Jane Smith", author: "Jane Smith" },                 // Lulu after-paren
    { line: 'by John "Jack" Smith', author: 'John "Jack" Smith' },          // by-loop, no (Author) tag
    { line: "by A.G. Riddle", author: "A.G. Riddle" },
  ],
};

// --- runner -----------------------------------------------------------------
const run = (line) => { const an = authorName(line); const s = splitName(an); return { an, first: s.firstName, last: s.lastName }; };
const J = (v) => JSON.stringify(v);

let total = 0, passed = 0;
const failures = [];

for (const [group, cases] of Object.entries(GROUPS)) {
  console.log("\n" + group);
  for (const c of cases) {
    total++;
    const r = run(c.line);
    const checks = [["author", r.an, c.author]];
    if (c.first !== undefined) checks.push(["First", r.first, c.first]);
    if (c.last !== undefined) checks.push(["Last", r.last, c.last]);
    const bad = checks.filter(([, got, exp]) => got !== exp);
    if (bad.length === 0) {
      passed++;
      console.log("  \u2713 " + c.line);
    } else {
      const detail = bad.map(([k, got, exp]) => `${k}: got ${J(got)} exp ${J(exp)}`).join("; ");
      console.log("  \u2717 " + c.line + "  ->  " + detail);
      failures.push({ line: c.line, detail });
    }
  }
}

console.log("\n" + "-".repeat(60));
console.log(`  ${passed}/${total} passed` + (failures.length ? `, ${failures.length} FAILED` : "  \u2014  all green"));
if (failures.length) {
  console.log("\nFAILURES:");
  for (const f of failures) console.log("  - " + f.line + "  (" + f.detail + ")");
  process.exit(1);
}
process.exit(0);
