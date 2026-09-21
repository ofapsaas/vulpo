// Selección de pestaña ORM y errores categorizados (fb-020-006 §2.1–§2.3).
//
// Las 11 tools ORM (todas las odoo salvo list_available_profiles) resuelven la
// pestaña con odooTabResolver y envían sus comandos a través del odooTarget
// resuelto, que categoriza los errores del hub y reporta la pestaña usada.
package mcp

import (
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"vulpo/server/internal/odooregistry"
)

// Códigos estables de error ORM (§2.3).
const (
	codeOdooNoTab           = "odoo_no_tab"
	codeOdooDetectionFailed = "odoo_detection_failed"
	codeOdooAmbiguousTab    = "odoo_ambiguous_tab"
	codeOdooTabUnreachable  = "odoo_tab_unreachable"
	codeOdooCommandFailed   = "odoo_command_failed"
	codeOdooCommandTimeout  = "odoo_command_timeout"
)

// errOdooNoTab: detalle único de odoo_no_tab. No incluye el tabId pedido ni
// datos de otros tokens: un tabId ajeno y uno inexistente son indistinguibles
// (I-2). "No Odoo tab detected" queda reservado a este código (I-1).
var errOdooNoTab = fmt.Errorf("%s: No Odoo tab detected. Open an Odoo tab and log in, or pass the tabId of a detected Odoo tab (see list_available_profiles).", codeOdooNoTab)

// odooTabResolver: resuelve la pestaña Odoo de cada llamada ORM contra el
// registry, con detección bajo demanda (D-6) y memoria de la última falla de
// comando por token (§2.1 condición iii).
type odooTabResolver struct {
	registry *odooregistry.Registry
	hub      Hub

	mu        sync.Mutex
	failedTab map[string]int // token → tabId cuyo último comando ORM falló
}

func newOdooTabResolver(registry *odooregistry.Registry, hub Hub) *odooTabResolver {
	return &odooTabResolver{registry: registry, hub: hub, failedTab: map[string]int{}}
}

// resolve: aplica §2.1. Corre como máximo un Detect por llamada.
func (r *odooTabResolver) resolve(params map[string]any, token string) (*odooTarget, error) {
	requested, hasRequest, err := requestedOdooTabID(params)
	if err != nil {
		return nil, err
	}

	candidates := r.candidates(token)
	mustDetect := len(candidates) == 0 || (hasRequest && !containsTab(candidates, requested))
	if mustDetect {
		if candidates, err = r.detect(token); err != nil {
			return nil, err
		}
	}

	profile, err := pickOdooTab(candidates, requested, hasRequest)
	if err != nil {
		return nil, err
	}
	if !mustDetect && r.lastCommandFailed(token, profile.TabID) {
		if candidates, err = r.detect(token); err != nil {
			return nil, err
		}
		if profile, err = pickOdooTab(candidates, requested, hasRequest); err != nil {
			return nil, err
		}
	}
	return &odooTarget{resolver: r, token: token, profile: profile, tab: strconv.Itoa(profile.TabID)}, nil
}

// candidates: perfiles con sesión válida del token según el último Detect.
func (r *odooTabResolver) candidates(token string) []odooregistry.OdooTabProfile {
	var active []odooregistry.OdooTabProfile
	for _, p := range r.registry.List(token) {
		if p.IsActive {
			active = append(active, p)
		}
	}
	return active
}

func (r *odooTabResolver) detect(token string) ([]odooregistry.OdooTabProfile, error) {
	if err := r.registry.Detect(token, odooHubAdapter{h: r.hub}); err != nil {
		return nil, fmt.Errorf("%s: %v; fix the Odoo tab (log in or reload it) and retry", codeOdooDetectionFailed, err)
	}
	r.mu.Lock()
	delete(r.failedTab, token)
	r.mu.Unlock()
	return r.candidates(token), nil
}

func (r *odooTabResolver) lastCommandFailed(token string, tabID int) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	failed, ok := r.failedTab[token]
	return ok && failed == tabID
}

func (r *odooTabResolver) recordCommandOutcome(token string, tabID int, failed bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if failed {
		r.failedTab[token] = tabID
		return
	}
	delete(r.failedTab, token)
}

// requestedOdooTabID: `tabId` (número o string numérico) o el alias no
// documentado `profile`. Un `profile` no numérico no puede matchear ninguna
// pestaña: devuelve odoo_no_tab sin correr Detect.
func requestedOdooTabID(params map[string]any) (int, bool, error) {
	if v, ok := params["tabId"]; ok && v != nil {
		id, err := parseOdooTabID(v)
		if err != nil {
			return 0, false, err
		}
		return id, true, nil
	}
	if p := strArg(params, "profile"); p != "" {
		id, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return 0, false, errOdooNoTab
		}
		return id, true, nil
	}
	return 0, false, nil
}

func parseOdooTabID(v any) (int, error) {
	switch n := v.(type) {
	case float64:
		if n == float64(int(n)) {
			return int(n), nil
		}
	case int:
		return n, nil
	case string:
		if id, err := strconv.Atoi(strings.TrimSpace(n)); err == nil {
			return id, nil
		}
	}
	return 0, fmt.Errorf("tabId must be an integer or a numeric string, got %v", v)
}

func containsTab(profiles []odooregistry.OdooTabProfile, tabID int) bool {
	for _, p := range profiles {
		if p.TabID == tabID {
			return true
		}
	}
	return false
}

