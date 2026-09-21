// Package mcp tests — fb-020-003-native-dialog-policy (sub-fase RED, T1-Go).
//
// Deriva de §3.6 P21 del spec: las descripciones de `tools/list` de
// `vlp_act`, `vlp_fill` y `vlp_getFrame` tienen que
// comunicar el contrato de `nativeDialog` (§2.3, §2.4). El conteo de tools
// (34) ya lo guarda mcp_tools_test.go:145 (`want 34`, TestAllTools_Registered)
// y mcp_dialogo_inerte_test.go:43-45 lo re-afirma como precondición local: NO
// se duplica acá (AC-2 sólo exige que ese guardián siga verde).
//
// Archivo NUEVO a propósito (AC-4): ningún test existente se modifica.
//
// Anclas: la redacción de las descripciones la decide el implementer. Estos
// tests afirman CONCEPTOS con anclas léxicas mínimas — literales de wire
// (`nativeDialog`, `ok:true`, `ok:false`, `success:false`, `getFrame`,
// `settled:false`) donde el contrato ya fija esas cadenas, y grupos de
// sinónimos (ES/EN) para el resto de la prosa. Cada concepto documenta, en su
// comentario, qué exige el spec y qué tan firme es el ancla. Ver la sección
// de ambigüedades en el output de la sesión para los conceptos con ancla
// débil (fragilidad reconocida, no inventada).
package mcp

import (
	"strings"
	"testing"
)

// fillTool devuelve la Description y el InputSchema de vlp_fill.
// (getFrameTool y actTool ya existen en el paquete: mcp_frame_payload_test.go
// y mcp_dialogo_inerte_test.go respectivamente — se reusan tal cual, sin
// duplicar.)
func fillTool(t *testing.T, s *Server) (string, map[string]any) {
	t.Helper()
	for _, tl := range s.ListTools() {
		if tl.Name == "vlp_fill" {
			return tl.Description, tl.InputSchema
		}
	}
	t.Fatal("falta la tool vlp_fill")
	return "", nil
}

// normalizeColon saca los espacios alrededor de ":" para que "ok:true",
// "ok: true" y "ok : true" aserten igual — el implementer elige el espaciado,
// el test no.
func normalizeColon(s string) string {
	s = strings.ReplaceAll(s, " :", ":")
	s = strings.ReplaceAll(s, ": ", ":")
	return s
}

