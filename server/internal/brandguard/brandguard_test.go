// Package brandguard — guardián de marca permanente (fb-022-002, P9).
// Recorre el repo completo (desde la raíz del outer repo de Vulpo) y FALLA si
// la marca del legado aparece en cualquier lugar: en el CONTENIDO de cualquier
// archivo (case-insensitive) o en el NOMBRE (basename) de cualquier archivo o
// directorio — así la clase de hueco "marca en el path" queda cerrada.
// Excluye: .git, server/bin y agent-kit/cli/cli (binarios compilados,
// artefactos de build, no fuente) y node_modules (deps de tests).
package brandguard

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// brandNeedles: marcas vigiladas de la línea legacy, construidas por partes
// para que este archivo no las contenga literal y no se auto-matchee:
// "foxbridge" (producto origin) y "fbmcp" (nombre original del CLI —
// review fb-022-004: el identificador camelCase runFbmcp escapó al sed de
// 002; se vigilan ambos).
var brandNeedles = []string{"fox" + "bridge", "fb" + "mcp"}

// matchesBrand: alguna de las marcas vigiladas (case-insensitive).
func matchesBrand(s string) bool {
	for _, n := range brandNeedles {
		if strings.Contains(s, n) {
			return true
		}
	}
	return false
}

func TestNoLegacyBrand(t *testing.T) {
	// Raíz del repo: src/server/internal/brandguard → ../../.. = src/
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("resolver raíz del repo: %v", err)
	}
	// El propio archivo del guardián contiene la marca en su nombre de test
	// (TestNoLegacyBrand, requerido por el gate) — se auto-excluye del scan.
	selfFile := filepath.Join(root, "server", "internal", "brandguard", "brandguard_test.go")

	// Binarios compilados excluidos por path exacto (artefactos de build).
	binaryPaths := map[string]bool{
		filepath.Join(root, "server", "bin"):           true,
		filepath.Join(root, "agent-kit", "cli", "cli"): true,
	}

	var violations []string
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if binaryPaths[path] {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			switch name {
			case ".git", "node_modules":
				if path == filepath.Join(root, name) {
					return filepath.SkipDir
				}
			}
			// Guardián de basename: el nombre de CUALQUIER directorio no
			// puede contener la marca (el selfFile se maneja más abajo).
			if path != selfFile && matchesBrand(strings.ToLower(name)) {
				rel, _ := filepath.Rel(root, path)
				violations = append(violations, rel+"/ (nombre de directorio)")
			}
			return nil
		}
		if path == selfFile {
			return nil
		}
		// Guardián de basename: el nombre de CUALQUIER archivo no puede
		// contener la marca (case-insensitive).
		if matchesBrand(strings.ToLower(name)) {
			rel, _ := filepath.Rel(root, path)
			violations = append(violations, rel+" (nombre de archivo)")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(data), "\n") {
			if matchesBrand(strings.ToLower(line)) {
				rel, _ := filepath.Rel(root, path)
				violations = append(violations, rel+":"+fmtInt(i+1))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk del repo: %v", err)
	}
	if len(violations) > 0 {
		t.Errorf("marca del legado encontrada en %d sitio(s); renombrar antes de commitear:\n%s",
			len(violations), strings.Join(violations, "\n"))
	}
}

func fmtInt(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
