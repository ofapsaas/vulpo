// Envelope de paginación y composiciones wire de las tools odoo
// (fb-019-002, spec §2.2 y §2.5).
//
// search_read y export_records devuelven el envelope pineado vivo (fórmulas
// §2.2): total = search_count REAL (jamás derivado de len(records) — I-5);
// has_more = (offset + len(records)) < total; next_offset = offset + limit
// (puede exceder total — observado vivo); format siempre presente. La
// composición es atómica a nivel respuesta (P9): el fallo de CUALQUIER command
// del wire propaga el error del hub, sin success parcial.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package mcp

import "fmt"

// odooCountTotal: extrae el total del resultado de odooSearchCount (I-5). Un
// resultado no numérico (shape inesperado de la extensión) se degrada a 0 —
// el total sigue viniendo del command de count, nunca de len(records); el
// fallo del command en sí sí propaga error (P9).
func odooCountTotal(res any) float64 {
	switch t := res.(type) {
	case float64:
		return t
	case int:
		return float64(t)
	case int64:
		return float64(t)
	}
	return 0
}

// unwrapOdooRecords: normaliza el resultado de un read a la lista de records:
// lista → tal cual; object con clave "records" (shape envelope) → esa lista.
// Cualquier otro shape → error fail-loud.
func unwrapOdooRecords(res any) ([]any, error) {
	switch t := res.(type) {
	case []any:
		return t, nil
	case map[string]any:
		if recs, ok := t["records"].([]any); ok {
			return recs, nil
		}
	}
	return nil, fmt.Errorf("unexpected extension response: want a list of records, got %T", res)
}

// odooEnvelope: claves de paginación §2.2 (fórmulas pineadas vivo). El format
// viaja SIEMPRE en el envelope (§2.0.4).
func odooEnvelope(format string, total, limit, offset float64, n int) map[string]any {
	return map[string]any{
		"total":       total,
		"limit":       limit,
		"offset":      offset,
		"has_more":    offset+float64(n) < total,
		"next_offset": offset + limit,
		"format":      format,
	}
}

// odooPagedResponse: respuesta completa de las tools con paginación
// (search_read / export_records): envelope §2.2 + datos según format §2.3
// (json → records; el resto → headers+rows o data, sin success).
func odooPagedResponse(format string, records []any, fields []any, total, limit, offset float64) (map[string]any, error) {
	out := odooEnvelope(format, total, limit, offset, len(records))
	if format == "json" {
		out["records"] = records
		return out, nil
	}
	headers, rows, err := odooTabular(records, fields)
	if err != nil {
		return nil, err
	}
	data, err := odooNonJSON(format, headers, rows)
	if err != nil {
		return nil, err
	}
	for k, v := range data {
		out[k] = v
	}
	return out, nil
}

// wrapSuccess: wrapper mínimo observable del write-path de write/unlink
// (C-2/P14): {success: true}. Las keys extra del resultado del hub se
// transmiten cuando llega un object (render aditivo — las keys exactas se
// cierran en campo, P22/P23, sin tocar la suite Go).
func wrapSuccess(res any) map[string]any {
	out := map[string]any{}
	if m, ok := res.(map[string]any); ok {
		for k, v := range m {
			out[k] = v
		}
	}
	if _, ok := out["success"]; !ok {
		out["success"] = true
	}
	return out
}

// odooCreateResult: respuesta de create (C-2/P14): el id del registro creado —
// el id nativo del ORM llega como número y se envuelve como {id}; un object
// del hub se transmite tal cual (wrapper exacto VERIFICAR vivo, P22/P23).
func odooCreateResult(res any) any {
	switch t := res.(type) {
	case float64:
		return map[string]any{"id": t}
	case int:
		return map[string]any{"id": t}
	case int64:
		return map[string]any{"id": t}
	}
	return res
}

// odooImportResult: transform del raw `load` de import_records (§2.5/C-2):
// {success, created, updated} — rows CON id (External ID) → updated; sin id →
// created (los ids que el load devuelve, en orden de las rows sin id). Los
// messages del load se transmiten (shape exacta VERIFICAR vivo — P22/P23).
func odooImportResult(rows []any, load any) map[string]any {
	var loadIDs []any
	var messages any
	if m, ok := load.(map[string]any); ok {
		loadIDs, _ = m["ids"].([]any)
		messages = m["messages"]
	}
	created := []any{}
	updated := []any{}
	next := 0
	for _, row := range rows {
		m, ok := row.(map[string]any)
		if !ok {
			continue
		}
		if id := m["id"]; id != nil && id != "" {
			updated = append(updated, id)
			continue
		}
		if next < len(loadIDs) {
			created = append(created, loadIDs[next])
			next++
		}
	}
	out := map[string]any{"success": true, "created": created, "updated": updated}
	if messages != nil {
		out["messages"] = messages
	}
	return out
}

// odooDatasToRecords: normaliza el resultado crudo de export_data — MATRIZ
// {datas: [[v1,v2],…]} observada en campo (fb-019-002 field verification) — a
// la lista de dicts del contrato, zip-eando cada fila con los fields
// exportados en orden. Una fila más corta que fields deja los faltantes como
// nil (no error); una fila no-array o un field no-string → error fail-loud.
func odooDatasToRecords(datas []any, fields []any) ([]any, error) {
	records := make([]any, 0, len(datas))
	for i, rowAny := range datas {
		row, ok := rowAny.([]any)
		if !ok {
			return nil, fmt.Errorf("export_records: unexpected extension response: datas row %d is %T, want array", i, rowAny)
		}
		record := make(map[string]any, len(fields))
		for j, fieldAny := range fields {
			field, ok := fieldAny.(string)
			if !ok {
				return nil, fmt.Errorf("export_records: unexpected field name %d is %T, want string", j, fieldAny)
			}
			if j < len(row) {
				record[field] = row[j]
			} else {
				record[field] = nil
			}
		}
		records = append(records, record)
	}
	return records, nil
}

// odooRowsToMatrix: convierte rows (dicts) a la MATRIZ alineada con fields que
// el load nativo exige (fb-019-002 field verification: load NO mapea dicts —
// wire load([fields], [[v1,v2],…])). Valor ausente en el dict → nil; una row
// no-objeto o un field no-string → error fail-loud.
func odooRowsToMatrix(rows []any, fields []any) ([]any, error) {
	matrix := make([]any, 0, len(rows))
	for i, rowAny := range rows {
		row, ok := rowAny.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("rows[%d] is %T, want object", i, rowAny)
		}
		values := make([]any, len(fields))
		for j, fieldAny := range fields {
			field, ok := fieldAny.(string)
			if !ok {
				return nil, fmt.Errorf("fields[%d] is %T, want string", j, fieldAny)
			}
			values[j] = row[field]
		}
		matrix = append(matrix, values)
	}
	return matrix, nil
}
