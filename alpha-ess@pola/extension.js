import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import cairo from 'cairo';
import Soup from 'gi://Soup';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const API = 'https://openapi.alphaess.com/api';
const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'alpha-ess', 'config.json']);
const DEFAULTS = {
    currency: '฿',
    importPrice: 4.2,   // cost per kWh bought from grid
    exportPrice: 2.2,   // credit per kWh sold to grid
    refreshSeconds: 60,
    socLow: 35,         // battery % at or below this shows red (inverter switches to grid ~28%)
    socHigh: 60,        // below this shows orange, from here green
    loadLow: 1.5,       // house load in kW up to this shows green
    loadHigh: 4,        // up to this orange, above red
    pvLow: 3,           // solar kW below this shows the sun grey (20 kWp array)
    pvHigh: 8,          // below this light yellow, from here full yellow
    importMin: 100,     // grid import in W above this counts as buying (ignores standby trickle)
    flowMin: 50,        // solar / battery W below this count as idle
};

const fmtKw = w => `${(w / 1000).toFixed(2)} kW`;
const fmtKwh = v => `${(v ?? 0).toFixed(1)} kWh`;
const LEVELS = ['alpha-ess-good', 'alpha-ess-warn', 'alpha-ess-bad'];
const SUN = ['alpha-ess-sun-strong', 'alpha-ess-sun-mid', 'alpha-ess-sun-weak'];
const MOON = 'alpha-ess-moon';
const setLevel = (w, level, classes = LEVELS) => {
    for (const c of classes) w.remove_style_class_name(c);
    if (level != null) w.add_style_class_name(classes[level]);
};
const setClass = (w, cls) => {
    for (const c of [...LEVELS, ...SUN, MOON]) w.remove_style_class_name(c);
    if (cls) w.add_style_class_name(cls);
};

// same colours as .alpha-ess-good / -warn / -bad in the stylesheet, for Cairo
const LEVEL_RGB = [[0x57, 0xe3, 0x89], [0xff, 0xa3, 0x48], [0xff, 0x7b, 0x63]];

const roundRect = (cr, x, y, w, h, r) => {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
};

