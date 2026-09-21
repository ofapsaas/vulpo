// Unit rápido (fb-017-004): helpers puros de parseo del frame usado por la
// E2E — frameInfo (invalidation, sections/elements, findRefByName, count).
// No es parte del gate; valida la lógica de parseo sin navegador.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import "testing"

const sampleFrame = `{"tabId":3,"page":1,"sections":[{"name":null,"elements":[{"ref":"html/body/button[1]","role":"button","name":"Agregar nodo","tag":"button","disabled":false,"visible":true},{"ref":"html/body/input[1]","role":"textbox","name":"campo","tag":"input","disabled":false,"visible":true}]},{"name":"otra","elements":[{"ref":"html/body/div[1]/button[1]","role":"button","name":"nuevo","tag":"button","disabled":false,"visible":true}]}],"read":[],"do":["html/body/button[1]","html/body/input[1]","html/body/div[1]/button[1]"],"invalidation":{"changedSinceLast":true}}`

func TestFrameInfoParse(t *testing.T) {
	var f frameInfo
	if !parseJSON(sampleFrame, &f) {
		t.Fatal("parse del frame sample falló")
	}
	if !f.Invalidation.ChangedSinceLast {
		t.Fatalf("invalidation mal parseada: %+v", f.Invalidation)
	}
	if n := f.frameElementCount(); n != 3 {
		t.Fatalf("frameElementCount = %d, esperado 3", n)
	}
	ref, ok := f.findRefByName("Agregar nodo")
	if !ok || ref != "html/body/button[1]" {
		t.Fatalf("findRefByName('Agregar nodo') = %q, %v", ref, ok)
	}
	if _, ok := f.findRefByName("no-existe"); ok {
		t.Fatal("findRefByName('no-existe') no debió encontrar")
	}
}
