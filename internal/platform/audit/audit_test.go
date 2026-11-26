package audit_test

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"testing"

	"github.com/zoiko/zoikopay/internal/platform/audit"
	"github.com/zoiko/zoikopay/internal/platform/trace"
)

const (
	issuer  = "http://localhost:8180/realms/zoikopay"
	subject = "00000000-0000-4000-8000-0000000000a1"
	tenant  = "ten_019abc000000700080000000000000a1"
	traceID = "0123456789abcdef0123456789abcdef"
	jwtLike = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"
)

func valid() audit.Entry {
	return audit.Entry{
		TraceID: traceID, Actor: &audit.Actor{Issuer: issuer, Subject: subject}, Environment: "TEST",
		TenantID: tenant, Action: "getMerchant", ResourceType: "merchant",
		ResourceHash: audit.ResourceHash("merchant", "mer_x"), Outcome: audit.Allowed, HTTPStatus: 200,
	}
}

func TestValidEntriesPass(t *testing.T) {
	for name, e := range map[string]audit.Entry{
		"allowed read":   valid(),
		"401, no actor":  {TraceID: traceID, Environment: "TEST", Action: "authenticate", Outcome: audit.Denied, HTTPStatus: 401, Reason: "authentication_required"},
		"404, no tenant": {TraceID: traceID, Actor: &audit.Actor{Issuer: issuer, Subject: subject}, Environment: "LIVE", Action: "getMerchant", ResourceType: "merchant", ResourceHash: audit.ResourceHash("merchant", "mer_y"), Outcome: audit.Denied, HTTPStatus: 404, Reason: "resource_not_found"},
		"503":            {TraceID: traceID, Environment: "TEST", Action: "request", Outcome: audit.Failed, HTTPStatus: 503, Reason: "temporarily_unavailable"},
	} {
		if err := e.Validate(); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
}

// Rule 4 and 38.8: no free text, so a token, password or secret has nowhere to go.
func TestEntriesThatCouldCarrySecretsAreRefused(t *testing.T) {
	for name, mutate := range map[string]func(*audit.Entry){
		"token as subject":             func(e *audit.Entry) { e.Actor.Subject = jwtLike },
		"token as issuer":              func(e *audit.Entry) { e.Actor.Issuer = "https://x.example.test/" + jwtLike },
		"token as action":              func(e *audit.Entry) { e.Action = jwtLike },
		"token as reason":              func(e *audit.Entry) { e.Reason = jwtLike },
		"free text in action":          func(e *audit.Entry) { e.Action = "user typed password hunter2" },
		"free text in reason":          func(e *audit.Entry) { e.Reason = "password=hunter2" },
		"raw resource id, not a hash":  func(e *audit.Entry) { e.ResourceHash = "mer_x" },
		"resource hash without a type": func(e *audit.Entry) { e.ResourceType = "" },
		"bad trace ID":                 func(e *audit.Entry) { e.TraceID = "client-supplied" },
		"actor without subject":        func(e *audit.Entry) { e.Actor.Subject = "" },
		"actor without issuer":         func(e *audit.Entry) { e.Actor.Issuer = "" },
		"subject with spaces":          func(e *audit.Entry) { e.Actor.Subject = "Bearer abc" },
		"bad tenant":                   func(e *audit.Entry) { e.TenantID = "ten_northwind" },
		"no environment":               func(e *audit.Entry) { e.Environment = "" },
		"outcome does not match":       func(e *audit.Entry) { e.Outcome = audit.Allowed; e.HTTPStatus = 403 },
		"denied with a 2xx":            func(e *audit.Entry) { e.Outcome = audit.Denied; e.HTTPStatus = 200 },
		"unknown outcome":              func(e *audit.Entry) { e.Outcome = "MAYBE" },
	} {
		e := valid()
		mutate(&e)
		if err := e.Validate(); !errors.Is(err, audit.ErrInvalidEntry) {
			t.Errorf("%s: err = %v; want ErrInvalidEntry", name, err)
		}
	}
}

func TestResourceHashHidesTheID(t *testing.T) {
	h := audit.ResourceHash("merchant", "mer_019abc000000700080000000000000a1")
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(h) || strings.Contains(h, "mer_") {
		t.Errorf("hash %q; want 64 hex without the id", h)
	}
	if h != audit.ResourceHash("merchant", "mer_019abc000000700080000000000000a1") {
		t.Error("hash is not deterministic")
	}
	if h == audit.ResourceHash("tenant", "mer_019abc000000700080000000000000a1") {
		t.Error("hash ignores the resource type")
	}
}

// recorder is a fake Recorder.
type recorder struct {
	mu      sync.Mutex
	entries []audit.Entry
	err     error
}

func (r *recorder) Record(_ context.Context, e audit.Entry) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return r.err
	}
	r.entries = append(r.entries, e)
	return nil
}

func (r *recorder) only(t *testing.T) audit.Entry {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.entries) != 1 {
		t.Fatalf("%d entries recorded; want exactly 1", len(r.entries))
	}
	return r.entries[0]
}

