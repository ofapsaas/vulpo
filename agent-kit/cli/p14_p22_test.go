package main_test

// fb-020-006 (docs/specs/fb-020-006-orm-diagnostics-client-health/spec.md)
// §2.5 token file, §2.6 kit revision — postconditions P14–P18, P20–P22.
//
// Expected interface for the kit revision: a package-level string variable
// main.kitRevision, injected with `go build -ldflags "-X main.kitRevision=<sha>"`.
// A build without it is an unknown ("dev") kit revision.

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const spec006 = "fb-020-006"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

var (
	kitBinMu   sync.Mutex
	kitBinDir  string
	kitBinByRv = map[string]string{}
)

// kitBinary builds vlpmcp with -X main.kitRevision=rev (cached per revision).
func kitBinary(t *testing.T, rev string) string {
	t.Helper()
	requireBinary(t)
	kitBinMu.Lock()
	defer kitBinMu.Unlock()
	if bin, ok := kitBinByRv[rev]; ok {
		return bin
	}
	if kitBinDir == "" {
		dir, err := os.MkdirTemp(filepath.Dir(vlpmcpBin), "kitrev-")
		if err != nil {
			t.Fatalf("%s %s: mkdir: %v", spec006, t.Name(), err)
		}
		kitBinDir = dir
	}
	bin := filepath.Join(kitBinDir, "vlpmcp-"+rev)
	if err := goBuild(bin, "-ldflags", "-X main.kitRevision="+rev); err != nil {
		t.Fatalf("%s %s: go build -ldflags '-X main.kitRevision=%s': %v", spec006, t.Name(), rev, err)
	}
	kitBinByRv[rev] = bin
	return bin
}

const randAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// randChunk returns n random characters (P16: never a real token).
func randChunk(t *testing.T, n int) string {
	t.Helper()
	var b strings.Builder
	max := big.NewInt(int64(len(randAlphabet)))
	for i := 0; i < n; i++ {
		k, err := rand.Int(rand.Reader, max)
		if err != nil {
			t.Fatalf("rand: %v", err)
		}
		b.WriteByte(randAlphabet[k.Int64()])
	}
	return b.String()
}

type badTokenCase struct {
	name    string
	content string
	reason  string // §2.5: empty | multiple lines | invalid characters
	// leakCheck: P16 scan is meaningful (empty/whitespace-only files have no
	// token characters to leak, so the scan is vacuous by construction).
	leakCheck bool
}

func badTokenCases(t *testing.T) []badTokenCase {
	t.Helper()
	r := func() string { return randChunk(t, 16) }
	return []badTokenCase{
		{name: "two lines", content: r() + "\n" + r() + "\n", reason: "multiple lines", leakCheck: true},
		{name: "empty", content: "", reason: "empty"},
		{name: "whitespace only", content: "  \t\r\n \n", reason: "empty"},
		{name: "control byte", content: r() + "\x01" + r() + "\n", reason: "invalid characters", leakCheck: true},
		{name: "internal space", content: r() + " " + r() + "\n", reason: "invalid characters", leakCheck: true},
		{name: "non-ascii", content: r() + "é" + r() + "\n", reason: "invalid characters", leakCheck: true},
	}
}

// expectNoLeak (P16): no substring of content of length >= 4 appears in the
// outputs. Checking every length-4 window is sufficient.
func expectNoLeak(t *testing.T, content string, outputs map[string]string) {
	t.Helper()
	for label, out := range outputs {
		for i := 0; i+4 <= len(content); i++ {
			w := content[i : i+4]
			if strings.Contains(out, w) {
				// Do not print the window or the output: they may carry token bytes.
				t.Errorf("%s %s: P16: %s contains a 4-byte substring of the token file (offset %d)", spec006, t.Name(), label, i)
				break
			}
		}
	}
}

func lineIndex(out, line string) int {
	for i, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) == line {
			return i
		}
	}
	return -1
}

func kitLines(out string) []string {
	var got []string
	for _, l := range strings.Split(out, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), "kit:") {
			got = append(got, l)
		}
	}
	return got
}

func notConnected(f *fakeMCP) {
	f.callResult = func(string, json.RawMessage) (string, *rpcError) {
		return "", &rpcError{Code: -32000, Message: noExtensionMsg}
	}
}

// ---------------------------------------------------------------------------
// P14. Trailing/leading whitespace (incl. \n, \r\n) is trimmed
// ---------------------------------------------------------------------------

