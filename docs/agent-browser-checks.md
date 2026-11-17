# Agent browser checks: keyboard walk, element to source, check after a change

> This is the design as approved before implementation. Verification changed several details
> (how the walk finds its start and judges traps, the React owner chain and source-map limits,
> how the change check tells an update from a page that changes on its own). The code and the
> comments at the top of `page/keyboard.ts`, `page/source.ts` and `page/change.ts` are current;
> `docs/ARCHITECTURE.md` has the summary.

Design for three features of the browser page tools (`src/extension/browser/page/`). Three implementors
work in parallel, one worktree per feature, and a mechanical merge follows. Each feature owns only new
files plus the shared-file hooks quoted in section 4. **No change to `src/extension/core/` or
`src/shared/` is needed.** No new runtime dependency: PNG decoding uses `node:zlib`, source maps
are decoded by our own code, and workspace lookup uses `node:fs`.

Verified against commit `eafe9b7` (`main` = `feat/agent-browser-checks`).

---

## 1. Tool surface

### Budget, measured

I measured with the same pipeline as `test/unit/tool-budget.test.ts`: `z.toJSONSchema`, then the
`JSON.stringify` of `{name,title,description,inputSchema,annotations}`, plus one separator per tool.
The worktree has no `node_modules`, so I ran it in the main checkout at the same commit.
Implementors run `npm ci` in their worktree first.

| | now | after F1 | after F2 | after F3 | all three |
|---|---|---|---|---|---|
| total (budget 30,000) | **27,458** (42 tools) | 27,656 | 27,873 | 28,214 | **28,827** (44 tools) |
| `browser_audit` | 576 | **774** | | | 774 |
| `browser_inspect` (new) | | | **414** | | 414 |
| `browser_check_change` (new) | | | | **755** | 755 |
| largest tool (budget 1,800) | `browser_emulate` 1,633 | unchanged | | | 1,633 |
| instructions (budget 3,400) | 2,353 / 2,546 | unchanged | | | unchanged |

No budget is raised. `core/instructions.ts` is not touched.

### Feature 1: `browser_audit` gets `type: 'keyboard'` (an option on an existing tool)

```ts
description:
  'accessibility: axe-core violations by rule, with refs and fixes (ref/selector: only that part). performance: load timing, Web Vitals, slowest and largest requests, long tasks, render-blocking resources. keyboard: presses Tab through the page (ref/selector: that region) and reports focus order, invisible focus, traps, unreachable controls and the skip link; focus and scroll are restored.',
input: {
  type: z.enum(['accessibility', 'performance', 'keyboard']),
  ref: z.string().optional(),
  selector: z.string().optional(),
  reload: z.boolean().optional().describe('performance: reload without cache first, measure that load.'),
  tab: tabArg,
},
```

- Access: `keyboard` needs **control** (it sends trusted key input). `accessibility` stays read.
  `performance` stays read, or control with `reload`.
- `ref`/`selector` with `keyboard`: the walk starts at the region's start and stops when focus leaves
  the region. This is how an agent checks a dialog, a menu or a widget.
- `reload` with `keyboard` is rejected with the existing message "reload applies to the performance
  check only."

### Feature 2: new tool `browser_inspect`

Reason: no existing tool reads one element. Putting it on `browser_snapshot` would mean per-element
lookups and words in a tool used in every conversation, and `browser_evaluate` is the wrong place
for it. A separate `browser_inspect` (414 chars) gives a natural place for the later computed-styles
explanation (a future `styles: true`) without renaming anything.

```ts
defineTool({
  name: 'browser_inspect',
  title: 'Find element source',
  description:
    'Finds the code that renders an element: its components, innermost first, with workspace file:line (React, Vue, Svelte dev builds, inspector plugin attributes; source maps resolved).',
  input: { ref: z.string().optional(), selector: z.string().optional(), tab: tabArg },
  annotations: { readOnlyHint: true },
  handler: … withPage(env, ctx, args.tab, { access: 'read' }, …)
})
```

- Access: **read**.
- `ref` and `selector` are left undescribed, as in `browser_audit` (they are explained on the action tools).
- With neither given, it fails with `invalid_input`: "Pass the element: ref (from browser_snapshot) or selector."

### Feature 3: new tool `browser_check_change` with `action: 'baseline' | 'check'`

Reason: baseline and check are two steps of one workflow with shared, hidden per-session state. One
tool with an action costs one definition instead of two. Options on `browser_screenshot` or
`browser_wait_for` would blur those tools and still need the hidden baseline.

```ts
defineTool({
  name: 'browser_check_change',
  title: 'Check page after a code change',
  description:
    'Before you edit code, action "baseline" records the tab (screenshot, errors, failed requests, URL). After the edit, "check" waits for the hot update or reload to settle and reports only what changed: new errors with source locations, failed requests, navigation or crash, changed screenshot regions.',
  input: {
    action: z.enum(['baseline', 'check']),
    reload: z.boolean().optional().describe('check: reload first, for pages without hot reload.'),
    timeout: z.number().min(1).max(60).optional().describe('check: seconds to wait for the update, default 15.'),
    tab: tabArg,
  },
  handler: … access: args.action === 'check' && args.reload ? 'control' : 'read'
})
```

- Access: `baseline` is **read**. `check` is **read**, or **control** with `reload`.
- `reload` or `timeout` with `baseline` is rejected with `invalid_input`: 'reload and timeout apply to "check" only.'
- No annotations: with `reload` the tool changes the page.

---

## 2. Result formats (examples)

### 2.1 Keyboard walk (about 1.5–3.5k chars typically; capped near 5k)

**Success with problems:**

```
Keyboard walk of tab-2 (whole page, 3 documents): 24 Tab stops, back to the start, 3.9 s; 6 problems in 5 checks, all fail WCAG A/AA. Focus and scroll restored.
Focus order (page CSS px):
1 link "Products" [ref=e31] (24,18)
2 link "Pricing" [ref=e32] (118,18)
…
9 button "Search" [ref=e40] (1180,18)
10 textbox "Email" [ref=e41] (40,2210) tabindex=3
11 button "Open chat" [ref=e44] (1210,640) in the frame http://localhost:5174/chat.html
…
- critical keyboard-trap ×1 [WCAG 2.1.2 A]: Tab cycles inside group "Chat" [ref=e43] through 3 stops; Shift+Tab cannot leave it either. Fix: let Tab move past the last control (no preventDefault on Tab), or close the widget with Escape and say so.
  button "Send" [ref=e46]; textbox "Message" [ref=e45]; button "Close" [ref=e47]
- serious not-focusable ×3 [WCAG 2.1.1 A]: looks interactive but Tab never reaches it. Fix: use a <button> or <a href>; otherwise add tabindex="0", a role and Enter/Space handling.
  button "Add to cart" [ref=e70] (role=button, no tabindex); generic "Filters" [ref=e71] (click handler, cursor: pointer); <span class="more">More…</span> (cursor: pointer, no handler found: maybe decorative)
- serious focus-not-visible ×2 [WCAG 2.4.7 AA]: nothing shows where focus is. Fix: style :focus-visible (e.g. outline: 2px solid; offset 2px); never outline: none without a replacement.
  button "Search" [ref=e40]; button "Open chat" [ref=e44] (in the frame localhost:5174/chat.html; style check only)
- moderate skip-link-missing ×1 [WCAG 2.4.1 A]: 8 stops before the main content (first in <main>: textbox "Email" [ref=e41]). Fix: add a first link "Skip to content" to <main id="…">, visible on focus.
- moderate focus-order ×2 [WCAG 2.4.3 A]: focus jumps against the reading order. Fix: remove tabindex > 0 and order the DOM the way the page reads.
  button "Search" [ref=e40] (1180,18) → textbox "Email" [ref=e41] (40,2210) (tabindex=3); textbox "Email" [ref=e41] (40,2210) → link "Docs" [ref=e33] (212,18) (jumps 2192 px up)
This walk uses only Tab and Shift+Tab. Also try the controls themselves: Enter, Space, the arrows in menus and tabs, Escape in dialogs. A column layout can make an upward jump correct; compare with how the page reads.
```

