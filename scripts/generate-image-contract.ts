import { writeFileSync, mkdirSync } from "node:fs";
import { z } from "zod";
import { imageAnalysisSchema } from "../lib/image-analysis/contracts";
import { imageInstructions } from "../lib/image-analysis/prompt";
mkdirSync("contracts", { recursive: true });
writeFileSync("contracts/image-analysis.schema.json", JSON.stringify(z.toJSONSchema(imageAnalysisSchema), null, 2) + "\n");
writeFileSync("contracts/image-instructions.txt", imageInstructions + "\n");
