// Package domain holds BC-02's pure business logic: product eligibility and policy decisions (02-06); D4 is the authority, D1 and D2 enforce.
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
