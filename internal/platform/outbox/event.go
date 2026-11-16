package outbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Classification of an event (04-06 §3.1).
type Classification string

// Allowed classifications.
const (
	RestrictedFinancial Classification = "restricted-financial"
	Confidential        Classification = "confidential"
	InternalAggregate   Classification = "internal-aggregate"
)

// typePattern is com.zoiko.pay.<domain>.<aggregate>.<fact>.v<MAJOR> (04-06 §3.2).
var typePattern = regexp.MustCompile(`^com\.zoiko\.pay\.[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+\.v[1-9][0-9]*$`)

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Event is the canonical CloudEvents-compatible envelope (04-06 §3.1).
// Attribute names are lower-case alphanumeric; payload fields are snake_case.
type Event struct {
	SpecVersion      string          `json:"specversion"`
	ID               string          `json:"id"`
	Source           string          `json:"source"`
	Type             string          `json:"type"`
	Subject          string          `json:"subject"`
	Time             time.Time       `json:"time"`
	DataContentType  string          `json:"datacontenttype"`
	DataSchema       string          `json:"dataschema"`
	TenantID         string          `json:"tenantid"`
	MerchantID       string          `json:"merchantid,omitempty"`
	CellID           string          `json:"cellid"`
	LegalEntityID    string          `json:"legalentityid"`
	AggregateID      string          `json:"aggregateid"`
	AggregateVersion int64           `json:"aggregateversion"`
	CorrelationID    string          `json:"correlationid"`
	CausationID      string          `json:"causationid,omitempty"`
	PolicyVersion    string          `json:"policyversion,omitempty"`
	Classification   Classification  `json:"classification"`
	RecordedAt       time.Time       `json:"recordedat"`
	TraceParent      string          `json:"traceparent,omitempty"`
	Data             json.RawMessage `json:"data"`
}

// ErrInvalidEvent wraps every validation failure.
var ErrInvalidEvent = errors.New("invalid event")

// Validate checks the required attributes. PolicyVersion is required for
// events that record an effect (04-06: "Required for effects"); the producer
// decides that, so it is checked by RequirePolicy, not here.
func (e *Event) Validate() error {
	var problems []string
	req := func(name, v string) {
		if strings.TrimSpace(v) == "" {
			problems = append(problems, name+" is required")
		}
	}
	if e.SpecVersion != "1.0" {
		problems = append(problems, `specversion must be "1.0"`)
	}
	if !uuidPattern.MatchString(e.ID) {
		problems = append(problems, "id must be a lowercase UUID")
	}
	req("source", e.Source)
	if !typePattern.MatchString(e.Type) {
		problems = append(problems, "type must match com.zoiko.pay.<domain>.<aggregate>.<fact>.v<major>")
	}
	req("subject", e.Subject)
	if e.Time.IsZero() {
		problems = append(problems, "time is required")
	}
	if e.DataContentType != "application/json" {
		problems = append(problems, "datacontenttype must be application/json")
	}
	req("dataschema", e.DataSchema)
	req("tenantid", e.TenantID)
	req("cellid", e.CellID)
	req("legalentityid", e.LegalEntityID)
	req("aggregateid", e.AggregateID)
	if e.AggregateVersion < 1 {
		problems = append(problems, "aggregateversion must be >= 1")
	}
	req("correlationid", e.CorrelationID)
	switch e.Classification {
	case RestrictedFinancial, Confidential, InternalAggregate:
	default:
		problems = append(problems, "classification is not an allowed value")
	}
	if e.RecordedAt.IsZero() {
		problems = append(problems, "recordedat is required")
	}
	if len(e.Data) == 0 || !json.Valid(e.Data) || e.Data[0] != '{' {
		problems = append(problems, "data must be a JSON object")
	}
	if len(problems) > 0 {
		return fmt.Errorf("%w: %s", ErrInvalidEvent, strings.Join(problems, "; "))
	}
	return nil
}

// RequirePolicy fails when an effect event has no policy version.
func (e *Event) RequirePolicy() error {
	if e.PolicyVersion == "" {
		return fmt.Errorf("%w: policyversion is required for an effect event", ErrInvalidEvent)
	}
	return nil
}

// marshal produces the exact bytes stored and delivered. Times are UTC
// RFC 3339 with nanosecond precision trimmed by encoding/json.
func (e *Event) marshal() ([]byte, error) {
	c := *e
	c.Time, c.RecordedAt = c.Time.UTC(), c.RecordedAt.UTC()
	return json.Marshal(c)
}
