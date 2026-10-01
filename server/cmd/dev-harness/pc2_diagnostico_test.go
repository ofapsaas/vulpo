package main

// fb-024-harness-pc2-diagnostico — P1 y P2 (spec §3.2, RED).
//
// P1 — clasificador puro pc2NoRegistrationLine(configInjected bool) string
// (D-2): separa la línea (a) [config omitida por selector, nombrada por
// VLP_HARNESS_NOCONFIG] de la línea (b) [no registró; estado observado, sin
// afirmar causa no observada]. Ninguna de las dos repite el literal colapsado
// viejo `extension not configured (harness-config)` (se elimina de la ruta
// genérica, D-2). Guarda: las dos líneas difieren entre sí.
//
// P2 — barrera waitForStartURLTab (D-1) contra un httptest.Server que imita
// el canal /mcp del server real:
//   - POST /mcp `initialize` → 200 con header `Mcp-Session-Id`;
//   - POST /mcp `tools/call` de `vlp_listTabs` → result.content[0].text es el
//     JSON de la lista de tabs `[{"id":<n>,"url":"<url>"}]` (contrato wire
//     declarado por este fixture; la implementación de GREEN parsea ESTE
//     contrato observado).
//
// (a) con `[]` persistente devuelve false al vencer (honesto, no cuelga) —
// y "al vencer" significa que la espera completa transcurrió: no se rinde
// antes de la ventana (anti-vacuidad, I-4).
// (b) cuando el tab de la start-url aparece a mitad de la espera devuelve
// true antes del timeout, con el tabID observado.
//
// Cada test cita la cláusula de la postcondición que verifica. El contrato
// observable es el valor de retorno y su temporalidad; no se pinea el
// mecanismo de poll interno (convención heredada de settle_barrier_test.go).

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// ---- fixture /mcp ----

// pc2McpFixture imita el canal /mcp del server: initialize con
// Mcp-Session-Id y tools/call vlp_listTabs con el estado de tabs controlado
// por el test (mutable a mitad de la espera, como el registro real).
type pc2McpFixture struct {
	mu        sync.Mutex
	tabs      []map[string]any
	sessionID string
}

func (f *pc2McpFixture) tabsSnapshot() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]map[string]any, len(f.tabs))
	copy(out, f.tabs)
	return out
}

func (f *pc2McpFixture) setTabs(tabs []map[string]any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tabs = tabs
}

// showTabAfter hace aparecer el tab de la start-url después de delay
// (registro a mitad de la espera, como en la carrera real de PC2).
func (f *pc2McpFixture) showTabAfter(delay time.Duration, tabID int, pageURL string) {
	time.AfterFunc(delay, func() {
		f.setTabs([]map[string]any{{"id": tabID, "url": pageURL}})
	})
}

