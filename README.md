# g4f4r0

Johan's personal tools, one folder per app.

| Path | What it is |
| --- | --- |
| [apps/capy-phone-bridge](apps/capy-phone-bridge) | Cloudflare Worker `capy-phone-bridge` that lets Johan talk to Axo by phone through Telnyx, and lets Axo phone him |
| [docs](docs) | Notes that span more than one app |

## Working in the repo

The repo is an npm workspace. Run `npm install` once at the root, then `npm test` and `npm run typecheck` to check every app. Each app keeps its own README with setup, configuration and deploy steps.

A new app goes in `apps/<name>` with its own `package.json` that defines `test` and `typecheck` scripts. Shared code goes in `packages/<name>` once a second app needs it.
