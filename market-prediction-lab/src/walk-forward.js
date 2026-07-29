function firstIndexAfter(records, startIndex, timestamp) {
  for (let index = startIndex; index < records.length; index += 1) if (records[index].anchorTimestamp > timestamp) return index;
  return records.length;
}

export function walkForwardSplit(rawRecords, options = {}) {
  if (!Array.isArray(rawRecords) || rawRecords.length < 20) throw new RangeError("at least 20 records are required");
  const trainRatio = options.trainRatio ?? 0.7;
  const validationRatio = options.validationRatio ?? 0.15;
  if (!(trainRatio > 0 && validationRatio > 0 && trainRatio + validationRatio < 1)) throw new RangeError("invalid split ratios");
  const records = [...rawRecords].sort((a, b) => a.anchorTimestamp - b.anchorTimestamp);
  const trainBoundary = Math.max(1, Math.floor(records.length * trainRatio));
  const validationBoundary = Math.max(trainBoundary + 1, Math.floor(records.length * (trainRatio + validationRatio)));
  const train = records.slice(0, trainBoundary);
  const maxTrainFuture = Math.max(...train.map((record) => record.futureEndTimestamp));
  const validationStart = firstIndexAfter(records, trainBoundary, maxTrainFuture);
  const validation = records.slice(validationStart, validationBoundary);
  if (validation.length === 0) throw new RangeError("validation split became empty after leakage purge");
  const maxValidationFuture = Math.max(...validation.map((record) => record.futureEndTimestamp));
  const testStart = firstIndexAfter(records, validationBoundary, maxValidationFuture);
  const test = records.slice(testStart);
  if (test.length === 0) throw new RangeError("test split became empty after leakage purge");
  return Object.freeze({
    train: Object.freeze(train),
    validation: Object.freeze(validation),
    test: Object.freeze(test),
    report: Object.freeze({
      total: records.length,
      train: train.length,
      validation: validation.length,
      test: test.length,
      purgedBetweenTrainValidation: validationStart - trainBoundary,
      purgedBetweenValidationTest: testStart - validationBoundary,
      trainLastFutureTimestamp: maxTrainFuture,
      validationFirstAnchorTimestamp: validation[0].anchorTimestamp,
      validationLastFutureTimestamp: maxValidationFuture,
      testFirstAnchorTimestamp: test[0].anchorTimestamp,
    }),
  });
}
