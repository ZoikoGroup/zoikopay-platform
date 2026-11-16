// Package domain holds BC-05's pure business logic: the double-entry financial subledger and chart of accounts (09-01, 09-02).
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
