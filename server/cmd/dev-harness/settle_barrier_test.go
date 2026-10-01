package main

// fb-024-settle-flaky-harness — P1 (spec §3.2, RED).
//
// Unit tests de las 4 barreras observables (D-2) contra un httptest.Server
// que sirve GET /settle-status con JSON {"applied":n,"transition":"…","doc":"…",
// "loop":"…"} controlado por el test. Contrato:
//   - cada barrera bloquea hasta que su condición se cumple y devuelve true
//     (antes del timeout — no-vacuidad);
//   - al vencer el timeout devuelve false honesto (no cuelga);
//   - la condición cumplida a mitad de la espera hace volver antes del timeout.
//
// Cada test cita la cláusula de P1 que verifica. El contrato observable es el
// valor de retorno y su temporalidad; no se pinea el mecanismo de poll interno.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// settleFixture simula el canal de progreso del harness: un servidor HTTP que
// expone /settle-status con el estado mutable controlado por el test.
type settleFixture struct {
	mu         sync.Mutex
	applied    int
	transition string
	doc        string
	loop       string
}

func (f *settleFixture) setState(applied int, transition, doc, loop string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.applied, f.transition, f.doc, f.loop = applied, transition, doc, loop
}

// applyAfter muta el estado después de delay, como el progreso real del
// fixture llegaría a mitad de la espera de una barrera.
func (f *settleFixture) applyAfter(delay time.Duration, fn func()) {
	time.AfterFunc(delay, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		fn()
	})
}

func newSettleFixture(t *testing.T) (*settleFixture, string) {
	t.Helper()
	f := &settleFixture{}
	mux := http.NewServeMux()
	mux.HandleFunc("/settle-status", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		body, err := json.Marshal(map[string]any{
			"applied":    f.applied,
			"transition": f.transition,
			"doc":        f.doc,
			"loop":       f.loop,
		})
		f.mu.Unlock()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return f, srv.URL
}

// P1: "waitForApplied bloquea hasta applied≥min". No-vacuidad: la condición
// cumplida a mitad de la espera hace volver true antes del timeout.
func TestWaitForApplied_BlocksUntilConditionMet(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "off")
	f.applyAfter(100*time.Millisecond, func() { f.applied = 2 })

	start := time.Now()
	got := waitForApplied(pageURL, 2, 3*time.Second)
	elapsed := time.Since(start)

	if !got {
		t.Fatalf("waitForApplied(min=2): quiero true cuando applied llega a 2; obtuve false (espera vacía)")
	}
	if elapsed >= 3*time.Second {
		t.Errorf("waitForApplied volvió después del timeout (%v): no volvió por la condición, volvió por vencimiento", elapsed)
	}
}

// P1 + guarda: "al vencer devuelve false honesto (con un timeout corto)";
// "un caso de timeout debe devolver false (no colgar)".
func TestWaitForApplied_TimeoutReturnsFalseHonest(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "off") // applied nunca alcanza min=3

	start := time.Now()
	got := waitForApplied(pageURL, 3, 300*time.Millisecond)
	elapsed := time.Since(start)

	if got {
		t.Fatalf("waitForApplied(min=3): quiero false al vencer con applied=0; obtuve true")
	}
	if elapsed > 300*time.Millisecond+2*time.Second {
		t.Errorf("waitForApplied tardó %v con timeout 300ms: parece colgar en vez de vencer honesto", elapsed)
	}
}

// P1: idem para waitForTransition — bloquea hasta transition==want.
func TestWaitForTransition_BlocksUntilValueMatches(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "off")
	f.applyAfter(100*time.Millisecond, func() { f.transition = "running" })

	start := time.Now()
	got := waitForTransition(pageURL, "running", 3*time.Second)
	elapsed := time.Since(start)

	if !got {
		t.Fatalf("waitForTransition(running): quiero true cuando transition pasa a running; obtuve false")
	}
	if elapsed >= 3*time.Second {
		t.Errorf("waitForTransition volvió después del timeout (%v): no volvió por la condición", elapsed)
	}
}

