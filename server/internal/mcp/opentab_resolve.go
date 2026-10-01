// Package mcp — fb-024-opentab-id (spec §3 D-1/D-2/D-5 + Enmienda 1).
//
// resolveOpenTab devuelve el id REAL (Firefox) de la pestaña que carga la URL
// pedida, resolviéndolo DESPUÉS del create con snapshots de `listTabs`:
//
//	before := listTabs()                       # ids presentes antes de abrir
//	raw    := openTab(url)                     # id de la extensión (NO confiable:
//	                                           #  browser.tabs.create desfasa +1 en Firefox real)
//	poll de listTabs hasta T: nuevo = id ∉ before
//	    exacto → prefijo → |nuevos|==1 (redirect)
//	si T vence → raw + idUnresolved:true       # nunca un id no verificado sin marcar
//
// Degradación honesta (D-2/Enmienda 1): si `listTabs` no es utilizable (error o
// respuesta no parseable) igual se despacha `openTab` (el gate de dominio sigue
// vigente) y se devuelve raw + idUnresolved:true SIN polls adicionales.
//
// El intervalo/plazo son package vars inyectables (In/5): los unit tests fijan
// 1 ms / ~15 ms para no dormir; producción usa los defaults 150/5000 (Q1).
package mcp

import (
	"encoding/json"
	"time"
)

// openTabPollIntervalMs: intervalo entre polls de listTabs (default 150 ms).
var openTabPollIntervalMs = 150

// openTabTimeoutMs: plazo total T de resolución (default 5000 ms — Q1).
var openTabTimeoutMs = 5000

// openTabNotFound: el tab nuevo que carga la URL no se pudo resolver dentro de T.
const openTabNotFound = -1

// tabSnapshot: fila normalizada de listTabs ({id,url} del wire de la extensión).
type tabSnapshot struct {
	id  int // -1 si el wire no trae un id utilizable
	url string
}

// resolveOpenTab: snapshot before → dispatch openTab → poll hasta T → tab nuevo
// que sirve `url`. `raw` es el resultado crudo de la extensión.
//
// Camino de listTabs no utilizable: se despacha openTab igual y se devuelve raw
// marcado idUnresolved:true (sin post-poll) — preserva el command wire de
// despacho (`openTab`) y la honestidad de I-3.
func resolveOpenTab(hub Hub, token, url string) (any, error) {
	before, ok := listTabSnapshots(hub, token)
	if !ok {
		raw, err := hub.Command(token, Command{Command: "openTab", Params: map[string]any{"url": url}})
		if err != nil {
			return nil, err
		}
		return markUnresolved(raw), nil
	}
	beforeIDs := idSet(before)

	raw, err := hub.Command(token, Command{Command: "openTab", Params: map[string]any{"url": url}})
	if err != nil {
		return nil, err
	}

	// Fast-path/poll: `until` calculado una sola vez; la primera iteración es el
	// fast-path (si el tab ya aparece en el primer snapshot, no hay más polls).
	until := time.Now().Add(time.Duration(openTabTimeoutMs) * time.Millisecond)
	for {
		tabs, ok := listTabSnapshots(hub, token)
		if !ok {
			// listTabs deja de ser utilizable en pleno poll: degradación honesta.
			return markUnresolved(raw), nil
		}
		if t, found := pickNewTab(tabs, beforeIDs, url); found {
			return tabResult(t), nil
		}
		if !time.Now().Before(until) {
			return markUnresolved(raw), nil
		}
		time.Sleep(time.Duration(openTabPollIntervalMs) * time.Millisecond)
	}
}

// listTabSnapshots: un snapshot utilizable de listTabs. `ok=false` si la
// respuesta no fue parseable al shape wire (detalle solo para diagnósticos).
func listTabSnapshots(hub Hub, token string) ([]tabSnapshot, bool) {
	res, err := hub.Command(token, Command{Command: "listTabs", Params: map[string]any{}})
	if err != nil {
		return nil, false
	}
	return tabsFromWire(res)
}

