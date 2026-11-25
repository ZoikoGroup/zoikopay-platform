package authz

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/db"
)

// Persona is a merchant persona that a tenant membership can carry (02-02 §01).
// Platform staff personas are deliberately absent: they never come from tenant
// memberships (OPEN_QUESTIONS Q36, decisions 36.1–36.3).
type Persona string

// The five merchant personas (02-02 §3 TENANT.READ).
const (
	MOWN  Persona = "MOWN"  // merchant owner / legal administrator
	MOPS  Persona = "MOPS"  // merchant operations
	MFIN  Persona = "MFIN"  // merchant finance
	MDEV  Persona = "MDEV"  // merchant developer
	MVIEW Persona = "MVIEW" // merchant auditor / viewer
)

func (p Persona) valid() bool {
	switch p {
	case MOWN, MOPS, MFIN, MDEV, MVIEW:
		return true
	}
	return false
}

// Grant is one approved tenant membership as stored by BC-01.
type Grant struct {
	ID            string     // membership ID; grants are immutable, so it is also the grant version (36.9)
	Subject       db.Subject // the member
	TenantID      string
	MerchantID    string // "" means every merchant of the tenant in Environment
	Environment   string // TEST or LIVE
	Persona       Persona
	EffectiveFrom time.Time // inclusive
	ExpiresAt     time.Time // exclusive
}

func (g Grant) liveAt(t time.Time) bool {
	return !t.Before(g.EffectiveFrom) && t.Before(g.ExpiresAt)
}

// GrantSource returns a subject's grants. BC-01 implements it from
// merchant.memberships; it must never derive grants from token claims.
type GrantSource interface {
	GrantsForSubject(ctx context.Context, s db.Subject) ([]Grant, error)
}

var (
	// ErrInvalidIdentity: the identity lacks an issuer or subject; nothing is read.
	ErrInvalidIdentity = errors.New("authz: identity is incomplete")
	// ErrGrantsUnavailable: grants could not be read or were inconsistent.
	// Callers fail closed (02-02 §6.3: 503 or secure denial, never permissive).
	ErrGrantsUnavailable = errors.New("authz: grants unavailable")
	// ErrAmbiguousPrincipal: the subject holds live grants in both TEST and
	// LIVE, which 02-02 §2.4 ("distinct principals") forbids (decision 36.16).
	ErrAmbiguousPrincipal = errors.New("authz: subject holds grants in more than one environment")
)

// Principal is what Zoiko Pay has decided a verified caller may act as, in one
// environment. The zero value has no access. Accessors return copies, so a
// Principal cannot be widened after it is resolved.
type Principal struct {
	Identity    authn.Identity
	Environment string
	grants      []Grant
}

// HasAccess reports whether the principal holds any live grant.
func (p Principal) HasAccess() bool { return len(p.grants) > 0 }

// Grants returns a copy of the principal's live grants.
func (p Principal) Grants() []Grant { return slices.Clone(p.grants) }

// Tenants returns the sorted, distinct tenants the principal has a grant in.
func (p Principal) Tenants() []string {
	var ts []string
	for _, g := range p.grants {
		if !slices.Contains(ts, g.TenantID) {
			ts = append(ts, g.TenantID)
		}
	}
	slices.Sort(ts)
	return ts
}

// Holds reports whether the principal holds persona for a resource owned by
// tenantID and merchantID ("" for a tenant-level resource), taken from the
// stored record, never from the request. A tenant-wide grant covers every
// merchant of its tenant; a merchant grant covers only that merchant (02-02
// AT-007). There are no wildcards.
func (p Principal) Holds(persona Persona, tenantID, merchantID string) bool {
	return slices.Contains(p.Personas(tenantID, merchantID), persona)
}

// Personas returns the sorted personas the principal holds for a resource of
// tenantID and merchantID.
func (p Principal) Personas(tenantID, merchantID string) []Persona {
	if tenantID == "" {
		return nil
	}
	var out []Persona
	for _, g := range p.grants {
		if g.TenantID == tenantID && (g.MerchantID == "" || g.MerchantID == merchantID) && !slices.Contains(out, g.Persona) {
			out = append(out, g.Persona)
		}
	}
	slices.Sort(out)
	return out
}

// Resolver turns a verified identity into a Principal from Zoiko Pay's own
// grants (02-02 §2.2, §2.3; 03-05 §2.2, §7.1). It is safe for concurrent use.
type Resolver struct {
	src         GrantSource
	environment string
	now         func() time.Time
}

// NewResolver returns a Resolver for the deployment's environment (TEST or
// LIVE), which comes from configuration, never from a request (36.16).
// now defaults to time.Now.
func NewResolver(src GrantSource, environment string, now func() time.Time) (*Resolver, error) {
	if src == nil {
		return nil, errors.New("authz: a grant source is required")
	}
	if environment != "TEST" && environment != "LIVE" {
		return nil, fmt.Errorf("authz: environment %q is not TEST or LIVE", environment)
	}
	if now == nil {
		now = time.Now
	}
	return &Resolver{src: src, environment: environment, now: now}, nil
}

// Resolve reads the identity's grants on every call (no cache, so revocation
// applies to the next request: 02-02 AT-005, 36.19) and keeps only live
// grants of a merchant persona in this deployment's environment. It takes
// nothing but the verified identity: no tenant, merchant or role from the
// token, headers, query or body can enter. Any error returns a principal
// with no access.
func (r *Resolver) Resolve(ctx context.Context, id authn.Identity) (Principal, error) {
	if id.Issuer == "" || id.Subject == "" {
		return Principal{}, ErrInvalidIdentity
	}
	subject := db.Subject{Issuer: id.Issuer, Subject: id.Subject}
	grants, err := r.src.GrantsForSubject(ctx, subject)
	if err != nil {
		return Principal{}, fmt.Errorf("%w: %w", ErrGrantsUnavailable, err)
	}

	now := r.now()
	var kept []Grant
	otherEnvironment := false
	for _, g := range grants {
		if g.Subject != subject {
			// The source returned someone else's grant: it cannot be trusted.
			return Principal{}, fmt.Errorf("%w: a grant for another subject was returned", ErrGrantsUnavailable)
		}
		if g.TenantID == "" || !g.Persona.valid() || !g.liveAt(now) {
			continue
		}
		switch g.Environment {
		case r.environment:
			kept = append(kept, g)
		case "TEST", "LIVE":
			otherEnvironment = true
		}
	}
	if otherEnvironment && len(kept) > 0 {
		return Principal{}, ErrAmbiguousPrincipal
	}
	return Principal{Identity: id, Environment: r.environment, grants: kept}, nil
}
