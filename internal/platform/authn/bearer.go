package authn

import (
	"net/http"
	"strings"
)

// BearerToken returns the token from an "Authorization: Bearer <token>"
// header (RFC 6750 §2.1). The scheme is case-insensitive; anything else,
// including a second Authorization header, an empty token, a token in the
// query string or extra spaces, is refused with ErrInvalidToken.
func BearerToken(r *http.Request) (string, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return "", invalid("exactly one Authorization header is required")
	}
	scheme, token, ok := strings.Cut(values[0], " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") || token == "" || len(token) > maxTokenBytes ||
		strings.ContainsAny(token, " \t\r\n") {
		return "", invalid("authorization header is not a bearer token")
	}
	return token, nil
}
