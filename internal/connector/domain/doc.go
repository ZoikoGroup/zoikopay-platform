// Package domain holds BC-04's pure business logic: PSP connectivity, provider adapters and unknown-outcome resolution (02-07).
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
