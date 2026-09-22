---
name: vulpo-odoo-web
description: Odoo-specific recipes for navigating the webapp through the frame driver (getFrame/act) — installing a module from Apps, the "Save manually" pattern, adding lines to a document (many2one in a row), numeric fields (float, monetary, quantities: the user's convention, prefer the ORM tool `write`, measured examples), sending/confirming a document (workflow with state mutation), and when to use the ORM tools (`search_read`, `write`, etc.) instead of the browser. Complements the generic vulpo-web-navigation skill (read/act loop, dialogs, state verification, combobox) with what is specific to Odoo's UI. Use together with vulpo-web-navigation when the agent operates an Odoo instance through Vulpo.
---

# Odoo — specific recipes on top of vulpo-web-navigation

This skill assumes you already know the generic navigation loop (read → decide →
act → re-read, dialogs first, state verification, combobox) from the
`vulpo-web-navigation` skill. Here, only what is specific to Odoo's UI, verified on a
real demo (installing Purchase, creating products, building an RFQ).

Tool calls below are shown as `{"tool": ..., "arguments": ...}`: use your native
tool with those arguments, or `vlpmcp call <tool> '<arguments json>'` (see the
`vulpo` skill).

UI labels are quoted as they appeared on the measured instance (often in
Spanish, `es_ES`); the label always follows the user's language.

## Installing a module from Apps

Module card → `Activate` button in its footer → it stays `disabled` while
installing → wait and re-read (`getFrame`) until the card's state changes. Do not
assume instant installation: poll with `getFrame` instead of acting again on the
same button.

## Typical record-creation flow

Apps/the module's side menu (buttons of the top `nav`: Orders/Products/...)
→ list (`New` to create) → form in edit mode → fill in fields
→ **`Save manually`** (do not assume autosave) → verify in `read[]` that a
confirmation appears ("created"/"saved").

## Fixed-choice fields (`expands`): never type, open and pick (fb-020-009)

Odoo's fixed-choice selector widgets (e.g. `o_select_menu_toggler`) serialize
as a plain `input`/`textbox` with the current label as `value` — nothing in
the tag/role says it is a closed set. The tell is `expands`: the map marks
such an input/button with `expands:true|false` (taken from the nearest
ancestor's `aria-expanded` — see `vlp_getFrame`'s description).
**A field carrying `expands:false` (or `expands:true`, or the sibling key
`expanded` when the element declares its own `aria-expanded`) is a closed
set — do not `act type` into it**, no matter what the current `value` looks
like; `expands:false` still means "there is something to open here", not
"nothing to do".

Open it and pick, in one call: `act click` on the field's `ref`, with `frame`
folded into the same call, returns the map with the dropdown already open —
its options arrive as `role:"menuitem"` entries, the currently-selected one
carrying `selected:true` (measured):

```json
{"name":"Cantidad ordenada","role":"menuitem","selected":true,"ref":"…>span:1"}
```

Then `act click` on the wanted option's `ref`. Two calls total (open, pick) —
never a `type` on a field with `expands`/`expanded`.

## Detecting a blocked form (required/invalid fields)

**Odoo 19 does not emit `aria-invalid`** (measured 2026-09-17 on an expense
line with required account and journal empty, after pressing Save): the page
has no `[aria-invalid]` anywhere and the tab link carries no error class. Odoo
marks invalid fields only with its own classes instead: `o_field_invalid` on
the field widget and `o_invalid_cell` on one2many cells. Vulpo resolves
this through a site-detected validity convention (see the generic
`vulpo-web-navigation` skill), so **the map already carries the affected fields as
`invalidElements`/`invalidCount`** — no selector-based search of your own is
needed.

**Primary recipe: read `invalidElements` off the folded map in `act`.** Press
"Guardar"/"Save" with the fold attached, in a single call:

```json
{
  "tool": "vlp_act",
  "arguments": {
    "tabId": 7, "ref": "<Guardar/Save ref>", "action": "click",
    "frame": {"roles": ["button", "textbox", "combobox"], "namedOnly": true}
  }
}
```

There are **two branches**, and only one of them is free:

1. **Save attempted (`ok:true`).** This is the case this feature optimizes,
   and the only branch where Odoo has *just put the marks on*, as a
   consequence of the attempt: the response's `frame.invalidElements` already
   lists every offending field, each with a `ref` you can act on directly
   (`act type`) and a `name` (possibly `""`). **Zero extra calls** — the N
   invalid fields all arrive in the one response that pressed Save.
2. **Save disabled (`ok:false`, `disabled:true`).** No action was dispatched,
   so there is no folded map to read (see `vulpo-web-navigation` §1b: the fold only
   runs on `ok:true`). Reach `invalidElements` with **one** `getFrame` call on
   that same tab. Still far better than one `getDOM` per field, but it is
   **one call, not zero** — do not present it as free.

**The absence of `invalidElements` does NOT prove the record was saved.**
This is the most dangerous false negative here: the map can be serialized
before Odoo has finished painting the invalid classes, so a response without
`invalidElements` can arrive even though the save is about to fail. The only
confirmation is a success message in `read[]` ("creado"/"guardado" or
equivalent) — never the absence of the key. If `read[]` shows no
confirmation, re-read before concluding the save went through.

**Possible false positive.** Odoo can leave an `o_field_invalid`/
`o_invalid_cell` class in place transiently (a field already fixed but not yet
revalidated, a row mid-discard). If a field reported as invalid already shows
the value you expect, press Save again to force revalidation before trusting
the mark.

**`notInMap` entries.** An empty required cell outside edit mode has no
interactive descendant and no text of its own, so it cannot be a portador: it
arrives as an `invalidElements` entry with `notInMap:true`. Its `ref` still
resolves and is clickable — clicking it enters edit mode, and only then can
you `act type` into it. Re-read after clicking before writing.

Once the reported fields are fixed, save again and re-check `invalidElements`
and `read[]`.

## Document lines (many2one in a row)

For orders/documents with lines (e.g. RFQ, invoice): `Add a product` (or
equivalent) creates a new row. That row's product field is a many2one
combobox — apply the generic recipe from `vulpo-web-navigation` §5 (type → re-read →
click option). Quantity and other numeric fields of the row are normal inputs
inside the same freshly created row — remember to `getFrame` again after
clicking the combobox option before touching the quantity cell, because adding
the row mutated the DOM.

## Numeric fields (float, monetary, quantities)

See `vulpo-web-navigation` §5c for the generic principle (the site interprets the text
exactly as written, with its own separator convention). Here, what is specific to
Odoo.

**If the task does not require the interface, prefer the ORM tool `write` to
persist numbers.** If the instructions ask you to do it through the interface, or
what is being tested is the UI flow, follow the UI path below. When `write` is
appropriate, it takes `model`, `ids` and `values` (JSON object) — the number goes
as a number, for example:

```json
{
  "tool": "write",
  "arguments": {
    "model": "product.template",
    "ids": "30",
    "values": {"weight": 3.5}
  }
}
```

It does not go through the UI's language parser, so the separator problem
disappears at the root. Verify the result with `search_read`. It is not measured
whether `write` reproduces the onchange recalculations you do see when filling
the field from the form (for example, a quantity change that recalculated a
line's unit amount) — if the flow depends on those recalculations, re-read the
derived fields via `search_read` after writing.

If `write` fails with `odoo_no_tab`, `odoo_detection_failed` or
`odoo_tab_unreachable` and the fix in the section below does not help, use the UI
path that follows. Since reading the convention also
uses ORM tools, if they fail the same way apply `vulpo-web-navigation` §5c points 2 and
3 (infer from an already formatted value showing both separators, or ask). If
`write` fails for another reason (permissions, validation, plan mode), do not
work around it through the interface: report the error.

**Before writing through the UI, read the user's separator convention.**

**First, `get_version` (extension ≥ 0.5.0).** Besides what it already returned,
it brings `lang`, `decimal_point` and `thousands_sep` of the session's user — no
other call needed. These three keys are optional: if the session is not valid or
reading the language on the server fails, `get_version` still responds but
without those keys (never `null`). In that case, fall back to the three-call
recipe below. The convention keys exist since 0.5.0, but this skill's full
recipe — which also relies on the observation from `act type`/`fill`
(`vulpo-web-navigation` §3b) — requires extension **≥ 0.5.0**.

**If `get_version` does not bring the three keys,** three-call recipe, **once per
session** (no need to repeat it for each field):

1. `get_version` → returns, among other data, the user's `uid`.

   ```json
   {"tool": "get_version", "arguments": {}}
   ```

2. `search_read` on `res.users`, filtering by that `uid` (integer, no quotes —
   measured with `uid` 2), requesting the `lang` field:

   ```json
   {
     "tool": "search_read",
     "arguments": {
       "model": "res.users",
       "domain": [["id", "=", 2]],
       "fields": ["lang"]
     }
   }
   ```

3. `search_read` on `res.lang`, filtering by that `lang`, requesting
   `decimal_point` and `thousands_sep`:

   ```json
   {
     "tool": "search_read",
     "arguments": {
       "model": "res.lang",
       "domain": [["code", "=", "<lang>"]],
       "fields": ["decimal_point", "thousands_sep"]
     }
   }
   ```

Measured values: with an `es_ES` user, `decimal_point` is `","` and
`thousands_sep` is `"."`. On the same instance, with `en_US`, it is the other way
around: `decimal_point` `"."` and `thousands_sep` `","`. Only es_ES and en_US are
documented here, and writing was measured in both (see tables below). For any
other `lang`, always read it; do not extrapolate.

**Measured examples, es_ES** (what was written through the UI, `act type` except
rows marked as typed by a human; what the input showed afterwards; and what was
persisted, read via ORM):

| Sent | Displayed | Persisted | Reference |
|---|---|---|---|
| `3,5` | `3,50` | 3.5 | N2 |
| `3.5` | `35,00` | 35 | N3 |
| `4100,5` | `4.100,50` | 4100.5 | N7 |
| `1003.5` (typed by a human) | `10.035,00` | not saved | manual control |
| `3,56789` (typed by a human) | `3,57` | **not measured** | manual control |

`3.5` (with a dot, the convention of someone who does not know `es_ES`) was saved
as `35`: the dot is lost (exact mechanism **not measured**). `3,5` (with a comma,
the local convention) was saved correctly as `3.5`.

**Measured examples, en_US** (same field, inverted convention:
`decimal_point "."`, `thousands_sep ","`; `act type`, value displayed with
`settle`):

| Sent | Displayed | Reference |
|---|---|---|
| `3.5` (dot, local convention) | `3.50` | EN-punto |
| `3,5` (comma) | `35.00` | EN-coma |
| `1234.5` (no thousands separator) | `1,234.50` | EN-miles |
| `1,234.5` (with thousands separator) | `1,234.50` | EN-miles-coma |

The symmetry is confirmed: with the inverted convention, the comma is lost just
like the dot in `es_ES` — the order-of-magnitude error depends on the convention,
not on a particular language. `1,234.5` (EN-miles-coma) is the first measurement
of writing **with** a thousands separator: it was interpreted correctly in en_US;
in es_ES, writing with a thousands separator is **not measured**.

`act type` committed the value in all these contexts: form with tabs, monetary
field, editable one2many list (click on the cell to enter edit mode → re-read the
frame → `type`) and quantity of a delivery move (click on the row → re-read the
frame → `type`).

**Verification and timing.** First check: the `value` of the `act type` response
(see above and `vulpo-web-navigation` §3b/§5c) — compare the number against the wanted
one under the site's convention. In fields with a server onchange, the input
keeps the raw text as typed until the server's response comes back, so if
`settled:false` or `detached`, or if what matters is a derived value (not the
field itself), re-read with `getFrame settle:true` and the default `quietMs`
before concluding what was stored. A line's derived values (amount, taxes,
document total) can update after the line itself: do not lower `quietMs` to speed
up the read, you can read a half-applied state. The signal that there are unsaved
changes is the save/discard buttons ("Guardar manualmente" / "Descartar todos los
cambios" in es_ES; the label follows the user's language). These buttons only
exist in the DOM while the form has pending changes: they do not appear in the map
before modifying anything, and they do afterwards (evidence:
`findings/fb-020-002-campo-v2-2026-09-13/ac8-calls.jsonl` #0/#2, without the
buttons, versus #6/#8/#11, with them). After Save, the judge is `search_read`,
never the input. "Descartar todos los cambios" does not ask for confirmation: the
changes are lost on click, with no intermediate dialog. Saving right after `act`,
without a pause, persisted correctly on a field **without** a server onchange;
with a server onchange it is **not measured**.

**Measured case: `value` with the field's previous value, `settled:true`.** In
"Precio de venta", writing `1234,5` returned `{"ok":true,"settled":true,
"value":"4.000,00","waitedMs":569}` — `4.000,00` was the value the field had
**before** writing, not what was sent nor its formatted version; re-reading with
`getFrame settle:true` showed `1.234,50` (correct) and the save was also correct.
It happened once in 8 attempts; 0 in 7 controlled replicas (`C9s-*`, `C9x-*`,
`C9y-*` in `findings/fb-020-002-campo-v2-2026-09-13.md`). The mechanism is not
measured (the site's CSP blocks `eval`, so the field's internal state at that
moment could not be inspected); **inferred**: Odoo restores the value the record
had before applying the change while it silently processes the onchange, and that
restoration was captured as if it were the final value. See `vulpo-web-navigation` §5c
for the generic case.

### Finding H: rewriting a field with the same number can leave the form marked dirty

**Measured:** on a numeric field already at `6,25`, writing `6,250` (same number,
different text) made the input show `6,25` again, but the "Guardar"/"Descartar"
buttons stayed visible after Discard — also after a second discard. Reloading the
page (normal reload, no autosave) did clear the mark (`H-reload-dirty`);
`write_date` unchanged (`H-reload-wd`). It does not happen with the same unchanged
text, with a different number, or with no change at all (`H-iso`, `HB`, `HC`).

**Mechanism (inferred from source, not measured in Vulpo):** read in the Odoo
19 community code (`addons/web/static/src/views/fields/input_field_hook.js`), the
event that clears the "field modified" mark (`FIELD_IS_DIRTY(false)`, consumed by
`addons/web/static/src/views/form/form_status_indicator/form_status_indicator.js`)
is only emitted, both in `onChange` and in `commitChanges`, in the branch where
the parsed number differs from the last recorded one; if the final number is
equal, the field is restored visually but that mark is not cleared. **Reproduced
by hand:** a human control with a real keyboard, repeating the exact sequence
after `Ctrl+F5`, reached the same stuck state — so it is not an artifact of
`act`'s synthetic writing; it is an Odoo defect. Reported upstream:
https://github.com/odoo/odoo/issues/287978.

**Scope of `value` in this case (I-6):** in HA, the input correctly showed `6,25`
(frame read, S1) — the field's number — while the form was still marked with
pending changes; `value`, which reads that same field, would report the same
(**inferred**, not measured directly with `value` in this case). Neither `value`
nor the frame read tell whether the form stayed marked or whether "Descartar"
fully cleared it: that has to be verified another way (save/discard buttons, or
reloading).

**Practical recommendation:** if the field already shows the number you want, do
not rewrite it "to make sure" — doing so can leave the form marked with pending
changes even though the value did not change. Check with the `value` of the
`act type` response whether the number is already the wanted one, and do not
rewrite that field.

## Sending and confirming a document (workflow with state mutation)

Verified end-to-end (Send RFQ → Confirm order, Odoo 19). The statusbar
(`radiogroup` with radios `checked:true/false`) is the source of truth for the
state at each step.

1. **Action buttons are REORDERED according to state.** When going from SdP to
   SdP enviada, "Confirmar pedido" jumped from `button:nth-of-type(2)` to
   `button:nth-of-type(1)`. Never cache an action button's position: resolve by
   `name` after each re-read.
2. **A disabled `Enviar` button in a dialog = missing data that Odoo asks for in
   the dialog itself.** Real example: "Enviar SdP" opens the email wizard; if the
   vendor has no email, the wizard asks for it ("¿Cuál es la dirección de correo
   electrónico de ...?") and the footer's Enviar button stays disabled. The fix is
   to fill in the field the dialog offers (input + "Establecer dirección de
   correo" button) — do not force the button or discard. Careful: once resolved,
   the wizard restructures and ALL refs change.
3. **On confirmation, the form switches to read-only mode.** Inputs
   (combobox/textbox) become links (`role: link`); the edit refs cease to exist.
   Verify the state via the statusbar or chatter, not via the presence of inputs.
4. **The table structure changes according to state.** After confirmation,
   "Recibido"/"Facturado" columns and smart buttons ("1 Recepción") appear.
   Another reason not to cache structure: each `getFrame` is the only truth.

## One call per interaction on dense forms (fb-020-008)

Odoo forms are exactly the case the `act`/`navigate` `frame` fold targets:
a real order/document view can carry far more than 200 candidate elements, so
an unfiltered folded map's page 1 is unlikely to contain the next field you
need — you would still have to re-read, which defeats the point of folding.
Narrow every folded read with `roles`/`namedOnly` to the kind of element
you are actually filling next, for example:

```json
{
  "tool": "vlp_act",
  "arguments": {
    "tabId": 7, "ref": "main>form>div:2>input", "action": "type", "value": "Acme",
    "frame": {"roles": ["textbox", "combobox"], "namedOnly": true, "maxElementsPerPage": 50}
  }
}
```

Same rule for `vlp_navigate` when you know you will act on the
destination document right away (e.g. opening a record from a direct URL):
pass `frame` narrowed the same way instead of a plain `navigate` followed by
`getFrame`. See the `vulpo-web-navigation` skill §1b for the general pattern, the
`frameError` handling, and when the fold is not worth it.

## `getFrame`/`act` (logged-in session) vs. ORM tools (`search_read`, `write`, etc. — direct RPC)

`getFrame`/`act` operate on the user's already logged-in session in the browser
tab — this is the path to use when you need to interact with the UI as the user
sees it (forms, wizards, flows with UI validations).

The ORM tools (`search_read`, `write`, `create`, `unlink`, `execute_kw`, and the
rest of the registered family — unprefixed) are the direct RPC path (they do not
go through the DOM and do not require the UI to be rendered). They run in one
Odoo tab of your token:

- **Choosing the tab.** Pass `tabId` to target a specific Odoo tab. Without
  `tabId`, if all detected Odoo tabs are the same instance (origin and db) the
  lowest `tabId` is used; if they are different instances the call fails with
  `odoo_ambiguous_tab` listing `{tabId, origin, db}` of each — retry with the
  right `tabId`. The server detects tabs on demand, so no prior
  `list_available_profiles` call is needed.
- **Which tab was used.** Every successful ORM call adds `content[1]` =
  `{"odoo_tab":{"tabId":N,"origin":"…","db":"…"}}` (with `vlpmcp call`, printed on stderr).
  Confirm the db before and after writes.
- **Errors** start with a code:
  - `odoo_no_tab` ("No Odoo tab detected"): no logged-in Odoo tab for your token,
    or the `tabId` is not one. Check `list_available_profiles`; ask the human to
    open/log in to Odoo.
  - `odoo_detection_failed`: tabs exist but no valid session (message says why).
    Ask the human to log in or reload, then retry.
  - `odoo_ambiguous_tab`: pass `tabId`.
  - `odoo_tab_unreachable`: the tab could not be reached (closed, navigating),
    or the page could not reach Odoo (network/fetch error); read the cause in
    the message. If it is a network/fetch error, check that the Odoo server is
    reachable. Otherwise ask the human to activate or reload the tab and retry
    once; if it keeps failing,
    use `getFrame`/`act` on the tab.
  - `odoo_command_failed`: Odoo's own error (permissions, validation, plan
    mode), with tabId, origin and db. Fix the call; do not work around it through
    the UI.
  - `odoo_command_timeout`: no answer and no heartbeat from the extension for
    45 s. Reads say "safe to retry"; writes say "re-read before retrying".
- **ORM and navigation.** After a click or a navigation, an ORM call waits for
  the page to load (up to 10 s) before it runs. Do not launch ORM calls in
  parallel with a navigation expecting both to run at the same time. If the tab
  navigates, `odoo_tab_unreachable` says what happened:
  - "the command was NOT dispatched; retry after the page loads": nothing was sent.
  - "the command did not complete; it is safe to retry": a read was cut; retry.
  - "the command may have been dispatched — re-read before retrying": a write
    was cut and Odoo may have applied it; re-read the records first.
- **Long operations.** Heavy actions, imports or `execute_kw` of processes may
  take minutes: while the tab stays on the same page, the page running the call
  sends a heartbeat every 15 s and there is no total limit (`command_timeout` only after
  45 s without answer or heartbeat). `vlpmcp` waits up to `VLP_TIMEOUT`
  (default 1800 s).

---

To connect to Vulpo and see the catalog of available tools, load the
`vulpo` skill. For the navigation loop itself, load `vulpo-web-navigation`.
