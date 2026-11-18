const bundleTemplate = /(<script type="__bundler\/template">\s*)([\s\S]*?)(\s*<\/script>)/;

const primaryButton = 'min-height: 40px; padding: 0 16px; border: 1px solid #4A1A2C; border-radius: 999px; background: #4A1A2C; color: #FFFFFF; font: inherit; font-weight: 600; cursor: pointer';
const secondaryButton = 'min-height: 40px; padding: 0 12px; border: 1px solid #E7DFD6; border-radius: 999px; background: #FAF7F2; color: #4A1A2C; font: inherit; font-weight: 600; cursor: pointer';
const braceletPanel = `
<section aria-label="Bracelet sync" style="display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid #E7DFD6; border-radius: 18px; background: #FFFFFF; font-size: 13px">
<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
<sc-if value="{{braceletDisconnected}}" hint-placeholder-val="{{true}}">
<button type="button" disabled="{{braceletBusy}}" sc-camel-on-click="{{connectBracelet}}" style="${primaryButton}">Sync bracelet</button>
<span style="color: #7A5E66">Bracelet disconnected</span>
</sc-if>
<sc-if value="{{braceletConnected}}" hint-placeholder-val="{{false}}">
<span style="flex-basis: 100%; overflow-wrap: anywhere">{{braceletName}}</span>
<button type="button" disabled="{{braceletBusy}}" sc-camel-on-click="{{syncBracelet}}" style="${primaryButton}">Sync now</button>
<button type="button" disabled="{{braceletBusy}}" sc-camel-on-click="{{disconnectBracelet}}" style="${secondaryButton}">Disconnect</button>
<button type="button" disabled="{{braceletBusy}}" sc-camel-on-click="{{switchBracelet}}" style="${secondaryButton}">Switch bracelet</button>
</sc-if>
</div>
<p role="status" style="margin: 0; color: #7A5E66">{{braceletMessage}}</p>
</section>
`.trim();

function replaceOnce(template, before, after) {
  const start = template.indexOf(before);
  if (start === -1 || template.indexOf(before, start + before.length) !== -1) {
    throw new Error('Frontend.html changed. Check the timeline preview anchor: ' + before.slice(0, 90));
  }
  return template.slice(0, start) + after + template.slice(start + before.length);
}

