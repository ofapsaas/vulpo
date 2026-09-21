// fb-020-007 — llamada durante una navegación: sonda S-1 y harness P12, P13,
// P19, P27 y la NOTE de P21
// (docs/specs/fb-020-007-orm-navigation-hang/harness-design.md, spec §9).
//
// Selector: VLP_NAVHANG=s1,p12,p13,p19,p21,p27 (lista separada por comas)
// corre SOLO esos escenarios sobre el boot de FRAME_E2E. VLP_FRAME_E2E=1
// corre P12, P13 y P27 dentro de la regresión completa (S-1 y P19 duran más de 60 s).
//
// El Odoo falso vive en un listener propio: si colgara de la página de test,
// todas las pestañas de la suite pasarían a ser pestañas Odoo válidas.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"
)

const (
	navHangCount        = 2733
	navHangOdooPath     = "odoo/action-760"
	navHangSlowFetchDur = 90 * time.Second
)

// slowFetchArrivals: requests recibidas por /slowfetch de la página de test.
var slowFetchArrivals atomic.Int64

const navHangSlowPageHTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>fb-020-007 slowpage</title></head>
<body><div id="status">fetch pendiente</div>
<script>fetch('/slowfetch').then(function () { document.getElementById('status').textContent = 'fetch terminado'; });</script>
</body></html>`

// registerNavHangRoutes: fixture inverso de P12 sobre la página de test —
// /slowpage deja un fetch de 90 s pendiente en el documento.
func registerNavHangRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/slowpage", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, navHangSlowPageHTML)
	})
	mux.HandleFunc("/slowfetch", func(w http.ResponseWriter, r *http.Request) {
		slowFetchArrivals.Add(1)
		if !sleepOrAbort(r, navHangSlowFetchDur) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	})
}

// sleepOrAbort duerme d o hasta que el cliente corte la request; true si durmió entero.
func sleepOrAbort(r *http.Request, d time.Duration) bool {
	select {
	case <-time.After(d):
		return true
	case <-r.Context().Done():
		return false
	}
}

// fakeOdoo: Odoo falso con get_session_info válido y call_kw de duración configurable.
type fakeOdoo struct {
	baseURL    string
	callKwMs   atomic.Int64
	callKwHits atomic.Int64
	close      func()
}

func (f *fakeOdoo) pageURL() string { return f.baseURL + navHangOdooPath }

func (f *fakeOdoo) setCallKwDuration(d time.Duration) { f.callKwMs.Store(d.Milliseconds()) }

func (f *fakeOdoo) resetCallKwHits() { f.callKwHits.Store(0) }

func startFakeOdoo() (*fakeOdoo, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	f := &fakeOdoo{}
	mux := http.NewServeMux()
	mux.HandleFunc("/"+navHangOdooPath, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8"><title>fb-020-007 fake odoo</title></head><body><div id="odoo-ready">Odoo falso</div></body></html>`)
	})
	mux.HandleFunc("/web/session/get_session_info", func(w http.ResponseWriter, r *http.Request) {
		writeJSONRPC(w, jsonRPCID(r), map[string]any{
			"uid": 2, "username": "admin", "db": "demo", "server_version": "19.0",
			"is_superuser": true, "user_context": map[string]any{"lang": "en_US"},
		})
	})
	mux.HandleFunc("/web/dataset/call_kw", func(w http.ResponseWriter, r *http.Request) {
		f.callKwHits.Add(1) // al llegar, antes de dormir
		id := jsonRPCID(r)
		if !sleepOrAbort(r, time.Duration(f.callKwMs.Load())*time.Millisecond) {
			return
		}
		writeJSONRPC(w, id, navHangCount)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, `<!doctype html><html><head><meta charset="utf-8"><title>fast</title></head><body><div id="fast-ready">rapida</div></body></html>`)
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	f.baseURL = "http://" + ln.Addr().String() + "/"
	f.close = func() { srv.Close() }
	return f, nil
}

func jsonRPCID(r *http.Request) any {
	var body struct {
		ID any `json:"id"`
	}
	data, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(data, &body)
	return body.ID
}

