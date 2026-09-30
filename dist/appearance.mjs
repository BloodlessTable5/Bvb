export const DEFAULT_HIGHLIGHT = '#eaf7ff';

const HIGHLIGHT_PRESETS = [
  ['Ice white', DEFAULT_HIGHLIGHT],
  ['Cyan', '#7df9ff'],
  ['Blue', '#a0b9ff'],
  ['Pink', '#ff82d6'],
  ['Gold', '#ffe18a'],
  ['Mint', '#b2ffda'],
];

export function normalizeHighlight(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : DEFAULT_HIGHLIGHT;
}

export function setupHighlightPicker({ initialColor, onChange } = {}) {
  const container = document.getElementById('highlight-swatches');
  const customInput = document.getElementById('highlight-color');
  const selectedName = document.getElementById('highlight-name');
  let color = normalizeHighlight(initialColor);

  const radios = HIGHLIGHT_PRESETS.map(([name, value]) => {
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'highlight';
    radio.value = value;
    radio.className = 'highlight-swatch';
    radio.title = name;
    radio.setAttribute('aria-label', name);
    radio.style.setProperty('--swatch', value);
    radio.addEventListener('change', () => {
      if (radio.checked) selectColor(value, true);
    });
    return radio;
  });

  function selectColor(value, notify = false) {
    const nextColor = normalizeHighlight(value);
    const changed = nextColor !== color;
    color = nextColor;
    document.documentElement.style.setProperty('--player-highlight', color);
    radios.forEach(radio => { radio.checked = radio.value === color; });
    customInput.value = color;
    const preset = HIGHLIGHT_PRESETS.find(([, value]) => value === color);
    selectedName.textContent = preset ? preset[0] : `Custom ${color.toUpperCase()}`;
    if (notify && changed && typeof onChange === 'function') onChange(color);
  }

  container.replaceChildren(...radios);
  customInput.addEventListener('input', () => selectColor(customInput.value, true));
  customInput.addEventListener('change', () => selectColor(customInput.value, true));
  selectColor(color);

  return {
    getColor: () => color,
    setColor: value => selectColor(value),
  };
}
