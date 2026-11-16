// Package domain holds BC-08's pure business logic: risk, compliance, approvals and audit evidence.
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
