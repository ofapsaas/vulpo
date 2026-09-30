// harness_stubs.go — stubs de RED (fb-024-harness-headless, spec §5).
//
// El spec declara dos interfaces en el contrato (§3.2 letras finales y
// D-1/D-3) y el RED puede crearlas como stubs para que los tests P1/P6
// fallen POR ASERCIÓN y no por compilación:
//
//   - writeDevTokensFile: stub con el formato ACTUAL documentado en el
//     spec §2 (:2098 escribe `devToken + " dev\n"`, formato legacy
//     `token agente`).
//   - prepareHarnessExtension: stub que no copia nada, devuelve nil.
//
// El implementer (GREEN) reemplaza el cuerpo de ambas firmas por la
// implementación real (D-1: `devToken + "\n"` desde el único escritor;
// D-3: copia a dstDir excluyendo node_modules, inyecta harness-build.js
// al final de background.scripts con injectBuild).
//
// El valor del token se fija por el discovery del spec (medido: el archivo
// `dev-token dev` era el que el harness actual producía).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import "os"

// harnessDevToken es el token del harness que los tests P1/P2 verifican
// contra ParseTokensFile/StartServer. Valor del discovery (spec, D.1).
const harnessDevToken = "dev-token"

// writeDevTokensFile — stub RED: escribe el formato actual
// (devToken + " dev\n"). GREEN debe escribir devToken + "\n" (D-1).
func writeDevTokensFile(path string) error {
	return os.WriteFile(path, []byte(harnessDevToken+" dev\n"), 0o600)
}

// prepareHarnessExtension — stub RED: no copia, dev nil.
// GREEN debe implementar D-3 (copia sin node_modules + inyección).
func prepareHarnessExtension(srcDir, dstDir string, injectBuild bool) error {
	_ = srcDir
	_ = dstDir
	_ = injectBuild
	return nil
}
