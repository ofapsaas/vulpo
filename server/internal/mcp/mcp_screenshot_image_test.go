// fb-024-screenshot-imagen — RED contract tests (stage 3, sub-phase RED).
//
// Sources: docs/specs/fb-024-screenshot-imagen/spec.md §3 (P1, P2, P4), §4
// (I-4 synthetic fixtures, G-1 operationalization via test-audit GC-1),
// docs/specs/fb-024-screenshot-imagen/test-audit.md §2/§4/§5.
//
// These tests are the only oracle for the vlp_screenshot image-part wire
// shape; the implementation was never read (no tools.go / mcp.go / hub).
// Derivation of the expected rescale branch dims: source 1546×888, cap 1280
// on the max side, aspect preserved with integer-floor dims —
// floor(888 × 1280 / 1546) = floor(1136640/1546) = 735 → delivered 1280×735.
//
// RED expectations (test-audit §5): all tests here fail on the committed
// tree because today vlp_screenshot relays the hub envelope as ONE text part
// ({"dataUrl":...}); the image branch does not exist yet.

package mcp

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"vulpo/server/internal/odooregistry"
)

// fb024SynthPNG builds a synthetic fixture exactly as I-4 requires: a
// programmatically filled RGBA encoded with the stdlib encoder. The raw
// encoded bytes are captured ONCE and every assertion below uses those exact
// bytes (Go PNG encoding varies across encodes by design — filter choices).
func fb024SynthPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			off := img.PixOffset(x, y)
			img.Pix[off+0] = uint8((x*7 + y*3) % 256)
			img.Pix[off+1] = uint8((x*2 + y*5) % 256)
			img.Pix[off+2] = uint8((x + y) % 256)
			img.Pix[off+3] = 0xff
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("fb-024 fixture: png.Encode %dx%d: %v", w, h, err)
	}
	return buf.Bytes()
}

// decodedDims decodes exactly one image from b and returns its pixel dims.
func decodedDims(t *testing.T, b []byte) (int, int) {
	t.Helper()
	imgCfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("fb-024: fixture bytes are not a decodable image: %v", err)
	}
	_ = format
	return imgCfg.Width, imgCfg.Height
}

// fb024DataUrl is the exact envelope shape the extension hands the hub today
// (spec §3 P1: {"dataUrl":"data:image/png;base64,<b64>"}).
func fb024DataUrl(raw []byte) string {
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(raw)
}

// fb024CallScreenshot routes tools/call vlp_screenshot (wire command
// "screenshot", requiresTab — toolsTable :108) against the caller's hub and a
// Server bound to that same hub.
func fb024CallScreenshot(t *testing.T, hub *MockHub, dataUrlSeed any) (map[string]any, map[string]any) {
	t.Helper()
	hub.byCommand = map[string]any{"screenshot": dataUrlSeed}
	s := New(hub)
	RegisterAllTools(s, hub, "", odooregistry.New())
	resp, _ := s.HandleRequest(map[string]any{
		"id": 1, "method": "tools/call",
		"params": map[string]any{"name": "vlp_screenshot", "arguments": map[string]any{"tabId": float64(7)}},
	}, "tok1")
	m, ok := resp.(map[string]any)
	if !ok {
		t.Fatalf("fb-024: unexpected HandleRequest response %T", resp)
	}
	res, _ := m["result"].(map[string]any)
	errMap, _ := m["error"].(map[string]any)
	return res, errMap
}

// fb024Content returns the result content array as stringly-typed parts.
func fb024Content(t *testing.T, res map[string]any) []map[string]any {
	t.Helper()
	arr, ok := res["content"].([]any)
	if !ok {
		t.Fatalf("fb-024: result.content missing or not an array — %v", res)
	}
	out := make([]map[string]any, 0, len(arr))
	for i, it := range arr {
		part, ok := it.(map[string]any)
		if !ok {
			t.Fatalf("fb-024: content[%d] is not an object — %T", i, it)
		}
		out = append(out, part)
	}
	return out
}

var fb024B64Run = regexp.MustCompile(`[A-Za-z0-9+/]{16,}`)

