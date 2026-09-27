// fb-024-screenshot-imagen — P5 stdio passthrough guard (stage 3, RED-neutral).
//
// Source: docs/specs/fb-024-screenshot-imagen/spec.md §3 P5 (stdio.go:40-71
// forward → relay → json.Compact, no re-serialization); test-audit GC-2
// (self-contained image-capable fake in THIS file, main_test.go untouched).
//
// The fake mirrors the decide contract of main_test.go (initialize/session/
// tools/call over httptest loopback) but emits IMAGE + metadata content
// parts for vlp_screenshot. The test then drives the full mcp-stdio
// in-subprocess run (TestC12 pattern) and asserts the tools/call response is
// relayed byte-faithfully on stdout: image part data/mimeType intact,
// metadata text intact, no re-serialization into text.
//
// Expected green before implementation (the passthrough already exists) and
// to stay green — this is a guard, not a RED.

package main_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// p24FixturePNG builds a small synthetic PNG (I-4 style: programmatic RGBA,
func p24FixturePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := img.PixOffset(x, y)
			img.Pix[off+0] = uint8((x * 3) % 256)
			img.Pix[off+1] = uint8((y * 5) % 256)
			img.Pix[off+2] = uint8((x + y) % 256)
			img.Pix[off+3] = 0xff
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("fb-024 P5: png.Encode fixture: %v", err)
	}
	return buf.Bytes()
}

// p24fakeMCP is a minimal image-capable mirror of the decide contract
// (~main_test.go:386-459): token check, initialize session, tools/list,
// tools/call returning a content array of [image part, metadata text part].
type p24fakeMCP struct {
	srv *httptest.Server

	mu      sync.Mutex
	token   string
	session string
	imgB64  string
	imgMime string

	// rawCallJSON is the exact bytes the fake answers for tools/call —
	// captured so the test can compare against stdout relayed by vlpmcp.
	rawCallJSON string
}

func newP24Fake(t *testing.T) *p24fakeMCP {
	t.Helper()
	raw := p24FixturePNG(t, 800, 480)
	b64 := base64.StdEncoding.EncodeToString(raw)

	metadata := fmt.Sprintf(`{"screenshot":{"mimeType":"image/png","width":800,"height":480,"bytes":%d,"source":[800,480],"rescaled":false}}`, len(raw))

	// Byte-exact tools/call answer: content[0] image part, content[1] metadata.
	callBody := fmt.Sprintf(`{"jsonrpc":"2.0","id":"p24-call","result":{"content":[`+
		`{"type":"image","data":%q,"mimeType":"image/png"},`+
		`{"type":"text","text":%q}]}}`, b64, metadata)

	f := &p24fakeMCP{token: sentinelToken, imgB64: b64, imgMime: "image/png", rawCallJSON: callBody}
	f.srv = httptest.NewServer(f)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *p24fakeMCP) URL() string { return f.srv.URL + "/mcp" }

func (f *p24fakeMCP) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	type reqT struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
	}
	var req reqT
	if err := json.Unmarshal(body, &req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "bad json")
		return
	}
	if r.Header.Get("x-vlp-token") != f.token {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(w, "invalid token")
		return
	}
	session := r.Header.Get("Mcp-Session-Id")
	if req.Method != "initialize" && session == "" {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "missing session")
		return
	}
	f.mu.Lock()
	if f.session == "" {
		f.session = "p24-session-1"
	}
	sess := f.session
	f.mu.Unlock()

	var msg map[string]any
	switch req.Method {
	case "initialize":
		msg = map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{
			"protocolVersion": "2025-06-18",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "p24-fake", "version": "0"},
		}}
	case "tools/call":
		// Relay the captured raw body verbatim: byte-faithful anchor.
		w.Header().Set("Mcp-Session-Id", sess)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, f.rawCallJSON)
		return
	default:
		if len(req.ID) == 0 {
			w.WriteHeader(http.StatusAccepted)
			return
		}
		if msg == nil {
			msg = map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{}}
		}
	}
	if msg != nil {
		w.Header().Set("Mcp-Session-Id", sess)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(msg)
		_, _ = w.Write(bytes.TrimRight(buf.Bytes(), "\n"))
	}
}

// TestStdioPassthrough drives vlpmcp mcp-stdio against the image-capable fake
// and asserts the tools/call result content is relayed byte-faithfully.
func TestStdioPassthrough(t *testing.T) {
	fake := newP24Fake(t)
	env := newEnv(t, fake.URL())

	stdin := stdioInitializeLine +
		`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
		`{"jsonrpc":"2.0","id":"p24-call","method":"tools/call","params":{"name":"vlp_screenshot","arguments":{"tabId":7}}}` + "\n"
	res := runVlpmcp(t, env, stdin, "mcp-stdio")
	expectExit(t, res, 0)

	msgs := parseStdioOutput(t, res.Stdout)
	call := findByID(msgs, "p24-call")
	if call == nil {
		t.Fatalf("fb-024 P5: no response with id \"p24-call\" on stdout\nstdout: %q", res.Stdout)
	}

	var result struct {
		Content []struct {
			Type     string `json:"type"`
			Data     string `json:"data,omitempty"`
			MimeType string `json:"mimeType,omitempty"`
			Text     string `json:"text,omitempty"`
		} `json:"content"`
	}
	if err := json.Unmarshal(call.Result, &result); err != nil {
		t.Fatalf("fb-024 P5: tools/call result is not valid JSON: %v (%q)", err, string(call.Result))
	}
	if len(result.Content) != 2 {
		t.Fatalf("fb-024 P5: content has %d parts, want 2 (image + metadata) — %q", len(result.Content), string(call.Result))
	}
	imgPart := result.Content[0]
	if imgPart.Type != "image" {
		t.Fatalf("fb-024 P5: content[0].type = %q, want image (re-serialized into text?) — %q", imgPart.Type, string(call.Result))
	}
	if imgPart.Data != fake.imgB64 {
		t.Errorf("fb-024 P5: content[0].data not byte-faithful to the fake's image payload")
	}
	if imgPart.MimeType != "image/png" {
		t.Errorf("fb-024 P5: content[0].mimeType = %q, want image/png", imgPart.MimeType)
	}
	metadataPart := result.Content[1]
	if metadataPart.Type != "text" || metadataPart.Text == "" {
		t.Fatalf("fb-024 P5: content[1] = %+v, want non-empty text metadata part", metadataPart)
	}
	if !strings.Contains(metadataPart.Text, "screenshot") {
		t.Errorf("fb-024 P5: content[1].text = %q, want the metadata JSON", metadataPart.Text)
	}
	raw, err := base64.StdEncoding.DecodeString(imgPart.Data)
	if err != nil || len(raw) == 0 {
		t.Errorf("fb-024 P5: relayed image data does not decode: %v", err)
	}
}
