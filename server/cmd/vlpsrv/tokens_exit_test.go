// tokens_exit_test.go — fb-024-harness-headless: P5, exit 1 de vlpsrv ante
// un archivo de tokens mal formado.
//
// Mecanismo (review fb-024-harness-headless #2): patrón re-exec, SIN
// compilar el binario. TestMain del propio paquete: si
// VLPSRV_TEST_AS_MAIN=1 (variable propia del test, nunca puesta por
// `go test`), el binario de test ACTÚA como vlpsrv — llama a main() real
// del paquete, que hace os.Exit con el código del contrato. Sin la
// variable: corre los tests normalmente (os.Exit(m.Run())). No hay
// recursión: el subproceso de P5 hereda un cmd.Env EXCLUSIVO que incluye
// VLPSRV_TEST_AS_MAIN=1; el proceso padre (go test) nunca la tiene.
//
// #3: puerto no fijo. vlpsrv NO acepta VLP_PORT=0 (el CLI lo interpreta
// como "sin setear" → default 8765, medido en la corrida de review): el
// test elige un puerto LIBRE con net.Listen("tcp", "127.0.0.1:0") y lo
// pasa por VLP_PORT — en lugar del bind fijo 127.0.0.2:39998, que
// chocaba entre corridas concurrentes o con un proceso ajeno. El guard
// confirma el port real leyéndolo de la línea VLP_READY.
//
// Postcondición P5 (invariada — no se debilita ninguna aserción): con
// `"# c\ntok1\nsecretA secretB\n"`, el proceso vlpsrv termina con exit 1,
// su salida contiene `line 3` y NO contiene `secretA`/`secretB`
// (I-4: nunca revela el token). Guarda de no-vacuidad: con un archivo de
// un solo token el proceso arranca, imprime VLP_READY en stdout y el test
// lo mata.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bufio"
	"bytes"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
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

// TestMain: punto de re-exec (review #2). Si VLPSRV_TEST_AS_MAIN=1, el
// binario de test (os.Args[0] del subproceso) actúa como vlpsrv: llama al
// main() real del paquete, que hace os.Exit(1|0) con el código del
// contrato. Sin la variable: corre el suite de tests normalmente. La
// recursión es imposible: el padre (go test) nunca importa la variable
// heredándola del entorno — solo el subproceso la crea dentro de su
// cmd.Env exclusivo, y ahí main() termina por os.Exit, no re-exec.
func TestMain(m *testing.M) {
	if os.Getenv("VLPSRV_TEST_AS_MAIN") == "1" {
		main() // main hace os.Exit: nunca retorna
		return
	}
	os.Exit(m.Run())
}

// vlpsrvSubprocess arma el re-exec del binario de test (os.Args[0]) — SIN
// argumentos: main() rechaza cualquier argv[1] desconocido ("opcion
// desconocida") y no hace falta ninguno: el subproceso no corre ningún
// test (`go test` nunca se invoca; el binario de test arranca TestMain
// directo, y por la marca del env TestMain actúa como vlpsrv). Env
// EXCLUSIVO (el subproceso NO hereda el resto del entorno del padre, así
// la marca no puede volver al padre ni contaminar otros paquetes):
//   - VLP_TOKENS_FILE: el tokens file del caso (tempdir del test);
//   - VLP_PORT: puerto libre elegido por el test (review #3);
//   - VLPSRV_TEST_AS_MAIN=1: la marca de re-exec.
func vlpsrvSubprocess(tokensPath string, port int) (*exec.Cmd, error) {
	if os.Args[0] == "" {
		return nil, errors.New("os.Args[0] vacío: sin binario para re-exec")
	}
	cmd := exec.Command(os.Args[0])
	cmd.Env = []string{
		"VLPSRV_TEST_AS_MAIN=1",
		"VLP_TOKENS_FILE=" + tokensPath,
		"VLP_PORT=" + strconv.Itoa(port),
	}
	return cmd, nil
}