**Clean:**

```
Keyboard walk of tab-2 (whole page): 12 Tab stops, back to the start, 1.6 s; no problems found. Focus and scroll restored.
Focus order (page CSS px):
1 link "Skip to content" [ref=e5] (8,8)
…
This walk uses only Tab and Shift+Tab. …
```

**Modal dialog (region given):**

```
Keyboard walk of tab-2 (only dialog "Delete project?" [ref=e20]): 3 Tab stops; focus stays inside the modal dialog, as it should (check that Escape closes it). No problems found. Focus and scroll restored.
```

**Stopped early (step limit):**

```
Keyboard walk of tab-2 (whole page): stopped after 250 Tab stops (the limit), 9.7 s, before getting back to the start. Unreachable elements and the skip link are not checked on an incomplete walk. Walk one region at a time (ref/selector of a section). 2 problems so far. Focus and scroll restored.
Focus order (page CSS px): first 40 of 250
…
… 210 more stops (pass a region's ref/selector to list them).
```

The time-limit variant reads "stopped after 30 s (the time limit) at stop 143". After a trap: "stopped
at a keyboard trap (stop 17); later stops and unreachable elements are not checked."

**Navigation during the walk** (`ToolError 'failed'`): "The page in tab-2 navigated while Tab was
pressed (focus reached link "Next" [ref=e12], whose focus handler loads another page). The walk
stopped at stop 12; focus and scroll could not be restored. Take a snapshot."

### 2.2 Element to source (about 200–700 chars)

**Vue 3 dev with inspector attribute:**

```
Source of button "Save" [ref=e12] (Vue 3, development build):
1. <button> src/components/SaveButton.vue:14:5 (data-v-inspector)
2. SaveButton src/components/SaveButton.vue
3. EditorToolbar src/components/EditorToolbar.vue
4. App src/App.vue
Paths are relative to the workspace folder "shop". Vue gives files, not lines, for components.
```

**React 19 via `_debugStack` and source maps:**

```
Source of button "Add to cart" [ref=e7] (React 19, development build; lines from source maps):
1. ProductCard src/components/ProductCard.tsx:42:9 (where the element is written)
2. ProductList src/components/ProductList.tsx:18:11
3. App src/App.tsx:30:7
2 library components left out (node_modules).
```

**Path outside the workspace:**

```
2. Toolbar /home/build/app/src/Toolbar.vue (not found in the workspace folders)
```

**React production build:**

```
No source locations for button "Add to cart" [ref=e7]: React is present, but this is a production build (no file locations; component names are minified). Open the app from its development server for locations, or search the workspace for the element's text: "Add to cart" (id "add", data-testid "add-to-cart").
```

The Vue 3 production variant starts "Vue 3 is present (data-v-app) but this is a production build…".
The Svelte variant says "svelte-xxxx classes but no __svelte_meta: a production build…".

**No framework info:**

```
No framework information for heading "Pricing plans" [ref=e3]: neither it nor its ancestors carry React, Vue or Svelte development data or inspector attributes (plain or server-rendered HTML, another framework, or a production build). Search the workspace for its text instead: "Pricing plans for teams" (classes "hero-title").
```

**Source map unreachable** (a note line, then the bundled location):

```
1. ProductCard /assets/index-3f2a.js:1:20512 (source map not found: /assets/index-3f2a.js.map answered 404)
```

### 2.3 Check after a change (about 300–1,500 chars plus an image when pixels changed)

**Baseline:**

```
Baseline of tab-2 taken: http://localhost:5173/cart, viewport 1280×720 at scroll 0,0; 1 console error and 0 failed requests on this page so far (not repeated in the check). Edit the code, then call browser_check_change with action "check".
```

**Hot update with an error, a failed request and changed regions:**

```
Change in tab-2 after a hot update (Vite: /src/components/Cart.vue), settled after 1.3 s:
- 1 new error:
  [exception] Uncaught TypeError: Cannot read properties of undefined (reading 'price')  (src/components/Cart.vue:31:18)
- 1 new failed request: r57  GET 404 fetch  http://localhost:5173/api/cart/totals
- Screenshot: 6.2% changed in 2 regions (viewport CSS px): x 340–940 y 210–480 (5.8%); x 1100–1260 y 20–52 (0.4%). After-screenshot attached.
+ 2 new warnings (browser_console_messages shows them).
<image/jpeg>
```

**No visible change:**

```
Change in tab-2 after a hot update (Vite: /src/utils/format.ts), settled after 0.6 s: no new errors or failed requests, and the screenshot is unchanged. The edit does not show in this view (other route or state?), or it did not apply.
```

**Reload or navigation:**

```
Change in tab-2 after a full reload (new document), settled after 2.1 s:
- Navigated: http://localhost:5173/cart → http://localhost:5173/login
- Still there from before the change: 1 error (same text).
- Screenshot: 71.4% changed in 1 region: x 0–1280 y 0–720. After-screenshot attached.
```

**Build error overlay:**

```
- Build error shown in the page (Vite error overlay): [plugin:vite:vue] src/components/Cart.vue: Unexpected token (31:18). Fix the file; the page updates by itself once it compiles.
```

**Crash:**

```
The page in tab-2 crashed after the change (renderer gone). New errors before the crash: …. Reload it with browser_history (action "reload") once the cause is fixed.
```

**Timeout (nothing arrived):**

```
No update reached tab-2 within 15 s (no hot update, reload, DOM change or error since the baseline 48 s ago). If the edit should show here: is the dev server running and watching that file (check its terminal)? A page without hot reload needs check with reload: true.
```

**Did not settle** (a note line, the comparison still runs):

```
Note: the page kept changing for 10 s after the update (animation, polling or a live feed); the comparison includes those changes.
```

**Other notes:**

- Viewport size changed: "Viewport changed size (1280×720 → 390×844), so the screenshots are not compared."
- Scroll moved: "Scrolled from 0,0 to 0,640 since the baseline; the regions include that shift."
- Dev server gone: "The dev server connection was lost ([vite] server connection lost): is it still running?"

**No baseline** (`ToolError 'invalid_input'`): `No baseline for tab-2 in this session. Call
browser_check_change with action "baseline" before editing, then "check" after.`

---

## 3. Algorithms

### 3.1 Keyboard walk (`keyboard.ts`; pure parts in `keyboardLogic.ts` and `keyboardReport.ts`)

Entry point: `keyboardAudit(call: PageCall, root: ElementTarget | undefined): Promise<string>`, called
from `auditTool.ts`. Limits: `MAX_STOPS = 250`, `TIME_LIMIT_MS = 30_000`, `MAX_LISTED_STOPS = 40`,
`MAX_PIXEL_CHECKS = 40`, `MAX_CANDIDATES = 200`, at most 8 elements shown per problem, documents capped
like `a11y.ts` (`MAX_DOCUMENTS = 10`).

