package http

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	stdhttp "net/http"
	"slices"
	"strings"
	"time"

	"github.com/zoiko/zoikopay/internal/apigen/publicapi"
	"github.com/zoiko/zoikopay/internal/merchant/app"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/authz"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/httpauth"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

// Deps are what the public merchant API needs.
type Deps struct {
	Pool        db.Beginner // zp_gateway
	Verifier    httpauth.TokenVerifier
	Resolver    httpauth.PrincipalResolver
	Log         *slog.Logger
	Audit       audit.Recorder // BC-08 audit log, as zp_audit (OPEN_QUESTIONS Q38)
	Environment string         // the deployment's, TEST or LIVE
}

const detailNotFound = "The requested resource was not found."

// Mount serves the public API (api/openapi/public.v1.yaml) under /v1 on mux.
// Authentication runs before routing, so an unauthenticated caller gets 401
// for every /v1 path and cannot discover which routes exist (Q37 37.15).
// Every /v1 request, allowed, denied or failed, leaves one audit entry; the
// audit middleware sits outside authentication so it records 401s too, and
// withholds the response if the entry cannot be written (Q38).
func Mount(mux *stdhttp.ServeMux, d Deps) {
	api := stdhttp.NewServeMux()
	h := &Handler{merchants: app.Merchants{Pool: d.Pool}, log: d.Log}
	publicapi.HandlerWithOptions(h, publicapi.StdHTTPServerOptions{
		BaseRouter: api,
		BaseURL:    "/v1",
		ErrorHandlerFunc: func(w stdhttp.ResponseWriter, r *stdhttp.Request, _ error) {
			httpauth.WriteProblem(w, r, apierror.New(apierror.ResourceNotFound, detailNotFound))
		},
	})
	api.HandleFunc("/v1/", func(w stdhttp.ResponseWriter, r *stdhttp.Request) {
		audit.Describe(r.Context(), "unknownRoute", "", "", "")
		httpauth.WriteProblem(w, r, apierror.New(apierror.ResourceNotFound, detailNotFound))
	})
	authenticated := httpauth.Authenticate(d.Verifier, d.Resolver, d.Log)(api)
	mux.Handle("/v1/", audit.Middleware(d.Audit, d.Environment, d.Log)(authenticated))
}

// Handler implements the public API's merchant operations.
type Handler struct {
	merchants app.Merchants
	log       *slog.Logger
}

var _ publicapi.ServerInterface = (*Handler)(nil)

// GetPrincipal serves GET /v1/principal (OPEN_QUESTIONS Q39): the caller's own
// live grants, as the principal resolver read them from merchant.memberships
// for this request. Nothing is cached, so a revoked or expired grant is gone
// on the next call. A caller without a live grant gets an empty list; the
// list never includes another person's grants.
func (h *Handler) GetPrincipal(w stdhttp.ResponseWriter, r *stdhttp.Request) {
	ctx := r.Context()
	p, ok := httpauth.PrincipalFrom(ctx)
	if !ok { // only reachable if Mount's middleware were removed
		httpauth.WriteProblem(w, r, apierror.New(apierror.AuthenticationRequired, "A valid access token is required."))
		return
	}
	// A principal can span tenants, so the entry names none (Q38 38.10).
	audit.Describe(ctx, "getPrincipal", "", "", "")

	grants := p.Grants()
	slices.SortFunc(grants, func(a, b authz.Grant) int {
		return cmp.Or(cmp.Compare(a.TenantID, b.TenantID), cmp.Compare(a.MerchantID, b.MerchantID), cmp.Compare(a.Persona, b.Persona))
	})
	out := publicapi.Principal{
		Object: "principal", Issuer: p.Identity.Issuer, Subject: p.Identity.Subject,
		Environment: publicapi.PrincipalEnvironment(strings.ToLower(p.Environment)),
		Grants:      make([]publicapi.Grant, 0, len(grants)),
	}
	for _, g := range grants {
		pg := publicapi.Grant{
			TenantId: g.TenantID, Persona: publicapi.GrantPersona(strings.ToLower(string(g.Persona))),
			EffectiveFrom: g.EffectiveFrom.UTC().Truncate(time.Second), ExpiresAt: g.ExpiresAt.UTC().Truncate(time.Second),
		}
		if g.MerchantID != "" {
			pg.MerchantId = &g.MerchantID
		}
		out.Grants = append(out.Grants, pg)
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(stdhttp.StatusOK)
	_ = json.NewEncoder(w).Encode(out)
}

// GetMerchant serves GET /v1/merchants/{merchant_id} (04-03 getMerchant).
func (h *Handler) GetMerchant(w stdhttp.ResponseWriter, r *stdhttp.Request, merchantID publicapi.MerchantId) {
	ctx := r.Context()
	p, ok := httpauth.PrincipalFrom(ctx)
	if !ok { // only reachable if Mount's middleware were removed
		httpauth.WriteProblem(w, r, apierror.New(apierror.AuthenticationRequired, "A valid access token is required."))
		return
	}
	m, err := h.merchants.Get(ctx, p, merchantID)
	// The tenant is named only when the merchant was found in one of the
	// caller's own tenants (200 or 403), never for a 404 (Q38 38.10).
	audit.Describe(ctx, "getMerchant", "merchant", merchantID, m.TenantID)
	switch {
	case errors.Is(err, app.ErrNotFound):
		httpauth.WriteProblem(w, r, apierror.New(apierror.ResourceNotFound, detailNotFound))
		return
	case errors.Is(err, app.ErrForbidden):
		httpauth.WriteProblem(w, r, apierror.New(apierror.PermissionDenied, "You do not have permission to view this merchant."))
		return
	case err != nil:
		h.log.ErrorContext(ctx, "get merchant failed", "trace_id", trace.ID(ctx), "error", err)
		httpauth.WriteProblem(w, r, apierror.New(apierror.TemporarilyUnavailable,
			"The service is temporarily unavailable. Retry later and quote the trace ID if it persists."))
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("ETag", fmt.Sprintf(`"merchant-rev-%d"`, m.Revision))
	w.WriteHeader(stdhttp.StatusOK)
	_ = json.NewEncoder(w).Encode(publicapi.Merchant{
		Id: m.ID, Object: "merchant", DisplayName: m.DisplayName,
		Status:   publicapi.MerchantStatus(strings.ToLower(m.Status)), // lower case on the wire (Q37 37.11)
		Revision: m.Revision, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt,
	})
}