func TestP14_TokenFileTrimmedCallExit0(t *testing.T) {
	const tok = "fbtok-P14-" + "trim-3c9e1a"
	for name, content := range map[string]string{
		"lf":            tok + "\n",
		"crlf":          tok + "\r\n",
		"spaces and lf": "  " + tok + "  \n",
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeMCP(t)
			f.set(func(f *fakeMCP) { f.token = tok })
			env := newEnv(t, f.URL())
			writeFileMode(t, env.TokenFile, content, 0o600)

			res := runVlpmcp(t, env, "", "call", "vlp_listTabs")
			expectExit(t, res, 0)
			reqs := f.requests()
			if len(reqs) == 0 {
				t.Errorf("%s %s: P14: server received no request", spec006, t.Name())
			}
			for i, r := range reqs {
				if r.Token != tok {
					t.Errorf("%s %s: P14: request %d (%s) x-vlp-token is not the trimmed token", spec006, t.Name(), i, r.Method)
				}
			}
		})
	}
}

// ---------------------------------------------------------------------------
// P15 + P16. Invalid token file: exit 3, no HTTP, message, no leak
// ---------------------------------------------------------------------------

func TestP15_P16_InvalidTokenFileExit3NoRequests(t *testing.T) {
	commands := []struct {
		name  string
		stdin string
		args  []string
	}{
		{name: "call", args: []string{"call", "vlp_listTabs"}},
		{name: "tools", args: []string{"tools"}},
		{name: "ping", args: []string{"ping"}},
		{name: "mcp-stdio", stdin: stdioHandshake, args: []string{"mcp-stdio"}},
	}
	for _, tc := range badTokenCases(t) {
		for _, cmd := range commands {
			t.Run(tc.name+"/"+cmd.name, func(t *testing.T) {
				f := newFakeMCP(t)
				env := newEnv(t, f.URL())
				writeFileMode(t, env.TokenFile, tc.content, 0o600)

				res := runVlpmcp(t, env, cmd.stdin, cmd.args...)
				// Outputs are not printed on failure (P16): report exit only.
				if res.Exit != 3 {
					t.Errorf("%s %s: P15: vlpmcp %q exit = %d, want 3", spec006, t.Name(), cmd.args, res.Exit)
				}
				want := "token file invalid: " + env.TokenFile + ": " + tc.reason
				if !strings.Contains(res.Stderr, want) {
					t.Errorf("%s %s: P15: stderr does not contain %q", spec006, t.Name(), want)
				}
				if n := len(f.requests()); n != 0 {
					t.Errorf("%s %s: P15: server received %d requests, want 0 (%v)", spec006, t.Name(), n, methodsOf(f.requests()))
				}
				if tc.leakCheck {
					expectNoLeak(t, tc.content, map[string]string{
						"stdout":        res.Stdout,
						"stderr":        res.Stderr,
						"VLP_LOG": readFileOrEmpty(env.LogFile),
					})
				}
			})
		}
	}
}

// ---------------------------------------------------------------------------
// P17 + P18. doctor with a malformed token file
// ---------------------------------------------------------------------------

func TestP17_DoctorInvalidTokenServerOkExit3(t *testing.T) {
	for _, tc := range badTokenCases(t) {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeMCP(t)
			env := newEnv(t, f.URL())
			writeFileMode(t, env.TokenFile, tc.content, 0o600)

			res := runVlpmcp(t, env, "", "doctor")
			if res.Exit != 3 {
				t.Errorf("%s %s: P17: doctor exit = %d, want 3", spec006, t.Name(), res.Exit)
			}
			iServer := lineIndex(res.Stdout, "server: ok")
			iToken := lineIndex(res.Stdout, "token: invalid file")
			if iServer < 0 || iToken < 0 || iServer > iToken {
				t.Errorf("%s %s: P17: stdout must have line \"server: ok\" followed by \"token: invalid file\" (indexes %d, %d)", spec006, t.Name(), iServer, iToken)
			}
			reqs := f.requests()
			if len(reqs) == 0 {
				t.Errorf("%s %s: P17: doctor did not probe the server (0 requests)", spec006, t.Name())
			}
			for i, r := range reqs {
				if r.Token != "" {
					t.Errorf("%s %s: P17: request %d (%s) carried x-vlp-token", spec006, t.Name(), i, r.Method)
				}
			}
			if tc.leakCheck {
				expectNoLeak(t, tc.content, map[string]string{
					"stdout":        res.Stdout,
					"stderr":        res.Stderr,
					"VLP_LOG": readFileOrEmpty(env.LogFile),
				})
			}
		})
	}
}