1. **Save state.**
   - `focusedAcrossFrames(call, DEEP_ACTIVE_ELEMENT)` (`frameQuery.ts:278`) gives the focused element as
     `{at, objectId}` in the isolated world, or none.
   - In each document's isolated world, a `SAVE_VIEW` script records the window scroll, the scroll
     offsets of every element whose `scrollTop` or `scrollLeft` is non-zero (walking open shadow roots,
     bounded to 20,000 elements), and the selection ranges. It installs a capture-phase `scroll`
     listener that adds each scrolled target to a `Set`.
   - The documents are: the top document plus same-origin frames through `contentDocument`, and each
     `call.state.frames.list()` frame target through `call.at(frame)`.
   - Send `Emulation.setFocusEmulationEnabled {enabled:true}` to every out-of-process frame session.
     `keepPageActive` covers only the page target. Turn it off again at the end.
2. **Start point.**
   - In the isolated world: `getSelection().collapse(scopeOrBody, 0)` then `document.activeElement?.blur()`,
     so Tab starts at the beginning of the document (or of the region).
   - Verify after the first Tab: the stop must be the first tabbable in tab order, computed by `FIRST_TABBABLE`
     (positive tabindex first, then DOM order).
   - If it is not, fall back: `FOCUS` (`scripts.ts:115`) on that element, counted as stop 1, and the
     report says "stop 1 was focused by script".