// pickOdooTab: con tabId, esa pestaña si es candidata; sin tabId, agrupa por
// (origin, db): 0 grupos → odoo_no_tab, 1 → menor tabId, ≥2 → odoo_ambiguous_tab.
func pickOdooTab(candidates []odooregistry.OdooTabProfile, requested int, hasRequest bool) (odooregistry.OdooTabProfile, error) {
	if hasRequest {
		for _, p := range candidates {
			if p.TabID == requested {
				return p, nil
			}
		}
		return odooregistry.OdooTabProfile{}, errOdooNoTab
	}
	if len(candidates) == 0 {
		return odooregistry.OdooTabProfile{}, errOdooNoTab
	}

	sorted := append([]odooregistry.OdooTabProfile(nil), candidates...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].TabID < sorted[j].TabID })

	groups := map[[2]string]bool{}
	for _, p := range sorted {
		groups[[2]string{odooOrigin(p.URL), p.DB}] = true
	}
	if len(groups) > 1 {
		return odooregistry.OdooTabProfile{}, ambiguousOdooTabError(sorted)
	}
	return sorted[0], nil
}

func ambiguousOdooTabError(sorted []odooregistry.OdooTabProfile) error {
	listed := make([]string, 0, len(sorted))
	for _, p := range sorted {
		listed = append(listed, fmt.Sprintf("{tabId %d, origin %s, db %s}", p.TabID, odooOrigin(p.URL), p.DB))
	}
	return fmt.Errorf("%s: the detected Odoo tabs belong to different instances (origin, db); pass tabId to choose one: %s",
		codeOdooAmbiguousTab, strings.Join(listed, "; "))
}

// odooOrigin: scheme://host[:port] de la URL de la pestaña.
func odooOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return raw
	}
	return u.Scheme + "://" + u.Host
}

// odooTarget: pestaña resuelta para una llamada ORM.
type odooTarget struct {
	resolver *odooTabResolver
	token    string
	profile  odooregistry.OdooTabProfile
	tab      string
}

// command: envía un comando ORM (una sola vez, sin reintento — I-4) y
// categoriza el error del hub (§2.3).
func (t *odooTarget) command(cmd Command) (any, error) {
	res, err := t.resolver.hub.Command(t.token, cmd)
	t.resolver.recordCommandOutcome(t.token, t.profile.TabID, err != nil)
	if err != nil {
		return nil, t.commandError(cmd, err)
	}
	return res, nil
}

func (t *odooTarget) commandError(cmd Command, err error) error {
	original := err.Error()
	if strings.HasPrefix(original, hubCommandTimeoutPrefix) {
		return fmt.Errorf("%s: %s (%s); %s", codeOdooCommandTimeout, original, t.describe(), retryAdvice(cmd))
	}
	if !strings.HasPrefix(original, codeOdooTabUnreachable+":") {
		return fmt.Errorf("%s: %s (%s)", codeOdooCommandFailed, original, t.describe())
	}
	notDispatched := strings.Contains(original, "NOT dispatched")
	// Una escritura que pudo despacharse nunca invita a reintentar sin releer (I-3, §9.3).
	if (odooWriteCommands[cmd.Command] && !notDispatched) || strings.Contains(original, "may have been dispatched") {
		// O-2: si el texto del hub ya pide releer, la cola del server no lo repite.
		if strings.Contains(original, reReadAdvice) {
			return fmt.Errorf("%s (%s)", original, t.describe())
		}
		return fmt.Errorf("%s (%s); %s", original, t.describe(), reReadAdvice)
	}
	// El texto ya trae el veredicto de despacho: sin sufijo genérico (§9.3).
	if notDispatched || strings.Contains(original, "safe to retry") {
		return fmt.Errorf("%s (%s)", original, t.describe())
	}
	return fmt.Errorf("%s (%s); activate or reload the Odoo tab and retry; if the cause is a network/fetch error, check that the Odoo server is reachable", original, t.describe())
}

// hubCommandTimeoutPrefix: error del hub al vencer el presupuesto de inactividad (fb-020-007 §2.3).
const hubCommandTimeoutPrefix = "command_timeout:"

// odooWriteCommands: comandos ORM que pueden modificar datos. execute_kw se
// trata como escritura porque el método invocado puede serlo (I-3).
var odooWriteCommands = map[string]bool{
	"odooCreate": true, "odooWrite": true, "odooUnlink": true,
	"odooImportRecords": true, "odooExecuteKw": true,
}

// reReadAdvice: única redacción del pedido de releer (§2.4, §9.3). Al ser una
// sola cadena, el chequeo de "ya lo trae el texto del hub" (O-2) no puede
// desincronizarse del sufijo que agrega el server.
const reReadAdvice = "re-read before retrying"

// retryAdvice: una escritura que pudo ejecutarse nunca invita a reintentar sin releer.
func retryAdvice(cmd Command) string {
	if odooWriteCommands[cmd.Command] {
		return reReadAdvice
	}
	return "safe to retry"
}

func (t *odooTarget) describe() string {
	d := fmt.Sprintf("tabId %d, origin %s", t.profile.TabID, odooOrigin(t.profile.URL))
	if t.profile.DB != "" {
		d += ", db " + t.profile.DB
	}
	return d
}

// odooTabReport: payload de content[1] (§2.2); db se omite si no se conoce.
type odooTabReport struct {
	TabID  int    `json:"tabId"`
	Origin string `json:"origin"`
	DB     string `json:"db,omitempty"`
}

// withTab: agrega el reporte odoo_tab como content[1] a un resultado exitoso;
// content[0] sigue siendo el resultado sin cambios (I-3).
func (t *odooTarget) withTab(result any, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	report, _ := marshalNoEscape(map[string]any{"odoo_tab": odooTabReport{
		TabID: t.profile.TabID, Origin: odooOrigin(t.profile.URL), DB: t.profile.DB,
	}})
	return multiContentResult{primary: result, extraTexts: []string{string(report)}}, nil
}
