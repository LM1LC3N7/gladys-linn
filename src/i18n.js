// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration buttons, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

export const T = {
  noDevice: both(
    'No OpenHome device created yet: open the Discovery tab (the search runs at start-up), or type the description URL of a device in the configuration.',
    "Aucun appareil OpenHome créé : ouvrez l'onglet Découverte (la recherche se lance au démarrage), ou saisissez l'URL de description d'un appareil dans la configuration.",
  ),
  ok: (total, online) =>
    both(
      `${online} of ${total} device(s) answering.`,
      `${online} appareil(s) sur ${total} répondent.`,
    ),
  unreachable: (names) =>
    both(
      `Not answering (off, unplugged or new address), tried again at spaced intervals: ${list(names)}.`,
      `Ne répondent pas (éteints, débranchés ou nouvelle adresse), réessayés à intervalles espacés : ${list(names)}.`,
    ),
  invalidUrls: (positions) =>
    both(
      `Description URLs ignored (not plain http URLs of a description), position ${list(positions)}.`,
      `URL de description ignorées (pas des URL http de description), position ${list(positions)}.`,
    ),
  check: (lines, maxVolume) => ({
    en: [...lines.map((l) => l.en), `Volume cap: ${maxVolume} %`].join('\n'),
    fr: [...lines.map((l) => l.fr), `Plafond de volume : ${maxVolume} %`].join('\n'),
  }),
  checkLine: (label, state, error) => {
    if (error || state === null || state === undefined) {
      const why = error ? ` (${error})` : '';
      return both(`${label}: no answer${why}`, `${label} : pas de réponse${why}`);
    }
    if (state.standby) {
      return both(`${label}: in standby`, `${label} : en veille`);
    }
    const volume = Number.isInteger(state.volume) ? `, volume ${state.volume}` : '';
    const muteEn = state.mute ? ', muted' : '';
    const muteFr = state.mute ? ', sourdine' : '';
    const source = state.sourceName ? `, ${state.sourceName}` : '';
    return both(
      `${label}: on${source}${volume}${muteEn}`,
      `${label} : allumé${source}${volume}${muteFr}`,
    );
  },
  notRead: (label) =>
    both(
      `${label}: not read (time limit of the button reached)`,
      `${label} : non lu (temps du bouton écoulé)`,
    ),
  noneFound: both(
    'No OpenHome device answers. SSDP must reach Gladys (same network, no VLAN between them), or type the description URL of the device in the configuration.',
    "Aucun appareil OpenHome ne répond. Le SSDP doit atteindre Gladys (même réseau, pas de VLAN entre les deux), ou saisissez l'URL de description de l'appareil dans la configuration.",
  ),
  sourcesOf: (label, sources, pins) => {
    const none = { en: '(none)', fr: '(aucun)' };
    const block = (lang) =>
      [
        label,
        lang === 'en' ? 'Sources:' : 'Sources :',
        ...(sources.length ? sources.map((s) => `- ${s}`) : [none[lang]]),
        lang === 'en' ? 'Pins (presets):' : 'Épingles (préréglages) :',
        ...(pins.length ? pins.map((p) => `- ${p}`) : [none[lang]]),
      ].join('\n');
    return both(block('en'), block('fr'));
  },
};