3. **Step loop**, until a stop limit, the time limit, a navigation (`state.loaderId` changes), a trap,
   the end, or cancellation:
   - **Press.** `pressChord(call, { modifiers: [], key: keyDefinition('Tab')! })` (`input.ts`), then wait
     two `requestAnimationFrame` in the top isolated world (timeout 500 ms).
   - **Find.** `focusedAcrossFrames` gives `{at, objectId}`. This follows shadow roots and same-origin
     frames through `DEEP_ACTIVE_ELEMENT`, and out-of-process frames through `frameOfOwner`. Then
     `DOM.describeNode` gives `backendNodeId`. The key is `${at.frame?.id ?? 'top'}#${backendNodeId}`.
   - **Describe.**
     - `at.describeAx(backendNodeId)` gives role and name. Assign a ref exactly as `a11y.ts describeNode` does.
     - `elementBox(at, backendNodeId)` gives a box in top-viewport CSS px, already mapped out of
       out-of-process frames. Add `viewport(call).pageX/Y` to get the page position.
     - `FOCUS_FACTS` (isolated, `this` = element) returns tabindex, `position: fixed/sticky` on the
       element or its ancestors, visibility (zero box, clipped, opacity 0, outside scroll extents), and
       the style signature (below). It also adds the element to `window.__copaneKbReached` (a `WeakSet`
       in that world).
   - **Focus visibility of the previous stop** (WCAG 2.4.7), checked now that it is unfocused:
     - Compare `STYLE_SIGNATURE` read while focused with the one read now.
     - The signature is the effective outline (only when its style is not none and width > 0),
       box-shadow, the border colours and widths (only when the width > 0), background colour and image,
       colour, text decoration, and the same for `::before`, `::after` and two ancestors. The ancestors
       cross shadow hosts through `getRootNode().host`, which catches `:focus-within`.
     - Different signatures: visible.
     - Identical, for an element in the top target: compare the bytes of two small PNG clips
       (`Page.captureScreenshot`, element box plus 8 px margin, `scale: 1`, `fromSurface`), taken while
       focused and after. The focused clip is taken during the step itself, only when the signature
       later turns out identical, so the clip is taken eagerly and dropped when not needed.
       PNG output for identical pixels is byte-identical, so no decoder is needed. Identical bytes mean
       the focus is not visible.
     - Out-of-process frames get the style check only (said in the report).
     - A focused element that is itself invisible is reported as "(hidden or off-screen when focused)".
   - **End of the cycle.** No deep active element (focus left the document), or the key equals stop 1:
     the walk is complete.
   - **Stuck.** The same key twice in a row means Tab is captured (an editor or a `keydown` that
     prevents default). Report a trap with the note "Tab is captured here; WCAG allows it only if the
     page says how to leave". Stop.
   - **Cycle.** A key seen before at index i > 0: press Tab `n - i` more times.
     - If exactly the same subsequence repeats, it is a cycle. Then, if any of its elements is inside
       `dialog:modal` or a visible `[aria-modal="true"]` (`MODAL_OF` script), focus is contained as
       expected: say so and finish.
     - Otherwise press Shift+Tab `len + 1` times. If focus never leaves the set, it is a trap ("Shift+Tab
       cannot leave it either"); otherwise note "Shift+Tab leaves it".
     - The trap region is the lowest common ancestor of the cycle's elements when they share a document,
       else the outermost frame. Stop.
     - If the subsequence does not repeat, continue, and note "focus returns to X" for focus-order.
4. **After a complete walk only:**
   - **Unreachable** (2.1.1).
     - In each document's isolated world, `UNREACHED_CANDIDATES` walks the elements: open shadow roots,
       same-origin frames, at most 5,000 elements.
     - It keeps visible, enabled, non-`inert` elements that are not in `__copaneKbReached`, have no reached
       ancestor or descendant, are not a `<label>`, and have one of:
       - an interactive role: button, link, checkbox, radio, switch, tab, menuitem, option, slider,
         combobox or textbox;
       - an `onclick` attribute;
       - `tabindex < 0` on such a role;
       - `cursor: pointer` where the parent's cursor is not pointer.
     - Candidates go into a global array, read back by index for refs (the pattern of `a11y.ts`).
     - Weak candidates (`cursor: pointer` only) are checked in the **main world**. `DOM.resolveNode`
       without a context id gives a main-world handle (as `call.resolve` does), and on it:
       - `DOMDebugger.getEventListeners {objectId, depth: 0}` finds click, mousedown, pointerdown or
         keydown listeners;
       - a `CLICK_PROPS` main-world function looks at the React `__reactProps$*` `onClick` and the
         Vue `_vei.onClick`.
     - With evidence the reason is "click handler"; without it, "no handler found: maybe decorative".
       At most 200 candidates are checked.
   - **Skip link** (2.4.1).
     - `MAIN_START` returns the first stop inside `main`, `[role=main]` or the skip target.
     - Missing: no same-page link (`href="#…"`) among the first 3 stops whose name matches
       `/skip|jump to|main content|zum inhalt|aller au contenu|saltar/i` or whose target is or contains
       `main`, while at least 5 stops come before the main content.
     - Broken: there is such a link, but its target id does not exist, or the target is `display:none`
       or zero-size. The link is not activated (that would change the URL hash and history).
     - A skip link that is invisible when focused is already a 2.4.7 problem.
   - **Focus order** (2.4.3), in pure `keyboardLogic.ts`:
     - Every positive tabindex counts (shown with the jump it causes).
     - Consecutive stops a→b where b's bottom is more than 200 px above a's top count, unless either is
       fixed or sticky, either is in another frame, or it is the wrap.
     - In the same row (|Δy| < 10 px) and on an LTR page (`document.dir`), b.right < a.left − 20 px counts.
     - At most 5 are reported.
5. **Restore** (in `finally`, also on errors and cancellation, skipped if the page navigated):
   - `FOCUS` on the saved element in its call (`preventScroll`), or blur if nothing was focused.
   - `RESTORE_VIEW` in each document: put each scrolled element back to its saved offset (0 if it had
     none), restore the window scroll and the selection, and remove the listener.
   - Turn off frame focus emulation.
   - Release the object groups (as `PageCall.dispose` does).
   - If restoring fails, the report says "Focus could not be restored: <why>".
6. **Report** (`formatKeyboard` in `keyboardReport.ts`). Rule ids, impact and WCAG:
   - `keyboard-trap` critical, 2.1.2 A;
   - `not-focusable` serious, 2.1.1 A;
   - `focus-not-visible` serious, 2.4.7 AA;
   - `skip-link-missing` / `skip-link-broken` moderate, 2.4.1 A;
   - `focus-order` moderate, 2.4.3 A.

   The line format matches `formatA11y`: `- <impact> <id> ×<n> [WCAG x.y.z L]: <what>. Fix: <fix>.`
   followed by elements joined with `; ` and `+N more`.

CDP used: `Input.dispatchKeyEvent`, `Runtime.callFunctionOn`, `DOM.describeNode`,
`DOM.resolveNode`, `DOM.getContentQuads`, `Accessibility.getPartialAXTree`,
`Page.getLayoutMetrics`, `Page.captureScreenshot`, `DOMDebugger.getEventListeners`,
`Emulation.setFocusEmulationEnabled`.

### 3.2 Element to source (`source.ts`; pure parts in `sourceMap.ts`, `stackFrames.ts`, `workspacePaths.ts` and `sourceReport.ts`; fetching in `sourceFetch.ts`)

Entry point: `elementSource(call: PageCall, target: ElementTarget): Promise<string>`.

1. **Read the framework data in the main world.** Expando properties set by page JavaScript are
   invisible in the isolated world. `target.objectId` is a handle in the page's own world
   (`targets.ts:24`), so `target.call.callOn(target.objectId, SOURCE_PROBE, [], {returnByValue: true})`.
   It works for out-of-process frames too, because `target.call` is scoped to the frame.

   `SOURCE_PROBE` is one self-contained function, guarded by `try` per step, that returns plain JSON. It
   walks from `this` up to 50 ancestors (crossing shadow hosts) and collects, **in this order**:
   1. **Inspector attributes** on the element or its nearest ancestor:
      - `data-insp-path` (code-inspector-plugin: `path:line:col[:tag]`);
      - `data-v-inspector` (vite-plugin-vue-inspector: `path:line:col`);
      - `data-inspector-relative-path` with `data-inspector-line` and `-column` (react-dev-inspector).

      This becomes entry 1, the element's own location.
   2. **React.** A key starting with `__reactFiber$` (React 17+) or `__reactInternalInstance$` (16) on
      the nearest element that has one.
      - `locOf(f)` is `f._debugSource` (`{fileName, lineNumber, columnNumber}`, React 18 and earlier)
        or else `f._debugStack?.stack` (a string, React 19).
      - Walk: `pending = locOf(host); for (f = host.return; f; f = f.return) if isComponent(f) {
        push({name: nameOf(f.type), loc: pending}); pending = locOf(f); }`.
      - Component tags are 0, 1, 11, 14 and 15. The name is `displayName || name ||
        render?.displayName || render?.name || type?.type?.name`. Cap at 15 entries.
      - Each location lies in the file of the component it is attributed to, so the chain reads
        "component plus the line where the path goes through it".
      - Dev versus production: `'_debugOwner' in fiber`.
   3. **Vue 3.** Walk `__vueParentComponent` → `.parent`. The name is `type.name || type.__name ||
      type.displayName || basename(type.__file)`. The file is `type.__file`; there is no line.
      Production: no `__vueParentComponent`, but a `[data-v-app]` element exists.
   4. **Vue 2.** Use the nearest `__vue__`, then `.$parent`. The name is `$options.name ||
      $options._componentTag`, the file `$options.__file`. Production: `__vue__` without any
      `__file`.
   5. **Svelte.** Use the nearest `__svelte_meta`.
      - Svelte 4 shape: `{loc:{file,line,column,char}}`, line 0-based, so add 1.
      - Svelte 5 shape: `{loc:{file,line,column}, parent:{type,file,line,column,componentTag,parent}}`,
        line 1-based. Its chain is the `parent` entries of type `component`.
      - Production: a `svelte-[a-z0-9]{6,}` class without meta.

   Several sources can coexist, for example an attribute plus React: entry 1 comes from the attribute,
   then the component chain. The probe also returns `text` (60 chars of `innerText`), `id`,
   `data-testid` and non-hashed classes, for the grep fallback, and `angular` when `[ng-version]`
   exists (reported as "Angular is not supported; search the text").

2. **Resolve locations.**
   - **React 19 stacks** (`stackFrames.ts`):
     - Parse V8 lines `at [async ]Name (url:line:col)` or `at url:line:col`.
     - Skip the leading `Error: …` line and frames whose URL matches
       `/node_modules\/|\/\.vite\/deps\/|react-dom|react\.development|jsx-dev-runtime|scheduler/`,
       or whose function is `jsxDEV|jsx|jsxs|createElement|react-stack-bottom-frame|fakeJSXCallSite`.
     - Take the first frame left.
   - **URLs** (`http(s):`, `webpack-internal:`, `file:`) go to `originalPosition`:
     - **Fetch the script** (`sourceFetch.ts`):
       - `Network.loadNetworkResource {frameId: at.frame?.id ?? state.mainFrameId, url,
         options:{disableCache:false, includeCredentials:true}}`, then `IO.read` in 1 MB chunks up to
         8 MB (base64-aware), then `IO.close`.
       - If the method is unsupported or fails, fall back to an isolated-world `fetch(url,
         {credentials:'include', signal: AbortSignal.timeout(5000)})` capped at 8 MB.
       - `data:` URLs are decoded directly. `webpack-internal:///(…)/./src/x.tsx` is not fetched; its
         path goes straight to path mapping.
     - **Find the map:** the response header `SourceMap` or `X-SourceMap`, else the last
       `//# sourceMappingURL=` (or `//@`) in the text, resolved against the script URL. Inline
       `data:application/json;base64,…` and URI-encoded maps are supported.
     - **Decode** (`sourceMap.ts`, pure):
       - Version 3. Base64 VLQ with sign in the low bit and continuation bit 32.
       - `mappings` are split by `;` into lines and `,` into segments, with delta fields
         `genCol, srcIdx, srcLine, srcCol[, nameIdx]`.
       - Decode lazily on the first lookup into a per-line `Int32Array` of quads.
       - Index maps (`sections` with `offset`) are supported; `url` sections are skipped.
       - `sources[i]` is resolved with `sourceRoot` against the map URL. `ignoreList` and
         `x_google_ignoreList` mark library sources.
       - Lookup: the segment with the largest `genCol ≤ col` on the same line only (0-based inputs).
         Line and column are reported 1-based.
     - **Cache:** per tab, keyed by `${loaderId}\0${scriptUrl}`, values are `Promise<ParsedMap | null>`.
       LRU of 30 entries; total `mappings` text at most 64 MB. A `mappings` string over 20 MB is
       refused with "source map too large".
   - **Exported for feature 3:** `export async function originalLocation(call: PageCall, location:
     string): Promise<string | undefined>`. It takes `"url:line:col"` (1-based, as `consoleLog.ts`
     writes it) and returns the workspace-relative `file:line:col`, or undefined.
3. **Map to the workspace** (`workspacePaths.ts`, pure):
   `mapToWorkspace(raw, roots, exists, platform): {root, rel, library} | {unmapped}`.
   - Roots are `env.services.window.workspaceFolders`: `fsPath`s on the side where the extension
     host runs, which is the remote side in remote windows, next to the files.
   - `exists` is `fs.statSync(p).isFile()` with a per-call cache, at most 60 stats per path. The
     wrapper lives in `source.ts`.
   - **Normalize:**
     - strip `?query` and `#hash`;
     - strip the prefixes `webpack://<name>/`, `webpack-internal:///`, `(app-pages-browser)/`-style
       `(…)/`, `file://`, `/@fs/` and `vite:`;
     - turn `\` into `/` and `/C:/` into `C:/`;
     - drop a leading `./`;
     - for an `http(s)` URL, keep the path only (Vite serves `/src/x.vue` relative to its root).
   - **Absolute path inside a root** (drive letter and, on win32 and darwin, case-insensitive): the
     relative path.
   - **Otherwise, suffix matching:** for k from `max(0, n − 12)`, longest suffix first, down to suffixes
     of at least 2 segments (1 if the raw path had one), try `join(root, suffix)` for each root; the
     first that exists wins.
     - This handles containers (`/app/src` mounted as `/workspaces/x/src`), Windows dev servers, WSL
       and relative paths from vue-loader and Svelte.
   - `library` means the path contains `/node_modules/` or is ignore-listed. Consecutive library
     entries collapse into "N library components left out".
   - **Shown as:** `rel` with `/`. With more than one root, `<basename(root)>/<rel>`. Unmapped paths
     appear as given plus "(not found in the workspace folders)".
4. **Report** (`formatSource` in `sourceReport.ts`): a head with the framework and build, numbered
   entries innermost first (at most 12), notes. There are four failure texts: production build, dev
   build without locations ("React development build without JSX source info: names only"), no framework,
   and unsupported framework. Each says what to do instead.

### 3.3 Check after a change (`change.ts`; pure parts in `changeLogic.ts`, `png.ts`, `imageDiff.ts` and `changeReport.ts`)

**Storage.**
- A `ChangeBaselines` instance is created in the `changeTools(env)` closure: a `Map<sessionTabKey,
  Baseline>`, LRU of 10 per window.
- The closure pushes `env.services.sessions.onDidChange` (on `removed`, drop the session's keys) into
  `env.services.context.subscriptions`.
- A baseline whose tab no longer exists (`browser.getTab`) is dropped on use.
- A baseline holds: `seq` (`state.seq`), `loaderId`, `url`, `takenAt`, `docErrors` (texts of the
  error entries since the current document's navigation entry), `viewport {w, h, scrollX, scrollY}`,
  `image {rgba, width, height, scale}`, and `churn` (whether the DOM changed in a 300 ms observation
  at baseline).

**Baseline.**
1. `ensureReady`, which `withPage` already runs. If the page is loading, wait until `load` and network
   idle for 500 ms (`state.networkIdleFor()`), at most 5 s.
2. `INSTALL_WATCH` in the top isolated world:
   - a `MutationObserver` on `document` (`subtree, childList, attributes, characterData`) that ignores
     targets inside `[data-copane-ui]` (the page indicator, `scripts.ts:213`);
   - it keeps `window.__copaneChangeWatch = {count, last}`.
   - Wait 300 ms, then read the count: a non-zero count sets `churn`.
3. **Diff capture.**
   - Hide the bridge UI with `TOGGLE_BRIDGE_UI(true)`. If a hook's `screenshot` returns content (the
     mobile emulation path, `call.ts` `PageHook.screenshot`) with `format: 'png'`, use that image.
   - Otherwise `Page.captureScreenshot {format:'png', clip:{viewport, scale: s / dpr}, fromSurface:true}`
     with `s = min(1, 800 / viewportWidth)`.
   - Decode with `png.ts`. If the image is wider than 800 px, `downscale` it (box average) to at most
     800 px. Restore the bridge UI.
4. Store the baseline and return the baseline text.

**Check.**
1. With no baseline, fail with `invalid_input`. With `reload`, send `Page.reload {ignoreCache:false}`
   (control access).
2. **Wait for an update signal.** Deadline = start + `timeout` (default 15 s). Uses
   `state.waitFor(pred, {pollMs: 200})`, plus polling the watch counter every 200 ms. `pred` is true
   when anything since `baseline.seq` shows:
   - a navigation entry (`state.navigations.after(seq)`): reload or URL change;
   - `state.crashed`;
   - a console entry matching `HMR_CONSOLE`;
   - a network entry whose URL matches `HMR_NETWORK`;
   - a new error entry;
   - an overlay present;
   - the watch count above the baseline count (only when `!churn`).

   Signals that came before the call count at once. If the deadline passes with no signal, return the
   timeout text (not an error result).

   The patterns are in `changeLogic.ts`, pure and unit-tested:
   ```ts
   HMR_CONSOLE = [/^\[vite\] (hot updated|css hot updated|page reload|invalidate)/, /^\[HMR\] (Updated modules|Nothing hot updated|Cannot apply update|App is up to date)/,
     /^\[webpack-dev-server\] (App updated|Errors while compiling|Warnings while compiling)/, /^\[Fast Refresh\] (done|rebuilding)/, /^\[hmr\]/i]
   HMR_PENDING = [/^\[HMR\] Checking for updates/, /^\[Fast Refresh\] rebuilding/]   // wait for a completion line
   HMR_NETWORK = [/\.hot-update\.(json|js)(\?|$)/, /[?&]t=\d{10,}(&|$)/, /[?&]import&t=\d+/]
   DEV_SERVER_LOST = /^\[vite\] server connection lost|^\[webpack-dev-server\] Disconnected/
   ```
   `/__webpack_hmr` (a long-lived EventSource) never counts. `describeUpdate` names the signal: "hot
   update (Vite: /src/x.vue)", "full reload (new document)", "navigation", or "DOM changes (no
   hot-update message seen)".
3. **Settle.** After a navigation, re-run `INSTALL_WATCH` in the new document. Wait until all of these
   hold, at most `min(10 s, time left)`:
   - `!state.loading`, and `lifecycleOf().has('load')` if the document changed;
   - `state.networkIdleFor() ≥ 500`;
   - no DOM mutation for 500 ms (`Date.now() - watch.last`), or a 1 s settle when `churn` is set;
   - no `HMR_PENDING` without a later completion line.

   If it does not settle, add the "kept changing" note and continue.
4. **Compare.**
   - **Errors:** `console.entries.after(seq)` with `level === 'error'`, at most 8, formatted with
     `formatConsoleEntry` (privacy-safe: withheld entries are already blanked, `privacy.ts`). The
     location goes through `options.locate` when given, else `shortLocation`. Texts equal to
     `baseline.docErrors` after a reload are counted as "still there" instead. Warnings are only counted.
   - **Failed requests:** `network.entries.after(seq).filter(isFailure)`, at most 8, with
     `formatNetworkEntry`.
   - **Navigation:** URL or `loaderId` versus the baseline. **Crash:** `state.crashed`.
   - **Overlay:** `OVERLAY_TEXT` in the top isolated world, clipped to 400 chars. It looks for:
     - `vite-error-overlay`: `shadowRoot` `.message-body` and `.file`;
     - `iframe#webpack-dev-server-client-overlay`: `contentDocument.body.innerText`;
     - `#webpack-dev-server-client-overlay-div`;
     - `nextjs-portal`: `shadowRoot` text containing "Failed to compile" or "Unhandled Runtime Error".
   - **Screenshot:** capture as in the baseline. If the viewport size differs, say so and do not compare.
     Otherwise `diffImages(a, b)` and `regions(...)`.
   - **After-image** for the agent, only if some pixel changed or the page navigated: a JPEG of the
     viewport sized by `screenshotScale` (`screenshotMath.ts`), quality 80, through the hook if one
     answers.
   - The baseline is **kept** (see question 2).
5. `formatChange` in `changeReport.ts`.

**PNG decode** (`png.ts`, pure, `node:zlib`):
- Check the signature, then read the chunks. IHDR must have bit depth 8, colour type 2 (RGB) or 6
  (RGBA), and no interlace. Anything else throws `UnsupportedPng`, which the report turns into
  "Screenshots not compared (unsupported image)".
- Concatenate the IDATs, `inflateSync`, and unfilter each row (None, Sub, Up, Average, Paeth; bpp 3 or 4).
- Output RGBA as a `Uint8Array`. At most 4,000,000 pixels.
- `downscale(img, maxWidth)` does an integer box average.

**Image diff** (`imageDiff.ts`, pure):
- A pixel changed if `max(|ΔR|, |ΔG|, |ΔB|) > 32` (alpha ignored).
- 8×8 cells; a cell is on if it holds at least 2 changed pixels. Dilate by one cell, then find 8-connected
  components.
- Each region's box is the tight box of its changed pixels, divided by `scale` to get viewport CSS px.
- Regions narrower than 2 CSS px or smaller than 12 CSS px² are dropped (a blinking caret).
- Sort by changed pixels; show at most 6 plus "and N smaller".
- Percent is `changed / total * 100`, one decimal, or "<0.1%".
- Memory: at most about 1.5 MB per baseline × 10.

**CDP used:** `Page.captureScreenshot`, `Page.getLayoutMetrics`, `Page.reload`, `Runtime.callFunctionOn`.
Events already recorded by `PageState`: console, network, navigation, lifecycle, crash.

---

## 4. File ownership

### Feature 1: keyboard (owner F1)

New files:
- `src/extension/browser/page/keyboard.ts`: the CDP walk, save and restore, page-side scripts.
- `src/extension/browser/page/keyboardLogic.ts`: pure: cycle and trap detection over the key
  sequence, jump detection, skip-link judgement, signature comparison.
- `src/extension/browser/page/keyboardReport.ts`: pure: `formatKeyboard`.
- `test/unit/page-keyboard.test.ts`
- `test/fixtures/browser-keyboard/server.mjs`, `index.html`, `trap.html`, `skip.html`, `many.html`, `frame.html`
- `test/e2e/browser-keyboard.e2e.mjs`

Shared edits (F1 is the only one touching `auditTool.ts`):
- `src/extension/browser/page/auditTool.ts`:
  ```ts
  // add import after `import { accessibilityAudit } from './a11y';`
  import { keyboardAudit } from './keyboard';
  // description: the string from section 1 (append " keyboard: …")
  type: z.enum(['accessibility', 'performance', 'keyboard']),
  // handler:
  withPage(env, ctx, args.tab, { access: args.reload || args.type === 'keyboard' ? 'control' : 'read' }, async call => {
    …performance branch unchanged…
    if (args.reload) throw new ToolError('invalid_input', 'reload applies to the performance check only.');
    const root = (await resolveTarget(call, args, { waitMs: 2000 })) as ElementTarget | undefined;
    if (args.type === 'keyboard') return keyboardAudit(call, root);
    return accessibilityAudit(call, root, env.services.context.extensionPath);
  })
  ```
  Also update the file's head comment: "an accessibility check (a11y.ts, axe-core), a keyboard walk
  (keyboard.ts) or a performance check (perf.ts)".
- `scripts/e2e.mjs` SUITES: insert after `'browser-devtools': {},`:
  ```js
    'browser-keyboard': {},
  ```

### Feature 2: source (owner F2)

New files:
- `src/extension/browser/page/inspectTool.ts`: `export function inspectTools(env: PageEnv): ToolDefinition<any>[]`.
- `src/extension/browser/page/source.ts`: the `SOURCE_PROBE` script, orchestration, the `fs` `exists`
  wrapper, `originalLocation` (exported for feature 3).
- `src/extension/browser/page/sourceFetch.ts`: `loadNetworkResource`/`IO` with the fetch fallback; the
  per-tab LRU cache.
- `src/extension/browser/page/sourceMap.ts`: pure: VLQ, parse, index maps, lookup, URL resolution.
- `src/extension/browser/page/stackFrames.ts`: pure: V8 stack parsing, React frame filter.
- `src/extension/browser/page/workspacePaths.ts`: pure: normalize and map (POSIX and Windows).
- `src/extension/browser/page/sourceReport.ts`: pure: `formatSource`.
- `test/unit/page-source.test.ts`
- `test/fixtures/browser-source/server.mjs` (builds `bundle.js` and its map at start with a small VLQ
  encoder in the fixture), `project/src/**` (source files copied into the dev host workspace by the
  test), `vue3.html`, `vue2.html`, `react18.html`, `react19.html`, `svelte.html`, `attrs.html`,
  `prod-react.html`, `prod-vue.html`, `plain.html`, `xframe.html`
- `test/e2e/browser-source.e2e.mjs`

Shared edits:
- `src/extension/browser/page/index.ts`:
  ```ts
  // import: insert after `import { emulationTools } from './emulationTools';`
  import { inspectTools } from './inspectTool';
  // tools: insert between the line `      ]),` (end of recorder.instrument) and `      ...testExportTools(env, recorder),`
        ...inspectTools(env),
  ```
