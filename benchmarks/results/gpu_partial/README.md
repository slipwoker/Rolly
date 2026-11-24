Runs kept for the record but excluded from the summaries:

- `scenarios_modular-selfhosted_20261124T184358.json` - first GPU attempt, interrupted after 13 scenarios when the pod was
  restarted to improve monitoring (31 turns; median 665 ms, consistent with the complete run that followed).
- `concurrency_modular-selfhosted_20261124T191234.json` - ramp that stopped after one level because the stop rule judged
  four turns against the 800 ms median target; superseded by the full ramp `..._20261124T194758.json`.
