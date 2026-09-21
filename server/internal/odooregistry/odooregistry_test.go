// Package odooregistry tests — sub-fase RED, feature fb-013-002-rpc-bridge.
//
// Verifica las postcondiciones Go HARD del spec (docs/specs/fb-013-002-rpc-bridge/spec.md):
//
//	PC1 — Detect emite el command wire "odooDetectTabs" y List devuelve el perfil cacheado.
//	PC2 — List con respuesta vacía del mock devuelve lista vacía sin error.
//	PC3 — Lookup devuelve perfil+token para tab cacheado; error para tab no cacheado.
//	PC4 — IsActive refleja el ÚLTIMO Detect (true para tabs devueltos, false si un
//	      Detect posterior ya no los devuelve).
//	PC9 — OdooTabProfile hace round-trip JSON preservando el shape del Contrato 1
//	      (tabId/uid como number, is_superuser/is_active como bool, strings el resto).
//
// MockHub local (NO reutiliza el de package mcp — tipo no exportado, paquete distinto;
// ver test-audit §5). Mismo shape: captura calls, result/err configurables.
package odooregistry

import (
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// mockHub: doble de la interface Hub del paquete. Captura las llamadas a Command y
// devuelve result/err configurables por test.
type mockHub struct {
	mu    sync.Mutex
	calls []struct {
		profileID string
		cmd       Command
	}
	result any
	err    error
}

func (m *mockHub) Command(profileID string, cmd Command) (any, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, struct {
		profileID string
		cmd       Command
	}{profileID, cmd})
	return m.result, m.err
}

// lastCall devuelve el último profileID y Command emitidos al hub.
func (m *mockHub) lastCall() (string, Command) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.calls) == 0 {
		return "", Command{}
	}
	c := m.calls[len(m.calls)-1]
	return c.profileID, c.cmd
}

// setResult configura el resultado que Command devuelve en las próximas llamadas.
func (m *mockHub) setResult(r any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.result = r
}

// profileMap devuelve la representación wire (map JSON) de un OdooTabProfile, tal como
// la extensión la enviaría por el hub.
func profileMap() map[string]any {
	return map[string]any{
		"tabId":        7,
		"url":          "http://127.0.0.1:8078",
		"db":           "demo",
		"version":      "18.0",
		"uid":          2,
		"username":     "admin",
		"is_superuser": true,
		"is_active":    true,
	}
}

func wantProfile() OdooTabProfile {
	return OdooTabProfile{
		TabID:       7,
		URL:         "http://127.0.0.1:8078",
		DB:          "demo",
		Version:     "18.0",
		UID:         2,
		Username:    "admin",
		IsSuperuser: true,
		IsActive:    true,
	}
}

// --- PC1: Detect emite el command wire odooDetectTabs con el profileID correcto. ---

func TestDetect_EmitsOdooDetectTabs(t *testing.T) {
	hub := &mockHub{result: []map[string]any{}}
	reg := New()

	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}

	profileID, cmd := hub.lastCall()
	if profileID != "profA" {
		t.Errorf("Detect called hub.Command with profileID %q, want %q", profileID, "profA")
	}
	if cmd.Command != "odooDetectTabs" {
		t.Errorf("Detect emitted command %q, want %q", cmd.Command, "odooDetectTabs")
	}
	if cmd.TabID != "" {
		t.Errorf("Detect emitted TabID %q, want empty string", cmd.TabID)
	}
	if cmd.Params == nil {
		t.Fatalf("Detect emitted nil Params, want empty (non-nil) map")
	}
	if len(cmd.Params) != 0 {
		t.Errorf("Detect emitted Params with %d entries, want empty map", len(cmd.Params))
	}
}

// --- PC1: Detect devuelve un perfil; List(profileID) lo contiene con los 8 campos. ---

func TestDetect_ThenList_ReturnsProfile(t *testing.T) {
	hub := &mockHub{result: []map[string]any{profileMap()}}
	reg := New()

	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}

	got := reg.List("profA")
	if len(got) != 1 {
		t.Fatalf("List returned %d profiles, want 1", len(got))
	}
	if !reflect.DeepEqual(got[0], wantProfile()) {
		t.Errorf("List returned %+v, want %+v", got[0], wantProfile())
	}
}

// --- PC2: sin Odoo (mock devuelve []) → List vacía, sin error. ---

func TestList_Empty_OnNoOdoo(t *testing.T) {
	hub := &mockHub{result: []map[string]any{}}
	reg := New()

	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect returned error for empty result: %v", err)
	}
	if got := reg.List("profA"); len(got) != 0 {
		t.Errorf("List returned %d profiles, want 0 (no Odoo tabs)", len(got))
	}
}

