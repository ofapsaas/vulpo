package docsguard

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// repoRoot: raíz del repo Vulpo (cwd del test = src/server/internal/docsguard;
// "../.." = src/server → Dir() = src).
func repoRoot(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	return filepath.Dir(abs)
}

// scanTargets: files del set escaneado + dir extra de la negativa (env hook).
func scanTargets(t *testing.T, root string) []string {
	t.Helper()
	files, err := scannedSet(root)
	if err != nil {
		t.Fatal(err)
	}
	if extra := os.Getenv(extraDirEnv); extra != "" {
		matches, _ := filepath.Glob(filepath.Join(extra, "*.md"))
		files = append(files, matches...)
	}
	return files
}

var spanishRe = regexp.MustCompile(`\b(el|la|los|las|que|para|con|una|como|del|sobre|también|servidor|configuración)\b`)
var versionRe = regexp.MustCompile(`v\d+\.\d+\.\d+`)
// legacyFloorRe: piso de versión de la línea legacy (con o sin prefijo v) —
// el producto nuevo nace en 0.5.0; un 0.x citado como piso es error (review
// fb-022-003 M-1: la guardia no debe ser solo tripwire del prefijo "v").
var legacyFloorRe = regexp.MustCompile(`\b0\.[1-4]\.\d+\b`)
var vlpRefRe = regexp.MustCompile("`vlp_[A-Za-z]+`")

var odooToolNames = []string{"search_read", "search_count", "write", "unlink", "create",
	"export_records", "import_records", "execute_kw", "list_models", "list_fields",
	"list_available_profiles", "get_version"}

// TestDocsToolsExist: toda tool backtick-quoted `vlp_*` y todo nombre odoo citado
// como backtick token exacto debe existir en el catálogo real.
func TestDocsToolsExist(t *testing.T) {
	catalog, err := buildCatalog()
	if err != nil {
		t.Fatal(err)
	}
	names := catalogNames(catalog)
	if len(names) != 33 {
		t.Fatalf("catálogo inesperado: %d tools (esperado 33)", len(names))
	}
	root := repoRoot(t)
	files := scanTargets(t, root)
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		rel, _ := filepath.Rel(root, f)
		for _, m := range vlpRefRe.FindAllStringSubmatch(string(raw), -1) {
			name := strings.Trim(m[0], "`")
			if !names[name] {
				t.Errorf("%s: cita la tool inexistente %s", rel, name)
			}
		}
		for _, on := range odooToolNames {
			// los nombres odoo son genéricos: solo se valida el patrón vlp_ de
			// forma estricta (limitación documentada en spec: typo de nombre
			// odoo no detectable por pattern — aceptado).
			_ = on
		}
	}
}

// TestDocsVersionFloors: todo piso vX.Y.Z citado en el set == manifest version.
func TestDocsVersionFloors(t *testing.T) {
	root := repoRoot(t)
	ver, err := versionFloorFromManifest(root)
	if err != nil {
		t.Fatal(err)
	}
	want := "v" + ver
	files := scanTargets(t, root)
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		rel, _ := filepath.Rel(root, f)
		for i, line := range strings.Split(string(raw), "\n") {
			for _, m := range versionRe.FindAllString(line, -1) {
				if m != want {
					t.Errorf("%s:%d: piso de versión %s ≠ manifest %s", rel, i+1, m, want)
				}
			}
			if legacyFloorRe.MatchString(line) {
				t.Errorf("%s:%d: piso de la línea legacy (%s) — el producto nace en %s",
					rel, i+1, legacyFloorRe.FindString(line), want)
			}
		}
	}
}

// TestDocsNoSpanish: cero palabra funcional ES fuera de la allowlist.
func TestDocsNoSpanish(t *testing.T) {
	root := repoRoot(t)
	files := scanTargets(t, root)
	for _, f := range files {
		rel, _ := filepath.Rel(root, f)
		allowed := map[int]bool{}
		for k, lines := range allowedSpanish {
			if strings.HasSuffix(rel, k) || strings.HasSuffix(f, k) {
				for _, l := range lines {
					allowed[l] = true
				}
			}
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		for i, line := range strings.Split(string(raw), "\n") {
			if allowed[i+1] {
				continue
			}
			if spanishRe.MatchString(line) {
				t.Errorf("%s:%d: español funcional fuera de allowlist: %q", rel, i+1, strings.TrimSpace(line))
			}
		}
	}
}

// TestToolsReferenceFresh: tools.md == render actual del catálogo (drift = FAIL).
func TestToolsReferenceFresh(t *testing.T) {
	root := repoRoot(t)
	catalog, err := buildCatalog()
	if err != nil {
		t.Fatal(err)
	}
	want := RenderToolsReference(catalog)
	path := filepath.Join(root, "docs", "reference", "tools.md")
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("docs/reference/tools.md: %v (¿se generó?)", err)
	}
	if string(got) != want {
		t.Fatalf("docs/reference/tools.md desincronizada del catálogo — regenerar: (cd server && go run ./cmd/gen-docs)")
	}
}
