package main

// fb-024-settle-flaky-harness — stubs RED de P1 (spec §3.2/D-2).
//
// Los helpers de barrera observables aún no existen (RED de P1); estos stubs
// devuelven false inmediato para que el RED falle por aserción y no por
// error de compilación. El implementer los reemplaza en GREEN con las
// barreras reales (D-2) cableadas a /settle-status. Único archivo no-test
// del RED (autorizado por el encargo). Se elimina con la implementación.

import "time"

// waitForApplied espera hasta applied≥min y devuelve true; false honesto al vencer.
func waitForApplied(pageURL string, min int, timeout time.Duration) bool { return false }

// waitForTransition espera hasta transition==want y devuelve true; false honesto al vencer.
func waitForTransition(pageURL, want string, timeout time.Duration) bool { return false }

// waitForDocChange espera hasta doc!=prevToken y devuelve true; false honesto al vencer.
func waitForDocChange(pageURL, prevToken string, timeout time.Duration) bool { return false }

// waitForAppliedStable espera hasta que applied quede sin cambios durante quiet
// y devuelve true; false honesto al vencer.
func waitForAppliedStable(pageURL string, quiet, timeout time.Duration) bool { return false }
