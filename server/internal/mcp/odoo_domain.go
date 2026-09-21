// Transformaciones de entrada de las tools odoo (fb-019-002, spec §2.4).
//
// El parámetro `domain` llega como string (literal Python — canónico
// mcp.odoo) o como array (legacy vulpo). El parser implementa el
// SUBCONJUNTO de literal Python suficiente para domains Odoo: listas, tuplas,
// strings con escapes, enteros/floats y True/False/None. Todo lo demás
// (dicts, aritmética, f-strings) es un error de la tool que nombra el
// problema ("unsupported domain syntax …") — la validación es PRE-ruteo: un
// argumento inválido jamás emite un command wire (P4, defensa en profundidad).
//
// El resto de las transformaciones de §2.4 vive acá también: fields/attributes
// string comma-separated → split+trim, ids "1,2,3" → array de números, y los
// defaults numéricos explícitos (P5/P6).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package mcp

import (
	"fmt"
	"strconv"
	"strings"
)

// parseOdooDomain normaliza el parámetro domain (§2.4): nil → dominio vacío
// (default "[]" resuelto); array → passthrough sin parse (I-4: superset de
// entrada); string → parse del subconjunto Python.
func parseOdooDomain(v any) ([]any, error) {
	switch d := v.(type) {
	case nil:
		return []any{}, nil
	case []any:
		return d, nil
	case string:
		return parseDomainString(d)
	default:
		return nil, fmt.Errorf("unsupported domain syntax: domain must be a Python-literal string or an array, got %T", v)
	}
}

// parseDomainString parsea el subconjunto de literal Python del spec §2.4 y
// devuelve el dominio como array de condiciones. Una tupla top-level se
// normaliza a dominio de esa única condición (p.ej. "('name','=','x')" →
// [["name","=","x"]] — observado en mcp.odoo).
func parseDomainString(src string) ([]any, error) {
	p := &domainParser{src: src}
	p.skipSpace()
	if p.i >= len(p.src) {
		return nil, fmt.Errorf("unsupported domain syntax: empty domain string")
	}
	if p.src[p.i] == '(' {
		cond, err := p.parseSeq(')')
		if err != nil {
			return nil, err
		}
		p.skipSpace()
		if p.i < len(p.src) {
			return nil, fmt.Errorf("unsupported domain syntax: unexpected trailing characters %q", p.src[p.i:])
		}
		return []any{cond}, nil
	}
	val, err := p.parseValue()
	if err != nil {
		return nil, err
	}
	p.skipSpace()
	if p.i < len(p.src) {
		return nil, fmt.Errorf("unsupported domain syntax: unexpected trailing characters %q", p.src[p.i:])
	}
	domain, ok := val.([]any)
	if !ok {
		return nil, fmt.Errorf("unsupported domain syntax: domain must be a list or tuple of conditions, got %T", val)
	}
	return domain, nil
}

// domainParser: descenso recursivo mínimo sobre el literal (fail-loud: todo
// camino inválido devuelve error "unsupported domain syntax: …").
type domainParser struct {
	src string
	i   int
}

func (p *domainParser) skipSpace() {
	for p.i < len(p.src) {
		switch p.src[p.i] {
		case ' ', '\t', '\n', '\r':
			p.i++
		default:
			return
		}
	}
}

func (p *domainParser) parseValue() (any, error) {
	p.skipSpace()
	if p.i >= len(p.src) {
		return nil, fmt.Errorf("unsupported domain syntax: unexpected end of input")
	}
	switch c := p.src[p.i]; {
	case c == '[':
		return p.parseSeq(']')
	case c == '(':
		return p.parseSeq(')')
	case c == '\'' || c == '"':
		return p.parseString()
	case c == '-' || (c >= '0' && c <= '9'):
		return p.parseNumber()
	case strings.HasPrefix(p.src[p.i:], "True"):
		return p.parseKeyword("True", true)
	case strings.HasPrefix(p.src[p.i:], "False"):
		return p.parseKeyword("False", false)
	case strings.HasPrefix(p.src[p.i:], "None"):
		return p.parseKeyword("None", nil)
	default:
		return nil, fmt.Errorf("unsupported domain syntax: unexpected character %q at position %d", c, p.i)
	}
}

// parseSeq: lista [...] o tupla (...) — ambas se normalizan a array (§2.4).
func (p *domainParser) parseSeq(close byte) (any, error) {
	open := p.src[p.i]
	p.i++
	items := []any{}
	p.skipSpace()
	if p.i < len(p.src) && p.src[p.i] == close {
		p.i++
		return items, nil
	}
	for {
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		items = append(items, val)
		p.skipSpace()
		if p.i >= len(p.src) {
			return nil, fmt.Errorf("unsupported domain syntax: unterminated %c sequence", open)
		}
		switch p.src[p.i] {
		case ',':
			p.i++
		case close:
			p.i++
			return items, nil
		default:
			return nil, fmt.Errorf("unsupported domain syntax: want ',' or %q at position %d, got %q", string(close), p.i, p.src[p.i])
		}
	}
}

