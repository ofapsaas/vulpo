// harness_ext.go — fb-024-harness-headless (GREEN).
//
// D-1: writeDevTokensFile es el ÚNICO escritor del archivo de tokens del
// harness; escribe el formato canónico (un token por línea, sin espacios
// internos), que es lo que server.ParseTokensFile acepta.
//
// D-3: prepareHarnessExtension copia la extensión a un directorio temporal
// FUERA del repo, excluyendo node_modules/, y — con injectBuild — agrega
// harness-build.js como ÚLTIMO elemento de background.scripts de la copia y
// escribe el archivo. El script sólo existe en esa copia (I-2); srcDir queda
// byte-idéntico (la fuente nunca se toca).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// harnessBuildFileName: nombre del script sólo-harness inyectado en la copia.
const harnessBuildFileName = "harness-build.js"

// harnessTokensToken: token que escribe writeDevTokensFile. Es devToken salvo
// en el selector de prueba P10 (VLP_HARNESS_BADTOKEN=1), que escribe un token
// ajeno al harness para forzar el 401 del probe (D-5).
var harnessTokensToken = devToken

// writeDevTokensFile: escribe el archivo de tokens en el formato canónico
// (un token por línea, sin espacios internos). Único escritor (D-1).
func writeDevTokensFile(path string) error {
	return os.WriteFile(path, []byte(harnessTokensToken+"\n"), 0o600)
}

// harnessBuildJS: script SÓLO del harness (D-3). Sólo altera el valor inicial
// de planMode: envuelve getOrCreateProfile para que todo perfil quede en Build
// (planMode=false), recién creado o preexistente. No toca togglePlanMode, ni
// el storage, ni el WS. Si getOrCreateProfile no existe, lanza: fail-closed,
// el perfil queda en Plan y el harness lo reporta (P7).
//
// Se carga DESPUÉS de background.js (último de background.scripts): los
// scripts clásicos de background comparten el entorno léxico global, así que
// el envoltorio no obliga a tocar el producto.
const harnessBuildJS = `// harness-build.js — fb-024-harness-headless (D-3).
// Script SÓLO del harness: existe únicamente dentro de la copia temporal de
// la extensión que arma cmd/dev-harness. Nunca en el repo ni en una XPI.
(function () {
  "use strict";
  if (typeof getOrCreateProfile !== "function") {
    throw new Error("harness-build.js: getOrCreateProfile not found (fail-closed: profile stays in Plan)");
  }
  var baseGetOrCreateProfile = getOrCreateProfile;
  getOrCreateProfile = function (profileId, bridgeUrl, token) {
    var profile = baseGetOrCreateProfile(profileId, bridgeUrl, token);
    // A PROPÓSITO: reaplica planMode=false en CADA llamada a
    // getOrCreateProfile, no sólo al crear el perfil. background.js vuelve a
    // pedir el perfil al recargar la config (getOrCreateProfile), y el
    // harness necesita que ese perfil también quede en Build: por eso el
    // wrapper reescribe el flag en cada retorno, pisando un toggle a Plan
    // dentro de la copia. Todo queda confinado a la copia del harness (I-2);
    // el producto (background.js) no se toca.
    if (profile && profile.planMode !== false) {
      profile.planMode = false;
    }
    return profile;
  };
})();
`

// prepareHarnessExtension: copia srcDir → dstDir excluyendo node_modules/ a
// cualquier profundidad. Con injectBuild agrega harnessBuildFileName al final
// de background.scripts en la copia de manifest.json y escribe el script.
// Nunca modifica srcDir.
func prepareHarnessExtension(srcDir, dstDir string, injectBuild bool) error {
	err := filepath.WalkDir(srcDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			if d.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dstDir, rel), 0o755)
		}
		if rel == "manifest.json" {
			// Se escribe al final: verbatim, o re-serializado con la inyección.
			return nil
		}
		return copyHarnessFile(filepath.Join(dstDir, rel), path)
	})
	if err != nil {
		return err
	}

	manifestBytes, err := os.ReadFile(filepath.Join(srcDir, "manifest.json"))
	if err != nil {
		return fmt.Errorf("read manifest.json: %w", err)
	}
	if injectBuild {
		var m map[string]any
		if err := json.Unmarshal(manifestBytes, &m); err != nil {
			return fmt.Errorf("manifest.json: %w", err)
		}
		bg, ok := m["background"].(map[string]any)
		if !ok {
			return fmt.Errorf("manifest.json: background missing")
		}
		scripts, ok := bg["scripts"].([]any)
		if !ok {
			return fmt.Errorf("manifest.json: background.scripts missing")
		}
		bg["scripts"] = append(scripts, harnessBuildFileName)
		manifestBytes, err = json.Marshal(m)
		if err != nil {
			return fmt.Errorf("manifest.json: %w", err)
		}
		if err := os.WriteFile(filepath.Join(dstDir, harnessBuildFileName), []byte(harnessBuildJS), 0o644); err != nil {
			return err
		}
	}
	return os.WriteFile(filepath.Join(dstDir, "manifest.json"), manifestBytes, 0o644)
}

// copyHarnessFile: copia byte a byte src → dst, creando los directorios padre.
func copyHarnessFile(dst, src string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
