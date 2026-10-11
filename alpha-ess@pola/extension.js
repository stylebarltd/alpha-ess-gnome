import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
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
};

const fmtKw = w => `${(w / 1000).toFixed(2)} kW`;
const fmtKwh = v => `${(v ?? 0).toFixed(1)} kWh`;
const LEVELS = ['alpha-ess-good', 'alpha-ess-warn', 'alpha-ess-bad'];
const SUN = ['alpha-ess-sun-strong', 'alpha-ess-sun-mid', 'alpha-ess-sun-weak'];
const setLevel = (w, level, classes = LEVELS) => {
    for (const c of classes) w.remove_style_class_name(c);
    if (level != null) w.add_style_class_name(classes[level]);
};

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Alpha ESS Solar');
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box alpha-ess-chip'});
        this._icon = new St.Icon({icon_name: 'weather-clear-symbolic', style_class: 'system-status-icon'});
        box.add_child(this._icon);
        this._label = new St.Label({text: '…', y_align: Clutter.ActorAlign.CENTER, style_class: 'alpha-ess-label'});
        box.add_child(this._label);
        this._sep = new St.Label({text: ' · ', visible: false, y_align: Clutter.ActorAlign.CENTER, style_class: 'alpha-ess-label'});
        box.add_child(this._sep);
        this._soc = new St.Label({text: '', y_align: Clutter.ActorAlign.CENTER, style_class: 'alpha-ess-label'});
        box.add_child(this._soc);
        this.add_child(box);

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
    }
    setRow(k, text) { this._rows[k]?.set_text(text); }
    setPanel(text, showIcon = true, level = null) {
        this._label.set_text(text);
        setLevel(this._label, level);
        this._icon.visible = showIcon;
    }
    setSoc(text, level) {
        this._soc.set_text(text);
        this._sep.visible = true;
        setLevel(this._soc, level);
        setLevel(this._rows.bat, level);
    }
    setLoadLevel(level) { setLevel(this._rows.load, level); }
    setPvLevel(level) {
        setLevel(this._icon, level, SUN);
        setLevel(this._rows.pv, level, SUN);
    }
});

export default class AlphaEssExtension extends Extension {
    enable() {
        this._session = new Soup.Session({timeout: 20});
        this._cancel = new Gio.Cancellable();
        this._dayCache = new Map();   // 'YYYY-MM-DD' -> {epv,eInput,eOutput,eload?}
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
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
        if (!this._cfg) return;
        const ind = this._indicator;
        try {
            const rt = await this._api('getLastPowerData', {});
            const soc = rt.soc ?? 0, pv = rt.ppv ?? 0, bat = rt.pbat ?? 0, grid = rt.pgrid ?? 0;
            // Night (no solar): drop the icon and show house usage instead of PV output.
            const night = pv <= 0;
            const load = rt.pload ?? 0;
            const loadLevel = load / 1000 <= this._cfg.loadLow ? 0 : load / 1000 <= this._cfg.loadHigh ? 1 : 2;
            // Colour the panel kW only when it shows house load; solar output is never "bad".
            ind.setPanel(`${((night ? load : pv) / 1000).toFixed(1)}kW`, !night, night ? loadLevel : null);
            ind.setLoadLevel(loadLevel);
            const kwPv = pv / 1000;
            ind.setPvLevel(kwPv >= this._cfg.pvHigh ? 0 : kwPv >= this._cfg.pvLow ? 1 : 2);
            ind.setSoc(`${Math.round(soc)}%`, soc <= this._cfg.socLow ? 2 : soc < this._cfg.socHigh ? 1 : 0);
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
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
            ind.setRow('status', `Error: ${e.message}`);
        }
    }

    _tick() {
        this._refresh();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            Math.max(this._cfg?.refreshSeconds ?? 60, 30), () => { this._refresh(); return GLib.SOURCE_CONTINUE; });
    }
}
