import { dominantPredictionDirection } from './public-prediction.service';
import type {
  PredictionDirection,
  PredictionOutcomeEvent,
  PublicPredictionRecord,
  SimulatedTradingOutcome,
} from './public-prediction.types';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertSimulation(outcome: SimulatedTradingOutcome | null, expectedMode: 'PAPER' | 'SHADOW'): void {
  if (!outcome) return;
  if (outcome.mode !== expectedMode) throw new Error(`${expectedMode}_OUTCOME_MODE_MISMATCH`);
  if (!Number.isFinite(outcome.return)) throw new Error(`${expectedMode}_OUTCOME_RETURN_INVALID`);
}

export interface AppendOutcomeInput {
  outcomeEventId: string;
  predictionId: string;
  observedAt: string;
  actualReturn: number;
  actualDirection: PredictionDirection;
  paperOutcome?: SimulatedTradingOutcome | null;
  shadowOutcome?: SimulatedTradingOutcome | null;
}

export class InMemoryPredictionLedger {
  readonly #predictions = new Map<string, PublicPredictionRecord>();
  readonly #outcomes = new Map<string, PredictionOutcomeEvent>();
  readonly #outcomeByPrediction = new Map<string, string>();

  appendPrediction(prediction: PublicPredictionRecord): PublicPredictionRecord {
    if (this.#predictions.has(prediction.predictionId)) throw new Error('PREDICTION_ALREADY_EXISTS');
    this.#predictions.set(prediction.predictionId, clone(prediction));
    return clone(prediction);
  }

  appendOutcome(input: AppendOutcomeInput): PredictionOutcomeEvent {
    if (this.#outcomes.has(input.outcomeEventId)) throw new Error('OUTCOME_EVENT_ALREADY_EXISTS');
    if (this.#outcomeByPrediction.has(input.predictionId)) throw new Error('PREDICTION_ALREADY_REALIZED');

    const prediction = this.#predictions.get(input.predictionId);
    if (!prediction) throw new Error('PREDICTION_NOT_FOUND');

    const observedAt = Date.parse(input.observedAt);
    const predictedAt = Date.parse(prediction.timestamp);
    if (!Number.isFinite(observedAt) || !Number.isFinite(predictedAt) || observedAt < predictedAt) {
      throw new Error('OUTCOME_TIMESTAMP_INVALID');
    }
    if (!Number.isFinite(input.actualReturn)) throw new Error('ACTUAL_RETURN_INVALID');

    const paperOutcome = input.paperOutcome ?? null;
    const shadowOutcome = input.shadowOutcome ?? null;
    assertSimulation(paperOutcome, 'PAPER');
    assertSimulation(shadowOutcome, 'SHADOW');

    const event: PredictionOutcomeEvent = {
      outcomeEventId: input.outcomeEventId,
      predictionId: input.predictionId,
      observedAt: input.observedAt,
      actualReturn: input.actualReturn,
      actualDirection: input.actualDirection,
      correct: dominantPredictionDirection(prediction.probabilities) === input.actualDirection,
      paperOutcome: paperOutcome ? clone(paperOutcome) : null,
      shadowOutcome: shadowOutcome ? clone(shadowOutcome) : null,
    };

    this.#outcomes.set(event.outcomeEventId, clone(event));
    this.#outcomeByPrediction.set(event.predictionId, event.outcomeEventId);
    return clone(event);
  }

  getPrediction(predictionId: string): PublicPredictionRecord | null {
    const record = this.#predictions.get(predictionId);
    return record ? clone(record) : null;
  }

  getOutcomeForPrediction(predictionId: string): PredictionOutcomeEvent | null {
    const outcomeId = this.#outcomeByPrediction.get(predictionId);
    if (!outcomeId) return null;
    const event = this.#outcomes.get(outcomeId);
    return event ? clone(event) : null;
  }

  listPredictions(): PublicPredictionRecord[] {
    return [...this.#predictions.values()].map(clone);
  }

  listOutcomes(): PredictionOutcomeEvent[] {
    return [...this.#outcomes.values()].map(clone);
  }
}
