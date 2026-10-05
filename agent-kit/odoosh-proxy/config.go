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
// once at startup (spec §3.2).
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
