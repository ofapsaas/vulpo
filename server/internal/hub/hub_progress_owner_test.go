// fb-020-007-orm-navigation-hang — sub-fase RED v1.2, aislamiento de latidos
// (docs/specs/fb-020-007-orm-navigation-hang/spec.md §9.7 y §9.8 P26):
// el hub ignora un `progress` si el remitente no es el dueño del comando
// (token de la conexión ≠ token del pending).
package hub

import (
	"strings"
	"testing"
	"time"
)

func TestFb007_P26_ForeignProgressDoesNotExtendCommand(t *testing.T) {
	const (
		idle = 200 * time.Millisecond
		eps  = 150 * time.Millisecond
	)
	th, wsA := fb007Hub(t, idle) // extensión A: tok1, pestaña 24
	wsB := &fakeWS{}
	th.register(t, wsB, "tok2") // extensión B: otro token

	start := time.Now()
	done := fb007Command(th, Command{Command: "odooExecuteKw", Params: map[string]any{}, TabID: "24"})
	id := fb007WaitCommandN(t, wsA, 1)[0]

	// B late con el id del comando de A cada B/4 durante 4·B.
	var r cmdResult
	finished := false
	for !finished && time.Since(start) < 4*idle {
		time.Sleep(idle / 4)
		select {
		case r = <-done:
			finished = true
		default:
			th.h.HandleMessage(wsB, fb007Progress(id, time.Since(start)))
		}
	}
	if !finished {
		r = fb007Await(t, done, 2*time.Second, "P26")
	}
	if r.err == nil || !strings.HasPrefix(r.err.Error(), "command_timeout:") {
		t.Fatalf("P26: con progress ajeno (tok2) err = %v, want command_timeout", r.err)
	}
	if r.elapsed > idle+eps {
		t.Fatalf("P26: venció a %v, want <= B+ε=%v (el latido de otra extensión no debe estirar el plazo)", r.elapsed, idle+eps)
	}
}

// Control mínimo: el mismo esquema con el progress enviado por el dueño (A)
// mantiene vivo el comando (P3 lo cubre en detalle).
func TestFb007_P26_OwnerProgressStillExtends(t *testing.T) {
	const idle = 200 * time.Millisecond
	th, wsA := fb007Hub(t, idle)
	wsB := &fakeWS{}
	th.register(t, wsB, "tok2")

	start := time.Now()
	done := fb007Command(th, Command{Command: "odooExecuteKw", Params: map[string]any{}, TabID: "24"})
	id := fb007WaitCommandN(t, wsA, 1)[0]
	for time.Since(start) < 2*idle {
		time.Sleep(idle / 4)
		select {
		case r := <-done:
			t.Fatalf("P26 control: con progress del dueño terminó a %v con err=%v", r.elapsed, r.err)
		default:
		}
		th.h.HandleMessage(wsA, fb007Progress(id, time.Since(start)))
	}
	th.h.HandleMessage(wsA, []byte(`{"type":"response","id":"`+id+`","result":1}`))
	if r := fb007Await(t, done, 2*time.Second, "P26 control"); r.err != nil {
		t.Fatalf("P26 control: err = %v, want éxito", r.err)
	}
}
