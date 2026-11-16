// Package outbox writes events to a module's outbox table inside the caller's
// transaction, and the relay contract cmd/outbox-relay implements (ADR 0002 §3).
package outbox