// fb024AssertNoBase64Leaks applies the audit's approved G-1 operationalization
// (GC-1) to every type:"text" part: (a) the fixture's exact base64 string is
// not a substring of any text part; (b) no text part contains the
// "data:image/png;base64," prefix signature; (c) no text part contains a run
// of >=16 base64-alphabet characters.
func fb024AssertNoBase64Leaks(t *testing.T, parts []map[string]any, fixtureB64 string) {
	t.Helper()
	for i, part := range parts {
		if part["type"] != "text" {
			continue
		}
		text, _ := part["text"].(string)
		if strings.Contains(text, fixtureB64) {
			t.Errorf("fb-024 G-1(a): content[%d] text contains the fixture base64 payload", i)
		}
		if strings.Contains(text, "data:image/png;base64,") {
			t.Errorf("fb-024 G-1(b): content[%d] text contains a data:image/png;base64, prefix", i)
		}
		if loc := fb024B64Run.FindStringIndex(text); loc != nil {
			t.Errorf("fb-024 G-1(c): content[%d] text contains a %d-char base64-alphabet run at %d (%s)",
				i, loc[1]-loc[0], loc[0], text[loc[0]:loc[1]])
		}
	}
}

// fb024AssertMetadataPart checks content[1]: single-line JSON text with ONE
// top-level key "screenshot" carrying mimeType/width/height/bytes/source/rescaled.
func fb024AssertMetadataPart(t *testing.T, part map[string]any, wantMime string, wantW, wantH, wantBytes int, wantSource [2]int, wantRescaled bool) {
	t.Helper()
	if part["type"] != "text" {
		t.Fatalf("fb-024 P1: metadata content[1].type = %v, want text", part["type"])
	}
	text, _ := part["text"].(string)
	if strings.ContainsRune(text, '\n') {
		t.Fatalf("fb-024 P1: metadata text is not single-line: %q", text)
	}
	var top map[string]any
	if err := json.Unmarshal([]byte(text), &top); err != nil {
		t.Fatalf("fb-024 P1: metadata text is not JSON: %q (%v)", text, err)
	}
	if len(top) != 1 {
		t.Fatalf("fb-024 P1: metadata top-level keys = %v, want exactly one key screenshot", top)
	}
	shot, ok := top["screenshot"].(map[string]any)
	if !ok {
		t.Fatalf("fb-024 P1: metadata top-level key screenshot missing — %v", top)
	}
	for _, key := range []string{"mimeType", "width", "height", "bytes", "source", "rescaled"} {
		if _, present := shot[key]; !present {
			t.Fatalf("fb-024 P1: metadata screenshot missing key %q — %v", key, shot)
		}
	}
	if shot["mimeType"] != wantMime {
		t.Errorf("fb-024 metadata mimeType = %v, want %s", shot["mimeType"], wantMime)
	}
	if int(shot["width"].(float64)) != wantW {
		t.Errorf("fb-024 metadata width = %v, want %d", shot["width"], wantW)
	}
	if int(shot["height"].(float64)) != wantH {
		t.Errorf("fb-024 metadata height = %v, want %d", shot["height"], wantH)
	}
	if int(shot["bytes"].(float64)) != wantBytes {
		t.Errorf("fb-024 metadata bytes = %v, want %d", shot["bytes"], wantBytes)
	}
	src, _ := shot["source"].([]any)
	if len(src) != 2 || int(src[0].(float64)) != wantSource[0] || int(src[1].(float64)) != wantSource[1] {
		t.Errorf("fb-024 metadata source = %v, want [%d %d]", shot["source"], wantSource[0], wantSource[1])
	}
	if rescaled, ok := shot["rescaled"].(bool); !ok || rescaled != wantRescaled {
		t.Errorf("fb-024 metadata rescaled = %v, want %v", shot["rescaled"], wantRescaled)
	}
}

// fb024ImagePart checks a part is exactly {"type":"image","data":<b64>,
// "mimeType":<mime>} whose base64 decodes to a valid image of that mimeType.
func fb024ImagePart(t *testing.T, part map[string]any, wantMime string) []byte {
	t.Helper()
	if part["type"] != "image" {
		t.Fatalf("fb-024 P1: content[0].type = %v, want image (part = %v)", part["type"], part)
	}
	data, ok := part["data"].(string)
	if !ok || data == "" {
		t.Fatalf("fb-024 P1: content[0].data missing or not a string — %v", part)
	}
	if part["mimeType"] != wantMime {
		t.Errorf("fb-024 P1: content[0].mimeType = %v, want %s", part["mimeType"], wantMime)
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		t.Fatalf("fb-024 P1: content[0].data is not decodable base64: %v", err)
	}
	img, format, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("fb-024 P1: delivered base64 does not decode to an image: %v", err)
	}
	if gotMime := "image/" + format; gotMime != wantMime {
		t.Fatalf("fb-024 P1: delivered bytes decode as %q, want mimeType %q", gotMime, wantMime)
	}
	_ = img
	return raw
}

