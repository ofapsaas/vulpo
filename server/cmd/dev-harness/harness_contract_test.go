// harness_contract_test.go — fb-024-harness-headless: guardas Go del
// contrato entre el harness, el archivo de tokens y el parser (D-1) y
// del preparador de la copia de la extensión (D-3).
//
// P1 — writeDevTokensFile escribe el formato canónico: los bytes
//
//	leídos con server.ParseTokensFile dan EXACTAMENTE [devToken],
//	sin error. Guarda: el archivo existe y no está vacío.
//	RED: hoy el stub escribe `dev-token dev` → el parseo es
//	["dev-token dev"] → fallo por aserción (con el parser estricto
//	GREEN, sería error de ParseTokensFile).
//
// P2 — server.StartServer con los tokens de P1 responde 200 al
//
//	`initialize` con x-vlp-token: devToken y 401 con un token ajeno
//	(PIN del 401 + guarda de no-vacuidad de tokens).
//
// P6 — prepareHarnessExtension: copia de la extensión con
//
//	inyección de background.scripts y guardas contra vacuidad
//	(cierre de set por nombre + SHA-256; snapshot de srcDir antes
//	y después). INTERFAZ DECLARADA del spec (función no existe hoy:
//	stub RED que no copia).
//
// Los tests sólo usan contratos observables (files, HTTP status) y las
// interfaces declaradas del spec. Sin estructura interna.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"vulpo/server/internal/server"
)

// token del harness según el spec/discovery de fb-024 (valor medido).
const p1DevToken = "dev-token"

// --- helpers de fixture y contratos (tests) --------------------------------

// manifestFixture: manifest MV2 de la fuente de prueba de P6.
func manifestFixture() map[string]any {
	return map[string]any{
		"name":             "ext-fixture",
		"manifest_version": float64(2),
		"version":          "1.0.0",
		"background": map[string]any{
			"scripts": []any{"a.js", "background.js"},
		},
	}
}

