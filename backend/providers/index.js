// Provider registry — the rest of the pipeline (backend/forge.js,
// motekin-main.js) only ever goes through generateFrame(providerId, ...) or
// the list() metadata below, so swapping/adding a provider never touches
// anything outside this folder.
'use strict';

const openai = require('./openai');
const stability = require('./stability');
const gemini = require('./gemini');

const PROVIDERS = { openai, stability, gemini };

function list() {
  return Object.values(PROVIDERS).map(({ id, label, keyPlaceholder, keyHelpUrl, costNote }) => (
    { id, label, keyPlaceholder, keyHelpUrl, costNote }
  ));
}

function get(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider "${providerId}".`);
  return provider;
}

async function generateFrame(providerId, args) {
  return get(providerId).generateFrame(args);
}

module.exports = { list, generateFrame };
