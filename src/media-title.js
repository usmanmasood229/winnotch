'use strict';
// Trims a player's track title down to the part worth reading.
//
// What Windows hands over is whatever the app set, and for anything playing in
// a browser that's the page title: "Artist | Song | Official Audio", with the
// artist repeated, promo words and a "Prod by" credit. The song is what
// belongs on the notch, so the string is split on its separators and the parts
// that aren't the song are dropped.
(function (root) {
  const SEPARATORS = /\s*[|•·–—]\s*|\s+-\s+/;

  // Parts that are never the track name.
  const NOISE = /^(official\b|full\b|new\b|latest\b|exclusive\b|hd\b|hq\b|4k\b|audio$|video$|lyrics?$|lyrical\b|visualizer$|prod\.?\s|prod\.?\sby\b|dir\.?\sby\b|directed by\b|out now\b|free download\b|slowed\b|reverb\b|remastered?\b|cover$|remix$|teaser$|trailer$|subtitle|with lyrics\b)/i;

  // A bracket ends the title: everything from the first one is an aside.
  const BRACKET_ON = /[([{].*$/s;
  const MAX_WORDS = 4;

  function words(s) {
    return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  // True when a part is mostly the artist's name again.
  function isArtist(part, artist) {
    const a = words(artist), p = words(part);
    if (!a.length || !p.length) return false;
    const shared = p.filter(w => a.includes(w)).length;
    return shared / p.length >= 0.6;
  }

  function clean(part) {
    return part
      .replace(BRACKET_ON, '')
      .replace(/["“”]+/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/[\s,;:\-–—]+$/, '')
      .trim();
  }

  // Nothing to cut on: keep it to a few words rather than a whole sentence.
  function cap(s) {
    const parts = s.split(/\s+/).filter(Boolean);
    return parts.length <= MAX_WORDS ? s : parts.slice(0, MAX_WORDS).join(' ');
  }

  function simplify(title, artist) {
    if (typeof title !== 'string') return '';
    const whole = clean(title);
    if (!whole) return '';

    const parts = whole.split(SEPARATORS).map(clean).filter(Boolean);
    if (parts.length <= 1) return cap(whole);

    const keep = parts.filter(p => !NOISE.test(p) && !isArtist(p, artist));
    // Everything looked like noise or the artist: fall back to the first part,
    // which beats showing nothing.
    return cap(keep.length ? keep[0] : parts[0]);
  }

  const api = { simplify };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MediaTitle = api;
})(this);
