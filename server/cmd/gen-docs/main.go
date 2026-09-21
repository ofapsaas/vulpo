// cmd/gen-docs: regenera docs/reference/tools.md desde el catálogo real de tools.
// Solo para humanos/mantenedores — la vigilancia de drift vive en internal/docsguard.
package main

import (
	"fmt"
	"os"

	"vulpo/server/internal/docsguard"
	"vulpo/server/internal/mcp"
	"vulpo/server/internal/odooregistry"
)

func main() {
	ms := mcp.New(nil)
	mcp.RegisterAllTools(ms, nil, "", odooregistry.New())
	out := docsguard.RenderToolsReference(ms.ListTools())
	// Fail-fast de cwd: la ruta documentada es (cd server && go run ./cmd/gen-docs).
	// Desde otro cwd el write caería en un path equivocado — mejor fallar acá.
	if _, err := os.Stat("../docs"); err != nil {
		fmt.Fprintln(os.Stderr, "gen-docs: run from src/server (target ../docs/reference/tools.md not found)")
		os.Exit(1)
	}
	if err := osWrite("../docs/reference/tools.md", out); err != nil {
		fmt.Fprintln(os.Stderr, "gen-docs:", err)
		os.Exit(1)
	}
	fmt.Println("docs/reference/tools.md regenerated")
}

func osWrite(relPath, content string) error {
	return os.WriteFile(relPath, []byte(content), 0o644)
}
