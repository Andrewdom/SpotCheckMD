import { readFileSync } from "node:fs";
import { summarizeComparison } from "../lib/image-analysis/evaluation";
try {
  if (!process.argv[2]) throw Error("Missing reviewed comparison file");
  console.log(JSON.stringify(summarizeComparison(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2));
} catch { console.error("Invalid comparison annotations: supply complete, independently reviewed, nonnegative counts for all three variants per case. See evals/README.md."); process.exitCode = 1; }
