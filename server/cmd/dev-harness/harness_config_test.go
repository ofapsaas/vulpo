// harness_config_test.go — fb-024-bootstrap-solo-dev: guardas Go de P3
// (spec §3.2, D-2) sobre la interfaz declarada
// injectHarnessConfig(dstDir, rules string) error.
//
// P3 — la inyección de configuración, llamada sobre un destino con
// manifest.json (background.scripts = [a.js, background.js]):
//
//	(i)   agrega "harness-config.js" como ÚLTIMO elemento de
//	      background.scripts;
//	(ii)  ningún otro campo del manifest cambia (DeepEqual contra
//	      original + append);
//	(iii) el archivo harness-config.js queda escrito en el destino;
//	(iv)  (C2 del audit) el archivo contiene las secuencias escapadas
//	      \" y \\ y NO contiene el rules crudo (con las comillas sin
//	      escapar) — el rules de prueba contiene " y \ (guarda
//	      anti-escape-vacío del audit);
//	(v)   aplicada DESPUÉS de prepareHarnessExtension(src, dst, true),
//	      el orden queda [a.js, background.js, harness-build.js,
//	      harness-config.js].
//
// RED: hoy injectHarnessConfig es un stub que no hace nada → los tests
// fallan por aserción, no por compilación. Sólo contrato observable
// (manifest.json y archivo escrito); sin estructura interna.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

// p3Rules: rules de prueba con " y \ (guarda mandatoria del audit: un
// concatenador sin escape no debe pasar). Raw literal Go: los bytes son
// exactamente el valor de runtime. No contiene la secuencia \" (backslash
// seguido de comilla): así el rules crudo no puede aparecer como substring
// de un texto correctamente escapado (en él, toda comilla va precedida de
// backslash) — el assert negativo de (iv) no es vacuo ni sobre-acoplado.
const p3Rules = `{"allowAddonNewtab":true,"route":"C:\tmp\vulpo"}`

// expectedManifestWithScripts: original redondeado por JSON + scripts
// appendeados al final de background.scripts (patrón del P6 existente).
func expectedManifestWithScripts(t *testing.T, original map[string]any, extra ...string) map[string]any {
	t.Helper()
	b, err := json.Marshal(original)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	bg, _ := m["background"].(map[string]any)
	scripts, _ := bg["scripts"].([]any)
	bg["scripts"] = append(scripts, toAnySlice(extra)...)
	return m
}

func toAnySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

// assertConfigScriptPresent: (iii) — os.Stat del archivo inyectado.
func assertConfigScriptPresent(t *testing.T, dstDir, ctx string) {
	t.Helper()
	if _, err := os.Stat(filepath2(dstDir, "harness-config.js")); err != nil {
		t.Fatalf("%s: harness-config.js falta en el destino: %v", ctx, err)
	}
}

// =============================================================================
// P3 — injectHarnessConfig sobre un destino suelto: (i)+(ii)+(iii)+(iv)
// =============================================================================

func TestInjectHarnessConfig_AppendsConfigScript(t *testing.T) {
	dstDir := t.TempDir()
	original := manifestFixture()
	writeManifest(t, dstDir, original)

	if err := injectHarnessConfig(dstDir, p3Rules); err != nil {
		t.Fatalf("injectHarnessConfig = %v", err)
	}

	// (i)+(ii) manifest = original + harness-config.js al final; nada más cambia.
	got := loadManifest(t, dstDir)
	expected := expectedManifestWithScripts(t, original, "harness-config.js")
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("manifest tras injectHarnessConfig difiere de original + harness-config.js al final de background.scripts: got=%v want=%v", got, expected)
	}

	// (i) explícito: el nuevo elemento es el ÚLTIMO.
	bg, _ := got["background"].(map[string]any)
	scripts, _ := bg["scripts"].([]any)
	if len(scripts) == 0 || scripts[len(scripts)-1] != "harness-config.js" {
		t.Fatalf("harness-config.js no es el último elemento de background.scripts: %v", scripts)
	}

	// (iii) archivo presente.
	assertConfigScriptPresent(t, dstDir, "(iii)")

	// (iv) C2: secuencias escapadas presentes; rules crudo ausente.
	b, err := os.ReadFile(filepath2(dstDir, "harness-config.js"))
	if err != nil {
		t.Fatalf("leer harness-config.js: %v", err)
	}
	content := string(b)
	if !strings.Contains(content, `\"`) {
		t.Fatal(`harness-config.js no contiene la secuencia escapada \" (las comillas del rules deben quedar escapadas en el literal JS)`)
	}
	if !strings.Contains(content, `\\`) {
		t.Fatal(`harness-config.js no contiene la secuencia escapada \\ (los backslashes del rules deben quedar escapados en el literal JS)`)
	}
	if strings.Contains(content, p3Rules) {
		t.Fatalf("harness-config.js contiene el rules crudo con comillas sin escapar (el escape quedó roto): %s", p3Rules)
	}
}

// =============================================================================
// P3 — injectHarnessConfig DESPUÉS de prepareHarnessExtension(…, true): (v)
// =============================================================================

func TestInjectHarnessConfig_AfterPrepareHarnessExtension(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()
	_, original := makeExtFixture(t, srcDir)

	if err := prepareHarnessExtension(srcDir, dstDir, true); err != nil {
		t.Fatalf("prepareHarnessExtension = %v", err)
	}
	if err := injectHarnessConfig(dstDir, p3Rules); err != nil {
		t.Fatalf("injectHarnessConfig = %v", err)
	}

	// (v) orden final: [..., background.js, harness-build.js, harness-config.js]
	got := loadManifest(t, dstDir)
	expected := expectedManifestWithScripts(t, original, "harness-build.js", "harness-config.js")
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("manifest tras prepare+inject difiere de original + [harness-build.js, harness-config.js]: got=%v want=%v", got, expected)
	}
	bg, _ := got["background"].(map[string]any)
	scripts, _ := bg["scripts"].([]any)
	n := len(scripts)
	if n < 2 || scripts[n-2] != "harness-build.js" || scripts[n-1] != "harness-config.js" {
		t.Fatalf("orden final incorrecto en background.scripts: %v (want [..., background.js, harness-build.js, harness-config.js])", scripts)
	}

	// (iii) archivo presente también en la copia completa.
	assertConfigScriptPresent(t, dstDir, "(v)")
}
