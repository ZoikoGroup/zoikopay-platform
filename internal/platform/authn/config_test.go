package authn

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func lookup(env map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := env[k]; return v, ok }
}

func TestConfigFromEnvKeycloak(t *testing.T) {
	c, err := configFromLookup(lookup(map[string]string{
		EnvIssuer:         "http://localhost:8180/realms/zoikopay",
		EnvAudience:       "zoikopay-gateway",
		EnvJWKSURL:        "http://localhost:8180/realms/zoikopay/protocol/openid-connect/certs",
		EnvAlgorithms:     "RS256, ES256",
		EnvRequiredClaims: "typ=Bearer, azp=zoikopay-console",
		EnvSessionIDClaim: "sid",
		EnvLeeway:         "10s",
		EnvMaxLifetime:    "15m",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if c.Issuer != "http://localhost:8180/realms/zoikopay" || c.Audience != "zoikopay-gateway" ||
		!reflect.DeepEqual(c.Algorithms, []string{"RS256", "ES256"}) ||
		!reflect.DeepEqual(c.RequiredClaims, map[string]string{"typ": "Bearer", "azp": "zoikopay-console"}) ||
		c.Leeway != 10*time.Second || c.MaxLifetime != 15*time.Minute || c.AllowInsecureHTTP {
		t.Errorf("config = %+v", c)
	}
}

func TestConfigFromEnvRefusesBadValues(t *testing.T) {
	base := map[string]string{
		EnvIssuer: "https://idp.example.test/realms/zoikopay", EnvAudience: "zoikopay-gateway",
		EnvJWKSURL: "https://idp.example.test/realms/zoikopay/protocol/openid-connect/certs",
	}
	for name, extra := range map[string]map[string]string{
		"missing audience":         {EnvAudience: ""},
		"HS256":                    {EnvAlgorithms: "HS256"},
		"claim without a value":    {EnvRequiredClaims: "typ"},
		"leeway not a duration":    {EnvLeeway: "thirty"},
		"negative lifetime":        {EnvMaxLifetime: "-1h"},
		"insecure flag not a bool": {EnvAllowInsecureHTTP: "yes please"},
	} {
		env := map[string]string{}
		for k, v := range base {
			env[k] = v
		}
		for k, v := range extra {
			env[k] = v
		}
		if _, err := configFromLookup(lookup(env)); !errors.Is(err, ErrConfig) {
			t.Errorf("%s: err = %v; want ErrConfig", name, err)
		}
	}
}