// hasConcept: cada grupo es un OR de sinónimos (case-insensitive); el
// concepto se cumple sólo si TODOS los grupos matchean (AND entre grupos).
// Diseño deliberadamente generoso en sinónimos para no sobre-especificar la
// redacción — el objetivo es fallar hoy (nada de esto existe) y no bloquear
// un GREEN razonable mañana.
func hasConcept(desc string, groups ...[]string) bool {
	low := strings.ToLower(normalizeColon(desc))
	for _, g := range groups {
		found := false
		for _, kw := range g {
			if strings.Contains(low, strings.ToLower(kw)) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// TestActDescription_NativeDialogConcepts — P21, vlp_act. Cada subtest
// verifica un concepto de §3.6 P21 (lista de 7 bullets bajo "vlp_act").
// Hoy la Description no menciona nada de esto: las siete fallan por
// t.Errorf (AssertionError-equivalente en Go), no por compilación.
func TestActDescription_NativeDialogConcepts(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := actTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_act debe tener Description")
	}

	// Concepto 1 (bullet 1): existe el nombre de campo `nativeDialog`.
	// Ancla firme: literal de wire, case-sensitive.
	t.Run("nombre_de_campo_nativeDialog", func(t *testing.T) {
		if !strings.Contains(desc, "nativeDialog") {
			t.Errorf("la Description de vlp_act no menciona el campo `nativeDialog` (§3.6 P21 bullet 1): %q", desc)
		}
	})

	// Concepto 2 (bullet 2): con `ok:true` trae la pregunta abierta por un
	// `click`. Ancla firme en el literal `ok:true` (normalizado); ancla débil
	// en "click" porque la palabra ya aparece en la Description actual como
	// nombre de acción — no discrimina por sí sola. Se combina con `nativeDialog`
	// para acotar el sentido: la Description tiene que asociar ok:true con
	// nativeDialog Y mencionar click en algún punto.
	t.Run("ok_true_trae_pregunta_abierta_por_click", func(t *testing.T) {
		if !hasConcept(desc, []string{"ok:true"}, []string{"nativedialog"}, []string{"click"}) {
			t.Errorf("la Description de vlp_act no asocia `ok:true` con `nativeDialog` y `click` (§3.6 P21 bullet 2): %q", desc)
		}
	})

	// Concepto 3 (bullet 3): si ya había una pregunta pendiente, cualquier
	// acción devuelve `ok:false` sin despacho. Ancla firme en `ok:false`;
	// ancla débil (sinónimos ES/EN) en "pendiente" y en "sin despacho".
	t.Run("pregunta_pendiente_ok_false_sin_despacho", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"ok:false"},
			[]string{"pending", "pendiente", "already", "ya hab"},
			[]string{"without dispatch", "not dispatch", "doesn't dispatch", "does not dispatch", "sin despachar", "no despacha"},
		) {
			t.Errorf("la Description de vlp_act no dice que una pregunta pendiente devuelve `ok:false` sin despachar (§3.6 P21 bullet 3): %q", desc)
		}
	})

	// Concepto 4 (bullet 4): `force` no lo saltea. Ancla débil: prosa nueva sin
	// literal de wire que la fije.
	t.Run("force_no_lo_saltea", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"force"},
			[]string{"not skip", "doesn't skip", "does not skip", "no skip", "not bypass", "doesn't bypass", "does not bypass", "no bypass", "no salte", "no evita", "sigue aplic", "still applies", "still rejects"},
		) {
			t.Errorf("la Description de vlp_act no dice que `force` no saltea el guard de pregunta pendiente (§3.6 P21 bullet 4): %q", desc)
		}
	})

	// Concepto 5 (bullet 5): Vulpo no responde el diálogo; hay que
	// avisarle al humano y releer con `getFrame`. Ancla firme en `getFrame`
	// (literal); ancla débil en "no responde" y en "avisar al humano".
	t.Run("no_responde_avisar_humano_releer_getFrame", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"does not answer", "doesn't answer", "won't answer", "will not answer", "no responde", "not answer the dialog", "does not respond"},
			[]string{"human", "humano"},
			[]string{"getframe"},
		) {
			t.Errorf("la Description de vlp_act no dice que Vulpo no responde el diálogo, que hay que avisar al humano y releer con getFrame (§3.6 P21 bullet 5): %q", desc)
		}
	})

	// Concepto 6 (bullet 6): sólo `click` detecta diálogos; `type`, `focus` y
	// `select` que abran uno pueden bloquear la llamada. Ancla débil: "sólo
	// click" es prosa nueva, y "bloquear" compite con el vocabulario general
	// de la tool.
	t.Run("solo_click_detecta_otras_pueden_bloquear", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"only click", "only \"click\"", "solo click", "solo \"click\"", "sólo click", "only the click action"},
			[]string{"type"},
			[]string{"focus"},
			[]string{"select"},
			[]string{"block", "hang", "may not return", "bloquea", "cuelga", "puede colgar"},
		) {
			t.Errorf("la Description de vlp_act no dice que sólo `click` detecta diálogos y que `type`/`focus`/`select` pueden bloquear la llamada (§3.6 P21 bullet 6): %q", desc)
		}
	})

	// Concepto 7 (bullet 7): un diálogo que se abre después de que la llamada
	// volvió no se detecta. Ancla débil: prosa nueva sobre una limitación
	// temporal (D-2).
	t.Run("dialogo_tardio_no_se_detecta", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"after", "once it returns", "después de que", "después de la llamada", "returned", "already returned"},
			[]string{"not detect", "won't detect", "isn't detected", "is not detected", "no se detecta", "no detecta"},
		) {
			t.Errorf("la Description de vlp_act no dice que un diálogo abierto después de que la llamada volvió no se detecta (§3.6 P21 bullet 7): %q", desc)
		}
	})
}

