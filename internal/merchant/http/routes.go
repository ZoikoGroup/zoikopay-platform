package http

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	stdhttp "net/http"
	"strings"

	"github.com/zoiko/zoikopay/internal/apigen/publicapi"
	"github.com/zoiko/zoikopay/internal/merchant/app"
	"github.com/zoiko/zoikopay/internal/platform/apierror"
	"github.com/zoiko/zoikopay/internal/platform/db"
	"github.com/zoiko/zoikopay/internal/platform/httpauth"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

// Deps are what the public merchant API needs.
type Deps struct {
	Pool     db.Beginner // zp_gateway
	Verifier httpauth.TokenVerifier
	Resolver httpauth.PrincipalResolver
	Log      *slog.Logger
}

const detailNotFound = "The requested resource was not found."

// Mount serves the public API (api/openapi/public.v1.yaml) under /v1 on mux.
// Authentication runs before routing, so an unauthenticated caller gets 401
// for every /v1 path and cannot discover which routes exist (Q37 37.15).
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
		httpauth.WriteProblem(w, r, apierror.New(apierror.ResourceNotFound, detailNotFound))
	})
	mux.Handle("/v1/", httpauth.Authenticate(d.Verifier, d.Resolver, d.Log)(api))
}

// Handler implements the public API's merchant operations.
type Handler struct {
	merchants app.Merchants
	log       *slog.Logger
}

var _ publicapi.ServerInterface = (*Handler)(nil)

// GetMerchant serves GET /v1/merchants/{merchant_id} (04-03 getMerchant).
func (h *Handler) GetMerchant(w stdhttp.ResponseWriter, r *stdhttp.Request, merchantID publicapi.MerchantId) {
	ctx := r.Context()
	p, ok := httpauth.PrincipalFrom(ctx)
	if !ok { // only reachable if Mount's middleware were removed
		httpauth.WriteProblem(w, r, apierror.New(apierror.AuthenticationRequired, "A valid access token is required."))
		return
	}
	m, err := h.merchants.Get(ctx, p, merchantID)
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
