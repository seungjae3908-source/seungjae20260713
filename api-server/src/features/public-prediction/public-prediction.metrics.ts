import { dominantPredictionDirection } from './public-prediction.service';
import type { PredictionDirection, PredictionOutcomeEvent, PublicPredictionRecord } from './public-prediction.types';

export interface CalibrationBucket {
  label: string;
  lowerInclusive: number;
  upperExclusive: number | null;
  samples: number;
  meanForecastProbability: number | null;
  observedAccuracy: number | null;
}

export interface PredictionPerformanceSummary {
  samples: number;
  directionAccuracy: number | null;
  brierScore: number | null;
  calibrationBuckets: CalibrationBucket[];
}

const BUCKETS: Array<Omit<CalibrationBucket, 'samples' | 'meanForecastProbability' | 'observedAccuracy'>> = [
  { label: '<50%', lowerInclusive: 0, upperExclusive: 0.5 },
  { label: '50-55%', lowerInclusive: 0.5, upperExclusive: 0.55 },
  { label: '55-60%', lowerInclusive: 0.55, upperExclusive: 0.6 },
  { label: '60-65%', lowerInclusive: 0.6, upperExclusive: 0.65 },
  { label: '65-70%', lowerInclusive: 0.65, upperExclusive: 0.7 },
  { label: '70-75%', lowerInclusive: 0.7, upperExclusive: 0.75 },
  { label: '75-80%', lowerInclusive: 0.75, upperExclusive: 0.8 },
  { label: '80%+', lowerInclusive: 0.8, upperExclusive: null },
];

function oneHot(direction: PredictionDirection): Record<PredictionDirection, number> {
  return {
    UP: direction === 'UP' ? 1 : 0,
    DOWN: direction === 'DOWN' ? 1 : 0,
    SIDEWAYS: direction === 'SIDEWAYS' ? 1 : 0,
  };
}

function multiclassBrier(prediction: PublicPredictionRecord, outcome: PredictionOutcomeEvent): number {
  const truth = oneHot(outcome.actualDirection);
  return (
    (prediction.probabilities.UP - truth.UP) ** 2 +
    (prediction.probabilities.DOWN - truth.DOWN) ** 2 +
    (prediction.probabilities.SIDEWAYS - truth.SIDEWAYS) ** 2
  );
}

export function summarizePredictionPerformance(
  predictions: PublicPredictionRecord[],
  outcomes: PredictionOutcomeEvent[],
): PredictionPerformanceSummary {
  const outcomeByPrediction = new Map(outcomes.map((outcome) => [outcome.predictionId, outcome]));
  const realized = predictions
    .map((prediction) => ({ prediction, outcome: outcomeByPrediction.get(prediction.predictionId) }))
    .filter((entry): entry is { prediction: PublicPredictionRecord; outcome: PredictionOutcomeEvent } => Boolean(entry.outcome));

  const bucketRows = BUCKETS.map((bucket) => ({ ...bucket, probabilities: [] as number[], correct: [] as number[] }));
  let correct = 0;
  let brierTotal = 0;

  for (const { prediction, outcome } of realized) {
    const predictedDirection = dominantPredictionDirection(prediction.probabilities);
    const probability = prediction.probabilities[predictedDirection];
    const hit = predictedDirection === outcome.actualDirection ? 1 : 0;
    correct += hit;
    brierTotal += multiclassBrier(prediction, outcome);

    const bucket = bucketRows.find((row) =>
      probability >= row.lowerInclusive && (row.upperExclusive === null || probability < row.upperExclusive));
    if (bucket) {
      bucket.probabilities.push(probability);
      bucket.correct.push(hit);
    }
  }

  return {
    samples: realized.length,
    directionAccuracy: realized.length ? correct / realized.length : null,
    brierScore: realized.length ? brierTotal / realized.length : null,
    calibrationBuckets: bucketRows.map(({ probabilities, correct: hits, ...bucket }) => ({
      ...bucket,
      samples: probabilities.length,
      meanForecastProbability: probabilities.length
        ? probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length
        : null,
      observedAccuracy: hits.length ? hits.reduce((sum, value) => sum + value, 0) / hits.length : null,
    })),
  };
}

export function predictionGapPercentagePoints(historicalAccuracy: number | null, realtimeAccuracy: number | null): number | null {
  if (historicalAccuracy === null || realtimeAccuracy === null) return null;
  if (![historicalAccuracy, realtimeAccuracy].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) return null;
  return Number(((realtimeAccuracy - historicalAccuracy) * 100).toFixed(10));
}

export interface DriftAssessment {
  status: 'INSUFFICIENT_DATA' | 'STABLE' | 'MODEL_DRIFT_WARNING';
  recentSamples: number;
  historicalAccuracy: number;
  recentAccuracy: number | null;
  dropPercentagePoints: number | null;
}

export function assessModelDrift(input: {
  historicalAccuracy: number;
  recentOutcomes: PredictionOutcomeEvent[];
  minimumRecentSamples: number;
  warningDropPercentagePoints: number;
}): DriftAssessment {
  const { historicalAccuracy, recentOutcomes, minimumRecentSamples, warningDropPercentagePoints } = input;
  if (!Number.isFinite(historicalAccuracy) || historicalAccuracy < 0 || historicalAccuracy > 1) {
    throw new Error('HISTORICAL_ACCURACY_INVALID');
  }
  if (!Number.isInteger(minimumRecentSamples) || minimumRecentSamples <= 0) throw new Error('MINIMUM_SAMPLE_INVALID');
  if (!Number.isFinite(warningDropPercentagePoints) || warningDropPercentagePoints < 0) throw new Error('DRIFT_THRESHOLD_INVALID');

  if (recentOutcomes.length < minimumRecentSamples) {
    return {
      status: 'INSUFFICIENT_DATA',
      recentSamples: recentOutcomes.length,
      historicalAccuracy,
      recentAccuracy: null,
      dropPercentagePoints: null,
    };
  }

  const recentAccuracy = recentOutcomes.filter((outcome) => outcome.correct).length / recentOutcomes.length;
  const dropPercentagePoints = (historicalAccuracy - recentAccuracy) * 100;
  return {
    status: dropPercentagePoints >= warningDropPercentagePoints ? 'MODEL_DRIFT_WARNING' : 'STABLE',
    recentSamples: recentOutcomes.length,
    historicalAccuracy,
    recentAccuracy,
    dropPercentagePoints,
  };
}
