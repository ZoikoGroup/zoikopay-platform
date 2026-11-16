// Package ledger is bounded context BC-05 (Financial Subledger), placed in deployable D3 finance.
//
// This root package is the module's public contract: the only part of this
// module that other modules may import (see ADR 0002). Internals live in
// domain/ (pure logic, no I/O), app/ (use cases, one transaction each),
// store/ (sqlc, this module's schema only), http/ (generated handlers) and
// events/ (outbox event types).
package ledger
