// OpenAI adapter — uses the images *edit* endpoint (not plain generation)
// specifically so the reference image (either the user's uploaded photo, or
// the generated anchor frame for every state after idle — see
// backend/forge.js) is passed as real image input on every call, which is
// what keeps the character visually tied to that reference across all 9
// states/frames.
//
// Endpoint/parameter shapes verified 2026-07 against OpenAI's current API
// reference (developers.openai.com/api/reference), the images guide, and
// the "generate images with high input fidelity" cookbook — gpt-image-1
// always returns base64 image data (b64_json), never a url, but this still
// checks for a url field defensively in case that ever changes or a
// different model is configured.
'use strict';

const { ForgeError, classifyHttpError } = require('../forgeError');

const EDIT_URL = 'https://api.openai.com/v1/images/edits';
const MODEL = 'gpt-image-1';

async function generateFrame({ referencePhoto, prompt, apiKey, size = '1024x1024', inputFidelity = 'high' }) {
  const form = new FormData();
  form.set('model', MODEL);
  form.set('prompt', prompt);
  form.set('size', size);
  form.set('n', '1');
  // gpt-image-1-only param: renders real alpha transparency instead of a
  // solid background, so the assembled spritesheet doesn't need a separate
  // background-removal pass for this provider (see README's provider notes
  // for why Stability/Gemini don't get the same treatment).
  form.set('background', 'transparent');
  // gpt-image-1-only param (not supported on gpt-image-1.5, which this
  // adapter doesn't use): 'high' spends more input-image tokens to preserve
  // exact details from the reference — faces, hair, clothing colors — rather
  // than treating it as loose inspiration. Matters for every call, but
  // especially the anchor-based ones in backend/forge.js, where the
  // reference *is* the already-designed character and any drift away from
  // it is exactly the drift this whole change is meant to fix.
  form.set('input_fidelity', inputFidelity);
  form.set('image', new Blob([referencePhoto.buffer], { type: referencePhoto.mimeType }), 'reference.png');

  let res;
  try {
    res = await fetch(EDIT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } catch (err) {
    throw new ForgeError('network', `Could not reach OpenAI (${err.message}).`, { cause: err });
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new ForgeError(classifyHttpError(res.status, bodyText), `OpenAI returned ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    throw new ForgeError('unknown', `OpenAI response was not valid JSON: ${err.message}`);
  }

  const entry = json.data && json.data[0];
  if (!entry) throw new ForgeError('unknown', 'OpenAI response had no image data.');

  if (entry.b64_json) {
    return { buffer: Buffer.from(entry.b64_json, 'base64'), mimeType: 'image/png' };
  }
  if (entry.url) {
    const imgRes = await fetch(entry.url);
    if (!imgRes.ok) throw new ForgeError('network', `Could not download generated image from OpenAI (${imgRes.status}).`);
    return { buffer: Buffer.from(await imgRes.arrayBuffer()), mimeType: imgRes.headers.get('content-type') || 'image/png' };
  }
  throw new ForgeError('unknown', 'OpenAI response had neither b64_json nor url.');
}

module.exports = {
  id: 'openai',
  label: 'OpenAI',
  keyPlaceholder: 'sk-••••••••••••••••',
  keyHelpUrl: 'https://platform.openai.com/api-keys',
  costNote: 'gpt-image-1 edits are billed per image (~$0.02-$0.19 depending on size/quality, slightly more with input_fidelity=high) — this forges 36 images per character.',
  generateFrame
};
