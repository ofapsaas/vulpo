// harness_config_stub.go — fb-024-bootstrap-solo-dev: stub RED de la
// interfaz declarada en el spec D-2 (§3.1). No hace nada: los tests de P3
// (harness_config_test.go) deben fallar por aserción, no por compilación.
// El implementer reemplaza este stub en GREEN (harness_ext.go).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

// injectHarnessConfig inyecta la configuración del harness en la copia de
// la extensión (dstDir): agrega "harness-config.js" al final de
// background.scripts y escribe el archivo con rules como literal JS
// escapado. STUB RED: devuelve nil sin efecto.
func injectHarnessConfig(dstDir, rules string) error {
	return nil
}
