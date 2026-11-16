// Package domain holds BC-09's pure business logic: notifications, receipts and merchant insights (02-09).
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
