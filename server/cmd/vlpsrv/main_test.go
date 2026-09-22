// main_test.go — seam de configuración del CLI (resolveBindAddr). Verifican
// que VLP_BIND_ADDR se resuelve con default 127.0.0.1 (PC-04) y que el mensaje
// READY incluye bind+port (PC-05). TestParseTokensFile: formato simple.
package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"vulpo/server/internal/server"
)

// PC-04 — resolveBindAddr: con VLP_BIND_ADDR=0.0.0.0 → "0.0.0.0"; sin env →
// default "127.0.0.1".
func TestResolveBindAddr_FromEnv(t *testing.T) {
	t.Setenv("VLP_BIND_ADDR", "0.0.0.0")
	if got := resolveBindAddr(); got != "0.0.0.0" {
		t.Fatalf("resolveBindAddr = %q, want 0.0.0.0 (de env)", got)
	}
}

func TestResolveBindAddr_Default(t *testing.T) {
	t.Setenv("VLP_BIND_ADDR", "")
	if got := resolveBindAddr(); got != "127.0.0.1" {
		t.Fatalf("resolveBindAddr = %q, want default 127.0.0.1", got)
	}
}

// PC-05 — el mensaje SYSTEM VLP_READY incluye bind y port.
func TestReadyMessage_IncludesBindAndPort(t *testing.T) {
	msg := formatReady(0, "0.0.0.0", 2)
	if !strings.Contains(msg, "bind:0.0.0.0") || !strings.Contains(msg, "port:0") {
		t.Fatalf("READY = %q, want bind:0.0.0.0 y port:0", msg)
	}
}

// ParseTokensFile — formato simple: un token por línea, comentarios '#',
// líneas vacías ignoradas; ilegible → error (fail-loud).
func TestParseTokensFile(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "tokens.txt")
	if err := os.WriteFile(f, []byte("# comentario\ntok1\n\ntok2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	toks, err := server.ParseTokensFile(f)
	if err != nil {
		t.Fatalf("parse = %v", err)
	}
	if len(toks) != 2 || toks[0] != "tok1" || toks[1] != "tok2" {
		t.Fatalf("tokens = %v, want [tok1 tok2]", toks)
	}
	// ilegible → error
	if _, err := server.ParseTokensFile(filepath.Join(dir, "no-existe.txt")); err == nil {
		t.Fatal("archivo inexistente debe fallar (fail-loud)")
	}
}
