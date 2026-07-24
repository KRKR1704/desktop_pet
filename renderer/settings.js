const walkSelect = document.getElementById('walkFrequency');
const moodSelect = document.getElementById('moodFrequency');
const pausedCheckbox = document.getElementById('paused');

async function init() {
  const settings = await window.settingsAPI.getPetSettings();
  walkSelect.value = settings.walkFrequency;
  moodSelect.value = settings.moodFrequency;
  pausedCheckbox.checked = settings.paused;
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

init();
