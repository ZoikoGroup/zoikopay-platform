// Package domain holds BC-06's pure business logic: reconciliation of ledger against provider reports, and settlement.
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
