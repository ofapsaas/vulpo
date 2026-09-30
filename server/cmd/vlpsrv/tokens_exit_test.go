// tokens_exit_test.go — fb-024-harness-headless: P5, exit 1 de vlpsrv ante
// un archivo de tokens mal formado.
//
// Mecanismo (fijado en test-audit §4): binario compilado en t.TempDir()
// con GOCACHE en TempDir; re-exec queda como fallback declarado del audit.
//
// Postcondición: con `"# c\ntok1\nsecretA secretB\n"`, el proceso vlpsrv
// termina con exit 1, su salida contiene `line 3` y NO contiene contenido
// de la línea (I-4: nunca revela el token). Guarda de no-vacuidad: con un
// archivo de un solo token el proceso arranca, imprime VLP_READY en
// stdout y el test lo mata.
//
// RED: hoy el parser acepta la línea con espacios internos, vlpsrv arranca
// y se queda vivo (exit 0 never) → la aserción de exit 1 + `line 3` falla
// por aserción (con deadline + kill: el test nunca queda colgado).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bufio"
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// timeouts del subproceso (RED: el proceso puede no terminar → matamos;
// no depende del test.timeout global).
const (
	readyTimeout = 30 * time.Second
	exitDeadline = 45 * time.Second
)

// buildVlpsrv compila el binario real del paquete en t.TempDir(), con
// GOCACHE dentro de TempDir (no toca $HOME en escritura; GOMODCACHE se
// hereda en lectura, decisión del test-audit §4).
func buildVlpsrv(t *testing.T) string {
	t.Helper()
	binDir := t.TempDir()
	bin := filepath.Join(binDir, "vlpsrv")
	cmd := exec.Command("go", "build", "-o", bin, ".")
	cmd.Env = append(os.Environ(), "GOCACHE="+binDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build vlpsrv = %v; salida: %s", err, out)
	}
	return bin
}

// vlpsrvEnv: entorno común del subproceso (tokens file + bind+port fijados
// fuera del rango del servicio del host y de los tests paralelos).
func vlpsrvEnv(tokensPath string) []string {
	return append(os.Environ(),
		"VLP_TOKENS_FILE="+tokensPath,
		"VLP_BIND_ADDR=127.0.0.2",
		"VLP_PORT=39998",
	)
}

func TestVlpsrv_TokensFile_Behaviour(t *testing.T) {
	bin := buildVlpsrv(t)
	dir := t.TempDir()

	t.Run("guard: valid tokens → starts, prints VLP_READY, killable", func(t *testing.T) {
		valid := filepath.Join(dir, "tokens-valid.txt")
		if err := os.WriteFile(valid, []byte("tokguard\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(bin)
		cmd.Env = vlpsrvEnv(valid)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr

		var mu sync.Mutex
		var lines []string
		ready := make(chan struct{})
		go func() {
			sc := bufio.NewScanner(stdout)
			for sc.Scan() {
				mu.Lock()
				lines = append(lines, sc.Text())
				mu.Unlock()
				if strings.Contains(sc.Text(), "VLP_READY") {
					close(ready)
					return
				}
			}
		}()

		if err := cmd.Start(); err != nil {
			t.Fatalf("start = %v", err)
		}
		if cmd.Process == nil {
			t.Fatal("proceso nulo tras Start")
		}
		exited := make(chan error, 1)
		go func() { exited <- cmd.Wait() }()

		select {
		case <-ready:
			// VLP_READY apareció; el proceso sigue corriendo.
		case err := <-exited:
			mu.Lock()
			sal := strings.Join(lines, "\n") + "\n" + stderr.String()
			mu.Unlock()
			t.Fatalf("vlpsrv abortó antes de VLP_READY: %v | salida: %s", err, sal)
		case <-time.After(readyTimeout):
			mu.Lock()
			sal := strings.Join(lines, "\n") + "\n" + stderr.String()
			mu.Unlock()
			_ = cmd.Process.Kill()
			<-exited
			t.Fatalf("timeout esperando VLP_READY | salida: %s", sal)
		}
		if err := cmd.Process.Kill(); err != nil {
			t.Fatalf("kill = %v", err)
		}
		<-exited
	})

	t.Run("invalid tokens file → exit 1, says line 3, no content", func(t *testing.T) {
		bad := filepath.Join(dir, "tokens-bad.txt")
		if err := os.WriteFile(bad, []byte("# c\ntok1\nsecretA secretB\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(bin)
		cmd.Env = vlpsrvEnv(bad)
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		var stderrBuf bytes.Buffer
		var mu sync.Mutex
		var outLines []string
		go func() {
			sc := bufio.NewScanner(stdout)
			for sc.Scan() {
				mu.Lock()
				outLines = append(outLines, sc.Text())
				mu.Unlock()
				// RED: si el server ARRANCA con el archivo malo, killer.
				if strings.Contains(sc.Text(), "VLP_READY") {
					_ = cmd.Process.Kill()
					return
				}
			}
		}()
		cmd.Stderr = &stderrBuf

		if err := cmd.Start(); err != nil {
			t.Fatalf("start = %v", err)
		}
		exited := make(chan error, 1)
		go func() { exited <- cmd.Wait() }()

		select {
		case err := <-exited:
			mu.Lock()
			std := strings.Join(outLines, "\n")
			mu.Unlock()
			out := std + "\n" + stderrBuf.String()
			ee, ok := err.(*exec.ExitError)
			if !ok {
				t.Fatalf("el subproceso terminó sin estado de salida interpretable: %v (stdout=%q stderr=%q)", err, std, stderrBuf.String())
			}
			if ee.ExitCode() != 1 {
				t.Fatalf("exit code = %d, want 1; stdout=%q stderr=%q", ee.ExitCode(), std, stderrBuf.String())
			}
			if !strings.Contains(out, "line 3") {
				t.Fatalf("salida = %q, want contiene 'line 3'", out)
			}
			if strings.Contains(out, "secretA") || strings.Contains(out, "secretB") {
				t.Fatalf("salida filtra el contenido del token (I-4): %q", out)
			}
		case <-time.After(exitDeadline):
			_ = cmd.Process.Kill()
			<-exited
			mu.Lock()
			std := strings.Join(outLines, "\n")
			mu.Unlock()
			t.Fatalf("exit 0: el parser actual aceptó el archivo con espacios internos y el server arrancó (proceso vivo %v); want exit 1 (stdout=%q stderr=%q)", exitDeadline, std, stderrBuf.String())
		}
	})
}
