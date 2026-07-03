# GitHub Pages data-pack deployment

The app and generated offline data pack are deployed as one static GitHub Pages site. Generated data is not committed to Git.

Stable paths after deployment:

```text
https://br0c.github.io/meet-the-cows/
https://br0c.github.io/meet-the-cows/packs/packs.json
https://br0c.github.io/meet-the-cows/packs/fr-alps/manifest.json
https://br0c.github.io/meet-the-cows/packs/fr-alps/fields.json
https://br0c.github.io/meet-the-cows/packs/fr-alps/media/...
```

Setup:

1. Repository Settings → Pages → Build and deployment → Source: GitHub Actions.
2. Repository Settings → Secrets and variables → Actions → add `OPENAIP_API_KEY`.
3. Run the workflow: Actions → Deploy app and data pack to Pages → Run workflow.

The site is currently around 472 MB, below GitHub Pages' published 1 GB site-size limit.
