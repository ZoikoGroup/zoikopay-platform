package outbox_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

// ValidEvent returns an envelope with every required 04-06 attribute set.
func validEvent() outbox.Event {
	t := time.Date(2026, 11, 16, 10, 0, 0, 0, time.UTC)
	return outbox.Event{
		SpecVersion: "1.0", ID: "019b95b1-28f1-7f02-a7c7-140000000031", Source: "/zoikopay/cell_uk_01/bc03",
		Type: "com.zoiko.pay.payment.intent.created.v1", Subject: "payment_intent/pi_1", Time: t,
		DataContentType: "application/json", DataSchema: "urn:zoikopay:schema:payment-intent-created:1.0.0",
		TenantID: "ten_1", MerchantID: "mer_1", CellID: "cell_uk_01", LegalEntityID: "le_1",
		AggregateID: "pi_1", AggregateVersion: 1, CorrelationID: "cor_1", PolicyVersion: "policy_1",
		Classification: outbox.RestrictedFinancial, RecordedAt: t,
		Data: json.RawMessage(`{"payment_intent_id":"pi_1","amount_minor":"1999","currency":"GBP"}`),
	}
}

func TestValidEventPasses(t *testing.T) {
	e := validEvent()
	if err := e.Validate(); err != nil {
		t.Fatal(err)
	}
	if err := e.RequirePolicy(); err != nil {
		t.Fatal(err)
	}
}

func TestEnvelopeRules(t *testing.T) {
	cases := map[string]func(*outbox.Event){
		"spec version":   func(e *outbox.Event) { e.SpecVersion = "0.3" },
		"id not uuid":    func(e *outbox.Event) { e.ID = "evt_1" },
		"type shape":     func(e *outbox.Event) { e.Type = "PaymentCreated" },
		"type no major":  func(e *outbox.Event) { e.Type = "com.zoiko.pay.payment.intent.created" },
		"no tenant":      func(e *outbox.Event) { e.TenantID = "" },
		"no cell":        func(e *outbox.Event) { e.CellID = "" },
		"no entity":      func(e *outbox.Event) { e.LegalEntityID = "" },
		"version zero":   func(e *outbox.Event) { e.AggregateVersion = 0 },
		"no correlation": func(e *outbox.Event) { e.CorrelationID = "" },
		"classification": func(e *outbox.Event) { e.Classification = "public" },
		"content type":   func(e *outbox.Event) { e.DataContentType = "text/plain" },
		"data array":     func(e *outbox.Event) { e.Data = json.RawMessage(`[1]`) },
		"data invalid":   func(e *outbox.Event) { e.Data = json.RawMessage(`{`) },
		"no time":        func(e *outbox.Event) { e.Time = time.Time{} },
	}
	for name, mutate := range cases {
		e := validEvent()
		mutate(&e)
		if err := e.Validate(); !errors.Is(err, outbox.ErrInvalidEvent) {
			t.Errorf("%s: err = %v; want ErrInvalidEvent", name, err)
		}
	}
	e := validEvent()
	e.PolicyVersion = ""
	if err := e.RequirePolicy(); err == nil || !strings.Contains(err.Error(), "policyversion") {
		t.Errorf("effect event without policy: %v", err)
	}
}

func TestBackoffIsBounded(t *testing.T) {
	if outbox.DefaultBackoff(1) != time.Second || outbox.DefaultBackoff(2) != 2*time.Second {
		t.Fatal("backoff should start at 1s and double")
	}
	if outbox.DefaultBackoff(100) != 5*time.Minute {
		t.Fatal("backoff should cap at 5 minutes")
	}
}
