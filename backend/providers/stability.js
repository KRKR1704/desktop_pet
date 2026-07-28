// Stability AI adapter.
//
// Chose the /v2beta/stable-image/generate/sd3 endpoint in image-to-image
// mode (image + strength) over the /generate/core endpoint: core is
// text-to-image *only* (confirmed against its current field list — no
// image/strength params exist on it at all), so it can't take the user's
// reference photo as input. sd3 supports mode=image-to-image, which is what
// this needs for the same photo-consistency reason described in
// backend/providers/openai.js. A dedicated /v2beta/stable-image/edit/...
// endpoint also exists but is for targeted edits (inpaint/erase/etc), not
// general stylized generation from a reference — sd3 img2img is the closer
// fit for "reinterpret this photo as a sprite in state X".
//
// Verified 2026-07 via Stability's current field list (core vs sd3) and a
// reference server-side implementation (strands-agents/tools) rather than
// the interactive docs site, which returned no static content to fetch.
// TODO(unverified-live): this endpoint's exact accepted values for the
// `model` sub-parameter (e.g. "sd3.5-large" vs a bare default) couldn't be
// confirmed against a live call — left unset here to take Stability's
// documented default. If real calls 400 on a missing/invalid `model` field,
// that error will surface verbatim in the tile's FAILED reason/log, which is
// exactly what to check first.
//
// `strength` and `seed` are both passed through from backend/forge.js rather
// than hardcoded here: forge.js is the single place that decides how tightly
// a given call should stick to its reference (looser for the first,
// photo-based anchor call; much tighter for every call after that, which is
// reproducing an already-designed character — see forge.js's
// STRENGTH_FROM_PHOTO/STRENGTH_FROM_ANCHOR) and holds one seed for the whole
// session so every call, however loosely, samples from the same noise
// starting point. TODO(unverified-live): `seed`'s effect specifically in
// image-to-image mode (vs pure text-to-image) wasn't confirmed against a
// live call — documented as a real, accepted parameter on this endpoint
// family generally (echoed back in the response), so worst case it's inert
// here, not wrong.
'use strict';

const { ForgeError, classifyHttpError } = require('../forgeError');

const GENERATE_URL = 'https://api.stability.ai/v2beta/stable-image/generate/sd3';
const DEFAULT_STRENGTH = 0.6; // 0=ignore prompt/keep reference, 1=ignore reference; used only if forge.js doesn't pass one

async function generateFrame({ referencePhoto, prompt, apiKey, strength = DEFAULT_STRENGTH, seed }) {
  const form = new FormData();
  form.set('prompt', prompt);
  form.set('mode', 'image-to-image');
  form.set('strength', String(strength));
  form.set('output_format', 'png');
  if (Number.isFinite(seed)) form.set('seed', String(seed));
  form.set('image', new Blob([referencePhoto.buffer], { type: referencePhoto.mimeType }), 'reference.png');

  let res;
  try {
    res = await fetch(GENERATE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json' // base64-in-JSON, rather than image/* raw bytes, so we get finish_reason alongside the image for content-policy detection
      },
      body: form
    });
  } catch (err) {
    throw new ForgeError('network', `Could not reach Stability AI (${err.message}).`, { cause: err });
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new ForgeError(classifyHttpError(res.status, bodyText), `Stability AI returned ${res.status}: ${bodyText.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (err) {
    throw new ForgeError('unknown', `Stability AI response was not valid JSON: ${err.message}`);
  }

  if (json.finish_reason && json.finish_reason !== 'SUCCESS') {
    const kind = json.finish_reason === 'CONTENT_FILTERED' ? 'content_policy' : 'unknown';
    throw new ForgeError(kind, `Stability AI did not return an image (finish_reason: ${json.finish_reason}).`);
  }
  if (!json.image) throw new ForgeError('unknown', 'Stability AI response had no image data.');

  return { buffer: Buffer.from(json.image, 'base64'), mimeType: 'image/png' };
}

module.exports = {
  id: 'stability',
  label: 'Stability AI',
  keyPlaceholder: 'sk-••••••••••••••••',
  keyHelpUrl: 'https://platform.stability.ai/account/keys',
  costNote: 'SD3 image-to-image is billed per generation via credits (~$0.03-0.09/image depending on model tier) — this forges 36 images per character.',
  generateFrame
};
