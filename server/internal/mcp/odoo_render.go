// Renderer de formats de las tools odoo (fb-019-002, spec §2.3) — server-side.
//
// La extensión devuelve datos crudos del ORM; el server renderiza (D-5).
// Aplica EXACTAMENTE a search_read, export_records, list_models y list_fields.
// Shapes pineadas vivo (§2.3): compact = headers+rows SIN success; table =
// markdown con separador --- por columna y valores stringificados (enteros sin
// decimales); html = escapado, sin newlines ni atributos; csv = RFC4180
// (quoting solo cuando el valor contiene coma/comilla/newline, doblado de
// comillas).
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package mcp

import (
	"encoding/json"
	"fmt"
	"html"
	"math"
	"sort"
	"strconv"
	"strings"
)

// odooFormats: enum válido del parámetro format (§2.0.4).
var odooFormats = map[string]bool{
	"json": true, "compact": true, "table": true, "html": true, "csv": true,
}

// formatArg: lee y valida el parámetro format (default json — §2.0.4).
func formatArg(params map[string]any) (string, error) {
	f := strArg(params, "format")
	if f == "" {
		return "json", nil
	}
	if !odooFormats[f] {
		return "", fmt.Errorf("unsupported format %q (enum json|compact|table|html|csv)", f)
	}
	return f, nil
}

// odooTabular: proyecta una lista de records (dicts) a (headers, rows).
// headers = los campos pedidos, en orden; sin campos → claves del primer
// record (§2.3, vivo); en Go el orden de claves del map no es determinista,
// así que se ordenan alfabéticamente. Un record no-dict es un shape
// inesperado de la extensión → error fail-loud.
func odooTabular(records []any, fields []any) ([]any, []any, error) {
	var headers []any
	switch {
	case len(fields) > 0:
		headers = make([]any, len(fields))
		copy(headers, fields)
	case len(records) > 0:
		first, ok := records[0].(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("unexpected extension response: record is %T, want object", records[0])
		}
		keys := make([]string, 0, len(first))
		for k := range first {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		headers = make([]any, len(keys))
		for i, k := range keys {
			headers[i] = k
		}
	default:
		headers = []any{}
	}
	rows := make([]any, 0, len(records))
	for _, r := range records {
		m, ok := r.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("unexpected extension response: record is %T, want object", r)
		}
		row := make([]any, len(headers))
		for i, h := range headers {
			row[i] = m[h.(string)]
		}
		rows = append(rows, row)
	}
	return headers, rows, nil
}

// odooFieldsTabular: aplana el dict de fields_get (list_fields, §2.3): columna
// "field" primera + atributos (unión de los campos, ordenados) y una fila por
// campo, ordenada por nombre de campo (vivo §2.1 fila 10). Un atributo que un
// campo no trae viaja como null en esa fila.
func odooFieldsTabular(fieldsDict map[string]any) ([]any, []any) {
	names := make([]string, 0, len(fieldsDict))
	for name := range fieldsDict {
		names = append(names, name)
	}
	sort.Strings(names)

	attrSet := map[string]bool{}
	for _, name := range names {
		if attrs, ok := fieldsDict[name].(map[string]any); ok {
			for k := range attrs {
				attrSet[k] = true
			}
		}
	}
	attrKeys := make([]string, 0, len(attrSet))
	for k := range attrSet {
		attrKeys = append(attrKeys, k)
	}
	sort.Strings(attrKeys)

	headers := make([]any, 0, len(attrKeys)+1)
	headers = append(headers, "field")
	for _, k := range attrKeys {
		headers = append(headers, k)
	}
	rows := make([]any, 0, len(names))
	for _, name := range names {
		row := make([]any, 0, len(headers))
		row = append(row, name)
		attrs, _ := fieldsDict[name].(map[string]any)
		for _, k := range attrKeys {
			row = append(row, attrs[k])
		}
		rows = append(rows, row)
	}
	return headers, rows
}

// odooNonJSON: fragmento de datos de la respuesta para format != json (§2.3).
// json lo compone cada tool (la clave de datos json difiere: records / models
// / fields); los non-json NO llevan success (vivo §2.3).
func odooNonJSON(format string, headers, rows []any) (map[string]any, error) {
	switch format {
	case "compact":
		return map[string]any{"headers": headers, "rows": rows}, nil
	case "table":
		return map[string]any{"data": odooMarkdownTable(headers, rows)}, nil
	case "html":
		return map[string]any{"data": odooHTMLTable(headers, rows)}, nil
	case "csv":
		return map[string]any{"data": odooCSV(headers, rows)}, nil
	}
	return nil, fmt.Errorf("unsupported format %q (enum json|compact|table|html|csv)", format)
}

// odooMarkdownRow: "| a | b |" con celdas stringificadas (§2.3).
func odooMarkdownRow(cells []any) string {
	parts := make([]string, len(cells))
	for i, c := range cells {
		parts[i] = odooCellString(c)
	}
	return "| " + strings.Join(parts, " | ") + " |"
}

// odooMarkdownTable: header row + separador "---" por columna + filas (§2.3).
func odooMarkdownTable(headers, rows []any) string {
	var b strings.Builder
	b.WriteString(odooMarkdownRow(headers))
	b.WriteString("\n")
	seps := make([]any, len(headers))
	for i := range seps {
		seps[i] = "---"
	}
	b.WriteString(odooMarkdownRow(seps))
	for _, r := range rows {
		b.WriteString("\n")
		b.WriteString(odooMarkdownRow(r.([]any)))
	}
	return b.String()
}

// odooHTMLTable: <table> plano sin newlines ni atributos; valores escapados
// (§2.3 — html escape, seguridad).
func odooHTMLTable(headers, rows []any) string {
	var b strings.Builder
	b.WriteString("<table><thead><tr>")
	for _, h := range headers {
		b.WriteString("<th>")
		b.WriteString(html.EscapeString(odooCellString(h)))
		b.WriteString("</th>")
	}
	b.WriteString("</tr></thead><tbody>")
	for _, r := range rows {
		b.WriteString("<tr>")
		for _, c := range r.([]any) {
			b.WriteString("<td>")
			b.WriteString(html.EscapeString(odooCellString(c)))
			b.WriteString("</td>")
		}
		b.WriteString("</tr>")
	}
	b.WriteString("</tbody></table>")
	return b.String()
}

// odooCSV: RFC4180 (§2.3, vivo) — sin quoting cuando no hace falta; quoting y
// doblado de comillas cuando el valor contiene coma, comilla o newline.
func odooCSV(headers, rows []any) string {
	var b strings.Builder
	b.WriteString(odooCSVRow(headers))
	for _, r := range rows {
		b.WriteString("\n")
		b.WriteString(odooCSVRow(r.([]any)))
	}
	return b.String()
}

func odooCSVRow(cells []any) string {
	parts := make([]string, len(cells))
	for i, c := range cells {
		parts[i] = odooCSVCell(c)
	}
	return strings.Join(parts, ",")
}

func odooCSVCell(v any) string {
	s := odooCellString(v)
	if strings.ContainsAny(s, ",\"\n\r") {
		return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
	}
	return s
}

// odooCellString: stringificación de celda (§2.3: "valores stringificados,
// enteros sin decimales"). Bools y strings crudos; números enteros sin parte
// decimal; valores complejos como JSON.
func odooCellString(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case bool:
		return strconv.FormatBool(t)
	case string:
		return t
	case float64:
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(b)
	}
}