// Render an in-memory variant of the exported prototype. Its original HTML,
// mobile bundle, and sample data stay available through their usual entrypoints.
export function renderPreview(html, accounts) {
  const match = html.match(bundleTemplate);
  if (!match) throw new Error('Frontend.html is missing its bundled template.');
  let template = JSON.parse(match[2]);
  const replace = (before, after) => {
    template = replaceOnce(template, before, after);
  };

  replace('#C9A14A"></span>Synced</span>', '#C9A14A"></span>Local preview</span>');
  replace('<p style="margin: 0; font-size: 14px; color: #7A5E66">{{countText}}</p>',
    '<p role="status" style="margin: 0; font-size: 14px; color: #7A5E66">{{countText}}</p>');
  const filtersRow = '<div style="display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; margin: 0 -20px; padding-left: 20px; padding-right: 20px">\n<sc-for list="{{filters}}" as="f" hint-placeholder-count="7">';
  replace(filtersRow, [braceletPanel, filtersRow].join('\n'));
  replace('No one in this time range. Try a longer one.',
    'No encounters in this view. Sync your bracelet or try All time.');
  replace('Turn on Bluetooth, then hold your bracelet near your phone.',
    'Turn on Bluetooth, then select your bracelet when Chrome asks.');
  replace('type="button" sc-camel-on-click="{{pairAction}}"',
    'type="button" disabled="{{braceletBusy}}" sc-camel-on-click="{{pairAction}}"');
  replace('<p style="margin: 0; font-size: 14px; color: #7A5E66; text-align: center; max-width: 280px; line-height: 1.5">{{pairHint}}</p>',
    '<p role="status" style="margin: 0; font-size: 14px; color: #7A5E66; text-align: center; max-width: 280px; line-height: 1.5">{{pairHint}}</p>');
  replace('<input type="text" value="{{profName}}"', `<sc-if value="{{showProfileNameError}}" hint-placeholder-val="{{false}}">
<p role="alert" style="margin: 0; color: #8B2635">{{profileNameError}}</p>
</sc-if>
<input type="text" maxlength="80" value="{{profName}}"`);
  replace('type="button" sc-camel-on-click="{{profileNext}}"',
    'type="button" disabled="{{profileSaving}}" sc-camel-on-click="{{profileNext}}"');

  const initialEncounters = JSON.stringify(accounts).replace(/</g, '\\u003c');
  replace('class Component extends DCLogic {', `
const BRACELET_ENCOUNTERS = ${initialEncounters};
const tapTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric',
  minute: '2-digit', second: '2-digit', timeZoneName: 'short'
});
function demoClicks(accounts, owner) {
  const now = Date.now();
  return (accounts[owner] ?? []).slice()
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))
    .map(({ id, peerId, peerName, timestampMs }) => ({
      id, name: peerName ?? peerId, desc: 'Bracelet encounter', loc: '', event: '',
      photo: '', socials: [], about: '', mins: timestampMs === null
        ? Infinity : Math.max(0, (now - timestampMs) / 60000),
      when: timestampMs === null ? 'Time unknown' : tapTime.format(timestampMs)
    }));
}

class Component extends DCLogic {`.trimStart());
  replace("      screen: 'welcome',", `      screen: 'welcome',
      braceletOwner: null,
      profileBraceletOwner: null,
      profileSaving: false,
      profileNameError: '',
      demoEncounters: BRACELET_ENCOUNTERS,
      braceletInfo: null,
      braceletBusy: false,
      braceletMessage: '',`);
  replace("      filter: 'year',", "      filter: 'all',");
  replace('  componentWillUnmount() { clearTimeout(this.pairTimer); clearTimeout(this.askTimer); }', `  componentDidMount() {
    this.braceletControls = window.createClickBraceletControls({
      update: (patch) => this.setState(patch),
      updateTimeline: (demoEncounters) => this.setState({ demoEncounters }),
      selectBraceletOwner: (owner) => this.selectBraceletOwner(owner)
    });
  }

  componentWillUnmount() {
    clearTimeout(this.askTimer);
    this.braceletControls?.close();
  }

  selectBraceletOwner(owner) {
    if (!Object.hasOwn(BRACELET_ENCOUNTERS, owner)) return false;
    if (owner === this.state.braceletOwner) return true;
    clearTimeout(this.askTimer);
    this.setState({
      braceletOwner: owner, profileBraceletOwner: this.state.profileBraceletOwner ?? owner,
      filter: 'all', selectedId: null, expandedId: null,
      noteOpenId: null, editingLoc: false, locDraft: '',
      chat: [], chatDraft: '', asking: false
    });
    return true;
  }

  async continueProfile(screen) {
    const { profileBraceletOwner, profileSaving, profName } = this.state;
    if (profileSaving) return;
    const displayName = profName.trim();
    if (!profileBraceletOwner || !displayName) {
      this.setState({ screen, profileNameError: '' });
      return;
    }
    this.setState({ profileSaving: true, profileNameError: '' });
    try {
      await this.braceletControls.saveProfileName(profileBraceletOwner, displayName);
      this.setState({ screen });
    } catch (error) {
      this.setState({ profileNameError: error.message || 'Could not save your local profile name. Try again.' });
    } finally {
      this.setState({ profileSaving: false });
    }
  }`);
  replace('const people = CLICK_DATA.filter', 'const people = demoClicks(this.state.demoEncounters, this.state.braceletOwner).filter');
  replace('const CLICKS = CLICK_DATA;', 'const CLICKS = demoClicks(s.demoEncounters, s.braceletOwner);');
  replace('const FILTERS = [', "const FILTERS = [\n      { id: 'all', label: 'All time', max: Infinity, phrase: 'saved locally' },");
  replace('|| FILTERS[6];', '|| FILTERS[0];');
  replace("place: ev ? ev + ', ' + c.loc : c.loc,", "place: [ev, c.loc].filter(Boolean).join(', ') || 'Location not recorded',");
  replace("screen: 'clicks', filter: 'year', expandedId: p.id", "screen: 'clicks', filter: 'all', expandedId: p.id");
  replace('|| CLICKS[0];', "|| CLICKS[0] || { name: '', desc: '', loc: '', when: 'Time unknown', socials: [] };");
  replace('    const pairState = s.pairState;',
    "    const pairState = s.braceletInfo ? 'paired' : (s.braceletBusy ? 'searching' : 'idle');");
  replace("      pairBack: set({ screen: s.fromSettings ? 'settings' : 'welcome' }),", `      pairBack: () => {
        if (!this.state.braceletBusy) set({ screen: s.fromSettings ? 'settings' : 'welcome' })();
      },`);
  replace("      pairHint: pairState === 'paired' ? 'Connected over Bluetooth. Your new Clicks will sync here automatically.' : 'Keep your bracelet within a few inches of your phone.',",
    "      pairHint: s.braceletMessage || 'Turn on Bluetooth and keep your bracelet near this computer.',");
  const mockPairAction = `      pairAction: pairState === 'paired'
        ? set({ screen: s.fromSettings ? 'settings' : 'profile' })
        : () => {
            if (this.state.pairState === 'searching') return;
            this.setState({ pairState: 'searching' });
            clearTimeout(this.pairTimer);
            this.pairTimer = setTimeout(() => this.setState({ pairState: 'paired' }), 1600);
          },`;
  replace(mockPairAction, `      pairAction: pairState === 'paired'
        ? set({ screen: s.fromSettings ? 'settings' : 'profile' })
        : () => this.braceletControls.choose(),`);
  replace("      profileNext: set({ screen: s.fromSettings ? 'settings' : 'socials' }),", `      profileSaving: s.profileSaving,
      showProfileNameError: !!s.profileNameError,
      profileNameError: s.profileNameError,
      profileNext: () => this.continueProfile(s.fromSettings ? 'settings' : 'socials'),`);
  replace('      filters, clicks,', `      braceletBusy: s.braceletBusy,
      braceletMessage: s.braceletMessage,
      braceletConnected: !!s.braceletInfo,
      braceletDisconnected: !s.braceletInfo,
      braceletName: s.braceletInfo ? 'Connected to Click-' + s.braceletInfo.deviceId : '',
      connectBracelet: () => this.braceletControls.choose(),
      switchBracelet: () => this.braceletControls.choose(),
      syncBracelet: () => this.braceletControls.sync(),
      disconnectBracelet: () => this.braceletControls.disconnect(),
      filters, clicks,`);
  replace("braceletStatus: s.locked ? 'Locked · Not sharing' : 'Connected via Bluetooth',",
    "braceletStatus: s.braceletInfo ? 'Connected to Click-' + s.braceletInfo.deviceId : 'Bracelet disconnected',");
  replace("repair: set({ screen: 'pair', fromSettings: true, pairState: 'idle' }),", `repair: () => {
        if (this.state.braceletBusy) return;
        this.braceletControls.disconnect();
        set({ screen: 'pair', fromSettings: true })();
      },`);
  replace('      signOut: () => {\n', `      signOut: () => {
        if (this.state.braceletBusy || this.state.profileSaving) return;
        this.braceletControls.disconnect();
        this.setState({ braceletOwner: null, profileBraceletOwner: null, profName: '', profileNameError: '' });
`);

  const packed = JSON.stringify(template).replace(/<\//g, '<\\u002F');
  const preview = html.replace(bundleTemplate, (_, open, _old, close) => open + packed + close);
  return replaceOnce(preview, '    const manifest = JSON.parse(manifestEl.textContent);',
    "    await import('/bracelet-controls.mjs');\n    const manifest = JSON.parse(manifestEl.textContent);");
}
