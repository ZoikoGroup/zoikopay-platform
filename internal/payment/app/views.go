package app

import (
	"strings"
	"time"

	"github.com/zoiko/zoikopay/internal/payment/store"
	"github.com/zoiko/zoikopay/internal/platform/money"
)

// IntentView is the public representation (06-01 §11.2, 04-02 §5). Status and
// enums are lower case on the wire per ADR 0001 §2 (04-02 §5.1 asks for upper
// case: OPEN_QUESTIONS Q29). No token, provider account, policy or evidence
// pointer is exposed.
type IntentView struct {
	ID                    string      `json:"id"`
	Object                string      `json:"object"`
	Status                string      `json:"status"`
	Amount                money.Minor `json:"amount_minor"`
	Currency              string      `json:"currency"`
	CaptureMethod         string      `json:"capture_method"`
	AmountAuthorized      money.Minor `json:"amount_authorized_minor"`
	AmountCaptured        money.Minor `json:"amount_captured_minor"`
	AmountCapturable      money.Minor `json:"amount_capturable_minor"`
	LatestOperationID     *string     `json:"latest_operation_id"`
	OperationResolution   *string     `json:"operation_resolution"`
	MerchantReference     *string     `json:"merchant_reference,omitempty"`
	NextAction            *NextAction `json:"next_action"`
	CancellationRequested bool        `json:"cancellation_requested"`
	Revision              int64       `json:"revision"`
	ExpiresAt             *time.Time  `json:"expires_at,omitempty"`
	CreatedAt             time.Time   `json:"created_at"`
	UpdatedAt             time.Time   `json:"updated_at"`
}

// NextAction is a time-bounded customer action reference (04-02 §5).
type NextAction struct {
	Type      string     `json:"type"`
	Ref       string     `json:"ref"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"`
}

// OperationView is an operation receipt (04-02 §6, GET /v1/operations/{id}).
type OperationView struct {
	ID              string      `json:"id"`
	Object          string      `json:"object"`
	Kind            string      `json:"kind"`
	Resolution      string      `json:"resolution"`
	PaymentIntentID string      `json:"payment_intent_id"`
	Amount          money.Minor `json:"amount_minor"`
	Currency        string      `json:"currency"`
	CreatedAt       time.Time   `json:"created_at"`
	ResolvedAt      *time.Time  `json:"resolved_at,omitempty"`
}

func lower(s string) string { return strings.ToLower(s) }

func intentView(i store.PaymentPaymentIntent, latest *store.PaymentPaymentOperation) IntentView {
	v := IntentView{
		ID: i.PublicID, Object: "payment_intent", Status: lower(i.IntentStatus),
		Amount: money.Minor(i.AmountRequestedMinor), Currency: i.Currency, CaptureMethod: lower(i.CaptureMethod),
		AmountAuthorized: money.Minor(i.AuthorizedMinor), AmountCaptured: money.Minor(i.CapturedMinor),
		MerchantReference: i.MerchantReference, CancellationRequested: i.CancelRequestedAtUtc != nil,
		Revision: i.AggregateVersion, ExpiresAt: i.ExpiresAtUtc, CreatedAt: i.CreatedAtUtc, UpdatedAt: i.UpdatedAtUtc,
	}
	if i.CaptureMethod == "MANUAL" && i.IntentStatus == "REQUIRES_CAPTURE" {
		v.AmountCapturable = money.Minor(i.AuthorizedMinor - i.CapturedMinor - i.ReservedCaptureMinor)
	}
	if latest != nil {
		id, res := latest.PublicID, lower(latest.Resolution)
		v.LatestOperationID, v.OperationResolution = &id, &res
	}
	if i.IntentStatus == "REQUIRES_CUSTOMER_ACTION" && i.ActionRef != nil {
		v.NextAction = &NextAction{Type: "customer_action", Ref: *i.ActionRef, ExpiresAt: i.ActionExpiresAtUtc}
	}
	return v
}

func operationView(o store.PaymentPaymentOperation, intentPublicID string) OperationView {
	return OperationView{
		ID: o.PublicID, Object: "operation", Kind: lower(o.Kind), Resolution: lower(o.Resolution),
		PaymentIntentID: intentPublicID, Amount: money.Minor(o.RequestedMinor), Currency: o.Currency,
		CreatedAt: o.CreatedAtUtc, ResolvedAt: o.ResolvedAtUtc,
	}
}