// Horizontal battery in the top bar, sized by the stylesheet (.alpha-ess-battery): a bold
// outline with a gap, the body filled to the charge level in the level colour, the
// percentage in large bold text on top, a bolt on the left while charging. Flow is shown by
// a faint light sheen that drifts very slowly through the fill: rightwards (towards full)
// while charging, leftwards while discharging, still when idle.
const SHEEN_PERIOD_MS = 12000;   // one sweep; slow enough not to catch the eye
const SHEEN_FRAME_MS = 80;
const BatteryGauge = GObject.registerClass(
class BatteryGauge extends St.DrawingArea {
    _init() {
        super._init({style_class: 'alpha-ess-battery', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._soc = 0;
        this._level = 0;
        this._flow = 0;        // 1 charging, -1 discharging, 0 idle
        this._timer = null;
        this.connect('repaint', () => this._draw());
        this.connect('destroy', () => this._stopSheen());
    }

    set(soc, level, flow) {
        this._soc = Math.min(100, Math.max(0, soc));
        this._level = level;
        this._flow = flow;
        this.visible = true;
        if (flow) this._startSheen(); else this._stopSheen();
        this.queue_repaint();
    }

    _startSheen() {
        if (this._timer) return;
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, SHEEN_FRAME_MS, () => {
            if (this.mapped) this.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSheen() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
    }

    _draw() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const fg = this.get_theme_node().get_foreground_color();
        const [r, g, b] = LEVEL_RGB[this._level] ?? LEVEL_RGB[0];
        const fgRGBA = a => cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255, fg.alpha / 255 * a);
        const lw = 1.5, nubW = 3, nubH = Math.round(h * 0.45), gap = 1.5;
        const bw = w - nubW - 1;   // body width; the nub and a hair of air take the rest
        const radius = 4;

        // outline and nub in the panel's text colour
        fgRGBA(0.9);
        cr.setLineWidth(lw);
        roundRect(cr, lw / 2, lw / 2, bw - lw, h - lw, radius);
        cr.stroke();
        roundRect(cr, bw + 1, (h - nubH) / 2, nubW, nubH, 1.5);
        cr.fill();

        // charge level with a gap inside the outline, translucent so the text stays readable
        const pad = lw + gap, inner = bw - 2 * pad, innerH = h - 2 * pad;
        const fill = Math.round(inner * this._soc / 100);
        if (fill > 0) {
            cr.setSourceRGBA(r / 255, g / 255, b / 255, 0.6);
            roundRect(cr, pad, pad, fill, innerH, radius - gap);
            cr.fill();
        }

        // slow sheen through the fill while charging / discharging
        if (this._flow && fill >= 8) {
            const band = Math.max(10, fill * 0.6);
            const phase = (GLib.get_monotonic_time() / 1000 % SHEEN_PERIOD_MS) / SHEEN_PERIOD_MS;
            const travel = fill + band;
            const x = this._flow > 0 ? pad - band + phase * travel : pad + fill - phase * travel;
            const grad = new cairo.LinearGradient(x, 0, x + band, 0);
            grad.addColorStopRGBA(0, 1, 1, 1, 0);
            grad.addColorStopRGBA(0.5, 1, 1, 1, 0.22);
            grad.addColorStopRGBA(1, 1, 1, 1, 0);
            cr.save();
            roundRect(cr, pad, pad, fill, innerH, radius - gap);
            cr.clip();
            cr.setSource(grad);
            cr.paint();
            cr.restore();
        }

        // bolt while charging (shape of icons/grid-power-symbolic.svg, scaled to about 7×11)
        let textX = pad;
        let textW = inner;
        if (this._flow > 0) {
            const k = Math.min(0.75, (innerH - 2) / 15);
            const bx = pad + 2, by = (h - 15 * k) / 2;
            const pts = [[9.5, 0.5], [3, 9], [7.2, 9], [5.8, 15.5], [13, 6.5], [8.6, 6.5]];
            fgRGBA(1);
            pts.forEach(([x, y], i) => cr[i ? 'lineTo' : 'moveTo'](bx + (x - 3) * k, by + (y - 0.5) * k));
            cr.closePath();
            cr.fill();
            const used = 10 * k + 3;
            textX += used;
            textW -= used;
        }

        // percentage, centred in what is left of the body
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string('Sans Bold 9'));
        layout.set_text(`${Math.round(this._soc)}%`, -1);
        const [, log] = layout.get_pixel_extents();
        fgRGBA(1);
        cr.moveTo(textX + (textW - log.width) / 2 - log.x, (h - log.height) / 2 - log.y);
        PangoCairo.show_layout(cr, layout);

        cr.$dispose();
    }
});

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(path, onRefresh) {
        super._init(0.5, 'Alpha ESS Solar');
        this.add_style_class_name('alpha-ess-button');
        this._gridIcon = new Gio.FileIcon({file: Gio.File.new_for_path(GLib.build_filenamev([path, 'icons', 'grid-power-symbolic.svg']))});
        // [what matters most now: grid / sun / moon][kW]  [horizontal battery with % inside]
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box alpha-ess-chip'});
        this._icon = new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'system-status-icon'});
        this._box.add_child(this._icon);
        this._label = new St.Label({text: '…', y_align: Clutter.ActorAlign.CENTER, style_class: 'alpha-ess-label'});
        this._box.add_child(this._label);
        this._bat = new BatteryGauge();
        this._box.add_child(this._bat);
        this.add_child(this._box);

        this._rows = {};
        for (const [k, title] of [
            ['pv', 'Solar'], ['load', 'House load'], ['bat', 'Battery'], ['grid', 'Grid'], ['_', null],
            ['pvToday', 'Solar today'], ['gridToday', 'Grid import today'], ['_', null],
            ['saveToday', 'Saved today'], ['saveMonth', 'Saved this month'], ['_', null],
            ['status', 'Updated'],
        ]) {
            if (!title) { this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem()); continue; }
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false});
            const key = new St.Label({text: title, style_class: 'alpha-ess-key'});
            const val = new St.Label({text: '–', style_class: 'alpha-ess-val', x_expand: true, x_align: Clutter.ActorAlign.END});
            item.add_child(key); item.add_child(val);
            this.menu.addMenuItem(item);
            this._rows[k] = val;
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Refresh now', onRefresh, 'view-refresh-symbolic');
    }
    setRow(k, text) { this._rows[k]?.set_text(text); }
    setPanel(text) {
        this._label.set_text(text);
        setLevel(this._label, null);
    }

    // mode: 'import' (buying from the grid), 'sun' or 'night'
    setMode(mode, text, {sunLevel = null, loadLevel = null} = {}) {
        this._icon.visible = true;
        if (mode === 'import') {
            this._icon.gicon = this._gridIcon;
            setClass(this._icon, LEVELS[2]);
        } else if (mode === 'sun') {
            this._icon.icon_name = 'weather-clear-symbolic';
            setClass(this._icon, SUN[sunLevel]);
        } else {
            this._icon.icon_name = 'weather-clear-night-symbolic';
            setClass(this._icon, MOON);
        }
        this._label.set_text(text);
        setLevel(this._label, mode === 'import' ? 2 : mode === 'night' ? loadLevel : null);
        if (mode === 'import') this._box.add_style_class_name('alpha-ess-importing');
        else this._box.remove_style_class_name('alpha-ess-importing');
    }

    setSoc(soc, level, flow) {
        this._bat.set(soc, level, flow);
        setLevel(this._rows.bat, level);
    }
    setGridLevel(level) { setLevel(this._rows.grid, level); }
    setLoadLevel(level) { setLevel(this._rows.load, level); }
    setPvLevel(level) { setLevel(this._rows.pv, level, SUN); }   // the top-bar icon is coloured by setMode
});

