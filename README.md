# Jhunkenn's Mining Rig

A lead-extraction tool for self-published-author prospecting. Paste raw text from people-search
sites (TruePeopleSearch, FastBackgroundCheck, Whitepages) and/or book/merchant pages (Amazon,
Barnes & Noble, Goodreads), and it parses everything into a fixed, 16-cell spreadsheet-ready row.

Built with React + Vite.

## Run locally

```bash
npm install
npm run dev      # start the dev server (http://localhost:5173)
npm run build    # production build into dist/
npm run preview  # preview the production build locally
```

Requires Node.js 18 or newer.

## Deploy

### Vercel
1. Push this folder to a Git repo (GitHub/GitLab/Bitbucket).
2. In Vercel, "Add New Project" and import the repo.
3. Vercel auto-detects the **Vite** framework. No configuration needed.
   - Build command: `npm run build`
   - Output directory: `dist`
4. Deploy.

### Netlify
1. Push this folder to a Git repo.
2. In Netlify, "Add new site" -> "Import an existing project" and pick the repo.
3. Settings are read from `netlify.toml` automatically (build `npm run build`, publish `dist`).
4. Deploy.

## Project structure

```
.
├── index.html          # Vite HTML entry
├── package.json        # scripts + dependencies
├── vite.config.js      # Vite + React plugin
├── netlify.toml        # Netlify build config + SPA fallback
├── .gitignore
└── src/
    ├── main.jsx        # React entry point (mounts <App />)
    └── App.jsx         # the entire tool (parser + UI)
```
