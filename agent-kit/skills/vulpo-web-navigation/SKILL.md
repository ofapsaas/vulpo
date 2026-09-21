---
name: vulpo-web-navigation
description: Generic pattern for navigating and interacting with modern SPAs/webapps through an accessibility-tree frame driver (paginated ref map + actions by ref, like Vulpo's getFrame/act). Covers the read→decide→act→re-read loop, why refs go stale after the DOM mutates, how to resolve modal dialogs before any other action, how to verify a view's real state (never the tab title), and the generic combobox/autocomplete recipe type→re-read→click option. Not specific to any site: applies to any webapp exposing an equivalent frame driver (Odoo, Salesforce, React admin panels, etc.). Use when an agent needs to navigate/interact with a complex webapp via accessibility instead of brittle CSS selectors.
---

# Generic web navigation via frame driver (accessibility)

This skill describes **how to navigate any SPA/webapp** using a frame driver: a
tool that serializes the visible accessibility tree into a paginated map with
stable refs (`getFrame`) and a tool that acts on those refs (`act`). It assumes
no particular site — for Odoo specifics see the `vulpo-odoo-web` skill; to connect and
list Vulpo's tools see the `vulpo` skill.

## 1. The loop: read → decide → act → re-read

The frame driver replaces dump-and-guess with CSS selectors. The cycle is:

1. **`getFrame`** → paginated accessible map: `sections[]` (elements with `ref`,
   `role`, `name`, `tag`, `disabled`, `visible`), `read[]` (global visible text,
   useful to read messages/state) and `do[]` (actionable refs). Includes
   `invalidation: {changedSinceLast}`.
2. **Decide with the map** — not with memory of a previous map — and act by
   `ref`: **`act {ref, action, value?}`** with `action` = click/type/focus/select.
   **The text parameter of `type`/`select` is `value`** (a string, required
   for those two actions; `value: ""` is the way to clear a field). *Server
   from Vulpo 0.5.0:* **unknown parameters are rejected** — e.g. `text` instead of
   `value` returns a tool error naming the unknown argument and listing the
   accepted ones, and nothing is dispatched (before, the field was silently
   emptied with `ok:true`). The same applies to `fill`.
   Response: `{ok:true}` | `{ok:false, stale:true}` (the ref no longer resolves →
   re-snapshot) | `{ok:false, inert:true, error}` (covered by a modal dialog,
   §3) | `{ok:false, disabled:true, error}` (disabled control, §3b) |
   `{ok:false, error}`. **`ok:true` does not mean the action had an effect**:
   verify it by re-reading (see §3b).
   - **Validation state** *(extension ≥ 0.5.0)*: an element marked invalid
     by the page (`aria-invalid` other than `"false"`, or `:user-invalid`)
     carries `invalid: true`, and the frame carries a top-level
     `invalidCount: N` with the total across all pages and filters. Both are
     absent when nothing is invalid. If a save does nothing, look for
     `invalidCount` first.
   - **Site-specific validity conventions** *(fb-020-005)*: some sites mark
     invalid fields only with their own non-standard convention (their own
     CSS classes, for example) instead of, or in addition to,
     `aria-invalid`/`:user-invalid`. Vulpo resolves these through a
     registry of DOM-detected site profiles, kept out of the generic
     serializer: when a profile's own detection matches the live DOM, its
     findings are folded into the same `invalid`/`invalidCount` surface
     above. Beyond that, the frame also carries a top-level, present-only
     `invalidElements` array (capped at 20 entries; `invalidCount` itself is
     never capped) with one summary per invalid element —
     `{ref, name, context?, field?, notInMap?}` — computed **before**
     `roles`/`namedOnly` filtering, pagination, and any promotion caps, so an
     invalid element stays reachable through it even when `sections` was
     narrowed past it. `ref` is directly actionable; `name` is always
     present (it can be `""`); `notInMap:true` marks an entry whose marker
     contains no element of the map (its `ref` still resolves and is
     clickable). When at least one entry came from a detected site
     convention, the frame also carries a top-level `invalidProfile: "<id>"`
     naming it — absent when all invalidity came from the standard path, or
     no convention matched. See the site-specific skill for the concrete
     conventions it uses, if any.
   - **`fill` by selector**: if nothing matches it returns
     `{success:false, notFound:true, error, selector}`; with a syntactically
     invalid CSS selector, `{success:false, invalidSelector:true, error,
     selector}`. Nothing was written in either case — fix the selector and
     retry.
3. **Never chain two blind `act`s.** Every action that mutates the DOM
   potentially invalidates the remaining refs of the map — after each mutation,
   read the map again before the next `act`.

## 1b. One call per interaction: fold the re-read into `act`/`navigate`

The re-read after step 3 does not have to be a second MCP round trip.
`vlp_act` and `vlp_navigate` accept an optional `frame` object
(absent by default — nothing changes if you don't pass it). When present, the
tool runs the action and, in the **same** response, returns exactly what a
`getFrame` call with those same parameters would have returned, nested under
`frame`. The old pattern was `act → getFrame → act → getFrame`; the new one is
`act` with `frame` → `act` with `frame`, one MCP call per interaction instead
of two.

Example (generic form, two fields to fill and inspect):

```
# Old pattern — 4 calls for 2 interactions
act {ref: nameField, action: "type", value: "Acme"}
getFrame {roles: ["textbox"], namedOnly: true}
act {ref: emailField, action: "type", value: "a@example.com"}
getFrame {roles: ["textbox"], namedOnly: true}

# New pattern — 2 calls for 2 interactions
act {ref: nameField, action: "type", value: "Acme",
     frame: {roles: ["textbox"], namedOnly: true}}
act {ref: emailField, action: "type", value: "a@example.com",
     frame: {roles: ["textbox"], namedOnly: true}}
```

The fold only runs when the action itself succeeded (`ok:true` for `act`); on
failure (`stale`/`inert`/`disabled`/a pending native dialog) the response is
identical to the unfolded one — nothing to read if nothing happened, and you
already know to re-snapshot. The fold's own map read can still fail even
though the action succeeded: that surfaces as a top-level `frameError:{error}`
instead of `frame`, never as a tool error. **`frameError` does not mean the
action failed** — it means the action completed but its own map read did not.
Re-read with a plain `getFrame` call; do not retry the action.

Inside the fold, `settle` defaults to `true` — the opposite of `getFrame`'s
own default — because an unsettled folded map would arrive mid-update and
force the same re-read the fold exists to avoid. Pass `frame:{settle:false}`
when you want an immediate, cheap read instead (e.g. you only need to confirm
the action dispatched, not the resulting screen).

With `vlp_navigate`, folding also changes what `success:true` asserts:
without `frame` it only means the navigation was dispatched; with `frame` it
means the destination document exists and was serialized. Do not treat an
unfolded `navigate`'s `success:true` as "the page loaded" — that promise only
comes with the fold.

**When the fold is not worth it:** if you are not going to read the screen
after the action (e.g. a `click` that closes a dialog and you have nothing
left to verify), or you specifically want the cheapest possible dispatch
without waiting on a document read, skip `frame` and call the action alone.
The fold trades a bit of latency (see §5b/§2.3.1 of the tool description for
the timeout budget) for one fewer round trip — use it when you were going to
re-read anyway.

**Narrow with `roles`/`namedOnly` on dense forms — same rule as §6, sharper
inside a fold.** A folded map that returns unfiltered page 1 of a large form
still forces a re-read to find the next ref, which defeats the whole point of
folding. At the same time, §6's warning still applies inside the fold: a
badly chosen filter can hide the very element you needed next, so narrow
based on what you already know you are looking for (e.g. `roles:["textbox",
"combobox"]` for a data-entry pass), not reflexively on every call.

`vlp_click`/`vlp_fill` (legacy CSS-selector tools) do **not**
support `frame` — see the `vulpo` skill for why and use `act` with `ref`
instead when you want the fold.

## 2. Why refs go stale

Refs are **positional** (tag + `nth-of-type` + `::shadow`), without id/class/
data-* (often undetectable or unstable in reactive frameworks). Any SPA
re-render (the framework remounts a subtree, a row is added/removed, a modal
opens/closes) can shift the positional indexes. Practical consequence: an `act`
on a ref taken before the last mutation can return `stale:true` — that is
expected, not a bug; the right response is to re-snapshot and retry, not to
retry the same ref.

### `invalidation.changedSinceLast` — what it guarantees and what it doesn't

- If `false`: the cached map is still valid byte for byte; you can reuse it
  without calling `getFrame` again (saves tokens).
- If `true`: it does **not** tell you what changed or whether it affects the refs
  you care about — only that the full snapshot differs from the previous one
  (conservative comparison, never a false negative). In apps with counters,
  clocks, or notifications that change on their own you will see `true` almost
  always even if your part of the UI is intact. Do not treat it as "re-plan
  everything", only as "the cached map is not reliable, ask for a new one".

## 2b. Scope limitations to know before planning

Verified operating Odoo 19 end-to-end (2026-09-04). They are not site bugs: they
are limits of the current contract, and they change what you can promise the
user.

- **List rows: not reachable by content.** The serializer considers
  `a[href], button, input, select, textarea, [role]` as candidates. Table rows
  that open a record are usually `<tr>`/`<td>` with a click handler, without
  `role` or `href` → **they do not appear as refs**. Their content lands loose in
  `read[]`, not correlated with any ref. Practical result: *"open record X from
  the list"* **cannot be done** reliably. Alternatives: use the app's own search
  box to filter down to a single record, navigate by direct URL if the app
  allows it, or — if available — use the system's API/RPC instead of the DOM.
- ✅ **Behind a modal, the background comes marked `inert: true` and `act`
  rejects it** (fb-018-004). *Requires extension ≥ 0.5.0.* Before that version
  the background was reported as actionable **and it was**: `act`'s synthetic
  click dispatches without hit-testing, so it bypassed the modal overlay — a
  human could not make that click, an agent could. See §3.

## 2c. Recipes are approximate: markup varies and the contract reflects it

**Underlying rule: the quality of what you see depends on who rendered the
widget.** The frame driver faithfully exposes what is in the DOM; it does not
invent semantics where there are none. That is why the same system, in
**another version or configuration**, can give you a different map — and that
is not a bug.

Examples measured on the same Odoo 19 instance, only switching views:

| View | Cell that identifies the row | Emitted `name` |
|---|---|---|
| Sales | `…>tr:N>td:2` | `"S00101"` |
| Purchases | `…>tr:N>td:3` | `"P00033"` |
| Contacts | `…>tr:N>td:2` | `""` (avatar column in front) |

The cell position **changes between views of the same app and version**. If a
recipe tells you "column 2 has the identifier", be suspicious.

### What to do about it

- **Do not memorize indexes or refs across sessions.** Read the map every time
  and locate the element by its `name`/`context`, not by position.
- **Use `context` to identify rows**; it is more stable than the cell's `name`:
  in some views the promoted cell is decorative and its `name` is empty, but
  `context` carries the accessible name of the whole row. Careful: that
  `context` is usually **the entire row concatenated** (`"Archivo binario
  Acme Demo SA demo@example.invalid …"`), so **compare by substring, never by
  equality**.
- **Verify the effect after acting, do not assume it.** `ok: true` means
  "I dispatched the event", not "what you wanted happened". See §4.
- **If something you see in `read[]` has no ref, say so instead of making it
  up.** It may be a real limitation of that version's markup. Propose the
  alternative (app search box, direct URL, API/RPC) instead of forcing a blind
  click.

### What the contract does NOT promise

- **It does not promise one ref per cell.** In lists one cell per row is exposed
  (the one identifying the record). If you need to act on a specific cell — for
  example for inline editing — you may have to open the record.
- **It does not promise that a clickable element has a ref.** If the site built
  it with a `div` without role, without `href` and with the handler attached by
  JS, it may not appear. What you see marked `clickable: true` is **inference
  from presentation** (`cursor: pointer`), not declared semantics: treat it as a
  hint, not a certainty.
- **The validations above were measured on Odoo 19.** Other versions may mark
  up differently. If something does not match this guide, trust the map you are
  reading, not the guide.

### Three measured gaps, so they don't surprise you

All three are **verified against real Odoo 19**, not assumed. They are not
failures you can fix: they are limits worth knowing before planning around them.

- **In a pivot, the column label may be missing.** The `context` of a cross-tab
  cell normally carries two labels, `[row, column]`. In Odoo's pivot with the
  grouping on the horizontal axis, the association shifts and **only the first
  cell finds its column**: measured, 1 out of 4. The cause is that the pivot
  header uses `colspan`/`rowspan` and the association matches by position. **A
  single-label `context` in a pivot does not mean "this cell belongs to no
  column"** — it means the label could not be associated. If you need the
  column, read it from the header in `read[]`.
- **Pivot headers are not in the map.** The `th`s that expand and collapse
  groupings are not candidates (they are `th` with `cursor-pointer`, no role, no
  `tabindex`). You can flip the axis, expand all or change measures with the
  toolbar buttons; **you cannot expand a specific group by `ref`**.
- **A confirmation dialog's text may not be attached to any element.** In Odoo's
  confirmation dialog the buttons come with `context: ['Confirmación']` — so you
  know you are in a dialog and which one — but the question (*"¿Estás seguro de
  que…?"*) **stays loose in `read[]`** and the `dialog` element comes with an
  empty `name`. **Before confirming a destructive action, read `read[]`**: the
  button tells you what you are doing, not to what.

### Reading right after navigating can return a degenerate map

Measured three times in different rounds: a read done right after `navigate`
returned once **7 elements**, another time **zero** — the `totalElements` key only
appears when the number of returned elements differs from the number of
candidates, so a read with no candidates may not carry it, and its absence must
not be read as `null` —, and another time the whole table collapsed into **a
single element** whose `name` was the concatenated text of all rows. It
stabilizes after a few seconds.

**Use `getFrame` with `settle: true`** (extension ≥ 0.5.0, see §5b): it waits
for the content to quiet down and tells you whether it managed to
(`invalidation.settled`). Even so, right after a full navigation you can get
`settled: true` with **zero elements** (the new document has not mounted yet):
**re-read and compare**. If two consecutive reads match, the map is real; if the
first brings much less than the second, the first was noise. Do not plan on a
single read taken right after navigating.

## 3. Modal dialogs first

If the app opens a modal dialog, **resolve it before any other action**.

**With extension ≥ 0.5.0 the contract tells you and also protects you:**

1. When a modal dialog is active, the frame carries a top-level field
   `dialog: {ref, role, name}`. The `name` is usable even if the dialog has no
   accessible name: if empty, it falls back to the text of the first heading in
   its subtree (so an Odoo error arrives as `"Operación no válida"` instead of
   `""`).
2. Everything **behind** the dialog comes marked `inert: true`. Nothing is
   filtered: you still see the background — you need it to know where you are —
   but you know it is not actionable.
3. **`act` rejects acting on an inert element**, with
   `{ok:false, inert:true, error}`. It is not merely informative: it is the
   protection. Marking without rejecting would not be enough, because the
   browser will never prevent it on its own (the synthetic click does not
   consult hit-testing).
4. If you really need to act on the background, pass `force: true`. It exists
   because a non-modal `role="dialog"` could mark the whole page inert; it is
   the escape hatch, not the normal path. **`force` bypasses only `inert`**: it
   does not bypass `disabled` or `stale`. And using it under a real modal **can
   leave the application inconsistent** — measured on Odoo 19: with the "Crear
   Contacto" dialog open, `force` on the background pager switched records with
   the dialog still open.

**Rule of thumb:** if `dialog` is present, work only on elements **without**
`inert` until you close it (`Guardar`/`Descartar` are usually in the `footer` of
the dialog's subtree).

**With stacked dialogs** (one opens another), `dialog` always points to the top
one; the one below and its content come out `inert: true`.

**Popups opened from the dialog** *(extension ≥ 0.5.0)*. A dropdown, select
menu or listbox opened from a control inside the active dialog is often
rendered **outside** the dialog's subtree (an overlay container). Its options
are **not** `inert` and `act click` works on them **without `force`**, as long
as the popup has role `menu`/`listbox`/`tree`/`grid` (or the `popover`
attribute) and is linked to the dialog: a control inside it points to the popup
with `aria-controls`/`aria-owns`, or the popup comes after the dialog in the
document while a control inside the dialog is `aria-expanded="true"`. If an
option still comes out `inert`, re-read after opening the dropdown before
reaching for `force`.

**`dialog.modal` — only when the dialog really covers** *(requires extension
≥ 0.5.0)*. An element having `role="dialog"` does **not** mean it blocks the
page: many sites use that role for popovers, pickers and side panels. That is
why the contract distinguishes two things:

- **`dialog` present + `dialog.modal: true`** → the dialog covers the background.
  You will see `inert:true` elements and `act` will reject them.
- **`dialog` present **without** `modal`** → a dialog is open but **covers
  nothing**. **No** element comes out `inert` and you can keep operating the
  background normally. This is the popover case.

The decision is not made by role but by behavior: the extension checks with real
hit-testing whether the background is still reachable. If there is no way to
know (no layout), it assumes it covers — protects by default.

> **On extension < 0.5.0** this did not exist and `role="dialog"` was always
> treated as modal, so a popover marked the whole page as `inert` and `act`
> rejected legitimate actions. If you are against an old version and see that,
> `force: true` is the way out.

> **Extension < 0.5.0** (historical workaround, no longer needed): look for an
> element with `role: dialog` — it may have an empty `name` — take **its `ref` as
> a prefix** and keep only the elements whose ref starts the same way. Everything
> else is background, even if it says `visible: true`. There the background
> **was** actionable, so discipline was the only protection.

### Native browser prompts (`confirm`/`alert`/`prompt`, extension ≥ 0.5.0)

This is different from a page dialog (§3 above): a **native prompt** is a call
to the browser's own `window.confirm`/`window.alert`/`window.prompt`, not a DOM
element. While an `act click` has it open, it arrives as a top-level field
`nativeDialog:{type, message, pending:true}` — independent of `dialog` (§3):
they can coexist.

- **The tool never answers it.** There is no `force` or parameter that bypasses
  it: only a human can resolve the prompt, by pressing the real button.
- **Tell the human**, quoting `message` exactly as it arrived. If the tab is not
  visible, `vlp_activateTab` helps them see it.
- **Do not retry or use `force`.** While the prompt stays open, any `act` (on any
  element) and any `fill` in that tab come back rejected: `{ok:false,
  nativeDialog, error}` or `{success:false, nativeDialog, error}`, without
  executing anything.
- **`vlp_click` by selector and `vlp_eval` do not check for a pending
  prompt**: they dispatch anyway on the suspended page. Do not use them to dodge
  an `act` or `fill` rejection with `nativeDialog`.
- **Re-read with `getFrame`** until `nativeDialog` stops appearing: that marks
  that the prompt has been closed.
- **`navigate` and `closeTab` close it without anyone answering** — the
  unloading document receives `false`/`null` instead of a human answer. They
  are the only path if nobody answers and the tab would be stuck without them,
  but they are not a shortcut to "get out" of the prompt: use them only with the
  human's agreement, not to skip it.
- **Only `click` detects it.** A `type`, `focus`, `select` or `fill` whose own
  dispatch triggers a prompt can hang without notice — there is no way to know
  from the tool's response.
- **`vlp_screenshot` does not show it.**
- **A prompt that opens after the call has already returned is not detected**:
  if nobody answers it, a later action in that tab can hang anyway.

*Requires extension ≥ 0.5.0.*

## 3b. What `act`'s `ok` guarantees (extension ≥ 0.5.0)

- **`act` dispatches the event directly to the element** (`el.click()` and
  equivalents), without hit-testing. That is why **an overlay on top does not
  block it**: measured on Odoo 19, a click under the notifications toast or under
  an open popover arrives and has an effect. `ok:true` does **not** guarantee
  that a human could have clicked there, nor that the action produced the
  business result you wanted.
- **`type` with `ok:true` also carries an observation of the written field**
  (extension ≥ 0.5.0): after dispatching, it waits for the field to stabilize
  and adds `value` (the field's text at that moment), `settled` (boolean) and
  `waitedMs`. `settled` is a **temporal, not semantic** verdict: it does not
  assert that the site finished processing, nor does it cover values derived
  from other fields, nor the overall form state — only the written field, at
  that instant. If the element left the document during the wait, the response
  carries `detached:true` and `settled:false`, without `value`. Example of a
  real response (test harness): `{ok:true, settled:true,
  value:"formateado-1", waitedMs:906}`. For writing numbers and comparing
  `value` against what you wanted, see §5c.
- **`{ok:false, disabled:true, error}`** means the control is disabled per HTML
  (includes controls inside a `<fieldset disabled>`): **nothing was executed**.
  You must enable it first — fill in the missing required field, write the
  message text, change state — and only then retry. **`force` does not bypass
  it**. Applies to `click`, `type`, `focus` and `select`. Measured example:
  "Registrar" in the chatter with an empty composer.
- **`nativeDialog` (extension ≥ 0.5.0, see the subsection above).** A `click`
  that opens a native prompt comes back with `{ok:true, nativeDialog}`. With a
  native prompt already pending in the tab, any `act` comes back with
  `{ok:false, nativeDialog, error}` and any `fill` with `{success:false,
  nativeDialog, error, selector}`, without executing anything; this takes
  precedence over `stale`/`inert`/`disabled` and `force` does not bypass it.
- **The map's `disabled` and `act`'s do not always match.** `act` uses the HTML
  rule; the map uses its own. Three cases worth knowing:
  - **`aria-disabled="true"`**: the map says `disabled:true`, but `act` **does
    dispatch** and responds `ok:true`. The map marking it does not guarantee the
    action is blocked.
  - **Control inside the first `<legend>` of a `<fieldset disabled>`**: the map
    may say `disabled:true`, but HTML does not disable it and `act` dispatches.
  - **Disabled only by class** (`.o_disabled`, `.btn.disabled`,
    `.o_switch_disabled`): **neither the map nor `act` detect it**. The map says
    `disabled:false` and `act` responds `ok:true` even though the click does
    nothing. If a control looks greyed out or the action has no effect, take a
    `vlp_screenshot` and verify by re-reading.
- **Odoo's notifications toast does not appear in the frame**, and
  `getFrame settle:true` waits for it to disappear (~4.75 s measured: its
  progress bar mutates the DOM non-stop). If a read with `settle` takes long, it
  may be that.
- **When HTML is not enough, look.** If it is unclear what is really rendered —
  something seems to cover the control, the effect does not show up in the map,
  the view does not look like what the frame describes — take a
  `vlp_screenshot`. The primary tools (`vlp_screenshot`,
  `vlp_click`, …) remain legitimate: the frame is the efficient path, not
  the only one.

## 4. Verifying a view's real state

**The browser tab title does not reflect the state of a flow/workflow.**

✅ **The per-element contract includes observable state (fb-018-002, closed
2026-09-04):** besides `{disabled, name, ref, role, tag, visible}`, an element
may carry `value` (field content), `checked` (boolean or `"mixed"`), `selected`
and `expanded`. **The absence rule — the most expensive one to misread:** an
absent key means *"the element has no such state dimension"*, never `false` or
empty. A checkbox without the `checked` key is not unchecked, it is not
checkable. A field without the `value` key is not empty, it is not a field with
a value — an empty field is declared with `value: ""` (present).

- **The statusbar/stepper IS readable now.** The active state of a radio group
  (e.g. `SdP` / `SdP enviada` / `Pedido de compra`) has `checked: true`; the
  others, `checked: false`. **`disabled` is still useless for inferring state**
  (verified: the three radios of a real statusbar all came with
  `disabled: true`) — use `checked`, not `disabled`.
- **Values of fields being edited are visible before saving.** The `value` of an
  `<input>`/`<textarea>`/`<select>` reflects what is typed at that moment,
  **without needing to save first**. This closes the gap that forced using
  screenshot+vision or waiting until after saving.
- **Security exception, hard and without workarounds:**
  `input[type=password|file|hidden]` **never** expose `value` — neither the value
  nor its length. An agent must not interpret the absence of `value` on those
  fields as a bug: it is the rule.
- **Long values are truncated** (default 300 chars + `…`, same criterion as
  `read[]`) — a value that legitimately ends in `…` is indistinguishable from a
  truncated one.

Sources of truth, in order of preference:

1. **`checked`/`selected`/`expanded`** for selection state — direct, no
   inference required.
2. **`value`** for field content, **before or after saving**.
3. **`read[]`** is still useful for confirmation/chatter messages ("creado",
   "guardado") and for the content of elements the frame cannot reference yet
   (see §2b — list rows).
4. **Screenshot + vision**, if you have the tool available, for what the
   contract does not cover yet (see limitations below).
   (`eval` is still not an escape hatch: sites with a strict CSP — Odoo among
   them — block it.)

### Limitations still open (not resolved by fb-018-002)

- **List rows are still unreachable by content** (G3, see §2b) —
  `value`/`checked` help read an element that is already referenceable, not make
  a table row without `role` referenceable.
- **A modal's background still reports `visible: true`** (G4, see §3) —
  `value`/`checked` do not change this; rely on `inert` (or the ref-prefix
  technique on old extensions).
- **No readiness signal** (G5, see §5b) — a frame read mid-render can show a
  partial `value` (what had been typed up to that instant), not corrupt data,
  but not necessarily the final value either. For numeric values in particular,
  see §5c.

## 5. Generic recipe: combobox / autocomplete

A pattern repeated in almost every form framework (Material, Odoo,
React-select, etc.) for a "search and pick from a list" field:

1. `act type` with the search text on the combobox input (`role: combobox` or
   similar).
2. `getFrame` — the options list shows up as an options container
   (`role: listbox`/`menu` with `role: option`) usually right below the input,
   freshly mounted in the DOM (which is why you must re-read, not assume).
3. `act click` on the matching option (check the exact `name` — do not assume the
   first option is the right one).

If the text matches nothing existing, many apps offer an option like
"Create..."/"Add new..." as part of the list. **That means the record you are
looking for does not exist yet** — it is not a frame-driver error. Decide
explicitly: create the new record, or refine the search.

## 5b. Readiness signal `settled` (fb-018-006, 0.5.0) — and its honest limits

`getFrame` accepts the opt-in mode `settle: true` (with `waitMs`=5000 and
`quietMs`=300 defaults): instead of returning instant *t*, it observes the DOM
until the content quiets down (or the deadline expires) and returns
`invalidation: {changedSinceLast, settled, waitedMs}`. The promise of
`settled: true` is **temporal, not semantic**: (1) the content was quiet for
`quietMs`, (2) the map was serialized without a concurrent mutation, (3) no
standard loading indicator (`aria-busy`, `role=progressbar`, `<progress>`) was
visible. It does **NOT promise** that your last action is already reflected.

**Decision table** (combine `settled` with `changedSinceLast`):

| `settled` | `changedSinceLast` | Reading |
|---|---|---|
| `true` | `true` | new content, settled → plan on it |
| `true` | `false` | no observable effect yet → re-query after waiting, or conclude |
| `false` | — | still changing → provisional frame; re-query |

**Two limits measured in the field (Odoo 19, real):**

1. **Full navigation (full page load):** there is a window during the new
   document's boot in which the DOM is essentially empty and quiet (OWL has not
   mounted yet; the network is in flight and invisible) ⇒ `settled: true` with
   **0 elements** can arrive. It is the (a)/(b) ambiguity of the table:
   **re-query** — the second read brings the real view (verified in the field).
   The extension already waits for the navigation commit before observing
   (0.5.0), and during navigation responses carry
   `invalidation: {navigating: true}` — if you see it, the map belongs to the
   document that is leaving, do not plan on it.
2. **Silent interlude** (network-phase transition): the DOM stays quiet while
   the server responds ⇒ `settled: true` is possible on content that is about to
   change. Irreducible for a pull reader; the answer is to re-query (the pattern
   above).

   Do not lower `quietMs` below the default (300) without a concrete reason: the
   site waiting for the server's response, if it produces no DOM mutations and
   shows no standard loading indicator, counts as quiet, and `settled: true` can
   arrive with derived values still half-applied — measured with `quietMs:100`:
   `settled: true` at ~450 ms with part of the content already updated and
   another part still old; a read 3 s later already showed it updated. With the
   default, the state was coherent in the measured cases, without that being a
   guarantee. If what matters are values derived from one you just wrote,
   compare two reads a few seconds apart (in the measured case, the derived
   values changed between ~450 ms and 3 s); if they differ, keep re-reading until
   two match. That there was no standard loading indicator in the measured case
   is **inferred**, not observed. (For writing numbers, see §5c.)

Practical rules that still apply: if the frame does not contain what you
expected, **re-read before concluding it does not exist**. If `read[]` contains a
loading indicator (Odoo exposes it as the text "Cargando"), re-read. Do not treat
a single failed read as evidence of absence. Pages with chatter/longpolling may
never quiet down ⇒ persistent `settled: false` with the full frame included — the
frame is still usable, just not certified.

## 5c. Writing numeric values

`act type` and selector-based filling assign the whole text to the field at once
(they do not simulate keystrokes) and fire the change events: they do not
interpret the number or format it. **The site interprets it with its own
separator convention, as it would interpret the same text typed by a person**
(measured with human control on one site). Since keystrokes are not simulated, a
field that filters or transforms input keystroke by keystroke could behave
differently. A wrongly chosen separator produces a different number, with no
error and with `ok:true` — the signal is in the `value` of the `type` response
(§3b), not in `ok`. Generic example: on a site that uses a comma as decimal
separator, writing `3.5` (with a dot) can end up saved as `35`. The dot is lost:
the exact mechanism (whether it was interpreted as a thousands separator and
discarded, or some other rule of the site's parser) is not measured, only the
result.

**Before writing a decimal, know the convention:**

1. First, the site-specific skill, if one exists — it usually documents how to
   read it.
2. If none exists, it can be **inferred** from a value already formatted on
   screen that shows both separators (thousands and decimal) at once. This is
   **unmeasured guidance**, not a verified recipe.
3. If the convention cannot be determined unambiguously, do not write decimals
   through the UI blindly: use the site's API if one exists, or ask.

**When writing:** use only the site's decimal separator and **no thousands
separator** (e.g. `4100,5`). Writing **with** a thousands separator has a single
measured case (a value sent with a thousands separator, interpreted correctly) in
a single language; in other languages it is not measured — do not treat it as a
universal rule proven for all.

**When verifying, first check:** look at the `value` of the `type` response
(§3b) and compare **the number** you wanted against the number it carries —
never the raw text sent against the displayed text. If `settled:false` or
`detached`, or if what matters is a value derived from another field (not the
written field), re-read with `getFrame settle:true`. Legitimate transformations
measured, none of them a tool error: decimals brought to a fixed count (`2,500`
displayed as `2,50`), thousands separator added by the site (`4100,5` displayed
as `4.100,50`) and rounding to the field's configured precision (`3,56789`
displayed as `3,57`). Rounding is a site rule, not a tool defect.

**A `value` identical to the text sent is still ambiguous on a site that
reformats.** The site may not have processed it yet — for example, while it
waits for a response before reformatting. Measured: a read right after writing
showed the raw text as-is, and a later read with `settle` (which waited ~1.4 s
until quiet) already showed the formatted value. Do not conclude from a single
read if the sent and displayed text match by coincidence of format: if `settled`
is not `true` yet, re-read with `settle`. **Do not lower `quietMs` to speed up
this read** (§5b): a shorter window can declare quiet on a half-processed value.
`value` asserts the written field's value at that instant — it does not assert
that the site finished processing, nor the state of other fields, nor the
overall form state (see §3b). Use the persisted value as the final judge: the
site's API if one exists; otherwise, re-read after saving and compare **the
number** displayed under the site's convention against the one you wanted. A
reformatted `value`, before saving, is already enough to detect an error (e.g.
`35,00` when you wanted 3,5): no need to wait for the save for that, but the
final judge of whether it persisted is still the saved value. See also §4,
item G5.

When the goal is the data and not the UI flow itself, it is better to write
numbers through the **site's typed API** if one exists, instead of through the
interface — it avoids this problem at the root because it goes through no text
parser. Check the site-specific skill for the concrete recipe. Remember that
`type`'s `ok:true` does not assert how the written value was interpreted — look
at `value` (§3b).

**A `value` equal to the field's previous value is also ambiguous, even if
`settled` is `true`.** Not only the case above (raw text identical to what was
sent); there is a third value `value` can match by coincidence: what the field
showed **before** writing. If the site silently processes for longer than the
quiet wait covers, it can momentarily restore the field's previous value while
it applies the change, and that restoration is captured as `value` with
`settled:true` even though the real change is not reflected there yet. Looking
only at `value` and `settled`, it is indistinguishable from the write having had
no effect. Measured as infrequent in one field case (1 in 8 attempts; 0 in 7
later controlled replicas) — not the typical case, but it cannot be ruled out for
being rare. So it is worth noting the value the field showed before writing, to
be able to compare the three candidates (previous, sent, displayed) instead of
only two. Faced with this ambiguity, re-read with `getFrame settle:true` before
concluding the write had no effect or rewriting the field.

## 6. Token budget / map size

✅ **Lossless compaction by default (fb-018-001, closed 2026-09-04):**
`getFrame` no longer sends `do[]` unless you ask for it explicitly, and refs use
a compact encoding (`div:3` instead of `div:nth-of-type(3)`). Together, these
two things reduce the payload without losing a single bit of information —
~60% savings verified on the dense measured case. No habit change needed: it is
free.

- **`do[]` is opt-in.** By default it is not sent (`sections`/`read` only). If you
  need the flat array of actionable refs for some specific reason, ask for it
  with `include: "both"`. In 99% of cases it is not needed: the same refs are
  already in `sections[].elements[]`.
- **Old refs (format `tag:nth-of-type(N)`) still work.** If you have a cached map
  from before this feature, the refs it contains still resolve — no need to
  re-request the frame just for this.
- **Optional filters, never by default:** `roles: [...]` (only elements of those
  roles) and `namedOnly: true` (only elements with an accessible name). Use them
  when you know beforehand what kind of element you are looking for — they shrink
  the map without losing anything you asked for, but **do not use them "just in
  case"**: a badly chosen filter can hide exactly the button you needed (see ⚠️
  below).
- **`invalidation.changedSinceLast` is now reliable across query changes.**
  Before, requesting different pages of the same frame without touching the DOM
  could give false "changed" positives (real bug, closed). Now you can change
  `page`/`maxElementsPerPage`/`include`/`roles`/`namedOnly` between calls and
  `changedSinceLast` still answers only "did the page change?", never "did I
  change my query?".
- **`page` / `maxElementsPerPage` are still the main lever** for really dense
  pages (over 200 candidates) — the compact encoding reduces the weight of each
  page, not the number of pages.

⚠️ **`visibleOnly` never existed, and still does not.** `visible:false` means
*outside the viewport* (scrolled), not hidden — filtering by it would break
navigation (actionable elements reachable by scrolling would disappear from the
map). If you ever see that parameter documented, be suspicious: it is exactly
what this project decided not to build, on purpose.

---

For the particulars of a concrete site (e.g. Odoo), load that site's specific
skill in addition to this one — this skill is the common base, the specific skill
is the thin layer of that app's own recipes.
