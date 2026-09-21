// Adapter mcp.Hub → odooregistry.Hub (fb-013-003). Los tipos mcp.Command y
// odooregistry.Command son estructuralmente idénticos pero nominalmente
// distintos. Este adapter permite que registry.Detect (que exige
// odooregistry.Hub) use el mismo hub MCP (mcp.Hub) que las tools.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package mcp

import "vulpo/server/internal/odooregistry"

// odooHubAdapter: envuelve una mcp.Hub como odooregistry.Hub (fb-013-003).
type odooHubAdapter struct {
	h Hub
}

// Command traduce odooregistry.Command → mcp.Command y lo delega al hub MCP.
func (a odooHubAdapter) Command(profileID string, cmd odooregistry.Command) (any, error) {
	return a.h.Command(profileID, Command{
		Command: cmd.Command,
		Params:  cmd.Params,
		TabID:   cmd.TabID,
	})
}
