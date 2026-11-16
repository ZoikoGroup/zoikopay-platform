package events

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/zoiko/zoikopay/internal/platform/money"
	"github.com/zoiko/zoikopay/internal/platform/outbox"
)

// Full CloudEvents types (04-06 §3.2, 06-01 §11.1). Only registry names are
// used; there is no event for FAILED, CANCELED or EXPIRED in the 04-06
// registry (OPEN_QUESTIONS Q30), so those are recorded in the transition audit.
const (
	TypeIntentCreated          = "com.zoiko.pay.payment.intent.created.v1"
	TypeAttemptRequested       = "com.zoiko.pay.payment.attempt.requested.v1"
	TypeAuthorizationConfirmed = "com.zoiko.pay.payment.authorization.confirmed.v1"
	TypeCaptureConfirmed       = "com.zoiko.pay.payment.capture.confirmed.v1"
	TypeOutcomeUnknown         = "com.zoiko.pay.payment.outcome.unknown.v1"

	// Consumed from BC-04.
	TypeAttemptDispatched = "com.zoiko.pay.payment.attempt.dispatched.v1"
	TypeOutcomeObserved   = "com.zoiko.pay.provider.outcome.observed.v1"
)

// SchemaURI is the immutable schema identifier for a type. The JSON Schemas
// live in api/events/payment/; a URN is used until a schema registry host is
// approved (04-06 §6).
func SchemaURI(eventType string) string { return "urn:zoikopay:schema:" + eventType }

// IntentCreated is payment.intent.created.v1: the intent exists; no provider effect.
type IntentCreated struct {
	PaymentIntentID string      `json:"payment_intent_id"`
	MerchantID      string      `json:"merchant_id"`
	Amount          money.Minor `json:"amount_minor"`
	Currency        string      `json:"currency"`
	CaptureMethod   string      `json:"capture_method"`
	Status          string      `json:"status"`
	CreatedAt       time.Time   `json:"created_at"`
}

// AttemptRequested is payment.attempt.requested.v1: the durable command for
// BC-04 to dispatch exactly once under provider_instruction_key (06-01 §7.1).
type AttemptRequested struct {
	PaymentIntentID        string      `json:"payment_intent_id"`
	OperationID            string      `json:"operation_id"`
	OperationKind          string      `json:"operation_kind"`
	AttemptID              string      `json:"attempt_id"`
	ProviderInstructionKey string      `json:"provider_instruction_key"`
	EconomicEffectID       string      `json:"economic_effect_id"`
	Amount                 money.Minor `json:"amount_minor"`
	Currency               string      `json:"currency"`
	CaptureMethod          string      `json:"capture_method"`
	PaymentMethodTokenRef  string      `json:"payment_method_token_ref,omitempty"`
	Environment            string      `json:"environment"`
}

// AuthorizationConfirmed is payment.authorization.confirmed.v1: a verified
// hold; not capture, not settlement (PI-INV-10).
type AuthorizationConfirmed struct {
	PaymentIntentID  string      `json:"payment_intent_id"`
	OperationID      string      `json:"operation_id"`
	EconomicEffectID string      `json:"economic_effect_id"`
	Amount           money.Minor `json:"amount_minor"`
	Currency         string      `json:"currency"`
	ObservationID    string      `json:"observation_id"`
}

// CaptureConfirmed is payment.capture.confirmed.v1: a verified capture (or
// automatic-capture execution) for BC-05 to post exactly once per
// economic_effect_id. Not bank settlement (06-01 §10).
type CaptureConfirmed struct {
	PaymentIntentID  string      `json:"payment_intent_id"`
	OperationID      string      `json:"operation_id"`
	EconomicEffectID string      `json:"economic_effect_id"`
	Amount           money.Minor `json:"amount_minor"`
	Currency         string      `json:"currency"`
	ObservationID    string      `json:"observation_id"`
}

// OutcomeUnknown is payment.outcome.unknown.v1: inquiry required under the
// original identity; no blind replay (06-01 §7.3).
type OutcomeUnknown struct {
	PaymentIntentID        string `json:"payment_intent_id"`
	OperationID            string `json:"operation_id"`
	OperationKind          string `json:"operation_kind"`
	AttemptID              string `json:"attempt_id"`
	ProviderInstructionKey string `json:"provider_instruction_key"`
	ProviderAccountID      string `json:"provider_account_id,omitempty"`
	Environment            string `json:"environment"`
}

// OutcomeObserved is the data of provider.outcome.observed.v1 as Payments
// consumes it. BC-04 owns the producer schema; this is the consumer contract.
type OutcomeObserved struct {
	ObservationID     string       `json:"observation_id"`
	OperationID       string       `json:"operation_id"`
	Outcome           string       `json:"outcome"`
	SourceChannel     string       `json:"source_channel"`
	ProviderAccountID string       `json:"provider_account_id"`
	ProviderReference string       `json:"provider_reference,omitempty"`
	Amount            *money.Minor `json:"amount_minor,omitempty"`
	Currency          string       `json:"currency,omitempty"`
	RetryEligible     bool         `json:"retry_eligible,omitempty"`
	ActionRef         string       `json:"action_ref,omitempty"`
	ActionExpiresAt   *time.Time   `json:"action_expires_at,omitempty"`
	ObservedAt        time.Time    `json:"observed_at"`
	EvidenceDigest    string       `json:"evidence_digest"`
	Environment       string       `json:"environment"`
}

// AttemptDispatched is the data of payment.attempt.dispatched.v1 (BC-04).
type AttemptDispatched struct {
	OperationID            string    `json:"operation_id"`
	AttemptID              string    `json:"attempt_id"`
	ProviderInstructionKey string    `json:"provider_instruction_key"`
	ProviderAccountID      string    `json:"provider_account_id"`
	DispatchedAt           time.Time `json:"dispatched_at"`
	Environment            string    `json:"environment"`
}

// Scope is the envelope context of a BC-03 event.
type Scope struct {
	Source        string // e.g. /zoikopay/cell_uk_01/bc03
	TenantID      string
	MerchantID    string
	CellID        string
	LegalEntityID string
	CorrelationID string
	CausationID   string
	PolicyVersion string
}

// Envelope wraps data in the 04-06 envelope for aggregate pi at version.
func Envelope(id, eventType, paymentIntentID string, version int64, at time.Time, sc Scope, data any) (outbox.Event, error) {
	b, err := json.Marshal(data)
	if err != nil {
		return outbox.Event{}, fmt.Errorf("marshal %s: %w", eventType, err)
	}
	return outbox.Event{
		SpecVersion: "1.0", ID: id, Source: sc.Source, Type: eventType,
		Subject: "payment_intent/" + paymentIntentID, Time: at, DataContentType: "application/json",
		DataSchema: SchemaURI(eventType), TenantID: sc.TenantID, MerchantID: sc.MerchantID,
		CellID: sc.CellID, LegalEntityID: sc.LegalEntityID, AggregateID: paymentIntentID,
		AggregateVersion: version, CorrelationID: sc.CorrelationID, CausationID: sc.CausationID,
		PolicyVersion: sc.PolicyVersion, Classification: outbox.RestrictedFinancial, Data: b,
	}, nil
}
