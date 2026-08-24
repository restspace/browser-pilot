browser-use - an autonomous browser agent (Python).

This arm is MONOLITHIC: there is no orchestrator loop and no per-command
documentation, because nothing composes commands. The harness hands the whole
task text to a browser-use Agent exactly once; the agent plans, drives its own
Chromium via CDP, and returns a final report when it decides it is done (or
hits the step cap the harness passes through).

This file exists for the record rather than for a model to read: the fairness
contract for this arm is described in bench/README.md, and the runner is
bench/arms/browser_use_runner.py.
