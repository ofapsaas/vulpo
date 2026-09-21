// fb-020-004 — P13 (§2.5) y AC-2 (§5), harness E2E con Firefox real.
// Reusa /type-observe?step=p23 en tab propio.
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"fmt"
	"strings"
	"time"
)

const fb004MayOrMayNot = "may or may not have been dispatched"

func fb004FillShape(m map[string]any, text, flag, sel string) (bool, string) {
	success, sucBool := m["success"].(bool)
	flagV, _ := m[flag].(bool)
	errStr, _ := m["error"].(string)
	selector, _ := m["selector"].(string)
	noReserved := !strings.Contains(text, fb004MayOrMayNot)
	ok := sucBool && !success && flagV && errStr != "" && selector == sel && noReserved
	return ok, fmt.Sprintf(" (success=%v bool=%v, %s=%v, error no vacío=%v, selector=%q, sin %q=%v; raw %.300s)",
		success, sucBool, flag, flagV, errStr != "", selector, fb004MayOrMayNot, noReserved, text)
}

func runFieldCaseE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-fieldcase] fill sin match / selector inválido y act con `text` (fb-020-004) — P13, AC-2")
	allOK := true
	if !paso("REP-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	firstURL := strings.TrimSuffix(pageURL, "/") + "/type-observe?step=p23"
	_, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": firstURL})
	tabID, tabOK := 0, false
	if openOK {
		tabID, tabOK = findTabByURL(port, firstURL, 15*time.Second)
	}
	if !paso("REP-0: tab de la fixture type-observe (p23) abierto y detectado", openOK && tabOK,
		fmt.Sprintf(" (openTab ok=%v, tabId %d, url %s)", openOK, tabID, firstURL)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})

	_, readyA, whyA := loadTypeObserveStep(port, tabID, pageURL, "p23", "")
	const selNoMatch = "#fb020004-no-existe"
	textA, toolErrA, answeredA := whyA, false, false
	var mA map[string]any
	parsedA := false
	if readyA {
		textA, toolErrA, answeredA = mcpCallEnvelope(port, "vlp_fill",
			map[string]any{"tabId": tabID, "selector": selNoMatch, "value": "x"}, 20*time.Second)
		parsedA = !toolErrA && parseJSON(textA, &mA)
	}
	shapeA, detA := fb004FillShape(mA, textA, "notFound", selNoMatch)
	allOK = paso("P13-notFound: fill con selector sin coincidencia → {success:false, notFound:true, error, selector}, sin \"may or may not\"",
		readyA && answeredA && parsedA && shapeA,
		fmt.Sprintf(" (fixture=%v, respondió=%v, error de tool=%v, JSON=%v)%s", readyA, answeredA, toolErrA, parsedA, detA)) && allOK

	_, readyB, whyB := loadTypeObserveStep(port, tabID, pageURL, "p23", "")
	const selInvalid = "#[[fb020004"
	textB, toolErrB, answeredB := whyB, false, false
	var mB map[string]any
	parsedB := false
	if readyB {
		textB, toolErrB, answeredB = mcpCallEnvelope(port, "vlp_fill",
			map[string]any{"tabId": tabID, "selector": selInvalid, "value": "x"}, 20*time.Second)
		parsedB = !toolErrB && parseJSON(textB, &mB)
	}
	shapeB, detB := fb004FillShape(mB, textB, "invalidSelector", selInvalid)
	allOK = paso("P13-invalidSelector: fill con selector inválido → {success:false, invalidSelector:true, error, selector}, sin \"may or may not\"",
		readyB && answeredB && parsedB && shapeB,
		fmt.Sprintf(" (fixture=%v, respondió=%v, error de tool=%v, JSON=%v)%s", readyB, answeredB, toolErrB, parsedB, detB)) && allOK

	refC, readyC, whyC := loadTypeObserveStep(port, tabID, pageURL, "p23", "campo-p23-enabled")
	const seed = "intacto-ac2"
	seeded, toolErrC, answeredC, textC := false, false, false, whyC
	if readyC {
		mSeed, seedOK, _ := toolMap(port, "vlp_fill", map[string]any{"tabId": tabID, "selector": "#p23-enabled", "value": seed})
		seeded, _ = mSeed["success"].(bool)
		seeded = seeded && seedOK
		if seeded && ensureBuildMode(port) {
			textC, toolErrC, answeredC = mcpCallEnvelope(port, "vlp_act",
				map[string]any{"tabId": tabID, "ref": refC, "action": "type", "text": "x"}, 20*time.Second)
		}
	}
	mRead, readOK, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	valC, valOK := elementValueByName(mRead, "campo-p23-enabled")
	allOK = paso("AC-2: act type con `text` → error de tool y el campo conserva su valor",
		readyC && seeded && answeredC && toolErrC && readOK && valOK && valC == seed,
		fmt.Sprintf(" (fixture=%v, sembrado=%v, respondió=%v, error de tool=%v, relectura=%v value=%q; raw %.300s)",
			readyC, seeded, answeredC, toolErrC, readOK && valOK, valC, textC)) && allOK
	return allOK
}
