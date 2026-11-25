// Package httpauth connects the access-token verifier (ADR 0007) and the
// principal resolver (OPEN_QUESTIONS Q36) to HTTP routes. Response codes and
// trace behavior follow Q37.
package httpauth

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/authn"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

// TokenVerifier is satisfied by *authn.Verifier.
type TokenVerifier interface {
	Verify(ctx context.Context, raw string) (authn.Identity, error)
}

// PrincipalResolver is satisfied by *authz.Resolver.
type PrincipalResolver interface {
	Resolve(ctx context.Context, id authn.Identity) (authz.Principal, error)
}

type principalKey struct{}

// PrincipalFrom returns the principal Authenticate stored for the request.
func PrincipalFrom(ctx context.Context) (authz.Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(authz.Principal)
	return p, ok
}

// Fixed public texts: one body per outcome, so a response never says why a
// token failed or whether a resource exists (Q37 37.3, 37.5).
const (
	detailUnauthenticated = "A valid access token is required."
	detailUnavailable     = "The service is temporarily unavailable. Retry later and quote the trace ID if it persists."
	detailAmbiguous       = "This account cannot be used here. Contact your administrator and quote the trace ID."
)

// Authenticate requires an "Authorization: Bearer" access token on every
// request, verifies it, resolves the caller's principal from Zoiko Pay's own
// memberships and passes it to next in the request context.
//
//   - no, malformed or invalid token → 401 authentication_required (Q37 37.3)
//   - signing keys or grants unavailable → 503 temporarily_unavailable (37.4)
//   - grants in both TEST and LIVE → 403 permission_denied (37.8)
//
// Only the verified issuer and subject reach the resolver: no header, query,
// cookie, body or token claim can supply a tenant or role (rule 5). A caller
// without grants continues with a principal that can do nothing; routes deny
// (37.7). Failure reasons are logged with the trace ID; tokens never are.
func Authenticate(v TokenVerifier, res PrincipalResolver, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := r.Context()
			raw, err := authn.BearerToken(r)
			if err != nil {
				unauthenticated(w, r, log, "no usable bearer token")
				return
			}
			id, err := v.Verify(ctx, raw)
			switch {
			case errors.Is(err, authn.ErrKeysUnavailable):
				log.WarnContext(ctx, "token verification unavailable", "trace_id", trace.ID(ctx), "error", err)
				WriteProblem(w, r, apierror.New(apierror.TemporarilyUnavailable, detailUnavailable))
				return
			case err != nil:
				// Verifier errors name the failed check, never the token.
				unauthenticated(w, r, log, err.Error())
				return
			}

			p, err := res.Resolve(ctx, id)
			switch {
			case errors.Is(err, authz.ErrAmbiguousPrincipal):
				log.WarnContext(ctx, "principal refused", "trace_id", trace.ID(ctx), "reason", "grants in more than one environment")
				WriteProblem(w, r, apierror.New(apierror.PermissionDenied, detailAmbiguous))
				return
			case err != nil:
				log.ErrorContext(ctx, "principal resolution unavailable", "trace_id", trace.ID(ctx), "error", err)
				WriteProblem(w, r, apierror.New(apierror.TemporarilyUnavailable, detailUnavailable))
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(ctx, principalKey{}, p)))
		})
	}
}

func unauthenticated(w http.ResponseWriter, r *http.Request, log *slog.Logger, reason string) {
	log.InfoContext(r.Context(), "request not authenticated", "trace_id", trace.ID(r.Context()), "reason", reason)
	w.Header().Set("WWW-Authenticate", `Bearer realm="zoikopay"`)
	WriteProblem(w, r, apierror.New(apierror.AuthenticationRequired, detailUnauthenticated))
}

// WriteProblem writes p as an RFC 9457 problem carrying the request's trace
// ID as trace_id and request_id (Q37 37.1, 37.2).
func WriteProblem(w http.ResponseWriter, r *http.Request, p *apierror.Problem) {
	id := trace.ID(r.Context())
	p.TraceID = id
	apierror.Write(w, id, p)
}
