export function downsampleToPCM16(input: Float32Array, inputRate: number, outputRate = 16000) {
  if (!Number.isFinite(inputRate) || inputRate < outputRate || outputRate <= 0) throw new Error("Unsupported audio sample rate");
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let source = start; source < end; source++) sum += input[source];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output.buffer;
}