// ---
// P1 — content[0] is exactly one image part, envelope dropped, metadata in
// content[1], no other parts, no base64 anywhere in text.
// ---

func TestScreenshotImageContent(t *testing.T) {
	raw := fb024SynthPNG(t, 800, 480)
	b64 := base64.StdEncoding.EncodeToString(raw)
	fixtureB64 := base64.StdEncoding.EncodeToString(append([]byte(nil), raw...))

	hub := &MockHub{}
	res, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": fb024DataUrl(raw)})
	if errMap != nil {
		t.Fatalf("fb-024 P1: vlp_screenshot error via tools/call: %v", errMap)
	}
	parts := fb024Content(t, res)
	if len(parts) != 2 {
		t.Fatalf("fb-024 P1: content has %d parts, want exactly 2 (image + metadata) — %v", len(parts), parts)
	}
	fb024ImagePart(t, parts[0], "image/png")
	fb024AssertMetadataPart(t, parts[1], "image/png", 800, 480, len(raw), [2]int{800, 480}, false)
	fb024AssertNoBase64Leaks(t, parts, fixtureB64)
	_ = b64
}

// ---
// P2 — cap 1280 on the max side with JPEG re-encode and rescaled:true;
// sources at or under the cap pass through byte-identical with rescaled:false.
// ---

func TestScreenshotCapAndNoUpscale(t *testing.T) {
	t.Run("rescale branch 1546x888 to 1280", func(t *testing.T) {
		raw := fb024SynthPNG(t, 1546, 888) // native size of the sonda capture
		hub := &MockHub{}
		res, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": fb024DataUrl(raw)})
		if errMap != nil {
			t.Fatalf("fb-024 P2(a): vlp_screenshot error: %v", errMap)
		}
		parts := fb024Content(t, res)
		if len(parts) != 2 {
			t.Fatalf("fb-024 P2(a): content has %d parts, want 2 — %v", len(parts), parts)
		}
		delivered := fb024ImagePart(t, parts[0], "image/jpeg")
		w, h := decodedDims(t, delivered)
		if w != 1280 || h != 735 {
			t.Fatalf("fb-024 P2(a): delivered dims = %dx%d, want 1280x735 (floor of 888*1280/1546)", w, h)
		}
		fb024AssertMetadataPart(t, parts[1], "image/jpeg", 1280, 735, len(delivered), [2]int{1546, 888}, true)
	})

	t.Run("passthrough branch 800x480 byte-identical", func(t *testing.T) {
		raw := fb024SynthPNG(t, 800, 480)
		wantB64 := base64.StdEncoding.EncodeToString(raw)
		hub := &MockHub{}
		res, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": fb024DataUrl(raw)})
		if errMap != nil {
			t.Fatalf("fb-024 P2(b): vlp_screenshot error: %v", errMap)
		}
		parts := fb024Content(t, res)
		if len(parts) != 2 {
			t.Fatalf("fb-024 P2(b): content has %d parts, want 2 — %v", len(parts), parts)
		}
		imgPart := parts[0]
		if imgPart["type"] != "image" {
			t.Fatalf("fb-024 P2(b): content[0].type = %v, want image", imgPart["type"])
		}
		if got, _ := imgPart["data"].(string); got != wantB64 {
			t.Fatalf("fb-024 P2(b): content[0].data is not the byte-identical passthrough of the fixture")
		}
		if imgPart["mimeType"] != "image/png" {
			t.Errorf("fb-024 P2(b): content[0].mimeType = %v, want image/png", imgPart["mimeType"])
		}
		fb024AssertMetadataPart(t, parts[1], "image/png", 800, 480, len(raw), [2]int{800, 480}, false)
	})
}

// ---
// P4 — every unusable capture yields a readable MCP error envelope whose
// message starts "screenshot: invalid capture"; hub errors keep the -32000
// envelope.
// ---

