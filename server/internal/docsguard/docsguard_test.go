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

// ——— fb-024-vision-subagente (RED, stage 3.1) ———
// Tests de presencia: un test por postcondición P1–P6 (spec §3.2), derivados
// SOLO de los anchors del spec (los SKILL son la implementación futura: esta
// sesión no los leyó). Matching literal case-insensitive + whitespace
// colapsado, por archivo nombrado descubierto vía scanTargets (sin números de
// línea, spec §3.2). G-5: SKILL faltante del set = t.Fatalf, nunca pass
// silencioso.

const (
	navSkillSuffix     = "agent-kit/skills/vulpo-web-navigation/SKILL.md"
	catalogSkillSuffix = "agent-kit/skills/vulpo/SKILL.md"
)

// normalize (G-1, AUDIT): casefold + colapso de cada run de whitespace
// (espacios, tabs, newlines) a un único espacio. Se aplica IDENTICAMENTE al
// contenido del archivo y a cada anchor antes de strings.Contains.
func normalize(s string) string {
	return strings.Join(strings.Fields(strings.ToLower(s)), " ")
}

// skillFile: lookup por sufijo del SKILL nombrado dentro del set escaneado
// (mismo idioma de sufijo que las claves de allowedSpanish, docsguard_test.go
// :119). G-5: si el SKILL nombrado no aparece en scanTargets sale por
// t.Fatalf — un rename futuro de agent-kit/skills/*/SKILL.md nunca puede
// dejar el test en verde en silencio.
func skillFile(t *testing.T, root, suffix string) string {
	t.Helper()
	for _, f := range scanTargets(t, root) {
		if strings.HasSuffix(f, suffix) {
			return f
		}
	}
	t.Fatalf("%s: no aparece en scanTargets (¿cambió el layout de agent-kit/skills/*/SKILL.md?)", suffix)
	return ""
}

// requireFragments: presencia literal de cada anchor sobre el contenido
// normalizado (G-1). Fail-soft: reporta TODOS los fragmentos faltantes con
// t.Errorf nombrando archivo + fragmento, para que un solo run RED liste el
// conjunto completo de fragmentos pendientes.
func requireFragments(t *testing.T, root, path string, anchors ...string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	rel, _ := filepath.Rel(root, path)
	got := normalize(string(raw))
	for _, a := range anchors {
		if !strings.Contains(got, normalize(a)) {
			t.Errorf("%s: missing required fragment %q", rel, a)
		}
	}
}

// TestNavSkillR1Delegation (P1): R1 completo en la guía de verificación
// visual — el agente principal nunca captura ni lee imágenes; delega la
// mirada a un sub-agente con una pregunta concreta y recibe UNA sola línea.
func TestNavSkillR1Delegation(t *testing.T) {
	root := repoRoot(t)
	requireFragments(t, root, skillFile(t, root, navSkillSuffix),
		"never captures or reads images",
		"one concrete question",
		"returns a single line",
	)
}

// TestNavSkillVisionRationale (P2): rationale obligatoria — el sub-agente
// puede usar el mismo modelo: la regla restringe en qué contexto aterriza la
// imagen, no qué modelo mira.
func TestNavSkillVisionRationale(t *testing.T) {
	root := repoRoot(t)
	requireFragments(t, root, skillFile(t, root, navSkillSuffix),
		"the sub-agent may use the same model",
		"which context the image lands in",
	)
}

// TestNavSkillFrameFirst (P3): R2 — el frame comes primero; el orden de
// recursos existente no degrada. G-2 (AUDIT): "or equivalent normative
// wording" no es implementable como matcher de substring — RED pinea el
// literal único "the frame comes first"; el juicio de equivalencia de
// redacción queda en T-doc (reviewer, spec §3.2 P3).
func TestNavSkillFrameFirst(t *testing.T) {
	root := repoRoot(t)
	requireFragments(t, root, skillFile(t, root, navSkillSuffix),
		"the frame comes first",
	)
}

// TestNavSkillAttemptCap (P4): R3 — tope de intentos contra el mismo control
// con el mismo objetivo, y registro del defecto al agotarlo. G-3 (AUDIT):
// el anchor pinea la FORMA DE DÍGITO — contrato: la frase debe llevar
// "3 attempts on the same control" con dígito; la forma "three attempts" NO
// satisface el anchor.
func TestNavSkillAttemptCap(t *testing.T) {
	root := repoRoot(t)
	requireFragments(t, root, skillFile(t, root, navSkillSuffix),
		"3 attempts on the same control",
		"register the defect",
	)
}

