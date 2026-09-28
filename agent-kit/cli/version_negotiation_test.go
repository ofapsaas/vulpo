// version_negotiation_test.go — negociación kit↔server vía doctor (fb-022
// version-negotiation). El server declara su versión de producto en
// serverInfo.version (initialize); doctor la imprime explícita
// ("server version:") y avisa cuando difiere de la versión del kit instalado.
// Warning only: nunca cambia el exit code (la negociación informa, no corta).
//
// Black-box como el resto de la suite: el binario default reporta "dev"
// (no se compara) y un binario con -X main.version=<v> se compara contra el
// serverInfo.version del fake ("0.5.0" — main_test.go).
package main_test

import (
	"path/filepath"
	"strings"
	"testing"
)

const mismatchLine = "server: version mismatch (server 0.5.0, kit 0.9.9); update the server and/or the agent kit"

func hasMismatchLine(out string) bool {
	return strings.Contains(out, "version mismatch")
}

func TestDoctor_ServerVersionPrintedAndMismatchWarned(t *testing.T) {
	requireBinary(t)
	bin := filepath.Join(t.TempDir(), "vlpmcp-versioned")
	const kitVersion = "0.9.9"
	if err := goBuild(bin, "-ldflags", "-X main.version="+kitVersion); err != nil {
		t.Fatalf("go build -ldflags '-X main.version=%s': %v", kitVersion, err)
	}
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runBinary(t, bin, env, "", "doctor")
	expectExit(t, res, 0)
	expectLine(t, "stdout", res.Stdout, "server version: 0.5.0")
	expectLine(t, "stdout", res.Stdout, mismatchLine)
}

func TestDoctor_ServerVersionMatchNoWarning(t *testing.T) {
	requireBinary(t)
	bin := filepath.Join(t.TempDir(), "vlpmcp-versioned")
	const kitVersion = "0.5.0" // == serverInfo.version del fake
	if err := goBuild(bin, "-ldflags", "-X main.version="+kitVersion); err != nil {
		t.Fatalf("go build -ldflags '-X main.version=%s': %v", kitVersion, err)
	}
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runBinary(t, bin, env, "", "doctor")
	expectExit(t, res, 0)
	expectLine(t, "stdout", res.Stdout, "server version: 0.5.0")
	if hasMismatchLine(res.Stdout) {
		t.Fatalf("no debía haber aviso de mismatch (kit %s == server): %q", kitVersion, res.Stdout)
	}
}

func TestDoctor_DevVersionNoComparison(t *testing.T) {
	f := newFakeMCP(t)
	env := newEnv(t, f.URL())

	res := runVlpmcp(t, env, "", "doctor") // binario default → version "dev"
	expectLine(t, "stdout", res.Stdout, "server version: 0.5.0")
	if hasMismatchLine(res.Stdout) {
		t.Fatalf("build dev no debe compararse contra el server: %q", res.Stdout)
	}
}
