import { readFile } from "node:fs/promises";
import type { Encounter } from "./domain";
import { suggest } from "./analysis";
import { PROMPT_VERSION } from "./image-analysis/contracts";
import { configuredImageProvider } from "./image-analysis/providers";
import { analyzeEncounter } from "./image-analysis/pipeline";
import { AppError, changed, mediaPath, transaction } from "./store";
import { configuredTranscriptionProvider, transcriptionModel } from "./transcription/providers";
import { soapDocumentationMode } from "./transcription/soap";

type ClaimedJob = { snapshot: Encounter; runId: string };
const globalJobs = globalThis as unknown as { spotcheckAnalysisWorker?: Promise<void>; spotcheckAnalysisStarted?: boolean };

async function claimNextJob(): Promise<ClaimedJob | null> {
  return transaction(db => {
    const now = Date.now();
    for (const encounter of db.encounters) {
      if (encounter.analysis !== "running" || !encounter.activeAnalysis) continue;
      if (encounter.activeAnalysis.expiresAt <= now) {
        encounter.analysis = "failed";
        encounter.analysisError = "The queued analysis expired before it could complete. Retry the authorized demonstration inputs.";
        encounter.activeAnalysis = undefined;
        changed(encounter, "analysis queue expired");
      }
    }
    const encounter = db.encounters
      .filter(item => item.analysis === "running" && item.activeAnalysis?.status === "queued")
      .sort((a, b) => a.activeAnalysis!.queuedAt.localeCompare(b.activeAnalysis!.queuedAt))[0];
    if (!encounter?.activeAnalysis) return null;
    encounter.activeAnalysis.status = "processing";
    encounter.activeAnalysis.startedAt = new Date().toISOString();
    encounter.activeAnalysis.attempts += 1;
    return { snapshot: structuredClone(encounter), runId: encounter.activeAnalysis.id };
  });
}

async function ensureCurrent(snapshot: Encounter, runId: string) {
  return transaction(db => {
    const encounter = db.encounters.find(item => item.id === snapshot.id && item.owner === snapshot.owner);
    if (!encounter || encounter.revision !== snapshot.revision || !encounter.consent || !encounter.patientConfirmed || encounter.activeAnalysis?.id !== runId || encounter.activeAnalysis.status !== "processing" || encounter.activeAnalysis.expiresAt <= Date.now()) {
      throw new AppError(409, "Analysis was cancelled or expired. Review the current encounter and retry.");
    }
  });
}

