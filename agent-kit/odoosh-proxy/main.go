// Command vlp-odoosh-proxy is the HTTP proxy that replaces
// https://www.odoo.sh in the egress of odoosh-mcp and translates its control
// plane into a synchronous evaluation inside an authenticated odoo.sh tab via
// Vulpo (vlp_eval) (fb-025-001-proxy-readonly, spec v1 §3).
//
// It reads the token from a 0600 file, keeps the MCP session only in memory,
// discards the incoming Cookie and never emits the token.
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
)

var version = "dev"

func main() {
	if err := run(); err != nil {
		log.Printf("vlp-odoosh-proxy: %v", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	// Fail loud on a non-loopback bind without the explicit opt-in (spec §3.2).
	if !isLoopback(cfg.bind) && !cfg.allowNonLoopback {
		return fmt.Errorf("refusing non-loopback bind %q without VLP_PROXY_ALLOW_NON_LOOPBACK=1", cfg.bind)
	}
	// Fail loud on an unreadable token or a mode other than 0600 (spec §3.2).
	token, err := readToken(cfg.tokenFile)
	if err != nil {
		return err
	}

	addr := net.JoinHostPort(cfg.bind, cfg.port)
	srv := &http.Server{
		Addr:    addr,
		Handler: newProxy(cfg, newMCPClient(cfg.url, token, cfg.evalTimeout, cfg.transportMaxBytes)),
	}
	log.Printf("vlp-odoosh-proxy listening on %s", addr)
	return srv.ListenAndServe()
}