- `scripts/e2e.mjs` SUITES: insert after `'browser-tab-ids': {},`:
  ```js
    'browser-source': {},
  ```

### Feature 3: change (owner F3)

New files:
- `src/extension/browser/page/changeTool.ts`: `export function changeTools(env: PageEnv, options: { locate?: (call: PageCall, location: string) => Promise<string | undefined> } = {}): ToolDefinition<any>[]`.
- `src/extension/browser/page/change.ts`: baseline and check, settle, captures, page-side scripts (`INSTALL_WATCH`, `OVERLAY_TEXT`), `ChangeBaselines`.
- `src/extension/browser/page/changeLogic.ts`: pure: signal patterns, settle predicate over observed facts, error dedupe.
- `src/extension/browser/page/png.ts`: pure: decode and downscale.
- `src/extension/browser/page/imageDiff.ts`: pure: diff, regions, percent.
- `src/extension/browser/page/changeReport.ts`: pure: `formatBaseline`, `formatChange`, `formatTimeout`.
- `test/unit/page-change.test.ts` (it encodes test PNGs with `zlib.deflateSync` and all five filters).
- `test/fixtures/browser-change/server.mjs` (a fake HMR: an SSE `/events`, a POST `/edit?mode=hmr|reload|error|overlay|404|none`), `app.html`, `app.js`, `plain.html`
- `test/e2e/browser-change.e2e.mjs`