async function processJob({ snapshot, runId }: ClaimedJob) {
  try {
    const result = await analyzeEncounter(snapshot, runId, {
      provider: configuredImageProvider,
      transcriber: configuredTranscriptionProvider,
      document: soapDocumentationMode() === "extractive" ? async () => [] : (transcript, specialty) => suggest([], transcript, specialty),
      readMedia: source => readFile(mediaPath(source.mediaId!)),
      ensureCurrent: () => ensureCurrent(snapshot, runId),
    });
    await ensureCurrent(snapshot, runId);
    await transaction(db => {
      const encounter = db.encounters.find(item => item.id === snapshot.id && item.owner === snapshot.owner);
      if (!encounter || encounter.revision !== snapshot.revision || encounter.activeAnalysis?.id !== runId || !encounter.consent || !encounter.patientConfirmed) throw new AppError(409, "Analysis superseded.");
      encounter.sources.push(...result.newSources);
      encounter.transcripts = [...(encounter.transcripts || []), ...result.newTranscripts];
      const retained = encounter.findings.filter(finding => finding.origin === "clinician" || finding.review !== "pending");
      const retainedIds = new Set(retained.map(finding => finding.id));
      encounter.findings = [...retained, ...result.findings];
      encounter.conflicts = [...encounter.conflicts.filter(conflict => conflict.findingIds.every(id => retainedIds.has(id))), ...result.conflicts];
      encounter.imageAnalyses = [...(encounter.imageAnalyses || []), ...result.analyses];
      encounter.analysisWarnings = result.warnings;
      encounter.warningsAcknowledged = false;
      encounter.analysis = result.findings.length || result.analyses.length ? "ready" : "failed";
      const hasTranscript = encounter.sources.some(source => source.kind === "transcript");
      const transcriptionFailed = result.warnings.some(warning => warning.startsWith("Audio transcription failed"));
      const medgemmaFailure = result.warnings.find(warning => warning.includes("MedGemma"));
      encounter.analysisError = encounter.analysis !== "failed" ? ""
        : medgemmaFailure || (hasTranscript && soapDocumentationMode() === "extractive"
          ? "The finalized doctor-dictation transcript is available. In free local mode, add clinician-authored findings manually and choose their SOAP sections."
          : hasTranscript
            ? "The finalized transcript is available, but SOAP suggestions were not generated. Check the OpenAI SOAP-extraction configuration or add a clinician observation."
            : transcriptionFailed
              ? "The audio was saved, but transcription failed. Check the provider settings and confirm the recording contains only doctor dictation before retrying."
              : "No new findings were generated. Review analysis warnings or add a supported manual observation.");
      encounter.activeAnalysis = undefined;
      encounter.model = [...new Set([
        ...result.analyses.map(analysis => analysis.model),
        ...(encounter.transcripts || []).map(transcriptionModel),
        ...(result.findings.some(finding => finding.origin === "spoken") ? ["gpt-4o (transcript documentation)"] : []),
      ].filter(Boolean))].join(" + ");
      encounter.promptVersion = PROMPT_VERSION;
      changed(encounter, "analysis completed");
    });
  } catch {
    try {
      await transaction(db => {
        const encounter = db.encounters.find(item => item.id === snapshot.id && item.owner === snapshot.owner);
        if (encounter?.activeAnalysis?.id === runId) {
          encounter.analysis = "failed";
          encounter.activeAnalysis = undefined;
          encounter.analysisError = "Analysis failed or was interrupted. Retry with authorized demonstration inputs.";
          changed(encounter, "analysis failed");
        }
      });
    } catch {
      // Leave the persisted processing record intact when storage is unavailable.
      // Startup recovery will return it to the queue after storage is restored.
    }
  }
}

async function drainQueue() {
  for (;;) {
    const job = await claimNextJob();
    if (!job) return;
    await processJob(job);
  }
}

export function kickAnalysisWorker() {
  if (!globalJobs.spotcheckAnalysisWorker) {
    const work = (async () => {
      await drainQueue();
      // Close the narrow handoff window where an enqueue observes the old
      // worker just as its first drain finishes.
      await new Promise(resolve => setTimeout(resolve, 0));
      await drainQueue();
    })();
    globalJobs.spotcheckAnalysisWorker = work.finally(() => { globalJobs.spotcheckAnalysisWorker = undefined; });
  }
  return globalJobs.spotcheckAnalysisWorker;
}

export async function waitForAnalysisWorker() {
  while (globalJobs.spotcheckAnalysisWorker) await globalJobs.spotcheckAnalysisWorker;
}

export async function startAnalysisWorker() {
  if (globalJobs.spotcheckAnalysisStarted) return kickAnalysisWorker();
  globalJobs.spotcheckAnalysisStarted = true;
  try {
    await transaction(db => {
      for (const encounter of db.encounters) {
        if (encounter.analysis === "running" && encounter.activeAnalysis && encounter.activeAnalysis.status !== "queued") {
          encounter.activeAnalysis.status = "queued";
          encounter.activeAnalysis.startedAt = undefined;
          encounter.activeAnalysis.queuedAt ||= new Date().toISOString();
          encounter.activeAnalysis.attempts ||= 0;
          encounter.analysisError = "The server restarted; this analysis was safely returned to the queue.";
        }
      }
    });
    return kickAnalysisWorker();
  } catch {
    globalJobs.spotcheckAnalysisStarted = false;
  }
}