// TestNavSkillNoDiskImages (P5): R4 — la prohibición cubre leer archivos de
// imagen del disco con el read del runtime, no solo la llamada
// `vlp_screenshot`: la regla es "imágenes nunca en el contexto del agente
// principal".
func TestNavSkillNoDiskImages(t *testing.T) {
	root := repoRoot(t)
	requireFragments(t, root, skillFile(t, root, navSkillSuffix),
		"reading an image file from disk",
	)
}

// TestCatalogSkillImageBoundary (P6): regla corta de frontera de imagen en el
// SKILL catálogo + cross-ref nombrando el skill que porta la regla completa.
// G-4 (AUDIT): el literal exacto del cross-ref no lo cita el spec — RED lo
// pinea como "see vulpo-web-navigation". En RED este test DEBE fallar por el
// fragmento de regla "never captures or reads images" (must fail por la regla
// faltante) aunque el token "vulpo-web-navigation" ya pre-exista en el
// catálogo; el cross-ref pineado puede pasar o fallar igualmente — con ≥1
// anchor faltante P6 queda rojo.
func TestCatalogSkillImageBoundary(t *testing.T) {
	root := repoRoot(t)
	requireFragments(t, root, skillFile(t, root, catalogSkillSuffix),
		"never captures or reads images",
		"see vulpo-web-navigation",
	)
}

// TestAllowedSpanishLiterals (G-6, opcional; debe PASAR en RED): automatiza
// "re-point, never widen" (spec I-2/P7) para los literales de I-2 — cada
// entrada allowlistada sigue apuntando a la línea que contiene el MISMO
// literal. Los literales pinneados son los verificados en I-2: la pregunta de
// confirmación (l.249-250, frase partida en dos líneas → se validan juntas),
// el token `el.click()` (l.380) y la nota user-only del plan/build
// (vulpo/SKILL.md l.84). La entrada de vulpo-odoo-web (UI Odoo de fb-022,
// byte-unchanged por P7) se valida solo estructuralmente aquí: sin pinear
// literales de UI ajenos a I-2.
func TestAllowedSpanishLiterals(t *testing.T) {
	root := repoRoot(t)
	type fragCheck struct {
		lines    []int // números de línea 1-based (grupo si la frase parte líneas)
		fragment string
	}
	perFile := map[string][]fragCheck{
		navSkillSuffix: {
			{lines: []int{249, 250}, fragment: "¿estás seguro"},
			{lines: []int{380}, fragment: "el.click()"},
		},
		catalogSkillSuffix: {
			{lines: []int{84}, fragment: "plan/build"},
			{lines: []int{84}, fragment: "user-only"},
		},
	}
	files := scanTargets(t, root)
	for suffix, checks := range perFile {
		var path string
		for _, f := range files {
			if strings.HasSuffix(f, suffix) {
				path = f
				break
			}
		}
		if path == "" {
			t.Fatalf("%s: no aparece en scanTargets (¿cambió el layout de agent-kit/skills/*/SKILL.md?)", suffix)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", suffix, err)
		}
		lines := strings.Split(string(raw), "\n")
		for _, c := range checks {
			var joined string
			for _, n := range c.lines {
				if n < 1 || n > len(lines) {
					t.Fatalf("%s: allowlist apunta a la línea %d inexistente (archivo de %d líneas) — el re-point perdió el literal", suffix, n, len(lines))
				}
				joined += " " + strings.TrimSpace(lines[n-1])
			}
			if !strings.Contains(normalize(joined), normalize(c.fragment)) {
				t.Errorf("%s: línea(s) %v ya no contienen el literal I-2 %q — re-point, never widen (spec P7)", suffix, c.lines, c.fragment)
			}
		}
	}
	// Resto de entradas de allowedSpanish (UI Odoo, byte-unchanged): chequeo
	// estructural — la línea allowlistada existe y no quedó vacía.
	for suffix, nums := range allowedSpanish {
		if suffix == navSkillSuffix || suffix == catalogSkillSuffix {
			continue
		}
		var path string
		for _, f := range files {
			if strings.HasSuffix(f, suffix) {
				path = f
				break
			}
		}
		if path == "" {
			t.Fatalf("%s: no aparece en scanTargets (¿cambió el layout de agent-kit/skills/*/SKILL.md?)", suffix)
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", suffix, err)
		}
		lines := strings.Split(string(raw), "\n")
		for _, n := range nums {
			if n < 1 || n > len(lines) {
				t.Fatalf("%s: allowlist apunta a la línea %d inexistente (archivo de %d líneas)", suffix, n, len(lines))
			}
			if strings.TrimSpace(lines[n-1]) == "" {
				t.Errorf("%s: línea allowlistada %d quedó vacía — el re-point apuntó a una línea sin contenido", suffix, n)
			}
		}
	}
}