func TestScreenshotReadableErrors(t *testing.T) {
	badBase64 := base64.StdEncoding.EncodeToString([]byte("not an image"))
	cases := []struct {
		name string
		seed map[string]any
	}{
		{"missing dataUrl key", map[string]any{}},
		{"wrong prefix", map[string]any{"dataUrl": "data:image/gif;base64," + badBase64}},
		{"undecodable base64", map[string]any{"dataUrl": "data:image/png;base64,!!!"}},
		{"valid base64 invalid image bytes", map[string]any{"dataUrl": "data:image/png;base64," + badBase64}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := &MockHub{}
			_, errMap := fb024CallScreenshot(t, hub, tc.seed)
			if errMap == nil {
				t.Fatalf("fb-024 P4 (%s): expected a readable MCP error envelope whose message starts %q; got success (the bad capture today travels as the raw dataUrl envelope) — RED of fb-024", tc.name, "screenshot: invalid capture")
			}
			if codeOf(errMap) != -32000 {
				t.Errorf("fb-024 P4 (%s): error code = %v, want -32000", tc.name, errMap["code"])
			}
			if msg, _ := errMap["message"].(string); !strings.HasPrefix(msg, "screenshot: invalid capture") {
				t.Errorf("fb-024 P4 (%s): error message = %q, want prefix %q", tc.name, msg, "screenshot: invalid capture")
			}
		})
	}

	// Hub failure path stays the plain -32000 envelope (green pre-impl).
	t.Run("hub error preserved", func(t *testing.T) {
		hub := &MockHub{}
		hub.errByCommand = map[string]error{"screenshot": &simpleErr{s: "no extension connected"}}
		s := New(hub)
		RegisterAllTools(s, hub, "", odooregistry.New())
		resp, _ := s.HandleRequest(map[string]any{
			"id": 2, "method": "tools/call",
			"params": map[string]any{"name": "vlp_screenshot", "arguments": map[string]any{"tabId": float64(7)}},
		}, "tok1")
		m, ok := resp.(map[string]any)
		if !ok {
			t.Fatalf("fb-024 P4 hub-error: unexpected response %T", resp)
		}
		errMap, has := m["error"].(map[string]any)
		if !has {
			t.Fatalf("fb-024 P4 hub-error: expected error envelope, got %v", m)
		}
		if codeOf(errMap) != -32000 {
			t.Errorf("fb-024 P4 hub-error: code = %v, want -32000", errMap["code"])
		}
		if msg, _ := errMap["message"].(string); msg != "no extension connected" {
			t.Errorf("fb-024 P4 hub-error: message = %q, want the hub's own message", msg)
		}
	})
}

var (
	_ = reflect.DeepEqual // keep reflect import until a strict set-check lands
	_ = jpeg.Encode       // registered decoder check for jpeg paths
)

// ---
// Micro-RED (review round 2, owner-approved): F-2, F-5 and F-7(a) of
// docs/specs/fb-024-screenshot-imagen/review.md §0/§3. Additive only — the
// tests above are the untouched acceptance surface and must keep passing
// post-GREEN.
//
// Colors pinned now (RED run on the committed tree de4310e):
//   - F-2 (TestScreenshotPassthroughFullDecode): RED — the ≤1280 passthrough
//     validates with DecodeConfig (header) only, so a valid-header /
//     corrupt-body PNG travels as a success capture.
//   - F-5 (TestScreenshotMimeBytesMismatch): RED-neutral pin — the committed
//     mime/bytes guard (screenshot_image.go:83-85) already rejects this
//     class; the test exists so the guard cannot regress silently.
//   - F-7(a) (TestScreenshotHugeDimensionsRejected): RED on the huge-dims
//     case (no sanity cap today: the full decode materializes the declared
//     pixels before any check); the 4000×3000 case is a green-neutral
//     boundary pin (test-local threshold expectation: 8192 px max side).
// ---

// fb024TruncatedPNG cuts a valid stdlib PNG right after the start of its
// IDAT chunk (type + 2 payload bytes): signature+IHDR stay intact so
// DecodeConfig still reports the real width/height, but a full image.Decode
// hits the truncated IDAT and fails — the exact F-2 wrong-behavior class
// (valid header, corrupt body).
func fb024TruncatedPNG(t *testing.T, raw []byte) []byte {
	t.Helper()
	idx := bytes.Index(raw, []byte("IDAT"))
	if idx < 8 || idx+4+2 > len(raw) {
		t.Fatalf("fb-024 F-2 fixture: stdlib PNG without a recognizable early IDAT chunk (len=%d, idx=%d)", len(raw), idx)
	}
	return raw[:idx+4+2] // signature + IHDR + IDAT length/type + 2 data bytes
}

