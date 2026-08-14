# Pasture game integration

Original prompt: Wire H-146's ready Wolves & Wool browser game to Urufu's Easter egg game path.

## 2026-08-14

- Picked up H-146 in a clean worktree based on `origin/main`.
- Confirmed the game requires a same-origin, unsandboxed static host to preserve its local saves.
- Confirmed the game also depends on the local biome generator and color-grade file, in addition to the listed model and UI assets.
- Packaged the 28-file, 17 MB runtime under `web/public/pasture-game/` with all runtime paths rewritten to `/pasture-game/`.
- Added the home-page discovery card, same-origin unsandboxed `/pasture` host, direct-open control, in-game return, and visible asset credits.
- Verified desktop and mobile entry, same-origin local saves, primary and fallback sheep loading, wolf/farm asset loads, and clean real-WebGL farm rendering.
- Passed TypeScript, ESLint (18 pre-existing warnings), and the webpack production build. The source game's 115-case suite reached 111 passes; its four failures only assert the retired `/projects/afterglow` URL and deliberately induce its resulting 404. A packaged-route smoke test covered those rewritten URL and fallback cases successfully.

## Next

- Keep this local-only branch unpushed until the Free3D wolf asset has a publication-safe replacement license or explicit permission.