// parseString: '…' o "…" con los escapes del spec (\\ \' \" \n \t); cualquier
// otro escape es sintaxis no soportada.
func (p *domainParser) parseString() (any, error) {
	quote := p.src[p.i]
	p.i++
	var b strings.Builder
	for {
		if p.i >= len(p.src) {
			return nil, fmt.Errorf("unsupported domain syntax: unterminated string")
		}
		c := p.src[p.i]
		if c == quote {
			p.i++
			return b.String(), nil
		}
		if c == '\\' {
			p.i++
			if p.i >= len(p.src) {
				return nil, fmt.Errorf("unsupported domain syntax: dangling escape in string")
			}
			switch p.src[p.i] {
			case '\\':
				b.WriteByte('\\')
			case '\'':
				b.WriteByte('\'')
			case '"':
				b.WriteByte('"')
			case 'n':
				b.WriteByte('\n')
			case 't':
				b.WriteByte('\t')
			default:
				return nil, fmt.Errorf("unsupported domain syntax: unsupported escape \\%c in string", p.src[p.i])
			}
			p.i++
			continue
		}
		b.WriteByte(c)
		p.i++
	}
}

// parseNumber: entero o float (incluidos negativos) — el wire JSON lleva
// float64.
func (p *domainParser) parseNumber() (any, error) {
	start := p.i
	if p.src[p.i] == '-' {
		p.i++
	}
	for p.i < len(p.src) {
		c := p.src[p.i]
		if (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-' {
			p.i++
			continue
		}
		break
	}
	f, err := strconv.ParseFloat(p.src[start:p.i], 64)
	if err != nil {
		return nil, fmt.Errorf("unsupported domain syntax: invalid number %q", p.src[start:p.i])
	}
	return f, nil
}

func (p *domainParser) parseKeyword(word string, val any) (any, error) {
	p.i += len(word)
	if p.i < len(p.src) {
		c := p.src[p.i]
		if c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') {
			return nil, fmt.Errorf("unsupported domain syntax: unexpected token after %s at position %d", word, p.i)
		}
	}
	return val, nil
}

// strListArg: normaliza un parámetro de lista de strings (§2.4): string comma-
// separated → split+trim (canónico mcp.odoo); array → passthrough (legacy
// vulpo, I-4); ausente → (nil, false, nil); otro tipo → error fail-loud.
func strListArg(params map[string]any, key string) ([]any, bool, error) {
	v, ok := params[key]
	if !ok || v == nil {
		return nil, false, nil
	}
	switch t := v.(type) {
	case string:
		parts := strings.Split(t, ",")
		out := make([]any, 0, len(parts))
		for _, part := range parts {
			if s := strings.TrimSpace(part); s != "" {
				out = append(out, s)
			}
		}
		return out, true, nil
	case []any:
		return t, true, nil
	default:
		return nil, false, fmt.Errorf("%s must be a comma-separated string or an array", key)
	}
}

// idsArg: ids de write/unlink (§2.4): array → passthrough; string comma-
// separated ("1,2,3") → array de enteros (wire float64); otro tipo → error
// fail-loud. ParseInt (no ParseFloat): "1.5"/"1e5" no son ids → error claro.
func idsArg(params map[string]any) ([]any, error) {
	v := params["ids"]
	switch t := v.(type) {
	case []any:
		return t, nil
	case string:
		parts := strings.Split(t, ",")
		out := make([]any, 0, len(parts))
		for _, part := range parts {
			s := strings.TrimSpace(part)
			if s == "" {
				continue
			}
			id, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				return nil, fmt.Errorf("invalid integer id %q: ids must be comma-separated integers", s)
			}
			out = append(out, float64(id))
		}
		return out, nil
	default:
		return nil, fmt.Errorf("ids must be an array or a comma-separated string")
	}
}

// numArg: lee un parámetro numérico (los JSON numbers decodifican como
// float64); default explícito cuando ausente (P6); tipo incorrecto → error.
func numArg(params map[string]any, key string, def float64) (float64, error) {
	v, ok := params[key]
	if !ok || v == nil {
		return def, nil
	}
	f, ok := v.(float64)
	if !ok {
		return 0, fmt.Errorf("%s must be a number", key)
	}
	return f, nil
}
