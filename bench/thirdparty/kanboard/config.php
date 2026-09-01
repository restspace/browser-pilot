<?php

// Benchmark instance configuration. One purpose: a FIXED application API
// token, so bench/app-reset.mjs and bench/verify-kanboard.mjs can talk to
// /jsonrpc.php (Basic jsonrpc:<token>) without first scraping the generated
// token out of the settings UI. Everything else stays at Kanboard defaults
// (SQLite in the data volume, admin/admin).
define('API_AUTHENTICATION_TOKEN', 'bench-api-token');

// The bench drives a fresh browser every run; remember-me cookies would make
// run 1 (fresh login) structurally different from a human's later visits.
define('REMEMBER_ME_AUTH', false);