// tabsFromWire: normaliza el resultado de listTabs (array JSON de {id,url}).
// Una respuesta no parseable (string, null, objeto, number) → ok=false: el
// resolver degrada con idUnresolved en vez de fabricar un match.
func tabsFromWire(res any) ([]tabSnapshot, bool) {
	if res == nil {
		return nil, false
	}
	raw, err := json.Marshal(res)
	if err != nil {
		return nil, false
	}
	var wire []map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		return nil, false
	}
	out := make([]tabSnapshot, 0, len(wire))
	for _, t := range wire {
		out = append(out, tabSnapshot{id: idFromWire(t["id"]), url: urlFromWire(t["url"])})
	}
	return out, true
}

// idFromWire: id numérico del wire (JSON number). Cualquier otra forma → -1
// (no se inventa un id).
func idFromWire(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	}
	return openTabNotFound
}

// urlFromWire: url del wire; ausente → "" (no matchea nada por exacto/prefijo).
func urlFromWire(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// idSet: conjunto de ids presentes (snapshot before — D-1 `id ∉ before`).
func idSet(tabs []tabSnapshot) map[int]bool {
	out := make(map[int]bool, len(tabs))
	for _, t := range tabs {
		if t.id != openTabNotFound {
			out[t.id] = true
		}
	}
	return out
}

// pickNewTab: el tab nuevo (id ∉ before) que sirve `url`. Orden determinista
// (D-5/Enmienda 1): (1) match exacto; (2) match por prefijo (redirect que
// agrega path/query); (3) |nuevos|==1 → ese (redirect a otra URL) — condición
// necesaria, no suficiente: con ≥2 nuevos sin match NO se elige arbitrariamente.
// Empate de exactos → menor id.
func pickNewTab(tabs []tabSnapshot, beforeIDs map[int]bool, url string) (tabSnapshot, bool) {
	var nuevos []tabSnapshot
	for _, t := range tabs {
		if !beforeIDs[t.id] {
			nuevos = append(nuevos, t)
		}
	}
	if t, ok := lowestByID(matching(nuevos, func(t tabSnapshot) bool { return t.url == url })); ok {
		return t, true
	}
	if t, ok := lowestByID(matching(nuevos, func(t tabSnapshot) bool {
		return url != "" && len(t.url) > len(url) && t.url[:len(url)] == url
	})); ok {
		return t, true
	}
	if len(nuevos) == 1 {
		return nuevos[0], true
	}
	return tabSnapshot{}, false
}

// matching: subconjunto que cumple el predicado (conserva el orden de entrada).
func matching(tabs []tabSnapshot, pred func(tabSnapshot) bool) []tabSnapshot {
	var out []tabSnapshot
	for _, t := range tabs {
		if pred(t) {
			out = append(out, t)
		}
	}
	return out
}

// lowestByID: el de menor id del subconjunto (determinista — Enmienda 1).
func lowestByID(tabs []tabSnapshot) (tabSnapshot, bool) {
	if len(tabs) == 0 {
		return tabSnapshot{}, false
	}
	best := tabs[0]
	for _, t := range tabs[1:] {
		if t.id < best.id {
			best = t
		}
	}
	return best, true
}

// tabResult: el objeto de la tool para un tab resuelto ({id,url} verificados).
func tabResult(t tabSnapshot) map[string]any {
	return map[string]any{"id": t.id, "url": t.url}
}

// markUnresolved: raw + idUnresolved:true (D-2/I-3). El raw se copia (nunca se
// muta el objeto del hub) y debe ser un objeto; si no lo es, se envuelve.
func markUnresolved(raw any) any {
	out := map[string]any{}
	if m, ok := raw.(map[string]any); ok {
		for k, v := range m {
			out[k] = v
		}
	} else if raw != nil {
		out["raw"] = raw
	}
	out["idUnresolved"] = true
	return out
}
