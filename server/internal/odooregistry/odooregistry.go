// Package odooregistry — registry server-side de perfiles Odoo (fb-013-002).
//
// Cache de OdooTabProfile por profileID (token). Las tools odoo_* de
// 003-005 (renombradas por fb-019-002) consultan este registry para resolver
// un profile/tabId al perfil del
// token correcto y emitir el command wire hacia la extensión.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package odooregistry

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
)

// Command — command wire hacia la extensión.
type Command struct {
	Command string
	Params  map[string]any
	TabID   string
}

// Hub — interface local de un método que el Registry usa para emitir commands.
type Hub interface {
	Command(profileID string, cmd Command) (any, error)
}

// OdooTabProfile — Contrato 1 del epic fb-013 (plan.md L56-74).
type OdooTabProfile struct {
	TabID       int    `json:"tabId"`
	URL         string `json:"url"`
	DB          string `json:"db"`
	Version     string `json:"version"`
	UID         int    `json:"uid"`
	Username    string `json:"username"`
	IsSuperuser bool   `json:"is_superuser"`
	IsActive    bool   `json:"is_active"`
}

// ErrNoOdooTab — error de Lookup para un tab no cacheado. No llega a las tools:
// el server devuelve su propio odoo_no_tab (mcp/odoo_tab_select.go).
var ErrNoOdooTab = errors.New("No Odoo tab detected. Open an Odoo tab first or provide a profile.")

// entry — perfil cacheado con su token propietario.
type entry struct {
	profile OdooTabProfile
	token   string
}

// Registry — cache mutex-guarded de perfiles Odoo por profileID.
type Registry struct {
	mu    sync.RWMutex
	cache map[string][]entry // profileID → perfiles detectados
}

// New crea un Registry.
func New() *Registry {
	return &Registry{cache: map[string][]entry{}}
}

// Detect emite odooDetectTabs al hub para un profileID, parsea la respuesta
// ([]OdooTabProfile vía JSON) y refresca el cache bajo ese profileID. Los tabs
// que el re-Detect ya no devuelve se marcan is_active=false (PC4).
func (r *Registry) Detect(profileID string, hub Hub) error {
	res, err := hub.Command(profileID, Command{
		Command: "odooDetectTabs",
		Params:  map[string]any{},
		TabID:   "",
	})
	if err != nil {
		return fmt.Errorf("odooregistry: Detect: %w", err)
	}

	// La extensión devuelve la lista de perfiles como []map[string]any (o el
	// JSON equivalente). Normalizar a OdooTabProfile.
	var raw []map[string]any
	switch v := res.(type) {
	case []map[string]any:
		raw = v
	default:
		// Probar unmarshal si vino serializado como JSON string/bytes.
		data, err := json.Marshal(res)
		if err != nil {
			return fmt.Errorf("odooregistry: Detect: resultado inesperado: %w", err)
		}
		if err := json.Unmarshal(data, &raw); err != nil {
			return fmt.Errorf("odooregistry: Detect: resultado no es lista de perfiles: %w", err)
		}
	}

	// Reconstruir el cache completo bajo este profileID.
	var entries []entry
	for _, m := range raw {
		var p OdooTabProfile
		if err := mapToProfile(m, &p); err != nil {
			// Perfil malformado: omitirlo (mejor no cachear datos corruptos).
			continue
		}
		// El perfil devuelto por un Detect actual está activo por definición
		// (PC4): is_active del wire se ignora — el re-Detect es la fuente de
		// verdad de actividad. Los tabs ausentes se marcan inactivos abajo.
		p.IsActive = true
		entries = append(entries, entry{profile: p, token: profileID})
	}

	// Marcar como inactivos los tabs que antes estaban activos y ya no se
	// devuelven en este re-Detect (PC4).
	prev := r.snapshot(profileID)
	still := map[int]bool{}
	for _, e := range entries {
		still[e.profile.TabID] = true
	}
	for _, e := range prev {
		if !still[e.profile.TabID] {
			e.profile.IsActive = false
			entries = append(entries, e)
		}
	}

	r.mu.Lock()
	r.cache[profileID] = entries
	r.mu.Unlock()
	return nil
}

// List devuelve los perfiles cacheados (activos e inactivos) de un profileID.
func (r *Registry) List(profileID string) []OdooTabProfile {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ents := r.cache[profileID]
	out := make([]OdooTabProfile, 0, len(ents))
	for _, e := range ents {
		out = append(out, e.profile)
	}
	return out
}

// Lookup devuelve perfil + token para un tabId (string; TabID es int).
//
// ⚠️ SECURITY: Lookup es GLOBAL (itera el cache de TODOS los tokens). El caller
// DEBE verificar que el owner devuelto coincide con el token del request antes
// de ruteear cualquier comando (aislamiento TokenTenant). El server no lo usa:
// las tools ORM resuelven con odooTabResolver (mcp/odoo_tab_select.go), que
// solo mira List(token). Se conserva porque lo cubren los tests de PC3.
func (r *Registry) Lookup(tabId string) (OdooTabProfile, string, error) {
	id, err := strconv.Atoi(tabId)
	if err != nil {
		id = -1 // no-numérico → no matcheará
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, ents := range r.cache {
		for _, e := range ents {
			if e.profile.TabID == id && e.profile.IsActive {
				return e.profile, e.token, nil
			}
		}
	}
	return OdooTabProfile{}, "", ErrNoOdooTab
}

// IsActive indica si un tab está activo en el último Detect de su profileID.
func (r *Registry) IsActive(tabId string) bool {
	id, err := strconv.Atoi(tabId)
	if err != nil {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, ents := range r.cache {
		for _, e := range ents {
			if e.profile.TabID == id {
				return e.profile.IsActive
			}
		}
	}
	return false
}

// snapshot devuelve una copia del cache de un profileID (para PC4 sin lock muerto).
func (r *Registry) snapshot(profileID string) []entry {
	r.mu.RLock()
	defer r.mu.RUnlock()
	ents := r.cache[profileID]
	out := make([]entry, len(ents))
	copy(out, ents)
	return out
}

// mapToProfile normaliza un map JSON wire (snake_case) a OdooTabProfile.
func mapToProfile(m map[string]any, p *OdooTabProfile) error {
	if v, ok := m["tabId"].(float64); ok {
		p.TabID = int(v)
	} else if v, ok := m["tabId"].(int); ok {
		p.TabID = v
	} else {
		return fmt.Errorf("tabId inválido")
	}
	p.URL, _ = m["url"].(string)
	p.DB, _ = m["db"].(string)
	p.Version, _ = m["version"].(string)
	if v, ok := m["uid"].(float64); ok {
		p.UID = int(v)
	} else if v, ok := m["uid"].(int); ok {
		p.UID = v
	}
	p.Username, _ = m["username"].(string)
	p.IsSuperuser, _ = m["is_superuser"].(bool)
	p.IsActive, _ = m["is_active"].(bool)
	return nil
}
