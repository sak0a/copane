# Browser login profiles

A login profile is a separate store of cookies, local storage and cache for integrated-browser tabs.
Tabs of one profile ("dev", "test", "prod", or a session's private one) share logins with each other
and with nobody else; tabs without a profile use the window's default store, as before. Code:
`src/extension/browser/profiles/`; end-to-end: `test/e2e/browser-profiles.e2e.mjs`.

## Mechanism

The proposed `openBrowserTab(url, options)` has no storage option. Through CDP it works: a session
started from any tab (`BrowserTab.startCDPSession()`), `Target.attachToBrowserTarget`, then on that
browser session `Target.createBrowserContext` returns `cdp-created:<uuid>`, and `Target.createTarget
{ url, browserContextId }` opens a real integrated-browser tab in that context (listed in
`window.browserTabs`, shown in the editor area, opened with `preserveFocus: true`, always in front).
In VS Code (`platform/browserView/electron-main/browserViewGroup.ts`, `browserSession.ts`) such a
context is an Electron `session.fromPartition('vscode-browser-cdp-created<uuid>')`: in memory, never on
disk. Each `startCDPSession()` is its own "group"; a group may open tabs in a context it created, or in
the context of a tab it contains (the tab it was started from and the tabs it created).

Copane keeps one such session open (the "host") for as long as the extension runs and creates every
profile with it. Profile name → context id is kept in memory and in `workspaceState` (with each profile
tab's view id), so after a window reload Copane recognises the tabs again.

## Lifetime and limits (VS Code 1.146.0, macOS; established by experiment)

| Event | Logins of the profile | How it was tested |
|---|---|---|
| A tab of the profile closes | kept | e2e: open, close, reopen |
| The last tab of the profile closes | kept while Copane's host session is open (until the window reloads or the extension restarts) | e2e; and a raw probe: context with no tab for 10 minutes, then a new tab in it was still logged in |
| The CDP session that created the context closes, a tab of it is still open | kept; any open tab of the profile can open more tabs in it | raw probe (`debug_cdp_raw`): closed the creating session, opened a new tab from a profile tab's own session: logged in |
| The tab the host session was started from closes | no effect: the session outlives it | raw probe |
| No tab open **and** the creating session gone | **lost**: `Target.createTarget` answers "Unknown browser context" from every other session | raw probe |
| Window reload | tabs come back in the **same** context, logged in; profiles without an open tab are lost (the host session ends with the extension host) | raw probe (`getTargets` showed the same `browserContextId` after reload) and e2e |
| Extension host restart ("Restart Extension Host", disabling/updating Copane) | like a reload | manual run with `workbench.action.restartExtensionHost` |
| VS Code restart | **all profiles lost.** Each restored tab comes back in a store of its own (`ephemeral:<viewId>`), empty, shared with nothing, never with the default store | manual quit (`workbench.action.quit`) and restart; `getTargets` showed `ephemeral:<viewId>` per tab, every page "Not logged in" |
| Copane disabled | open profile tabs keep working in their context as plain tabs; nothing creates new profile tabs | follows from the above (tabs do not depend on Copane's session) |

What Copane says about it: `browser_open` names the profile and, for a new or emptied profile, the
lifetime sentence; `browser_profiles` lists each profile as "tabs …", "no tab open, logins kept",
"no tab open", or "logins lost (reason); the next tab starts logged out"; a tab restored after a VS Code
restart is listed as "own login store (its profile ended when VS Code restarted)"; the user command's
quick pick shows the lifetime sentence and the status bar says when a profile starts logged out again.

Existing features in profile tabs (all through the tab's own page target, unchanged code): consent and
leases, the in-page indicator, certificate prompts, HTTP login prompts and request mocking through CDP
Fetch, cross-origin frames, downloads, emulation. Login prompts, mocking and frames are in the e2e;
downloads, emulation and certificates were run by hand (`Page.setDownloadBehavior` saved the file,
`browser_emulate` applied and reset, a self-signed site loaded after "Proceed"). Popups and
`target=_blank` tabs of a profile tab open in the same context (e2e); Copane recognises them by
reading the new tab's `browserContextId`.

### Found on the way, not specific to profiles

With `copane.browser.loginPrompts` on (the default), a tab that an agent session **controls** at the
moment of a window reload comes back stuck loading, and every CDP command that needs the renderer
(`Runtime.evaluate`, `Page.navigate`) times out. Reproduced with the profiles module switched off and in
the default store; it does not happen with `loginPrompts` off or when the tab was released before the
reload. Likely cause: the CDP `Fetch` interception the previous extension host enabled is never turned
off (`FetchInterception.dispose` sends `Fetch.disable` asynchronously, after its page connections may
already be closed, and the extension host goes away right after). A new session's `Fetch.enable` /
`Fetch.disable` did not release the tab. Not investigated further here. The profiles e2e releases its tabs before reloading.

## Precedence

Which store a new agent tab uses: `browser_open`'s `profile`, else the default the user set for the
session (Sessions view), else the one the agent set with `browser_profiles`, else the setting
`copane.browser.agentLoginStore` (`shared`: the default store; `private`: a private profile per
session). With `private`, agents cannot open tabs in the default store unless the user chose it for
that session.

## Persistence across restarts

Not possible with this mechanism: CDP-created contexts are in memory only, and a restored tab gets a
fresh ephemeral store. The honest persistent alternative is VS Code's own setting
`workbench.browser.dataStorage: "workspace"` (window scope, honoured in trusted workspaces only): every
tab of a workspace shares one store that is kept on disk per workspace. One workspace (or
`.code-workspace` file) per environment gives a persistent login per environment, one window each.
Copane does not set this up; it is one line in the workspace's settings, and it applies to tabs opened
after the change.

Copane does not export and re-import cookies. Session cookies of company single sign-on are bearer
credentials: written anywhere by an extension (even VS Code's secret storage, i.e. the OS keychain),
anyone who can read that store as the user, or any code running as the user, could replay them and act
as each signed-in account until they expire, including HttpOnly cookies that page scripts never see.

## Security

A profile isolates logins between tabs. It is not isolation from an agent: an agent session that uses
a tab of a profile acts with that profile's logins, as with any other tab. `agentLoginStore: private`
keeps agents' own tabs out of the user's default store; user tabs remain reachable only with consent,
as before.
