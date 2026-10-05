// Command vlp-odoosh-proxy is the read-only proxy that replaces
// https://www.odoo.sh in the egress of odoosh-mcp and translates its control
// plane into a synchronous evaluation inside an authenticated odoo.sh tab via
// Vulpo (vlp_eval).
//
// This file is the RED scaffold for fb-025-001-proxy-readonly: it only brings
// up an HTTP server that answers 404 to every request. The real behavior
// (allowlist, healthcheck, MCP transport, cookie discard, error mapping) is
// implemented in GREEN.
package main

import (
	"log"
	"net"
	"net/http"
	"os"
)

const (
	defaultBind = "127.0.0.1"
	defaultPort = "8899"
)

// placeholderHandler answers 404 to every request: no behavior yet.
func placeholderHandler(w http.ResponseWriter, r *http.Request) {
	http.NotFound(w, r)
}

func main() {
	bind := envOr("VLP_PROXY_BIND", defaultBind)
	port := envOr("VLP_PROXY_PORT", defaultPort)

	addr := net.JoinHostPort(bind, port)
	srv := &http.Server{
		Addr:    addr,
		Handler: http.HandlerFunc(placeholderHandler),
	}

	log.Printf("vlp-odoosh-proxy listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("vlp-odoosh-proxy: %v", err)
	}
}

// envOr returns the value of the environment variable named key, or def when
// the variable is unset or empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