func writeJSONRPC(w http.ResponseWriter, id any, result any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

// callOutcome: desenlace de una tool lanzada en segundo plano.
type callOutcome struct {
	text     string
	toolErr  bool
	answered bool
	elapsed  time.Duration
}

func (o callOutcome) String() string {
	return fmt.Sprintf("respondió=%v error=%v %d ms; raw %.300s", o.answered, o.toolErr, o.elapsed.Milliseconds(), o.text)
}

func callInBackground(port int, name string, args map[string]any, timeout time.Duration) <-chan callOutcome {
	out := make(chan callOutcome, 1)
	go func() {
		t0 := time.Now()
		text, toolErr, answered := mcpCallEnvelope(port, name, args, timeout)
		out <- callOutcome{text: text, toolErr: toolErr, answered: answered, elapsed: time.Since(t0)}
	}()
	return out
}

func searchCountArgs(tabID int) map[string]any {
	return map[string]any{"model": "res.partner", "domain": "[]", "tabId": tabID}
}

func isCountResult(o callOutcome) bool {
	return o.answered && !o.toolErr && strings.Contains(o.text, fmt.Sprint(navHangCount))
}

func waitCounter(counter func() int64, want int64, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if counter() >= want {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

// openOdooTab abre el Odoo falso y deja la sesión detectada con un search_count rápido.
func openOdooTab(port int, odoo *fakeOdoo) (int, bool) {
	openText, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": odoo.pageURL()})
	tabID, found := 0, false
	if openOK {
		tabID, found = findTabByURL(port, odoo.pageURL(), 15*time.Second)
	}
	if !found {
		tabsText, _ := mcpCall(port, "vlp_listTabs", map[string]any{})
		return 0, paso("NAV-0: pestaña del Odoo falso abierta y detectada", false,
			fmt.Sprintf(" (openTab ok=%v %.200s; listTabs %.400s)", openOK, openText, tabsText))
	}
	odoo.setCallKwDuration(0)
	warm := <-callInBackground(port, "search_count", searchCountArgs(tabID), 30*time.Second)
	return tabID, paso("NAV-0: pestaña del Odoo falso abierta y detectada (search_count de calentamiento)",
		isCountResult(warm), fmt.Sprintf(" (tabId %d; %s)", tabID, warm))
}

func navigateTab(port, tabID int, url string) bool {
	_, ok := mcpCall(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": url})
	return ok
}

// runNavHangS1: sonda S-1 (antes del GREEN). search_count con call_kw de 90 s y
// navegación rápida a "/" apenas llega el call_kw. C-1 se confirma si no hay
// desenlace en 65 s.
func runNavHangS1(port int, odoo *fakeOdoo) bool {
	fmt.Println("\n[NAV-S1] Sonda S-1: ORM pendiente + navegación rápida (fb-020-007 C-1)")
	tabID, ok := openOdooTab(port, odoo)
	if !ok {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})
	odoo.resetCallKwHits()
	odoo.setCallKwDuration(navHangSlowFetchDur)
	call := callInBackground(port, "search_count", searchCountArgs(tabID), 70*time.Second)
	arrived := waitCounter(odoo.callKwHits.Load, 1, 3*time.Second)
	time.Sleep(100 * time.Millisecond)
	tNav := time.Now()
	navOK := navigateTab(port, tabID, odoo.baseURL)
	fmt.Printf("  [NOTE] S-1: call_kw llegó=%v, navigate a %s ok=%v\n", arrived, odoo.baseURL, navOK)
	// Sonda, no check: informa el desenlace y nunca falla la corrida.
	select {
	case o := <-call:
		fmt.Printf("  [NOTE] S-1: desenlace a %d ms desde la navegación (C-1 no se reproduce con este fixture) — %s\n",
			time.Since(tNav).Milliseconds(), o)
	case <-time.After(65 * time.Second):
		fmt.Printf("  [NOTE] S-1: sin desenlace en 65 s (C-1 confirmada); '/' cargó=%v\n", tabHasURL(port, tabID, odoo.baseURL))
	}
	fmt.Printf("  [NOTE] S-1: call_kw recibidos=%d\n", odoo.callKwHits.Load())
	return true
}

func tabHasURL(port, tabID int, url string) bool {
	text, ok := mcpCall(port, "vlp_listTabs", map[string]any{})
	var tabs []tabInfo
	if !ok || !parseJSON(text, &tabs) {
		return false
	}
	for _, t := range tabs {
		if t.ID == tabID {
			return t.URL == url
		}
	}
	return false
}

// runNavHangP12: waitForElement pendiente + navegación a "/" → error "navigated" antes de 10 s.
func runNavHangP12(port int, pageURL string) bool {
	fmt.Println("\n[NAV-P12] waitForElement durante una navegación (fb-020-007 P12)")
	slowURL := strings.TrimSuffix(pageURL, "/") + "/slowpage"
	_, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": slowURL})
	tabID, found := 0, false
	if openOK {
		tabID, found = findTabByURL(port, slowURL, 15*time.Second)
	}
	if !paso("P12-0: pestaña /slowpage abierta y detectada", openOK && found, fmt.Sprintf(" (tabId %d)", tabID)) {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})
	fetchPending := waitCounter(slowFetchArrivals.Load, 1, 5*time.Second)
	call := callInBackground(port, "vlp_waitForElement",
		map[string]any{"tabId": tabID, "selector": "#nunca", "timeout": 30000}, 45*time.Second)
	time.Sleep(300 * time.Millisecond)
	tNav := time.Now()
	navOK := navigateTab(port, tabID, pageURL)
	o := <-call
	sinceNav := time.Since(tNav)
	allOK := paso("P12: waitForElement retorna antes de 10 s desde la navegación con error \"navigated\"",
		navOK && o.answered && o.toolErr && strings.Contains(o.text, "navigated") && sinceNav < 10*time.Second,
		fmt.Sprintf(" (fetch lento pendiente=%v, navigate ok=%v, %d ms desde la navegación; %s)",
			fetchPending, navOK, sinceNav.Milliseconds(), o))
	after := <-callInBackground(port, "vlp_waitForElement",
		map[string]any{"tabId": tabID, "selector": "#adder", "timeout": 5000}, 20*time.Second)
	return paso("P12-post: waitForElement con un selector presente en '/' tiene éxito",
		after.answered && !after.toolErr && strings.Contains(after.text, `"found":true`), fmt.Sprintf(" (%s)", after)) && allOK
}

// runNavHangP13: search_count tras vlp_navigate (P13a) y navegación tras el despacho (P13b).
func runNavHangP13(port int, odoo *fakeOdoo) bool {
	fmt.Println("\n[NAV-P13] search_count durante una navegación (fb-020-007 P13)")
	tabID, ok := openOdooTab(port, odoo)
	if !ok {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})
	odoo.setCallKwDuration(5 * time.Second)
	allOK := true
	for _, delay := range []time.Duration{50, 100, 150, 200, 250} {
		delay *= time.Millisecond
		odoo.resetCallKwHits()
		navOK := navigateTab(port, tabID, odoo.pageURL())
		time.Sleep(delay)
		o := <-callInBackground(port, "search_count", searchCountArgs(tabID), 30*time.Second)
		categorized := o.answered && o.toolErr && strings.Contains(o.text, "odoo_")
		allOK = paso(fmt.Sprintf("P13a (%d ms): search_count tras navigate retorna antes de 15 s con 2733 o un odoo_* categorizado", delay.Milliseconds()),
			navOK && (isCountResult(o) || categorized) && o.elapsed < 15*time.Second && odoo.callKwHits.Load() <= 1,
			fmt.Sprintf(" (navigate ok=%v, call_kw=%d; %s)", navOK, odoo.callKwHits.Load(), o)) && allOK
		time.Sleep(500 * time.Millisecond)
	}

	odoo.resetCallKwHits()
	call := callInBackground(port, "search_count", searchCountArgs(tabID), 30*time.Second)
	arrived := waitCounter(odoo.callKwHits.Load, 1, 3*time.Second)
	navOK := navigateTab(port, tabID, odoo.pageURL())
	o := <-call
	time.Sleep(6 * time.Second)
	hits := odoo.callKwHits.Load()
	return paso("P13b: navegación tras el despacho → odoo_tab_unreachable \"safe to retry\" antes de 15 s, call_kw ≤ 1",
		arrived && navOK && o.answered && o.toolErr && strings.Contains(o.text, "odoo_tab_unreachable") &&
			strings.Contains(o.text, "safe to retry") && o.elapsed < 15*time.Second && hits <= 1,
		fmt.Sprintf(" (call_kw llegó=%v, navigate ok=%v, call_kw a los 6 s=%d; %s)", arrived, navOK, hits, o)) && allOK
}

// runNavHangP19: call_kw de 70 s con la pestaña quieta termina con éxito gracias al latido.
func runNavHangP19(port int, odoo *fakeOdoo) bool {
	fmt.Println("\n[NAV-P19] operación Odoo larga con latido (fb-020-007 P19)")
	tabID, ok := openOdooTab(port, odoo)
	if !ok {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})
	odoo.resetCallKwHits()
	odoo.setCallKwDuration(70 * time.Second)
	o := <-callInBackground(port, "search_count", searchCountArgs(tabID), 100*time.Second)
	noTimeout := !strings.Contains(o.text, "command_timeout")
	return paso("P19: search_count con call_kw de 70 s devuelve 2733 entre 70 y 90 s, sin command_timeout, call_kw = 1",
		isCountResult(o) && noTimeout && o.elapsed >= 70*time.Second && o.elapsed < 90*time.Second && odoo.callKwHits.Load() == 1,
		fmt.Sprintf(" (call_kw=%d; %s)", odoo.callKwHits.Load(), o))
}