// newPc2McpFixture arma el httptest.Server y devuelve (fixture, port). El
// port (int) es la firma declarada por D-1 para waitForStartURLTab; se
// extrae de srv.URL para poder testear contra httptest sin cambiar la firma.
func newPc2McpFixture(t *testing.T) (*pc2McpFixture, int) {
	t.Helper()
	f := &pc2McpFixture{sessionID: "pc2-fake-session-1"}
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params map[string]any  `json:"params"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch req.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", f.sessionID)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"protocolVersion": "2025-06-18",
					"capabilities":    map[string]any{},
					"serverInfo":      map[string]any{"name": "pc2-fake-mcp", "version": "0.0.1"},
				},
			})
		case "notifications/initialized":
			w.WriteHeader(http.StatusAccepted)
		case "tools/call":
			name, _ := req.Params["name"].(string)
			if name != "vlp_listTabs" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"jsonrpc": "2.0", "id": req.ID,
					"error": map[string]any{"code": -32601, "message": "tool not found: " + name},
				})
				return
			}
			text, _ := json.Marshal(f.tabsSnapshot())
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0",
				"id":      req.ID,
				"result": map[string]any{
					"content": []map[string]any{{"type": "text", "text": string(text)}},
				},
			})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{
				"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{},
			})
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse srv.URL: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("port de srv.URL (%s): %v", srv.URL, err)
	}
	return f, port
}

// ---- P1: clasificador puro del mensaje de no-registro ----

// P1: "pc2NoRegistrationLine(false) devuelve una línea que contiene
// VLP_HARNESS_NOCONFIG y no contiene `not configured (harness-config)`".
// La línea (a) nombra el selector determinista (D-4) y el archivo omitido
// (contrato D-4 de bootstrap-solo-dev, citado por D-2).
func TestPc2NoRegistrationLine_NoConfig_NamesSelectorAndDropsOldLiteral(t *testing.T) {
	line := pc2NoRegistrationLine(false)

	if !strings.Contains(line, "VLP_HARNESS_NOCONFIG") {
		t.Fatalf("pc2NoRegistrationLine(false) = %q: quiero que nombre el selector VLP_HARNESS_NOCONFIG", line)
	}
	if strings.Contains(line, "not configured (harness-config)") {
		t.Fatalf("pc2NoRegistrationLine(false) = %q: la línea (a) no debe repetir el literal colapsado viejo `not configured (harness-config)` (D-2: se elimina de la ruta genérica)", line)
	}
	if !strings.Contains(line, "harness-config.js") {
		t.Fatalf("pc2NoRegistrationLine(false) = %q: la línea (a) debe nombrar harness-config.js (contrato D-4 de bootstrap-solo-dev que D-2 hace repetir)", line)
	}
}

// P1: "pc2NoRegistrationLine(true) no contiene `not configured (harness-config)`
// y nombra MV3/arranque". La línea (b) declara el estado observado y las
// causas candidatas sin afirmar una causa no observada (D-2/D-3, I-7).
func TestPc2NoRegistrationLine_Injected_NamesMv3Startup(t *testing.T) {
	line := pc2NoRegistrationLine(true)

	if strings.Contains(line, "not configured (harness-config)") {
		t.Fatalf("pc2NoRegistrationLine(true) = %q: la línea (b) no debe afirmar `not configured` con la config inyectada (afirmaría una causa no observada, I-7)", line)
	}
	if !strings.Contains(line, "MV3") {
		t.Fatalf("pc2NoRegistrationLine(true) = %q: la línea (b) debe nombrar MV3/arranque del event page como causa candidata (D-2)", line)
	}
}

// P1 (guarda): "las dos líneas difieren entre sí" — el selector separa (a)
// de (b): quien lee la salida puede distinguir config omitida de no-registro.
func TestPc2NoRegistrationLine_LinesDiffer(t *testing.T) {
	noConfig := pc2NoRegistrationLine(false)
	injected := pc2NoRegistrationLine(true)

	if noConfig == injected {
		t.Fatalf("las líneas (a) y (b) son idénticas (%q): el clasificador no separa las causas por selector", noConfig)
	}
}

// ---- P2: barrera waitForStartURLTab contra /mcp fake ----

// P2(a): "con [] persistente devuelve false al vencer (honesto, no cuelga)".
// La ventana completa de espera transcurre: la barrera no se rinde antes de
// la ventana (I-4: vence honesta, no pasa ni se retira en vacío).
func TestWaitForStartURLTab_TimeoutReturnsFalseHonest(t *testing.T) {
	_, port := newPc2McpFixture(t) // tabs: [] persistente
	const timeout = 300 * time.Millisecond

	start := time.Now()
	tabID, ok := waitForStartURLTab(port, "http://127.0.0.1:9/no-existe-page", timeout)
	elapsed := time.Since(start)

	if ok {
		t.Fatalf("waitForStartURLTab con [] persistente: quiero false al vencer; obtuve true (tabID=%d)", tabID)
	}
	if tabID != 0 {
		t.Errorf("waitForStartURLTab con [] persistente: quiero tabID 0 al vencer; obtuve %d", tabID)
	}
	if elapsed >= timeout+2*time.Second {
		t.Errorf("waitForStartURLTab tardó %v con timeout %v: parece colgar en vez de vencer honesto", elapsed, timeout)
	}
	// "al vencer": la espera no termina antes de la ventana (los timers de Go
	// no disparan antes de su presupuesto; margen 10% por medición).
	if elapsed < timeout*9/10 {
		t.Errorf("waitForStartURLTab volvió en %v con timeout %v y [] persistente: venció ANTES de la ventana (I-4: la barrera debe vencer al fin de la espera, no retirarse en vacío)", elapsed, timeout)
	}
}

// P2(b): "cuando el tab aparece a mitad de la espera devuelve true antes del
// timeout". El tab de la start-url aparece a los 400ms; la barrera debe
// observarlo (no-vacuidad: no puede volver cierto antes de que exista) y
// devolver el tabID con ok=true, antes del timeout de 2s.
func TestWaitForStartURLTab_AppearsMidWait(t *testing.T) {
	f, port := newPc2McpFixture(t)
	const (
		switchAt = 400 * time.Millisecond
		timeout  = 2 * time.Second
		pageURL  = "http://127.0.0.1:9/pc2-fixture-page"
	)
	f.showTabAfter(switchAt, 7, pageURL)

	start := time.Now()
	tabID, ok := waitForStartURLTab(port, pageURL, timeout)
	elapsed := time.Since(start)

	if !ok {
		t.Fatalf("waitForStartURLTab: quiero true cuando el tab de la start-url aparece a mitad de la espera; obtuve false (venció %v) — espera vacía", elapsed)
	}
	if tabID <= 0 {
		t.Errorf("waitForStartURLTab: quiero el tabID observado del tab de la start-url; obtuve %d", tabID)
	}
	if elapsed >= timeout {
		t.Errorf("waitForStartURLTab volvió después del timeout (%v): no volvió por la condición, volvió por vencimiento", elapsed)
	}
	// No-vacuidad: la condición es imposible antes del switch; volver cierto
	// antes sería pasar en vacío.
	if elapsed < switchAt*9/10 {
		t.Errorf("waitForStartURLTab volvió cierto en %v, antes de que el tab existiera (switch en %v): pasó en vacío", elapsed, switchAt)
	}
}

// P2(b) — guarda de la semántica de match declarada por D-1 ("exact match,
// luego prefix, igual que findTabByURL"): un tab cuya URL extiende la
// start-url (prefijo) también satisface la barrera.
func TestWaitForStartURLTab_MatchesByPrefix(t *testing.T) {
	f, port := newPc2McpFixture(t)
	const (
		switchAt = 300 * time.Millisecond
		timeout  = 2 * time.Second
		pageURL  = "http://127.0.0.1:9/pc2-fixture-page"
	)
	f.showTabAfter(switchAt, 8, pageURL+"/slow")

	tabID, ok := waitForStartURLTab(port, pageURL, timeout)
	if !ok {
		t.Fatalf("waitForStartURLTab: quiero true con tab de URL-prefijo de la start-url (semántica D-1 exact→prefix); obtuve false")
	}
	if tabID != 8 {
		t.Errorf("waitForStartURLTab: quiero tabID 8 (el tab prefijo); obtuve %d", tabID)
	}
}

// Sanity del fixture (no es postcondición): el fake /mcp responde initialize
// con Mcp-Session-Id — la imitación del canal declarada en P2.
func TestPc2McpFixture_InitializeAnswersSessionID(t *testing.T) {
	_, port := newPc2McpFixture(t)
	body := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`
	resp, err := http.Post(fmt.Sprintf("http://127.0.0.1:%d/mcp", port), "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST /mcp initialize: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("initialize status = %d, want 200", resp.StatusCode)
	}
	if resp.Header.Get("Mcp-Session-Id") == "" {
		t.Fatalf("initialize sin header Mcp-Session-Id: el fake no imita el canal /mcp")
	}
}
