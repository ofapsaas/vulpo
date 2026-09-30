// tokens_strict_test.go — fb-024-harness-headless: parser estricto de tokens.
//
// P3: una línea con espacio interno (espacio o tab) hace fallar
// ParseTokensFile con un error que nombra `line <N>` (N arranca en 1 y
// cuenta TODAS las líneas del archivo) y NUNCA revela el contenido de la
// línea (I-4). Guarda: el mismo archivo sin la línea mala parsea [tok1].
//
// RED: hoy el parser acepta la línea entera como token (no hay error).
// GREEN: el error debe salir por aserción, no por compilación.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTokensFile_StrictInnerWhitespace(t *testing.T) {
	dir := t.TempDir()

	t.Run("space inner line → error line 3, no content leak", func(t *testing.T) {
		f := filepath.Join(dir, "tokens-space.txt")
		if err := os.WriteFile(f, []byte("# c\ntok1\nsecretA secretB\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		toks, err := ParseTokensFile(f)
		if err == nil {
			t.Fatalf("ParseTokensFile = %v, want error (línea con espacio interno)", toks)
		}
		if !strings.Contains(err.Error(), "line 3") {
			t.Fatalf("error = %q, want contiene 'line 3'", err.Error())
		}
		if strings.Contains(err.Error(), "secretA") || strings.Contains(err.Error(), "secretB") {
			t.Fatalf("error filtra contenido de la línea (I-4): %q", err.Error())
		}
	})

	t.Run("tab inner line → error line 2, no content", func(t *testing.T) {
		f := filepath.Join(dir, "tokens-tab.txt")
		if err := os.WriteFile(f, []byte("tok1\nsecretA\tsecretB\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		toks, err := ParseTokensFile(f)
		if err == nil {
			t.Fatalf("ParseTokensFile = %v, want error (línea con tab interno)", toks)
		}
		if !strings.Contains(err.Error(), "line 2") {
			t.Fatalf("error = %q, want contiene 'line 2'", err.Error())
		}
		if strings.Contains(err.Error(), "secretA") || strings.Contains(err.Error(), "secretB") {
			t.Fatalf("error filtra contenido de la línea (I-4): %q", err.Error())
		}
	})

	t.Run("guard: same file without bad line parses tok1", func(t *testing.T) {
		f := filepath.Join(dir, "tokens-clean.txt")
		if err := os.WriteFile(f, []byte("# c\ntok1\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		toks, err := ParseTokensFile(f)
		if err != nil {
			t.Fatalf("parse = %v", err)
		}
		if len(toks) != 1 || toks[0] != "tok1" {
			t.Fatalf("tokens = %v, want [tok1]", toks)
		}
	})
}
