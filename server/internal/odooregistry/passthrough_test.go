// Package odooregistry tests — guard P8, feature fb-019-001-fix-no-odoo-tab.
//
// P8 (spec docs/specs/fb-019-001-fix-no-odoo-tab/spec.md §3): SIN cambios .go,
// este guard piniza el passthrough del mensaje clasificado de la extensión a
// través de Detect: el error del Hub (p.ej. "Odoo session expired in tab 5.
// Please re-login in the tab.") debe llegar al agente con su texto intacto,
// envuelto en el wrap preexistente "odooregistry: Detect: ". Ese canal es el
// que permite distinguir (b) sesión vencida de (a) detección fallida y del
// mensaje reservado "No Odoo tab detected" (I-4).
//
// Este guard verifica código EXISTENTE: pasa desde el inicio; su rol es
// congelar el canal (patrón guard-PIN, precedent P17 de fb-018-006). Si deja
// de pasar, alguien rompió el wrap/passthrough sin enmienda de spec.
//
// Reutiliza mockHub del package de test (odooregistry_test.go:27) con su campo
// err (L34) — ningún test preexistente ejercitaba ese camino (test-audit §2.1).
package odooregistry

import (
	"errors"
	"strings"
	"testing"
)

func TestDetect_PassthroughHubError_PreservesClassifiedMessage(t *testing.T) {
	hub := &mockHub{err: errors.New("Odoo session expired in tab 5. Please re-login in the tab.")}
	reg := New()

	err := reg.Detect("profA", hub)
	if err == nil {
		t.Fatal("Detect returned nil error, want the Hub error passthrough")
	}
	if !strings.Contains(err.Error(), "Odoo session expired in tab 5. Please re-login in the tab.") {
		t.Errorf("Detect error %q does not contain the classified Hub message (the channel that distinguishes expired from detection-failed)", err.Error())
	}
	if !strings.Contains(err.Error(), "odooregistry: Detect: ") {
		t.Errorf("Detect error %q does not contain the pre-existing wrap prefix %q", err.Error(), "odooregistry: Detect: ")
	}
}
