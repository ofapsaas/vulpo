// version_pin_test.go — pin de la versión de producto/protocolo compartida
// (fb-022 versión-negotiation). ProductVersion (server) DEBE ser la misma
// "version" de extension/manifest.json: el manifest es la fuente única de la
// versión de producto — el kit la toma de acá por default (build-agent-kit.sh)
// y la extensión la reporta desde runtime.getManifest(). La negociación en
// runtime es: extension↔server por welcome.serverVersion (register lleva
// EXT_VERSION), kit↔server por serverInfo.version vs clientInfo.version
// (vlpmcp doctor la compara y avisa). Este pin evita el drift silencioso
// entre las tres partes al subir de versión.
package mcp

import (
	"encoding/json"
	"os"
	"testing"
)

func TestVersionPin_ProductVersionMatchesExtensionManifest(t *testing.T) {
	manifest := "../../../extension/manifest.json"
	data, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatalf("no se pudo leer %s: %v", manifest, err)
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("manifest.json no es JSON válido: %v", err)
	}
	if m.Version == "" {
		t.Fatalf("extension/manifest.json no declara version")
	}
	if ProductVersion != m.Version {
		t.Fatalf("drift de versión de producto/protocolo: server ProductVersion = %q, extension/manifest.json = %q\n"+
			"alinear: bumpear ProductVersion (mcp.go), manifest.json y CHANGELOG juntos", ProductVersion, m.Version)
	}
}
