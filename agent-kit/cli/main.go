// Command vlpmcp is the Vulpo MCP client for agents (fb-021-mvp spec §3).
//
// It reads the token from a 0600 file, keeps an MCP session on disk, retries
// once on a lost session and never emits the token.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var version = "dev"

// kitRevision is the short sha of the last commit touching agent-kit/,
// injected at build time with -X main.kitRevision (fb-020-006 §2.6).
var kitRevision = "dev"

// Exit codes (spec C7; 9 is doctor's "extension not connected").
const (
	exitOK           = 0
	exitUsage        = 2
	exitTokenConfig  = 3
	exitHTTP         = 4
	exitRPC          = 5
	exitInvalidToken = 7
	exitNetwork      = 8
	exitNoExtension  = 9
)

const usageText = `usage:
  vlpmcp tools [--json | --schema <tool>]
  vlpmcp call [--raw] <tool> [json|-]
  vlpmcp ping
  vlpmcp doctor
  vlpmcp mcp-stdio
  vlpmcp version
`

// exitError carries the process exit code and the message for stderr.
type exitError struct {
	code  int
	msg   string
	cause error
}

func (e *exitError) Error() string { return e.msg }

func (e *exitError) Unwrap() error { return e.cause }

// errInvalidTokenFile marks a token file whose content is malformed (§2.5).
var errInvalidTokenFile = errors.New("token file invalid")

func fail(code int, format string, args ...any) *exitError {
	return &exitError{code: code, msg: fmt.Sprintf(format, args...)}
}

// exitCodeOf maps any error to its exit code; nil is success.
func exitCodeOf(err error) int {
	if err == nil {
		return exitOK
	}
	var ee *exitError
	if errors.As(err, &ee) {
		return ee.code
	}
	return exitHTTP
}

type config struct {
	url         string
	tokenFile   string
	sessionFile string
	logFile     string
	timeout     time.Duration
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usageText)
		return exitUsage
	}
	cmd, rest := args[0], args[1:]
	if cmd == "version" {
		if len(rest) != 0 {
			return usageError(stderr, "version takes no arguments")
		}
		printLine(stdout, version)
		return exitOK
	}
	runner, err := parseCommand(cmd, rest)
	if err != nil {
		return usageError(stderr, err.Error())
	}
	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return exitCodeOf(err)
	}
	return runner(cfg, stdin, stdout, stderr)
}

type commandRunner func(cfg config, stdin io.Reader, stdout, stderr io.Writer) int

func parseCommand(cmd string, args []string) (commandRunner, error) {
	switch cmd {
	case "tools":
		return parseTools(args)
	case "call":
		return parseCall(args)
	case "ping":
		return noArgs(cmd, args, runPing)
	case "doctor":
		return noArgs(cmd, args, runDoctor)
	case "mcp-stdio":
		return noArgs(cmd, args, runStdio)
	}
	return nil, fmt.Errorf("unknown subcommand %q", cmd)
}

func noArgs(cmd string, args []string, runner commandRunner) (commandRunner, error) {
	if len(args) != 0 {
		return nil, fmt.Errorf("%s takes no arguments", cmd)
	}
	return runner, nil
}

func usageError(stderr io.Writer, msg string) int {
	fmt.Fprintf(stderr, "vlpmcp: %s\n%s", msg, usageText)
	return exitUsage
}

// printLine writes text followed by a single newline unless it already ends with one (A1).
func printLine(w io.Writer, text string) {
	if strings.HasSuffix(text, "\n") {
		fmt.Fprint(w, text)
		return
	}
	fmt.Fprintln(w, text)
}

func loadConfig() (config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return config{}, fail(exitTokenConfig, "cannot resolve home directory: %v", err)
	}
	timeout, err := timeoutFromEnv()
	if err != nil {
		return config{}, err
	}
	return config{
		url:         envOr("VLP_URL", "http://127.0.0.1:8765/mcp"),
		tokenFile:   envOr("VLP_TOKEN_FILE", filepath.Join(home, ".config", "vulpo", "token")),
		sessionFile: envOr("VLP_SESSION_FILE", filepath.Join(home, ".cache", "vulpo", "session")),
		logFile:     os.Getenv("VLP_LOG"),
		timeout:     timeout,
	}, nil
}

// defaultTimeout: safety net only; the server guarantees an outcome through its
// idle budget, so long legitimate Odoo operations are not cut (fb-020-007 §2.5).
const defaultTimeout = 1800 * time.Second

func timeoutFromEnv() (time.Duration, error) {
	raw := os.Getenv("VLP_TIMEOUT")
	if raw == "" {
		return defaultTimeout, nil
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds <= 0 {
		return 0, fail(exitUsage, "VLP_TIMEOUT must be a positive number of seconds: %q", raw)
	}
	return time.Duration(seconds) * time.Second, nil
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// readToken returns the trimmed token from path, enforcing mode 0600 (C1).
func readToken(path string) (string, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", fail(exitTokenConfig, "token file not found: %s", path)
	}
	if err != nil {
		return "", fail(exitTokenConfig, "cannot read token file %s: %v", path, err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", fail(exitTokenConfig, "token file must be mode 0600: %s", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fail(exitTokenConfig, "cannot read token file %s: %v", path, err)
	}
	token := strings.Trim(string(data), " \t\r\n\v\f")
	if reason := tokenDefect(token); reason != "" {
		return "", &exitError{
			code:  exitTokenConfig,
			msg:   fmt.Sprintf("%v: %s: %s", errInvalidTokenFile, path, reason),
			cause: errInvalidTokenFile,
		}
	}
	return token, nil
}

// tokenDefect names why a trimmed token is unusable, or "" when it is valid:
// one non-empty line of bytes 0x21-0x7E (§2.5). It never echoes the token.
func tokenDefect(token string) string {
	if token == "" {
		return "empty"
	}
	if strings.Contains(token, "\n") {
		return "multiple lines"
	}
	for i := 0; i < len(token); i++ {
		if token[i] < 0x21 || token[i] > 0x7E {
			return "invalid characters"
		}
	}
	return ""
}
