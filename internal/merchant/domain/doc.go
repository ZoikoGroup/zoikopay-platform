// Package domain holds BC-01's pure business logic: merchants, tenants, API keys, webhook endpoints and merchant configuration.
//
// No I/O: it must not import database, HTTP, OS, Temporal or any other
// package of this module (enforced by internal/archtest).
package domain
