const walkSelect = document.getElementById('walkFrequency');
const moodSelect = document.getElementById('moodFrequency');
const pausedCheckbox = document.getElementById('paused');
const reactToActivityCheckbox = document.getElementById('reactToActivity');
const petsList = document.getElementById('petsList');

async function init() {
  const settings = await window.settingsAPI.getPetSettings();
  walkSelect.value = settings.walkFrequency;
  moodSelect.value = settings.moodFrequency;
  pausedCheckbox.checked = settings.paused;
  reactToActivityCheckbox.checked = settings.reactToActivity;

  await renderPetsList();
}

// Renders the discovered character packs as checkboxes. Checking/unchecking
// spawns/closes that pet immediately, without closing this window — unlike
// the tray menu this replaced, which closed after every single click.
async function renderPetsList() {
  const packs = await window.settingsAPI.getAvailablePacks();
  petsList.innerHTML = '';

  if (packs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No character packs found.';
    petsList.appendChild(empty);
    return;
  }

  for (const pack of packs) {
    const row = document.createElement('div');
    row.className = 'checkbox-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.id = `pet-${pack.id}`;
    checkbox.checked = pack.active;

    const label = document.createElement('label');
    label.setAttribute('for', checkbox.id);
    label.textContent = pack.label;

    checkbox.addEventListener('change', () => {
      window.settingsAPI.setPetActive(pack.id, checkbox.checked);
    });

    row.appendChild(checkbox);
    row.appendChild(label);
    petsList.appendChild(row);
  }
}

walkSelect.addEventListener('change', () => {
  window.settingsAPI.updatePetSettings({ walkFrequency: walkSelect.value });
});

moodSelect.addEventListener('change', () => {
  window.settingsAPI.updatePetSettings({ moodFrequency: moodSelect.value });
});

pausedCheckbox.addEventListener('change', () => {
  window.settingsAPI.updatePetSettings({ paused: pausedCheckbox.checked });
});

reactToActivityCheckbox.addEventListener('change', () => {
  window.settingsAPI.updatePetSettings({ reactToActivity: reactToActivityCheckbox.checked });
});

init();
