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

// screenshotMaxSide: the normative cap on the larger of width/height (P2/Q-A).
// Single-point revision via a second probe pass; no environment knob this cycle.
const screenshotMaxSide = 1280

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
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil {
		return imageContentResult{}, fmt.Errorf("%s: bytes are not a decodable %s image: %v", screenshotErrPrefix, mimeType, err)
	}
	if got := "image/" + format; got != mimeType {
		return imageContentResult{}, fmt.Errorf("%s: dataUrl declares %s but the bytes decode as %s", screenshotErrPrefix, mimeType, got)
	}

	srcW, srcH := cfg.Width, cfg.Height
	maxSide := max(srcW, srcH)
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
		src, decodedFormat, err := image.Decode(bytes.NewReader(raw))
		if err != nil {
			return imageContentResult{}, fmt.Errorf("%s: bytes are not a decodable %s image: %v", screenshotErrPrefix, mimeType, err)
		}
		// Fail fast at the point of transformation: the delivered bytes must
		// still match the dataUrl-declared mime (same guard as DecodeConfig
		// above; the full decode re-derives the format from the magic bytes).
		if got := "image/" + decodedFormat; got != mimeType {
			return imageContentResult{}, fmt.Errorf("%s: dataUrl declares %s but the bytes decode as %s", screenshotErrPrefix, mimeType, got)
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