Shared edits:
- `src/extension/browser/page/index.ts`:
  ```ts
  // import: insert after `import { auditTools } from './auditTool';`
  import { changeTools } from './changeTool';
  // tools: insert between `      ...auditTools(env),` and `      ...debugCdpTools(services),`
        ...changeTools(env),
  ```
- `scripts/e2e.mjs` SUITES: insert after `'browser-prompts': {},`:
  ```js
    'browser-change': {},
  ```

### Why the diffs merge cleanly

- **`index.ts`:** F2 and F3 insert their imports at different places. Their tool lines are separated
  by two unchanged lines (`...testExportTools`, `...auditTools`).
- **`scripts/e2e.mjs`:** at least one unchanged line separates the three insertions.
- **`auditTool.ts`:** F1 only.
- **Not touched by any feature:** `tool-budget.test.ts` (new tools are collected through
  `activateBrowser`; no budget changes), `contributes/*.json` (no commands or settings),
  `core/instructions.ts`, `core/`, `src/shared/`.
- **Each feature owns its scripts:** no feature edits `scripts.ts`; page-side function strings live in
  the feature's own file.
- **Duplicated on purpose:** F1 and F3 each write their own small capture helper (about 20 lines,
  modelled on `browser_screenshot` in `snapshotTools.ts:212-266`). This keeps the shared file untouched.

