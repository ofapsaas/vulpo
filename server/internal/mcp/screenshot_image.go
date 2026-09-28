// fb-024-screenshot-imagen — vlp_screenshot image-part mechanism.
//
// Converts the hub screenshot answer (the {"dataUrl":"data:image/...;base64,..."}
// envelope the extension produces; P1) into the contract wire shape:
// content[0] = one MCP image part, content[1] = a one-line screenshot
// metadata JSON text part, base64 never duplicated in any text part.
// Normative decisions applied here (spec §3.2): cap 1280 px max side (Q-A),
// JPEG q85 when rescaling (Q-B), CatmullRom filter (Q-C), byte-passthrough
// when at or under the cap (Q-D), readable error "screenshot: invalid
// capture ..." on unusable captures (P4/Q-F). The recover in mcp.go is a
// backstop, not the contract.
//
// Review round 2 hardening (docs/specs/fb-024-screenshot-imagen/review.md
// §0/§3, owner-approved micro-RED 7c9dac3): F-7(a) dimension sanity cap
// enforced after DecodeConfig and before any full decode or delivery
// decision; F-2 full image.Decode on EVERY path (the ≤1280 passthrough
// included) so a valid-header/corrupt-body capture fails server-side with
// the readable error; F-5 mime/bytes consistency guard kept intact and
// applied to the unconditional decode.

package mcp

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"image"
	"image/jpeg"
	_ "image/png" // registered PNG decoder — the hub capture format
	"strings"

	"golang.org/x/image/draw"
)

// screenshotMaxSide: the normative delivery cap on the larger of width/height
// (P2/Q-A). Single-point revision via a second probe pass; no environment
// knob this cycle.
const screenshotMaxSide = 1280

// screenshotSanityMaxSide: F-7(a) dimension sanity cap on the larger of the
// declared width/height, enforced right after DecodeConfig and BEFORE any
// full decode or delivery decision — a crafted header can declare enormous
// dimensions and a full decode would materialize those pixels
// (decompression-bomb surface). Value pinned by review as 8192 px max side:
// far above real captures and above the 1280 delivery cap (the 4000×3000
// boundary pin must still deliver), far below the 20000×20000 rejection pin.
const screenshotSanityMaxSide = 8192

// screenshotJPEGQuality: re-encode quality when rescaling (Q-B; legible at
// q85 per the 2026-09-26 legibility probe).
const screenshotJPEGQuality = 85

// screenshotErrPrefix: readable error prefix for every unusable capture (P4/Q-F).
const screenshotErrPrefix = "screenshot: invalid capture"

// imageContentResult: handler result recognized by callTool to emit a real
// MCP image part (content[0]) plus a metadata text part (content[1]),
// image-first like multiContentResult's primary-first convention. Returned
// only by the vlp_screenshot handler (I-3); the base64 payload travels only
// in dataBase64 and is never embedded in the metadata text.
type imageContentResult struct {
	dataBase64 string
	mimeType   string
	metadata   string // single-line JSON, no base64
}

// screenshotImageParts converts a hub screenshot answer into the
// image + metadata content pair, rescaling over-cap captures and passing
// bytes through unchanged otherwise. Unusable captures fail with the
// readable P4 error instead of traveling as a text envelope. Results that
// are not an envelope object (nil included) fall back to the legacy
// passthrough — the wire shape pinned by the pre-existing TestCommandWire.
func screenshotImageParts(hubRes any) (any, error) {
	envelope, ok := hubRes.(map[string]any)
	if !ok {
		return hubRes, nil
	}
	dataURL, _ := envelope["dataUrl"].(string)
	if dataURL == "" {
		return imageContentResult{}, fmt.Errorf("%s: dataUrl missing", screenshotErrPrefix)
	}
	const pngPrefix = "data:image/png;base64,"
	const jpegPrefix = "data:image/jpeg;base64,"
	var mimeType, payload string
	switch {
	case strings.HasPrefix(dataURL, pngPrefix):
		mimeType, payload = "image/png", strings.TrimPrefix(dataURL, pngPrefix)
	case strings.HasPrefix(dataURL, jpegPrefix):
		mimeType, payload = "image/jpeg", strings.TrimPrefix(dataURL, jpegPrefix)
	default:
		return imageContentResult{}, fmt.Errorf("%s: dataUrl prefix is not %s or %s", screenshotErrPrefix, pngPrefix, jpegPrefix)
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		return imageContentResult{}, fmt.Errorf("%s: base64 decode failed: %v", screenshotErrPrefix, err)
	}
	// Header-level validation first: dims without materializing pixels.
	cfg, _, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return imageContentResult{}, fmt.Errorf("%s: bytes are not a decodable %s image: %v", screenshotErrPrefix, mimeType, err)
	}
	srcW, srcH := cfg.Width, cfg.Height
	maxSide := max(srcW, srcH)

	// F-7(a): dimension sanity cap BEFORE any full decode or delivery
	// decision — a declared bomb fails here, never materializing pixels.
	if maxSide > screenshotSanityMaxSide {
		return imageContentResult{}, fmt.Errorf("%s: declared dimensions %dx%d exceed the %d px sanity cap", screenshotErrPrefix, srcW, srcH, screenshotSanityMaxSide)
	}

	// F-2: full decode on EVERY path after the sanity cap — the ≤1280
	// passthrough included — so a valid-header/corrupt-body capture fails
	// server-side with the readable error instead of being delivered.
	src, decodedFormat, err := image.Decode(bytes.NewReader(raw))
	if err != nil {
		return imageContentResult{}, fmt.Errorf("%s: %s image decode failed: %v", screenshotErrPrefix, mimeType, err)
	}
	// F-5: the dataUrl prefix and the decoded magic bytes must agree; a
	// contradictory capture is rejected, never delivered (guard applied to
	// the unconditional decode, so no path can bypass it).
	if got := "image/" + decodedFormat; got != mimeType {
		return imageContentResult{}, fmt.Errorf("%s: dataUrl declares %s but the bytes decode as %s", screenshotErrPrefix, mimeType, got)
	}

	out, dstW, dstH, dstMime, rescaled := raw, srcW, srcH, mimeType, false
	if maxSide > screenshotMaxSide {
		// Q-A/Q-C: cap the max side, preserve aspect, integer-floor dims.
		dstW = srcW * screenshotMaxSide / maxSide
		dstH = srcH * screenshotMaxSide / maxSide
		if dstW < 1 {
			dstW = 1
		}
		if dstH < 1 {
			dstH = 1
		}
		dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
		draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: screenshotJPEGQuality}); err != nil {
			return imageContentResult{}, fmt.Errorf("screenshot: re-encode failed: %v", err)
		}
		out, dstMime, rescaled = buf.Bytes(), "image/jpeg", true
	}

	metadata, err := marshalNoEscape(map[string]any{
		"screenshot": map[string]any{
			"mimeType": dstMime,
			"width":    dstW,
			"height":   dstH,
			"bytes":    len(out),
			"source":   []int{srcW, srcH},
			"rescaled": rescaled,
		},
	})
	if err != nil {
		return imageContentResult{}, fmt.Errorf("screenshot: metadata encode failed: %v", err)
	}
	return imageContentResult{
		dataBase64: base64.StdEncoding.EncodeToString(out),
		mimeType:   dstMime,
		metadata:   string(metadata),
	}, nil
}
