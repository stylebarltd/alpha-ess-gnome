# Alpha ESS Solar (GNOME Shell extension)

<!-- Public repo: keep this file free of credentials, serial numbers and local paths. -->

## What this is
Top-bar indicator for an Alpha ESS solar/battery system: solar output and battery %
by day, house load and battery % at night; the menu shows load, grid, battery flow,
daily energy and savings. Repo `stylebarltd/alpha-ess-gnome` (public).

## Stack & layout
- GNOME Shell extension (GJS, ES modules), uuid `alpha-ess@pola`, shell 46–50.
- `alpha-ess@pola/extension.js`: everything (API polling, panel, menu);
  `stylesheet.css`; `icons/`; `metadata.json`.
- Data: Alpha ESS Open API, credentials read from `~/.config/alpha-ess/config.json`
  (`appId`, `appSecret`, `sysSn`, prices, `refreshSeconds`), never from the repo.

## Commands
```bash
ln -s "$PWD/alpha-ess@pola" ~/.local/share/gnome-shell/extensions/alpha-ess@pola   # once
gnome-extensions enable alpha-ess@pola
journalctl -f -o cat /usr/bin/gnome-shell     # extension logs and errors
```
Reload after a change: X11 `Alt+F2`, `r`; Wayland: log out and back in.

## Gotchas
- The config file holds API secrets. Never commit it or paste its values.
- When the API never answers, the indicator shows offline; keep that path working.