// writeManifest serializa y escribe manifest.json en dir.
func writeManifest(t *testing.T, dir string, m map[string]any) {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath2(dir, "manifest.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// filepath2: join corto (evita import extra de path/filepath en tests).
func filepath2(dir, name string) string {
	return dir + string(os.PathSeparator) + name
}

// makeExtFixture: crea la fuente de prueba de P6 en srcDir con
// manifest.json (background.scripts = [a.js, background.js]), archivos
// planos, DOS subdirectorios, un archivo binario (bytes no-UTF8) y
// node_modules/x (para que la guarda anti-vacuidad de (c) no sea vacua).
func makeExtFixture(t *testing.T, srcDir string) (map[string]string, map[string]any) {
	t.Helper()
	manifest := manifestFixture()
	for _, d := range []string{
		srcDir, filepath2(srcDir, "subdir1"), filepath2(srcDir, "subdir2"),
		filepath2(srcDir, "subdir2") + string(os.PathSeparator) + "sub3",
		filepath2(srcDir, "node_modules"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string][]byte{
		"a.js":                 []byte("// fixture a.js\n"),
		"background.js":        []byte("const fixture_bg = 1;\n"),
		"subdir1/mod.js":       []byte("// fixture module\n"),
		"subdir2/sub3/deep.js": []byte("// deep file\n"),
		// binario no-UTF8 (0xFF es secuencia inválida UTF-8; detecta
		// corrupción de encoding/mangle de bytes en la copia).
		"subdir1/bin.png": {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0x80, 0xC3, 0x28},
		"node_modules/x":  []byte("heavy\n"),
	}
	for name, content := range files {
		if err := os.WriteFile(filepath2(srcDir, name), content, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeManifest(t, srcDir, manifest)

	// snapshot esperado (cierre de set por nombre + SHA-256), SIN node_modules
	want := treeSHA(t, srcDir)
	for path := range want {
		if path == "node_modules/x" || strings.HasPrefix(path, "node_modules"+string(os.PathSeparator)) {
			delete(want, path)
		}
	}
	return want, manifest
}

// treeSHA: walk del árbol → map relpath→sha256hex (solo archivos).
func treeSHA(t *testing.T, root string) map[string]string {
	t.Helper()
	m := map[string]string{}
	err := filepathWalk(root, func(rel string, data []byte) {
		h := sha256.Sum256(data)
		m[rel] = fmt.Sprintf("%x", h[:])
	})
	if err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return m
}

// filepathWalk: walk recursivo simple con fs.WalkDir — visita cada archivo
// y entrega rel-path + bytes. Devuelve error si el árbol es ilegible.
// filepathWalk: walk recursivo simple con fs.WalkDir — visita cada archivo
// y entrega rel-path + bytes. Devuelve error si el árbol es ilegible.
func filepathWalk(root string, fn func(rel string, data []byte)) error {
	var walk func(dir, base string) error
	walk = func(dir, base string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			full := dir + string(os.PathSeparator) + e.Name()
			rel := e.Name()
			if base != "" {
				rel = base + string(os.PathSeparator) + e.Name()
			}
			if e.IsDir() {
				if err := walk(full, rel); err != nil {
					return err
				}
				continue
			}
			data, err := os.ReadFile(full)
			if err != nil {
				return err
			}
			fn(rel, data)
		}
		return nil
	}
	return walk(root, "")
}

// compareTree: cierre de set — ambos mapas deben tener exactamente el
// mismo conjunto de rel-paths y los mismos SHA-256 (a menos que fuera
// parte del set: harness-build.js, cuyo contenido P6 no exige).
func compareTree(t *testing.T, got, want map[string]string, ctx string) {
	t.Helper()
	for k := range got {
		if _, ok := want[k]; !ok {
			t.Fatalf("%s: archivo inesperado en la copia: %q", ctx, k)
		}
	}
	for k, v := range want {
		g, ok := got[k]
		if !ok {
			if v == "" { // marcador known-unknown (harness-build.js)
				continue
			}
			t.Fatalf("%s: falta en la copia: %q", ctx, k)
			continue
		}
		if v == "" { // unknown sha (harness-build.js) — solo presencia
			continue
		}
		if g != v {
			t.Fatalf("%s: SHA-256 distinto para %q: original %s, copia %s", ctx, k, v, g)
		}
	}
}

// snapshotBefore/After: par de snapshots para la guarda (d).
func snapshotEqual(t *testing.T, before, after map[string]string, ctx string) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatalf("%s: la cantidad de archivos de srcDir cambió: antes %d, después %d", ctx, len(before), len(after))
	}
	for k, v := range before {
		if after[k] != v {
			t.Fatalf("%s: srcDir mutó: %q cambió (%s → %s)", ctx, k, v, after[k])
		}
	}
}

// loadManifest: lee manifest.json de dir y lo parsea a map.
func loadManifest(t *testing.T, dir string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath2(dir, "manifest.json"))
	if err != nil {
		t.Fatalf("leer manifest de destino: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("manifest de destino no es JSON válido: %v", err)
	}
	return m
}

// noNodeModules: aserto negativo explícito contra la copia-sucia.
func noNodeModules(t *testing.T, got map[string]string, ctx string) {
	t.Helper()
	for k := range got {
		if strings.HasPrefix(k, "node_modules"+string(os.PathSeparator)) || k == "node_modules" {
			t.Fatalf("%s: node_modules quedó en la copia (contrato D-3: excluir): %q", ctx, k)
		}
	}
}

// =============================================================================
// P1 — writeDevTokensFile → ParseTokensFile == [devToken] exacto
// =============================================================================

func TestWriteDevTokensFile_ParsesExactDevToken(t *testing.T) {
	dir := t.TempDir()
	path := filepath2(dir, "tokens.txt")

	if err := writeDevTokensFile(path); err != nil {
		t.Fatalf("writeDevTokensFile = %v", err)
	}

	// Guarda: el archivo existe y no está vacío.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("archivo del harness no existe: %v", err)
	}
	if info.Size() == 0 {
		t.Fatal("archivo del harness vacío")
	}

	toks, err := server.ParseTokensFile(path)
	if err != nil {
		t.Fatalf("ParseTokensFile = %v (el harness debe escribir el formato canónico: un token por línea, sin espacios internos)", err)
	}
	if len(toks) != 1 || toks[0] != p1DevToken {
		t.Fatalf("ParseTokensFile = %v, want [%q] exacto", toks, p1DevToken)
	}
}

// =============================================================================
// P2 — StartServer con los tokens de P1: 200 al initialize; 401 con ajeno
// =============================================================================

func mcpInitializeStatus(t *testing.T, port int, token string) int {
	t.Helper()
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	req, err := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", port), strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-vlp-token", token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /mcp = %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// startWithHarnessTokens: escribe el archivo del harness, lo parsea con
// el server y levanta StartServer con esos tokens exactos. Devuelve la
// Server para inspección observable.
func startWithHarnessTokens(t *testing.T) *server.Server {
	t.Helper()
	dir := t.TempDir()
	path := filepath2(dir, "tokens.txt")
	if err := writeDevTokensFile(path); err != nil {
		t.Fatalf("writeDevTokensFile = %v", err)
	}
	toks, err := server.ParseTokensFile(path)
	if err != nil {
		t.Fatalf("ParseTokensFile = %v", err)
	}
	if len(toks) == 0 {
		t.Fatal("no-vacuidad: tokens parsed vacíos")
	}
	s, err := server.StartServer(server.Options{Port: 0, Tokens: toks})
	if err != nil {
		t.Fatalf("StartServer = %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

// TestServer_Initialize_HarnessToken200 — RED en el 200: hoy el archivo
// del harness parsea ["dev-token dev"] y el derecho "dev-token" no está
// autorizado (401).
func TestServer_Initialize_HarnessToken(t *testing.T) {
	s := startWithHarnessTokens(t)
	code := mcpInitializeStatus(t, s.Port, "dev-token")
	if code != 200 {
		t.Fatalf("initialize con x-vlp-token dev-token = %d, want 200 (el token del harness debe ser aceptado por el server)", code)
	}
}

// Precisión: el 401 (PIN) va en test separado para que el RED del 200 no
// tape el PIN.
func TestServer_WrongToken_Rejected401(t *testing.T) {
	s := startWithHarnessTokens(t)
	// guarda de no-vacuidad del 401
	if s.Port == 0 {
		t.Fatal("puerto efímero no asignado (no-vacuidad)")
	}
	code := mcpInitializeStatus(t, s.Port, "tok-falso-ajeno-al-harness")
	if code != 401 {
		t.Fatalf("initialize con token ajeno = %d, want 401", code)
	}
}

// =============================================================================
// P6 — prepareHarnessExtension: copia, inyección y guardas
// =============================================================================

// TestPrepareHarnessExtension_InjectBuild — (a)+(c)+(d) con injectBuild=true.
func TestPrepareHarnessExtension_InjectBuild(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()
	wantTree, manifest := makeExtFixture(t, srcDir)
	snapshotBefore := treeSHA(t, srcDir)

	if err := prepareHarnessExtension(srcDir, dstDir, true); err != nil {
		t.Fatalf("prepareHarnessExtension = %v", err)
	}

	// (a) manifest: scripts = [a.js, background.js, harness-build.js]
	//     — harness-build.js como ÚLTIMO elemento; ningún otro campo cambia.
	got := loadManifest(t, dstDir)
	expected := func() map[string]any {
		b, _ := json.Marshal(manifest)
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		bg, _ := m["background"].(map[string]any)
		scripts, _ := bg["scripts"].([]any)
		bg["scripts"] = append(scripts, "harness-build.js")
		return m
	}()
	if !reflect.DeepEqual(got, expected) {
		t.Fatalf("manifest de la copia con injectBuild difiere del esperado (que es el original + harness-build.js al final de background.scripts): got=%v", got)
	}

	// (a) harness-build.js presente
	if _, err := os.Stat(filepath2(dstDir, "harness-build.js")); err != nil {
		t.Fatalf("harness-build.js falta en la copia con injectBuild=true: %v", err)
	}

	// (c) cierre de set: exactamente los archivos del fixture (sin
	//     node_modules) + harness-build.js; byte-idénticos los demás.
	gotTree := treeSHA(t, dstDir)
	expectedTree := func() map[string]string {
		m := map[string]string{}
		for k, v := range wantTree {
			m[k] = v
		}
		m["harness-build.js"] = "" // presence-only
		return m
	}()
	noNodeModules(t, gotTree, "(c) injectBuild=true")
	compareTree(t, gotTree, expectedTree, "(c) injectBuild=true")

	// (d) srcDir byte-idéntico después de la llamada.
	snapshotAfter := treeSHA(t, srcDir)
	snapshotEqual(t, snapshotBefore, snapshotAfter, "(d) injectBuild=true")
}

// TestPrepareHarnessExtension_NoInject — (b)+(c)+(d) con injectBuild=false.
func TestPrepareHarnessExtension_NoInject(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()
	wantTree, manifest := makeExtFixture(t, srcDir)
	snapshotBefore := treeSHA(t, srcDir)

	if err := prepareHarnessExtension(srcDir, dstDir, false); err != nil {
		t.Fatalf("prepareHarnessExtension = %v", err)
	}

	// (b) manifest igual al original (semánticamente)
	got := loadManifest(t, dstDir)
	if !reflect.DeepEqual(got, manifest) {
		t.Fatalf("manifest con injectBuild=false difiere del original: got=%v want=%v", got, manifest)
	}

	// (b) harness-build.js AUSENTE
	if _, err := os.Stat(filepath2(dstDir, "harness-build.js")); err == nil {
		t.Fatal("harness-build.js existe en la copia con injectBuild=false (no debe inyectarse)")
	}

	// (c) cierre de set exacto (sin node_modules, sin harness-build.js)
	gotTree := treeSHA(t, dstDir)
	noNodeModules(t, gotTree, "(c) injectBuild=false")
	compareTree(t, gotTree, wantTree, "(c) injectBuild=false")

	// (d) srcDir byte-idéntico
	snapshotAfter := treeSHA(t, srcDir)
	snapshotEqual(t, snapshotBefore, snapshotAfter, "(d) injectBuild=false")
}
