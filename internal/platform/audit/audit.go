// Package audit is the shared interface every module uses to record business
// audit entries (OPEN_QUESTIONS Q38). BC-08 governance owns the log and
// implements Recorder (internal/governance/store); this package defines what
// an entry is and records one per HTTP request.
//
// An entry holds who (the verified issuer and subject), what (action and a
// hash of the resource), when (set by the store's trusted clock), which
// tenant, the outcome and the trace ID. It has no free-text field, so tokens,
// passwords and secrets have nowhere to go (38.8). Nothing here depends on an
// identity provider.
package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Outcome classifies a request by its HTTP status (38.13).
type Outcome string

const (
	Allowed Outcome = "ALLOWED" // 1xx–3xx
	Denied  Outcome = "DENIED"  // 4xx, including 401, 403 and 404
	Failed  Outcome = "FAILED"  // 5xx
)

// OutcomeOf returns the outcome for an HTTP status.
func OutcomeOf(status int) Outcome {
	switch {
	case status >= 500:
		return Failed
	case status >= 400:
		return Denied
	default:
		return Allowed
	}
}

// Actor is a verified identity: the token's issuer and subject.
type Actor struct {
	Issuer  string
	Subject string
}

// Entry is one audit record. Optional fields are empty (or Actor nil) when unknown.
type Entry struct {
	TraceID      string // the request's server-generated trace ID
	Actor        *Actor // nil when no identity was verified (for example a 401)
	Environment  string // TEST or LIVE
	TenantID     string // only when the resource was found in the caller's own tenant (38.10)
	Action       string // operation, e.g. getMerchant; "authenticate" for token failures
	ResourceType string // e.g. merchant
	ResourceHash string // ResourceHash(ResourceType, id); never the raw id (38.7)
	Outcome      Outcome
	HTTPStatus   int
	Reason       string // problem code, e.g. resource_not_found
}

// ErrInvalidEntry: the entry breaks a format rule and is not recorded.
var ErrInvalidEntry = errors.New("audit: invalid entry")

// The same formats as the database's CHECK constraints
// (db/migrations/governance/00002_audit_events.sql).
var (
	traceFormat    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	issuerFormat   = regexp.MustCompile(`^https?://[^\s]+$`)
	tenantFormat   = regexp.MustCompile(`^ten_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$`)
	actionFormat   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.]{0,63}$`)
	resourceFormat = regexp.MustCompile(`^[a-z][a-z_]{0,31}$`)
	hashFormat     = regexp.MustCompile(`^[0-9a-f]{64}$`)
	reasonFormat   = regexp.MustCompile(`^[a-z][a-z_]{0,63}$`)
)

// looksLikeToken catches a JOSE value: its base64url header always starts
// with "eyJ" (`{"`).
func looksLikeToken(s string) bool { return strings.Contains(s, "eyJ") }

// Validate reports whether e can be recorded. Every field must match its
// format, the outcome must match the status, and no value may look like a token.
func (e Entry) Validate() error {
	bad := func(what string) error { return fmt.Errorf("%w: %s", ErrInvalidEntry, what) }
	switch {
	case !traceFormat.MatchString(e.TraceID):
		return bad("trace ID")
	case e.Environment != "TEST" && e.Environment != "LIVE":
		return bad("environment")
	case !actionFormat.MatchString(e.Action) || looksLikeToken(e.Action):
		return bad("action")
	case e.TenantID != "" && !tenantFormat.MatchString(e.TenantID):
		return bad("tenant")
	case (e.ResourceType == "") != (e.ResourceHash == ""):
		return bad("resource type and hash go together")
	case e.ResourceType != "" && (!resourceFormat.MatchString(e.ResourceType) || !hashFormat.MatchString(e.ResourceHash)):
		return bad("resource")
	case e.Reason != "" && (!reasonFormat.MatchString(e.Reason) || looksLikeToken(e.Reason)):
		return bad("reason")
	case e.HTTPStatus < 100 || e.HTTPStatus > 599 || OutcomeOf(e.HTTPStatus) != e.Outcome:
		return bad("outcome and status")
	}
	if a := e.Actor; a != nil {
		if !issuerFormat.MatchString(a.Issuer) || len(a.Issuer) > 512 || looksLikeToken(a.Issuer) ||
			a.Subject == "" || len(a.Subject) > 255 || strings.ContainsAny(a.Subject, " \t\r\n") || looksLikeToken(a.Subject) {
			return bad("actor")
		}
	}
	return nil
}

// ResourceHash returns the SHA-256 of a resource's type and ID, so the log can
// be searched for a known resource without storing its ID (03-05 §14
// "resource hash").
func ResourceHash(resourceType, id string) string {
	sum := sha256.Sum256([]byte(resourceType + ":" + id))
	return hex.EncodeToString(sum[:])
}

// Recorder stores audit entries. BC-08 governance implements it.
type Recorder interface {
	Record(ctx context.Context, e Entry) error
}

// detail is the per-request record that Middleware writes; layers below it
// fill it through SetActor, Describe and SetReason.
type detail struct {
	actor        *Actor
	action       string
	resourceType string
	resourceID   string
	tenantID     string
	reason       string
}

type ctxKey struct{}

func from(ctx context.Context) *detail {
	d, _ := ctx.Value(ctxKey{}).(*detail)
	return d
}

// SetActor records the verified identity of the request. Only the
// authentication middleware calls it, after the token is verified (38.9).
func SetActor(ctx context.Context, issuer, subject string) {
	if d := from(ctx); d != nil {
		d.actor = &Actor{Issuer: issuer, Subject: subject}
	}
}

// Describe records what the request did: the action, the resource it
// addressed and, only when the resource was found in one of the caller's own
// tenants, that tenant (38.10). The resource ID is hashed when the entry is built.
func Describe(ctx context.Context, action, resourceType, resourceID, tenantID string) {
	if d := from(ctx); d != nil {
		d.action, d.resourceType, d.resourceID, d.tenantID = action, resourceType, resourceID, tenantID
	}
}

// SetReason records the problem code of a refused or failed request.
func SetReason(ctx context.Context, code string) {
	if d := from(ctx); d != nil {
		d.reason = code
	}
}
