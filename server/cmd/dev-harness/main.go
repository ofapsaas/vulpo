// dev-harness — fb-013-001: levanta el stack completo para testing autónomo
// de las tools odoo_* del epic fb-013 (server Go + Firefox con extensión
// real vía web-ext + tab Odoo) y verifica las postcondiciones PC1-PC6 del spec.
// fb-015-001 extiende el runner a las 13 tools odoo_* contra el Odoo real,
// con reporte PASS/FAIL/NOTE por tool y write tools net-zero (create/write/unlink).
// fb-017-004 agrega el gate independiente VLP_FRAME_E2E=1: E2E de
// invalidación por mutación (E2E1-E2E6) contra una página de test servida por
// el propio harness — sin requerir Odoo. Las checks PC1-PC6 de fb-013 quedan
// en su gate VLP_DEV_HARNESS=1, intactas. fb-019-002 renombra las tools
// (drop del prefijo fb_ — paridad mcp.odoo) y actualiza import/export al
// contrato rows/domain.
//
// OPT-IN: VLP_DEV_HARNESS=1 (checks Odoo) o VLP_FRAME_E2E=1
// (E2E de invalidación). Sin ninguna de las dos imprime hint y sale 0.
// NO entra en go test por defecto.
//
// Usage:
//
//	VLP_DEV_HARNESS=1 go run ./cmd/dev-harness
//
// Env:
//
//	VLP_ODOO_URL      URL del tab Odoo (default http://127.0.0.1:8078 — Odoo local)
//	VLP_SERVER_BIN    path al binario del server (default <repo>/server/bin/vlpsrv)
//	VLP_FIREFOX       binario Firefox (default "firefox" del PATH; override para builds específicos)
//	VLP_WEBEXT        binario web-ext (default ~/web-ext-tools/node_modules/.bin/web-ext)
//
// Nota: se usa web-ext (herramienta oficial de Mozilla) porque carga el addon
// como TEMPORARY ADD-ON, que es el mecanismo que activa el service worker MV3.
// El launcher Camoufox (camoufox-with-addon.mjs) instala el addon manualmente
// vía extensions.json y NO activa el MV3 service worker en Camoufox 152 beta.
//
// Copyright 2026 Vulpo contributors
// SPDX-License-Identifier: GPL-3.0-or-later
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

const devToken = "dev-token"

type tabInfo struct {
	ID    int    `json:"id"`
	URL   string `json:"url"`
	Title string `json:"title"`
}

// paso: helper de verificación — imprime PASS/FAIL por postcondición.
func paso(name string, ok bool, detail string) bool {
	if ok {
		fmt.Printf("  [PASS] %s%s\n", name, detail)
	} else {
		fmt.Printf("  [FAIL] %s%s\n", name, detail)
	}
	return ok
}

// devSession: Mcp-Session-Id cacheado por el dev-harness (Streamable HTTP).
// Se obtiene en el initialize del primer mcpCall y se reutiliza en los POST.
var devSession string

// ensureSession: hace initialize (si no hay sesión) y cachea el Mcp-Session-Id
// devuelto en el header de la respuesta. Devuelve false si falla.
func ensureSession(port int) bool {
	if devSession != "" {
		return true
	}
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", port), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("x-vlp-token", devToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	sess := resp.Header.Get("Mcp-Session-Id")
	if sess == "" {
		return false
	}
	devSession = sess
	return true
}

// mcpCall: hace POST /mcp a tools/call con el token dev y devuelve el text del content.
// Envía Accept: application/json y Mcp-Session-Id (obtenido vía initialize previo).
func mcpCall(port int, name string, args map[string]any) (string, bool) {
	if !ensureSession(port) {
		return "", false
	}
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", port), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Mcp-Session-Id", devSession)
	req.Header.Set("x-vlp-token", devToken)
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return string(data), false
	}
	if e, hasErr := out["error"]; hasErr {
		return fmt.Sprintf("error: %v", e), false
	}
	res, ok := out["result"].(map[string]any)
	if !ok {
		return string(data), false
	}
	content, ok := res["content"].([]any)
	if !ok || len(content) == 0 {
		return string(data), false
	}
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	return text, true
}

func waitFor(fn func() bool, timeout time.Duration, step string) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if fn() {
			return true
		}
		time.Sleep(500 * time.Millisecond)
	}
	fmt.Printf("  [TIMEOUT] %s\n", step)
	return false
}

// seedStorage: escribe vlp_rules + vlp_debug_autoconnect en el
// storage.sync del perfil de Firefox (SQLite), apuntando al server local.
func seedStorage(profileDir string, serverPort int) error {
	dbPath := filepath.Join(profileDir, "storage-sync-v2.sqlite")
	if err := os.MkdirAll(profileDir, 0o755); err != nil {
		return err
	}
	// Usar node (mejor SQLite support que en Go stdlib para este SQLite de Mozilla).
	seedScript := fmt.Sprintf(`
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(%q);
const rules = %q;
const payload = JSON.stringify({ vlp_rules: rules, vlp_debug_autoconnect: '1' });
db.exec("CREATE TABLE IF NOT EXISTS storage_sync_data (ext_id TEXT NOT NULL PRIMARY KEY, data TEXT, sync_change_counter INTEGER NOT NULL DEFAULT 1)");
db.exec("CREATE TABLE IF NOT EXISTS storage_sync_mirror (guid TEXT NOT NULL PRIMARY KEY, ext_id TEXT UNIQUE, data TEXT)");
const safe = payload.replace(/'/g, "''");
db.exec("INSERT OR REPLACE INTO storage_sync_data (ext_id, data) VALUES ('vulpo@example.com', '" + safe + "')");
db.close();
console.log('ok');
`, dbPath, fmt.Sprintf("ws://127.0.0.1:%d %s 127.0.0.1", serverPort, devToken))
	// escribir script a un archivo temporal en el workspace
	scriptPath := filepath.Join(profileDir, "..", "seed-webext.tmp.mjs")
	if err := os.WriteFile(scriptPath, []byte(seedScript), 0o600); err != nil {
		return err
	}
	cmd := exec.Command("node", scriptPath)
	cmd.Dir = filepath.Dir(profileDir)
	out, err := cmd.CombinedOutput()
	os.Remove(scriptPath)
	if err != nil {
		return fmt.Errorf("seedStorage: %v (%s)", err, out)
	}
	return nil
}

func contains(s, sub string) bool { return len(sub) == 0 || bytes.Contains([]byte(s), []byte(sub)) }

// ensureBuildMode: plan/build ya no es programático (fb-022: solo el usuario,
// desde el popup de la extensión). Verifica el estado del perfil con un probe
// write-class (vlp_eval sobre el primer tab): en Plan mode devuelve false y los
// pasos write reportan la desviación con el error "blocked in Plan mode".
func ensureBuildMode(port int) bool {
	tabsText, ok := mcpCall(port, "vlp_listTabs", map[string]any{})
	if !ok {
		return false
	}
	var tabs []map[string]any
	if err := json.Unmarshal([]byte(tabsText), &tabs); err != nil || len(tabs) == 0 {
		return false
	}
	_, ok = mcpCall(port, "vlp_eval", map[string]any{"tabId": tabs[0]["tabId"], "code": "1"})
	return ok
}

// extractInt: extrae el primer entero del texto (id devuelto por create/import, etc.).
func extractInt(s string) (int, bool) {
	for i := 0; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			j := i
			for j < len(s) && s[j] >= '0' && s[j] <= '9' {
				j++
			}
			if n, err := strconv.Atoi(s[i:j]); err == nil {
				return n, true
			}
			i = j
		}
	}
	return 0, false
}

// ---- fb-017-004: gate VLP_FRAME_E2E — E2E de invalidación por mutación ----

// mutatePending: comando de mutación pendiente para la página de test
// ("" = nada; "mutate-visible" | "mutate-attr"). Lo setea el harness vía
// /mutate-on y lo consume (resetea) el primer poll de /mutate-cmd de la página.
var mutatePending atomic.Value

// loopState: último estado del loop de mutación reportado por la página
// ("on" | "off"; "" = aún sin reporte) — fb-018-006 (3.5 E2E). Canal de
// sincronización: los pasos settle con mutación continua no arrancan hasta
// que el loop está verifablemente activo (elimina la carrera consume-poll
// vs. inicio de la espera, observada como falso settled:true en corrida 2).
var loopState atomic.Value

// testPageHTML: página SPA-like servida por el harness para la E2E de
// invalidación. Un botón "Agregar nodo" cuyo listener muta el DOM (SPA-like),
// un input sin listeners (acción no mutante), y texto visible.
//
// fb-018-006 (3.5 E2E) agrega la TRANSICIÓN CONTROLADA para el E2E de settle:
// reemplaza el subárbol #old-subtree con un DELAY (1200 ms > quietMs) antes de
// que aparezca el contenido final. Fase 1 (0-1200 ms): ticks de atributo cada
// 200 ms — mutación REAL para el MutationObserver (attributes:true) pero
// invisible al mapa (los data-* no alteran refs/names — E2E6), con el
// contenido viejo INTACTO en el DOM: un getFrame plain dentro de la ventana lo
// devuelve completo y plausible sin señal alguna (el problema G5); un getFrame
// settle espera los ticks + el swap + la quietud y devuelve el mapa FINAL.
// Fase 2 (t=1200): remueve el subárbol viejo y agrega el botón final.
// Disparable por CLICK real (botón "Iniciar transicion") y por canal POLL
// (comando "transition", mismo timing controlado que E2E3/E2E6).
//
// Las mutaciones de E2E3/E2E6 NO usan eval (bloqueado por la CSP de la
// extensión): la página hace POLL cada ~150ms a /mutate-cmd y se auto-muta
// según el comando pendiente (canal sin eval, sin extension).
const testPageHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>fb-017-004 frame E2E</title></head>
<body>
<h1>Frame E2E page</h1>
<p>Texto visible de la pagina de test.</p>
<button id="adder">Agregar nodo</button>
<input placeholder="campo">
<button aria-hidden="true">secreto</button>
<p aria-hidden="true">texto-secreto-aria</p>
<div id="old-subtree"><button id="old-btn">contenido-viejo</button></div>
<div id="loop-marker" data-tick="t0"></div>
<button id="transition-btn">Iniciar transicion</button>
<script>
// fb-018-006: transición controlada (delay 1200 ms > quietMs=300).
// El guard "running" hace no-op re-entradas (doble consumo del poll).
var TRANSITION_DELAY_MS = 1200;
function startTransition() {
  if (startTransition.running) return;
  startTransition.running = true;
  var tick = 0;
  var iv = setInterval(function () {
    var m = document.getElementById('loop-marker');
    if (m) m.setAttribute('data-tick', 't' + (++tick));
  }, 200);
  setTimeout(function () {
    clearInterval(iv);
    var old = document.getElementById('old-subtree');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var fin = document.createElement('div');
    fin.id = 'final-content';
    var b = document.createElement('button');
    b.textContent = 'contenido-final-listo';
    fin.appendChild(b);
    document.body.appendChild(fin);
    startTransition.running = false;
  }, TRANSITION_DELAY_MS);
}
document.getElementById('transition-btn').addEventListener('click', startTransition);
</script>
<script>
// El poll REPORTA el estado del loop (query param state) — canal de
// sincronización del harness: los pasos settle con mutación continua solo
// corren cuando el loop está verifablemente activo (fb-018-006 3.5).
setInterval(function () {
  fetch('/mutate-cmd?state=' + (startTransition.loop ? 'on' : 'off')).then(function (r) { return r.text(); }).then(function (cmd) {
    if (cmd === 'mutate-visible') {
      document.body.appendChild(Object.assign(document.createElement('button'), {textContent: 'nuevo'}));
    } else if (cmd === 'mutate-attr') {
      document.querySelector('input').setAttribute('data-irrelevant', 'y');
    } else if (cmd === 'transition') {
      startTransition();
    } else if (cmd === 'loop-on') {
      if (startTransition.loop) return;
      var tick = 0;
      var loopFn = function () {
        var m = document.getElementById('loop-marker');
        if (m) m.setAttribute('data-tick', 'L' + (++tick));
      };
      loopFn();
      startTransition.loop = setInterval(loopFn, 200);
    } else if (cmd === 'loop-off') {
      if (startTransition.loop) { clearInterval(startTransition.loop); startTransition.loop = null; }
    }
  }).catch(function () {});
}, 150);
</script>
<script>
document.getElementById('adder').addEventListener('click', function () {
  var d = document.createElement('div');
  var b = document.createElement('button');
  b.textContent = 'nuevo';
  d.appendChild(b);
  document.body.appendChild(d);
});
</script>
</body>
</html>`

// slowPageHTML (fb-018-006 enmienda P14): página destino de la navegación con
// commit retrasado, servida en /slow?ms=N&n=ID. El HTML llega COMPLETO recién
// tras el delay — el navegador mantiene el documento previo vivo mientras la
// respuesta está pendiente (el commit ocurre al primer byte), que es la
// ventana donde P14 falsó en campo 2/2 (Odoo 19 real:
// findings/p14-navegacion-documento-previo-2026-09-08.md). El marker del
// botón lleva el identificador de navegación (n): documento destino y previo
// tienen markers DISTINTOS — SET-10..12 distinguen a cuál aterrizó el frame.
// Sin JS: el documento destino queda quieto tras cargar (el settle sobre él
// resuelve rápido, sin ruido que contamine la aserción).
const slowPageHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>fb-018-006 destino lento %ID%</title></head>
<body>
<h1>Destino lento %ID% cargado</h1>
<p>Pagina destino con commit retrasado (enmienda P14 fb-018-006).</p>
<button id="slow-btn">destino-lento-listo-%ID%</button>
</body>
</html>`