### Merge step (after all three, one commit)

1. **Source locations in check results.** In `index.ts`, replace `...changeTools(env),` with
   `...changeTools(env, { locate: originalLocation }),` and add
   `import { originalLocation } from './source';`.
2. **`docs/ARCHITECTURE.md`**: after the **Audits** bullet, add:
   ```
   - **Keyboard walk** (`page/keyboard*.ts`, `browser_audit` type `keyboard`): trusted Tab presses
     followed into shadow roots and frames (`focusedAcrossFrames`); focus and scroll are restored.
   - **Element to source** (`page/source*.ts`, `stackFrames.ts`, `workspacePaths.ts`, `browser_inspect`):
     framework data is read in the page's own world (expandos are invisible to the isolated world);
     scripts and source maps are fetched through the browser (`Network.loadNetworkResource`), cached per
     tab and document; paths are matched to workspace files by suffix.
   - **Check after a change** (`page/change*.ts`, `png.ts`, `imageDiff.ts`, `browser_check_change`):
     per session and tab, a baseline (decoded PNG at ≤ 800 px, log positions) in memory, LRU 10;
     "check" waits for an HMR/reload signal, then for quiet, and diffs.
   ```
3. **`README.md`**: change the "Testing and audits" row to: `` `browser_audit` (accessibility with
   WCAG criteria, keyboard walk, performance), `browser_inspect` (the component and file:line that
   render an element), `browser_check_change` (what a code change did to the page),
   `browser_export_test` (the agent's actions as a Playwright test) ``. After the "Accessibility and
   performance" paragraph, add:
   ```
   **Keyboard, source, and checking a change.** `browser_audit` with `type: "keyboard"` presses Tab
   through the page like a keyboard user and reports the focus order, focus that is not visible,
   keyboard traps, controls Tab never reaches and a missing or broken skip link, each with its WCAG
   criterion; focus and scroll are put back afterwards. `browser_inspect` tells which component and
   file:line in your workspace render an element (React, Vue, Svelte in development, through source
   maps). `browser_check_change` takes a baseline before the agent edits code and afterwards reports
   only what the hot update or reload changed: new errors with their source lines, failed requests,
   a navigation or crash, and the changed regions of the screenshot.
   ```
4. **`CHANGELOG.md`**: under `## Unreleased`, before the existing bullet, add:
   ```
   - **Keyboard walk** (`browser_audit` with `type: "keyboard"`): focus order, focus that is not
     visible, keyboard traps, controls Tab never reaches, skip link, focus jumps; each with its WCAG
     criterion, element ref and fix. Focus and scroll are restored.
   - **Element to source** (`browser_inspect`): the components that render an element, innermost
     first, with workspace file:line, for React, Vue 2/3 and Svelte development builds and inspector
     plugins; bundled locations are resolved through source maps.
   - **Check after a code change** (`browser_check_change`): a baseline before editing, then only what
     changed once the hot update or reload settled: new errors with source locations, failed requests,
     navigation or crash, changed screenshot regions.
   ```
5. Run `npm run check`, all three suites (`node scripts/e2e.mjs browser-keyboard browser-source
   browser-change`), and `browser-devtools` (`browser_audit` changed).

---

## 5. Fixtures and tests

### Feature 1

**Unit tests** (`page-keyboard.test.ts`):
- cycle versus wrap versus stuck versus repeated-but-not-cycling sequences;
- modal containment;
- jump detection: positive tabindex, up-jumps over 200 px, fixed and sticky exclusions, frames
  excluded, same-row backward in LTR only;
- the skip-link rules: missing, broken, present;
- signature comparison: `outline: none` with an unchanged signature is invisible; a `box-shadow` change
  is visible; a border-colour change with zero width is invisible;
- `formatKeyboard`: header variants (complete, step limit, time limit, trap, region, modal), the
  40-stop cap, the problem line format, and that refs are present.

**Fixtures** (`test/fixtures/browser-keyboard/`, served on `127.0.0.1` and on `localhost` as a second
origin for the cross-origin frame):

`index.html` is a long page (3,000 px) with these known problems:
- 6 nav links and no skip link → `skip-link-missing`;
- `button#search` with `outline: none` and no other focus style → `focus-not-visible`;
- `a#ok` with a `:focus-visible` outline (no problem);
- `div[role=button]#add` without tabindex → `not-focusable`;
- `span#filters` with `cursor: pointer` and `addEventListener('click')` → `not-focusable` (click handler);
- `input#email[tabindex=3]` at y=2200 → `focus-order`;
- `<x-search>` with 2 buttons in an open shadow root (reached);
- a same-origin iframe with a link;
- a cross-origin iframe (`localhost`) with a `button` styled `outline: none` → `focus-not-visible`, style check.

The other pages:
- `trap.html`: a 3-button widget whose last button's keydown Tab calls `preventDefault()` and focuses
  the first → `keyboard-trap`; plus `<dialog id=confirm>` opened with `showModal()` on a URL flag.
- `skip.html`: a skip link `#content` with no `#content` → `skip-link-broken`.
- `many.html`: 400 links, for the step limit.

**E2E** (`browser-keyboard.e2e.mjs`):
1. Whole-page walk: each expected rule id and WCAG criterion appears; refs from the result work with
   `browser_click`; shadow and frame stops are listed ("in the frame").
2. Restore: before the walk, `browser_evaluate` scrolls to y=300 and focuses `#start`; afterwards the
   same evaluate returns `[300, "start"]`.
3. Trap page: `keyboard-trap` and "stopped at a keyboard trap".
4. Modal: walk with the dialog's ref: "stays inside the modal dialog", no trap.
5. Broken skip link.
6. Step limit on `many.html`: "stopped after 250".
7. Control access: a second session (`--session` key 2) gets the busy error while the first holds the
   lease. (The time limit is unit-tested only.)
- No skips expected. The out-of-process frame case declares
  `skip: 'needs site isolation (localhost and 127.0.0.1 as separate sites)'` only if the frame does not
  become a frame target (checked with `browser_snapshot` showing it).

### Feature 2

**Unit tests** (`page-source.test.ts`):
- VLQ decoding against known vectors (`AAAA`, `AACA`, `gBAAgB`, negatives, multi-char);
- maps with `sourceRoot` and `sections`, lookup at line boundaries, inline data URLs (base64 and
  URI-encoded), the map-size cap;
- V8 stack parsing (named, anonymous, async, `webpack-internal`), the React 19 filter on real-shaped
  stacks from React 19.0 and 19.1 (`react-stack-top-frame`, `.vite/deps`);
- `mapToWorkspace`: absolute in root; container mount suffix; `webpack://app/./src`; Vite `/src/x`;
  `/@fs/`; `C:\Users\me\proj\src\a.tsx` and `/c:/Users/...` against a win32 root; WSL; two roots; the
  minimum suffix length; the stat cap; library detection;
- `formatSource` for every result kind;
- Svelte 4 and 5 line bases.

**Fixtures** (`test/fixtures/browser-source/`):
- The pages fake the framework data in the page's own world (no framework dependency):
  - Vue 3: `el.__vueParentComponent` chains with `type.__file` set to `<root>/source-app/src/...`
    (`root` comes from a query parameter) and one foreign path `/home/build/app/src/components/Toolbar.vue`;
  - Vue 2: `__vue__` with `$options.__file`;
  - React 18: `__reactFiber$x` with `_debugSource` and a `return` chain with `_debugOwner` keys;
  - React 19: `_debugStack = new Error('react-stack-top-frame')` created by functions in
    `bundle.js` at known generated lines, mapped by `bundle.js.map` to `src/components/Card.jsx`;
  - Svelte 4 and Svelte 5 meta shapes;
  - inspector attributes;
  - production React (fibers without debug keys), production Vue (`data-v-app` only);
  - plain HTML;
  - a cross-origin frame with Vue data.
- The e2e copies `project/src/**` to `${hostDir}/ws/source-app/` (the dev host's workspace,
  `scripts/dev-host.mjs:31`).

**E2E** (`browser-source.e2e.mjs`), one case per page:
- the expected `src/...:line` lines in innermost-first order;
- the foreign path is mapped by suffix;
- React 19 lines come from the source map;
- the production and no-framework texts suggest the element's text;
- the element in the cross-origin frame works;
- a missing map (the server answers 404 for `bundle-nomap.js.map`) shows the bundled location with
  the note.

Skips:
- Windows path mapping: `skip: 'Windows paths: covered by unit tests; needs a Windows host'` unless `win32`.
- Remote: not in this suite (the suite runs unchanged in `remote-dev-host`; noted as a manual check).

### Feature 3

**Unit tests** (`page-change.test.ts`):
- PNG decode for RGB and RGBA, all five filter types, the unsupported cases (16-bit, palette,
  interlaced), the pixel cap;
- `downscale`;
- diff: identical images give 0; one 50×20 block gives one region with correct CSS box and percent; two
  separate blocks give two regions; a caret-sized change is dropped; noise below the threshold is
  ignored; scale conversion;
- the `HMR_CONSOLE`, `HMR_NETWORK` and `HMR_PENDING` patterns against real Vite, webpack 5 and Next
  lines;
- the settle predicate over fact sequences;
- error dedupe after a reload;
- every `formatChange` variant (hot update, reload, navigation, crash, overlay, timeout, unsettled,
  viewport changed, scroll moved).

**Fixture** (`test/fixtures/browser-change/`):
- `app.html` loads `app.js`, which connects to SSE `/events`.
- `POST /edit?mode=…` changes server state and pushes an event. On `hmr` the page logs
  `[vite] hot updated: /src/app.js`, imports `/src/app.js?t=<ms>` and changes one panel.
- The other modes: `reload` (logs `[vite] page reload`, then `location.reload()`, serving a different
  title), `error` (the hot module throws from `/src/broken.js` at a known line), `404` (the update
  fetches `/api/missing`), `overlay` (inserts `<vite-error-overlay>` with a shadow `.message-body`),
  `none` (nothing happens), `css` (changes a stylesheet only).
- `plain.html` has no HMR (for `reload: true`).

**E2E** (`browser-change.e2e.mjs`):
1. baseline, then `hmr`: one region and an image; no errors.
2. `error`: a new exception whose location contains `/src/broken.js:` (after the merge step, the
   workspace-relative path; the e2e accepts both).
3. `404`: one failed request.
4. `reload`: "full reload" and a navigation line.
5. `overlay`: the overlay text.
6. `css`: a region, with no console signal needed.
7. `none` with `timeout: 2`: the timeout text, returned within about 2.5 s.
8. `plain.html` with `reload: true`: works, and needs control (a second session gets busy).
9. Check without a baseline: the error text.
10. A second session's baseline is independent.
11. Crash: `debug_cdp` `Page.crash`, then check reports a crash, with
    `skip: 'debug_cdp is only available in a development host'` when the tool is missing.

---

## 6. Open questions and risks (recommendation in each)

1. **Name `browser_check_change`.** Alternatives: `browser_baseline`, `browser_compare`.
   Recommendation: keep it; the action names read naturally.
2. **The baseline is fixed until the next baseline, not rolled forward by each check.** A rolling
   baseline is handier for fix loops, but hides the cumulative effect. Recommendation: fixed; the agent
   re-baselines when it wants to.
3. **`Network.loadNetworkResource` and `IO.read` through VS Code's CDP proxy are not verified.** If
   they are refused, the isolated-world `fetch` fallback works, but those fetches appear in the tab's
   network log. Recommendation: F2 verifies on day 1 with `debug_cdp`. If the fallback is needed, tag
   bridge fetches in the network log as "fetched by the bridge (source map)" (`state.network.annotate`)
   and have feature 3 ignore them.
4. **Starting Tab from the document start** (`Selection.collapse` + `blur`) is assumed to reset
   Chromium's sequential focus navigation starting point. Recommendation: verify in the F1 e2e; the
   specified fallback (script-focus the first tabbable, noted in the report) keeps results correct.
5. **Side effects of focus** (menus or tooltips opened by focus handlers) cannot be undone; only focus,
   scroll and selection are restored. Recommendation: accept, and document it in the result footer only
   when the DOM changed during the walk (watch count, as in F3's `INSTALL_WATCH`, F1's own copy).
6. **Focus emulation in out-of-process frames:** sending `Emulation.setFocusEmulationEnabled` to frame
   sessions is assumed to make `:focus-visible` behave as in the top document. Recommendation: verify
   with the cross-origin fixture; if it fails, report frame stops with "(focus style not checked in this
   frame)".
7. **Svelte 5 line base and meta shape** are taken from the compiler source, not run. Recommendation:
   F2 does a one-time manual check with a real Svelte 5 and Svelte 4 app outside the repository, then
   fixes the unit test vectors.
8. **Feature 3 source mapping depends on feature 2** (merge step 1). Before the merge, feature 3 prints
   dev-server paths (already `/src/...` under Vite). Recommendation: keep the one-line merge step rather
   than coupling the worktrees.
9. **Rebuilt bundles at the same URL** (webpack `main.js` after a recompile): fetching the script and
   map may give the new build while the page runs the old one, so lines can be off. Caching per
   `loaderId` limits this. Recommendation: accept; say "lines may be off: the bundle was rebuilt" when
   the map's `file` or `Last-Modified` is newer than the document (best effort).
10. **Pixel fallback for focus visibility** costs up to 40 small screenshots per walk (about 1–2 s).
    Recommendation: keep it; style-only checks miss focus rings painted by siblings or pseudo-elements.
