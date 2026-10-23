# Deployment

The site is built with Vite and published to GitHub Pages at <https://khalidibnwalid.github.io/map-generator/>.

## How it works

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs on every push to `main` (and on manual dispatch):

1. Checks out the repo and installs pnpm and Node (LTS).
2. Runs `pnpm install --frozen-lockfile`, so `pnpm-lock.yaml` must be committed and up to date.
3. Runs `pnpm run build` (type-check, then `vite build`) into `dist/`.
4. Uploads `dist/` and deploys it with the official Pages actions.

## First-time setup

1. Push the repo to GitHub.
2. Go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` or run the workflow from the **Actions** tab.

## Forks and renames

The app is served from a sub-path, so the asset base is set in [`vite.config.ts`](vite.config.ts):

```ts
base: "/map-generator/",
```

If you fork under another repo name or use a custom domain, change `base` to match (`"/"` for a custom domain or a `username.github.io` repo).

The absolute URLs in [`index.html`](index.html) (canonical, Open Graph, JSON-LD), [`public/sitemap.xml`](public/sitemap.xml), [`public/robots.txt`](public/robots.txt) and [`public/llms.txt`](public/llms.txt) point at `https://khalidibnwalid.github.io/map-generator/` and also need updating.

## Local production check

```bash
pnpm build
pnpm preview
```

Open the URL Vite prints, including the `/map-generator/` path.
