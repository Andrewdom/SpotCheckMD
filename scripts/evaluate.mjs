import { readFileSync } from 'node:fs';
const file = process.argv[2];
if (!file) { console.error('Usage: node scripts/evaluate.mjs evals/reviewed-cases.json'); process.exit(2); }
const cases = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(cases) || !cases.length) throw new Error('Provide an array of human-reviewed synthetic or licensed cases.');
const groups = new Map();
for (const c of cases) {
  if (!c.reviewed || !Number.isInteger(c.expected) || !Number.isInteger(c.supported) || !Number.isInteger(c.unsupported) || !Number.isInteger(c.missed) || !Number.isInteger(c.corrected) || !Number.isInteger(c.totalTranscriptTerms) || !Number.isInteger(c.missedTranscriptTerms)) throw new Error(`Case ${c.id}: missing human review counts.`);
  for (const [dimension, value] of Object.entries({ skinTone: c.skinTone, lighting: c.lighting, accent: c.accent, terminology: c.terminology })) {
    if (!value) throw new Error(`Case ${c.id}: missing ${dimension} label (use 'not-applicable' explicitly).`);
    const key = `${dimension}=${value}`;
    const row = groups.get(key) || { n: 0, expected: 0, supported: 0, unsupported: 0, missed: 0, corrected: 0, terms: 0, missedTerms: 0 };
    row.n++; row.expected += c.expected; row.supported += c.supported; row.unsupported += c.unsupported; row.missed += c.missed; row.corrected += c.corrected; row.terms += c.totalTranscriptTerms; row.missedTerms += c.missedTranscriptTerms;
    groups.set(key, row);
  }
}
console.log('Group\tN\tUnsupported rate\tMissed rate\tCorrection rate\tTerm error rate');
for (const [key, row] of [...groups].sort((a,b) => a[0].localeCompare(b[0]))) {
  const pct = (a,b) => b ? `${(a/b*100).toFixed(1)}%` : 'N/A';
  console.log([key, row.n, pct(row.unsupported, row.supported+row.unsupported), pct(row.missed,row.expected), pct(row.corrected,row.supported+row.unsupported), pct(row.missedTerms,row.terms)].join('\t'));
}