// --- PC3: Lookup de un tab cacheado devuelve perfil + token (= profileID). ---

func TestLookup_CachedTab_ReturnsProfileAndToken(t *testing.T) {
	hub := &mockHub{result: []map[string]any{profileMap()}}
	reg := New()
	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}

	profile, token, err := reg.Lookup("7")
	if err != nil {
		t.Fatalf("Lookup(cached tab) returned error: %v", err)
	}
	if token != "profA" {
		t.Errorf("Lookup returned token %q, want profileID %q", token, "profA")
	}
	if !reflect.DeepEqual(profile, wantProfile()) {
		t.Errorf("Lookup returned profile %+v, want %+v", profile, wantProfile())
	}
}

// --- PC3: Lookup de un tab no cacheado devuelve error que habilita el mensaje
//          "No Odoo tab detected. Open an Odoo tab first or provide a profile." ---

func TestLookup_MissingTab_ReturnsError(t *testing.T) {
	hub := &mockHub{result: []map[string]any{}}
	reg := New()
	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect returned error: %v", err)
	}

	_, _, err := reg.Lookup("999")
	if err == nil {
		t.Fatal("Lookup(missing tab) returned nil error, want error")
	}
	if !strings.Contains(err.Error(), "No Odoo tab detected") {
		t.Errorf("Lookup error %q does not enable the 'No Odoo tab detected' message", err.Error())
	}
}

// --- PC4: IsActive refleja el ÚLTIMO Detect. ---

func TestIsActive_RefreshesOnDetect(t *testing.T) {
	hub := &mockHub{result: []map[string]any{profileMap()}}
	reg := New()

	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect(1) returned error: %v", err)
	}
	if !reg.IsActive("7") {
		t.Errorf("IsActive after Detect with tab 7 active: got false, want true")
	}

	// Detect posterior ya no devuelve el tab 7 → deja de estar activo.
	hub.setResult([]map[string]any{})
	if err := reg.Detect("profA", hub); err != nil {
		t.Fatalf("Detect(2) returned error: %v", err)
	}
	if reg.IsActive("7") {
		t.Errorf("IsActive after Detect without tab 7: got true, want false")
	}
}

// --- PC9: shape JSON del Contrato 1 — round-trip marshal/unmarshal. ---

func TestOdooTabProfile_JSONRoundTrip(t *testing.T) {
	in := wantProfile()

	data, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	// Shape de claves y tipos: tabId/uid números (no strings); is_* bools; resto strings.
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("Unmarshal to map: %v", err)
	}
	assertJSONNumber(t, raw, "tabId", 7)
	assertJSONNumber(t, raw, "uid", 2)
	assertJSONBool(t, raw, "is_superuser", true)
	assertJSONBool(t, raw, "is_active", true)
	assertJSONString(t, raw, "url", "http://127.0.0.1:8078")
	assertJSONString(t, raw, "db", "demo")
	assertJSONString(t, raw, "version", "18.0")
	assertJSONString(t, raw, "username", "admin")

	var out OdooTabProfile
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("Unmarshal round-trip: %v", err)
	}
	if !reflect.DeepEqual(out, in) {
		t.Errorf("round-trip mismatch: got %+v, want %+v", out, in)
	}
}

// --- helpers de shape JSON ---

func assertJSONNumber(t *testing.T, m map[string]any, key string, want int) {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("JSON missing key %q", key)
	}
	n, ok := v.(float64) // JSON numbers decodifican a float64
	if !ok {
		t.Fatalf("JSON key %q has type %T, want number", key, v)
	}
	if int(n) != want {
		t.Errorf("JSON key %q = %v, want %d", key, int(n), want)
	}
}

func assertJSONBool(t *testing.T, m map[string]any, key string, want bool) {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("JSON missing key %q", key)
	}
	b, ok := v.(bool)
	if !ok {
		t.Fatalf("JSON key %q has type %T, want bool", key, v)
	}
	if b != want {
		t.Errorf("JSON key %q = %v, want %v", key, b, want)
	}
}

func assertJSONString(t *testing.T, m map[string]any, key, want string) {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("JSON missing key %q", key)
	}
	s, ok := v.(string)
	if !ok {
		t.Fatalf("JSON key %q has type %T, want string", key, v)
	}
	if s != want {
		t.Errorf("JSON key %q = %q, want %q", key, s, want)
	}
}