func serve(t *testing.T, rec audit.Recorder, h http.HandlerFunc, edit ...func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	log := slog.New(slog.DiscardHandler)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/v1/merchants/mer_x", nil)
	for _, f := range edit {
		f(req)
	}
	w := httptest.NewRecorder()
	trace.Middleware(log, audit.Middleware(rec, "TEST", log)(h)).ServeHTTP(w, req)
	return w
}

func problem(w http.ResponseWriter, r *http.Request, status int, code string) {
	audit.SetReason(r.Context(), code)
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"code":"` + code + `"}`))
}

// Rule 2: who, what, when (set by the store), which tenant, the outcome and the trace ID.
func TestAllowedRequestIsRecordedWithEveryField(t *testing.T) {
	rec := &recorder{}
	w := serve(t, rec, func(w http.ResponseWriter, r *http.Request) {
		audit.SetActor(r.Context(), issuer, subject)
		audit.Describe(r.Context(), "getMerchant", "merchant", "mer_x", tenant)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"mer_x"}`))
	})
	e := rec.only(t)
	want := audit.Entry{TraceID: w.Header().Get(trace.Header), Actor: &audit.Actor{Issuer: issuer, Subject: subject}, Environment: "TEST",
		TenantID: tenant, Action: "getMerchant", ResourceType: "merchant", ResourceHash: audit.ResourceHash("merchant", "mer_x"),
		Outcome: audit.Allowed, HTTPStatus: 200}
	if !reflect.DeepEqual(e, want) {
		t.Errorf("entry %+v; want %+v", e, want)
	}
	if w.Code != 200 || w.Body.String() != `{"id":"mer_x"}` {
		t.Errorf("response %d %q; want the handler's", w.Code, w.Body)
	}
}

// Rule 3: denials are recorded too.
func TestDeniedAndFailedRequestsAreRecorded(t *testing.T) {
	for _, c := range []struct {
		status  int
		code    string
		outcome audit.Outcome
	}{
		{401, "authentication_required", audit.Denied},
		{403, "permission_denied", audit.Denied},
		{404, "resource_not_found", audit.Denied},
		{503, "temporarily_unavailable", audit.Failed},
	} {
		rec := &recorder{}
		w := serve(t, rec, func(w http.ResponseWriter, r *http.Request) { problem(w, r, c.status, c.code) })
		e := rec.only(t)
		if e.Outcome != c.outcome || e.HTTPStatus != c.status || e.Reason != c.code || e.TraceID != w.Header().Get(trace.Header) {
			t.Errorf("%d: entry %+v; want outcome %s, reason %s and the response's trace ID", c.status, e, c.outcome, c.code)
		}
		if e.Actor != nil || e.TenantID != "" {
			t.Errorf("%d: entry has actor %+v or tenant %q although none was set", c.status, e.Actor, e.TenantID)
		}
	}
}

// Rule 5 support: nothing from the request itself reaches the entry.
func TestRequestHeadersCannotSetActorOrTenant(t *testing.T) {
	rec := &recorder{}
	serve(t, rec, func(w http.ResponseWriter, r *http.Request) { problem(w, r, 404, "resource_not_found") }, func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+jwtLike)
		r.Header.Set("X-Tenant-Id", tenant)
		r.Header.Set("X-User-Id", subject)
		r.URL.RawQuery = "tenant_id=" + tenant
	})
	e := rec.only(t)
	if e.Actor != nil || e.TenantID != "" {
		t.Errorf("entry actor %+v tenant %q came from the request", e.Actor, e.TenantID)
	}
	b, _ := json.Marshal(e)
	if strings.Contains(string(b), "eyJ") {
		t.Errorf("entry contains token material: %s", b)
	}
}

// 38.12: if the entry cannot be written, the caller gets 503 and nothing of
// the handler's response leaves.
func TestAuditFailureFailsClosed(t *testing.T) {
	rec := &recorder{err: errors.New("audit database unreachable")}
	w := serve(t, rec, func(w http.ResponseWriter, r *http.Request) {
		audit.SetActor(r.Context(), issuer, subject)
		w.Header().Set("ETag", `"merchant-rev-1"`)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"mer_secret_profile"}`))
	})
	if w.Code != http.StatusServiceUnavailable || strings.Contains(w.Body.String(), "mer_secret_profile") || w.Header().Get("ETag") != "" {
		t.Errorf("response %d %q (ETag %q); want 503 with none of the handler's output", w.Code, w.Body, w.Header().Get("ETag"))
	}
	var p struct {
		Code    string `json:"code"`
		TraceID string `json:"trace_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.Code != "temporarily_unavailable" || p.TraceID != w.Header().Get(trace.Header) {
		t.Errorf("503 body %q; want a temporarily_unavailable problem with the trace ID", w.Body)
	}
}

func TestEntryWithoutDescribeUsesTheDefaultAction(t *testing.T) {
	rec := &recorder{}
	serve(t, rec, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	if e := rec.only(t); e.Action != "request" || e.ResourceType != "" || e.ResourceHash != "" {
		t.Errorf("entry %+v; want action request and no resource", e)
	}
}

func TestHelpersOutsideTheMiddlewareDoNothing(t *testing.T) {
	ctx := context.Background()
	audit.SetActor(ctx, issuer, subject) // must not panic
	audit.Describe(ctx, "getMerchant", "merchant", "mer_x", tenant)
	audit.SetReason(ctx, "permission_denied")
}
