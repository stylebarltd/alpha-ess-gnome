# Alpha ESS Solar (GNOME Shell extension)

Top-bar indicator for an Alpha ESS system: solar output and battery % by day, house usage and battery % at night, plus a menu with load, grid, battery flow, daily energy and savings.

## Setup

Create `~/.config/alpha-ess/config.json`:

```json
{"appId": "...", "appSecret": "...", "sysSn": "...",
 "currency": "฿", "importPrice": 4.2, "exportPrice": 2.2, "refreshSeconds": 60}
```

Link the extension and reload the shell:

```sh
ln -s "$PWD/alpha-ess@pola" ~/.local/share/gnome-shell/extensions/alpha-ess@pola
```

Targets GNOME Shell 50.
