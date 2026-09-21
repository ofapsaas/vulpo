// Package mcp tests — fb-020-005-odoo-form-validity (sub-fase RED). P17.
//
// Deriva de §5 P17 y de las secciones que nombra (§3.3 `invalidElements`,
// §3.5 `invalidProfile`, §3.2 `notInMap`) del spec
// docs/specs/fb-020-005-odoo-form-validity/spec.md: las descripciones de
// `vlp_getFrame` y `vlp_act` documentan `invalidElements`
// (incluida su cota de 20 y su inmunidad a filtros/paginación/caps de
// promoción), `invalidCount` (sin cota), `notInMap` e `invalidProfile`, y
// declaran que existen convenciones de sitio detectadas por DOM.
//
// Archivo NUEVO a propósito: ningún test existente se modifica. Se REUSAN
// del package los helpers de tests vigentes: newTools/getFrameTool/actTool
// (mcp_frame_payload_test.go, mcp_dialogo_inerte_test.go) y hasConcept
// (mcp_native_dialog_test.go).
//
// Anclas: literales de wire (`invalidElements`, `invalidCount`, `notInMap`,
// `invalidProfile`, `20`) donde el contrato fija esas cadenas exactas;
// grupos de sinónimos ES/EN vía hasConcept para la prosa que explica
// inmunidad y mecanismo de convención de sitio — el nombre de la clave no
// cambia con una reescritura de estilo, la frase que la explica sí.
package mcp

import (
	"strings"
	"testing"
)

// P17 (§5, §3.3, §3.5, §3.2): vlp_getFrame documenta las cuatro claves
// nuevas de nivel superior por su nombre literal.
func TestPostcondition17_GetFrameDescription_NamesValidityKeys(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := getFrameTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_getFrame debe tener Description")
	}

	for _, key := range []string{"invalidElements", "invalidCount", "notInMap", "invalidProfile"} {
		if !strings.Contains(desc, key) {
			t.Errorf("P17: la Description de vlp_getFrame no documenta la clave `%s`: %q", key, desc)
		}
	}
}

// P17 (§3.3, I-5): la Description declara que `invalidElements`/`invalidCount`
// se computan ANTES de filtrar (roles/namedOnly), paginar y acotar por los
// caps de promoción — es la propiedad de "inmunidad" que hace útil recortar
// el mapa sin perder los inválidos.
func TestPostcondition17_GetFrameDescription_InvalidSummaryImmuneToTrimming(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := getFrameTool(t, s)

	if !hasConcept(desc,
		[]string{"invalidElements", "invalidCount"},
		[]string{"before", "antes"},
		[]string{
			"filter", "filtering", "filtrar", "filtrado",
			"paginat", "pagination", "pagina",
			"cap", "cropped", "crop", "trim", "recort", "acot",
		},
	) {
		t.Errorf("P17: la Description de vlp_getFrame no dice que invalidElements/invalidCount se computan antes de filtrar/paginar/acotar (§3.3, I-5): %q", desc)
	}
}

// P17 (§3.3): `invalidElements` está acotado a 20 entradas de payload, pero
// `invalidCount` NO se acota — el agente sabe por el número si hay más.
func TestPostcondition17_GetFrameDescription_CapTwentyInvalidCountUncapped(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := getFrameTool(t, s)

	if !hasConcept(desc, []string{"invalidElements"}, []string{"20"}) {
		t.Errorf("P17: la Description de vlp_getFrame no documenta la cota de 20 entradas de invalidElements (§3.3): %q", desc)
	}

	if !hasConcept(desc,
		[]string{"invalidCount"},
		[]string{
			"not capped", "not limited", "not truncated", "uncapped", "no limit", "no cap",
			"total", "no se acota", "no acotad", "sin acotar", "sin cota", "sin limite", "sin límite",
		},
	) {
		t.Errorf("P17: la Description de vlp_getFrame no dice que invalidCount NO se acota (§3.3): %q", desc)
	}
}

// P17 (§3.1, §3.5, §2 Opción C): la Description declara que existen
// convenciones de sitio, que se detectan por DOM, y que invalidProfile las
// nombra — es como se cumple la regla 3 del contrato de generalidad (la
// especialización no se esconde, se declara).
func TestPostcondition17_GetFrameDescription_DeclaresSiteConventionMechanism(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := getFrameTool(t, s)

	if !hasConcept(desc,
		[]string{"convention", "convención", "convencion", "profile", "perfil"},
		[]string{"site", "sitio"},
		[]string{"dom"},
	) {
		t.Errorf("P17: la Description de vlp_getFrame no declara el mecanismo de convenciones de sitio detectadas por DOM (§3.1, §3.5): %q", desc)
	}

	if !strings.Contains(desc, "invalidProfile") {
		t.Errorf("P17: la Description de vlp_getFrame no nombra invalidProfile junto al mecanismo de convención de sitio (§3.5): %q", desc)
	}
}

// P17 (§3.6, §3.7): el pliegue de vlp_act trae el frame con las mismas
// claves de validez que un vlp_getFrame — la Description de act lo
// dice, no lo da por sentado.
func TestPostcondition17_ActDescription_FoldCarriesSameValidityKeysAsGetFrame(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := actTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_act debe tener Description")
	}

	for _, key := range []string{"invalidElements", "invalidCount"} {
		if !strings.Contains(desc, key) {
			t.Errorf("P17: la Description de vlp_act no documenta la clave `%s` en el frame plegado: %q", key, desc)
		}
	}

	if !hasConcept(desc,
		[]string{"invalidElements", "invalidCount"},
		[]string{"getframe", "getFrame"},
	) {
		t.Errorf("P17: la Description de vlp_act no liga las claves de validez del frame plegado a vlp_getFrame (§3.6): %q", desc)
	}
}