// TestFillDescription_NativeDialogConcepts — P21, vlp_fill.
func TestFillDescription_NativeDialogConcepts(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := fillTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_fill debe tener Description")
	}

	// Concepto 1: con una pregunta pendiente, `fill` devuelve `success:false`
	// con `nativeDialog`, sin escribir. Ancla firme en `success:false` y
	// `nativeDialog`; ancla débil en "sin escribir".
	t.Run("pregunta_pendiente_success_false_sin_escribir", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"success:false"},
			[]string{"nativedialog"},
			[]string{"without writing", "doesn't write", "does not write", "no writes", "sin escribir", "no escribe"},
		) {
			t.Errorf("la Description de vlp_fill no dice que con pregunta pendiente devuelve `success:false`+`nativeDialog` sin escribir (§3.6 P21, bullet fill): %q", desc)
		}
	})

	// Concepto 2: un diálogo abierto por el propio `fill` no se detecta y
	// puede bloquear la llamada. Ancla débil, misma familia que act bullet 7.
	t.Run("dialogo_propio_no_detectado_puede_bloquear", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"not detect", "won't detect", "isn't detected", "is not detected", "no se detecta", "no detecta"},
			[]string{"block", "hang", "may not return", "bloquea", "cuelga", "puede colgar"},
		) {
			t.Errorf("la Description de vlp_fill no dice que un diálogo abierto por el propio fill no se detecta y puede bloquear la llamada (§3.6 P21, bullet fill): %q", desc)
		}
	})
}

// TestGetFrameDescription_NativeDialogConcepts — P21, vlp_getFrame.
func TestGetFrameDescription_NativeDialogConcepts(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := getFrameTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_getFrame debe tener Description")
	}

	// Concepto 1: existe el campo `nativeDialog` de primer nivel. Ancla firme
	// en el literal; ancla débil en "primer nivel"/"top-level".
	t.Run("campo_nativeDialog_de_primer_nivel", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"nativedialog"},
			[]string{"top-level", "top level", "first level", "primer nivel", "nivel superior"},
		) {
			t.Errorf("la Description de vlp_getFrame no dice que existe el campo `nativeDialog` de primer nivel (§3.6 P21, bullet getFrame): %q", desc)
		}
	})

	// Concepto 2: con `settle:true` y una pregunta pendiente, el veredicto es
	// `settled:false`. Ancla firme en `settle` y `settled:false`; ancla débil
	// en "pendiente".
	t.Run("settle_true_con_pendiente_settled_false", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"settle"},
			[]string{"settled:false"},
			[]string{"pending", "pendiente"},
		) {
			t.Errorf("la Description de vlp_getFrame no dice que con settle:true y pregunta pendiente el veredicto es settled:false (§3.6 P21, bullet getFrame): %q", desc)
		}
	})
}

// TestNativeDialogDescriptions_Generality — I-5 / §3.6 P21 ("Ningún texto
// nombra sistemas concretos"). Ancla firme: los tres literales prohibidos,
// case-insensitive, sobre las tres descripciones tocadas por P21. Hoy pasa de
// forma vacua (nada menciona nativeDialog todavía), así que este test no
// aporta al RED por sí solo — queda como guardián de regresión para cuando
// el implementer escriba las descripciones nuevas en GREEN.
func TestNativeDialogDescriptions_Generality(t *testing.T) {
	s, _ := newTools(t)
	actDesc, _ := actTool(t, s)
	fillDesc, _ := fillTool(t, s)
	getFrameDesc, _ := getFrameTool(t, s)

	forbidden := []string{"odoo", "owl", "o_form"}
	for name, desc := range map[string]string{
		"vlp_act":      actDesc,
		"vlp_fill":     fillDesc,
		"vlp_getFrame": getFrameDesc,
	} {
		low := strings.ToLower(desc)
		for _, bad := range forbidden {
			if strings.Contains(low, bad) {
				t.Errorf("la Description de %s nombra un sistema concreto (%q) — I-5/§3.6 P21 exige generalidad: %q", name, bad, desc)
			}
		}
	}
}

// ── fb-020-003 v3.3, P27 (lote de fixes del review) ──────────────────────────
//
// P27 (b) (H-12) y (c) (R-17). Mismo estilo que arriba: CONCEPTOS con grupos
// de sinónimos ES/EN vía hasConcept, no frases literales. P27 (a) y (d) los
// verifica el orquestador leyendo: no llevan test. El conteo de tools (34) lo
// sigue guardando mcp_tools_test.go.

// p27ToolDescription devuelve la Description de la tool `name`.
func p27ToolDescription(t *testing.T, s *Server, name string) string {
	t.Helper()
	for _, tl := range s.ListTools() {
		if tl.Name == name {
			return tl.Description
		}
	}
	t.Fatalf("falta la tool %s", name)
	return ""
}

