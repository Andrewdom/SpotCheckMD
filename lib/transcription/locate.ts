import type { TranscriptArtifact, TranscriptEvidence, TranscriptUtterance } from "./types";

// Pure helpers with no Node imports, so client components can use them.
export function formatTimestamp(milliseconds: number) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function transcriptText(utterances: TranscriptUtterance[]) {
  return utterances.map(utterance => `${utterance.speaker} [${formatTimestamp(utterance.startMs)}]: ${utterance.text}`).join("\n");
}

export function locateTranscriptEvidence(artifact: TranscriptArtifact | undefined, quote: string): TranscriptEvidence | undefined {
  if (!artifact || !quote.trim()) return;
  for (const utterance of artifact.utterances) {
    const quoteStart = utterance.text.indexOf(quote);
    if (quoteStart < 0) continue;
    const quoteEnd = quoteStart + quote.length;
    let cursor = 0;
    const positions = utterance.words.map(word => {
      const start = utterance.text.indexOf(word.text, cursor);
      if (start < 0) return null;
      cursor = start + word.text.length;
      return { start, end: cursor };
    });
    const selected = positions.flatMap((position, index) => position && position.end > quoteStart && position.start < quoteEnd ? [index] : []);
    const first = selected.length ? utterance.words[selected[0]] : undefined;
    const last = selected.length ? utterance.words[selected[selected.length - 1]] : undefined;
    return {
      artifactId: artifact.id,
      utteranceId: utterance.id,
      speaker: utterance.speaker,
      startMs: first?.startMs ?? utterance.startMs,
      endMs: last?.endMs ?? utterance.endMs,
      wordStart: selected.length ? selected[0] : null,
      wordEnd: selected.length ? selected[selected.length - 1] : null,
    };
  }
}