// runNavHangP27: navigate a la misma URL con otro #hash no recambia el
// documento, así que la llamada ORM siguiente no espera una navegación (§9.4).
func runNavHangP27(port int, odoo *fakeOdoo) bool {
	fmt.Println("\n[NAV-P27] search_count tras navigate solo de fragmento (fb-020-007 P27)")
	tabID, ok := openOdooTab(port, odoo)
	if !ok {
		return false
	}
	defer mcpCall(port, "vlp_closeTab", map[string]any{"tabId": tabID})
	odoo.setCallKwDuration(0)
	odoo.resetCallKwHits()
	hashURL := fmt.Sprintf("%s#p27-%d", odoo.pageURL(), time.Now().UnixNano())
	t0 := time.Now()
	navOK := navigateTab(port, tabID, hashURL)
	o := <-callInBackground(port, "search_count", searchCountArgs(tabID), 30*time.Second)
	sinceNav := time.Since(t0)
	return paso("P27: navigate a la misma URL con otro #hash + search_count → 2733 en menos de 2 s",
		navOK && isCountResult(o) && o.elapsed < 2*time.Second,
		fmt.Sprintf(" (navigate ok=%v, %d ms desde navigate, call_kw=%d; %s)", navOK, sinceNav.Milliseconds(), odoo.callKwHits.Load(), o))
}