func TestScreenshotPassthroughFullDecode(t *testing.T) {
	raw := fb024SynthPNG(t, 64, 48)
	trunc := fb024TruncatedPNG(t, raw)

	// Fixture sanity: the header survives (DecodeConfig reads 64×48) while a
	// full decode fails — only then does the fixture exercise the F-2 gap.
	if w, h := decodedDims(t, trunc); w != 64 || h != 48 {
		t.Fatalf("fb-024 F-2 fixture: DecodeConfig = %dx%d, want 64x48 (header must survive truncation)", w, h)
	}
	if _, _, err := image.Decode(bytes.NewReader(trunc)); err == nil {
		t.Fatalf("fb-024 F-2 fixture: truncated PNG unexpectedly full-decodes; fixture does not exercise the decode gap")
	}

	hub := &MockHub{}
	res, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": fb024DataUrl(trunc)})
	if errMap == nil {
		t.Fatalf("fb-024 F-2 RED: a PNG with a valid header but a corrupt body was delivered as a SUCCESS capture (result=%v) — the ≤1280 passthrough validates with DecodeConfig only; want a readable MCP error envelope whose message starts %q and names the body/decode failure", res, "screenshot: invalid capture")
	}
	if codeOf(errMap) != -32000 {
		t.Errorf("fb-024 F-2: error code = %v, want -32000", errMap["code"])
	}
	msg, _ := errMap["message"].(string)
	if !strings.HasPrefix(msg, "screenshot: invalid capture") {
		t.Errorf("fb-024 F-2: error message = %q, want prefix %q", msg, "screenshot: invalid capture")
	}
	if !strings.Contains(msg, "decode") {
		t.Errorf("fb-024 F-2: error message = %q, want it to name the decode failure of the image body", msg)
	}
}

// TestScreenshotMimeBytesMismatch pins F-5: the dataUrl prefix and the
// decoded image format must agree; a contradictory capture is rejected with
// the readable prefix, never delivered. RED-neutral on the committed tree
// (the guard fires at DecodeConfig level already); it is written so the
// guard cannot regress silently.
func TestScreenshotMimeBytesMismatch(t *testing.T) {
	pngBytes := fb024SynthPNG(t, 32, 24)
	var jbuf bytes.Buffer
	if err := jpeg.Encode(&jbuf, image.NewRGBA(image.Rect(0, 0, 32, 24)), nil); err != nil {
		t.Fatalf("fb-024 F-5 fixture: jpeg.Encode: %v", err)
	}
	cases := []struct {
		name    string
		dataURL string
	}{
		{"prefix declares png, bytes are jpeg", "data:image/png;base64," + base64.StdEncoding.EncodeToString(jbuf.Bytes())},
		{"prefix declares jpeg, bytes are png", "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(pngBytes)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := &MockHub{}
			_, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": tc.dataURL})
			if errMap == nil {
				t.Fatalf("fb-024 F-5 (%s): a capture whose declared mime contradicts its magic bytes was delivered as a SUCCESS capture; want a readable MCP error envelope whose message starts %q and names the mime/format mismatch", tc.name, "screenshot: invalid capture")
			}
			if codeOf(errMap) != -32000 {
				t.Errorf("fb-024 F-5 (%s): error code = %v, want -32000", tc.name, errMap["code"])
			}
			msg, _ := errMap["message"].(string)
			if !strings.HasPrefix(msg, "screenshot: invalid capture") {
				t.Errorf("fb-024 F-5 (%s): error message = %q, want prefix %q", tc.name, msg, "screenshot: invalid capture")
			}
			if !strings.Contains(msg, "image/png") || !strings.Contains(msg, "image/jpeg") {
				t.Errorf("fb-024 F-5 (%s): error message = %q, want it to name both the declared and the decoded mime", tc.name, msg)
			}
		})
	}
}

