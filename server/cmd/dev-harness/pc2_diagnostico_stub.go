package main

// pc2_diagnostico_stub.go — STUB de RED (fb-024-harness-pc2-diagnostico).
//
// Firmas mínimas declaradas por el spec (D-1/D-2, §3.2 P1/P2) para que los
// tests de RED compilen y fallen POR ASERCIÓN (no por ImportError/compile):
//   - pc2NoRegistrationLine: devuelve el literal colapsado viejo de
//     main.go (la única línea de PC2 hoy) para ambas ramas — exactamente el
//     estado que la feature elimina.
//   - waitForStartURLTab: devuelve (0, false) instantáneo — ni vence al
//     fin de la ventana ni observa tabs.
//
// Este archivo es el ÚNICO no-test del RED y debe ELIMINARSE en GREEN cuando
// pc2_diagnostico.go implemente las funciones reales (las firmas quedan
// puestas por este stub; el implementer conserva las firmas y borra este
// archivo).

import "time"

const pc2OldLiteral = "  [FAIL] precondition: extension not configured (harness-config) — the extension did not register with the server within the PC2 timeout"

// pc2NoRegistrationLine — stub RED: replica el literal colapsado actual.
func pc2NoRegistrationLine(configInjected bool) string {
	_ = configInjected
	return pc2OldLiteral
}

// waitForStartURLTab — stub RED: no observa nada, devuelve (0, false).
func waitForStartURLTab(port int, pageURL string, timeout time.Duration) (int, bool) {
	_, _, _ = port, pageURL, timeout
	return 0, false
}