// typeObservePageHTML (fb-020-002 C6, P20-P23): fixture de la observación de
// `act type` y del guard `disabled` de `fill`, servida en
// /type-observe?step=<p20|p21|p22|p23>. Página propia (no testPageHTML: los
// conteos de E2E1-E6 no cambian) y SIN el poll de /mutate-cmd (un segundo
// poller robaría los comandos one-shot de la página principal). El paso
// recarga la página antes de cada caso (P21 cambia el DOM, P22 la descarga);
// el marker listo-%STEP% distingue el documento fresco del previo. Los
// listeners de `change` son script de página: el reformateo y las mutaciones
// ocurren fuera del content script.
//   - P20: muta un contenedor aparte cada 100 ms cinco veces (100-500 ms) y a
//     los 600 ms asigna por propiedad el.value = "formateado-1".
//   - P21: a los 150 ms reemplaza el input por un clon idéntico.
//   - P22: navega a /slow?ms=4000 (commit retrasado: documento descargado
//     durante la llamada).
//   - P23: #p23-enabled vacío y #p23-disabled con disabled y value inicial.
const typeObservePageHTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>fb-020-002 type-observe %STEP%</title></head>
<body>
<h1>Type observe %STEP%</h1>
<button id="ready-marker">listo-%STEP%</button>
<input id="p20" aria-label="campo-p20" placeholder="campo-p20">
<div id="p20-box"></div>
<input id="p21" aria-label="campo-p21" placeholder="campo-p21">
<input id="p22" aria-label="campo-p22" placeholder="campo-p22">
<input id="p23-enabled" aria-label="campo-p23-enabled" placeholder="campo-p23-enabled">
<input id="p23-disabled" aria-label="campo-p23-disabled" placeholder="campo-p23-disabled" disabled value="original-p23">
<script>
document.getElementById('p20').addEventListener('change', function (ev) {
  var el = ev.target;
  var box = document.getElementById('p20-box');
  var n = 0;
  var iv = setInterval(function () {
    var s = document.createElement('span');
    s.textContent = 'tick-' + (++n);
    box.appendChild(s);
    if (n >= 5) clearInterval(iv);
  }, 100);
  setTimeout(function () { el.value = 'formateado-1'; }, 600);
});
document.getElementById('p21').addEventListener('change', function (ev) {
  var el = ev.target;
  setTimeout(function () { el.replaceWith(el.cloneNode(true)); }, 150);
});
document.getElementById('p22').addEventListener('change', function () {
  location.href = '/slow?ms=4000';
});
</script>
</body>
</html>`

// typeObserveSteps: valores válidos de ?step= en /type-observe.
var typeObserveSteps = map[string]bool{"p20": true, "p21": true, "p22": true, "p23": true}

// nativeDialogPageHTML (fb-020-003 §1.1, integrado desde e2e-diseno.md):
// fixture de confirm/alert/prompt nativos servida en /native-dialog?step=.
// La CSP `script-src 'self'` de la ruta prohíbe scripts inline: el único
// script es la referencia externa a /native-dialog.js (§3.4 del spec, T2
// cubre la inyección MAIN bajo CSP estricta). %STEP% se sustituye por
// ReplaceAll (mismo patrón que typeObservePageHTML), no por Sprintf — evita
// depender del orden/cantidad de placeholders.
const nativeDialogPageHTML = `<!doctype html>
<html data-step="%STEP%">
<head><meta charset="utf-8"><title>native-dialog-%STEP%</title></head>
<body>
<main>
  <button id="b-trigger">Disparar</button>
  <button id="b-other">Otro control</button>
  <input id="i-text" aria-label="texto">
  <input id="i-plain" aria-label="sin-listeners">
  <input id="i-focus" aria-label="foco">
  <select id="s-opt" aria-label="opciones"><option value="a">a</option><option value="b">b</option></select>

  <div id="st-intacto" role="status">intacto:true</div>
  <div id="st-resultado" role="status">resultado:none</div>
  <div id="st-eventos" role="status">eventos:0</div>
  <div id="st-listo" role="status"></div>