// P1 + guarda: timeout de waitForTransition → false honesto.
func TestWaitForTransition_TimeoutReturnsFalseHonest(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "off") // transition nunca pasa a "done"

	start := time.Now()
	got := waitForTransition(pageURL, "done", 300*time.Millisecond)
	elapsed := time.Since(start)

	if got {
		t.Fatalf("waitForTransition(done): quiero false al vencer con transition=idle; obtuve true")
	}
	if elapsed > 300*time.Millisecond+2*time.Second {
		t.Errorf("waitForTransition tardó %v con timeout 300ms: parece colgar", elapsed)
	}
}

// P1: idem para waitForDocChange — bloquea hasta doc!=prevToken.
func TestWaitForDocChange_DetectsNewToken(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "off")
	f.applyAfter(100*time.Millisecond, func() { f.doc = "doc-b" })

	start := time.Now()
	got := waitForDocChange(pageURL, "doc-a", 3*time.Second)
	elapsed := time.Since(start)

	if !got {
		t.Fatalf("waitForDocChange(doc-a): quiero true cuando doc cambia a doc-b; obtuve false")
	}
	if elapsed >= 3*time.Second {
		t.Errorf("waitForDocChange volvió después del timeout (%v): no volvió por la condición", elapsed)
	}
}

// P1 + guarda: timeout de waitForDocChange → false honesto (doc sin cambiar).
func TestWaitForDocChange_TimeoutReturnsFalseHonest(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "off") // doc nunca cambia

	start := time.Now()
	got := waitForDocChange(pageURL, "doc-a", 300*time.Millisecond)
	elapsed := time.Since(start)

	if got {
		t.Fatalf("waitForDocChange(doc-a): quiero false al vencer con doc=doc-a; obtuve true")
	}
	if elapsed > 300*time.Millisecond+2*time.Second {
		t.Errorf("waitForDocChange tardó %v con timeout 300ms: parece colgar", elapsed)
	}
}

// P1: waitForAppliedStable — "applied sin cambios durante quiet" → true.
// applied está quieto desde el inicio; la barrera debe confirmar la ventana
// completa de quietud y devolver true.
func TestWaitForAppliedStable_TrueWhenQuiet(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(5, "idle", "doc-a", "off") // applied=5, sin cambios

	start := time.Now()
	got := waitForAppliedStable(pageURL, 250*time.Millisecond, 3*time.Second)
	elapsed := time.Since(start)

	if !got {
		t.Fatalf("waitForAppliedStable(quiet=250ms): quiero true con applied quieto en 5; obtuve false")
	}
	if elapsed > 3*time.Second {
		t.Errorf("waitForAppliedStable tardó %v con timeout 3s: no volvió por la quietud observada", elapsed)
	}
}

// P1 + guarda: si applied sigue cambiando, la ventana de quietud nunca se
// completa → false honesto al vencer (no pasa en vacío).
func TestWaitForAppliedStable_TimeoutWhileChanging(t *testing.T) {
	f, pageURL := newSettleFixture(t)
	f.setState(0, "idle", "doc-a", "on")

	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		tick := time.NewTicker(100 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				f.mu.Lock()
				f.applied++
				f.mu.Unlock()
			}
		}
	}()

	start := time.Now()
	got := waitForAppliedStable(pageURL, 250*time.Millisecond, 2*time.Second)
	elapsed := time.Since(start)

	if got {
		t.Fatalf("waitForAppliedStable(quiet=250ms): quiero false con applied cambiando cada 100ms; obtuve true (ventana de quietud vacía)")
	}
	if elapsed > 2*time.Second+2*time.Second {
		t.Errorf("waitForAppliedStable tardó %v con timeout 2s: parece colgar", elapsed)
	}
}
