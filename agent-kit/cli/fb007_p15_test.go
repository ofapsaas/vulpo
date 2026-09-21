package main_test

// fb-020-007-orm-navigation-hang — sub-fase RED, vlpmcp (spec §2.5, P15).
// El timeout propio del cliente no se reporta como "server unreachable".

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const spec007 = "docs/specs/fb-020-007-orm-navigation-hang/spec.md"

func TestFb007_P15_ClientTimeoutIsNotServerUnreachable(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 3 * time.Second })
	env := newEnv(t, f.URL())
	env.Vars["VLP_TIMEOUT"] = "1"

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 8)
	if !strings.Contains(res.Stderr, "no answer from server within 1s") {
		t.Errorf("%s %s: P15: stderr = %q, want contener \"no answer from server within 1s\"", spec007, t.Name(), res.Stderr)
	}
	if strings.Contains(res.Stderr, "server unreachable") {
		t.Errorf("%s %s: P15: stderr = %q contiene \"server unreachable\" en un timeout del cliente", spec007, t.Name(), res.Stderr)
	}
}

// P18 (spec v1.1 §2.5): VLP_TIMEOUT por defecto 1800 s. Sin la variable
// en el entorno, un server que tarda 3 s no corta la llamada.
func TestFb007_P18_NoTimeoutEnvSlowServerSucceeds(t *testing.T) {
	f := newFakeMCP(t)
	f.set(func(f *fakeMCP) { f.callDelay = 3 * time.Second })
	env := newEnv(t, f.URL())
	delete(env.Vars, "VLP_TIMEOUT")

	expectExit(t, runVlpmcp(t, env, "", "call", "vlp_listTabs"), 0)
}

// P18 (T-doc): docs/agents.md documenta el default 1800 de VLP_TIMEOUT.
func TestFb007_P18_AgentsDocDocumentsDefault1800(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "agents.md"))
	if err != nil {
		t.Fatalf("%s %s: P18: no se pudo leer docs/agents.md: %v", spec007, t.Name(), err)
	}
	doc := string(data)
	if !strings.Contains(doc, "VLP_TIMEOUT") || !strings.Contains(doc, "1800") {
		t.Errorf("%s %s: P18: docs/agents.md no documenta VLP_TIMEOUT con default 1800", spec007, t.Name())
	}
}

func TestFb007_P15_ClosedPortStillServerUnreachable(t *testing.T) {
	env := newEnv(t, unreachableURL(t))
	env.Vars["VLP_TIMEOUT"] = "1"

	res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
	expectExit(t, res, 8)
	if !strings.Contains(res.Stderr, "server unreachable") {
		t.Errorf("%s %s: P15: puerto cerrado stderr = %q, want contener \"server unreachable\"", spec007, t.Name(), res.Stderr)
	}
}