func TestP18_DoctorInvalidTokenServerUnreachableExit8(t *testing.T) {
	for _, tc := range badTokenCases(t) {
		t.Run(tc.name, func(t *testing.T) {
			env := newEnv(t, unreachableURL(t))
			writeFileMode(t, env.TokenFile, tc.content, 0o600)

			res := runVlpmcp(t, env, "", "doctor")
			if res.Exit != 8 {
				t.Errorf("%s %s: P18: doctor exit = %d, want 8", spec006, t.Name(), res.Exit)
			}
			if lineIndex(res.Stdout, "server: unreachable") < 0 {
				t.Errorf("%s %s: P18: stdout has no line \"server: unreachable\"", spec006, t.Name())
			}
		})
	}
}

// ---------------------------------------------------------------------------
// P20 + P21. doctor kit revision warning
// ---------------------------------------------------------------------------

func TestP20_DoctorKitOutdatedWarning(t *testing.T) {
	const r1, r2 = "1a2b3c4", "9f8e7d6"
	bin := kitBinary(t, r1)
	cases := []struct {
		name     string
		setup    func(f *fakeMCP)
		wantExit int
	}{
		{name: "happy path", wantExit: 0},
		{name: "extension not connected", setup: notConnected, wantExit: 9},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeMCP(t)
			f.set(func(f *fakeMCP) {
				f.kitRevision = r2
				if tc.setup != nil {
					tc.setup(f)
				}
			})
			env := newEnv(t, f.URL())

			res := runBinary(t, bin, env, "", "doctor")
			expectExit(t, res, tc.wantExit)
			lines := kitLines(res.Stdout)
			if len(lines) != 1 {
				t.Fatalf("%s %s: P20: got %d \"kit:\" lines, want 1\nstdout: %q", spec006, t.Name(), len(lines), res.Stdout)
			}
			for _, want := range []string{"kit: outdated", r1, r2, "install.sh"} {
				expectContains(t, "kit line", lines[0], want)
			}
		})
	}
}

func TestP21_DoctorNoKitLine(t *testing.T) {
	const r1 = "1a2b3c4"
	cases := []struct {
		name      string
		bin       func(t *testing.T) string
		serverRev string
		setup     func(f *fakeMCP)
		wantExit  int
	}{
		{name: "server without key", bin: func(t *testing.T) string { return kitBinary(t, r1) }, wantExit: 0},
		{name: "kit dev (default build)", bin: requireBinary, serverRev: r1, wantExit: 0},
		{name: "kit dev (explicit)", bin: func(t *testing.T) string { return kitBinary(t, "dev") }, serverRev: r1, wantExit: 0},
		{name: "equal revisions", bin: func(t *testing.T) string { return kitBinary(t, r1) }, serverRev: r1, wantExit: 0},
		{name: "equal revisions not connected", bin: func(t *testing.T) string { return kitBinary(t, r1) }, serverRev: r1, setup: notConnected, wantExit: 9},
		{name: "server without key not connected", bin: func(t *testing.T) string { return kitBinary(t, r1) }, setup: notConnected, wantExit: 9},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			bin := tc.bin(t)
			f := newFakeMCP(t)
			f.set(func(f *fakeMCP) {
				f.kitRevision = tc.serverRev
				if tc.setup != nil {
					tc.setup(f)
				}
			})
			env := newEnv(t, f.URL())

			res := runBinary(t, bin, env, "", "doctor")
			expectExit(t, res, tc.wantExit)
			if lines := kitLines(res.Stdout); len(lines) != 0 {
				t.Errorf("%s %s: P21: unexpected \"kit:\" lines %q", spec006, t.Name(), lines)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// P22. version stays offline, one line
// ---------------------------------------------------------------------------

func TestP22_VersionOfflineOneLine(t *testing.T) {
	for name, bin := range map[string]func(t *testing.T) string{
		"default build": requireBinary,
		"kit revision":  func(t *testing.T) string { return kitBinary(t, "1a2b3c4") },
	} {
		t.Run(name, func(t *testing.T) {
			b := bin(t)
			f := newFakeMCP(t)
			f.set(func(f *fakeMCP) { f.kitRevision = "9f8e7d6" })
			env := newEnv(t, f.URL())
			if err := os.Remove(env.TokenFile); err != nil {
				t.Fatalf("remove token file: %v", err)
			}

			res := runBinary(t, b, env, "", "version")
			expectExit(t, res, 0)
			if lines := nonEmptyLines(res.Stdout); len(lines) != 1 {
				t.Errorf("%s %s: P22: version printed %d lines, want 1\nstdout: %q", spec006, t.Name(), len(lines), res.Stdout)
			}
			if n := len(f.requests()); n != 0 {
				t.Errorf("%s %s: P22: server received %d requests, want 0", spec006, t.Name(), n)
			}
		})
	}
}
