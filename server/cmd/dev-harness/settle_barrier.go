package main

// fb-024-settle-flaky-harness — barreras observables (D-2, GREEN).
//
// Las 4 barreras leen el canal de progreso del fixture en GET /settle-status
// (D-1: JSON {applied, transition, doc, loop}) y bloquean hasta que la premisa
// del paso está observablemente cumplida; al vencer devuelven false honesto
// (I-5, P1), nunca true por vacío. El canal viaja por HTTP, no por mutaciones
// del DOM observado por `settle` (I-4), así que no reinicia su ventana de
// quietud. El contrato lo fija settle_barrier_test.go (P1).

import (
	"io"
	"net/http"
	"strings"
	"time"
)

// settlePollInterval: cadencia de sondeo de las barreras. Más fina que el poll
// del fixture (150 ms) para acotar el retardo de detección sin martillar.
const settlePollInterval = 50 * time.Millisecond

// readSettleStatus: lee /settle-status del fixture y lo parsea a settleReport.
// ok=false si el GET falla o el cuerpo no parsea (las barreras no confunden un
// fallo de transporte con una condición cumplida).
func readSettleStatus(pageURL string) (settleReport, bool) {
	var rep settleReport
	resp, err := http.Get(strings.TrimSuffix(pageURL, "/") + "/settle-status")
	if err != nil {
		return rep, false
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if !parseJSON(string(b), &rep) {
		return rep, false
	}
	return rep, true
}

// waitForApplied espera hasta applied≥min y devuelve true; false honesto al vencer.
func waitForApplied(pageURL string, min int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if rep, ok := readSettleStatus(pageURL); ok && rep.Applied >= min {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(settlePollInterval)
	}
}

// waitForTransition espera hasta transition==want y devuelve true; false honesto al vencer.
func waitForTransition(pageURL, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if rep, ok := readSettleStatus(pageURL); ok && rep.Transition == want {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(settlePollInterval)
	}
}

// waitForDocChange espera hasta doc!=prevToken y devuelve true; false honesto al vencer.
func waitForDocChange(pageURL, prevToken string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if rep, ok := readSettleStatus(pageURL); ok && rep.Doc != prevToken {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(settlePollInterval)
	}
}

// waitForAppliedStable espera hasta que applied quede sin cambios durante quiet
// y devuelve true; false honesto al vencer. La ventana sólo se evalúa sobre
// lecturas exitosas: un fallo de transporte no cuenta como quietud.
func waitForAppliedStable(pageURL string, quiet, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	last := 0
	lastChange := time.Time{}
	have := false
	for {
		if rep, ok := readSettleStatus(pageURL); ok {
			if !have || rep.Applied != last {
				last = rep.Applied
				lastChange = time.Now()
				have = true
			} else if time.Since(lastChange) >= quiet {
				return true
			}
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(settlePollInterval)
	}
}
