// Package domain holds BC-03's pure business logic: PaymentIntents, attempts, refunds and their 06-01 state machines.
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