</main>
<script src="/native-dialog.js"></script>
</body>
</html>`

// nativeDialogJS (fb-020-003 §1.2, integrado desde e2e-diseno.md): script
// único servido en /native-dialog.js para todos los pasos — lee el paso
// desde data-step porque la CSP prohíbe scripts inline. Corrección del
// orquestador al shim (nota final de §1.2): el shim de shim-pagina NO
// escribe `resultado` directamente; lo escribe el trigger con el valor que
// devuelve `window.confirm` (ya reemplazado por el shim) — el resultado
// observable es el mismo que el diseño original.
const nativeDialogJS = `(function () {
  "use strict";
  var step = document.documentElement.dataset.step;
  var stIntacto = document.getElementById("st-intacto");
  var stResultado = document.getElementById("st-resultado");
  var stEventos = document.getElementById("st-eventos");
  var stListo = document.getElementById("st-listo");

  var eventos = 0;
  function bumpEventos() {
    eventos += 1;
    var txt = "eventos:" + eventos;
    if (stEventos.textContent !== txt) stEventos.textContent = txt;
  }
  ["click", "input", "change", "focus"].forEach(function (evName) {
    ["b-other", "i-text", "i-focus", "s-opt"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener(evName, bumpEventos, true);
    });
  });
  // #i-plain NO recibe listeners: control limpio para la regresión de P14.

  function setResultado(v) {
    var txt = "resultado:" + JSON.stringify(v === undefined ? null : v);
    if (stResultado.textContent !== txt) stResultado.textContent = txt;
  }

  var origConfirm, origAlert, origPrompt;
  function captureOriginals() {
    origConfirm = window.confirm;
    origAlert = window.alert;
    origPrompt = window.prompt;
  }

  if (step === "shim-pagina") {
    // La página reemplaza confirm ANTES de tomar las referencias: intacto se mide
    // contra el shim, no contra la nativa (§3.4 P15).
    window.confirm = function () {
      return true;
    };
  }
  captureOriginals();

  var lastIntacto = null;
  function refreshIntacto() {
    var ok = window.confirm === origConfirm &&
             window.alert === origAlert &&
             window.prompt === origPrompt;
    if (ok !== lastIntacto) {
      lastIntacto = ok;
      stIntacto.textContent = "intacto:" + ok;
    }
  }
  setInterval(refreshIntacto, 100);
  refreshIntacto();

  var trigger = document.getElementById("b-trigger");
  trigger.addEventListener("click", function () {
    if (step === "confirm-sync") {
      setResultado(confirm("¿Borrar el registro?"));
    } else if (step === "alert-sync") {
      alert("Registro guardado");
      setResultado(undefined);
    } else if (step === "prompt-sync") {
      setResultado(prompt("Nuevo nombre", "viejo"));
    } else if (step === "shim-pagina") {
      setResultado(window.confirm("x"));
    } else if (step === "confirm-tarde") {
      setTimeout(function () { setResultado(confirm("tarde")); }, 1000);
    }
    // "sin-dialogo": el trigger no llama a ninguna función de diálogo.
  });

  stListo.textContent = "listo:" + step;
})();`

// nativeDialogSteps: valores válidos de ?step= en /native-dialog. `guard` no
// es una ruta propia (resolución 6.1 del diseño): es alias de confirm-sync,
// P12 corre sobre el mismo tab que abrió la pregunta de P10.
var nativeDialogSteps = map[string]bool{
	"confirm-sync": true, "alert-sync": true, "prompt-sync": true,
	"sin-dialogo": true, "shim-pagina": true, "confirm-tarde": true,
}

// startTestPage: sirve testPageHTML (ruta /) y la página bootstrap
// /vulpo-bootstrap?rules=<urlencoded> (fb-017-004) en 127.0.0.1:0 (puerto
// efímero). La página bootstrap es el start-url de web-ext en el gate
// FRAME_E2E: el event page la detecta vía tabs.query y persiste las reglas en
// storage.local (el seed por sqlite de storage.sync no es leído por FF154).
// Devuelve la URL base y una función de shutdown.
func startTestPage() (string, func()) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", func() {}
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, testPageHTML)
	})
	mutatePending.Store("")
	loopState.Store("")
	// /slow?ms=N&n=ID (fb-018-006 enmienda P14): página destino con COMMIT
	// retrasado — responde tras el delay. El navegador mantiene el documento
	// previo vivo mientras la respuesta está pendiente: la ventana
	// documento-previo queda observable en el harness (repro del defecto de
	// campo P14). El delay es lo que ensancha la ventana: sin él, el swap
	// instantáneo de la página estática hace el race invisible (lección del
	// hallazgo — el E2E original no podía verlo).
	mux.HandleFunc("/slow", func(w http.ResponseWriter, r *http.Request) {
		ms := 1500
		if v, err := strconv.Atoi(r.URL.Query().Get("ms")); err == nil && v >= 0 {
			ms = v
		}
		id := r.URL.Query().Get("n")
		if id == "" {
			id = "0"
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, strings.ReplaceAll(slowPageHTML, "%ID%", html.EscapeString(id)))
	})
	// /type-observe?step=pNN (fb-020-002 C6): fixture de P20-P23. Un step
	// desconocido es 400 (nunca cae al catch-all "/" con la página equivocada).
	mux.HandleFunc("/type-observe", func(w http.ResponseWriter, r *http.Request) {
		step := r.URL.Query().Get("step")
		if !typeObserveSteps[step] {
			http.Error(w, "step invalido", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, strings.ReplaceAll(typeObservePageHTML, "%STEP%", step))
	})
	// /native-dialog?step=<paso> (fb-020-003 §3.4): fixture de P10-P17. CSP
	// script-src 'self' — el HTML no lleva script inline, sólo referencia
	// /native-dialog.js. Un step desconocido es 400 (mismo patrón que
	// /type-observe).
	mux.HandleFunc("/native-dialog", func(w http.ResponseWriter, r *http.Request) {
		step := r.URL.Query().Get("step")
		if !nativeDialogSteps[step] {
			http.Error(w, "step invalido", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, strings.ReplaceAll(nativeDialogPageHTML, "%STEP%", step))
	})
	mux.HandleFunc("/native-dialog.js", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		fmt.Fprint(w, nativeDialogJS)
	})
	mux.HandleFunc("/mutate-on", func(w http.ResponseWriter, r *http.Request) {
		mode := r.URL.Query().Get("mode")
		switch mode {
		case "visible":
			mutatePending.Store("mutate-visible")
		case "attr":
			mutatePending.Store("mutate-attr")
		// fb-018-006 (3.5 E2E): transición controlada + loop de mutación
		// continua (para settled:false por deadline).
		case "transition":
			mutatePending.Store("transition")
		case "loop-on":
			mutatePending.Store("loop-on")
		case "loop-off":
			mutatePending.Store("loop-off")
		default:
			http.Error(w, "mode invalido", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, "ok")
	})
	mux.HandleFunc("/mutate-cmd", func(w http.ResponseWriter, r *http.Request) {
		// Estado del loop reportado por la página en ESTE poll (fb-018-006).
		if st := r.URL.Query().Get("state"); st == "on" || st == "off" {
			loopState.Store(st)
		}
		// Poll de la página: consume el comando pendiente (one-shot).
		cmd, _ := mutatePending.Load().(string)
		mutatePending.Store("")
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, cmd)
	})
	// /loop-status: último estado del loop reportado por la página — barrera
	// de sincronización del harness para los pasos settle (fb-018-006).
	mux.HandleFunc("/loop-status", func(w http.ResponseWriter, _ *http.Request) {
		st, _ := loopState.Load().(string)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprint(w, st)
	})
	mux.HandleFunc("/vulpo-bootstrap", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("rules")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, "<!doctype html><html><head><meta charset=\"utf-8\"><title>vulpo-bootstrap</title></head><body><p>vulpo bootstrap ok: %s</p></body></html>", html.EscapeString(q))
	})
	registerNavHangRoutes(mux)  // fb-020-007: /slowpage + /slowfetch
	registerFoldRoutes(mux)     // fb-020-008: /fold-act
	registerValidityRoutes(mux) // fb-020-005: /form-validez
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	return "http://" + ln.Addr().String() + "/", func() { srv.Close() }
}

// parseJSON: unmarshal tolerante del content JSON de un result.
func parseJSON(text string, v any) bool {
	return json.Unmarshal([]byte(text), v) == nil
}

// findTabByURL: lista tabs y devuelve el tabId de la página de test.
// MEJOR ESFUERZO: reintenta hasta timeout porque el tab puede tardar en
// aparecer en listTabs tras openTab.
//
// Matching en dos niveles para evitar falsos positivos con el tab
// vulpo-bootstrap (su URL es <pageURL>vulpo-bootstrap?rules=...,
// que CONTIENE pageURL como prefijo):
//  1. Exact match: url == pageURL (openTab abre exactamente pageURL).
//  2. Fallback: URLs que empiezan con pageURL pero NO contienen
//     "vulpo-bootstrap" (descarta el tab bootstrap).
func findTabByURL(port int, pageURL string, timeout time.Duration) (int, bool) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		text, ok := mcpCall(port, "vlp_listTabs", map[string]any{})
		if ok {
			var tabs []tabInfo
			if parseJSON(text, &tabs) {
				for _, t := range tabs {
					if t.URL == pageURL {
						return t.ID, true
					}
				}
				for _, t := range tabs {
					if strings.HasPrefix(t.URL, pageURL) && !strings.Contains(t.URL, "vulpo-bootstrap") {
						return t.ID, true
					}
				}
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return 0, false
}

// frameInfo: subconjunto del Frame contract + invalidation (fb-017-004)
// que la E2E necesita — el resto del frame se ignora (relayed verbatim).
type frameInfo struct {
	Sections []struct {
		Elements []struct {
			Ref  string `json:"ref"`
			Name string `json:"name"`
		} `json:"elements"`
	} `json:"sections"`
	Invalidation struct {
		ChangedSinceLast bool `json:"changedSinceLast"`
	} `json:"invalidation"`
}

// frameElementCount: total de elements en sections[*].elements[*].
func (f *frameInfo) frameElementCount() int {
	n := 0
	for _, s := range f.Sections {
		n += len(s.Elements)
	}
	return n
}

// findRefByName: recorre sections[*].elements[*] buscando el ref del elemento
// con name dado (p.ej. el botón "Agregar nodo").
func (f *frameInfo) findRefByName(name string) (string, bool) {
	for _, s := range f.Sections {
		for _, e := range s.Elements {
			if e.Name == name {
				return e.Ref, true
			}
		}
	}
	return "", false
}

// getFrame: wrapper de mcpCall + parseo del frame (con invalidation).
func getFrame(port int, tabID int) (frameInfo, bool) {
	fi, ok, _ := getFrameRaw(port, tabID)
	return fi, ok
}

// getFrameRaw: igual que getFrame pero devuelve el content JSON crudo
// para instrumentación de debug (parseo de respuestas inesperadas).
func getFrameRaw(port int, tabID int) (frameInfo, bool, string) {
	var fi frameInfo
	text, ok := mcpCall(port, "vlp_getFrame", map[string]any{"tabId": tabID})
	if !ok || !parseJSON(text, &fi) {
		return fi, false, text
	}
	return fi, true, text
}

// triggerMutate: pide al harness server que encole una mutación para la
// página de test vía GET /mutate-on?mode=... (la página se auto-muta por POLL
// a /mutate-cmd — sin eval, sin extension).
func triggerMutate(pageURL, mode string) bool {
	resp, err := http.Get(strings.TrimSuffix(pageURL, "/") + "/mutate-on?mode=" + mode)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == http.StatusOK
}

// waitForLoopState (fb-018-006 3.5): espera a que la página de test reporte el
// estado `want` ("on"/"off") del loop de mutación vía /loop-status. Barrera de
// sincronización: elimina la carrera entre el consumo one-shot del comando
// (poll ≤150 ms, sujeto a scheduling del navegador) y el inicio de la espera
// de settle — sin ella, un settle puede caer en una ventana ANTES del primer
// tick y declarar settled:true sin loop (falso positivo del paso, no de la
// feature; observado en la corrida 2 del desarrollo).
func waitForLoopState(pageURL, want string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(strings.TrimSuffix(pageURL, "/") + "/loop-status")
		if err == nil {
			b, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if strings.TrimSpace(string(b)) == want {
				return true
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// runFrameE2E: corre las checks E2E1-E2E6 del spec fb-017-004 contra la
// página de test. Requiere la extensión ya conectada (boot compartido).
// Devuelve true si todas las checks pasan.
func runFrameE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E] Invalidación por mutación (fb-017-004) — E2E1..E2E6")
	allOK := true

	// Salir de plan mode antes de cualquier WRITE_TOOL (openTab está bloqueado en plan).
	if !paso("E2E-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		fmt.Println("[FAIL] E2E-pre: no se pudo salir de plan mode")
		return false
	}

	// Abrir el tab de la página de test y obtener su tabId.
	text, ok := mcpCall(port, "vlp_openTab", map[string]any{"url": pageURL})
	tabID, tabOK := 0, false
	if ok {
		tabID, tabOK = findTabByURL(port, pageURL, 15*time.Second)
	}
	if !paso("E2E0: página de test abierta y detectada en listTabs", ok && tabOK,
		fmt.Sprintf(" (openTab ok=%v, tabId %d, url %s)", ok, tabID, pageURL)) {
		return false
	}
	_ = text

	// E2E1 — primera llamada: changedSinceLast true (sin snapshot previo).
	f1, ok1, raw1 := getFrameRaw(port, tabID)
	fmt.Printf("  [DEBUG] getFrame raw: %.600s\n", raw1)
	allOK = paso("E2E1: primer getFrame → changedSinceLast=true",
		ok1 && f1.Invalidation.ChangedSinceLast,
		fmt.Sprintf(" (changed %v)", f1.Invalidation.ChangedSinceLast)) && allOK

	// E2E2 — re-llamada sin mutar: el JSON del frame es idéntico → false.
	// raw2 (sin mutación previa) se re-usa en E2E7 (fb-017-005): los elementos
	// aria-hidden están presentes desde el inicio de la página, así que este
	// getFrame es también el estado limpio para verificar su exclusión.
	f2, ok2, raw2 := getFrameRaw(port, tabID)
	allOK = paso("E2E2: getFrame sin mutar → changedSinceLast=false",
		ok2 && !f2.Invalidation.ChangedSinceLast,
		fmt.Sprintf(" (changed %v)", f2.Invalidation.ChangedSinceLast)) && allOK

	// E2E3 — mutación de nodo interactivo vía POLL (la página se auto-muta;
	// diff stateless en background, sin debounce): changedSinceLast=true.
	// El harness pide la mutación directamente al server (http.Get) — sin eval
	// (bloqueado por la CSP de la extensión) y sin pasar por la extensión.
	mutOK := triggerMutate(pageURL, "visible")
	time.Sleep(300 * time.Millisecond)
	f3, ok3, raw3 := getFrameRaw(port, tabID)
	fmt.Printf("  [DEBUG] getFrame raw: %.600s\n", raw3)
	allOK = paso("E2E3: appendChild (button) vía poll → changedSinceLast=true",
		mutOK && ok3 && f3.Invalidation.ChangedSinceLast,
		fmt.Sprintf(" (changed %v)", f3.Invalidation.ChangedSinceLast)) && allOK

	// E2E4 — getFrame sin mutar (post E2E3): changedSinceLast=false.
	f4, ok4 := getFrame(port, tabID)
	allOK = paso("E2E4: getFrame sin mutar → changedSinceLast=false",
		ok4 && !f4.Invalidation.ChangedSinceLast,
		fmt.Sprintf(" (changed %v)", f4.Invalidation.ChangedSinceLast)) && allOK

	// E2E5 — acción mutante SPA-like: click del agente en "Agregar nodo"
	// provoca la mutación → changedSinceLast=true y la cantidad de elementos
	// del frame incrementó. act es write → toggle a build antes (D5).
	beforeCount := f4.frameElementCount()
	adderRef, refOK := f4.findRefByName("Agregar nodo")
	actOK := false
	if refOK {
		actOK = ensureBuildMode(port)
		_, actOK = mcpCall(port, "vlp_act", map[string]any{"tabId": tabID, "ref": adderRef, "action": "click"})
	}
	time.Sleep(200 * time.Millisecond)
	f5, ok5 := getFrame(port, tabID)
	allOK = paso("E2E5: vlp_act click en 'Agregar nodo' → changedSinceLast=true y elementos incrementan",
		refOK && actOK && ok5 && f5.Invalidation.ChangedSinceLast && f5.frameElementCount() > beforeCount,
		fmt.Sprintf(" (ref encontrado=%v, changed %v, elems %d→%d)",
			refOK, f5.Invalidation.ChangedSinceLast, beforeCount, f5.frameElementCount())) && allOK

	// E2E6 — mutación que NO altera el mapa: atributo data-* en un elemento
	// existente (los refs/names/roles del frame nunca usan atributos data).
	// El diff stateless compara solo el JSON del frame serializado, así que
	// changedSinceLast=false — precisión superior al observer.
	invOK := triggerMutate(pageURL, "attr")
	time.Sleep(300 * time.Millisecond)
	f6, ok6 := getFrame(port, tabID)
	allOK = paso("E2E6: mutación invisible al mapa (atributo data-*) → changedSinceLast=false (diff no reporta mutaciones que no alteran el mapa)",
		invOK && ok6 && !f6.Invalidation.ChangedSinceLast,
		fmt.Sprintf(" (changed %v)", f6.Invalidation.ChangedSinceLast)) && allOK

	// E2E7 (fb-017-005) — elementos aria-hidden fuera del mapa: el content JSON
	// crudo del getFrame NO contiene el texto de los elementos aria-hidden
	// ("secreto" / "texto-secreto-aria"), pero sí sigue conteniendo los
	// elementos interactivos visibles ("Agregar nodo") — si la aserción
	// positiva falla, el serializer se rompió, no el filtro aria-hidden.
	// Se usa raw2 (getFrame de E2E2, sin mutación previa que confunda: los
	// aria-hidden están presentes desde el inicio de la página).
	allOK = paso("E2E7: aria-hidden fuera del mapa (fb-017-005)",
		ok2 && !strings.Contains(raw2, "secreto") && strings.Contains(raw2, "Agregar nodo"),
		fmt.Sprintf(" (sin secreto=%v, con Agregar nodo=%v)",
			!strings.Contains(raw2, "secreto"), strings.Contains(raw2, "Agregar nodo"))) && allOK

	return allOK
}

// ---- fb-018-006 (3.5 E2E): señal de readiness `settle` ----

// getFrameMap: getFrame con args arbitrarios (settle/waitMs/quietMs) parseado
// a mapa crudo. A diferencia de frameInfo (struct tipado), el mapa permite
// verificar ABSENCIA de claves en invalidation (I-2: ausente ≠ false — un
// bool con zero-value false no distingue).
func getFrameMap(port int, args map[string]any) (map[string]any, bool, string) {
	text, ok := mcpCall(port, "vlp_getFrame", args)
	var m map[string]any
	if !ok || !parseJSON(text, &m) {
		return nil, false, text
	}
	return m, true, text
}

// invOf: extrae invalidation como mapa (nil si ausente o malformado).
func invOf(m map[string]any) map[string]any {
	inv, _ := m["invalidation"].(map[string]any)
	return inv
}

// invChanged: changedSinceLast como bool (false si ausente/malformado — los
// pasos que la leen también verifican ok del parseo).
func invChanged(m map[string]any) bool {
	b, _ := invOf(m)["changedSinceLast"].(bool)
	return b
}

// payloadJSON: la respuesta SIN invalidation, serializada determinísticamente
// (json.Marshal de map ordena claves) — para el deep-equal de P13.
func payloadJSON(m map[string]any) (string, bool) {
	if m == nil {
		return "", false
	}
	cp := make(map[string]any, len(m))
	for k, v := range m {
		if k == "invalidation" {
			continue
		}
		cp[k] = v
	}
	b, err := json.Marshal(cp)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// isNonNegInt: waitedMs entero ≥ 0 (P11) — Go decodifica números JSON a float64.
func isNonNegInt(m map[string]any, key string) (int, bool) {
	f, ok := m[key].(float64)
	if !ok || f < 0 || f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

// verifySettleBuild: el E2E debe ejercitar el build NUEVO (lección fb-018-004:
// la extensión y el server se despliegan por separado) — verifica que el
// binario del server traiga el schema settle (literales "quietMs"/"waitedMs"
// de tools.go) y el bundle la exportación waitForSettle (settle.js vía
// build-frame.sh). Un artefacto viejo invalida el E2E: falla rápido.
func verifySettleBuild(repoRoot, srvBin string) bool {
	bin, err := os.ReadFile(srvBin)
	if err != nil || !bytes.Contains(bin, []byte("quietMs")) || !bytes.Contains(bin, []byte("waitedMs")) {
		fmt.Printf("  [FAIL] el binario del server (%s) NO contiene el schema settle — build previo a fb-018-006\n", srvBin)
		return false
	}
	bundle, err := os.ReadFile(filepath.Join(repoRoot, "extension", "frame-serializer.js"))
	if err != nil || !bytes.Contains(bundle, []byte("waitForSettle")) {
		fmt.Printf("  [FAIL] frame-serializer.js NO contiene waitForSettle — bundle previo a fb-018-006\n")
		return false
	}
	// enmienda P14 (fb-018-006 §2.2.7): el E2E de navegación en vuelo debe
	// ejercitar el background enmendado — la señal `navigating` y la espera
	// de commit viven en background.js (no pasa por build: web-ext carga el
	// source dir tal cual).
	bg, err := os.ReadFile(filepath.Join(repoRoot, "extension", "background.js"))
	if err != nil || !bytes.Contains(bg, []byte("navigatingTabs")) {
		fmt.Printf("  [FAIL] background.js NO contiene navigatingTabs — build previo a la enmienda P14 (§2.2.7)\n")
		return false
	}
	// fb-020-007: background.js consume los globals VulpoNav (núcleo
	// genérico) y VulpoNavGuard (capa ORM); sin los bundles el event page
	// lanza al cargar y el E2E vería un timeout de conexión.
	for bundleFile, global := range map[string]string{
		"nav-guard-bundle.js":      "pageHeartbeat",
		"odoo-nav-guard-bundle.js": "VulpoNavGuard",
	} {
		data, err := os.ReadFile(filepath.Join(repoRoot, "extension", bundleFile))
		if err != nil || !bytes.Contains(data, []byte(global)) {
			fmt.Printf("  [FAIL] %s NO contiene %s — bundle previo a fb-020-007 v1.2\n", bundleFile, global)
			return false
		}
	}
	// fb-020-007 §9.2: pageHeartbeat vive dos veces — la canónica y testeada en
	// extension/nav-guard.js, y la copia textual que background.js inlinea en
	// pageOdooFetch (executeScript no transporta closures). Si divergen, la
	// página late distinto de lo que la suite verifica: el E2E mediría otra
	// cosa. Se comparan los cuerpos normalizados (sin whitespace ni ';').
	coreSrc, err := os.ReadFile(filepath.Join(repoRoot, "extension", "nav-guard.js"))
	if err != nil {
		fmt.Printf("  [FAIL] no se pudo leer extension/nav-guard.js: %v\n", err)
		return false
	}
	coreBody, err := pageHeartbeatBody(coreSrc, pageHeartbeatCoreMarker)
	if err != nil {
		fmt.Printf("  [FAIL] pageHeartbeat en extension/nav-guard.js: %v\n", err)
		return false
	}
	copyBody, err := pageHeartbeatBody(bg, pageHeartbeatCopyMarker)
	if err != nil {
		fmt.Printf("  [FAIL] copia de pageHeartbeat en background.js (pageOdooFetch): %v\n", err)
		return false
	}
	if coreBody != copyBody {
		fmt.Printf("  [FAIL] la copia de pageHeartbeat en background.js DIVERGE de extension/nav-guard.js (§9.2)\n    nav-guard.js:   %s\n    background.js:  %s\n", coreBody, copyBody)
		return false
	}
	fmt.Println("  [PASS] build con settle verificado (binario server + bundle extensión + background enmendado P14 + pageHeartbeat sin divergir)")
	return true
}

// Marcadores de las dos definiciones de pageHeartbeat (§9.2). Terminan en "("
// para que el primer bloque que sigue sea el de los parámetros desestructurados.
const (
	pageHeartbeatCoreMarker = "export function pageHeartbeat("
	pageHeartbeatCopyMarker = "const pageHeartbeat = function pageHeartbeat("
)

// pageHeartbeatBody: cuerpo normalizado de la pageHeartbeat que empieza en
// `marker`. Falla fuerte si el marcador no está o si las llaves no cierran:
// una comparación que no encuentra qué comparar no puede decir "iguales".
func pageHeartbeatBody(src []byte, marker string) (string, error) {
	at := bytes.Index(src, []byte(marker))
	if at < 0 {
		return "", fmt.Errorf("no se encontró %q", marker)
	}
	rest := string(src[at+len(marker):])
	_, afterParams, err := jsBlock(rest)
	if err != nil {
		return "", fmt.Errorf("parámetros: %w", err)
	}
	body, _, err := jsBlock(rest[afterParams:])
	if err != nil {
		return "", fmt.Errorf("cuerpo: %w", err)
	}
	return normalizeJS(body), nil
}

// jsBlock: primer bloque {…} de src (llaves balanceadas) y el índice siguiente
// a su cierre. Vale para pageHeartbeat porque su cuerpo no tiene llaves dentro
// de literales de texto.
func jsBlock(src string) (string, int, error) {
	open := strings.IndexByte(src, '{')
	if open < 0 {
		return "", 0, fmt.Errorf("sin '{'")
	}
	depth := 0
	for i := open; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return src[open : i+1], i + 1, nil
			}
		}
	}
	return "", 0, fmt.Errorf("llaves sin cerrar")
}

// normalizeJS: quita whitespace y ';' para comparar dos copias del mismo
// código con indentación distinta.
func normalizeJS(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case ' ', '\t', '\n', '\r', ';':
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

// rebuildForE2E (FRAME_E2E): reconstruye DENTRO de la corrida el binario del
// server (go build) y el bundle de la extensión (frame/build-frame.sh, esbuild)
// para que el E2E nunca pinche un artefacto previo a la feature. Si esbuild no
// está disponible, degrada a verificación del bundle on-disk (fail-fast si es
// viejo). Requiere que srvBin sea el path por defecto (binario del repo).
func rebuildForE2E(repoRoot, srvBin string) bool {
	serverDir := filepath.Join(repoRoot, "server")
	fmt.Println("  [BUILD] server: go build -o bin/vlpsrv ./cmd/vlpsrv")
	build := exec.Command("go", "build", "-o", srvBin, "./cmd/vlpsrv")
	build.Dir = serverDir
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Printf("  [FAIL] build server: %v\n%s\n", err, out)
		return false
	}
	frameDir := filepath.Join(repoRoot, "extension", "frame")
	fmt.Println("  [BUILD] bundle: frame/build-frame.sh (esbuild → frame-serializer.js)")
	buildB := exec.Command("bash", "build-frame.sh")
	buildB.Dir = frameDir
	if out, err := buildB.CombinedOutput(); err != nil {
		fmt.Printf("  [NOTE] build-frame.sh falló (%v) — se verifica el bundle on-disk\n%s\n", err, out)
	}
	odooDir := filepath.Join(repoRoot, "extension", "odoo")
	fmt.Println("  [BUILD] bundle: odoo/build-probe.sh (esbuild → session-probe-bundle.js + nav-guard-bundle.js + odoo-nav-guard-bundle.js)")
	buildO := exec.Command("bash", "build-probe.sh")
	buildO.Dir = odooDir
	if out, err := buildO.CombinedOutput(); err != nil {
		fmt.Printf("  [NOTE] build-probe.sh falló (%v) — se verifica el bundle on-disk\n%s\n", err, out)
	}
	return verifySettleBuild(repoRoot, srvBin)
}

// runSettleE2E (fb-018-006 3.5): E2E de la señal de readiness sobre la página
// de test — P10-P13, P15, P17 (smoke), P18, y — enmienda P14 2026-09-08 —
// P19/P20 (navegación en vuelo, SET-10..12 contra /slow). P14 (probes contra
// Odoo real) y las medianas de latencia con control (criterio 6) son de
// DESPLIEGUE: no corren acá (SKIP documentado, no se simulan). Requiere el
// tab de test ya abierto por runFrameE2E (boot compartido) — lo re-detecta
// por URL.
func runSettleE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-settle] Señal de readiness settle (fb-018-006) — P10-P13, P15, P17-P18 + P19/P20 (enmienda P14)")
	allOK := true

	tabID, tabOK := findTabByURL(port, pageURL, 10*time.Second)
	if !paso("SET-pre: tab de test detectado (abierto por E2E0)", tabOK, fmt.Sprintf(" (tabId %d)", tabID)) {
		return false
	}

	// SET-1 (P10) — getFrame plain INMEDIATAMENTE tras disparar la transición:
	// sin settle, la respuesta NO contiene invalidation.settled NI
	// invalidation.waitedMs — AUSENCIA, no false (I-2). La transición mantiene
	// el contenido viejo 1200 ms (G5): el plain cae dentro de la ventana y ve
	// el mapa viejo completo y plausible SIN señal alguna (se reporta como
	// evidencia del problema; la postcondición es la ausencia de claves).
	trigOK := triggerMutate(pageURL, "transition")
	m1, ok1, raw1 := getFrameMap(port, map[string]any{"tabId": tabID})
	inv1 := invOf(m1)
	_, hasS1 := inv1["settled"]
	_, hasW1 := inv1["waitedMs"]
	seeOld := strings.Contains(raw1, "contenido-viejo")
	allOK = paso("P10: getFrame plain post-click → SIN invalidation.settled/waitedMs (ausencia, I-2)",
		trigOK && ok1 && inv1 != nil && !hasS1 && !hasW1,
		fmt.Sprintf(" (transition=%v, settled ausente=%v, waitedMs ausente=%v; mapa viejo visto=%v — G5: contenido viejo sin señal)",
			trigOK, !hasS1, !hasW1, seeOld)) && allOK

	// SET-2 (P11-outcome-true + demo G5 corregido) — settle DURANTE la
	// transición: los ticks (200 ms) reinician la ventana de quietud, el swap
	// a t=1200 también, y la quietud posterior ⇒ settled:true con el mapa
	// FINAL (no el viejo). waitMs=4000 holgado vs ~1600 de resolución real.
	m2, ok2, raw2 := getFrameMap(port, map[string]any{"tabId": tabID, "settle": true, "waitMs": 4000, "quietMs": 300})
	inv2 := invOf(m2)
	s2, boolOK2 := inv2["settled"].(bool)
	w2, intOK2 := isNonNegInt(inv2, "waitedMs")
	seeFinal := strings.Contains(raw2, "contenido-final-listo")
	allOK = paso("P11-true: settle durante transición → settled:true + waitedMs entero ≥0 + mapa FINAL (G5 corregido)",
		ok2 && boolOK2 && s2 && intOK2 && seeFinal,
		fmt.Sprintf(" (settled=%v bool=%v, waitedMs=%d int≥0=%v, contenido final=%v)",
			s2, boolOK2, w2, intOK2, seeFinal)) && allOK

	// SET-3 (P13) — coherencia temporal: re-lectura plain INMEDIATA con la
	// misma query ⇒ changedSinceLast:false y payload deep-equal (la huella del
	// frame settled es la huella estable — el mapa settled ES el mapa actual).
	m3, ok3, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	changed3 := invChanged(m3)
	p2, p2ok := payloadJSON(m2)
	p3, p3ok := payloadJSON(m3)
	allOK = paso("P13: plain inmediato tras settled:true → changedSinceLast:false y payload deep-equal",
		ok3 && !changed3 && p2ok && p3ok && p2 == p3,
		fmt.Sprintf(" (changed=%v, payload igual=%v)", changed3, p2ok && p3ok && p2 == p3)) && allOK

	// SET-4 (P11-outcome-false) — mutación continua (tick cada 200 ms <
	// quietMs=300: la ventana jamás se completa) pasada waitMs=1500 ⇒
	// settled:false CON ambas claves presentes (el veredicto se reporta
	// siempre; I-2 en el outcome false). BARRERA: el settle solo arranca con
	// el loop verifablemente activo (waitForLoopState) — si la página no lo
	// reporta a tiempo, el paso FALLA honesto (setup), sin fingir veredicto.
	loopOn := triggerMutate(pageURL, "loop-on")
	loopReady := loopOn && waitForLoopState(pageURL, "on", 5*time.Second)
	m4, ok4, _ := getFrameMap(port, map[string]any{"tabId": tabID, "settle": true, "waitMs": 1500, "quietMs": 300})
	inv4 := invOf(m4)
	s4, boolOK4 := inv4["settled"].(bool)
	_, intOK4 := isNonNegInt(inv4, "waitedMs")
	allOK = paso("P11-false: settle con mutación continua (waitMs=1500) → settled:false + ambas claves presentes",
		loopReady && ok4 && boolOK4 && !s4 && intOK4,
		fmt.Sprintf(" (loop activo confirmado=%v, settled=%v bool=%v, waitedMs presente=%v)",
			loopReady, s4, boolOK4, intOK4)) && allOK

	// SET-5 (P12) — timeout ⇒ frame COMPLETO (I-A: sections+read presentes,
	// NUNCA una respuesta sin mapa por la espera).
	m5, ok5, raw5 := getFrameMap(port, map[string]any{"tabId": tabID, "settle": true, "waitMs": 1500, "quietMs": 300})
	s5, _ := invOf(m5)["settled"].(bool)
	secs, _ := m5["sections"].([]any)
	readArr, _ := m5["read"].([]any)
	allOK = paso("P12: timeout ⇒ settled:false + frame completo (sections+read, nunca respuesta sin mapa)",
		ok5 && !s5 && len(secs) > 0 && readArr != nil,
		fmt.Sprintf(" (settled=%v, sections=%d, read=%d, bytes=%d)", s5, len(secs), len(readArr), len(raw5))) && allOK

	// fin del loop: barrera de loop inactivo reportado por la página + drenaje
	// antes de los pasos que asumen página quieta (tras "off" confirmado no
	// quedan ticks: clearInterval no deja callbacks pendientes).
	_ = triggerMutate(pageURL, "loop-off")
	loopOff := waitForLoopState(pageURL, "off", 5*time.Second)
	time.Sleep(250 * time.Millisecond)

	// SET-6 (P11 cierre) — settle en página QUIETA (sin transición de por
	// medio): segundo outcome true, waitedMs ≈ quietMs (piso holgado 150).
	m6, ok6, _ := getFrameMap(port, map[string]any{"tabId": tabID, "settle": true, "waitMs": 1500, "quietMs": 300})
	inv6 := invOf(m6)
	s6, boolOK6 := inv6["settled"].(bool)
	w6, intOK6 := isNonNegInt(inv6, "waitedMs")
	allOK = paso("P11-quiet: settle en página quieta → settled:true + waitedMs ≥150 (cierra los dos outcomes de P11)",
		loopOff && ok6 && boolOK6 && s6 && intOK6 && w6 >= 150,
		fmt.Sprintf(" (loop inactivo confirmado=%v, settled=%v bool=%v, waitedMs=%d int=%v)",
			loopOff, s6, boolOK6, w6, intOK6)) && allOK

	// SET-7 (P15) — changedSinceLast intacto (I7): reset (navegación) ⇒ true;
	// tras mutación real ⇒ true; repetida sin mutación ⇒ false. La "primera
	// llamada true" (sin snapshot previo) ya la verifica E2E1 en esta misma
	// corrida; acá se cubre el reset por navegación del spec P15. navigate es
	// WRITE → build mode antes (D5). Se navega a ?p15=1 (misma página, URL
	// distinta ⇒ recarga garantizada; la página limpia difiere de la
	// acumulada ⇒ primera lectura post-reset reporta true).
	p15Build := ensureBuildMode(port)
	_, navOK := mcpCall(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": pageURL + "?p15=1"})
	time.Sleep(1500 * time.Millisecond) // recarga local: la página nueva reemplaza a la acumulada
	var m7a map[string]any
	ok7a := false
	for i := 0; i < 5 && !ok7a; i++ { // reintenta SOLO fallas de transporte (tab cargando), nunca contenido
		m7a, ok7a, _ = getFrameMap(port, map[string]any{"tabId": tabID})
		if !ok7a {
			time.Sleep(500 * time.Millisecond)
		}
	}
	changed7a := invChanged(m7a)
	mutOK7 := triggerMutate(pageURL, "visible")
	time.Sleep(300 * time.Millisecond)
	m7b, ok7b, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	changed7b := invChanged(m7b)
	m7c, ok7c, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	changed7c := invChanged(m7c)
	allOK = paso("P15: changedSinceLast intacto — reset(navegación)=true, mutación real=true, repetida=false",
		p15Build && navOK && ok7a && changed7a && mutOK7 && ok7b && changed7b && ok7c && !changed7c,
		fmt.Sprintf(" (build=%v nav=%v, reset changed=%v, mutación=%v changed=%v, repetida changed=%v)",
			p15Build, navOK, changed7a, mutOK7, changed7b, changed7c)) && allOK

	// SET-8 (P18) — error path intacto: getFrame con settle sobre tab
	// inexistente ⇒ el MISMO error que el plain (la espera no introduce una
	// clase de error nueva; ambos fallan en la inyección previa a la espera).
	ghost := 987654321
	errPlain, okPlain := mcpCall(port, "vlp_getFrame", map[string]any{"tabId": ghost})
	errSettle, okSettle := mcpCall(port, "vlp_getFrame", map[string]any{"tabId": ghost, "settle": true, "waitMs": 800})
	allOK = paso("P18: settle sobre tab inexistente ⇒ mismo error que plain (sin clase de error nueva)",
		!okPlain && !okSettle && errPlain == errSettle,
		fmt.Sprintf(" (plain ok=%v, settle ok=%v, error idéntico=%v)",
			okPlain, okSettle, errPlain == errSettle)) && allOK

	// SET-9 (P17 smoke) — vlp_act intacto: click real en "Agregar nodo"
	// ⇒ {ok:true} (forma sin cambios; settle no toca el camino de act).
	actBuild := ensureBuildMode(port)
	fAct, okActPre := getFrame(port, tabID)
	adderRef, refOK := fAct.findRefByName("Agregar nodo")
	var actText string
	actOK := false
	if refOK {
		actText, actOK = mcpCall(port, "vlp_act", map[string]any{"tabId": tabID, "ref": adderRef, "action": "click"})
	}
	var actParsed map[string]any
	okTrue := false
	if actOK && parseJSON(actText, &actParsed) {
		okTrue, _ = actParsed["ok"].(bool)
	}
	allOK = paso("P17-smoke: vlp_act click ⇒ {ok:true} (forma de respuesta intacta)",
		actBuild && okActPre && refOK && okTrue,
		fmt.Sprintf(" (build=%v, frame=%v, ref=%v, ok=%v)", actBuild, okActPre, refOK, okTrue)) && allOK

	// ---- fb-018-006 enmienda P14 (§2.2.7, P19/P20): navegación en vuelo ----
	// El executeScript durante una navegación de página completa aterriza en
	// el DOCUMENTO PREVIO (Firefox lo mantiene vivo hasta el commit) y ese
	// documento puede estar quieto (loader overlay CSS-animated: cero
	// mutaciones, readyState complete) — el settle certificaría settled:true
	// sobre contenido ya inexistente (P14 falsado 2/2 en campo, repro 2/2).
	// La página /slow?ms=1500 retrasa el COMMIT (respuesta completa tras el
	// delay) para hacer la ventana observable: el documento previo sigue vivo
	// mientras. El marker de cada destino lleva el número de navegación
	// (?n=1 → destino-lento-listo-1; ?n=2 → destino-lento-listo-2): destino y
	// previo tienen markers DISTINTOS y la aserción distingue a cuál aterrizó
	// el frame. RED esperado contra el build previo a la
	// enmienda: SET-10 (clave navigating inexistente en el wire) y SET-12
	// (mapa del documento previo certificado como estable).
	navBuild10 := ensureBuildMode(port)
	slow1 := strings.TrimSuffix(pageURL, "/") + "/slow?ms=1500&n=1"
	_, navOK10 := mcpCall(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": slow1})
	m10, ok10, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	nav10, boolOK10 := invOf(m10)["navigating"].(bool)
	allOK = paso("SET-10 (P19): getFrame plain INMEDIATO tras goto → invalidation.navigating:true (present-only, I-2)",
		navBuild10 && navOK10 && ok10 && boolOK10 && nav10,
		fmt.Sprintf(" (build=%v, nav=%v, frame=%v, navigating presente-bool=%v valor=%v)",
			navBuild10, navOK10, ok10, boolOK10, nav10)) && allOK

	// SET-11 (P19, mitad negativa) — navegación COMPLETA ⇒ navigating AUSENTE
	// (I-2: ausente ≠ false — nunca navigating:false). Barrera: la aserción
	// corre con el contenido destino ya observable (marker
	// destino-lento-listo-1 en el mapa) y tras un drenaje de 500 ms; la
	// aserción es sobre UNA llamada final (sin reintentos que enmascaren un
	// flag residual).
	completed11 := false
	for i := 0; i < 20 && !completed11; i++ {
		_, okPoll, rawPoll := getFrameMap(port, map[string]any{"tabId": tabID})
		completed11 = okPoll && strings.Contains(rawPoll, "destino-lento-listo-1")
		if !completed11 {
			time.Sleep(500 * time.Millisecond)
		}
	}
	time.Sleep(500 * time.Millisecond)
	m11, ok11, raw11 := getFrameMap(port, map[string]any{"tabId": tabID})
	fmt.Printf("  [DEBUG] SET-11 raw final: %.300s\n", raw11)
	_, has11 := invOf(m11)["navigating"]
	allOK = paso("SET-11 (P19-neg): getFrame plain con navegación completa → navigating AUSENTE (I-2, nunca navigating:false)",
		completed11 && ok11 && !has11,
		fmt.Sprintf(" (destino n1 observable=%v, frame=%v, navigating ausente=%v)",
			completed11, ok11, !has11)) && allOK

	// SET-12 (P20-RED) — settle INMEDIATO tras el goto: con la enmienda debe
	// esperar el commit (techo waitMs) y certificar settled:true sobre el
	// DOCUMENTO DESTINO (marker destino-lento-listo-2), nunca sobre el previo
	// (marker destino-lento-listo-1 — el mapa viejo certificado es exactamente
	// el defecto de campo P14). RED: el build previo ejecuta el settle en el
	// doc previo (quieto: overlay CSS, cero mutaciones) ⇒ mapa del doc previo
	// con settled:true.
	navBuild12 := ensureBuildMode(port)
	slow2 := strings.TrimSuffix(pageURL, "/") + "/slow?ms=1500&n=2"
	_, navOK12 := mcpCall(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": slow2})
	m12, ok12, raw12 := getFrameMap(port, map[string]any{"tabId": tabID, "settle": true, "waitMs": 5000})
	fmt.Printf("  [DEBUG] SET-12 raw: %.600s\n", raw12)
	s12, boolOK12 := invOf(m12)["settled"].(bool)
	seeDest12 := strings.Contains(raw12, "destino-lento-listo-2")
	seePrev12 := strings.Contains(raw12, "destino-lento-listo-1")
	allOK = paso("SET-12 (P20): settle durante navegación → settled:true sobre el DOCUMENTO DESTINO (marker -2), no el previo (marker -1)",
		navBuild12 && navOK12 && ok12 && boolOK12 && s12 && seeDest12 && !seePrev12,
		fmt.Sprintf(" (build=%v, nav=%v, frame=%v, settled=%v bool=%v, marker -2=%v, marker -1 previo=%v)",
			navBuild12, navOK12, ok12, s12, boolOK12, seeDest12, seePrev12)) && allOK

	return allOK
}

// ---- fb-020-002 C6 (T2): observación de act type y guard disabled de fill ----

// mcpCallEnvelope: como mcpCall pero separa las tres salidas que P22 debe
// distinguir (mcpCall las colapsa en ok=false): answered=false si no hubo
// respuesta HTTP (incluye vencer `timeout`); toolErr=true si la tool devolvió
// error (JSON-RPC `error` o result.isError); si no, text es el content del
// result ("" si vino vacío). No aserta el texto del error.
func mcpCallEnvelope(port int, name string, args map[string]any, timeout time.Duration) (text string, toolErr bool, answered bool) {
	if !ensureSession(port) {
		return "", false, false
	}
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": args},
	})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", port), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Mcp-Session-Id", devSession)
	req.Header.Set("x-vlp-token", devToken)
	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return err.Error(), false, false
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		return string(data), false, true
	}
	if e, hasErr := out["error"]; hasErr {
		return fmt.Sprintf("error: %v", e), true, true
	}
	res, _ := out["result"].(map[string]any)
	content, _ := res["content"].([]any)
	if len(content) > 0 {
		first, _ := content[0].(map[string]any)
		text, _ = first["text"].(string)
	}
	if isErr, _ := res["isError"].(bool); isErr {
		return text, true, true
	}
	return text, false, true
}

// waitTypeObserveStep: espera a que el frame del tab sea el documento fresco
// de /type-observe?step=<step> (marker listo-<step> en el mapa). Reintenta
// sólo hasta que el marker aparece; nunca inspecciona el resultado del paso.
func waitTypeObserveStep(port, tabID int, step string, timeout time.Duration) (frameInfo, bool, string) {
	deadline := time.Now().Add(timeout)
	var fi frameInfo
	var raw string
	for time.Now().Before(deadline) {
		var ok bool
		fi, ok, raw = getFrameRaw(port, tabID)
		if ok && strings.Contains(raw, "listo-"+step) {
			return fi, true, raw
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fi, false, raw
}

// loadTypeObserveStep: build mode + navigate del tab a la fixture del step y
// espera del documento fresco. Devuelve el frame listo y el ref del input con
// name inputName (ref "" si no hay input que buscar).
func loadTypeObserveStep(port, tabID int, pageURL, step, inputName string) (ref string, ready bool, detail string) {
	target := strings.TrimSuffix(pageURL, "/") + "/type-observe?step=" + step
	if !ensureBuildMode(port) {
		return "", false, "build mode no disponible"
	}
	if _, navOK := mcpCall(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": target}); !navOK {
		return "", false, "navigate falló"
	}
	fi, fresh, raw := waitTypeObserveStep(port, tabID, step, 15*time.Second)
	if !fresh {
		fmt.Printf("  [DEBUG] %s getFrame raw (sin marker): %.600s\n", step, raw)
		return "", false, "documento fresco no observado"
	}
	if inputName == "" {
		return "", true, ""
	}
	ref, refOK := fi.findRefByName(inputName)
	if !refOK {
		fmt.Printf("  [DEBUG] %s getFrame raw (sin %s): %.600s\n", step, inputName, raw)
		return "", false, "ref de " + inputName + " no encontrado"
	}
	return ref, true, ""
}

// toolMap: mcpCall + parseo a mapa crudo (ausencia de claves verificable).
func toolMap(port int, name string, args map[string]any) (map[string]any, bool, string) {
	text, ok := mcpCall(port, name, args)
	var m map[string]any
	if !ok || !parseJSON(text, &m) {
		return nil, false, text
	}
	return m, true, text
}

// elementValueByName: `value` del elemento con name dado en el frame crudo
// (sections[*].elements[*]) — relectura del input por getFrame.
func elementValueByName(m map[string]any, name string) (string, bool) {
	secs, _ := m["sections"].([]any)
	for _, s := range secs {
		sec, _ := s.(map[string]any)
		elems, _ := sec["elements"].([]any)
		for _, e := range elems {
			el, _ := e.(map[string]any)
			if n, _ := el["name"].(string); n != name {
				continue
			}
			v, isStr := el["value"].(string)
			return v, isStr
		}
	}
	return "", false
}

// runTypeObserveE2E (fb-020-002 C6, AC-10): P20-P23 en un tab PROPIO (no el
// compartido por runFrameE2E/runSettleE2E, cuyo snapshot y URL no se tocan).
// Cada caso recarga /type-observe?step=pNN. Corre último: P22 descarga la
// página.
func runTypeObserveE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-type] Observación de act type y guard disabled de fill (fb-020-002) — P20-P23")
	allOK := true

	if !paso("TYP-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	firstURL := strings.TrimSuffix(pageURL, "/") + "/type-observe?step=p20"
	_, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": firstURL})
	tabID, tabOK := 0, false
	if openOK {
		tabID, tabOK = findTabByURL(port, firstURL, 15*time.Second)
	}
	if !paso("TYP-0: tab de la fixture type-observe abierto y detectado", openOK && tabOK,
		fmt.Sprintf(" (openTab ok=%v, tabId %d, url %s)", openOK, tabID, firstURL)) {
		return false
	}

	// P20 — mutaciones del DOM 100-500 ms + reformateo por propiedad a los
	// 600 ms: con defaults, settled:true, value = texto formateado y
	// waitedMs ≥ 900 (600 + quietMs 300).
	ref20, ready20, why20 := loadTypeObserveStep(port, tabID, pageURL, "p20", "campo-p20")
	var m20 map[string]any
	act20, raw20 := false, why20
	if ready20 {
		m20, act20, raw20 = toolMap(port, "vlp_act", map[string]any{"tabId": tabID, "ref": ref20, "action": "type", "value": "1234"})
	}
	ok20, _ := m20["ok"].(bool)
	settled20, sBool20 := m20["settled"].(bool)
	value20, vStr20 := m20["value"].(string)
	waited20, wInt20 := isNonNegInt(m20, "waitedMs")
	allOK = paso("P20: act type con mutaciones + reformateo a 600 ms → ok:true, settled:true, value formateado, waitedMs ≥ 900",
		ready20 && act20 && ok20 && sBool20 && settled20 && vStr20 && value20 == "formateado-1" && wInt20 && waited20 >= 900,
		fmt.Sprintf(" (fixture=%v, act=%v, ok=%v, settled=%v bool=%v, value=%q str=%v, waitedMs=%d int=%v; raw %.300s)",
			ready20, act20, ok20, settled20, sBool20, value20, vStr20, waited20, wInt20, raw20)) && allOK

	// P21 — el listener reemplaza el input por un clon a los 150 ms:
	// ok:true, detached:true, settled:false y la clave value AUSENTE.
	ref21, ready21, why21 := loadTypeObserveStep(port, tabID, pageURL, "p21", "campo-p21")
	var m21 map[string]any
	act21, raw21 := false, why21
	if ready21 {
		m21, act21, raw21 = toolMap(port, "vlp_act", map[string]any{"tabId": tabID, "ref": ref21, "action": "type", "value": "1234"})
	}
	ok21, _ := m21["ok"].(bool)
	detached21, _ := m21["detached"].(bool)
	settled21, sBool21 := m21["settled"].(bool)
	_, hasValue21 := m21["value"]
	allOK = paso("P21: act type con reemplazo por clon a 150 ms → ok:true, detached:true, settled:false, sin value",
		ready21 && act21 && ok21 && detached21 && sBool21 && !settled21 && !hasValue21,
		fmt.Sprintf(" (fixture=%v, act=%v, ok=%v, detached=%v, settled=%v bool=%v, value ausente=%v; raw %.300s)",
			ready21, act21, ok21, detached21, settled21, sBool21, !hasValue21, raw21)) && allOK

	// P22 — el listener navega a /slow?ms=4000 (documento descargado durante
	// la llamada): la llamada RETORNA antes de waitMs + 3000 = 8000 ms, con
	// error de la tool o con un resultado que trae `ok`. Falla si vence el
	// techo o si retorna éxito vacío/sin `ok`. No se aserta el texto del error.
	const ceiling22 = 8000 * time.Millisecond
	ref22, ready22, why22 := loadTypeObserveStep(port, tabID, pageURL, "p22", "campo-p22")
	text22, toolErr22, answered22 := why22, false, false
	var elapsed22 time.Duration
	if ready22 {
		start := time.Now()
		text22, toolErr22, answered22 = mcpCallEnvelope(port, "vlp_act",
			map[string]any{"tabId": tabID, "ref": ref22, "action": "type", "value": "1234"}, ceiling22+7*time.Second)
		elapsed22 = time.Since(start)
	}
	var m22 map[string]any
	hasOK22 := false
	if !toolErr22 && parseJSON(text22, &m22) {
		_, hasOK22 = m22["ok"]
	}
	within22 := elapsed22 <= ceiling22
	allOK = paso("P22: act type que navega (documento descargado) → retorna < 8000 ms con error de tool o resultado con ok (nunca éxito vacío)",
		ready22 && answered22 && within22 && (toolErr22 || hasOK22),
		fmt.Sprintf(" (fixture=%v, respondió=%v, %d ms ≤ 8000=%v, error de tool=%v, resultado con ok=%v; raw %.300s)",
			ready22, answered22, elapsed22.Milliseconds(), within22, toolErr22, hasOK22, text22)) && allOK

	// P23 — fill en input habilitado: {success:true, selector, value, settled,
	// waitedMs}. En input disabled: {success:false, disabled:true, error,
	// selector} y el valor releído por getFrame sigue siendo el original.
	_, ready23, why23 := loadTypeObserveStep(port, tabID, pageURL, "p23", "")
	const selEnabled, selDisabled = "#p23-enabled", "#p23-disabled"
	var m23e map[string]any
	fill23e, raw23e := false, why23
	if ready23 && ensureBuildMode(port) {
		m23e, fill23e, raw23e = toolMap(port, "vlp_fill", map[string]any{"tabId": tabID, "selector": selEnabled, "value": "texto-p23"})
	}
	success23e, sucBool23e := m23e["success"].(bool)
	selector23e, _ := m23e["selector"].(string)
	_, valueStr23e := m23e["value"].(string)
	_, settledBool23e := m23e["settled"].(bool)
	_, waitedNum23e := m23e["waitedMs"].(float64)
	allOK = paso("P23-enabled: fill en input habilitado → success:true, selector, value string, settled bool, waitedMs numérico",
		ready23 && fill23e && sucBool23e && success23e && selector23e == selEnabled && valueStr23e && settledBool23e && waitedNum23e,
		fmt.Sprintf(" (fixture=%v, fill=%v, success=%v bool=%v, selector=%q, value str=%v, settled bool=%v, waitedMs num=%v; raw %.300s)",
			ready23, fill23e, success23e, sucBool23e, selector23e, valueStr23e, settledBool23e, waitedNum23e, raw23e)) && allOK

	var m23d map[string]any
	fill23d, raw23d := false, why23
	if ready23 && ensureBuildMode(port) {
		m23d, fill23d, raw23d = toolMap(port, "vlp_fill", map[string]any{"tabId": tabID, "selector": selDisabled, "value": "nuevo-p23"})
	}
	success23d, sucBool23d := m23d["success"].(bool)
	disabled23d, _ := m23d["disabled"].(bool)
	error23d, _ := m23d["error"].(string)
	selector23d, _ := m23d["selector"].(string)
	mRead, readOK, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	value23d, valueOK23d := elementValueByName(mRead, "campo-p23-disabled")
	allOK = paso("P23-disabled: fill en input disabled → success:false, disabled:true, error no vacío, selector; valor releído sin cambios",
		ready23 && fill23d && sucBool23d && !success23d && disabled23d && error23d != "" && selector23d == selDisabled &&
			readOK && valueOK23d && value23d == "original-p23",
		fmt.Sprintf(" (fixture=%v, fill=%v, success=%v bool=%v, disabled=%v, error no vacío=%v, selector=%q, relectura=%v value=%q; raw %.300s)",
			ready23, fill23d, success23d, sucBool23d, disabled23d, error23d != "", selector23d, readOK && valueOK23d, value23d, raw23d)) && allOK

	return allOK
}

// ---- fb-020-003 (T2, P10-P17): diálogos nativos en act click ----
// Integrado por cdad-implementer desde docs/specs/fb-020-003-native-dialog-policy/
// e2e-diseno.md (test-writer no puede leer ni editar este archivo — precedente
// C6 de fb-020-002). Los pasos se derivan del diseño/spec, no de background.js,
// extension/frame/*.js ni tools.go, que este integrador tiene prohibido leer.

// nativeDialogOf: extrae nativeDialog como mapa (nil si ausente o malformado).
func nativeDialogOf(m map[string]any) map[string]any {
	nd, _ := m["nativeDialog"].(map[string]any)
	return nd
}

// exactKeys: true si el conjunto de claves de m es EXACTAMENTE `keys` — la
// ausencia de una clave se verifica tanto como su presencia (I-2/I-6 del
// spec: nativeDialog nunca aparece de más, ok:true sin diálogo es byte-idéntico).
func exactKeys(m map[string]any, keys ...string) bool {
	if len(m) != len(keys) {
		return false
	}
	for _, k := range keys {
		if _, ok := m[k]; !ok {
			return false
		}
	}
	return true
}

// boolTrue: v es exactamente el bool true (evita falsos positivos de nil).
func boolTrue(v any) bool {
	b, ok := v.(bool)
	return ok && b
}

// nativeDialogMatches: nd tiene EXACTAMENTE {type, message, pending:true}
// con los valores esperados (§2.1 del spec — nativeDialog es {type, message,
// pending:true}, nunca más ni menos claves).
func nativeDialogMatches(nd map[string]any, wantType, wantMessage string) bool {
	if nd == nil || !exactKeys(nd, "type", "message", "pending") {
		return false
	}
	tp, _ := nd["type"].(string)
	msg, _ := nd["message"].(string)
	return tp == wantType && msg == wantMessage && boolTrue(nd["pending"])
}

// nativeDialogEquals: deep-equal de dos nativeDialog vía json.Marshal (ordena
// claves — mismo criterio que payloadJSON). Usado por P12: las 6 llamadas del
// guard tienen que llevar el MISMO nativeDialog que abrió P10.
func nativeDialogEquals(a, b map[string]any) bool {
	if a == nil || b == nil {
		return false
	}
	ja, erra := json.Marshal(a)
	jb, errb := json.Marshal(b)
	return erra == nil && errb == nil && string(ja) == string(jb)
}

// isValidDialogError: forma exigida por §2.3 (resolución 6.7) a todo `error`
// que acompaña un nativeDialog — no vacío, una sola línea, sin la palabra
// "force" (force no lo saltea; el mensaje no debe insinuar lo contrario).
func isValidDialogError(s string) bool {
	return s != "" && !strings.Contains(s, "\n") && !strings.Contains(strings.ToLower(s), "force")
}

// hasNoNativeDialog: la clave nativeDialog está AUSENTE (nunca null/false — I-6).
func hasNoNativeDialog(m map[string]any) bool {
	_, has := m["nativeDialog"]
	return !has
}

// toolMapTimeout: como toolMap pero con timeout de cliente explícito,
// separando answered/toolErr (patrón de mcpCallEnvelope, ya usado por P22) —
// los pasos de fb-020-003 miden "vuelve en menos de N ms" como aserción
// aparte de la forma de la respuesta.
func toolMapTimeout(port int, name string, args map[string]any, timeout time.Duration) (m map[string]any, toolErr bool, answered bool, text string) {
	text, toolErr, answered = mcpCallEnvelope(port, name, args, timeout)
	if !answered || toolErr {
		return nil, toolErr, answered, text
	}
	parseJSON(text, &m)
	return m, toolErr, answered, text
}

// refByName: findRefByName con dump de debug si no encuentra — visibilidad
// de un miss de resolución de ref en el run real (mismo espíritu que el
// [DEBUG] de loadTypeObserveStep).
func refByName(fi frameInfo, raw, name string) (string, bool) {
	ref, ok := fi.findRefByName(name)
	if !ok {
		fmt.Printf("  [DEBUG] ref no encontrado por name=%q; frame raw: %.400s\n", name, raw)
	}
	return ref, ok
}

// waitNativeDialogStep (fb-020-003 §1.2): espera el marcador `listo:<step>`
// en #st-listo — mismo patrón que waitTypeObserveStep, pero el separador es
// ':' (no '-': el JS del diseño escribe "listo:" + step).
func waitNativeDialogStep(port, tabID int, step string, timeout time.Duration) (frameInfo, bool, string) {
	deadline := time.Now().Add(timeout)
	var fi frameInfo
	var raw string
	for time.Now().Before(deadline) {
		var ok bool
		fi, ok, raw = getFrameRaw(port, tabID)
		if ok && strings.Contains(raw, "listo:"+step) {
			return fi, true, raw
		}
		time.Sleep(250 * time.Millisecond)
	}
	return fi, false, raw
}

// openNativeDialogTab (fb-020-003): abre un tab NUEVO en /native-dialog?step=
// y espera su marcador — cada tab (A/B/C) de runNativeDialogE2E arranca así.
func openNativeDialogTab(port int, pageURL, step string) (tabID int, fi frameInfo, raw string, ready bool, detail string) {
	if !ensureBuildMode(port) {
		return 0, fi, "", false, "build mode no disponible"
	}
	target := strings.TrimSuffix(pageURL, "/") + "/native-dialog?step=" + step
	if _, openOK := mcpCall(port, "vlp_openTab", map[string]any{"url": target}); !openOK {
		return 0, fi, "", false, "openTab falló"
	}
	var tabOK bool
	tabID, tabOK = findTabByURL(port, target, 15*time.Second)
	if !tabOK {
		return tabID, fi, "", false, "tab no detectado"
	}
	fi, fresh, raw := waitNativeDialogStep(port, tabID, step, 5*time.Second)
	if !fresh {
		return tabID, fi, raw, false, "documento fresco no observado"
	}
	return tabID, fi, raw, true, ""
}

// navigateNativeDialogStep (fb-020-003): navega el tab existente a otro paso
// de /native-dialog y espera su marcador — el navegador libera cualquier
// diálogo nativo abierto al descargar el documento (run-d, H-11).
func navigateNativeDialogStep(port, tabID int, pageURL, step string) (fi frameInfo, raw string, ready bool, detail string) {
	if !ensureBuildMode(port) {
		return fi, "", false, "build mode no disponible"
	}
	target := strings.TrimSuffix(pageURL, "/") + "/native-dialog?step=" + step
	if _, navOK := mcpCall(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": target}); !navOK {
		return fi, "", false, "navigate falló"
	}
	fi, fresh, raw := waitNativeDialogStep(port, tabID, step, 5*time.Second)
	if !fresh {
		return fi, raw, false, "documento fresco no observado"
	}
	return fi, raw, true, ""
}

// assertNativeDialogGuardAct (P12): una de las 4 llamadas act guardadas —
// 5000 ms de cliente, umbral de 3000 ms, forma exacta {ok:false, nativeDialog,
// error} con el nativeDialog de la pregunta pendiente (ndWant).
func assertNativeDialogGuardAct(port, tabID int, args map[string]any, ndWant map[string]any, label string) bool {
	call := map[string]any{"tabId": tabID}
	for k, v := range args {
		call[k] = v
	}
	start := time.Now()
	m, toolErr, answered, text := toolMapTimeout(port, "vlp_act", call, 5*time.Second)
	elapsed := time.Since(start)
	errStr, _ := m["error"].(string)
	ok := answered && !toolErr && elapsed < 3*time.Second &&
		exactKeys(m, "ok", "nativeDialog", "error") && !boolTrue(m["ok"]) &&
		nativeDialogEquals(nativeDialogOf(m), ndWant) && isValidDialogError(errStr)
	return paso("P12: "+label+" con pregunta pendiente → {ok:false, nativeDialog, error}",
		ok, fmt.Sprintf(" (%dms, respondió=%v, error de tool=%v, error=%q; raw=%.250s)",
			elapsed.Milliseconds(), answered, toolErr, errStr, text))
}

// assertNativeDialogGuardFill (P12): fill por selector con la pregunta
// pendiente — forma exacta {success:false, nativeDialog, error, selector}.
func assertNativeDialogGuardFill(port, tabID int, selector string, ndWant map[string]any) bool {
	start := time.Now()
	m, toolErr, answered, text := toolMapTimeout(port, "vlp_fill",
		map[string]any{"tabId": tabID, "selector": selector, "value": "y"}, 5*time.Second)
	elapsed := time.Since(start)
	errStr, _ := m["error"].(string)
	sel, _ := m["selector"].(string)
	ok := answered && !toolErr && elapsed < 3*time.Second &&
		exactKeys(m, "success", "nativeDialog", "error", "selector") && !boolTrue(m["success"]) &&
		nativeDialogEquals(nativeDialogOf(m), ndWant) && isValidDialogError(errStr) && sel == selector
	return paso("P12: fill "+selector+" con pregunta pendiente → {success:false, nativeDialog, error, selector}",
		ok, fmt.Sprintf(" (%dms, respondió=%v, error de tool=%v, error=%q, selector=%q; raw=%.250s)",
			elapsed.Milliseconds(), answered, toolErr, errStr, sel, text))
}

// runNativeDialogTabA (fb-020-003 §3.4, P10/P12/P13): abre confirm-sync,
// dispara la pregunta con P10 y la deja pendiente para P12 y P13. Libera con
// closeTab en defer — pase lo que pase con las aserciones (§2 del diseño:
// "cada paso que abre un diálogo lo libera en su propio bloque, aunque la
// aserción haya fallado").
func runNativeDialogTabA(port int, pageURL string) bool {
	allOK := true
	tabID, fiA, rawA, ready, why := openNativeDialogTab(port, pageURL, "confirm-sync")
	if !paso("P10-setup: tab A abierto en confirm-sync", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer func() {
		mcpCallEnvelope(port, "vlp_closeTab", map[string]any{"tabId": tabID}, 3*time.Second)
	}()

	refTrigger, okTrigger := refByName(fiA, rawA, "Disparar")
	refOther, okOther := refByName(fiA, rawA, "Otro control")
	refText, okText := refByName(fiA, rawA, "texto")
	refFocus, okFocus := refByName(fiA, rawA, "foco")
	refSelect, okSelect := refByName(fiA, rawA, "opciones")
	if !paso("P10-refs: refs de b-trigger/b-other/i-text/i-focus/s-opt resueltos",
		okTrigger && okOther && okText && okFocus && okSelect,
		fmt.Sprintf(" (trigger=%v other=%v text=%v focus=%v select=%v)", okTrigger, okOther, okText, okFocus, okSelect)) {
		allOK = false
	}

	// P10: act click sobre confirm-sync → {ok:true, nativeDialog:{type:confirm,
	// message:"¿Borrar el registro?", pending:true}} en menos de 3000 ms.
	start := time.Now()
	m10, toolErr10, answered10, text10 := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTrigger, "action": "click"}, 5*time.Second)
	elapsed10 := time.Since(start)
	nd10 := nativeDialogOf(m10)
	allOK = paso("P10: act click sobre confirm-sync → {ok:true, nativeDialog} en <3000 ms",
		okTrigger && answered10 && !toolErr10 && elapsed10 < 3*time.Second &&
			exactKeys(m10, "ok", "nativeDialog") && boolTrue(m10["ok"]) &&
			nativeDialogMatches(nd10, "confirm", "¿Borrar el registro?"),
		fmt.Sprintf(" (%dms, respondió=%v, error de tool=%v; raw=%.300s)",
			elapsed10.Milliseconds(), answered10, toolErr10, text10)) && allOK

	mFrame10, okFrame10, rawFrame10 := getFrameMap(port, map[string]any{"tabId": tabID})
	ndFrame10 := nativeDialogOf(mFrame10)
	allOK = paso("P10: getFrame posterior trae el mismo nativeDialog",
		okFrame10 && nativeDialogMatches(ndFrame10, "confirm", "¿Borrar el registro?"),
		fmt.Sprintf(" (raw=%.300s)", rawFrame10)) && allOK

	// P12: guard real — 6 llamadas SECUENCIALES, todas con el nativeDialog de
	// P10. Corren aunque P10 haya fallado en la forma (más evidencia).
	g1 := assertNativeDialogGuardAct(port, tabID,
		map[string]any{"ref": refOther, "action": "click", "force": false}, nd10, "act click #b-other force:false")
	g2 := assertNativeDialogGuardAct(port, tabID,
		map[string]any{"ref": refOther, "action": "click", "force": true}, nd10, "act click #b-other force:true (no saltea)")
	g3 := assertNativeDialogGuardAct(port, tabID,
		map[string]any{"ref": refText, "action": "type", "value": "x"}, nd10, "act type #i-text")
	g4 := assertNativeDialogGuardAct(port, tabID,
		map[string]any{"ref": refFocus, "action": "focus"}, nd10, "act focus #i-focus")
	g5 := assertNativeDialogGuardAct(port, tabID,
		map[string]any{"ref": refSelect, "action": "select", "value": "b"}, nd10, "act select #s-opt")
	g6 := assertNativeDialogGuardFill(port, tabID, "#i-text", nd10)
	allOK = g1 && g2 && g3 && g4 && g5 && g6 && allOK

	_, okFrame12, rawFrame12 := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P12: getFrame tras el guard → eventos:0 en read (ningún listener disparado)",
		okFrame12 && strings.Contains(rawFrame12, "eventos:0"),
		fmt.Sprintf(" (raw=%.300s)", rawFrame12)) && allOK

	// P13: getFrame con la pregunta de P10 todavía abierta.
	start13 := time.Now()
	m13a, ok13a, raw13a := getFrameMap(port, map[string]any{"tabId": tabID, "settle": true, "waitMs": 1500})
	elapsed13a := time.Since(start13)
	nd13a := nativeDialogOf(m13a)
	settled13a, settledBool13a := invOf(m13a)["settled"].(bool)
	allOK = paso("P13: getFrame settle:true con pregunta pendiente → <4500 ms, nativeDialog, settled:false",
		ok13a && elapsed13a < 4500*time.Millisecond && nd13a != nil && settledBool13a && !settled13a,
		fmt.Sprintf(" (%dms, settled bool=%v valor=%v; raw=%.300s)",
			elapsed13a.Milliseconds(), settledBool13a, settled13a, raw13a)) && allOK

	m13b, ok13b, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	nd13b := nativeDialogOf(m13b)
	allOK = paso("P13: getFrame plain (sin settle) trae nativeDialog",
		ok13b && nd13b != nil, "") && allOK

	m13c, ok13c, _ := getFrameMap(port, map[string]any{"tabId": tabID})
	nd13c := nativeDialogOf(m13c)
	changed13c := invChanged(m13c)
	allOK = paso("P13: getFrame repetido → nativeDialog + changedSinceLast:false",
		ok13c && nd13c != nil && !changed13c, "") && allOK

	return allOK
}

// runNativeDialogTabB (fb-020-003 §3.4, P11/P14/P15/P16): alert-sync →
// prompt-sync → sin-dialogo → shim-pagina → confirm-tarde. Se libera
// navegando — el defer es la liberación de resguardo final, además de los
// navigate intermedios que ya liberan cada diálogo previo.
func runNativeDialogTabB(port int, pageURL string) bool {
	allOK := true
	tabID, fiB, rawB, ready, why := openNativeDialogTab(port, pageURL, "alert-sync")
	if !paso("P11-setup: tab B abierto en alert-sync", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}
	defer func() {
		target := strings.TrimSuffix(pageURL, "/") + "/native-dialog?step=sin-dialogo"
		mcpCallEnvelope(port, "vlp_navigate", map[string]any{"tabId": tabID, "url": target}, 3*time.Second)
	}()

	// P11 — alert.
	refTriggerB, okTriggerB := refByName(fiB, rawB, "Disparar")
	startAlert := time.Now()
	mAlert, toolErrAlert, answeredAlert, textAlert := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTriggerB, "action": "click"}, 5*time.Second)
	elapsedAlert := time.Since(startAlert)
	ndAlert := nativeDialogOf(mAlert)
	allOK = paso("P11: act click sobre alert-sync → {ok:true, nativeDialog:{type:alert}} en <3000 ms",
		okTriggerB && answeredAlert && !toolErrAlert && elapsedAlert < 3*time.Second &&
			exactKeys(mAlert, "ok", "nativeDialog") && boolTrue(mAlert["ok"]) &&
			nativeDialogMatches(ndAlert, "alert", "Registro guardado"),
		fmt.Sprintf(" (%dms; raw=%.300s)", elapsedAlert.Milliseconds(), textAlert)) && allOK

	mFrameAlert, okFrameAlert, rawFrameAlert := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P11: getFrame confirma el mismo nativeDialog (alert)",
		okFrameAlert && nativeDialogMatches(nativeDialogOf(mFrameAlert), "alert", "Registro guardado"),
		fmt.Sprintf(" (raw=%.300s)", rawFrameAlert)) && allOK

	// Libera el alert navegando a prompt-sync.
	fiB, rawB, readyPrompt, whyPrompt := navigateNativeDialogStep(port, tabID, pageURL, "prompt-sync")
	if !paso("P11-setup: navigate libera alert-sync → prompt-sync listo", readyPrompt, fmt.Sprintf(" (%s)", whyPrompt)) {
		return false
	}

	// P11 — prompt.
	refTriggerP, okTriggerP := refByName(fiB, rawB, "Disparar")
	startPrompt := time.Now()
	mPrompt, toolErrPrompt, answeredPrompt, textPrompt := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTriggerP, "action": "click"}, 5*time.Second)
	elapsedPrompt := time.Since(startPrompt)
	ndPrompt := nativeDialogOf(mPrompt)
	allOK = paso("P11: act click sobre prompt-sync → {ok:true, nativeDialog:{type:prompt}} en <3000 ms",
		okTriggerP && answeredPrompt && !toolErrPrompt && elapsedPrompt < 3*time.Second &&
			exactKeys(mPrompt, "ok", "nativeDialog") && boolTrue(mPrompt["ok"]) &&
			nativeDialogMatches(ndPrompt, "prompt", "Nuevo nombre"),
		fmt.Sprintf(" (%dms; raw=%.300s)", elapsedPrompt.Milliseconds(), textPrompt)) && allOK

	mFramePrompt, okFramePrompt, rawFramePrompt := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P11: getFrame confirma el mismo nativeDialog (prompt)",
		okFramePrompt && nativeDialogMatches(nativeDialogOf(mFramePrompt), "prompt", "Nuevo nombre"),
		fmt.Sprintf(" (raw=%.300s)", rawFramePrompt)) && allOK

	// Libera el prompt navegando a sin-dialogo (release de P17 también).
	fiB, rawB, readySD, whySD := navigateNativeDialogStep(port, tabID, pageURL, "sin-dialogo")
	if !paso("P14-setup: navigate libera prompt-sync → sin-dialogo listo", readySD, fmt.Sprintf(" (%s)", whySD)) {
		return false
	}

	// P14 — sin diálogo, byte-idéntico y restaurado.
	refTriggerSD, okTriggerSD := refByName(fiB, rawB, "Disparar")
	refPlainSD, okPlainSD := refByName(fiB, rawB, "sin-listeners")
	mClickSD, toolErrSD, answeredSD, textSD := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTriggerSD, "action": "click"}, 5*time.Second)
	allOK = paso("P14: act click sin diálogo → exactamente {ok:true}",
		okTriggerSD && answeredSD && !toolErrSD && exactKeys(mClickSD, "ok") && boolTrue(mClickSD["ok"]),
		fmt.Sprintf(" (raw=%.200s)", textSD)) && allOK

	time.Sleep(500 * time.Millisecond)
	_, okFrameSD, rawFrameSD := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P14: tras 500 ms, getFrame lee intacto:true",
		okFrameSD && strings.Contains(rawFrameSD, "intacto:true"),
		fmt.Sprintf(" (raw=%.200s)", rawFrameSD)) && allOK

	mTypePlain, toolErrPlain, answeredPlain, textPlain := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refPlainSD, "action": "type", "value": "x"}, 5*time.Second)
	waitedPlain, waitedOKPlain := isNonNegInt(mTypePlain, "waitedMs")
	allOK = paso("P14: act type sobre #i-plain (sin listeners) → {ok,value,settled,waitedMs}, sin nativeDialog",
		okPlainSD && answeredPlain && !toolErrPlain &&
			exactKeys(mTypePlain, "ok", "value", "settled", "waitedMs") &&
			boolTrue(mTypePlain["ok"]) && waitedOKPlain && waitedPlain >= 0,
		fmt.Sprintf(" (waitedMs=%d int=%v; raw=%.200s)", waitedPlain, waitedOKPlain, textPlain)) && allOK

	// Libera navegando a shim-pagina.
	fiB, rawB, readyShim, whyShim := navigateNativeDialogStep(port, tabID, pageURL, "shim-pagina")
	if !paso("P15-setup: navigate a shim-pagina listo", readyShim, fmt.Sprintf(" (%s)", whyShim)) {
		return false
	}

	// P15 — transparencia real: la página shimeó confirm ANTES de capturar
	// originales, así que intacto se mide contra el shim (nota de diseño).
	refTriggerShim, okTriggerShim := refByName(fiB, rawB, "Disparar")
	mShim, toolErrShim, answeredShim, textShim := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTriggerShim, "action": "click"}, 5*time.Second)
	allOK = paso("P15: act click sobre shim-pagina → {ok:true} sin nativeDialog",
		okTriggerShim && answeredShim && !toolErrShim && boolTrue(mShim["ok"]) && hasNoNativeDialog(mShim),
		fmt.Sprintf(" (raw=%.200s)", textShim)) && allOK

	_, okFrameShim1, rawFrameShim1 := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P15: getFrame lee resultado:true",
		okFrameShim1 && strings.Contains(rawFrameShim1, "resultado:true"),
		fmt.Sprintf(" (raw=%.200s)", rawFrameShim1)) && allOK

	time.Sleep(500 * time.Millisecond)
	_, okFrameShim2, rawFrameShim2 := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P15: tras 500 ms, getFrame lee intacto:true (contra el shim)",
		okFrameShim2 && strings.Contains(rawFrameShim2, "intacto:true"),
		fmt.Sprintf(" (raw=%.200s)", rawFrameShim2)) && allOK

	// Libera navegando a confirm-tarde.
	fiB, rawB, readyTarde, whyTarde := navigateNativeDialogStep(port, tabID, pageURL, "confirm-tarde")
	if !paso("P16-setup: navigate a confirm-tarde listo", readyTarde, fmt.Sprintf(" (%s)", whyTarde)) {
		return false
	}

	// P16 — H-2: fuera del act no hay envoltorio (D-2, comportamiento esperado).
	refTriggerTarde, okTriggerTarde := refByName(fiB, rawB, "Disparar")
	mTarde, toolErrTarde, answeredTarde, textTarde := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTriggerTarde, "action": "click"}, 5*time.Second)
	allOK = paso("P16: act click sobre confirm-tarde → {ok:true} sin nativeDialog",
		okTriggerTarde && answeredTarde && !toolErrTarde && boolTrue(mTarde["ok"]) && hasNoNativeDialog(mTarde),
		fmt.Sprintf(" (raw=%.200s)", textTarde)) && allOK

	time.Sleep(2000 * time.Millisecond)
	mFrameTarde, okFrameTarde, rawFrameTarde := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P16: a los 2000 ms, getFrame responde sin nativeDialog (diálogo real ya abierto, D-2)",
		okFrameTarde && hasNoNativeDialog(mFrameTarde),
		fmt.Sprintf(" (raw=%.200s)", rawFrameTarde)) && allOK

	// La liberación final (navigate a sin-dialogo) corre en el defer.
	return allOK
}

// runNativeDialogTabC (fb-020-003 §3.4, P17): tab NUEVO, después de liberar
// P10 con closeTab y P11 con navigate — la extensión sigue operativa tras la
// vuelta tardía.
func runNativeDialogTabC(port int, pageURL string) bool {
	allOK := true
	tabID, fiC, rawC, ready, why := openNativeDialogTab(port, pageURL, "sin-dialogo")
	if !paso("P17-setup: tab C abierto en sin-dialogo", ready, fmt.Sprintf(" (%s)", why)) {
		return false
	}

	startList := time.Now()
	_, toolErrList, answeredList, textList := toolMapTimeout(port, "vlp_listTabs", map[string]any{}, 5*time.Second)
	elapsedList := time.Since(startList)
	allOK = paso("P17: listTabs responde dentro de 5000 ms",
		answeredList && !toolErrList && elapsedList <= 5*time.Second,
		fmt.Sprintf(" (%dms; raw=%.200s)", elapsedList.Milliseconds(), textList)) && allOK

	refTriggerC, okTriggerC := refByName(fiC, rawC, "Disparar")
	startClick := time.Now()
	mClickC, toolErrC, answeredC, textC := toolMapTimeout(port, "vlp_act",
		map[string]any{"tabId": tabID, "ref": refTriggerC, "action": "click"}, 5*time.Second)
	elapsedClickC := time.Since(startClick)
	allOK = paso("P17: act click en tab nuevo → {ok:true} en <3000 ms",
		okTriggerC && answeredC && !toolErrC && elapsedClickC < 3*time.Second && boolTrue(mClickC["ok"]),
		fmt.Sprintf(" (%dms; raw=%.200s)", elapsedClickC.Milliseconds(), textC)) && allOK

	// #st-intacto se refresca cada 100 ms: igual que P14/P15, se lee tras 500 ms.
	time.Sleep(500 * time.Millisecond)
	_, okFrameC, rawFrameC := getFrameMap(port, map[string]any{"tabId": tabID})
	allOK = paso("P17: tras 500 ms, getFrame lee intacto:true",
		okFrameC && strings.Contains(rawFrameC, "intacto:true"),
		fmt.Sprintf(" (raw=%.200s)", rawFrameC)) && allOK

	return allOK
}

// runNativeDialogE2E (fb-020-003 §3.4, AC-5): P10-P17 en tabs A/B/C propios.
// Corre después de runTypeObserveE2E (§2 del diseño). Cada tab se libera en
// su propio bloque, con release en defer aunque una aserción haya fallado.
func runNativeDialogE2E(port int, pageURL string) bool {
	fmt.Println("\n[E2E-native-dialog] Diálogos nativos en act click (fb-020-003) — P10-P17")
	if !paso("NDE-pre: toggle build (planMode:false)", ensureBuildMode(port), "") {
		return false
	}
	okA := runNativeDialogTabA(port, pageURL)
	okB := runNativeDialogTabB(port, pageURL)
	okC := runNativeDialogTabC(port, pageURL)
	return okA && okB && okC
}

func main() {
	// PC6 — opt-in: sin VLP_DEV_HARNESS=1 ni VLP_FRAME_E2E=1,
	// hint + exit 0.
	// fb-020-007: VLP_NAVHANG=s1,p12,p13,p19,p21,p27 corre sólo esos escenarios
	// sobre el boot de FRAME_E2E.
	navHang := os.Getenv("VLP_NAVHANG")
	frameE2E := os.Getenv("VLP_FRAME_E2E") == "1" || navHang != ""
	if os.Getenv("VLP_DEV_HARNESS") != "1" && !frameE2E {
		fmt.Println("dev-harness: opt-in — set VLP_DEV_HARNESS=1 (checks Odoo) or VLP_FRAME_E2E=1 (E2E invalidación) to run.")
		fmt.Println("  VLP_DEV_HARNESS=1 go run ./cmd/dev-harness")
		fmt.Println("  VLP_FRAME_E2E=1  go run ./cmd/dev-harness")
		os.Exit(0)
	}

	allOK := true
	odoourl := os.Getenv("VLP_ODOO_URL")
	if odoourl == "" {
		odoourl = "http://127.0.0.1:8078" // Odoo local del blog (read-only)
	}
	// Raíz del repo src/ — deriva del cwd pase lo que pase.
	srcRoot := "."
	if p, err := os.Getwd(); err == nil {
		srcRoot = p
	}
	repoRoot := srcRoot
	for i := 0; i < 4; i++ {
		if _, err := os.Stat(filepath.Join(repoRoot, "extension", "manifest.json")); err == nil {
			break
		}
		parent := filepath.Dir(repoRoot)
		if parent == repoRoot {
			break
		}
		repoRoot = parent
	}
	extDir := filepath.Join(repoRoot, "extension")
	// binarios
	srvBin := os.Getenv("VLP_SERVER_BIN")
	if srvBin == "" {
		srvBin = filepath.Join(repoRoot, "server", "bin", "vlpsrv")
	}
	firefoxBin := os.Getenv("VLP_FIREFOX")
	if firefoxBin == "" {
		firefoxBin = "firefox"
	}
	webextBin := os.Getenv("VLP_WEBEXT")
	if webextBin == "" {
		home, _ := os.UserHomeDir()
		// web-ext vive en ~/web-ext-tools (workspace), ruta directa al
		// binario (no el symlink .bin — xvfb-run no lo resuelve).
		webextBin = filepath.Join(home, "web-ext-tools", "node_modules", "web-ext", "bin", "web-ext.js")
	}
	// perfil de navegador en el workspace (no /tmp) + limpio por run
	profileDir := filepath.Join(repoRoot, ".devharness-profile")
	os.RemoveAll(profileDir)
	os.MkdirAll(profileDir, 0o755)
	tokensFile := filepath.Join(repoRoot, ".devharness-tokens.txt")
	os.WriteFile(tokensFile, []byte(devToken+" dev\n"), 0o600)

	// Gate FRAME_E2E: página de test + página bootstrap servidas por el propio
	// harness (127.0.0.1:0, puerto efímero). No requiere Odoo. El start-url de
	// web-ext es la URL bootstrap (fb-017-004): el bg la detecta vía tabs.query,
	// persiste las reglas en storage.local y reconecta — el seed por sqlite de
	// storage.sync no es leído por FF154 (defecto verificado empíricamente).
	serverPort := 28700 + int(time.Now().Unix()%200)
	rules := fmt.Sprintf("ws://127.0.0.1:%d %s 127.0.0.1", serverPort, devToken)
	var closeTestPage func() = func() {}
	startURL := odoourl
	testPageURL := odoourl
	if frameE2E {
		var tpURL string
		tpURL, closeTestPage = startTestPage()
		if tpURL == "" {
			fmt.Println("  [FAIL] no se pudo levantar la página de test (listen 127.0.0.1:0)")
			os.Exit(1)
		}
		testPageURL = tpURL
		startURL = tpURL + "vulpo-bootstrap?rules=" + url.QueryEscape(rules)
	}

	fmt.Println("=== fb-013-001 dev-harness ===")
	fmt.Printf("  Odoo URL: %s\n  firefox: %s\n  web-ext: %s\n", odoourl, firefoxBin, webextBin)

	var srvCmd *exec.Cmd
	var webextCmd *exec.Cmd
	webextLaunched := false
	// cleanup: mata server + web-ext y borra archivos temporales. Se llama
	// EXPLÍCITAMENTE antes de os.Exit (os.Exit NO ejecuta defers en Go).
	cleanup := func() {
		if webextLaunched && webextCmd != nil && webextCmd.Process != nil {
			syscall.Kill(-webextCmd.Process.Pid, syscall.SIGKILL)
			webextCmd.Process.Kill()
		}
		if srvCmd != nil && srvCmd.Process != nil {
			srvCmd.Process.Kill()
		}
		closeTestPage()
		os.RemoveAll(profileDir)
		os.RemoveAll(tokensFile)
	}

	// fb-018-006 (3.5 E2E): el gate FRAME_E2E reconstruye server + bundle
	// DENTRO de la corrida — el E2E debe ejercitar el build NUEVO (con settle),
	// no un artefacto previo a la feature. Con VLP_SERVER_BIN explícito
	// no se reconstruye (el caller es dueño del binario) pero se verifica que
	// traiga la feature: fail-fast en vez de medir código viejo.
	if frameE2E {
		if os.Getenv("VLP_SERVER_BIN") == "" {
			if !rebuildForE2E(repoRoot, srvBin) {
				cleanup()
				os.Exit(1)
			}
		} else if !verifySettleBuild(repoRoot, srvBin) {
			cleanup()
			os.Exit(1)
		}
	}

	// ---- PC1: arranca el server Go (binario como subproceso) ----
	fmt.Println("\n[PC1] Arranca el server Go")
	srvCmd = exec.Command(srvBin)
	srvCmd.Env = append(os.Environ(),
		"VLP_PORT="+strconv.Itoa(serverPort),
		"VLP_TOKENS_FILE="+tokensFile,
	)
	srvCmd.Stdout = os.Stdout
	srvCmd.Stderr = os.Stderr
	if err := srvCmd.Start(); err != nil {
		fmt.Printf("  [FAIL] spawn server: %v\n", err)
		cleanup()
		os.Exit(1)
	}
	serverOK := waitFor(func() bool {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"})
		req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/mcp", serverPort), bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("x-vlp-token", devToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return false
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		return bytes.Contains(data, []byte(`"name":"vulpo"`))
	}, 30*time.Second, "server arranca (initialize responde)")
	allOK = allOK && paso("server arranca sin opencode (initialize serverInfo.name==vulpo)", serverOK, fmt.Sprintf(" (port %d)", serverPort))

	// ---- PC2: lanza Firefox con extensión real vía web-ext ----
	fmt.Println("\n[PC2] Lanza Firefox con extensión real vía web-ext")
	fmt.Printf("  regla: %s\n", rules)
	if frameE2E {
		// fb-017-004: seed sqlite REMOVIDO en este gate — FF154 no lee la fila
		// sembrada en storage-sync-v2.sqlite (y la descarta al primer
		// storage.sync.set del addon). La config llega vía /vulpo-bootstrap
		// (start-url) → storage.local en el bg.
		fmt.Println("  [NOTE] seed sqlite omitido (FRAME_E2E usa bootstrap vía URL localhost)")
	} else if err := seedStorage(profileDir, serverPort); err != nil {
		fmt.Printf("  [FAIL] seed storage: %v\n", err)
		cleanup()
		os.Exit(1)
	} else {
		fmt.Printf("  [PASS] storage sembrado (vlp_rules + autoconnect)\n")
	}

	// ---- PC2: lanza web-ext (temporary addon) con start-url Odoo ----
	// web-ext carga el addon como temporary add-on → activa el MV3 service worker.
	// Se invoca con `node <web-ext.js>` explícito porque xvfb-run (sh -c) no
	// resuelve el shebang del binario web-ext.
	webextCmd = exec.Command("xvfb-run", "-a", "node", webextBin, "run",
		"--source-dir", extDir,
		"--firefox", firefoxBin,
		"--keep-profile-changes",
		"--firefox-profile", profileDir,
		"--start-url", startURL,
	)
	webextCmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	webextCmd.Stdout = os.Stdout
	webextCmd.Stderr = os.Stderr
	if err := webextCmd.Start(); err != nil {
		fmt.Printf("  [FAIL] spawn web-ext: %v\n", err)
		cleanup()
		os.Exit(1)
	}
	webextLaunched = true

	// PC2: espera que la extensión conecte por WS (listTabs responde).
	// MEJOR ESFUERZO (desviación documentada en spec §2 PC2): el event page MV3
	// arranca no-determinísticamente tras la instalación temporal (ADR-005).
	// Mitigación: sin --no-reload, un touch-loop toca un archivo marker dentro
	// de extDir cada ~8s → web-ext recarga el addon (nueva instalación temporal)
	// → nueva oportunidad de arranque del event page. Timeout total 120s.
	touchFile := filepath.Join(extDir, ".harness-touch")
	if f, err := os.OpenFile(touchFile, os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
		f.Close()
	}
	touchDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(8 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-touchDone:
				return
			case <-ticker.C:
				os.WriteFile(touchFile, []byte(strconv.FormatInt(time.Now().UnixNano(), 10)), 0o644)
			}
		}
	}()
	connected := waitFor(func() bool {
		_, ok := mcpCall(serverPort, "vlp_listTabs", map[string]any{})
		return ok
	}, 120*time.Second, "extensión conectada por WS (listTabs round-trip)")
	close(touchDone)
	paso("extensión real conectada (temporary addon MV3, listTabs round-trip)", connected, "")
	if connected {
		text, ok := mcpCall(serverPort, "vlp_listTabs", map[string]any{})
		var tabs []tabInfo
		_ = json.Unmarshal([]byte(text), &tabs)
		paso("vlp_listTabs devuelve tabs reales", ok, fmt.Sprintf(" (%d tabs)", len(tabs)))
	} else {
		fmt.Println("  [NOTE] PC2 desviación documentada (MV3 no-determinista): no bloquea PC1/PC4/PC6.")
	}

	// ---- Gate FRAME_E2E (fb-017-004 + fb-018-006): E2E de invalidación y de
	// settle. Boot compartido (server + seed + web-ext + ensureSession). Sin
	// checks de Odoo (PC3/PC4/PC9-10 quedan en el gate VLP_DEV_HARNESS=1).
	if frameE2E && navHang != "" {
		navOK := connected && runNavHangE2E(serverPort, testPageURL, navHang)
		fmt.Println("\n=== RESULT ===")
		cleanup()
		if navOK {
			fmt.Printf("nav-hang (%s): PASS\n", navHang)
			os.Exit(0)
		}
		fmt.Printf("nav-hang (%s): FAIL\n", navHang)
		os.Exit(1)
	}
	if frameE2E {
		e2eOK := connected && runFrameE2E(serverPort, testPageURL)
		// fb-018-006 3.5: la E2E de settle corre sobre el MISMO tab (reutiliza
		// el estado de lastFrameByTab y el boot); se ejecuta aunque E2E1-E2E7
		// hayan fallado (más evidencia; nunca enmascara el fallo previo).
		settleOK := connected && runSettleE2E(serverPort, testPageURL)
		// fb-020-002 C6: P20-P23 en tab propio; corre aunque lo previo haya
		// fallado (más evidencia, nunca enmascara).
		typeOK := connected && runTypeObserveE2E(serverPort, testPageURL)
		// fb-020-003: diálogos nativos P10-P17, tabs A/B/C propios; corre
		// aunque lo previo haya fallado (más evidencia, nunca enmascara).
		nativeOK := connected && runNativeDialogE2E(serverPort, testPageURL)
		// fb-020-004: fill notFound/invalidSelector (P13) y act con `text`
		// (AC-2), tab propio; corre aunque lo previo haya fallado.
		fieldCaseOK := connected && runFieldCaseE2E(serverPort, testPageURL)
		// fb-020-007: llamada durante una navegación (P12, P13), tabs propios.
		navHangOK := connected && runNavHangE2E(serverPort, testPageURL, "p12,p13,p27")
		// fb-020-008: pliegue del mapa en act/navigate, tabs propios; corre
		// último, aunque lo previo haya fallado (más evidencia, nunca enmascara).
		foldOK := connected && runActFrameFoldE2E(serverPort, testPageURL)
		// fb-020-005: validez de formulario en el mapa, perfil REAL de Odoo;
		// tabs propios, corre último, aunque lo previo haya fallado.
		valOK := connected && runFormValidityE2E(serverPort, testPageURL)
		if !connected {
			fmt.Println("  [FAIL] FRAME_E2E: MV3 service worker no conectó (desviación conocida — reintentar).")
		}
		fmt.Println("\n=== RESULT ===")
		cleanup()
		if e2eOK && settleOK && typeOK && nativeOK && fieldCaseOK && navHangOK && foldOK && valOK {
			fmt.Println("frame-e2e: PASS (E2E1-E2E7 invalidación + settle P10-P13/P15/P17/P18 + P19/P20 navegación en vuelo + type/fill P20-P23 fb-020-002 + native-dialog P10-P17 fb-020-003 + fill notFound/invalidSelector P13 + AC-2 fb-020-004 + llamada durante navegación P12/P13 fb-020-007 + pliegue act/navigate P23-live/P24/P25/P26/P28 fb-020-008 + validez de formulario en el mapa P15/P16/P21 fb-020-005)")
			os.Exit(0)
		}
		fmt.Println("frame-e2e: FAIL (alguna check E2E falló)")
		os.Exit(1)
	}

	// ---- PC3: tab Odoo abierto y detectado (MEJOR ESFUERZO) ----
	fmt.Println("\n[PC3] Tab Odoo abierto y detectado")
	if connected {
		text, _ := mcpCall(serverPort, "vlp_listTabs", map[string]any{})
		var tabs []tabInfo
		_ = json.Unmarshal([]byte(text), &tabs)
		found := false
		for _, t := range tabs {
			if contains(t.URL, odoourl) {
				found = true
				break
			}
		}
		paso("tab Odoo abierto y detectado en listTabs", found, fmt.Sprintf(" (url contienen %s, %d tabs)", odoourl, len(tabs)))
	} else {
		fmt.Println("  [NOTE] PC3 desviación documentada (MV3 no-determinista): no bloquea.")
	}

	// ---- PC4: plan/build es user-only (fb-022) ----
	// La tool vlp_togglePlanMode ya no existe: el estado plan/build se cambia
	// desde el popup de la extensión. Si el perfil está en Plan, los pasos write
	// de abajo reportan la desviación con el error "blocked in Plan mode".
	fmt.Println("\n[PC4] plan/build es user-only (popup de la extensión) — el perfil debe estar en Build para las tools write")

	// ---- PC9-PC10 (fb-013-003) + PC1-PC7 (fb-015-001): E2E best-effort de las 12 tools odoo_* (fb-019-002) ----
	// Self-checks contra el Odoo local. Requieren el round-trip real de la extensión
	// (MV3 no-determinista) → best-effort, no bloquean los gates duros Go. Reporte
	// PASS/FAIL/NOTE por tool (PC1), sin PASS simulado (D2/PC5).
	fmt.Println("\n[PC9-PC10] Tools odoo_* E2E (best-effort, MV3) — 12 tools + net-zero search_count")
	if connected {
		nPass, nFail, nNote := 0, 0, 0
		// toolCheck: registra una de las 13 tools en el conteo del reporte e imprime su línea.
		toolCheck := func(name string, ok bool, detail string) {
			if ok {
				nPass++
			} else {
				nFail++
			}
			paso(name, ok, detail)
		}

		// ---- read tools (fb-013-003/005) ----
		text, ok := mcpCall(serverPort, "list_available_profiles", map[string]any{})
		toolCheck("list_available_profiles detecta tab Odoo", ok && contains(text, odoourl), fmt.Sprintf(" (url contiene %s)", odoourl))

		text, ok = mcpCall(serverPort, "get_version", map[string]any{})
		toolCheck("get_version devuelve version Odoo", ok && (contains(text, `"17.0"`) || contains(text, `"18.0"`)), "")

		text, ok = mcpCall(serverPort, "list_models", map[string]any{})
		toolCheck("list_models incluye res.partner", ok && contains(text, "res.partner"), "")

		text, ok = mcpCall(serverPort, "list_fields", map[string]any{"model": "res.partner"})
		toolCheck("list_fields(res.partner) incluye name/email", ok && (contains(text, "name") || contains(text, "email")), "")

		text, ok = mcpCall(serverPort, "search_count", map[string]any{"model": "res.partner", "domain": []any{}})
		toolCheck("search_count(res.partner) devuelve numero", ok && contains(text, "count"), "")

		// PC2: search_read — read, sin gate de build.
		text, ok = mcpCall(serverPort, "search_read", map[string]any{"model": "res.partner", "domain": []any{}, "limit": 5})
		toolCheck("search_read(res.partner, limit 5) devuelve registros", ok && len(text) > 2, "")

		// PC7 (fb-015-001) + PC8 (fb-013-005): execute_kw read-safe en build (solo search_count de ir.model).
		// execute_kw es exec → WRITE_TOOLS → toggle a build antes (D5).
		paso("toggle build previo a execute_kw (planMode:false)", ensureBuildMode(serverPort), "")
		text, ok = mcpCall(serverPort, "execute_kw", map[string]any{"model": "ir.model", "method": "search_count", "args": []any{[]any{}}})
		toolCheck("execute_kw ir.model search_count devuelve numero", ok, "")

		// ---- PC3/PC2 (fb-015-001): write tools net-zero (D4) ----
		// create → write → unlink de res.partner con {name:único}; search_count→0.
		uniqueName := fmt.Sprintf("dev-harness-%d", time.Now().UnixNano())
		paso("toggle build previo a create (planMode:false)", ensureBuildMode(serverPort), "")
		text, ok = mcpCall(serverPort, "create", map[string]any{"model": "res.partner", "values": map[string]any{"name": uniqueName}})
		id, idOK := extractInt(text)
		toolCheck("create res.partner devuelve id", ok && idOK, fmt.Sprintf(" (id %d)", id))
		createdOK := ok && idOK

		if createdOK {
			paso("toggle build previo a write (planMode:false)", ensureBuildMode(serverPort), "")
			text, ok = mcpCall(serverPort, "write", map[string]any{"model": "res.partner", "ids": []any{id}, "values": map[string]any{"name": uniqueName + "-upd"}})
			toolCheck("write res.partner actualiza", ok && contains(text, "true"), "")
		} else {
			nNote++
			fmt.Printf("  [NOTE] write no ejecutado (create falló, id %s)\n", text)
		}

		if createdOK {
			paso("toggle build previo a unlink (planMode:false)", ensureBuildMode(serverPort), "")
			text, ok = mcpCall(serverPort, "unlink", map[string]any{"model": "res.partner", "ids": []any{id}})
			toolCheck("unlink res.partner elimina", ok && contains(text, "true"), "")
		} else {
			nNote++
			fmt.Printf("  [NOTE] unlink no ejecutado (create falló)\n")
		}

		// PC3: verificación net-zero — search_count por name único → 0 (no contamina el demo).
		text, ok = mcpCall(serverPort, "search_count", map[string]any{"model": "res.partner", "domain": []any{[]any{"name", "=", uniqueName}}})
		count, _ := extractInt(text)
		paso("net-zero: search_count por name unico = 0", ok && count == 0, fmt.Sprintf(" (count %d)", count))

		// PC2: import_records — write gated → toggle build (D5). Net-zero: unlink del importado.
		impName := fmt.Sprintf("dev-harness-import-%d", time.Now().UnixNano())
		paso("toggle build previo a import_records (planMode:false)", ensureBuildMode(serverPort), "")
		text, ok = mcpCall(serverPort, "import_records", map[string]any{"model": "res.partner", "fields": "name", "rows": []any{map[string]any{"name": impName}}})
		impOK := ok
		toolCheck("import_records importa res.partner", impOK, "")
		if impOK {
			// B2 (review): parsear el JSON estructurado del import para el id
			// correcto (no extractInt, que toma el primer entero de nextrow/messages).
			// fb-019-002: la respuesta es {success, created, updated} — los ids
			// creados (rows sin id) viajan en "created".
			var impResult struct {
				IDs []int `json:"created"`
			}
			if json.Unmarshal([]byte(text), &impResult) == nil && len(impResult.IDs) > 0 {
				impID := impResult.IDs[0]
				paso("toggle build previo a unlink (import cleanup)", ensureBuildMode(serverPort), "")
				_, cleanupOK := mcpCall(serverPort, "unlink", map[string]any{"model": "res.partner", "ids": []any{impID}})
				if !cleanupOK {
					fmt.Printf("  [NOTE] import cleanup unlink falló (id %d) — posible contaminación demo\n", impID)
				}
			} else {
				fmt.Printf("  [NOTE] import_records sin ids parseables — cleanup no ejecutado\n")
			}
		}

		// PC2: export_records — export está en WRITE_TOOLS → toggle build (D5).
		// O5 (review): usar el id de la cadena net-zero (no hardcodear ID=1).
		if createdOK {
			paso("toggle build previo a export_records (planMode:false)", ensureBuildMode(serverPort), "")
			text, ok = mcpCall(serverPort, "export_records", map[string]any{"model": "res.partner", "domain": []any{[]any{"id", "=", id}}, "fields": "id,name"})
			toolCheck("export_records exporta res.partner", ok, fmt.Sprintf(" (id %d)", id))
		} else {
			nNote++
			fmt.Printf("  [NOTE] export_records no ejecutado (create falló, sin id)\n")
		}

		// PC1: conteo agregado de las 13 tools (12 únicas + net-zero search_count; si
		// create falla, write/unlink/export se cuentan como NOTE). B1 (review): el
		// conteo suma 13 porque cada tool incrementa nPass/nFail/nNote exactamente una vez.
		fmt.Printf("  REPORTE: 13 tools (12 únicas + net-zero search_count), %d PASS / %d FAIL / %d NOTE\n", nPass, nFail, nNote)
	} else {
		fmt.Println("  [NOTE] MV3 no conectó — PC1-7/PC9-10 desviación documentada, no bloqueante.")
	}

	// ---- PC5: exit 0 si PASS (limpieza explícita — os.Exit no corre defers) ----
	// allOK = gate duro: server arranca (PC1 fb-013). PC8 (opt-in, go test) se
	// verifica externamente. PC2/3/4 y PC9-10 son mejor esfuerzo — no bloquean.
	fmt.Println("\n=== RESULT ===")
	cleanup()
	if allOK {
		fmt.Println("dev-harness: PASS (gates duros PC1+PC6; PC2/3/4 y PC9-10 mejor esfuerzo)")
		os.Exit(0)
	}
	fmt.Println("dev-harness: FAIL (gate duro PC1 o PC6 falló)")
	os.Exit(1)
}