export default class AlphaEssExtension extends Extension {
    enable() {
        this._session = new Soup.Session({timeout: 20});
        this._cancel = new Gio.Cancellable();
        this._dayCache = new Map();   // 'YYYY-MM-DD' -> {epv,eInput,eOutput,eload?}
        this._busy = false;
        this._hasData = false;
        this._indicator = new Indicator(this.path, () => this._refresh());
        Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'left'); // left side of the top bar, after Activities
        this._loadConfig();
        this._tick();
    }

    disable() {
        this._cancel?.cancel();
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._session?.abort();
        this._session = null;
        this._dayCache = null;
    }

    _loadConfig() {
        try {
            const [, bytes] = GLib.file_get_contents(CONFIG_PATH);
            this._cfg = {...DEFAULTS, ...JSON.parse(new TextDecoder().decode(bytes))};
        } catch (e) {
            this._cfg = null;
            this._indicator.setPanel('no config');
            this._indicator.setRow('status', `Missing ${CONFIG_PATH}`);
        }
    }

    async _api(endpoint, params) {
        const {appId, appSecret, sysSn} = this._cfg;
        const ts = Math.floor(Date.now() / 1000).toString();
        const sign = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA512, `${appId}${appSecret}${ts}`, -1);
        const q = Object.entries({sysSn, ...params})
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('&');
        const msg = Soup.Message.new('GET', `${API}/${endpoint}?${q}`);
        const h = msg.get_request_headers();
        h.append('appId', appId); h.append('timeStamp', ts); h.append('sign', sign);
        const bytes = await this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancel);
        if (msg.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${msg.get_status()}`);
        const json = JSON.parse(new TextDecoder().decode(bytes.get_data()));
        if (json.code !== 200) throw new Error(`API ${json.code}: ${json.msg}`);
        return json.data;
    }

    _saving(day) {
        // Solar value = self-consumed energy at import price + exported at export price.
        const used = Math.max((day.epv ?? 0) - (day.eOutput ?? 0), 0);
        return used * this._cfg.importPrice + (day.eOutput ?? 0) * this._cfg.exportPrice;
    }

    _dateStr(d) {
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    async _monthSaving(today) {
        const now = new Date();
        let total = this._saving(today);
        for (let d = 1; d < now.getDate(); d++) {
            const ds = this._dateStr(new Date(now.getFullYear(), now.getMonth(), d));
            if (!this._dayCache.has(ds)) {
                try { this._dayCache.set(ds, await this._api('getOneDateEnergyBySn', {queryDate: ds})); }
                catch (e) { continue; }
            }
            total += this._saving(this._dayCache.get(ds));
        }
        return total;
    }

    async _refresh() {
        if (!this._cfg || this._busy) return;   // a hung request must not stack up more
        this._busy = true;
        const ind = this._indicator;
        ind.setRow('status', 'Refreshing…');
        try {
            const rt = await this._api('getLastPowerData', {});
            const soc = rt.soc ?? 0, pv = rt.ppv ?? 0, bat = rt.pbat ?? 0, grid = rt.pgrid ?? 0;
            const load = rt.pload ?? 0;
            const {flowMin, importMin} = this._cfg;
            const loadLevel = load / 1000 <= this._cfg.loadLow ? 0 : load / 1000 <= this._cfg.loadHigh ? 1 : 2;
            const kwPv = pv / 1000;
            const sunLevel = kwPv >= this._cfg.pvHigh ? 0 : kwPv >= this._cfg.pvLow ? 1 : 2;
            const kw = w => `${(w / 1000).toFixed(1)}kW`;
            // What the top bar leads with, most important first:
            //   1. buying from the grid (red bolt + import kW): that costs money
            //   2. sun producing (sun coloured by strength + solar kW)
            //   3. otherwise night (moon + house load, coloured by size)
            if (grid > importMin) ind.setMode('import', kw(grid));
            else if (pv > flowMin) ind.setMode('sun', kw(pv), {sunLevel});
            else ind.setMode('night', kw(load), {loadLevel});
            ind.setLoadLevel(loadLevel);
            ind.setPvLevel(sunLevel);
            ind.setGridLevel(grid > importMin ? 2 : grid < -importMin ? 0 : null);
            // battery gauge shows level and flow: pbat < 0 charging, > 0 discharging
            ind.setSoc(soc, soc <= this._cfg.socLow ? 2 : soc < this._cfg.socHigh ? 1 : 0,
                bat < -flowMin ? 1 : bat > flowMin ? -1 : 0);
            ind.setRow('pv', fmtKw(pv));
            ind.setRow('load', fmtKw(load));
            // Alpha ESS: pbat > 0 discharging, < 0 charging; pgrid > 0 importing.
            ind.setRow('bat', `${Math.round(soc)}%  ${bat > 0 ? '▼ ' + fmtKw(bat) : bat < 0 ? '▲ ' + fmtKw(-bat) : 'idle'}`);
            ind.setRow('grid', grid >= 0 ? `import ${fmtKw(grid)}` : `export ${fmtKw(-grid)}`);

            const day = await this._api('getOneDateEnergyBySn', {queryDate: this._dateStr(new Date())});
            ind.setRow('pvToday', fmtKwh(day.epv));
            ind.setRow('gridToday', fmtKwh(day.eInput));
            const c = this._cfg.currency;
            ind.setRow('saveToday', `${c}${this._saving(day).toFixed(0)}`);
            ind.setRow('saveMonth', `${c}${(await this._monthSaving(day)).toFixed(0)}`);
            ind.setRow('status', new Date().toLocaleTimeString());
            this._hasData = true;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
            ind.setRow('status', `Error: ${e.message}`);
            if (!this._hasData) ind.setPanel('offline');
        } finally {
            this._busy = false;
        }
    }

    _tick() {
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(this._cfg?.refreshSeconds ?? 60, 30), () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
    }
}
