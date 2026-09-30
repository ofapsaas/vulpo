// tokens_trim_test.go — fb-024-harness-headless: parser tolerante en lo
// válido.
//
// P4 (PIN): espacios en los bordes, CRLF, líneas vacías y comentarios
// se aceptan y recortan; el resultado es exactamente los tokens limpios.
// Solo cambia el sistema de trim y los comentarios: no exige nada del
// entorno (Selectores declarados: ParseTokensFile). Debe pasar ya en RED
// (PIN): si este test falla en RED, el terreno medido estaba mal.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package server

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseTokensFile_ToleratesBoundaryWhitespace(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "tokens.txt")
	if err := os.WriteFile(f, []byte("  tok1  \r\n\n  # c\ntok2\t\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	toks, err := ParseTokensFile(f)
	if err != nil {
		t.Fatalf("ParseTokensFile = %v", err)
	}
	if len(toks) != 2 || toks[0] != "tok1" || toks[1] != "tok2" {
		t.Fatalf("tokens = %v, want [tok1 tok2]", toks)
	}
}
