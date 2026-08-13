-- Signal Performance Learning V1 + Profit-First V2 runtime evidence
-- Draft migration only. Do not execute against Production as part of this feature PR.
-- Recommendation exposure/outcome records are append-only evidence and have no execution authority.

CREATE TABLE IF NOT EXISTS signal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  market text NOT NULL CHECK (market IN ('KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES')),
  symbol text NOT NULL,
  symbol_name text,
  strategy_horizon text NOT NULL CHECK (strategy_horizon IN ('SCALP','SWING','POSITION')),
  direction text NOT NULL CHECK (direction IN ('BUY','SELL','LONG','SHORT')),
  signal_score numeric NOT NULL,
  display_confidence numeric,
  reference_price numeric NOT NULL CHECK (reference_price > 0),
  entry_price numeric NOT NULL CHECK (entry_price > 0),
  stop_loss numeric,
  target_1 numeric,
  target_2 numeric,
  risk_reward numeric,
  profit_evidence_status text CHECK (profit_evidence_status IN ('READY','INSUFFICIENT_SAMPLE','NOT_EVIDENCED','NO_VALIDATED_HISTORY')),
  profit_probability numeric CHECK (profit_probability IS NULL OR (profit_probability >= 0 AND profit_probability <= 100)),
  target_before_stop_probability numeric CHECK (target_before_stop_probability IS NULL OR (target_before_stop_probability >= 0 AND target_before_stop_probability <= 100)),
  loss_probability numeric CHECK (loss_probability IS NULL OR (loss_probability >= 0 AND loss_probability <= 100)),
  expected_gross_return numeric,
  expected_net_return numeric,
  expected_loss numeric,
  expected_value numeric,
  profit_sample_size integer CHECK (profit_sample_size IS NULL OR profit_sample_size >= 0),
  profit_confidence_interval jsonb,
  trading_cost_policy_id text,
  timeframes jsonb NOT NULL DEFAULT '[]'::jsonb,
  strategy_profile_version text NOT NULL,
  indicator_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  indicator_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  pattern_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  volume_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  volatility_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  trend_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  market_regime text NOT NULL DEFAULT 'UNKNOWN',
  liquidity_context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_validator_result jsonb,
  risk_engine_result jsonb,
  data_provenance jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_timestamp timestamptz NOT NULL,
  snapshot jsonb NOT NULL,
  immutable boolean NOT NULL DEFAULT true CHECK (immutable = true),
  execution_authority text NOT NULL DEFAULT 'NONE' CHECK (execution_authority = 'NONE'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (data_timestamp <= occurred_at),
  CHECK (profit_evidence_status = 'READY' OR (profit_probability IS NULL AND expected_net_return IS NULL AND expected_value IS NULL))
);

CREATE INDEX IF NOT EXISTS signal_events_performance_dimensions_idx
  ON signal_events (market, strategy_horizon, direction, strategy_profile_version, occurred_at DESC);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id text NOT NULL REFERENCES signal_events(signal_id) ON DELETE RESTRICT,
  evaluation_horizon text NOT NULL,
  evaluated_at timestamptz NOT NULL,
  return_percent numeric,
  gross_return_percent numeric,
  net_return_percent numeric,
  trading_cost_percent numeric CHECK (trading_cost_percent IS NULL OR trading_cost_percent >= 0),
  trading_cost_policy_id text,
  mfe_percent numeric,
  mae_percent numeric,
  target_1_hit boolean NOT NULL DEFAULT false,
  target_2_hit boolean NOT NULL DEFAULT false,
  stop_loss_hit boolean NOT NULL DEFAULT false,
  target_before_stop boolean,
  time_to_target_ms bigint,
  time_to_stop_ms bigint,
  outcome text NOT NULL CHECK (outcome IN ('WIN','LOSS','NEUTRAL','EXPIRED')),
  conservative_intrabar_conflict boolean NOT NULL DEFAULT false,
  execution_authority text NOT NULL DEFAULT 'NONE' CHECK (execution_authority = 'NONE'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (signal_id, evaluation_horizon, evaluated_at)
);

CREATE INDEX IF NOT EXISTS signal_outcomes_signal_idx
  ON signal_outcomes (signal_id, evaluated_at DESC);

CREATE TABLE IF NOT EXISTS strategy_performance_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_profile_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('BACKTEST','PAPER','SHADOW','LIVE_RECOMMENDATION')),
  dimension_key jsonb NOT NULL,
  sample_status text NOT NULL CHECK (sample_status IN ('READY','INSUFFICIENT_SAMPLE')),
  sample_size integer NOT NULL CHECK (sample_size >= 0),
  metrics jsonb NOT NULL,
  learning_stage text NOT NULL CHECK (learning_stage IN ('MEASURE_ONLY','RECOMMENDED_WEIGHT','SHADOW_WEIGHT','VALIDATED_WEIGHT')),
  execution_authority text NOT NULL DEFAULT 'NONE' CHECK (execution_authority = 'NONE'),
  calculated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS strategy_performance_snapshots_lookup_idx
  ON strategy_performance_snapshots (strategy_profile_version, source, calculated_at DESC);

COMMENT ON TABLE signal_events IS 'Immutable scanner recommendation exposure snapshots with evidence-based Profit-First fields. No order authority.';
COMMENT ON TABLE signal_outcomes IS 'Observed post-signal gross/net outcomes with target-before-stop evidence. No order authority.';
COMMENT ON TABLE strategy_performance_snapshots IS 'Derived Backtest/Paper/Shadow/Live recommendation comparison metrics. No order authority.';
