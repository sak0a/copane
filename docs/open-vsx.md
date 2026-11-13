# Publishing to Open VSX

Cursor, VSCodium, Windsurf and other editors install extensions from [Open VSX](https://open-vsx.org),
not from the Visual Studio Marketplace. The VSIX that `npm run package` builds is the same for both:
Open VSX needs no manifest change (`publisher: saka` becomes the namespace, `license` and `LICENSE`
are present, `enabledApiProposals` is accepted). Which editors can use Copane is in the README
(*Other editors*).

## One-time setup (by hand, by the owner)

1. Create an Eclipse account at <https://accounts.eclipse.org> and enter your GitHub user name in
   its profile.
2. Log in at <https://open-vsx.org> with that GitHub account. In *Settings*, *Log in with Eclipse*,
   then *Show Publisher Agreement* and agree to it.
3. In *Settings → Access Tokens*, generate a token and keep it somewhere safe (it is shown once).
4. Create the namespace (it was still free on 2026-11-14):

       npx ovsx create-namespace saka -p <token>

5. Optional: claim the namespace so releases are shown as from a verified publisher. Open an issue
   at <https://github.com/EclipseFdn/open-vsx.org/issues> with the namespace template; because `saka`
   is also a Marketplace publisher, you show that you control it.

## Each release

    npm run package                                  # copane-<version>.vsix
    npx ovsx publish copane-<version>.vsix -p <token>   # or set OVSX_PAT instead of -p

`vsce publish` to the Marketplace needs `--allow-proposed-apis browser terminalDataWriteEvent
terminalDimensions` (or `--allow-all-proposed-apis`) because of `enabledApiProposals`; `ovsx` has no
such check.
