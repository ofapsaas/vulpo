// Package mcp — fb-024-opentab-id, stage 3 RED (opentab_resolve_stub.go).
//
// Declaración de las package vars DI del resolver (spec §3 In/5, Enmienda 1:
// "intervalo y plazo del resolver inyectables (package vars)"), para que el
// RED compile y falle POR ASERCIÓN (no por ImportError/link de símbolo).
//
// Este stub es SIN LÓGICA por diseño (aislamiento de roles): el implementer
// (GREEN) materializa `opentab_resolve.go` — resolveOpenTab y el polling
// D-1 — que CONSUME estas vars, y borra/reemplaza este stub en el mismo
// commit. Compile-time guard de GREEN: si el GREEN deja el stub vivo junto a
// su implementación causaría redeclaración (duálnegative imposible de
// comitear en verde).
//
// Defaults = producción (D-1/Q1): intervalo 150 ms, plazo T = 5000 ms.
package mcp

// openTabPollIntervalMs: intervalo entre polls de listTabs del resolver.
var openTabPollIntervalMs = 150

// openTabTimeoutMs: plazo total T de resolución (default 5000 ms — Q1).
var openTabTimeoutMs = 5000
