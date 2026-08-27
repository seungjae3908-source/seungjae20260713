# Canonical Shadow runtime activation contract

This file intentionally contains no executable configuration. It records the bounded activation invariants exercised by `canonical-shadow-runtime-activation-v1.test.js` and the two GitHub Actions workflows.

- First activation may bootstrap only from Producer Run `32921992780` and Shadow Run `32933416612` with the exact recorded artifact digest.
- Hourly continuation may use only a predecessor with a successful canonical publication receipt.
- A terminal-success Shadow artifact is validated and normalized by the existing `shadow-state-root-transport-v1` before any state-root write.
- Canonical schedule execution remains dormant while the legacy hourly Shadow workflow is enabled.
- Legacy Shadow is disabled only after canonical state publication, read-back verification, Node/Python dashboard parity, and merged Strategy Health adapter verification succeed.
- Failure does not grant execution authority, does not enable live trading, and does not create real orders.
