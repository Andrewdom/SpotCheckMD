import { AppError } from "../store";

export function soapDocumentationMode() {
  const configured = (process.env.SOAP_DOCUMENTATION_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "extractive")).toLowerCase();
  if (configured !== "openai" && configured !== "extractive") throw new AppError(503, "Unknown SOAP_DOCUMENTATION_PROVIDER. Choose openai or extractive explicitly.");
  return configured;
}