// fb024CraftedGrayPNG builds a minimal valid grayscale PNG (color type 0,
// bit depth 8, non-interlaced, filter 0) declaring w×h with a solid fill.
// The scanlines compress to a few KB, so the fixture never materializes the
// declared pixels in the test process — only the header declares the bomb.
// Stdlib's encoder cannot emit a lying header, so the chunk framing
// (length/type/CRC + zlib scanlines) is crafted here with binary/crc32/zlib.
func fb024CraftedGrayPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1A, '\n'})
	chunk := func(typ string, data []byte) {
		var hdr [4]byte
		binary.BigEndian.PutUint32(hdr[:], uint32(len(data)))
		buf.Write(hdr[:])
		buf.WriteString(typ)
		buf.Write(data)
		var sum [4]byte
		binary.BigEndian.PutUint32(sum[:], crc32.ChecksumIEEE(append([]byte(typ), data...)))
		buf.Write(sum[:])
	}
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], uint32(w))
	binary.BigEndian.PutUint32(ihdr[4:8], uint32(h))
	ihdr[8] = 8 // bit depth 8
	ihdr[9] = 0 // color type 0: grayscale — 1 byte/px keeps a full decode affordable if one ever happens
	chunk("IHDR", ihdr)

	var idat bytes.Buffer
	zw := zlib.NewWriter(&idat)
	row := make([]byte, 1+w) // filter byte 0 + w gray samples
	for y := 0; y < h; y++ {
		zw.Write(row)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("fb-024 F-7 fixture: zlib close: %v", err)
	}
	chunk("IDAT", idat.Bytes())
	chunk("IEND", nil)
	return buf.Bytes()
}

// TestScreenshotHugeDimensionsRejected pins F-7(a): after DecodeConfig, the
// handler must sanity-cap the declared dimensions BEFORE any full decode —
// a capture declaring enormous dims is a decompression-bomb surface and
// must fail with the readable prefix instead of materializing. Test-local
// threshold expectation: the cap sits far above any real capture (RED uses
// 20000×20000, beyond any sane cap); the green case (4000×3000) pins that
// the cap does not swallow legitimate over-1280 captures. If the GREEN
// implementation documents a different named constant, the boundary cases
// here (20000 reject / 4000 accept) must still both hold — i.e. the
// constant lies in (4000, 20000) and is named in the code.
func TestScreenshotHugeDimensionsRejected(t *testing.T) {
	t.Run("declared 20000x20000 rejected before decode", func(t *testing.T) {
		raw := fb024CraftedGrayPNG(t, 20000, 20000)
		if w, h := decodedDims(t, raw); w != 20000 || h != 20000 {
			t.Fatalf("fb-024 F-7 fixture: DecodeConfig = %dx%d, want 20000x20000", w, h)
		}
		hub := &MockHub{}
		res, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": fb024DataUrl(raw)})
		if errMap == nil {
			t.Fatalf("fb-024 F-7(a) RED: a capture declaring 20000x20000 px was delivered as a SUCCESS capture (result=%v) — no dimension sanity cap today: the full decode materializes the declared pixels; want a readable MCP error envelope whose message starts %q and names the dimension cap", res, "screenshot: invalid capture")
		}
		if codeOf(errMap) != -32000 {
			t.Errorf("fb-024 F-7(a): error code = %v, want -32000", errMap["code"])
		}
		msg, _ := errMap["message"].(string)
		if !strings.HasPrefix(msg, "screenshot: invalid capture") {
			t.Errorf("fb-024 F-7(a): error message = %q, want prefix %q", msg, "screenshot: invalid capture")
		}
		if !strings.Contains(msg, "20000") {
			t.Errorf("fb-024 F-7(a): error message = %q, want it to name the rejected dimensions", msg)
		}
	})

	t.Run("4000x3000 still delivered (over 1280 cap, under sanity threshold)", func(t *testing.T) {
		raw := fb024CraftedGrayPNG(t, 4000, 3000)
		hub := &MockHub{}
		res, errMap := fb024CallScreenshot(t, hub, map[string]any{"dataUrl": fb024DataUrl(raw)})
		if errMap != nil {
			t.Fatalf("fb-024 F-7 sanity: a 4000x3000 capture (over the 1280 rescale cap, under the 8192 test-local threshold) was rejected: %v — the sanity cap must not swallow legitimate over-1280 captures", errMap)
		}
		parts := fb024Content(t, res)
		if len(parts) != 2 {
			t.Fatalf("fb-024 F-7 sanity: content has %d parts, want 2 — %v", len(parts), parts)
		}
		delivered := fb024ImagePart(t, parts[0], "image/jpeg")
		if w, h := decodedDims(t, delivered); w != 1280 || h != 960 {
			t.Errorf("fb-024 F-7 sanity: delivered dims = %dx%d, want 1280x960 (floor of 3000*1280/4000)", w, h)
		}
	})
}