// noteNavHangP21: P21 (página congelada que deja de latir → odoo_command_timeout
// dentro de B+ε) no se simula en el harness. Congelar el event loop de la
// página congela también el hilo en el que corre la inyección y su fetch, y
// bloquear sendMessage exigiría un hook de test dentro de la extensión: en
// ambos casos se mediría otra cosa que el contrato. El corte por inactividad
// del hub lo cubren los Go unit P1/P3 (WS fake que deja de latir).
func noteNavHangP21() bool {
	fmt.Println("\n[NAV-P21] página que deja de latir (fb-020-007 P21)")
	fmt.Println("  [NOTE] P21 no se simula en el harness: congelar la página congela la inyección misma y bloquear el latido requiere un hook de test en la extensión; cubierto por Go unit P1/P3 del hub (internal/hub).")
	return true
}

// runNavHangE2E corre los escenarios pedidos (s1, p12, p13, p19, p21, p27) en ese orden.
func runNavHangE2E(port int, pageURL string, scenarios string) bool {
	selected := map[string]bool{}
	for _, s := range strings.Split(scenarios, ",") {
		selected[strings.TrimSpace(strings.ToLower(s))] = true
	}
	if !paso("NAV-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	odoo, err := startFakeOdoo()
	if !paso("NAV-pre: Odoo falso levantado", err == nil, fmt.Sprintf(" (err %v)", err)) {
		return false
	}
	defer odoo.close()
	allOK := true
	if selected["s1"] {
		allOK = runNavHangS1(port, odoo) && allOK
	}
	if selected["p12"] {
		allOK = runNavHangP12(port, pageURL) && allOK
	}
	if selected["p13"] {
		allOK = runNavHangP13(port, odoo) && allOK
	}
	if selected["p19"] {
		allOK = runNavHangP19(port, odoo) && allOK
	}
	if selected["p21"] {
		allOK = noteNavHangP21() && allOK
	}
	if selected["p27"] {
		allOK = runNavHangP27(port, odoo) && allOK
	}
	return allOK
}
