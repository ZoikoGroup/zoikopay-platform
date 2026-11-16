// Package domain holds BC-07's pure business logic: merchant pricing, fees and billing (02-08).
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