// parseReadyPort: extrae el port de "SYSTEM VLP_READY {bind:… port:N …}".
func parseReadyPort(line string) (int, bool) {
	if !strings.Contains(line, "VLP_READY") {
		return 0, false
	}
	i := strings.Index(line, "port:")
	if i < 0 {
		return 0, false
	}
	rest := line[i+len("port:"):]
	end := 0
	for end < len(rest) && rest[end] >= '0' && rest[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0, false
	}
	p, err := strconv.Atoi(rest[:end])
	if err != nil || p <= 0 {
		return 0, false
	}
	return p, true
}

// collectStdout: goroutine que acumula las líneas stdout del subproceso y
// detecta VLP_READY (con su port).
// Devuelve un "watcher" con tres canales:
//   - ready()       : señal de VLP_READY visto (una única vez)
//   - lines()       : las líneas acumuladas hasta el momento
//   - doneRead()    : el scanner llegó a EOF (stdout cerrado)
func collectStdout(t *testing.T, cmd *exec.Cmd, mu *sync.Mutex, lines *[]string, readyPort *int) (ready <-chan struct{}, eof <-chan struct{}) {
	t.Helper()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	readyCh := make(chan struct{})
	eofCh := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			mu.Lock()
			*lines = append(*lines, sc.Text())
			mu.Unlock()
			if p, ok := parseReadyPort(sc.Text()); ok {
				mu.Lock()
				*readyPort = p
				mu.Unlock()
				close(readyCh)
				return
			}
		}
		close(eofCh)
	}()
	return readyCh, eofCh
}

// freePort: elige un puerto TCP libre pidiéndole al SO un listen efímero
// y cerrándolo enseguida (review #3; no hay colisión con el fijo 39998,
// ni entre corridas concurrentes ni con procesos ajenos). La ventana
// между close y el Listen del server es mínima y no depende de nada.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen(:0) = %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// TestVlpsrv_TokensFile_Behaviour — P5 (exit 1 ante tokens file malformado)
// + guarda de no-vacuidad (archivo válido arranca y es matable).
func TestVlpsrv_TokensFile_Behaviour(t *testing.T) {
	dir := t.TempDir()

	t.Run("guard: valid tokens → starts, prints VLP_READY, killable", func(t *testing.T) {
		valid := filepath.Join(dir, "tokens-valid.txt")
		if err := os.WriteFile(valid, []byte("tokguard\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd, err := vlpsrvSubprocess(valid, freePort(t))
		if err != nil {
			t.Fatal(err)
		}
		var stderr bytes.Buffer
		cmd.Stderr = &stderr

		var mu sync.Mutex
		var lines []string
		var readyPort int
		ready, _ := collectStdout(t, cmd, &mu, &lines, &readyPort)

		if err := cmd.Start(); err != nil {
			t.Fatalf("start = %v", err)
		}
		exited := make(chan error, 1)
		go func() { exited <- cmd.Wait() }()

		select {
		case <-ready:
			// VLP_READY apareció con puerto efímero real: el proceso
			// sigue corriendo (no volvió a test a sí mismo).
			mu.Lock()
			port := readyPort
			mu.Unlock()
			if port <= 0 {
				t.Errorf("VLP_READY sin puerto utilizable: %q", lines)
			}
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
		cmd, err := vlpsrvSubprocess(bad, freePort(t))
		if err != nil {
			t.Fatal(err)
		}
		var stderrBuf bytes.Buffer
		var mu sync.Mutex
		var outLines []string
		var killed bool
		var readyPort int
		readyCh, _ := collectStdout(t, cmd, &mu, &outLines, &readyPort)
		go func() {
			// RED: si el server ARRANCA con el archivo malo, killer.
			<-readyCh // readyCh se cierra una sola vez; este bloque corre una vez
			mu.Lock()
			killed = true
			mu.Unlock()
			_ = cmd.Process.Kill()
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
			killedNow := killed
			mu.Unlock()
			t.Fatalf("exit 0: el parser actual aceptó el archivo con espacios internos y el server arrancó (proceso vivo %v, killed=%v); want exit 1 (stdout=%q stderr=%q)", exitDeadline, killedNow, std, stderrBuf.String())
		}
	})
}