// TestActDescription_NavigateCloseTabSinRespuestaHumana — P27 (b), H-12:
// `vlp_act` dice que `navigate` y `closeTab` sobre el tab cierran la
// pregunta pendiente sin respuesta humana, y que no se usan para salir de ella
// sin acuerdo del humano. Anclas firmes: los nombres `navigate` y `closeTab`.
// Anclas débiles: la prosa de "sin respuesta humana" y de "sin acuerdo".
func TestActDescription_NavigateCloseTabSinRespuestaHumana(t *testing.T) {
	s, _ := newTools(t)
	desc, _ := actTool(t, s)
	if desc == "" {
		t.Fatal("precondición: vlp_act debe tener Description")
	}

	t.Run("navigate_closeTab_cierran_la_pregunta_sin_respuesta_humana", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"navigate"},
			[]string{"closetab"},
			[]string{"pending", "pendiente"},
			[]string{
				"without a human answer", "without human answer", "without a human response", "without human response",
				"with no human answer", "no human answer", "without the human answering", "before the human answers",
				"false/null", "false or null",
				"sin respuesta humana", "sin que el humano",
			},
		) {
			t.Errorf("la Description de vlp_act no dice que navigate/closeTab cierran la pregunta pendiente sin respuesta humana (§3 P27 (b), H-12): %q", desc)
		}
	})

	t.Run("navigate_closeTab_no_se_usan_para_salir_sin_acuerdo_del_humano", func(t *testing.T) {
		if !hasConcept(desc,
			[]string{"navigate"},
			[]string{"closetab"},
			[]string{
				"do not use", "don't use", "never use", "must not be used", "should not be used", "not be used", "avoid using",
				"no se usan", "no usar", "no deben usarse",
			},
			[]string{"agree", "consent", "approv", "permission", "unless the human", "acuerdo", "consentimiento"},
		) {
			t.Errorf("la Description de vlp_act no dice que navigate/closeTab no se usan para salir de la pregunta pendiente sin acuerdo del humano (§3 P27 (b), H-12): %q", desc)
		}
	})
}

// TestClickEvalDescriptions_SinChequeoDePreguntaPendiente — P27 (c), R-17:
// `vlp_click` y `vlp_eval` dicen que no chequean la pregunta
// pendiente y que no se usan para esquivar un rechazo con `nativeDialog`.
// Ancla firme: el literal de wire `nativeDialog` en el segundo concepto.
// Anclas débiles: "no chequea", "no se usa", "rechazo", "esquivar".
func TestClickEvalDescriptions_SinChequeoDePreguntaPendiente(t *testing.T) {
	s, _ := newTools(t)
	for _, name := range []string{"vlp_click", "vlp_eval"} {
		desc := p27ToolDescription(t, s, name)
		if desc == "" {
			t.Fatalf("precondición: %s debe tener Description", name)
		}

		t.Run(name+"_no_chequea_la_pregunta_pendiente", func(t *testing.T) {
			if !hasConcept(desc,
				[]string{"nativedialog", "native dialog", "pending question", "pregunta pendiente", "pregunta nativa"},
				[]string{
					"does not check", "doesn't check", "do not check", "don't check", "not checked", "never check",
					"without checking", "no guard", "not guarded", "without the guard", "without a guard",
					"no chequea", "sin chequear", "sin guard",
				},
			) {
				t.Errorf("la Description de %s no dice que no chequea la pregunta pendiente (§3 P27 (c), R-17): %q", name, desc)
			}
		})

		t.Run(name+"_no_se_usa_para_esquivar_un_rechazo_con_nativeDialog", func(t *testing.T) {
			if !hasConcept(desc,
				[]string{"nativedialog"},
				[]string{
					"do not use", "don't use", "never use", "must not be used", "should not be used", "not be used", "avoid using",
					"no se usa", "no usar", "no deben usarse", "no debe usarse",
				},
				[]string{"reject", "refus", "ok:false", "rechaz", "blocked"},
				[]string{"bypass", "get around", "circumvent", "work around", "workaround", "sidestep", "evade", "dodge", "esquivar", "evadir", "sortear", "instead"},
			) {
				t.Errorf("la Description de %s no dice que no se usa para esquivar un rechazo con nativeDialog (§3 P27 (c), R-17): %q", name, desc)
			}
		})
	}
}
