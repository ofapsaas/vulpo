package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// config is the complete proxy configuration, resolved from the environment
// once at startup (spec §3.2). The 001 fields are unchanged; the recovery
// fields are added by fb-025-002 (spec §3.2).
type config struct {
	bind             string
	port             string
	url              string
	tokenFile        string
	tabPrefix        string
	evalTab          string
	logFile          string
	evalTimeout      time.Duration
	allowNonLoopback bool

	// fb-025-002 resilience knobs (spec §3.2).
	recoverOnAmbiguous bool
	recoverAllowFocus  bool
	// fb-025-003 route guard knob (spec §3.2/D-3): opt-in recovery on non-read
	// routes. Default false (safe): a generic candidate on a non-read route is
	// never re-emitted.
	recoverOnWrite       bool
	recoverReadyDeadline time.Duration
	recoverReadyPoll     time.Duration
	transportMaxBytes    int64
	resolveRetries       int
	resolveBackoff       time.Duration
	readyzTimeout        time.Duration
}

// loadConfig reads the env schema of spec §3.2 with its documented defaults.
func loadConfig() (config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return config{}, fmt.Errorf("cannot resolve home directory: %w", err)
	}
	timeout, err := evalTimeout()
	if err != nil {
		return config{}, err
	}
	recoverDeadline, err := envMillis("VLP_RECOVER_READY_DEADLINE_MS", 10000)
	if err != nil {
		return config{}, err
	}
	// The ready deadline lives inside the eval budget (spec §3.2). Clamp rather
	// than refuse so the 001 env (which never sets this var) keeps starting.
	if recoverDeadline > timeout {
		recoverDeadline = timeout
	}
	recoverPoll, err := envMillis("VLP_RECOVER_READY_POLL_MS", 250)
	if err != nil {
		return config{}, err
	}
	transportMax, err := envInt64("VLP_TRANSPORT_MAX_BYTES", 2097152)
	if err != nil {
		return config{}, err
	}
	resolveRetries, err := envInt("VLP_RESOLVE_RETRIES", 5)
	if err != nil {
		return config{}, err
	}
	resolveBackoff, err := envMillis("VLP_RESOLVE_BACKOFF_MS", 200)
	if err != nil {
		return config{}, err
	}
	readyzTimeout, err := envMillis("VLP_READYZ_TIMEOUT_MS", 2000)
	if err != nil {
		return config{}, err
	}
	recoverOnAmbiguous, err := envFlag("VLP_RECOVER_ON_AMBIGUOUS", true)
	if err != nil {
		return config{}, err
	}
	recoverAllowFocus, err := envFlag("VLP_RECOVER_ALLOW_FOCUS", false)
	if err != nil {
		return config{}, err
	}
	recoverOnWrite, err := envFlag("VLP_RECOVER_ON_WRITE", false)
	if err != nil {
		return config{}, err
	}
	return config{
		bind:             envOr("VLP_PROXY_BIND", "127.0.0.1"),
		port:             envOr("VLP_PROXY_PORT", "8899"),
		url:              envOr("VLP_URL", "http://127.0.0.1:8765/mcp"),
		tokenFile:        envOr("VLP_TOKEN_FILE", filepath.Join(home, ".config", "vulpo", "token")),
		tabPrefix:        envOr("VLP_TAB_URL_PREFIX", "https://www.odoo.sh"),
		evalTab:          os.Getenv("VLP_EVAL_TAB"),
		logFile:          os.Getenv("VLP_PROXY_LOG"),
		evalTimeout:      timeout,
		allowNonLoopback: os.Getenv("VLP_PROXY_ALLOW_NON_LOOPBACK") == "1",

		recoverOnAmbiguous:   recoverOnAmbiguous,
		recoverAllowFocus:    recoverAllowFocus,
		recoverOnWrite:       recoverOnWrite,
		recoverReadyDeadline: recoverDeadline,
		recoverReadyPoll:     recoverPoll,
		transportMaxBytes:    transportMax,
		resolveRetries:       resolveRetries,
		resolveBackoff:       resolveBackoff,
		readyzTimeout:        readyzTimeout,
	}, nil
}

// evalTimeout is VLP_EVAL_TIMEOUT in seconds; it must stay below odoosh-mcp's
// 60s default and above Vulpo's 45s idle budget (spec §3.2).
func evalTimeout() (time.Duration, error) {
	raw := os.Getenv("VLP_EVAL_TIMEOUT")
	if raw == "" {
		return 50 * time.Second, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return 0, fmt.Errorf("VLP_EVAL_TIMEOUT must be a positive number of seconds: %q", raw)
	}
	return time.Duration(seconds) * time.Second, nil
}

// isLoopback reports whether bind is a loopback address or localhost.
func isLoopback(bind string) bool {
	if bind == "localhost" {
		return true
	}
	ip := net.ParseIP(bind)
	return ip != nil && ip.IsLoopback()
}

// readToken returns the trimmed token from path after enforcing the same
// contract as vlpmcp (spec D-3): readable, mode 0600, one printable line.
func readToken(path string) (string, error) {
	if reason := tokenProblem(path); reason != "" {
		return "", fmt.Errorf("token file %s: %s", path, reason)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read token file %s: %w", path, err)
	}
	return strings.Trim(string(data), " \t\r\n\v\f"), nil
}

// tokenProblem names why the token file is unusable, or "" when it is valid.
// It never echoes the token. /healthz re-checks it on every request (§3.4).
func tokenProblem(path string) string {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "token file not found"
	}
	if err != nil {
		return "token file not readable"
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "token file mode is not 0600"
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "token file not readable"
	}
	token := strings.Trim(string(data), " \t\r\n\v\f")
	if token == "" {
		return "token file is empty"
	}
	if strings.Contains(token, "\n") {
		return "token file has multiple lines"
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x21 || token[i] > 0x7E {
			return "token file has invalid characters"
		}
	}
	return ""
}

// envOr returns the value of key, or def when it is unset or empty.
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// envInt parses a positive integer env var; unset -> def (spec §3.2, fail loud
// on a non-numeric or non-positive value).
func envInt(key string, def int) (int, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer: %q", key, raw)
	}
	return n, nil
}

// envInt64 is envInt for a 64-bit value (VLP_TRANSPORT_MAX_BYTES).
func envInt64(key string, def int64) (int64, error) {
	raw := os.Getenv(key)
	if raw == "" {
		return def, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer: %q", key, raw)
	}
	return n, nil
}

// envMillis parses a positive number of milliseconds into a Duration.
func envMillis(key string, def int) (time.Duration, error) {
	ms, err := envInt(key, def)
	if err != nil {
		return 0, err
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// envFlag parses a "0"/"1" env var; unset -> def.
func envFlag(key string, def bool) (bool, error) {
	switch raw := os.Getenv(key); raw {
	case "":
		return def, nil
	case "1":
		return true, nil
	case "0":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be 0 or 1: %q", key, raw)
	}
}
