import { randomBytes } from "node:crypto";
import type { Finding } from "../domain";
import { AppError } from "../store";
import { locateTranscriptEvidence, type TranscriptArtifact, type TranscriptRoles } from "./types";

const uid = () => randomBytes(16).toString("hex");

export function soapDocumentationMode() {
  const configured = (process.env.SOAP_DOCUMENTATION_PROVIDER || (process.env.OPENAI_API_KEY ? "openai" : "extractive")).toLowerCase();
  if (configured !== "openai" && configured !== "extractive") throw new AppError(503, "Unknown SOAP_DOCUMENTATION_PROVIDER. Choose openai or extractive explicitly.");
  return configured;
}

function atomicQuotes(text: string) {
  return (text.match(/[^.!?]+[.!?]?/g) || [text])
    .map(value => value.trim())
    .filter(value => value.length >= 3 && value.length <= 460);
}

export function extractiveSubjectiveFindings(artifact: TranscriptArtifact, patientSpeaker: string, roles?: TranscriptRoles): Finding[] {
  if (!artifact.utterances.some(utterance => utterance.speaker === patientSpeaker)) throw new AppError(400, "Choose a speaker present in this transcript.");
  const confirmed = roles?.artifactId === artifact.id && roles.patientSpeaker === patientSpeaker;
  return artifact.utterances
    .filter(utterance => utterance.speaker === patientSpeaker)
    .flatMap(utterance => atomicQuotes(utterance.text))
    .slice(0, 20)
    .map(quote => ({
      id: uid(), section: "S" as const,
      text: `${confirmed ? "Patient reported" : "Recorded statement"}: “${quote}”`,
      originalText: `${confirmed ? "Patient reported" : "Recorded statement"}: “${quote}”`,
      origin: "spoken" as const, certainty: "observed" as const,
      limitation: confirmed
        ? "Free local extractive mode preserves the exact patient-attributed wording; it does not summarize, diagnose, or determine clinical significance."
        : "Free local extractive mode preserves exact wording, but speaker identity is unconfirmed. Verify attribution and meaning before acceptance.",
      evidence: [{ sourceId: artifact.transcriptSourceId, quote, role: "spoken" as const, transcript: locateTranscriptEvidence(artifact, quote) }],
      review: "pending" as const, reviewNote: "", provider: "local-extractive-transcript",
    }));
}
