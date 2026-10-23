export type RawSample = {
  /** Monotonic sample index or timestamp-derived index, assigned by the adapter. */
  index: number;
  /** Raw detector reading in device-defined units. Never assume this is HbO2/HbR. */
  intensity: number;
};

export type SampleValidation = {
  valid: boolean;
  reason?: "non-finite-index" | "non-finite-intensity" | "negative-intensity";
};

/** Validate a sample without silently altering the recorded value. */
export function validateRawSample(sample: RawSample): SampleValidation {
  if (!Number.isFinite(sample.index)) return { valid: false, reason: "non-finite-index" };
  if (!Number.isFinite(sample.intensity)) return { valid: false, reason: "non-finite-intensity" };
  if (sample.intensity < 0) return { valid: false, reason: "negative-intensity" };
  return { valid: true };
}

/**
 * Trailing moving average. This is a simple smoothing primitive, not a substitute
 * for a filter chosen from the device's sampling rate and experimental design.
 */
export function movingAverage(values: readonly number[], windowSize: number): number[] {
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new RangeError("windowSize must be a positive integer");
  }
  const output: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= windowSize) sum -= values[i - windowSize];
    output.push(sum / Math.min(i + 1, windowSize));
  }
  return output;
}

/**
 * First-order low-pass filter. Provide the real sampling rate and cutoff frequency.
 * The cutoff must be positive and below Nyquist; do not guess these parameters.
 */
export function lowPassFilter(
  values: readonly number[],
  samplingRateHz: number,
  cutoffHz: number,
): number[] {
  if (!Number.isFinite(samplingRateHz) || samplingRateHz <= 0) {
    throw new RangeError("samplingRateHz must be positive");
  }
  if (!Number.isFinite(cutoffHz) || cutoffHz <= 0 || cutoffHz >= samplingRateHz / 2) {
    throw new RangeError("cutoffHz must be positive and below the Nyquist frequency");
  }
  if (values.length === 0) return [];
  const dt = 1 / samplingRateHz;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  const output = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    output.push(output[i - 1] + alpha * (values[i] - output[i - 1]));
  }
  return output;
}
