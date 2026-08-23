// FX settings (FR-UX-01): pure evaluator + storage helpers for the settings
// strip (master volume slider, reduced-FX toggle). Zero DOM; load/save take
// an injected storage so tests run without localStorage.

export const FX_KEY = 'opengame.fx';

/**
 * Coerce raw prefs into safe render/audio parameters.
 * @param {{volume?: number|string, reducedFx?: boolean}} prefs
 * @returns {{volume: number, reducedFx: boolean, particleScale: number, shakeScale: number}}
 */
// Absent volume means factory default (1); a PRESENT junk value coerces to 0
// so a corrupt slider write can never blast audio at full volume.
function coercePrefs(prefs) {
  const n = Number(prefs && prefs.volume !== undefined ? prefs.volume : 1);
  return {
    volume: Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0,
    reducedFx: prefs?.reducedFx === true,
  };
}

export function resolveFxSettings(prefs) {
  const { volume, reducedFx } = coercePrefs(prefs);
  return {
    volume,
    reducedFx,
    particleScale: reducedFx ? 0.35 : 1,
    shakeScale: reducedFx ? 0 : 1,
  };
}

/** Read prefs from a storage-like; missing or corrupt values fall back to defaults. */
export function loadFxSettings(store) {
  try {
    const raw = store.getItem(FX_KEY);
    if (!raw) return { volume: 1, reducedFx: false };
    const obj = JSON.parse(raw);
    // A non-numeric stored volume means the blob is corrupt -> full defaults.
    if (!obj || typeof obj !== 'object' || !Number.isFinite(Number(obj.volume))) {
      return { volume: 1, reducedFx: false };
    }
    return coercePrefs(obj);
  } catch {
    return { volume: 1, reducedFx: false };
  }
}

export function saveFxSettings(store, prefs) {
  store.setItem(FX_KEY, JSON.stringify({ volume: prefs.volume, reducedFx: prefs.reducedFx }));
}
