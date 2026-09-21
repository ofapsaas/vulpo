// vlpsrv — CLI del server de Vulpo. Ensambla las piezas (hub/mcp), lee env,
// valida el tokens file (fail-loud: exit 1), arranca, loguea VLP_READY y
// aguanta SIGINT/SIGTERM (graceful shutdown).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"

	"vulpo/server/internal/server"
)

// version es la version del server.
const version = "0.5.2"

// agentKitRevision: short sha del último commit que tocó agent-kit/.
// La inyecta scripts/build-server.sh con -X main.agentKitRevision=<sha>;
// vacía en builds sin el script.
var agentKitRevision string

func main() {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--version":
			fmt.Println(version)
			return
		case "--check":
			fmt.Printf("vlpsrv: OK (v%s)\n", version)
			return
		case "--help", "-h":
			usage()
			return
		default:
			fmt.Fprintf(os.Stderr, "vlpsrv: opcion desconocida: %s\n", os.Args[1])
			usage()
			os.Exit(1)
		}
	}

	// --- env (defaults) ---
	port, _ := strconv.Atoi(os.Getenv("VLP_PORT"))
	if port == 0 {
		port = 8765
	}
	tokensFile := os.Getenv("VLP_TOKENS_FILE")
	if tokensFile == "" {
		home, _ := os.UserHomeDir()
		tokensFile = filepath.Join(home, ".vulpo", "tokens.txt")
	}
	bindAddr := resolveBindAddr()
	helpFile := os.Getenv("VLP_HELP_FILE")

	// --- tokens file (fail-loud) ---
	tokens, err := server.ParseTokensFile(tokensFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR VLP_TOKENS_FILE inválido: %v (%s)\n", err, tokensFile)
		os.Exit(1)
	}
	if len(tokens) == 0 {
		fmt.Fprintf(os.Stderr, "ERROR VLP_TOKENS_FILE sin tokens: %s\n", tokensFile)
		os.Exit(1)
	}

	// --- arranque ---
	srv, err := server.StartServer(server.Options{
		Port:             port,
		BindAddr:         bindAddr,
		Tokens:           tokens,
		HelpFile:         helpFile,
		AgentKitRevision: agentKitRevision,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "ERROR VLP_READY falló: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(formatReady(srv.Port, bindAddr, len(tokens)))

	// --- graceful shutdown ---
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	srv.Close()
	os.Exit(0)
}

// resolveBindAddr: resuelve la interfaz de escucha desde VLP_BIND_ADDR;
// env vacío o ausente → default "127.0.0.1" (loopback).
func resolveBindAddr() string {
	addr := os.Getenv("VLP_BIND_ADDR")
	if addr == "" {
		addr = "127.0.0.1"
	}
	return addr
}

// formatReady: arma el mensaje SYSTEM VLP_READY con bind, port y tokens.
func formatReady(port int, bind string, profiles int) string {
	return fmt.Sprintf("SYSTEM VLP_READY {bind:%s port:%d profiles:%d}",
		bind, port, profiles)
}

func usage() {
	fmt.Fprintf(os.Stderr, "uso: vlpsrv [--version | --check | --help]\n")
	fmt.Fprintf(os.Stderr, "     (sin args) arranca el server con env VLP_*\n")
}
